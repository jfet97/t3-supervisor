import { agreedWorkUnfinished, explicitWaitRecorded, latestExecutedRun, returnWaiting } from "./workflow-liveness.js";
import { conversationMayContact, conversationMayObserve, taskScopeRevision } from "./supervision-conversation.js";
import { Cause, Clock, Context, Data, Effect, FiberMap, Layer, Option } from "effect";
import { freshRuntimeRequestStatus, projectionHasOngoingWork } from "./domain.js";
import { fingerprint } from "./guidance-store.js";
import { NativeOperateRpc, record, SupervisorRpcError } from "./supervisor-native.js";
import { GuidanceDb } from "./db.js";
import { guidanceTransaction, type SupervisionStoreError } from "./guidance-sql.js";
import { ProjectSupervisorStore, type BindingRecord, type ParticipantSettlement, type TaskRecord } from "./project-supervisor-store.js";
import { completionRecordId, settlementKey, workflowParticipants } from "./workflow-progress.js";
import { SupervisorConversation } from "./supervisor-conversation.js";
import { introductionOutcomeUnknown, SupervisorConversationStore, type ConversationRequest } from "./supervisor-conversation-store.js";
import { ProjectSupervisorMonitorStore } from "./supervisor-monitor-store.js";
import { documentBranchSelections, notApplicableNodeIds, WorkflowStateStore } from "./workflow-state-store.js";
import { unsettledOccurrences } from "./workflow-plan-tree.js";
import { T3Client, T3TransportError } from "./t3.js";
import type { Projection, ThreadInfo } from "./types.js";
import { resolveSupervisorScope, type SupervisorScopeResolution } from "./supervisor-scope.js";
import { childOrigin, delegatedLifecycle, directParentChildLifecycle, normalizeLifecycle } from "./supervisor-observation.js";
import { SupervisorTeamRuntime } from "./supervisor-team-runtime.js";
import { SupervisorIds } from "./ids.js";
import { planningHasUnresolvedEffects } from "./supervisor-planning.js";
import { admitSend, SupervisionGate, type GateGuard, type SendPreparation } from "./supervision-gate.js";

export const SUPERVISOR_SETTLE_QUIET_MS = 60_000;
const SUPERVISOR_LIFECYCLE_MAX_PROJECTION_READS = 100;
const SUPERVISOR_LIFECYCLE_MAX_CACHE_REFRESHES = 20;
const SUPERVISOR_LIFECYCLE_MAX_CACHE_ENTRIES = 10_000;
const SUPERVISOR_LIFECYCLE_MAX_SCAN_OFFSETS = 256;
export const userKeepsSupervisorActive = (thread: ThreadInfo): boolean => Boolean(thread.pinnedAt || thread.autoSettleDisabledAt || thread.settledOverride === "active");
const laterThan = (value: unknown, since: number): boolean => typeof value === "string" && Date.parse(value) > since;
/** A keep-active choice counts against a stop only when the human made it after the stop; an unstamped override predates it. */
export const userKeepsSupervisorActiveSince = (thread: ThreadInfo, since: number): boolean =>
  laterThan(thread.pinnedAt, since) || laterThan(thread.autoSettleDisabledAt, since) || thread.settledOverride === "active" && laterThan(thread.unsettledAt, since);
const hasUnresolvedRuntimeRequestHint = (projection: Projection, value: unknown): boolean => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value !== null && value !== undefined;
  const request = value as Record<string, unknown>;
  const requestId = typeof request.id === "string" ? request.id : typeof request.requestId === "string" ? request.requestId : null;
  const nodeId = typeof request.nodeId === "string" ? request.nodeId : null;
  const status = freshRuntimeRequestStatus(projection, {requestId, nodeId});
  return !["resolved", "expired", "cancelled"].includes(status);
};

export const projectionNeedsAttention = (projection: Projection, shell?: ThreadInfo): boolean =>
  projectionHasOngoingWork(projection, shell) || Boolean(projection.thread.activeRunId || hasUnresolvedRuntimeRequestHint(projection, projection.thread.pendingRuntimeRequest));
const activityVersion = (projection: Projection) => fingerprint({
  archivedAt: projection.thread.archivedAt ?? null,
  deletedAt: projection.thread.deletedAt ?? null,
  updatedAt: projection.thread.updatedAt,
  runs: projection.runs.map(run => [run.id, run.status, run.completedAt]),
  messages: projection.messages.map(message => [message.id, message.updatedAt, message.streaming]),
  items: projection.turnItems?.map(item => [item.id, item.type, item.status, item.updatedAt, item.childThreadId, item.providerThreadId]),
  subagents: projection.subagents?.map(item => [item.childThreadId, item.providerThreadId, item.status, item.completedAt]),
});
const lifecycleShellVersion = (thread: ThreadInfo): string => fingerprint({
  id: thread.id,
  parentThreadId: thread.lineage.parentThreadId,
  relationshipToParent: thread.lineage.relationshipToParent,
  creationSource: thread.creationSource ?? null,
  updatedAt: thread.updatedAt ?? null,
  archivedAt: thread.archivedAt ?? null,
  deletedAt: thread.deletedAt ?? null,
  latestRunId: thread.latestRunId ?? null,
  activeRunId: thread.activeRunId ?? null,
  activityRunStatus: thread.activityRunStatus ?? null,
  latestRunCompletedAt: thread.latestRunCompletedAt ?? null,
  pendingRuntimeRequest: thread.pendingRuntimeRequest ?? null,
  pendingBackgroundTasks: thread.pendingBackgroundTasks ?? null,
  pullRequests: thread.pullRequests ?? null,
});
type QuietChildObservation = {childShellVersion: string; parentShellVersion: string; parentProjectionVersion: string; resultVersion: string};

const activeDetachedChildWork = (projection: Projection): boolean => (projection.turnItems ?? []).some(item => {
  if (item.threadId !== projection.thread.id || item.runId !== null) return false;
  const requestItem = ["user_input_request", "approval_request", "secret_request"].includes(String(item.type));
  if (requestItem) {
    const requestStatus = freshRuntimeRequestStatus(projection, {
      requestId: typeof item.requestId === "string" ? item.requestId : null,
      nodeId: typeof item.nodeId === "string" ? item.nodeId : null,
    });
    if (["resolved", "expired", "cancelled"].includes(requestStatus)) return false;
    if (requestStatus === "pending") return true;
  }
  return item.streaming === true || ["preparing", "queued", "starting", "running", "waiting"].includes(String(item.status));
});


// a main projection that names another thread or project; it fails closed like any unreadable scope
export class MainScopeMismatch extends Data.TaggedError("MainScopeMismatch")<{readonly message: string}> {}

type ChildScopes = {blocked: boolean; version: string; threadIds: string[]};
// the baseline catch around an awaited step: its value, or the caught failure (a typed error or a defect); an interruption
// stays an interruption
type Attempt<A> = {readonly ok: true; readonly value: A} | {readonly ok: false; readonly cause: unknown};
const attempt = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<Attempt<A>, never, R> =>
  Effect.catchCauseIf(Effect.map(effect, (value): Attempt<A> => ({ok: true, value})), (cause) => !Cause.hasInterruptsOnly(cause),
    (cause) => Effect.succeed<Attempt<A>>({ok: false, cause: Cause.squash(cause)})) as Effect.Effect<Attempt<A>, never, R>;

export interface SupervisorLifecycleShape {
  /** Returns a confirmed missing main as null; every other unreadable or mismatched scope fails closed. */
  readonly readMain: (binding: BindingRecord) => Effect.Effect<Projection | null, T3TransportError | MainScopeMismatch>;
  readonly check: (input: BindingRecord, threads: readonly ThreadInfo[]) => Effect.Effect<void, SupervisionStoreError>;
  /** Parks an inactive No Project scope without manufacturing a human Stop or changing its permission. */
  readonly parkInactive: (input: BindingRecord, stillInactive: () => Effect.Effect<boolean, SupervisionStoreError>) => Effect.Effect<void, SupervisionStoreError>;
}

type StoppedSettlement = {binding: BindingRecord; stoppedAt: number; version: string};

/** Parks only owned idle conversations, retaining their identity for normal native dispatch. */
const makeSupervisorLifecycle = Effect.gen(function* () {
  const store = yield* ProjectSupervisorStore;
  const requests = yield* SupervisorConversationStore;
  const monitor = yield* ProjectSupervisorMonitorStore;
  const workflows = Option.getOrNull(yield* Effect.serviceOption(WorkflowStateStore));
  const transaction = guidanceTransaction(yield* GuidanceDb);
  const conversation = yield* SupervisorConversation;
  const gate = yield* SupervisionGate;
  const t3 = yield* T3Client;
  const ids = yield* SupervisorIds;
  // the operate credential and the helper team are absent where a scope has none of them
  const rpc = Option.getOrNull(yield* Effect.serviceOption(NativeOperateRpc));
  const teamRuntime = Option.getOrNull(yield* Effect.serviceOption(SupervisorTeamRuntime));
  // the in-flight settle commands of this service (plan 3.11): closing its scope interrupts each one and keeps its reservation
  const settlements = yield* FiberMap.make<string, void>();
  // insertion-ordered caches of this process, bounded least-recently-used and keyed by scope so concurrent scopes stay independent
  const childObservations = new Map<string, QuietChildObservation>();
  const childScanOffsets = new Map<string, number>();

  const projection = (threadId: string): Effect.Effect<Projection, T3TransportError> => Effect.map(t3.projection(threadId), (snapshot) => snapshot.projection);
  // a confirmed 404 is a missing projection; any other failure stays a failure
  const presentProjection = (threadId: string): Effect.Effect<Projection | null, T3TransportError> => projection(threadId).pipe(
    Effect.catchTag("T3TransportError", (error) => error.httpStatus === 404 ? Effect.succeed(null) : Effect.fail(error)));
  // one admitted block: its guard reads and writes as one guidance transaction in the admission section
  const admitted = <A, E>(block: (guard: GateGuard) => Effect.Effect<A, E>) => gate.admit((guard) => transaction(block(guard)));
  const teamWorkOf = (binding: BindingRecord): Effect.Effect<boolean, SupervisionStoreError> => teamRuntime ? teamRuntime.hasBlockingWork(binding) : Effect.succeed(false);
  const teamEffectsOf = (binding: BindingRecord): Effect.Effect<boolean, SupervisionStoreError> => teamRuntime ? teamRuntime.hasInflightEffects(binding) : Effect.succeed(false);

  const readMain = (binding: BindingRecord): Effect.Effect<Projection | null, T3TransportError | MainScopeMismatch> => Effect.gen(function* () {
    const main = yield* presentProjection(binding.mainThreadId);
    if (main === null) return null;
    if (main.thread.id !== binding.mainThreadId || main.thread.projectId !== binding.projectId) return yield* new MainScopeMismatch({message: "main_scope_mismatch"});
    return main;
  });

  const workflowAttention = (binding: BindingRecord, threadIds: readonly string[]) => Effect.gen(function* () {
    if (!workflows) return {blocked: false, version: "workflow-store-unavailable-in-test"};
    const result = yield* workflows.hasNeedsAttention(binding.projectId, binding.mainThreadId, threadIds);
    return {blocked: result.status !== "complete" || result.needsAttention, version: fingerprint(result)};
  });

  // a not-needed or unresolved request gets no check-ins, so unreviewed activity retained for the next genuine request does not keep
  // its Supervisor open (an incomplete scan still does); any other task still waits for that activity to be reviewed
  const awaitsReview = (binding: BindingRecord) => Effect.map(store.task(binding.mainThreadId), (task) =>
    !task || task.supervisorThreadId !== binding.threadId || conversationMayContact(task));

  /** Returns the first gate that keeps the main supervision active, or null when settlement may proceed. */
  const mainAttention = (binding: BindingRecord, supervisor: Projection, main: Projection | null, closedMain: boolean, source: ThreadInfo | undefined,
    teamWork: boolean, keepSupervisorActive = true) => Effect.gen(function* (): Effect.fn.Return<string | null, SupervisionStoreError> {
    if (keepSupervisorActive && (binding.manualKeepActive || userKeepsSupervisorActive(supervisor.thread))) return "keep_active";
    if ((yield* store.modelState(binding)).pending) return "model_change_pending";
    if (projectionNeedsAttention(supervisor)) return "supervisor_busy";
    if (teamWork) return "team_work";
    if ((yield* requests.planningAttempts(binding.projectId)).some(attempt => attempt.mainThreadId === binding.mainThreadId && planningHasUnresolvedEffects(attempt)))
      return "planning_wait_or_delivery";
    if (closedMain) return main && projectionNeedsAttention(main, source ?? main.thread) ? "main_busy" : null;
    if (!source) return "main_not_cataloged";
    const tasks = yield* store.tasksFor(binding);
    const owned = yield* requests.requests(binding.projectId, binding.threadId);
    const status = yield* conversation.status(binding.projectId, binding.threadId);
    if (status.state !== "idle") return "monitoring_not_idle";
    if (status.pendingItems > 0) return "pending_activity";
    if ((yield* requests.reviewMisses(binding.threadId)) > 0) return "review_misses";
    // a temporary not-needed decision or an unresolved request leaves nothing to supervise until the next genuine request
    if (tasks.length === 0 || tasks.some(task => !["inferred", "not_supervised", "needs_context"].includes(task.status) || task.definitionReview?.status === "checking" ||
      task.definitionReview?.status === "revert_requested" || task.agreement?.status === "stale")) return "task_state";
    // the current task's unsent introduction and any introduction with an unknown outcome hold the Supervisor; a known-unsent draft
    // of a replaced task is history
    const current = yield* store.task(binding.mainThreadId);
    if ((yield* requests.introductions(binding.projectId)).some(intro => intro.supervisorThreadId === binding.threadId && intro.state !== "sent" &&
      (intro.taskId === current?.id || introductionOutcomeUnknown(intro))))
      return "introduction_unsent";
    if (owned.some(request => ["prepared", "sending", "waiting", "uncertain"].includes(request.state) ||
      request.state === "failed" && request.kind === "review" && !request.failureAcknowledged)) return "request_open";
    // a queued request cancelled before it started executed nothing; the latest executed run decides completion
    const latest = main ? latestExecutedRun(main) : undefined;
    if (!main || !latest || latest.status !== "completed") return "main_run_not_completed";
    if (projectionNeedsAttention(main, source ?? main.thread)) return "main_busy";
    return (yield* unfinishedAgreedWork(binding, current, owned, Date.parse(latest.completedAt ?? ""))) ? "unfinished_agreed_work" : null;
  });

  // an idle main whose agreed workflow is unfinished parks only on an explicit current wait: the latest check-in's confirmed wait naming
  // who acts next and what resumes the work, recorded for the current task after the main's last completed run. Attention, a stale wait or the operative's own unfinished action keeps it out of standby; a
  // completion status counts only when every applicable member is settled. Following, stopped and closed scopes keep their own rules,
  // and nothing here contacts a model
  const unfinishedAgreedWork = (binding: BindingRecord, task: TaskRecord | null, owned: ReadonlyArray<ConversationRequest>, mainFinishedAt: number) =>
    Effect.gen(function* () {
      if (!workflows || !task || task.supervisorThreadId !== binding.threadId || task.status !== "inferred" || task.agreement?.status !== "agreed" ||
        !conversationMayContact(task)) return false;
      const document = yield* workflows.get(binding.projectId, binding.mainThreadId);
      if (!document) return false;
      if (returnWaiting(document)) return true;
      if (!agreedWorkUnfinished(document)) return false;
      // an open external result can coexist with the operative's own unfinished work, so only an explicit wait acknowledges the blocker
      const latest = owned.filter(request => request.kind === "review" && request.reviewPins).at(-1);
      const pinned = latest?.reviewPins?.tasks.some(pin => pin.taskId === task.id && pin.taskRevision === taskScopeRevision(task)) ?? false;
      return !explicitWaitRecorded(latest?.reviewOutcome, pinned, mainFinishedAt);
    });

  const scopeFor = (binding: BindingRecord, main: Projection | null, threads: readonly ThreadInfo[]): SupervisorScopeResolution | null => {
    if (!main || main.thread.deletedAt) return null;
    const nativeThreads = threads.some(thread => thread.id === main.thread.id) ? threads : [...threads, main.thread];
    return resolveSupervisorScope(nativeThreads, binding.projectId, binding.mainThreadId, store.ownedIds);
  };

  const childObservationKey = (binding: BindingRecord, childThreadId: string): string => JSON.stringify([binding.projectId, binding.mainThreadId, childThreadId]);

  const rememberChildObservation = (key: string, value: QuietChildObservation): void => {
    childObservations.delete(key);
    childObservations.set(key, value);
    while (childObservations.size > SUPERVISOR_LIFECYCLE_MAX_CACHE_ENTRIES)
      childObservations.delete(childObservations.keys().next().value!);
  };

  const rememberScanOffset = (scopeKey: string, offset: number): void => {
    childScanOffsets.delete(scopeKey);
    childScanOffsets.set(scopeKey, offset);
    while (childScanOffsets.size > SUPERVISOR_LIFECYCLE_MAX_SCAN_OFFSETS)
      childScanOffsets.delete(childScanOffsets.keys().next().value!);
  };

  const relatedChildren = (binding: BindingRecord, main: Projection | null, threads: readonly ThreadInfo[], scope: SupervisorScopeResolution | null):
    Effect.Effect<ChildScopes, T3TransportError> => Effect.gen(function* () {
    if (!main || main.thread.deletedAt) return {blocked: false, version: fingerprint("deleted-main"), threadIds: [binding.mainThreadId]};
    if (!scope || !scope.complete || !scope.main || !scope.allowedIds.has(scope.main.id))
      return {blocked: true, version: fingerprint(["incomplete-child-scope", scope?.issues ?? []]), threadIds: scope ? [...scope.allowedIds] : [binding.mainThreadId]};
    const projections = new Map<string, Projection>([[main.thread.id, main]]);
    const children = scope.descendants.filter(child => scope.allowedIds.has(child.id) && child.lineage.relationshipToParent !== "fork");
    const scopeKey = JSON.stringify([binding.projectId, binding.mainThreadId]);
    const start = children.length ? (childScanOffsets.get(scopeKey) ?? 0) % children.length : 0;
    const ordered = [...children.slice(start), ...children.slice(0, start)];
    const observed = new Map<string, readonly unknown[]>();
    const stale: ThreadInfo[] = [];
    for (const child of ordered) {
      const parentId = child.lineage.parentThreadId;
      const parentInfo = parentId ? scope.byId.get(parentId) : null;
      if (!parentId || !scope.allowedIds.has(parentId) || !parentInfo)
        return {blocked: true, version: fingerprint(["child_parent_outside_scope", child.id]), threadIds: [...scope.allowedIds]};
      const cacheKey = childObservationKey(binding, child.id);
      const cached = childObservations.get(cacheKey);
      const parentProjection = projections.get(parentId);
      const parentProjectionVersion = parentProjection ? activityVersion(parentProjection) : null;
      const current = cached && cached.childShellVersion === lifecycleShellVersion(child) &&
        cached.parentShellVersion === lifecycleShellVersion(parentInfo) &&
        (parentProjectionVersion === null || cached.parentProjectionVersion === parentProjectionVersion) ? cached : null;
      if (current && !stale.includes(child)) {
        childObservations.delete(cacheKey);
        childObservations.set(cacheKey, current);
        observed.set(child.id, [child.id, current.resultVersion]);
      } else stale.push(child);
    }
    const refreshCandidates = [...stale, ...ordered.filter(child => observed.has(child.id)).slice(0, SUPERVISOR_LIFECYCLE_MAX_CACHE_REFRESHES)];
    let projectionReads = 0;
    let scanned = 0;
    const readProjection = (threadId: string): Effect.Effect<Projection | null | "budget", T3TransportError> => Effect.gen(function* () {
      const existing = projections.get(threadId);
      if (existing) return existing;
      if (projectionReads >= SUPERVISOR_LIFECYCLE_MAX_PROJECTION_READS) return "budget" as const;
      projectionReads++;
      const value = yield* presentProjection(threadId);
      if (!value || value.thread.id !== threadId) return null;
      projections.set(threadId, value);
      return value;
    });
    let incomplete = false;
    for (const child of refreshCandidates) {
      const parentId = child.lineage.parentThreadId;
      if (!parentId) return {blocked: true, version: fingerprint(["child_parent_missing", child.id]), threadIds: [...scope.allowedIds]};
      let parentProjection = projections.get(parentId) ?? null;
      if (!parentProjection) {
        const read = yield* readProjection(parentId);
        if (read === "budget") {incomplete = true;break;}
        parentProjection = read;
      }
      if (!parentProjection) return {blocked: true, version: fingerprint(["parent_projection_unavailable", child.id]), threadIds: [...scope.allowedIds]};
      const parentInfo = scope.byId.get(parentId);
      if (parentProjection.thread.id !== parentId || !parentInfo || parentId !== binding.mainThreadId && (parentProjection.thread.lineage.relationshipToParent !== "subagent" ||
        parentProjection.thread.lineage.parentThreadId !== parentInfo.lineage.parentThreadId))
        return {blocked: true, version: fingerprint(["parent_lineage_mismatch", child.id]), threadIds: [...scope.allowedIds]};
      const parentRecord = directParentChildLifecycle(parentProjection, child.id);
      let childProjection: Projection | null = null;
      if (!child.deletedAt) {
        const read = yield* readProjection(child.id);
        if (read === "budget") {incomplete = true;break;}
        childProjection = read;
      }
      if (!childProjection && !child.deletedAt && !child.archivedAt)
        return {blocked: true, version: fingerprint(["child_projection_unavailable", child.id]), threadIds: [...scope.allowedIds]};
      if (childProjection && (childProjection.thread.id !== child.id || childProjection.thread.lineage.relationshipToParent !== "subagent" ||
        childProjection.thread.lineage.parentThreadId !== parentId))
        return {blocked: true, version: fingerprint(["child_scope_mismatch", child.id]), threadIds: [...scope.allowedIds]};
      if (childProjection) projections.set(child.id, childProjection);
      if (childProjection && (projectionNeedsAttention(childProjection, childProjection.thread) || activeDetachedChildWork(childProjection)))
        return {blocked: true, version: fingerprint([child.id, activityVersion(childProjection), parentRecord?.status ?? null]), threadIds: [...scope.allowedIds]};

      const origin = childOrigin(child, parentProjection ?? undefined);
      const lifecycle = origin === "native_child"
        ? parentRecord ? normalizeLifecycle(parentRecord.status) : {lifecycle: "unknown" as const, detail: null}
        : origin === "delegated_child" && childProjection
          ? delegatedLifecycle(childProjection.thread, childProjection)
          : {lifecycle: "unknown" as const, detail: null};
      if (lifecycle.lifecycle === "running" || parentRecord && normalizeLifecycle(parentRecord.status).lifecycle === "running")
        return {blocked: true, version: fingerprint([child.id, activityVersion(childProjection ?? {thread: child, runs: [], messages: []}), parentRecord?.status ?? null]), threadIds: [...scope.allowedIds]};
      const parentVersion = activityVersion(parentProjection);
      const childVersion = activityVersion(childProjection ?? {thread: child, runs: [], messages: []});
      const resultVersion = fingerprint([child.id, childVersion, parentRecord?.status ?? null, parentVersion]);
      rememberChildObservation(childObservationKey(binding, child.id), {childShellVersion: lifecycleShellVersion(child),
        parentShellVersion: lifecycleShellVersion(parentInfo), parentProjectionVersion: parentVersion, resultVersion});
      observed.set(child.id, [child.id, resultVersion]);
      scanned++;
    }
    if (children.length) rememberScanOffset(scopeKey, (start + Math.max(1, scanned)) % children.length);
    const allObserved = children.every(child => observed.has(child.id));
    const orderedVersion = children.map(child => observed.get(child.id) ?? [child.id, "not-yet-observed"]);
    return {blocked: incomplete || !allObserved, version: fingerprint(orderedVersion), threadIds: [...scope.allowedIds]};
  });

  const check = (input: BindingRecord, threads: readonly ThreadInfo[]): Effect.Effect<void, SupervisionStoreError> => Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    let initial = yield* store.binding(input.projectId, input.mainThreadId);
    if (!initial || initial.threadId !== input.threadId || initial.state !== "ready" || !rpc) return;
    const supervisorRead = yield* attempt(projection(initial.threadId));
    if (!supervisorRead.ok) {yield* clearQuiet(initial, "supervisor_unreadable");return;}
    const supervisor = supervisorRead.value;
    if (supervisor.thread.id !== initial.threadId || supervisor.thread.projectId !== initial.projectId || supervisor.thread.archivedAt || supervisor.thread.deletedAt) return;
    yield* settleCompletedMain(initial, supervisor, threads);
    initial = (yield* store.binding(input.projectId, input.mainThreadId))!;
    if (!initial || initial.threadId !== input.threadId || initial.generation !== input.generation) return;
    const teamWork = yield* teamWorkOf(initial);
    const teamEffects = yield* teamEffectsOf(initial);
    // the per-chat stop read, its bookkeeping and, for a stopped chat, the settlement gates up to the fresh Supervisor read run
    // in one admission section
    const first = yield* admitted((guard) => Effect.gen(function* (): Effect.fn.Return<{kind: "stopped"; settlement: StoppedSettlement} | {kind: "active"; binding: BindingRecord} | null, SupervisionStoreError> {
      let binding = initial;
      const stopped = yield* guard.supervisionStopped(binding.mainThreadId);
      if (!stopped && binding.stopObservedAt !== undefined) {
        binding = {...binding};delete binding.stopObservedAt;yield* store.setBinding(binding);
      }
      if (!stopped && supervisor.thread.settledOverride === "active" && !binding.manualKeepActive) {
        binding = {...binding, manualKeepActive: true};yield* store.setBinding(binding);
      }
      if (supervisor.thread.settledAt || supervisor.thread.settledOverride === "settled") {
        if (binding.settlement && binding.settlement.state !== "settled") yield* store.setBinding({...binding, settlement: {...binding.settlement, state: "settled"}});
        return null;
      }
      if (stopped) {
        const settlement = yield* stoppedSettlement(binding, supervisor, now, teamEffects);
        return settlement ? {kind: "stopped", settlement} : null;
      }
      const supervisorAttention = yield* mainAttention(binding, supervisor, null, true, undefined, teamWork);
      if (supervisorAttention) {yield* clearQuiet(binding, supervisorAttention);return null;}
      return {kind: "active", binding};
    }));
    if (!first) return;
    if (first.kind === "stopped") {yield* settleStopped(first.settlement, now);return;}
    let binding = first.binding;
    const mainRead = yield* attempt(readMain(binding));
    if (!mainRead.ok) {yield* clearQuiet(binding, "main_unreadable");return;}
    const main = mainRead.value;
    const closedMain = !main || Boolean(main.thread.archivedAt || main.thread.deletedAt);
    const source = threads.find(thread => thread.id === input.mainThreadId && thread.projectId === input.projectId);
    const teamWorkNow = yield* teamWorkOf(binding);
    // the attention gates, the scope, the pending monitor and workflow reads and their quiet-window writes are one block
    const gates = yield* transaction(Effect.gen(function* () {
      const attention = yield* mainAttention(binding, supervisor, main, closedMain, source, teamWorkNow);
      if (attention) {yield* clearQuiet(binding, attention);return null;}
      const scope = scopeFor(binding, main, threads);
      if (main && !main.thread.deletedAt && (!scope || !scope.complete || !scope.main || !scope.allowedIds.has(scope.main.id))) {
        yield* clearQuiet(binding, "scope_incomplete");return null;
      }
      const threadIds = scope ? [...scope.allowedIds] : [binding.mainThreadId];
      const monitorPending = yield* monitor.hasPendingReviewableActivity(binding.projectId, threadIds);
      const attentionOfWorkflows = yield* workflowAttention(binding, threadIds);
      if (monitorPending.status !== "complete" || (yield* awaitsReview(binding)) && monitorPending.pending) {yield* clearQuiet(binding, "pending_activity");return null;}
      if (attentionOfWorkflows.blocked) {yield* clearQuiet(binding, "workflow_attention");return null;}
      return {scope, attentionOfWorkflows};
    }));
    if (!gates) return;
    const {scope, attentionOfWorkflows} = gates;
    const childRead = yield* attempt(relatedChildren(binding, main, threads, scope));
    if (!childRead.ok) {yield* clearQuiet(binding, "children_unreadable");return;}
    const childScopes = childRead.value;
    if (childScopes.blocked) {yield* clearQuiet(binding, "children_active");return;}
    const version = fingerprint({main: main ? activityVersion(main) : "missing", supervisor: activityVersion(supervisor), children: childScopes.version,
      workflows: attentionOfWorkflows.version});
    if (binding.settlement && ["pending", "uncertain"].includes(binding.settlement.state) && binding.settlement.activityVersion !== version) {
      yield* store.setBinding({...binding, quietSince: null, settlement: {...binding.settlement, state: "superseded"}});return;
    }
    if (binding.settlement?.state === "uncertain" && ((binding.settlement.attempts ?? 0) >= 3 || now - binding.settlement.observedAt < SUPERVISOR_SETTLE_QUIET_MS)) return;
    if (binding.quietFingerprint !== version || binding.quietSince == null) {
      yield* store.setBinding({...binding, quietFingerprint: version, quietSince: now, settlementBlockedBy: "quiet_window"});return;
    }
    if (now - binding.quietSince < SUPERVISOR_SETTLE_QUIET_MS) return;
    // recheck both chats immediately before the native effect; native settlement rejects busy Supervisors
    const freshMainRead = yield* attempt(readMain(binding));
    if (!freshMainRead.ok) {yield* clearQuiet(binding, "main_unreadable");return;}
    const freshMain = freshMainRead.value;
    const freshSupervisorRead = yield* attempt(projection(binding.threadId));
    if (!freshSupervisorRead.ok) {yield* clearQuiet(binding, "supervisor_unreadable");return;}
    const freshSupervisor = freshSupervisorRead.value;
    if (freshSupervisor.thread.id !== binding.threadId || freshSupervisor.thread.projectId !== binding.projectId || freshSupervisor.thread.archivedAt || freshSupervisor.thread.deletedAt) {yield* clearQuiet(binding, "supervisor_unavailable");return;}
    const freshClosedMain = !freshMain || Boolean(freshMain.thread.archivedAt || freshMain.thread.deletedAt);
    const freshTeamWork = yield* teamWorkOf(binding);
    // the fresh gates are one block
    const freshGates = yield* transaction(Effect.gen(function* () {
      const freshAttention = yield* mainAttention(binding, freshSupervisor, freshMain, freshClosedMain, source, freshTeamWork);
      if (freshAttention) {yield* clearQuiet(binding, freshAttention);return null;}
      const freshScope = scopeFor(binding, freshMain, threads);
      if (freshMain && !freshMain.thread.deletedAt && (!freshScope || !freshScope.complete || !freshScope.main || !freshScope.allowedIds.has(freshScope.main.id))) {
        yield* clearQuiet(binding, "scope_incomplete");return null;
      }
      const freshThreadIds = freshScope ? [...freshScope.allowedIds] : [binding.mainThreadId];
      const freshMonitorPending = yield* monitor.hasPendingReviewableActivity(binding.projectId, freshThreadIds);
      const freshWorkflowAttention = yield* workflowAttention(binding, freshThreadIds);
      if (freshMonitorPending.status !== "complete" || (yield* awaitsReview(binding)) && freshMonitorPending.pending) {yield* clearQuiet(binding, "pending_activity");return null;}
      if (freshWorkflowAttention.blocked) {yield* clearQuiet(binding, "workflow_attention");return null;}
      return {freshScope, freshWorkflowAttention};
    }));
    if (!freshGates) return;
    const {freshScope, freshWorkflowAttention} = freshGates;
    const freshChildRead = yield* attempt(relatedChildren(binding, freshMain, threads, freshScope));
    if (!freshChildRead.ok) {yield* clearQuiet(binding, "children_unreadable");return;}
    const freshChildren = freshChildRead.value;
    const quiet = binding;
    // the activity recheck, the binding re-read and its in-flight check, the settlement reservation and the settle command run in
    // one admission section; active settlement keeps its baseline: no Stop or Enable recheck after its awaits (L-03)
    yield* sendSettlement(quiet, version, now, () => Effect.gen(function* () {
      if (freshClosedMain !== closedMain || freshChildren.blocked ||
        fingerprint({main: freshMain ? activityVersion(freshMain) : "missing", supervisor: activityVersion(freshSupervisor), children: freshChildren.version,
          workflows: freshWorkflowAttention.version}) !== version ||
        freshMain && projectionNeedsAttention(freshMain, source ?? freshMain.thread)) {
        yield* clearQuiet(quiet, "activity_changed");return null;
      }
      binding = (yield* store.binding(quiet.projectId, quiet.mainThreadId))!;
      if (!closedMain && (yield* conversation.hasInflight(binding.projectId, binding.threadId))) return null;
      return binding;
    }));
  });
  /** Gates that still hold a stopped chat's own Supervisor: only a keep-active choice made after the stop, and unreconciled native work. */
  const stoppedAttention = (binding: BindingRecord, supervisor: Projection, stoppedAt: number, teamEffects: boolean) => Effect.gen(function* (): Effect.fn.Return<string | null, SupervisionStoreError> {
    if (userKeepsSupervisorActiveSince(supervisor.thread, stoppedAt)) return "keep_active";
    if ((yield* store.modelState(binding)).pending) return "model_change_pending";
    if (projectionNeedsAttention(supervisor)) return "supervisor_busy";
    if (teamEffects) return "team_effect_unresolved";
    // an interpretation T3 accepted, or may have accepted, can still start a Supervisor run
    if ((yield* store.tasksFor(binding)).some(task => ["dispatching", "waiting", "uncertain"].includes(task.status))) return "stopped_interpretation_unresolved";
    return null;
  });
  const parkInactive = (input: BindingRecord, stillInactive: () => Effect.Effect<boolean, SupervisionStoreError>): Effect.Effect<void, SupervisionStoreError> => Effect.gen(function* () {
    const binding = yield* store.binding(input.projectId, input.mainThreadId);
    if (!binding || binding.threadId !== input.threadId || binding.state !== "ready" || !(yield* stillInactive())) return;
    const read = yield* attempt(projection(binding.threadId));
    if (!read.ok) return;
    const supervisor = read.value;
    const now = yield* Clock.currentTimeMillis;
    const teamEffects = yield* teamEffectsOf(binding);
    const settlement = yield* admitted(() => Effect.gen(function* () {
      if (supervisor.thread.id !== binding.threadId || supervisor.thread.projectId !== binding.projectId || supervisor.thread.archivedAt || supervisor.thread.deletedAt ||
        supervisor.thread.settledAt || supervisor.thread.settledOverride === "settled" || !(yield* stillInactive())) return null;
      return yield* stoppedSettlement(binding, supervisor, now, teamEffects, stillInactive);
    }));
    if (settlement) yield* settleStopped(settlement, now, stillInactive);
  });
  /**
   * A chat whose supervision a human stopped: its owned Supervisor settles promptly once idle and once every
   * accepted request has a confirmed native outcome. The stop supersedes earlier keep-active choices for that Supervisor; a stop without a
   * recorded time dates from its first observation. Uncertain identities are retained, and the operative main is never settled or interrupted.
   * This part runs inside the caller's admission section, up to the fresh Supervisor read.
   */
  const stoppedSettlement = (input: BindingRecord, supervisor: Projection, now: number, teamEffects: boolean, inactive?: () => Effect.Effect<boolean, SupervisionStoreError>) =>
    Effect.gen(function* (): Effect.fn.Return<StoppedSettlement | null, SupervisionStoreError> {
    let binding = input;
    let stoppedAt = inactive ? 0 : binding.supervisionStop?.stoppedAt ?? binding.stopObservedAt;
    if (stoppedAt === undefined) {
      stoppedAt = now;binding = {...binding, stopObservedAt: now};yield* store.setBinding(binding);
    }
    const attention = yield* stoppedAttention(binding, supervisor, stoppedAt, teamEffects);
    if (attention) {yield* clearQuiet(binding, attention);return null;}
    // an accepted delivery without a confirmed native outcome can still start a run, so it holds the Supervisor; elapsed time never resolves it
    if (yield* requests.pending(binding.projectId, binding.threadId)) {yield* clearQuiet(binding, "stopped_request_unresolved");return null;}
    const version = fingerprint({stopped: !inactive, supervisor: activityVersion(supervisor)});
    if (binding.settlement && ["pending", "uncertain"].includes(binding.settlement.state) && binding.settlement.activityVersion !== version) {
      yield* store.setBinding({...binding, quietSince: null, settlement: {...binding.settlement, state: "superseded"}});return null;
    }
    if (binding.settlement?.state === "uncertain" && ((binding.settlement.attempts ?? 0) >= 3 || now - binding.settlement.observedAt < SUPERVISOR_SETTLE_QUIET_MS)) return null;
    return {binding, stoppedAt, version};
  });
  const settleStopped = ({binding, stoppedAt, version}: StoppedSettlement, now: number, inactive?: () => Effect.Effect<boolean, SupervisionStoreError>): Effect.Effect<void, SupervisionStoreError> => Effect.gen(function* () {
    const read = yield* attempt(projection(binding.threadId));
    if (!read.ok) {yield* clearQuiet(binding, "supervisor_unreadable");return;}
    const fresh = read.value;
    const teamEffects = yield* teamEffectsOf(binding);
    // the fresh gates, the final stop (or inactivity) recheck, the reservation and the settle command run in one admission section
    yield* sendSettlement(binding, version, now, (guard) => Effect.gen(function* () {
      if (fresh.thread.id !== binding.threadId || fresh.thread.projectId !== binding.projectId || fresh.thread.archivedAt || fresh.thread.deletedAt) {yield* clearQuiet(binding, "supervisor_unavailable");return null;}
      const freshAttention = yield* stoppedAttention(binding, fresh, stoppedAt, teamEffects);
      if (freshAttention) {yield* clearQuiet(binding, freshAttention);return null;}
      if (fingerprint({stopped: !inactive, supervisor: activityVersion(fresh)}) !== version) {yield* clearQuiet(binding, "activity_changed");return null;}
      if (inactive ? !(yield* inactive()) : !(yield* guard.supervisionStopped(binding.mainThreadId))) return null;
      return (yield* store.binding(binding.projectId, binding.mainThreadId))!;
    }));
  });
  /**
   * One settle command under the admission contract (plan 3.11): `final` runs the caller's last checks with the guard and returns
   * the binding to settle; the 'pending' reservation (the same commandId while pending or uncertain, attempts+1) and the command
   * start in the same section, its reads and writes in one transaction, and the reply and its native readback are classified
   * outside it.
   */
  /** The main and Supervisor keep independent quiet windows and human keep-active choices. */
  const settleCompletedMain = (input: BindingRecord, supervisor: Projection, threads: readonly ThreadInfo[]) => Effect.gen(function* () {
    let binding = (yield* store.binding(input.projectId, input.mainThreadId))!;
    const task = yield* store.task(binding.mainThreadId);
    const execution = task ? yield* completedExecution(binding, task) : null;
    if (!task || !execution) return;
    const read = yield* attempt(readMain(binding));
    if (!read.ok || !read.value || read.value.thread.archivedAt || read.value.thread.deletedAt) return;
    const main = read.value;
    const now = yield* Clock.currentTimeMillis;
    const held = (reason: string) => transaction(Effect.gen(function* () {
      const latest = yield* store.binding(binding.projectId, binding.mainThreadId);
      if (latest) yield* store.setBinding({...latest, mainQuietSince: null, mainSettlementBlockedBy: reason});
    }));
    const authorised = yield* admitted(guard => Effect.gen(function* () {
      return !(yield* guard.supervisionStopped(binding.mainThreadId)) && (yield* guard.scopeEnabled(binding.projectId, binding.mainThreadId));
    }));
    if (main.thread.settledAt || main.thread.settledOverride === "settled") {
      if (binding.mainSettlement && binding.mainSettlement.state !== "settled") yield* store.setBinding({...binding, mainSettlement: {...binding.mainSettlement, state: "settled"}});
      // the main is settled; the task's other T3 participants settle, or retry, on the same completed task
      if (authorised) yield* settleParticipants((yield* store.binding(binding.projectId, binding.mainThreadId)) ?? binding, execution, main, threads, now);
      return;
    }
    if (userKeepsSupervisorActive(main.thread)) {yield* held("keep_active");return;}
    const source = threads.find(thread => thread.id === binding.mainThreadId && thread.projectId === binding.projectId);
    if (!authorised) return;
    const attention = yield* mainAttention(binding, supervisor, main, false, source, yield* teamWorkOf(binding), false);
    if (attention) {yield* held(attention);return;}
    const scope = scopeFor(binding, main, threads);
    if (!scope?.complete || !scope.main) {yield* held("scope_incomplete");return;}
    const childRead = yield* attempt(relatedChildren(binding, main, threads, scope));
    if (!childRead.ok || childRead.value.blocked) {yield* held("children_active_or_unavailable");return;}
    const threadIds = [...scope.allowedIds];
    const pending = yield* monitor.hasPendingReviewableActivity(binding.projectId, threadIds);
    const workflow = yield* workflowAttention(binding, threadIds);
    if (pending.status !== "complete" || pending.pending || workflow.blocked) {yield* held("unassessed_work");return;}
    const version = fingerprint({main: activityVersion(main), children: childRead.value.version, workflow: workflow.version});
    if (binding.mainSettlement?.state === "uncertain" && binding.mainSettlement.activityVersion !== version) {yield* held("uncertain_settlement");return;}
    if (binding.mainQuietFingerprint !== version || binding.mainQuietSince == null) {
      yield* store.setBinding({...binding, mainQuietFingerprint: version, mainQuietSince: now, mainSettlementBlockedBy: "quiet_window"});return;
    }
    if (now - binding.mainQuietSince < SUPERVISOR_SETTLE_QUIET_MS) return;
    const freshRead = yield* attempt(readMain(binding));
    const ownerRead = yield* attempt(projection(binding.threadId));
    if (!freshRead.ok || !freshRead.value || !ownerRead.ok) return;
    const freshMain = freshRead.value;
    const freshChildren = yield* attempt(relatedChildren(binding, freshMain, threads, scopeFor(binding, freshMain, threads)));
    if (!freshChildren.ok || freshChildren.value.blocked) {yield* held("children_active_or_unavailable");return;}
    // the complete participant set settles with the main: its lineage descendants and the declared T3 conversations the root observed
    yield* settleParticipants(binding, execution, freshMain, threads, now);
    binding = (yield* store.binding(binding.projectId, binding.mainThreadId)) ?? binding;
    yield* sendSettlement(binding, version, now, guard => Effect.gen(function* () {
      const latest = yield* store.binding(binding.projectId, binding.mainThreadId);
      if (!latest || latest.threadId !== input.threadId || latest.generation !== input.generation ||
        (yield* guard.supervisionStopped(binding.mainThreadId)) || !(yield* guard.scopeEnabled(binding.projectId, binding.mainThreadId)) ||
        userKeepsSupervisorActive(freshMain.thread) || freshMain.thread.archivedAt || freshMain.thread.deletedAt) return null;
      const currentTask = yield* store.task(binding.mainThreadId);
      const currentExecution = currentTask ? yield* completedExecution(latest, currentTask) : null;
      if (!currentTask || !currentExecution || !sameExecution(currentExecution, execution)) return null;
      const attention = yield* mainAttention(latest, ownerRead.value, freshMain, false, source, yield* teamWorkOf(latest), false);
      if (attention) return null;
      const freshPending = yield* monitor.hasPendingReviewableActivity(binding.projectId, threadIds);
      const freshWorkflow = yield* workflowAttention(binding, threadIds);
      if (freshPending.status !== "complete" || freshPending.pending || freshWorkflow.blocked ||
        fingerprint({main: activityVersion(freshMain), children: freshChildren.value.version, workflow: freshWorkflow.version}) !== version) return null;
      binding = latest;
      return latest;
    }), true);
  });

  const sendSettlement = (owner: BindingRecord, version: string, now: number, final: (guard: GateGuard) => Effect.Effect<BindingRecord | null, SupervisionStoreError>, main = false):
    Effect.Effect<void, SupervisionStoreError> => Effect.gen(function* () {
    if (!rpc) {yield* admitted(final);return;}
    const operate = rpc;
    const fresh = `supervisor-settle:${yield* ids.uuid}`;
    const targetId = main ? owner.mainThreadId : owner.threadId;
    const key = main ? "mainSettlement" : "settlement";
    const blockedKey = main ? "mainSettlementBlockedBy" : "settlementBlockedBy";
    yield* admitSend(gate, {
      identity: targetId,
      inFlight: settlements,
      prepare: (guard) => transaction(Effect.gen(function* (): Effect.fn.Return<SendPreparation<void>, SupervisionStoreError> {
        const binding = yield* final(guard);
        if (!binding) return {_tag: "Answer", value: undefined};
        const existing = binding[key];
        const settlement = existing && ["pending", "uncertain"].includes(existing.state) ? existing : {commandId: fresh, state: "pending" as const, observedAt: now, activityVersion: version, attempts: 0};
        const sending = {...settlement, attempts: (settlement.attempts ?? 0) + 1, observedAt: now};
        yield* store.setBinding({...binding, [key]: sending});
        // the settled check and the uncertain write are one transaction; a failed write is a defect of the in-flight operation
        const uncertain = transaction(Effect.gen(function* () {
          const latest = yield* store.binding(binding.projectId, binding.mainThreadId);
          if (latest && latest[key]?.state !== "settled") yield* store.setBinding({...latest, [key]: {...sending, state: "uncertain"}});
        })).pipe(Effect.orDie);
        return {_tag: "Initiate", initiate: Effect.map(operate.initiate("orchestration.dispatchCommand", {type: "thread.settle", commandId: settlement.commandId, threadId: targetId}), (flight) => ({
          result: Effect.gen(function* () {
            const outcome = yield* attempt(Effect.gen(function* () {
              const receipt = yield* flight.result;
              if (!record(receipt) || !Number.isSafeInteger(receipt.sequence)) return yield* new SupervisorRpcError("uncertain");
              const current = yield* projection(targetId);
              yield* transaction(Effect.gen(function* () {
                const latest = yield* store.binding(binding.projectId, binding.mainThreadId);
                if (latest) yield* store.setBinding({...latest, [blockedKey]: null, [key]: {...sending, state: current.thread.settledAt || current.thread.settledOverride === "settled" ? "settled" : current.thread.settledOverride === "active" ? "superseded" : "uncertain"}});
              })).pipe(Effect.orDie);
            }));
            if (outcome.ok) return;
            if (outcome.cause instanceof SupervisorRpcError && outcome.cause.definiteRejection) yield* transaction(Effect.gen(function* () {
              const latest = yield* store.binding(binding.projectId, binding.mainThreadId);
              if (latest) yield* store.setBinding({...latest, [main ? "mainQuietSince" : "quietSince"]: null, [key]: {...sending, state: "superseded"}});
            })).pipe(Effect.orDie);
            else yield* uncertain;
          }).pipe(Effect.onInterrupt(() => uncertain)),
          release: flight.release,
        }))};
      })),
      reconcile: Effect.void,
    });
  });
  // the task's current completed execution as every settlement path reads it: a not-needed observable request (no document, so no
  // completion record), or an agreed task whose bound main workflow document is completed with every applicable member settled and no
  // pending return, identified by the document's latest completion record; null while the task is not complete
  type ExecutionStamp = {taskId: string; taskRevision: string; completionId: string | null};
  const sameExecution = (left: ExecutionStamp, right: ExecutionStamp) => left.taskId === right.taskId && left.taskRevision === right.taskRevision && left.completionId === right.completionId;
  const completedExecution = (binding: BindingRecord, task: TaskRecord): Effect.Effect<ExecutionStamp | null, SupervisionStoreError> => Effect.gen(function* () {
    if (task.status !== "inferred") return null;
    const stamp = {taskId: task.id, taskRevision: taskScopeRevision(task)};
    if (task.supervision === "not_needed" && conversationMayObserve(task)) return {...stamp, completionId: null};
    if (!workflows || task.agreement?.status !== "agreed") return null;
    const document = yield* workflows.get(binding.projectId, binding.mainThreadId);
    if (!document || document.sourceBinding?.taskId !== task.id || document.sourceBinding.sourceHash !== taskScopeRevision(task) || document.status !== "completed" ||
      document.returns.some(item => item.state === "pending") || unsettledOccurrences(document.plan, documentBranchSelections(document),
        notApplicableNodeIds(document.evidence, document.sourceBinding?.sourceHash ?? null)).length !== 0) return null;
    return {...stamp, completionId: completionRecordId(document)};
  });
  // the T3-managed participants of a completed task: the main's lineage descendants (not forks) and the T3 conversations the main
  // workflow's contributions declared; an external or unknown participant has nothing to settle
  type ParticipantTarget = {threadId: string; environmentId: string | null};
  const participantTargets = (binding: BindingRecord, scope: SupervisorScopeResolution): Effect.Effect<ParticipantTarget[], SupervisionStoreError> => Effect.gen(function* () {
    const targets = new Map<string, ParticipantTarget>();
    for (const child of scope.descendants) if (scope.allowedIds.has(child.id) && child.lineage.relationshipToParent !== "fork" && !child.deletedAt && !child.archivedAt)
      targets.set(settlementKey(child.id, null), {threadId: child.id, environmentId: null});
    const document = workflows ? yield* workflows.get(binding.projectId, binding.mainThreadId) : null;
    if (document) for (const participant of workflowParticipants(document, [], new Map(), new Map())) {
      if (participant.source !== "declared" || participant.kind !== "t3_conversation" || !participant.threadId) continue;
      const key = settlementKey(participant.threadId, participant.environmentId);
      if (!targets.has(key)) targets.set(key, {threadId: participant.threadId, environmentId: participant.environmentId});
    }
    return [...targets.values()];
  });
  // one participant's rows, one per execution: the rows of earlier executions stay as history and prove nothing for the current one
  const sameParticipant = (row: ParticipantSettlement, target: ParticipantTarget) => settlementKey(row.threadId, row.environmentId) === settlementKey(target.threadId, target.environmentId);
  const participantRows = (binding: BindingRecord, target: ParticipantTarget) => (binding.participantSettlements ?? []).filter(row => sameParticipant(row, target));
  const participantRow = (binding: BindingRecord, execution: ExecutionStamp, target: ParticipantTarget) => participantRows(binding, target).find(row => sameExecution(row, execution));
  const withParticipantRow = (binding: BindingRecord, entry: ParticipantSettlement): BindingRecord =>
    ({...binding, participantSettlements: [...(binding.participantSettlements ?? []).filter(row => !(sameParticipant(row, entry) && sameExecution(row, entry))), entry]});
  const PARTICIPANT_SETTLE_ATTEMPTS = 3;
  const openReasons = new Set(["unavailable", "not_quiet", "snapshot_unavailable"]);
  // a reserved command whose native outcome is still unknown: sent (pending), its reply lost (uncertain), or its last read inconclusive
  const commandOpen = (row: ParticipantSettlement) => row.commandId !== null && typeof row.snapshotAt === "string" &&
    (row.state === "pending" || row.state === "uncertain" || (row.state === "unresolved" && openReasons.has(row.reason ?? "")));
  const openCommand = (binding: BindingRecord, target: ParticipantTarget) => participantRows(binding, target).find(commandOpen);
  // a row its execution never evaluates again: settled, superseded, definitely rejected, without a supported route, or its one command
  // sent the bounded number of times
  const participantTerminal = (row: ParticipantSettlement) => row.state === "settled" || row.state === "superseded" || row.reason === "settle_rejected" ||
    row.reason === "environment_settle_unsupported" || (row.commandId !== null && (row.attempts ?? 0) >= PARTICIPANT_SETTLE_ATTEMPTS);
  const recordParticipant = (owner: BindingRecord, entry: ParticipantSettlement) => transaction(Effect.gen(function* () {
    const latest = yield* store.binding(owner.projectId, owner.mainThreadId);
    if (!latest || latest.threadId !== owner.threadId || latest.generation !== owner.generation) return;
    yield* store.setBinding(withParticipantRow(latest, entry));
  }));
  /**
   * Settles the participants of the current completed execution once each, by their own automatic-settle commands, after the main's
   * lineage read found every child quiet. A participant's earlier command whose outcome is unknown is resolved first and identically: its
   * reserved payload never changes, so a settled read confirms it, native activity after its snapshot or its user's choice supersedes it, a
   * quiet unchanged read retries it (at most three sends; the bound ends the sends, never the command), and no second command is reserved
   * while it is open, on any execution. The execution then gets at
   * most one command of its own: a local conversation settles on the snapshot its fresh read showed when it is quiet and not kept active by
   * its user, a conversation in a linked environment is listed unsupported, and what cannot settle is recorded with its reason and read
   * afresh on each pass. A new completed execution (a later task, or the same task completed again after a return) evaluates every
   * participant anew while the earlier rows stay as history.
   */
  const settleParticipants = (binding: BindingRecord, execution: ExecutionStamp, main: Projection, threads: readonly ThreadInfo[], now: number) => Effect.gen(function* () {
    const scope = scopeFor(binding, main, threads);
    if (!scope?.complete || !scope.main) return;
    const children = yield* attempt(relatedChildren(binding, main, threads, scope));
    if (!children.ok || children.value.blocked) return;
    const version = children.value.version;
    for (const target of yield* participantTargets(binding, scope)) {
      const fresh = (): ParticipantSettlement => ({...execution, threadId: target.threadId, environmentId: target.environmentId, commandId: null, state: "unresolved",
        observedAt: now, activityVersion: version, attempts: 0, reason: null, snapshotAt: null});
      // the local command handler settles local threads only: no supported route settles a linked environment's conversation from here
      if (target.environmentId !== null) {
        if (!participantRow(binding, execution, target)) yield* recordParticipant(binding, {...fresh(), reason: "environment_settle_unsupported"});
        continue;
      }
      const info = threads.find(thread => thread.id === target.threadId);
      if (info?.deletedAt || info?.archivedAt) continue;
      let latest = binding;
      let read: Attempt<Projection> | null = null;
      const open = openCommand(binding, target);
      if (open) {
        if ((open.state === "pending" || open.state === "uncertain") && now - open.observedAt < SUPERVISOR_SETTLE_QUIET_MS) continue;
        read = yield* attempt(projection(target.threadId));
        const resolve = (state: ParticipantSettlement["state"], reason: string | null) => recordParticipant(binding, {...open, state, reason, observedAt: now, activityVersion: version});
        if (!read.ok || read.value.thread.id !== target.threadId) {yield* resolve("unresolved", "unavailable"); continue;}
        const thread = read.value.thread;
        if (thread.settledAt || thread.settledOverride === "settled") yield* resolve("settled", null);
        else if (typeof thread.updatedAt !== "string") {yield* resolve("unresolved", "snapshot_unavailable"); continue;}
        else if (thread.updatedAt !== open.snapshotAt) yield* resolve("superseded", "activity_changed");
        else if (userKeepsSupervisorActive(thread)) yield* resolve("superseded", "keep_active");
        else if (projectionNeedsAttention(read.value, info ?? thread)) {yield* resolve("unresolved", "not_quiet"); continue;}
        // the bound ends the sends, not the command: elapsed attempts are no native evidence, so an unchanged quiet thread keeps the
        // command open, on this and every later execution, until a settled read, new activity or the user's choice reconciles it
        else if ((open.attempts ?? 0) >= PARTICIPANT_SETTLE_ATTEMPTS) continue;
        else {yield* sendParticipantSettlement(binding, execution, scope, target, {retry: open}, version, now); continue;}
        latest = (yield* store.binding(binding.projectId, binding.mainThreadId)) ?? binding;
      }
      const current = participantRow(latest, execution, target);
      if (current && participantTerminal(current)) continue;
      const note = (state: ParticipantSettlement["state"], reason: string | null) => recordParticipant(latest, {...fresh(), state, reason});
      read ??= yield* attempt(projection(target.threadId));
      if (!read.ok || read.value.thread.id !== target.threadId) {yield* note("unresolved", "unavailable"); continue;}
      const thread = read.value.thread;
      if (thread.settledAt || thread.settledOverride === "settled") {yield* note("settled", null); continue;}
      if (userKeepsSupervisorActive(thread)) {yield* note("skipped", "keep_active"); continue;}
      if (projectionNeedsAttention(read.value, info ?? thread)) {yield* note("unresolved", "not_quiet"); continue;}
      if (typeof thread.updatedAt !== "string") {yield* note("unresolved", "snapshot_unavailable"); continue;}
      yield* sendParticipantSettlement(latest, execution, scope, target, {snapshotAt: thread.updatedAt}, version, now);
    }
  });
  // one participant's automatic settle, admitted like the main's: a retry resends the reserved payload unchanged, a new command is
  // reserved only for an execution with no command yet and no open command on any earlier one, and either goes out only while the same
  // execution is still complete and the participant still a member. The record moves pending → settled (a fresh read confirms it),
  // superseded when its user reactivated it, uncertain on a lost reply, unresolved on a definite rejection, which a changed snapshot or a
  // user's override produces; every callback write is fenced to the owner root, its generation and this command
  const sendParticipantSettlement = (owner: BindingRecord, execution: ExecutionStamp, scope: SupervisorScopeResolution, target: ParticipantTarget,
    command: {retry: ParticipantSettlement} | {snapshotAt: string}, version: string, now: number): Effect.Effect<void, SupervisionStoreError> => Effect.gen(function* () {
    if (!rpc) return;
    const operate = rpc;
    const fresh = `supervisor-settle:${yield* ids.uuid}`;
    yield* admitSend(gate, {
      identity: `participant:${settlementKey(target.threadId, target.environmentId)}`,
      inFlight: settlements,
      prepare: (guard) => transaction(Effect.gen(function* (): Effect.fn.Return<SendPreparation<void>, SupervisionStoreError> {
        const binding = yield* store.binding(owner.projectId, owner.mainThreadId);
        if (!binding || binding.threadId !== owner.threadId || binding.generation !== owner.generation ||
          (yield* guard.supervisionStopped(owner.mainThreadId)) || !(yield* guard.scopeEnabled(owner.projectId, owner.mainThreadId))) return {_tag: "Answer", value: undefined};
        // the completion this command rests on is read again in the section: a correction or return that reopened the document while an
        // earlier participant's command waited leaves nothing to settle
        const task = yield* store.task(owner.mainThreadId);
        const current = task ? yield* completedExecution(binding, task) : null;
        if (!current || !sameExecution(current, execution)) return {_tag: "Answer", value: undefined};
        if (!(yield* participantTargets(binding, scope)).some(item => settlementKey(item.threadId, item.environmentId) === settlementKey(target.threadId, target.environmentId)))
          return {_tag: "Answer", value: undefined};
        const reserved = "retry" in command ? participantRows(binding, target).find(row => sameExecution(row, command.retry)) : undefined;
        if ("retry" in command && (!reserved || reserved.commandId !== command.retry.commandId || !commandOpen(reserved) || (reserved.attempts ?? 0) >= PARTICIPANT_SETTLE_ATTEMPTS))
          return {_tag: "Answer", value: undefined};
        if (!("retry" in command) && (openCommand(binding, target) || participantRow(binding, execution, target)?.commandId)) return {_tag: "Answer", value: undefined};
        const sending: ParticipantSettlement = reserved
          ? {...reserved, state: "pending", attempts: (reserved.attempts ?? 0) + 1, observedAt: now, activityVersion: version, reason: null}
          : {...execution, threadId: target.threadId, environmentId: target.environmentId, commandId: fresh, state: "pending", observedAt: now, activityVersion: version,
            attempts: 1, reason: null, snapshotAt: "retry" in command ? null : command.snapshotAt};
        yield* store.setBinding(withParticipantRow(binding, sending));
        const mark = (state: ParticipantSettlement["state"], reason: string | null) => transaction(Effect.gen(function* () {
          const latest = yield* store.binding(owner.projectId, owner.mainThreadId);
          const row = latest ? participantRows(latest, target).find(item => sameExecution(item, sending)) : undefined;
          if (latest && latest.threadId === owner.threadId && latest.generation === owner.generation && row?.commandId === sending.commandId && row.state !== "settled")
            yield* store.setBinding(withParticipantRow(latest, {...sending, state, reason}));
        })).pipe(Effect.orDie);
        const payload = {type: "thread.auto-settle", commandId: sending.commandId, threadId: target.threadId, snapshotAt: sending.snapshotAt};
        return {_tag: "Initiate", initiate: Effect.map(operate.initiate("orchestration.dispatchCommand", payload), (flight) => ({
          result: Effect.gen(function* () {
            const outcome = yield* attempt(Effect.gen(function* () {
              const receipt = yield* flight.result;
              if (!record(receipt) || !Number.isSafeInteger(receipt.sequence)) return yield* new SupervisorRpcError("uncertain");
              const current = yield* projection(target.threadId);
              yield* mark(current.thread.settledAt || current.thread.settledOverride === "settled" ? "settled" : current.thread.settledOverride === "active" ? "superseded" : "uncertain", null);
            }));
            if (outcome.ok) return;
            if (outcome.cause instanceof SupervisorRpcError && outcome.cause.definiteRejection) yield* mark("unresolved", "settle_rejected");
            else yield* mark("uncertain", null);
          }).pipe(Effect.onInterrupt(() => mark("uncertain", null))),
          release: flight.release,
        }))};
      })),
      reconcile: Effect.void,
    });
  });
  const clearQuiet = (binding: BindingRecord, blockedBy: string) => {
    const next = {...binding, quietSince: null, settlementBlockedBy: blockedBy};delete next.quietFingerprint;
    if (next.settlement?.state !== "uncertain") delete next.settlement;
    return store.setBinding(next);
  };
  return {readMain, check, parkInactive} satisfies SupervisorLifecycleShape;
});

// the quiet-window settlement of owned Supervisors over the supervision stores, the conversation's status, the admission section
// and the native clients
export class SupervisorLifecycle extends Context.Service<SupervisorLifecycle, SupervisorLifecycleShape>()("t3-supervisor/SupervisorLifecycle") {
  static readonly make = makeSupervisorLifecycle;
  static readonly layer = Layer.effect(SupervisorLifecycle, makeSupervisorLifecycle);
}
