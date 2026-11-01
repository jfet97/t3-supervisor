import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Deferred, Effect, Fiber } from "effect";
import type { BindingRecord } from "../src/project-supervisor-store.js";
import { abortCall, atWallTime, within } from "./support/g1b-conversation.js";
import {
  abortHonouringSend, addCommandActivity, appendNoticeToOperative, baseTime, makeFixture, operativeThreadId, projectId, setNow, type Fixture,
  type FixtureClock, type Flight, type RpcCall,
} from "./support/c1-conversation-fixture.js";

/* The conversation's sends under the admission section (S6b): a root check-in's preparation, guard, 'sending' receipt and POST run in
 * the one section the policy writers use; the cycle that initiated a check-in, an introduction or a Stop notice owns its cancellation,
 * so an interrupted cycle classifies the send it owns and releases its call once; and a send left 'sending' by a crash is reopened
 * unchanged and reconciled by the next controller. None of them is ever sent again. The interrupted introduction runs over the real
 * sockets in unknown-send-reconciliation.test.ts, and a Stop made while a check-in's reply is pending (S6b-CONV-01) in
 * stop-linearization.test.ts (CT-LIN-06, root check-in). The crash cases stay here: the scenario driver's restart closes the run's
 * services before its files, so each in-flight send is classified at shutdown, while this fixture's crash closes the database clients
 * under the live services and leaves the row exactly as committed.
 * the cases are Effect tests on the production conversation, project supervisor, admission gate and stores over real files in a
 * temporary directory, with the fake T3 as an effect fake and the suite clock on the test clock; the baseline per-call 8 s
 * abort deadlines and the observation's 5 s are gone with the signal parameter: hang guards, which each case's 10 s bound and
 * the 3 s live-clock bounds of its awaited events still cover.
 */

const isCheckIn = (fixture: Fixture) => (call: RpcCall) => call.payload.type === "message.dispatch" && call.payload.threadId === fixture.binding.threadId;
const isIntroduction = (fixture: Fixture) => (call: RpcCall) => call.payload.type === "message.dispatch" && call.payload.threadId === operativeThreadId &&
  String(call.payload.messageId).startsWith(`supervisor-notice:workflow:${fixture.task.id}`);

/* Three due command activities beside a sent introduction, observed into the monitor; the project is enabled for the
 * supervisor's own scope predicates.
 */
const dueCheckIn = (clock: FixtureClock) => Effect.gen(function* () {
  yield* setNow(clock, clock.now);
  const fixture = yield* makeFixture(clock, {settings: {intervalMinutes: 2, activityThreshold: 3}});
  yield* appendNoticeToOperative(fixture);
  for (let index = 1; index <= 3; index++) addCommandActivity(fixture.operative, `command-${index}`, `PRIVATE_COMMAND_BODY_${index}`, clock.now - index * 1_000);
  yield* fixture.conversation.observe(fixture.threadList).pipe(atWallTime(clock.now));
  yield* fixture.projectStore.saveControl(projectId, (yield* fixture.projectStore.control(projectId)).generation, true, {snapshotSequence: 1, threads: []});
  return fixture;
});

const binding = (fixture: Fixture) => Effect.map(fixture.projectStore.binding(projectId, operativeThreadId), (current) => current as BindingRecord);

// holds the matching send at the fake peer: abort-honouring, or never settling until the test ends
const holdSend = (fixture: Fixture, matches: (call: RpcCall) => boolean, mode: "abort" | "crash") => Effect.gen(function* () {
  const reached = yield* Deferred.make<RpcCall>();
  fixture.intercept((call, flight) => {
    if (!matches(call)) return null;
    return Effect.andThen(Deferred.succeed(reached, call), mode === "abort" ? abortHonouringSend(flight) : Effect.never);
  });
  return within(Deferred.await(reached), 3_000, "held send");
});

// a run left parked at its held send when the process crashes; it ends with the test, interrupted within the bound
const abandon = (fixture: Fixture) => Effect.gen(function* () {
  const abandoned = yield* Effect.forkScoped(fixture.run);
  yield* Effect.addFinalizer(() => within(Fiber.interrupt(abandoned), 3_000, "abandoned run"));
});

it.effect("S6b-CONV-02: a Stop committed while a root check-in waits for the admission section prepares and sends nothing", () => Effect.gen(function* () {
  const clock = {now: baseTime};
  const fixture = yield* dueCheckIn(clock);
  const service = yield* fixture.makeProjectSupervisor;
  const scope = yield* Effect.scope;
  const barrier = yield* Deferred.make<void>();
  const holding = yield* Deferred.make<void>();
  // the check-in's main read is its last native read before its section: the section is taken right there
  let held: Fiber.Fiber<void> | null = null;
  fixture.fake.holdSupervisorReads((threadId, read) => Effect.gen(function* () {
    if (threadId === operativeThreadId && held === null) {
      held = yield* Effect.forkIn(service.gate.admit(() => Deferred.await(barrier)), scope, {startImmediately: true});
      yield* Deferred.succeed(holding, undefined);
    }
    return yield* read;
  }));
  const running = yield* Effect.forkChild(service.conversation.run(yield* binding(fixture), fixture.supervisor, fixture.threadList));
  yield* within(Deferred.await(holding), 3_000, "section held");
  // a policy write made while the section is held, as a Stop's own section would make it
  const policy = yield* fixture.threadPolicy.get();
  yield* fixture.threadPolicy.save({...policy, excludedThreadIds: [...policy.excludedThreadIds, operativeThreadId]});
  yield* Deferred.succeed(barrier, undefined);
  yield* within(Fiber.join(running), 3_000, "cycle");
  yield* within(Fiber.join(held!), 3_000, "section released");
  assert.deepEqual(fixture.calls.filter(isCheckIn(fixture)), [], "nothing is posted after the Stop");
  assert.equal(yield* service.requests.pending(projectId, fixture.binding.threadId), null, "no check-in is prepared");
  assert.ok((yield* Effect.forEach(["command-1", "command-2", "command-3"], id => Effect.map(service.monitor.pending(projectId, operativeThreadId), items => items.some(item => item.id === id)))).every(Boolean),
    "the pending activity is retained");
}), {timeout: 10_000});

it.effect("an interrupted cycle saves its in-flight root check-in 'uncertain' under its identity, releases the call once and never resends it (S6b-CONV-03, CT-CONV-01 abort)", () => Effect.gen(function* () {
  const clock = {now: baseTime};
  const fixture = yield* dueCheckIn(clock);
  const reached = yield* Deferred.make<{call: RpcCall; flight: Flight}>();
  fixture.intercept((call, flight) => {
    if (!isCheckIn(fixture)(call)) return null;
    return Effect.andThen(Deferred.succeed(reached, {call, flight}), abortHonouringSend(flight));
  });
  const running = yield* Effect.forkChild(fixture.conversation.run(yield* binding(fixture), fixture.supervisor, fixture.threadList));
  const {call, flight} = yield* within(Deferred.await(reached), 3_000, "check-in POST");
  // the section committed the receipt, its notice time and the exact identities before the POST left
  const sending = yield* fixture.requests.pending(projectId, fixture.binding.threadId);
  assert.ok(sending?.kind === "review");
  assert.equal(sending.state, "sending");
  assert.equal(sending.sentAt, clock.now);
  assert.equal(yield* fixture.requests.lastNotice(fixture.binding.threadId), clock.now);
  assert.equal(call.payload.messageId, sending.messageId);
  assert.equal(call.payload.commandId, `supervisor-review:${sending.id}`);

  // the cycle owns the send: its interruption settles it, releases the call exactly once and records the unknown outcome
  yield* within(abortCall(running), 3_000, "interrupted cycle");
  assert.equal(yield* Deferred.isDone(flight.released), true);
  assert.equal(flight.releases, 1);
  const uncertain = yield* fixture.requests.pending(projectId, fixture.binding.threadId);
  assert.deepEqual(uncertain, {...sending, state: "uncertain",
    error: "Supervisor request delivery is uncertain; its original identity is retained and only observed, never resent."});

  fixture.intercept(null);
  yield* setNow(clock, clock.now + 120_000);
  yield* fixture.run;
  yield* fixture.run;
  assert.deepEqual(yield* fixture.requests.pending(projectId, fixture.binding.threadId), uncertain);
  assert.deepEqual(fixture.calls.filter(isCheckIn(fixture)), [call]);
}), {timeout: 10_000});

it.effect("a check-in left 'sending' by a crash is reopened unchanged by every process; the next controller marks it 'uncertain' and never sends it again (CT-CONV-01 crash, CT-CSTORE-03)", () => Effect.gen(function* () {
  const clock = {now: baseTime};
  const fixture = yield* dueCheckIn(clock);
  const reached = yield* holdSend(fixture, isCheckIn(fixture), "crash");
  yield* abandon(fixture);
  const call = yield* reached;
  const sending = yield* fixture.requests.pending(projectId, fixture.binding.threadId);
  assert.ok(sending?.state === "sending");
  yield* fixture.crash;

  fixture.intercept(null);
  const restarted = yield* fixture.reopen;
  assert.deepEqual(yield* restarted.requests.pending(projectId, fixture.binding.threadId), sending, "reopening performs no recovery");
  const again = yield* fixture.reopen;
  assert.deepEqual(yield* again.requests.requests(projectId), [sending], "nor does a second reopen");
  yield* setNow(clock, clock.now + 1_000);
  yield* again.run;
  const uncertain = yield* again.requests.pending(projectId, fixture.binding.threadId);
  assert.deepEqual(uncertain, {...sending, state: "uncertain",
    error: "The native request has no confirmed matching run yet. Its identity and pending activity are retained."});
  yield* setNow(clock, clock.now + 120_000);
  yield* again.run;
  assert.deepEqual(yield* again.requests.pending(projectId, fixture.binding.threadId), uncertain);
  assert.deepEqual(fixture.calls.filter(isCheckIn(fixture)), [call]);
  assert.equal(call.payload.commandId, `supervisor-review:${sending.id}`);
  assert.equal(fixture.calls.length, 1);
}), {timeout: 10_000});

it.effect("an introduction left 'sending' by a crash is reopened unchanged; the next cycle marks it 'uncertain' and neither Retry nor another restart sends it again (CT-CONV-02 crash)", () => Effect.gen(function* () {
  const clock = {now: baseTime};
  yield* setNow(clock, clock.now);
  const fixture = yield* makeFixture(clock);
  const reached = yield* holdSend(fixture, isIntroduction(fixture), "crash");
  yield* abandon(fixture);
  const call = yield* reached;
  const sending = yield* fixture.requests.introduction(fixture.task.id);
  assert.ok(sending?.state === "sending");
  yield* fixture.crash;

  fixture.intercept(null);
  const restarted = yield* fixture.reopen;
  assert.deepEqual(yield* restarted.requests.introduction(fixture.task.id), sending, "reopening performs no recovery");
  yield* setNow(clock, clock.now + 1_000);
  yield* restarted.run;
  const uncertain = yield* restarted.requests.introduction(fixture.task.id);
  assert.deepEqual(uncertain, {...sending, state: "uncertain",
    error: "Proposal delivery is uncertain; its message identity is retained. Retry native access rather than sending another proposal."});
  yield* restarted.conversation.retry(projectId, fixture.binding.threadId);
  yield* setNow(clock, clock.now + 61_000);
  yield* restarted.run;
  const again = yield* fixture.reopen;
  yield* again.run;
  assert.deepEqual(yield* again.requests.introduction(fixture.task.id), uncertain);
  assert.deepEqual(fixture.calls, [call]);
}), {timeout: 10_000});

it.effect("an interrupted Stop-notice send keeps the notice 'uncertain' under its identity; later observation and Retry never send a second notice (CT-CONV-03)", () => Effect.gen(function* () {
  const clock = {now: baseTime};
  yield* setNow(clock, clock.now);
  const fixture = yield* makeFixture(clock);
  yield* appendNoticeToOperative(fixture);
  const {supervisor: service} = yield* fixture.makeProjectSupervisor;
  yield* service.setChatSupervision({projectId, mainThreadId: operativeThreadId, enabled: false, policyGeneration: (yield* fixture.threadPolicy.get()).generation});
  const prepared = (yield* fixture.projectStore.binding(projectId, operativeThreadId))?.stopNotice;
  assert.ok(prepared);
  const isNotice = (call: RpcCall) => call.payload.type === "message.dispatch" && call.payload.messageId === prepared.messageId;
  const reached = yield* holdSend(fixture, isNotice, "abort");
  const running = yield* Effect.forkChild(fixture.conversation.reconcileStopNotice(fixture.binding));
  const call = yield* reached;
  // the notice is saved 'uncertain' before its POST leaves
  const uncertain = (yield* fixture.projectStore.binding(projectId, operativeThreadId))?.stopNotice;
  assert.ok(uncertain);
  assert.equal(uncertain.state, "uncertain");
  assert.deepEqual(uncertain.dispatchMode, {type: "steer_active", targetRunId: "operative-active-run"});
  assert.equal(call.payload.commandId, prepared.commandId);
  assert.equal(call.payload.threadId, operativeThreadId);

  yield* within(abortCall(running), 3_000, "aborted notice");
  assert.deepEqual((yield* fixture.projectStore.binding(projectId, operativeThreadId))?.stopNotice, uncertain, "a non-definite failure saves nothing over the reservation");

  fixture.intercept(null);
  for (let index = 0; index < 4; index++) {
    yield* setNow(clock, clock.now + 61_000);
    yield* fixture.conversation.reconcileStopNotice(fixture.binding);
  }
  yield* fixture.conversation.retry(projectId, fixture.binding.threadId);
  yield* fixture.conversation.reconcileStopNotice(fixture.binding);
  const observed = (yield* fixture.projectStore.binding(projectId, operativeThreadId))?.stopNotice;
  assert.equal(observed?.messageId, prepared.messageId);
  assert.equal(observed?.commandId, prepared.commandId);
  assert.equal(observed?.text, prepared.text);
  // three invisible observations made it unconfirmed; Retry only re-armed one more observation of the same identity
  assert.equal(observed?.state, "uncertain");
  assert.equal(observed?.visibilityMisses, 1);
  assert.deepEqual(fixture.calls.filter(item => item.payload.threadId === operativeThreadId), [call]);
}), {timeout: 10_000});
