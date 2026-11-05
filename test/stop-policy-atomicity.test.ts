import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import { workflowToolNames } from "../src/workflow-write-evidence.js";
import { execute, mcpCall } from "./support/glinint-wiring.js";
import { startInterpretationFixture } from "./support/interpretation-fixture.js";

/* CT-STOPTX-01: a dashboard Stop of a chat with a valid pending Start writes the policy exclusion and its bookkeeping (the
 * pending Start rejected as superseded, the recorded Stop) as one durable change. A persistent guidance trigger fails the
 * bookkeeping write that follows the policy write; on the reopened files neither change remains. Without the trigger the same
 * Stop commits both. it.live: the Start crosses the real MCP route and the loopback peer's sockets, and every check reads the
 * files again after a restart of the run.
 */

const startText = "Have Supervisor follow this task: add a CSV export.";

// the persistent fault: the pending Start's rejection, the first bookkeeping write after the policy write, is refused
const faultTriggers = (threadId: string) => ["INSERT", "UPDATE"].map((event) => `CREATE TRIGGER stop_bookkeeping_fault_${event.toLowerCase()} ` +
  `BEFORE ${event} ON meta WHEN NEW.key='supervisor_start:${threadId}' AND json_extract(NEW.value,'$.status')='rejected' ` +
  "BEGIN SELECT RAISE(ABORT,'injected bookkeeping failure'); END");

// a no project main's own genuine supervision_start call through the authenticated route, pending until its interpretation
const pendingStart = Effect.gen(function* () {
  const f = yield* startInterpretationFixture({noProject: true});
  f.addRequest("request-start", startText);
  const main = f.main();
  const run = main.runs.find(value => value.userMessageId === "request-start")!;
  const args = {callerThreadId: f.mainThreadId, userMessageId: "request-start", operationId: "own-start"};
  const nodeId = "start-node";
  (main.nodes as Array<Record<string, unknown>>).push({id: nodeId, kind: "dynamic_tool", threadId: f.mainThreadId, runId: run.id, rootNodeId: run.rootNodeId,
    parentNodeId: run.rootNodeId, providerThreadId: run.providerThreadId, status: "completed"});
  const item = {id: "start-item", type: "dynamic_tool", threadId: f.mainThreadId, runId: run.id, nodeId, providerThreadId: run.providerThreadId,
    parentItemId: null, ordinal: 1, status: "completed", toolName: workflowToolNames.start.direct[1], input: args};
  main.turnItems = [item];
  f.native.details.set(item.id, {...item, nativeItemRef: {driver: "codex", nativeId: "native-start-item", strength: "strong"}, toolNonExecutionKind: null});
  assert.equal(((yield* mcpCall(f.endpoint, "supervision_start", args)).value as {status: string}).status, "pending");
  return f;
});

it.live("CT-STOPTX-01: a Stop whose bookkeeping fails after the policy write keeps neither change; without the fault both commit", () => Effect.gen(function* () {
  const f = yield* pendingStart;
  const policy = yield* f.core.policy.get().pipe(Effect.orDie);
  const start = yield* f.core.store.start(f.mainThreadId).pipe(Effect.orDie);
  assert.equal(start?.status, "pending");
  assert.ok(!policy.excludedThreadIds.includes(f.mainThreadId));
  for (const statement of faultTriggers(f.mainThreadId)) yield* execute(f.core.sql, statement);

  const failed = yield* Effect.exit(f.core.control.setChatPolicy(f.mainThreadId, false, policy.generation));
  assert.ok(Exit.isFailure(failed), "the injected bookkeeping failure fails the Stop");
  yield* f.restart();
  // the atomicity assertion: the policy exclusion never outlives its bookkeeping, and the Start is still the pending one
  assert.deepEqual({policy: yield* f.core.policy.get().pipe(Effect.orDie), start: yield* f.core.store.start(f.mainThreadId).pipe(Effect.orDie)},
    {policy, start}, "neither the exclusion nor the Start's rejection is committed");
  assert.equal(yield* f.core.store.chatStop(f.mainThreadId).pipe(Effect.orDie), null, "no Stop is recorded");

  for (const event of ["insert", "update"]) yield* execute(f.core.sql, `DROP TRIGGER stop_bookkeeping_fault_${event}`);
  assert.deepEqual(yield* f.core.control.setChatPolicy(f.mainThreadId, false, policy.generation), {status: "saved", changed: true});
  yield* f.restart();
  assert.deepEqual(yield* f.core.policy.get().pipe(Effect.orDie),
    {generation: policy.generation + 1, excludedThreadIds: [...policy.excludedThreadIds, f.mainThreadId]}, "the exclusion committed");
  const rejected = yield* f.core.store.start(f.mainThreadId).pipe(Effect.orDie);
  assert.deepEqual({status: rejected?.status, reason: rejected?.reason}, {status: "rejected", reason: "Superseded by a later Stop."}, "its bookkeeping committed");
  assert.notEqual(yield* f.core.store.chatStop(f.mainThreadId).pipe(Effect.orDie), null, "the Stop is recorded");
}), {timeout: 60_000});
