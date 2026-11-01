import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { createHash } from "node:crypto";
import { Console, Context, Deferred, Effect, Fiber } from "effect";
import type { SqlClient } from "effect/sql";
import type { ConversationRequest } from "../src/supervisor-conversation-store.js";
import { SupervisorRpcError } from "../src/supervisor-native.js";
import { workflowIntroductionText } from "../src/supervisor-conversation.js";
import { SupervisionScopeService } from "../src/supervision-gate.js";
import { WorkflowNativeAccess, WorkflowWriteController } from "../src/workflow-write-controller.js";
import type { Projection } from "../src/types.js";
import { atWallTime, execute, query, rejectionOf, within } from "./support/g1b-conversation.js";
import { recordReview, rootNative } from "./support/review-record.js";
import {
  addCommandActivity, appendMessageToRun, proceed, appendNoticeToOperative, appendOperativeAcceptance, appendSupervisorProposal, baseTime, completeRun,
  makeFixture, observeAgreement, operativeThreadId, projectId, setNow, workflowRecord, type Fixture, type FixtureClock, type RpcCall,
} from "./support/c1-conversation-fixture.js";

// the cases are Effect tests on the production conversation, admission gate and stores over real files in a temporary
// directory, with the fake T3 as an effect fake; the suite clock moves the services' test clock as the baseline mocked Date.now
// did, and a call's baseline `now` is its wall time; the baseline per-call abort deadlines (the observations' 5 s, the Stop
// notice cases' 10 s and the fixture run's shared 10 s) are gone with the signal parameter: they were hang guards, which each
// case's 10 s bound and the 3 s live-clock bounds of its awaited events still cover

const isCheckIn = (fixture: Fixture) => (call: RpcCall) => call.payload.type === "message.dispatch" && call.payload.threadId === fixture.binding.threadId;

// a fixture with a sent introduction and three due command activities, observed into the monitor
const dueCheckIn = (clock: FixtureClock, idle = false) => Effect.gen(function* () {
  yield* setNow(clock, clock.now);
  const fixture = yield* makeFixture(clock, {settings: {intervalMinutes: 2, activityThreshold: 3}});
  yield* appendNoticeToOperative(fixture);
  if (idle) for (const run of fixture.operative.runs.filter(run => run.status === "running")) completeRun(fixture.operative, run, "The operative work is quiet.", clock.now - 1);
  if (idle) fixture.operative.thread.activityRunStatus = "completed";
  for (let index = 1; index <= 3; index++) addCommandActivity(fixture.operative, `command-${index}`, `PRIVATE_COMMAND_BODY_${index}`, clock.now - index * 1_000);
  yield* fixture.conversation.observe(fixture.threadList).pipe(atWallTime(clock.now));
  return fixture;
});

const isIntroduction = (fixture: Fixture) => (call: RpcCall) => call.payload.type === "message.dispatch" && call.payload.threadId === operativeThreadId &&
  String(call.payload.messageId).startsWith(`supervisor-notice:workflow:${fixture.task.id}`);

const reviewState = (sql: SqlClient.SqlClient, supervisorThreadId: string, requestId: string) => Effect.gen(function* () {
  const [request] = yield* query(sql, "SELECT document FROM supervisor_conversation_requests WHERE id=?", requestId);
  const [binding] = yield* query(sql, "SELECT document FROM supervisor_main_bindings WHERE main_thread_id=?", operativeThreadId);
  const [clock] = yield* query(sql, "SELECT review_misses FROM supervisor_monitor_binding_clock WHERE supervisor_thread_id=?", supervisorThreadId);
  const acknowledged = yield* query(sql, "SELECT item_id FROM supervisor_monitor_items WHERE project_id=? AND thread_id=? AND reviewed_version=version ORDER BY item_id", projectId, operativeThreadId);
  const document = JSON.parse(String(request?.document)) as {state: string; error: string | null; runId: string | null};
  return {state: document.state, error: document.error, runId: document.runId,
    deliveredRoleVersion: (JSON.parse(String(binding?.document)) as {deliveredRoleVersion?: string}).deliveredRoleVersion ?? null,
    reviewMisses: Number(clock?.review_misses), acknowledged: acknowledged.map(row => String(row.item_id))};
});

// the root records a review's outcome with workflow_write record_review in the review's own run, through the production controller
// over this process's services; workflow editing needs the catalog classifications read first, which a supervision cycle does
const recordOutcome = (fixture: Fixture, root: Projection, request: ConversationRequest) => Effect.gen(function* () {
  yield* Context.get(fixture.process.context, SupervisionScopeService).rememberCatalog([], fixture.threadList);
  const controller = yield* WorkflowWriteController.make({withoutTeam: true, maxEvidenceWaitMs: 0}).pipe(
    Effect.provideService(WorkflowNativeAccess, rootNative(root, () => fixture.threadList)), Effect.provide(fixture.process.context));
  return yield* recordReview(controller, root, request, "no_change");
});

const waitingReview = (clock: FixtureClock) => Effect.gen(function* () {
  const fixture = yield* dueCheckIn(clock);
  yield* fixture.run;
  const request = yield* fixture.requests.pending(projectId, fixture.binding.threadId);
  // the first wake of an instructions version carries the full root notice and names that version to confirm; the binding records it
  // as delivered only through a confirmed completion, so it stays undelivered until then
  const version = String((yield* fixture.conversation.readContextView(fixture.binding, {view: "instructions"})).version);
  assert.ok(request?.kind === "review" && request.state === "waiting" && request.batch);
  assert.equal(request.roleVersion, version, "the first wake carries the current instructions version to confirm");
  const run = fixture.supervisor.runs.find(item => item.userMessageId === request.messageId);
  assert.ok(run);
  return {fixture, request, run, version};
});

it.effect("CT-CONV-04: a failure at the monitor acknowledgement rolls back completion and the miss reset, also after reopen", () => Effect.gen(function* () {
  const clock = {now: baseTime};
  const {fixture, request, run, version} = yield* waitingReview(clock);
  yield* fixture.requests.missedReview(fixture.binding.threadId);
  assert.equal((yield* recordOutcome(fixture, fixture.supervisor, request)).status, "recorded");
  completeRun(fixture.supervisor, run, `No intervention is needed. ${request.completionMarker}`, clock.now + 1);
  yield* setNow(clock, clock.now + 1);
  const before = {state: "waiting", error: null, runId: run.id, deliveredRoleVersion: null, reviewMisses: 1, acknowledged: []};
  const pendingBefore = (yield* fixture.monitor.pending(projectId, operativeThreadId)).map(item => item.id);
  assert.ok(["command-1", "command-2", "command-3"].every(id => pendingBefore.includes(id)));
  yield* execute(fixture.sql, "CREATE TEMP TRIGGER c1_fail_acknowledgement BEFORE UPDATE OF reviewed_version ON supervisor_monitor_items BEGIN SELECT RAISE(ABORT, 'c1 injected acknowledgement failure'); END");
  assert.match(String(yield* rejectionOf(fixture.run)), /guidance store sql failed: ConstraintError/u);
  assert.deepEqual(yield* reviewState(fixture.sql, fixture.binding.threadId, request.id), before);
  const reopened = yield* fixture.reopen;
  assert.deepEqual(yield* reviewState(reopened.sql, fixture.binding.threadId, request.id), before);
  assert.deepEqual((yield* reopened.monitor.pending(projectId, operativeThreadId)).map(item => item.id), pendingBefore);

  // the same reconcile succeeds once the failure is gone: the confirmed completion also records the carried version as delivered, in
  // the same section as the completion, the miss reset and the acknowledgement (the rolled-back attempt above left it undelivered)
  yield* execute(fixture.sql, "DROP TRIGGER c1_fail_acknowledgement");
  yield* fixture.run;
  const completed = yield* reviewState(fixture.sql, fixture.binding.threadId, request.id);
  assert.deepEqual(completed, {state: "completed", error: null, runId: run.id, deliveredRoleVersion: version, reviewMisses: 0,
    acknowledged: [...pendingBefore].sort()});
  assert.deepEqual(yield* fixture.monitor.pending(projectId, operativeThreadId), []);
}), {timeout: 10_000});

it.effect("a confirmed check-in cannot acknowledge a role notice from before its compaction", () => Effect.gen(function* () {
  const clock = {now: baseTime};
  const {fixture, request, run} = yield* waitingReview(clock);
  yield* fixture.projectStore.recordCompaction(fixture.binding, {itemId: "completed-compaction", runId: run.id, runOrdinal: run.ordinal, itemOrdinal: 1});
  assert.equal((yield* recordOutcome(fixture, fixture.supervisor, request)).status, "recorded");
  completeRun(fixture.supervisor, run, `No intervention needed. ${request.completionMarker}`, clock.now + 1);
  yield* setNow(clock, clock.now + 1);
  yield* fixture.run;
  assert.equal((yield* fixture.projectStore.binding(projectId, operativeThreadId))?.deliveredRoleVersion, undefined);
  const next = (yield* fixture.conversation.rootWake(fixture.binding))!;
  assert.ok(next.roleVersion && next.roleVersion !== request.roleVersion);
  assert.match(next.text, /Context compacted: reread core\/index/u);
}));

it.effect("CT-CONV-04: a failure after the miss increment rolls back the counter and the request state, also after reopen", () => Effect.gen(function* () {
  const clock = {now: baseTime};
  const {fixture, request, run} = yield* waitingReview(clock);
  completeRun(fixture.supervisor, run, "The completed review omitted its required marker.", clock.now + 1);
  yield* setNow(clock, clock.now + 1);
  const before = {state: "waiting", error: null, runId: run.id, deliveredRoleVersion: null, reviewMisses: 0, acknowledged: []};
  yield* execute(fixture.sql, `CREATE TEMP TRIGGER c1_fail_close BEFORE UPDATE ON supervisor_conversation_requests
    WHEN json_extract(NEW.document,'$.state') IN ('completed','failed') BEGIN SELECT RAISE(ABORT, 'c1 injected close failure'); END`);
  assert.match(String(yield* rejectionOf(fixture.run)), /guidance store sql failed: ConstraintError/u);
  assert.deepEqual(yield* reviewState(fixture.sql, fixture.binding.threadId, request.id), before);
  const reopened = yield* fixture.reopen;
  assert.deepEqual(yield* reviewState(reopened.sql, fixture.binding.threadId, request.id), before);

  // a completion without its marker is a miss: it closes the request but confirms nothing, so the carried version stays undelivered
  yield* execute(fixture.sql, "DROP TRIGGER c1_fail_close");
  yield* fixture.run;
  assert.deepEqual(yield* reviewState(fixture.sql, fixture.binding.threadId, request.id), {state: "completed",
    error: "The check-in output was not confirmed; pending activity will be checked again after the cooldown.", runId: run.id,
    deliveredRoleVersion: null, reviewMisses: 1, acknowledged: []});
}), {timeout: 10_000});

// the lines a call logs, one per Console.log call, on the current console with a recording log
const loggedLines = <A, E, R>(effect: Effect.Effect<A, E, R>) => Console.consoleWith((console) => {
  const lines: unknown[][] = [];
  return Effect.as(Effect.provideService(effect, Console.Console, {...console, log: (...values: unknown[]) => {lines.push(values);}}), lines);
});

it.effect("CT-CONV-09: a non-applied workflow agreement import logs one event with its status only", () => Effect.gen(function* () {
  const clock = {now: baseTime};
  yield* setNow(clock, clock.now);
  const fixture = yield* makeFixture(clock);
  // an incompatible stored workflow-state document makes the import report 'incompatible'
  yield* execute(fixture.sql, `INSERT INTO supervisor_workflow_state(workflow_id,project_id,main_thread_id,thread_id,parent_workflow_id,parent_thread_id,
    revision,document,created_at,updated_at) VALUES(?,?,?,?,NULL,NULL,1,?,?,?)`, "legacy-workflow", projectId, operativeThreadId, operativeThreadId,
    JSON.stringify({formatVersion: 1}), clock.now, clock.now);
  yield* appendNoticeToOperative(fixture);
  yield* appendSupervisorProposal(fixture, fixture.task.id, undefined, clock.now);
  yield* appendOperativeAcceptance(fixture, workflowRecord(fixture.task, fixture.task.id), clock.now + 1);
  const lines = yield* loggedLines(observeAgreement(fixture, clock.now + 30_000));
  assert.equal((yield* fixture.projectStore.task(operativeThreadId))?.agreement?.status, "agreed");
  assert.deepEqual(lines, [[JSON.stringify({event: "workflow_agreement_import_unavailable", status: "incompatible"})]]);
}), {timeout: 10_000});

// a sent introduction for a task of another binding, visible in its main
const introduceBound = (fixture: Fixture, bound: Effect.Success<ReturnType<Fixture["addBoundOperative"]>>) => Effect.gen(function* () {
  const introduction = {taskId: bound.task.id, projectId, threadId: bound.task.threadId, supervisorThreadId: bound.binding.threadId, state: "sent" as const,
    text: workflowIntroductionText(bound.task), messageId: `supervisor-notice:workflow:${bound.task.id}`, targetRunId: String(bound.projection.thread.activeRunId), error: null};
  yield* fixture.requests.saveIntroduction(introduction);
  const run = bound.projection.runs.find(item => item.id === introduction.targetRunId);
  assert.ok(run);
  appendMessageToRun(bound.projection, run, {id: introduction.messageId, role: "user", text: introduction.text, createdBy: "user", creationSource: "server"});
});

it.effect("CT-CONV-06: interleaved cycles of two bindings keep request identities and cooldown clocks apart and never acknowledge across bindings", () => Effect.gen(function* () {
  const start = baseTime;
  const clock = {now: start};
  yield* setNow(clock, clock.now);
  const fixture = yield* makeFixture(clock, {settings: {intervalMinutes: 2, activityThreshold: 3}});
  const second = yield* fixture.addBoundOperative("operative-b", "proposal-b");
  yield* appendNoticeToOperative(fixture);
  yield* introduceBound(fixture, second);
  for (const projection of [fixture.operative, second.projection])
    for (const run of projection.runs.filter(run => run.status === "running")) completeRun(projection, run, "The operative work is quiet.", clock.now - 1);
  for (const projection of [fixture.operative, second.projection]) projection.thread.activityRunStatus = "completed";
  for (let index = 1; index <= 3; index++) {
    addCommandActivity(fixture.operative, `a-command-${index}`, `A_BODY_${index}`, clock.now - index * 1_000);
    addCommandActivity(second.projection, `b-command-${index}`, `B_BODY_${index}`, clock.now - index * 1_000);
  }
  yield* fixture.conversation.observe(fixture.threadList).pipe(atWallTime(clock.now));
  const supervisors = new Set([fixture.binding.threadId, second.binding.threadId]);
  const held = new Map<string, Deferred.Deferred<unknown>>();
  const reached = new Map<string, Deferred.Deferred<void>>();
  for (const id of supervisors) reached.set(id, yield* Deferred.make<void>());
  fixture.intercept(call => {
    const target = String(call.payload.threadId);
    if (call.payload.type !== "message.dispatch" || !supervisors.has(target)) return null;
    return Effect.gen(function* () {
      const gate = yield* Deferred.make<unknown>();
      held.set(target, gate);
      yield* Deferred.succeed(reached.get(target)!, undefined);
      return yield* Deferred.await(gate);
    });
  });
  // the first cycle is parked at its POST while the second binding's cycle and an observation run
  const firstCycle = yield* Effect.forkChild(fixture.run);
  yield* within(Deferred.await(reached.get(fixture.binding.threadId)!), 3_000, "first check-in");
  yield* setNow(clock, start + 10_000);
  const observing = yield* Effect.forkChild(fixture.conversation.observe(fixture.threadList).pipe(atWallTime(clock.now)));
  const secondCycle = yield* Effect.forkChild(second.run);
  yield* within(Deferred.await(reached.get(second.binding.threadId)!), 3_000, "second check-in");
  const first = yield* fixture.requests.pending(projectId, fixture.binding.threadId);
  const other = yield* fixture.requests.pending(projectId, second.binding.threadId);
  assert.ok(first && other);
  assert.notEqual(first.id, other.id);
  assert.deepEqual([first.state, first.sentAt, other.state, other.sentAt], ["sending", start, "sending", start + 10_000]);
  assert.deepEqual(first.batch?.threads.map(thread => thread.threadId), [operativeThreadId]);
  assert.deepEqual(other.batch?.threads.map(thread => thread.threadId), ["operative-b"]);
  assert.equal(yield* fixture.requests.lastNotice(fixture.binding.threadId), start);
  assert.equal(yield* fixture.requests.lastNotice(second.binding.threadId), start + 10_000);
  // released in reverse order
  yield* Deferred.succeed(held.get(second.binding.threadId)!, proceed);
  yield* within(Fiber.join(secondCycle), 3_000, "second cycle");
  assert.equal((yield* fixture.requests.pending(projectId, fixture.binding.threadId))?.state, "sending");
  yield* Deferred.succeed(held.get(fixture.binding.threadId)!, proceed);
  yield* within(Effect.all([Fiber.join(firstCycle), Fiber.join(observing)]), 3_000, "first cycle");
  assert.equal((yield* fixture.requests.pending(projectId, fixture.binding.threadId))?.state, "waiting");
  assert.equal((yield* fixture.requests.pending(projectId, second.binding.threadId))?.state, "waiting");

  // completing only the first review acknowledges only its own frozen batch
  const firstRun = fixture.supervisor.runs.find(run => run.userMessageId === first.messageId);
  assert.ok(firstRun);
  assert.equal((yield* recordOutcome(fixture, fixture.supervisor, first)).status, "recorded");
  completeRun(fixture.supervisor, firstRun, `No intervention is needed. ${first.completionMarker}`, start + 20_000);
  yield* setNow(clock, start + 20_000);
  yield* fixture.run;
  yield* second.run;
  assert.equal((yield* fixture.requests.requests(projectId)).find(item => item.id === first.id)?.state, "completed");
  assert.equal((yield* fixture.requests.pending(projectId, second.binding.threadId))?.id, other.id);
  assert.deepEqual(yield* fixture.monitor.pending(projectId, operativeThreadId), []);
  assert.ok((yield* Effect.forEach(["b-command-1", "b-command-2", "b-command-3"], id => Effect.map(fixture.monitor.pending(projectId, "operative-b"), items => items.some(item => item.id === id)))).every(Boolean));
  const otherRun = second.supervisor.runs.find(run => run.userMessageId === other.messageId);
  assert.ok(otherRun);
  assert.equal((yield* recordOutcome(fixture, second.supervisor, other)).status, "recorded");
  completeRun(second.supervisor, otherRun, `No intervention is needed. ${other.completionMarker}`, start + 20_001);
  yield* setNow(clock, start + 20_001);
  yield* second.run;
  assert.deepEqual(yield* fixture.monitor.pending(projectId, "operative-b"), []);

  // each binding's cooldown runs from its own last notice
  for (let index = 4; index <= 6; index++) {
    addCommandActivity(fixture.operative, `a-command-${index}`, `A_BODY_${index}`, start + 25_000 + index);
    addCommandActivity(second.projection, `b-command-${index}`, `B_BODY_${index}`, start + 25_000 + index);
  }
  yield* setNow(clock, start + 30_000);
  yield* fixture.conversation.observe(fixture.threadList).pipe(atWallTime(clock.now));
  fixture.intercept(null);
  const checkIns = (supervisorThreadId: string) => fixture.calls.filter(call => call.payload.threadId === supervisorThreadId).length;
  yield* setNow(clock, start + 30_000);
  yield* fixture.run;
  yield* second.run;
  assert.deepEqual([checkIns(fixture.binding.threadId), checkIns(second.binding.threadId)], [2, 1]);
  yield* setNow(clock, start + 40_000);
  yield* second.run;
  assert.deepEqual([checkIns(fixture.binding.threadId), checkIns(second.binding.threadId)], [2, 2]);
}), {timeout: 10_000});

const tableDigest = (sql: SqlClient.SqlClient) => Effect.gen(function* () {
  const hash = createHash("sha256");
  for (const {name} of yield* query(sql, "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"))
    hash.update(`${String(name)}\0${JSON.stringify(yield* query(sql, `SELECT * FROM "${String(name)}" ORDER BY rowid`))}\0`);
  return hash.digest("hex");
});
const totalChanges = (sql: SqlClient.SqlClient) => Effect.map(query(sql, "SELECT total_changes() AS n"), ([row]) => Number(row?.n));

it.effect("CT-CONV-07: an enabled binding without an inferred task or activity makes no native call and no write in run() and observe()", () => Effect.gen(function* () {
  const clock = {now: baseTime};
  yield* setNow(clock, clock.now);
  const fixture = yield* makeFixture(clock, {task: false});
  const digest = yield* tableDigest(fixture.sql);
  const changes = yield* totalChanges(fixture.sql);
  const reads = fixture.projectionReads.length;
  for (let cycle = 0; cycle < 3; cycle++) {
    yield* fixture.run;
    yield* fixture.conversation.observe(fixture.threadList).pipe(atWallTime(clock.now));
    yield* setNow(clock, clock.now + 61_000);
  }
  assert.deepEqual(fixture.calls, []);
  assert.equal(fixture.projectionReads.length, reads);
  assert.equal(yield* totalChanges(fixture.sql), changes);
  assert.equal(yield* tableDigest(fixture.sql), digest);
}), {timeout: 10_000});

it.effect("CT-CONV-08: an idle check-in is withheld at lastNotice+29999 ms and dispatched at lastNotice+30000 ms", () => Effect.gen(function* () {
  const start = baseTime;
  const clock = {now: start};
  const fixture = yield* dueCheckIn(clock, true);
  yield* fixture.run;
  const first = yield* fixture.requests.pending(projectId, fixture.binding.threadId);
  assert.ok(first);
  assert.equal(yield* fixture.requests.lastNotice(fixture.binding.threadId), start);
  const run = fixture.supervisor.runs.find(item => item.userMessageId === first.messageId);
  assert.ok(run);
  completeRun(fixture.supervisor, run, `No intervention is needed. ${first.completionMarker}`, start + 1);
  yield* setNow(clock, start + 1);
  yield* fixture.run;
  assert.equal(yield* fixture.requests.pending(projectId, fixture.binding.threadId), null);
  for (let index = 4; index <= 6; index++) addCommandActivity(fixture.operative, `command-${index}`, `PRIVATE_COMMAND_BODY_${index}`, start + 2);
  yield* fixture.conversation.observe(fixture.threadList).pipe(atWallTime(start + 5_001));
  const checkIns = () => fixture.calls.filter(isCheckIn(fixture)).length;
  yield* setNow(clock, start + 29_999);
  yield* fixture.run;
  assert.equal(checkIns(), 1);
  assert.equal(yield* fixture.requests.pending(projectId, fixture.binding.threadId), null);
  yield* setNow(clock, start + 30_000);
  yield* fixture.run;
  assert.equal(checkIns(), 2);
  assert.equal((yield* fixture.requests.pending(projectId, fixture.binding.threadId))?.sentAt, start + 30_000);
}), {timeout: 10_000});

it.effect("CT-CONV-08: an unseen uncertain Stop notice is next observed exactly 60000 ms after its deferral", () => Effect.gen(function* () {
  const clock = {now: baseTime};
  yield* setNow(clock, clock.now);
  const fixture = yield* makeFixture(clock);
  yield* appendNoticeToOperative(fixture);
  const {supervisor: service} = yield* fixture.makeProjectSupervisor;
  yield* service.setChatSupervision({projectId, mainThreadId: operativeThreadId, enabled: false, policyGeneration: (yield* fixture.threadPolicy.get()).generation});
  fixture.intercept(call => call.payload.threadId === operativeThreadId ? Effect.fail(new SupervisorRpcError("uncertain")) : null);
  yield* fixture.conversation.reconcileStopNotice(fixture.binding);
  assert.equal((yield* fixture.projectStore.binding(projectId, operativeThreadId))?.stopNotice?.state, "uncertain");
  fixture.intercept(null);
  const deferredAt = clock.now;
  yield* fixture.conversation.reconcileStopNotice(fixture.binding);
  const deferred = (yield* fixture.projectStore.binding(projectId, operativeThreadId))?.stopNotice;
  assert.equal(deferred?.nextObserveAt, deferredAt + 60_000);
  assert.equal(deferred?.visibilityMisses, 1);
  const reads = () => fixture.projectionReads.filter(id => id === operativeThreadId).length;
  const before = reads();
  yield* setNow(clock, deferredAt + 59_999);
  yield* fixture.conversation.reconcileStopNotice(fixture.binding);
  assert.equal(reads(), before);
  yield* setNow(clock, deferredAt + 60_000);
  yield* fixture.conversation.reconcileStopNotice(fixture.binding);
  assert.equal(reads(), before + 1);
  assert.equal((yield* fixture.projectStore.binding(projectId, operativeThreadId))?.stopNotice?.nextObserveAt, deferredAt + 120_000);
  assert.equal(fixture.calls.filter(call => call.payload.threadId === operativeThreadId).length, 1);
}), {timeout: 10_000});

it.effect("CT-CONV-08: an accepted but invisible introduction blocks only after strictly more than 60000 ms and three misses", () => Effect.gen(function* () {
  const start = baseTime;
  const clock = {now: start};
  yield* setNow(clock, clock.now);
  const fixture = yield* makeFixture(clock);
  // T3 accepts the introduction, but it never becomes visible unchanged
  fixture.intercept(call => isIntroduction(fixture)(call) ? Effect.succeed({sequence: 1}) : null);
  yield* fixture.run;
  const accepted = yield* fixture.requests.introduction(fixture.task.id);
  assert.equal(accepted?.state, "accepted");
  assert.equal(accepted?.acceptedAt, start);
  const observeAt = (time: number) => Effect.gen(function* () {
    yield* setNow(clock, time);
    yield* fixture.run;
    const current = yield* fixture.requests.introduction(fixture.task.id);
    return [current?.state, current?.visibilityMisses];
  });
  assert.deepEqual(yield* observeAt(start + 1), ["accepted", 1]);
  assert.deepEqual(yield* observeAt(start + 2), ["accepted", 2]);
  assert.deepEqual(yield* observeAt(start + 60_000), ["accepted", 3]);
  assert.deepEqual(yield* observeAt(start + 60_001), ["blocked", 4]);
  assert.equal(fixture.calls.filter(isIntroduction(fixture)).length, 1);
}), {timeout: 10_000});
