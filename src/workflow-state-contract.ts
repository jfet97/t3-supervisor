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
export const externalContributionParticipantKinds = ["t3_conversation", "external", "unknown"] as const;
/**
 * The main's optional, generic declaration of who performs a contribution: a T3 conversation (local or in a linked environment), an
 * opaque external handle, or an unknown capability set. It is untrusted and derives no lineage, scope, authority or settlement.
 */
export type ExternalContributionParticipant =
  | {kind: "t3_conversation"; threadId: string; environmentId: string | null}
  | {kind: "external"; ref: string}
  | {kind: "unknown"};
export const participantReceiptKinds = ["read", "lifecycle", "unsupported"] as const;
export type ParticipantReceiptKind = typeof participantReceiptKinds[number];
/**
 * The root's attributed observation of one contribution's participant, backed by its own completed native tool item (read or lifecycle)
 * or an explicit statement that no route exists (unsupported); recorded with the exact participant, revision and attempt it concerns.
 */
export type WorkflowEvidenceParticipant = {
  contributionId: string;
  revision: number;
  attempt: number;
  participant: ExternalContributionParticipant | null;
  receipt: {kind: ParticipantReceiptKind; toolName: string | null; inputDigest: string | null};
};

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
  maxParticipantHandleLength: 200,
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
  participant?: ExternalContributionParticipant | null;
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
  participant?: ExternalContributionParticipant | null;
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

/**
 * An execution that belonged to an attempt a return closed, so whatever it reports later stays with that attempt: an AppRun; the native
 * turns of a child without an AppRun of its own, named by the provider turn IDs T3 publishes for it; or a whole native child that
 * publishes no per-execution identity, which nothing it reports can satisfy again.
 */
export type WorkflowReturnRun =
  | {kind: "run"; threadId: string; runId: string}
  | {kind: "provider_turns"; threadId: string; providerThreadId: string; providerTurnIds: string[]}
  | {kind: "thread"; threadId: string; reason: string};

/**
 * One return of this workflow: a reached back_to asks to repeat its region, every occurrence from its target through the member that
 * holds it, as a new attempt. It stays pending until the Supervisor applies it at a safe point or it is no longer reached, and is never
 * removed: an applied return keeps the statuses, contributors and branch selections the closed attempt ended with and the child runs
 * retired with it.
 */
export type WorkflowReturn = {
  returnId: string;
  backToNodeId: string;
  targetNodeId: string;
  regionNodeIds: string[];
  /** the attempt of the back_to occurrence that reached it, which an applied return closes */
  attempt: number;
  state: "pending" | "applied" | "dismissed" | "exhausted";
  /** the reason of the selection that led to the back_to, or why it was reached unconditionally */
  reason: string;
  sourceThreadId: string | null;
  sourceRunId: string | null;
  sourceMessageId: string | null;
  requestedAt: number;
  resolvedAt: number | null;
  closed: Array<{nodeId: string; status: WorkflowExecutionStatus; contributorThreadIds: string[]}> | null;
  closedSelections: Array<{nodeId: string; revision: number; path: BranchSelectionPath}> | null;
  retiredRuns: WorkflowReturnRun[];
  resolution: {operationId: string; actorSupervisorThreadId: string; note: string} | null;
};

/** Applies one pending return; retiredRuns names the executions of the closed attempt whose later output must not count for the new one. */
export type WorkflowReturnApplyInput = {
  operationId: string;
  workflowId: string;
  expectedRevision: number;
  returnId: string;
  note: string;
  retiredRuns?: WorkflowReturnRun[];
};

export type WorkflowStateEvidence = {
  id: string;
  operationId: string;
  kind: "draft_created" | "lineage_linked" | "agreement_imported" | "plan_updated" | "status_changed" | "node_removed" | "note" | "observation" |
    "not_applicable" | "contribution_recorded" | "contribution_assessed" | "branch_selected" | "branch_selection_invalidated" | "branch_changed" |
    "return_requested" | "return_applied" | "return_dismissed" | "return_budget_exhausted";
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
  // resolved by the service for a native child reference without an AppRun: the published provider turn behind the cited item or
  // message and when it started; absent otherwise
  sourceProviderTurnId?: string | null;
  sourceProviderTurnStartedAt?: number | null;
  agreementKey: string | null;
  note: string;
  /** present only on not_applicable evidence: the task scope it assessed; a later scope needs a fresh assessment */
  scopeRevision?: string;
  // present only on contribution evidence; the summary and references stay on the current contribution entry
  contribution?: {contributionId: string; revision: number; state: ExternalContributionState | null; decision: ExternalContributionDecision | null};
  // present only on a participant observation: the receipt the write controller resolved from the root's own native item
  participant?: WorkflowEvidenceParticipant;
  // present only on selection evidence: the revision, its path and the condition it answered; changed is whether it replaced a different
  // or invalidated choice
  branch?: {revision: number; path: BranchSelectionPath; changed: boolean; condition?: string};
  // present only on return evidence; the region, attempt and closed state stay on the return entry
  return?: {returnId: string; regionNodeIds?: string[]};
  // present only on the status_changed evidence of an explicit repair: a misrecorded status inside a return region moved backward off
  // the selected path, starting no attempt and spending no jump
  repair?: true;
};

export type WorkflowStateEvidenceInput = {
  /** not_applicable records that a planned member of a fixed workflow does not apply to this task; it changes no status. */
  kind: "status_changed" | "note" | "observation" | "not_applicable";
  note: string;
  targetNodeId?: string | null;
  sourceThreadId?: string | null;
  sourceRunId?: string | null;
  sourceMessageId?: string | null;
  sourceItemId?: string | null;
  /** Resolved by the write controller from the cited native item or message and T3's published provider turns; never caller input. */
  sourceProviderTurnId?: string | null;
  sourceProviderTurnStartedAt?: number | null;
  /** An observation of a contribution's participant: the contribution and what the root's cited own item establishes. */
  participantContributionId?: string;
  observation?: ParticipantReceiptKind;
  /** Resolved by the write controller from the contribution and the root's verified item; never caller input. */
  participantReceipt?: WorkflowEvidenceParticipant;
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

/** One debit or reset of a return occurrence's jump budget. The node's current maximum is the ceiling; events are not cleared by editing it. */
export type ReturnBudgetEvent = {
  kind: "consumed" | "reset";
  returnId: string;
  at: number;
};

/** Retained jump budget for one return occurrence. address is the structural slot, not a target or a node id. */
export type ReturnBudget = {
  budgetId: string;
  address: string;
  events: ReturnBudgetEvent[];
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
  // every return this workflow's back_to nodes requested, in request order; a stored document without this field reads as empty
  returns: WorkflowReturn[];
  // jump budgets keyed by budgetId. Absent only on a document that stores no back_to; a missing key is not an empty budget for a return.
  returnBudgets?: ReturnBudget[];
  evidence: WorkflowStateEvidence[];
  createdAt: number;
  updatedAt: number;
};

/**
 * The proposal whose retained accepted snapshot the document's content still matches, or null once any later write changed that
 * content: edited contents are never the accepted plan, while the earlier acceptance stays retained in acceptedAgreements.
 */
export const currentAcceptedProposalId = (document: Pick<WorkflowStateDocument, "currentAgreementKey" | "acceptedAgreements">): string | null =>
  document.currentAgreementKey === null ? null
    : document.acceptedAgreements.find(item => item.key === document.currentAgreementKey)?.agreement.proposalId ?? null;

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
  /** Declares this apply's backward status moves inside a return region off its selected path as the correction of a misrecorded status. */
  repair?: boolean;
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
  /** The document's own status after the write, separate from the status of its root occurrence. */
  documentStatus?: WorkflowExecutionStatus;
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
  documentStatus?: WorkflowExecutionStatus;
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
  /** Returns one workflow may request, pending, applied and dismissed together; a runaway loop stops here. */
  maxReturns: number;
  /** Child runs one applied return may retire. */
  maxRetiredRuns: number;
  maxEvidencePerApply: number;
  maxTextLength: number;
  maxPlanTextLength: number;
  maxPlanReasonLength: number;
  maxOperationIdLength: number;
  /** Opaque native thread, run, message and item references cited by evidence; T3 identities can exceed operation IDs. */
  maxNativeReferenceLength: number;
  maxDocumentBytes: number;
};

export const workflowMutationLimits: WorkflowMutationLimits = {
  maxPlanNodes: 500,
  maxPlanDepth: 32,
  maxContributorsPerNode: 50,
  maxEvidence: 500,
  maxAcceptedAgreements: 100,
  maxReturns: 100,
  maxRetiredRuns: 50,
  maxEvidencePerApply: 50,
  maxTextLength: 2000,
  maxPlanTextLength: 8000,
  maxPlanReasonLength: 1000,
  maxOperationIdLength: 200,
  maxNativeReferenceLength: 1024,
  maxDocumentBytes: 524_288, // serialized JSON UTF-8 byte limit
};

/**
 * The deepest JSON nesting of a valid plan held under one record key: its root group is one level down, each of at most maxPlanDepth
 * further group levels adds at most three (a group, its nodes array and the branch or workflow node holding the next group), and the
 * deepest node detail, an omission's source fields, lies six levels below its group.
 */
export const storedPlanJsonDepth = 1 + 3 * workflowMutationLimits.maxPlanDepth + 6;

// stored shapes as the types above describe them; bounds, identities and cross-field rules stay with the store validators that run after decode
const mutableArray = <S extends Schema.Top>(item: S) => Schema.mutable(Schema.Array(item));
export const workflowEvidenceKinds = ["draft_created", "lineage_linked", "agreement_imported", "plan_updated", "status_changed", "node_removed", "note", "observation",
  "not_applicable", "contribution_recorded", "contribution_assessed", "branch_selected", "branch_selection_invalidated", "branch_changed",
  "return_requested", "return_applied", "return_dismissed", "return_budget_exhausted"] as const;

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

export const ExternalContributionParticipantSchema = Schema.Union([
  Schema.Struct({kind: Schema.Literal("t3_conversation"), threadId: Schema.String, environmentId: Schema.NullOr(Schema.String)}),
  Schema.Struct({kind: Schema.Literal("external"), ref: Schema.String}),
  Schema.Struct({kind: Schema.Literal("unknown")}),
]);
export const WorkflowEvidenceParticipantSchema = Schema.Struct({
  contributionId: Schema.String,
  revision: Schema.Number,
  attempt: Schema.Number,
  participant: Schema.NullOr(ExternalContributionParticipantSchema),
  receipt: Schema.Struct({kind: Schema.Literals(participantReceiptKinds), toolName: Schema.NullOr(Schema.String), inputDigest: Schema.NullOr(Schema.String)}),
});

export const ExternalContributionSchema = Schema.Struct({
  contributionId: Schema.String,
  nodeId: Schema.String,
  state: Schema.Literals(externalContributionStates),
  revision: Schema.Number,
  summary: Schema.String,
  references: mutableArray(ExternalContributionReferenceSchema),
  externalRef: Schema.NullOr(Schema.String),
  participant: Schema.optionalKey(Schema.NullOr(ExternalContributionParticipantSchema)),
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
  participant: Schema.optionalKey(Schema.NullOr(ExternalContributionParticipantSchema)),
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
  sourceProviderTurnId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  sourceProviderTurnStartedAt: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  agreementKey: Schema.NullOr(Schema.String),
  note: Schema.String,
  scopeRevision: Schema.optionalKey(Schema.String),
  contribution: Schema.optionalKey(Schema.Struct({
    contributionId: Schema.String,
    revision: Schema.Number,
    state: Schema.NullOr(Schema.Literals(externalContributionStates)),
    decision: Schema.NullOr(Schema.Literals(externalContributionDecisions)),
  })),
  participant: Schema.optionalKey(WorkflowEvidenceParticipantSchema),
  branch: Schema.optionalKey(Schema.Struct({revision: Schema.Number, path: Schema.Literals(branchSelectionPaths), changed: Schema.Boolean,
    condition: Schema.optionalKey(Schema.String)})),
  return: Schema.optionalKey(Schema.Struct({returnId: Schema.String, regionNodeIds: Schema.optionalKey(mutableArray(Schema.String))})),
  repair: Schema.optionalKey(Schema.Literal(true)),
});

export const WorkflowReturnRunSchema = Schema.Union([
  Schema.Struct({kind: Schema.Literal("run"), threadId: Schema.String, runId: Schema.String}),
  Schema.Struct({kind: Schema.Literal("provider_turns"), threadId: Schema.String, providerThreadId: Schema.String, providerTurnIds: mutableArray(Schema.String)}),
  Schema.Struct({kind: Schema.Literal("thread"), threadId: Schema.String, reason: Schema.String}),
]);

export const ReturnBudgetEventSchema = Schema.Struct({
  kind: Schema.Literals(["consumed", "reset"]),
  returnId: Schema.String,
  at: Schema.Number,
});
export const ReturnBudgetSchema = Schema.Struct({
  budgetId: Schema.String,
  address: Schema.String,
  events: mutableArray(ReturnBudgetEventSchema),
});

export const WorkflowReturnSchema = Schema.Struct({
  returnId: Schema.String,
  backToNodeId: Schema.String,
  targetNodeId: Schema.String,
  regionNodeIds: mutableArray(Schema.String),
  attempt: Schema.Number,
  state: Schema.Literals(["pending", "applied", "dismissed", "exhausted"]),
  reason: Schema.String,
  sourceThreadId: Schema.NullOr(Schema.String),
  sourceRunId: Schema.NullOr(Schema.String),
  sourceMessageId: Schema.NullOr(Schema.String),
  requestedAt: Schema.Number,
  resolvedAt: Schema.NullOr(Schema.Number),
  closed: Schema.NullOr(mutableArray(Schema.Struct({nodeId: Schema.String, status: WorkflowExecutionStatusSchema, contributorThreadIds: mutableArray(Schema.String)}))),
  closedSelections: Schema.NullOr(mutableArray(Schema.Struct({nodeId: Schema.String, revision: Schema.Number, path: Schema.Literals(branchSelectionPaths)}))),
  retiredRuns: mutableArray(WorkflowReturnRunSchema),
  resolution: Schema.NullOr(Schema.Struct({operationId: Schema.String, actorSupervisorThreadId: Schema.String, note: Schema.String})),
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
  returns: mutableArray(WorkflowReturnSchema).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  returnBudgets: Schema.optionalKey(mutableArray(ReturnBudgetSchema)),
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
  documentStatus: Schema.optionalKey(WorkflowExecutionStatusSchema),
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
  Same<typeof WorkflowReturnSchema.Type, WorkflowReturn>,
  Same<typeof WorkflowReturnRunSchema.Type, WorkflowReturnRun>,
  Same<typeof ExternalContributionParticipantSchema.Type, ExternalContributionParticipant>,
  Same<typeof WorkflowEvidenceParticipantSchema.Type, WorkflowEvidenceParticipant>,
] = [true, true, true, true, true, true, true, true, true, true, true, true];
void mirrors;
