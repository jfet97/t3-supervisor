import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {it} from "@effect/vitest";
import {Effect} from "effect";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {fingerprint} from "../src/guidance-store.js";
import {defaultSupervisorModel} from "../src/project-supervisor-store.js";
import {parseDefinitionWorkflow} from "../src/project-definitions.js";
import type {DefinitionNode, ProjectDefinitionSnapshot} from "../src/project-definitions-contract.js";
import type {WorkflowPlanBranchInfo, WorkflowPlanGroupInfo, WorkflowPlanNodeInfo, WorkflowProposalInfo} from "../src/project-supervisor-contract.js";
import {canonicalizeProposalDraft, manifestMembers, proposalContextFromDefinitions, validateWorkflowPlan} from "../src/supervisor-workflow.js";
import {renderPlan} from "../src/supervisor-conversation.js";
import {workflowAssessment} from "../src/workflow-assessment.js";
import {documentBranchSelections} from "../src/workflow-state-store.js";
import type {BranchSelectionImport, WorkflowAgreementImport, WorkflowApplyInput, WorkflowOwner, WorkflowStateDocument, WorkflowStateSourceBinding} from "../src/workflow-state-contract.js";
import {planBranches, planEntities, planReach} from "../src/workflow-plan-tree.js";
import {progressWorkflow} from "../src/workflow-progress.js";
import {recordsByStep} from "../ui/src/task-record.js";
import {completionTimes, PlanJourney} from "../ui/src/workflow-journey.js";
import {effectiveIndex, indexSource, makeDefinitionFixture, projectIndex, stepSource, testSummary} from "./project-definitions-fixture.js";
import {execute, openWorkflowStores, temporaryDirectory} from "./support/g12-stores.js";

// coarse semantic branches end to end below the native boundary: authored YAML, graph checks, canonical plans, required and fixed
// commitments, operative selections in the workflow store and the text an agent reads

const reviewWorkflow = `name: Review
description: Review the change at a depth that fits its scope.
fixed: true
sequence:
  - step: inspect
  - branch:
      if: The change is contained and well understood.
      then:
        - step: focused-review
      else:
        - parallel:
            - step: independent-review
            - workflow: second-opinion
        - step: iterate
  - step: deliver
`;
const secondOpinion = `name: Second opinion
description: A second independent model reviews the change.
sequence:
  - step: independent-review
`;
const stepIds = ["inspect", "focused-review", "independent-review", "iterate", "deliver"];

const load = (files: Record<string, string>, options: {required?: Array<{step: string} | {workflow: string}>; global?: Record<string, string>} = {}) => Effect.gen(function* () {
  const fixture = makeDefinitionFixture({globalEnabled: Boolean(options.global)});
  const write = (root: string, entries: Record<string, string>, required: Array<{step: string} | {workflow: string}>) => {
    for (const [path, contents] of Object.entries(entries)) fixture.addFile(root, `.t3-supervisor/${path}`, contents);
    fixture.writeIndex(root, {required});
  };
  write(fixture.threadRoot!, files, options.required ?? []);
  if (options.global) write(fixture.globalRoot, options.global, []);
  return yield* (yield* fixture.makeDefinitions()).load("project", "thread");
});
const catalog = (extra: Record<string, string> = {}) => ({
  ...Object.fromEntries(stepIds.map(id => [`steps/${id}.md`, stepSource(id, `Complete ${id}.`)])),
  "workflows/review.yaml": reviewWorkflow,
  "workflows/second-opinion.yaml": secondOpinion,
  ...extra,
});

it.effect("a branch keeps its condition, contained paths and the following step through parsing and the loaded collection", () => Effect.gen(function* () {
  const snapshot = yield* load(catalog());
  assert.equal(snapshot.status, "ready", JSON.stringify(snapshot.issues));
  const review = snapshot.workflows.find(workflow => workflow.id === "review")!;
  assert.deepEqual(review.sequence, [
    {step: "inspect"},
    {branch: {if: "The change is contained and well understood.", then: [{step: "focused-review"}],
      else: [{parallel: [{step: "independent-review"}, {workflow: "second-opinion"}]}, {step: "iterate"}]}},
    {step: "deliver"},
  ]);
  const ifOnly = parseDefinitionWorkflow("guarded", "name: Guarded\ndescription: Guarded release.\nsequence:\n  - branch:\n      if: The release changes stored data.\n      then:\n        - step: backup\n        - branch:\n            if: The data is shared across tenants.\n            then:\n              - step: announce\n  - step: release\n");
  assert.deepEqual(ifOnly.sequence, [{branch: {if: "The release changes stored data.", then: [{step: "backup"},
    {branch: {if: "The data is shared across tenants.", then: [{step: "announce"}]}}]}}, {step: "release"}], "an if-only branch nests without an else path");
  assert.deepEqual(manifestMembers(review.sequence!), ["step:inspect", "if \"The change is contained and well understood.\" then: step:focused-review",
    "if \"The change is contained and well understood.\" else: step:independent-review", "if \"The change is contained and well understood.\" else: workflow:second-opinion",
    "if \"The change is contained and well understood.\" else: step:iterate", "step:deliver"], "manifest members never become an unconditional checklist");
}));

it("malformed, ambiguous, excess or unbounded branch structure is rejected with a fixed reason", () => {
  const workflow = (node: string) => `name: Broken\ndescription: Broken workflow.\nsequence:\n${node}`;
  const reason = (source: string) => {try {parseDefinitionWorkflow("broken", source);return null;} catch (error) {return (error as Error).message;}};
  const branchReason = /^branch needs exactly a one-line if condition of at most 300 characters/u;
  const cases: Array<[string, string, RegExp]> = [
    ["no condition", workflow("  - branch:\n      then:\n        - step: a\n"), branchReason],
    ["an else-if key", workflow("  - branch:\n      if: Small.\n      then:\n        - step: a\n      elif:\n        - step: b\n"), branchReason],
    ["an empty then path", workflow("  - branch:\n      if: Small.\n      then: []\n"), branchReason],
    ["an empty else path", workflow("  - branch:\n      if: Small.\n      then:\n        - step: a\n      else: []\n"), branchReason],
    ["a then mapping instead of a path", workflow("  - branch:\n      if: Small.\n      then:\n        step: a\n"), branchReason],
    ["a multi-line condition", workflow("  - branch:\n      if: |\n        Small.\n        And simple.\n      then:\n        - step: a\n"), branchReason],
    ["an oversized condition", workflow(`  - branch:\n      if: ${"x".repeat(301)}\n      then:\n        - step: a\n`), branchReason],
    ["a jump", workflow("  - goto: inspect\n"), /exactly one step, workflow, sequence, parallel, branch or back_to key/u],
    ["a branch beside another key", workflow("  - branch:\n      if: Small.\n      then:\n        - step: a\n    step: b\n"), /exactly one step, workflow, sequence, parallel, branch or back_to key/u],
    ["a duplicate local step across paths", workflow("  - branch:\n      if: Small.\n      then:\n        - step: {id: same, name: Same, description: First.}\n      else:\n        - step: {id: same, name: Same, description: Second.}\n"),
      /Local step identifiers must be unique/u],
  ];
  for (const [label, source, expected] of cases) assert.match(reason(source) ?? "accepted", expected, label);
  const nest = (level: number): string => {
    const pad = " ".repeat(2 + level * 6);
    return level === 17 ? `${pad}- step: a\n` : `${pad}- branch:\n${pad}    if: Level ${level}.\n${pad}    then:\n${nest(level + 1)}`;
  };
  const deep = nest(0);
  assert.match(reason(workflow(deep)) ?? "accepted", /nesting or expanded-node limit/u, "nested branches count against the shared depth bound");
});

it.effect("missing references and cycles inside either path are diagnosed without expanding them", () => Effect.gen(function* () {
  const looped = `name: Loop\ndescription: Loop.\nsequence:\n  - step: inspect\n  - branch:\n      if: Another round is needed.\n      then:\n        - step: missing-step\n      else:\n        - workflow: loop\n`;
  const snapshot = yield* load(catalog({"workflows/loop.yaml": looped}));
  assert.equal(snapshot.status, "invalid");
  assert.ok(snapshot.issues.some(issue => issue.code === "workflow_step_missing" && issue.message.includes("missing-step")), "the then path is checked");
  assert.ok(snapshot.issues.some(issue => issue.code === "workflow_cycle" && issue.message.includes("loop -> loop")), "the else path is checked");
}));

it.effect("shared definitions namespace references inside both branch paths", () => Effect.gen(function* () {
  const snapshot = yield* load({"steps/.gitkeep": "", "workflows/.gitkeep": ""}, {global: catalog()});
  const review = snapshot.workflows.find(workflow => workflow.sourceId === "review")!;
  const branch = review.sequence![1] as Extract<DefinitionNode, {branch: unknown}>;
  const ids = [...branch.branch.then, ...branch.branch.else!].flatMap(node => "step" in node && typeof node.step === "string" ? [node.step]
    : "parallel" in node ? node.parallel.flatMap(item => "step" in item && typeof item.step === "string" ? [item.step] : "workflow" in item ? [item.workflow] : []) : []);
  assert.equal(ids.length, 4);
  assert.ok(ids.every(id => /^g[0-9a-f]{63}$/u.test(id)), "every reference in either path uses its namespaced identity");
}));

// a fixed definition context assembled directly, as the loader reports it
const snapshotOf = (required: Array<{step: string} | {workflow: string}>): ProjectDefinitionSnapshot => {
  const steps = stepIds.map(id => ({id, name: id, description: `Complete ${id}.`, summary: testSummary(id), origin: "project" as const, path: `.t3-supervisor/steps/${id}.md`, sourceId: id}));
  const review = {...parseDefinitionWorkflow("review", reviewWorkflow), summary: testSummary("review"), origin: "project" as const, path: ".t3-supervisor/workflows/review.yaml", sourceId: "review"};
  const second = {...parseDefinitionWorkflow("second-opinion", secondOpinion), summary: testSummary("second-opinion"), origin: "project" as const,
    path: ".t3-supervisor/workflows/second-opinion.yaml", sourceId: "second-opinion"};
  const index = {steps: stepIds, workflows: ["review", "second-opinion"], required};
  return {projectId: "project-a", threadId: "main-a", workspaceRoot: "/workspace/project-a", globalOnly: false, globalRevision: null, revision: "definitions-1",
    editingAvailable: true, status: "ready", steps, workflows: [review, second], config: effectiveIndex({steps, workflows: [review, second]}, required),
    projectConfig: projectIndex(index), definitionFiles: [], complete: true,
    sources: [{path: ".t3-supervisor/project.yaml", content: indexSource(index), origin: "project"}], issues: []};
};
const reviewReference = {kind: "workflow", definitionId: "review", reason: "Review the change."};
const localStep = (id: string) => ({kind: "step", definitionId: null, localId: id, name: id, description: `Complete ${id}.`, reason: `The task needs ${id}.`});
const branchOf = (plan: WorkflowPlanGroupInfo | null, index = 0): WorkflowPlanBranchInfo => planBranches(plan)[index]!;

it("expansion keeps branch identity, template paths, labelled outlines and the following step", () => {
  const context = proposalContextFromDefinitions(snapshotOf([]));
  const plan = validateWorkflowPlan({requirements: [], plan: {kind: "sequence", nodes: [reviewReference]}}, context);
  assert.ok(plan?.plan);
  const review = plan.plan.nodes[0];
  assert.ok(review?.kind === "workflow" && review.plan);
  assert.deepEqual(review.plan.nodes.map(node => node.kind), ["step", "branch", "step"], "deliver follows the whole branch");
  const branch = review.plan.nodes[1] as WorkflowPlanBranchInfo;
  assert.equal(branch.condition, "The change is contained and well understood.");
  assert.ok(branch.templatePath?.endsWith("workflow:review/root/1"));
  assert.equal(branch.then.templatePath, `${branch.templatePath}/then`);
  assert.equal(branch.else?.templatePath, `${branch.templatePath}/else`);
  assert.deepEqual(branch.else?.nodes.map(node => node.kind), ["parallel", "step"]);
  assert.equal(plan.issues.length, 0, JSON.stringify(plan.issues));
  const outline = renderPlan(plan.plan).join("\n");
  assert.match(outline, new RegExp(`  - branch \\[branch:${branch.nodeId}\\] if: The change is contained and well understood\\.\\n    then:\\n      - focused-review`, "u"));
  assert.match(outline, /    else:\n      parallel:\n        - independent-review \[step:independent-review\]\n        - Second opinion/u);
  assert.match(outline, /        - Second opinion \[workflow:second-opinion; flexible; members in its definition\]\n      - iterate \[step:iterate\]\n  - deliver \[step:deliver\]/u,
    "a nested workflow without a branch is one line, and deliver is dedented to follow the whole branch");
  const selected = renderPlan(plan.plan, "", new Map([[branch.nodeId, "then"]])).join("\n");
  assert.match(selected, /then path selected\n    then:\n/u);
  assert.match(selected, /    else: \(not selected\)/u);
  assert.match(renderPlan(plan.plan, "", new Map()).join("\n"), /decision pending/u);
});

it("required inclusion is structural: one alternative leaves an applicable requirement unresolved, every path includes it", () => {
  const assess = (id: string) => [{kind: "step", id, applies: true, reason: "The change needs it."}];
  const context = proposalContextFromDefinitions(snapshotOf([{step: "iterate"}]));
  const conditional = validateWorkflowPlan({requirements: assess("iterate"), plan: {kind: "sequence", nodes: [reviewReference]}}, context);
  assert.equal(conditional?.requirements[0]?.state, "unresolved", "iterate appears only on the else path");
  assert.match(conditional!.requirements[0]!.reason, /only inside a branch alternative/u);
  const bothPaths = validateWorkflowPlan({requirements: assess("iterate"), plan: {kind: "sequence", nodes: [{kind: "branch", condition: "The change is small.",
    reason: "Depth depends on scope.", then: {kind: "sequence", nodes: [{kind: "step", definitionId: "iterate", reason: "Iterate once."}]},
    else: {kind: "sequence", nodes: [{kind: "step", definitionId: "iterate", reason: "Iterate until resolved."}]}}]}}, context);
  assert.equal(bothPaths?.requirements[0]?.state, "included", "included on every path");
  const ifOnly = validateWorkflowPlan({requirements: assess("iterate"), plan: {kind: "sequence", nodes: [{kind: "branch", condition: "The change is small.",
    reason: "Optional check.", then: {kind: "sequence", nodes: [{kind: "step", definitionId: "iterate", reason: "Iterate."}]}}]}}, context);
  assert.equal(ifOnly?.requirements[0]?.state, "unresolved", "an if-only path skips it when the condition is false");
  const notApplicable = validateWorkflowPlan({requirements: [{kind: "step", id: "iterate", applies: false, reason: "Editorial change."}],
    plan: {kind: "sequence", nodes: [reviewReference]}}, context);
  assert.equal(notApplicable?.requirements[0]?.state, "not_applicable", "existing applicability still accounts for it");

  const requiredReview = proposalContextFromDefinitions(snapshotOf([{workflow: "review"}]));
  const included = validateWorkflowPlan({requirements: [{kind: "workflow", id: "review", applies: true, reason: "Every change is reviewed."}],
    plan: {kind: "sequence", nodes: [reviewReference]}}, requiredReview);
  assert.equal(included?.requirements[0]?.state, "included", "a required workflow's own alternatives are its commitments, not missing inclusion");
  assert.deepEqual(included?.issues, []);
});

it("fixed workflows keep branch conditions and containment while support work joins a path", () => {
  const context = proposalContextFromDefinitions(snapshotOf([]));
  const base = validateWorkflowPlan({requirements: [], plan: {kind: "sequence", nodes: [reviewReference]}}, context)!.plan!;
  const review = base.nodes[0] as Extract<WorkflowPlanNodeInfo, {kind: "workflow"}>;
  const branch = review.plan!.nodes[1] as WorkflowPlanBranchInfo;
  const withPlan = (nodes: readonly WorkflowPlanNodeInfo[] | unknown[]) => ({requirements: [], plan: {kind: "sequence", nodes: [{...reviewReference, plan: {...review.plan!, nodes}}]}});
  const supported = validateWorkflowPlan(withPlan([review.plan!.nodes[0], {...branch, then: {...branch.then, nodes: [...branch.then.nodes, localStep("re-run-tests")]}}, review.plan!.nodes[2]]), context);
  assert.deepEqual(supported?.issues, [], "support work inside a path keeps the fixed commitments");
  const moved = validateWorkflowPlan(withPlan([review.plan!.nodes[0], {...branch, then: {...branch.then, nodes: []}, else: {...branch.else!, nodes: [...branch.then.nodes, ...branch.else!.nodes]}},
    review.plan!.nodes[2]]), context);
  assert.equal(moved, null, "an emptied path is not a valid branch");
  const swapped = validateWorkflowPlan(withPlan([review.plan!.nodes[0], {...branch, then: {...branch.then, nodes: [branch.else!.nodes[1]!]},
    else: {...branch.else!, nodes: [branch.else!.nodes[0]!, branch.then.nodes[0]!]}}, review.plan!.nodes[2]]), context);
  assert.ok(swapped?.issues.some(issue => issue.code === "fixed_workflow_changed"), "members cannot move between alternatives");
  const lifted = validateWorkflowPlan(withPlan([review.plan!.nodes[0], {...branch, then: {...branch.then, nodes: [localStep("instead")]}}, branch.then.nodes[0], review.plan!.nodes[2]]), context);
  assert.ok(lifted?.issues.some(issue => issue.code === "fixed_workflow_changed"), "a then member cannot leave its path to become unconditional");
  const reworded = canonicalizeProposalDraft(withPlan([review.plan!.nodes[0], {...branch, condition: "Anything goes."}, review.plan!.nodes[2]]), context, "seed");
  assert.deepEqual(reworded.ok ? null : reworded.code, "template_branch_condition_changed");
  const dropped = canonicalizeProposalDraft(withPlan([review.plan!.nodes[0], {...branch, else: null}, review.plan!.nodes[2]]), context, "seed");
  assert.deepEqual(dropped.ok ? null : dropped.code, "template_branch_paths_changed");
});

it("task-local branches canonicalize, and malformed ones report the failing path", () => {
  const context = proposalContextFromDefinitions(snapshotOf([]));
  const draft = (branch: Record<string, unknown>) => ({requirements: [], plan: {kind: "sequence", nodes: [localStep("implement"), {kind: "branch", reason: "Rollout depends on data.",
    condition: "The change migrates stored data.", then: {kind: "sequence", nodes: [localStep("backup")]}, ...branch}, localStep("release")]}});
  const ok = canonicalizeProposalDraft(draft({}), context, "seed-a");
  assert.ok(ok.ok);
  const branch = branchOf(ok.workflow.plan);
  assert.deepEqual([branch.templatePath, branch.else, branch.then.templatePath], [null, null, null]);
  assert.deepEqual(canonicalizeProposalDraft(draft({}), context, "seed-a"), ok, "the same draft yields the same record");
  const failure = (branchFields: Record<string, unknown>) => {
    const result = canonicalizeProposalDraft(draft(branchFields), context, "seed-b");
    return result.ok ? null : [result.code, result.path];
  };
  assert.deepEqual(failure({condition: "Two\nlines"}), ["branch_condition_invalid", "/draft/plan/nodes/1/condition"]);
  assert.deepEqual(failure({then: {kind: "sequence", nodes: []}}), ["empty_branch_path", "/draft/plan/nodes/1"]);
  assert.deepEqual(failure({goto: "release"}), ["invalid_branch_node_fields", "/draft/plan/nodes/1"]);
  assert.deepEqual(failure({else: {kind: "sequence", nodes: [{kind: "branch", condition: "Nested.", reason: "Nested choice.", then: {kind: "sequence", nodes: [localStep("x")]}}]}}), null,
    "a nested branch in the else path is valid");
});

// the workflow store with a review workflow and a task-local branch in its agreed plan
const taskSourceHash = fingerprint("Ship the export change.");
const storeFixture = Effect.gen(function* () {
  const directory = yield* temporaryDirectory("workflow-branches-");
  const stores = yield* openWorkflowStores(directory);
  yield* execute(stores.sql, "INSERT INTO meta VALUES(?,?)", `supervisor_control:${JSON.stringify("project-a")}`, JSON.stringify({generation: 1, enabled: true, manual: true}));
  const reserved = yield* stores.supervisors.reserve("project-a", "main-a", "Main conversation", defaultSupervisorModel, 1, 1);
  yield* stores.supervisors.setBinding({...reserved, state: "ready"});
  const owner: WorkflowOwner = {projectId: "project-a", mainThreadId: "main-a", supervisorThreadId: reserved.threadId, bindingGeneration: reserved.generation};
  const context = proposalContextFromDefinitions(snapshotOf([{workflow: "review"}]));
  const canonical = validateWorkflowPlan({requirements: [{kind: "workflow", id: "review", applies: true, reason: "Every change is reviewed."}],
    plan: {kind: "sequence", nodes: [localStep("implement"), reviewReference, {kind: "branch", condition: "The change migrates stored data.", reason: "Rollout depends on data.",
      then: {kind: "sequence", nodes: [localStep("backup")]}}, localStep("release")]}}, context);
  assert.ok(canonical?.plan);
  const proposal = {status: "proposed", message: "A draft.", workspaceRoot: "/workspace/project-a", revision: "definitions-1", globalRevision: null, ...canonical} as WorkflowProposalInfo;
  const binding: WorkflowStateSourceBinding = {workspaceRoot: "/workspace/project-a", revision: "definitions-1", globalRevision: null, definitionsStatus: "ready",
    definitionsComplete: true, requirementsKnown: true, taskId: "task-a", proposalId: "proposal-a", sourceHash: taskSourceHash};
  const agreement: WorkflowAgreementImport = {taskId: "task-a", sourceThreadId: "main-a", sourceRunId: "run-a", sourceMessageId: "message-a", sourceHash: taskSourceHash,
    objective: "Ship the export change.", agreement: {status: "agreed", message: "Accepted.", proposalId: "proposal-a", agreedAt: 10,
      evidence: {kind: "supervisor_message", messageId: "supervisor-message"}, agentMessageId: "agent-message", workflow: proposal}};
  assert.equal((yield* stores.workflows.importAcceptedAgreement(owner, agreement, 100)).status, "applied");
  const validation = {pinnedContext: context, originalProposal: proposal, expectedTaskId: "task-a", expectedProposalId: "proposal-a",
    expectedSourceHash: taskSourceHash, acceptedTaskAgreement: null, acceptedTaskAgreementSourceHash: null};
  const main = () => Effect.map(stores.workflows.get("project-a", "main-a"), document => document!);
  const apply = (document: WorkflowStateDocument, plan: WorkflowPlanGroupInfo | null, operationId: string, at: number, extra: Partial<WorkflowApplyInput> = {}) =>
    stores.workflows.apply(owner, {operationId, workflowId: document.workflowId, expectedRevision: document.revision, status: document.status, objective: document.objective,
      sourceBinding: binding, requirements: document.threadId === "main-a" ? [...proposal.requirements] : [], issues: [...proposal.issues], plan, note: "Revise the plan.", ...extra}, validation, at);
  const select = (nodeId: string, revision: number, path: "then" | "else", sourceCreatedAt: number, at: number, author = "main-a") =>
    stores.workflows.recordBranchSelection(owner, {nodeId, revision, path, reason: `Context decided ${path}.`, sourceThreadId: author, sourceRunId: `${author}-run`,
      sourceMessageId: `${author}-message-${revision}-${path}-${sourceCreatedAt}`, sourceCreatedAt} satisfies BranchSelectionImport, at);
  return {stores, owner, main, apply, select, binding, proposal};
});
const reviewBranch = (document: WorkflowStateDocument) => planBranches(document.plan)[0]!;
const localBranch = (document: WorkflowStateDocument) => planBranches(document.plan)[1]!;
const withLocalBranch = (plan: WorkflowPlanGroupInfo, change: (branch: WorkflowPlanBranchInfo) => WorkflowPlanBranchInfo | null): WorkflowPlanGroupInfo =>
  ({...plan, nodes: plan.nodes.flatMap((node): WorkflowPlanNodeInfo[] => {
    if (node.kind !== "branch") return [node];
    const next = change(node);
    return next ? [next] : [];
  })});
const selections = (document: WorkflowStateDocument) => document.branchSelections.map(item => [item.revision, item.path, item.state]);
// the plan with every applicable occurrence, or only the chosen ones, recorded completed, with the status evidence each change needs
const completeApplicable = (document: WorkflowStateDocument, chosen: (nodeId: string) => boolean = () => true) => {
  const reach = new Map(planReach(document.plan, documentBranchSelections(document)).map(({node, reach}) => [node, reach] as const));
  const evidence: NonNullable<WorkflowApplyInput["evidence"]> = [];
  const group = (value: WorkflowPlanGroupInfo): WorkflowPlanGroupInfo => ({...value, nodes: value.nodes.map(visit)});
  const visit = (node: WorkflowPlanNodeInfo): WorkflowPlanNodeInfo => {
    if (node.kind === "sequence" || node.kind === "parallel") return group(node);
    if (node.kind === "branch") return {...node, then: group(node.then), else: node.else ? group(node.else) : null};
    return entity(node as Extract<WorkflowPlanNodeInfo, {kind: "step" | "workflow"}>);
  };
  const entity = (node: Extract<WorkflowPlanNodeInfo, {kind: "step" | "workflow"}>): WorkflowPlanNodeInfo => {
    const done = (reach.get(node) === "unconditional" || reach.get(node) === "selected") && chosen(node.nodeId) && node.status !== "completed";
    if (done) evidence.push({kind: "status_changed", targetNodeId: node.nodeId, note: `${node.name} is complete.`});
    const status = done ? "completed" as const : node.status;
    return node.kind === "workflow" ? {...node, status, plan: node.plan ? group(node.plan) : null} : {...node, status};
  };
  return {plan: group(document.plan!), evidence};
};

it.live("selections import under revision fences, and an invalidated selection stays pending on rescan until a later next revision", () => Effect.gen(function* () {
  const {main, apply, select} = yield* storeFixture;
  let document = yield* main();
  const branch = localBranch(document);
  assert.equal((yield* select(branch.nodeId, 1, "then", 1000, 1000)).status, "applied");
  assert.equal((yield* select(branch.nodeId, 1, "then", 1000, 1001)).status, "unchanged", "an identical replay changes nothing");
  assert.deepEqual(yield* select(branch.nodeId, 3, "else", 1002, 1002), {status: "rejected", code: "branch_revision_gap"});
  assert.deepEqual(yield* select(branch.nodeId, 1, "else", 1003, 1003), {status: "rejected", code: "branch_revision_conflict"});
  assert.deepEqual(yield* select(randomUUID(), 1, "then", 1004, 1004), {status: "rejected", code: "branch_node_unknown"});
  document = yield* main();
  assert.deepEqual([...documentBranchSelections(document)], [[branch.nodeId, "then"]]);
  const agreementKey = document.currentAgreementKey;
  assert.ok(agreementKey, "a selection is not a structural edit and keeps the agreement pointer");

  // a status change and support work around the branch leave the selection current
  const supported = {...document.plan!, nodes: [...document.plan!.nodes, {...localStep("notify"), nodeId: randomUUID(), templatePath: null, source: null, resolution: "resolved",
    status: "planned", contributorThreadIds: []} as WorkflowPlanNodeInfo]};
  assert.equal((yield* apply(document, supported, "add-support", 1500)).status, "applied");
  document = yield* main();
  assert.deepEqual(selections(document), [[1, "then", "current"]]);

  // a changed condition invalidates the selection for good: the old record's replay leaves the decision pending
  assert.equal((yield* apply(document, withLocalBranch(document.plan!, item => ({...item, condition: "The change rewrites stored data."})), "reword", 2000)).status, "applied");
  document = yield* main();
  assert.deepEqual(selections(document), [[1, "then", "invalidated"]]);
  assert.equal(document.evidence.filter(item => item.kind === "branch_selection_invalidated").length, 1);
  assert.equal((yield* select(branch.nodeId, 1, "then", 1000, 2100)).status, "unchanged");
  assert.equal(documentBranchSelections(yield* main()).size, 0, "the rescan of an older record never reactivates it");
  assert.deepEqual(yield* select(branch.nodeId, 2, "else", 1900, 2200), {status: "rejected", code: "branch_record_outdated"},
    "a record written before the change does not answer the changed branch");
  assert.equal((yield* select(branch.nodeId, 2, "else", 2300, 2300)).status, "applied");
  document = yield* main();
  assert.deepEqual([...documentBranchSelections(document)], [[branch.nodeId, "else"]]);

  // returning to the earlier condition, then removing and reintroducing the branch, never revives an earlier selection
  assert.equal((yield* apply(document, withLocalBranch(document.plan!, item => ({...item, condition: "The change migrates stored data."})), "reword-back", 3000)).status, "applied");
  document = yield* main();
  assert.equal(documentBranchSelections(document).size, 0);
  const restored = localBranch(document);
  assert.equal((yield* apply(document, withLocalBranch(document.plan!, () => null), "remove", 3100)).status, "applied");
  document = yield* main();
  assert.equal((yield* apply(document, {...document.plan!, nodes: [...document.plan!.nodes.slice(0, 2), restored, ...document.plan!.nodes.slice(2)]}, "reintroduce", 3200)).status, "applied");
  document = yield* main();
  assert.equal(localBranch(document).nodeId, restored.nodeId);
  assert.equal((yield* select(branch.nodeId, 2, "else", 2300, 3300)).status, "unchanged");
  assert.equal(documentBranchSelections(yield* main()).size, 0);
  assert.deepEqual((yield* main()).evidence.filter(item => item.kind === "branch_selected").map(item => [item.branch?.revision, item.branch?.path, item.sourceMessageId]),
    [[1, "then", "main-a-message-1-then-1000"], [2, "else", "main-a-message-2-else-2300"]], "selection history keeps its native attribution");
}));

it.live("a selection belongs to its author's own workflow: a child cannot select the main's branch and the main cannot select the child's", () => Effect.gen(function* () {
  const {stores, owner, main, apply, select} = yield* storeFixture;
  const linked = yield* stores.workflows.linkChild(owner, {operationId: "link-child", lineage: {threadId: "child-a", parentThreadId: "main-a", relationshipToParent: "subagent"},
    note: "The reviewer child."}, 200);
  assert.equal(linked.status, "created");
  const child = (yield* stores.workflows.get("project-a", "main-a", "child-a"))!;
  const childPlan = canonicalizeProposalDraft({requirements: [], plan: {kind: "sequence", nodes: [{kind: "branch", condition: "The diff stays within one module.",
    reason: "Review depth.", then: {kind: "sequence", nodes: [localStep("single-review")]}, else: {kind: "sequence", nodes: [localStep("paired-review")]}}]}},
  proposalContextFromDefinitions({...snapshotOf([]), threadId: "main-a"}), "child");
  assert.ok(childPlan.ok);
  assert.equal((yield* apply(child, childPlan.workflow.plan, "child-plan", 300)).status, "applied");
  const childBranch = planBranches((yield* stores.workflows.get("project-a", "main-a", "child-a"))!.plan)[0]!;
  const mainBranch = reviewBranch(yield* main());
  assert.deepEqual(yield* select(childBranch.nodeId, 1, "then", 400, 400, "main-a"), {status: "rejected", code: "branch_node_unknown"});
  assert.deepEqual(yield* select(mainBranch.nodeId, 1, "then", 401, 401, "child-a"), {status: "rejected", code: "branch_node_unknown"});
  assert.equal((yield* select(childBranch.nodeId, 1, "else", 402, 402, "child-a")).status, "applied");
  const stored = (yield* stores.workflows.get("project-a", "main-a", "child-a"))!;
  assert.deepEqual([...documentBranchSelections(stored)], [[childBranch.nodeId, "else"]]);
  assert.deepEqual([stored.branchSelections[0]?.sourceThreadId, stored.branchSelections[0]?.sourceRunId], ["child-a", "child-a-run"]);
  assert.equal((yield* main()).branchSelections.length, 0);
}));

it.live("a pending reached decision blocks a completed assessment, and a changed decision makes completion need reassessment without losing evidence", () => Effect.gen(function* () {
  const {main, apply, select} = yield* storeFixture;
  let document = yield* main();
  const complete = (current: WorkflowStateDocument, operationId: string, at: number) => {
    const done = completeApplicable(current);
    return apply(current, done.plan, operationId, at,
      {status: "completed", evidence: [{kind: "status_changed", note: "Every agreed duty is complete.", targetNodeId: null}, ...done.evidence]});
  };
  const pending = yield* complete(document, "complete-early", 1000);
  assert.equal(pending.status, "invalid");
  assert.equal(pending.status === "invalid" ? pending.reason : null, "branch_decision_pending");
  assert.match(pending.status === "invalid" && "diagnostic" in pending ? pending.diagnostic?.path ?? "" : "", /^\/plan\/nodes\/1\/plan\/nodes\/1$/u, "the pending review branch is named");

  const reviewWorkflow = document.plan!.nodes[1] as Extract<WorkflowPlanNodeInfo, {kind: "workflow"}>;
  const reviewDone = {...document.plan!, nodes: document.plan!.nodes.map(node => node === reviewWorkflow ? {...reviewWorkflow, status: "completed" as const} : node)};
  const occurrence = yield* apply(document, reviewDone, "complete-review-early", 1001,
    {evidence: [{kind: "status_changed", note: "Reviewed.", targetNodeId: reviewWorkflow.nodeId}]});
  assert.equal(occurrence.status === "invalid" ? occurrence.reason : occurrence.status, "branch_decision_pending", "a workflow occurrence with a pending inner decision cannot complete");

  assert.equal((yield* select(reviewBranch(document).nodeId, 1, "then", 1100, 1100)).status, "applied");
  assert.equal((yield* select(localBranch(document).nodeId, 1, "else", 1101, 1101)).status, "applied");
  document = yield* main();
  assert.equal((yield* complete(document, "complete", 1200)).status, "applied");
  document = yield* main();
  assert.equal(document.status, "completed");
  assert.equal(workflowAssessment(document)?.reassessment, null);

  assert.equal((yield* select(reviewBranch(document).nodeId, 2, "else", 1300, 1300)).status, "applied");
  document = yield* main();
  assert.equal(document.status, "completed", "the recorded status stays");
  assert.match(workflowAssessment(document)?.reassessment ?? "", /changed after this completion was assessed/u);
  assert.deepEqual(document.evidence.filter(item => item.kind === "branch_selected").map(item => [item.branch?.path, item.branch?.changed]),
    [["then", true], ["else", true], ["else", true]]);
  assert.ok(document.evidence.some(item => item.kind === "status_changed" && item.statusTo === "completed"), "the completion evidence stays");
}));

it.live("a not-selected path neither raises attention nor counts as active work", () => Effect.gen(function* () {
  const {stores, main, apply, select} = yield* storeFixture;
  let document = yield* main();
  const branch = reviewBranch(document);
  assert.equal((yield* select(branch.nodeId, 1, "then", 1000, 1000)).status, "applied");
  document = yield* main();
  const elseStep = planEntities(branch.else).find(node => node.kind === "step" && node.definitionId === "iterate")!;
  const mark = (plan: WorkflowPlanGroupInfo): WorkflowPlanGroupInfo => ({...plan, nodes: plan.nodes.map(function visit(node): WorkflowPlanNodeInfo {
    if (node.kind === "step") return node.nodeId === elseStep.nodeId ? {...node, status: "needs_attention"} : node;
    if (node.kind === "workflow") return {...node, plan: node.plan ? {...node.plan, nodes: node.plan.nodes.map(visit)} : null};
    if (node.kind === "branch") return {...node, then: {...node.then, nodes: node.then.nodes.map(visit)}, else: node.else ? {...node.else, nodes: node.else.nodes.map(visit)} : null};
    if (node.kind === "back_to") return node;
    return {...node, nodes: node.nodes.map(visit)};
  })});
  assert.equal((yield* apply(document, mark(document.plan!), "flag-unselected", 1100, {evidence: [{kind: "status_changed", note: "Earlier work stalled.", targetNodeId: elseStep.nodeId}]})).status, "applied");
  document = yield* main();
  const scan = yield* stores.workflows.hasNeedsAttention("project-a", "main-a", ["main-a"]);
  assert.deepEqual(scan, {status: "complete", needsAttention: false, inspected: 1}, "the recorded status stays as history only");
  const reach = new Map(planReach(document.plan, documentBranchSelections(document)).map(({node, reach}) => ["nodeId" in node ? node.nodeId : node.kind, reach]));
  assert.equal(reach.get(elseStep.nodeId), "not_selected");
  assert.equal(reach.get(branch.then.nodes[0]!.kind === "step" ? (branch.then.nodes[0] as {nodeId: string}).nodeId : ""), "selected");
  assert.equal(reach.get(planBranches(document.plan)[1]!.nodeId), "unconditional", "the task-local branch itself sits on the unconditional path");
  assert.equal(reach.get(planEntities(planBranches(document.plan)[1]!.then)[0]!.nodeId), "undecided");
}));

it.live("a record written before the latest change of its branch never selects it, with or without an earlier selection", () => Effect.gen(function* () {
  const {main, apply, select} = yield* storeFixture;
  let document = yield* main();
  const branch = localBranch(document);
  const reword = (condition: string, operationId: string, at: number) => Effect.gen(function* () {
    const current = yield* main();
    assert.equal((yield* apply(current, withLocalBranch(current.plan!, item => ({...item, condition})), operationId, at)).status, "applied");
  });
  // revision 1 written for condition A is observed only after A changed to B, with no selection ever recorded
  yield* reword("The change rewrites stored data.", "to-b", 2000);
  assert.deepEqual(yield* select(branch.nodeId, 1, "then", 1500, 2100), {status: "rejected", code: "branch_record_outdated"});
  // a selection answering B is invalidated by B to C; a record written for C is observed only after C changed to D and never answers D
  assert.equal((yield* select(branch.nodeId, 1, "then", 2050, 2100)).status, "applied");
  yield* reword("The change rewrites shared stored data.", "to-c", 3000);
  yield* reword("The change rewrites shared data across tenants.", "to-d", 4000);
  assert.deepEqual(yield* select(branch.nodeId, 2, "else", 3500, 4100), {status: "rejected", code: "branch_record_outdated"});
  // supporting work and a status change elsewhere leave the boundary where the last branch change put it
  document = yield* main();
  const support = {...document.plan!, nodes: [...document.plan!.nodes, {...localStep("notify"), nodeId: randomUUID(), templatePath: null, source: null, resolution: "resolved",
    status: "planned", contributorThreadIds: []} as WorkflowPlanNodeInfo]};
  assert.equal((yield* apply(document, support, "support", 5000)).status, "applied");
  assert.equal((yield* select(branch.nodeId, 2, "else", 4500, 5100)).status, "applied", "a record after the last branch change but before unrelated edits still answers it");
  document = yield* main();
  assert.deepEqual([...documentBranchSelections(document)], [[branch.nodeId, "else"]]);
  assert.deepEqual(document.branchSelections.map(item => [item.revision, item.condition]), [[2, "The change rewrites shared data across tenants."]]);
  assert.deepEqual(document.evidence.filter(item => item.kind === "branch_changed").map(item => [item.targetNodeId, item.recordedAt]),
    [[branch.nodeId, 2000], [branch.nodeId, 3000], [branch.nodeId, 4000]], "each change of this branch is a retained boundary; the support edit adds none");
  assert.deepEqual(document.evidence.filter(item => item.kind === "branch_selected" || item.kind === "branch_selection_invalidated").map(item => [item.kind, item.recordedAt, item.branch?.condition]),
    [["branch_selected", 2100, "The change rewrites stored data."], ["branch_selection_invalidated", 3000, "The change rewrites stored data."],
      ["branch_selected", 5100, "The change rewrites shared data across tenants."]], "every selection event keeps the condition it answered");
}));

it.live("a nested completion older than the retained observations still dates against a later changed decision", () => Effect.gen(function* () {
  const {main, apply, select} = yield* storeFixture;
  let document = yield* main();
  const review = document.plan!.nodes[1] as Extract<WorkflowPlanNodeInfo, {kind: "workflow"}>;
  assert.equal((yield* select(reviewBranch(document).nodeId, 1, "then", 1100, 1100)).status, "applied");
  document = yield* main();
  // the earlier step and the review with its selected path are recorded completed together
  const reviewed = new Set([(document.plan!.nodes[0] as {nodeId: string}).nodeId, review.nodeId, ...planEntities(review.plan).map(node => node.nodeId)]);
  const reviewDone = completeApplicable(document, nodeId => reviewed.has(nodeId));
  assert.equal((yield* apply(document, reviewDone.plan, "complete-review", 1200, {status: "underway",
    evidence: [{kind: "status_changed", note: "Reviewed.", targetNodeId: null}, ...reviewDone.evidence]})).status, "applied");
  document = yield* main();
  assert.equal((yield* apply(document, document.plan, "later-notes", 1300, {evidence: Array.from({length: 20}, (_, index) =>
    ({kind: "note" as const, note: `Later note ${index + 1}.`, targetNodeId: null}))})).status, "applied");
  const render = (current: WorkflowStateDocument, withTimes = true) => {
    const progress = progressWorkflow(current, []);
    const html = renderToStaticMarkup(createElement(PlanJourney, {node: progress.plan!, mode: "live", selections: progress.branchSelections,
      notes: {agreed: null, proposed: null, records: recordsByStep(progress.observations), changed: new Set<string>()}, ...(withTimes ? {completions: completionTimes(progress)} : {})}));
    const reviewStart = html.indexOf(`${review.name}<span class="step-flags"><small>Workflow</small>`);
    assert.ok(reviewStart >= 0, "the review row exists before its status is checked");
    return {progress, review: html.slice(reviewStart)};
  };
  const fresh = render(yield* main());
  assert.ok(!fresh.progress.observations.some(item => item.targetNodeId === review.nodeId), "the completion record is outside the retained observations");
  assert.deepEqual(fresh.progress.completions, [{nodeId: review.nodeId, completedAt: 1200}], "the completion time is read before truncation");
  assert.match(fresh.review, /^[^<]+<span class="step-flags"><small>Workflow<\/small><\/span><\/span><span class="step-state">Completed</, "a completion after every decision inside it stays current");

  assert.equal((yield* select(reviewBranch(document).nodeId, 2, "else", 1400, 1400)).status, "applied");
  const changed = render(yield* main());
  assert.match(changed.review, /^[^<]+<span class="step-flags"><small>Workflow<\/small><\/span><\/span><span class="step-state">Completed earlier · needs reassessment</);
  assert.match(changed.review, /a branch decision inside it changed afterwards, so its completion needs reassessment\. The recorded status stays as history\./);
  const undated = render(yield* main(), false);
  assert.match(undated.review, /<span class="step-state">Completed earlier · needs reassessment</, "without a completion time, completion is not presented as current");
  assert.match(undated.review, /no completion time is available to show that it followed the branch decisions inside it/);
}));
