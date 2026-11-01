import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Cause, Context, Effect, Exit, Fiber } from "effect";
import type { TaskRecord } from "../src/project-supervisor-store.js";
import { SupervisorConversation } from "../src/supervisor-conversation.js";
import { rows } from "./support/glinint-wiring.js";
import {
  addDispatchedMessage, holdRpcReply, mainThreadId, nativeWrites, projectId, routeOf, rpcRequests, seedIntroduction, startScenario, type RpcEntry,
  type Scenario,
} from "./support/scenario-driver.js";

/* Sends whose outcome is unknown, on the production run through the replay scenario driver (support/scenario-driver.ts): production
 * controllers and stores on temporary files and a loopback T3 peer that holds the reply of the send under test. The cycle that started
 * the send is interrupted while T3 holds its reply, as a shutdown interrupts the run's own cycle before it closes the run's services; the
 * send is recorded 'uncertain' under its identity, the run restarts over the same files while the peer keeps its native state, and the
 * reopened run reconciles the identity from what T3 shows: an interpretation is replayed exactly as it was, an introduction is only
 * observed until T3 shows it. Neither is sent under a new identity.
 * A send left 'sending' by a killed process is a different start state; the scenario driver's restart cannot leave it, because closing
 * the run's services classifies each send still in flight, so those cases run on fixtures whose crash closes the database clients under
 * the live services: supervisor-conversation-admission.test.ts (check-in, introduction, Stop notice) and project-supervisor.test.ts
 * (interpretation).
 * it.live: every case drives the run over the peer's real HTTP and websocket sockets and the real SQLite files, and waits only on the
 * held reply's arrival.
 */

const oldTurn = {id: "old-turn", text: "Earlier request before the boundary."};
const newTurn = {id: "new-turn", text: "Create a migration plan."};
const newRequest = {mainTurns: [oldTurn, newTurn]};
const newSource = {messageId: newTurn.id, runId: `run-${newTurn.id}`, ordinal: 2, text: newTurn.text};

const task = (f: Scenario): Effect.Effect<TaskRecord> => Effect.map(f.core.store.task(mainThreadId), (value) => value!).pipe(Effect.orDie);
const taskRows = (f: Scenario) => Effect.map(rows(f.core.sql, "SELECT count(*) AS n FROM supervisor_task_interpretations WHERE thread_id=?", mainThreadId),
  ([found]) => Number(found?.n));
const writes = (f: Scenario): string[] => nativeWrites(f.peer).map(routeOf);
const dispatches = (f: Scenario) => rpcRequests(f.peer, "orchestration.dispatchCommand").map(entry => entry.payload);
const dispatched = (payload: Record<string, unknown>) => ({type: payload.type, commandId: payload.commandId, messageId: payload.messageId,
  threadId: payload.threadId, text: payload.text});
// every send to the operative main; the root's own traffic (a check-in about the main's activity) is not the identity under test
const operativeSends = (f: Scenario) => dispatches(f).filter(payload => payload.threadId === mainThreadId).map(dispatched);
// the run's conversation service, read anew after each restart
const conversation = (f: Scenario) => Context.get(f.core.context, SupervisorConversation);

// forks one cycle and waits until the frame the peer holds has arrived; a cycle that ends first fails the case
const cycleUntilHeld = (f: Scenario, arrived: Effect.Effect<RpcEntry>, label: string) => Effect.gen(function* () {
  const cycle = yield* Effect.forkChild(f.runOnce);
  const frame = yield* Effect.raceFirst(arrived, Effect.andThen(Fiber.join(cycle), Effect.die(new Error(`the cycle ended before ${label} reached the peer`))));
  return {cycle, frame};
});

// the interrupted cycle settles by its interruption alone
const interrupted = (cycle: Fiber.Fiber<void>) => Effect.gen(function* () {
  yield* Fiber.interrupt(cycle);
  const exit = yield* Fiber.await(cycle);
  assert.ok(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause), "the interrupted cycle settles");
});

it.live("an interpretation whose cycle is interrupted while T3 holds its reply stays 'uncertain' under its identity; after a restart the reopened run replays exactly that identity once (CT-PS-01 abort)", () => Effect.gen(function* () {
  const f = yield* startScenario(newRequest);
  const binding = yield* f.bindSupervisor;
  // T3 holds the reply and starts no run for the request
  const held = yield* holdRpcReply(f, entry => entry.tag === "orchestration.dispatchCommand" && entry.payload.type === "message.dispatch");
  const {cycle, frame} = yield* cycleUntilHeld(f, held.arrived, "the interpretation");
  // the dispatching receipt with its final identity was committed before the frame left
  const dispatching = yield* task(f);
  assert.equal(dispatching.status, "dispatching");
  assert.equal(dispatching.messageId, `supervisor-objective:${dispatching.id}:${dispatching.sourceOrdinal}:${dispatching.sourceHash.slice(0, 20)}`);
  assert.equal(dispatching.replayCount, 0);
  assert.equal(typeof dispatching.dispatchedAt, "number");
  const first = dispatched(frame.payload);
  assert.deepEqual(first, {type: "message.dispatch", commandId: `supervisor-objective:${dispatching.attempt!.attemptId}`, messageId: dispatching.messageId,
    threadId: binding.threadId, text: dispatching.requestText});

  yield* interrupted(cycle);
  const uncertain = yield* task(f);
  assert.equal(uncertain.id, dispatching.id);
  assert.equal(uncertain.status, "uncertain");
  assert.equal(uncertain.reason, "Interpretation dispatch is uncertain; retry native access to reconcile the original request identity.");
  assert.equal(uncertain.messageId, dispatching.messageId);
  assert.deepEqual(uncertain.attempt, dispatching.attempt);
  assert.equal(uncertain.replayCount, 0);
  assert.deepEqual(dispatches(f).map(dispatched), [first]);

  // T3 never started a run for it, so the reopened run replays the retained identity, and only it
  yield* f.restart;
  yield* f.runOnce;
  const replayed = yield* task(f);
  assert.equal(replayed.id, uncertain.id, "no new task identity");
  assert.equal(replayed.messageId, uncertain.messageId);
  assert.equal(replayed.replayCount, 1);
  assert.equal(replayed.status, "waiting");
  assert.deepEqual(dispatches(f).map(dispatched), [first, first]);
  assert.deepEqual(writes(f), ["orchestration.dispatchCommand:message.dispatch", "orchestration.dispatchCommand:message.dispatch"]);
  assert.equal(yield* taskRows(f), 1);
  assert.deepEqual(f.peer.unexpected, []);
}), {timeout: 60_000});

it.live("an introduction whose cycle is interrupted while T3 holds its reply stays 'uncertain' under its identity through later cycles, Retry and a restart, and is confirmed sent once T3 shows it, never sent again (CT-CONV-02 abort)", () => Effect.gen(function* () {
  const f = yield* startScenario(newRequest);
  const binding = yield* f.bindSupervisor;
  const {introduction} = yield* seedIntroduction(f, newSource);
  // T3 holds the reply and shows nothing in the main yet
  const held = yield* holdRpcReply(f, entry => entry.tag === "orchestration.dispatchCommand" && entry.payload.messageId === introduction.messageId);
  const {cycle, frame} = yield* cycleUntilHeld(f, held.arrived, "the introduction");
  // the 'sending' receipt with its dispatch mode was committed before the frame left
  const sending = (yield* f.core.requests.introduction(introduction.taskId))!;
  assert.equal(sending.state, "sending");
  assert.deepEqual(sending.dispatchMode, {type: "queue_after_active"});
  const sent = dispatched(frame.payload);
  assert.deepEqual(sent, {type: "message.dispatch", commandId: `supervisor-workflow:${introduction.messageId}`, messageId: introduction.messageId,
    threadId: mainThreadId, text: introduction.text});

  yield* interrupted(cycle);
  const uncertain = (yield* f.core.requests.introduction(introduction.taskId))!;
  assert.deepEqual(uncertain, {...sending, state: "uncertain", definiteRejection: false, error: "Proposal delivery is uncertain. Its exact message identity is retained."});

  // later cycles, Retry and a restart only observe the unknown receipt
  yield* f.runOnce;
  assert.deepEqual(yield* f.core.requests.introduction(introduction.taskId), uncertain, "observation preserves the unknown receipt unchanged");
  yield* conversation(f).retry(projectId, binding.threadId);
  yield* f.runOnce;
  yield* f.restart;
  yield* conversation(f).retry(projectId, binding.threadId);
  yield* f.runOnce;
  yield* f.runOnce;
  assert.deepEqual(yield* f.core.requests.introduction(introduction.taskId), uncertain);
  assert.deepEqual(operativeSends(f), [sent]);

  // T3 shows the original message, queued after the active run: the same identity is confirmed sent
  addDispatchedMessage(f.main, frame.payload, "completed");
  yield* f.runOnce;
  const confirmed = (yield* f.core.requests.introduction(introduction.taskId))!;
  assert.equal(confirmed.state, "sent");
  assert.equal(confirmed.messageId, introduction.messageId);
  assert.equal(confirmed.error, null);
  assert.deepEqual(operativeSends(f), [sent], "one introduction in total");
  assert.deepEqual(f.peer.unexpected, []);
}), {timeout: 60_000});
