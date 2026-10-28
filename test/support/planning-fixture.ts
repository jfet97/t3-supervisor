import { Context, Effect, Layer } from "effect";
import { fingerprint } from "../../src/guidance-store.js";
import { defaultSupervisorModel, type TaskRecord } from "../../src/project-supervisor-store.js";
import { SupervisorConversation } from "../../src/supervisor-conversation.js";
import { SupervisorPlanningController } from "../../src/supervisor-planning-controller.js";
import type { NativeRpcShape } from "../../src/supervisor-native.js";
import { ThreadPolicyStore } from "../../src/thread-policy.js";
import type { Projection, ThreadInfo } from "../../src/types.js";
import { workflowToolNames } from "../../src/workflow-write-evidence.js";
import { WorkflowStateStore } from "../../src/workflow-state-store.js";
import { engagedTask } from "./engaged-task.js";
import { policyLayer, supervisionStores, temporaryDirectory } from "./g11-stores.js";
import { teamControllers } from "./g11-team.js";

/**
 * The planning controller over the g11 production layers and the real conversation service (its read-only context views): a bound
 * root of main "main", an engaged task from a genuine human source and fake native reads whose projections a suite edits in place.
 */
export const planningFixture = (rpc?: NativeRpcShape) => Effect.gen(function* () {
  const directory = yield* temporaryDirectory("planning-controller-");
  const stores = yield* supervisionStores(directory);
  const policy = Context.get(yield* Layer.build(policyLayer({dataDirectory: directory, t3Url: "http://unused", t3TokenFile: "unused",
    excludedThreadIds: [], healthPort: 0})), ThreadPolicyStore);
  const binding = {...yield* stores.supervisors.reserve("project", "main", "main", defaultSupervisorModel, 1, 1), state: "ready" as const};
  yield* stores.supervisors.setBinding(binding);
  let task: TaskRecord = {id: "task-a", sourceHash: fingerprint("Update the application"), threadId: "main", projectId: "project", sourceRunId: "source-run",
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
  projections.get("main")!.messages.push({id: "request-a", threadId: "main", runId: "source-run", nodeId: "source-node", role: "user", text: task.requestText,
    streaming: false, createdBy: "user", creationSource: "web", createdAt: "2026-10-27T12:00:00Z", updatedAt: "2026-10-27T12:00:00Z"});
  projections.get("main")!.runs.push({id: "source-run", threadId: "main", ordinal: 1, status: "completed", rootNodeId: "source-node", providerThreadId: "provider-main",
    requestedAt: "2026-10-27T12:00:00Z", startedAt: "2026-10-27T12:00:00Z", completedAt: "2026-10-27T12:01:00Z"});
  (projections.get("main")!.nodes as Record<string, unknown>[]).push({id: "source-node", kind: "root_turn", threadId: "main", runId: "source-run", rootNodeId: "source-node", providerThreadId: "provider-main", status: "completed"});
  task = engagedTask(task, projections.get("main")!);
  yield* stores.supervisors.saveTask(task);
  const details = new Map<string, unknown>();
  const built = yield* teamControllers(stores, policy, {listThreads: () => Effect.succeed(threads), projection: id => Effect.succeed(projections.get(id)!),
    turnItem: id => Effect.succeed(details.get(id))}, {rpc});
  const views = Context.add(built.context, SupervisorConversation, Context.get(yield* Layer.build(SupervisorConversation.layer.pipe(
    Layer.provide(Layer.succeedContext(built.context)))), SupervisorConversation));
  const context = yield* Layer.build(SupervisorPlanningController.layer.pipe(Layer.provide(Layer.succeedContext(views))));
  const controller = Context.get(context, SupervisorPlanningController);
  /** One executed supervision_planning call of `threadId` with exactly `input`, in a completed run of that thread's own. */
  const callAs = (threadId: string, input: Record<string, unknown>) => {
    const caller = projections.get(threadId)!;
    const itemId = `planning-tool-${details.size}`;
    const runId = `caller-${itemId}`, rootNodeId = `root-${itemId}`, nodeId = `node-${itemId}`;
    const providerThreadId = threadId === binding.threadId ? "provider-root" : `provider-${threadId}`;
    const detail = {id: itemId, type: "dynamic_tool", threadId, runId, nodeId, providerThreadId,
      providerTurnId: `turn-${itemId}`, nativeItemRef: {driver: "codex", nativeId: itemId, strength: "strong"},
      parentItemId: null, ordinal: details.size + 1, status: "completed", toolNonExecutionKind: null,
      toolName: workflowToolNames.planning.direct[0], input};
    details.set(itemId, detail);
    caller.runs.push({id: runId, threadId, ordinal: caller.runs.length + 1, status: "completed",
      requestedAt: "2026-10-27T12:00:00Z", startedAt: null, completedAt: null, rootNodeId, providerThreadId});
    (caller.nodes as Record<string, unknown>[]).push({id: rootNodeId, kind: "root_turn", threadId, runId, rootNodeId, providerThreadId, status: "completed"},
      {id: nodeId, kind: "dynamic_tool", threadId, runId, rootNodeId, providerThreadId, parentNodeId: rootNodeId, status: "completed"});
    caller.turnItems!.push({...detail, input: "snapshot-summary"});
  };
  const proof = (input: Record<string, unknown>) => callAs(binding.threadId, input);
  const args = {supervisorThreadId: binding.threadId, bindingGeneration: binding.generation, taskId: task.id, taskRevision: task.sourceHash,
    action: "pause", operationId: "pause-a", targetThreadIds: ["main"], reason: "Prepare the requested plan"};
  return {stores, policy, binding, task, threads, projections, details, controller, args, proof, callAs, workflows: built.workflows,
    states: Context.get(built.context, WorkflowStateStore), conversation: Context.get(views, SupervisorConversation)};
});
