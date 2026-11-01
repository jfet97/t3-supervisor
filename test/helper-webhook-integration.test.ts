import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Clock, Deferred, Duration, Effect, Fiber, Option } from "effect";
import { helperDeliveryBody } from "../src/supervisor-helper-transport.js";
import { workflowRequestHash } from "../src/workflow-write-evidence.js";
import { execute, row } from "./support/glinint-wiring.js";
import { json, type HttpAnswer } from "./support/int-native-peer.js";
import {
  assertHelperCredentials, helperReceipt, helperRequest, helperTeamRequest, hookPath, publishedWrapper, redirectedHookPath, rpcRequests, runHelperBatch,
  startHelperScenario, webhookPosts, type HelperScenario, type Scenario,
} from "./support/scenario-driver.js";

/* Production team runtime -> production helper transport -> platform fetch -> loopback socket; operate rpc over a real websocket;
 * restart reopens the files, on the replay scenario driver (support/scenario-driver.ts). it.live: the webhook POSTs, the websocket
 * RPC and the projection reads cross real loopback sockets, and H2's stalled body ends at the caller's own 3 s deadline on the live
 * clock. The Stop cases H4a, H4c and H5 run with the Stop linearization cases in stop-linearization.test.ts. A POST whose delivery T3
 * never shows stays unresolved in supervisor-helper-transport.test.ts (CT-TRUN-01's crash, CT-HTX-01's cancel): this driver's
 * peer logs every POST that reaches it.
 */

// `deadline`: the caller's own deadline, a cancel completed after it on the live clock, as the baseline AbortSignal.timeout aborted
const runBatch = (h: HelperScenario, deadline?: Duration.Input) => Effect.gen(function* () {
  const cancel = deadline === undefined ? undefined : yield* Deferred.make<void>();
  if (cancel) yield* Effect.forkScoped(Effect.andThen(Effect.sleep(deadline!), Deferred.succeed(cancel, undefined)));
  return yield* runHelperBatch(h, cancel);
});

const once = (work: Effect.Effect<void>): Effect.Effect<void> => {
  let done = false;
  return Effect.suspend(() => {
    if (done) return Effect.void;
    done = true;
    return work;
  });
};

// the exact identities the runtime hands to the transport
const sentInput = (f: Scenario) => Effect.map(helperRequest(f), (request) =>
  ({threadId: "helper", commandId: `supervisor-review:${request.id}`, messageId: request.messageId, text: request.text}));

const assertCredentials = (f: Scenario): void => {
  assertHelperCredentials(f.peer.log);
  assert.deepEqual(f.peer.unexpected, []);
};

/* The two ways an accepted POST's outcome stays unknown: T3 logged the delivery and holds its reply until the case ends the exchange,
 * by cutting the socket (H1) or by the caller's own cancel while the reply is still held (CT-TRUN-01's abort, which the baseline
 * characterized over a stubbed fetch).
 */
for (const outcome of ["its reply is lost", "the caller cancels while T3 holds its reply"] as const) {
  it.live(`CT-INT-03: H1 (CT-TRUN-01 abort) an accepted POST whose outcome is unknown because ${outcome} stays uncertain, is never re-posted and binds by exact body after restart`, () => Effect.gen(function* () {
    const h = yield* startHelperScenario();
    const {f} = h;
    const arrived = yield* Deferred.make<void>();
    const cut = yield* Deferred.make<void>();
    const lost: HttpAnswer = {raw: (request) => {request.socket.destroy();}};
    f.peer.webhook = () => Effect.andThen(Deferred.succeed(arrived, undefined), Effect.as(Deferred.await(cut), lost));
    const cancel = yield* Deferred.make<void>();
    const batch = yield* Effect.forkChild(runHelperBatch(h, outcome === "its reply is lost" ? undefined : cancel));
    yield* Deferred.await(arrived);
    // the runtime admitted the request and the transport committed its receipt before the POST left
    const sending = yield* helperRequest(f);
    assert.equal(sending.state, "sending");
    assert.equal((yield* helperReceipt(f))!.state, "posting");
    yield* Deferred.succeed(outcome === "its reply is lost" ? cut : cancel, undefined);
    // retain the retired cancellation case's ten-second bound within the live journey
    const ended = yield* Effect.timeoutOption(Fiber.join(batch), "10 seconds");
    assert.ok(Option.isSome(ended), "the batch ends while T3's reply is still unavailable");

    const posts = webhookPosts(f.peer);
    assert.equal(posts.length, 1, "no retry of a non-idempotent POST");
    const input = yield* sentInput(f);
    assert.equal(posts[0]!.path, hookPath);
    assert.equal(posts[0]!.body, helperDeliveryBody(input.messageId, input.text));
    assert.equal(posts[0]!.body, JSON.stringify({batchId: input.messageId, text: input.text}));
    assert.equal(posts[0]!.contentType, "application/json");
    const receipt = (yield* helperReceipt(f))!;
    assert.equal(receipt.state, "posting");
    assert.equal(receipt.messageId, input.messageId);
    assert.equal(receipt.commandId, input.commandId);
    assert.equal(receipt.text, input.text);
    assert.equal(receipt.hash, workflowRequestHash(input));
    assert.equal(receipt.taskId, f.peer.tasks[0]!.id);
    assert.match(String(receipt.taskId), /^supervisor-helper:[0-9a-f]{64}$/u);
    assert.equal("nativeDeliveryId" in receipt, false);
    const request = yield* helperRequest(f);
    assert.deepEqual(request, {...sending, state: "uncertain", error: "Helper delivery is uncertain; its original native identity is retained."});
    assert.equal((yield* helperTeamRequest(f)).state, "uncertain");

    yield* f.restart;
    const binding = yield* f.binding;
    yield* f.core.teamRuntime.startCycle(binding);
    yield* f.core.teamRuntime.reconcile(binding, h.threads);
    assert.equal(webhookPosts(f.peer).length, 1, "reconciliation after restart posts nothing");
    const reconciled = (yield* helperReceipt(f))!;
    assert.equal(reconciled.state, "posted");
    assert.equal(reconciled.nativeDeliveryId, "native-delivery-1");
    assert.equal(reconciled.renderedText, publishedWrapper(input.text));
    assert.equal(reconciled.messageId, input.messageId);
    assert.equal(reconciled.hash, receipt.hash);
    const reconciledRequest = yield* helperRequest(f);
    assert.equal(reconciledRequest.id, request.id);
    assert.equal(reconciledRequest.messageId, request.messageId);
    assert.equal(reconciledRequest.state, "waiting");
    assert.ok(rpcRequests(f.peer, "scheduledTasks.getWebhookDelivery").length >= 1);
    assertCredentials(f);
  }), {timeout: 60_000});
}

it.live("CT-INT-03: H2 a stalled 2xx body is read until the caller's deadline, then stays uncertain as recorded acceptance", () => Effect.gen(function* () {
  const h = yield* startHelperScenario();
  const {f} = h;
  f.peer.webhook = () => Effect.succeed({raw: (_request, response) => {
    response.writeHead(202, {"content-type": "application/json"});
    response.write("{\"deliveryId\":");
  }});
  const deadlineMs = 3_000;
  const started = yield* Clock.monotonicTimeNanos;
  yield* runBatch(h, Duration.millis(deadlineMs));
  const elapsed = Number((yield* Clock.monotonicTimeNanos) - started) / 1_000_000;
  assert.ok(elapsed >= deadlineMs, `the body read waits for the caller's signal (${Math.round(elapsed)} ms)`);
  assert.ok(elapsed < deadlineMs + 10_000, `the stalled body ends with the caller's signal (${Math.round(elapsed)} ms)`);
  assert.equal(webhookPosts(f.peer).length, 1);
  const receipt = (yield* helperReceipt(f))!;
  assert.equal(receipt.state, "posted");
  assert.equal("nativeDeliveryId" in receipt, false);
  assert.equal((yield* helperRequest(f)).state, "uncertain");
  assert.equal((yield* helperTeamRequest(f)).state, "uncertain");
  assertCredentials(f);
}), {timeout: 60_000});

/* H3 holds CT-HTX-03's unreadable 2xx body too: the same single POST, posted receipt without a delivery id and uncertain outcome,
 * over a chunked body where the baseline declared a longer length.
 */
it.live("CT-INT-03: H3 (CT-HTX-03) an unreadable 2xx body cut by socket loss stays uncertain as recorded acceptance", () => Effect.gen(function* () {
  const h = yield* startHelperScenario();
  const {f} = h;
  f.peer.webhook = () => Effect.succeed({raw: (request, response) => {
    response.writeHead(202, {"content-type": "application/json"});
    response.write("{\"deliveryId\":", () => request.socket.destroy());
  }});
  yield* runBatch(h);
  assert.equal(webhookPosts(f.peer).length, 1);
  const receipt = (yield* helperReceipt(f))!;
  assert.equal(receipt.state, "posted");
  assert.equal("nativeDeliveryId" in receipt, false);
  assert.equal((yield* helperRequest(f)).state, "uncertain");
  assert.equal((yield* helperTeamRequest(f)).state, "uncertain");
  assertCredentials(f);
}), {timeout: 60_000});

it.live("CT-INT-03: H4b a quarantine committed during the channel upsert revokes the send and settles its fence", () => Effect.gen(function* () {
  const h = yield* startHelperScenario();
  const {f} = h;
  // the quarantine committed on the peer's hook, before the upsert reply
  f.peer.onUpsert = once(Effect.flatMap(f.binding, (binding) => f.core.team.quarantineMember(binding, "helper")).pipe(Effect.asVoid, Effect.orDie));
  yield* runBatch(h);
  assert.equal(webhookPosts(f.peer).length, 0);
  assert.equal(yield* helperReceipt(f), null);
  assert.equal((yield* helperRequest(f)).state, "failed");
  assert.equal((yield* helperTeamRequest(f)).state, "settled");
  const events = (yield* f.core.team.snapshot(yield* f.binding)).events;
  assert.equal(events.some(event => event.kind === "service_attention" && event.id.startsWith("helper-checkin-failed:")), true);
  assertCredentials(f);
}), {timeout: 60_000});

it.live("CT-INT-03: H6 a 307 reply makes Node fetch re-POST the same body to the redirect target", () => Effect.gen(function* () {
  const h = yield* startHelperScenario();
  const {f} = h;
  f.peer.webhook = (entry, deliveryId) => Effect.succeed(entry.path === hookPath ? {raw: (_request, response) => {
    response.writeHead(307, {location: redirectedHookPath, "content-length": 0});
    response.end();
  }} : json(202, {deliveryId}));
  yield* runBatch(h);
  const posts = webhookPosts(f.peer);
  assert.deepEqual(posts.map(entry => entry.path), [hookPath, redirectedHookPath]);
  assert.equal(posts[1]!.body, posts[0]!.body);
  assert.equal(posts[1]!.contentType, "application/json");
  const receipt = (yield* helperReceipt(f))!;
  assert.equal(receipt.state, "posted");
  assert.equal(receipt.nativeDeliveryId, "native-delivery-2");
  assert.equal((yield* helperRequest(f)).state, "waiting");
  assertCredentials(f);
}), {timeout: 60_000});

/* Sol-r19-01 on the real caller: the receipt of an accepted check-in replaced by bytes the transport did not write. The
 * team runtime's reconciliation reaches the send, which stays uncertain on the unreadable receipt; the request keeps
 * its identity, its fence stays unresolved, nothing is posted again and the row keeps its bytes, active or stopped.
 */
const rawReceipt = (f: Scenario): Effect.Effect<string> => Effect.map(row(f.core.sql, "SELECT document FROM supervisor_helper_deliveries"),
  (found) => String(found!.document));
for (const [label, corrupt] of [
  ["an unparsable", (_valid: string) => "{\"threadId\":"],
  ["a wrong-shape", (valid: string) => JSON.stringify({...JSON.parse(valid) as object, state: "delivered"})],
] as const) {
  it.live(`SOL-R19-01: ${label} receipt of an accepted check-in stays unresolved through active and stopped reconciliation and is never posted again`, () => Effect.gen(function* () {
    const h = yield* startHelperScenario();
    const {f} = h;
    yield* runBatch(h);
    assert.equal(webhookPosts(f.peer).length, 1);
    const request = yield* helperRequest(f);
    const fence = yield* helperTeamRequest(f);
    assert.equal(request.state, "waiting");
    yield* execute(f.core.sql, "UPDATE supervisor_helper_deliveries SET document=?", corrupt(yield* rawReceipt(f)));
    const invalid = yield* rawReceipt(f);

    const binding = yield* f.binding;
    yield* f.core.teamRuntime.startCycle(binding);
    yield* f.core.teamRuntime.reconcile(binding, h.threads);
    const reconciled = yield* helperRequest(f);
    assert.deepEqual([reconciled.id, reconciled.messageId, reconciled.text, reconciled.state], [request.id, request.messageId, request.text, "uncertain"]);
    assert.deepEqual([(yield* helperTeamRequest(f)).requestId, (yield* helperTeamRequest(f)).state], [fence.requestId, "uncertain"], "its fence stays unresolved");
    assert.equal(webhookPosts(f.peer).length, 1, "nothing is posted again");
    assert.equal(yield* rawReceipt(f), invalid, "the receipt keeps its bytes");

    yield* f.stop();
    yield* f.core.teamRuntime.startCycle(binding);
    yield* f.core.teamRuntime.reconcileStopped(binding, h.threads);
    assert.deepEqual([(yield* helperRequest(f)).id, (yield* helperRequest(f)).state], [request.id, "uncertain"], "the stopped reconciliation neither fails nor releases it");
    assert.deepEqual([(yield* helperTeamRequest(f)).requestId, (yield* helperTeamRequest(f)).state], [fence.requestId, "uncertain"]);
    assert.equal(webhookPosts(f.peer).length, 1);
    assert.equal(yield* rawReceipt(f), invalid);
    assertCredentials(f);
  }), {timeout: 60_000});
}
