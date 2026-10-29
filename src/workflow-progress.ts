import { Schema } from "effect";
import { ProjectSupervisorScopeSnapshotSchema, type ProjectSupervisorScopeSnapshot, type ProjectSupervisorScopeThread } from "./supervisor-observation.js";
import { WorkflowExecutionStatus, WorkflowPlanGroupSchema, type WorkflowPlanGroupInfo } from "./project-supervisor-contract.js";
import { effectiveBranchSelections, notApplicableNodeIds, notApplicableSubtrees, occurrenceAttempts, planBackTos, planBranches, planEntities, resolveBackTo } from "./workflow-plan-tree.js";
import { branchSelectionPaths, currentAcceptedProposalId, externalContributionDecisions, externalContributionReferenceKinds, externalContributionStates,
  participantReceiptKinds, WorkflowReturnRunSchema, type ExternalContributionParticipant, type WorkflowStateDocument, type WorkflowStateEvidence } from "./workflow-state-contract.js";

import { WorkflowAssessment, workflowAssessment } from "./workflow-assessment.js";

const NullableText = Schema.NullOr(Schema.String);

export const WorkflowProgressObservationSchema = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals(["status_changed", "note", "observation", "not_applicable"]),
  recordedAt: Schema.Number,
  targetNodeId: NullableText,
  targetNodeName: NullableText,
  statusFrom: Schema.NullOr(WorkflowExecutionStatus),
  statusTo: Schema.NullOr(WorkflowExecutionStatus),
  sourceThreadId: NullableText,
  sourceRunId: NullableText,
  sourceMessageId: NullableText,
  sourceItemId: Schema.optionalKey(NullableText),
  note: Schema.String,
});
export type WorkflowProgressObservation = typeof WorkflowProgressObservationSchema.Type;

export const WorkflowHistoryEventSchema = Schema.Struct({
  id: Schema.String, sequence: Schema.Number, kind: Schema.String, recordedAt: Schema.Number,
  /** The write that recorded this event; consecutive events of one write are one operation, never merged into one record. */
  operationId: Schema.optionalKey(Schema.String),
  targetNodeId: NullableText, targetNodeName: NullableText, attempt: Schema.NullOr(Schema.Number),
  statusFrom: Schema.NullOr(WorkflowExecutionStatus), statusTo: Schema.NullOr(WorkflowExecutionStatus),
  sourceThreadId: NullableText, sourceMessageId: NullableText, sourceItemId: NullableText, note: Schema.String,
  repair: Schema.optionalKey(Schema.Literal(true)),
});
export type WorkflowHistoryEvent = typeof WorkflowHistoryEventSchema.Type;

/** Stored append order is authoritative even when several events share a timestamp. */
export const progressHistory = (document: WorkflowStateDocument): WorkflowHistoryEvent[] => {
  const attempts = new Map<string, number>();
  return document.evidence.map((item, index) => {
    if (item.kind === "return_applied" && item.return) {
      const returned = document.returns.find(returned => returned.returnId === item.return!.returnId && returned.state === "applied");
      for (const id of returned?.regionNodeIds ?? []) attempts.set(id, (attempts.get(id) ?? 1) + 1);
    }
    return {id: item.id, sequence: index + 1, kind: item.kind, recordedAt: item.recordedAt, operationId: item.operationId, targetNodeId: item.targetNodeId,
      targetNodeName: item.targetNodeName, attempt: item.targetNodeId ? attempts.get(item.targetNodeId) ?? 1 : null,
      statusFrom: item.statusFrom, statusTo: item.statusTo, sourceThreadId: item.sourceThreadId, sourceMessageId: item.sourceMessageId,
      sourceItemId: item.sourceItemId ?? null, note: item.note, ...(item.repair === true ? {repair: true as const} : {})};
  });
};

// a main-reported external contribution; its text is untrusted and its execution was not observed
export const WorkflowProgressContributionSchema = Schema.Struct({
  contributionId: Schema.String,
  nodeId: Schema.String,
  nodeName: NullableText,
  inCurrentPlan: Schema.Boolean,
  state: Schema.Literals(externalContributionStates),
  revision: Schema.Number,
  summary: Schema.String,
  references: Schema.Array(Schema.Struct({kind: Schema.Literals(externalContributionReferenceKinds), value: Schema.String})),
  externalRef: NullableText,
  sourceThreadId: Schema.String,
  sourceMessageId: Schema.String,
  recordedAt: Schema.Number,
  assessment: Schema.NullOr(Schema.Struct({
    decision: Schema.Literals(externalContributionDecisions),
    resultRevision: Schema.Number,
    note: Schema.String,
    recordedAt: Schema.Number,
  })),
});
export type WorkflowProgressContribution = typeof WorkflowProgressContributionSchema.Type;

/**
 * Coverage of one task participant, each value a distinct fact: native is the service's own verified scope read of a descendant;
 * supervisor_observed is the root's attributed read receipt backed by its own completed native item; lifecycle_only is such a receipt
 * from a wait, list or search call; reported is the main's declaration alone; unsupported is the root's explicit statement that no route
 * exists; unknown is no declaration and no receipt.
 */
export const participantCoverageStates = ["native", "supervisor_observed", "lifecycle_only", "reported", "unsupported", "unknown"] as const;
export type ParticipantCoverageState = typeof participantCoverageStates[number];
export const WorkflowProgressParticipantSchema = Schema.Struct({
  id: Schema.String,
  source: Schema.Literals(["native", "declared"]),
  kind: Schema.Literals(["native_child", "t3_conversation", "external", "unknown"]),
  handle: NullableText,
  environmentId: NullableText,
  threadId: NullableText,
  contributionId: NullableText,
  revision: Schema.NullOr(Schema.Number),
  roles: Schema.Array(Schema.Struct({nodeId: Schema.String, nodeName: NullableText, attempt: Schema.Number, retired: Schema.Boolean})),
  owner: Schema.Literals(["root", "helper", "unknown"]),
  lifecycle: Schema.Literals(["running", "completed", "interrupted", "unknown", "reported"]),
  reportedState: Schema.NullOr(Schema.Literals(externalContributionStates)),
  completion: Schema.Literals(["none", "native_completed", "result_reported", "accepted", "needs_more", "withdrawn"]),
  coverage: Schema.Literals(participantCoverageStates),
  currentReceipt: Schema.NullOr(Schema.Struct({kind: Schema.Literals(participantReceiptKinds), recordedAt: Schema.Number, actorSupervisorThreadId: Schema.String,
    sourceItemId: NullableText, toolName: NullableText, evidenceId: Schema.String})),
  priorReceipts: Schema.Number,
  settlement: Schema.Literal("not_evaluated"),
});
export type WorkflowProgressParticipant = typeof WorkflowProgressParticipantSchema.Type;

// the workflow operative's latest decision for one branch; current is false once the branch changed or left the plan
export const WorkflowProgressBranchSelectionSchema = Schema.Struct({
  nodeId: Schema.String,
  inCurrentPlan: Schema.Boolean,
  current: Schema.Boolean,
  path: Schema.Literals(branchSelectionPaths),
  revision: Schema.Number,
  reason: Schema.String,
  condition: Schema.String,
  sourceThreadId: Schema.String,
  sourceMessageId: Schema.String,
  recordedAt: Schema.Number,
  invalidatedAt: Schema.NullOr(Schema.Number),
});
export type WorkflowProgressBranchSelection = typeof WorkflowProgressBranchSelectionSchema.Type;
// one recorded branch event, newest first: a selection revision or the invalidation of one, with the condition it answered when recorded
export const WorkflowProgressBranchEventSchema = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals(["selected", "invalidated"]),
  nodeId: Schema.String,
  revision: Schema.Number,
  path: Schema.Literals(branchSelectionPaths),
  condition: Schema.optionalKey(Schema.NullOr(Schema.String)),
  note: Schema.String,
  sourceThreadId: NullableText,
  sourceMessageId: NullableText,
  recordedAt: Schema.Number,
});
export type WorkflowProgressBranchEvent = typeof WorkflowProgressBranchEventSchema.Type;

/**
 * One return of the workflow in request order: pending until the Supervisor applies it, applied when it started a new attempt of its
 * region, dismissed when its back_to was no longer reached, exhausted when its maximum is used and the failure is still in force.
 * An applied return keeps what the attempt it closed ended with.
 */
export const WorkflowProgressReturnSchema = Schema.Struct({
  returnId: Schema.String,
  backToNodeId: Schema.String,
  targetNodeId: Schema.String,
  targetName: NullableText,
  regionNodeIds: Schema.Array(Schema.String),
  attempt: Schema.Number,
  state: Schema.Literals(["pending", "applied", "dismissed", "exhausted"]),
  reason: Schema.String,
  sourceThreadId: NullableText,
  sourceMessageId: NullableText,
  requestedAt: Schema.Number,
  resolvedAt: Schema.NullOr(Schema.Number),
  closed: Schema.NullOr(Schema.Array(Schema.Struct({nodeId: Schema.String, status: WorkflowExecutionStatus, contributorThreadIds: Schema.Array(Schema.String)}))),
  /** The branch selections that were current in the closed attempt; their reason and source stay on the branch events of that revision. */
  closedSelections: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.Struct({nodeId: Schema.String, revision: Schema.Number, path: Schema.Literals(branchSelectionPaths)})))),
  retiredRuns: Schema.Array(WorkflowReturnRunSchema),
  note: NullableText,
});
export type WorkflowProgressReturn = typeof WorkflowProgressReturnSchema.Type;

/** A completed workflow occurrence and its latest completion record's time, or null when no completion record exists. */
export const WorkflowProgressCompletionSchema = Schema.Struct({
  nodeId: Schema.String,
  completedAt: Schema.NullOr(Schema.Number),
});
export type WorkflowProgressCompletion = typeof WorkflowProgressCompletionSchema.Type;

export const WorkflowProgressWorkflowSchema = Schema.Struct({
  workflowId: Schema.String,
  projectId: Schema.String,
  mainThreadId: Schema.String,
  threadId: Schema.String,
  parentThreadId: NullableText,
  revision: Schema.Number,
  status: WorkflowExecutionStatus,
  assessment: Schema.optionalKey(Schema.NullOr(WorkflowAssessment)),
  objective: NullableText,
  plan: Schema.NullOr(WorkflowPlanGroupSchema),
  /** The proposal whose accepted snapshot this content still matches; null once a later write changed it, so it is not accepted. */
  acceptedProposalId: NullableText,
  updatedAt: Schema.Number,
  parentNodeReferences: Schema.Array(Schema.Struct({
    parentWorkflowId: Schema.String,
    parentThreadId: Schema.String,
    nodeId: Schema.String,
    nodeKind: Schema.Literals(["step", "workflow"]),
    nodeName: Schema.String,
  })),
  observations: Schema.Array(WorkflowProgressObservationSchema),
  history: Schema.optionalKey(Schema.Array(WorkflowHistoryEventSchema)),
  historyComplete: Schema.optionalKey(Schema.Boolean),
  contributions: Schema.Array(WorkflowProgressContributionSchema),
  branchSelections: Schema.optionalKey(Schema.Array(WorkflowProgressBranchSelectionSchema)),
  branchEvents: Schema.optionalKey(Schema.Array(WorkflowProgressBranchEventSchema)),
  completions: Schema.optionalKey(Schema.Array(WorkflowProgressCompletionSchema)),
  /** Occurrences settled by a current not-applicable assessment, including everything inside an assessed workflow. */
  notApplicable: Schema.optionalKey(Schema.Array(Schema.String)),
  returns: Schema.optionalKey(Schema.Array(WorkflowProgressReturnSchema)),
  /** The current attempt of every occurrence inside a return's region: 1 until an applied return reopens it, one more per applied return holding it. */
  attempts: Schema.optionalKey(Schema.Array(Schema.Struct({nodeId: Schema.String, attempt: Schema.Number}))),
  /** Every participant of this workflow's occurrences: attached native descendants, linked children without a role, declared participants. */
  participants: Schema.optionalKey(Schema.Array(WorkflowProgressParticipantSchema)),
});
export type WorkflowProgressWorkflow = typeof WorkflowProgressWorkflowSchema.Type;

export const WorkflowProgressCoverageSchema = Schema.Struct({
  threadId: Schema.String,
  state: Schema.Literals(["root", "assigned", "transfer", "observe_only", "unknown"]),
  assigneeThreadId: NullableText,
  assigneeTitle: NullableText,
  assignmentRootThreadId: NullableText,
});
export type WorkflowProgressCoverage = typeof WorkflowProgressCoverageSchema.Type;

export const WorkflowProgressSnapshotSchema = Schema.Struct({
  status: Schema.Literals(["ok", "unavailable", "denied", "invalid", "incompatible", "too_large"]),
  message: NullableText,
  projectId: Schema.String,
  mainThreadId: Schema.String,
  observedAt: Schema.Number,
  scope: Schema.NullOr(ProjectSupervisorScopeSnapshotSchema),
  coverage: Schema.optionalKey(Schema.Array(WorkflowProgressCoverageSchema)),
  incompatibleWorkflows: Schema.Array(Schema.Struct({workflowId: Schema.String, formatVersion: Schema.NullOr(Schema.Number)})),
  workflows: Schema.Array(WorkflowProgressWorkflowSchema),
  workflowOffset: Schema.Number,
  workflowHasMore: Schema.Boolean,
  lineageOffset: Schema.Number,
  lineageHasMore: Schema.Boolean,
});
export type WorkflowProgressSnapshot = typeof WorkflowProgressSnapshotSchema.Type;

export type WorkflowProgressPageQuery = {
  projectId: string;
  mainThreadId: string;
  workflowOffset: number;
  lineageOffset: number;
  limit: number;
};

export type WorkflowProgressPagingQuery = {
  projectId: string;
  mainThreadId: string;
  workflowOffset?: string | undefined;
  lineageOffset?: string | undefined;
  limit?: string | undefined;
};

export const maxWorkflowProgressResponseBytes = 1_048_576;

const parseInteger = (value: string | undefined, fallback: number, minimum: number, maximum: number): number | null => {
  if (value === undefined) return fallback;
  if (!/^\d+$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : null;
};

export const parseWorkflowProgressPageQuery = (query: WorkflowProgressPagingQuery): WorkflowProgressPageQuery | null => {
  const workflowOffset = parseInteger(query.workflowOffset, 0, 0, 10_000);
  const lineageOffset = parseInteger(query.lineageOffset, 0, 0, 10_000);
  const limit = parseInteger(query.limit, 20, 1, 50);
  if (workflowOffset === null || lineageOffset === null || limit === null || !query.projectId || !query.mainThreadId) return null;
  return {projectId: query.projectId, mainThreadId: query.mainThreadId, workflowOffset, lineageOffset, limit};
};

// a page without workflow content; observedAt is the scope's time, else the reader's clock
export const emptyPage = (query: WorkflowProgressPageQuery, status: WorkflowProgressSnapshot["status"], message: string,
  scope: ProjectSupervisorScopeSnapshot | null, observedAt: number): WorkflowProgressSnapshot => ({
  status,
  message,
  projectId: query.projectId,
  mainThreadId: query.mainThreadId,
  observedAt,
  scope,
  coverage: [],
  incompatibleWorkflows: [],
  workflows: [],
  workflowOffset: query.workflowOffset,
  workflowHasMore: false,
  lineageOffset: query.lineageOffset,
  lineageHasMore: false,
});

export const scopePage = (scope: ProjectSupervisorScopeSnapshot, threadIds: readonly string[]): ProjectSupervisorScopeSnapshot => {
  const wanted = new Set(threadIds);
  return {...scope, threads: scope.threads.filter(thread => wanted.has(thread.threadId))};
};

const observationKinds = new Set<WorkflowStateEvidence["kind"]>(["status_changed", "note", "observation", "not_applicable"]);

type ParentNodeReference = {
  parentWorkflowId: string;
  parentThreadId: string;
  nodeId: string;
  nodeKind: "step" | "workflow";
  nodeName: string;
};

const planNodeNames = (plan: WorkflowPlanGroupInfo | null): Map<string, string> => new Map(planEntities(plan).map(node => [node.nodeId, node.name]));

// a removed node keeps the last name recorded for it so its contributions stay recognizable as history
const contributionNodeName = (document: WorkflowStateDocument, nodeId: string, planNames: ReadonlyMap<string, string>): string | null =>
  planNames.get(nodeId) ?? document.evidence.findLast(item => item.targetNodeId === nodeId && item.targetNodeName !== null)?.targetNodeName ?? null;

const progressContributions = (document: WorkflowStateDocument): WorkflowProgressContribution[] => {
  const planNames = planNodeNames(document.plan);
  return document.contributions.map(item => ({
    contributionId: item.contributionId,
    nodeId: item.nodeId,
    nodeName: contributionNodeName(document, item.nodeId, planNames),
    inCurrentPlan: planNames.has(item.nodeId),
    state: item.state,
    revision: item.revision,
    summary: item.summary,
    references: item.references.map(reference => ({kind: reference.kind, value: reference.value})),
    externalRef: item.externalRef,
    sourceThreadId: item.sourceThreadId,
    sourceMessageId: item.sourceMessageId,
    recordedAt: item.recordedAt,
    assessment: item.assessment ? {decision: item.assessment.decision, resultRevision: item.assessment.resultRevision,
      note: item.assessment.note, recordedAt: item.assessment.recordedAt} : null,
  }));
};

const progressBranchSelections = (document: WorkflowStateDocument): WorkflowProgressBranchSelection[] => {
  const inPlan = new Set(planBranches(document.plan).map(branch => branch.nodeId));
  const selected = effectiveBranchSelections(document.plan, document.branchSelections);
  return document.branchSelections.map(item => ({nodeId: item.nodeId, inCurrentPlan: inPlan.has(item.nodeId), current: selected.get(item.nodeId) === item.path,
    path: item.path, revision: item.revision, reason: item.reason, condition: item.condition, sourceThreadId: item.sourceThreadId,
    sourceMessageId: item.sourceMessageId, recordedAt: item.recordedAt, invalidatedAt: item.invalidatedAt}));
};

const progressBranchEvents = (document: WorkflowStateDocument): WorkflowProgressBranchEvent[] => document.evidence
  .flatMap(item => (item.kind === "branch_selected" || item.kind === "branch_selection_invalidated") && item.branch && item.targetNodeId
    ? [{id: item.id, kind: item.kind === "branch_selected" ? "selected" as const : "invalidated" as const, nodeId: item.targetNodeId, revision: item.branch.revision,
      path: item.branch.path, condition: item.branch.condition ?? null, note: item.note, sourceThreadId: item.sourceThreadId, sourceMessageId: item.sourceMessageId,
      recordedAt: item.recordedAt}] : [])
  .sort((left, right) => right.recordedAt - left.recordedAt).slice(0, 50);

// completion times come from the whole evidence, not the truncated observations, so an older completion still dates against later decisions
const progressCompletions = (document: WorkflowStateDocument): WorkflowProgressCompletion[] =>
  planEntities(document.plan).flatMap(node => node.kind !== "workflow" || node.status !== "completed" ? [] : [{nodeId: node.nodeId,
    completedAt: document.evidence.reduce<number | null>((latest, item) => item.kind === "status_changed" && item.targetNodeId === node.nodeId &&
      item.statusTo === "completed" && (latest === null || item.recordedAt > latest) ? item.recordedAt : latest, null)}]);

const progressReturns = (document: WorkflowStateDocument): WorkflowProgressReturn[] => {
  const planNames = planNodeNames(document.plan);
  return document.returns.map(item => ({returnId: item.returnId, backToNodeId: item.backToNodeId, targetNodeId: item.targetNodeId,
    targetName: contributionNodeName(document, item.targetNodeId, planNames), regionNodeIds: [...item.regionNodeIds], attempt: item.attempt, state: item.state,
    reason: item.reason, sourceThreadId: item.sourceThreadId, sourceMessageId: item.sourceMessageId, requestedAt: item.requestedAt, resolvedAt: item.resolvedAt,
    closed: item.closed ? item.closed.map(closed => ({nodeId: closed.nodeId, status: closed.status, contributorThreadIds: [...closed.contributorThreadIds]})) : null,
    closedSelections: item.closedSelections ? item.closedSelections.map(selection => ({nodeId: selection.nodeId, revision: selection.revision, path: selection.path})) : null,
    retiredRuns: item.retiredRuns.map(run => run.kind === "provider_turns" ? {...run, providerTurnIds: [...run.providerTurnIds]} : {...run}),
    note: item.resolution?.note ?? null}));
};

/** Previous attempts stay in History, while the current Plan gets only this attempt's assessments. */
const currentAttemptObservations = (document: WorkflowStateDocument): WorkflowStateEvidence[] => {
  const current = occurrenceAttempts(document.returns);
  const ids = new Set(progressHistory(document).filter(item => !item.targetNodeId || item.attempt === (current.get(item.targetNodeId) ?? 1)).map(item => item.id));
  return document.evidence.filter(item => observationKinds.has(item.kind) && ids.has(item.id));
};

export type ParticipantScopeThread = Pick<ProjectSupervisorScopeThread, "threadId" | "lifecycle">;
export type ParticipantCoverageOwner = "root" | "assigned" | "transfer" | "observe_only" | "unknown";
const participantDigest = (participant: ExternalContributionParticipant | null | undefined): string => JSON.stringify(participant ?? null);
const ownerOf = (state: ParticipantCoverageOwner | undefined): WorkflowProgressParticipant["owner"] =>
  state === "root" || state === "observe_only" ? "root" : state === "assigned" || state === "transfer" ? "helper" : "unknown";

/**
 * The participants of one workflow's occurrences, computed from existing records: native descendants attached by contributorThreadIds
 * (with their attempt and whether an applied return replaced the conversation), linked children with no attached occurrence, and the
 * main-reported participants of this document's contributions with the root's receipts that are current for the declaration, revision
 * and attempt; earlier receipts stay counted as history. Nothing here settles anything.
 */
export const workflowParticipants = (document: WorkflowStateDocument, linkedChildren: readonly string[], scopeThreads: ReadonlyMap<string, ParticipantScopeThread>,
  coverage: ReadonlyMap<string, ParticipantCoverageOwner>): WorkflowProgressParticipant[] => {
  const attempts = occurrenceAttempts(document.returns ?? []);
  const names = planNodeNames(document.plan);
  const replacedBy = new Map<string, Set<string>>();
  for (const item of document.returns ?? []) if (item.state === "applied") for (const run of item.retiredRuns)
    if (run.kind === "thread") for (const nodeId of item.regionNodeIds) replacedBy.set(run.threadId, new Set([...replacedBy.get(run.threadId) ?? [], nodeId]));
  const roles = new Map<string, WorkflowProgressParticipant["roles"][number][]>();
  for (const node of planEntities(document.plan)) for (const threadId of node.contributorThreadIds)
    roles.set(threadId, [...roles.get(threadId) ?? [], {nodeId: node.nodeId, nodeName: node.name, attempt: attempts.get(node.nodeId) ?? 1,
      retired: replacedBy.get(threadId)?.has(node.nodeId) ?? false}]);
  const nativeRow = (threadId: string): WorkflowProgressParticipant => {
    const thread = scopeThreads.get(threadId);
    return {id: threadId, source: "native", kind: "native_child", handle: threadId, environmentId: null, threadId, contributionId: null, revision: null,
      roles: roles.get(threadId) ?? [], owner: ownerOf(coverage.get(threadId)), lifecycle: thread?.lifecycle ?? "unknown", reportedState: null,
      completion: thread?.lifecycle === "completed" ? "native_completed" : "none", coverage: thread ? "native" : "unknown",
      currentReceipt: null, priorReceipts: 0, settlement: "not_evaluated"};
  };
  const native = [...new Set([...roles.keys(), ...linkedChildren])].map(nativeRow);
  const declared = document.contributions.map((contribution): WorkflowProgressParticipant => {
    const participant = contribution.participant ?? null;
    const attempt = attempts.get(contribution.nodeId) ?? 1;
    const receipts = document.evidence.filter(item => item.kind === "observation" && item.participant?.contributionId === contribution.contributionId)
      .sort((left, right) => right.recordedAt - left.recordedAt);
    const current = receipts.filter(item => item.participant!.revision === contribution.revision && item.participant!.attempt === attempt &&
      participantDigest(item.participant!.participant) === participantDigest(participant));
    const latest = current[0];
    const threadId = participant?.kind === "t3_conversation" ? participant.threadId : null;
    const thread = threadId ? scopeThreads.get(threadId) : undefined;
    const coverageState: ParticipantCoverageState = thread ? "native" : latest?.participant!.receipt.kind === "read" ? "supervisor_observed"
      : latest?.participant!.receipt.kind === "lifecycle" ? "lifecycle_only" : latest?.participant!.receipt.kind === "unsupported" ? "unsupported"
      : participant ? "reported" : "unknown";
    return {id: `contribution:${contribution.contributionId}`, source: "declared",
      kind: participant?.kind ?? "unknown", handle: participant?.kind === "t3_conversation" ? participant.threadId : participant?.kind === "external" ? participant.ref : null,
      environmentId: participant?.kind === "t3_conversation" ? participant.environmentId : null, threadId, contributionId: contribution.contributionId,
      revision: contribution.revision, roles: [{nodeId: contribution.nodeId, nodeName: contributionNodeName(document, contribution.nodeId, names), attempt, retired: false}],
      owner: "root", lifecycle: thread?.lifecycle ?? "reported", reportedState: contribution.state,
      completion: contribution.state === "withdrawn" ? "withdrawn" : contribution.state === "result"
        ? contribution.assessment?.decision === "accepted" ? "accepted" : contribution.assessment?.decision === "needs_more" ? "needs_more" : "result_reported" : "none",
      coverage: coverageState,
      currentReceipt: latest ? {kind: latest.participant!.receipt.kind, recordedAt: latest.recordedAt, actorSupervisorThreadId: latest.actorSupervisorThreadId,
        sourceItemId: latest.sourceItemId ?? null, toolName: latest.participant!.receipt.toolName, evidenceId: latest.id} : null,
      priorReceipts: receipts.length - current.length, settlement: "not_evaluated"};
  });
  return [...native, ...declared];
};

/**
 * The attempt of every occurrence a return can repeat: attempt 1 is explicit inside each return's region, and an applied return adds one
 * for each occurrence its region holds, so attempts only ever grow; a nested budget reset changes no attempt, and occurrences outside every
 * region are listed nowhere.
 */
export const returnableAttempts = (document: Pick<WorkflowStateDocument, "plan" | "returns">): Map<string, number> => {
  const attempts = new Map<string, number>();
  if (document.plan) for (const backTo of planBackTos(document.plan)) {
    const resolved = resolveBackTo(document.plan, backTo.nodeId);
    if (resolved.ok) for (const nodeId of resolved.regionNodeIds) attempts.set(nodeId, 1);
  }
  for (const [nodeId, attempt] of occurrenceAttempts(document.returns ?? [])) attempts.set(nodeId, Math.max(attempts.get(nodeId) ?? 1, attempt));
  return attempts;
};

export const progressWorkflow = (document: WorkflowStateDocument, parentNodeReferences: readonly ParentNodeReference[]): WorkflowProgressWorkflow => ({
  workflowId: document.workflowId,
  projectId: document.projectId,
  mainThreadId: document.mainThreadId,
  threadId: document.threadId,
  parentThreadId: document.parentThreadId,
  revision: document.revision,
  status: document.status,
  assessment: workflowAssessment(document),
  objective: document.objective,
  plan: document.plan,
  acceptedProposalId: currentAcceptedProposalId(document),
  updatedAt: document.updatedAt,
  parentNodeReferences: [...parentNodeReferences],
  history: progressHistory(document),
  historyComplete: true,
  observations: currentAttemptObservations(document)
    .sort((left, right) => right.recordedAt - left.recordedAt).slice(0, 20).map(item => ({
      id: item.id,
      // a not-applicable assessment from an earlier task scope stays as history, not as a current disposition
      kind: item.kind === "not_applicable" && item.scopeRevision !== document.sourceBinding?.sourceHash ? "note"
        : item.kind as "status_changed" | "note" | "observation" | "not_applicable",
      recordedAt: item.recordedAt,
      targetNodeId: item.targetNodeId,
      targetNodeName: item.targetNodeName,
      statusFrom: item.statusFrom,
      statusTo: item.statusTo,
      sourceThreadId: item.sourceThreadId,
      sourceRunId: item.sourceRunId,
      sourceMessageId: item.sourceMessageId,
      sourceItemId: (item as WorkflowStateEvidence & {sourceItemId?: string | null}).sourceItemId ?? null,
      note: item.note,
    })),
  contributions: progressContributions(document),
  branchSelections: progressBranchSelections(document),
  branchEvents: progressBranchEvents(document),
  completions: progressCompletions(document),
  notApplicable: [...notApplicableSubtrees(document.plan, effectiveBranchSelections(document.plan, document.branchSelections ?? []),
    notApplicableNodeIds(document.evidence, document.sourceBinding?.sourceHash ?? null))],
  returns: progressReturns(document),
  attempts: [...returnableAttempts(document)].map(([nodeId, attempt]) => ({nodeId, attempt})),
});
