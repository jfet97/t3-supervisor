import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Context, Deferred, Effect, Fiber, Layer, Queue } from "effect";
import { TestClock } from "effect/testing";
import { defaultSupervisorModel } from "../src/project-supervisor-store.js";
import { makeSupervisionGate, SupervisionGate, SupervisionScope, SupervisionScopeService } from "../src/supervision-gate.js";
import { SupervisorCompaction } from "../src/supervisor-compaction.js";
import { roleDeliveryVersion } from "../src/supervisor-compaction-contract.js";
import { NativeOperateRpc, SupervisorRpcError } from "../src/supervisor-native.js";
import { T3Client, T3TransportError } from "../src/t3.js";
import type { JsonRecord } from "../src/types.js";
import { WorkflowStateStore } from "../src/workflow-state-store.js";
import { conversationUnit, dataDirectory, nativeClient, openStores, t3Projections, workflowStore } from "./support/g1a-conversation.js";
import { baseTime, emptySupervisorProjection, makeSourceProjection } from "./support/ps-fixture.js";
import { nativeWrites, rpcRequests, startScenario } from "./support/scenario-driver.js";

// the real scoped controller, stores, policy and admission gate; only native I/O is synthetic
const fixture = Effect.fnUntraced(function* () {
  const directory = yield* dataDirectory("supervisor-compaction-");
  const stores = yield* openStores(directory, directory);
  const store = stores.supervisors;
  yield* store.saveControl("project-a", 0, true, {version: 2, snapshotSequence: 1, threads: []});
  const reserved = yield* store.reserve("project-a", "main", "Local task", defaultSupervisorModel, 1, Date.parse(baseTime));
  const binding = {...reserved, state: "ready" as const};
  yield* store.setBinding(binding);
  const projection = emptySupervisorProjection(binding.threadId, binding.projectId, defaultSupervisorModel);
  projection.thread.activeRunId = "root-run";
  projection.runs.push({id: "root-run", threadId: binding.threadId, ordinal: 1, status: "running", requestedAt: baseTime,
    startedAt: baseTime, completedAt: null, rootNodeId: "root-node", activeAttemptId: "root-attempt", providerThreadId: "provider-thread"});
  projection.providerThreads = [{id: "provider-thread", providerSessionId: "provider-session"}];
  projection.providerSessions = [{id: "provider-session", capabilities: {turns: {supportsActiveSteering: true}}}];
  projection.providerTurns = [{id: "provider-turn", runAttemptId: "root-attempt", nodeId: "root-node", status: "running"}];
  projection.nodes = [{id: "root-node", threadId: binding.threadId, runId: "root-run", kind: "root_turn"}];
  projection.runtimeRequests = [];
  projection.turnItems = [];
  const scope = new SupervisionScope({dataDirectory: directory, t3Url: "http://unused", t3TokenFile: "", excludedThreadIds: [], healthPort: 0},
    {guidance: stores.guidance, supervisors: store, policy: stores.policy}, true);
  const main = makeSourceProjection("main", "project-a", []).thread;
  yield* scope.rememberCatalog([{id: "project-a", workspaceRoot: "/work/a"}], [main, projection.thread]);
  const gate = yield* makeSupervisionGate(scope).pipe(Effect.provide(stores.context));
  const workflows = yield* workflowStore(stores);
  const subscribed = yield* Deferred.make<void>();
  const closed = yield* Deferred.make<void>();
  const reconnected = yield* Deferred.make<void>();
  const events = yield* Queue.unbounded<{item?: JsonRecord; failure?: T3TransportError; done: Deferred.Deferred<void>}>();
  const calls: Record<string, unknown>[] = [];
  const cursors: Array<number | undefined> = [];
  let subscriptions = 0;
  let read: Effect.Effect<void> = Effect.void;
  let reply: "accepted" | "uncertain" | "rejected" = "accepted";
  const native = nativeClient((tag, payload) => {
    assert.equal(tag, "orchestration.dispatchCommand");
    assert.equal(payload.type, "message.dispatch");
    calls.push(payload);
    if (reply === "uncertain") throw new SupervisorRpcError("uncertain");
    if (reply === "rejected") throw new SupervisorRpcError("rejected", true);
    projection.messages.push({id: String(payload.messageId), threadId: binding.threadId, runId: "root-run", nodeId: "root-node", role: "user",
      text: String(payload.text), streaming: false, createdAt: baseTime, updatedAt: baseTime});
    return {sequence: 100};
  });
  let replyGate: Effect.Effect<void> = Effect.void;
  const dispatching = yield* Deferred.make<void>();
  const operate = {...native, initiate: (tag: string, payload: Readonly<Record<string, unknown>>) => Effect.map(native.initiate(tag, payload),
    flight => ({...flight, result: Effect.andThen(Deferred.succeed(dispatching, undefined), Effect.andThen(Effect.suspend(() => replyGate), flight.result))}))};
  const port = {...t3Projections(() => Effect.succeed(projection)),
    projection: () => Effect.andThen(Effect.suspend(() => read), Effect.sync(() => ({snapshotSequence: 100, projection: structuredClone(projection)}))),
    watchThread: (_threadId: string, cursor: number | undefined, onItem: (item: JsonRecord) => Effect.Effect<void>) => Effect.gen(function* () {
      subscriptions++;
      cursors.push(cursor);
      yield* Deferred.succeed(subscribed, undefined);
      if (subscriptions > 1) yield* Deferred.succeed(reconnected, undefined);
      return yield* Effect.forever(Effect.flatMap(Queue.take(events), ({item, failure, done}) =>
        (failure ? Effect.fail(failure) : onItem(item!)).pipe(Effect.ensuring(Deferred.succeed(done, undefined)))));
    }).pipe(Effect.ensuring(Deferred.succeed(closed, undefined))),
  };
  const context = yield* Layer.build(SupervisorCompaction.layer.pipe(Layer.provide(Layer.mergeAll(
    Layer.succeedContext(stores.context), Layer.succeed(SupervisionScopeService, scope), Layer.succeed(SupervisionGate, gate),
    Layer.succeed(T3Client, port), Layer.succeed(NativeOperateRpc, operate), Layer.succeed(WorkflowStateStore, workflows)))));
  const service = Context.get(context, SupervisorCompaction);
  const publish = (item: JsonRecord) => Effect.gen(function* () {
    const done = yield* Deferred.make<void>();
    yield* Queue.offer(events, {item, done});
    yield* Deferred.await(done);
  });
  const item = (status = "running", extra: JsonRecord = {}): JsonRecord => ({id: "compact-1", threadId: binding.threadId,
    runId: "root-run", nodeId: "root-node", ordinal: 1, type: "compaction", status, ...extra});
  const event = (payload: JsonRecord, sequence = 21) => publish({kind: "event", sequence, event: {type: "turn-item.updated", payload}});
  const start = Effect.andThen(service.sync, Deferred.await(subscribed));
  const stop = gate.admit(() => Effect.flatMap(stores.policy.get(), policy => stores.policy.save({...policy, excludedThreadIds: ["main"]})));
  const disconnect = Effect.gen(function* () {
    const done = yield* Deferred.make<void>();
    yield* Queue.offer(events, {failure: new T3TransportError("synthetic connection loss"), done});
    yield* Deferred.await(done);
  });
  return {directory, stores, store, binding, projection, scope, gate, service, workflows, calls, item, event, publish, start, stop, closed,
    cursors, reconnected, disconnect, dispatching, get subscriptions() {return subscriptions;}, set read(effect: Effect.Effect<void>) {read = effect;},
    set reply(value: typeof reply) {reply = value;}, set replyGate(effect: Effect.Effect<void>) {replyGate = effect;}};
});

it.effect("one short native steer covers duplicate and cascaded root compactions without creating a new run or wake", () => Effect.gen(function* () {
  const f = yield* fixture();
  yield* f.start;
  const first = f.item();
  f.projection.turnItems = [first];
  yield* f.event(first);
  assert.equal(f.calls.length, 1);
  const sent = f.calls[0]!;
  assert.deepEqual(sent.dispatchMode, {type: "steer_active", targetRunId: "root-run"});
  assert.equal(sent.threadId, f.binding.threadId);
  assert.equal(f.projection.runs.length, 1);
  const text = String(sent.text);
  assert.ok(text.length < 900, `reminder length ${text.length}`);
  assert.match(text, /reread core\/index.*even if its version is unchanged/u);
  assert.match(text, /Check your inbox/u);
  assert.doesNotMatch(text, /UNTRUSTED_|"plan"|"requirements"|mcpx|MCPX/u);
  assert.equal((yield* f.store.binding("project-a", "main"))?.compactionReminder?.state, "accepted");
  yield* f.event(first);
  const cascade = f.item("running", {id: "compact-2", ordinal: 2});
  f.projection.turnItems!.push(cascade);
  yield* f.event(cascade);
  yield* f.service.sync;
  assert.equal(f.calls.length, 1);
  assert.equal(f.subscriptions, 1, "membership reconciliation keeps the same subscription");
  assert.equal((yield* f.stores.requests.pending("project-a", f.binding.threadId)), null, "no check-in was prepared");
  first.status = "completed";
  cascade.status = "completed";
  yield* f.event(cascade);
  const current = (yield* f.store.binding("project-a", "main"))!;
  assert.equal(current.roleCompaction?.itemId, "compact-2");
  assert.equal(current.compactionReminder?.state, "visible");
  yield* f.stop;
  yield* f.service.sync;
  yield* Deferred.await(f.closed);
}));

it.effect("no-compaction traffic and foreign, child, failed or stale compactions cause no reminder or role reset", () => Effect.gen(function* () {
  const f = yield* fixture();
  yield* f.start;
  yield* f.publish({kind: "snapshot", snapshotSequence: 10, projection: structuredClone(f.projection)});
  const excluded = [f.item("failed"), f.item("completed", {id: " "}), f.item("running", {threadId: "child"}), f.item("completed", {nodeId: "child-node"}),
    f.item("completed", {runId: "other-run"}), {...f.item(), type: "dynamic_tool"}];
  for (const candidate of excluded) {
    f.projection.turnItems = [candidate];
    yield* f.event(candidate);
  }
  f.projection.thread.activeRunId = "new-run";
  f.projection.turnItems = [f.item()];
  yield* f.event(f.item());
  assert.deepEqual(f.calls, []);
  assert.equal((yield* f.store.binding("project-a", "main"))?.roleCompaction, undefined);
}));

it.effect("unsupported or tool-interrupting native steering, live tools and pending approvals use the ordinary-wake backup", () => Effect.gen(function* () {
  for (const obstacle of ["capability", "tool-interrupting", "invalid-tool-interruption", "tool", "approval"] as const) {
    const f = yield* fixture();
    if (obstacle === "capability") f.projection.providerSessions = [{id: "provider-session", capabilities: {turns: {supportsActiveSteering: false}}}];
    if (obstacle === "tool-interrupting") f.projection.providerSessions = [{id: "provider-session", capabilities: {turns: {supportsActiveSteering: true, activeSteeringInterruptsTools: true}}}];
    if (obstacle === "invalid-tool-interruption") f.projection.providerSessions = [{id: "provider-session", capabilities: {turns: {supportsActiveSteering: true, activeSteeringInterruptsTools: "false"}}}];
    if (obstacle === "approval") f.projection.runtimeRequests = [{nodeId: "root-node", status: "pending"}];
    const compaction = f.item();
    f.projection.turnItems = [compaction];
    if (obstacle === "tool") f.projection.turnItems.push({id: "tool", threadId: f.binding.threadId, runId: "root-run", type: "dynamic_tool", status: "running"});
    yield* f.start;
    yield* f.event(compaction);
    assert.equal(f.calls.length, 0, obstacle);
    compaction.status = "completed";
    yield* f.event(compaction);
    assert.equal((yield* f.store.binding("project-a", "main"))?.roleCompaction?.itemId, compaction.id, obstacle);
  }
}));

it.effect("Stop, disable and binding replacement during the native read win final send admission", () => Effect.gen(function* () {
  for (const change of ["stop", "disable", "replace"] as const) {
    const f = yield* fixture();
    const reading = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    f.read = Effect.andThen(Deferred.succeed(reading, undefined), Deferred.await(release));
    f.projection.turnItems = [f.item()];
    yield* f.start;
    const pending = yield* Effect.forkChild(f.event(f.item()));
    yield* Deferred.await(reading);
    if (change === "stop") yield* f.stop;
    if (change === "disable") yield* f.gate.admit(() => Effect.flatMap(f.store.control("project-a"), control => f.store.saveControl("project-a", control.generation, false)));
    if (change === "replace") yield* f.gate.admit(() => Effect.gen(function* () {
      const missing = {...f.binding, state: "missing" as const};
      yield* f.store.setBinding(missing);
      yield* f.store.replaceMissingBinding(missing, defaultSupervisorModel);
    }));
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(pending);
    assert.equal(f.calls.length, 0, change);
    assert.equal((yield* f.store.binding("project-a", "main"))?.compactionReminder, undefined, change);
  }
}));

it.effect("lost replies retain one immutable attempt, and only its exact root message resolves native visibility", () => Effect.gen(function* () {
  const f = yield* fixture();
  f.reply = "uncertain";
  const compaction = f.item();
  f.projection.turnItems = [compaction];
  yield* f.start;
  yield* f.event(compaction);
  const receipt = (yield* f.store.binding("project-a", "main"))!.compactionReminder!;
  assert.equal(receipt.state, "uncertain");
  const reopened = yield* openStores(f.directory, f.directory);
  assert.deepEqual((yield* reopened.supervisors.binding("project-a", "main"))?.compactionReminder, receipt, "the uncertain identity survives reopening stores");
  yield* f.event(compaction);
  f.projection.runs[0]!.status = "completed";
  const nextRun = {...f.projection.runs[0]!, id: "next-run", ordinal: 2, status: "running", rootNodeId: "next-root", activeAttemptId: "next-attempt"};
  f.projection.runs.push(nextRun);
  f.projection.thread.activeRunId = nextRun.id;
  f.projection.providerTurns = [{id: "next-provider-turn", runAttemptId: "next-attempt", nodeId: "next-root", status: "running"}];
  const laterCompaction = f.item("running", {id: "next-compaction", runId: nextRun.id, nodeId: "next-root"});
  f.projection.turnItems!.push(laterCompaction);
  yield* f.event(laterCompaction);
  assert.equal(f.calls.length, 1, "a later run does not overwrite an unresolved delivery identity");
  laterCompaction.status = "completed";
  yield* f.event(laterCompaction);
  assert.equal((yield* f.store.binding("project-a", "main"))?.roleCompaction?.runId, nextRun.id, "the ordinary-wake backup still refreshes");
  const message = {id: receipt.messageId, threadId: "foreign-thread", runId: "root-run", nodeId: "root-node", role: "user",
    text: receipt.text, streaming: false, createdAt: baseTime, updatedAt: baseTime};
  f.projection.messages.push(message);
  yield* f.service.observe(f.binding, f.projection);
  assert.equal((yield* f.store.binding("project-a", "main"))?.compactionReminder?.state, "uncertain");
  message.threadId = f.binding.threadId;
  yield* f.service.observe(f.binding, f.projection);
  assert.deepEqual((yield* f.store.binding("project-a", "main"))?.compactionReminder, {...receipt, state: "visible"});
  assert.equal(f.calls.length, 1, "neither replay nor reconciliation requeues the reminder");
}));

it.effect("a disconnected listener resumes at its last handled native sequence and does not duplicate a reminder", () => Effect.gen(function* () {
  const f = yield* fixture();
  f.projection.turnItems = [f.item()];
  yield* f.start;
  yield* f.event(f.item(), 23);
  yield* f.disconnect;
  yield* TestClock.adjust("1 second");
  yield* Deferred.await(f.reconnected);
  assert.deepEqual(f.cursors, [undefined, 23]);
  yield* f.event(f.item(), 23);
  assert.equal(f.calls.length, 1);
}));

it.effect("Stop interrupts a pending receipt without losing its original native command identity", () => Effect.gen(function* () {
  const f = yield* fixture();
  f.replyGate = Effect.never;
  f.projection.turnItems = [f.item()];
  yield* f.start;
  const pending = yield* Effect.forkChild(f.event(f.item()));
  yield* Deferred.await(f.dispatching);
  const sending = (yield* f.store.binding("project-a", "main"))!.compactionReminder!;
  assert.equal(sending.state, "sending");
  yield* f.stop;
  yield* f.service.sync;
  yield* Fiber.join(pending);
  const interrupted = (yield* f.store.binding("project-a", "main"))!.compactionReminder!;
  assert.deepEqual(interrupted, {...sending, state: "uncertain"});
  assert.equal(f.calls.length, 1);
}));

it.effect("completed compaction invalidates the ordinary role acknowledgment; late completions and stale writes cannot undo it", () => Effect.gen(function* () {
  const f = yield* fixture();
  const conversation = yield* conversationUnit({stores: f.stores, operate: null, projection: () => Effect.succeed(f.projection),
    eligible: () => true, workflows: f.workflows});
  const initial = (yield* conversation.rootWake(f.binding))!;
  assert.ok(initial.roleVersion);
  yield* f.store.acknowledgeRole(f.binding, initial.roleVersion);
  assert.equal((yield* conversation.rootWake(f.binding))?.roleVersion, undefined);
  const completed = f.item("completed");
  f.projection.turnItems = [completed];
  yield* f.service.observe(f.binding, f.projection);
  yield* f.store.acknowledgeRole(f.binding, initial.roleVersion);
  yield* f.store.setBinding({...f.binding, quietSince: 123});
  const backup = (yield* conversation.rootWake(f.binding))!;
  assert.match(backup.text, /Context compacted: reread core\/index even if this instructions version is unchanged/u);
  assert.ok(backup.roleVersion && backup.roleVersion !== initial.roleVersion);
  yield* f.store.acknowledgeRole(f.binding, backup.roleVersion);
  yield* f.store.acknowledgeRole(f.binding, initial.roleVersion);
  assert.equal((yield* conversation.rootWake(f.binding))?.roleVersion, undefined);
  assert.equal((yield* f.store.binding("project-a", "main"))?.deliveredRoleVersion, backup.roleVersion);
  const newer = f.item("completed", {id: "compact-2", ordinal: 2});
  f.projection.turnItems!.push(newer);
  yield* f.service.observe(f.binding, f.projection);
  yield* f.store.acknowledgeRole(f.binding, backup.roleVersion);
  const latest = (yield* f.store.binding("project-a", "main"))!;
  assert.equal(latest.roleCompaction?.itemId, "compact-2");
  assert.equal((yield* conversation.rootWake(f.binding))?.roleVersion, roleDeliveryVersion(initial.roleVersion, latest));
  assert.equal(yield* f.store.recordCompaction(f.binding, {itemId: "older", runId: "root-run", runOrdinal: 1, itemOrdinal: 1}), false);
  assert.equal(yield* f.store.recordCompaction(f.binding, {itemId: "earlier-run", runId: "old-run", runOrdinal: 0, itemOrdinal: 999}), false);
  const missing = {...latest, state: "missing" as const};
  yield* f.store.setBinding(missing);
  const replacement = yield* f.store.replaceMissingBinding(missing, defaultSupervisorModel);
  assert.equal(replacement.roleCompaction, undefined);
  assert.equal(replacement.compactionReminder, undefined);
  assert.equal(replacement.deliveredRoleVersion, undefined);
  yield* f.store.acknowledgeRole(f.binding, backup.roleVersion);
  assert.equal((yield* f.store.binding("project-a", "main"))?.deliveredRoleVersion, undefined);
}));

it.live("the production graph receives a native subscription snapshot and sends one guarded steer through the operate transport", () => Effect.gen(function* () {
  const f = yield* startScenario();
  const binding = yield* f.bindSupervisor;
  const root = yield* f.supervisor;
  root.thread.activeRunId = "compacting-run";
  root.runs.push({id: "compacting-run", threadId: binding.threadId, ordinal: 1, status: "running", requestedAt: baseTime,
    startedAt: baseTime, completedAt: null, rootNodeId: "root-node", activeAttemptId: "attempt", providerThreadId: "provider-thread"});
  root.providerThreads = [{id: "provider-thread", providerSessionId: "session"}];
  root.providerSessions = [{id: "session", capabilities: {turns: {supportsActiveSteering: true}}}];
  root.providerTurns = [{id: "provider-turn", runAttemptId: "attempt", nodeId: "root-node", status: "running"}];
  root.turnItems!.push({id: "native-compaction", threadId: binding.threadId, runId: "compacting-run", nodeId: "root-node", ordinal: 1,
    type: "compaction", status: "running"});
  const arrived = yield* Deferred.make<void>();
  f.peer.onRpc = entry => {
    if (entry.tag !== "orchestration.dispatchCommand" || entry.payload.type !== "message.dispatch") return Effect.succeed(undefined);
    const payload = entry.payload;
    root.messages.push({id: String(payload.messageId), threadId: binding.threadId, runId: "compacting-run", nodeId: "root-node", role: "user",
      text: String(payload.text), streaming: false, createdAt: baseTime, updatedAt: baseTime});
    return Deferred.succeed(arrived, undefined).pipe(Effect.as(undefined));
  };
  yield* f.runOnce;
  yield* Deferred.await(arrived);
  yield* f.runOnce;
  const subscriptions = rpcRequests(f.peer, "orchestration.subscribeThread");
  assert.equal(subscriptions.length, 1, "the peer keeps the stream open across cycles");
  assert.equal(subscriptions[0]?.authorization, "Bearer int-read-token");
  assert.deepEqual(subscriptions[0]?.payload, {requestCompletionMarker: true, threadId: binding.threadId, acceptBoundedSnapshot: true});
  const writes = nativeWrites(f.peer);
  assert.equal(writes.length, 1);
  assert.equal(writes[0]?.kind, "rpc");
  const sent = rpcRequests(f.peer, "orchestration.dispatchCommand")[0]!;
  assert.equal(sent.authorization, "Bearer int-operate-token");
  assert.deepEqual(sent.payload.dispatchMode, {type: "steer_active", targetRunId: "compacting-run"});
  assert.equal(sent.payload.threadId, binding.threadId);
  assert.equal((yield* f.binding).compactionReminder?.state, "visible");
  assert.deepEqual(f.peer.unexpected, []);
}), {timeout: 10_000});
