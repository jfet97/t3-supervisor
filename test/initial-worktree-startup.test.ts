import assert from "node:assert/strict";
import {it} from "@effect/vitest";
import {Effect} from "effect";
import {planFields, startInterpretationFixture} from "./support/interpretation-fixture.js";

it.live("workspace preparation does not read root policy or dispatch an interpretation before the worktree is bound", () => Effect.gen(function* () {
  const f = yield* startInterpretationFixture();
  f.addRequest("worktree-request", "Implement the requested change; leave its PR unmerged.");
  const run = f.main().runs.at(-1)!;
  run.status = "preparing";
  run.startedAt = null;
  yield* f.runOnce();
  yield* f.runOnce();
  assert.equal(f.definitions.reads, 0);
  assert.equal(f.interpretationDispatches().length, 0);
  run.status = "running";
  run.startedAt = run.requestedAt;
  f.main().thread.worktreePath = "/workspace/ready-worktree";
  f.definitions.current = {...f.definitions.current, workspaceRoot: "/workspace/ready-worktree", revision: "worktree-policy"};
  yield* f.runOnce();
  yield* f.runOnce();
  const task = yield* f.task();
  assert.equal(task.definitionSnapshot?.workspaceRoot, "/workspace/ready-worktree");
  assert.equal(f.interpretationDispatches().length, 1);
}), {timeout: 60_000});

it.live("a historical preparing run does not block a later request in its ready worktree", () => Effect.gen(function* () {
  const f = yield* startInterpretationFixture();
  f.addRequest("ready-request", "Implement the requested repository change.");
  f.main().runs.unshift({...f.main().runs[0]!, id: "old-preparation", ordinal: 0, status: "preparing"});
  f.main().thread.worktreePath = "/workspace/ready-worktree";
  yield* f.runOnce();
  yield* f.runOnce();
  assert.equal(f.interpretationDispatches().length, 1);
}), {timeout: 60_000});

for (const variant of ["identical", "retained", "changed", "stopped"] as const) {
  it.live(`an initial checkout relocation recovers only an unsent identical policy: ${variant}`, () => Effect.gen(function* () {
    const f = yield* startInterpretationFixture();
    f.addRequest("moving-request", "Implement the requested repository change.");
    f.main().runs.at(-1)!.status = "running";
    yield* f.runOnce();
    yield* f.runOnce();
    const task = yield* f.task();
    assert.equal((yield* f.submitFields(task, planFields(task))).value.status, "submitted");
    f.main().thread.worktreePath = "/workspace/ready-worktree";
    f.definitions.current = {...f.definitions.current, workspaceRoot: "/workspace/ready-worktree", revision: "worktree-policy",
      ...(variant === "changed" || variant === "retained" ? {sources: [{path: ".t3-supervisor/project.yaml", content: "changed policy", origin: "project" as const}]} : {})};
    if (variant === "stopped") f.main().runs.at(-1)!.status = "interrupted";
    f.endRun(task, "completed");
    yield* f.runOnce();
    if (variant === "retained") {
      const retained = yield* f.task();
      assert.equal(retained.status, "inferred");
      assert.equal(retained.workflow?.status, "stale");
      assert.equal(retained.definitionReview?.status, "checking");
      assert.equal((yield* f.core.requests.introduction(task.id))?.state, "context");
      assert.equal(f.interpretationDispatches().length, 1);
      // restore identical content before reopening the state left by the old binary
      f.definitions.current = {...f.definitions.current, sources: task.definitionSnapshot!.sources};
    }
    yield* f.restart();
    yield* f.runOnce();
    yield* f.runOnce();
    if (variant === "identical" || variant === "retained") {
      const renewed = yield* f.task();
      assert.equal(renewed.status, "waiting");
      assert.notEqual(renewed.attempt?.attemptId, task.attempt?.attemptId);
      assert.equal((yield* f.submitFields(renewed, planFields(renewed))).value.status, "submitted");
      f.main().runs.at(-1)!.status = "completed";
      f.endRun(renewed, "completed");
      yield* f.runOnce();
      const current = yield* f.task();
      assert.equal(current.workflow?.status, "proposed");
      assert.equal(current.workflow.workspaceRoot, "/workspace/ready-worktree");
      assert.equal(f.operativeSends().length, 1);
      assert.equal(f.interpretationDispatches().length, 2);
      assert.equal(current.id, task.id);
      assert.equal(f.binding.threadId, task.supervisorThreadId);
      assert.equal(current.definitionReview, undefined);
      assert.equal(f.rootSends().length, 2);
      yield* f.core.requests.noticeSent(f.binding.threadId, 0);
      yield* f.runOnce();
      yield* f.runOnce();
      assert.equal(f.operativeSends().length, 1);
      assert.equal(f.interpretationDispatches().length, 2);
      assert.ok(f.rootSends().every(command => !String(command.text).includes("UNTRUSTED_PROJECT_DEFINITION_REVIEW_ENVELOPE")));
      assert.equal(f.rootSends().filter(command => !String(command.text).includes("UNTRUSTED_MONITOR_ENVELOPE")).length, 2);
    } else {
      const current = yield* f.task();
      assert.equal(f.operativeSends().length, 0);
      assert.equal(f.interpretationDispatches().length, 1);
      assert.equal(current.workflow?.status, "stale");
      assert.equal(current.workflow.workspaceRoot, task.definitionSnapshot?.workspaceRoot);
    }
  }), {timeout: 60_000});
}
