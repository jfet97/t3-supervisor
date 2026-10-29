import assert from "node:assert/strict";
import {it} from "@effect/vitest";
import type {WorkflowPlanGroupInfo, WorkflowPlanNodeInfo} from "../src/project-supervisor-contract.js";
import {proposalContextFromDefinitions, validateWorkflowPlan} from "../src/supervisor-workflow.js";
import type {RunInfo} from "../src/types.js";
import type {WorkflowExecutionStatus, WorkflowReturn, WorkflowStateDocument} from "../src/workflow-state-contract.js";
import {agreedWorkUnfinished, explicitWaitRecorded, latestExecutedRun, livenessWakeKey, returnWaiting, sameLivenessKey} from "../src/workflow-liveness.js";
import {effectiveIndex, indexSource, projectIndex} from "./project-definitions-fixture.js";

// the pure liveness reads shared by the lifecycle's standby decision and the conversation's fallback wake

const context = proposalContextFromDefinitions({
  projectId: "project-a", threadId: "main-a", workspaceRoot: "/workspace/project-a", globalOnly: false, globalRevision: null, revision: "definitions-1",
  editingAvailable: true, status: "ready", steps: [], workflows: [], config: effectiveIndex({steps: [], workflows: []}, []),
  projectConfig: projectIndex({steps: [], workflows: [], required: []}), definitionFiles: [], complete: true,
  sources: [{path: ".t3-supervisor/project.yaml", content: indexSource({steps: [], workflows: [], required: []}), origin: "project"}], issues: [],
});
const local = (id: string) => ({kind: "step", definitionId: null, localId: id, name: id, description: `Complete ${id}.`, reason: `The task needs ${id}.`});
const planOf = (statuses: Record<string, WorkflowExecutionStatus>): WorkflowPlanGroupInfo => {
  const validated = validateWorkflowPlan({requirements: [], plan: {kind: "sequence", nodes: Object.keys(statuses).map(local)}}, context);
  assert.ok(validated?.plan);
  const visit = (node: WorkflowPlanNodeInfo): WorkflowPlanNodeInfo => node.kind === "step" && node.localId !== null ? {...node, status: statuses[node.localId] ?? node.status} : node;
  return {...validated.plan, nodes: validated.plan.nodes.map(visit)};
};
const pendingReturn = {returnId: "return-1", backToNodeId: "back", targetNodeId: "target", regionNodeIds: ["target"], attempt: 1, state: "pending", reason: "Findings remain.",
  sourceThreadId: null, sourceRunId: null, sourceMessageId: null, requestedAt: 1, resolvedAt: null, closed: null, closedSelections: null, retiredRuns: [], resolution: null} satisfies WorkflowReturn;
const document = (status: WorkflowExecutionStatus, plan: WorkflowPlanGroupInfo | null, returns: WorkflowReturn[] = []) =>
  ({status, plan, returns, branchSelections: [], evidence: [], sourceBinding: null}) satisfies Pick<WorkflowStateDocument, "returns" | "status" | "plan" | "branchSelections" | "evidence" | "sourceBinding">;

it("agreed work is unfinished while a return waits, the document is not completed or an applicable member is unsettled", () => {
  assert.equal(returnWaiting(document("underway", null, [pendingReturn])), true);
  assert.equal(returnWaiting(document("underway", null, [{...pendingReturn, state: "dismissed", resolvedAt: 2}])), false);
  assert.equal(agreedWorkUnfinished(document("completed", planOf({a: "completed"}), [pendingReturn])), true, "a waiting return is the root's unfinished work");
  assert.equal(agreedWorkUnfinished(document("underway", planOf({a: "completed"}))), true, "the document's own status is not completed");
  assert.equal(agreedWorkUnfinished(document("completed", planOf({a: "completed", b: "planned"}))), true, "a planned member stays unfinished");
  assert.equal(agreedWorkUnfinished(document("completed", planOf({a: "completed", b: "underway"}))), true);
  assert.equal(agreedWorkUnfinished(document("completed", planOf({a: "completed", b: "completed"}))), false);
  assert.equal(agreedWorkUnfinished(document("completed", null)), false, "a completed document without a plan has nothing open");
});

it("an explicit wait counts only when confirmed, naming who acts next, pinned to the task and recorded after the main's run finished", () => {
  const wait = {state: "confirmed" as const, wait: {waitingOn: "external" as const, resumesWhen: "The upstream release is published."}, recordedAt: 1_000};
  assert.equal(explicitWaitRecorded(wait, true, 900), true);
  assert.equal(explicitWaitRecorded(wait, true, 1_000), true, "recorded in the same instant the run finished");
  assert.equal(explicitWaitRecorded(wait, true, 1_001), false, "a wait from before the latest run is history");
  assert.equal(explicitWaitRecorded(wait, false, 900), false, "a wait pinned to another task revision does not count");
  assert.equal(explicitWaitRecorded({...wait, state: "recorded"}, true, 900), false, "an unconfirmed outcome is no standby");
  assert.equal(explicitWaitRecorded({...wait, state: "unconfirmed"}, true, 900), false);
  assert.equal(explicitWaitRecorded({state: "confirmed", recordedAt: 1_000}, true, 900), false, "needs_attention without a wait is not standby");
  assert.equal(explicitWaitRecorded(wait, true, Number.NaN), false, "an unknown completion time never counts as covered");
  assert.equal(explicitWaitRecorded(undefined, true, 900), false);
});

it("the latest executed run skips a queued request cancelled before it started and keeps a cancelled started one", () => {
  const run = (id: string, ordinal: number, status: string, startedAt: string | null): RunInfo =>
    ({id, threadId: "main-a", ordinal, status, requestedAt: "2026-10-13T10:00:00.000Z", startedAt, completedAt: status === "completed" ? "2026-10-13T10:01:00.000Z" : null, rootNodeId: `${id}-root`});
  const executed = run("run-1", 1, "completed", "2026-10-13T10:00:01.000Z");
  const cancelledUnstarted = run("run-2", 2, "cancelled", null);
  assert.equal(latestExecutedRun({runs: [cancelledUnstarted, executed]})?.id, "run-1");
  const cancelledStarted = run("run-3", 3, "cancelled", "2026-10-13T10:02:00.000Z");
  assert.equal(latestExecutedRun({runs: [executed, cancelledUnstarted, cancelledStarted]})?.id, "run-3", "a run that started executed something");
  assert.equal(latestExecutedRun({runs: []}), undefined);
});

it("a liveness wake key names the main's run, the document revision and the terminal child lifecycle its parent reports", () => {
  const key = livenessWakeKey("main-a", "run-7", 12, [{childThreadId: "reviewer", status: "completed"}, {childThreadId: "helper", status: "running"},
    {childThreadId: "scanner", status: "failed"}, {childThreadId: 42, status: "completed"}, {status: "completed"}]);
  assert.deepEqual(key, {mainThreadId: "main-a", runId: "run-7", revision: 12, children: ["reviewer:completed", "scanner:failed"]});
  assert.deepEqual(livenessWakeKey("main-a", "run-7", 12, undefined).children, []);
  assert.equal(sameLivenessKey(key, livenessWakeKey("main-a", "run-7", 12, [{childThreadId: "scanner", status: "failed"}, {childThreadId: "reviewer", status: "completed"}])), true, "order of the reported children does not matter");
  assert.equal(sameLivenessKey(key, livenessWakeKey("main-a", "run-7", 13, [{childThreadId: "reviewer", status: "completed"}, {childThreadId: "scanner", status: "failed"}])), false, "a new document revision is a new key");
  assert.equal(sameLivenessKey(key, livenessWakeKey("main-a", "run-8", 12, [{childThreadId: "reviewer", status: "completed"}, {childThreadId: "scanner", status: "failed"}])), false, "a new main run is a new key");
  assert.equal(sameLivenessKey(key, livenessWakeKey("main-a", "run-7", 12, [{childThreadId: "reviewer", status: "completed"}])), false, "a child that ended is a new key");
});
