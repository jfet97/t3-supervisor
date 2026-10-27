import assert from "node:assert/strict";
import {it} from "vitest";
import {prepareWorkflowRequest, readerWorkflowInstruction} from "../src/supervisor-workflow.js";
import {goldenSnapshot} from "./support/c1-workflow-fixture.js";

// the bound root's first interpretation may pause the affected conversations before it plans, through the service; nothing else changes
const submission = (startVerdict: boolean) => ({supervisorThreadId: "supervisor-a", bindingGeneration: 3, taskId: "task-a",
  attemptId: "interpretation-attempt:00000000-0000-4000-8000-000000000001", sourcePin: {messageId: "message-a", runId: "run-a", ordinal: 1, hash: "a".repeat(64)}, startVerdict});
const reader = {supervisorThreadId: "supervisor-a", bindingGeneration: 3};

it("a bound root's interpretation instructions use exact scope pins for the early planning pause", () => {
  const rules = readerWorkflowInstruction.slice(readerWorkflowInstruction.lastIndexOf("PLANNING PAUSE: in a request with a SUBMISSION and no START AUTHORIZATION"));
  for (const rule of [
    "supervision_planning", "with action pause, the reader's supervisorThreadId/bindingGeneration and envelope planning.taskId/taskRevision",
    "naming only affected conversations", "do it first, before reading definitions or planning",
    "Never substitute sourcePin.hash for taskRevision",
    "Never pause for quick routine work, a discussion, an unclear request or a not_needed, following or pause decision: those stay silent",
    "never message them or repeat a service notice", "at most one bounded read-only drafter", "never edits, runs state-changing commands, contacts anyone, delegates or submits",
    "Check the attempt with action read", "only after every affected conversation has ACKed or is quiescent, rechecked against their activity up to those ACKs",
    "release with action release, then submit", "When the deadline released the pause first, still submit",
  ]) assert.ok(rules.includes(rule), rule);
  // the tool limit carries the same narrow exception
  assert.ok(readerWorkflowInstruction.includes("The second exception: read supplied main/child message handles with bounded local t3_thread_read, and use supervision_planning and at most one read-only drafter exactly as PLANNING PAUSE below says"));
  assert.ok(readerWorkflowInstruction.includes("Otherwise do not browse, read files, run commands, delegate, contact the operational agent, or ask questions."));
  assert.ok(readerWorkflowInstruction.includes("Use no other tools except bounded local t3_thread_read of the supplied main/child message handles, submission, supervision_planning with at most one read-only drafter exactly as PLANNING PAUSE allows"));
  // scope revision and source-body hash are separate identities
  const planning = {taskId: "task-a", taskRevision: "authorized-scope-revision"};
  const request = prepareWorkflowRequest("thread-a", "message-a", "Change the export format.", goldenSnapshot, {reader, planning, submission: submission(false)}).requestText;
  assert.ok(request.includes(`"sourcePin":{"messageId":"message-a","runId":"run-a","ordinal":1,"hash":"${"a".repeat(64)}"}`), request);
  assert.ok(request.includes(`"planning":${JSON.stringify(planning)}`), request);
  for (const options of [{reader, submission: submission(false)}, {reader, submission: submission(true)}, {submission: submission(false)}, {reader}])
    assert.ok(!prepareWorkflowRequest("thread-a", "message-a", "Change the export format.", goldenSnapshot, options).requestText.includes("PLANNING PAUSE"));
});
