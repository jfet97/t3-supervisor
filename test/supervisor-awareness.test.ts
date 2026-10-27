import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { nativeActivityRead } from "../src/supervisor-awareness.js";
import type { Projection } from "../src/types.js";

const projection: Projection = {
  thread: {id: "owner", title: "Owner", projectId: "p", lineage: {parentThreadId: null, relationshipToParent: null}},
  runs: [{id: "run", threadId: "owner", ordinal: 1, status: "running", requestedAt: "2026-10-27T12:00:00Z", startedAt: null, completedAt: null,
    rootNodeId: "root", providerThreadId: "provider"}],
  nodes: [{id: "root", kind: "root_turn", threadId: "owner", runId: "run", rootNodeId: "root", providerThreadId: "provider", status: "running"},
    {id: "read-node", kind: "dynamic_tool", threadId: "owner", runId: "run", rootNodeId: "root", providerThreadId: "provider", parentNodeId: "root", status: "completed"}],
  messages: [],
};
const detail = (truncated = false) => ({id: "read", type: "dynamic_tool", status: "completed", threadId: "owner", runId: "run", nodeId: "read-node",
  toolNonExecutionKind: null, toolName: "mcp__t3_code__t3_thread_read", input: {threadId: "child", view: "activity", afterPosition: 4},
  output: {structuredContent: {thread: {threadId: "child"}, items: [{position: 5, itemId: "actual-child-item", textTruncated: truncated}], hasMore: false}}});
const allowed = new Set(["child"]);

it("a completed native read records the fetched page without inventing an assessment", () => {
  const read = nativeActivityRead(projection, detail(), allowed, 100);
  assert.equal(read?.itemId, "actual-child-item");
  assert.equal(read?.position, 5);
  assert.equal(read?.snapshotEndReached, true);
  assert.equal(read?.partial, false);
  assert.equal("assessedAt" in read!, false);
});

it("cut-off text and item-only reads cannot claim the end of an activity snapshot", () => {
  const partial = nativeActivityRead(projection, detail(true), allowed, 100);
  assert.equal(partial?.partial, true);
  assert.equal(partial?.snapshotEndReached, false);
  const item = detail();
  Object.assign(item.input, {itemId: "actual-child-item"});
  assert.equal(nativeActivityRead(projection, item, allowed, 100)?.snapshotEndReached, false);
});

it("a child listing, foreign namespace, failed read or out-of-scope target provides no transcript coverage", () => {
  for (const value of [{...detail(), toolName: "t3_thread_list"}, {...detail(), toolName: "omegent__t3_thread_read"},
    {...detail(), output: {isError: true}}, {...detail(), threadId: "someone-else"}, {...detail(), status: "running"},
    {...detail(), toolNonExecutionKind: "denied"}]) assert.equal(nativeActivityRead(projection, value, allowed, 100), null);
  assert.equal(nativeActivityRead(projection, detail(), new Set(["other-child"]), 100), null);
});
