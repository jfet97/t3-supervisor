import assert from "node:assert/strict";
import {it} from "vitest";
import {nativeNodeTurn, readNativeProviderTurns} from "../src/workflow-native-turns.js";

// provider turns as T3 publishes them in a thread projection: one per native turn, a native child's included
const turn = (id: string, extra: Record<string, unknown> = {}) => ({id, providerThreadId: "provider-thread", nodeId: `${id}-root`, runAttemptId: null,
  nativeTurnRef: {driver: "codex", nativeId: `native-${id}`, strength: "strong"}, ordinal: 1, status: "completed",
  startedAt: "2026-10-27T10:00:00.000Z", completedAt: "2026-10-27T10:01:00.000Z", ...extra});

it("published provider turns decode only with strong native provenance, and a malformed list identifies nothing", () => {
  assert.deepEqual(readNativeProviderTurns({}), [], "a projection without provider turns publishes none");
  assert.deepEqual(readNativeProviderTurns({providerTurns: []}), []);
  assert.deepEqual(readNativeProviderTurns({providerTurns: [turn("turn-1"), turn("turn-2", {status: "running", startedAt: null})]}), [
    {id: "turn-1", providerThreadId: "provider-thread", nodeId: "turn-1-root", status: "completed", startedAt: Date.parse("2026-10-27T10:00:00.000Z")},
    {id: "turn-2", providerThreadId: "provider-thread", nodeId: "turn-2-root", status: "running", startedAt: null},
  ]);
  assert.deepEqual(readNativeProviderTurns({providerTurns: [turn("weak", {nativeTurnRef: {driver: "codex", nativeId: "native-weak", strength: "weak"}}),
    turn("none", {nativeTurnRef: null}), turn("blank", {nativeTurnRef: {driver: "codex", nativeId: null, strength: "strong"}})]}), [],
  "a turn without strong native provenance identifies nothing");
  for (const value of [null, {}, [null], [turn("a", {status: "paused"})], [turn("a", {startedAt: "yesterday"})], [turn("a"), turn("a")],
    [turn("a", {id: ""})], [turn("a", {nodeId: null})], [turn("a", {nativeTurnRef: {driver: "codex", nativeId: "x", strength: "certain"}})]])
    assert.equal(readNativeProviderTurns({providerTurns: value}), null, JSON.stringify(value));
});

it("a published execution node names the provider turn behind a cited message", () => {
  const projection = {nodes: [{id: "node-1", threadId: "thread-a", providerThreadId: "provider-thread", providerTurnId: "turn-1"},
    {id: "node-2", threadId: "thread-a", providerThreadId: null, providerTurnId: null}, {id: "node-3", threadId: "thread-a"}]};
  assert.deepEqual(nativeNodeTurn(projection, "node-1", "thread-a"), {providerTurnId: "turn-1", providerThreadId: "provider-thread"});
  assert.equal(nativeNodeTurn(projection, "node-2", "thread-a"), null, "a node outside any provider turn names none");
  assert.equal(nativeNodeTurn(projection, "node-3", "thread-a"), null);
  assert.equal(nativeNodeTurn(projection, "node-1", "thread-b"), undefined, "another thread's node is not this one");
  assert.equal(nativeNodeTurn({nodes: "broken"}, "node-1", "thread-a"), undefined);
  assert.equal(nativeNodeTurn({}, "node-1", "thread-a"), undefined);
});
