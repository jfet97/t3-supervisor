import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Clock, Deferred, type Duration, Effect, Exit, Fiber, FiberMap, Option, Queue, Schedule } from "effect";
import { vi } from "vitest";
import { within as bounded } from "./support/g1b-conversation.js";
import { TestClock } from "effect/testing";
import { fingerprint } from "../src/guidance-store.js";
import { createPlanningAttempt, planningCanAdopt, planningDraftInstruction, planningHoldText, planningReleaseText, resolvePlanningAttempt, startPlanningAttempt } from "../src/supervisor-planning.js";
import type { NativeRpcShape } from "../src/supervisor-native.js";
import {helperInstructions, helperInstructionsVersion} from "../src/supervisor-helper-instructions.js";
import {goldenSnapshot} from "./support/c1-workflow-fixture.js";
import {proposalContextFromDefinitions, validateWorkflowPlan} from "../src/supervisor-workflow.js";
import {planBackTos, planBranches, planEntities, returnBudgetUsed, withOccurrenceStatuses} from "../src/workflow-plan-tree.js";
import type {WorkflowProposalInfo} from "../src/project-supervisor-contract.js";
import type { ThreadInfo } from "../src/types.js";
import { planningFixture as fixture, type PlanningReadFailures } from "./support/planning-fixture.js";

// a mutable namespace copy permits a scoped observer of the real watchdog fibers; every Effect implementation stays unchanged.
vi.mock("effect", async importOriginal => {
  const actual = await importOriginal<typeof import("effect")>();
  return {...actual, FiberMap: {...actual.FiberMap}};
});

type Answer = {status: string; reason?: string; attempt: {attemptId: string; deadline: string; draftInstruction?: string}};

it.effect("a registering helper reads its own reference on demand without receiving root instructions", () => Effect.gen(function* () {
  const f = yield* fixture();
  const member = yield* f.stores.team.registerMember(f.binding, {threadId: "helper", taskId: "bootstrap", bootstrapRunId: "bootstrap-run", now: 1});
  const cancel = yield* Deferred.make<void>();
  const input = {supervisorThreadId: member.threadId, bindingGeneration: f.binding.generation, memberEpoch: member.epoch, view: "instructions"};
  const result = yield* f.workflows.readTool(input, cancel);
  assert.deepEqual(result, {status: "ok", view: "instructions", version: helperInstructionsVersion, instructions: helperInstructions});
  assert.equal((yield* f.workflows.readTool({...input, memberEpoch: member.epoch + 1}, cancel)).status, "denied");
  assert.notEqual((yield* f.workflows.readTool({...input, view: "context"}, cancel)).status, "ok", "registration grants reference reading only");
  // the root's frozen check-in envelope is the root's own: a registering helper's authority does not read it
  const request = yield* f.stores.requests.prepare({projectId: "project", supervisorThreadId: f.binding.threadId, kind: "review", taskId: null, text: "Check-in", batch: null,
    completionMarker: "Supervisor check-in monitor:1 completed", envelope: {threads: []}}, 1);
  assert.equal((yield* f.workflows.readTool({...input, view: "request", requestId: request.id}, cancel)).status, "denied");
}));

it.effect("a ready helper reads only its own check-in's frozen rows with view request; the root's request is not owned and an unknown id is unavailable", () => Effect.gen(function* () {
  const f = yield* fixture();
  const registered = yield* f.stores.team.registerMember(f.binding, {threadId: "helper", taskId: "bootstrap", bootstrapRunId: "bootstrap-run", now: 1});
  const member = yield* f.stores.team.markReady(f.binding, registered.threadId, registered.epoch);
  const cancel = yield* Deferred.make<void>();
  const authority = {supervisorThreadId: member.threadId, bindingGeneration: f.binding.generation, memberEpoch: member.epoch};
  const rows = {targets: [{threadId: "main", assignmentRootThreadId: "main", assignmentEpoch: 1, pending: 2, refs: [{sourceItemId: "turn-item:1"}]}], notifications: []};
  const own = yield* f.stores.requests.prepare({id: "team-review:own", projectId: "project", supervisorThreadId: member.threadId, kind: "review", taskId: null,
    text: "Helper check-in", batch: null, completionMarker: "Supervisor team check-in team-review:own completed", teamMemberEpoch: member.epoch, envelope: rows}, 1);
  const root = yield* f.stores.requests.prepare({projectId: "project", supervisorThreadId: f.binding.threadId, kind: "review", taskId: null, text: "Check-in", batch: null,
    completionMarker: "Supervisor check-in monitor:1 completed", envelope: {threads: []}}, 2);
  const read = (yield* f.reader.readTool({...authority, view: "request", requestId: own.id}, cancel)) as unknown as {status: string; view: string; request: Record<string, unknown>; envelope: unknown};
  assert.deepEqual([read.status, read.view, read.request.requestId, read.request.kind, read.envelope], ["ok", "request", own.id, "review", rows]);
  assert.deepEqual(yield* f.reader.readTool({...authority, view: "request", requestId: root.id}, cancel), {status: "denied", view: "request", reason: "request_not_owned"});
  assert.deepEqual(yield* f.reader.readTool({...authority, view: "request", requestId: "00000000-0000-4000-8000-000000000000"}, cancel), {status: "unavailable", view: "request", reason: "request_unknown"});
  // a stale epoch reads nothing, and the root reads its own request but not the helper's
  assert.equal((yield* f.reader.readTool({...authority, memberEpoch: member.epoch + 1, view: "request", requestId: own.id}, cancel)).status, "denied");
  const rootAuthority = {supervisorThreadId: f.binding.threadId, bindingGeneration: f.binding.generation};
  assert.equal(((yield* f.reader.readTool({...rootAuthority, view: "request", requestId: root.id}, cancel)) as {status: string}).status, "ok");
  assert.deepEqual(yield* f.reader.readTool({...rootAuthority, view: "request", requestId: own.id}, cancel), {status: "denied", view: "request", reason: "request_not_owned"});
}));

it.effect("a planning pause needs its exact native owner call and preserves one identity on replay", () => Effect.gen(function* () {
  const f = yield* fixture();
  const unproven = (yield* f.controller.call(f.args)) as {status: string};
  assert.notEqual(unproven.status, "recorded");
  assert.deepEqual(yield* f.stores.requests.planningAttempts("project"), []);
  f.proof(f.args);
  const first = (yield* f.controller.call(f.args)) as Answer;
  assert.equal(first.status, "recorded");
  const [stored] = yield* f.stores.requests.planningAttempts("project");
  assert.ok(stored);
  // the owner sees the attempt's states and its drafter's task; delivery identities, texts and hashes stay stored
  assert.deepEqual(first.attempt, {attemptId: stored.id, state: "open", deadline: new Date(stored.deadline).toISOString(), resolution: null,
    targets: [{threadId: "main", state: "requested", ack: null}], uncovered: [], scopeUnavailable: false, draft: null, draftInstruction: planningDraftInstruction(stored)});
  for (const hidden of [stored.targets[0]!.hold.messageId, stored.targets[0]!.hold.commandId, stored.requestHash!])
    assert.ok(!JSON.stringify(first).includes(hidden), hidden);
  const replay = (yield* f.controller.call(f.args)) as Answer;
  assert.deepEqual(replay, first, "an identical retry answers the original attempt");
  assert.equal((yield* f.stores.requests.planningAttempts("project")).length, 1);
  const changed = {...f.args, reason: "A different pause under the same operation"};
  f.proof(changed);
  const conflict = (yield* f.controller.call(changed)) as {reason?: string};
  assert.equal(conflict.reason, "operation_id_conflict");
  // an explicit read shows the drafter's task again while no drafter is attached; other answers never repeat it
  const read = {...f.args, action: "read"};
  delete (read as {operationId?: unknown}).operationId;
  delete (read as {targetThreadIds?: unknown}).targetThreadIds;
  delete (read as {reason?: unknown}).reason;
  f.proof(read);
  assert.deepEqual(yield* f.controller.call(read), {status: "ready", attempts: [first.attempt]});
  const release = {...f.args, action: "release", operationId: "release-a", attemptId: stored.id, resolution: "no_plan"};
  delete (release as {targetThreadIds?: unknown}).targetThreadIds;
  f.proof(release);
  const released = (yield* f.controller.call(release)) as Answer;
  assert.equal(released.status, "recorded");
  assert.equal(released.attempt.draftInstruction, undefined);
  assert.deepEqual(Object.keys(released.attempt), ["attemptId", "state", "deadline", "resolution", "targets", "uncovered", "scopeUnavailable", "draft"]);
  f.proof(read);
  assert.equal(((yield* f.controller.call(read)) as {attempts: Answer["attempt"][]}).attempts[0]!.draftInstruction, undefined, "a released attempt offers no drafter");
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
  assert.equal(String(sent.find(payload => String(payload.messageId).includes(":release:"))?.text),
    "Planning pause watchdog-pause released (deadline passed). Continue your authorised task; human Stops and limits still apply.");
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
  const result = (yield* f.controller.call(f.args)) as Answer;
  yield* f.controller.reconcile(f.binding);
  const hold = sent.find(item => String(item.messageId).includes(":hold:"))!;
  assert.ok(hold, "the exact native source admits the actual hold send");
  const [anchored] = yield* f.stores.requests.planningAttempts("project");
  assert.equal(hold.text, planningHoldText(anchored!, anchored!.targets[0]!));
  assert.equal(anchored!.targets[0]!.hold.text, hold.text, "the stored bytes are the sent bytes");
  assert.ok(String(hold.text).includes(`\n\`\`\`planning-pause-ack\n${JSON.stringify({attemptId: result.attempt.attemptId, targetThreadId: "main"})}\n\`\`\`\n`));
  const main = f.projections.get("main")!;
  main.messages.push({id: "actor-ack", threadId: "main", runId: "source-run", nodeId: "ack-node", role: "assistant", streaming: false,
    text: `\`\`\`planning-pause-ack\n${JSON.stringify({attemptId: result.attempt.attemptId, targetThreadId: "main"})}\n\`\`\``, createdAt: "2026-10-27T12:01:01Z", updatedAt: "2026-10-27T12:01:01Z"});
  (main.nodes as Record<string, unknown>[]).push({id: "ack-node", kind: "assistant_message", threadId: "main", runId: "source-run", rootNodeId: "source-node", parentNodeId: "source-node", providerThreadId: "provider-main", status: "completed"});
  yield* f.controller.reconcile(f.binding);
  assert.equal((yield* f.stores.requests.planningAttempts("project"))[0]?.targets[0]?.state, "acknowledged");
  const release = {...f.args, action: "release", attemptId: result.attempt.attemptId, operationId: "release-a", resolution: "continue"};
  delete (release as {targetThreadIds?: unknown}).targetThreadIds;
  f.proof(release);
  assert.equal(((yield* f.controller.call(release)) as {status: string}).status, "recorded");
  yield* f.controller.reconcile(f.binding);
  const notice = sent.find(item => String(item.messageId).includes(":release:"))!;
  // the fixture task has no proposal yet: planning resolved releases the pause but grants no implementation permission
  assert.equal(notice.text, `Planning pause ${result.attempt.attemptId} released (planning resolved). This release grants no implementation permission: no workflow proposal is agreed yet; agree the one your Supervisor sends before implementing; a record sent to your Supervisor or relayed by another chat records nothing. Evidence gathering may continue; human Stops and limits still apply.`);
  main.messages.push({id: String(notice.messageId), threadId: "main", runId: "source-run", nodeId: "source-node", role: "user", streaming: false,
    text: String(notice.text), creationSource: "server", createdBy: "system", createdAt: "2026-10-27T12:01:02Z", updatedAt: "2026-10-27T12:01:02Z"});
  yield* f.controller.reconcile(f.binding);
  assert.equal((yield* f.stores.requests.planningAttempts("project"))[0]?.state, "resolved");
  assert.equal(sent.length, 2, "one stable hold and one stable release");
}));

type PausedAnswer = Answer & {attempt: {targets: Array<{threadId: string; state: string}>; uncovered: Array<{threadId: string; reason: string}>; scopeUnavailable: boolean}};
const acknowledgingRpc = (sent: Record<string, unknown>[]): NativeRpcShape => ({call: () => Effect.die(new Error("admitted initiation only")), initiate: (_tag, payload) => {
  sent.push({...payload});
  return Effect.succeed({sent: Effect.succeed(true), release: Effect.void, result: Effect.succeed({sequence: sent.length})});
}});
// a native child of the fixture main whose execution is a provider turn the main reports as a subagent record with its parent run
const nativeChild = (f: Effect.Success<ReturnType<typeof fixture>>, id: string, running: boolean, now: number): ThreadInfo => {
  const child: ThreadInfo = {id, title: id, projectId: "project", creationSource: "provider", lineage: {parentThreadId: "main", relationshipToParent: "subagent"},
    runtimeMode: "full-access", interactionMode: "default"};
  f.threads.push(child);
  const turn = {id: `${id}-turn`, providerThreadId: `provider-${id}`, nodeId: `${id}-root`, status: running ? "running" : "completed", startedAt: new Date(now).toISOString(),
    completedAt: running ? null : new Date(now).toISOString(), nativeTurnRef: {driver: "codex", nativeId: `native-${id}`, strength: "strong"}};
  f.projections.set(id, {thread: child, runs: [], nodes: [{id: turn.nodeId, threadId: id, providerThreadId: turn.providerThreadId, providerTurnId: turn.id}], providerTurns: [turn],
    messages: [], turnItems: [], runtimeRequests: []});
  const main = f.projections.get("main")!;
  main.subagents = [...(main.subagents ?? []), {id: `${id}-task`, childThreadId: id, origin: "provider_native", providerThreadId: `provider-${id}`, runId: "source-run", status: running ? "running" : "completed"}];
  return child;
};
const finishChild = (f: Effect.Success<ReturnType<typeof fixture>>, id: string, now: number) => {
  const projection = f.projections.get(id)!;
  for (const turn of projection.providerTurns as Record<string, unknown>[]) {turn.status = "completed"; turn.completedAt = new Date(now).toISOString();}
  for (const record of f.projections.get("main")!.subagents as Record<string, unknown>[]) if (record.childThreadId === id) record.status = "completed";
};
const restartChild = (f: Effect.Success<ReturnType<typeof fixture>>, id: string, now: number) => {
  const projection = f.projections.get(id)!;
  const turns = projection.providerTurns as Record<string, unknown>[];
  turns.push({id: `${id}-turn-${turns.length + 1}`, providerThreadId: `provider-${id}`, nodeId: `${id}-root`, status: "running",
    startedAt: new Date(now).toISOString(), completedAt: null, nativeTurnRef: {driver: "codex", nativeId: `native-${id}-${turns.length + 1}`, strength: "strong"}});
  for (const record of f.projections.get("main")!.subagents as Record<string, unknown>[]) if (record.childThreadId === id) record.status = "running";
};
// a child's own completed reply carrying the attempt's ACK record for itself
const acknowledgeChild = (f: Effect.Success<ReturnType<typeof fixture>>, attemptId: string, id: string) => {
  const projection = f.projections.get(id)!;
  projection.runs = [{id: `${id}-run`, ordinal: 1, status: "completed", requestedAt: "2026-10-27T12:00:00Z", startedAt: "2026-10-27T12:00:00Z", completedAt: "2026-10-27T12:01:00Z",
    rootNodeId: `${id}-root-node`, threadId: id, providerThreadId: `provider-${id}`}];
  (projection.nodes as Record<string, unknown>[]).push(
    {id: `${id}-root-node`, kind: "root_turn", threadId: id, runId: `${id}-run`, rootNodeId: `${id}-root-node`, parentNodeId: null, providerThreadId: `provider-${id}`, status: "completed"},
    {id: `${id}-ack-node`, kind: "assistant_message", threadId: id, runId: `${id}-run`, rootNodeId: `${id}-root-node`, parentNodeId: `${id}-root-node`, providerThreadId: `provider-${id}`, status: "completed"});
  projection.messages.push({id: `${id}-ack`, threadId: id, runId: `${id}-run`, nodeId: `${id}-ack-node`, role: "assistant", streaming: false,
    text: `\`\`\`planning-pause-ack\n${JSON.stringify({attemptId, targetThreadId: id})}\n\`\`\``, createdAt: "2026-10-27T12:01:01Z", updatedAt: "2026-10-27T12:01:01Z"});
};
const acknowledgeMain = (f: Effect.Success<ReturnType<typeof fixture>>, attemptId: string) => {
  const main = f.projections.get("main")!;
  main.messages.push({id: "actor-ack", threadId: "main", runId: "source-run", nodeId: "ack-node", role: "assistant", streaming: false,
    text: `\`\`\`planning-pause-ack\n${JSON.stringify({attemptId, targetThreadId: "main"})}\n\`\`\``, createdAt: "2026-10-27T12:01:01Z", updatedAt: "2026-10-27T12:01:01Z"});
  (main.nodes as Record<string, unknown>[]).push({id: "ack-node", kind: "assistant_message", threadId: "main", runId: "source-run", rootNodeId: "source-node", parentNodeId: "source-node", providerThreadId: "provider-main", status: "completed"});
};

it.effect("a paused main holds its live native descendants through their parent, including a late one; a parent ACK never counts for a child, whose own terminal lifecycle makes it quiescent", () => Effect.gen(function* () {
  const sent: Record<string, unknown>[] = [];
  const f = yield* fixture(acknowledgingRpc(sent));
  const now = yield* Clock.currentTimeMillis;
  nativeChild(f, "busy-child", true, now);
  nativeChild(f, "idle-child", false, now);
  f.proof(f.args);
  const result = (yield* f.controller.call(f.args)) as PausedAnswer;
  assert.equal(result.status, "recorded", JSON.stringify(result));
  assert.deepEqual(result.attempt.targets.map(target => target.threadId).sort(), ["busy-child", "main"], "the child with ongoing work is held, the idle one is not");
  assert.deepEqual(result.attempt.uncovered, []);
  yield* f.controller.reconcile(f.binding);
  const [attempt] = yield* f.stores.requests.planningAttempts("project");
  const childTarget = attempt!.targets.find(target => target.threadId === "busy-child");
  assert.ok(childTarget);
  assert.equal(childTarget.recipientThreadId, "main", "a native child is held through its parent's dispatch");
  assert.equal(childTarget.hold.text, planningHoldText(attempt!, childTarget));
  assert.match(childTarget.hold.text ?? "", /Hold dispatch for child busy-child/);
  // a child that appears after the pause is held on the next pass; the parent's ACK leaves both children requested
  nativeChild(f, "late-child", true, now);
  acknowledgeMain(f, result.attempt.attemptId);
  yield* f.controller.reconcile(f.binding);
  const [withLate] = yield* f.stores.requests.planningAttempts("project");
  assert.deepEqual(withLate!.targets.map(target => [target.threadId, target.state]).sort(), [["busy-child", "requested"], ["late-child", "requested"], ["main", "acknowledged"]]);
  assert.equal(planningCanAdopt(withLate!, yield* Clock.currentTimeMillis), false);
  const release = {...f.args, action: "release", attemptId: result.attempt.attemptId, operationId: "release-early", resolution: "continue"};
  delete (release as {targetThreadIds?: unknown}).targetThreadIds;
  f.proof(release);
  assert.deepEqual(yield* f.controller.call(release), {status: "denied", reason: "planning_acks_incomplete"});
  // the children's own terminal lifecycle, with the parent's dispatch held, makes them quiescent
  finishChild(f, "busy-child", now + 1);
  finishChild(f, "late-child", now + 1);
  yield* f.controller.reconcile(f.binding);
  const [quiet] = yield* f.stores.requests.planningAttempts("project");
  assert.deepEqual(quiet!.targets.filter(target => target.threadId !== "main").map(target => target.state), ["quiescent", "quiescent"]);
  assert.equal(planningCanAdopt(quiet!, yield* Clock.currentTimeMillis), true);
  // adoption establishes quiet freshly: a child with work again is awaited again, not adopted on its earlier reading
  restartChild(f, "busy-child", now + 2);
  f.proof({...release, operationId: "release-restarted"});
  assert.deepEqual(yield* f.controller.call({...release, operationId: "release-restarted"}), {status: "denied", reason: "planning_acks_incomplete"});
  const [awaited] = yield* f.stores.requests.planningAttempts("project");
  const restarted = awaited!.targets.find(target => target.threadId === "busy-child")!;
  assert.deepEqual([restarted.state, restarted.quiescence], ["requested", undefined], "the release's own read withdrew the quiescence");
  finishChild(f, "busy-child", now + 3);
  yield* f.controller.reconcile(f.binding);
  // neither finished child has a workflow of its own: the release needs none fabricated, and each relayed hold is released as a hold only
  f.proof({...release, operationId: "release-finished"});
  assert.equal(((yield* f.controller.call({...release, operationId: "release-finished"})) as {status: string}).status, "recorded");
  yield* f.controller.reconcile(f.binding);
  const notices = sent.filter(item => String(item.messageId).includes(":release:")).map(item => String(item.text));
  assert.equal(notices.length, 3, JSON.stringify(notices));
  for (const id of ["busy-child", "late-child"]) {
    const notice = notices.find(text => text.startsWith(`Relay to child ${id}: planning pause`));
    assert.ok(notice, id);
    assert.match(notice, /releases your dispatch hold only\. Do not restart it or re-task it under its earlier result/);
    assert.doesNotMatch(notice, /Continue your authorised task|scoped plan/);
  }
  assert.ok(notices.some(text => text.startsWith(`Planning pause ${result.attempt.attemptId} released (planning resolved).`)), "the main's own release names the task's acceptance route");
}));

it.effect("a held child whose work resumes needs its linked, planned workflow to continue; without one the continue release is refused and a no-plan release still frees it", () => Effect.gen(function* () {
  const sent: Record<string, unknown>[] = [];
  const f = yield* fixture(acknowledgingRpc(sent));
  const now = yield* Clock.currentTimeMillis;
  nativeChild(f, "live-child", true, now);
  f.proof(f.args);
  const result = (yield* f.controller.call(f.args)) as PausedAnswer;
  assert.equal(result.status, "recorded", JSON.stringify(result));
  yield* f.controller.reconcile(f.binding);
  acknowledgeMain(f, result.attempt.attemptId);
  acknowledgeChild(f, result.attempt.attemptId, "live-child");
  yield* f.controller.reconcile(f.binding);
  const [acked] = yield* f.stores.requests.planningAttempts("project");
  assert.deepEqual(acked!.targets.map(target => [target.threadId, target.state]).sort(), [["live-child", "acknowledged"], ["main", "acknowledged"]]);
  const release = {...f.args, action: "release", attemptId: result.attempt.attemptId, operationId: "release-unscoped", resolution: "continue"};
  delete (release as {targetThreadIds?: unknown}).targetThreadIds;
  f.proof(release);
  assert.deepEqual(yield* f.controller.call(release), {status: "denied", reason: "planning_target_unscoped"}, "live work that resumes is not pointed at a plan it does not have");
  const noPlan = {...release, operationId: "release-no-plan", resolution: "no_plan"};
  f.proof(noPlan);
  assert.equal(((yield* f.controller.call(noPlan)) as {status: string}).status, "recorded");
  yield* f.controller.reconcile(f.binding);
  const relayed = sent.map(item => String(item.text)).find(text => text.startsWith("Relay to child live-child: planning pause"));
  assert.equal(relayed, `Relay to child live-child: planning pause ${result.attempt.attemptId} released (no plan needed). Continue your authorised task; human Stops and limits still apply.`);
}));

it.effect("a live child that cannot be read is listed as unavailable and blocks adoption past the main's ACK until a fresh read settles it; a release reads membership itself and a lineage outage marks the attempt until it recovers", () => Effect.gen(function* () {
  const sent: Record<string, unknown>[] = [];
  const failures: PlanningReadFailures = {projections: new Set(["dark-child", "flaky-child"]), listThreads: false};
  const f = yield* fixture(acknowledgingRpc(sent), {readFailures: failures});
  const now = yield* Clock.currentTimeMillis;
  nativeChild(f, "dark-child", true, now);
  nativeChild(f, "flaky-child", true, now);
  f.proof(f.args);
  const result = (yield* f.controller.call(f.args)) as PausedAnswer;
  assert.equal(result.status, "recorded", JSON.stringify(result));
  assert.deepEqual(result.attempt.targets.map(target => target.threadId), ["main"], "an unreadable child is never a target");
  assert.deepEqual(result.attempt.uncovered, [{threadId: "dark-child", reason: "unavailable"}, {threadId: "flaky-child", reason: "unavailable"}], "nothing about the unreadable children's work is established");
  yield* f.controller.reconcile(f.binding);
  acknowledgeMain(f, result.attempt.attemptId);
  yield* f.controller.reconcile(f.binding);
  const [acked] = yield* f.stores.requests.planningAttempts("project");
  assert.equal(acked!.targets[0]!.state, "acknowledged");
  assert.equal(planningCanAdopt(acked!, yield* Clock.currentTimeMillis), false, "the main's ACK cannot make the attempt look complete while a child is unread");
  const release = {...f.args, action: "release", attemptId: result.attempt.attemptId, operationId: "release-dark", resolution: "continue"};
  delete (release as {targetThreadIds?: unknown}).targetThreadIds;
  f.proof(release);
  assert.deepEqual(yield* f.controller.call(release), {status: "denied", reason: "planning_acks_incomplete"});
  // both reads recover: the idle child's listing is settled by that fresh read, not by time; the busy one is held, never silently dropped
  failures.projections.clear();
  finishChild(f, "dark-child", now + 1);
  yield* f.controller.reconcile(f.binding);
  const [recoveredBusy] = yield* f.stores.requests.planningAttempts("project");
  assert.deepEqual(recoveredBusy!.uncovered ?? [], [], "a fresh read settles the quiet child's listing and replaces the busy child's with a hold");
  assert.deepEqual(recoveredBusy!.targets.map(target => [target.threadId, target.state]), [["main", "acknowledged"], ["flaky-child", "requested"]], "a readable busy child becomes a held target");
  assert.equal(planningCanAdopt(recoveredBusy!, yield* Clock.currentTimeMillis), false, "the held busy child blocks adoption");
  f.proof({...release, operationId: "release-busy"});
  assert.deepEqual(yield* f.controller.call({...release, operationId: "release-busy"}), {status: "denied", reason: "planning_acks_incomplete"});
  finishChild(f, "flaky-child", now + 1);
  yield* f.controller.reconcile(f.binding);
  const [settled] = yield* f.stores.requests.planningAttempts("project");
  assert.deepEqual(settled!.targets.map(target => [target.threadId, target.state]), [["main", "acknowledged"], ["flaky-child", "quiescent"]], "the held child's own terminal lifecycle makes it quiescent");
  assert.equal(planningCanAdopt(settled!, yield* Clock.currentTimeMillis), true);
  // a child that starts after the last reconcile is held by the release's own membership read, with no reconcile in between
  nativeChild(f, "late-starter", true, now + 2);
  f.proof({...release, operationId: "release-late"});
  assert.deepEqual(yield* f.controller.call({...release, operationId: "release-late"}), {status: "denied", reason: "planning_acks_incomplete"});
  const [withLate] = yield* f.stores.requests.planningAttempts("project");
  assert.deepEqual(withLate!.targets.map(target => [target.threadId, target.state]), [["main", "acknowledged"], ["flaky-child", "quiescent"], ["late-starter", "requested"]], "the release itself held the late child");
  // a lineage outage establishes nothing: the release's own membership read marks the attempt and refuses, a reconcile pass under the
  // same outage keeps the mark, and only a later successful read of the lineage clears it
  finishChild(f, "late-starter", now + 3);
  yield* f.controller.reconcile(f.binding);
  failures.listThreads = true;
  f.proof({...release, operationId: "release-outage"});
  assert.deepEqual(yield* f.controller.call({...release, operationId: "release-outage"}), {status: "denied", reason: "planning_scope_unavailable"}, "an unreadable lineage is not an established membership");
  const [markedByRelease] = yield* f.stores.requests.planningAttempts("project");
  assert.equal(typeof markedByRelease!.scopeUnavailableAt, "number", "the release itself records the outage, even at a zero clock");
  yield* f.controller.reconcile(f.binding);
  const [marked] = yield* f.stores.requests.planningAttempts("project");
  assert.equal(marked!.scopeUnavailableAt, markedByRelease!.scopeUnavailableAt, "a reconcile under the same outage keeps the first mark");
  assert.equal(planningCanAdopt(marked!, yield* Clock.currentTimeMillis), false);
  failures.listThreads = false;
  const read = {...f.args, action: "read", attemptId: result.attempt.attemptId, operationId: "read-outage"};
  delete (read as {targetThreadIds?: unknown}).targetThreadIds;
  f.proof(read);
  assert.equal(((yield* f.controller.call(read)) as {attempts: PausedAnswer["attempt"][]}).attempts[0]?.scopeUnavailable, true, "the mark stays until a read establishes membership again");
  f.proof({...release, operationId: "release-recovered"});
  assert.equal(((yield* f.controller.call({...release, operationId: "release-recovered"})) as {status: string}).status, "recorded", "the release's own fresh read re-establishes membership: every held child is quiet");
  const [recovered] = yield* f.stores.requests.planningAttempts("project");
  assert.equal(recovered!.scopeUnavailableAt, undefined, "a successful lineage read clears the mark");
  assert.equal(recovered!.state, "releasing", "the release notices are still being delivered");
  // the native descendant has no workflow of its own: its relayed release carries no scoped-plan hint and the main's is unchanged
  yield* f.controller.reconcile(f.binding);
  const relayed = sent.filter(item => String(item.messageId).includes(":release:")).map(item => String(item.text));
  assert.equal(relayed.length, 3, JSON.stringify(relayed));
  assert.ok(relayed.some(text => text.startsWith("Relay to child late-starter: planning pause") && text.includes("releases your dispatch hold only") && !text.includes("Continue your authorised task")), JSON.stringify(relayed));
  assert.ok(relayed.some(text => text.startsWith(`Planning pause ${result.attempt.attemptId} released (planning resolved). This release grants no implementation permission`)), JSON.stringify(relayed));
}));

it.effect("the combined target limit is the existing 100: overflow at pause time is denied with its count, a late child beyond it and a helper-covered child are listed and block adoption", () => Effect.gen(function* () {
  const sent: Record<string, unknown>[] = [];
  const f = yield* fixture(acknowledgingRpc(sent));
  const now = yield* Clock.currentTimeMillis;
  for (let index = 0; index < 100; index++) nativeChild(f, `child-${index}`, true, now);
  f.proof(f.args);
  assert.deepEqual(yield* f.controller.call(f.args), {status: "denied", reason: "planning_targets_limit", targetCount: 101});
  // 99 running children and the main fill the limit exactly; a late child and a helper-covered child are uncovered, not quiet
  f.threads.splice(f.threads.findIndex(thread => thread.id === "child-99"), 1);
  f.projections.delete("child-99");
  f.projections.get("main")!.subagents = (f.projections.get("main")!.subagents as Record<string, unknown>[]).filter(record => record.childThreadId !== "child-99");
  const retry = {...f.args, operationId: "pause-b"};
  f.proof(retry);
  const result = (yield* f.controller.call(retry)) as PausedAnswer;
  assert.equal(result.status, "recorded", JSON.stringify(result));
  assert.equal(result.attempt?.targets.length, 100, JSON.stringify(result).slice(0, 300));
  nativeChild(f, "late-child", true, now);
  const helperChild = nativeChild(f, "helper-child", true, now);
  const registered = yield* f.stores.team.registerMember(f.binding, {threadId: "helper", taskId: "bootstrap", bootstrapRunId: "bootstrap-run", now: 1});
  yield* f.stores.team.markReady(f.binding, registered.threadId, registered.epoch);
  yield* f.stores.team.assign(f.binding, helperChild.id, registered.threadId, new Map(f.threads.map(thread => [thread.id, thread.lineage.parentThreadId ?? null])));
  yield* f.controller.reconcile(f.binding);
  const [attempt] = yield* f.stores.requests.planningAttempts("project");
  assert.equal(attempt!.targets.length, 100, "nothing beyond the limit becomes a target");
  assert.deepEqual(attempt!.uncovered?.map(item => [item.threadId, item.reason]).sort(), [["helper-child", "assigned_to_helper"], ["late-child", "limit"]]);
  for (const id of attempt!.targets.map(target => target.threadId).filter(id => id !== "main")) finishChild(f, id, now + 1);
  acknowledgeMain(f, result.attempt.attemptId);
  yield* f.controller.reconcile(f.binding);
  const [settled] = yield* f.stores.requests.planningAttempts("project");
  assert.ok(settled!.targets.every(target => target.state === "acknowledged" || target.state === "quiescent"), "every held target is quiet");
  assert.equal(planningCanAdopt(settled!, yield* Clock.currentTimeMillis), false, "uncovered children never read as quiet");
  const read = {...f.args, action: "read", attemptId: result.attempt.attemptId, operationId: "read-b"};
  delete (read as {targetThreadIds?: unknown}).targetThreadIds;
  f.proof(read);
  const answer = (yield* f.controller.call(read)) as {status: string; attempts: PausedAnswer["attempt"][]};
  assert.equal(answer.status, "ready");
  assert.deepEqual(answer.attempts[0]?.uncovered.map(item => [item.threadId, item.reason]).sort(), [["helper-child", "assigned_to_helper"], ["late-child", "limit"]], "the read lists what the pause could not hold");
  // a listing is settled only by fresh evidence of quiet: the helper-covered child finishes, the one beyond the limit stays listed while busy
  finishChild(f, "helper-child", now + 2);
  yield* f.controller.reconcile(f.binding);
  const [helperQuiet] = yield* f.stores.requests.planningAttempts("project");
  assert.deepEqual(helperQuiet!.uncovered?.map(item => [item.threadId, item.reason]), [["late-child", "limit"]], "the quiet helper-covered child is settled; the busy over-limit child is not");
  assert.equal(planningCanAdopt(helperQuiet!, yield* Clock.currentTimeMillis), false);
  finishChild(f, "late-child", now + 3);
  yield* f.controller.reconcile(f.binding);
  const [allQuiet] = yield* f.stores.requests.planningAttempts("project");
  assert.deepEqual(allQuiet!.uncovered ?? [], [], "the over-limit child's listing is settled by its own quiet read");
  assert.equal(planningCanAdopt(allQuiet!, yield* Clock.currentTimeMillis), true);
}), {timeout: 30_000});

// the main's prepared proposal as the task carries it before acceptance, and the same proposal recorded as its agreement
const proposal: WorkflowProposalInfo = {status: "proposed", message: "A complete proposal is waiting for an exact operative acceptance record.",
  workspaceRoot: "/workspace/project", revision: "definitions-1", globalRevision: null, definitionsStatus: "ready", definitionsComplete: true,
  requirementsKnown: true, requirements: [], issues: [], plan: null};
const agreement = {status: "agreed" as const, message: "The operative assistant accepted the Supervisor's exact proposal by its digest.", proposalId: "proposal-a",
  agreedAt: 1, evidence: {kind: "supervisor_message" as const, messageId: "proposal-message"}, agentMessageId: "acceptance-message", workflow: proposal};
// the acknowledged pause of the fixture main, through the controller's own hold send and the main's exact ACK
const acknowledgedPause = (f: Effect.Success<ReturnType<typeof fixture>>, sent: Record<string, unknown>[]) => Effect.gen(function* () {
  f.proof(f.args);
  const result = (yield* f.controller.call(f.args)) as Answer;
  assert.equal(result.status, "recorded");
  yield* f.controller.reconcile(f.binding);
  assert.ok(sent.find(item => String(item.messageId).includes(":hold:")), "the hold went out natively");
  const main = f.projections.get("main")!;
  main.messages.push({id: "actor-ack", threadId: "main", runId: "source-run", nodeId: "ack-node", role: "assistant", streaming: false,
    text: `\`\`\`planning-pause-ack\n${JSON.stringify({attemptId: result.attempt.attemptId, targetThreadId: "main"})}\n\`\`\``, createdAt: "2026-10-27T12:01:01Z", updatedAt: "2026-10-27T12:01:01Z"});
  (main.nodes as Record<string, unknown>[]).push({id: "ack-node", kind: "assistant_message", threadId: "main", runId: "source-run", rootNodeId: "source-node", parentNodeId: "source-node", providerThreadId: "provider-main", status: "completed"});
  return result.attempt.attemptId;
});
const releaseOf = (sent: Record<string, unknown>[]) => String(sent.find(item => String(item.messageId).includes(":release:"))?.text);

for (const agreed of [false, true])
it.effect(`a planning-resolved release of a main whose proposal is ${agreed ? "agreed continues the task" : "unagreed grants no implementation permission and names the acceptance route"}, only after the ACK`, () => Effect.gen(function* () {
  const sent: Record<string, unknown>[] = [];
  const rpc: NativeRpcShape = {call: () => Effect.die(new Error("admitted initiation only")), initiate: (_tag, payload) => {
    sent.push({...payload});return Effect.succeed({sent: Effect.succeed(true), release: Effect.void, result: Effect.succeed({sequence: sent.length})});
  }};
  const f = yield* fixture(rpc);
  yield* f.stores.supervisors.saveTask({...f.task, workflow: proposal, workflowProposalId: "proposal-a", ...(agreed ? {agreement} : {})});
  f.proof(f.args);
  const paused = (yield* f.controller.call(f.args)) as Answer;
  // a release before the main's ACK is refused: the two never race into a release of an unacknowledged pause
  const early = {...f.args, action: "release", attemptId: paused.attempt.attemptId, operationId: "release-early", resolution: "continue"};
  delete (early as {targetThreadIds?: unknown}).targetThreadIds;
  f.proof(early);
  assert.equal(((yield* f.controller.call(early)) as {reason?: string}).reason, "planning_acks_incomplete");
  yield* f.controller.reconcile(f.binding);
  const main = f.projections.get("main")!;
  main.messages.push({id: "actor-ack", threadId: "main", runId: "source-run", nodeId: "ack-node", role: "assistant", streaming: false,
    text: `\`\`\`planning-pause-ack\n${JSON.stringify({attemptId: paused.attempt.attemptId, targetThreadId: "main"})}\n\`\`\``, createdAt: "2026-10-27T12:01:01Z", updatedAt: "2026-10-27T12:01:01Z"});
  (main.nodes as Record<string, unknown>[]).push({id: "ack-node", kind: "assistant_message", threadId: "main", runId: "source-run", rootNodeId: "source-node", parentNodeId: "source-node", providerThreadId: "provider-main", status: "completed"});
  yield* f.controller.reconcile(f.binding);
  const release = {...early, operationId: "release-a"};
  f.proof(release);
  assert.equal(((yield* f.controller.call(release)) as {status: string}).status, "recorded");
  yield* f.controller.reconcile(f.binding);
  const attemptId = paused.attempt.attemptId;
  // the native send carries the release the main's agreement state decides
  assert.equal(releaseOf(sent), agreed
    ? `Planning pause ${attemptId} released (planning resolved). Continue your authorised task; human Stops and limits still apply.`
    : `Planning pause ${attemptId} released (planning resolved). This release grants no implementation permission: workflow proposal proposal-a is not agreed; read it with supervision_plan {"callerThreadId":"main","taskId":"task-a","proposalId":"proposal-a"} and, if you agree, put its exact acceptance record in your own completed reply; a record sent to your Supervisor or relayed by another chat records nothing. Evidence gathering may continue; human Stops and limits still apply.`);
  const [stored] = yield* f.stores.requests.planningAttempts("project");
  assert.equal(stored!.targets[0]!.release!.text, releaseOf(sent), "the stored bytes are the sent bytes");
  assert.equal(sent.length, 2, "one hold and one release");
}));

it.effect("a pause superseded by a changed task releases the main without implementation permission while nothing is agreed", () => Effect.gen(function* () {
  const sent: Record<string, unknown>[] = [];
  const rpc: NativeRpcShape = {call: () => Effect.die(new Error("admitted initiation only")), initiate: (_tag, payload) => {
    sent.push({...payload});return Effect.succeed({sent: Effect.succeed(true), release: Effect.void, result: Effect.succeed({sequence: sent.length})});
  }};
  const f = yield* fixture(rpc);
  const attemptId = yield* acknowledgedPause(f, sent);
  // the main's request was replaced by a new task: the attempt is superseded and its delivered hold must be released
  yield* f.stores.supervisors.saveTask({...f.task, id: "task-b", messageId: "interpretation-b"});
  yield* f.controller.reconcile(f.binding);
  const [stored] = yield* f.stores.requests.planningAttempts("project");
  assert.equal(stored?.state, "superseded");
  assert.equal(stored?.resolution, "superseded");
  assert.equal(releaseOf(sent), `Planning pause ${attemptId} released (superseded). This release grants no implementation permission: no workflow proposal is agreed yet; agree the one your Supervisor sends before implementing; a record sent to your Supervisor or relayed by another chat records nothing. Evidence gathering may continue; human Stops and limits still apply.`);
  assert.doesNotMatch(releaseOf(sent), /Continue your authorised task/u);
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
      {kind: "back_to", target: "work", maximum: 5, reason: "Correct the reviewed work."}]}}, local("deliver")]}}, context);
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
  if (execution === "app_run") {
    const coordinator: ThreadInfo = {...child, id: "coordinator", title: "Coordinator"};
    child.lineage = {...child.lineage, parentThreadId: coordinator.id};
    f.threads.push(coordinator);
    const mainProjection = f.projections.get("main")!;
    const run = {...mainProjection.runs[0]!, id: "coordinator-run", threadId: coordinator.id, rootNodeId: "coordinator-root", providerThreadId: "provider-coordinator", status: "running"};
    f.projections.set(coordinator.id, {thread: coordinator, runs: [run], messages: [], turnItems: [], runtimeRequests: [],
      nodes: [{...(mainProjection.nodes as Record<string, unknown>[])[0], id: "coordinator-root", threadId: coordinator.id, runId: run.id, rootNodeId: "coordinator-root", parentNodeId: null, providerThreadId: "provider-coordinator"}]});
    f.args.targetThreadIds.push(coordinator.id);
  }
  f.proof(f.args);
  const paused = (yield* f.controller.call(f.args)) as Answer;
  const input = {...f.args, action: "apply_return", operationId: "return-a", attemptId: paused.attempt.attemptId, workflowId: document.workflowId,
    expectedRevision: document.revision, returnId: document.returns[0]!.returnId, reason: "Apply the chosen return."};
  delete (input as {targetThreadIds?: unknown}).targetThreadIds;
  f.proof(input);
  assert.equal(((yield* f.controller.call(input)) as {reason: string}).reason, "return_owner_not_paused");
  yield* f.controller.reconcile(f.binding);
  const main = f.projections.get("main")!;
  main.messages.push({id: "return-ack", threadId: "main", runId: "source-run", nodeId: "return-ack-node", role: "assistant", streaming: false,
    text: `\`\`\`planning-pause-ack\n${JSON.stringify({attemptId: paused.attempt.attemptId, targetThreadId: "main"})}\n\`\`\``, createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString()});
  (main.nodes as Record<string, unknown>[]).push({id: "return-ack-node", kind: "assistant_message", threadId: "main", runId: "source-run", rootNodeId: "source-node", parentNodeId: "source-node", providerThreadId: "provider-main", status: "completed"});
  if (execution === "app_run") {
    const coordinator = f.projections.get("coordinator")!;
    coordinator.messages.push({id: "coordinator-ack", threadId: "coordinator", runId: "coordinator-run", nodeId: "coordinator-ack-node", role: "assistant", streaming: false,
      text: `\`\`\`planning-pause-ack\n${JSON.stringify({attemptId: paused.attempt.attemptId, targetThreadId: "coordinator"})}\n\`\`\``, createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString()});
    (coordinator.nodes as Record<string, unknown>[]).push({id: "coordinator-ack-node", kind: "assistant_message", threadId: "coordinator", runId: "coordinator-run", rootNodeId: "coordinator-root", parentNodeId: "coordinator-root", providerThreadId: "provider-coordinator", status: "completed"});
  }
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
  if (execution === "app_run") {
    const coordinator = f.projections.get("coordinator")!;
    coordinator.runs.push({...coordinator.runs[0]!, id: "queued-coordinator-run", ordinal: 2, status: "queued"});
    assert.equal(((yield* f.controller.call(input)) as {reason: string}).reason, "return_actor_changed_run", "an intermediary parent cannot dispatch work after its ACK");
    coordinator.runs.pop();
    f.projections.get("reviewer")!.runs.unshift({...childRun, id: "earlier-review-run", ordinal: 0});
  }
  const currentTask = (yield* f.stores.supervisors.task("main"))!;
  const scopeRevision = fingerprint("A reconsidered authorized scope.");
  yield* f.stores.supervisors.saveTask({...currentTask, conversation: {...currentTask.conversation!, authorization: {...currentTask.conversation!.authorization!, scopeRevision}}});
  const changedScopeInput = {...input, taskRevision: scopeRevision};
  f.proof(changedScopeInput);
  assert.equal(((yield* f.controller.call(changedScopeInput)) as {reason: string}).reason, "return_workflow_scope_changed", "current task pins cannot reopen an earlier scope's document");
  yield* f.stores.supervisors.saveTask(currentTask);
  f.proof(input);
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

// a pending return over [work, review by an AppRun reviewer child of main, a branch back_to work, deliver], its branch chosen, with main
// paused and ACKed in its still-waiting source run; with `reviewerTarget` the reviewer is also a pause target. Every native read is a
// point-in-time copy reported to `onRead`
const pendingReturn = (onRead: (threadId: string) => void, reviewerTarget = false, maximum = 5) => Effect.gen(function* () {
  const rpc: NativeRpcShape = {call: () => Effect.die(new Error("admitted initiation only")), initiate: () =>
    Effect.succeed({sent: Effect.succeed(true), release: Effect.void, result: Effect.succeed({sequence: 1})})};
  const f = yield* fixture(rpc, {onRead});
  const now = yield* Clock.currentTimeMillis;
  const context = proposalContextFromDefinitions({...goldenSnapshot, projectId: "project", threadId: "main", steps: [], workflows: [], config: {steps: [], workflows: []}, projectConfig: {steps: [], workflows: []}});
  const local = (id: string) => ({kind: "step", definitionId: null, localId: id, name: id, description: `Complete ${id}.`, reason: `The request needs ${id}.`});
  const plan = validateWorkflowPlan({requirements: [], plan: {kind: "sequence", nodes: [local("work"), local("review"),
    {kind: "branch", condition: "Corrections are required.", reason: "Review determines the next work.", then: {kind: "sequence", nodes: [
      {kind: "back_to", target: "work", maximum, reason: "Correct the reviewed work."}]}}, local("deliver")]}}, context);
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
  progress.plan.nodes = progress.plan.nodes.map(node => node.kind === "step" && node.localId === "review" ? {...node, contributorThreadIds: ["reviewer"]} : node);
  const advance = {pinnedContext: context, originalProposal: proposal, expectedTaskId: f.task.id, expectedProposalId: "proposal-a", expectedSourceHash: f.task.sourceHash,
    acceptedTaskAgreement: null, acceptedTaskAgreementSourceHash: null};
  assert.equal((yield* f.states.apply(owner, {operationId: "initial-progress", workflowId: document.workflowId, expectedRevision: document.revision,
    status: "underway", objective: document.objective, sourceBinding: document.sourceBinding!, requirements: [], issues: [], plan: progress.plan, note: "The first pass returned findings.",
    evidence: [{kind: "status_changed", targetNodeId: null, note: "The task is underway."}, ...changed.map(node => ({kind: "status_changed" as const, targetNodeId: node.nodeId, note: "This pass completed."}))]},
  advance, now + 1)).status, "applied");
  document = (yield* f.states.get("project", "main"))!;
  assert.equal((yield* f.states.recordBranchSelection(owner, {nodeId: planBranches(document.plan)[0]!.nodeId, revision: 1, path: "then",
    reason: "The report requires corrections.", sourceThreadId: "main", sourceRunId: "source-run", sourceMessageId: "decision-message", sourceCreatedAt: now + 2}, now + 2)).status, "applied");
  document = (yield* f.states.get("project", "main"))!;
  const reviewer: ThreadInfo = {id: "reviewer", title: "Reviewer", projectId: "project", creationSource: "mcp",
    lineage: {parentThreadId: "main", relationshipToParent: "subagent"}, runtimeMode: "full-access", interactionMode: "default"};
  f.threads.push(reviewer);
  const reviewRun = {id: "old-review-run", threadId: "reviewer", ordinal: 1, status: "completed", requestedAt: new Date(now).toISOString(), startedAt: new Date(now).toISOString(),
    completedAt: new Date(now).toISOString(), rootNodeId: null};
  f.projections.set(reviewer.id, {thread: reviewer, runs: [reviewRun], nodes: [], providerTurns: [], messages: [], turnItems: [], runtimeRequests: []});
  const main = f.projections.get("main")!;
  main.subagents = [{id: "review-task", childThreadId: "reviewer", origin: "app_owned", status: "completed", runId: "source-run"}];
  if (reviewerTarget) f.args.targetThreadIds.push("reviewer");
  f.proof(f.args);
  const paused = (yield* f.controller.call(f.args)) as Answer;
  const input = {...f.args, action: "apply_return", operationId: "return-a", attemptId: paused.attempt.attemptId, workflowId: document.workflowId,
    expectedRevision: document.revision, returnId: document.returns[0]!.returnId, reason: "Apply the chosen return."};
  delete (input as {targetThreadIds?: unknown}).targetThreadIds;
  f.proof(input);
  yield* f.controller.reconcile(f.binding);
  main.messages.push({id: "return-ack", threadId: "main", runId: "source-run", nodeId: "return-ack-node", role: "assistant", streaming: false,
    text: `\`\`\`planning-pause-ack\n${JSON.stringify({attemptId: paused.attempt.attemptId, targetThreadId: "main"})}\n\`\`\``, createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString()});
  (main.nodes as Record<string, unknown>[]).push({id: "return-ack-node", kind: "assistant_message", threadId: "main", runId: "source-run", rootNodeId: "source-node", parentNodeId: "source-node", providerThreadId: "provider-main", status: "completed"});
  yield* f.controller.reconcile(f.binding);
  if (reviewerTarget) yield* f.controller.reconcile(f.binding);
  main.runs[0]!.status = "waiting";
  main.thread.activeRunId = "source-run";
  return {f, input, main, now, owner, advance, document};
});

// audit F3: apply_return decides on point-in-time native reads taken before its admitted commit; the admission section reads nothing
// native (supervision-gate) and nothing is atomic with T3. The owner used to be read first, so work it started while its contributors
// were still being read was invisible to the decision
it.effect("apply_return reads its owner last, so work the owner starts while contributors are read refuses the return", () => Effect.gen(function* () {
  const reads: string[] = [];
  let during = (_threadId: string) => {};
  const r = yield* pendingReturn(threadId => {reads.push(threadId);during(threadId);});
  // the control: with no new owner work the same call applies
  reads.length = 0;
  during = threadId => {
    if (threadId === "reviewer" && !r.main.runs.some(run => run.id === "post-read-run"))
      r.main.runs.push({...r.main.runs[0]!, id: "post-read-run", ordinal: 2, status: "running", startedAt: null, completedAt: null, rootNodeId: null});
  };
  const refused = (yield* r.f.controller.call(r.input)) as {status: string; reason?: string};
  assert.equal(refused.reason, "return_actor_changed_run", JSON.stringify(refused));
  assert.ok(reads.lastIndexOf("main") > reads.lastIndexOf("reviewer"), `the owner is read after its contributors: ${reads.join(", ")}`);
  assert.equal((yield* r.f.states.get("project", "main"))!.returns[0]!.state, "pending");
  during = () => {};
  r.main.runs.pop();
  assert.equal(((yield* r.f.controller.call(r.input)) as {status: string}).status, "applied", "without that work the same call applies");
}));

// audit F3 (integration follow-up): the decision also must not wait behind another admitted section with the snapshot it read; work
// the owner starts during that wait would be committed over. Only the part after the last read, outside any wait, is the T3 boundary
it.effect("apply_return never commits a snapshot that waited behind a busy admission gate", () => Effect.gen(function* () {
  const reads: string[] = [];
  const ownerRead = yield* Deferred.make<void>();
  const admissionBusy = yield* Deferred.make<void>();
  let watching = false;
  const r = yield* pendingReturn(threadId => {
    if (!watching) return;
    reads.push(threadId);
    if (threadId === "main" && reads.includes("reviewer")) Deferred.doneUnsafe(ownerRead, Effect.void);
  });
  const originalAdmission = r.f.gate.admitIfAvailable;
  yield* Effect.acquireRelease(Effect.sync(() => vi.spyOn(r.f.gate, "admitIfAvailable").mockImplementation(body =>
    originalAdmission(body).pipe(Effect.tap(result => Option.isNone(result) ? Deferred.succeed(admissionBusy, undefined) : Effect.void)))),
  spy => Effect.sync(() => spy.mockRestore()));
  const held = yield* Deferred.make<void>();
  const release = yield* Deferred.make<void>();
  const holder = yield* Effect.forkChild(r.f.gate.admit(() => Effect.andThen(Deferred.succeed(held, undefined), Deferred.await(release))));
  yield* Deferred.await(held);
  watching = true;
  const applying = yield* Effect.forkChild(r.f.controller.call(r.input));
  yield* Effect.gen(function* () {
    yield* bounded(Deferred.await(ownerRead), 2_000, "the return reads its owner after its contributors");
    yield* bounded(Deferred.await(admissionBusy), 2_000, "the return refuses admission behind the held gate");
    // the owner starts work its ACK does not cover after this snapshot has actually refused admission
    r.main.runs.push({...r.main.runs[0]!, id: "admission-wait-run", ordinal: 2, status: "running", startedAt: null, completedAt: null, rootNodeId: null});
  }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
  yield* Fiber.join(holder);
  const answer = (yield* Fiber.join(applying)) as {status: string; reason?: string};
  assert.notEqual(answer.status, "applied", JSON.stringify(answer));
  assert.equal(answer.reason, "return_actor_changed_run", JSON.stringify(answer));
  assert.equal((yield* r.f.states.get("project", "main"))!.returns[0]!.state, "pending");
  watching = false;
  r.main.runs.pop();
  assert.equal(((yield* r.f.controller.call(r.input)) as {status: string}).status, "applied", "without that work the same operation applies");
}));

// audit F4: a quiescent target stays held while it is quiet now, like an ACKed one whose later completed run does not block (an ACK
// covers its execution; only queued or active work blocks). What the return must guarantee is that a contributor's work during the
// pause, including a run it completed after its quiescence evidence, never counts for the new attempt
it.effect("a quiescent contributor that ran again after its quiescence evidence has every known run retired by the return", () => Effect.gen(function* () {
  const r = yield* pendingReturn(() => {}, true);
  const target = (yield* r.f.stores.requests.planningAttempts("project"))[0]!.targets.find(row => row.threadId === "reviewer")!;
  assert.deepEqual({state: target.state, runId: target.quiescence?.runId}, {state: "quiescent", runId: "old-review-run"});
  const reviewer = r.f.projections.get("reviewer")!;
  reviewer.runs.push({...reviewer.runs[0]!, id: "after-quiescence-run", ordinal: 2});
  const applied = (yield* r.f.controller.call(r.input)) as {status: string};
  assert.equal(applied.status, "applied", JSON.stringify(applied));
  const returned = (yield* r.f.states.get("project", "main"))!;
  assert.deepEqual(returned.returns[0]!.retiredRuns, [{kind: "run", threadId: "reviewer", runId: "old-review-run"}, {kind: "run", threadId: "reviewer", runId: "after-quiescence-run"}]);
  const review = planEntities(returned.plan).find(node => node.kind === "step" && node.localId === "review")!;
  const next = withOccurrenceStatuses(returned.plan!, [{nodeId: review.nodeId, status: "completed"}]);
  assert.ok("plan" in next);
  const stale = yield* r.f.states.apply(r.owner, {operationId: "late-review-report", workflowId: returned.workflowId, expectedRevision: returned.revision,
    status: "underway", objective: returned.objective, sourceBinding: returned.sourceBinding!, requirements: [], issues: [], plan: next.plan, note: "The run after quiescence claims the repeated review.",
    evidence: [{kind: "status_changed", targetNodeId: review.nodeId, note: "A review result from the paused attempt.", sourceThreadId: "reviewer", sourceRunId: "after-quiescence-run"}]},
  r.advance, r.now + 3);
  assert.ok(stale.status === "invalid" && stale.reason === "retired_run_evidence", JSON.stringify(stale));
}));

// audit F5: the one-second watchdog also re-read every target of an open attempt on every pass, for the attempt's whole life (up to an
// hour), each read a new native connection, though an acknowledged or quiescent actor with a delivered hold has nothing left to observe
it.effect("an open planning attempt reads only actors it still waits for, while hold, ACK and deadline handling keep their one-second pace", () => Effect.gen(function* () {
  const sent: Record<string, unknown>[] = [];
  const rpc: NativeRpcShape = {call: () => Effect.die(new Error("admitted initiation only")), initiate: (_tag, payload) => {
    sent.push({...payload});
    return Effect.succeed({sent: Effect.succeed(true), release: Effect.void, result: Effect.succeed({sequence: sent.length})});
  }};
  // observe the actual fibers the production watchdog schedules, then join each pass before advancing the next second. SQL runs
  // on workers: scheduler yields cannot establish that its I/O or the pass has completed. The wrapper retains FiberMap.run unchanged.
  const passes = yield* Queue.unbounded<Effect.Effect<void, unknown>>();
  const run = FiberMap.run;
  let ownerThreadId = "";
  const observeRun = <K, A, E, R, XE extends E, XA extends A>(map: FiberMap.FiberMap<K, A, E>, key: K,
    effect: Effect.Effect<XA, XE, R>, options?: {onlyIfMissing?: boolean; propagateInterruption?: boolean; startImmediately?: boolean}) =>
    run(map, key, effect.pipe(Effect.onExit(exit => key === ownerThreadId
      ? Queue.offer(passes, Exit.isFailure(exit) ? Effect.failCause(exit.cause) : Effect.void) : Effect.void)), options);
  // this controller calls the uncurried overload only; the observer delegates that exact call to the original implementation.
  yield* Effect.acquireRelease(Effect.sync(() => vi.spyOn(FiberMap, "run").mockImplementation(observeRun as typeof FiberMap.run)),
    spy => Effect.sync(() => spy.mockRestore()));
  const reads: string[] = [];
  const f = yield* fixture(rpc, {onRead: threadId => reads.push(threadId)});
  ownerThreadId = f.binding.threadId;
  const tick = (duration: Duration.Input = "1 second") => Effect.gen(function* () {
    yield* TestClock.adjust(duration);
    yield* bounded(Effect.flatten(Queue.take(passes)), 2_000, "the watchdog's real reconciliation completes");
  });
  const within = <E>(seconds: number, label: string, done: Effect.Effect<boolean, E>) => Effect.gen(function* () {
    if (yield* done) return;
    for (let second = 1; second <= seconds; second++) {
      yield* tick();
      if (yield* done) return;
    }
    assert.fail(`${label} within ${seconds} watchdog seconds`);
  });
  const target = Effect.map(f.stores.requests.planningAttempts("project"), rows => rows[0]!);
  f.proof(f.args);
  const paused = (yield* f.controller.call(f.args)) as Answer;
  yield* within(2, "the hold goes out", Effect.sync(() => sent.some(item => String(item.messageId).includes(":hold:"))));
  const main = f.projections.get("main")!;
  main.messages.push({id: "actor-ack", threadId: "main", runId: "source-run", nodeId: "ack-node", role: "assistant", streaming: false,
    text: `\`\`\`planning-pause-ack\n${JSON.stringify({attemptId: paused.attempt.attemptId, targetThreadId: "main"})}\n\`\`\``, createdAt: "2026-10-27T12:01:01Z", updatedAt: "2026-10-27T12:01:01Z"});
  (main.nodes as Record<string, unknown>[]).push({id: "ack-node", kind: "assistant_message", threadId: "main", runId: "source-run", rootNodeId: "source-node", parentNodeId: "source-node", providerThreadId: "provider-main", status: "completed"});
  yield* within(2, "the ACK is recorded", Effect.map(target, row => row.targets[0]!.state === "acknowledged"));
  // a minute in which the only actor has acknowledged its delivered hold: nothing is left to observe
  reads.length = 0;
  for (let second = 0; second < 60; second++) yield* tick();
  assert.equal(reads.length, 0, `native projection reads in a settled minute: ${reads.length}`);
  // the deadline still expires the attempt and releases its actor
  const open = yield* target;
  assert.equal(open.state, "open");
  yield* tick(open.deadline - (yield* Clock.currentTimeMillis));
  yield* TestClock.adjust("2 seconds");
  // expiry forks release and observation independently. Wait for their stored/native result at this clock time, rather than
  // demanding another observation pass after the release has already closed the attempt.
  yield* bounded(TestClock.withLive(Effect.repeat(Effect.map(target, row => row.state !== "open" &&
    sent.filter(item => String(item.messageId).includes(":release:")).length === 1),
  {until: done => done, schedule: Schedule.spaced("10 millis")})), 2_000, "the deadline releases the actor within two watchdog seconds");
}));

it.effect("one new drafting task returns quietly to its owner and is cleaned up when its attempt ends", () => Effect.gen(function* () {
  const sent: Record<string, unknown>[] = [];
  const rpc: NativeRpcShape = {call: () => Effect.die(new Error("admitted initiation only")), initiate: (_tag, payload) => {
    sent.push({...payload});return Effect.succeed({sent: Effect.succeed(true), release: Effect.void, result: Effect.succeed({sequence: sent.length})});
  }};
  const f = yield* fixture(rpc);
  const now = yield* Clock.currentTimeMillis;
  f.proof(f.args);
  const paused = (yield* f.controller.call(f.args)) as Answer;
  const child: ThreadInfo = {id: "writer", title: "Planning writer", projectId: "project", lineage: {parentThreadId: f.binding.threadId, relationshipToParent: "subagent"}, runtimeMode: "full-access", interactionMode: "default"};
  f.threads.push(child);
  const record = {id: "draft-task", childThreadId: child.id, origin: "app_owned", status: "completed", startedAt: new Date(now - 1).toISOString()};
  f.projections.get(f.binding.threadId)!.subagents = [record];
  f.projections.set(child.id, {thread: child, runs: [{id: "draft-run", threadId: child.id, ordinal: 1, status: "completed", requestedAt: new Date(now).toISOString(),
    startedAt: new Date(now).toISOString(), completedAt: new Date(now).toISOString(), rootNodeId: "draft-root", providerThreadId: "provider-writer"}],
    nodes: [{id: "draft-root", kind: "root_turn", threadId: child.id, runId: "draft-run", rootNodeId: "draft-root", providerThreadId: "provider-writer", status: "completed"},
      {id: "draft-answer", kind: "assistant_message", threadId: child.id, runId: "draft-run", rootNodeId: "draft-root", parentNodeId: "draft-root", providerThreadId: "provider-writer", status: "completed"}],
    messages: [{id: "draft-content", threadId: child.id, runId: "draft-run", nodeId: "draft-answer", role: "assistant", text: "A read-only draft for the owner to assess.", streaming: false,
      createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString()}],
    // a provider reply's published turn item: an opaque ID no message ID can be turned into
    turnItems: [{id: "turn-item:provider:claude:native-turn-7:item-3", type: "assistant_message", messageId: "draft-content", threadId: child.id, runId: "draft-run",
      text: "A read-only draft for the owner to assess."}], runtimeRequests: []});
  const input = {...f.args, action: "attach_draft", operationId: "attach-a", attemptId: paused.attempt.attemptId, draftThreadId: child.id, draftTaskId: record.id};
  delete (input as {targetThreadIds?: unknown}).targetThreadIds;
  f.proof(input);
  assert.equal(((yield* f.controller.call(input)) as {reason: string}).reason, "planning_draft_not_new_for_attempt");
  record.startedAt = new Date(now).toISOString();
  const attached = (yield* f.controller.call(input)) as Answer & {attempt: {draft: unknown}};
  assert.equal(attached.status, "recorded");
  assert.deepEqual(attached.attempt.draft, {state: "working", taskId: "draft-task"});
  assert.equal(attached.attempt.draftInstruction, undefined, "an attached drafter is not offered again");
  yield* f.controller.reconcile(f.binding);
  const ready = (yield* f.stores.requests.planningAttempts("project"))[0]!;
  assert.equal(ready.draft?.state, "returned");
  assert.equal(ready.draft?.resultMessageId, "draft-content");
  const notice = sent.find(command => command.threadId === f.binding.threadId)!;
  assert.deepEqual(notice.dispatchMode, {type: "queue_after_active"}, "the draft never steers the owner's thinking");
  // the notice carries the result's exact read, which the owner's answer no longer repeats: the published item of the reply, never its message ID
  assert.equal(notice.text, `Planning draft for pause ${ready.id} is ready: read it with t3_thread_read {"threadId":"writer","itemId":"turn-item:provider:claude:native-turn-7:item-3"} (message draft-content). Check ACKs with supervision_planning read and re-read current operative work before adopting it; publish nothing automatically and start no new wait.`);
  const named = JSON.parse(/t3_thread_read (\{[^}]*\})/u.exec(String(notice.text))![1]!) as {threadId: string; itemId: string};
  const resolved = f.projections.get(named.threadId)!.turnItems!.find(item => item.id === named.itemId);
  assert.equal(resolved?.messageId, "draft-content", "the exact lookup returns the drafter's result");
  assert.equal(f.projections.get(named.threadId)!.turnItems!.some(item => item.id === "draft-content"), false, "the message ID is no item");
  assert.equal(ready.draft?.ownerNotice?.text, notice.text);
  const release = {...f.args, action: "release", operationId: "release-draft", attemptId: paused.attempt.attemptId, resolution: "no_plan"};
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

it.effect("an uncertain hold or release keeps its stored bytes and identities: never resent or re-rendered, only reconciled; new deliveries use the new texts", () => Effect.gen(function* () {
  const sent: Record<string, unknown>[] = [];
  const rpc: NativeRpcShape = {call: () => Effect.die(new Error("admitted initiation only")), initiate: (_tag, payload) => {
    sent.push({...payload});return Effect.succeed({sent: Effect.succeed(true), release: Effect.void, result: Effect.succeed({sequence: sent.length})});
  }};
  const f = yield* fixture(rpc);
  const now = yield* Clock.currentTimeMillis;
  const main = f.projections.get("main")!;
  const attempt = (id: string) => createPlanningAttempt({id, operationId: `${id}-operation`, projectId: "project", mainThreadId: "main",
    ownerThreadId: f.binding.threadId, bindingGeneration: f.binding.generation, taskId: f.task.id, taskRevision: f.task.sourceHash,
    reason: "Prepare the plan", createdAt: now, timeoutMs: 60_000, targets: [{threadId: "main", recipientThreadId: "main", scope: "implementation"}]});
  const stored = () => Effect.map(f.stores.requests.planningAttempts("project"), rows => rows.find(row => row.id === "legacy-pause")!);
  // a hold an earlier version attempted with its own wording, whose outcome is unknown
  const legacyHold = "The Supervisor is preparing a plan: Prepare the plan\nPlanning pause legacy-pause; scope: implementation. Deadline: earlier wording.";
  const begun = startPlanningAttempt(attempt("legacy-pause"), now);
  const hold = {...begun.targets[0]!.hold, state: "uncertain" as const, attemptedAt: now, text: legacyHold};
  yield* f.stores.requests.savePlanningAttempt({...begun, targets: [{...begun.targets[0]!, hold}]});
  const server = (id: string, text: string) => ({id, threadId: "main", runId: "source-run", nodeId: "source-node", role: "user" as const, streaming: false,
    text, creationSource: "server", createdBy: "system", createdAt: "2026-10-27T12:01:02Z", updatedAt: "2026-10-27T12:01:02Z"});
  yield* f.controller.reconcile(f.binding);
  assert.equal(sent.length, 0, "an uncertain hold is never sent again");
  // the same message identity carrying today's rendering is not the stored hold
  const observed = server(hold.messageId, planningHoldText(begun, begun.targets[0]!));
  main.messages.push(observed);
  yield* f.controller.reconcile(f.binding);
  assert.deepEqual((yield* stored()).targets[0]!.hold, hold, "only the stored bytes confirm it");
  observed.text = legacyHold;
  yield* f.controller.reconcile(f.binding);
  assert.deepEqual((yield* stored()).targets[0]!.hold, {...hold, state: "sent"});
  assert.equal(sent.length, 0);
  // the store refuses to replace attempted bytes with a re-rendering
  const confirmed = yield* stored();
  const rerendered = yield* Effect.flip(f.stores.requests.savePlanningAttempt({...confirmed, targets: [{...confirmed.targets[0]!,
    hold: {...confirmed.targets[0]!.hold, text: planningHoldText(confirmed, confirmed.targets[0]!)}}]}));
  assert.equal((rerendered as {row?: string}).row, "planning_attempt_identity");
  // a release an earlier version attempted with its own wording, whose outcome is unknown: neither the owner's pass nor the watchdog resends it
  const releasing = resolvePlanningAttempt(confirmed, "no_plan", now + 1);
  const legacyRelease = "Planning pause legacy-pause is released for implementation: a shared plan is not needed. Earlier wording.";
  const release = {...releasing.targets[0]!.release!, state: "uncertain" as const, attemptedAt: now + 1, text: legacyRelease};
  yield* f.stores.requests.savePlanningAttempt({...releasing, targets: [{...releasing.targets[0]!, release}]});
  yield* f.controller.reconcile(f.binding);
  yield* TestClock.adjust("3 seconds");
  assert.equal(sent.length, 0, "an uncertain release is never sent again");
  const observedRelease = server(release.messageId, planningReleaseText(releasing, releasing.targets[0]!));
  main.messages.push(observedRelease);
  yield* f.controller.reconcile(f.binding);
  assert.deepEqual((yield* stored()).targets[0]!.release, release);
  assert.equal((yield* stored()).state, "releasing");
  observedRelease.text = legacyRelease;
  yield* f.controller.reconcile(f.binding);
  const released = yield* stored();
  assert.deepEqual(released.targets[0]!.release, {...release, state: "sent"});
  assert.equal(released.targets[0]!.state, "released");
  assert.equal(released.state, "resolved");
  assert.equal(sent.length, 0);
  // a new attempt's first delivery uses the current text under its own stored identities
  const fresh = attempt("fresh-pause");
  yield* f.stores.requests.savePlanningAttempt(fresh);
  yield* f.controller.reconcile(f.binding);
  const [dispatch] = sent;
  const anchored = (yield* f.stores.requests.planningAttempts("project")).find(row => row.id === "fresh-pause")!;
  assert.equal(sent.length, 1);
  assert.deepEqual({commandId: dispatch!.commandId, messageId: dispatch!.messageId, text: dispatch!.text},
    {commandId: fresh.targets[0]!.hold.commandId, messageId: fresh.targets[0]!.hold.messageId, text: planningHoldText(anchored, anchored.targets[0]!)});
  assert.equal(anchored.targets[0]!.hold.text, dispatch!.text);
}));

it.effect("one successful jump replays without a second debit, and the next reach stays exhausted", () => Effect.gen(function* () {
  const r = yield* pendingReturn(() => {}, false, 1);
  const applied = (yield* r.f.controller.call(r.input)) as {status: string; reason?: string};
  assert.equal(applied.status, "applied", JSON.stringify(applied));
  const spent = (yield* r.f.states.get("project", "main"))!;
  const usage = (document: typeof spent) => {
    const node = planBackTos(document.plan).find(item => item.target === "work")!;
    const events = document.returnBudgets?.find(item => item.budgetId === node.budgetId)?.events ?? [];
    return {events, used: returnBudgetUsed(events)};
  };
  assert.equal(usage(spent).used, 1);
  assert.equal(spent.returns.find(item => item.returnId === r.input.returnId)?.state, "applied");
  const replay = (yield* r.f.controller.call(r.input)) as {status: string; reason?: string};
  assert.equal(replay.status, "applied", JSON.stringify(replay));
  const replayed = (yield* r.f.states.get("project", "main"))!;
  assert.equal(replayed.revision, spent.revision, "replaying the applied operation writes nothing");
  assert.equal(usage(replayed).used, 1);
  assert.equal(usage(replayed).events.filter(event => event.kind === "consumed").length, 1);

  const changed = planEntities(replayed.plan).filter(node => node.kind === "step" && node.localId !== "deliver");
  const progress = withOccurrenceStatuses(replayed.plan!, changed.map(node => ({nodeId: node.nodeId, status: "completed" as const})));
  assert.ok("plan" in progress);
  progress.plan.nodes = progress.plan.nodes.map(node => node.kind === "step" && node.localId === "review" ? {...node, contributorThreadIds: ["reviewer"]} : node);
  const again = yield* r.f.states.apply(r.owner, {operationId: "second-pass", workflowId: replayed.workflowId, expectedRevision: replayed.revision,
    status: "underway", objective: replayed.objective, sourceBinding: replayed.sourceBinding!, requirements: [], issues: [], plan: progress.plan,
    note: "The repeated pass returned findings.", evidence: changed.map(node => ({kind: "status_changed" as const, targetNodeId: node.nodeId, note: "This pass completed."}))},
  r.advance, r.now + 10);
  assert.equal(again.status, "applied", JSON.stringify(again));
  const progressed = (yield* r.f.states.get("project", "main"))!;
  const branch = planBranches(progressed.plan)[0]!;
  assert.equal((yield* r.f.states.recordBranchSelection(r.owner, {nodeId: branch.nodeId, revision: 2, path: "then",
    reason: "The report still requires corrections.", sourceThreadId: "main", sourceRunId: "source-run", sourceMessageId: "decision-again",
    sourceCreatedAt: r.now + 11}, r.now + 11)).status, "applied");
  const exhausted = (yield* r.f.states.get("project", "main"))!;
  const row = exhausted.returns.find(item => item.state === "exhausted" && item.resolvedAt === null);
  assert.ok(row, JSON.stringify(exhausted.returns.map(item => [item.state, item.resolvedAt])));
  assert.equal(usage(exhausted).used, 1);
  const retry = {...r.input, operationId: "return-again", expectedRevision: exhausted.revision, returnId: row.returnId};
  r.f.proof(retry);
  const refused = (yield* r.f.controller.call(retry)) as {status: string; reason?: string};
  assert.equal(refused.reason, "return_not_pending", JSON.stringify(refused));
  const after = (yield* r.f.states.get("project", "main"))!;
  assert.equal(after.revision, exhausted.revision, "an exhausted refusal writes nothing");
  assert.equal(usage(after).used, 1);
}));
