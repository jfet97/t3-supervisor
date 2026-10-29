import { createHash } from "node:crypto";
import { messageReadRule } from "./message-read-handle.js";
import type { TaskRecord } from "./project-supervisor-store.js";
import { planningTimeoutBounds } from "./supervisor-planning-contract.js";
import type { NewPlanningAttempt, PlanningAttempt, PlanningAcknowledgement, PlanningDelivery, PlanningDraftView, PlanningTarget } from "./supervisor-planning-contract.js";
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

/**
 * Whether reconciliation still observes a target: its ACK or quiescence is awaited (a quiet actor may still acknowledge, as an idle main
 * does once it takes up the hold), or a hold or release is not yet confirmed. An acknowledged actor with a delivered hold has nothing
 * left to observe; a decision that relies on it reads it afresh.
 */
export const planningTargetAwaited = (target: PlanningTarget): boolean => target.state === "requested" || target.state === "quiescent" ||
  target.state === "release_pending" || target.hold.state === "sending" || target.hold.state === "uncertain";

export const planningCanAdopt = (attempt: PlanningAttempt, now: number): boolean => attempt.state === "open" && now < attempt.deadline &&
  attempt.targets.every(target => target.state === "acknowledged" || target.state === "quiescent" || target.state === "closed");

/** A parent can acknowledge its own dispatch hold, never an active child's pause. */
export const acknowledgePlanningTarget = (attempt: PlanningAttempt, acknowledgement: PlanningAcknowledgement,
  evidence: NonNullable<PlanningTarget["acknowledgement"]>, now: number): PlanningAttempt => {
  if (attempt.state !== "open" || now >= attempt.deadline || acknowledgement.attemptId !== attempt.id ||
    evidence.sourceThreadId !== acknowledgement.targetThreadId) return attempt;
  const target = attempt.targets.find(target => target.threadId === acknowledgement.targetThreadId);
  if (!target || target.state !== "requested" && target.state !== "quiescent" || target.hold.state === "prepared" || target.hold.state === "not_sent") return attempt;
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

const deadlineText = (attempt: PlanningAttempt): string => new Date(attempt.deadline).toISOString();
// the one rule an operative is told with each hold or release, since it has no read of the planning rules
const humanPrecedence = "Human Stops, pauses, limits and approvals still win.";

/**
 * A hold is one event: the attempt, its deadline and scope and, for an actor, the exact ACK record the service matches in its own
 * completed reply. A parent relaying for a child holds its dispatch only and is given no record for the child.
 */
export const planningHoldText = (attempt: PlanningAttempt, target: PlanningTarget): string => {
  const pause = `Planning pause ${attempt.id} until ${deadlineText(attempt)}. Scope: ${target.scope}\n`;
  return target.threadId === target.recipientThreadId
    ? `${pause}Hold side-effecting work and new or re-tasked children in this scope; reads may continue. When paused, reply with exactly:\n\`\`\`planning-pause-ack\n${JSON.stringify({attemptId: attempt.id, targetThreadId: target.threadId})}\n\`\`\`\n${humanPrecedence}`
    : `${pause}Hold dispatch for child ${target.threadId} and ask it to pause work in this scope; your ACK covers your dispatch only. ${humanPrecedence}`;
};

const releaseNotes = {continue: "planning resolved", no_plan: "no plan needed", timeout: "deadline passed", superseded: "superseded"} as const;

/** The main's current proposal that a release leaves unagreed: the task and, when a proposal exists to read, its id. */
export type PlanningReleasePending = {taskId: string; proposalId: string | null};

/**
 * What a continue or superseded release of the main leaves unagreed: planning resolved or ended, but the main's current proposal is not
 * its recorded agreement, so the release grants no implementation permission. Null for a child target, for a genuine timeout or
 * no-plan release, and when the current proposal is agreed.
 */
export const unacceptedProposal = (attempt: Pick<PlanningAttempt, "mainThreadId" | "taskId" | "resolution">, target: Pick<PlanningTarget, "threadId">,
  task: Pick<TaskRecord, "id" | "workflowProposalId" | "agreement" | "workflow"> | null | undefined): PlanningReleasePending | null => {
  if (target.threadId !== attempt.mainThreadId || attempt.resolution !== "continue" && attempt.resolution !== "superseded") return null;
  if (!task) return {taskId: attempt.taskId, proposalId: null};
  const proposalId = task.workflowProposalId ?? task.id;
  if (task.agreement?.status === "agreed" && task.agreement.proposalId === proposalId) return null;
  return {taskId: task.id, proposalId: task.workflow ? proposalId : null};
};

/**
 * A release names the attempt and its resolution; a continued child is pointed to its own scoped plan, and a parent relays a child's.
 * A continue or superseded release whose main proposal is unagreed grants no implementation permission: it names the proposal and the
 * only acceptance route, the exact record in the operative's own completed reply; a timeout or no-plan release continues the task.
 */
export const planningReleaseText = (attempt: PlanningAttempt, target: PlanningTarget, pending: PlanningReleasePending | null = null): string => {
  const released = `${target.threadId !== target.recipientThreadId ? `Relay to child ${target.threadId}: planning` : "Planning"} pause ${attempt.id} released (${releaseNotes[attempt.resolution ?? "continue"]}).`;
  if (pending) {
    const route = pending.proposalId
      ? `workflow proposal ${pending.proposalId} is not agreed; read it with supervision_plan ${JSON.stringify({callerThreadId: target.threadId, taskId: pending.taskId, proposalId: pending.proposalId})} and, if you agree, put its exact acceptance record in your own completed reply`
      : "no workflow proposal is agreed yet; agree the one your Supervisor sends before implementing";
    return `${released} This release grants no implementation permission: ${route}; a record sent to your Supervisor or relayed by another chat records nothing. Evidence gathering may continue; human Stops and limits still apply.`;
  }
  return `${released} Continue your authorised task; human Stops and limits still apply.${target.scopedWorkflowId && attempt.resolution === "continue" ? ` Read your scoped plan with supervision_plan ${JSON.stringify({callerThreadId: target.threadId, taskId: attempt.taskId, proposalId: target.scopedWorkflowId})}; a parent relays it if the child cannot call it.` : ""}`;
};

/** The drafter's only read: its attempt's pins and one view, proven by the drafter's own executed call of exactly these arguments. */
export const planningDraftRead = (attempt: PlanningAttempt, view: PlanningDraftView) => ({supervisorThreadId: attempt.ownerThreadId,
  bindingGeneration: attempt.bindingGeneration, taskId: attempt.taskId, taskRevision: attempt.taskRevision, action: "draft_read" as const,
  attemptId: attempt.id, view});

/** The drafting child's task: the read route and coordinates, never a copy of the plan, the rules or the definitions. */
export const planningDraftInstruction = (attempt: PlanningAttempt): string =>
  `Read-only drafter for planning pause ${attempt.id} until ${deadlineText(attempt)}. Scope: ${attempt.reason}\nDraft a workflow plan. Read with supervision_planning ${JSON.stringify(planningDraftRead(attempt, "context"))}, adding section conversation for the intent and section plan for the current plan; other views: definitions (index; definitionIds for complete ones) and plan_rules (plan grammar). Messages context names are in its mainThreadId. ${messageReadRule} Answer with the plan and a brief rationale. Only read and draft: no edits, commands, contact, delegation or other Supervisor calls; your draft grants no authority and never extends the pause.`;

/**
 * What supervision_planning answers about an attempt: its states, deadline and each target's ACK message; delivery identities, texts
 * and hashes stay stored. The draft instruction comes only with a pause or an explicit read, while the open attempt has no drafter.
 */
export const planningAttemptAnswer = (attempt: PlanningAttempt, withDraftInstruction = false) => ({
  attemptId: attempt.id, state: attempt.state, deadline: deadlineText(attempt), resolution: attempt.resolution,
  targets: attempt.targets.map(target => ({threadId: target.threadId, state: target.state, ack: target.acknowledgement?.messageId ?? null})),
  draft: attempt.draft ? {state: attempt.draft.state, taskId: attempt.draft.taskId} : null,
  ...(withDraftInstruction && attempt.state === "open" && !attempt.draft ? {draftInstruction: planningDraftInstruction(attempt)} : {}),
});

/**
 * The owner's notice that its drafter ended: the exact read of the result's published turn item, or, before T3 publishes one, the
 * result's message ID as provenance to match while paging; adoption stays the owner's checked decision.
 */
export const planningDraftNotice = (attempt: PlanningAttempt, result: {threadId: string; messageId: string; readItemId: string | null} | null): string =>
  `Planning draft for pause ${attempt.id} is ${!result ? "unavailable" : result.readItemId
    ? `ready: read it with t3_thread_read ${JSON.stringify({threadId: result.threadId, itemId: result.readItemId})} (message ${result.messageId})`
    : `ready as message ${result.messageId} of thread ${result.threadId}, not yet published as a read item: page that thread's view messages and match the messageId`}. ` +
  `Check ACKs with supervision_planning read${result ? " and re-read current operative work before adopting it" : ""}; publish nothing automatically and start no new wait.`;
