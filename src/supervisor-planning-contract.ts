import { Schema } from "effect";

export const defaultPlanningTimeoutMs = 5 * 60_000;
export const planningTimeoutBounds = {min: 10_000, max: 60 * 60_000} as const;
export const planningInstructions = "Use supervision_planning pause with current task/binding pins, operationId, reason and affected targetThreadIds. " +
  "Require each actor's ACK or verified quiescence; parent ACK holds dispatch only. Root/helpers may use local orchestrator_capabilities/delegate_task for one read-only writer created for this attempt; attach_draft uses its childThreadId/taskId as draftThreadId/draftTaskId. Follow draftInstruction and model/isolation rules. Writers cannot guide, edit, publish, monitor or delegate. " +
  "Reconcile ACKs, results and fresh work before adoption. For pending back_to, apply_return takes workflowId, workflowThreadId, expectedRevision, returnId, reason and open attemptId; it verifies pauses and retires old child runs. Main acceptance and child scoped plans remain. " +
  "Release with continue/no_plan. The fixed deadline covers ACK, drafting and negotiation; late results never re-pause. Preserve human Stops, limits and approvals.";
const Id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024));
const Time = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));
const Text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4000));

export const PlanningDelivery = Schema.Struct({
  messageId: Id,
  commandId: Id,
  state: Schema.Literals(["prepared", "sending", "sent", "uncertain", "not_sent"]),
  attemptedAt: Schema.NullOr(Time),
  runId: Schema.NullOr(Id),
  text: Schema.optional(Schema.String.check(Schema.isMaxLength(12000))),
});
export type PlanningDelivery = typeof PlanningDelivery.Type;

export const PlanningAcknowledgement = Schema.Struct({attemptId: Id, targetThreadId: Id});
export type PlanningAcknowledgement = typeof PlanningAcknowledgement.Type;

export const PlanningTarget = Schema.Struct({
  threadId: Id,
  recipientThreadId: Id,
  assignmentRootThreadId: Schema.optional(Schema.NullOr(Id)),
  assignmentEpoch: Schema.optional(Schema.NullOr(Schema.Number)),
  scope: Text,
  scopedWorkflowId: Schema.optional(Id),
  state: Schema.Literals(["requested", "acknowledged", "quiescent", "release_pending", "closed", "released"]),
  hold: PlanningDelivery,
  release: Schema.optional(PlanningDelivery),
  acknowledgement: Schema.optional(Schema.Struct({sourceThreadId: Id, messageId: Id, runId: Id, observedAt: Time})),
  quiescence: Schema.optional(Schema.Struct({runId: Id, observedAt: Time})),
  closedAt: Schema.optional(Time),
});
export type PlanningTarget = typeof PlanningTarget.Type;

export const PlanningDraft = Schema.Struct({
  threadId: Id,
  taskId: Schema.NullOr(Id),
  state: Schema.Literals(["working", "returned", "failed", "closed"]),
  cleanupConfirmedAt: Schema.optional(Time),
  cleanup: Schema.optional(Schema.Array(Schema.Struct({
    type: Schema.Literals(["thread.stop", "queued-run.cancel", "delegated_task.completion-delivery.dispose"]),
    runId: Schema.NullOr(Id), receipt: PlanningDelivery,
  }))),
  resultMessageId: Schema.NullOr(Id),
  resultRunId: Schema.NullOr(Id),
  ownerNotice: Schema.optional(PlanningDelivery),
  ownerNoticeText: Schema.optional(Schema.String.check(Schema.isMaxLength(4000))),
});
export type PlanningDraft = typeof PlanningDraft.Type;

export const PlanningAttempt = Schema.Struct({
  id: Id,
  operationId: Id,
  requestHash: Schema.optional(Id),
  projectId: Id,
  mainThreadId: Id,
  ownerThreadId: Id,
  bindingGeneration: Schema.Finite,
  memberEpoch: Schema.optional(Schema.Finite),
  taskId: Id,
  taskRevision: Id,
  requestSource: Schema.optional(Schema.Struct({messageId: Id, hash: Id})),
  baselineAgreementId: Schema.optional(Schema.NullOr(Id)),
  reason: Text,
  createdAt: Time,
  startedAt: Schema.NullOr(Time),
  deadline: Time,
  state: Schema.Literals(["open", "releasing", "resolved", "expired", "superseded"]),
  resolution: Schema.NullOr(Schema.Literals(["continue", "no_plan", "timeout", "superseded"])),
  closedAt: Schema.NullOr(Time),
  targets: Schema.mutable(Schema.Array(PlanningTarget).check(Schema.isMinLength(1), Schema.isMaxLength(100))),
  draft: Schema.optional(PlanningDraft),
});
export type PlanningAttempt = typeof PlanningAttempt.Type;

export type NewPlanningAttempt = Omit<PlanningAttempt, "state" | "resolution" | "closedAt" | "deadline" | "targets" | "draft" | "startedAt"> & {
  timeoutMs: number;
  targets: Array<{threadId: string; recipientThreadId: string; scope: string; assignmentRootThreadId?: string | null; assignmentEpoch?: number | null}>;
};

