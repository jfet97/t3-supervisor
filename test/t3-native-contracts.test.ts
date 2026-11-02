import assert from "node:assert/strict";
import { describe, it } from "@effect/vitest";
import { Effect, Exit, Schema } from "effect";
import { helperDeliveryBody } from "../src/supervisor-helper-transport.js";
import { selectTranslation } from "../src/t3-native/build.js";
import {
  buildFacts, CatalogThread, CommandReceipt, HelperTask, HelperTaskUpsert, LaunchReceipt, referenceBuilds, ShellStreamItem, T3Unsupported,
  ThreadStreamItem, TurnItem, WebhookDelivery, webhookBody, type ReferenceBuild, type T3Environment,
} from "../src/t3-native/index.js";

/*
 * The T3Native contracts as pure rules: the build facts and translation selection, and the guards that check declared native fields
 * while keeping each value whole (every key in its order); the native behavior of each operation is in t3-native-boundary.test.ts.
 */

const environment = (serverVersion: string): T3Environment => ({environmentId: "environment-1", orchestrationProtocolVersion: 2, serverVersion});
const pinned = referenceBuilds[0]!;
// the same value back, every key in its order
const kept = (schema: Schema.ConstraintDecoder<unknown>, value: unknown) => {
  const decoded = Schema.decodeUnknownSync(schema)(value);
  assert.equal(decoded, value);
  assert.equal(JSON.stringify(decoded), JSON.stringify(value));
};

describe("T3Native contracts", () => {
  it.effect("T3N-01: the build facts name the captured reference build, and only a reference profile's recorded absence refuses an operation", () =>
    Effect.gen(function* () {
      assert.deepEqual(buildFacts(environment(pinned.serverVersion)),
        {environmentId: "environment-1", serverVersion: pinned.serverVersion, orchestrationProtocolVersion: 2, referenceBuild: true});
      assert.equal(buildFacts(environment("0.1.8-nightly.20261201.1")).referenceBuild, false);
      // before any descriptor, on the reference build and on any other build, every operation keeps the one implementation
      for (const facts of [null, buildFacts(environment(pinned.serverVersion)), buildFacts(environment("9.9.9"))])
        assert.equal(Exit.isSuccess(yield* Effect.exit(selectTranslation("orchestration/dispatchCommand", facts))), true);
      // a profile that records an operation absent refuses exactly that operation on exactly that build
      const profile: ReadonlyArray<ReferenceBuild> = [{serverVersion: "0.0.1-reference", source: "test", absent: ["helper/postWebhook"]}];
      const refused = yield* Effect.flip(selectTranslation("helper/postWebhook", buildFacts(environment("0.0.1-reference"), profile), profile));
      assert.ok(refused instanceof T3Unsupported);
      assert.deepEqual({operation: refused.operation, serverVersion: refused.serverVersion}, {operation: "helper/postWebhook", serverVersion: "0.0.1-reference"});
      assert.equal(Exit.isSuccess(yield* Effect.exit(selectTranslation("orchestration/dispatchCommand", buildFacts(environment("0.0.1-reference"), profile), profile))), true);
      assert.equal(Exit.isSuccess(yield* Effect.exit(selectTranslation("helper/postWebhook", buildFacts(environment("9.9.9"), profile), profile))), true);
    }));

  it("T3N-02: a conforming turn item keeps every native key and its native tool input; only its typed identity fields decide conformance", () => {
    const item = {id: "item-1", type: "dynamic_tool", threadId: "thread-1", runId: null, nodeId: "node-1", parentItemId: null, providerThreadId: "provider-thread",
      providerTurnId: "provider-turn", toolName: "mcpx.mcpx_call_tool", input: {name: "t3-supervisor-workflows__workflow_read", arguments: {threadId: "t"}, extra: 1},
      ordinal: 4, status: "completed", nativeItemRef: {driver: "codex", nativeId: "exec-1", strength: "strong"}, future: {kept: [1, 2]}};
    kept(TurnItem, item);
    kept(TurnItem, {...item, input: JSON.stringify({threadId: "t"})});
    const isItem = Schema.is(TurnItem);
    // these do not conform; the turn item read still hands a present one to the verifiers whole (t3-native-boundary.test.ts)
    for (const nonconforming of [{...item, id: ""}, {...item, threadId: 7}, {...item, nodeId: 7}, {...item, toolName: false}, {...item, outputOmitted: "yes"}, [item], null])
      assert.equal(isItem(nonconforming), false, JSON.stringify(nonconforming));
  });

  it("T3N-03: stream items keep the shell's closed kinds and the thread's unknown events; an archived thread is checked as the store reads it", () => {
    const isShell = Schema.is(ShellStreamItem);
    assert.equal(isShell({kind: "thread.updated", sequence: 3, thread: {id: "thread-1", title: "kept"}, location: "archive"}), true);
    assert.equal(isShell({kind: "mystery", sequence: 3}), false);
    assert.equal(isShell({kind: "snapshot", snapshot: {schemaVersion: 1, snapshotSequence: 1, projects: [], threads: [], archivedThreads: []}}), false);
    kept(ThreadStreamItem, {kind: "unknown-event", sequence: 2, eventType: "future.event", detail: {kept: true}});
    assert.equal(Schema.is(ThreadStreamItem)({kind: "event", sequence: 2, event: {type: " ", payload: null}}), false);
    // a relationship an unknown build adds is not refused, an empty id or a missing lineage is
    kept(CatalogThread, {id: "archived-1", title: "Archived", lineage: {relationshipToParent: "future-relation"}, archivedAt: "2026-11-01T00:00:00.000Z"});
    for (const refused of [{id: "", title: "x", lineage: {}}, {id: "a", title: "x"}, {id: "a", title: "x", lineage: []}])
      assert.equal(Schema.is(CatalogThread)(refused), false, JSON.stringify(refused));
  });

  it("T3N-04: receipts are the pinned build's results: a dispatch sequence, and a launch's thread, projection and resumed", () => {
    kept(CommandReceipt, {sequence: 4, extra: true});
    for (const refused of [{sequence: -1}, {sequence: 1.5}, {accepted: true}, null]) assert.equal(Schema.is(CommandReceipt)(refused), false, JSON.stringify(refused));
    kept(LaunchReceipt, {threadId: "thread-1", projection: {thread: {id: "thread-1"}, runs: []}, resumed: false});
    kept(LaunchReceipt, {threadId: "thread-1", projection: {thread: {id: "thread-1"}}, resumed: true, sequence: 9});
    for (const refused of [{sequence: 1}, {threadId: "thread-1"}, {accepted: true}, {threadId: "thread-1", projection: [], resumed: false}])
      assert.equal(Schema.is(LaunchReceipt)(refused), false, JSON.stringify(refused));
  });

  it("T3N-05: helper tasks and deliveries are typed on the fields the transport reads and kept whole; the upsert sends the thread's own model and modes", () => {
    // a task or delivery that does not conform is still returned by the helper reads, as Nonconforming (t3-native-boundary.test.ts)
    const scheduled = {title: "Supervisor helper check-ins", prompt: "{{body.text}}", enabled: true, projectId: "project-1", workspaceStrategy: {type: "root"},
      modelSelection: {instanceId: "codex", model: "gpt-5", options: [{id: "effort", value: "high"}]}, runtimeMode: "full-access", interactionMode: "default",
      createdAt: "2026-11-02T00:00:00.000Z", runCount: 0};
    const task = {id: "task-1", ...scheduled, schedule: {type: "webhook", signature: null}, threadId: "helper-1", createdBy: "system", creationSource: "server",
      webhook: {path: "/api/hooks/abc", url: null, hasSecret: false}};
    kept(HelperTask, task);
    // another task of the scheduler: a user's interval task, with no thread and no webhook
    kept(HelperTask, {id: "task-2", ...scheduled, schedule: {type: "interval", everyMs: 60_000}, threadId: null, createdBy: "user", creationSource: "web"});
    for (const nonconforming of [{...task, id: ""}, {...task, enabled: "yes"}, {...task, webhook: {path: 5}}, {...task, modelSelection: {model: "gpt-5"}}])
      assert.equal(Schema.is(HelperTask)(nonconforming), false, JSON.stringify(nonconforming));
    const summary = {id: "delivery-1", taskId: "task-1", receivedAt: "2026-11-02T00:00:01.000Z", method: "POST", contentType: "application/json", bodyBytes: 40,
      outcome: "a-future-outcome", signatureVerified: false, missingFields: [], error: null};
    kept(WebhookDelivery, summary);
    kept(WebhookDelivery, {...summary, query: "", headers: {}, body: "{}", bodyTruncated: false, renderedPrompt: null});
    assert.equal(Schema.is(WebhookDelivery)({...summary, bodyBytes: -1}), false);
    const upsert = {taskId: "task-1", requireExisting: false, commandId: "command-1", title: "t", prompt: "{{body.text}}", projectId: "project-1", threadId: "helper-1",
      modelSelection: task.modelSelection, runtimeMode: "full-access", interactionMode: "plan"};
    const isUpsert = Schema.is(HelperTaskUpsert);
    // a mode the helper thread carries is sent as read, also one the pinned build does not name
    for (const accepted of [upsert, {...upsert, runtimeMode: "a-future-mode"}]) assert.equal(isUpsert(accepted), true);
    for (const refused of [{...upsert, runtimeMode: ""}, {...upsert, interactionMode: undefined}, {...upsert, modelSelection: "gpt-5"}, {...upsert, modelSelection: {instanceId: "codex"}}])
      assert.equal(isUpsert(refused), false, JSON.stringify(refused));
  });

  it("T3N-06: the webhook body is exactly the bytes the helper receipts are compared against", () => {
    for (const [batchId, text] of [["message-1", "plain"], ["message-2", "quotes \" and ⁠ and émoji 🙂"]] as const) {
      assert.equal(webhookBody({batchId, text}), helperDeliveryBody(batchId, text));
      assert.equal(webhookBody({batchId, text}), JSON.stringify({batchId, text}));
    }
  });
});
