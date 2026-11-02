import assert from "node:assert/strict";
import { NodeCrypto } from "@effect/platform-node";
import { describe, it } from "@effect/vitest";
import { Context, Data, Deferred, Effect, Exit, Fiber, Layer } from "effect";
import { FetchHttpClient } from "effect/http";
import { NativeEnvelope } from "../src/native-envelope.js";
import { NativeOperateRpc, NativeRpc, NativeShell } from "../src/supervisor-native.js";
import { T3Client, type T3ClientOptions } from "../src/t3.js";
import {
  isHelperWebhookPath, T3FileError, T3InvalidInput, T3Native, T3ReadError, T3RequestError, T3TerminalError, T3WebhookError, webhookBody, type OrchestrationCommand,
  type T3InFlight, type TerminalAttachEvent, type TurnItemView,
} from "../src/t3-native/index.js";
import { canonicalJson, recognisedWorkflowCallArguments, verifyWorkflowToolEvidence } from "../src/workflow-write-evidence.js";
import { httpRequests, intPeer, json, rpcRequests, type IntNativePeer, type PeerRpcEntry, type RpcAnswer } from "./support/int-native-peer.js";
import * as fx from "./support/s6e-prep-interpretation.js";

/*
 * T3Native at the native boundary (it.live): the production service over the production clients of each credential, on real loopback
 * sockets to the scripted peer. Each case asserts the typed answer, the native requests per route and credential, and the
 * acknowledgements the peer received.
 */

const transport = Layer.mergeAll(NativeEnvelope.layer, FetchHttpClient.layer, NodeCrypto.layer);
const credential = (peer: IntNativePeer, token: string) => ({baseUrl: peer.baseUrl, token});

type NativeOptions = {
  // false: no operate credential, as a run without its token file
  readonly operate?: boolean;
  // false: no project-write, commit or probe credential
  readonly optional?: boolean;
  readonly t3?: Omit<T3ClientOptions, "baseUrl" | "token">;
};

// the production T3Native, built as the composition root builds it, over one token per credential
const nativeOf = (peer: IntNativePeer, options: NativeOptions = {}) => Effect.map(Layer.build(T3Native.layer({
  baseUrl: peer.baseUrl, read: credential(peer, "read-token"),
  ...(options.optional === false ? {} : {projectWrite: credential(peer, "write-token"), commit: credential(peer, "commit-token"), probe: credential(peer, "probe-token")}),
}).pipe(
  Layer.provideMerge(Layer.mergeAll(
    NativeShell.layer(credential(peer, "read-token")).pipe(Layer.provideMerge(NativeRpc.layer(credential(peer, "read-token")))),
    options.operate === false ? Layer.empty : NativeOperateRpc.layer(credential(peer, "operate-token")),
    T3Client.layer({baseUrl: peer.baseUrl, token: "read-token", ...options.t3}),
  )),
  Layer.provide(transport),
)), (context) => Context.get(context, T3Native));

const classification = (error: T3RequestError) => ({outcome: error.outcome, definiteRejection: error.definiteRejection,
  providerDisabled: error.providerDisabled, dispatchCommandFailure: error.dispatchCommandFailure, malformedReply: error.malformedReply});
// awaits the reply, then releases the request
const settle = <A, E>(flight: T3InFlight<A, E>) => flight.result.pipe(Effect.ensuring(flight.release));
// the subscription never received an Ack: it closed with chunks still unacknowledged
const unacknowledged = (stream: {readonly acknowledged: Effect.Effect<void>}) => Effect.map(Effect.exit(stream.acknowledged), Exit.isFailure);
// the last subscription the peer opened for a request, whether it is still open or already closed
const lastStream = (peer: IntNativePeer, matches: (entry: PeerRpcEntry) => boolean) => {
  const stream = peer.streams.filter((candidate) => matches(candidate.entry)).at(-1);
  assert.ok(stream !== undefined);
  return stream;
};

const shellSnapshot = (snapshotSequence: number) =>
  ({kind: "snapshot", snapshot: {schemaVersion: 2, snapshotSequence, projects: [], threads: [], archivedThreads: []}});
const helperTask = {id: "task-1", title: "Supervisor helper check-ins", prompt: "{{body.text}}", enabled: true, schedule: {type: "webhook", signature: null},
  projectId: "project-1", threadId: "helper-1", workspaceStrategy: {type: "root"}, modelSelection: {instanceId: "codex", model: "gpt-5"}, runtimeMode: "full-access",
  interactionMode: "default", createdBy: "system", creationSource: "server", createdAt: "2026-11-02T00:00:00.000Z",
  webhook: {path: "/api/hooks/accepted", url: null, hasSecret: false}, runCount: 0};

class Ingestion extends Data.TaggedError("Ingestion") {}

describe("T3Native at the native boundary", () => {
  it.live("T3N-B01: an input outside its contract is refused before any socket, frame or HTTP request", () => Effect.gen(function* () {
    const peer = yield* intPeer();
    const native = yield* nativeOf(peer);
    const commands = native.orchestration.commands!;
    // readiness keeps the hook prefix; preparation refuses a query or fragment before sending
    assert.equal(isHelperWebhookPath("/elsewhere"), false);
    assert.equal(isHelperWebhookPath("/api/hooks/accepted"), true);
    assert.equal(isHelperWebhookPath("/api/hooks/accepted?token=1"), true);
    assert.equal(isHelperWebhookPath("/api/hooks/accepted#fragment"), true);
    const failures: ReadonlyArray<unknown> = [
      yield* Effect.flip(commands.dispatchCommand.prepare({_tag: "MessageDispatch", commandId: "", messageId: "m", threadId: "t", text: "x",
        dispatchMode: {type: "queue_after_active"}})),
      yield* Effect.flip(commands.dispatchCommand.prepare({_tag: "MessageDispatch", commandId: "c", messageId: "m", threadId: "t", text: "x",
        dispatchMode: {type: "steer_active", targetRunId: ""}})),
      yield* Effect.flip(commands.launchThread.prepare({commandId: "c", threadId: "", projectId: "p", title: "Supervisor",
        modelSelection: {instanceId: "codex", model: "gpt-5", options: []}})),
      yield* Effect.flip(native.orchestration.thread(" ")),
      yield* Effect.flip(native.orchestration.turnItem({threadId: "t", itemId: ""})),
      yield* Effect.flip(native.orchestration.watchShell(-1, () => Effect.void)),
      yield* Effect.flip(native.orchestration.watchThread("t", 1.5, () => Effect.void)),
      yield* Effect.flip(native.helper!.postWebhook.prepare({path: "/elsewhere", batchId: "b", text: "x"})),
      yield* Effect.flip(native.helper!.postWebhook.prepare({path: "/api/hooks/accepted?token=1", batchId: "b", text: "x"})),
      yield* Effect.flip(native.helper!.postWebhook.prepare({path: "/api/hooks/accepted#fragment", batchId: "b", text: "x"})),
      yield* Effect.flip(native.helper!.webhookDeliveries({taskId: ""})),
      yield* Effect.flip(native.files.read.readFile({cwd: "/checkout", relativePath: "a\\b"})),
      yield* Effect.flip(native.files.write!.writeFile({cwd: "/checkout", relativePath: ".t3-supervisor/../outside", contents: "x"})),
      yield* Effect.flip(native.files.commit!.commit({cwd: "/checkout", filePaths: [], message: "m", actionId: "action-1"})),
      yield* Effect.flip(native.terminal!.open({threadId: "", terminalId: "terminal-1", cwd: "/checkout", cols: 80, rows: 24, env: {}})),
    ];
    for (const failure of failures) assert.ok(failure instanceof T3InvalidInput, String(failure));
    assert.deepEqual({requests: peer.log.length, sockets: peer.connections.length}, {requests: 0, sockets: 0});
  }), {timeout: 10_000});

  it.live("T3N-B02: each command is the pinned native command on the operate credential, and a named rejection keeps its classification", () =>
    Effect.gen(function* () {
      let sequence = 0;
      const failures: Record<string, unknown> = {
        disabled: {_tag: "ThreadManagementProviderInstanceDisabledError"},
        previously: {_tag: "OrchestratorCommandPreviouslyRejectedError"},
        refused: {_tag: "OrchestrationV2DispatchCommandError"},
      };
      const peer = yield* intPeer([{rpc: (entry): RpcAnswer | undefined => {
        if (entry.tag !== "orchestration.dispatchCommand") return undefined;
        const failure = failures[String(entry.payload.commandId)];
        return failure === undefined ? {value: {sequence: ++sequence, extra: "kept"}} : {failure};
      }}]);
      const native = yield* nativeOf(peer);
      const dispatch = (command: OrchestrationCommand) => Effect.flatMap(native.orchestration.commands!.dispatchCommand.prepare(command),
        (prepared) => Effect.flatMap(prepared.initiate(), settle));
      const system = {attachments: [], createdBy: "system", creationSource: "server"};
      const cases: ReadonlyArray<readonly [OrchestrationCommand, Record<string, unknown>]> = [
        [{_tag: "MessageDispatch", commandId: "c-1", messageId: "m-1", threadId: "t-1", text: "Check in.", dispatchMode: {type: "steer_active", targetRunId: "run-1"}},
          {type: "message.dispatch", commandId: "c-1", messageId: "m-1", threadId: "t-1", text: "Check in.", ...system,
            dispatchMode: {type: "steer_active", targetRunId: "run-1"}}],
        [{_tag: "MessageDispatch", commandId: "c-2", messageId: "m-2", threadId: "t-1", text: "Queued.", dispatchMode: {type: "queue_after_active"}},
          {type: "message.dispatch", commandId: "c-2", messageId: "m-2", threadId: "t-1", text: "Queued.", ...system, dispatchMode: {type: "queue_after_active"}}],
        [{_tag: "ThreadSettle", commandId: "c-3", threadId: "t-2"}, {type: "thread.settle", commandId: "c-3", threadId: "t-2"}],
        [{_tag: "ThreadAutoSettle", commandId: "c-4", threadId: "t-3", snapshotAt: "2026-11-02T00:00:00.000Z"},
          {type: "thread.auto-settle", commandId: "c-4", threadId: "t-3", snapshotAt: "2026-11-02T00:00:00.000Z"}],
        [{_tag: "ThreadStop", commandId: "c-5", threadId: "t-4", stopDelegatedTasks: true, reason: "The bounded planning attempt has ended."},
          {type: "thread.stop", commandId: "c-5", threadId: "t-4", stopDelegatedTasks: true, reason: "The bounded planning attempt has ended."}],
        [{_tag: "QueuedRunCancel", commandId: "c-6", threadId: "t-4", runId: "run-2"}, {type: "queued-run.cancel", commandId: "c-6", threadId: "t-4", runId: "run-2"}],
        [{_tag: "DelegatedCompletionDispose", commandId: "c-7", parentThreadId: "t-5", taskId: "node-1"},
          {type: "delegated_task.completion-delivery.dispose", commandId: "c-7", parentThreadId: "t-5", taskId: "node-1"}],
      ];
      for (const [command, payload] of cases) {
        const receipt = yield* dispatch(command);
        const sent = rpcRequests(peer, "orchestration.dispatchCommand").at(-1)!;
        assert.deepEqual(sent.payload, payload);
        assert.equal(sent.authorization, "Bearer operate-token");
        assert.deepEqual(receipt, {sequence, extra: "kept"});
      }
      const expected: ReadonlyArray<readonly [string, ReturnType<typeof classification>]> = [
        ["disabled", {outcome: "rejected", definiteRejection: true, providerDisabled: true, dispatchCommandFailure: false, malformedReply: false}],
        ["previously", {outcome: "rejected", definiteRejection: true, providerDisabled: false, dispatchCommandFailure: false, malformedReply: false}],
        ["refused", {outcome: "uncertain", definiteRejection: false, providerDisabled: false, dispatchCommandFailure: true, malformedReply: false}],
      ];
      for (const [commandId, classified] of expected) {
        const error = yield* Effect.flip(dispatch({_tag: "ThreadSettle", commandId, threadId: "t-6"}));
        assert.ok(error instanceof T3RequestError);
        assert.deepEqual(classification(error), classified);
      }
      assert.equal(rpcRequests(peer, "orchestration.dispatchCommand").length, cases.length + expected.length);
    }), {timeout: 10_000});

  it.live("T3N-B03: a reply that is not the pinned receipt is uncertain after exactly one initiation; a launch keeps its profile and result", () =>
    Effect.gen(function* () {
      const peer = yield* intPeer([{rpc: (entry): RpcAnswer | undefined => {
        if (entry.tag === "orchestration.dispatchCommand") return {value: {accepted: true}};
        if (entry.tag !== "orchestration.launchThread") return undefined;
        return entry.payload.commandId === "launch-accepted"
          ? {value: {threadId: entry.payload.threadId, projection: {thread: {id: entry.payload.threadId}, runs: []}, resumed: false, sequence: 5}}
          : {value: {sequence: 5}};
      }}]);
      const native = yield* nativeOf(peer);
      const commands = native.orchestration.commands!;
      const prepared = yield* commands.dispatchCommand.prepare({_tag: "ThreadSettle", commandId: "c-1", threadId: "t-1"});
      const flight = yield* prepared.initiate();
      const error = yield* Effect.flip(flight.result);
      assert.equal(yield* flight.sent, true);
      yield* flight.release;
      assert.deepEqual(classification(error),
        {outcome: "uncertain", definiteRejection: false, providerDisabled: false, dispatchCommandFailure: false, malformedReply: true});
      assert.equal(rpcRequests(peer, "orchestration.dispatchCommand").length, 1);

      const modelSelection = {instanceId: "codex", model: "gpt-5", options: [{id: "effort", value: "high"}]};
      const launch = (commandId: string) => Effect.flatMap(commands.launchThread.prepare({commandId, threadId: "supervisor-1", projectId: "project-1",
        title: "Supervisor", modelSelection}), (command) => Effect.flatMap(command.initiate(), settle));
      assert.deepEqual(yield* launch("launch-accepted"),
        {threadId: "supervisor-1", projection: {thread: {id: "supervisor-1"}, runs: []}, resumed: false, sequence: 5});
      assert.deepEqual(rpcRequests(peer, "orchestration.launchThread")[0]!.payload, {commandId: "launch-accepted", threadId: "supervisor-1",
        creationSource: "server", projectId: "project-1", title: "Supervisor", generateTitle: false, modelSelection, runtimeMode: "full-access",
        interactionMode: "default", workspaceStrategy: {type: "root"}});
      assert.equal(rpcRequests(peer, "orchestration.launchThread")[0]!.authorization, "Bearer operate-token");
      const unrecognised = yield* Effect.flip(launch("launch-sequence-only"));
      assert.ok(unrecognised instanceof T3RequestError);
      assert.deepEqual(classification(unrecognised),
        {outcome: "uncertain", definiteRejection: false, providerDisabled: false, dispatchCommandFailure: false, malformedReply: true});
      assert.equal(rpcRequests(peer, "orchestration.launchThread").filter((entry) => entry.payload.commandId === "launch-sequence-only").length, 1);
      assert.equal(peer.connections.length, 3);
    }), {timeout: 10_000});

  it.live("T3N-B04: a present turn item is never a read failure and keeps every native key; only a reply without an item is uncertain", () =>
    Effect.gen(function* () {
      const call = (input: unknown) => ({id: "item-1", type: "dynamic_tool", threadId: "thread-1", runId: null, nodeId: "node-1", parentItemId: null,
        providerThreadId: "provider-thread", providerTurnId: "provider-turn", toolName: "mcpx.mcpx_call_tool", input, ordinal: 4, status: "completed",
        nativeItemRef: {driver: "codex", nativeId: "exec-1", strength: "strong"}, future: {kept: [1, 2]}});
      const target = "t3-supervisor-workflows__workflow_read";
      const items = new Map<string, unknown>([
        ["exact", call({name: target, arguments: {threadId: "thread-2"}})],
        ["wrapper", call({name: target, arguments: {threadId: "thread-2"}, extra: true})],
        ["argument", call({name: target, arguments: {threadId: "thread-2", extra: true}})],
        ["text", call(JSON.stringify({threadId: "thread-2"}))],
        ["numeric-node", {...call({name: target, arguments: {threadId: "thread-2"}}), nodeId: 7}],
        ["array", []],
      ]);
      const replies = new Map<string, unknown>([["unwrapped", items.get("exact")], ["text-reply", "not a record"]]);
      const peer = yield* intPeer([{rpc: (entry) => {
        if (entry.tag !== "orchestration.getTurnItem") return undefined;
        const itemId = String(entry.payload.itemId);
        return {value: replies.has(itemId) ? replies.get(itemId) : {item: items.get(itemId) ?? null}};
      }}]);
      const native = yield* nativeOf(peer);
      const view = (itemId: string) => native.orchestration.turnItem({threadId: "thread-1", itemId});
      const present = (itemId: string) => Effect.map(view(itemId), (read) => {
        assert.ok(read._tag !== "Absent");
        return read;
      });
      const recognised = (itemId: string) => Effect.map(present(itemId), (read) => recognisedWorkflowCallArguments(read.item, "read"));
      const exact = yield* present("exact");
      // the same native value, every key in its order
      assert.equal(exact._tag, "Item");
      assert.equal(JSON.stringify(exact.item), JSON.stringify(items.get("exact")));
      assert.deepEqual(rpcRequests(peer, "orchestration.getTurnItem")[0], {kind: "rpc", tag: "orchestration.getTurnItem", authorization: "Bearer read-token",
        payload: {threadId: "thread-1", itemId: "exact"}});
      // the evidence recognition still sees the native input: an extra wrapper key is refused, an extra argument key mismatches
      assert.equal(canonicalJson(yield* recognised("exact")), canonicalJson({threadId: "thread-2"}));
      assert.equal(yield* recognised("wrapper"), null);
      assert.notEqual(canonicalJson(yield* recognised("argument")), canonicalJson({threadId: "thread-2"}));
      assert.equal((yield* present("text")).item.input, JSON.stringify({threadId: "thread-2"}));
      // an identity field outside the pinned types is still the received evidence, whole, for the verifiers to decide
      const nonconforming = yield* present("numeric-node");
      assert.equal(nonconforming._tag, "Nonconforming");
      assert.equal(JSON.stringify(nonconforming.item), JSON.stringify(items.get("numeric-node")));
      // no item, or an item that is not an object: the callers' pending path
      assert.deepEqual([yield* view("absent"), yield* view("array")], [{_tag: "Absent"}, {_tag: "Absent"}]);
      // a reply that is not a record with an item key is the only unusable answer, uncertain
      for (const itemId of ["unwrapped", "text-reply"]) {
        const malformed = yield* Effect.flip(view(itemId));
        assert.ok(malformed instanceof T3RequestError);
        assert.deepEqual(classification(malformed),
          {outcome: "uncertain", definiteRejection: false, providerDisabled: false, dispatchCommandFailure: false, malformedReply: true});
      }
    }), {timeout: 10_000});

  it.live("T3N-B12: the turn item view hands the unchanged evidence verifier the decisions main makes from the raw reply", () => Effect.gen(function* () {
    const args = fx.plainArguments();
    const state = fx.proofState(args);
    const projection = fx.proofProjection(state);
    const replied = new Map<string, unknown>([
      ["valid", state.item],
      ["numeric-node", {...state.item, nodeId: 7}],
      ["numeric-run", {...state.item, runId: 7}],
      ["array", []],
    ]);
    const peer = yield* intPeer([{rpc: (entry) => entry.tag === "orchestration.getTurnItem"
      ? {value: {item: replied.get(String(entry.payload.itemId)) ?? null}} : undefined}]);
    const native = yield* nativeOf(peer);
    // main hands the verifier the reply's item as received; T3Native hands it the view's item, null when absent
    const verify = (detail: unknown) => verifyWorkflowToolEvidence({projection, supervisorThreadId: fx.rootThreadId, itemId: "tool-item", detail,
      tool: "interpretation", arguments: args});
    const pinned: ReadonlyArray<readonly [string, TurnItemView["_tag"], unknown]> = [
      ["valid", "Item", "verified"],
      ["numeric-node", "Nonconforming", {status: "denied", reason: "native_item_identity_mismatch"}],
      ["numeric-run", "Nonconforming", {status: "pending", reason: "native_input_incomplete"}],
      ["missing", "Absent", {status: "pending", reason: "native_item_unavailable"}],
      ["array", "Absent", {status: "pending", reason: "native_item_unavailable"}],
    ];
    for (const [itemId, tag, decision] of pinned) {
      const read = yield* native.orchestration.turnItem({threadId: fx.rootThreadId, itemId});
      assert.equal(read._tag, tag, itemId);
      const throughView = verify(read._tag === "Absent" ? null : read.item);
      const fromMain = verify(structuredClone(replied.get(itemId) ?? null));
      assert.deepEqual(throughView, fromMain, itemId);
      if (decision === "verified") {
        assert.equal(throughView.status, "verified");
        assert.ok(read._tag !== "Absent");
        // every key kept and the canonical input untouched
        assert.equal(JSON.stringify(read.item), JSON.stringify(state.item));
        assert.equal(canonicalJson(read.item.input), canonicalJson(args));
      } else assert.deepEqual(throughView, decision, itemId);
    }
  }), {timeout: 10_000});

  it.live("T3N-B05: a watch acknowledges a chunk only after its consumer ingested it; a failing consumer, an unknown kind or an archive mismatch get no Ack",
    () => Effect.gen(function* () {
      const archive = {sequence: 7, threads: [] as ReadonlyArray<unknown>};
      const shellChunks: Array<ReadonlyArray<unknown>> = [];
      const threadChunks: Array<ReadonlyArray<unknown>> = [];
      const peer = yield* intPeer([{rpc: (entry): RpcAnswer | undefined => {
        if (entry.tag === "orchestration.subscribeShell") return {stream: shellChunks.shift() ?? []};
        if (entry.tag === "orchestration.subscribeThread") return {stream: threadChunks.shift() ?? []};
        if (entry.tag === "orchestration.getArchivedShellSnapshot") return {value: {schemaVersion: 2, snapshotSequence: archive.sequence, threads: archive.threads}};
        return undefined;
      }}]);
      const native = yield* nativeOf(peer);
      const isShell = (entry: {readonly tag: string}) => entry.tag === "orchestration.subscribeShell";
      const isThread = (entry: {readonly tag: string}) => entry.tag === "orchestration.subscribeThread";

      // ingested: the item and its archive cut reach the consumer whole, then the chunk is acknowledged
      const archived = {id: "archived-1", title: "Archived", lineage: {parentThreadId: null, relationshipToParent: "future-relation"}, archivedAt: "kept"};
      archive.threads = [archived];
      shellChunks.push([shellSnapshot(7)]);
      const seen: Array<unknown> = [];
      const watching = yield* Effect.forkChild(native.orchestration.watchShell(undefined, (item) => Effect.sync(() => {seen.push(item);})));
      yield* (yield* peer.stream(isShell)).acknowledged;
      yield* Fiber.interrupt(watching);
      assert.deepEqual(seen, [{stream: "active", item: shellSnapshot(7), archiveCut: {snapshotSequence: 7, threads: [archived]}}]);

      // a failing consumer: the watch ends with the consumer's own failure and the chunk stays unacknowledged
      threadChunks.push([{kind: "unknown-event", sequence: 3, eventType: "future.event", detail: "kept"}]);
      const failed = yield* Effect.flip(native.orchestration.watchThread("thread-1", undefined, () => Effect.fail(new Ingestion())));
      assert.ok(failed instanceof Ingestion);
      assert.equal(yield* unacknowledged(lastStream(peer, isThread)), true);

      // an unknown shell kind, an archive cut at another revision and an archived thread the store would refuse never reach the consumer
      const refused: Array<readonly [ReadonlyArray<unknown>, number, ReadonlyArray<unknown>, string]> = [
        [[{kind: "mystery", sequence: 1}], 7, [], "T3 subscription item has an unsupported schema or shape"],
        [[shellSnapshot(7)], 8, [], "T3 archived shell snapshot does not match the live shell"],
        [[shellSnapshot(7)], 7, [{id: "", title: "Archived", lineage: {}}], "T3 subscription item has an unsupported schema or shape"],
      ];
      for (const [chunk, archivedSequence, archivedThreads, message] of refused) {
        shellChunks.push(chunk);
        archive.sequence = archivedSequence;
        archive.threads = archivedThreads;
        const ingested: Array<unknown> = [];
        const error = yield* Effect.flip(native.orchestration.watchShell(undefined, (item) => Effect.sync(() => {ingested.push(item);})));
        assert.ok(error instanceof T3ReadError);
        assert.equal(error.message, message);
        assert.deepEqual(ingested, []);
        assert.equal(yield* unacknowledged(lastStream(peer, isShell)), true);
      }

      // a thread's unknown event reaches its consumer whole, then its chunk is acknowledged
      const event = {kind: "unknown-event", sequence: 4, eventType: "future.event", detail: {kept: true}};
      threadChunks.push([event]);
      const events: Array<unknown> = [];
      const threadWatch = yield* Effect.forkChild(native.orchestration.watchThread("thread-1", 3, (item) => Effect.sync(() => {events.push(item);})));
      yield* (yield* peer.stream((entry) => isThread(entry) && entry.payload.afterSequence === 3)).acknowledged;
      yield* Fiber.interrupt(threadWatch);
      assert.equal(JSON.stringify(events), JSON.stringify([event]));
      assert.deepEqual(rpcRequests(peer, "orchestration.subscribeThread").at(-1)!.payload,
        {requestCompletionMarker: true, afterSequence: 3, threadId: "thread-1", acceptBoundedSnapshot: true});
    }), {timeout: 10_000});

  it.live("T3N-B06: the coherent shell pair is read three times at most and then fails closed; a coherent pair gives the anchors", () => Effect.gen(function* () {
    const shell = {archivedSequence: 8};
    const peer = yield* intPeer([{
      http: (entry) => entry.method === "GET" && entry.path === "/api/orchestration/shell"
        ? json(200, {schemaVersion: 2, snapshotSequence: 7, threads: [{id: "active-1", latestRunId: null}], archivedThreads: []}) : undefined,
      rpc: (entry) => entry.tag === "orchestration.getArchivedShellSnapshot"
        ? {value: {schemaVersion: 2, snapshotSequence: shell.archivedSequence, threads: [{id: "archived-1", latestRunId: "run-1"}]}} : undefined,
    }]);
    const native = yield* nativeOf(peer);
    const error = yield* Effect.flip(native.orchestration.shellBaseline);
    assert.deepEqual(classification(error),
      {outcome: "rejected", definiteRejection: false, providerDisabled: false, dispatchCommandFailure: false, malformedReply: false});
    assert.deepEqual({active: httpRequests(peer, "/api/orchestration/shell").length, archived: rpcRequests(peer, "orchestration.getArchivedShellSnapshot").length},
      {active: 3, archived: 3});
    shell.archivedSequence = 7;
    assert.deepEqual(yield* native.orchestration.shellBaseline,
      {snapshotSequence: 7, threads: [{id: "active-1", latestRunId: null}, {id: "archived-1", latestRunId: "run-1"}]});
  }), {timeout: 10_000});

  it.live("T3N-B07: the environment read keeps the client's byte bound and deadline and records the build facts it selects", () => Effect.gen(function* () {
    const descriptor = {environmentId: "environment-1", orchestrationProtocolVersion: 2, serverVersion: "0.1.7-nightly.20261101.4016", extra: "kept"};
    const mode = {current: "whole" as "whole" | "large" | "stalled"};
    const peer = yield* intPeer([{http: (entry) => entry.path !== "/.well-known/t3/environment" ? undefined
      : mode.current === "stalled" ? {raw: () => undefined}
        : json(200, mode.current === "large" ? {...descriptor, padding: "x".repeat(1024)} : descriptor)}]);
    const native = yield* nativeOf(peer, {t3: {maxResponseBytes: 512, httpTimeoutMs: 300}});
    assert.equal(yield* native.build.observed, null);
    assert.equal(JSON.stringify(yield* native.orchestration.environment), JSON.stringify(descriptor));
    assert.deepEqual(yield* native.build.observed,
      {environmentId: "environment-1", serverVersion: "0.1.7-nightly.20261101.4016", orchestrationProtocolVersion: 2, referenceBuild: true});
    mode.current = "large";
    const large = yield* Effect.flip(native.orchestration.environment);
    assert.deepEqual({message: large.message, code: large.code, httpStatus: large.httpStatus},
      {message: "T3 environment descriptor response exceeded the byte limit", code: "response_too_large", httpStatus: undefined});
    mode.current = "stalled";
    const stalled = yield* Effect.flip(native.orchestration.environment);
    assert.deepEqual({message: stalled.message, code: stalled.code}, {message: "T3 environment descriptor request timed out", code: undefined});
  }), {timeout: 10_000});

  it.live("T3N-B08: file requests keep their credentials, payloads, native results and failure classification", () => Effect.gen(function* () {
    const read = {contents: "steps: []\n", byteLength: 10, truncated: false, revision: "kept"};
    const peer = yield* intPeer([{rpc: (entry): RpcAnswer | undefined => {
      switch (entry.tag) {
        case "projects.readFile": return entry.payload.relativePath === ".t3-supervisor/missing.md" ? {failure: {code: "ENOENT"}} : {value: read};
        case "filesystem.getMetadata": return {failure: {_tag: "EnvironmentAuthorizationError"}};
        case "vcs.listRefs": return {value: {isRepo: true, refs: [{name: "main", current: true, isDefault: true, worktreePath: null}], extra: "kept"}};
        case "subscribeVcsStatus": return {stream: [{_tag: "snapshot", local: {isRepo: true, workingTree: {files: [{path: "a.ts"}]}, extra: "kept"}}]};
        case "projects.listEntries": return {value: {truncated: false, entries: [{path: ".t3-supervisor", kind: "directory"}, {path: "link", kind: "symlink"}]}};
        case "projects.writeFile": return {value: {relativePath: entry.payload.relativePath === ".t3-supervisor/echo.md" ? ".t3-supervisor/other.md" : entry.payload.relativePath}};
        case "git.runStackedAction": return entry.payload.actionId === "denied" ? {failure: {_tag: "EnvironmentAuthorizationError"}} : {value: {}};
        default: return undefined;
      }
    }}]);
    const native = yield* nativeOf(peer);
    const files = native.files;
    assert.equal(JSON.stringify(yield* files.read.readFile({cwd: "/checkout", relativePath: ".t3-supervisor/project.yaml"})), JSON.stringify(read));
    assert.deepEqual(rpcRequests(peer, "projects.readFile")[0]!.payload, {cwd: "/checkout", relativePath: ".t3-supervisor/project.yaml"});
    const missing = yield* Effect.flip(files.read.readFile({cwd: "/checkout", relativePath: ".t3-supervisor/missing.md"}));
    assert.ok(missing instanceof T3FileError);
    assert.deepEqual({code: missing.code, scope: missing.scope}, {code: "missing", scope: "read"});
    const denied = yield* Effect.flip(files.read.metadata({paths: ["/checkout/.git"]}));
    assert.ok(denied instanceof T3FileError);
    assert.deepEqual({code: denied.code, scope: denied.scope, message: denied.message},
      {code: "permission_required", scope: "read", message: "Enable filesystem:read on the Supervisor read credential through deployment setup."});
    assert.equal(JSON.stringify(yield* files.read.vcsRefs({cwd: "/checkout"})),
      JSON.stringify({isRepo: true, refs: [{name: "main", current: true, isDefault: true, worktreePath: null}], extra: "kept"}));
    assert.equal(JSON.stringify(yield* files.read.vcsStatus({cwd: "/checkout"})),
      JSON.stringify({isRepo: true, workingTree: {files: [{path: "a.ts"}]}, extra: "kept"}));
    // the first status value ends the subscription without an Ack
    assert.equal(yield* unacknowledged(lastStream(peer, (entry) => entry.tag === "subscribeVcsStatus")), true);
    // a listing keeps an entry kind its reader does not accept: the reader decides
    assert.deepEqual((yield* files.write!.listEntries({cwd: "/checkout", directoryPath: ""})).entries.map((entry) => entry.kind), ["directory", "symlink"]);
    assert.deepEqual(yield* files.write!.writeFile({cwd: "/checkout", relativePath: ".t3-supervisor/project.yaml", contents: "x"}),
      {relativePath: ".t3-supervisor/project.yaml"});
    const echoed = yield* Effect.flip(files.write!.writeFile({cwd: "/checkout", relativePath: ".t3-supervisor/echo.md", contents: "x"}));
    assert.ok(echoed instanceof T3FileError);
    assert.deepEqual({code: echoed.code, scope: echoed.scope}, {code: "unavailable", scope: "write"});
    const commitDenied = yield* Effect.flip(files.commit!.commit({cwd: "/checkout", filePaths: [".t3-supervisor/project.yaml"], message: "Set up", actionId: "denied"}));
    assert.ok(commitDenied instanceof T3FileError);
    assert.deepEqual({code: commitDenied.code, scope: commitDenied.scope}, {code: "permission_required", scope: "write"});
    // an action that finished without creating a commit confirms nothing
    const unfinished = yield* Effect.flip(files.commit!.commit({cwd: "/checkout", filePaths: [".t3-supervisor/project.yaml"], message: "Set up", actionId: "a-1"}));
    assert.ok(unfinished instanceof T3FileError && unfinished.code === "unavailable");
    assert.deepEqual(rpcRequests(peer, "git.runStackedAction").at(-1)!.payload,
      {actionId: "a-1", cwd: "/checkout", action: "commit", commitMessage: "Set up", filePaths: [".t3-supervisor/project.yaml"]});
    const authorizations = (tag: string) => [...new Set(rpcRequests(peer, tag).map((entry) => entry.authorization))];
    assert.deepEqual({read: authorizations("projects.readFile"), refs: authorizations("vcs.listRefs"), status: authorizations("subscribeVcsStatus"),
      list: authorizations("projects.listEntries"), write: authorizations("projects.writeFile"), commit: authorizations("git.runStackedAction")},
    {read: ["Bearer read-token"], refs: ["Bearer read-token"], status: ["Bearer read-token"], list: ["Bearer write-token"], write: ["Bearer write-token"],
      commit: ["Bearer commit-token"]});
  }), {timeout: 10_000});

  it.live("T3N-B09: helper records stay whole, non-object elements invalidate their list, and a POST goes out once on the correct credentials",
    () => Effect.gen(function* () {
      const summary = {id: "delivery-1", taskId: "task-1", receivedAt: "2026-11-02T00:00:01.000Z", method: "POST", contentType: "application/json", bodyBytes: 40,
        outcome: "accepted", signatureVerified: false, missingFields: [], error: null};
      const detail = {...summary, query: "", headers: {}, body: "{}", bodyTruncated: false, renderedPrompt: "<webhook-data-0123456789ab>x</webhook-data-0123456789ab>"};
      // present records whose declared fields break the pinned types
      const oddTask = {...helperTask, id: "task-2", createdAt: 5};
      const oddSummary = {...summary, id: "delivery-2", bodyBytes: -1};
      const oddDetail = {...detail, renderedPrompt: 5};
      const nonObjects: ReadonlyArray<unknown> = [null, 7, "entry", true, []];
      const taskSnapshots: Array<unknown> = [{tasks: [helperTask, oddTask]},
        ...nonObjects.map((entry) => ({tasks: [helperTask, entry, oddTask]})), {tasks: "none"}, {snapshot: [helperTask]}];
      const deliveryLists: Record<string, unknown> = {"task-1": {deliveries: [summary, oddSummary]}, "task-malformed": {deliveries: summary},
        "task-none": {}, ...Object.fromEntries(nonObjects.map((entry, index) => [`task-invalid-${index}`, {deliveries: [summary, entry, oddSummary]}]))};
      const deliveryDetails: Record<string, unknown> = {"delivery-1": {delivery: detail}, "delivery-odd": {delivery: oddDetail}, "delivery-missing": {delivery: null}};
      const upserted: Record<string, unknown> = {"task-1": {task: helperTask}, "task-odd": {task: {...helperTask, id: "task-odd", enabled: "yes"}}, "task-missing": {task: null}};
      const peer = yield* intPeer([{
        rpc: (entry): RpcAnswer | undefined => {
          switch (entry.tag) {
            case "scheduledTasks.subscribe": return {stream: [taskSnapshots.shift()]};
            case "scheduledTasks.upsert": return {value: upserted[String(entry.payload.id)]};
            case "scheduledTasks.delete": return {value: {id: entry.payload.id}};
            case "scheduledTasks.listWebhookDeliveries": return {value: deliveryLists[String(entry.payload.id)]};
            case "scheduledTasks.getWebhookDelivery": return {value: deliveryDetails[String(entry.payload.deliveryId)]};
            default: return undefined;
          }
        },
        http: (entry) => {
          if (entry.method !== "POST") return undefined;
          if (entry.path === "/api/hooks/accepted") return json(202, {deliveryId: "delivery-2"});
          if (entry.path === "/api/hooks/refused") return json(404, {error: "not_found"});
          if (entry.path === "/api/hooks/failing") return json(500, {error: "failed"});
          if (entry.path === "/api/hooks/lost") return {raw: (_request, response) => {response.destroy();}};
          return undefined;
        },
      }]);
      const native = yield* nativeOf(peer);
      const helper = native.helper!;
      const malformed = (error: unknown) => {
        assert.ok(error instanceof T3RequestError);
        assert.deepEqual(classification(error),
          {outcome: "uncertain", definiteRejection: false, providerDisabled: false, dispatchCommandFailure: false, malformedReply: true});
      };

      // conforming and nonconforming objects keep their order and all native fields
      assert.equal(JSON.stringify(yield* helper.tasks()),
        JSON.stringify([{_tag: "Task", task: helperTask}, {_tag: "Nonconforming", task: oddTask}]));
      // the first snapshot ends the subscription without an Ack
      assert.equal(yield* unacknowledged(lastStream(peer, (entry) => entry.tag === "scheduledTasks.subscribe")), true);
      // malformed elements cannot expose partial evidence from an otherwise populated list
      for (let index = 0; index < nonObjects.length; index++) malformed(yield* Effect.flip(helper.tasks()));
      malformed(yield* Effect.flip(helper.tasks()));
      malformed(yield* Effect.flip(helper.tasks()));

      const upsert = {taskId: "task-1", commandId: "supervisor-helper-channel:1", title: "Supervisor helper check-ins", prompt: "{{body.text}}",
        projectId: "project-1", threadId: "helper-1", modelSelection: {instanceId: "codex", model: "gpt-5"}, runtimeMode: "full-access", interactionMode: "default"};
      assert.equal(JSON.stringify(yield* helper.upsertTask({...upsert, requireExisting: false})), JSON.stringify({_tag: "Task", task: helperTask}));
      yield* helper.upsertTask({...upsert, requireExisting: true});
      const nativeTask = {commandId: "supervisor-helper-channel:1", title: "Supervisor helper check-ins", prompt: "{{body.text}}", enabled: true,
        schedule: {type: "webhook"}, projectId: "project-1", threadId: "helper-1", workspaceStrategy: {type: "root"}, modelSelection: {instanceId: "codex", model: "gpt-5"},
        runtimeMode: "full-access", interactionMode: "default", createdBy: "system", creationSource: "server"};
      assert.deepEqual(rpcRequests(peer, "scheduledTasks.upsert").map((entry) => entry.payload),
        [{id: "task-1", ...nativeTask}, {id: "task-1", requireExisting: true, ...nativeTask}]);
      // a present task reply that breaks the types is returned as received; a reply without a task object is malformed
      assert.equal(JSON.stringify(yield* helper.upsertTask({...upsert, taskId: "task-odd", requireExisting: true})),
        JSON.stringify({_tag: "Nonconforming", task: {...helperTask, id: "task-odd", enabled: "yes"}}));
      malformed(yield* Effect.flip(helper.upsertTask({...upsert, taskId: "task-missing", requireExisting: true})));
      yield* helper.deleteTask({taskId: "task-1"});
      assert.deepEqual(rpcRequests(peer, "scheduledTasks.delete")[0]!.payload, {id: "task-1"});

      // the delivery log keeps every element in order, as the task list does
      assert.equal(JSON.stringify(yield* helper.webhookDeliveries({taskId: "task-1"})),
        JSON.stringify([{_tag: "Delivery", delivery: summary}, {_tag: "Nonconforming", delivery: oddSummary}]));
      for (let index = 0; index < nonObjects.length; index++)
        malformed(yield* Effect.flip(helper.webhookDeliveries({taskId: `task-invalid-${index}`})));
      malformed(yield* Effect.flip(helper.webhookDeliveries({taskId: "task-malformed"})));
      malformed(yield* Effect.flip(helper.webhookDeliveries({taskId: "task-none"})));
      assert.equal(JSON.stringify(yield* helper.webhookDelivery({taskId: "task-1", deliveryId: "delivery-1"})), JSON.stringify({_tag: "Delivery", delivery: detail}));
      assert.equal(JSON.stringify(yield* helper.webhookDelivery({taskId: "task-1", deliveryId: "delivery-odd"})),
        JSON.stringify({_tag: "Nonconforming", delivery: oddDetail}));
      malformed(yield* Effect.flip(helper.webhookDelivery({taskId: "task-1", deliveryId: "delivery-missing"})));
      assert.deepEqual({list: rpcRequests(peer, "scheduledTasks.listWebhookDeliveries")[0]!.payload, detail: rpcRequests(peer, "scheduledTasks.getWebhookDelivery")[0]!.payload},
        {list: {id: "task-1"}, detail: {id: "task-1", deliveryId: "delivery-1"}});
      const operate = new Set(peer.log.filter((entry) => entry.kind === "rpc").map((entry) => entry.authorization));
      assert.deepEqual([...operate], ["Bearer operate-token"]);

      const post = (path: string) => Effect.flatMap(helper.postWebhook.prepare({path, batchId: "message-1", text: "Check in."}),
        (prepared) => Effect.flatMap(prepared.initiate(), settle));
      assert.deepEqual(yield* post("/api/hooks/accepted"), {_tag: "Accepted", deliveryId: "delivery-2"});
      assert.deepEqual(yield* post("/api/hooks/refused"), {_tag: "Refused", httpStatus: 404});
      assert.deepEqual(yield* post("/api/hooks/failing"), {_tag: "Unconfirmed", httpStatus: 500});
      assert.ok((yield* Effect.flip(post("/api/hooks/lost"))) instanceof T3WebhookError);
      const posts = peer.log.filter((entry) => entry.kind === "http");
      assert.deepEqual(posts.map((entry) => entry.kind === "http" ? [entry.path, entry.body, entry.contentType, entry.authorization] : []),
        ["/api/hooks/accepted", "/api/hooks/refused", "/api/hooks/failing", "/api/hooks/lost"].map((path) =>
          [path, webhookBody({batchId: "message-1", text: "Check in."}), "application/json", null]));
    }), {timeout: 10_000});

  it.live("T3N-B10: the terminal requests run on the probe credential; an attach hands events in order and acknowledges only when asked", () =>
    Effect.gen(function* () {
      const snapshot = {threadId: "probe-thread", terminalId: "terminal-1", cwd: "/checkout", status: "running", extra: "kept"};
      const peer = yield* intPeer([{rpc: (entry): RpcAnswer | undefined => {
        switch (entry.tag) {
          case "terminal.open": return {value: snapshot};
          case "terminal.write":
          case "terminal.close": return {value: null};
          case "terminal.attach": return entry.payload.terminalId === "terminal-1"
            ? {stream: [{type: "snapshot", snapshot}, "not a record", {type: "output", threadId: "probe-thread", terminalId: "terminal-1", data: "ready"}]}
            : {stream: [{type: "output", threadId: "probe-thread", terminalId: "terminal-2", data: "ready"}]};
          default: return undefined;
        }
      }}]);
      const native = yield* nativeOf(peer);
      const terminal = native.terminal!;
      const session = {threadId: "probe-thread", terminalId: "terminal-1"};
      assert.equal(JSON.stringify(yield* terminal.open({...session, cwd: "/checkout", cols: 1000, rows: 40, env: {TERM: "dumb"}})), JSON.stringify(snapshot));
      yield* terminal.write({...session, data: "printf ready\n"});
      yield* terminal.close({...session, deleteHistory: true});
      assert.deepEqual([rpcRequests(peer, "terminal.open")[0]!.payload, rpcRequests(peer, "terminal.write")[0]!.payload, rpcRequests(peer, "terminal.close")[0]!.payload],
        [{...session, cwd: "/checkout", worktreePath: null, cols: 1000, rows: 40, env: {TERM: "dumb"}}, {...session, data: "printf ready\n"},
          {...session, deleteHistory: true}]);

      // the events of a chunk arrive in their positions, a value that is not a record as Malformed; Stop ends the attach without an Ack
      const tags: Array<TerminalAttachEvent["_tag"]> = [];
      yield* terminal.attach({...session, cwd: "/checkout"}, {
        onChunk: (events) => Effect.sync(() => {
          tags.push(...events.map((event) => event._tag));
          return {_tag: "Stop"} as const;
        }),
        onExit: () => Effect.void,
      });
      assert.deepEqual(tags, ["Event", "Malformed", "Event"]);
      assert.equal(yield* unacknowledged(lastStream(peer, (entry) => entry.tag === "terminal.attach" && entry.payload.terminalId === "terminal-1")), true);
      assert.deepEqual(rpcRequests(peer, "terminal.attach")[0]!.payload, {...session, cwd: "/checkout", worktreePath: null, restartIfNotRunning: false});

      // the Acknowledge step writes the Ack and then runs afterAck; a completed cancel ends the attach
      const cancel = yield* Deferred.make<void>();
      const acknowledgedAfter = yield* Deferred.make<void>();
      const attaching = yield* Effect.forkChild(Effect.flip(terminal.attach({threadId: "probe-thread", terminalId: "terminal-2", cwd: "/checkout"}, {
        onChunk: () => Effect.succeed({_tag: "Acknowledge", afterAck: Deferred.done(acknowledgedAfter, Exit.void).pipe(Effect.asVoid)} as const),
        onExit: () => Effect.void,
      }, cancel)));
      yield* (yield* peer.stream((entry) => entry.tag === "terminal.attach" && entry.payload.terminalId === "terminal-2")).acknowledged;
      yield* Deferred.await(acknowledgedAfter);
      yield* Deferred.succeed(cancel, undefined);
      const ended = yield* Fiber.join(attaching);
      assert.ok(ended instanceof T3TerminalError);
      assert.equal(ended.reason, "unavailable");
      assert.deepEqual([...new Set(rpcRequests(peer, "terminal.attach").concat(rpcRequests(peer, "terminal.open")).map((entry) => entry.authorization))],
        ["Bearer probe-token"]);
    }), {timeout: 10_000});

  it.live("T3N-B11: a credential without its token leaves its family unconstructed", () => Effect.gen(function* () {
    const peer = yield* intPeer();
    const native = yield* nativeOf(peer, {operate: false, optional: false});
    assert.deepEqual({commands: native.orchestration.commands, helper: native.helper, write: native.files.write, commit: native.files.commit,
      terminal: native.terminal}, {commands: null, helper: null, write: null, commit: null, terminal: null});
    assert.deepEqual({requests: peer.log.length, sockets: peer.connections.length}, {requests: 0, sockets: 0});
  }), {timeout: 10_000});
});
