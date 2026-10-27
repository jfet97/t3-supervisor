import assert from "node:assert/strict";
import {it} from "vitest";
import {interpretationPlanRules, interpretationRules, prepareWorkflowRequest} from "../src/supervisor-workflow.js";
import {goldenSnapshot} from "./support/c1-workflow-fixture.js";

// the bound root's first interpretation may pause the affected conversations before it plans, through the service; nothing else changes
const submission = (startVerdict: boolean) => ({supervisorThreadId: "supervisor-a", bindingGeneration: 3, taskId: "task-a",
  attemptId: "interpretation-attempt:00000000-0000-4000-8000-000000000001", sourcePin: {messageId: "message-a", runId: "run-a", ordinal: 1, hash: "a".repeat(64)}, startVerdict});
const reader = {supervisorThreadId: "supervisor-a", bindingGeneration: 3};

it("a bound root's interpretation rules use exact context pins for the early planning pause, read before any definition", () => {
  // the pause opens the plan stage, which a root reads only once it decided that a plan is needed, before definitions
  assert.ok(interpretationPlanRules.startsWith("PLANNING PAUSE: when context supplies submission pins with startVerdict false"));
  for (const rule of [
    "supervision_planning", "with action pause, the reader's supervisorThreadId/bindingGeneration and context task.taskId/taskRevision",
    "naming only affected conversations", "do it first, before reading definitions or planning",
    "Never substitute sourcePin.hash for taskRevision", "if pins changed, read view context for current task pins",
    "Never pause for quick routine work, a discussion, an unclear request or a not_needed, following or pause decision: those stay silent",
    "never message them or repeat a service notice", "at most one bounded read-only drafter", "never edits, runs state-changing commands, contacts anyone, delegates or submits",
    "Check the attempt with action read", "only after every affected conversation has ACKed or is quiescent, rechecked against their activity up to those ACKs",
    "release with action release, then submit", "When the deadline released the pause first, still submit",
  ]) assert.ok(interpretationPlanRules.includes(rule), rule);
  assert.ok(!interpretationRules.includes("PLANNING PAUSE:"), "stage one names the pause only as a tool exception");
  assert.ok(interpretationRules.includes('When a plan is needed, read view interpretation section "plan" before reading definitions: it holds the planning pause, which comes first'));
  // the tool limit carries the same narrow exception
  assert.ok(interpretationRules.includes("The second exception: read the main/child message handles view context names with bounded local t3_thread_read, and use supervision_planning and at most one read-only drafter exactly as PLANNING PAUSE says"));
  assert.ok(interpretationRules.includes("Otherwise do not browse, read files, run commands, delegate, contact the operational agent, or ask questions."));
  assert.ok(interpretationRules.includes("Use no other tools except bounded local t3_thread_read of the main/child message handles view context names, the submission, supervision_planning with at most one read-only drafter exactly as PLANNING PAUSE allows"));
  // the pins are read from view context, never pushed: no request carries a source pin, a scope revision or the pause rules
  for (const options of [{reader, submission: submission(false)}, {reader, submission: submission(true)}, {submission: submission(false)}, {reader}]) {
    const request = prepareWorkflowRequest("thread-a", "message-a", "Change the export format.", goldenSnapshot, options).requestText;
    for (const pushed of ["PLANNING PAUSE", "sourcePin", "taskRevision", "a".repeat(64)]) assert.ok(!request.includes(pushed), `${pushed}: ${request}`);
  }
});
