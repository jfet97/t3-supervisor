import { taskScopeRevision } from "./supervision-conversation-contract.js";
import type { ConversationFacts } from "./supervision-conversation-contract.js";
import { Schema } from "effect";
import type { WorkflowStateDocument } from "./workflow-state-contract.js";
import { effectiveBranchSelections, pendingBranchDecisions } from "./workflow-plan-tree.js";

export const WorkflowAssessment = Schema.Struct({
  taskId: Schema.String, sourceHash: Schema.String, status: Schema.String,
  summary: Schema.String, updatedAt: Schema.Number,
  /** Why a recorded completion no longer stands as current: a reached branch decision is pending or changed after the assessment. */
  reassessment: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
export type WorkflowAssessmentInfo = typeof WorkflowAssessment.Type;
type CurrentTask = {id?: string; sourceHash?: string; status: string; conversation?: ConversationFacts};

/** Projects the main assessment reason without mistaking later step or contribution notes for it. */
export function workflowAssessment(document: WorkflowStateDocument): WorkflowAssessmentInfo | null {
  if (!document.sourceBinding) return null;
  const evidence = [...document.evidence].reverse().find(item => item.kind === "status_changed" &&
    item.targetNodeId === null && item.statusTo === document.status);
  return {taskId: document.sourceBinding.taskId, sourceHash: document.sourceBinding.sourceHash,
    status: document.status, summary: evidence?.note.slice(0, 800) || "No explanation was recorded for this workflow assessment.",
    updatedAt: document.updatedAt, reassessment: completionReassessment(document, evidence?.recordedAt ?? null)};
}

// a completion assessment keeps its status and evidence, but it is not current while a reached decision is pending or after a branch
// decision changed or was invalidated
const completionReassessment = (document: WorkflowStateDocument, assessedAt: number | null): string | null => {
  if (document.status !== "completed") return null;
  const pending = pendingBranchDecisions(document.plan, effectiveBranchSelections(document.plan, document.branchSelections ?? [])).length;
  if (pending) return `${pending === 1 ? "A branch decision is" : `${pending} branch decisions are`} pending, so this completion needs reassessment.`;
  const changed = document.evidence.some(item => (item.kind === "branch_selection_invalidated" || item.kind === "branch_selected" && item.branch?.changed === true) &&
    (assessedAt === null || item.recordedAt > assessedAt));
  return changed ? "A branch decision changed after this completion was assessed, so it needs reassessment." : null;
};

export function assessmentForTask(assessment: WorkflowAssessmentInfo | null | undefined, task: CurrentTask | undefined) {
  return assessment && task?.id && task.sourceHash && !["expired", "not_supervised"].includes(task.status) &&
    assessment.taskId === task.id && assessment.sourceHash === taskScopeRevision(task) ? assessment : null;
}
