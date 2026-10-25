import { Effect, Schema } from "effect";
import {
  WorkflowAgreement,
  WorkflowExecutionStatus as WorkflowExecutionStatusSchema,
  WorkflowIssue,
  WorkflowPlanGroupSchema,
  WorkflowRequirement,
  WorkflowSourceBinding,
  type WorkflowAgreementInfo,
  type WorkflowIssueInfo,
  type WorkflowPlanGroupInfo,
  type WorkflowPlanNodeInfo,
  type WorkflowRequirementInfo,
  type WorkflowSourceBindingInfo,
} from "./project-supervisor-contract.js";

export const workflowExecutionStatuses = ["planned", "underway", "completed", "needs_attention"] as const;
export type WorkflowExecutionStatus = typeof workflowExecutionStatuses[number];

export type WorkflowStatePlan = WorkflowPlanGroupInfo | null;
export type WorkflowStatePlanNode = WorkflowPlanNodeInfo;
export type WorkflowStateRequirement = WorkflowRequirementInfo;
export type WorkflowStateIssue = WorkflowIssueInfo;

export type WorkflowStateSourceBinding = WorkflowSourceBindingInfo;

export const externalContributionStates = ["awaiting_result", "result", "withdrawn"] as const;
export type ExternalContributionState = typeof externalContributionStates[number];
export const externalContributionDecisions = ["accepted", "needs_more"] as const;
export type ExternalContributionDecision = typeof externalContributionDecisions[number];
export const externalContributionReferenceKinds = ["file", "url", "source", "text"] as const;
export type ExternalContributionReference = {kind: typeof externalContributionReferenceKinds[number]; value: string};

export const externalContributionLimits = {
  maxContributions: 32,
  maxRecordsPerMessage: 8,
  maxContributionIdLength: 64,
  maxNodeIdLength: 64,
  maxTaskIdLength: 200,
  maxRevision: 1_000_000,
  maxSummaryLength: 2000,
  maxReferences: 8,
  maxReferenceValueLength: 500,
  maxExternalRefLength: 200,
  maxAssessmentNoteLength: 2000,
} as const;

// fixed codes for the single task protocol diagnostic slot; a rejected record changes nothing
export const externalContributionDiagnosticCodes = [
  "contribution_json_invalid",
  "contribution_record_invalid",
  "contribution_message_limit",
  "contribution_duplicate_in_message",
  "contribution_node_unknown",
  "contribution_revision_conflict",
  "contribution_revision_gap",
  "contribution_revision_stale",
  "contribution_withdrawn",
  "contribution_capacity",
] as const;
export type ExternalContributionDiagnosticCode = typeof externalContributionDiagnosticCodes[number];

/** The Supervisor's current judgement of one result revision; it never changes a step status. */
export type ExternalContributionAssessment = {
  decision: ExternalContributionDecision;
  resultRevision: number;
  note: string;
  actorSupervisorThreadId: string;
  evidenceId: string;
  recordedAt: number;
};

/** A main-reported contribution whose execution happened outside observed T3 activity. Its text is untrusted. */
export type ExternalContribution = {
  contributionId: string;
  nodeId: string;
  state: ExternalContributionState;
  revision: number;
  summary: string;
  references: ExternalContributionReference[];
  externalRef: string | null;
  sourceThreadId: string;
  sourceRunId: string;
  sourceMessageId: string;
  recordedAt: number;
  assessment: ExternalContributionAssessment | null;
};

/** The exact fields of one main-authored external-contribution chat record. */
export type ExternalContributionRecord = {
  taskId: string;
  contributionId: string;
  nodeId: string;
  revision: number;
  state: ExternalContributionState;
  summary: string;
  references: ExternalContributionReference[];
  externalRef: string | null;
};

export type ExternalContributionImport = Omit<ExternalContributionRecord, "taskId"> & {
  sourceThreadId: string;
  sourceRunId: string;
  sourceMessageId: string;
};

export type ExternalContributionImportResult =
  | WorkflowMutationReceipt
  | {status: "unchanged"; workflowId: string; revision: number}
  | {status: "rejected"; code: ExternalContributionDiagnosticCode}
  | {status: "conflict"; reason: "revision"; currentRevision: number | null}
  | {status: "owner_mismatch" | "not_found"}
  | {status: "incompatible"; workflowId: string; formatVersion: number | null};

export type WorkflowContributionAssessmentInput = {
  operationId: string;
  workflowId: string;
  expectedRevision: number;
  contributionId: string;
  resultRevision: number;
  decision: ExternalContributionDecision;
  note: string;
};

export const branchSelectionPaths = ["then", "else"] as const;
export type BranchSelectionPath = typeof branchSelectionPaths[number];

export const branchSelectionLimits = {
  maxSelections: 64,
  maxRecordsPerMessage: 8,
  maxTaskIdLength: 200,
  maxNodeIdLength: 64,
  maxRevision: 1_000_000,
  maxReasonLength: 500,
} as const;

// fixed codes for the task protocol diagnostic slot; a rejected selection record changes nothing
export const branchSelectionDiagnosticCodes = [
  "branch_json_invalid",
  "branch_record_invalid",
  "branch_message_limit",
  "branch_duplicate_in_message",
  "branch_node_unknown",
  "branch_revision_conflict",
  "branch_revision_gap",
  "branch_revision_stale",
  "branch_record_outdated",
  "branch_capacity",
] as const;
export type BranchSelectionDiagnosticCode = typeof branchSelectionDiagnosticCodes[number];

/** The exact fields of one operative-authored branch-selection chat record. */
export type BranchSelectionRecord = {
  taskId: string;
  nodeId: string;
  revision: number;
  path: BranchSelectionPath;
  reason: string;
};

/**
 * The operative's latest selection for one branch occurrence of this workflow, recorded from its own native message. It answers the
 * branch identity it was made for: a later change of condition, else path or enclosing position invalidates it for good, and only a
 * next revision selects again. It never changes a status or the plan.
 */
export type BranchSelection = {
  nodeId: string;
  revision: number;
  path: BranchSelectionPath;
  reason: string;
  condition: string;
  branchKey: string;
  state: "current" | "invalidated";
  invalidatedAt: number | null;
  sourceThreadId: string;
  sourceRunId: string;
  sourceMessageId: string;
  recordedAt: number;
};

export type BranchSelectionImport = Omit<BranchSelectionRecord, "taskId"> & {
  sourceThreadId: string;
  sourceRunId: string;
  sourceMessageId: string;
  sourceCreatedAt: number | null;
};

export type BranchSelectionImportResult =
  | WorkflowMutationReceipt
  | {status: "unchanged"; workflowId: string; revision: number}
  | {status: "rejected"; code: BranchSelectionDiagnosticCode}
  | {status: "conflict"; reason: "revision"; currentRevision: number | null}
  | {status: "owner_mismatch" | "not_found"}
  | {status: "incompatible"; workflowId: string; formatVersion: number | null};

export type WorkflowStateEvidence = {
  id: string;
  operationId: string;
  kind: "draft_created" | "lineage_linked" | "agreement_imported" | "plan_updated" | "status_changed" | "node_removed" | "note" | "observation" |
    "contribution_recorded" | "contribution_assessed" | "branch_selected" | "branch_selection_invalidated" | "branch_changed";
  recordedAt: number;
  actorSupervisorThreadId: string;
  targetNodeId: string | null;
  targetNodeName: string | null;
  statusFrom: WorkflowExecutionStatus | null;
  statusTo: WorkflowExecutionStatus | null;
  sourceThreadId: string | null;
  sourceRunId: string | null;
  sourceMessageId: string | null;
  sourceItemId?: string | null;
  agreementKey: string | null;
  note: string;
  // present only on contribution evidence; the summary and references stay on the current contribution entry
  contribution?: {contributionId: string; revision: number; state: ExternalContributionState | null; decision: ExternalContributionDecision | null};
  // present only on selection evidence: the revision, its path and the condition it answered; changed is whether it replaced a different
  // or invalidated choice
  branch?: {revision: number; path: BranchSelectionPath; changed: boolean; condition?: string};
};

export type WorkflowStateEvidenceInput = {
  kind: "status_changed" | "note" | "observation";
  note: string;
  targetNodeId?: string | null;
  sourceThreadId?: string | null;
  sourceRunId?: string | null;
  sourceMessageId?: string | null;
  sourceItemId?: string | null;
};

export type AcceptedWorkflowAgreementRecord = {
  key: string;
  taskId: string;
  sourceThreadId: string;
  sourceRunId: string;
  sourceMessageId: string;
  sourceHash: string;
  objective: string;
  planHash: string;
  sourceBinding: WorkflowStateSourceBinding;
  requirements: WorkflowStateRequirement[];
  issues: WorkflowStateIssue[];
  plan: WorkflowStatePlan;
  agreement: WorkflowAgreementInfo;
};

export type WorkflowStateDocument = {
  formatVersion: 2;
  workflowId: string;
  projectId: string;
  mainThreadId: string;
  threadId: string;
  parentWorkflowId: string | null;
  parentThreadId: string | null;
  revision: number;
  status: WorkflowExecutionStatus;
  objective: string | null;
  sourceBinding: WorkflowStateSourceBinding | null;
  requirements: WorkflowStateRequirement[];
  issues: WorkflowStateIssue[];
  plan: WorkflowStatePlan;
  currentAgreementKey: string | null;
  acceptedAgreements: AcceptedWorkflowAgreementRecord[];
  // main workflow only; a stored document without this field reads as empty
  contributions: ExternalContribution[];
  // this workflow's own operative branch selections; a stored document without this field reads as empty
  branchSelections: BranchSelection[];
  evidence: WorkflowStateEvidence[];
  createdAt: number;
  updatedAt: number;
};

export type WorkflowStateIncompatible = {
  status: "incompatible";
  workflowId: string;
  formatVersion: number | null;
};

export type WorkflowStateLookupResult =
  | {status: "found"; document: WorkflowStateDocument}
  | {status: "not_found"}
  | {status: "owner_mismatch"}
  | WorkflowStateIncompatible;

export type WorkflowOwner = {
  projectId: string;
  mainThreadId: string;
  supervisorThreadId: string;
  bindingGeneration: number;
};

export type WorkflowApplyInput = {
  operationId: string;
  workflowId: string;
  expectedRevision: number;
  status: WorkflowExecutionStatus;
  objective: string | null;
  sourceBinding: WorkflowStateSourceBinding | null;
  requirements: WorkflowStateRequirement[];
  issues: WorkflowStateIssue[];
  plan: WorkflowStatePlan;
  note: string;
  evidence?: WorkflowStateEvidenceInput[];
};

export type WorkflowControllerLineage = {
  threadId: string;
  parentThreadId: string;
  relationshipToParent: "subagent";
};

export type WorkflowAgreementImport = {
  taskId: string;
  sourceThreadId: string;
  sourceRunId: string;
  sourceMessageId: string;
  sourceHash: string;
  objective: string;
  agreement: WorkflowAgreementInfo;
};

export type WorkflowMutationReceipt = {
  formatVersion: 2;
  status: "applied" | "created";
  operationId: string;
  workflowId: string;
  revision: number;
  stateHash: string;
};

export type WorkflowMutationResult = WorkflowMutationReceipt | {
  status: "conflict";
  operationId: string;
  reason: "revision" | "operation_id_reused" | "workflow_exists" | "child_already_linked" | "parent_missing" | "not_found" | "contribution_result_stale";
  currentRevision: number | null;
} | {
  status: "owner_mismatch";
  operationId: string;
} | {
  status: "invalid";
  operationId: string;
  reason: string;
} | {
  status: "not_found";
  operationId: string;
} | {
  status: "incompatible";
  operationId: string;
  workflowId: string;
  formatVersion: number | null;
};

export type WorkflowEnsureResult = WorkflowMutationResult | {
  formatVersion: 2;
  status: "exists";
  operationId: string;
  workflowId: string;
  revision: number;
  stateHash: string;
} | {
  status: "incompatible";
  operationId: string;
  workflowId: string;
  formatVersion: number | null;
};

export type WorkflowMutationLimits = {
  maxPlanNodes: number;
  maxPlanDepth: number;
  maxContributorsPerNode: number;
  maxEvidence: number;
  maxAcceptedAgreements: number;
  maxEvidencePerApply: number;
  maxTextLength: number;
  maxPlanTextLength: number;
  maxPlanReasonLength: number;
  maxOperationIdLength: number;
  maxDocumentBytes: number;
};

export const workflowMutationLimits: WorkflowMutationLimits = {
  maxPlanNodes: 500,
  maxPlanDepth: 32,
  maxContributorsPerNode: 50,
  maxEvidence: 500,
  maxAcceptedAgreements: 100,
  maxEvidencePerApply: 50,
  maxTextLength: 2000,
  maxPlanTextLength: 8000,
  maxPlanReasonLength: 1000,
  maxOperationIdLength: 200,
  maxDocumentBytes: 524_288, // serialized JSON UTF-8 byte limit
};

// stored shapes as the types above describe them; bounds, identities and cross-field rules stay with the store validators that run after decode
const mutableArray = <S extends Schema.Top>(item: S) => Schema.mutable(Schema.Array(item));
const workflowEvidenceKinds = ["draft_created", "lineage_linked", "agreement_imported", "plan_updated", "status_changed", "node_removed", "note", "observation",
  "contribution_recorded", "contribution_assessed", "branch_selected", "branch_selection_invalidated", "branch_changed"] as const;

export const BranchSelectionSchema = Schema.Struct({
  nodeId: Schema.String,
  revision: Schema.Number,
  path: Schema.Literals(branchSelectionPaths),
  reason: Schema.String,
  condition: Schema.String,
  branchKey: Schema.String,
  state: Schema.Literals(["current", "invalidated"]),
  invalidatedAt: Schema.NullOr(Schema.Number),
  sourceThreadId: Schema.String,
  sourceRunId: Schema.String,
  sourceMessageId: Schema.String,
  recordedAt: Schema.Number,
});

/** One operative-authored branch-selection chat record; decode it with onExcessProperty "error" for the exact key set. */
export const BranchSelectionRecordSchema = Schema.Struct({
  taskId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(branchSelectionLimits.maxTaskIdLength)),
  nodeId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(branchSelectionLimits.maxNodeIdLength)),
  revision: Schema.Int.check(Schema.isBetween({minimum: 1, maximum: branchSelectionLimits.maxRevision})),
  path: Schema.Literals(branchSelectionPaths),
  reason: Schema.String.check(Schema.isMaxLength(branchSelectionLimits.maxReasonLength), Schema.makeFilter((value: string) => value.trim().length > 0)),
});

export const ExternalContributionReferenceSchema = Schema.Struct({
  kind: Schema.Literals(externalContributionReferenceKinds),
  value: Schema.String,
});

export const ExternalContributionAssessmentSchema = Schema.Struct({
  decision: Schema.Literals(externalContributionDecisions),
  resultRevision: Schema.Number,
  note: Schema.String,
  actorSupervisorThreadId: Schema.String,
  evidenceId: Schema.String,
  recordedAt: Schema.Number,
});

export const ExternalContributionSchema = Schema.Struct({
  contributionId: Schema.String,
  nodeId: Schema.String,
  state: Schema.Literals(externalContributionStates),
  revision: Schema.Number,
  summary: Schema.String,
  references: mutableArray(ExternalContributionReferenceSchema),
  externalRef: Schema.NullOr(Schema.String),
  sourceThreadId: Schema.String,
  sourceRunId: Schema.String,
  sourceMessageId: Schema.String,
  recordedAt: Schema.Number,
  assessment: Schema.NullOr(ExternalContributionAssessmentSchema),
});

/** One main-authored external-contribution chat record; decode it with onExcessProperty "error" for the exact key set. */
export const ExternalContributionRecordSchema = Schema.Struct({
  taskId: Schema.String,
  contributionId: Schema.String,
  nodeId: Schema.String,
  revision: Schema.Number,
  state: Schema.Literals(externalContributionStates),
  summary: Schema.String,
  references: mutableArray(ExternalContributionReferenceSchema),
  externalRef: Schema.NullOr(Schema.String),
});

export const WorkflowStateEvidenceSchema = Schema.Struct({
  id: Schema.String,
  operationId: Schema.String,
  kind: Schema.Literals(workflowEvidenceKinds),
  recordedAt: Schema.Number,
  actorSupervisorThreadId: Schema.String,
  targetNodeId: Schema.NullOr(Schema.String),
  targetNodeName: Schema.NullOr(Schema.String),
  statusFrom: Schema.NullOr(WorkflowExecutionStatusSchema),
  statusTo: Schema.NullOr(WorkflowExecutionStatusSchema),
  sourceThreadId: Schema.NullOr(Schema.String),
  sourceRunId: Schema.NullOr(Schema.String),
  sourceMessageId: Schema.NullOr(Schema.String),
  sourceItemId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  agreementKey: Schema.NullOr(Schema.String),
  note: Schema.String,
  contribution: Schema.optionalKey(Schema.Struct({
    contributionId: Schema.String,
    revision: Schema.Number,
    state: Schema.NullOr(Schema.Literals(externalContributionStates)),
    decision: Schema.NullOr(Schema.Literals(externalContributionDecisions)),
  })),
  branch: Schema.optionalKey(Schema.Struct({revision: Schema.Number, path: Schema.Literals(branchSelectionPaths), changed: Schema.Boolean,
    condition: Schema.optionalKey(Schema.String)})),
});

export const AcceptedWorkflowAgreementRecordSchema = Schema.Struct({
  key: Schema.String,
  taskId: Schema.String,
  sourceThreadId: Schema.String,
  sourceRunId: Schema.String,
  sourceMessageId: Schema.String,
  sourceHash: Schema.String,
  objective: Schema.String,
  planHash: Schema.String,
  sourceBinding: WorkflowSourceBinding,
  requirements: mutableArray(WorkflowRequirement),
  issues: mutableArray(WorkflowIssue),
  plan: Schema.NullOr(WorkflowPlanGroupSchema),
  agreement: WorkflowAgreement,
});

/** A stored formatVersion 2 workflow document; a row stored before contributions existed decodes with an empty list. */
export const WorkflowStateDocumentSchema = Schema.Struct({
  formatVersion: Schema.Literal(2),
  workflowId: Schema.String,
  projectId: Schema.String,
  mainThreadId: Schema.String,
  threadId: Schema.String,
  parentWorkflowId: Schema.NullOr(Schema.String),
  parentThreadId: Schema.NullOr(Schema.String),
  revision: Schema.Number,
  status: WorkflowExecutionStatusSchema,
  objective: Schema.NullOr(Schema.String),
  sourceBinding: Schema.NullOr(WorkflowSourceBinding),
  requirements: mutableArray(WorkflowRequirement),
  issues: mutableArray(WorkflowIssue),
  plan: Schema.NullOr(WorkflowPlanGroupSchema),
  currentAgreementKey: Schema.NullOr(Schema.String),
  acceptedAgreements: mutableArray(AcceptedWorkflowAgreementRecordSchema),
  contributions: mutableArray(ExternalContributionSchema).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  branchSelections: mutableArray(BranchSelectionSchema).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  evidence: mutableArray(WorkflowStateEvidenceSchema),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
});

/** A stored operation receipt: the replay result of one workflow write. */
export const WorkflowMutationReceiptSchema = Schema.Struct({
  formatVersion: Schema.Literal(2),
  status: Schema.Literals(["applied", "created"]),
  operationId: Schema.String,
  workflowId: Schema.String,
  revision: Schema.Number,
  stateHash: Schema.String,
});

// the schemas mirror the hand-written types in both directions
type Same<A, B> = [A] extends [B] ? [B] extends [A] ? true : false : false;
const mirrors: [
  Same<typeof WorkflowStateDocumentSchema.Type, WorkflowStateDocument>,
  Same<typeof WorkflowMutationReceiptSchema.Type, WorkflowMutationReceipt>,
  Same<typeof ExternalContributionSchema.Type, ExternalContribution>,
  Same<typeof ExternalContributionRecordSchema.Type, ExternalContributionRecord>,
  Same<typeof WorkflowStateEvidenceSchema.Type, WorkflowStateEvidence>,
  Same<typeof BranchSelectionSchema.Type, BranchSelection>,
  Same<typeof BranchSelectionRecordSchema.Type, BranchSelectionRecord>,
  Same<typeof AcceptedWorkflowAgreementRecordSchema.Type, AcceptedWorkflowAgreementRecord>,
] = [true, true, true, true, true, true, true, true];
void mirrors;
