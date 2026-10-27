import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import {
  acknowledgePlanningTarget, closePlanningTarget, createPlanningAttempt, defaultPlanningTimeoutMs,
  expirePlanningAttempt, planningCanAdopt, planningHasUnresolvedEffects, planningHoldText, planningReleaseText,
  planningDelivery, resolvePlanningAttempt, startPlanningAttempt, type PlanningAttempt,
} from "../src/supervisor-planning.js";

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
  assert.match(planningReleaseText(expired, expired.targets[0]!), /Continue with your authorised task/);
  assert.match(planningReleaseText(expired, expired.targets[0]!), /no remaining wait/);
  assert.match(planningReleaseText(expired, expired.targets[0]!), /Human Stops, pauses, limits and approvals still apply/);
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
  assert.match(planningReleaseText(released, released.targets[0]!), /shared plan is not needed/);
  assert.equal(expirePlanningAttempt(released, released.deadline).state, "expired", "requesting release does not end deadline recovery");
});

it("the parent's relay text never asks it to publish a child's ACK", () => {
  const original = attempt();
  const relay = planningHoldText(original, original.targets[1]!);
  assert.match(relay, /Do not publish an ACK for child-a yourself/);
  assert.doesNotMatch(relay, /```planning-pause-ack/);
  const direct = planningHoldText(original, original.targets[0]!);
  assert.match(direct, /```planning-pause-ack/);
  assert.match(direct, /2026-10-27T12:05:00.000Z/);
});


it("the timeout anchors at the first delivery attempt and cannot be extended by a later one", () => {
  const original = attempt();
  const begun = startPlanningAttempt(original, now + 10_000);
  assert.equal(begun.startedAt, now + 10_000);
  assert.equal(begun.deadline, now + 10_000 + defaultPlanningTimeoutMs);
  assert.equal(startPlanningAttempt(begun, now + 30_000), begun);
});
