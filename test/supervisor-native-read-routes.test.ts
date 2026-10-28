import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { TestClock } from "effect/testing";
import type { SupervisorMonitorBatch, SupervisorMonitorThreadBatch } from "../src/supervisor-monitor.js";
import type { RunInfo, SupervisorSettings } from "../src/types.js";
import { wallClock } from "./support/g1b-conversation.js";
import { appendRun, baseTime, iso, makeFixture, operativeThreadId, projectId, type Fixture } from "./support/c1-conversation-fixture.js";
import { helperBatch, projectId as linProjectId, seedTeam, startLinFixture } from "./support/lin-fixture.js";

// audit F7: a Supervisor's own T3 thread reads count toward its awareness on the deployment's configured gateway call tools, as its
// workflow calls are proven. The production conversation collects them from the run of its pending request through the read
// credential; the fake T3 serves each native item as recorded

// a waiting monitoring review of the operative, and the Supervisor run it started
const waitingReview = (fixture: Fixture) => Effect.gen(function* () {
  const item = {id: `run:${operativeThreadId}`, readItemId: null, type: "run_finished", status: "completed", ordinal: 1, detectedAt: baseTime,
    version: `${operativeThreadId}-v1`, priority: "run_finished" as const};
  const thread: SupervisorMonitorThreadBatch = {threadId: operativeThreadId, trigger: "priority", finalizedActivityCount: 1, pendingItemCount: 1,
    oldestAt: baseTime, priority: true, priorityKinds: ["run_finished"], saturated: false, untrackedCount: 0, items: [item], previewItems: [item]};
  const batch: SupervisorMonitorBatch = {projectId, createdAt: baseTime, trigger: "priority", finalizedActivityCount: 1, pendingItemCount: 1,
    truncated: false, threads: [thread]};
  const prepared = yield* fixture.requests.prepare({projectId, supervisorThreadId: fixture.binding.threadId, kind: "review", taskId: null,
    text: "Review the operative's finished run.", batch, completionMarker: "Supervisor check-in monitor:1 completed"}, baseTime).pipe(Effect.orDie);
  const run = appendRun({projection: fixture.supervisor, id: "review-run", ordinal: fixture.supervisor.runs.length + 1, status: "running",
    messageId: prepared.messageId, text: prepared.text, createdBy: "system", creationSource: "server", now: baseTime});
  yield* fixture.requests.saveRequest({...prepared, state: "waiting", runId: run.id, sentAt: baseTime}).pipe(Effect.orDie);
  return run;
});

// one completed native call of the Supervisor in the review run, whose result is a page of `target`
const completedCall = (fixture: Fixture, run: RunInfo, id: string, toolName: string, input: unknown, target = operativeThreadId) => {
  const supervisorThreadId = fixture.supervisor.thread.id;
  (fixture.supervisor.nodes as Array<Record<string, unknown>>).push({id: `node-${id}`, kind: "dynamic_tool", threadId: supervisorThreadId, runId: run.id,
    rootNodeId: run.rootNodeId, providerThreadId: run.providerThreadId, parentNodeId: run.rootNodeId, status: "completed"});
  fixture.supervisor.turnItems!.push({id, type: "dynamic_tool", status: "completed", threadId: supervisorThreadId, runId: run.id, nodeId: `node-${id}`,
    toolNonExecutionKind: null, toolName, input, updatedAt: iso(baseTime + 1_000),
    output: {structuredContent: {thread: {threadId: target}, items: [{itemId: `${id}-page`, position: 3, textTruncated: false}], hasMore: false}}});
};

// the same reads in every case: one through the configured gateway, and the routes that must never count
const installReads = (fixture: Fixture, run: RunInfo) => {
  const read = {name: "t3-code__t3_thread_read", arguments: {threadId: operativeThreadId, view: "activity"}};
  completedCall(fixture, run, "read-configured", "mcp__other_gateway__call_tool", read);
  completedCall(fixture, run, "read-mcpx", "mcpx.mcpx_call_tool", read);
  completedCall(fixture, run, "read-unknown-gateway", "mcp__unknown_gateway__call_tool", read);
  completedCall(fixture, run, "read-foreign-target", "mcp__other_gateway__call_tool", {...read, name: "other__t3_thread_read"});
  completedCall(fixture, run, "read-other-shape", "mcp__other_gateway__call_tool", {...read, extra: true});
  completedCall(fixture, run, "read-outside-batch", "mcp__other_gateway__call_tool",
    {...read, arguments: {threadId: "operative-b", view: "activity"}}, "operative-b");
};

const recorded = (fixture: Fixture) => Effect.map(fixture.requests.pending(projectId, fixture.binding.threadId).pipe(Effect.orDie), (request) => ({
  calls: request?.nativeReadCallIds ?? [],
  reads: request?.nativeReads?.map(read => ({target: read.targetThreadId, call: read.callItemId, actor: read.actorThreadId})) ?? [],
}));

const runWith = (config?: Partial<SupervisorSettings>) => Effect.gen(function* () {
  yield* TestClock.setTime(wallClock);
  const fixture = yield* makeFixture({now: baseTime}, {task: false, ...(config ? {config} : {})});
  installReads(fixture, yield* waitingReview(fixture));
  yield* fixture.run;
  return {fixture, recorded: yield* recorded(fixture)};
});

it.effect("a read through the configured gateway call tool counts; the unconfigured MCPX default, another gateway, a foreign target or another shape do not", () =>
  Effect.gen(function* () {
    const {fixture, recorded} = yield* runWith({workflowMcpGatewayTools: ["mcp__other_gateway__call_tool"]});
    assert.deepEqual(recorded, {calls: ["read-configured"], reads: [{target: operativeThreadId, call: "read-configured", actor: fixture.binding.threadId}]});
  }), { timeout: 30_000 });

it.effect("with the documented registrations the MCPX call tool counts and the other gateway does not", () => Effect.gen(function* () {
  const {fixture, recorded} = yield* runWith();
  assert.deepEqual(recorded, {calls: ["read-mcpx"], reads: [{target: operativeThreadId, call: "read-mcpx", actor: fixture.binding.threadId}]});
}), { timeout: 30_000 });

// the helper path: a helper's own reads during its delivered monitoring review count on the same configured routes
it.live("a helper's read through the configured gateway call tool counts toward its review; the unconfigured MCPX default and another gateway do not", () =>
  Effect.gen(function* () {
    const f = yield* startLinFixture({config: {workflowMcpGatewayTools: ["gateway.invoke"]}});
    const binding = yield* f.bindSupervisor;
    const {helper} = yield* seedTeam(f);
    const threads = [helper.thread, ...f.threads];
    const runtime = f.core.teamRuntime;
    const batches = (yield* runtime.partition(binding, threads, helperBatch("branch"))).helperBatches;
    yield* runtime.startCycle(yield* f.binding);
    yield* runtime.runHelperBatch(yield* f.binding, threads, batches);
    const helperRequests = Effect.map(f.core.requests.requests(linProjectId, helper.thread.id).pipe(Effect.orDie),
      (requests) => requests.find(value => value.id.startsWith("team-review:")));
    const request = (yield* helperRequests)!;
    assert.equal(request.state, "waiting");
    // the helper's run of the delivered review, and its reads of the assigned child
    const run: RunInfo = {id: "helper-review-run", threadId: helper.thread.id, ordinal: helper.runs.length + 1, status: "running",
      requestedAt: iso(baseTime), startedAt: iso(baseTime), completedAt: null, rootNodeId: "helper-review-root", userMessageId: request.messageId,
      providerThreadId: "helper-provider"};
    helper.runs.push(run);
    (helper.nodes as Array<Record<string, unknown>>).push({id: run.rootNodeId, kind: "root_turn", threadId: helper.thread.id, runId: run.id,
      rootNodeId: run.rootNodeId, providerThreadId: run.providerThreadId, parentNodeId: null, status: "running"});
    const read = {name: "t3-code__t3_thread_read", arguments: {threadId: "branch", view: "activity"}};
    for (const [id, toolName] of [["helper-read-configured", "gateway.invoke"], ["helper-read-mcpx", "mcpx.mcpx_call_tool"],
      ["helper-read-unknown-gateway", "mcp__unknown_gateway__call_tool"]] as const) {
      (helper.nodes as Array<Record<string, unknown>>).push({id: `node-${id}`, kind: "dynamic_tool", threadId: helper.thread.id, runId: run.id,
        rootNodeId: run.rootNodeId, providerThreadId: run.providerThreadId, parentNodeId: run.rootNodeId, status: "completed"});
      const detail = {id, type: "dynamic_tool", status: "completed", threadId: helper.thread.id, runId: run.id, nodeId: `node-${id}`,
        toolNonExecutionKind: null, toolName, input: read, updatedAt: iso(baseTime + 1_000),
        output: {structuredContent: {thread: {threadId: "branch"}, items: [{itemId: `${id}-page`, position: 2, textTruncated: false}], hasMore: false}}};
      f.peer.details.set(id, detail);
      helper.turnItems!.push(detail);
    }
    yield* runtime.startCycle(yield* f.binding);
    yield* runtime.reconcile(yield* f.binding, threads);
    const stored = (yield* helperRequests)!;
    assert.equal(stored.id, request.id);
    assert.deepEqual(stored.nativeReadCallIds, ["helper-read-configured"]);
    assert.deepEqual(stored.nativeReads?.map(value => ({actor: value.actorThreadId, target: value.targetThreadId, call: value.callItemId})),
      [{actor: helper.thread.id, target: "branch", call: "helper-read-configured"}]);
  }), { timeout: 20_000 });
