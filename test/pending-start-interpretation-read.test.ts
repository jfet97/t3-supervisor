import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { SupervisionControl } from "../src/supervision-control.js";
import { SupervisionGate, SupervisionScopeService, type SupervisionScope } from "../src/supervision-gate.js";
import { SupervisorConversation } from "../src/supervisor-conversation.js";
import { WorkflowNativeAccess, WorkflowWriteController } from "../src/workflow-write-controller.js";
import { WorkflowStateStore } from "../src/workflow-state-store.js";
import { noProjectFixture, type PsSupervisor } from "./support/ps-fixture.js";

// the production workflow_read/workflow_write entries over the supervisor's own conversation, stores and gate, with the given scope
const controllerOf = (supervisor: PsSupervisor, scope: SupervisionScope) => WorkflowWriteController.make({withoutTeam: true, maxEvidenceWaitMs: 0}).pipe(
  Effect.provideService(WorkflowNativeAccess, WorkflowNativeAccess.of({
    listThreads: () => Effect.die(new Error("no native read is expected")),
    projection: () => Effect.die(new Error("no native read is expected")),
    getTurnItem: () => Effect.die(new Error("no native read is expected"))})),
  Effect.provideService(SupervisionControl, supervisor.control),
  Effect.provideService(SupervisionGate, supervisor.gate),
  Effect.provideService(SupervisionScopeService, scope),
  Effect.provideService(WorkflowStateStore, supervisor.workflows),
  Effect.provideService(SupervisorConversation, supervisor.conversation),
  Effect.provide(supervisor.stores.context),
);

// the same scope with workflow editing closed, as it can be while a Start is pending: the interpretation permission is unchanged
const editingClosed = (scope: SupervisionScope): SupervisionScope =>
  Object.assign(Object.create(scope) as SupervisionScope, {workflowEditingEnabled: () => Effect.succeed(false)});

it.effect("a pending Start's root reads its interpretation context through workflow_read under the interpretation permission, never a write or other read", () => Effect.gen(function* () {
  const f = yield* noProjectFixture();
  assert.equal((yield* f.supervisor.startSupervision({callerThreadId: "manual", userMessageId: "request-start", operationId: "own-start"}, {runId: "run-request-start"})).status, "pending");
  yield* f.supervisor.runOnce;
  const task = (yield* f.fixture.store.task("manual"))!;
  const binding = (yield* f.fixture.store.binding("project-a", "manual"))!;
  assert.equal(task.status, "waiting", "the Start interpretation is in flight");
  const reader = {supervisorThreadId: binding.threadId, bindingGeneration: binding.generation};
  for (const [label, scope] of [["open", f.supervisor.scope], ["editing closed", editingClosed(f.supervisor.scope)]] as const) {
    const controller = yield* controllerOf(f.supervisor, scope);
    const context = (yield* controller.readTool({...reader, view: "context"})) as Record<string, unknown>;
    assert.equal(context.status, "ok", label);
    assert.equal(context.supervision, "pending_start", label);
    assert.deepEqual(context.submission, {tool: "supervision_interpretation_submit", arguments: {...reader, taskId: task.id,
      attemptId: task.attempt!.attemptId, sourcePin: task.attempt!.key.source}, startVerdict: true}, label);
    for (const view of ["interpretation", "instructions", "definitions"])
      assert.notEqual((yield* controller.readTool({...reader, view})).status, "denied", `${label} ${view}`);
    // the same pins name nothing for an older generation; a write, a dry-run check, a status or document read stay closed
    assert.equal((yield* controller.readTool({...reader, bindingGeneration: binding.generation + 1, view: "context"})).status, "denied", label);
    assert.equal((yield* controller.write({...reader, operationId: `review-${label}`, action: "record_review", requestId: "any", outcome: "no_change"})).status, "denied", label);
    if (label === "editing closed") {
      for (const input of [{...reader, view: "check", record: {}}, {...reader, view: "status"}, reader])
        assert.equal((yield* controller.readTool(input)).status, "denied", `${label} ${JSON.stringify(input)}`);
    }
  }
  // once the attempt is no longer in flight, nothing outside workflow editing admits the read
  yield* f.fixture.store.saveTask({...task, status: "inferred"});
  const closed = yield* controllerOf(f.supervisor, editingClosed(f.supervisor.scope));
  assert.equal((yield* closed.readTool({...reader, view: "context"})).status, "denied");
}), {timeout: 60_000});

it.effect("a stopped chat without a valid pending Start admits no interpretation read when workflow editing is closed", () => Effect.gen(function* () {
  const f = yield* noProjectFixture();
  assert.equal((yield* f.supervisor.startSupervision({callerThreadId: "manual", userMessageId: "request-start", operationId: "own-start"}, {runId: "run-request-start"})).status, "pending");
  yield* f.supervisor.runOnce;
  const binding = (yield* f.fixture.store.binding("project-a", "manual"))!;
  const reader = {supervisorThreadId: binding.threadId, bindingGeneration: binding.generation};
  // a later Stop supersedes the pending Start: its permission is gone, and the stopped context names no submission
  yield* f.fixture.store.saveUnboundStop("manual", {route: "ui", callerThreadId: null, userMessageId: null, stoppedAt: f.fixture.now() + 60_000});
  yield* f.supervisor.setChatSupervision({projectId: "project-a", mainThreadId: "manual", policyGeneration: (yield* f.policy.get()).generation, enabled: false});
  const controller = yield* controllerOf(f.supervisor, editingClosed(f.supervisor.scope));
  for (const view of ["interpretation", "instructions", "definitions"])
    assert.equal((yield* controller.readTool({...reader, view})).status, "denied", view);
  const context = (yield* controller.readTool({...reader, view: "context"})) as Record<string, unknown>;
  assert.equal(context.supervision, "stopped");
  assert.equal(context.submission, undefined);
}), {timeout: 60_000});
