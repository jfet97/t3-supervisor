import { engagedTask } from "./support/engaged-task.js";
import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Clock, Context, Deferred, Effect, Fiber, Layer } from "effect";
import { fingerprint } from "../src/guidance-store.js";
import { defaultSupervisorModel, type TaskRecord } from "../src/project-supervisor-store.js";
import { SupervisorPlanningController } from "../src/supervisor-planning-controller.js";
import { createPlanningAttempt } from "../src/supervisor-planning.js";
import type { NativeRpcShape } from "../src/supervisor-native.js";
import { ThreadPolicyStore } from "../src/thread-policy.js";
import { workflowToolNames } from "../src/workflow-write-evidence.js";
import {WorkflowStateStore} from "../src/workflow-state-store.js";
import {helperInstructions, helperInstructionsVersion} from "../src/supervisor-helper-instructions.js";
import {goldenSnapshot} from "./support/c1-workflow-fixture.js";
import {proposalContextFromDefinitions, validateWorkflowPlan} from "../src/supervisor-workflow.js";
import {planBranches, planEntities, withOccurrenceStatuses} from "../src/workflow-plan-tree.js";
import type {WorkflowProposalInfo} from "../src/project-supervisor-contract.js";
import type { Projection, ThreadInfo } from "../src/types.js";
import { policyLayer, supervisionStores, temporaryDirectory } from "./support/g11-stores.js";
import { teamControllers } from "./support/g11-team.js";

const fixture = (rpc?: NativeRpcShape) => Effect.gen(function* () {
  const directory = yield* temporaryDirectory("planning-controller-");
  const stores = yield* supervisionStores(directory);
  const policy = Context.get(yield* Layer.build(policyLayer({dataDirectory: directory, t3Url: "http://unused", t3TokenFile: "unused",
    excludedThreadIds: [], healthPort: 0})), ThreadPolicyStore);
  const binding = {...yield* stores.supervisors.reserve("project", "main", "main", defaultSupervisorModel, 1, 1), state: "ready" as const};
  yield* stores.supervisors.setBinding(binding);
  let task: TaskRecord = {id: "task-a", sourceHash: fingerprint("Update the application"), threadId: "main", projectId: "project", sourceRunId: "source-run",
    sourceMessageId: "request-a", status: "inferred", objective: "Update the application", reason: "Requested work", updatedAt: 0,
    requestText: "Update the application", supervisorThreadId: binding.threadId, messageId: "interpretation-a", dispatchedAt: null,
    replayCount: 0, supervisorRunId: null, sourceOrdinal: 1};
  yield* stores.supervisors.saveTask(task);
  const threads: ThreadInfo[] = [
    {id: "main", title: "Main", projectId: "project", lineage: {parentThreadId: null, relationshipToParent: null}, runtimeMode: "full-access", interactionMode: "default"},
    {id: binding.threadId, title: "Supervisor", projectId: "project", lineage: {parentThreadId: "main", relationshipToParent: "subagent"},
      runtimeMode: "full-access", interactionMode: "default"},
  ];
  const projections = new Map<string, Projection>(threads.map(thread => [thread.id, {thread, runs: [], nodes: [], messages: [], turnItems: [], runtimeRequests: []}]));
  projections.get("main")!.messages.push({id: "request-a", threadId: "main", runId: "source-run", nodeId: "source-node", role: "user", text: task.requestText,
    streaming: false, createdBy: "user", creationSource: "web", createdAt: "2026-10-27T12:00:00Z", updatedAt: "2026-10-27T12:00:00Z"});
  projections.get("main")!.runs.push({id: "source-run", threadId: "main", ordinal: 1, status: "completed", rootNodeId: "source-node", providerThreadId: "provider-main",
    requestedAt: "2026-10-27T12:00:00Z", startedAt: "2026-10-27T12:00:00Z", completedAt: "2026-10-27T12:01:00Z"});
  (projections.get("main")!.nodes as Record<string, unknown>[]).push({id: "source-node", kind: "root_turn", threadId: "main", runId: "source-run", rootNodeId: "source-node", providerThreadId: "provider-main", status: "completed"});
  task = engagedTask(task, projections.get("main")!);
  yield* stores.supervisors.saveTask(task);
  const details = new Map<string, unknown>();
  const built = yield* teamControllers(stores, policy, {listThreads: () => Effect.succeed(threads), projection: id => Effect.succeed(projections.get(id)!),
    turnItem: id => Effect.succeed(details.get(id))}, {rpc});
  const context = yield* Layer.build(SupervisorPlanningController.layer.pipe(Layer.provide(Layer.succeedContext(built.context))));
  const controller = Context.get(context, SupervisorPlanningController);
  const proof = (input: Record<string, unknown>) => {
    const root = projections.get(binding.threadId)!;
    const itemId = `planning-tool-${details.size}`;
    const runId = `caller-${itemId}`, rootNodeId = `root-${itemId}`, nodeId = `node-${itemId}`, providerThreadId = "provider-root";
    const detail = {id: itemId, type: "dynamic_tool", threadId: binding.threadId, runId, nodeId, providerThreadId,
      providerTurnId: `turn-${itemId}`, nativeItemRef: {driver: "codex", nativeId: itemId, strength: "strong"},
      parentItemId: null, ordinal: details.size + 1, status: "completed", toolNonExecutionKind: null,
      toolName: workflowToolNames.planning.direct[0], input};
    details.set(itemId, detail);
    root.runs.push({id: runId, threadId: binding.threadId, ordinal: root.runs.length + 1, status: "completed",
      requestedAt: "2026-10-27T12:00:00Z", startedAt: null, completedAt: null, rootNodeId, providerThreadId});
    (root.nodes as Record<string, unknown>[]).push({id: rootNodeId, kind: "root_turn", threadId: binding.threadId, runId, rootNodeId, providerThreadId, status: "completed"},
      {id: nodeId, kind: "dynamic_tool", threadId: binding.threadId, runId, rootNodeId, providerThreadId, parentNodeId: rootNodeId, status: "completed"});
    root.turnItems!.push({...detail, input: "snapshot-summary"});
  };
  const args = {supervisorThreadId: binding.threadId, bindingGeneration: binding.generation, taskId: task.id, taskRevision: task.sourceHash,
    action: "pause", operationId: "pause-a", targetThreadIds: ["main"], reason: "Prepare the requested plan"};
  return {stores, binding, task, threads, projections, controller, args, proof, workflows: built.workflows,
    states: Context.get(built.context, WorkflowStateStore)};
});

it.effect("a registering helper reads its own reference on demand without receiving root instructions", () => Effect.gen(function* () {
  const f = yield* fixture();
  const member = yield* f.stores.team.registerMember(f.binding, {threadId: "helper", taskId: "bootstrap", bootstrapRunId: "bootstrap-run", now: 1});
  const cancel = yield* Deferred.make<void>();
  const input = {supervisorThreadId: member.threadId, bindingGeneration: f.binding.generation, memberEpoch: member.epoch, view: "instructions"};
  const result = yield* f.workflows.readTool(input, cancel);
  assert.deepEqual(result, {status: "ok", view: "instructions", version: helperInstructionsVersion, instructions: helperInstructions});
  assert.doesNotMatch(helperInstructions, /Root team coordination|recruit or manage other helpers/u);
  assert.match(helperInstructions, /Do not perform operative work/u);
  assert.match(helperInstructions, /workflow_read supplies plans, lineage and status on demand/u);
  assert.equal((yield* f.workflows.readTool({...input, memberEpoch: member.epoch + 1}, cancel)).status, "denied");
  assert.notEqual((yield* f.workflows.readTool({...input, view: "context"}, cancel)).status, "ok", "registration grants reference reading only");
}));

it.effect("a planning pause needs its exact native owner call and preserves one identity on replay", () => Effect.gen(function* () {
  const f = yield* fixture();
  const unproven = (yield* f.controller.call(f.args)) as {status: string};
  assert.notEqual(unproven.status, "recorded");
  assert.deepEqual(yield* f.stores.requests.planningAttempts("project"), []);
  f.proof(f.args);
  const first = (yield* f.controller.call(f.args)) as {status: string; attempt?: {id: string; deadline: number}};
  assert.equal(first.status, "recorded");
  const replay = (yield* f.controller.call(f.args)) as typeof first;
  assert.deepEqual(replay.attempt?.id, first.attempt?.id);
  assert.equal(replay.attempt?.deadline, first.attempt?.deadline);
  assert.equal((yield* f.stores.requests.planningAttempts("project")).length, 1);
  const changed = {...f.args, reason: "A different pause under the same operation"};
  f.proof(changed);
  const conflict = (yield* f.controller.call(changed)) as {reason?: string};
  assert.equal(conflict.reason, "operation_id_conflict");
}));

it.live("the watchdog closes and releases a pause while its original native send is still awaiting a receipt", () => Effect.gen(function* () {
  const liveClock = yield* Clock.Clock;
  let clockNow = liveClock.currentTimeMillisUnsafe();
  yield* Effect.gen(function* () {
  const holdStarted = yield* Deferred.make<void>();
  const releaseStarted = yield* Deferred.make<void>();
  const holdReply = yield* Deferred.make<unknown>();
  const sent: Record<string, unknown>[] = [];
  const rpc: NativeRpcShape = {
    call: () => Effect.die(new Error("only admitted native initiation is allowed")),
    initiate: (_tag, payload) => Effect.gen(function* () {
      sent.push({...payload});
      const hold = String(payload.messageId).includes(":hold:");
      yield* Deferred.succeed(hold ? holdStarted : releaseStarted, undefined);
      return {sent: Effect.succeed(true), release: Effect.void,
        result: hold ? Deferred.await(holdReply) : Effect.succeed({sequence: 2})};
    }),
  };
  const f = yield* fixture(rpc);
  const now = yield* Clock.currentTimeMillis;
  const pause = createPlanningAttempt({id: "watchdog-pause", operationId: "watchdog-operation", projectId: "project", mainThreadId: "main",
    ownerThreadId: f.binding.threadId, bindingGeneration: f.binding.generation, taskId: f.task.id, taskRevision: f.task.sourceHash,
    reason: "Prepare the plan", createdAt: now, timeoutMs: 10_000,
    targets: [{threadId: "main", recipientThreadId: "main", scope: "implementation"}]});
  yield* f.stores.requests.savePlanningAttempt(pause);
  const originalSend = yield* Effect.forkChild(f.controller.reconcile(f.binding));
  yield* Effect.raceFirst(Deferred.await(holdStarted), Effect.andThen(Fiber.join(originalSend), Effect.die(new Error("reconcile finished without initiating its pause"))));
  clockNow += 10_000;
  yield* Deferred.await(releaseStarted);
  assert.equal(yield* Deferred.isDone(holdReply), false, "release is independent of the unresolved original send");
  const [expired] = yield* f.stores.requests.planningAttempts("project");
  assert.equal(expired?.state, "expired");
  assert.equal(expired?.deadline, pause.deadline);
  assert.match(String(sent.find(payload => String(payload.messageId).includes(":release:"))?.text), /Continue with your authorised task/);
  yield* Deferred.succeed(holdReply, {sequence: 1});
  yield* Fiber.join(originalSend);
  const [afterLateReceipt] = yield* f.stores.requests.planningAttempts("project");
  assert.equal(afterLateReceipt?.state, "expired");
  }).pipe(Effect.provideService(Clock.Clock, Object.assign(Object.create(liveClock) as Clock.Clock, {currentTimeMillisUnsafe: () => clockNow, currentTimeMillis: Effect.sync(() => clockNow)})));
}));


it.effect("a source-bound native pause observes the actor's own ACK and confirms its explicit release", () => Effect.gen(function* () {
  const sent: Record<string, unknown>[] = [];
  const rpc: NativeRpcShape = {call: () => Effect.die(new Error("admitted initiation only")), initiate: (_tag, payload) => {
    sent.push({...payload});
    return Effect.succeed({sent: Effect.succeed(true), release: Effect.void, result: Effect.succeed({sequence: sent.length})});
  }};
  const f = yield* fixture(rpc);
  f.proof(f.args);
  const result = (yield* f.controller.call(f.args)) as {attempt: {id: string}};
  yield* f.controller.reconcile(f.binding);
  const hold = sent.find(item => String(item.messageId).includes(":hold:"))!;
  assert.ok(hold, "the exact native source admits the actual hold send");
  const main = f.projections.get("main")!;
  main.messages.push({id: "actor-ack", threadId: "main", runId: "source-run", nodeId: "ack-node", role: "assistant", streaming: false,
    text: `\`\`\`planning-pause-ack\n${JSON.stringify({attemptId: result.attempt.id, targetThreadId: "main"})}\n\`\`\``, createdAt: "2026-10-27T12:01:01Z", updatedAt: "2026-10-27T12:01:01Z"});
  (main.nodes as Record<string, unknown>[]).push({id: "ack-node", kind: "assistant_message", threadId: "main", runId: "source-run", rootNodeId: "source-node", parentNodeId: "source-node", providerThreadId: "provider-main", status: "completed"});
  yield* f.controller.reconcile(f.binding);
  assert.equal((yield* f.stores.requests.planningAttempts("project"))[0]?.targets[0]?.state, "acknowledged");
  const release = {...f.args, action: "release", attemptId: result.attempt.id, operationId: "release-a", resolution: "continue"};
  delete (release as {targetThreadIds?: unknown}).targetThreadIds;
  f.proof(release);
  assert.equal(((yield* f.controller.call(release)) as {status: string}).status, "recorded");
  yield* f.controller.reconcile(f.binding);
  const notice = sent.find(item => String(item.messageId).includes(":release:"))!;
  assert.ok(notice);
  main.messages.push({id: String(notice.messageId), threadId: "main", runId: "source-run", nodeId: "source-node", role: "user", streaming: false,
    text: String(notice.text), creationSource: "server", createdBy: "system", createdAt: "2026-10-27T12:01:02Z", updatedAt: "2026-10-27T12:01:02Z"});
  yield* f.controller.reconcile(f.binding);
  assert.equal((yield* f.stores.requests.planningAttempts("project"))[0]?.state, "resolved");
  assert.equal(sent.length, 2, "one stable hold and one stable release");
}));

it.effect("an edited requester source cannot receive the earlier planning hold", () => Effect.gen(function* () {
  const sent: Record<string, unknown>[] = [];
  const rpc: NativeRpcShape = {call: () => Effect.die(new Error("admitted initiation only")), initiate: (_tag, payload) => {
    sent.push({...payload});return Effect.succeed({sent: Effect.succeed(true), release: Effect.void, result: Effect.succeed({sequence: 1})});
  }};
  const f = yield* fixture(rpc);
  f.proof(f.args);
  assert.equal(((yield* f.controller.call(f.args)) as {status: string}).status, "recorded");
  f.projections.get("main")!.messages[0]!.text = "Stop the task and discuss it instead.";
  yield* f.controller.reconcile(f.binding);
  assert.deepEqual(sent, []);
  assert.equal((yield* f.stores.requests.planningAttempts("project"))[0]?.targets[0]?.hold.attemptedAt, null);
}));

for (const execution of ["app_run", "native_turn", "unversioned_native"] as const)
it.effect(`a return requires the operative's real ACK and quiet ${execution} contributors, retires their work and replays once`, () => Effect.gen(function* () {
  const rpc: NativeRpcShape = {call: () => Effect.die(new Error("admitted initiation only")), initiate: () =>
    Effect.succeed({sent: Effect.succeed(true), release: Effect.void, result: Effect.succeed({sequence: 1})})};
  const f = yield* fixture(rpc);
  const now = yield* Clock.currentTimeMillis;
  const context = proposalContextFromDefinitions({...goldenSnapshot, projectId: "project", threadId: "main", steps: [], workflows: [], config: {steps: [], workflows: []}, projectConfig: {steps: [], workflows: []}});
  const local = (id: string) => ({kind: "step", definitionId: null, localId: id, name: id, description: `Complete ${id}.`, reason: `The request needs ${id}.`});
  const plan = validateWorkflowPlan({requirements: [], plan: {kind: "sequence", nodes: [local("work"), local("review"),
    {kind: "branch", condition: "Corrections are required.", reason: "Review determines the next work.", then: {kind: "sequence", nodes: [
      {kind: "back_to", target: "work", reason: "Correct the reviewed work."}]}}, local("deliver")]}}, context);
  assert.ok(plan?.plan);
  const proposal: WorkflowProposalInfo = {status: "proposed", message: "Complete the requested work.", workspaceRoot: "/work/project", revision: "revision-ready", globalRevision: null, ...plan};
  const agreement = {status: "agreed" as const, message: "Accepted.", proposalId: "proposal-a", agreedAt: now,
    evidence: {kind: "supervisor_message" as const, messageId: "proposal-message"}, agentMessageId: "acceptance-message", workflow: proposal};
  yield* f.stores.supervisors.saveTask({...f.task, agreement, workflow: proposal});
  const owner = {projectId: "project", mainThreadId: "main", supervisorThreadId: f.binding.threadId, bindingGeneration: f.binding.generation};
  assert.equal((yield* f.states.importAcceptedAgreement(owner, {taskId: f.task.id, sourceThreadId: "main", sourceRunId: "source-run",
    sourceMessageId: "request-a", sourceHash: f.task.sourceHash, objective: f.task.objective!, agreement}, now)).status, "applied");
  let document = (yield* f.states.get("project", "main"))!;
  const changed = planEntities(document.plan).filter(node => node.kind === "step" && node.localId !== "deliver");
  const progress = withOccurrenceStatuses(document.plan!, changed.map(node => ({nodeId: node.nodeId, status: "completed" as const})));
  assert.ok("plan" in progress);
  const progressed = progress.plan;
  progressed.nodes = progressed.nodes.map(node => node.kind === "step" && node.localId === "review" ? {...node, contributorThreadIds: ["reviewer"]} : node);
  const advanced = yield* f.states.apply(owner, {operationId: "initial-progress", workflowId: document.workflowId, expectedRevision: document.revision,
    status: "underway", objective: document.objective, sourceBinding: document.sourceBinding!, requirements: [], issues: [], plan: progressed, note: "The first pass returned findings.",
    evidence: [{kind: "status_changed", targetNodeId: null, note: "The task is underway."}, ...changed.map(node => ({kind: "status_changed" as const, targetNodeId: node.nodeId, note: "This pass completed."}))]},
  {pinnedContext: context, originalProposal: proposal, expectedTaskId: f.task.id, expectedProposalId: "proposal-a", expectedSourceHash: f.task.sourceHash,
    acceptedTaskAgreement: null, acceptedTaskAgreementSourceHash: null}, now + 1);
  assert.equal(advanced.status, "applied", JSON.stringify(advanced));
  document = (yield* f.states.get("project", "main"))!;
  assert.equal((yield* f.states.recordBranchSelection(owner, {nodeId: planBranches(document.plan)[0]!.nodeId, revision: 1, path: "then",
    reason: "The report requires corrections.", sourceThreadId: "main", sourceRunId: "source-run", sourceMessageId: "decision-message", sourceCreatedAt: now + 2}, now + 2)).status, "applied");
  document = (yield* f.states.get("project", "main"))!;
  assert.equal(document.returns.length, 1);
  const child: ThreadInfo = {id: "reviewer", title: "Reviewer", projectId: "project", creationSource: execution === "app_run" ? "mcp" : "provider",
    lineage: {parentThreadId: "main", relationshipToParent: "subagent"}, runtimeMode: "full-access", interactionMode: "default"};
  f.threads.push(child);
  const childRun = {id: "old-review-run", ordinal: 1, status: "running", requestedAt: new Date(now).toISOString(), startedAt: new Date(now).toISOString(), completedAt: null, rootNodeId: null};
  const nativeTurn = {id: "old-native-turn", providerThreadId: "provider-reviewer", nodeId: "native-review-root", status: "running",
    startedAt: new Date(now).toISOString(), nativeTurnRef: {driver: "codex", nativeId: "native-turn-1", strength: "strong"}};
  const lifecycle = {id: "native-review-task", childThreadId: child.id, origin: "provider_native", providerThreadId: "provider-reviewer", status: "running"};
  f.projections.set(child.id, {thread: child, runs: execution === "app_run" ? [childRun] : [], nodes: execution === "native_turn" ? [{id: nativeTurn.nodeId,
    threadId: child.id, providerThreadId: nativeTurn.providerThreadId, providerTurnId: nativeTurn.id}] : [],
    providerTurns: execution === "native_turn" ? [nativeTurn] : [], messages: [], turnItems: [], runtimeRequests: []});
  if (execution !== "app_run") f.projections.get("main")!.subagents = [lifecycle];
  f.proof(f.args);
  const paused = (yield* f.controller.call(f.args)) as {attempt: {id: string}};
  const input = {...f.args, action: "apply_return", operationId: "return-a", attemptId: paused.attempt.id, workflowId: document.workflowId,
    expectedRevision: document.revision, returnId: document.returns[0]!.returnId, reason: "Apply the chosen return."};
  delete (input as {targetThreadIds?: unknown}).targetThreadIds;
  f.proof(input);
  assert.equal(((yield* f.controller.call(input)) as {reason: string}).reason, "return_owner_not_paused");
  yield* f.controller.reconcile(f.binding);
  const main = f.projections.get("main")!;
  main.messages.push({id: "return-ack", threadId: "main", runId: "source-run", nodeId: "return-ack-node", role: "assistant", streaming: false,
    text: `\`\`\`planning-pause-ack\n${JSON.stringify({attemptId: paused.attempt.id, targetThreadId: "main"})}\n\`\`\``, createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString()});
  (main.nodes as Record<string, unknown>[]).push({id: "return-ack-node", kind: "assistant_message", threadId: "main", runId: "source-run", rootNodeId: "source-node", parentNodeId: "source-node", providerThreadId: "provider-main", status: "completed"});
  yield* f.controller.reconcile(f.binding);
  assert.equal(((yield* f.controller.call(input)) as {reason: string}).reason, "return_actor_not_quiescent", "a parent ACK cannot pause a running reviewer");
  if (execution === "native_turn") {
    nativeTurn.nativeTurnRef.strength = "weak";
    assert.equal(((yield* f.controller.call(input)) as {reason: string}).reason, "return_actor_not_quiescent", "a weakly identified running turn still prevents quiescence");
    nativeTurn.nativeTurnRef.strength = "strong";
    nativeTurn.status = "completed";
    assert.equal(((yield* f.controller.call(input)) as {reason: string}).reason, "return_actor_not_quiescent", "a completed turn cannot override a still-running parent lifecycle");
  }
  childRun.status = "completed";
  lifecycle.status = "completed";
  for (const status of ["queued", "preparing", "starting", "running", "waiting"]) {
    const newerRun = {...main.runs[0]!, id: `post-ack-${status}`, ordinal: 2, status, startedAt: null, completedAt: null, rootNodeId: null};
    main.runs.push(newerRun);
    assert.equal(((yield* f.controller.call(input)) as {reason: string}).reason, "return_actor_changed_run", `an ACK cannot cover newly ${status} operative work`);
    main.runs.pop();
  }
  if (execution === "app_run") f.projections.get("reviewer")!.runs.unshift({...childRun, id: "earlier-review-run", ordinal: 0});
  main.providerTurns = [{...nativeTurn, id: "post-ack-native-turn", status: "pending", nativeTurnRef: {...nativeTurn.nativeTurnRef, strength: "weak"}}];
  assert.equal(((yield* f.controller.call(input)) as {reason: string}).reason, "return_actor_not_quiescent", "an ACK does not settle weakly identified pending native work");
  delete main.providerTurns;
  main.runs[0]!.status = "waiting";
  main.thread.activeRunId = "source-run";
  const result = yield* f.controller.call(input);
  assert.equal((result as {status: string}).status, "applied");
  const returned = (yield* f.states.get("project", "main"))!;
  assert.deepEqual(returned.returns[0]!.retiredRuns, execution === "app_run" ? [{kind: "run", threadId: "reviewer", runId: "earlier-review-run"}, {kind: "run", threadId: "reviewer", runId: "old-review-run"}]
    : execution === "native_turn" ? [{kind: "provider_turns", threadId: "reviewer", providerThreadId: "provider-reviewer", providerTurnIds: [nativeTurn.id]}]
      : [{kind: "thread", threadId: "reviewer", reason: "No published per-execution identity; replace this reviewer and carry forward its findings."}]);
  assert.deepEqual(returned.sourceBinding, document.sourceBinding);
  assert.equal(returned.currentAgreementKey, document.currentAgreementKey);
  if (execution === "app_run") {
    const review = planEntities(returned.plan).find(node => node.kind === "step" && node.localId === "review")!;
    const next = withOccurrenceStatuses(returned.plan!, [{nodeId: review.nodeId, status: "completed"}]);
    assert.ok("plan" in next);
    const stale = yield* f.states.apply(owner, {operationId: "old-earlier-review-report", workflowId: returned.workflowId, expectedRevision: returned.revision,
      status: "underway", objective: returned.objective, sourceBinding: returned.sourceBinding!, requirements: [], issues: [], plan: next.plan, note: "An earlier run claims the repeated review is complete.",
      evidence: [{kind: "status_changed", targetNodeId: review.nodeId, note: "An old review result.", sourceThreadId: "reviewer", sourceRunId: "earlier-review-run"}]},
    {pinnedContext: context, originalProposal: proposal, expectedTaskId: f.task.id, expectedProposalId: "proposal-a", expectedSourceHash: f.task.sourceHash,
      acceptedTaskAgreement: null, acceptedTaskAgreementSourceHash: null}, now + 3);
    assert.ok(stale.status === "invalid", JSON.stringify(stale));
    assert.equal(stale.reason, "retired_run_evidence");
  }
  assert.deepEqual(yield* f.controller.call(input), result, "identical retry returns the original receipt");
  assert.equal((yield* f.states.get("project", "main"))!.revision, returned.revision);
}));

it.effect("one new drafting task returns quietly to its owner and is cleaned up when its attempt ends", () => Effect.gen(function* () {
  const sent: Record<string, unknown>[] = [];
  const rpc: NativeRpcShape = {call: () => Effect.die(new Error("admitted initiation only")), initiate: (_tag, payload) => {
    sent.push({...payload});return Effect.succeed({sent: Effect.succeed(true), release: Effect.void, result: Effect.succeed({sequence: sent.length})});
  }};
  const f = yield* fixture(rpc);
  const now = yield* Clock.currentTimeMillis;
  f.proof(f.args);
  const paused = (yield* f.controller.call(f.args)) as {attempt: {id: string}};
  const child: ThreadInfo = {id: "writer", title: "Planning writer", projectId: "project", lineage: {parentThreadId: f.binding.threadId, relationshipToParent: "subagent"}, runtimeMode: "full-access", interactionMode: "default"};
  f.threads.push(child);
  const record = {id: "draft-task", childThreadId: child.id, origin: "app_owned", status: "completed", startedAt: new Date(now - 1).toISOString()};
  f.projections.get(f.binding.threadId)!.subagents = [record];
  f.projections.set(child.id, {thread: child, runs: [{id: "draft-run", threadId: child.id, ordinal: 1, status: "completed", requestedAt: new Date(now).toISOString(),
    startedAt: new Date(now).toISOString(), completedAt: new Date(now).toISOString(), rootNodeId: "draft-root", providerThreadId: "provider-writer"}],
    nodes: [{id: "draft-root", kind: "root_turn", threadId: child.id, runId: "draft-run", rootNodeId: "draft-root", providerThreadId: "provider-writer", status: "completed"},
      {id: "draft-answer", kind: "assistant_message", threadId: child.id, runId: "draft-run", rootNodeId: "draft-root", parentNodeId: "draft-root", providerThreadId: "provider-writer", status: "completed"}],
    messages: [{id: "draft-content", threadId: child.id, runId: "draft-run", nodeId: "draft-answer", role: "assistant", text: "A read-only draft for the owner to assess.", streaming: false,
      createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString()}], turnItems: [], runtimeRequests: []});
  const input = {...f.args, action: "attach_draft", operationId: "attach-a", attemptId: paused.attempt.id, draftThreadId: child.id, draftTaskId: record.id};
  delete (input as {targetThreadIds?: unknown}).targetThreadIds;
  f.proof(input);
  assert.equal(((yield* f.controller.call(input)) as {reason: string}).reason, "planning_draft_not_new_for_attempt");
  record.startedAt = new Date(now).toISOString();
  assert.equal(((yield* f.controller.call(input)) as {status: string}).status, "recorded");
  yield* f.controller.reconcile(f.binding);
  const ready = (yield* f.stores.requests.planningAttempts("project"))[0]!;
  assert.equal(ready.draft?.state, "returned");
  assert.equal(ready.draft?.resultMessageId, "draft-content");
  const notice = sent.find(command => command.threadId === f.binding.threadId)!;
  assert.deepEqual(notice.dispatchMode, {type: "queue_after_active"}, "the draft never steers the owner's thinking");
  const release = {...f.args, action: "release", operationId: "release-draft", attemptId: paused.attempt.id, resolution: "no_plan"};
  delete (release as {targetThreadIds?: unknown}).targetThreadIds;
  f.proof(release);
  assert.equal(((yield* f.controller.call(release)) as {status: string}).status, "recorded");
  yield* f.controller.reconcile(f.binding);
  const cleanup = sent.filter(command => command.type !== "message.dispatch");
  assert.deepEqual(cleanup.map(command => command.type), ["thread.stop", "delegated_task.completion-delivery.dispose"]);
  assert.ok(cleanup.every(command => command.threadId === "writer" || command.taskId === "draft-task"));
  assert.equal((yield* f.stores.requests.planningAttempts("project"))[0]!.draft?.cleanupConfirmedAt, now);
  yield* f.controller.reconcile(f.binding);
  assert.equal(sent.filter(command => command.type !== "message.dispatch").length, 2, "confirmed cleanup is not posted twice");
}));
