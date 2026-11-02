import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { collectNativeReads, nativeActivityRead } from "../src/supervisor-awareness.js";
import type { ConversationRequest } from "../src/supervisor-conversation-store.js";
import type { NativeRpcShape } from "../src/supervisor-native.js";
import { T3RequestError } from "../src/t3-native/index.js";
import type { Projection } from "../src/types.js";
import { defaultWorkflowServerAliases, defaultWorkflowToolRoutes, workflowToolRoutes } from "../src/workflow-write-evidence.js";
import { fakeNative } from "./support/native-access.js";

const nodes = [{id: "root", kind: "root_turn", threadId: "owner", runId: "run", rootNodeId: "root", providerThreadId: "provider", status: "running"},
  {id: "read-node", kind: "dynamic_tool", threadId: "owner", runId: "run", rootNodeId: "root", providerThreadId: "provider", parentNodeId: "root", status: "completed"}];
const projection: Projection = {
  thread: {id: "owner", title: "Owner", projectId: "p", lineage: {parentThreadId: null, relationshipToParent: null}},
  runs: [{id: "run", threadId: "owner", ordinal: 1, status: "running", requestedAt: "2026-10-27T12:00:00Z", startedAt: null, completedAt: null,
    rootNodeId: "root", providerThreadId: "provider"}],
  nodes,
  messages: [],
};
const detail = (truncated = false) => ({id: "read", type: "dynamic_tool", status: "completed", threadId: "owner", runId: "run", nodeId: "read-node",
  toolNonExecutionKind: null, toolName: "mcp__t3_code__t3_thread_read", input: {threadId: "child", view: "activity", afterPosition: 4},
  output: {structuredContent: {thread: {threadId: "child"}, items: [{position: 5, itemId: "actual-child-item", textTruncated: truncated}], hasMore: false}}});
const allowed = new Set(["child"]);

it("a completed native read records the fetched page without inventing an assessment", () => {
  const read = nativeActivityRead(projection, detail(), allowed, 100, defaultWorkflowToolRoutes);
  assert.equal(read?.itemId, "actual-child-item");
  assert.equal(read?.position, 5);
  assert.equal(read?.snapshotEndReached, true);
  assert.equal(read?.partial, false);
  assert.equal("assessedAt" in read!, false);
});

it("published tool_call nodes and omitted non-execution hints retain successful native read coverage", () => {
  const {toolNonExecutionKind, ...executed} = detail();
  assert.equal(toolNonExecutionKind, null);
  for (const kind of ["dynamic_tool", "tool_call"]) {
    const actualProjection = {...projection, nodes: nodes.map(node => node.id === "read-node" ? {...node, kind} : node)};
    for (const hint of [{}, {toolNonExecutionKind: null}]) {
      const actual = {...executed, ...hint, toolName: "t3-code.t3_thread_read", output: executed.output.structuredContent};
      const read = nativeActivityRead(actualProjection, actual, allowed, 100, defaultWorkflowToolRoutes);
      assert.equal(read?.position, 5, `${kind} with ${JSON.stringify(hint)}`);
      assert.equal(read?.snapshotEndReached, true);
      for (const refusal of ["denied", "cancelled"])
        assert.equal(nativeActivityRead(actualProjection, {...actual, toolNonExecutionKind: refusal}, allowed, 100, defaultWorkflowToolRoutes), null);
      for (const invalidNode of [{kind: "assistant_message"}, {threadId: "foreign-owner"}, {runId: "foreign-run"}, {parentNodeId: "foreign-root"}, {status: "running"}]) {
        const invalid = {...actualProjection, nodes: actualProjection.nodes.map(node => node.id === "read-node" ? {...node, ...invalidNode} : node)};
        assert.equal(nativeActivityRead(invalid, actual, allowed, 100, defaultWorkflowToolRoutes), null, JSON.stringify(invalidNode));
      }
    }
  }
});

it("cut-off text and item-only reads cannot claim the end of an activity snapshot", () => {
  const partial = nativeActivityRead(projection, detail(true), allowed, 100, defaultWorkflowToolRoutes);
  assert.equal(partial?.partial, true);
  assert.equal(partial?.snapshotEndReached, false);
  const item = detail();
  Object.assign(item.input, {itemId: "actual-child-item"});
  assert.equal(nativeActivityRead(projection, item, allowed, 100, defaultWorkflowToolRoutes)?.snapshotEndReached, false);
});

it("a child listing, foreign namespace, failed read or out-of-scope target provides no transcript coverage", () => {
  for (const value of [{...detail(), toolName: "t3_thread_list"}, {...detail(), toolName: "omegent__t3_thread_read"},
    {...detail(), output: {isError: true}}, {...detail(), threadId: "someone-else"}, {...detail(), status: "running"},
    {...detail(), toolNonExecutionKind: "denied"}]) assert.equal(nativeActivityRead(projection, value, allowed, 100, defaultWorkflowToolRoutes), null);
  assert.equal(nativeActivityRead(projection, detail(), new Set(["other-child"]), 100, defaultWorkflowToolRoutes), null);
});

it("a read through a recognised MCP call tool counts on every recognised route, and an unrecognised wrapper or equal arguments alone never do", () => {
  const routed = (toolName: string, input: unknown) => nativeActivityRead(projection, {...detail(), toolName, input}, allowed, 100, defaultWorkflowToolRoutes);
  const call = {name: "t3-code__t3_thread_read", arguments: detail().input};
  for (const toolName of ["mcpx.mcpx_call_tool", "mcp__mcpx__mcpx_call_tool"])
    assert.equal(routed(toolName, call)?.itemId, "actual-child-item", toolName);
  assert.equal(routed("mcpx.mcpx_call_tool", JSON.stringify(call))?.itemId, "actual-child-item", "an input recorded as JSON text");
  for (const [toolName, input] of [["gateway.call_tool", call], ["mcpx.mcpx_call_tool", {...call, name: "t3-code__t3_thread_send"}],
    ["mcpx.mcpx_call_tool", {...call, extra: true}], ["other_server.read", detail().input]] as const)
    assert.equal(routed(toolName, input), null, `${toolName}: not a recognised read route`);
});

// audit F7: a deployment's configured gateway call tools are the routes of its own T3 thread reads too, matched exactly
it("a read through a configured gateway call tool counts; the unconfigured default, another gateway or server, a foreign thread or another shape never do", () => {
  const routes = workflowToolRoutes(defaultWorkflowServerAliases, ["mcp__other_gateway__call_tool", "gateway.invoke"]);
  const routed = (toolName: string, input: unknown, value: object = detail(), using = routes) =>
    nativeActivityRead(projection, {...value, toolName, input}, allowed, 100, using);
  const call = {name: "t3-code__t3_thread_read", arguments: detail().input};
  for (const toolName of ["mcp__other_gateway__call_tool", "gateway.invoke"]) {
    assert.equal(routed(toolName, call)?.itemId, "actual-child-item", toolName);
    assert.equal(routed(toolName, call, detail(), defaultWorkflowToolRoutes), null, `${toolName} with the documented registrations`);
  }
  assert.equal(routed("gateway.invoke", JSON.stringify(call))?.itemId, "actual-child-item", "an input recorded as JSON text");
  assert.equal(nativeActivityRead(projection, detail(), allowed, 100, routes)?.itemId, "actual-child-item", "T3's own direct read");
  for (const [label, toolName, input] of [
    ["the documented MCPX call tool, not configured", "mcpx.mcpx_call_tool", call],
    ["the documented MCPX call tool in its other form, not configured", "mcp__mcpx__mcpx_call_tool", call],
    ["the configured operation on another server", "mcp__another_gateway__call_tool", call],
    ["the configured server's other form, not configured", "other_gateway.call_tool", call],
    ["a configured name with a suffix", "gateway.invoke_tool", call],
    ["a bare operation", "call_tool", call],
    ["a configured gateway naming another server's read", "gateway.invoke", {...call, name: "other__t3_thread_read"}],
    ["a configured gateway naming another T3 tool", "gateway.invoke", {...call, name: "t3-code__t3_thread_send"}],
    ["a configured gateway with an extra key", "gateway.invoke", {...call, extra: true}],
    ["a configured gateway with another envelope", "gateway.invoke", {tool: call.name, arguments: call.arguments}],
    ["a configured gateway with text arguments", "gateway.invoke", {name: call.name, arguments: JSON.stringify(call.arguments)}],
  ] as const) assert.equal(routed(toolName, input), null, label);
  // the actor, scope and fetched page are proven on a configured route as on every other
  assert.equal(routed("gateway.invoke", {...call, arguments: {...call.arguments, threadId: "other-child"}}), null, "a target outside the batch");
  assert.equal(routed("gateway.invoke", call, {...detail(), threadId: "someone-else"}), null, "another actor's item");
  assert.equal(routed("gateway.invoke", call, {...detail(), output: {isError: true}}), null, "a failed read");
  assert.equal(routed("gateway.invoke", call, {...detail(), output: {structuredContent: {thread: {threadId: "other-child"}, items: [], hasMore: false}}}),
    null, "another thread's page");
});

/**
 * The turn item reads of a check-in through the production T3Native: the verifier receives the reply's item itself, every native key
 * kept, so a valid and a nonconforming item decide exactly as their detail does; a reply that carries no item is a failed read.
 */
it.effect("a native read hands each reply's item whole to the verifier, and a reply without an item records no read", () => Effect.gen(function* () {
  const valid = {...detail(), id: "valid", providerTurnId: "turn-1", nativeItemRef: {driver: "codex", nativeId: "valid", strength: "strong"}};
  // a numeric provider turn breaks the pinned identity types; the verifier reads no such field and still decides on the rest
  const nonconforming = {...detail(), id: "nonconforming", providerTurnId: 42, ordinal: 7};
  // the item itself as the reply, without the reply's item key
  const unwrapped = {...detail(), id: "unwrapped"};
  const replies = new Map<string, unknown>([["valid", {item: valid}], ["nonconforming", {item: nonconforming}], ["unwrapped", unwrapped],
    ["absent", {item: null}]]);
  const requested: string[] = [];
  const read: NativeRpcShape = {
    call: (tag, payload) => {
      assert.equal(tag, "orchestration.getTurnItem");
      requested.push(String(payload.itemId));
      return Effect.succeed(replies.get(String(payload.itemId)));
    },
    initiate: () => Effect.die(new Error("a turn item read never initiates")),
  };
  const native = yield* fakeNative({read});
  const owner: Projection = {...projection, turnItems: [...replies.keys()].map((id) => ({...detail(), id}))};
  // only the fields the reads use: the request's batch, its run and its recorded read calls
  const request = {runId: "run", messageId: "request-message", batch: {threads: [{threadId: "child"}]}} as unknown as ConversationRequest;
  const reads = yield* collectNativeReads(request, owner, (itemId) => native.orchestration.turnItem({threadId: "owner", itemId}), 100,
    defaultWorkflowToolRoutes);
  assert.deepEqual(requested, ["valid", "nonconforming", "unwrapped", "absent"]);
  assert.deepEqual(reads, [nativeActivityRead(owner, valid, allowed, 100, defaultWorkflowToolRoutes),
    nativeActivityRead(owner, nonconforming, allowed, 100, defaultWorkflowToolRoutes)]);
  assert.deepEqual(reads.map((item) => item.callItemId), ["valid", "nonconforming"]);
  // the item each view hands on is the reply's own object, with every key it carried
  const validView = yield* native.orchestration.turnItem({threadId: "owner", itemId: "valid"});
  assert.ok(validView._tag === "Item" && validView.item === valid);
  const nonconformingView = yield* native.orchestration.turnItem({threadId: "owner", itemId: "nonconforming"});
  assert.ok(nonconformingView._tag === "Nonconforming" && nonconformingView.item === nonconforming);
  assert.deepEqual(yield* native.orchestration.turnItem({threadId: "owner", itemId: "absent"}), {_tag: "Absent"});
  const failed = yield* Effect.flip(native.orchestration.turnItem({threadId: "owner", itemId: "unwrapped"}));
  assert.ok(failed instanceof T3RequestError && failed.malformedReply && failed.outcome === "uncertain");
}));
