import assert from "node:assert/strict";
import {it} from "@effect/vitest";
import {Effect} from "effect";
import {TestClock} from "effect/testing";
import type {ProjectDefinitionSnapshot} from "../src/project-definitions-contract.js";
import type {WorkflowPlanGroupInfo, WorkflowPlanNodeInfo, WorkflowProposalInfo} from "../src/project-supervisor-contract.js";
import {canonicalizeProposalDraft, proposalContextFromDefinitions} from "../src/supervisor-workflow.js";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {renderPlan, workflowIntroductionText, workflowProposalText} from "../src/supervisor-conversation.js";
import {planNodeAtPointer, withOmissions} from "../src/workflow-plan-tree.js";
import {progressWorkflow} from "../src/workflow-progress.js";
import {notApplicableNodeIds} from "../src/workflow-state-store.js";
import {currentBranchPaths, liveProgress, PlanJourney} from "../ui/src/workflow-journey.js";
import type {WorkflowApplyPatch} from "../src/workflow-write-controller.js";
import {testSummary} from "./project-definitions-fixture.js";
import {
  applyArgs, ensureArgs, installEvidence, locator, localStep, makeFixture, planEntities, proposalForDefinitions, replaceCurrentProposal,
  sequencePlan, snapshotWith, thread, type WwcFixture,
} from "./support/wwc-fixture.js";

// a delivery catalog shaped like the incident's: a flexible change sequence whose fixed review chooses single or paired review
// descriptions of realistic length: the full document carries them, the status view does not
const contract = (name: string) => `${name}. ${"Read the applicable guidance, apply the documented constraints, record evidence that can really fail and state any limit. ".repeat(5)}`;
const step = (id: string, name: string) => ({id, name, description: contract(name), references: ["AGENTS.md", "wiki/how-we-build.md"], summary: testSummary(id), origin: "project" as const,
  path: `.t3-supervisor/steps/${id}.md`, sourceId: `project:${id}`});
const workflow = (id: string, name: string, fixed: boolean, body: Record<string, unknown>) => ({id, name, description: contract(name), summary: testSummary(id),
  fixed, ...body, origin: "project" as const, path: `.t3-supervisor/workflows/${id}.yaml`, sourceId: `project:${id}`});
const catalog = (base: ProjectDefinitionSnapshot): ProjectDefinitionSnapshot => snapshotWith(base, [
  step("scope-and-authority", "Scope and authority"), step("gather-evidence", "Gather source evidence"), step("design-approach", "Design the approach"),
  step("data-and-rollout", "Data and rollout plan"), step("implement-in-scope", "Implement within scope"), step("prevent-recurrence", "Prevent recurrence"),
  step("verify-behavior", "Verify behavior"), step("review-correctness", "Correctness review"), step("review-fit", "Fit and simplicity review"),
  step("account-for-findings", "Account for findings"), step("finalize", "Finalize"),
], [
  workflow("change", "Change", false, {sequence: [{step: "scope-and-authority"}, {step: "gather-evidence"}, {step: "design-approach"}, {step: "data-and-rollout"},
    {step: "implement-in-scope"}, {step: "prevent-recurrence"}, {step: "verify-behavior"}, {workflow: "review"}, {step: "finalize"}]}),
  workflow("review", "Review", true, {sequence: [{branch: {if: "The frozen artifact is a contained, low-risk change.", then: [{workflow: "single-review"}],
    else: [{workflow: "paired-review"}]}}, {step: "account-for-findings"}]}),
  workflow("single-review", "Single review", true, {parallel: [{step: "review-correctness"}, {step: "review-fit"}]}),
  workflow("paired-review", "Paired review", true, {parallel: [{step: "review-correctness"}, {step: "review-fit"}]}),
  // a fixed release whose fixed review and flexible hotfix may not apply to a task
  workflow("hotfix", "Hotfix", false, {sequence: [{step: "implement-in-scope"}, {step: "prevent-recurrence"}]}),
  workflow("release", "Release", true, {sequence: [{step: "verify-behavior"}, {workflow: "review"}, {workflow: "hotfix"}, {step: "finalize"}]}),
]);

type Fixture = WwcFixture & {workflowId: string};
const changeOf = (plan: WorkflowPlanGroupInfo | null) => planEntities(plan).find((node): node is Extract<WorkflowPlanNodeInfo, {kind: "workflow"}> =>
  node.kind === "workflow" && node.definitionId === "change")!;
const occurrence = (fixture: Fixture, definitionId: string, index = 0) => Effect.map(fixture.workflows.get(fixture.projectId, fixture.mainThreadId),
  (document) => planEntities(document!.plan).filter(node => node.definitionId === definitionId)[index]!);
const current = (fixture: Fixture) => Effect.map(fixture.workflows.get(fixture.projectId, fixture.mainThreadId), document => document!);
const write = (fixture: Fixture, input: Omit<WorkflowApplyPatch, "workflowId" | "expectedRevision"> & {expectedRevision?: number}) => Effect.gen(function* () {
  const args = yield* applyArgs(fixture, {workflowId: fixture.workflowId, expectedRevision: input.expectedRevision ?? (yield* current(fixture)).revision, ...input});
  installEvidence(fixture, args);
  return {result: yield* fixture.controller.write(args), bytes: Buffer.byteLength(JSON.stringify(args), "utf8")};
});
// explicit status edits with one status_changed record per changed occurrence and, when given, the task's own status
const statusEdit = (fixture: Fixture, operationId: string, edits: ReadonlyArray<readonly [string, "planned" | "underway" | "completed"]>,
  options: {status?: "underway"; skipEvidenceFor?: string} = {}) => Effect.gen(function* () {
  const statuses = [];
  for (const [definitionId, status] of edits) statuses.push({nodeId: (yield* occurrence(fixture, definitionId)).nodeId, status});
  return yield* write(fixture, {operationId, note: "Reconcile the observed progress.", ...(options.status ? {status: options.status} : {}), statuses,
    evidence: [...(options.status ? [{kind: "status_changed" as const, note: "The task is underway."}] : []),
      ...statuses.filter((_, index) => edits[index]![0] !== options.skipEvidenceFor)
        .map(edit => ({kind: "status_changed" as const, targetNodeId: edit.nodeId, note: `Native activity shows this occurrence ${edit.status}.`}))]});
});

const agreedFixture = (nodes: readonly unknown[]) => Effect.gen(function* () {
  const fixture = yield* makeFixture();
  const definitions = catalog(fixture.definitionReader.current);
  const proposal = proposalForDefinitions(definitions, sequencePlan(nodes));
  yield* replaceCurrentProposal(fixture, "proposal-change", definitions, proposal);
  const ensure = ensureArgs(fixture, "incident-create", "Create the agreed change workflow.");
  installEvidence(fixture, ensure);
  const created = yield* fixture.controller.write(ensure);
  assert.equal(created.status, "created");
  if (created.status !== "created") throw new Error("create failed");
  const seeded = yield* applyArgs(fixture, {operationId: "incident-plan", workflowId: created.workflowId, expectedRevision: created.revision,
    plan: proposal.plan, note: "Seed the agreed plan."});
  installEvidence(fixture, seeded);
  assert.equal((yield* fixture.controller.write(seeded)).status, "applied");
  return Object.assign(fixture, {workflowId: created.workflowId}) as Fixture;
});
const incidentFixture = agreedFixture([{kind: "workflow", definitionId: "change", reason: "The task changes repository behavior."}]);

const coherentRepair = [["change", "underway"], ["scope-and-authority", "completed"], ["gather-evidence", "completed"], ["design-approach", "completed"],
  ["data-and-rollout", "completed"], ["implement-in-scope", "underway"]] as const;

it.effect("parent-only and later-stage writes are rejected atomically while a coherent nested repair is one small apply", () => Effect.gen(function* () {
  const fixture = yield* incidentFixture;
  try {
    const seeded = yield* current(fixture);
    // the incident's first write advanced only the task while every nested occurrence stayed planned
    const parentOnly = yield* write(fixture, {operationId: "parent-only", status: "underway", note: "The workflow is underway.",
      evidence: [{kind: "status_changed", note: "Evidence gathering has begun."}]});
    assert.deepEqual(parentOnly.result, {status: "invalid", operationId: "parent-only", reason: "nested_status_inconsistent", diagnostic: {code: "nested_status_inconsistent",
      path: "/input/status", expected: "enter a workflow or the task together with the member that is actually underway, and enter a member only inside an entered workflow and task."}});

    // the compact status read carries identities and statuses without descriptions, accepted snapshots or history
    const full = yield* fixture.controller.readTool({...locator(fixture), limit: 10});
    const compact = yield* fixture.controller.readTool({...locator(fixture), view: "status"});
    assert.equal(compact.status, "ok");
    assert.ok("view" in compact && compact.view === "status");
    const rows = (compact as {workflows: Array<{occurrences: Array<{name: string; status: string | null; depth: number}>}>}).workflows[0]!.occurrences;
    assert.deepEqual(rows.slice(0, 3).map(row => [row.name, row.status, row.depth]), [["Change", "planned", 0], ["Scope and authority", "planned", 1], ["Gather source evidence", "planned", 1]]);
    assert.ok(JSON.stringify(compact).length * 3 < JSON.stringify(full).length, "the status view is a small fraction of the document read");

    // the incident's reconciliation also started Verify and Finalize ahead of Prevent recurrence and Review: nothing is applied
    const outOfOrder = yield* statusEdit(fixture, "out-of-order", [...coherentRepair, ["verify-behavior", "underway"], ["finalize", "underway"]], {status: "underway"});
    assert.equal(outOfOrder.result.status, "invalid");
    assert.deepEqual("diagnostic" in outOfOrder.result ? [outOfOrder.result.reason, outOfOrder.result.diagnostic?.path] : null, ["sequence_order", "/input/statuses/6/status"]);
    const missing = yield* statusEdit(fixture, "missing-evidence", coherentRepair, {status: "underway", skipEvidenceFor: "design-approach"});
    assert.deepEqual("diagnostic" in missing.result ? [missing.result.reason, missing.result.diagnostic?.path] : null,
      ["missing_status_changed_evidence", "/input/statuses/3/status"]);
    assert.equal((yield* current(fixture)).revision, seeded.revision, "rejected edits change nothing");

    const taskPlanned = yield* statusEdit(fixture, "repair-task-planned", coherentRepair);
    assert.deepEqual("diagnostic" in taskPlanned.result ? [taskPlanned.result.reason, taskPlanned.result.diagnostic?.path] : null,
      ["nested_status_inconsistent", "/input/status"], "members are entered only inside an entered task");
    const repaired = yield* statusEdit(fixture, "coherent-repair", coherentRepair, {status: "underway"});
    assert.equal(repaired.result.status, "applied", JSON.stringify(repaired.result));
    assert.ok(repaired.bytes < 4_000, `the status edit stays small: ${repaired.bytes} bytes`);
    assert.ok(JSON.stringify(seeded.plan).length > 5 * repaired.bytes, "no plan is retransmitted");
    const after = yield* current(fixture);
    assert.equal(after.revision, seeded.revision + 1);
    assert.deepEqual(planEntities(changeOf(after.plan).plan).filter(node => node.status !== "planned").map(node => [node.name, node.status]),
      [["Scope and authority", "completed"], ["Gather source evidence", "completed"], ["Design the approach", "completed"], ["Data and rollout plan", "completed"],
        ["Implement within scope", "underway"]]);

    // an early draft pull request and a failing diagnostic run are observations on later members, which stay planned
    const finalize = yield* occurrence(fixture, "finalize");
    const verify = yield* occurrence(fixture, "verify-behavior");
    const observed = yield* write(fixture, {operationId: "early-evidence", note: "Record supporting work without entering later stages.", evidence: [
      {kind: "observation", targetNodeId: finalize.nodeId, note: "A draft pull request is open as preparation."},
      {kind: "observation", targetNodeId: verify.nodeId, note: "A focused browser run failed during implementation and is diagnostic evidence."}]});
    assert.equal(observed.result.status, "applied", JSON.stringify(observed.result));
    assert.deepEqual([(yield* occurrence(fixture, "finalize")).status, (yield* occurrence(fixture, "verify-behavior")).status], ["planned", "planned"]);
    for (const [operationId, definitionId] of [["finalize-early", "finalize"], ["verify-early", "verify-behavior"], ["prevent-as-not-applicable", "prevent-recurrence"]] as const) {
      const early = yield* statusEdit(fixture, operationId, [[definitionId, definitionId === "prevent-recurrence" ? "completed" : "underway"]]);
      assert.equal("diagnostic" in early.result ? early.result.diagnostic?.code : early.result.status, "sequence_order", operationId);
    }

    // a status_changed assertion without a change claims no progress
    const implement = yield* occurrence(fixture, "implement-in-scope");
    const noOp = yield* write(fixture, {operationId: "no-op-status", note: "Implementation continues.",
      evidence: [{kind: "status_changed", targetNodeId: implement.nodeId, note: "Implementation is still underway."}]});
    assert.deepEqual("diagnostic" in noOp.result ? [noOp.result.reason, noOp.result.diagnostic?.path] : null, ["status_unchanged", "/input/evidence/0"]);
  } finally {yield* fixture.close;}
}));

it.effect("a not-applicable flexible member is omitted only after negotiation and stays visible, while fixed members keep their duties", () => Effect.gen(function* () {
  const fixture = yield* incidentFixture;
  try {
    assert.equal((yield* statusEdit(fixture, "repair", coherentRepair, {status: "underway"})).result.status, "applied");
    const prevent = yield* occurrence(fixture, "prevent-recurrence");
    const unnegotiated = yield* write(fixture, {operationId: "omit-unnegotiated", note: "Omit prevention.", omit: [{nodeId: prevent.nodeId, reason: "No defect was exposed."}]});
    assert.equal("diagnostic" in unnegotiated.result ? unnegotiated.result.diagnostic?.code : unnegotiated.result.status, "omission_not_negotiated");
    const account = yield* occurrence(fixture, "account-for-findings");
    const fixedMember = yield* write(fixture, {operationId: "omit-fixed", note: "Omit accounting.", omit: [{nodeId: account.nodeId, reason: "Not needed."}]});
    assert.deepEqual("diagnostic" in fixedMember.result ? [fixedMember.result.diagnostic?.code, fixedMember.result.diagnostic?.path] : null,
      ["omission_not_allowed", "/input/omit/0"]);

    // the revised proposal names the member; the service derives its provenance and keeps it visible as not applicable
    const definitions = fixture.definitionReader.current;
    const context = proposalContextFromDefinitions(definitions);
    const draft = canonicalizeProposalDraft({requirements: [], plan: {kind: "sequence", nodes: [{kind: "workflow", definitionId: "change", reason: "The task changes repository behavior.",
      omit: [{member: "prevent-recurrence", reason: "Ordinary feature work; no defect or correction exposed a gap."}]}]}}, context, "revised");
    assert.ok(draft.ok, JSON.stringify(draft));
    if (!draft.ok) return;
    assert.deepEqual(changeOf(draft.workflow.plan).omissions.map(item => [item.id, item.name, item.reason]),
      [["prevent-recurrence", "Prevent recurrence", "Ordinary feature work; no defect or correction exposed a gap."]]);
    assert.match(renderPlan(draft.workflow.plan).join("\n"), /not applicable: Prevent recurrence — Ordinary feature work/u);
    const revised: WorkflowProposalInfo = {status: "proposed", message: "A revised proposal.", workspaceRoot: definitions.workspaceRoot, revision: definitions.revision,
      globalRevision: definitions.globalRevision ?? null, ...draft.workflow};
    yield* replaceCurrentProposal(fixture, "proposal-change-revised", definitions, revised);
    // a published proposal is not yet agreed: the omission waits for the operative's acceptance of that exact proposal
    const proposedOnly = yield* write(fixture, {operationId: "omit-proposed-only", note: "Apply the proposed omission.",
      omit: [{nodeId: prevent.nodeId, reason: "Ordinary feature work; no defect or correction exposed a gap."}]});
    assert.equal("diagnostic" in proposedOnly.result ? proposedOnly.result.diagnostic?.code : proposedOnly.result.status, "omission_not_negotiated");
    const task = (yield* fixture.supervisors.task(fixture.mainThreadId))!;
    yield* fixture.supervisors.saveTask({...task, agreementSourceHash: fixture.sourceBinding.sourceHash, agreement: {status: "agreed", message: "Accepted.",
      proposalId: "proposal-change-revised", agreedAt: 1, evidence: {kind: "supervisor_message", messageId: "supervisor-message"}, agentMessageId: "agent-message", workflow: revised}});
    const implementing = yield* occurrence(fixture, "implement-in-scope");
    const started = yield* write(fixture, {operationId: "omit-started", note: "Omit started work.", omit: [{nodeId: implementing.nodeId, reason: "Not needed."}]});
    assert.deepEqual("diagnostic" in started.result ? [started.result.diagnostic?.code, started.result.diagnostic?.path] : null, ["omission_not_allowed", "/input/omit/0"],
      "recorded progress is never omitted");

    // an open member named by a rejected apply that also omits an earlier sibling is located in the current document
    const reviewBranch = ((yield* occurrence(fixture, "review")) as Extract<WorkflowPlanNodeInfo, {kind: "workflow"}>).plan!.nodes[0]!;
    assert.equal((yield* fixture.workflows.recordBranchSelection(fixture.owner, {nodeId: (reviewBranch as {nodeId: string}).nodeId, revision: 1, path: "then",
      reason: "Contained change.", sourceThreadId: fixture.mainThreadId, sourceRunId: "main-run", sourceMessageId: "main-selection",
      sourceCreatedAt: Date.parse("2100-01-01T00:00:00Z")})).status, "applied");
    const changeNode = yield* occurrence(fixture, "change");
    const combined = (yield* write(fixture, {operationId: "omit-and-complete", note: "Omit prevention and complete the change.",
      omit: [{nodeId: prevent.nodeId, reason: "Ordinary feature work; no defect or correction exposed a gap."}],
      statuses: [{nodeId: implementing.nodeId, status: "completed"}, {nodeId: changeNode.nodeId, status: "completed"}],
      evidence: [implementing, changeNode].map(node => ({kind: "status_changed" as const, targetNodeId: node.nodeId, note: "Done."}))})).result;
    const culprit = "diagnostic" in combined ? combined.diagnostic?.path ?? "" : "";
    assert.equal("diagnostic" in combined ? combined.diagnostic?.code : combined.status, "completion_unfinished");
    assert.equal((planNodeAtPointer((yield* current(fixture)).plan, culprit.replace(/^\/current/u, "")) as {nodeId?: string} | null)?.nodeId,
      (yield* occurrence(fixture, "verify-behavior")).nodeId, `${culprit} names the open Verify behavior in the current plan`);

    const before = yield* current(fixture);
    const omitted = yield* write(fixture, {operationId: "omit-negotiated", note: "Apply the agreed omission.",
      omit: [{nodeId: prevent.nodeId, reason: "Ordinary feature work; no defect or correction exposed a gap."}]});
    assert.equal(omitted.result.status, "applied", JSON.stringify(omitted.result));
    const after = yield* current(fixture);
    const change = changeOf(after.plan);
    assert.deepEqual(change.omissions.map(item => [item.id, item.reason]), [["prevent-recurrence", "Ordinary feature work; no defect or correction exposed a gap."]]);
    assert.equal(planEntities(after.plan).some(node => node.nodeId === prevent.nodeId), false, "the omission is not recorded as completed work");
    assert.deepEqual(planEntities(after.plan).map(node => [node.nodeId, node.status]),
      planEntities(before.plan).filter(node => node.nodeId !== prevent.nodeId).map(node => [node.nodeId, node.status]), "every other occurrence keeps its identity and status");
    const status = yield* fixture.controller.readTool({...locator(fixture), view: "status"});
    assert.match(JSON.stringify(status), /"omitted":\[\{"id":"prevent-recurrence","name":"Prevent recurrence","reason":"Ordinary feature work/u);

    // the omitted member no longer precedes verification, and fixed workflows reject an omission in drafts as well
    assert.equal((yield* statusEdit(fixture, "implement-done", [["implement-in-scope", "completed"], ["verify-behavior", "underway"]])).result.status, "applied");
    const fixedDraft = canonicalizeProposalDraft({requirements: [], plan: {kind: "sequence", nodes: [{kind: "workflow", definitionId: "review", reason: "Review.",
      omit: [{member: "account-for-findings", reason: "Not needed."}]}]}}, context, "fixed");
    assert.deepEqual(fixedDraft.ok ? null : [fixedDraft.code, fixedDraft.path], ["omission_owner_fixed", "/draft/plan/nodes/0/omit"]);
  } finally {yield* fixture.close;}
}));

it.effect("dependency review is linked child work during implementation while the main Review waits, and lanes, rework and rounds stay free", () => Effect.gen(function* () {
  const fixture = yield* incidentFixture;
  try {
    assert.equal((yield* statusEdit(fixture, "repair", coherentRepair, {status: "underway"})).result.status, "applied");
    // a native reviewer of a separately frozen library change is linked as its own workflow and contributes to Implementation
    const reviewer = thread("library-reviewer", fixture.projectId, fixture.mainThreadId, "subagent", fixture.mainThreadId);
    fixture.threads.push(reviewer);
    const link = {action: "link_child", ...locator(fixture), operationId: "link-library-reviewer", childThreadId: reviewer.id, note: "Review the frozen library change."};
    installEvidence(fixture, link);
    assert.equal((yield* fixture.controller.write(link)).status, "created");
    const child = (yield* fixture.workflows.get(fixture.projectId, fixture.mainThreadId, reviewer.id))!;
    const childPlan = yield* applyArgs(fixture, {operationId: "library-review-plan", workflowId: child.workflowId, expectedRevision: child.revision,
      plan: sequencePlan([localStep("Review library change", "Review the frozen library head against its actual base.", [reviewer.id])]), note: "Plan the dependency review."});
    installEvidence(fixture, childPlan);
    assert.equal((yield* fixture.controller.write(childPlan)).status, "applied");
    const childStep = planEntities((yield* fixture.workflows.get(fixture.projectId, fixture.mainThreadId, reviewer.id))!.plan)[0]!;
    const childStart = yield* applyArgs(fixture, {operationId: "library-review-start", workflowId: child.workflowId,
      expectedRevision: (yield* fixture.workflows.get(fixture.projectId, fixture.mainThreadId, reviewer.id))!.revision, status: "underway",
      statuses: [{nodeId: childStep.nodeId, status: "underway"}], note: "The dependency review is running.",
      evidence: [{kind: "status_changed", note: "The child review started."}, {kind: "status_changed", targetNodeId: childStep.nodeId, note: "The reviewer is reading the frozen head."}]});
    installEvidence(fixture, childStart);
    assert.equal((yield* fixture.controller.write(childStart)).status, "applied", "the dependency review is not gated by the main sequence");
    const withContributor = (yield* current(fixture)).plan!;
    const implement = yield* occurrence(fixture, "implement-in-scope");
    const mapped = JSON.parse(JSON.stringify(withContributor), (_key, value: unknown) =>
      value && typeof value === "object" && (value as {nodeId?: string}).nodeId === implement.nodeId ? {...value, contributorThreadIds: [reviewer.id]} : value) as WorkflowPlanGroupInfo;
    assert.equal((yield* write(fixture, {operationId: "associate-reviewer", plan: mapped, note: "The dependency review supports Implementation."})).result.status, "applied");

    // the main Review cannot start while Implementation and the later checks are open, whichever way the start is recorded
    const paired = yield* occurrence(fixture, "review-correctness", 1);
    const undecided = yield* write(fixture, {operationId: "main-review-undecided", note: "Start the main review.", statuses: [{nodeId: paired.nodeId, status: "underway"}],
      evidence: [{kind: "status_changed", targetNodeId: paired.nodeId, note: "Started."}]});
    assert.equal("diagnostic" in undecided.result ? undecided.result.diagnostic?.code : undecided.result.status, "branch_decision_pending");
    const review = planEntities((yield* current(fixture)).plan).find((node): node is Extract<WorkflowPlanNodeInfo, {kind: "workflow"}> =>
      node.kind === "workflow" && node.definitionId === "review")!;
    const reviewBranch = (review.plan!.nodes[0] as Extract<WorkflowPlanNodeInfo, {kind: "branch"}>);
    assert.equal((yield* fixture.workflows.recordBranchSelection(fixture.owner, {nodeId: reviewBranch.nodeId, revision: 1, path: "else", reason: "Customer-facing behavior changed.",
      sourceThreadId: fixture.mainThreadId, sourceRunId: "main-run", sourceMessageId: "main-selection", sourceCreatedAt: Date.parse("2100-01-01T00:00:00Z")})).status, "applied");
    const stepOnly = (operationId: string) => write(fixture, {operationId, note: "Start the main review.", statuses: [{nodeId: paired.nodeId, status: "underway"}],
      evidence: [{kind: "status_changed", targetNodeId: paired.nodeId, note: "Started."}]});
    const early = yield* stepOnly("main-review-step-early");
    assert.equal("diagnostic" in early.result ? early.result.diagnostic?.code : early.result.status, "sequence_order");
    const pairedWorkflow = planEntities((yield* current(fixture)).plan).find(node => node.kind === "workflow" && node.definitionId === "paired-review")!;
    const fit = yield* occurrence(fixture, "review-fit", 1);
    const reviewLanes = (operationId: string) => write(fixture, {operationId, note: "Both reviewers run.", statuses: [{nodeId: review.nodeId, status: "underway"},
      {nodeId: pairedWorkflow.nodeId, status: "underway"}, {nodeId: paired.nodeId, status: "underway"}, {nodeId: fit.nodeId, status: "underway"}],
    evidence: [review, pairedWorkflow, paired, fit].map(node => ({kind: "status_changed" as const, targetNodeId: node.nodeId, note: "Review round one started."}))});
    const premature = yield* reviewLanes("main-review-early");
    assert.deepEqual("diagnostic" in premature.result ? [premature.result.diagnostic?.code, premature.result.diagnostic?.path] : null, ["sequence_order", "/input/statuses/0/status"], "the Review occurrence itself is the premature entry");

    // once the earlier phases complete, parallel review lanes, accounting, a second round and reopened implementation are all recorded
    assert.equal((yield* statusEdit(fixture, "phases-done", [["implement-in-scope", "completed"], ["prevent-recurrence", "completed"], ["verify-behavior", "completed"]])).result.status, "applied");
    const alone = yield* stepOnly("main-review-step-alone");
    assert.equal("diagnostic" in alone.result ? alone.result.diagnostic?.code : alone.result.status, "nested_status_inconsistent", "a member enters inside its workflows");
    const lanes = yield* reviewLanes("review-lanes");
    assert.equal(lanes.result.status, "applied", JSON.stringify(lanes.result));
    const account = yield* occurrence(fixture, "account-for-findings");
    assert.equal((yield* write(fixture, {operationId: "round-one-reports", note: "Reports arrived.", statuses: [{nodeId: paired.nodeId, status: "completed"},
      {nodeId: fit.nodeId, status: "completed"}, {nodeId: pairedWorkflow.nodeId, status: "completed"}, {nodeId: account.nodeId, status: "underway"}],
    evidence: [paired, fit, pairedWorkflow, account].map(node => ({kind: "status_changed" as const, targetNodeId: node.nodeId, note: "Round one reported."}))})).result.status, "applied");
    const rework = yield* write(fixture, {operationId: "round-two", note: "A fix needs another round.", statuses: [{nodeId: implement.nodeId, status: "underway"},
      {nodeId: pairedWorkflow.nodeId, status: "underway"}, {nodeId: paired.nodeId, status: "underway"}],
    evidence: [implement, pairedWorkflow, paired].map(node => ({kind: "status_changed" as const, targetNodeId: node.nodeId, note: "Rework and a second round."}))});
    assert.equal(rework.result.status, "applied", JSON.stringify(rework.result));
    const single = planEntities((yield* current(fixture)).plan).filter(node => node.kind === "step" && node.definitionId === "review-correctness")[0]!;
    assert.equal(single.status, "planned", "the not-selected single-review path stays planned without blocking anything");
  } finally {yield* fixture.close;}
}));

it.effect("the operative gets a short pinned notice, reads the complete proposal on demand, and a scope-only revision says only that", () => Effect.gen(function* () {
  const fixture = yield* incidentFixture;
  try {
    const task = (yield* fixture.supervisors.task(fixture.mainThreadId))!;
    // the notice names the exact read; the complete proposal it returns carries the plan, its contracts' locations and the acceptance record
    const notice = workflowIntroductionText(task);
    const full = workflowProposalText(task);
    assert.ok(notice.includes(`supervision_plan and exactly ${JSON.stringify({callerThreadId: task.threadId, taskId: task.id, proposalId: task.workflowProposalId ?? task.id})}`));
    // the event: proposal and task identities, the operative's agreement step and the contact route; the contract and the definitions'
    // starting point are part of the complete proposal it reads
    assert.match(notice, new RegExp(`^Project Supervisor — proposal ${task.workflowProposalId ?? task.id} for task ${task.id}\n`, "u"));
    assert.match(notice, /Questions or proposed changes: t3_thread_send to Supervisor [^,]+, mode queue, naming task /u);
    assert.doesNotMatch(notice, /Plan outline|workflow-acceptance|branch-selection|Required references|project\.yaml|approval step/u,
      "the notice pastes no plan, protocol, record, contract or definitions pointer");
    assert.match(full, /It adds no human approval step or authority, cannot block tools/u, "the agreement contract is read with the proposal");
    assert.ok(notice.length * 4 < full.length, `notice ${notice.length} characters against the ${full.length}-character proposal it points to`);
    assert.match(full, /```workflow-acceptance\n/u);
    assert.doesNotMatch(full, /^\s+Reference: /mu, "definition pointers are not repeated under every member");
    // the operative starts at the project.yaml index and reads each member's file, which carries its own references and skills
    assert.equal(full.match(/AGENTS\.md|wiki\/how-we-build\.md/gu), null, "no definition's supporting pointer is copied into the introduction");
    assert.match(full, /\.t3-supervisor\/project\.yaml; read the full steps\/<id>\.md and workflows\/<id>\.yaml files it lists that apply\./u);
    assert.match(full, /Defined members' contracts, references and skills are in their definition files; read the ones that apply, progressively\./u);
    assert.match(full, /Single review \[workflow:single-review; fixed; members in its definition\]/u);
    assert.match(full, /- branch \[branch:[^\]]+\] if: The frozen artifact is a contained, low-risk change\./u, "the operative still sees the branch it decides");
    const outline = full.slice(full.indexOf("Plan outline"), full.indexOf("\nBranches:"));
    assert.ok(outline.length < 1_600, `the incident-shaped outline and pointers take ${outline.length} characters`);

    // a revised proposal for a changed scope with the same plan structure, definitions and requirements is a short delta
    const earlier = proposalForDefinitions(fixture.definitionReader.current, sequencePlan([{kind: "workflow", definitionId: "change", reason: "The task changes repository behavior."}]));
    const sameScope = {...task, workflowProposalId: "proposal-change-limits", agreement: {status: "agreed" as const, message: "Accepted.",
      proposalId: "proposal-change", agreedAt: 1, evidence: {kind: "supervisor_message" as const, messageId: "supervisor-message"}, agentMessageId: "agent-message", workflow: earlier}};
    const revised = {...sameScope, agreementSourceHash: "an-earlier-scope"};
    const delta = workflowIntroductionText(revised);
    assert.match(delta, /^Project Supervisor — revised proposal proposal-change-limits for task [^\n]+\nThe authorized scope changed; the agreed plan of proposal proposal-change is unchanged/u);
    assert.match(workflowIntroductionText(sameScope), /^Project Supervisor — revised proposal proposal-change-limits for task [^\n]+\nThe agreed plan of proposal proposal-change is unchanged/u,
      "a revision without a scope change does not claim one");
    assert.match(delta, /Read its new acceptance record with the t3-supervisor-workflows tool supervision_plan and exactly \{"callerThreadId":[^}]+"proposalId":"proposal-change-limits"\}/u);
    assert.match(workflowProposalText(revised), /```workflow-acceptance\n\{"taskId":"[^"]+","proposalId":"proposal-change-limits","digest":"[0-9a-f]{64}"\}\n```/u);
    assert.doesNotMatch(delta, /Plan outline|branch-selection|workflow-acceptance/u);
    // whole messages count, fixed protocol prose included: both notices together stay below one complete proposal
    assert.ok(notice.length + delta.length < full.length, `notices ${notice.length} + ${delta.length} characters against ${full.length}`);
    const changedPlan = {...revised, agreement: {...revised.agreement, workflow: {...earlier, plan: sequencePlan([localStep("Other plan", "A different plan.")])}}};
    assert.match(workflowIntroductionText(changedPlan), /^Project Supervisor — revised proposal proposal-change-limits for task [^\n]+\nThis revises the workflow you agreed as proposal proposal-change; agree the revision/u,
      "a changed plan gets the proposal notice naming the agreed proposal it replaces");
    assert.match(workflowIntroductionText(changedPlan), /Read it with the t3-supervisor-workflows tool supervision_plan and exactly \{"callerThreadId":[^}]+"proposalId":"proposal-change-limits"\}/u);
  } finally {yield* fixture.close;}
}));

it.effect("completion requires every applicable member settled, and a fixed member that does not apply is recorded without blocking", () => Effect.gen(function* () {
  const fixture = yield* incidentFixture;
  try {
    assert.equal((yield* statusEdit(fixture, "repair", coherentRepair, {status: "underway"})).result.status, "applied");
    const review = planEntities((yield* current(fixture)).plan).find((node): node is Extract<WorkflowPlanNodeInfo, {kind: "workflow"}> =>
      node.kind === "workflow" && node.definitionId === "review")!;
    const reviewBranch = review.plan!.nodes[0] as Extract<WorkflowPlanNodeInfo, {kind: "branch"}>;
    assert.equal((yield* fixture.workflows.recordBranchSelection(fixture.owner, {nodeId: reviewBranch.nodeId, revision: 1, path: "else", reason: "Customer-facing behavior changed.",
      sourceThreadId: fixture.mainThreadId, sourceRunId: "main-run", sourceMessageId: "main-selection", sourceCreatedAt: Date.parse("2100-01-01T00:00:00Z")})).status, "applied");
    // the task cannot be recorded completed while Implementation is underway and later phases are planned
    const early = yield* write(fixture, {operationId: "task-complete-early", status: "completed", note: "Everything is done.",
      evidence: [{kind: "status_changed", note: "The task is complete."}]});
    assert.deepEqual("diagnostic" in early.result ? [early.result.reason, early.result.diagnostic?.code] : null, ["completion_unfinished", "completion_unfinished"]);

    // not_applicable marks only a planned fixed member; a flexible member is omitted through an agreed proposal instead
    const prevent = yield* occurrence(fixture, "prevent-recurrence");
    const flexibleNa = yield* write(fixture, {operationId: "flexible-not-applicable", note: "Not applicable.",
      evidence: [{kind: "not_applicable", targetNodeId: prevent.nodeId, note: "Ordinary feature work."}]});
    assert.deepEqual("diagnostic" in flexibleNa.result ? [flexibleNa.result.diagnostic?.code, flexibleNa.result.diagnostic?.path] : null,
      ["not_applicable_invalid", "/input/evidence/0"]);

    assert.equal((yield* statusEdit(fixture, "phases-done", [["implement-in-scope", "completed"], ["prevent-recurrence", "completed"], ["verify-behavior", "completed"]])).result.status, "applied");
    const paired = yield* occurrence(fixture, "review-correctness", 1);
    const fit = yield* occurrence(fixture, "review-fit", 1);
    const pairedWorkflow = planEntities((yield* current(fixture)).plan).find(node => node.kind === "workflow" && node.definitionId === "paired-review")!;
    const account = yield* occurrence(fixture, "account-for-findings");
    assert.equal((yield* write(fixture, {operationId: "review-done", note: "Both reviews reported.", statuses: [review, pairedWorkflow, paired, fit]
      .map(node => ({nodeId: node.nodeId, status: node === review ? "underway" as const : "completed" as const})),
    evidence: [review, pairedWorkflow, paired, fit].map(node => ({kind: "status_changed" as const, targetNodeId: node.nodeId, note: "Reported."}))})).result.status, "applied");
    // completing Review while its accounting member is still open is refused, then the fixed member is recorded not applicable
    const reviewEarly = yield* write(fixture, {operationId: "review-complete-early", note: "Review done.", statuses: [{nodeId: review.nodeId, status: "completed"}],
      evidence: [{kind: "status_changed", targetNodeId: review.nodeId, note: "Done."}]});
    assert.equal("diagnostic" in reviewEarly.result ? reviewEarly.result.diagnostic?.code : reviewEarly.result.status, "completion_unfinished");
    const recorded = yield* write(fixture, {operationId: "account-not-applicable", note: "Record the fixed member's assessment.",
      evidence: [{kind: "not_applicable", targetNodeId: account.nodeId, note: "Report-only review: findings are returned without accounting in this task."}]});
    assert.equal(recorded.result.status, "applied", JSON.stringify(recorded.result));
    assert.equal((yield* occurrence(fixture, "account-for-findings")).status, "planned", "the fixed member stays visible and planned");
    const finished = yield* write(fixture, {operationId: "review-complete", note: "Review done.", statuses: [{nodeId: review.nodeId, status: "completed"}],
      evidence: [{kind: "status_changed", targetNodeId: review.nodeId, note: "Done."}]});
    assert.equal(finished.result.status, "applied", JSON.stringify(finished.result));
    assert.equal((yield* statusEdit(fixture, "finalize", [["finalize", "completed"], ["change", "completed"]])).result.status, "applied",
      "the not-applicable fixed member never blocks what follows");
    const done = yield* write(fixture, {operationId: "task-complete", status: "completed", note: "Everything is done.",
      evidence: [{kind: "status_changed", note: "The task is complete."}]});
    assert.equal(done.result.status, "applied", JSON.stringify(done.result));
    assert.equal((yield* occurrence(fixture, "account-for-findings")).status, "planned", "completion never completes a member");
    const status = yield* fixture.controller.readTool({...locator(fixture), view: "status"});
    assert.match(JSON.stringify(status), /"name":"Account for findings","ref":"step:account-for-findings","status":"planned","notApplicable":true/u,
      "the status view marks the current not-applicable assessment distinctly from completion");
    const stored = (yield* current(fixture)).evidence.find(item => item.kind === "not_applicable");
    assert.equal(stored?.scopeRevision, fixture.sourceBinding.sourceHash, "the assessment is bound to the task scope it assessed");
    assert.equal(notApplicableNodeIds((yield* current(fixture)).evidence, "a-later-scope").size, 0, "a later scope needs a fresh assessment");
  } finally {yield* fixture.close;}
}));

it("omissions never empty a workflow through a nested group, and outlines expand nested workflows with task-specific members", () => {
  const member = {...localStep("Only check", "The only member."), nodeId: "0b7c9a52-5f3e-4c1a-9d2e-6a1f2b3c4d5e", templatePath: "workflow:inner/root/0/0"};
  const inner = {kind: "workflow" as const, nodeId: "1b7c9a52-5f3e-4c1a-9d2e-6a1f2b3c4d5e", definitionId: "inner", templatePath: null, name: "Inner", description: "Inner.",
    fixed: false, source: null, resolution: "resolved" as const, reason: "Included.", status: "planned" as const, contributorThreadIds: [], omissions: [],
    plan: {kind: "sequence" as const, templatePath: "workflow:inner/root", nodes: [{kind: "parallel" as const, templatePath: "workflow:inner/root/0", nodes: [member]}]}};
  const plan = sequencePlan([inner]);
  assert.deepEqual(withOmissions(plan, [{nodeId: member.nodeId, reason: "Not needed."}]), {index: 0, problem: "empties_group"});

  const outer = {...inner, nodeId: "2b7c9a52-5f3e-4c1a-9d2e-6a1f2b3c4d5e", definitionId: "outer", name: "Outer",
    plan: {kind: "sequence" as const, templatePath: "workflow:outer/root", nodes: [{...inner, templatePath: "workflow:outer/root/0"}]}};
  assert.match(renderPlan(sequencePlan([outer])).join("\n"), /Inner \[workflow:inner; flexible; members in its definition\]/u);
  const extended = {...outer, plan: {...outer.plan, nodes: [{...inner, templatePath: "workflow:outer/root/0",
    plan: {...inner.plan, nodes: [...inner.plan.nodes, {...localStep("Extra migration check", "Task-specific."), nodeId: "3b7c9a52-5f3e-4c1a-9d2e-6a1f2b3c4d5e"}]}}]}};
  assert.match(renderPlan(sequencePlan([extended])).join("\n"), /Extra migration check \[local:extra-migration-check\]/u, "added members stay visible");
  const second = {...member, nodeId: "4b7c9a52-5f3e-4c1a-9d2e-6a1f2b3c4d5e", name: "Second check", templatePath: "workflow:inner/root/1"};
  const reordered = {...outer, plan: {...outer.plan, nodes: [{...inner, templatePath: "workflow:outer/root/0",
    plan: {kind: "sequence" as const, templatePath: "workflow:inner/root", nodes: [second, {...member, templatePath: "workflow:inner/root/0"}]}}]}};
  assert.match(renderPlan(sequencePlan([reordered])).join("\n"), /Second check[\s\S]*Only check/u, "a reordered workflow is expanded in its agreed order");
});

it.effect("fixed sequences keep their order, and a fixed workflow that does not apply settles its whole occurrence", () => Effect.gen(function* () {
  const fixture = yield* agreedFixture([{kind: "workflow", definitionId: "release", reason: "The task ships a release."},
    {kind: "step", definitionId: "data-and-rollout", reason: "Roll the release out."}]);
  try {
    const codeAndPath = (result: {result: unknown}) => {
      const value = result.result as {status: string; diagnostic?: {code: string; path: string}};
      return value.diagnostic ? [value.diagnostic.code, value.diagnostic.path] : [value.status];
    };
    // a fixed sequence is ordered like any other: Finalize cannot be entered before Verify, Review and Hotfix are settled
    assert.deepEqual(codeAndPath(yield* statusEdit(fixture, "finalize-first", [["release", "underway"], ["finalize", "underway"]], {status: "underway"})),
      ["sequence_order", "/input/statuses/1/status"]);
    assert.equal((yield* statusEdit(fixture, "verify", [["release", "underway"], ["verify-behavior", "completed"]], {status: "underway"})).result.status, "applied");
    const releaseEarly = codeAndPath(yield* statusEdit(fixture, "release-complete-early", [["release", "completed"]]));
    assert.equal(releaseEarly[0], "branch_decision_pending", "Review's open decision holds Release until Review is assessed");
    const reviewNode = (yield* occurrence(fixture, "review")) as Extract<WorkflowPlanNodeInfo, {kind: "workflow"}>;
    assert.equal((planNodeAtPointer((yield* current(fixture)).plan, String(releaseEarly[1]).replace(/^\/current/u, "")) as {nodeId?: string} | null)?.nodeId,
      (reviewNode.plan!.nodes[0] as {nodeId: string}).nodeId, `${String(releaseEarly[1])} names the pending branch`);

    // the fixed Review, with its decision still pending, and the flexible Hotfix do not apply: each is recorded once and stays planned
    const review = yield* occurrence(fixture, "review");
    const hotfix = yield* occurrence(fixture, "hotfix");
    const assessed = yield* write(fixture, {operationId: "release-not-applicable", note: "Record the fixed members' assessments.", evidence: [
      {kind: "not_applicable", targetNodeId: review.nodeId, note: "Review ran in the change this release ships."},
      {kind: "not_applicable", targetNodeId: hotfix.nodeId, note: "No hotfix is part of this release."}]});
    assert.equal(assessed.result.status, "applied", JSON.stringify(assessed.result));
    // members inside an assessed workflow need no record of their own, and its pending decision no longer blocks
    assert.equal((yield* statusEdit(fixture, "release-done", [["finalize", "completed"], ["release", "completed"]])).result.status, "applied");
    assert.equal((yield* statusEdit(fixture, "rollout", [["data-and-rollout", "underway"]])).result.status, "applied", "the next member is entered");
    assert.equal((yield* statusEdit(fixture, "rollout-done", [["data-and-rollout", "completed"]])).result.status, "applied");
    const done = yield* write(fixture, {operationId: "task-complete", status: "completed", note: "Everything is done.",
      evidence: [{kind: "status_changed", note: "The task is complete."}]});
    assert.equal(done.result.status, "applied", JSON.stringify(done.result));

    // the assessment survives a long later history, and the dashboard neither counts its members nor asks for its decision
    const finalize = yield* occurrence(fixture, "finalize");
    yield* TestClock.adjust("1 minute");
    for (const round of [0, 1]) assert.equal((yield* write(fixture, {operationId: `history-${round}`, note: "Later observations.",
      evidence: Array.from({length: 15}, (_, index) => ({kind: "observation" as const, targetNodeId: finalize.nodeId,
        note: `Follow-up observation ${round}-${index}.`}))})).result.status, "applied");
    const document = yield* current(fixture);
    const progress = progressWorkflow(document, []);
    assert.equal(progress.observations.some(item => item.kind === "not_applicable"), false, "the assessments fell out of the recent records");
    const settled = new Set(progress.notApplicable);
    const inside = (definitionId: string) => planEntities(document.plan).filter(node => node.definitionId === definitionId).map(node => node.nodeId);
    for (const nodeId of [review.nodeId, hotfix.nodeId, ...inside("single-review"), ...inside("review-correctness"), ...inside("account-for-findings"),
      ...inside("implement-in-scope")]) assert.ok(settled.has(nodeId), `${nodeId} is settled by its workflow's assessment`);
    assert.equal(settled.has(finalize.nodeId), false);
    const live = liveProgress(document.plan, currentBranchPaths(progress), settled);
    assert.deepEqual(live.steps.map(step => step.definitionId), ["verify-behavior", "finalize", "data-and-rollout"]);
    assert.deepEqual(live.pending, [], "the decision inside the assessed Review is not asked for");
    const html = renderToStaticMarkup(createElement(PlanJourney, {node: document.plan!, mode: "live", notApplicable: settled, selections: progress.branchSelections,
      completions: new Map((progress.completions ?? []).map(item => [item.nodeId, item.completedAt] as const))}));
    assert.match(html, /Review<span class="step-flags"><small>Workflow<\/small><\/span><\/span><span class="step-state">Not applicable/u);
    assert.match(html, /Account for findings[\s\S]*?<span class="step-state">Not applicable/u);
    assert.doesNotMatch(html, /needs reassessment/u, "Release's completion stands although the assessed Review never decided its branch");
    assert.doesNotMatch(html, /Decision pending|Awaiting decision/u, "nothing inside an assessed Review is waiting for a decision");
    assert.match(html, /Single review<span class="step-flags"><small>Workflow<\/small><\/span><\/span><span class="step-state">Not applicable/u, "a member on an undecided path inside it is not applicable");
    // outside an assessed occurrence an undecided branch keeps its usual labels
    const undecidedHtml = renderToStaticMarkup(createElement(PlanJourney, {node: document.plan!, mode: "live", selections: progress.branchSelections}));
    assert.match(undecidedHtml, /Decision pending/u);
    assert.match(undecidedHtml, /Awaiting decision/u);
    assert.equal(progress.assessment?.reassessment ?? null, null, "the task's completion stands as current");
    const statusView = yield* fixture.controller.readTool({...locator(fixture), view: "status"});
    assert.match(JSON.stringify(statusView), /"pendingBranchDecisions":\[\]/u, "the Supervisor is not asked for a decision inside an assessed workflow");
  } finally {yield* fixture.close;}
}));

it.effect("Review accounts for findings only after its selected lanes are settled, while the lanes themselves overlap freely", () => Effect.gen(function* () {
  const fixture = yield* incidentFixture;
  try {
    assert.equal((yield* statusEdit(fixture, "repair", coherentRepair, {status: "underway"})).result.status, "applied");
    assert.equal((yield* statusEdit(fixture, "phases-done", [["implement-in-scope", "completed"], ["prevent-recurrence", "completed"], ["verify-behavior", "completed"]])).result.status, "applied");
    const review = yield* occurrence(fixture, "review");
    const reviewBranch = (review.kind === "workflow" ? review.plan!.nodes[0] : null) as Extract<WorkflowPlanNodeInfo, {kind: "branch"}>;
    assert.equal((yield* fixture.workflows.recordBranchSelection(fixture.owner, {nodeId: reviewBranch.nodeId, revision: 1, path: "else", reason: "Customer-facing behavior changed.",
      sourceThreadId: fixture.mainThreadId, sourceRunId: "main-run", sourceMessageId: "main-selection", sourceCreatedAt: Date.parse("2100-01-01T00:00:00Z")})).status, "applied");
    const pairedWorkflow = planEntities((yield* current(fixture)).plan).find(node => node.kind === "workflow" && node.definitionId === "paired-review")!;
    const correctness = yield* occurrence(fixture, "review-correctness", 1);
    const account = yield* occurrence(fixture, "account-for-findings");
    const edit = (operationId: string, nodes: readonly WorkflowPlanNodeInfo[]) => write(fixture, {operationId, note: "Reconcile the review.",
      statuses: nodes.map(node => ({nodeId: (node as {nodeId: string}).nodeId, status: "underway" as const})),
      evidence: nodes.map(node => ({kind: "status_changed" as const, targetNodeId: (node as {nodeId: string}).nodeId, note: "Native activity shows this underway."}))});
    const early = (yield* edit("account-first", [review, account])).result;
    assert.deepEqual("diagnostic" in early ? [early.diagnostic?.code, early.diagnostic?.path] : null, ["sequence_order", "/input/statuses/1/status"]);
    assert.equal((yield* edit("lanes", [review, pairedWorkflow, correctness])).result.status, "applied", "a lane is entered while its sibling is planned");
    const stillEarly = (yield* edit("account-during-lanes", [account])).result;
    assert.equal("diagnostic" in stillEarly ? stillEarly.diagnostic?.code : stillEarly.status, "sequence_order");
    // an unedited occurrence at fault is located in the current document
    const reviewEarly = (yield* statusEdit(fixture, "review-complete-early", [["review", "completed"]])).result;
    const pointer = "diagnostic" in reviewEarly ? reviewEarly.diagnostic?.path ?? "" : "";
    assert.equal("diagnostic" in reviewEarly ? reviewEarly.diagnostic?.code : reviewEarly.status, "completion_unfinished");
    assert.match(pointer, /^\/current\/plan\/.+\/status$/u);
    assert.equal((planNodeAtPointer((yield* current(fixture)).plan, pointer.slice("/current".length)) as {nodeId?: string} | null)?.nodeId, pairedWorkflow.nodeId,
      "the open paired review is named in the current plan");
  } finally {yield* fixture.close;}
}));

it.effect("a fixed workflow with recorded progress inside it is never assessed not applicable, even after reverting it to planned", () => Effect.gen(function* () {
  const fixture = yield* agreedFixture([{kind: "workflow", definitionId: "release", reason: "The task ships a release."}]);
  try {
    assert.equal((yield* statusEdit(fixture, "verify", [["release", "underway"], ["verify-behavior", "completed"]], {status: "underway"})).result.status, "applied");
    const review = (yield* occurrence(fixture, "review")) as Extract<WorkflowPlanNodeInfo, {kind: "workflow"}>;
    const branch = review.plan!.nodes[0] as Extract<WorkflowPlanNodeInfo, {kind: "branch"}>;
    assert.equal((yield* fixture.workflows.recordBranchSelection(fixture.owner, {nodeId: branch.nodeId, revision: 1, path: "then", reason: "Contained change.",
      sourceThreadId: fixture.mainThreadId, sourceRunId: "main-run", sourceMessageId: "main-selection", sourceCreatedAt: Date.parse("2100-01-01T00:00:00Z")})).status, "applied");
    assert.equal((yield* statusEdit(fixture, "lane", [["review", "underway"], ["single-review", "underway"], ["review-correctness", "underway"]])).result.status, "applied");
    assert.equal((yield* statusEdit(fixture, "revert", [["review", "planned"]])).result.status, "applied");
    const hidden = (yield* write(fixture, {operationId: "assess-started", note: "Record Review not applicable.",
      evidence: [{kind: "not_applicable", targetNodeId: review.nodeId, note: "Review is not needed."}]})).result;
    assert.deepEqual("diagnostic" in hidden ? [hidden.diagnostic?.code, hidden.diagnostic?.path] : null, ["not_applicable_invalid", "/input/evidence/0"]);
    const finished = (yield* statusEdit(fixture, "finish", [["finalize", "completed"]])).result;
    assert.equal("diagnostic" in finished ? finished.diagnostic?.code : finished.status, "sequence_order", "the underway lane still holds what follows");
  } finally {yield* fixture.close;}
}));

it.effect("an operative's scope exclusions reduce the accepted plan in one agreed revision, keeping completed history", () => Effect.gen(function* () {
  const fixture = yield* incidentFixture;
  try {
    assert.equal((yield* statusEdit(fixture, "started", [["change", "underway"], ["scope-and-authority", "completed"], ["gather-evidence", "completed"]],
      {status: "underway"})).result.status, "applied");
    const before = yield* current(fixture);
    // the operative says design, data rollout and recurrence prevention are outside this task: one smaller revision omits all three
    const reasons = {"design-approach": "Only local documentation is refreshed; no design decision is involved.",
      "data-and-rollout": "No stored data or rollout is involved.", "prevent-recurrence": "No defect was exposed."} as const;
    const definitions = fixture.definitionReader.current;
    const draft = canonicalizeProposalDraft({requirements: [], plan: {kind: "sequence", nodes: [{kind: "workflow", definitionId: "change", reason: "The task changes repository content.",
      omit: Object.entries(reasons).map(([member, reason]) => ({member, reason}))}]}}, proposalContextFromDefinitions(definitions), "reduced");
    assert.ok(draft.ok, JSON.stringify(draft));
    if (!draft.ok) return;
    const reduced: WorkflowProposalInfo = {status: "proposed", message: "A smaller revised proposal.", workspaceRoot: definitions.workspaceRoot, revision: definitions.revision,
      globalRevision: definitions.globalRevision ?? null, ...draft.workflow};
    yield* replaceCurrentProposal(fixture, "proposal-change-reduced", definitions, reduced);
    const task = (yield* fixture.supervisors.task(fixture.mainThreadId))!;
    yield* fixture.supervisors.saveTask({...task, agreementSourceHash: fixture.sourceBinding.sourceHash, agreement: {status: "agreed", message: "Accepted.",
      proposalId: "proposal-change-reduced", agreedAt: 1, evidence: {kind: "supervisor_message", messageId: "supervisor-message"}, agentMessageId: "agent-message", workflow: reduced}});
    const omitted = Object.keys(reasons).map(definitionId => planEntities(before.plan).find(node => node.definitionId === definitionId)!);
    const applied = yield* write(fixture, {operationId: "reduce-accepted", note: "Apply the agreed smaller plan.",
      omit: omitted.map(node => ({nodeId: node.nodeId, reason: reasons[node.definitionId as keyof typeof reasons]}))});
    assert.equal(applied.result.status, "applied", JSON.stringify(applied.result));
    const after = yield* current(fixture);
    assert.deepEqual(changeOf(after.plan).omissions.map(item => [item.id, item.reason]), Object.entries(reasons));
    assert.deepEqual(planEntities(after.plan).filter(node => node.status !== "planned").map(node => [node.nodeId, node.status]),
      planEntities(before.plan).filter(node => node.status !== "planned").map(node => [node.nodeId, node.status]), "completed and underway work keeps its identity and status");
    assert.equal(planEntities(after.plan).some(node => omitted.some(item => item.nodeId === node.nodeId)), false);
    // implementation now follows the gathered evidence directly
    assert.equal((yield* statusEdit(fixture, "implementing", [["implement-in-scope", "underway"]])).result.status, "applied");
  } finally {yield* fixture.close;}
}));
