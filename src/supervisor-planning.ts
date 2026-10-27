import { createHash } from "node:crypto";
import { planningTimeoutBounds } from "./supervisor-planning-contract.js";
import type { NewPlanningAttempt, PlanningAttempt, PlanningAcknowledgement, PlanningDelivery, PlanningTarget } from "./supervisor-planning-contract.js";
export * from "./supervisor-planning-contract.js";

/** Delivery identities are allocated before any send and never depend on retry time. */
export const planningDelivery = (attemptId: string, targetThreadId: string, kind: "hold" | "release" | "draft"): PlanningDelivery => ({
  messageId: `supervisor-planning:${attemptId}:${kind}:${createHash("sha256").update(targetThreadId).digest("hex")}`,
  commandId: `supervisor-planning-command:${attemptId}:${kind}:${createHash("sha256").update(targetThreadId).digest("hex")}`,
  state: "prepared",
  attemptedAt: null,
  runId: null,
});

/** The attempt freezes its deadline; later setting changes and progress cannot renew it. */
export const createPlanningAttempt = (input: NewPlanningAttempt): PlanningAttempt => {
  const {timeoutMs, targets, ...identity} = input;
  return {
    ...identity,
    deadline: input.createdAt + Math.min(planningTimeoutBounds.max, Math.max(planningTimeoutBounds.min, timeoutMs)),
    startedAt: null, state: "open", resolution: null, closedAt: null,
    targets: targets.map(target => ({...target, state: "requested", hold: planningDelivery(input.id, target.threadId, "hold")})),
  };
};

/** The first native delivery attempt anchors the one deadline; replies and progress never renew it. */
export const startPlanningAttempt = (attempt: PlanningAttempt, now: number): PlanningAttempt =>
  attempt.state !== "open" || attempt.startedAt !== null ? attempt : {...attempt, startedAt: now,
    deadline: now + (attempt.deadline - attempt.createdAt)};

export const planningWaitOpen = (target: PlanningTarget): boolean =>
  target.state === "requested" || target.state === "acknowledged" || target.state === "quiescent";

export const planningCanAdopt = (attempt: PlanningAttempt, now: number): boolean => attempt.state === "open" && now < attempt.deadline &&
  attempt.targets.every(target => target.state === "acknowledged" || target.state === "quiescent" || target.state === "closed");

/** A parent can acknowledge its own dispatch hold, never an active child's pause. */
export const acknowledgePlanningTarget = (attempt: PlanningAttempt, acknowledgement: PlanningAcknowledgement,
  evidence: NonNullable<PlanningTarget["acknowledgement"]>, now: number): PlanningAttempt => {
  if (attempt.state !== "open" || now >= attempt.deadline || acknowledgement.attemptId !== attempt.id ||
    evidence.sourceThreadId !== acknowledgement.targetThreadId) return attempt;
  const target = attempt.targets.find(target => target.threadId === acknowledgement.targetThreadId);
  if (!target || target.state !== "requested" || target.hold.state === "prepared" || target.hold.state === "not_sent") return attempt;
  return {...attempt, targets: attempt.targets.map(item => item === target ? {...item, state: "acknowledged", acknowledgement: evidence} : item)};
};

/** The caller has verified terminal native work and that its parent's dispatch is held. */
export const markPlanningTargetQuiescent = (attempt: PlanningAttempt, threadId: string,
  evidence: NonNullable<PlanningTarget["quiescence"]>, now: number): PlanningAttempt => {
  if (attempt.state !== "open" || now >= attempt.deadline) return attempt;
  const target = attempt.targets.find(target => target.threadId === threadId);
  if (!target || target.state !== "requested") return attempt;
  return {...attempt, targets: attempt.targets.map(item => item === target ? {...item, state: "quiescent", quiescence: evidence} : item)};
};

/** An accepted result for one target does not resolve other actors' waits. */
export const closePlanningTarget = (attempt: PlanningAttempt, threadId: string, now: number): PlanningAttempt => {
  if (attempt.state !== "open" || now >= attempt.deadline) return attempt;
  const targets = attempt.targets.map(target => target.threadId === threadId && planningWaitOpen(target)
    ? {...target, state: "closed" as const, closedAt: now} : target);
  return targets.every(target => !planningWaitOpen(target))
    ? {...attempt, targets, state: "resolved", resolution: "continue", closedAt: now}
    : {...attempt, targets};
};

/** Unknown delivery is possibly received and needs release; definitely unsent holds do not. */
export const resolvePlanningAttempt = (attempt: PlanningAttempt, reason: NonNullable<PlanningAttempt["resolution"]>, now: number): PlanningAttempt => {
  if (attempt.state !== "open" && !(attempt.state === "releasing" && (reason === "timeout" || reason === "superseded"))) return attempt;
  const targets = attempt.targets.map(target => {
    if (!planningWaitOpen(target)) return target;
    const possibleDelivery = target.hold.state !== "prepared" && target.hold.state !== "not_sent";
    return {...target, state: possibleDelivery ? "release_pending" as const : "closed" as const,
      ...(possibleDelivery ? {release: planningDelivery(attempt.id, target.threadId, "release")} : {closedAt: now})};
  });
  const pendingRelease = targets.some(target => target.state === "release_pending");
  return {...attempt, targets, state: reason === "timeout" ? "expired" : reason === "superseded" ? "superseded" : pendingRelease ? "releasing" : "resolved",
    resolution: reason, closedAt: reason !== "timeout" && reason !== "superseded" && pendingRelease ? null : now,
    ...(attempt.draft ? {draft: {...attempt.draft, state: "closed" as const}} : {})};
};

export const expirePlanningAttempt = (attempt: PlanningAttempt, now: number): PlanningAttempt =>
  now >= attempt.deadline ? resolvePlanningAttempt(attempt, "timeout", now) : attempt;

export const planningHasUnresolvedEffects = (attempt: PlanningAttempt): boolean => attempt.state === "open" || attempt.state === "releasing" ||
  attempt.targets.some(target => target.state === "release_pending" || target.hold.state === "sending" || target.hold.state === "uncertain" ||
    target.release?.state === "sending" || target.release?.state === "uncertain") ||
  attempt.draft?.ownerNotice?.state === "sending" || attempt.draft?.ownerNotice?.state === "uncertain" ||
  Boolean(attempt.draft?.taskId && attempt.draft.state === "closed" && attempt.draft.cleanupConfirmedAt === undefined);

export const planningHoldText = (attempt: PlanningAttempt, target: PlanningTarget): string => {
  const recipient = target.threadId === target.recipientThreadId
    ? "Hold side-effecting work and new or re-tasked children in this scope. Read-only observation may continue."
    : `Hold new or re-tasked work for child ${target.threadId} and ask it to pause conflicting work when possible. Your ACK covers your own dispatch only, not the child's active work.`;
  const acknowledgement = target.threadId === target.recipientThreadId
    ? `When your own work is paused, publish this exact record in your own completed reply:\n\`\`\`planning-pause-ack\n${JSON.stringify({attemptId: attempt.id, targetThreadId: target.threadId})}\n\`\`\``
    : `Confirmation must come from the child's own reply or verified terminal work. Do not publish an ACK for ${target.threadId} yourself. A separate pause addressed to you has its own ACK.`;
  return `The Supervisor is preparing a plan: ${attempt.reason}\nPlanning pause ${attempt.id}; scope: ${target.scope}. Deadline: ${new Date(attempt.deadline).toISOString()}.\n${recipient}\n${acknowledgement}\nThe service will send a plan or release. This planning wait expires at the printed deadline; it never overrides a human Stop, pause, limit or approval.`;
};

export const planningReleaseText = (attempt: PlanningAttempt, target: PlanningTarget): string =>
  `Planning pause ${attempt.id} is released for ${target.scope}${attempt.resolution === "timeout" ? ": its deadline expired before all required planning outcomes were confirmed" :
    attempt.resolution === "no_plan" ? ": a shared plan is not needed" : attempt.resolution === "superseded" ? ": newer instructions superseded it" : ": planning is resolved"}. Continue with your authorised task. There is no remaining wait for this planning attempt. Human Stops, pauses, limits and approvals still apply.`;

export const planningDraftInstruction = (attempt: PlanningAttempt): string =>
  `Prepare read-only draft content for planning attempt ${attempt.id}, owned by ${attempt.ownerThreadId}. Deadline: ${new Date(attempt.deadline).toISOString()}. Scope: ${attempt.reason}. Return the proposed workflow and concise rationale to your parent. Do not implement work, publish a plan, instruct an operative, change state, monitor ongoing work or delegate. The owner is obtaining pause acknowledgements and will reconcile your draft with later activity before adopting it. Your result grants no authority and cannot renew or reopen this attempt.`;
