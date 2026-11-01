import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Clock, Context, Deferred, Effect, Fiber } from "effect";
import { fingerprint } from "../src/guidance-store.js";
import type { ProjectDefinitionSnapshot } from "../src/project-definitions-contract.js";
import type { WorkflowProposalInfo } from "../src/project-supervisor-contract.js";
import type { TaskRecord } from "../src/project-supervisor-store.js";
import { compactionReminderText } from "../src/supervisor-compaction.js";
import { SupervisorConversation } from "../src/supervisor-conversation.js";
import type { ConversationRequest } from "../src/supervisor-conversation-store.js";
import { ProjectSupervisorMonitorStore } from "../src/supervisor-monitor-store.js";
import { SUPERVISOR_MONITOR_COOLDOWN_MS } from "../src/supervisor-monitor.js";
import { proposalContextFromDefinitions, validateWorkflowPlan } from "../src/supervisor-workflow.js";
import type { MessageInfo, Projection } from "../src/types.js";
import { planBranches, planEntities } from "../src/workflow-plan-tree.js";
import { workflowToolNames } from "../src/workflow-write-evidence.js";
import { effectiveIndex, projectIndex } from "./project-definitions-fixture.js";
import { engagedTask } from "./support/engaged-task.js";
import { operateToken, readToken, rows } from "./support/glinint-wiring.js";
import { httpRequests } from "./support/int-native-peer.js";
import {
  addDispatchedMessage, addTurn, atWallClock, baseTime, emitThreadEvent, installToolCall, mainThreadId, missingDefinitions, nativeWrites, projectId,
  projectionOf, routeOf, rpcRequests, seedIntroduction, startScenario, thread, threadSubscription, type Scenario,
} from "./support/scenario-driver.js";

/* One production-wire journey for each replay family the controller suites own below the wire (docs/testing.md, increment 4): child
 * activity, compaction events, duplicate prevention, and workflow returns with stale receipts. Each runs the production graph through
 * the replay scenario driver (support/scenario-driver.ts): native events arrive from the loopback T3 peer, and the case checks the
 * stored state, the native traffic per route, the identities sent and whom nothing reached. The family's controller suites keep the
 * races and boundaries a peer cannot order; each journey proves the sequence across the boundary, which none of them runs.
 * Native shapes the journeys rely on. Where the pinned T3's sanitized projection capture shows them (0.1.7-nightly.20261101.4016) the
 * driver follows it: a dispatched message recorded createdBy user with the server source (addDispatchedMessage and the steer below), a
 * workflow tool call as a dynamic_tool item on a tool_call node (installToolCall), and a served projection's thread without activeRunId,
 * so a root's activity is read from its published runs. The rest stay scripted from the suites, as no capture holds them: the
 * subscription snapshot and its turn-item.updated event with the client's Ack (supervisor-compaction.test.ts), a compaction item and
 * the steering capability evidence, a completed assistant reply (c1-conversation-fixture.ts completeRun), the thread T3 creates for a
 * launchThread (psx-supervisor.ts), the root's dynamic_tool item detail, and a delegated child's catalog thread and finished turn.
 * it.live: every journey crosses the peer's real HTTP and websocket sockets, the workflow MCP route and the real SQLite files; it
 * waits only on native arrivals and the client's acknowledgement of a published event. A wall-clock reading is passed to a cycle
 * only where a time policy (a child's re-read interval, the check-in cooldown) is the input, never to wait.
 */

const oldTurn = {id: "old-turn", text: "Earlier request before the boundary."};
const newTurn = {id: "new-turn", text: "Create a migration plan."};
const newRequest = {mainTurns: [oldTurn, newTurn]};
const newSource = {messageId: newTurn.id, runId: `run-${newTurn.id}`, ordinal: 2, text: newTurn.text};

const writes = (f: Scenario): string[] => nativeWrites(f.peer).map(routeOf);
const dispatches = (f: Scenario) => rpcRequests(f.peer, "orchestration.dispatchCommand");
const dispatched = (payload: Record<string, unknown>) => ({type: payload.type, commandId: payload.commandId, messageId: payload.messageId,
  threadId: payload.threadId, text: payload.text});
const taskRows = (f: Scenario) => Effect.map(rows(f.core.sql, "SELECT count(*) AS n FROM supervisor_task_interpretations WHERE thread_id=?", mainThreadId),
  ([found]) => Number(found?.n));

// the root's monitoring check-ins in the order they were prepared, on the current run
const checkIns = (f: Scenario, rootThreadId: string): Effect.Effect<ConversationRequest[]> => Effect.map(
  Effect.suspend(() => f.core.requests.requests(projectId, rootThreadId)).pipe(Effect.orDie), (found) => found.filter(request => request.kind === "review"));
const checkInSent = (request: ConversationRequest) => ({type: "message.dispatch", commandId: `supervisor-review:${request.id}`, messageId: request.messageId,
  threadId: request.supervisorThreadId, text: request.text});
// the run activity of each chat a check-in froze
const frozen = (request: ConversationRequest): Record<string, string[]> => Object.fromEntries((request.batch?.threads ?? [])
  .map(chat => [chat.threadId, chat.items.map(item => item.id).filter(id => id.startsWith("run:")).sort()] as const).filter(([, ids]) => ids.length));
// the run activity of a chat the monitor holds unacknowledged, on the current run
const pendingRuns = (f: Scenario, threadId: string): Effect.Effect<string[]> => Effect.map(
  Effect.suspend(() => Context.get(f.core.context, ProjectSupervisorMonitorStore).pending(projectId, threadId)).pipe(Effect.orDie),
  (items) => items.map(item => item.id).filter(id => id.startsWith("run:")).sort());

// the interpreted task with its source-bound proposal, introduced to the main
const introduced = (f: Scenario) => Effect.gen(function* () {
  const {task, introduction} = yield* seedIntroduction(f, newSource);
  yield* f.core.requests.saveIntroduction({...introduction, state: "sent"}).pipe(Effect.orDie);
  return task;
});

// a delegated child of the main, created after the request, as T3 lists and serves it
const delegatedChild = (f: Scenario, id: string): Projection => {
  const child = projectionOf({...thread(id, mainThreadId, "subagent"), creationSource: "mcp", createdAt: "2026-10-13T10:05:00.000Z"});
  f.peer.projections.set(id, child);
  f.threads.push(child.thread);
  return child;
};

// the peer completes a running turn now, on the case's clock, with the assistant's final reply (the completed-reply shape of c1-conversation-fixture.ts)
const completeTurn = (projection: Projection, runId: string, text: string) => Effect.map(Clock.currentTimeMillis, (millis) => {
  const run = projection.runs.find(value => value.id === runId)!;
  const now = new Date(millis).toISOString();
  run.status = "completed";
  run.completedAt = now;
  const nodes = projection.nodes as Array<Record<string, unknown>>;
  const root = nodes.find(node => node.id === run.rootNodeId);
  if (root) root.status = "completed";
  const nodeId = `${runId}-reply-node`;
  nodes.push({id: nodeId, threadId: projection.thread.id, runId, parentNodeId: run.rootNodeId, rootNodeId: run.rootNodeId, kind: "assistant_message",
    status: "completed", providerThreadId: run.providerThreadId});
  projection.messages.push({id: `${runId}-reply`, threadId: projection.thread.id, runId, nodeId, role: "assistant", text, streaming: false, createdAt: now,
    updatedAt: now} as MessageInfo);
});

// ---- child activity ----

/* The cycle reads its scope and sends first and observes the scope last, so a child's finished run is checkpointed by one cycle and
 * reaches the root in the next. Planted fault for this journey: the cycle no longer observes the scope (EXPECTED.md, child activity).
 */
it.live("child activity: a delegated child's finished run reaches the root as one check-in; the root's own outcome record and completion acknowledge exactly its frozen batch, activity that arrived meanwhile gets the next check-in after the cooldown, and nothing is sent twice, also across a restart", () => Effect.gen(function* () {
  const f = yield* startScenario(newRequest);
  const binding = yield* f.bindSupervisor;
  const root = yield* f.supervisor;
  yield* introduced(f);
  // the peer starts a turn of the root for each check-in it accepts, as it does for a server message.dispatch
  const reviewRuns: string[] = [];
  f.peer.onRpc = (entry) => Effect.sync(() => {
    if (entry.tag === "orchestration.dispatchCommand" && entry.payload.type === "message.dispatch" && entry.payload.threadId === binding.threadId)
      reviewRuns.push(addDispatchedMessage(root, entry.payload, "running"));
    return undefined;
  });
  const worker = delegatedChild(f, "worker");
  addTurn(worker, {id: "worker-1", text: "Implement the parser.", createdAt: "2026-10-13T10:06:00.000Z"});

  // the first cycle only checkpoints the activity it read on the read credential
  yield* f.runOnce;
  assert.deepEqual(writes(f), [], "the first cycle contacts nobody");
  assert.deepEqual(yield* pendingRuns(f, "worker"), ["run:run-worker-1"]);
  const childReads = httpRequests(f.peer, "/api/orchestration/threads/worker");
  assert.ok(childReads.length >= 1 && childReads.every(entry => entry.authorization === `Bearer ${readToken}`), "the child is read natively");

  // the next cycle sends the root one check-in that freezes the batch; nothing reaches the main or the child
  yield* f.runOnce;
  const [first] = yield* checkIns(f, binding.threadId);
  assert.ok(first, "one check-in");
  assert.ok(first.batch, "with a frozen batch");
  assert.equal(first.state, "waiting");
  assert.deepEqual(dispatches(f).map(entry => dispatched(entry.payload)), [checkInSent(first)]);
  assert.equal(dispatches(f)[0]!.authorization, `Bearer ${operateToken}`);
  assert.deepEqual(dispatches(f)[0]!.payload.dispatchMode, {type: "queue_after_active"});
  assert.deepEqual(frozen(first).worker, ["run:run-worker-1"]);
  assert.ok(first.batch.threads.some(chat => chat.threadId === mainThreadId), "the main's own finished run rides the same batch");

  /* The child finishes another run while the root reviews; a child is re-read at most every 5 s of wall clock, so this cycle reads
   * the clock 10 s on to see it. The busy root gets nothing new.
   */
  addTurn(worker, {id: "worker-2", text: "Add the parser tests.", createdAt: "2026-10-13T10:08:00.000Z"});
  yield* atWallClock((yield* Clock.currentTimeMillis) + 10_000)(f.runOnce);
  assert.deepEqual(yield* pendingRuns(f, "worker"), ["run:run-worker-1", "run:run-worker-2"]);
  assert.equal(dispatches(f).length, 1);
  assert.equal((yield* checkIns(f, binding.threadId))[0]!.runId, reviewRuns[0], "the check-in matched the turn T3 started for it");

  // the root records its outcome through its own native call in the review's turn, then ends the turn with the marker
  const record = {action: "record_review", supervisorThreadId: binding.threadId, bindingGeneration: binding.generation,
    operationId: `record-review:${first.id}`, requestId: first.id, outcome: "no_change"};
  installToolCall(f, root, workflowToolNames.write.direct[0], record, {runId: reviewRuns[0]!});
  const recorded = yield* f.mcp("workflow_write", record);
  assert.equal(recorded.isError, false, JSON.stringify(recorded.value));
  assert.deepEqual(recorded.value, {status: "recorded", operationId: record.operationId, requestId: first.id, outcome: "no_change"});
  yield* completeTurn(root, reviewRuns[0]!, `No intervention is needed. ${first.completionMarker}`);
  yield* f.runOnce;
  const completed = (yield* checkIns(f, binding.threadId))[0]!;
  assert.equal(completed.state, "completed");
  assert.equal(completed.error, null);
  assert.equal(completed.reviewOutcome?.state, "confirmed");
  assert.deepEqual(yield* pendingRuns(f, mainThreadId), [], "the frozen main activity is acknowledged");
  assert.deepEqual(yield* pendingRuns(f, "worker"), ["run:run-worker-2"], "only the frozen batch is acknowledged; the arrival stays pending");
  assert.equal(dispatches(f).length, 1);

  // after the cooldown the arrival gets its own check-in, carrying none of the acknowledged activity
  const noticeAt = yield* f.core.requests.lastNotice(binding.threadId).pipe(Effect.orDie);
  assert.equal(noticeAt, first.sentAt, "the sent check-in started the root's cooldown");
  yield* atWallClock(noticeAt! + SUPERVISOR_MONITOR_COOLDOWN_MS)(f.runOnce);
  const [, second] = yield* checkIns(f, binding.threadId);
  assert.ok(second, "one more check-in");
  assert.deepEqual(frozen(second), {worker: ["run:run-worker-2"]});
  assert.deepEqual(dispatches(f).map(entry => dispatched(entry.payload)), [checkInSent(first), checkInSent(second)]);

  // the reopened run keeps the checkpoints as metadata and only observes the check-in in flight
  yield* f.restart;
  yield* f.runOnce;
  yield* f.runOnce;
  assert.deepEqual(dispatches(f).map(entry => dispatched(entry.payload)), [checkInSent(first), checkInSent(second)], "nothing is sent twice");
  assert.deepEqual(yield* pendingRuns(f, "worker"), ["run:run-worker-2"]);
  assert.deepEqual(yield* pendingRuns(f, mainThreadId), []);
  const stored = JSON.stringify(yield* rows(f.core.sql, "SELECT * FROM supervisor_monitor_items"));
  assert.ok(!stored.includes("Implement the parser.") && !stored.includes("Add the parser tests."), "no activity body is stored");
  assert.ok(dispatches(f).every(entry => entry.payload.threadId === binding.threadId), "no contact with the main or the child");
  assert.deepEqual(writes(f), ["orchestration.dispatchCommand:message.dispatch", "orchestration.dispatchCommand:message.dispatch"]);
  assert.deepEqual(f.peer.unexpected, []);
}), {timeout: 60_000});

// ---- compaction ----

/* Planted fault for this journey: the check-in's role notice drops the compaction reread while the interpretation's keeps it
 * (EXPECTED.md, compaction).
 */
it.live("compaction: a root compaction published as native events gets one guarded steer into its turn and records its completion, which invalidates the role acknowledgement, so the root's next check-in on the wire carries the reread; other traffic changes nothing", () => Effect.gen(function* () {
  const f = yield* startScenario(newRequest);
  const binding = yield* f.bindSupervisor;
  const root = yield* f.supervisor;
  yield* introduced(f);
  // the root is in a turn its provider steers without interrupting tools (the capability evidence of supervisor-compaction.test.ts)
  root.runs.push({id: "compacting-run", threadId: binding.threadId, ordinal: 2, status: "running", requestedAt: baseTime, startedAt: baseTime,
    completedAt: null, rootNodeId: "compacting-root", activeAttemptId: "compacting-attempt", providerThreadId: "compacting-provider"});
  (root.nodes as Array<Record<string, unknown>>).push({id: "compacting-root", threadId: binding.threadId, runId: "compacting-run", parentNodeId: null,
    rootNodeId: "compacting-root", kind: "root_turn", status: "running", providerThreadId: "compacting-provider"});
  root.providerThreads = [{id: "compacting-provider", providerSessionId: "compacting-session"}];
  root.providerSessions = [{id: "compacting-session", capabilities: {turns: {supportsActiveSteering: true}}}];
  root.providerTurns = [{id: "compacting-turn", runAttemptId: "compacting-attempt", nodeId: "compacting-root", status: "running"}];
  // the peer places an accepted steer in the turn it targets, recorded as T3's WebSocket RPC records every dispatched message
  f.peer.onRpc = (entry) => Effect.sync(() => {
    const payload = entry.payload;
    if (entry.tag === "orchestration.dispatchCommand" && payload.type === "message.dispatch" && payload.threadId === binding.threadId &&
      (payload.dispatchMode as {type?: unknown} | undefined)?.type === "steer_active")
      root.messages.push({id: String(payload.messageId), threadId: binding.threadId, runId: "compacting-run", nodeId: "compacting-root", role: "user",
        text: String(payload.text), streaming: false, createdAt: baseTime, updatedAt: baseTime, createdBy: "user", creationSource: "server"} as MessageInfo);
    return undefined;
  });

  // the cycle starts the root's watcher on the read credential; the busy root gets no check-in
  yield* f.runOnce;
  const subscription = yield* threadSubscription(f, binding.threadId);
  assert.equal(subscription.entry.authorization, `Bearer ${readToken}`);
  assert.deepEqual(writes(f), []);
  const rootReads = () => httpRequests(f.peer, `/api/orchestration/threads/${encodeURIComponent(binding.threadId)}`).length;

  // other traffic of the root's turn needs no read and sends nothing
  const before = rootReads();
  const read = {id: "root-read", threadId: binding.threadId, runId: "compacting-run", nodeId: "root-read-node", ordinal: 1, type: "dynamic_tool",
    status: "completed"};
  root.turnItems!.push(read);
  yield* emitThreadEvent(f, binding.threadId, {type: "turn-item.updated", payload: {...read}});
  assert.equal(rootReads(), before);
  assert.deepEqual(writes(f), []);

  // the compaction starts: one fresh read at the event's sequence and one steer into the compacting turn on the operate credential
  const compaction = {id: "native-compaction", threadId: binding.threadId, runId: "compacting-run", nodeId: "compacting-root", ordinal: 2,
    type: "compaction", status: "running"};
  root.turnItems!.push(compaction);
  yield* emitThreadEvent(f, binding.threadId, {type: "turn-item.updated", payload: {...compaction}});
  assert.equal(rootReads(), before + 1);
  const reminder = (yield* f.binding).compactionReminder!;
  assert.deepEqual({state: reminder.state, itemId: reminder.itemId, runId: reminder.runId}, {state: "accepted", itemId: "native-compaction", runId: "compacting-run"});
  const steer = {type: "message.dispatch", commandId: reminder.commandId, messageId: reminder.messageId, threadId: binding.threadId,
    text: compactionReminderText(binding, true)};
  assert.deepEqual(dispatches(f).map(entry => dispatched(entry.payload)), [steer]);
  assert.equal(dispatches(f)[0]!.authorization, `Bearer ${operateToken}`);
  assert.deepEqual(dispatches(f)[0]!.payload.dispatchMode, {type: "steer_active", targetRunId: "compacting-run"});

  // a later update of the same compaction does not repeat the turn's one attempt
  yield* emitThreadEvent(f, binding.threadId, {type: "turn-item.updated", payload: {...compaction}});
  assert.equal(dispatches(f).length, 1);

  // the compaction completes: it is recorded, and the steer T3 shows confirms the reminder
  compaction.status = "completed";
  yield* emitThreadEvent(f, binding.threadId, {type: "turn-item.updated", payload: {...compaction}});
  const compacted = yield* f.binding;
  assert.deepEqual(compacted.roleCompaction, {itemId: "native-compaction", runId: "compacting-run", runOrdinal: 2, itemOrdinal: 2});
  assert.equal(compacted.compactionReminder?.state, "visible");
  assert.equal(dispatches(f).length, 1);

  // the turn ends; the next cycle sends the main's activity to the root, and that check-in carries the reread
  yield* completeTurn(root, "compacting-run", "Compaction done; the watch continues.");
  root.providerTurns = [{id: "compacting-turn", runAttemptId: "compacting-attempt", nodeId: "compacting-root", status: "completed"}];
  yield* f.runOnce;
  const [checkIn] = yield* checkIns(f, binding.threadId);
  assert.ok(checkIn, "the root's next check-in");
  assert.equal(checkIn.state, "waiting");
  const wake = yield* Context.get(f.core.context, SupervisorConversation).rootWake(binding);
  assert.ok(wake?.roleVersion, "compaction requires a fresh root role acknowledgment");
  assert.ok(checkIn.text.includes(wake.text), "the check-in carries the current root wake notice after compaction");
  assert.equal(checkIn.roleVersion, wake.roleVersion);
  assert.equal(typeof checkIn.roleVersion, "string", "it delivers a role version still to be confirmed");
  assert.deepEqual(dispatches(f).map(entry => dispatched(entry.payload)), [steer, checkInSent(checkIn)]);
  assert.ok(dispatches(f).every(entry => entry.payload.threadId === binding.threadId), "no contact with the main");
  assert.equal(rpcRequests(f.peer, "orchestration.subscribeThread").filter(entry => entry.payload.threadId === binding.threadId).length, 1,
    "one subscription across the cycles");
  assert.deepEqual(f.peer.unexpected, []);
}), {timeout: 60_000});

// ---- duplicate prevention ----

/* CT-PS-03 on the production wire. A second cycle is started while T3 holds the first cycle's launch reply and is let go only once its
 * discovery read the main twice, its last native read before the per-main lock. The single launch has four guards in sequence (the
 * per-main lock, the reservation that returns an existing binding, the readback of the reserved identity, the launch's in-flight
 * identity), so a fault in one of them is masked by the next (EXPECTED.md, duplicate prevention).
 */
it.live("duplicate prevention: two cycles over a fresh request, the second started while T3 holds the first one's launch reply, launch one Supervisor under its reserved identity and send it one interpretation; later cycles and a restart send neither again (CT-PS-03)", () => Effect.gen(function* () {
  const f = yield* startScenario(newRequest);
  const launched = yield* Deferred.make<void>();
  const release = yield* Deferred.make<void>();
  const secondAtLock = yield* Deferred.make<void>();
  let holding = false;
  let mainReadsWhileHeld = 0;
  f.peer.onRpc = (entry) => Effect.gen(function* () {
    const payload = entry.payload;
    if (entry.tag === "orchestration.launchThread") {
      // the peer creates the conversation under the identity the command names, then holds the reply
      const created = projectionOf({...thread(String(payload.threadId)), title: String(payload.title), modelSelection: payload.modelSelection});
      f.peer.projections.set(created.thread.id, created);
      f.threads.push(created.thread);
      holding = true;
      yield* Deferred.succeed(launched, undefined);
      yield* Deferred.await(release);
      holding = false;
    }
    // the peer starts a turn for the interpretation it accepts
    if (entry.tag === "orchestration.dispatchCommand" && payload.type === "message.dispatch") {
      const target = f.peer.projections.get(String(payload.threadId));
      if (target) addDispatchedMessage(target, payload, "running");
    }
    return undefined;
  });
  f.peer.onProjection = (threadId) => holding && threadId === mainThreadId && ++mainReadsWhileHeld === 2
    ? Effect.asVoid(Deferred.succeed(secondAtLock, undefined)) : Effect.void;
  const first = yield* Effect.forkChild(f.runOnce);
  yield* Effect.raceFirst(Deferred.await(launched), Effect.andThen(Fiber.join(first), Effect.die(new Error("the first cycle ended before its launch reached T3"))));
  const second = yield* Effect.forkChild(f.runOnce);
  yield* Effect.raceFirst(Deferred.await(secondAtLock), Effect.andThen(Fiber.join(second), Effect.die(new Error("the second cycle ended before its discovery read the main"))));
  yield* Deferred.succeed(release, undefined);
  yield* Fiber.join(first);
  yield* Fiber.join(second);

  const binding = yield* f.binding;
  assert.equal(binding.state, "ready");
  assert.equal(binding.creationAttempts, 1);
  const launches = rpcRequests(f.peer, "orchestration.launchThread");
  assert.equal(launches.length, 1, "one Supervisor");
  assert.equal(launches[0]!.authorization, `Bearer ${operateToken}`);
  assert.deepEqual(launches[0]!.payload, {commandId: `supervisor-create:${binding.threadId}:${binding.generation}`, threadId: binding.threadId,
    creationSource: "server", projectId, title: binding.title, generateTitle: false, modelSelection: binding.initialModel, runtimeMode: "full-access",
    interactionMode: "default", workspaceStrategy: {type: "root"}});
  const task = (yield* f.core.store.task(mainThreadId).pipe(Effect.orDie))!;
  assert.equal(task.status, "waiting");
  assert.equal(task.supervisorThreadId, binding.threadId);
  const interpretation = {type: "message.dispatch", commandId: `supervisor-objective:${task.attempt!.attemptId}`, messageId: task.messageId,
    threadId: binding.threadId, text: task.requestText};
  assert.deepEqual(dispatches(f).map(entry => dispatched(entry.payload)), [interpretation], "one interpretation, to the new root only");
  assert.equal(yield* taskRows(f), 1);

  yield* f.runOnce;
  yield* f.restart;
  yield* Effect.all([f.runOnce, f.runOnce], {concurrency: "unbounded"});
  const reopened = yield* f.binding;
  assert.deepEqual([reopened.threadId, reopened.generation, reopened.state, reopened.creationAttempts], [binding.threadId, binding.generation, "ready", 1]);
  assert.deepEqual(yield* f.core.store.task(mainThreadId).pipe(Effect.orDie), task, "the running interpretation is only observed");
  assert.deepEqual(writes(f), ["orchestration.launchThread", "orchestration.dispatchCommand:message.dispatch"]);
  assert.equal(yield* taskRows(f), 1);
  assert.deepEqual(f.peer.unexpected, []);
}), {timeout: 60_000});

// ---- workflow returns and stale receipts ----

/* An interpreted task whose agreed workflow repeats implementation while the review finds failures (implement, review, a branch whose
 * then-path returns to implement at most 5 times, deliver), seeded through the workflow store as the store suites seed an agreement.
 */
const agreedLoop = (f: Scenario, supervisorThreadId: string) => Effect.gen(function* () {
  const snapshot: ProjectDefinitionSnapshot = {projectId, threadId: mainThreadId, workspaceRoot: "/work/p", globalOnly: false, globalRevision: null,
    revision: "definition-revision-1", editingAvailable: true, status: "ready", steps: [], workflows: [], config: effectiveIndex({steps: [], workflows: []}),
    projectConfig: projectIndex(), definitionFiles: [], complete: true, sources: [], issues: []};
  f.definitions.current = threadId => threadId === mainThreadId ? snapshot : missingDefinitions(threadId);
  const definitionContext = proposalContextFromDefinitions(snapshot);
  const local = (id: string) => ({kind: "step", definitionId: null, localId: id, name: id, description: `Complete ${id}.`, reason: `The task needs ${id}.`});
  const normalized = validateWorkflowPlan({requirements: [], plan: {kind: "sequence", templatePath: null, nodes: [local("implement"), local("review"),
    {kind: "branch", condition: "Review found failures.", reason: "The findings decide.", then: {kind: "sequence", nodes: [
      {kind: "back_to", target: "implement", maximum: 5, reason: "Repeat from implementation while findings remain."}]}}, local("deliver")]}}, definitionContext);
  if (!normalized?.plan) return yield* Effect.die(new Error("test_workflow_proposal_invalid"));
  const proposal: WorkflowProposalInfo = {status: "proposed", message: "Implement, review and repeat while the review finds failures.",
    workspaceRoot: "/work/p", revision: "definition-revision-1", globalRevision: null, definitionsStatus: "ready", definitionsComplete: true,
    requirementsKnown: true, requirements: normalized.requirements, issues: normalized.issues, plan: normalized.plan};
  const now = yield* Clock.currentTimeMillis;
  const proposalId = "proposal-loop";
  const task: TaskRecord = {id: "task-loop", threadId: mainThreadId, projectId, sourceRunId: newSource.runId, sourceMessageId: newSource.messageId,
    sourceOrdinal: newSource.ordinal, sourceHash: fingerprint(newSource.text), status: "inferred", objective: "Create a migration plan.",
    reason: "The latest user message describes an actionable task.", updatedAt: now, workflow: proposal, agreement: null, workflowProposalId: proposalId,
    requestText: newSource.text, supervisorThreadId, messageId: newSource.messageId, dispatchedAt: null, replayCount: 0, supervisorRunId: null,
    definitionContext, definitionSnapshot: snapshot};
  yield* f.core.store.saveTask(engagedTask(task, f.main)).pipe(Effect.orDie);
  const owner = {projectId, mainThreadId, supervisorThreadId, bindingGeneration: (yield* f.binding).generation};
  const imported = yield* f.core.workflowStates.importAcceptedAgreement(owner, {taskId: task.id, sourceThreadId: mainThreadId, sourceRunId: task.sourceRunId,
    sourceMessageId: task.sourceMessageId, sourceHash: task.sourceHash, objective: "Create a migration plan.", agreement: {status: "agreed",
      message: "The operative accepted the review loop.", proposalId, agreedAt: now, evidence: {kind: "supervisor_message", messageId: "loop-supervisor-message"},
      agentMessageId: "loop-agent-message", workflow: proposal}}, now).pipe(Effect.orDie);
  if (imported.status !== "applied") return yield* Effect.die(new Error(`test_agreement_import_${imported.status}`));
  const sourceBinding = {workspaceRoot: proposal.workspaceRoot, revision: proposal.revision, globalRevision: null, definitionsStatus: proposal.definitionsStatus,
    definitionsComplete: proposal.definitionsComplete, requirementsKnown: proposal.requirementsKnown, taskId: task.id, proposalId, sourceHash: task.sourceHash};
  return {owner, proposal, sourceBinding};
});

/* Planted faults for this journey: an apply whose expected revision is outdated is refused before its receipt is looked up, and the
 * store lets a status move past a pending return (EXPECTED.md, workflow returns and stale receipts).
 */
it.live("workflow returns and stale receipts: a reached return holds the root's next write over the production route; after a restart the root's earlier, now stale write replays its own receipt and a reused operation ID conflicts, with no native request and nothing written to T3", () => Effect.gen(function* () {
  const f = yield* startScenario(newRequest);
  const binding = yield* f.bindSupervisor;
  const root = yield* f.supervisor;
  const {owner, proposal, sourceBinding} = yield* agreedLoop(f, binding.threadId);
  const current = Effect.suspend(() => f.core.workflowStates.get(projectId, mainThreadId)).pipe(Effect.orDie, Effect.map(value => value!));
  let document = yield* current;
  const step = (id: string) => planEntities(document.plan).find(node => node.kind === "step" && node.localId === id)!.nodeId;
  const ids = {implement: step("implement"), review: step("review"), deliver: step("deliver")};
  const loop = planBranches(document.plan)[0]!;
  // the root's apply of the current revision, proven by its own native call of exactly these arguments
  const apply = (operationId: string, patch: Record<string, unknown>) => ({action: "apply", supervisorThreadId: binding.threadId,
    bindingGeneration: binding.generation, input: {sourceBinding, requirements: proposal.requirements, issues: proposal.issues, operationId,
      workflowId: document.workflowId, expectedRevision: document.revision, ...patch}});
  const call = (args: Record<string, unknown>) => Effect.suspend(() => {
    installToolCall(f, root, workflowToolNames.write.direct[0], args);
    return f.mcp("workflow_write", args);
  });

  // the first attempt ends with findings
  const attempt = apply("loop-attempt-1", {status: "underway", statuses: [{nodeId: ids.implement, status: "completed"}, {nodeId: ids.review, status: "completed"}],
    evidence: [{kind: "status_changed", note: "The task is underway."}, {kind: "status_changed", targetNodeId: ids.implement, note: "Implementation completed."},
      {kind: "status_changed", targetNodeId: ids.review, note: "Review completed with findings."}], note: "Attempt 1 ended with findings."});
  const applied = yield* call(attempt);
  assert.equal(applied.isError, false, JSON.stringify(applied.value));
  assert.equal((applied.value as {status: string}).status, "applied");

  // the operative's decision reaches the return (seeded as the store suites seed a decision), which now waits for the Supervisor
  const decidedAt = yield* Clock.currentTimeMillis;
  const selected = yield* f.core.workflowStates.recordBranchSelection(owner, {nodeId: loop.nodeId, revision: 1, path: "then", reason: "The review found failures.",
    sourceThreadId: mainThreadId, sourceRunId: newSource.runId, sourceMessageId: "loop-decision-message", sourceCreatedAt: decidedAt}, decidedAt).pipe(Effect.orDie);
  assert.equal(selected.status, "applied");
  document = yield* current;
  assert.deepEqual(document.returns.map(entry => [entry.state, entry.targetNodeId]), [["pending", ids.implement]]);

  // the root's write past the waiting return is refused and changes nothing
  const held = yield* call(apply("deliver-early", {statuses: [{nodeId: ids.deliver, status: "underway"}],
    evidence: [{kind: "status_changed", targetNodeId: ids.deliver, note: "Delivery started."}], note: "Start delivery."}));
  assert.equal(held.isError, true);
  assert.equal((held.value as {reason?: unknown}).reason, "return_pending");
  assert.equal((yield* current).revision, document.revision);

  /* After a restart the first write, whose expected revision is now outdated, replays its own receipt; a reused operation ID with
   * another input conflicts; both are answered without a native request.
   */
  yield* f.restart;
  const traffic = f.peer.log.length;
  assert.deepEqual(yield* f.mcp("workflow_write", attempt), applied, "the stale write's own receipt");
  const reused = yield* f.mcp("workflow_write", {...attempt, input: {...attempt.input, note: "Another note under the same operation ID."}});
  assert.deepEqual(reused.value, {status: "conflict", operationId: "loop-attempt-1", reason: "operation_id_reused", currentRevision: null});
  assert.equal(f.peer.log.length, traffic, "no native request");
  assert.deepEqual((yield* current).returns.map(entry => entry.state), ["pending"], "the return still waits for the Supervisor");
  assert.equal((yield* current).revision, document.revision);
  assert.deepEqual(nativeWrites(f.peer), [], "nothing was written to T3");
  assert.deepEqual(f.peer.unexpected, []);
}), {timeout: 60_000});
