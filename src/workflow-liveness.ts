import type { ReviewOutcomeRecord } from "./supervisor-conversation-store.js";
import type { Projection, RunInfo } from "./types.js";
import { notApplicableNodeIds, unsettledOccurrences } from "./workflow-plan-tree.js";
import type { WorkflowStateDocument } from "./workflow-state-contract.js";
import { documentBranchSelections } from "./workflow-state-store.js";

// the liveness of agreed work, shared by the lifecycle's standby decision and the conversation's fallback wake: pure reads of a
// workflow document, a main projection and the latest pinned review

/** A return the Supervisor still has to apply: the next attempt waits on the root, not on the operative. */
export const returnWaiting = (document: Pick<WorkflowStateDocument, "returns">): boolean => document.returns.some(item => item.state === "pending");

/**
 * Whether the agreed work of a document is unfinished: a return waits, the document is not completed, or an applicable member is
 * still unsettled under the current selections.
 */
export const agreedWorkUnfinished = (document: Pick<WorkflowStateDocument, "returns" | "status" | "plan" | "branchSelections" | "evidence" | "sourceBinding">): boolean => {
  if (returnWaiting(document)) return true;
  if (document.status !== "completed") return true;
  return unsettledOccurrences(document.plan, documentBranchSelections(document),
    notApplicableNodeIds(document.evidence, document.sourceBinding?.sourceHash ?? null)).length > 0;
};

/** The node ids of the applicable occurrences still unsettled under the current selections: what a liveness wake is about. */
export const unsettledNodeIds = (document: Pick<WorkflowStateDocument, "plan" | "branchSelections" | "evidence" | "sourceBinding">): string[] =>
  unsettledOccurrences(document.plan, documentBranchSelections(document), notApplicableNodeIds(document.evidence, document.sourceBinding?.sourceHash ?? null))
    .map(node => node.nodeId);

/**
 * Whether a confirmed review outcome records a current explicit wait for a task: it names who acts next, it is pinned to the task's
 * revision and it was recorded after the main's latest run finished; an earlier or unpinned wait is history.
 */
export const explicitWaitRecorded = (outcome: Pick<ReviewOutcomeRecord, "state" | "wait" | "recordedAt"> | undefined, pinnedToTask: boolean,
  mainFinishedAt: number): boolean =>
  outcome?.state === "confirmed" && outcome.wait !== undefined && pinnedToTask && Number.isFinite(mainFinishedAt) && outcome.recordedAt >= mainFinishedAt;

/** The main's latest executed run: a queued request cancelled before it started executed nothing. */
export const latestExecutedRun = (projection: Pick<Projection, "runs">): RunInfo | undefined =>
  [...projection.runs].filter(run => !(run.status === "cancelled" && !run.startedAt)).sort((left, right) => right.ordinal - left.ordinal)[0];

const terminalChildStatuses = new Set(["completed", "failed", "interrupted", "cancelled", "resolved", "expired"]);

/** The identity one liveness wake answers: the main, its latest completed run, the document revision and the terminal lifecycle of its native children. */
export type LivenessWakeKey = {mainThreadId: string; runId: string; revision: number; children: string[]};

/**
 * The liveness wake key of a main: its latest completed run, the document revision and the terminal native child lifecycle its own
 * projection reports (the direct parent is the source of a native child's lifecycle), so a child that ends while the main is idle
 * re-arms exactly one wake.
 */
export const livenessWakeKey = (mainThreadId: string, runId: string, revision: number, subagents: ReadonlyArray<Record<string, unknown>> | undefined): LivenessWakeKey => ({
  mainThreadId, runId, revision,
  children: (subagents ?? []).flatMap(child => typeof child.childThreadId === "string" && typeof child.status === "string" && terminalChildStatuses.has(child.status)
    ? [`${child.childThreadId}:${child.status}`] : []).sort(),
});

export const sameLivenessKey = (left: LivenessWakeKey, right: LivenessWakeKey): boolean =>
  left.mainThreadId === right.mainThreadId && left.runId === right.runId && left.revision === right.revision &&
  left.children.length === right.children.length && left.children.every((child, index) => child === right.children[index]);
