import { WorkflowStateStore } from "./workflow-state-store.js";
import type {WorkflowReturnRun} from "./workflow-state-contract.js";
import {nativeNodeTurn, readNativeProviderTurns} from "./workflow-native-turns.js";
import { planEntities } from "./workflow-plan-tree.js";
import { Cause, Clock, Context, Effect, Exit, FiberMap, Layer, Option, Schedule, Schema, Semaphore } from "effect";
import { GuidanceDb } from "./db.js";
import { mainRunNodeReader, projectionHasOngoingProviderTurns, projectionHasOngoingWork } from "./domain.js";
import { guidanceTransaction, type SupervisionStoreError } from "./guidance-sql.js";
import { fingerprint } from "./guidance-store.js";
import { projectRequesterPolicy } from "./task-requester.js";
import { conversationAuthorityCurrent, requesterSources } from "./supervision-conversation.js";
import { SupervisorIds } from "./ids.js";
import { ProjectSupervisorStore, type BindingRecord } from "./project-supervisor-store.js";
import { taskScopeRevision } from "./supervision-conversation.js";
import { admitSend, SupervisionGate, type GateGuard, type SendPreparation } from "./supervision-gate.js";
import { canSupervisorContact, hasPendingOwnerInput, resolveSteerableRun, SupervisorConversation } from "./supervisor-conversation.js";
import { SupervisorConversationStore } from "./supervisor-conversation-store.js";
import { childOrigin, delegatedLifecycle, directParentChildLifecycle, normalizeLifecycle } from "./supervisor-observation.js";
import { resolveSupervisorScope, type SupervisorScopeResolution } from "./supervisor-scope.js";
import { planningTargetLimit, type NewPlanningAttempt, type PlanningUncovered } from "./supervisor-planning-contract.js";
import { SupervisorTeamStore } from "./supervisor-team-store.js";
import { exactFenceRecords } from "./supervisor-workflow-agreement.js";
import { NativeOperateRpc, record, SupervisorRpcError } from "./supervisor-native.js";
import { WorkflowNativeAccess, WorkflowWriteController, type WorkflowCallCancel, type WorkflowLocator } from "./workflow-write-controller.js";
import { workflowRequestHash } from "./workflow-write-evidence.js";
import {
  acknowledgePlanningTarget, addPlanningTargets, closePlanningTarget, createPlanningAttempt, defaultPlanningTimeoutMs, expirePlanningAttempt,
  markPlanningTargetQuiescent, planningTargetAwaited, startPlanningAttempt, PlanningAcknowledgement, planningAttemptAnswer, planningDelivery, planningCanAdopt, planningDraftNotice,
  planningDraftSections, planningDraftViews, planningHasUnresolvedEffects, planningHoldText, planningReleaseText, planningWaitOpen, resolvePlanningAttempt, unacceptedProposal,
  type PlanningAttempt, type PlanningDelivery, type PlanningTarget,
} from "./supervisor-planning.js";
import type { ConversationFacts, RequesterSource } from "./supervision-conversation-contract.js";
import { planAuthoringRules } from "./supervisor-workflow.js";
import { messageReadItemId } from "./message-read-handle.js";
import type { MessageInfo, Projection } from "./types.js";

const Id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024));
const Epoch = Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1));
const Pins = {supervisorThreadId: Id, bindingGeneration: Epoch, taskId: Id, taskRevision: Id};
const OwnerArguments = Schema.Struct({
  ...Pins, memberEpoch: Schema.optional(Epoch),
  assignmentRootThreadId: Schema.optional(Id), assignmentEpoch: Schema.optional(Epoch),
  action: Schema.Literals(["read", "pause", "attach_draft", "release", "apply_return"]),
  operationId: Schema.optional(Id), attemptId: Schema.optional(Id),
  targetThreadIds: Schema.optional(Schema.mutable(Schema.Array(Id).check(Schema.isMinLength(1), Schema.isMaxLength(100)))),
  reason: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4000))),
  draftThreadId: Schema.optional(Id), draftTaskId: Schema.optional(Id),
  resolution: Schema.optional(Schema.Literals(["continue", "no_plan"])),
  workflowThreadId: Schema.optional(Id), workflowId: Schema.optional(Id), expectedRevision: Schema.optional(Epoch), returnId: Schema.optional(Id),
});
// a drafter's read carries its attempt's pins and one view, and no field of any action that could act
const DraftReadArguments = Schema.Struct({
  ...Pins, action: Schema.Literal("draft_read"), attemptId: Id, view: Schema.Literals(planningDraftViews),
  section: Schema.optional(Schema.Literals(planningDraftSections)),
  definitionIds: Schema.optional(Schema.mutable(Schema.Array(Id).check(Schema.isMinLength(1), Schema.isMaxLength(50)))),
});
// a drafter reads no input of the root's own interpretation submission in any section: no submission pins or verdict, no
// interpretation attempt, and requester source pins only as their message provenance
const sourceProvenance = (source: RequesterSource | null) => source === null ? null : {messageId: source.messageId, requester: source.requester};
const drafterConversation = (facts: ConversationFacts | null) => facts === null ? null : {draft: facts.draft,
  authorization: facts.authorization === null ? null : {scopeRevision: facts.authorization.scopeRevision, outcome: facts.authorization.outcome,
    limits: facts.authorization.limits, state: facts.authorization.state, scopeSources: facts.authorization.scopeSources.map(sourceProvenance),
    stateSource: sourceProvenance(facts.authorization.stateSource)},
  considered: sourceProvenance(facts.considered), observed: sourceProvenance(facts.observed), updatedAt: facts.updatedAt};
const Arguments = Schema.Union([OwnerArguments, DraftReadArguments]);
type PlanningArguments = typeof OwnerArguments.Type;
type DraftReadArguments = typeof DraftReadArguments.Type;

export const supervisionPlanningToolDefinition = {
  name: "supervision_planning",
  description: "Bounded planning pauses. An owner (root or assigned helper, with its pins and its own exact native call) can pause affected actors, read ACK and draft state, attach_draft its one new read-only drafting child started with local T3 delegate_task whose task is the answer's draftInstruction, release with continue or no_plan, or apply_return a pending back_to (workflowId, workflowThreadId, expectedRevision, returnId, reason, open attemptId). The service delivers holds and releases and owns the fixed deadline; a parent ACK never confirms an active child; adoption waits for the relevant ACKs. A drafter only reads, with draft_read and its draftInstruction's pins: view context (section conversation for the intent, plan for the current plan), definitions (definitionIds for complete ones) or plan_rules. Nothing here changes human Stops, pauses or approvals.",
  inputSchema: {type: "object", additionalProperties: false,
    required: ["supervisorThreadId", "bindingGeneration", "taskId", "taskRevision", "action"],
    properties: {
      supervisorThreadId: {type: "string"}, bindingGeneration: {type: "integer", minimum: 1}, memberEpoch: {type: "integer", minimum: 1},
      assignmentRootThreadId: {type: "string"}, assignmentEpoch: {type: "integer", minimum: 1}, taskId: {type: "string"}, taskRevision: {type: "string"},
      action: {type: "string", enum: ["read", "pause", "attach_draft", "release", "apply_return", "draft_read"]}, operationId: {type: "string"}, attemptId: {type: "string"},
      targetThreadIds: {type: "array", minItems: 1, maxItems: 100, items: {type: "string"}}, reason: {type: "string", maxLength: 4000},
      workflowThreadId: {type: "string"}, workflowId: {type: "string"}, expectedRevision: {type: "integer", minimum: 1}, returnId: {type: "string"},
      draftThreadId: {type: "string"}, draftTaskId: {type: "string"}, resolution: {type: "string", enum: ["continue", "no_plan"]},
      view: {type: "string", enum: planningDraftViews}, section: {type: "string", enum: planningDraftSections},
      definitionIds: {type: "array", minItems: 1, maxItems: 50, items: {type: "string"}},
    }},
} as const;

type Attempt<A> = {ok: true; value: A} | {ok: false; cause: unknown};
const attempt = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<Attempt<A>> =>
  Effect.catchCauseIf(Effect.map(effect, (value): Attempt<A> => ({ok: true, value})), cause => !Cause.hasInterruptsOnly(cause),
    cause => Effect.succeed<Attempt<A>>({ok: false, cause: Cause.squash(cause)})) as Effect.Effect<Attempt<A>>;
const terminal = new Set(["completed", "failed", "cancelled", "interrupted"]);
const ownReplies = (projection: Projection): MessageInfo[] => projection.messages.filter(message => {
  if (message.threadId !== projection.thread.id || message.role !== "assistant" || message.streaming || !message.runId || !message.nodeId) return false;
  const run = projection.runs.find(run => run.id === message.runId && run.status !== "rolled_back");
  const node = run ? mainRunNodeReader(projection, run)(message.nodeId) : undefined;
  return node?.kind === "assistant_message" && node.status === "completed";
});

export interface SupervisorPlanningControllerShape {
  readonly call: (input: unknown, cancel?: WorkflowCallCancel) => Effect.Effect<unknown, SupervisionStoreError>;
  readonly reconcile: (binding: BindingRecord) => Effect.Effect<void, SupervisionStoreError>;
}

/** Planning state and recovery share the existing guidance database and native admission boundary. */
const make = Effect.gen(function* () {
  const workflows = yield* WorkflowWriteController;
  const states = yield* WorkflowStateStore;
  const native = yield* WorkflowNativeAccess;
  const supervisors = yield* ProjectSupervisorStore;
  const requests = yield* SupervisorConversationStore;
  const team = yield* SupervisorTeamStore;
  const gate = yield* SupervisionGate;
  const ids = yield* SupervisorIds;
  const transaction = guidanceTransaction(yield* GuidanceDb);
  const rpc = Option.getOrNull(yield* Effect.serviceOption(NativeOperateRpc));
  // the read-only context views a drafter reads; absent where a scope has no conversation service
  const conversation = Option.getOrNull(yield* Effect.serviceOption(SupervisorConversation));
  const inFlight = yield* FiberMap.make<string, void>();
  const reconciliations = yield* FiberMap.make<string, void>();
  const releaseSlots = yield* Semaphore.make(8);
  const cleanupSlots = yield* Semaphore.make(4);
  const observationSlots = yield* Semaphore.make(4);
  const clock = yield* Clock.Clock;
  const denied = (reason: string) => ({status: "denied", reason});
  const currentOwner = (payload: PlanningArguments, binding: BindingRecord, guard: GateGuard) => Effect.gen(function* () {
    const locator: WorkflowLocator = {supervisorThreadId: payload.supervisorThreadId, bindingGeneration: payload.bindingGeneration,
      ...(payload.memberEpoch === undefined ? {} : {memberEpoch: payload.memberEpoch}),
      ...(payload.assignmentRootThreadId === undefined ? {} : {assignmentRootThreadId: payload.assignmentRootThreadId}),
      ...(payload.assignmentEpoch === undefined ? {} : {assignmentEpoch: payload.assignmentEpoch})};
    const actor = yield* workflows.resolveBinding(locator, false, "effect", guard);
    const task = yield* supervisors.task(binding.mainThreadId);
    return actor?.threadId === binding.threadId && actor.generation === binding.generation &&
      task?.id === payload.taskId && taskScopeRevision(task) === payload.taskRevision;
  });

  /**
   * The live native descendants of the paused main with ongoing work that are not yet targets: each through its direct route or its
   * parent's dispatch hold, with the parent itself as a target; a descendant a helper covers is uncovered (the root has no pause authority
   * over it), and a parent's acknowledgement never counts for the child, whose own terminal lifecycle marks it quiescent.
   */
  const pausedDescendants = (binding: BindingRecord, scope: SupervisorScopeResolution, parents: ReadonlyMap<string, string | null>,
    known: readonly string[], reason: string, now: number, cancel?: WorkflowCallCancel) => Effect.gen(function* () {
    const targets: NewPlanningAttempt["targets"] = [];
    const uncovered: PlanningUncovered[] = [];
    const seen = new Set(known);
    for (const child of scope.descendants) {
      if (!scope.liveIds.has(child.id) || seen.has(child.id)) continue;
      const projection = yield* attempt(native.projection(child.id, cancel));
      if (!projection.ok || !projectionHasOngoingWork(projection.value, child)) continue;
      const coverage = yield* team.coverage(binding, child.id, parents);
      if (coverage.state !== "root") {uncovered.push({threadId: child.id, reason: "assigned_to_helper", observedAt: now}); seen.add(child.id); continue;}
      const direct = childOrigin(child, undefined) === "delegated_child" && resolveSteerableRun(projection.value) !== null;
      const recipientThreadId = direct ? child.id : child.lineage.parentThreadId;
      if (!recipientThreadId || !scope.allowedIds.has(recipientThreadId)) continue;
      seen.add(child.id);
      targets.push({threadId: child.id, recipientThreadId, scope: `Descendant of the paused main: ${reason}`,
        assignmentRootThreadId: coverage.assignmentRootThreadId, assignmentEpoch: coverage.assignmentEpoch});
    }
    for (const target of [...targets]) if (target.threadId !== target.recipientThreadId && !seen.has(target.recipientThreadId)) {
      const coverage = yield* team.coverage(binding, target.recipientThreadId, parents);
      seen.add(target.recipientThreadId);
      targets.push({threadId: target.recipientThreadId, recipientThreadId: target.recipientThreadId, scope: `Dispatch to affected child ${target.threadId}`,
        assignmentRootThreadId: coverage.assignmentRootThreadId, assignmentEpoch: coverage.assignmentEpoch});
    }
    return {targets, uncovered};
  });
  const currentAttempt = (projectId: string, id: string) => Effect.map(requests.planningAttempts(projectId), rows => rows.find(row => row.id === id) ?? null);
  const update = (projectId: string, id: string, change: (current: PlanningAttempt) => PlanningAttempt) => transaction(Effect.gen(function* () {
    const current = yield* currentAttempt(projectId, id);
    if (!current) return null;
    const next = change(current);
    if (next !== current) yield* requests.savePlanningAttempt(next);
    return next;
  }));
  // the model-facing attempt; the stored row keeps every delivery identity, text and hash
  const answer = (row: PlanningAttempt, withDraftInstruction = false) => planningAttemptAnswer(row, withDraftInstruction);

  /**
   * Why attach_draft refuses a thread as this attempt's drafter, or null: it must be the owner's own app-owned delegated child for this
   * task, no helper, created (or first run) within the attempt's window, with a task no other attempt holds. draft_read admits the same
   * child, so a drafter can read before and after its owner attaches it.
   */
  const draftingChildRefusal = (selected: PlanningAttempt, owner: Projection, threadId: string, taskId: string, binding: BindingRecord, cancel?: WorkflowCallCancel) =>
    Effect.gen(function* () {
      const taskRecord = owner.subagents?.find(item => item.id === taskId && item.childThreadId === threadId && item.origin === "app_owned");
      const draft = yield* attempt(native.projection(threadId, cancel));
      if (!taskRecord || owner.thread.id !== selected.ownerThreadId || !draft.ok || draft.value.thread.lineage.parentThreadId !== selected.ownerThreadId ||
        draft.value.thread.lineage.relationshipToParent !== "subagent" ||
        (yield* team.snapshot(binding)).members.some(member => member.threadId === threadId)) return "planning_draft_not_owned_child";
      const created = typeof taskRecord.startedAt === "string" ? Date.parse(taskRecord.startedAt) : Number.NaN;
      const freshRun = draft.value.runs.some(run => run.delegatedTaskId === taskId && Date.parse(run.requestedAt) >= selected.createdAt &&
        Date.parse(run.requestedAt) < selected.deadline);
      if (!(Number.isFinite(created) && created >= selected.createdAt && created < selected.deadline) && !freshRun ||
        (yield* requests.planningAttempts(selected.projectId)).some(row => row.id !== selected.id && row.draft?.taskId === taskId))
        return "planning_draft_not_new_for_attempt";
      return null;
    });

  const call = (input: unknown, cancel?: WorkflowCallCancel) => Effect.gen(function* (): Effect.fn.Return<unknown, SupervisionStoreError> {
    const parsed = Schema.decodeUnknownExit(Arguments)(input, {onExcessProperty: "error"});
    if (Exit.isFailure(parsed)) return {status: "invalid", reason: "invalid_planning_arguments"};
    if (parsed.value.action === "draft_read") return yield* draftRead(parsed.value, cancel);
    const payload = parsed.value;
    const proof = yield* workflows.authorizeNative(payload as WorkflowLocator & Record<string, unknown>, "planning", false, cancel);
    if (proof.status !== "verified") return proof;
    const binding = proof.binding;
    const task = yield* supervisors.task(binding.mainThreadId);
    if (!task || task.id !== payload.taskId || taskScopeRevision(task) !== payload.taskRevision) return denied("planning_task_changed");
    const existing = yield* requests.planningAttempts(binding.projectId, payload.supervisorThreadId);
    if (payload.action === "read") return {status: "ready", attempts: existing.filter(row => row.taskId === task.id).map(row => answer(row, true))};
    if (!payload.operationId) return {status: "invalid", reason: "operation_id_required"};
    const clockNow = yield* Clock.currentTimeMillis;
    if (payload.action === "apply_return") return yield* applyReturn(payload, binding, cancel);
    if (payload.action !== "pause") {
      const selected = existing.find(row => row.id === payload.attemptId && row.taskId === task.id);
      if (!selected) return denied("planning_attempt_unknown");
      if (selected.state !== "open" || clockNow >= selected.deadline) return {status: "closed", attempt: answer(expirePlanningAttempt(selected, clockNow))};
      if (payload.action === "attach_draft") {
        if (!payload.draftThreadId || selected.draft && selected.draft.threadId !== payload.draftThreadId) return denied("planning_draft_already_assigned");
        const owner = yield* attempt(native.projection(payload.supervisorThreadId, cancel));
        if (!payload.draftTaskId || !owner.ok) return denied("planning_draft_not_owned_child");
        const refusal = yield* draftingChildRefusal(selected, owner.value, payload.draftThreadId, payload.draftTaskId, binding, cancel);
        if (refusal) return denied(refusal);
        const attached = yield* gate.admit(guard => transaction(Effect.gen(function* () {
          if (!(yield* currentOwner(payload, binding, guard))) return null;
          return yield* update(binding.projectId, selected.id, current => current.state === "open" && clock.currentTimeMillisUnsafe() < current.deadline && !current.draft
            ? {...current, draft: {threadId: payload.draftThreadId!, taskId: payload.draftTaskId ?? null, state: "working", resultMessageId: null, resultRunId: null}} : current);
        })));
        return attached ? {status: "recorded", attempt: answer(attached)} : denied("planning_scope_changed");
      }
      if (payload.resolution !== "no_plan" && !planningCanAdopt(selected, clockNow)) return denied("planning_acks_incomplete");
      const released = yield* gate.admit(guard => transaction(Effect.gen(function* () {
        if (!(yield* currentOwner(payload, binding, guard))) return null;
        const current = yield* currentAttempt(binding.projectId, selected.id);
        if (!current || payload.resolution !== "no_plan" && !planningCanAdopt(current, clock.currentTimeMillisUnsafe())) return null;
        const scopedIds = new Map<string, string>();
        if (payload.resolution !== "no_plan") for (const target of current.targets.filter(target => target.threadId !== binding.mainThreadId)) {
          const child = yield* states.getState(binding.projectId, binding.mainThreadId, target.threadId);
          if (child.status !== "found" || child.document.plan === null || !child.document.parentWorkflowId) return null;
          scopedIds.set(target.threadId, child.document.workflowId);
        }
        return yield* update(binding.projectId, selected.id, row => resolvePlanningAttempt({...row, targets: row.targets.map(target =>
          scopedIds.has(target.threadId) ? {...target, scopedWorkflowId: scopedIds.get(target.threadId)!} : target)}, payload.resolution ?? "continue", clockNow));
      })));
      return released ? {status: "recorded", attempt: answer(released)} : denied("planning_scope_changed");
    }
    if (!payload.targetThreadIds?.length || !payload.reason || new Set(payload.targetThreadIds).size !== payload.targetThreadIds.length)
      return {status: "invalid", reason: "planning_targets_required"};
    const replay = existing.find(row => row.operationId === payload.operationId && row.bindingGeneration === binding.generation);
    if (replay) return replay.requestHash === workflowRequestHash(input) ? {status: "recorded", attempt: answer(replay, true)} : denied("operation_id_conflict");
    if (existing.some(row => row.state === "open")) return denied("planning_attempt_inflight");
    const observedThreads = yield* attempt(native.listThreads(cancel));
    if (!observedThreads.ok) return denied("planning_scope_unavailable");
    const threads = observedThreads.value;
    const scope = resolveSupervisorScope(threads, binding.projectId, binding.mainThreadId, supervisors.ownedIds);
    if (!scope.complete || !scope.main) return denied("planning_scope_unavailable");
    const sourceProjection = yield* attempt(native.projection(binding.mainThreadId, cancel));
    const requestMessage = sourceProjection.ok ? sourceProjection.value.messages.find(message => message.id === task.sourceMessageId && !message.streaming) : null;
    if (!requestMessage) return denied("planning_source_unavailable");
    const parents = new Map(threads.map(thread => [thread.id, thread.lineage.parentThreadId]));
    const targets: Array<{threadId: string; recipientThreadId: string; scope: string; assignmentRootThreadId?: string | null; assignmentEpoch?: number | null}> = [];
    for (const threadId of payload.targetThreadIds) {
      const thread = scope.byId.get(threadId);
      if (!thread || !scope.allowedIds.has(threadId) || !scope.liveIds.has(threadId)) return denied("planning_target_outside_scope");
      const coverage = yield* team.coverage(binding, threadId, parents);
      if (payload.supervisorThreadId !== binding.threadId) {
        if (coverage.state !== "assigned" || coverage.actorThreadId !== payload.supervisorThreadId || coverage.memberEpoch !== payload.memberEpoch)
          return denied("planning_target_not_assigned");
      } else if (coverage.state !== "root") return denied("planning_target_owned_by_helper");
      const projection = yield* attempt(native.projection(threadId, cancel));
      if (!projection.ok) return denied("planning_target_unavailable");
      const origin = childOrigin(thread, undefined);
      const direct = threadId === binding.mainThreadId || origin === "delegated_child" && resolveSteerableRun(projection.value) !== null;
      const recipientThreadId = direct ? threadId : thread.lineage.parentThreadId;
      if (!recipientThreadId || !scope.allowedIds.has(recipientThreadId)) return denied("planning_parent_relay_unavailable");
      if (payload.supervisorThreadId !== binding.threadId && recipientThreadId !== threadId) {
        const parentCoverage = yield* team.coverage(binding, recipientThreadId, parents);
        if (parentCoverage.state !== "assigned" || parentCoverage.actorThreadId !== payload.supervisorThreadId)
          return denied("planning_parent_requires_root");
      }
      targets.push({threadId, recipientThreadId, scope: payload.reason, assignmentRootThreadId: coverage.assignmentRootThreadId, assignmentEpoch: coverage.assignmentEpoch});
    }
    // a paused main holds its live native descendants with ongoing work through the same direct-or-parent route; a child a helper
    // covers is listed as uncovered, never paused by the root's authority and never silently omitted
    const uncovered: PlanningUncovered[] = [];
    if (payload.supervisorThreadId === binding.threadId && targets.some(target => target.threadId === binding.mainThreadId)) {
      const descendants = yield* pausedDescendants(binding, scope, parents, targets.map(target => target.threadId), payload.reason, clockNow, cancel);
      targets.push(...descendants.targets);
      uncovered.push(...descendants.uncovered);
    }
    for (const target of [...targets]) if (target.threadId !== target.recipientThreadId && !targets.some(row => row.threadId === target.recipientThreadId)) {
      const coverage = yield* team.coverage(binding, target.recipientThreadId, parents);
      targets.push({threadId: target.recipientThreadId, recipientThreadId: target.recipientThreadId, scope: `Dispatch to affected child ${target.threadId}`,
        assignmentRootThreadId: coverage.assignmentRootThreadId, assignmentEpoch: coverage.assignmentEpoch});
    }
    if (targets.length > planningTargetLimit) return {status: "denied", reason: "planning_targets_limit", targetCount: targets.length};
    const settings = yield* supervisors.settings(binding.projectId);
    const timeoutMs = "planningTimeoutMs" in settings && typeof settings.planningTimeoutMs === "number" ? settings.planningTimeoutMs : defaultPlanningTimeoutMs;
    const created = createPlanningAttempt({id: yield* ids.uuid, operationId: payload.operationId, requestHash: workflowRequestHash(input),
      projectId: binding.projectId, mainThreadId: binding.mainThreadId, ownerThreadId: payload.supervisorThreadId,
      bindingGeneration: binding.generation, ...(payload.memberEpoch ? {memberEpoch: payload.memberEpoch} : {}), taskId: task.id,
      taskRevision: payload.taskRevision, requestSource: {messageId: requestMessage.id, hash: fingerprint(requestMessage.text)},
      baselineAgreementId: task.agreement?.proposalId ?? null, reason: payload.reason, createdAt: clockNow, timeoutMs, targets, ...(uncovered.length ? {uncovered} : {})});
    return yield* gate.admit(guard => transaction(Effect.gen(function* () {
      if (!(yield* currentOwner(payload, binding, guard))) return denied("planning_scope_changed");
      const concurrent = (yield* requests.planningAttempts(binding.projectId, payload.supervisorThreadId)).find(row => row.state === "open");
      if (concurrent) return concurrent.operationId === payload.operationId && concurrent.requestHash === created.requestHash
        ? {status: "recorded", attempt: answer(concurrent, true)} : denied("planning_attempt_inflight");
      yield* requests.savePlanningAttempt(created);
      return {status: "recorded", attempt: answer(created, true)};
    })));
  });

  const applyReturn = (payload: PlanningArguments, binding: BindingRecord, cancel?: WorkflowCallCancel) => Effect.gen(function* () {
    if (!payload.workflowId || !payload.expectedRevision || !payload.returnId || !payload.reason || !payload.operationId || !payload.attemptId)
      return {status: "invalid", reason: "return_coordinates_required"};
    const targetId = payload.workflowThreadId ?? binding.mainThreadId;
    const document = yield* states.getState(binding.projectId, binding.mainThreadId, targetId);
    if (document.status !== "found" || document.document.workflowId !== payload.workflowId) return denied("return_workflow_unknown");
    const entry = document.document.returns.find(entry => entry.returnId === payload.returnId);
    if (!entry) return denied("return_unknown");
    const listed = yield* attempt(native.listThreads(cancel));
    if (!listed.ok) return denied("return_scope_unavailable");
    const scope = resolveSupervisorScope(listed.value, binding.projectId, binding.mainThreadId, supervisors.ownedIds);
    const parents = new Map(listed.value.map(thread => [thread.id, thread.lineage.parentThreadId]));
    if (!scope.complete || !scope.allowedIds.has(targetId)) return denied("return_scope_unavailable");
    const owner = {projectId: binding.projectId, mainThreadId: binding.mainThreadId, supervisorThreadId: binding.threadId, bindingGeneration: binding.generation};
    const expected = {...(payload.memberEpoch === undefined ? {} : {memberEpoch: payload.memberEpoch}),
      ...(payload.assignmentRootThreadId === undefined ? {} : {assignmentRootThreadId: payload.assignmentRootThreadId}),
      ...(payload.assignmentEpoch === undefined ? {} : {assignmentEpoch: payload.assignmentEpoch})};
    if (!(yield* team.authorizeWrite(binding, payload.supervisorThreadId, targetId, parents, expected))) return denied("return_not_assigned");
    if (entry.state === "applied" && entry.resolution?.operationId === payload.operationId)
      return yield* states.applyReturn(owner, {operationId: payload.operationId, workflowId: payload.workflowId, expectedRevision: payload.expectedRevision,
        returnId: payload.returnId, note: payload.reason, retiredRuns: entry.retiredRuns});
    if (entry.state !== "pending") return denied("return_not_pending");
    const region = new Set(entry.regionNodeIds);
    const required = new Set([targetId, ...planEntities(document.document.plan).filter(node => region.has(node.nodeId)).flatMap(node => node.contributorThreadIds)]);
    // point-in-time reads before the admitted commit (nothing is atomic with T3): the owner's is the last, so work it starts while its
    // contributors are read is seen by the decision
    const snapshot = Effect.gen(function* () {
      const projections = new Map<string, Projection>();
      const main = yield* attempt(native.projection(binding.mainThreadId, cancel));
      const task = yield* supervisors.task(binding.mainThreadId);
      if (!main.ok || !task || !conversationAuthorityCurrent(task, main.value, yield* projectRequesterPolicy(supervisors, binding.projectId)))
        return denied("return_task_not_authorised");
      if (!document.document.sourceBinding || document.document.sourceBinding.taskId !== task.id ||
        document.document.sourceBinding.sourceHash !== taskScopeRevision(task)) return denied("return_workflow_scope_changed");
      projections.set(binding.mainThreadId, main.value);
      const source = main.value.messages.find(message => message.id === task.sourceMessageId);
      if (!source) return denied("return_source_unavailable");
      for (const id of [...[...required].filter(id => id !== targetId), targetId]) {
        if (!scope.allowedIds.has(id)) return denied("return_contributor_outside_scope");
        const observed = yield* attempt(native.projection(id, cancel));
        if (!observed.ok || observed.value.thread.id !== id) return denied("return_actor_unavailable");
        projections.set(id, observed.value);
        const parentId = parents.get(id);
        if (id !== binding.mainThreadId && parentId && !projections.has(parentId)) {
          const parent = yield* attempt(native.projection(parentId, cancel));
          if (!parent.ok) return denied("return_parent_unavailable");
          projections.set(parentId, parent.value);
        }
      }
      return {projections, task, source};
    });
    // the decision is made only on a snapshot that never waited for admission: while another section holds the gate, the call waits for it
    // to end and reads again, a bounded number of times, and otherwise answers busy without committing anything
    for (let pass = 0; pass < 3; pass++) {
      if (pass > 0) yield* gate.admit(() => Effect.void);
      const read = yield* snapshot;
      if ("status" in read) return read;
      const {projections, task, source} = read;
      const decided = yield* gate.admitIfAvailable(guard => transaction(Effect.gen(function* () {
      if (!(yield* currentOwner(payload, binding, guard)) || !(yield* team.authorizeWrite(binding, payload.supervisorThreadId, targetId, parents, expected)))
        return denied("planning_scope_changed");
      const now = yield* Clock.currentTimeMillis;
      const pauses = (yield* requests.planningAttempts(binding.projectId)).filter(row => row.mainThreadId === binding.mainThreadId && row.taskId === payload.taskId &&
        row.bindingGeneration === binding.generation && row.state === "open" && now < row.deadline &&
        (row.requestSource ? row.requestSource.messageId === task.sourceMessageId && row.requestSource.hash === fingerprint(source.text) : row.taskRevision === payload.taskRevision));
      if (!pauses.some(row => row.id === payload.attemptId && row.ownerThreadId === payload.supervisorThreadId)) return denied("return_pause_not_open");
      const held = new Set<string>();
      const acknowledgedRuns = new Map<string, Set<string>>();
      for (const pause of pauses) for (const target of pause.targets) {
        const observed = projections.get(target.threadId);
        if (!observed) continue;
        if (target.state === "quiescent" && !projectionHasOngoingWork(observed) && !observed.runs.some(run => run.status === "queued")) held.add(target.threadId);
        if (target.state !== "acknowledged" || !target.acknowledgement) continue;
        const acknowledgment = target.acknowledgement;
        const message = ownReplies(observed).find(message => message.id === acknowledgment.messageId && message.runId === acknowledgment.runId);
        if (message && exactFenceRecords(message.text, "planning-pause-ack", 2, true).some(record => {
          const parsed = Schema.decodeUnknownExit(PlanningAcknowledgement)(record.value, {onExcessProperty: "error"});
          return Exit.isSuccess(parsed) && parsed.value.attemptId === pause.id && parsed.value.targetThreadId === target.threadId;
        })) {
          held.add(target.threadId);
          const runs = acknowledgedRuns.get(target.threadId) ?? new Set<string>();
          runs.add(acknowledgment.runId);
          acknowledgedRuns.set(target.threadId, runs);
        }
      }
      if (!held.has(targetId)) return denied("return_owner_not_paused");
      for (const id of new Set([...required, ...held])) {
        const projection = projections.get(id)!;
        const turns = readNativeProviderTurns(projection);
        if (turns === null) return denied("return_contributor_identity_unavailable");
        if (projectionHasOngoingProviderTurns(projection)) return denied("return_actor_not_quiescent");
        if (held.has(id)) {
          const acknowledged = acknowledgedRuns.get(id);
          if (projection.thread.activeRunId && acknowledged && !acknowledged.has(projection.thread.activeRunId) ||
            projection.runs.some(run => run.status === "queued" || !terminal.has(run.status) && run.status !== "rolled_back" && !acknowledged?.has(run.id)))
            return denied("return_actor_changed_run");
          continue;
        }
        const parentId = parents.get(id);
        const parent = parentId ? projections.get(parentId) : null;
        const lifecycle = parent ? directParentChildLifecycle(parent, id) : null;
        const quiet = !projectionHasOngoingWork(projection) && !projection.runs.some(run => run.status === "queued") &&
          (projection.runs.some(run => terminal.has(run.status)) || lifecycle && terminal.has(lifecycle.status));
        if (!quiet || !parentId || !held.has(parentId)) return denied("return_actor_not_quiescent");
      }
      const retiredRuns: WorkflowReturnRun[] = [];
      for (const id of required) if (id !== binding.mainThreadId && id !== targetId) {
        const projection = projections.get(id)!;
        if (projection.runs.length) {
          for (const run of projection.runs.filter(run => run.status !== "rolled_back"))
            retiredRuns.push({kind: "run", threadId: id, runId: run.id});
          continue;
        }
        const parentId = parents.get(id);
        const nativeChildren = (parentId ? projections.get(parentId)?.subagents : [])?.filter(child => child.childThreadId === id && child.origin === "provider_native") ?? [];
        if (!nativeChildren.length) return denied("return_contributor_identity_unavailable");
        const turns = readNativeProviderTurns(projection);
        if (turns === null) return denied("return_contributor_identity_unavailable");
        if (turns.length) {
          const providers = new Set(nativeChildren.map(child => child.providerThreadId));
          if (providers.size !== 1 || turns.some(turn => {
            const node = nativeNodeTurn(projection, turn.nodeId, id);
            return !providers.has(turn.providerThreadId) || !node || node.providerTurnId !== turn.id || node.providerThreadId !== turn.providerThreadId;
          })) return denied("return_contributor_identity_unavailable");
          retiredRuns.push({kind: "provider_turns", threadId: id, providerThreadId: turns[0]!.providerThreadId, providerTurnIds: turns.map(turn => turn.id)});
        } else retiredRuns.push({kind: "thread", threadId: id, reason: "No published per-execution identity; replace this reviewer and carry forward its findings."});
      }
      if (retiredRuns.length > 50 || retiredRuns.some(entry => entry.kind === "provider_turns" && entry.providerTurnIds.length > 50)) return denied("return_run_capacity");
      return yield* states.applyReturn(owner, {operationId: payload.operationId!, workflowId: payload.workflowId!, expectedRevision: payload.expectedRevision!,
        returnId: payload.returnId!, note: payload.reason!, retiredRuns}, now);
    })));
      if (Option.isSome(decided)) return decided.value;
    }
    return {status: "unavailable", reason: "return_admission_busy"};
  });

  /**
   * A drafter's read. The call is admitted only as the own executed call, with exactly these arguments, of this attempt's drafter: the
   * attached one or, before attach_draft, a new app-owned child of the owner that attach_draft would accept (a child whose task started
   * outside the attempt's window reads only once attached). The attempt must be open, before its deadline, for the current binding
   * generation, owner and task revision, with no other drafter attached. It answers one read-only view and writes, contacts, changes
   * and renews nothing; it never names the root's own interpretation submission.
   */
  const draftRead = (payload: DraftReadArguments, cancel?: WorkflowCallCancel) => Effect.gen(function* (): Effect.fn.Return<unknown, SupervisionStoreError> {
    if (payload.definitionIds && payload.view !== "definitions" || payload.section && payload.view !== "context")
      return {status: "invalid", reason: "invalid_planning_arguments"};
    if (!conversation) return {status: "unavailable", reason: "planning_views_unavailable"};
    const owner = yield* attempt(native.projection(payload.supervisorThreadId, cancel));
    if (!owner.ok || owner.value.thread.id !== payload.supervisorThreadId || typeof owner.value.thread.projectId !== "string") return denied("planning_attempt_unknown");
    const projectId = owner.value.thread.projectId;
    const selected = (yield* requests.planningAttempts(projectId, payload.supervisorThreadId)).find(row => row.id === payload.attemptId &&
      row.bindingGeneration === payload.bindingGeneration && row.taskId === payload.taskId && row.taskRevision === payload.taskRevision);
    if (!selected) return denied("planning_attempt_unknown");
    const closed = {status: "closed", reason: "planning_attempt_closed"};
    if (selected.state !== "open" || clock.currentTimeMillisUnsafe() >= selected.deadline) return closed;
    const binding = yield* supervisors.binding(projectId, selected.mainThreadId);
    if (!binding) return denied("planning_scope_changed");
    const inWindow = (startedAt: unknown) => {
      const created = typeof startedAt === "string" ? Date.parse(startedAt) : Number.NaN;
      return !Number.isFinite(created) || created >= selected.createdAt && created < selected.deadline;
    };
    const candidates = (owner.value.subagents ?? []).filter(item => item.origin === "app_owned" && typeof item.id === "string" && typeof item.childThreadId === "string" &&
      (selected.draft ? item.id === selected.draft.taskId && item.childThreadId === selected.draft.threadId : inWindow(item.startedAt)));
    let proof: {status: string; reason?: string} = {status: "denied", reason: "planning_drafter_unknown"};
    let drafter: string | null = null;
    for (const candidate of candidates) {
      const threadId = candidate.childThreadId as string;
      if ((yield* draftingChildRefusal(selected, owner.value, threadId, candidate.id as string, binding, cancel)) !== null) continue;
      proof = yield* workflows.verifyOwnCall(threadId, projectId, payload, "planning", cancel);
      if (proof.status === "verified") {
        drafter = threadId;
        break;
      }
    }
    if (drafter === null) return {status: proof.status, reason: proof.reason, ...(proof.status === "pending" ? {retryable: true} : {})};
    const admitted = yield* gate.admit(guard => Effect.gen(function* () {
      const current = yield* currentAttempt(projectId, selected.id);
      if (current?.state !== "open" || clock.currentTimeMillisUnsafe() >= current.deadline) return "closed" as const;
      const actor = yield* workflows.resolveBinding({supervisorThreadId: selected.ownerThreadId, bindingGeneration: selected.bindingGeneration,
        ...(selected.memberEpoch === undefined ? {} : {memberEpoch: selected.memberEpoch})}, false, "effect", guard);
      const task = yield* supervisors.task(selected.mainThreadId);
      return actor && actor.mainThreadId === selected.mainThreadId && actor.generation === selected.bindingGeneration &&
        (!current.draft || current.draft.threadId === drafter) && task?.id === selected.taskId && taskScopeRevision(task) === selected.taskRevision &&
        (!selected.requestSource || task.sourceMessageId === selected.requestSource.messageId) ? actor : "changed" as const;
    }));
    if (admitted === "closed") return closed;
    if (admitted === "changed") return denied("planning_scope_changed");
    // the plan authoring rules, without the root's pause coordination
    if (payload.view === "plan_rules") return {status: "ok", view: payload.view, instructions: planAuthoringRules};
    const read = yield* conversation.readContextView(admitted, {view: payload.view, ...(payload.section ? {section: payload.section} : {}),
      ...(payload.definitionIds ? {definitionIds: payload.definitionIds} : {})}, cancel);
    // a Stop since admission answers the root's own resume route, never a drafter's
    if (read.supervision === "stopped") return denied("planning_scope_changed");
    const shown: Record<string, unknown> = {...read};
    delete shown.submission;
    // the main's message handles are read in its own thread; the sections a drafter reads are its own
    return {...shown, view: payload.view,
      ...(payload.view === "context" && read.status === "ok" ? {mainThreadId: admitted.mainThreadId} : {}),
      ...(payload.view === "context" && Array.isArray(read.sections) ? {sections: planningDraftSections} : {}),
      ...("conversation" in read ? {conversation: drafterConversation(read.conversation as ConversationFacts | null)} : {})};
  });

  const replaceDelivery = (row: PlanningAttempt, threadId: string, kind: "hold" | "release", delivery: PlanningDelivery, confirmed = false): PlanningAttempt => {
    const existing = row.targets.find(target => target.threadId === threadId)?.[kind];
    if (existing?.state === "sent" && delivery.state !== "sent") return row;
    const targets = row.targets.map(target => target.threadId === threadId ? {...target, [kind]: delivery,
      ...(kind === "release" && confirmed ? {state: "released" as const, closedAt: clock.currentTimeMillisUnsafe()} : {})} : target);
    return {...row, targets, ...(row.state === "releasing" && targets.every(target => target.state === "closed" || target.state === "released")
      ? {state: "resolved" as const, closedAt: clock.currentTimeMillisUnsafe()} : {})};
  };
  const deliver = (binding: BindingRecord, selected: PlanningAttempt, target: PlanningTarget, kind: "hold" | "release") => Effect.gen(function* () {
    if (!rpc) return;
    const delivery = kind === "hold" ? target.hold : target.release;
    if (!delivery || delivery.state !== "prepared") return;
    const observedThreads = yield* attempt(native.listThreads());
    if (!observedThreads.ok) return;
    const parentById = new Map(observedThreads.value.map(thread => [thread.id, thread.lineage.parentThreadId]));
    const observedScope = resolveSupervisorScope(observedThreads.value, binding.projectId, binding.mainThreadId, supervisors.ownedIds);
    if (!observedScope.complete || !observedScope.allowedIds.has(target.threadId) || !observedScope.allowedIds.has(target.recipientThreadId)) return;
    const source = selected.requestSource ? yield* attempt(native.projection(binding.mainThreadId)) : null;
    const currentSource = source?.ok && selected.requestSource ? source.value.messages.find(message => message.id === selected.requestSource!.messageId && !message.streaming) : null;
    if (kind === "hold" && selected.requestSource && (!source?.ok || !currentSource || fingerprint(currentSource.text) !== selected.requestSource.hash ||
      requesterSources(source.value, yield* projectRequesterPolicy(supervisors, binding.projectId)).at(-1)?.messageId !== selected.requestSource.messageId)) return;
    const recipient = yield* attempt(native.projection(target.recipientThreadId));
    const actor = yield* attempt(native.projection(selected.ownerThreadId));
    if (!recipient.ok || !actor.ok || recipient.value.thread.archivedAt || recipient.value.thread.deletedAt ||
      !canSupervisorContact(actor.value.thread, recipient.value.thread)) return;
    const steerable = resolveSteerableRun(recipient.value);
    if (kind === "hold" && hasPendingOwnerInput(recipient.value)) return;
    const child = target.recipientThreadId !== binding.mainThreadId;
    if (child && !steerable) return;
    const dispatchMode = steerable && !hasPendingOwnerInput(recipient.value)
      ? {type: "steer_active", targetRunId: steerable.id} : {type: "queue_after_active"};
    const operate = rpc;
    yield* admitSend(gate, {identity: delivery.commandId, inFlight,
      reconcile: Effect.void,
      prepare: guard => transaction(Effect.gen(function* (): Effect.fn.Return<SendPreparation<void>, SupervisionStoreError> {
        const current = yield* currentAttempt(binding.projectId, selected.id);
        const currentTarget = current?.targets.find(row => row.threadId === target.threadId);
        const stored = kind === "hold" ? currentTarget?.hold : currentTarget?.release;
        const now = yield* Clock.currentTimeMillis;
        const liveBinding = yield* supervisors.binding(binding.projectId, binding.mainThreadId);
        const currentTask = yield* supervisors.task(binding.mainThreadId);
        if (kind === "hold" && (!liveBinding || liveBinding.generation !== selected.bindingGeneration ||
          currentTask?.id !== selected.taskId || selected.requestSource && currentTask.sourceMessageId !== selected.requestSource.messageId ||
          !(yield* team.authorizeWrite(binding, selected.ownerThreadId, target.threadId, parentById,
            selected.memberEpoch === undefined ? {} : {memberEpoch: selected.memberEpoch,
              ...(target.assignmentRootThreadId === undefined ? {} : {assignmentRootThreadId: target.assignmentRootThreadId}),
              ...(target.assignmentEpoch === undefined ? {} : {assignmentEpoch: target.assignmentEpoch})})))) return {_tag: "Answer", value: undefined};
        if (!current || !currentTarget || stored?.state !== "prepared" ||
          kind === "hold" && ((yield* guard.supervisionStopped(binding.mainThreadId)) || (!(yield* guard.scopeEnabled(binding.projectId, binding.mainThreadId)) || current.state !== "open" || now >= current.deadline)))
          return {_tag: "Answer", value: undefined};
        const anchored = kind === "hold" ? startPlanningAttempt(current, now) : current;
        // a release reads the main's current agreement state: planning resolved or superseded leaves an unagreed proposal unagreed
        const text = kind === "hold" ? planningHoldText(anchored, currentTarget)
          : planningReleaseText(anchored, currentTarget, unacceptedProposal(anchored, currentTarget, currentTask));
        const sending: PlanningDelivery = {...stored, state: "sending", attemptedAt: now, text,
          runId: dispatchMode.type === "steer_active" ? dispatchMode.targetRunId ?? null : null};
        yield* requests.savePlanningAttempt(replaceDelivery(anchored, target.threadId, kind, sending));
        return {_tag: "Initiate", initiate: Effect.map(operate.initiate("orchestration.dispatchCommand", {
          type: "message.dispatch", commandId: stored.commandId, messageId: stored.messageId, threadId: target.recipientThreadId,
          text, attachments: [], createdBy: "system", creationSource: "server", dispatchMode,
        }), flight => ({release: flight.release, result: Effect.gen(function* () {
          const reply = yield* attempt(flight.result);
          const accepted = reply.ok && record(reply.value) && Number.isSafeInteger(reply.value.sequence);
          const definite = !reply.ok && reply.cause instanceof SupervisorRpcError && reply.cause.definiteRejection;
          yield* update(binding.projectId, selected.id, latest => replaceDelivery(latest, target.threadId, kind,
            {...sending, state: accepted ? "sent" : definite ? "not_sent" : "uncertain"})).pipe(Effect.orDie);
        }).pipe(Effect.onInterrupt(() => update(binding.projectId, selected.id, latest => replaceDelivery(latest, target.threadId, kind,
          {...sending, state: "uncertain"})).pipe(Effect.orDie, Effect.asVoid)))}))};
      })),
    });
  });

  // these are the same published native commands used by T3 task cancellation, restricted to the registered drafting task
  const draftEffect = (binding: BindingRecord, selected: PlanningAttempt, kind: "notice" | "cleanup", cleanupIndex = 0) => Effect.gen(function* () {
    if (!rpc || !selected.draft?.taskId) return;
    const owner = yield* attempt(native.projection(selected.ownerThreadId));
    const child = yield* attempt(native.projection(selected.draft.threadId));
    if (!owner.ok || !child.ok || child.value.thread.lineage.parentThreadId !== selected.ownerThreadId ||
      child.value.thread.lineage.relationshipToParent !== "subagent" || !canSupervisorContact(owner.value.thread, child.value.thread) ||
      !owner.value.subagents?.some(item => item.id === selected.draft!.taskId && item.childThreadId === selected.draft!.threadId && item.origin === "app_owned")) return;
    const cleanup = selected.draft.cleanup?.[cleanupIndex];
    const delivery = kind === "notice" ? selected.draft.ownerNotice : cleanup?.receipt;
    if (!delivery || delivery.state !== "prepared") return;
    const text = selected.draft.ownerNoticeText;
    if (kind === "notice" && (!text || hasPendingOwnerInput(owner.value))) return;
    const save = (current: PlanningAttempt, receipt: PlanningDelivery): PlanningAttempt => !current.draft ? current : {...current, draft: {...current.draft,
      ...(kind === "notice" ? {ownerNotice: receipt} : {cleanup: current.draft.cleanup?.map((item, index) => index === cleanupIndex ? {...item, receipt} : item)})}};
    yield* admitSend(gate, {identity: delivery.commandId, inFlight, reconcile: Effect.void,
      prepare: guard => transaction(Effect.gen(function* (): Effect.fn.Return<SendPreparation<void>, SupervisionStoreError> {
        const current = yield* currentAttempt(binding.projectId, selected.id);
        const stored = kind === "notice" ? current?.draft?.ownerNotice : current?.draft?.cleanup?.[cleanupIndex]?.receipt;
        if (!current?.draft || current.draft.threadId !== selected.draft!.threadId || stored?.state !== "prepared" ||
          kind === "notice" && (current.state !== "open" || (yield* guard.supervisionStopped(binding.mainThreadId)))) return {_tag: "Answer", value: undefined};
        const sending: PlanningDelivery = {...stored, state: "sending", attemptedAt: yield* Clock.currentTimeMillis, runId: null,
          ...(kind === "notice" ? {text: text!} : {})};
        yield* requests.savePlanningAttempt(save(current, sending));
        const command = kind === "notice" ? {type: "message.dispatch", commandId: stored.commandId, messageId: stored.messageId,
          threadId: selected.ownerThreadId, text, attachments: [], createdBy: "system", creationSource: "server", dispatchMode: {type: "queue_after_active"}}
          : cleanup!.type === "delegated_task.completion-delivery.dispose" ? {type: cleanup!.type, commandId: stored.commandId,
            parentThreadId: selected.ownerThreadId, taskId: current.draft.taskId}
          : cleanup!.type === "queued-run.cancel" ? {type: cleanup!.type, commandId: stored.commandId, threadId: current.draft.threadId, runId: cleanup!.runId}
          : {type: "thread.stop", commandId: stored.commandId, threadId: current.draft.threadId, stopDelegatedTasks: true, reason: "The bounded planning attempt has ended."};
        return {_tag: "Initiate", initiate: Effect.map(rpc!.initiate("orchestration.dispatchCommand", command), flight => ({release: flight.release,
          result: Effect.gen(function* () {
            const reply = yield* attempt(flight.result);
            const accepted = reply.ok && record(reply.value) && Number.isSafeInteger(reply.value.sequence);
            yield* update(binding.projectId, current.id, row => save(row, {...sending, state: accepted ? "sent" :
              !reply.ok && reply.cause instanceof SupervisorRpcError && reply.cause.definiteRejection ? "not_sent" : "uncertain"})).pipe(Effect.orDie);
          }).pipe(Effect.onInterrupt(() => update(binding.projectId, current.id, row => save(row, {...sending, state: "uncertain"})).pipe(Effect.orDie, Effect.asVoid)))}))};
      }))});
  });

  const cleanupDraft = (binding: BindingRecord, selected: PlanningAttempt) => Effect.gen(function* () {
    let current = (yield* currentAttempt(binding.projectId, selected.id))!;
    if (current.state === "open" || !current.draft?.taskId) return;
    const now = yield* Clock.currentTimeMillis;

        const child = yield* attempt(native.projection(current.draft.threadId));
        if (child.ok && !current.draft.cleanup) {
          const queued = child.value.runs.filter(run => run.status === "queued");
          current = (yield* update(binding.projectId, current.id, row => !row.draft || row.draft.cleanup ? row : {...row, draft: {...row.draft,
            cleanup: [
              {type: "thread.stop", runId: null, receipt: planningDelivery(row.id, `${row.draft.threadId}:stop`, "draft")},
              ...queued.map(run => ({type: "queued-run.cancel" as const, runId: run.id, receipt: planningDelivery(row.id, `${row.draft!.threadId}:queue:${run.id}`, "draft")})),
              {type: "delegated_task.completion-delivery.dispose", runId: null, receipt: planningDelivery(row.id, `${row.draft.threadId}:dispose`, "draft")},
            ]}}))!;
        }
        for (let index = 0; index < (current.draft?.cleanup?.length ?? 0); index++) yield* draftEffect(binding, current, "cleanup", index);
        const stopped = yield* attempt(native.projection(current.draft!.threadId));
        if (stopped.ok && !projectionHasOngoingWork(stopped.value) && !stopped.value.runs.some(run => run.status === "queued"))
          yield* update(binding.projectId, current.id, row => row.draft?.cleanup?.every(item => item.receipt.state === "sent")
            ? {...row, draft: {...row.draft, cleanupConfirmedAt: now}} : row);
  });

  const reconcile = (binding: BindingRecord) => Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    for (const selected of (yield* requests.planningAttempts(binding.projectId)).filter(row => row.mainThreadId === binding.mainThreadId && planningHasUnresolvedEffects(row))) {
      let current = (yield* update(binding.projectId, selected.id, row => expirePlanningAttempt(row, now)))!;
      if (current.state === "open") {
        const stopped = yield* gate.admit(guard => Effect.gen(function* () {return (yield* guard.supervisionStopped(binding.mainThreadId)) || !(yield* guard.scopeEnabled(binding.projectId, binding.mainThreadId));}));
        const task = yield* supervisors.task(binding.mainThreadId);
        if (stopped || binding.generation !== current.bindingGeneration || !task || task.id !== current.taskId ||
          (current.requestSource ? task.sourceMessageId !== current.requestSource.messageId : taskScopeRevision(task) !== current.taskRevision))
          current = (yield* update(binding.projectId, current.id, row => resolvePlanningAttempt(row, "superseded", now)))!;
        else if (task.agreement?.status === "agreed" && task.agreement.agreedAt >= current.createdAt &&
          task.agreement.proposalId !== current.baselineAgreementId)
          current = (yield* update(binding.projectId, current.id, row => closePlanningTarget(row, binding.mainThreadId, now)))!;
      }
      // a child that appeared after the pause of its main is held the same way while the attempt is open; one that cannot be held is listed
      if (current.state === "open" && current.ownerThreadId === binding.threadId && current.targets.some(target => target.threadId === binding.mainThreadId)) {
        const listed = yield* attempt(native.listThreads());
        const scope = listed.ok ? resolveSupervisorScope(listed.value, binding.projectId, binding.mainThreadId, supervisors.ownedIds) : null;
        if (listed.ok && scope?.complete && scope.main) {
          const parents = new Map(listed.value.map(thread => [thread.id, thread.lineage.parentThreadId ?? null]));
          const late = yield* pausedDescendants(binding, scope, parents, [...current.targets.map(target => target.threadId), ...(current.uncovered ?? []).map(item => item.threadId)],
            current.reason, now);
          if (late.targets.length || late.uncovered.length) current = (yield* update(binding.projectId, current.id, row => addPlanningTargets(row, late.targets, late.uncovered, now)))!;
        }
      }
      for (const target of current.targets) {
        if (!planningTargetAwaited(target)) continue;
        const projection = yield* attempt(native.projection(target.threadId));
        const recipientProjection = target.recipientThreadId === target.threadId ? projection : yield* attempt(native.projection(target.recipientThreadId));
        current = (yield* currentAttempt(binding.projectId, selected.id))!;
        if (projection.ok) {
          for (const message of ownReplies(projection.value)) for (const fence of exactFenceRecords(message.text, "planning-pause-ack", 2, true)) {
            const parsed = Schema.decodeUnknownExit(PlanningAcknowledgement)(fence.value, {onExcessProperty: "error"});
            if (Exit.isSuccess(parsed) && message.runId) current = (yield* update(binding.projectId, current.id, row => acknowledgePlanningTarget(row,
              parsed.value, {sourceThreadId: target.threadId, messageId: message.id, runId: message.runId!, observedAt: now}, now)))!;
          }
          if (target.state === "requested" && !projectionHasOngoingWork(projection.value)) {
            const parent = target.recipientThreadId === target.threadId ? null : recipientProjection;
            const lifecycle = parent?.ok ? normalizeLifecycle(directParentChildLifecycle(parent.value, target.threadId)?.status)
              : delegatedLifecycle(projection.value.thread, projection.value);
            const dispatchHeld = target.recipientThreadId === target.threadId || current.targets.some(row => row.threadId === target.recipientThreadId &&
              (row.state === "acknowledged" || row.state === "closed"));
            const run = [...projection.value.runs].sort((left, right) => right.ordinal - left.ordinal)[0];
            const parentChild = parent?.ok ? directParentChildLifecycle(parent.value, target.threadId) : null;
            const terminalRunId = run && terminal.has(run.status) ? run.id : parentChild && parentChild.parentRunId !== null ? parentChild.parentRunId : null;
            if (dispatchHeld && (lifecycle.lifecycle === "completed" || lifecycle.lifecycle === "interrupted") && terminalRunId)
              current = (yield* update(binding.projectId, current.id, row => markPlanningTargetQuiescent(row, target.threadId, {runId: terminalRunId, observedAt: now}, now)))!;
          }
        }
        for (const kind of ["hold", "release"] as const) {
          const freshTarget = current.targets.find(row => row.threadId === target.threadId)!;
          const delivery = kind === "hold" ? freshTarget.hold : freshTarget.release;
          // a seen release releases its actor, even once sent; a hold already sent has nothing left to confirm
          if (delivery && (kind === "release" ? ["sending", "uncertain", "sent"] : ["sending", "uncertain"]).includes(delivery.state) && delivery.text && recipientProjection.ok &&
            recipientProjection.value.messages.some(message => message.id === delivery.messageId && message.text === delivery.text &&
              message.creationSource === "server"))
            current = (yield* update(binding.projectId, current.id, row => replaceDelivery(row, target.threadId, kind, {...delivery, state: "sent"}, true)))!;
        }
        const freshTarget = current.targets.find(row => row.threadId === target.threadId)!;
        if (current.state === "open" && planningWaitOpen(freshTarget)) yield* deliver(binding, current, freshTarget, "hold");
        if (freshTarget.state === "release_pending") yield* deliver(binding, current, freshTarget, "release");
      }
      const draft = current.draft;
      if (current.state === "open" && draft?.state === "working") {
        const child = yield* attempt(native.projection(draft.threadId));
        const parent = yield* attempt(native.projection(current.ownerThreadId));
        if (child.ok && parent.ok && child.value.thread.lineage.parentThreadId === current.ownerThreadId &&
          child.value.thread.lineage.relationshipToParent === "subagent") {
          const lifecycle = directParentChildLifecycle(parent.value, draft.threadId);
          const latestRun = [...child.value.runs].sort((left, right) => right.ordinal - left.ordinal)[0];
          const terminalStatus = lifecycle?.status ?? latestRun?.status;
          if (terminalStatus && terminal.has(terminalStatus) && !projectionHasOngoingWork(child.value)) {
            const reply = ownReplies(child.value).at(-1);
            current = (yield* update(binding.projectId, current.id, row => row.state === "open" && row.draft?.state === "working"
              ? {...row, draft: {...row.draft, state: terminalStatus === "completed" && reply ? "returned" : "failed",
                resultMessageId: reply?.id ?? null, resultRunId: reply?.runId ?? latestRun?.id ?? null,
                ownerNotice: planningDelivery(row.id, row.ownerThreadId, "draft"),
                ownerNoticeText: planningDraftNotice(row, terminalStatus === "completed" && reply ? {threadId: row.draft.threadId, messageId: reply.id,
                  readItemId: messageReadItemId(child.value, row.draft.threadId, reply.id)} : null)}} : row))!;
          }
        }
      }
      current = (yield* currentAttempt(binding.projectId, current.id))!;
      if (current.state === "open" && current.draft?.ownerNotice?.state === "prepared") yield* draftEffect(binding, current, "notice");
      if (current.state !== "open" && current.draft?.taskId) yield* cleanupDraft(binding, current);
    }
  });

  // expiry is independent of a busy owner or its ordinary check-in admission; native effects retain their own identities
  const deadlines = Effect.gen(function* () {
    const bindings = yield* supervisors.bindings();
    const now = yield* Clock.currentTimeMillis;
    const pendingMains = new Set<string>();
    const releases: Array<{binding: BindingRecord; row: PlanningAttempt; target: PlanningTarget}> = [];
    for (const projectId of new Set(bindings.map(binding => binding.projectId))) {
      const rows = yield* requests.planningAttempts(projectId);
      for (const row of rows) {
        if (planningHasUnresolvedEffects(row)) pendingMains.add(row.mainThreadId);
        const current = (row.state === "open" || row.state === "releasing") && now >= row.deadline
          ? (yield* update(projectId, row.id, current => expirePlanningAttempt(current, now)))! : row;
        const binding = bindings.find(binding => binding.projectId === projectId && binding.mainThreadId === row.mainThreadId);
        if (binding && current.state !== "open" && current.draft?.taskId && current.draft.cleanupConfirmedAt === undefined)
          yield* FiberMap.run(reconciliations, `draft-cleanup:${current.id}`, cleanupDraft(binding, current).pipe(Semaphore.withPermits(cleanupSlots, 1),
            Effect.catchCauseIf(cause => !Cause.hasInterruptsOnly(cause), () => Effect.void)), {onlyIfMissing: true});
        if (binding) for (const target of current.targets) if (target.state === "release_pending" && target.release?.state === "prepared")
          releases.push({binding, row: current, target});
      }
    }
    // releasing a hold never waits behind its original send or the owner's ordinary observation pass
    for (const release of releases) yield* FiberMap.run(reconciliations, release.target.release!.commandId,
      deliver(release.binding, release.row, release.target, "release").pipe(Semaphore.withPermits(releaseSlots, 1),
        Effect.catchCauseIf(cause => !Cause.hasInterruptsOnly(cause), () => Effect.void)), {onlyIfMissing: true});
    for (const binding of bindings) if (pendingMains.has(binding.mainThreadId))
      yield* FiberMap.run(reconciliations, binding.threadId,
        reconcile(binding).pipe(Semaphore.withPermits(observationSlots, 1), Effect.catchCauseIf(cause => !Cause.hasInterruptsOnly(cause), () => Effect.void)), {onlyIfMissing: true});
  }).pipe(Effect.catchCauseIf(cause => !Cause.hasInterruptsOnly(cause), () => Effect.void));
  yield* Effect.forkScoped(Effect.repeat(deadlines, Schedule.spaced("1 second")));
  return SupervisorPlanningController.of({call, reconcile});
});

export class SupervisorPlanningController extends Context.Service<SupervisorPlanningController, SupervisorPlanningControllerShape>()(
  "t3-supervisor/SupervisorPlanningController") {
  static readonly layer = Layer.effect(SupervisorPlanningController, make);
}
