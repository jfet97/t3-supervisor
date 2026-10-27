import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Clock, Context, Deferred, Effect, Fiber, Layer } from "effect";
import { TestClock } from "effect/testing";
import { fingerprint } from "../src/guidance-store.js";
import { defaultSupervisorModel, type TaskRecord } from "../src/project-supervisor-store.js";
import { SupervisorPlanningController } from "../src/supervisor-planning-controller.js";
import { createPlanningAttempt } from "../src/supervisor-planning.js";
import type { NativeRpcShape } from "../src/supervisor-native.js";
import { ThreadPolicyStore } from "../src/thread-policy.js";
import { workflowToolNames } from "../src/workflow-write-evidence.js";
import type { Projection, ThreadInfo } from "../src/types.js";
import { policyLayer, supervisionStores, temporaryDirectory } from "./support/g11-stores.js";
import { teamControllers } from "./support/g11-team.js";

const fixture = (rpc?: NativeRpcShape) => Effect.gen(function* () {
  const directory = yield* temporaryDirectory("planning-controller-");
  const stores = yield* supervisionStores(directory);
  const policy = Context.get(yield* Layer.build(policyLayer({dataDirectory: directory, t3Url: "http://unused", t3TokenFile: "unused",
    excludedThreadIds: [], healthPort: 0})), ThreadPolicyStore);
  const binding = {...yield* stores.supervisors.reserve("project", "main", "main", defaultSupervisorModel, 1, 1), state: "ready" as const};
  yield* stores.supervisors.setBinding(binding);
  const task: TaskRecord = {id: "task-a", sourceHash: fingerprint("Update the application"), threadId: "main", projectId: "project", sourceRunId: "source-run",
    sourceMessageId: "request-a", status: "inferred", objective: "Update the application", reason: "Requested work", updatedAt: 0,
    requestText: "Update the application", supervisorThreadId: binding.threadId, messageId: "interpretation-a", dispatchedAt: null,
    replayCount: 0, supervisorRunId: null, sourceOrdinal: 1};
  yield* stores.supervisors.saveTask(task);
  const threads: ThreadInfo[] = [
    {id: "main", title: "Main", projectId: "project", lineage: {parentThreadId: null, relationshipToParent: null}, runtimeMode: "full-access", interactionMode: "default"},
    {id: binding.threadId, title: "Supervisor", projectId: "project", lineage: {parentThreadId: "main", relationshipToParent: "subagent"},
      runtimeMode: "full-access", interactionMode: "default"},
  ];
  const projections = new Map<string, Projection>(threads.map(thread => [thread.id, {thread, runs: [], nodes: [], messages: [], turnItems: [], runtimeRequests: []}]));
  projections.get("main")!.messages.push({id: "request-a", runId: "source-run", nodeId: "source-node", role: "user", text: task.requestText,
    streaming: false, createdBy: "user", creationSource: "web", createdAt: "2026-10-27T12:00:00Z", updatedAt: "2026-10-27T12:00:00Z"});
  projections.get("main")!.runs.push({id: "source-run", threadId: "main", ordinal: 1, status: "completed", rootNodeId: "source-node",
    requestedAt: "2026-10-27T12:00:00Z", startedAt: "2026-10-27T12:00:00Z", completedAt: "2026-10-27T12:01:00Z"});
  (projections.get("main")!.nodes as Record<string, unknown>[]).push({id: "source-node", kind: "root_turn", threadId: "main", runId: "source-run", rootNodeId: "source-node", status: "completed"});
  const details = new Map<string, unknown>();
  const built = yield* teamControllers(stores, policy, {listThreads: () => Effect.succeed(threads), projection: id => Effect.succeed(projections.get(id)!),
    turnItem: id => Effect.succeed(details.get(id))}, {rpc});
  const context = yield* Layer.build(SupervisorPlanningController.layer.pipe(Layer.provide(Layer.succeedContext(built.context))));
  const controller = Context.get(context, SupervisorPlanningController);
  const proof = (input: Record<string, unknown>) => {
    const root = projections.get(binding.threadId)!;
    const itemId = `planning-tool-${details.size}`;
    const runId = `caller-${itemId}`, rootNodeId = `root-${itemId}`, nodeId = `node-${itemId}`, providerThreadId = "provider-root";
    const detail = {id: itemId, type: "dynamic_tool", threadId: binding.threadId, runId, nodeId, providerThreadId,
      providerTurnId: `turn-${itemId}`, nativeItemRef: {driver: "codex", nativeId: itemId, strength: "strong"},
      parentItemId: null, ordinal: details.size + 1, status: "completed", toolNonExecutionKind: null,
      toolName: workflowToolNames.planning.direct[0], input};
    details.set(itemId, detail);
    root.runs.push({id: runId, threadId: binding.threadId, ordinal: root.runs.length + 1, status: "completed",
      requestedAt: "2026-10-27T12:00:00Z", startedAt: null, completedAt: null, rootNodeId, providerThreadId});
    (root.nodes as Record<string, unknown>[]).push({id: rootNodeId, kind: "root_turn", threadId: binding.threadId, runId, rootNodeId, providerThreadId, status: "completed"},
      {id: nodeId, kind: "dynamic_tool", threadId: binding.threadId, runId, rootNodeId, providerThreadId, parentNodeId: rootNodeId, status: "completed"});
    root.turnItems!.push({...detail, input: "snapshot-summary"});
  };
  const args = {supervisorThreadId: binding.threadId, bindingGeneration: binding.generation, taskId: task.id, taskRevision: task.sourceHash,
    action: "pause", operationId: "pause-a", targetThreadIds: ["main"], reason: "Prepare the requested plan"};
  return {stores, binding, task, threads, projections, controller, args, proof};
});

it.effect("a planning pause needs its exact native owner call and preserves one identity on replay", () => Effect.gen(function* () {
  const f = yield* fixture();
  const unproven = (yield* f.controller.call(f.args)) as {status: string};
  assert.notEqual(unproven.status, "recorded");
  assert.deepEqual(yield* f.stores.requests.planningAttempts("project"), []);
  f.proof(f.args);
  const first = (yield* f.controller.call(f.args)) as {status: string; attempt?: {id: string; deadline: number}};
  assert.equal(first.status, "recorded");
  const replay = (yield* f.controller.call(f.args)) as typeof first;
  assert.deepEqual(replay.attempt?.id, first.attempt?.id);
  assert.equal(replay.attempt?.deadline, first.attempt?.deadline);
  assert.equal((yield* f.stores.requests.planningAttempts("project")).length, 1);
  const changed = {...f.args, reason: "A different pause under the same operation"};
  f.proof(changed);
  const conflict = (yield* f.controller.call(changed)) as {reason?: string};
  assert.equal(conflict.reason, "operation_id_conflict");
}));

it.effect("the watchdog closes and releases a pause while its original native send is still awaiting a receipt", () => Effect.gen(function* () {
  const holdStarted = yield* Deferred.make<void>();
  const releaseStarted = yield* Deferred.make<void>();
  const holdReply = yield* Deferred.make<unknown>();
  const sent: Record<string, unknown>[] = [];
  const rpc: NativeRpcShape = {
    call: () => Effect.die(new Error("only admitted native initiation is allowed")),
    initiate: (_tag, payload) => Effect.gen(function* () {
      sent.push({...payload});
      const hold = String(payload.messageId).includes(":hold:");
      yield* Deferred.succeed(hold ? holdStarted : releaseStarted, undefined);
      return {sent: Effect.succeed(true), release: Effect.void,
        result: hold ? Deferred.await(holdReply) : Effect.succeed({sequence: 2})};
    }),
  };
  const f = yield* fixture(rpc);
  const now = yield* Clock.currentTimeMillis;
  const pause = createPlanningAttempt({id: "watchdog-pause", operationId: "watchdog-operation", projectId: "project", mainThreadId: "main",
    ownerThreadId: f.binding.threadId, bindingGeneration: f.binding.generation, taskId: f.task.id, taskRevision: f.task.sourceHash,
    reason: "Prepare the plan", createdAt: now, timeoutMs: 10_000,
    targets: [{threadId: "main", recipientThreadId: "main", scope: "implementation"}]});
  yield* f.stores.requests.savePlanningAttempt(pause);
  const originalSend = yield* Effect.forkChild(f.controller.reconcile(f.binding));
  yield* Effect.raceFirst(Deferred.await(holdStarted), Effect.andThen(Fiber.join(originalSend), Effect.die(new Error("reconcile finished without initiating its pause"))));
  yield* TestClock.adjust("10 seconds");
  yield* Deferred.await(releaseStarted);
  assert.equal(yield* Deferred.isDone(holdReply), false, "release is independent of the unresolved original send");
  const [expired] = yield* f.stores.requests.planningAttempts("project");
  assert.equal(expired?.state, "expired");
  assert.equal(expired?.deadline, pause.deadline);
  assert.match(String(sent.find(payload => String(payload.messageId).includes(":release:"))?.text), /Continue with your authorised task/);
  yield* Deferred.succeed(holdReply, {sequence: 1});
  yield* Fiber.join(originalSend);
  const [afterLateReceipt] = yield* f.stores.requests.planningAttempts("project");
  assert.equal(afterLateReceipt?.state, "expired");
}));
