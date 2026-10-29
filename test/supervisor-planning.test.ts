import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Exit, Schema } from "effect";
import {
  acknowledgePlanningTarget, closePlanningTarget, createPlanningAttempt, defaultPlanningTimeoutMs,
  expirePlanningAttempt, PlanningAcknowledgement, planningAttemptAnswer, planningCanAdopt, planningDraftInstruction, planningDraftNotice, planningDraftRead,
  planningHasUnresolvedEffects, planningHoldText, planningInstructions, planningReleaseText,
  planningDelivery, resolvePlanningAttempt, startPlanningAttempt, unacceptedProposal, type PlanningAttempt,
} from "../src/supervisor-planning.js";
import { exactFenceRecords } from "../src/supervisor-workflow-agreement.js";
import { interpretationPlanRules } from "../src/supervisor-workflow.js";
import { messageReadRule } from "../src/message-read-handle.js";

const now = Date.parse("2026-10-27T12:00:00.000Z");
const attempt = (): PlanningAttempt => createPlanningAttempt({
  id: "pause-a", operationId: "request-a", projectId: "project-a", mainThreadId: "main-a", ownerThreadId: "owner-a",
  bindingGeneration: 1, taskId: "task-a", taskRevision: "source-a", reason: "Reconcile the implementation plan", createdAt: now,
  timeoutMs: defaultPlanningTimeoutMs, targets: [
    {threadId: "main-a", recipientThreadId: "main-a", scope: "main implementation"},
    {threadId: "child-a", recipientThreadId: "main-a", scope: "child implementation"},
  ],
});
const sent = (): PlanningAttempt => ({...attempt(), targets: attempt().targets.map(target => ({...target,
  hold: {...target.hold, state: "sent", attemptedAt: now, runId: "run-a"}}))});
const evidence = (sourceThreadId: string) => ({sourceThreadId, messageId: `ack-${sourceThreadId}`, runId: "run-a", observedAt: now + 1});

it("a parent's ACK cannot confirm its active child and does not permit adoption", () => {
  const original = sent();
  const wrong = acknowledgePlanningTarget(original, {attemptId: original.id, targetThreadId: "child-a"}, evidence("main-a"), now + 1);
  assert.equal(wrong, original);
  const main = acknowledgePlanningTarget(original, {attemptId: original.id, targetThreadId: "main-a"}, evidence("main-a"), now + 1);
  assert.equal(main.targets[0]?.state, "acknowledged");
  assert.equal(main.targets[1]?.state, "requested");
  assert.equal(planningCanAdopt(main, now + 1), false);
});

it("drafting and partial outcomes never renew the deadline or resolve another target", () => {
  const original = sent();
  const partial = closePlanningTarget({...original, draft: {threadId: "writer-a", taskId: "draft-a", state: "working",
    resultMessageId: null, resultRunId: null}}, "main-a", now + 1000);
  assert.equal(partial.state, "open");
  assert.equal(partial.deadline, now + defaultPlanningTimeoutMs);
  assert.equal(partial.targets[1]?.state, "requested");
  assert.equal(expirePlanningAttempt(partial, partial.deadline - 1), partial);
  const expired = expirePlanningAttempt(partial, partial.deadline);
  assert.equal(expired.state, "expired");
  assert.equal(expired.draft?.state, "closed");
  assert.equal(expired.targets[0]?.state, "closed");
  assert.equal(expired.targets[0]?.release, undefined);
  assert.equal(expired.targets[1]?.state, "release_pending");
});

it("the watchdog releases a possibly received hold using its stable identity", () => {
  const initial = sent();
  const original: PlanningAttempt = {...initial, targets: initial.targets.map((target, index) => index === 0
    ? {...target, hold: {...target.hold, state: "uncertain"}} : target)};
  const expired = expirePlanningAttempt(original, original.deadline);
  assert.ok(expired.targets.every(target => target.state === "release_pending"));
  assert.equal(planningHasUnresolvedEffects(expired), true);
  assert.equal(expirePlanningAttempt(expired, expired.deadline + 60_000), expired);
  assert.equal(expired.targets[0]?.release?.messageId, planningDelivery("pause-a", "main-a", "release").messageId);
  assert.equal(planningReleaseText(expired, expired.targets[0]!),
    "Planning pause pause-a released (deadline passed). Continue your authorised task; human Stops and limits still apply.");
});

it("a definitely unsent hold closes without manufacturing a release delivery", () => {
  const initial = attempt();
  const original: PlanningAttempt = {...initial, targets: initial.targets.map((target, index) => index === 0
    ? {...target, hold: {...target.hold, state: "not_sent"}} : target)};
  const expired = expirePlanningAttempt(original, original.deadline);
  assert.ok(expired.targets.every(target => target.state === "closed" && target.release === undefined));
  assert.equal(planningHasUnresolvedEffects(expired), false);
});

it("late ACKs and prior-attempt ACKs cannot reopen or resolve an expired pause", () => {
  const original = sent();
  const ack = {attemptId: original.id, targetThreadId: "main-a"};
  assert.equal(acknowledgePlanningTarget(original, {...ack, attemptId: "earlier-pause"}, evidence("main-a"), now + 1), original);
  assert.equal(acknowledgePlanningTarget(original, ack, evidence("main-a"), original.deadline), original);
  const expired = expirePlanningAttempt(original, original.deadline);
  assert.equal(acknowledgePlanningTarget(expired, ack, evidence("main-a"), expired.deadline + 1), expired);
  assert.equal(planningCanAdopt(expired, expired.deadline + 1), false);
  assert.equal(resolvePlanningAttempt(expired, "continue", expired.deadline + 1), expired);
});

it("a no-plan decision explicitly releases every existing unresolved hold", () => {
  const original = sent();
  const released = resolvePlanningAttempt(original, "no_plan", now + 100);
  assert.equal(released.state, "releasing");
  assert.equal(released.resolution, "no_plan");
  assert.ok(released.targets.every(target => target.state === "release_pending"));
  assert.equal(planningReleaseText(released, released.targets[0]!),
    "Planning pause pause-a released (no plan needed). Continue your authorised task; human Stops and limits still apply.");
  assert.equal(planningReleaseText(released, released.targets[1]!),
    "Relay to child child-a: planning pause pause-a released (no plan needed). Continue your authorised task; human Stops and limits still apply.");
  assert.equal(expirePlanningAttempt(released, released.deadline).state, "expired", "requesting release does not end deadline recovery");
});

it("the parent's relay text never asks it to publish a child's ACK", () => {
  const original = attempt();
  const relay = planningHoldText(original, original.targets[1]!);
  assert.equal(relay, "Planning pause pause-a until 2026-10-27T12:05:00.000Z. Scope: child implementation\n" +
    "Hold dispatch for child child-a and ask it to pause work in this scope; your ACK covers your dispatch only. Human Stops, pauses, limits and approvals still win.");
  assert.doesNotMatch(relay, /planning-pause-ack/);
  const direct = planningHoldText(original, original.targets[0]!);
  assert.equal(direct, "Planning pause pause-a until 2026-10-27T12:05:00.000Z. Scope: main implementation\n" +
    "Hold side-effecting work and new or re-tasked children in this scope; reads may continue. When paused, reply with exactly:\n" +
    "```planning-pause-ack\n{\"attemptId\":\"pause-a\",\"targetThreadId\":\"main-a\"}\n```\n" +
    "Human Stops, pauses, limits and approvals still win.");
});

it("the hold's ACK record, reproduced in the actor's reply, is exactly what the service matches", () => {
  const original = attempt();
  const direct = planningHoldText(original, original.targets[0]!);
  const block = direct.slice(direct.indexOf("```planning-pause-ack"), direct.lastIndexOf("```") + 3);
  const matched = exactFenceRecords(`Paused the edits.\n${block}`, "planning-pause-ack", 2, true).map(record =>
    Schema.decodeUnknownExit(PlanningAcknowledgement)(record.value, {onExcessProperty: "error"}));
  assert.equal(matched.length, 1);
  assert.ok(Exit.isSuccess(matched[0]!));
  assert.deepEqual(matched[0]!.value, {attemptId: "pause-a", targetThreadId: "main-a"});
  // a quoted or indented copy is no record
  assert.deepEqual(exactFenceRecords(`> ${block.replaceAll("\n", "\n> ")}`, "planning-pause-ack", 2, true), []);
});

it("a continued child's release points to its own scoped plan, through its parent when relayed", () => {
  const original = sent();
  const continued = resolvePlanningAttempt({...original, targets: original.targets.map(target => target.threadId === "child-a"
    ? {...target, state: "acknowledged" as const, scopedWorkflowId: "workflow-child"} : {...target, state: "acknowledged" as const})}, "continue", now + 100);
  assert.equal(planningReleaseText(continued, continued.targets[0]!),
    "Planning pause pause-a released (planning resolved). Continue your authorised task; human Stops and limits still apply.");
  assert.equal(planningReleaseText(continued, continued.targets[1]!),
    "Relay to child child-a: planning pause pause-a released (planning resolved). Continue your authorised task; human Stops and limits still apply. " +
    "Read your scoped plan with supervision_plan {\"callerThreadId\":\"child-a\",\"taskId\":\"task-a\",\"proposalId\":\"workflow-child\"}; a parent relays it if the child cannot call it.");
  assert.equal(planningReleaseText({...continued, resolution: "superseded"}, continued.targets[0]!),
    "Planning pause pause-a released (superseded). Continue your authorised task; human Stops and limits still apply.");
});

// the main's current proposal, as the planning controller reads it at release time
const proposalTask = (agreed: boolean, withProposal = true) => ({id: "task-a", workflowProposalId: "proposal-a",
  workflow: withProposal ? {status: "proposed"} as never : null,
  agreement: agreed ? {status: "agreed" as const, proposalId: "proposal-a"} as never : null});

it("planning resolved or superseded with an unagreed main proposal grants no implementation permission and names the one acceptance route", () => {
  const original = sent();
  const continued = resolvePlanningAttempt({...original, targets: original.targets.map(target => ({...target, state: "acknowledged" as const}))}, "continue", now + 100);
  const main = continued.targets[0]!;
  // the pending read: only the main, only continue or superseded, only while the current proposal is not the recorded agreement
  assert.deepEqual(unacceptedProposal(continued, main, proposalTask(false)), {taskId: "task-a", proposalId: "proposal-a"});
  assert.deepEqual(unacceptedProposal(continued, main, proposalTask(false, false)), {taskId: "task-a", proposalId: null}, "no proposal to read yet");
  assert.deepEqual(unacceptedProposal(continued, main, null), {taskId: "task-a", proposalId: null}, "a task that is gone leaves nothing agreed");
  assert.equal(unacceptedProposal(continued, main, proposalTask(true)), null, "the agreed current proposal continues");
  assert.equal(unacceptedProposal(continued, continued.targets[1]!, proposalTask(false)), null, "a child target has no own acceptance");
  assert.equal(unacceptedProposal({...continued, resolution: "superseded"}, main, proposalTask(false))?.proposalId, "proposal-a");
  assert.equal(unacceptedProposal({...continued, resolution: "timeout"}, main, proposalTask(false)), null, "a genuine timeout release continues the task");
  assert.equal(unacceptedProposal({...continued, resolution: "no_plan"}, main, proposalTask(false)), null, "a no-plan release continues the task");
  assert.equal(planningReleaseText(continued, main, {taskId: "task-a", proposalId: "proposal-a"}),
    "Planning pause pause-a released (planning resolved). This release grants no implementation permission: workflow proposal proposal-a is not agreed; " +
    "read it with supervision_plan {\"callerThreadId\":\"main-a\",\"taskId\":\"task-a\",\"proposalId\":\"proposal-a\"} and, if you agree, put its exact acceptance " +
    "record in your own completed reply; a record sent to your Supervisor or relayed by another chat records nothing. Evidence gathering may continue; human Stops and limits still apply.");
  assert.equal(planningReleaseText({...continued, resolution: "superseded"}, main, {taskId: "task-a", proposalId: null}),
    "Planning pause pause-a released (superseded). This release grants no implementation permission: no workflow proposal is agreed yet; agree the one your Supervisor " +
    "sends before implementing; a record sent to your Supervisor or relayed by another chat records nothing. Evidence gathering may continue; human Stops and limits still apply.");
  assert.doesNotMatch(planningReleaseText(continued, main, {taskId: "task-a", proposalId: "proposal-a"}), /Continue your authorised task/u);
});

it("the drafter's task names its read route and pins, never the plan, rules or definitions", () => {
  const original = attempt();
  const instruction = planningDraftInstruction(original);
  assert.equal(instruction, "Read-only drafter for planning pause pause-a until 2026-10-27T12:05:00.000Z. Scope: Reconcile the implementation plan\n" +
    "Draft a workflow plan. Read with supervision_planning {\"supervisorThreadId\":\"owner-a\",\"bindingGeneration\":1,\"taskId\":\"task-a\",\"taskRevision\":\"source-a\",\"action\":\"draft_read\",\"attemptId\":\"pause-a\",\"view\":\"context\"}, " +
    "adding section conversation for the intent and section plan for the current plan; other views: definitions (index; definitionIds for complete ones) and plan_rules (plan grammar). " +
    `Messages context names are in its mainThreadId. ${messageReadRule} ` +
    "Answer with the plan and a brief rationale. Only read and draft: no edits, commands, contact, delegation or other Supervisor calls; your draft grants no authority and never extends the pause.");
  assert.ok(instruction.includes(JSON.stringify(planningDraftRead(original, "context"))));
  for (const copied of [interpretationPlanRules.slice(0, 60), planningInstructions.slice(0, 60), "PLANNING PAUSE", "workflow_read", "mcpx"])
    assert.ok(!instruction.includes(copied), copied);
});

it("an answer carries the attempt's states and ACK messages, and its drafter's task only when asked for an open attempt without one", () => {
  const original = sent();
  const acknowledged = acknowledgePlanningTarget(original, {attemptId: original.id, targetThreadId: "main-a"}, evidence("main-a"), now + 1);
  assert.deepEqual(planningAttemptAnswer(acknowledged), {attemptId: "pause-a", state: "open", deadline: "2026-10-27T12:05:00.000Z", resolution: null,
    targets: [{threadId: "main-a", state: "acknowledged", ack: "ack-main-a"}, {threadId: "child-a", state: "requested", ack: null}], uncovered: [], draft: null});
  assert.equal(planningAttemptAnswer(acknowledged, true).draftInstruction, planningDraftInstruction(acknowledged));
  const drafting: PlanningAttempt = {...acknowledged, draft: {threadId: "writer-a", taskId: "draft-a", state: "working", resultMessageId: null, resultRunId: null}};
  assert.deepEqual(planningAttemptAnswer(drafting, true).draft, {state: "working", taskId: "draft-a"});
  assert.equal(planningAttemptAnswer(drafting, true).draftInstruction, undefined);
  const released = resolvePlanningAttempt(acknowledged, "no_plan", now + 2);
  assert.equal(planningAttemptAnswer(released, true).draftInstruction, undefined);
  const rendered = JSON.stringify(planningAttemptAnswer(released, true));
  for (const stored of released.targets.flatMap(target => [target.hold, target.release!]).flatMap(delivery => [delivery.messageId, delivery.commandId]))
    assert.ok(!rendered.includes(stored), stored);
  assert.ok(!rendered.includes(planningHoldText(released, released.targets[0]!)));
});

it("the owner's draft notice names the result's exact read and keeps adoption the owner's checked decision", () => {
  const original = attempt();
  // the published turn item is the read; the message ID stays provenance and is never offered as an itemId
  const published = planningDraftNotice(original, {threadId: "writer-a", messageId: "draft-content", readItemId: "turn-item:message:draft-content"});
  assert.equal(published,
    "Planning draft for pause pause-a is ready: read it with t3_thread_read {\"threadId\":\"writer-a\",\"itemId\":\"turn-item:message:draft-content\"} (message draft-content). Check ACKs with supervision_planning read and re-read current operative work before adopting it; publish nothing automatically and start no new wait.");
  assert.doesNotMatch(published, /"itemId":"draft-content"/u);
  // before T3 publishes the item, the message is matched while paging, never read as an item
  const unpublished = planningDraftNotice(original, {threadId: "writer-a", messageId: "draft-content", readItemId: null});
  assert.match(unpublished, /ready as message draft-content of thread writer-a, not yet published as a read item: page that thread's view messages and match the messageId\./u);
  assert.doesNotMatch(unpublished, /itemId/u);
  assert.equal(planningDraftNotice(original, null),
    "Planning draft for pause pause-a is unavailable. Check ACKs with supervision_planning read; publish nothing automatically and start no new wait.");
});


it("the timeout anchors at the first delivery attempt and cannot be extended by a later one", () => {
  const original = attempt();
  const begun = startPlanningAttempt(original, now + 10_000);
  assert.equal(begun.startedAt, now + 10_000);
  assert.equal(begun.deadline, now + 10_000 + defaultPlanningTimeoutMs);
  assert.equal(startPlanningAttempt(begun, now + 30_000), begun);
});
