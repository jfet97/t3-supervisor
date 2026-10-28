import { collectNativeReads } from "./supervisor-awareness.js";
import { NativeRpc } from "./supervisor-native.js";
import {helperCore} from "./supervisor-helper-instructions.js";
import { Cause, Clock, Context, Data, Deferred, Effect, Exit, HashMap, HashSet, Layer, Option, Ref } from "effect";
import { GuidanceDb } from "./db.js";
import { guidanceTransaction, type SupervisionStoreError } from "./guidance-sql.js";
import { ProjectSupervisorStore, type BindingRecord } from "./project-supervisor-store.js";
import { SUPERVISOR_MONITOR_COOLDOWN_MS, SUPERVISOR_TEAM_ATTENTION_MS, type SupervisorMonitorBatch, type SupervisorMonitorThreadBatch } from "./supervisor-monitor.js";
import { ProjectSupervisorMonitorStore, type InvalidMonitorObservation } from "./supervisor-monitor-store.js";
import { conversationRequestMessageId, SupervisorConversationStore, type ConversationRequest, type RequestInflight } from "./supervisor-conversation-store.js";
import { endedWithoutCompletion, notificationClosed, SupervisorTeamStore, type HandoverAttempt, type SupervisorTeamSnapshot, type TeamEvent, type TeamMember, type TeamNotification, type TeamRequest, type TeamRequestTarget } from "./supervisor-team-store.js";
import { T3Client } from "./t3.js";
import { helperDeliveryBudget, HelperTransport, type HelperTransportShape, type SupervisorHelperMessage, type SupervisorHelperSendResult } from "./supervisor-helper-transport.js";
import { SupervisionGate, SupervisionScopeService, type GateGuard } from "./supervision-gate.js";
import { SupervisorIds } from "./ids.js";
import { fingerprint } from "./guidance-store.js";
import type { MessageInfo, Projection, ThreadInfo } from "./types.js";
import { resolveSupervisorScope } from "./supervisor-scope.js";
import { workflowMutationLimits } from "./workflow-state-contract.js";
import { configuredWorkflowToolRoutes } from "./workflow-write-evidence.js";


export type SupervisorTeamHelperBatch = {
  actorThreadId: string;
  memberEpoch: number;
  targets: TeamRequestTarget[];
  batch: SupervisorMonitorBatch;
};

export type SupervisorTeamPartition = {
  rootBatch: SupervisorMonitorBatch | null;
  helperBatches: SupervisorTeamHelperBatch[];
  rootEvents: TeamEvent[];
};

type SupervisorTeamRootCoverage = "root" | "transferring" | "unavailable";

export type SupervisorTeamRuntimeOptions = {
  // whether supervision of the owning main is stopped, read with the admission guard right before every fresh helper
  // delivery; by default the per-chat stop or a disabled scope of that main
  readonly stopped?: (guard: GateGuard, mainThreadId: string) => Effect.Effect<boolean, SupervisionStoreError>;
};

const terminal = new Set(["completed", "failed", "interrupted", "cancelled", "rolled_back"]);
const batchTriggerOrder = ["priority", "active_watch", "activity_threshold", "activity_age", "saturated"];
// the most a helper check-in may occupy once T3 has rendered it, in UTF-16 code units
const maxHelperCheckinRenderedLength = 40_000;
// names the size policy in overflow attention identities, so an event recorded under an earlier policy cannot collide
const helperCheckinSizePolicy = "rendered-40000-body-65536";
const hasCompletionMarker = (text: string, marker: string): boolean => text.trim().replace(/[\s`*_.,!?:;'"()]+$/u, "").endsWith(marker);
const isActivityReferenceId = (value: string): boolean => value.length > 0 && value.length <= workflowMutationLimits.maxNativeReferenceLength &&
  value.trim().length > 0;
// an exact native handle of a previewed record; with its target's threadId as sourceThreadId it is a workflow_write reference
const helperActivityReference = (sourceThreadId: string, activity: SupervisorMonitorThreadBatch["items"][number]) => {
  if (!isActivityReferenceId(sourceThreadId)) return null;
  if (activity.readItemId !== null)
    return isActivityReferenceId(activity.readItemId) ? {sourceItemId: activity.readItemId} : null;
  const messagePrefix = "message:";
  if (!activity.id.startsWith(messagePrefix)) return null;
  const sourceMessageId = activity.id.slice(messagePrefix.length);
  return isActivityReferenceId(sourceMessageId) ? {sourceMessageId} : null;
};

const scopedBatch = (batch: SupervisorMonitorBatch, threads: SupervisorMonitorThreadBatch[]): SupervisorMonitorBatch | null => {
  if (!threads.length) return null;
  const trigger = [...threads].map(thread => thread.trigger).sort((left, right) => batchTriggerOrder.indexOf(left) - batchTriggerOrder.indexOf(right))[0] ?? batch.trigger;
  return {...batch, trigger, pendingItemCount: threads.reduce((count, thread) => count + thread.pendingItemCount, 0),
    finalizedActivityCount: threads.reduce((count, thread) => count + thread.finalizedActivityCount, 0), threads};
};

// a notification is one event line: its handles, the exact read that returns its record, and its marker. Only an attempt
// that was never posted is generated from this; a posted attempt keeps the exact bytes of its receipt
export function teamNotificationText(binding: BindingRecord, notification: TeamNotification): {text: string; marker: string} {
  const attempt = notification.deliveryAttempt ?? 0;
  const marker = `Supervisor team notification ${notification.id} attempt ${attempt} completed`;
  const read = {action: "read", supervisorThreadId: notification.recipientThreadId, bindingGeneration: binding.generation, memberEpoch: notification.memberEpoch};
  return {marker, text: `${helperCore}\nTeam notification ${notification.id} (${notification.kind}): read it with supervision_team ${JSON.stringify(read)}.\nEnd with: ${marker}`};
}

// the transport predicate admits only the attributed delivery message. Every run strongly linked to it, by its
// userMessageId or by the message's own runId, counts; a live run keeps the attempt open. A marker in another
// message or a non-final/streaming answer is no ACK.
export function teamNotificationEvidence(projection: Projection, notification: TeamNotification, marker: string,
  matches: (message: Projection["messages"][number]) => boolean) {
  const messages = projection.messages.filter(message => message.threadId === notification.recipientThreadId && message.role === "user" && matches(message));
  const messageIds = new Set(messages.map(message => message.id));
  const messageRunIds = new Set(messages.flatMap(message => typeof message.runId === "string" ? [message.runId] : []));
  const runs = projection.runs.filter(run => run.threadId === notification.recipientThreadId &&
    (typeof run.userMessageId === "string" && messageIds.has(run.userMessageId) || messageRunIds.has(run.id)));
  // completion counts only once every strongly linked run is terminal: a live or unknown-status copy defers it
  const settled = runs.every(run => run.status === "completed" || endedWithoutCompletion.has(run.status));
  const completedRun = !settled ? undefined : runs.find(run => run.status === "completed" && typeof run.userMessageId === "string" && messageIds.has(run.userMessageId) &&
    !projection.messages.some(item => item.threadId === notification.recipientThreadId && item.runId === run.id && item.role === "user" && !messageIds.has(item.id) && typeof item.senderThreadId !== "string") &&
    hasCompletionMarker(projection.messages.filter(item => item.threadId === notification.recipientThreadId && item.runId === run.id &&
      item.role === "assistant" && item.streaming !== true && typeof item.text === "string")
      .sort((left, right) => Number(left.ordinal ?? 0) - Number(right.ordinal ?? 0)).at(-1)?.text ?? "", marker));
  return {message: messages[0], runs, completedRun};
}

// one check-in target: its pins, counts and exact handles; whether it may be written is stated only when it may not
const checkinTarget = (target: TeamRequestTarget, monitored: SupervisorMonitorThreadBatch, thread: ThreadInfo | undefined) => {
  const writable = Boolean(thread && !thread.archivedAt && !thread.deletedAt);
  const refs = monitored.previewItems.flatMap(item => {
    const reference = helperActivityReference(target.targetThreadId, item);
    return reference ? [reference] : [];
  });
  return {threadId: target.targetThreadId, assignmentRootThreadId: target.assignmentRootThreadId, assignmentEpoch: target.assignmentEpoch,
    pending: monitored.pendingItemCount, ...(monitored.priorityKinds.length ? {priority: monitored.priorityKinds} : {}),
    ...(monitored.untrackedCount ? {untracked: monitored.untrackedCount} : {}), ...(refs.length ? {refs} : {}),
    ...(writable ? {} : {writable: false, reason: thread ? "target_archived_or_deleted" as const : "target_thread_unavailable" as const})};
};

// a check-in is one event: the helper's authority once, its targets, the handles of its open notifications and its marker
const helperCheckinText = (authority: {supervisorThreadId: string; bindingGeneration: number; memberEpoch: number},
  targets: ReadonlyArray<ReturnType<typeof checkinTarget>>, notifications: ReadonlyArray<TeamNotification>, completionMarker: string): string =>
  `${helperCore}\nHelper check-in: assess these targets.\nauthority ${JSON.stringify(authority)}\ntargets ${JSON.stringify(targets)}\n` +
  `${notifications.length ? `notifications ${JSON.stringify(notifications.map(value => ({id: value.id, kind: value.kind})))}\n` : ""}End with: ${completionMarker}`;


type Cancel = Deferred.Deferred<void> | undefined;

// a store failure of a team operation; the native outcomes stay values
type TeamRuntimeError = SupervisionStoreError | InvalidMonitorObservation | RequestInflight;

export interface SupervisorTeamRuntimeShape {
  // a fresh bounded read budget for one supervision cycle of this root
  readonly startCycle: (binding: BindingRecord) => Effect.Effect<void>;
  readonly rootOwnedBatch: (binding: BindingRecord, batch: SupervisorMonitorBatch, threads: readonly ThreadInfo[]) => Effect.Effect<SupervisorMonitorBatch | null, SupervisionStoreError>;
  readonly partition: (binding: BindingRecord, threads: readonly ThreadInfo[], batch: SupervisorMonitorBatch | null) => Effect.Effect<SupervisorTeamPartition, SupervisionStoreError>;
  readonly hasMembers: (binding: BindingRecord) => Effect.Effect<boolean, SupervisionStoreError>;
  readonly coordinatorPolicy: (binding: BindingRecord) => Effect.Effect<{maxHelpersPerRoot: number; readyHelpers: number; registeringHelpers: number}, SupervisionStoreError>;
  readonly acknowledgeRootEvents: (binding: BindingRecord, eventIds: readonly string[]) => Effect.Effect<void, SupervisionStoreError>;
  /**
   * Team effects that are still in flight: an unresolved team request, a notification being delivered and any helper request.
   * A human stop waits only for these. A transfer is bookkeeping whose native effects are exactly its notices and requests,
   * and review-only events and undelivered notices are superseded by the stop.
   */
  readonly hasInflightEffects: (binding: BindingRecord) => Effect.Effect<boolean, SupervisionStoreError>;
  readonly hasBlockingWork: (binding: BindingRecord) => Effect.Effect<boolean, SupervisionStoreError>;
  /**
   * Observation-only reconciliation while a human has stopped supervision of this chat, also while supervision is disabled.
   * Nothing is sent, retried or retired: requests and notices that were never posted are fenced, accepted helper check-ins
   * and notices are matched to their native outcome, lost members close their work and finished transfers complete, so stop
   * settlement never waits only because ordinary processing is skipped. An effect whose delivery cannot be proven either way
   * keeps its identity and remains unresolved.
   */
  readonly reconcileStopped: (binding: BindingRecord, threads: readonly ThreadInfo[], cancel?: Cancel) => Effect.Effect<void, TeamRuntimeError>;
  readonly reconcile: (binding: BindingRecord, threads: readonly ThreadInfo[], cancel?: Cancel) => Effect.Effect<void, TeamRuntimeError>;
  readonly runHelperBatch: (binding: BindingRecord, threads: readonly ThreadInfo[], batches: readonly SupervisorTeamHelperBatch[], cancel?: Cancel) => Effect.Effect<void, TeamRuntimeError>;
}

// a caller's cancel completed during an awaited read: it ends like the aborted read it replaces
class Cancelled extends Data.TaggedError("Cancelled") {}
// whether the caller gave up, as the baseline signal.aborted checks
const cancelled = (cancel: Cancel): Effect.Effect<boolean> => cancel === undefined ? Effect.succeed(false) : Deferred.isDone(cancel);
// the baseline catch-all around a call: any failure or defect gives the fallback; an interruption stays an interruption
const otherwise = <B>(fallback: B) => <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A | B, never, R> =>
  Effect.catchCauseIf(effect, (cause) => !Cause.hasInterruptsOnly(cause), () => Effect.succeed(fallback)) as Effect.Effect<A | B, never, R>;
const lastAssistantText = (projection: Projection, runId: string): string | undefined =>
  projection.messages.filter(item => item.runId === runId && item.role === "assistant" && item.streaming !== true && typeof item.text === "string")
    .sort((left, right) => Number(left.ordinal ?? 0) - Number(right.ordinal ?? 0)).at(-1)?.text;

const makeSupervisorTeamRuntime = (options: SupervisorTeamRuntimeOptions = {}) => Effect.gen(function* () {
  const gate = yield* SupervisionGate;
  const t3 = yield* T3Client;
  const readRpc = Option.getOrNull(yield* Effect.serviceOption(NativeRpc));
  // the exact native routes of this deployment's registrations, on which a helper's own thread reads are recognised
  const nativeRoutes = configuredWorkflowToolRoutes((yield* SupervisionScopeService).config);
  const ids = yield* SupervisorIds;
  const store = yield* ProjectSupervisorStore;
  const teamStore = yield* SupervisorTeamStore;
  const requests = yield* SupervisorConversationStore;
  const monitor = yield* ProjectSupervisorMonitorStore;
  const transaction = guidanceTransaction(yield* GuidanceDb);
  const transport: HelperTransportShape | null = Option.getOrNull(yield* Effect.serviceOption(HelperTransport));
  const helperOffset = yield* Ref.make(HashMap.empty<string, number>());
  const notificationOffset = yield* Ref.make(HashMap.empty<string, number>());
  const transferOffset = yield* Ref.make(HashMap.empty<string, number>());
  const readBudget = yield* Ref.make(HashMap.empty<string, number>());
  const retiredHelpers = yield* Ref.make(HashSet.empty<string>());
  const projectOf = (mainThreadId: string) => Effect.map(store.bindings(), (bindings) => bindings.find(item => item.mainThreadId === mainThreadId)?.projectId ?? "");
  const stoppedWith = options.stopped ?? ((guard: GateGuard, mainThreadId: string) => Effect.gen(function* () {
    return (yield* guard.supervisionStopped(mainThreadId)) || !(yield* guard.scopeEnabled(yield* projectOf(mainThreadId), mainThreadId));
  }));
  const offsetOf = (ref: Ref.Ref<HashMap.HashMap<string, number>>, key: string) =>
    Effect.map(Ref.get(ref), (offsets) => Option.getOrElse(HashMap.get(offsets, key), () => 0));
  const setOffset = (ref: Ref.Ref<HashMap.HashMap<string, number>>, key: string, value: number) => Ref.update(ref, HashMap.set(key, value));

  const startCycle = (binding: BindingRecord) => Ref.update(readBudget, HashMap.set(binding.threadId, 5));
  // the per-chat stop and scope of the owning main, read with the admission guard
  const stopped = (binding: BindingRecord) => gate.admit((guard) => transaction(stoppedWith(guard, binding.mainThreadId)));
  const memberUnchanged = (binding: BindingRecord, member: TeamMember) => Effect.map(teamStore.snapshot(binding), (snapshot) => {
    const current = snapshot.members.find(value => value.threadId === member.threadId);
    return current?.state === member.state && current.epoch === member.epoch;
  });

  const consumeReadBudget = (binding: BindingRecord) => Ref.modify(readBudget, (budgets): [boolean, HashMap.HashMap<string, number>] => {
    const remaining = Option.getOrElse(HashMap.get(budgets, binding.threadId), () => 5);
    if (remaining <= 0) return [false, budgets];
    return [true, HashMap.set(budgets, binding.threadId, remaining - 1)];
  });

  const unresolvedDeliveryTooLong = (request: ConversationRequest) => Effect.map(Clock.currentTimeMillis, (now) => {
    const hasDeliveryIdentity = request.sentAt !== null;
    const repeatedBusy = request.state === "prepared" && request.error !== null;
    const startedAt = request.sentAt ?? (repeatedBusy ? request.createdAt : null);
    return (hasDeliveryIdentity && ["waiting", "uncertain"].includes(request.state) || repeatedBusy) && startedAt !== null &&
      now - startedAt >= SUPERVISOR_TEAM_ATTENTION_MS;
  });

  // a replaced binding owns its own service events: any failure of the event write is ignored, as the baseline catch did
  const emitServiceAttention = (binding: BindingRecord, eventId: string, memberThreadId: string, targetThreadId: string | undefined, summary: string) =>
    teamStore.serviceAttention(binding, {eventId, memberThreadId, ...(targetThreadId ? {targetThreadId} : {}), summary}).pipe(Effect.asVoid, otherwise(undefined));

  const serviceUnresolvedDelivery = (binding: BindingRecord, memberThreadId: string, request: ConversationRequest) => {
    const targetThreadId = request.batch?.threads[0]?.threadId;
    return emitServiceAttention(binding, `helper-checkin-unresolved:${fingerprint([binding.threadId, binding.generation, memberThreadId, request.id]).slice(0, 32)}`,
      memberThreadId, targetThreadId,
      `Helper check-in ${request.id} has no visible terminal native run after bounded reconciliation. No success or rejection is confirmed; preserve its original request and delivery identities, do not retry or acknowledge it as failed, and keep assigned activity fenced.`);
  };

  const hasUnacknowledgedFailure = (binding: BindingRecord, memberThreadId: string) =>
    Effect.map(requests.requests(binding.projectId, memberThreadId), (owned) => owned.some(request => request.kind === "review" &&
      (request.id.startsWith("team-review:") || request.id.startsWith("team-ready:")) && request.state === "failed" && !request.failureAcknowledged));

  const serviceAttention = (binding: BindingRecord, memberThreadId: string, request: ConversationRequest, summary: string) => {
    const targetThreadId = request.batch?.threads[0]?.threadId;
    return emitServiceAttention(binding, `helper-checkin-failed:${fingerprint([binding.threadId, binding.generation, memberThreadId, request.id]).slice(0, 32)}`,
      memberThreadId, targetThreadId, `Helper check-in failed: ${request.error ?? summary}`);
  };

  // the messages of `messages` whose receipt attribution the transport confirms for this logical delivery
  const matchedMessages = (binding: BindingRecord, logicalMessageId: string, text: string, messages: readonly MessageInfo[],
    candidate: (message: MessageInfo) => boolean) => Effect.gen(function* () {
    const matched = new Set<MessageInfo>();
    if (!transport) return matched;
    for (const message of messages)
      if (candidate(message) && (yield* transport.matchesMessage(binding, logicalMessageId, text, message, messages))) matched.add(message);
    return matched;
  });
  const firstMatch = (binding: BindingRecord, logicalMessageId: string, text: string, projection: Projection, threadId: string) =>
    Effect.map(matchedMessages(binding, logicalMessageId, text, projection.messages, item => item.threadId === threadId),
      (matched) => projection.messages.find(item => matched.has(item)));

  const retireHelper = (binding: BindingRecord, memberThreadId: string, cancel: Cancel) => Effect.gen(function* () {
    if (!transport) return;
    const key = `${binding.threadId}:${binding.generation}:${memberThreadId}`;
    if (HashSet.has(yield* Ref.get(retiredHelpers), key)) return;
    // retry a failed native channel retirement on a later cycle
    if (yield* transport.retire(binding, memberThreadId, cancel).pipe(otherwise(false))) yield* Ref.update(retiredHelpers, HashSet.add(key));
  });

  const loseMember = (binding: BindingRecord, member: TeamMember, cancel: Cancel, reason: string, retire = true) => Effect.gen(function* () {
    // the member state, its closed requests, their service events and the settled fences commit together
    const lost = yield* transaction(Effect.gen(function* () {
      const current = (yield* teamStore.snapshot(binding)).members.find(value => value.threadId === member.threadId);
      // the loss applies only to the exact member state and epoch its caller observed: a transition committed since that
      // observation (for example ready at a newer epoch) is never marked missing, its requests are never closed and its
      // channel is never retired
      if (current?.state !== member.state || current.epoch !== member.epoch) return false;
      // quarantine is terminal for service handling: its requests and notices stay fenced and it never becomes missing
      if (current.state === "quarantined") return false;
      if (current.state !== "missing" && current.state !== "retired") yield* teamStore.markMissing(binding, member.threadId);
      const owned = (yield* requests.requests(binding.projectId, member.threadId)).filter(request => request.kind === "review" &&
        (request.id.startsWith("team-review:") || request.id.startsWith("team-ready:")) &&
        (["prepared", "sending", "waiting", "uncertain"].includes(request.state) || request.state === "failed" && !request.failureAcknowledged));
      for (const request of owned) {
        const failed = request.state === "failed" ? {...request, error: request.error ?? reason} : {...request, state: "failed" as const, error: reason};
        if (request.state !== "failed" || !request.error) yield* requests.saveRequest(failed);
        yield* serviceAttention(binding, member.threadId, failed, reason);
      }
      for (const request of (yield* teamStore.unresolvedRequests(binding)).filter(value => value.memberThreadId === member.threadId &&
        (value.requestId.startsWith("team-review:") || value.requestId.startsWith("team-ready:"))))
        yield* teamStore.settleRequest(binding, request.requestId);
      return true;
    }));
    if (lost && retire) yield* retireHelper(binding, member.threadId, cancel);
  });

  const readMemberProjection = (binding: BindingRecord, member: TeamMember, cancel: Cancel, observeOnly = false) => Effect.gen(function* () {
    if ((yield* cancelled(cancel)) || !(yield* consumeReadBudget(binding))) return null;
    // the member can change during the awaited read (for example a root quarantine); a lost conversation
    // only applies to the exact member state and epoch that was read: this early check avoids a needless transaction, and
    // the loss transaction itself checks again
    const unchanged = memberUnchanged(binding, member);
    const read = yield* Effect.exit(Effect.gen(function* () {
      const snapshot = yield* (cancel === undefined ? t3.projection(member.threadId)
        : Effect.raceFirst(t3.projection(member.threadId), Effect.andThen(Deferred.await(cancel), Effect.fail(new Cancelled()))));
      const value = snapshot.projection;
      if (value.thread.id !== member.threadId) return null;
      if (value.thread.archivedAt != null || value.thread.deletedAt != null) {
        if (!observeOnly && (yield* unchanged)) yield* loseMember(binding, member, cancel, "The helper conversation is archived or deleted; its check-in was closed and pending operational effects remain fenced.");
        return null;
      }
      return value;
    }));
    if (Exit.isSuccess(read)) return read.value;
    if (Cause.hasInterruptsOnly(read.cause)) return yield* Effect.failCause(read.cause as Cause.Cause<never>);
    const error = Option.getOrNull(Cause.findErrorOption(read.cause));
    if (!observeOnly && error !== null && error._tag === "T3TransportError" && error.httpStatus === 404 && (yield* unchanged)) {
      yield* loseMember(binding, member, cancel, "The helper conversation returned native 404; its check-in was closed and pending operational effects remain fenced.");
    }
    return null;
  });

  const parentById = (binding: BindingRecord, threads: readonly ThreadInfo[]): Map<string, string | null> | null => {
    const scope = resolveSupervisorScope(threads, binding.projectId, binding.mainThreadId, store.ownedIds);
    if (!scope.complete || !scope.main || !scope.allowedIds.has(binding.mainThreadId)) return null;
    return new Map([...scope.byId].filter(([id]) => scope.allowedIds.has(id)).map(([id, thread]) => [id, thread.lineage.parentThreadId]));
  };

  const subset = (binding: BindingRecord, batch: SupervisorMonitorBatch, threads: SupervisorMonitorThreadBatch[]): SupervisorMonitorBatch | null =>
    scopedBatch({...batch, projectId: binding.projectId}, threads);

  const hasOutstandingHelperCheckin = (binding: BindingRecord, targetThreadId: string) =>
    Effect.map(teamStore.unresolvedRequests(binding), (unresolved) => unresolved.some(request => request.requestId.startsWith("team-review:") &&
      request.targets.some(target => target.targetThreadId === targetThreadId)));

  const rootOwnedBatch = (binding: BindingRecord, batch: SupervisorMonitorBatch, threads: readonly ThreadInfo[]) => transaction(Effect.gen(function* () {
    const parents = parentById(binding, threads);
    if (!parents) return null;
    return subset(binding, batch, yield* Effect.filter(batch.threads, (monitored) =>
      Effect.map(teamStore.coverage(binding, monitored.threadId, parents), (coverage) => coverage.state === "root")));
  }));

  const partition = (binding: BindingRecord, threads: readonly ThreadInfo[], batch: SupervisorMonitorBatch | null) => transaction(Effect.gen(function* (): Effect.fn.Return<SupervisorTeamPartition, SupervisionStoreError> {
    const snapshot = yield* teamStore.snapshot(binding);
    const rootEvents = snapshot.events.filter(event => event.acknowledgedAt === null && event.kind !== "assignment_handover_completed" &&
      (event.severity === "attention" || event.severity === "result")).slice(-50);
    if (!batch) return {rootBatch: null, helperBatches: [], rootEvents};
    const parents = parentById(binding, threads);
    if (!parents) return {rootBatch: rootEvents.length ? scopedBatch({...batch, projectId: binding.projectId}, batch.threads.map(thread =>
      ({...thread, teamCoverageState: "unavailable" as const}))) : null, helperBatches: [], rootEvents};
    const rootThreads: Array<SupervisorMonitorThreadBatch & {teamCoverageState?: SupervisorTeamRootCoverage}> = [];
    const helpers = new Map<string, {memberEpoch: number; targets: TeamRequestTarget[]; threads: SupervisorMonitorThreadBatch[]}>();
    for (const monitored of batch.threads) {
      if (!parents.has(monitored.threadId)) {rootThreads.push({...monitored, teamCoverageState: "unavailable"});continue;}
      const coverage = yield* teamStore.coverage(binding, monitored.threadId, parents);
      const actor = coverage.state === "assigned" ? yield* teamStore.resolveActor(binding, coverage.actorThreadId, coverage.memberEpoch ?? undefined) : null;
      if (coverage.state === "root") {rootThreads.push({...monitored, teamCoverageState: "root"});continue;}
      if ((coverage.state === "transferring" || coverage.state === "unavailable") && !(yield* hasOutstandingHelperCheckin(binding, monitored.threadId))) {
        rootThreads.push({...monitored, teamCoverageState: coverage.state});continue;
      }
      if (coverage.state !== "assigned" || !actor || actor.role !== "helper" || coverage.memberEpoch === null || coverage.assignmentRootThreadId === null || coverage.assignmentEpoch === null) continue;
      const group = helpers.get(actor.actorThreadId) ?? {memberEpoch: actor.memberEpoch!, targets: [], threads: []};
      group.targets.push({targetThreadId: monitored.threadId, assignmentRootThreadId: coverage.assignmentRootThreadId, assignmentEpoch: coverage.assignmentEpoch});
      group.threads.push(monitored);
      helpers.set(actor.actorThreadId, group);
    }
    const helperBatches = [...helpers].map(([actorThreadId, group]) => ({actorThreadId, memberEpoch: group.memberEpoch,
      targets: group.targets, batch: subset(binding, batch, group.threads)!}));
    const hasRootOwnedActivity = rootThreads.some(thread => thread.teamCoverageState === "root");
    const rootBatch = hasRootOwnedActivity || rootEvents.length ? subset(binding, batch, rootThreads) : null;
    return {rootBatch, helperBatches, rootEvents};
  }));

  const pendingRequest = (binding: BindingRecord) => (member: TeamMember) => Effect.map(requests.pending(binding.projectId, member.threadId), (request) => request !== null);
  const hasInflightEffects = (binding: BindingRecord) => transaction(Effect.gen(function* () {
    const snapshot = yield* teamStore.snapshot(binding);
    return (yield* teamStore.unresolvedRequests(binding)).length > 0 ||
      snapshot.notifications.some(notification => !notificationClosed(notification) && ["sending", "uncertain"].includes(notification.state)) ||
      (yield* Effect.findFirst(snapshot.members, pendingRequest(binding)))._tag === "Some";
  }));
  const hasBlockingWork = (binding: BindingRecord) => transaction(Effect.gen(function* () {
    const snapshot = yield* teamStore.snapshot(binding);
    const members = new Map(snapshot.members.map(member => [member.threadId, member]));
    const hasUnsettledTransfer = snapshot.assignments.some(assignment => assignment.state === "transferring");
    const hasUnresolvedEffect = (yield* teamStore.unresolvedRequests(binding)).length > 0;
    const hasPendingNotification = snapshot.notifications.some(notification => !notificationClosed(notification) &&
      (["sending", "uncertain", "delivered"].includes(notification.state) || members.get(notification.recipientThreadId)?.state === "ready" &&
        members.get(notification.recipientThreadId)?.epoch === notification.memberEpoch));
    const hasUnreviewedEvent = snapshot.events.some(event => event.acknowledgedAt === null && event.kind !== "assignment_handover_completed" &&
      (event.severity === "attention" || event.severity === "result"));
    if (hasUnsettledTransfer || hasUnresolvedEffect || hasPendingNotification || hasUnreviewedEvent) return true;
    return (yield* Effect.findFirst(snapshot.members, (member) => member.state === "registering" ? Effect.succeed(true) : pendingRequest(binding)(member)))._tag === "Some";
  }));

  const validHelper = (member: TeamMember, binding: BindingRecord, projection: Projection): boolean =>
    projection.thread.id === member.threadId && projection.thread.projectId === binding.projectId &&
      projection.thread.lineage.relationshipToParent === "subagent" && projection.thread.lineage.parentThreadId === binding.threadId &&
      !projection.thread.archivedAt && !projection.thread.deletedAt;

  const helperRequest = (binding: BindingRecord, member: TeamMember) => requests.pending(binding.projectId, member.threadId);

  const currentRequest = (binding: BindingRecord, requestId: string) => Effect.map(teamStore.unresolvedRequests(binding), (unresolved): TeamRequest | null =>
    unresolved.find(request => request.requestId === requestId && request.requestId.startsWith("team-review:")) ?? null);

  const currentTargets = (binding: BindingRecord, member: TeamMember, request: TeamRequest, threads: readonly ThreadInfo[]) => Effect.gen(function* () {
    const parents = parentById(binding, threads);
    if (!parents || request.memberThreadId !== member.threadId || request.memberEpoch !== member.epoch) return false;
    if (!request.targets.length) return false;
    const targetIds = request.targets.map(target => target.targetThreadId).sort();
    const pending = yield* requests.pending(binding.projectId, member.threadId);
    if (!pending?.batch || JSON.stringify([...pending.batch.threads.map(thread => thread.threadId)].sort()) !== JSON.stringify(targetIds)) return false;
    for (const target of request.targets) {
      const coverage = yield* teamStore.coverage(binding, target.targetThreadId, parents);
      if (!(coverage.state === "assigned" && coverage.actorThreadId === member.threadId && coverage.memberEpoch === member.epoch &&
        coverage.assignmentRootThreadId === target.assignmentRootThreadId && coverage.assignmentEpoch === target.assignmentEpoch)) return false;
    }
    return true;
  });

  // a helper delivery admitted by the transport only while the main is not stopped and the member keeps the exact
  // state and epoch read before; the transport evaluates it with the admission guard right before its receipt and POST
  const deliveryAuthority = (binding: BindingRecord, member: TeamMember) => (guard: GateGuard) => Effect.gen(function* () {
    return !(yield* stoppedWith(guard, binding.mainThreadId)) && (yield* memberUnchanged(binding, member));
  });

  const reconcileRequest = (binding: BindingRecord, member: TeamMember, threads: readonly ThreadInfo[], cancel: Cancel, observeOnly = false): Effect.Effect<void, TeamRuntimeError> => Effect.gen(function* () {
    const request = yield* helperRequest(binding, member);
    if (!request || request.id.startsWith("team-note:") || !request.id.startsWith("team-review:")) return;
    const teamRequest = yield* currentRequest(binding, request.id);
    if (!teamRequest || teamRequest.memberThreadId !== member.threadId) return;
    const projection = yield* readMemberProjection(binding, member, cancel, observeOnly);
    if (!projection) return;
    if (!validHelper(member, binding, projection) || !(yield* teamStore.resolveActor(binding, member.threadId, teamRequest.memberEpoch))) return;
    if (readRpc) yield* requests.recordNativeReads(binding.projectId, request.id,
      yield* collectNativeReads(request, projection, itemId => readRpc.call("orchestration.getTurnItem", {threadId: member.threadId, itemId}), yield* Clock.currentTimeMillis,
        nativeRoutes));
    const message = yield* firstMatch(binding, request.messageId, request.text, projection, member.threadId);
    const run = projection.runs.find(item => item.threadId === member.threadId && (item.id === message?.runId || item.id === request.runId || item.userMessageId === message?.id));
    if (!run) {
      if (yield* unresolvedDeliveryTooLong(request)) yield* serviceUnresolvedDelivery(binding, member.threadId, request);
      if (observeOnly) {yield* observeUndeliveredRequest(binding, member, request, teamRequest.requestId, cancel);return;}
      if (["prepared", "uncertain", "waiting"].includes(request.state)) yield* dispatchHelperRequest(binding, member, request, teamRequest, threads, cancel);
      else if (request.state === "sending") yield* requests.saveRequest({...request, state: "uncertain", error: "The helper request may have been accepted; its original native identity is retained."});
      return;
    }
    if (request.runId !== run.id) {request.runId = run.id;yield* requests.saveRequest(request);}
    if (!terminal.has(run.status)) return;
    // the message was matched against the receipt's proven native rendering, so its text is not compared again
    const completed = run.status === "completed" && message !== undefined && run.userMessageId === message.id &&
      !projection.messages.some(item => item.runId === run.id && item.role === "user" && item.id !== message.id && typeof item.senderThreadId !== "string") &&
      lastAssistantText(projection, run.id)?.includes(request.completionMarker) === true &&
      hasCompletionMarker(lastAssistantText(projection, run.id) ?? "", request.completionMarker);
    const resultRequest = yield* transaction(Effect.gen(function* () {
      const current = completed && (yield* currentTargets(binding, member, teamRequest, threads));
      const state = completed ? "completed" as const : "failed" as const;
      const error = current ? null : completed ? "Coverage changed during this check-in; pending activity remains for its current owner." : "The helper check-in ended without its exact completion marker; pending activity is retained.";
      const resultRequest = {...request, state, error};
      if (current && request.batch) yield* monitor.acknowledge(request.batch);
      yield* requests.saveRequest(resultRequest);
      yield* teamStore.settleRequest(binding, teamRequest.requestId);
      if (current && request.teamNotificationIds) for (const notificationId of request.teamNotificationIds) {
        const notice = (yield* teamStore.snapshot(binding)).notifications.find(value => value.id === notificationId);
        if (notice?.kind === "note") yield* teamStore.acknowledgeNotification(binding, member.threadId, notificationId, member.epoch);
      }
      return {request: resultRequest, current};
    }));
    if (!resultRequest.current && !completed) yield* serviceAttention(binding, member.threadId, resultRequest.request,
      "The helper check-in failed without an exact native completion marker. Review the failed request and use the team retry action before another check-in.");
  });

  // a quarantined helper's check-in or readiness request without a delivery receipt never reached a POST (the
  // transport records a receipt first), including one interrupted between a revoked send and its failure. It fails
  // and settles only its own fence; anything with a receipt keeps its fence and nothing is resent.
  const failNeverPostedRequests = (binding: BindingRecord, member: TeamMember) => Effect.gen(function* () {
    const unresolved = new Set((yield* teamStore.unresolvedRequests(binding)).map(value => value.requestId));
    for (const request of yield* requests.requests(binding.projectId, member.threadId)) {
      if (request.kind !== "review" || !(request.id.startsWith("team-review:") || request.id.startsWith("team-ready:")) ||
        (transport ? yield* transport.receiptText(binding, request.messageId) : undefined) !== null) continue;
      const open = ["prepared", "sending", "waiting", "uncertain"].includes(request.state);
      if (!open && !(request.state === "failed" && unresolved.has(request.id))) continue;
      const failed = open ? {...request, state: "failed" as const,
        error: "The helper lost its authority before this request was posted; nothing was posted and pending activity is retained."} : request;
      yield* transaction(Effect.gen(function* () {
        if (open) yield* requests.saveRequest(failed);
        if (unresolved.has(request.id)) yield* teamStore.settleRequest(binding, request.id);
      }));
      if (open) yield* serviceAttention(binding, member.threadId, failed, "A quarantined helper's request was never posted. Pending activity is retained; its other fences remain.");
    }
  });

  /**
   * A helper request with no matching native run during stopped reconciliation: nothing is resent. A durable or native rejection
   * of its receipt proves it was not delivered, so it fails and releases its fence; otherwise its identity stays unresolved.
   */
  const observeUndeliveredRequest = (binding: BindingRecord, member: TeamMember, initial: ConversationRequest, teamRequestId: string, cancel: Cancel) => Effect.gen(function* () {
    let request = initial;
    if (request.state === "sending") {
      request = {...request, state: "uncertain", error: "The helper request may have been accepted; its original native identity is retained."};
      yield* requests.saveRequest(request);
    }
    if (!transport || !(yield* consumeReadBudget(binding))) return;
    const input = {threadId: member.threadId, commandId: `supervisor-review:${request.id}`, messageId: request.messageId, text: request.text};
    if ((yield* transport.reconcileDelivery(binding, input, cancel)) !== "rejected") return;
    const failed = {...request, state: "failed" as const, failureAcknowledged: true,
      error: "Supervision was stopped for this chat; the native delivery of this helper request was rejected, so it was not delivered."};
    yield* transaction(Effect.gen(function* () {
      yield* requests.saveRequest(failed);
      if ((yield* teamStore.unresolvedRequests(binding)).some(value => value.requestId === teamRequestId)) yield* teamStore.settleRequest(binding, teamRequestId);
    }));
  });

  const reconcileStopped = (binding: BindingRecord, threads: readonly ThreadInfo[], cancel?: Cancel) => Effect.gen(function* () {
    // each stopped cycle observes with its own bounded read budget, so a delayed native outcome is still seen later
    yield* startCycle(binding);
    let snapshot = yield* teamStore.snapshot(binding);
    for (const member of snapshot.members) yield* failNeverPostedRequests(binding, member);
    for (const member of snapshot.members.filter(value => value.state === "missing" || value.state === "retired"))
      yield* loseMember(binding, member, cancel, `The helper is already ${member.state}; its check-in was closed and pending operational effects remain fenced.`, false);
    snapshot = yield* teamStore.snapshot(binding);
    for (let index = 0; index < snapshot.notifications.length && !(yield* cancelled(cancel)); index++) yield* reconcileNotifications(binding, yield* teamStore.snapshot(binding), cancel, true);
    for (const member of (yield* teamStore.snapshot(binding)).members.filter(value => value.state === "ready" || value.state === "registering")) {
      if (yield* cancelled(cancel)) return;
      const request = yield* helperRequest(binding, member);
      if (!request) continue;
      if (request.id.startsWith("team-ready:")) yield* reconcileReadiness(binding, member, request, cancel, true);
      else if (member.state === "ready") yield* reconcileRequest(binding, member, threads, cancel, true);
    }
    const transfers = (yield* teamStore.snapshot(binding)).assignments.filter(assignment => assignment.state === "transferring").length;
    for (let index = 0; index < transfers; index++) yield* completeTransfer(binding);
  });

  const reconcile = (binding: BindingRecord, threads: readonly ThreadInfo[], cancel?: Cancel) => Effect.gen(function* () {
    let snapshot = yield* teamStore.snapshot(binding);
    for (const member of snapshot.members.filter(value => value.state === "missing" || value.state === "retired"))
      yield* loseMember(binding, member, cancel, `The helper is already ${member.state}; its check-in was closed and pending operational effects remain fenced.`);
    for (const member of snapshot.members.filter(value => value.state === "quarantined")) {
      yield* failNeverPostedRequests(binding, member);
      yield* retireHelper(binding, member.threadId, cancel);
    }
    yield* reconcileNotifications(binding, snapshot, cancel);
    snapshot = yield* teamStore.snapshot(binding);
    const members = snapshot.members.filter(member => member.state === "ready" || member.state === "registering");
    if (!members.length) {yield* completeTransfer(binding);return;}
    const offset = yield* offsetOf(helperOffset, binding.threadId);
    const ordered = [...members.slice(offset % members.length), ...members.slice(0, offset % members.length)];
    for (const member of ordered) {
      if (yield* cancelled(cancel)) return;
      const request = yield* helperRequest(binding, member);
      if (request) {
        if (request.id.startsWith("team-ready:")) yield* reconcileReadiness(binding, member, request, cancel);
        else if (member.state === "ready") yield* reconcileRequest(binding, member, threads, cancel);
      } else if (member.state === "registering" && !(yield* hasUnacknowledgedFailure(binding, member.threadId))) yield* startReadiness(binding, member, cancel);
      yield* setOffset(helperOffset, binding.threadId, (members.indexOf(member) + 1) % members.length);
      yield* completeTransfer(binding);
      return;
    }
    yield* completeTransfer(binding);
  });

  const startReadiness = (binding: BindingRecord, member: TeamMember, cancel: Cancel) => Effect.gen(function* () {
    if (!transport) return;
    const now = yield* Clock.currentTimeMillis;
    if (now - ((yield* requests.lastNotice(member.threadId)) ?? 0) < SUPERVISOR_MONITOR_COOLDOWN_MS) return;
    const readinessKey = fingerprint([binding.threadId, member.threadId, member.epoch]).slice(0, 24);
    const requestId = `team-ready:${readinessKey}:${yield* ids.uuid}`;
    const completionMarker = `Supervisor team readiness ${requestId} completed`;
    const operationId = `team-ready:${readinessKey}`;
    // the exact ready arguments are the native proof the ready action verifies, so they stay byte-exact in the message
    const read = {supervisorThreadId: member.threadId, bindingGeneration: binding.generation, memberEpoch: member.epoch, view: "instructions"};
    const ready = {action: "ready", supervisorThreadId: member.threadId, bindingGeneration: binding.generation, memberEpoch: member.epoch, operationId};
    const text = `${helperCore}\nReadiness: read them with workflow_read ${JSON.stringify(read)}, then call supervision_team ${JSON.stringify(ready)}.\nEnd with: ${completionMarker}`;
    const request = yield* requests.prepare({id: requestId, projectId: binding.projectId, supervisorThreadId: member.threadId,
      kind: "review", taskId: null, text, batch: null, completionMarker, teamMemberEpoch: member.epoch}, now);
    yield* dispatchReadiness(binding, member, request, cancel);
  });

  // the sending mark and the first attempt's notice clock commit together
  const markSending = (member: TeamMember, request: ConversationRequest, sentAt: number, attemptedAt: number) => transaction(Effect.gen(function* () {
    yield* requests.saveRequest({...request, state: "sending", sentAt});
    if (request.sentAt === null) yield* requests.noticeSent(member.threadId, attemptedAt);
  }));

  const dispatchReadiness = (binding: BindingRecord, member: TeamMember, request: ConversationRequest, cancel: Cancel) => Effect.gen(function* () {
    if (!transport || !["prepared", "uncertain", "waiting"].includes(request.state)) return;
    if (request.state === "prepared" && (yield* Clock.currentTimeMillis) - ((yield* requests.lastNotice(member.threadId)) ?? 0) < SUPERVISOR_MONITOR_COOLDOWN_MS) return;
    if (!(yield* consumeReadBudget(binding))) return;
    const attemptedAt = yield* Clock.currentTimeMillis;
    const sentAt = request.sentAt ?? attemptedAt;
    yield* markSending(member, request, sentAt, attemptedAt);
    const result: SupervisorHelperSendResult = yield* transport.send(binding, {threadId: member.threadId, commandId: `supervisor-review:${request.id}`,
      messageId: request.messageId, text: request.text}, {cancel, authorized: deliveryAuthority(binding, member)});
    if (result === "waiting") {
      const waiting = {...request, state: "waiting" as const, sentAt, error: null};
      yield* requests.saveRequest(waiting);
      if (yield* unresolvedDeliveryTooLong(waiting)) yield* serviceUnresolvedDelivery(binding, member.threadId, waiting);
    }
    else if (result === "busy") yield* requests.saveRequest({...request, state: request.sentAt === null ? "prepared" : "uncertain",
      sentAt: request.sentAt, error: "The helper is busy or its delivery transport is unavailable; readiness keeps its identity and will wait."});
    else if (result === "rejected" || result === "revoked") {
      const failed = {...request, state: "failed" as const, sentAt, error: result === "revoked"
        ? "The helper lost its authority before the readiness delivery was posted; nothing was posted." : "T3 rejected the exact helper readiness delivery."};
      yield* requests.saveRequest(failed);
      yield* serviceAttention(binding, member.threadId, failed, "The helper readiness delivery was rejected. Review the failed request and use the team retry action before another readiness attempt.");
    }
    else {
      const uncertain = {...request, state: "uncertain" as const, sentAt, error: "Helper readiness delivery is uncertain; its original native identity is retained."};
      yield* requests.saveRequest(uncertain);
      if (yield* unresolvedDeliveryTooLong(uncertain)) yield* serviceUnresolvedDelivery(binding, member.threadId, uncertain);
    }
  });

  const reconcileReadiness = (binding: BindingRecord, member: TeamMember, request: ConversationRequest, cancel: Cancel, observeOnly = false) => Effect.gen(function* () {
    const projection = yield* readMemberProjection(binding, member, cancel, observeOnly);
    if (!projection || !validHelper(member, binding, projection)) return;
    const message = yield* firstMatch(binding, request.messageId, request.text, projection, member.threadId);
    const run = projection.runs.find(item => item.threadId === member.threadId && (item.id === message?.runId || item.id === request.runId || item.userMessageId === message?.id));
    if (!run) {
      if (yield* unresolvedDeliveryTooLong(request)) yield* serviceUnresolvedDelivery(binding, member.threadId, request);
      if (observeOnly) {yield* observeUndeliveredRequest(binding, member, request, request.id, cancel);return;}
      if (["prepared", "uncertain", "waiting"].includes(request.state)) yield* dispatchReadiness(binding, member, request, cancel);
      else if (request.state === "sending") yield* requests.saveRequest({...request, state: "uncertain", error: "Helper readiness may have been accepted; its original native identity is retained."});
      return;
    }
    if (request.runId !== run.id) {request.runId = run.id;yield* requests.saveRequest(request);}
    if (!terminal.has(run.status)) return;
    const finalText = lastAssistantText(projection, run.id) ?? "";
    const nativeComplete = run.status === "completed" && message !== undefined && run.userMessageId === message.id &&
      !projection.messages.some(item => item.runId === run.id && item.role === "user" && item.id !== message.id && typeof item.senderThreadId !== "string") &&
      hasCompletionMarker(finalText, request.completionMarker);
    // the member read and the request's result are one block
    const settled = yield* transaction(Effect.gen(function* () {
      const current = (yield* teamStore.snapshot(binding)).members.find(item => item.threadId === member.threadId);
      const ready = Boolean(nativeComplete && request.teamMemberEpoch !== undefined && current?.state === "ready" && current.epoch === request.teamMemberEpoch + 1);
      const failed = {...request, state: ready ? "completed" as const : "failed" as const,
        error: ready ? null : "The readiness check-in ended without a confirmed native ready call and completion marker."};
      yield* requests.saveRequest(failed);
      return {ready, failed};
    }));
    if (!settled.ready) yield* serviceAttention(binding, member.threadId, settled.failed,
      "The helper readiness check-in ended without its exact native ready evidence and completion marker. Review the failed request and use the team retry action before another readiness attempt.");
  });

  const completeTransfer = (binding: BindingRecord) => Effect.gen(function* () {
    const transfers = (yield* teamStore.snapshot(binding)).assignments.filter(assignment => assignment.state === "transferring");
    if (!transfers.length) return;
    const offset = (yield* offsetOf(transferOffset, binding.threadId)) % transfers.length;
    const assignment = transfers[offset]!;
    // unresolved notifications or requests keep this transfer pending
    yield* teamStore.completeTransfer(binding, assignment.subtreeRootThreadId, assignment.epoch).pipe(Effect.asVoid, otherwise(undefined));
    yield* setOffset(transferOffset, binding.threadId, (offset + 1) % transfers.length);
  });

  const notificationNeedsAttention = (notification: TeamNotification) =>
    Effect.map(Clock.currentTimeMillis, (now) => now - notification.createdAt >= SUPERVISOR_TEAM_ATTENTION_MS);

  const updateNotificationDelivery = (binding: BindingRecord, notification: TeamNotification, state: "sending" | "delivered" | "uncertain") =>
    Effect.flatMap(Clock.currentTimeMillis, (now) =>
      teamStore.updateNotificationDelivery(binding, binding.threadId, notification.id, state, now, notification.deliveryAttempt ?? 0).pipe(Effect.as(true), otherwise(false)));

  const markNotificationRejected = (binding: BindingRecord, notification: TeamNotification,
    reason = "The native webhook delivery was definitively rejected.") =>
    teamStore.markNotificationRejected(binding, binding.threadId, notification.id, reason, notification.deliveryAttempt ?? 0).pipe(Effect.as(true), otherwise(false));

  const serviceNotificationAttention = (binding: BindingRecord, notification: TeamNotification) => {
    const attempt = notification.deliveryAttempt ?? 0;
    const summary = "A helper handover notice has no visible completion marker after bounded reconciliation. Preserve its identity and handover fence; do not infer acknowledgment or retry with a new ID. The team read lists its exact notification and attempt.";
    return emitServiceAttention(binding,
      `helper-notification-unresolved:${fingerprint([binding.threadId, binding.generation, notification.id, attempt]).slice(0, 32)}`,
      notification.recipientThreadId, notification.assignmentRootThreadId ?? undefined, summary);
  };

  // an attempt with a delivery receipt is identified by the exact bytes it sent, so a later wording change
  // cannot orphan it; generated text only applies to an attempt that has never been posted.
  const noticeText = (binding: BindingRecord, notification: TeamNotification) => Effect.gen(function* () {
    const messageId = `supervisor-team-notice:${notification.id}:attempt:${notification.deliveryAttempt}`;
    const generated = teamNotificationText(binding, notification);
    // an unreadable receipt has no text to reuse; the transport keeps that attempt unresolved and posts nothing for it
    const sentText = transport ? yield* transport.receiptText(binding, messageId) : null;
    return {text: typeof sentText === "string" ? sentText : generated.text, marker: generated.marker, messageId};
  });

  const noticeEvidence = (binding: BindingRecord, projection: Projection, notification: TeamNotification) => Effect.gen(function* () {
    const {text, marker, messageId} = yield* noticeText(binding, notification);
    const matched = yield* matchedMessages(binding, messageId, text, projection.messages,
      message => message.threadId === notification.recipientThreadId && message.role === "user");
    return teamNotificationEvidence(projection, notification, marker, message => matched.has(message));
  });

  // closure repeats the creation-time native check on the current projection: an attempt whose message has a
  // running, missing or marker-completed run is not closed by the review and keeps its own fence.
  const nativelyClosable = (binding: BindingRecord, projection: Projection, review: TeamNotification) => Effect.gen(function* () {
    const notifications = (yield* teamStore.snapshot(binding)).notifications;
    const closable: HandoverAttempt[] = [];
    for (const entry of review.reviewChain ?? []) {
      const member = notifications.find(value => value.id === entry.notificationId && value.deliveryAttempt === entry.deliveryAttempt);
      if (!member) continue;
      const evidence = yield* noticeEvidence(binding, projection, member);
      if (Boolean(evidence.message) && !evidence.completedRun && evidence.runs.some(run => run.id === entry.runId) &&
        evidence.runs.every(run => endedWithoutCompletion.has(run.status))) closable.push(entry);
    }
    return closable;
  });

  // a delivered attempt whose native run ended without its marker is recorded and surfaced once; it is never resent or relabelled
  const notificationRunEnded = (binding: BindingRecord, projection: Projection, notification: TeamNotification) => Effect.gen(function* () {
    const evidence = yield* noticeEvidence(binding, projection, notification);
    if (evidence.completedRun || !evidence.runs.length || evidence.runs.some(item => !endedWithoutCompletion.has(item.status))) return false;
    const run = evidence.runs.find(item => item.id === notification.observedRun?.runId) ??
      [...evidence.runs].sort((left, right) => right.ordinal - left.ordinal)[0]!;
    const attempt = notification.deliveryAttempt ?? 0;
    // the observed run and its service event are one block
    return yield* transaction(Effect.gen(function* () {
      if (!(yield* teamStore.recordNotificationRun(binding, binding.threadId, notification.id, attempt, {runId: run.id, status: run.status}).pipe(Effect.as(true), otherwise(false))))
        return false;
      yield* emitServiceAttention(binding,
        `helper-notification-interrupted:${fingerprint([binding.threadId, binding.generation, notification.id, attempt, run.id]).slice(0, 32)}`,
        notification.recipientThreadId, notification.assignmentRootThreadId ?? undefined,
        `A delivered helper handover notice's native run ended ${run.status} before confirming. Its effects are unknown: the handover stays fenced, the root keeps responsibility, and nothing was resent. Read the team for its exact notification, attempt and observed run, then use the root review_handover action to inspect all unresolved attempts, or consider reassignment or quarantine.`);
      return true;
    }));
  });

  const reconcileNotifications = (binding: BindingRecord, snapshot: SupervisorTeamSnapshot, cancel: Cancel, observeOnly = false): Effect.Effect<void, SupervisionStoreError> => Effect.gen(function* () {
    if (!transport) return;
    // while stopped only notices already being delivered are observed; a notice not yet attempted is never sent
    const candidates = snapshot.notifications.filter(notification => notification.state !== "acknowledged" && notification.state !== "superseded" && notification.state !== "failed" &&
      snapshot.members.some(member => member.threadId === notification.recipientThreadId &&
        (["sending", "uncertain", "delivered"].includes(notification.state) || !observeOnly && member.state === "ready" && member.epoch === notification.memberEpoch)));
    if (!candidates.length) return;
    const offset = (yield* offsetOf(notificationOffset, binding.threadId)) % candidates.length;
    const notification = candidates[offset]!;
    yield* setOffset(notificationOffset, binding.threadId, (offset + 1) % candidates.length);
    const member = snapshot.members.find(value => value.threadId === notification.recipientThreadId);
    if (!member) return;
    const {text, messageId} = yield* noticeText(binding, notification);
    const message: SupervisorHelperMessage = {threadId: member.threadId, commandId: messageId, messageId, text};
    const attempted = ["sending", "uncertain"].includes(notification.state) && (yield* transport.hasDelivery(binding, message));
    // membership can change during any await (for example a root quarantine), so eligibility is always re-read
    const eligible = Effect.map(teamStore.snapshot(binding), (current) => {
      const recipient = current.members.find(value => value.threadId === member.threadId);
      return recipient?.state === "ready" && recipient.epoch === notification.memberEpoch;
    });
    // the transport records a receipt before any POST, so an attempted notice without one was never posted
    const neverPosted = Effect.gen(function* () {
      return ["sending", "uncertain"].includes(notification.state) && (yield* transport.receiptText(binding, messageId)) === null;
    });
    const neverPostedReason = "The notice was never posted: no delivery receipt exists and its recipient is no longer eligible.";
    // a non-ready member is only observed here: a lost conversation must not turn quarantine into missing
    const projection = yield* readMemberProjection(binding, member, cancel, observeOnly || member.state !== "ready");
    if (!projection || !validHelper(member, binding, projection)) {
      // a durable or native rejection of an attempted POST needs no helper read; reconcile it read-only so an
      // archived, deleted or no longer eligible helper cannot strand a definitely undelivered notice
      if (attempted && (yield* consumeReadBudget(binding)) &&
        (yield* transport.reconcileDelivery(binding, message, cancel)) === "rejected") yield* markNotificationRejected(binding, notification);
      else yield* transaction(Effect.gen(function* () {
        if (!(yield* eligible) && (yield* neverPosted)) yield* markNotificationRejected(binding, notification, neverPostedReason);
      }));
      return;
    }
    const visible = (yield* firstMatch(binding, messageId, text, projection, member.threadId)) !== undefined;
    if (visible) {
      if (notification.state === "pending" && !(yield* updateNotificationDelivery(binding, notification, "sending"))) return;
      if (["pending", "sending", "uncertain"].includes(notification.state))
        if (!(yield* updateNotificationDelivery(binding, notification, "delivered"))) return;
      const completedRunId = (yield* noticeEvidence(binding, projection, notification)).completedRun?.id ?? null;
      if (completedRunId) {
        // a retried or reassigned notification keeps its current attempt
        yield* Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const closable = notification.reviewOf ? yield* nativelyClosable(binding, projection, notification) : [];
          yield* teamStore.acknowledgeNotificationRun(binding, binding.threadId, notification.id, notification.deliveryAttempt, completedRunId, now, closable);
        }).pipe(otherwise(undefined));
      }
      else if (notification.resolvedByReview) return;
      else if (yield* notificationRunEnded(binding, projection, notification)) return;
      else if (yield* notificationNeedsAttention(notification)) yield* serviceNotificationAttention(binding, notification);
      return;
    }
    if (notification.state === "delivered") {
      if (yield* notificationNeedsAttention(notification)) yield* serviceNotificationAttention(binding, notification);
      return;
    }
    // the transport durably records an attempt before POST. With a receipt, a review is never sent again:
    // it only reconciles that receipt read-only, so durable or native rejection evidence still fails it
    // after a crash. Without one, a busy/pre-send crash has not posted anything and ordinary delivery runs.
    if (notification.kind === "handover_review" && attempted) {
      if (!(yield* consumeReadBudget(binding))) return;
      const outcome = yield* transport.reconcileDelivery(binding, message, cancel);
      if (outcome === "rejected") yield* markNotificationRejected(binding, notification);
      else if (yield* notificationNeedsAttention(notification)) yield* serviceNotificationAttention(binding, notification);
      return;
    }
    if (!(yield* eligible)) {
      yield* transaction(Effect.gen(function* () {
        if (yield* neverPosted) yield* markNotificationRejected(binding, notification, neverPostedReason);
      }));
      return;
    }
    if (observeOnly) {
      // a stop supersedes a notice that was never posted; an attempted one is only reconciled read-only from its receipt
      if (yield* transaction(Effect.gen(function* () {
        if (!(yield* neverPosted)) return false;
        yield* markNotificationRejected(binding, notification, "Supervision was stopped for this chat before this notice was posted; it was not posted.");
        return true;
      }))) return;
      if (attempted && (yield* consumeReadBudget(binding)) &&
        (yield* transport.reconcileDelivery(binding, message, cancel)) === "rejected") yield* markNotificationRejected(binding, notification);
      return;
    }
    if (!(yield* consumeReadBudget(binding))) return;
    if (notification.state === "sending" && !(yield* updateNotificationDelivery(binding, notification, "uncertain"))) return;
    if (!(yield* updateNotificationDelivery(binding, notification, "sending"))) return;
    const result = yield* transport.send(binding, {threadId: member.threadId,
      commandId: `supervisor-team-notice:${notification.id}:attempt:${notification.deliveryAttempt ?? 0}`,
      messageId, text}, {cancel, authorized: (guard) => Effect.gen(function* () {
        return !(yield* stoppedWith(guard, binding.mainThreadId)) && (yield* eligible);
      })});
    yield* requests.noticeSent(member.threadId, yield* Clock.currentTimeMillis);
    if (result !== "waiting") {
      if (result === "rejected") {
        yield* markNotificationRejected(binding, notification);
      } else if (result === "revoked") {
        yield* markNotificationRejected(binding, notification, (yield* stopped(binding))
          ? "Supervision was stopped for this chat before this notice was posted; it was not posted." : neverPostedReason);
      } else {
        if (!(yield* updateNotificationDelivery(binding, notification, "uncertain"))) return;
        if (yield* notificationNeedsAttention(notification)) yield* serviceNotificationAttention(binding, notification);
      }
      return;
    }
    const fresh = yield* readMemberProjection(binding, member, cancel);
    if (!fresh) {
      if (!(yield* updateNotificationDelivery(binding, notification, "uncertain"))) return;
      if (yield* notificationNeedsAttention(notification)) yield* serviceNotificationAttention(binding, notification);
      return;
    }
    if ((yield* firstMatch(binding, messageId, text, fresh, member.threadId)) !== undefined)
      yield* updateNotificationDelivery(binding, notification, "delivered");
    else {
      if (!(yield* updateNotificationDelivery(binding, notification, "uncertain"))) return;
      if (yield* notificationNeedsAttention(notification)) yield* serviceNotificationAttention(binding, notification);
    }
  });

  const runHelperBatch = (binding: BindingRecord, threads: readonly ThreadInfo[], batches: readonly SupervisorTeamHelperBatch[], cancel?: Cancel) => Effect.gen(function* () {
    if (!transport || !batches.length || (yield* stopped(binding))) return;
    const offset = yield* offsetOf(helperOffset, binding.threadId);
    const ordered = [...batches.slice(offset % batches.length), ...batches.slice(0, offset % batches.length)];
    const eligible = yield* transaction(Effect.filter(ordered, (candidate) => Effect.gen(function* () {
      return !(yield* hasUnacknowledgedFailure(binding, candidate.actorThreadId)) &&
        !(yield* requests.pending(binding.projectId, candidate.actorThreadId)) &&
        !(yield* teamStore.unresolvedRequests(binding)).some(request => request.memberThreadId === candidate.actorThreadId);
    })));
    // a helper none of whose targets fits a check-in yields this call to the next eligible helper; any other stop ends it
    for (const batch of eligible) if ((yield* runSelectedHelperBatch(binding, threads, batches, batch, cancel)) !== "unfittable") return;
  });

  // whether every target of the batch is still assigned to the member at its exact epochs
  const batchCovered = (binding: BindingRecord, member: TeamMember, batch: SupervisorTeamHelperBatch, parents: Map<string, string | null>) => Effect.gen(function* () {
    for (const target of batch.targets) {
      const coverage = yield* teamStore.coverage(binding, target.targetThreadId, parents);
      if (coverage.state !== "assigned" || coverage.actorThreadId !== member.threadId || coverage.memberEpoch !== member.epoch ||
        coverage.assignmentRootThreadId !== target.assignmentRootThreadId || coverage.assignmentEpoch !== target.assignmentEpoch) return false;
    }
    return true;
  });

  const runSelectedHelperBatch = (binding: BindingRecord, threads: readonly ThreadInfo[], batches: readonly SupervisorTeamHelperBatch[],
    batch: SupervisorTeamHelperBatch, cancel: Cancel) => Effect.gen(function* (): Effect.fn.Return<"prepared" | "unfittable" | "stopped", TeamRuntimeError> {
    const parents = parentById(binding, threads);
    if (!parents) return "stopped";
    const now = yield* Clock.currentTimeMillis;
    // the member, actor, notice clock and coverage reads before the helper read are one block
    const member = yield* transaction(Effect.gen(function* () {
      const member = (yield* teamStore.snapshot(binding)).members.find(value => value.threadId === batch.actorThreadId && value.state === "ready" && value.epoch === batch.memberEpoch);
      if (!member || (yield* teamStore.resolveActor(binding, member.threadId, member.epoch))?.role !== "helper") return null;
      if (batch.batch.trigger !== "active_watch" && now - ((yield* requests.lastNotice(member.threadId)) ?? 0) < SUPERVISOR_MONITOR_COOLDOWN_MS) return null;
      return (yield* batchCovered(binding, member, batch, parents)) ? member : null;
    }));
    if (!member) return "stopped";
    const projection = yield* readMemberProjection(binding, member, cancel);
    if (!projection) return "stopped";
    if (!validHelper(member, binding, projection)) return "stopped";
    const currentParents = parentById(binding, threads);
    if (!currentParents || !(yield* batchCovered(binding, member, batch, currentParents))) return "stopped";
    const requestId = `team-review:${yield* ids.uuid}`;
    const completionMarker = `Supervisor team check-in ${requestId} completed`;
    // a notice closed by a completed review is history; re-presenting it would replay its instruction
    const deliveredNotifications = (yield* teamStore.snapshot(binding)).notifications.filter(value => value.recipientThreadId === member.threadId &&
      value.memberEpoch === member.epoch && value.state === "delivered" && !notificationClosed(value));
    const threadsById = new Map(threads.map(thread => [thread.id, thread]));
    const monitorThreadsById = new Map(batch.batch.threads.map(thread => [thread.threadId, thread]));
    const authority = {supervisorThreadId: member.threadId, bindingGeneration: binding.generation, memberEpoch: member.epoch};
    const buildReview = (targets: TeamRequestTarget[]) => {
      const targetThreads: SupervisorMonitorThreadBatch[] = [];
      for (const target of targets) {
        const thread = monitorThreadsById.get(target.targetThreadId);
        if (!thread) return null;
        targetThreads.push(thread);
      }
      const reviewBatch = scopedBatch(batch.batch, targetThreads);
      if (!reviewBatch) return null;
      const selectedAssignmentRoots = new Set(targets.map(target => target.assignmentRootThreadId));
      const notifications = deliveredNotifications.filter(notification => {
        const notificationRoots = [...(notification.assignmentRootThreadId ? [notification.assignmentRootThreadId] : []),
          ...notification.remainingAssignmentRoots];
        return !notificationRoots.length || notificationRoots.some(root => selectedAssignmentRoots.has(root));
      });
      const text = helperCheckinText(authority, targets.map((target, index) => checkinTarget(target, targetThreads[index]!, threadsById.get(target.targetThreadId))),
        notifications, completionMarker);
      return {batch: reviewBatch, targets, notifications, text};
    };
    // a check-in fits only when its T3 rendering stays within the bound and its delivery stays provable
    const budget = (text: string) => helperDeliveryBudget(conversationRequestMessageId(requestId), text, maxHelperCheckinRenderedLength);
    let selectedTargets: TeamRequestTarget[] = [];
    let selectedReview: ReturnType<typeof buildReview> = null;
    const unprocessableTargets: Array<{target: TeamRequestTarget; reason: "monitor_thread_missing" | "rendered_too_large" | "body_too_large"}> = [];
    for (const target of batch.targets) {
      const candidateTargets = [...selectedTargets, target];
      const candidate = buildReview(candidateTargets);
      if (candidate && budget(candidate.text) === "fits") {
        selectedTargets = candidateTargets;
        selectedReview = candidate;
        continue;
      }
      const singleTarget = buildReview([target]);
      if (!singleTarget) {unprocessableTargets.push({target, reason: "monitor_thread_missing"});continue;}
      const reason = budget(singleTarget.text);
      if (reason !== "fits") unprocessableTargets.push({target, reason});
    }
    if (unprocessableTargets.length) {
      const unprocessableVersions = unprocessableTargets.map(({target, reason}) => {
        const thread = monitorThreadsById.get(target.targetThreadId);
        return [target.targetThreadId, target.assignmentRootThreadId, target.assignmentEpoch, reason,
          thread?.items.map(item => [item.id, item.version]) ?? null];
      });
      const eventId = `helper-review-size:${fingerprint([binding.threadId, binding.generation, member.threadId, member.epoch, helperCheckinSizePolicy,
        unprocessableVersions]).slice(0, 32)}`;
      const renderedCount = unprocessableTargets.filter(value => value.reason === "rendered_too_large").length;
      const bodyCount = unprocessableTargets.filter(value => value.reason === "body_too_large").length;
      const missingThreadCount = unprocessableTargets.length - renderedCount - bodyCount;
      const targetIds = unprocessableTargets.slice(0, 4).map(value => value.target.targetThreadId).join(", ");
      yield* emitServiceAttention(binding, eventId, member.threadId, unprocessableTargets[0]?.target.targetThreadId,
        `A one-target check-in, including the applicable notifications, exceeds the ${maxHelperCheckinRenderedLength}-code-unit rendered bound for ${renderedCount} assigned target(s) and the 64 KiB delivery body T3 records for proof for ${bodyCount}; ${missingThreadCount} target(s) lack a matching frozen monitor thread. No request was prepared for them, and their recorded monitor activity remains pending and unacknowledged. Root review is needed for: ${targetIds}${unprocessableTargets.length > 4 ? ", and others" : ""}.`);
    }
    const review = selectedReview;
    if (!review) return unprocessableTargets.length ? "unfittable" : "stopped";
    // a stop saved during the awaited helper read prepares no check-in: the stop check and the preparation are one
    // policy-dependent write in the admission section (plan 3.11)
    const request = yield* gate.admit((guard) => transaction(Effect.gen(function* () {
      if (yield* stoppedWith(guard, binding.mainThreadId)) return null;
      const value = yield* requests.prepare({id: requestId, projectId: binding.projectId, supervisorThreadId: member.threadId,
        kind: "review", taskId: null, text: review.text, batch: review.batch, completionMarker,
        teamNotificationIds: review.notifications.map(item => item.id)}, now);
      yield* teamStore.recordRequest(binding, {requestId: value.id, memberThreadId: member.threadId, memberEpoch: member.epoch,
        targets: review.targets, parentById: parents, now});
      return value;
    })));
    if (!request) return "stopped";
    yield* setOffset(helperOffset, binding.threadId, (batches.indexOf(batch) + 1) % batches.length);
    yield* dispatchHelperRequest(binding, member, request, (yield* currentRequest(binding, request.id))!, threads, cancel);
    return "prepared";
  });

  const dispatchHelperRequest = (binding: BindingRecord, member: TeamMember, request: ConversationRequest, teamRequest: TeamRequest,
    threads: readonly ThreadInfo[], cancel: Cancel) => Effect.gen(function* () {
    if (!transport || !["prepared", "uncertain", "waiting"].includes(request.state)) return;
    if (request.state === "prepared" && (yield* Clock.currentTimeMillis) - ((yield* requests.lastNotice(member.threadId)) ?? 0) < SUPERVISOR_MONITOR_COOLDOWN_MS) return;
    const input = {threadId: member.threadId, commandId: `supervisor-review:${request.id}`, messageId: request.messageId, text: request.text};
    const current = yield* currentTargets(binding, member, teamRequest, threads);
    if (!current && !(yield* transport.hasDelivery(binding, input))) return;
    if (!(yield* consumeReadBudget(binding))) return;
    const attemptedAt = yield* Clock.currentTimeMillis;
    const sentAt = request.sentAt ?? attemptedAt;
    yield* markSending(member, request, sentAt, attemptedAt);
    const result = yield* transport.send(binding, input, {cancel, authorized: deliveryAuthority(binding, member)});
    if (result === "waiting") {
      const waiting = {...request, state: "waiting" as const, sentAt, error: null};
      yield* requests.saveRequest(waiting);
      if (yield* unresolvedDeliveryTooLong(waiting)) yield* serviceUnresolvedDelivery(binding, member.threadId, waiting);
    }
    else if (result === "busy") yield* requests.saveRequest({...request, state: request.sentAt === null ? "prepared" : "uncertain",
      sentAt: request.sentAt, error: "The helper is busy or its delivery transport is unavailable; this request keeps its identity and will wait."});
    else if (result === "rejected" || result === "revoked") {
      // both prove this exact check-in was never delivered, so only its own request fence settles
      const failed = {...request, state: "failed" as const, sentAt, error: result === "revoked"
        ? "The helper lost its authority before this check-in was posted; nothing was posted and pending activity is retained."
        : "T3 rejected this exact helper delivery; pending activity is retained."};
      // failure and its own fence settle together, so a restart cannot leave one without the other
      yield* transaction(Effect.gen(function* () {
        yield* requests.saveRequest(failed);
        yield* teamStore.settleRequest(binding, teamRequest.requestId);
      }));
      yield* serviceAttention(binding, member.threadId, failed,
        "T3 rejected the helper check-in delivery. Pending activity is retained; review the failed request and use the team retry action before another check-in.");
    } else {
      const uncertain = {...request, state: "uncertain" as const, sentAt, error: "Helper delivery is uncertain; its original native identity is retained."};
      yield* transaction(Effect.gen(function* () {
        yield* requests.saveRequest(uncertain);
        yield* teamStore.setRequestState(binding, binding.threadId, teamRequest.requestId, 0, "uncertain");
      }));
      if (yield* unresolvedDeliveryTooLong(uncertain)) yield* serviceUnresolvedDelivery(binding, member.threadId, uncertain);
    }
  });

  return SupervisorTeamRuntime.of({
    startCycle,
    rootOwnedBatch,
    partition,
    hasMembers: (binding) => Effect.map(teamStore.snapshot(binding), (snapshot) => snapshot.members.some(member => member.state !== "retired")),
    coordinatorPolicy: (binding) => Effect.map(teamStore.snapshot(binding), (snapshot) => ({maxHelpersPerRoot: snapshot.settings.maxHelpersPerRoot,
      readyHelpers: snapshot.members.filter(member => member.state === "ready").length,
      registeringHelpers: snapshot.members.filter(member => member.state === "registering").length})),
    // the acknowledgements of one confirmed request commit together
    acknowledgeRootEvents: (binding, eventIds) => transaction(Effect.forEach(eventIds, (eventId) => teamStore.acknowledgeEvent(binding, binding.threadId, eventId), {discard: true})),
    hasInflightEffects,
    hasBlockingWork,
    reconcileStopped,
    reconcile,
    runHelperBatch,
  });
});

// the bounded helper team of each root: membership, check-ins, readiness, notices and transfers over the helper transport
export class SupervisorTeamRuntime extends Context.Service<SupervisorTeamRuntime, SupervisorTeamRuntimeShape>()("t3-supervisor/SupervisorTeamRuntime") {
  static readonly make = makeSupervisorTeamRuntime;
  static readonly layer = (options: SupervisorTeamRuntimeOptions = {}) => Layer.effect(SupervisorTeamRuntime, makeSupervisorTeamRuntime(options));
}
