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
import type {WorkflowPlanGroupInfo, WorkflowPlanNodeInfo, WorkflowProposalInfo} from "../src/project-supervisor-contract.js";
import {canonicalizeProposalDraft, manifestMembers, prepareWorkflowRequest, proposalContextFromDefinitions, seededNodeIds, validateWorkflowApplyAgainstPinnedContext,
  validateWorkflowPlan} from "../src/supervisor-workflow.js";
import {preserveOccurrenceIds} from "../src/supervision-conversation.js";
import {workflowAssessment} from "../src/workflow-assessment.js";
import {branchSelectionImportDecision, documentBranchSelections, notApplicableNodeIds} from "../src/workflow-state-store.js";
import type {BranchSelectionImport, WorkflowAgreementImport, WorkflowApplyInput, WorkflowExecutionStatus, WorkflowOwner, WorkflowStateDocument,
  WorkflowStateSourceBinding} from "../src/workflow-state-contract.js";
import {isPlanGroup, occurrenceAttempts, planBackTos, planBranches, planEntities, planNodes, planStatusOutline, reachedBackTos, resolveBackTo, withOccurrenceStatuses} from "../src/workflow-plan-tree.js";
import {progressWorkflow} from "../src/workflow-progress.js";
import {scopedWorkflowText} from "../src/workflow-write-controller.js";
import {PlanJourney} from "../ui/src/workflow-journey.js";
import {effectiveIndex, indexSource, makeDefinitionFixture, projectIndex, stepSource, testSummary} from "./project-definitions-fixture.js";
import {execute, openWorkflowStores, temporaryDirectory} from "./support/g12-stores.js";

// back_to end to end below the native boundary: authored YAML, composed-plan validation, stable occurrence identity across revisions,
// and the returns, attempts and late-output fences of the workflow store

const fixAndReturn = "name: Fix and return\ndescription: Fix the findings, then review again.\nsequence:\n  - step: fix\n  - back_to: review\n";
const deliveryFlow = "name: Delivery flow\ndescription: Implement, review and deliver.\nsequence:\n  - step: implement\n  - step: review\n  - step: deliver\n";
const reviewLoop = "name: Review loop\ndescription: Review until no findings remain.\nsequence:\n  - step: implement\n  - step: review\n" +
  "  - branch:\n      if: Findings remain.\n      then:\n        - step: fix\n        - back_to: review\n";
const stepIds = ["implement", "review", "fix", "deliver", "verify"];
const snapshot = (): ProjectDefinitionSnapshot => {
  const steps = stepIds.map(id => ({id, name: id, description: `Complete ${id}.`, summary: testSummary(id), origin: "project" as const, path: `.t3-supervisor/steps/${id}.md`, sourceId: id}));
  const workflow = (id: string, source: string) => ({...parseDefinitionWorkflow(id, source), summary: testSummary(id), origin: "project" as const,
    path: `.t3-supervisor/workflows/${id}.yaml`, sourceId: id});
  const workflows = [workflow("fix-and-return", fixAndReturn), workflow("delivery-flow", deliveryFlow), workflow("fixed-delivery", deliveryFlow.replace("sequence:", "fixed: true\nsequence:")), workflow("review-loop", reviewLoop)];
  const index = {steps: stepIds, workflows: workflows.map(item => item.id), required: []};
  return {projectId: "project-a", threadId: "main-a", workspaceRoot: "/workspace/project-a", globalOnly: false, globalRevision: null, revision: "definitions-1",
    editingAvailable: true, status: "ready", steps, workflows, config: effectiveIndex({steps, workflows}, []), projectConfig: projectIndex(index), definitionFiles: [],
    complete: true, sources: [{path: ".t3-supervisor/project.yaml", content: indexSource(index), origin: "project"}], issues: []};
};
const context = proposalContextFromDefinitions(snapshot());

const local = (id: string) => ({kind: "step", definitionId: null, localId: id, name: id, description: `Complete ${id}.`, reason: `The task needs ${id}.`});
const step = (id: string) => ({kind: "step", definitionId: id, reason: `The task needs ${id}.`});
const backTo = (target: string) => ({kind: "back_to", target, reason: `Repeat from ${target} while findings remain.`});
const branch = (condition: string, then: unknown[], otherwise?: unknown[]) => ({kind: "branch", condition, reason: "The findings decide.",
  then: {kind: "sequence", nodes: then}, ...(otherwise ? {else: {kind: "sequence", nodes: otherwise}} : {})});
const draft = (...nodes: unknown[]) => ({requirements: [], plan: {kind: "sequence", nodes}});
const canonical = (value: unknown, seed = "seed-a", base: WorkflowPlanGroupInfo | null = null): WorkflowPlanGroupInfo => {
  const result = canonicalizeProposalDraft(value, context, seed, base);
  assert.ok(result.ok, JSON.stringify(result));
  return result.workflow.plan!;
};
const localNode = (plan: WorkflowPlanGroupInfo | null, id: string) => planEntities(plan).find(node => node.kind === "step" && (node.localId ?? node.definitionId) === id)!;
const nodeIdsOf = (plan: WorkflowPlanGroupInfo | null): string[] => planNodes(plan).flatMap(node => isPlanGroup(node) ? [] : [node.nodeId]);
// every occurrence ID renamed, as a plan stored before template members derived their IDs would carry arbitrary ones
const renameIds = (plan: WorkflowPlanGroupInfo, rename: (id: string) => string): WorkflowPlanGroupInfo => {
  const group = (value: WorkflowPlanGroupInfo): WorkflowPlanGroupInfo => ({...value, nodes: value.nodes.map(node)});
  const node = (value: WorkflowPlanNodeInfo): WorkflowPlanNodeInfo => {
    switch (value.kind) {
      case "sequence": case "parallel": return group(value);
      case "branch": return {...value, nodeId: rename(value.nodeId), then: group(value.then), else: value.else ? group(value.else) : null};
      case "back_to": return {...value, nodeId: rename(value.nodeId), targetNodeId: value.targetNodeId ? rename(value.targetNodeId) : null};
      case "workflow": return {...value, nodeId: rename(value.nodeId), plan: value.plan ? group(value.plan) : null};
      case "step": return {...value, nodeId: rename(value.nodeId)};
    }
  };
  return group(plan);
};

it("definitions parse a return in a sequence or branch path and reject one that is not last or sits directly in a parallel group", () => {
  const loop = parseDefinitionWorkflow("review-loop", "name: Review loop\ndescription: Review until no findings remain.\nsequence:\n  - step: implement\n  - step: review\n" +
    "  - branch:\n      if: Findings remain.\n      then:\n        - step: fix\n        - back_to: review\n  - step: deliver\n");
  assert.deepEqual(loop.sequence, [{step: "implement"}, {step: "review"}, {branch: {if: "Findings remain.", then: [{step: "fix"}, {back_to: "review"}]}}, {step: "deliver"}]);
  assert.deepEqual(manifestMembers(loop.sequence!), ["step:implement", "step:review", "if \"Findings remain.\" then: step:fix", "if \"Findings remain.\" then: back_to:review",
    "if \"Findings remain.\" else: (nothing)", "step:deliver"]);
  const reason = (body: string) => {
    try {parseDefinitionWorkflow("broken", `name: Broken\ndescription: Broken workflow.\n${body}`);return null;} catch (error) {return (error as Error).message;}
  };
  assert.match(reason("sequence:\n  - step: a\n  - back_to: a\n  - step: b\n") ?? "accepted", /back_to must be the last member of its sequence or branch path/u);
  assert.match(reason("sequence:\n  - step: a\n  - branch:\n      if: Again.\n      then:\n        - back_to: a\n        - step: b\n") ?? "accepted", /back_to must be the last member/u);
  assert.match(reason("parallel:\n  - step: a\n  - back_to: a\n") ?? "accepted", /back_to cannot be a direct parallel member/u);
  assert.match(reason("sequence:\n  - step: a\n  - back_to: Not an id\n") ?? "accepted", /back_to must name the step, local step or workflow ID/u);
  assert.match(reason("sequence:\n  - step: a\n  - back_to: a\n    step: b\n") ?? "accepted", /exactly one step, workflow, sequence, parallel, branch or back_to key/u);
  // a return that is last and outside any branch parses: whether the composed plan can still complete is decided there
  assert.equal(reason("sequence:\n  - step: a\n  - back_to: a\n"), null);
});

const loadShared = (global: Record<string, string>) => Effect.gen(function* () {
  const fixture = makeDefinitionFixture({globalEnabled: true});
  const write = (root: string, entries: Record<string, string>) => {
    for (const [path, contents] of Object.entries(entries)) fixture.addFile(root, `.t3-supervisor/${path}`, contents);
    fixture.writeIndex(root, {required: []});
  };
  write(fixture.threadRoot!, {"steps/.gitkeep": "", "workflows/.gitkeep": ""});
  write(fixture.globalRoot, global);
  return yield* (yield* fixture.makeDefinitions()).load("project", "thread");
});

it.effect("shared definitions namespace a return to a reusable member and keep a return to a local step", () => Effect.gen(function* () {
  const shared = yield* loadShared({"steps/review.md": stepSource("review", "Review the change."), "steps/fix.md": stepSource("fix", "Fix the findings."),
    "workflows/loop.yaml": "name: Loop\ndescription: Review until clean.\nsequence:\n  - step: review\n  - step: {id: tidy, name: Tidy, description: Tidy the change.}\n" +
      "  - branch:\n      if: Findings remain.\n      then:\n        - step: fix\n        - back_to: review\n  - branch:\n      if: The change is untidy.\n      then:\n        - back_to: tidy\n"});
  assert.equal(shared.status, "ready", JSON.stringify(shared.issues));
  const loop = shared.workflows.find(workflow => workflow.sourceId === "loop")!;
  const review = shared.steps.find(item => item.sourceId === "review")!;
  assert.match(review.id, /^g[0-9a-f]{63}$/u);
  const branches = loop.sequence!.filter((node): node is Extract<DefinitionNode, {branch: unknown}> => "branch" in node);
  assert.deepEqual(branches.map(node => node.branch.then.at(-1)), [{back_to: review.id}, {back_to: "tidy"}]);
  const plan = canonicalizeProposalDraft(draft({kind: "workflow", definitionId: loop.id, reason: "Review until clean."}), proposalContextFromDefinitions(shared), "seed-shared");
  assert.ok(plan.ok, JSON.stringify(plan));
  const [toReview, toTidy] = planBackTos(plan.workflow.plan);
  assert.equal(toReview!.targetNodeId, planEntities(plan.workflow.plan).find(node => node.kind === "step" && node.definitionId === review.id)!.nodeId);
  assert.equal(toTidy!.targetNodeId, planEntities(plan.workflow.plan).find(node => node.kind === "step" && node.localId === "tidy")!.nodeId);
}));

it("a composed plan resolves each return to the one earlier member of its sequential lane and reports why one cannot", () => {
  const loopDraft = draft(local("implement"), local("review"), branch("Findings remain.", [local("fix"), backTo("review")]), local("deliver"));
  const plan = canonical(loopDraft);
  const [returning] = planBackTos(plan);
  assert.equal(returning!.targetNodeId, localNode(plan, "review").nodeId);
  const resolved = resolveBackTo(plan, returning!.nodeId);
  assert.ok(resolved.ok);
  // the region runs from the target through the branch holding the return: not implement before it, nor deliver after it
  assert.deepEqual(resolved.regionNodeIds, [localNode(plan, "review").nodeId, planBranches(plan)[0]!.nodeId, localNode(plan, "fix").nodeId, returning!.nodeId]);
  assert.deepEqual(canonical(loopDraft), plan, "the same draft yields the same record");

  const failure = (...nodes: unknown[]) => {
    const result = canonicalizeProposalDraft(draft(...nodes), context, "seed-b");
    return result.ok ? null : [result.code, result.path];
  };
  assert.deepEqual(failure(local("review"), branch("Findings remain.", [backTo("missing")])), ["back_to_target_not_found", "/draft/plan/nodes/1/then/nodes/0"]);
  assert.deepEqual(failure(branch("Findings remain.", [backTo("deliver")]), local("deliver")), ["back_to_target_not_found", "/draft/plan/nodes/0/then/nodes/0"],
    "a later member is never a target");
  assert.deepEqual(failure(step("verify"), step("verify"), branch("Findings remain.", [backTo("verify")])), ["back_to_target_ambiguous", "/draft/plan/nodes/2/then/nodes/0"]);
  assert.deepEqual(failure(local("review"), branch("Findings remain.", [backTo("review"), local("fix")])), ["back_to_unreachable_member", "/draft/plan/nodes/1/then/nodes/0"]);
  assert.deepEqual(failure(local("review"), backTo("review")), ["back_to_no_exit_cycle", "/draft/plan/nodes/1"]);
  assert.deepEqual(failure(local("review"), branch("Findings remain.", [backTo("review")], [local("fix"), backTo("review")])),
    ["back_to_no_exit_cycle", "/draft/plan/nodes/1/then/nodes/0"], "a branch whose every path returns cannot complete either");
  // the lane ends at a parallel group: a return never reaches before the group, and one placed directly in it has no lane
  const lane = (...nodes: unknown[]) => ({kind: "parallel", nodes: [local("other"), {kind: "sequence", nodes}]});
  assert.deepEqual(failure(local("review"), lane(local("check"), branch("Checks fail.", [backTo("review")]))), ["back_to_target_not_found", "/draft/plan/nodes/1/nodes/1/nodes/1/then/nodes/0"]);
  assert.equal(failure(local("review"), lane(local("check"), branch("Checks fail.", [backTo("check")]))), null, "a return within its own lane");
  assert.deepEqual(failure(local("review"), {kind: "parallel", nodes: [local("other"), backTo("review")]}), ["back_to_target_not_found", "/draft/plan/nodes/1/nodes/1"]);
  assert.deepEqual(failure(local("review"), branch("Findings remain.", [{kind: "back_to", target: "Review step", reason: "Again."}])),
    ["back_to_target_invalid", "/draft/plan/nodes/1/then/nodes/0/target"]);
  assert.deepEqual(failure(local("review"), branch("Findings remain.", [{kind: "back_to", target: "review", reason: "Again.", goto: "review"}])),
    ["invalid_back_to_node_fields", "/draft/plan/nodes/1/then/nodes/0"]);

  // a reusable workflow may return to its caller's earlier member; without an exit around it the composed plan cannot complete
  const reference = {kind: "workflow", definitionId: "fix-and-return", reason: "Fix, then review again."};
  const caller = canonical(draft(step("review"), branch("Findings remain.", [reference])));
  const nested = planBackTos(caller)[0]!;
  assert.deepEqual([nested.templatePath, nested.targetNodeId], ["workflow:fix-and-return/root/1", localNode(caller, "review").nodeId]);
  assert.deepEqual(failure(step("review"), reference), ["back_to_no_exit_cycle", "/draft/plan/nodes/1/plan/nodes/1"]);

  // a flexible workflow may leave out a member, but never the one its return repeats
  const loop = (member: string) => ({kind: "workflow", definitionId: "review-loop", reason: "Review until clean.", omit: [{member, reason: "It does not apply."}]});
  assert.deepEqual(failure(loop("review")), ["omission_return_target", "/draft/plan/nodes/0/omit/0"]);
  assert.equal(failure(loop("implement")), null);
});

it("a return reached inside an earlier member holds a later return back, while another parallel lane never does", () => {
  const plan = canonical(draft(local("review"), {kind: "parallel", nodes: [{kind: "sequence", nodes: [local("check"), branch("Checks fail.", [backTo("check")])]}, local("other")]},
    branch("Findings remain.", [backTo("review")])));
  const [inner, outer] = planBackTos(plan);
  const [laneBranch, outerBranch] = planBranches(plan);
  const statuses = (except: string[] = []) => {
    const result = withOccurrenceStatuses(plan, planEntities(plan).flatMap(node => except.includes(node.nodeId) ? [] : [{nodeId: node.nodeId, status: "completed" as const}]));
    assert.ok("plan" in result);
    return result.plan;
  };
  const reached = (current: WorkflowPlanGroupInfo, selected: Array<[string, "then" | "else"]>) => reachedBackTos(current, new Map(selected), new Set()).map(node => node.nodeId);
  assert.deepEqual(reached(statuses([localNode(plan, "other").nodeId]), [[laneBranch!.nodeId, "then"]]), [inner!.nodeId], "the other lane still running holds nothing back");
  assert.deepEqual(reached(statuses(), [[laneBranch!.nodeId, "then"], [outerBranch!.nodeId, "then"]]), [inner!.nodeId], "the lane has not completed normally");
  assert.deepEqual(reached(statuses(), [[laneBranch!.nodeId, "else"], [outerBranch!.nodeId, "then"]]), [outer!.nodeId]);
  assert.deepEqual(reached(statuses([localNode(plan, "check").nodeId]), [[outerBranch!.nodeId, "then"]]), [], "an unsettled earlier member holds a return back");
});

it("a revision keeps every existing occurrence's actual ID, old in-flight member IDs included, and the proposal and apply derive the same new member", () => {
  const pinned = prepareWorkflowRequest("main-a", "message-a", "Ship the change.", snapshot()).context;
  assert.ok(pinned);
  const reference = (extra: Record<string, unknown> = {}) => ({kind: "workflow", definitionId: "delivery-flow", reason: "Deliver the change.", ...extra});
  const first = canonicalizeProposalDraft(draft(reference({omit: [{member: "review", reason: "A trivial change needs no review."}]})), pinned, "proposal-1");
  assert.ok(first.ok, JSON.stringify(first));
  const occurrence = first.workflow.plan!.nodes[0]!;
  assert.ok(occurrence.kind === "workflow" && occurrence.plan);
  // an occurrence stored before template members derived their IDs carries arbitrary ones; a revision keeps them instead of re-deriving
  const legacy = new Map(planEntities(occurrence.plan).map(node => [node.nodeId, randomUUID()] as const));
  const inflight = renameIds(first.workflow.plan!, id => legacy.get(id) ?? id);
  const revised = canonicalizeProposalDraft(draft(reference()), pinned, "proposal-2", inflight);
  assert.ok(revised.ok, JSON.stringify(revised));
  assert.equal(revised.workflow.plan!.nodes[0]!.kind === "workflow" && revised.workflow.plan!.nodes[0]!.nodeId, occurrence.nodeId, "the reference keeps its occurrence");
  for (const id of ["implement", "deliver"]) assert.equal(localNode(revised.workflow.plan, id).nodeId, localNode(inflight, id).nodeId, `${id} keeps its in-flight ID`);
  const added = localNode(revised.workflow.plan, "review").nodeId;
  assert.equal(added[14], "8", "the member the revision includes again derives its ID from its occurrence");
  assert.deepEqual(canonicalizeProposalDraft(draft(reference()), pinned, "proposal-2", inflight), revised, "the same revision against the same base is the same record");
  assert.deepEqual(canonicalizeProposalDraft(draft(reference({nodeId: occurrence.nodeId})), pinned, "proposal-2", inflight), revised, "an explicit nodeId names the same occurrence");
  const unanchored = canonicalizeProposalDraft(draft(reference()), pinned, "proposal-2");
  assert.ok(unanchored.ok);
  assert.notEqual(unanchored.workflow.plan!.nodes[0]!.kind === "workflow" && unanchored.workflow.plan!.nodes[0]!.nodeId, occurrence.nodeId,
    "without its base a revision would allocate another occurrence");

  // applying the revised reference against the in-flight plan keeps the same IDs and derives the same new member
  const proposal: WorkflowProposalInfo = {status: "proposed", message: "Draft.", workspaceRoot: pinned.workspaceRoot, revision: pinned.revision, globalRevision: null, ...revised.workflow};
  const sourceBinding = {workspaceRoot: pinned.workspaceRoot, revision: pinned.revision, globalRevision: null, definitionsStatus: "ready" as const,
    definitionsComplete: true, requirementsKnown: true, taskId: "task-a", proposalId: "proposal-2", sourceHash: "source-hash"};
  const applyWith = (plan: unknown) => validateWorkflowApplyAgainstPinnedContext({plan, requirements: proposal.requirements, issues: proposal.issues, sourceBinding},
    pinned, proposal, "task-a", "proposal-2", "source-hash", {targetThreadId: "main-a", mainThreadId: "main-a"}, [], inflight, undefined, seededNodeIds("apply"));
  const applied = applyWith(draft(reference({nodeId: occurrence.nodeId})).plan);
  assert.ok(applied);
  assert.deepEqual(nodeIdsOf(applied.plan), nodeIdsOf(revised.workflow.plan));
  assert.equal(applyWith(draft(reference()).plan), null, "an apply still names an existing occurrence by its nodeId");
});

it("a return keeps its identity and target when a re-interpreted plan reuses the previous occurrence IDs", () => {
  const loopDraft = draft(local("implement"), local("review"), branch("Findings remain.", [local("fix"), backTo("review")]));
  const previous = canonical(loopDraft, "first");
  const next = canonical(loopDraft, "second");
  assert.notDeepEqual(nodeIdsOf(next), nodeIdsOf(previous));
  const preserved = preserveOccurrenceIds(next, previous);
  assert.deepEqual(nodeIdsOf(preserved), nodeIdsOf(previous));
  assert.equal(planBackTos(preserved)[0]!.targetNodeId, localNode(previous, "review").nodeId);
});

// the workflow store with a task-local review loop in its agreed plan
const taskSourceHash = fingerprint("Ship the reviewed change.");
const storeFixture = (nodes: unknown[]) => Effect.gen(function* () {
  const directory = yield* temporaryDirectory("workflow-back-to-");
  const stores = yield* openWorkflowStores(directory);
  yield* execute(stores.sql, "INSERT INTO meta VALUES(?,?)", `supervisor_control:${JSON.stringify("project-a")}`, JSON.stringify({generation: 1, enabled: true, manual: true}));
  const reserved = yield* stores.supervisors.reserve("project-a", "main-a", "Main conversation", defaultSupervisorModel, 1, 1);
  yield* stores.supervisors.setBinding({...reserved, state: "ready"});
  const owner: WorkflowOwner = {projectId: "project-a", mainThreadId: "main-a", supervisorThreadId: reserved.threadId, bindingGeneration: reserved.generation};
  const plan = validateWorkflowPlan(draft(...nodes), context);
  assert.ok(plan?.plan);
  const proposal = {status: "proposed", message: "A draft.", workspaceRoot: "/workspace/project-a", revision: "definitions-1", globalRevision: null, ...plan} as WorkflowProposalInfo;
  const binding: WorkflowStateSourceBinding = {workspaceRoot: "/workspace/project-a", revision: "definitions-1", globalRevision: null, definitionsStatus: "ready",
    definitionsComplete: true, requirementsKnown: true, taskId: "task-a", proposalId: "proposal-a", sourceHash: taskSourceHash};
  const agreement: WorkflowAgreementImport = {taskId: "task-a", sourceThreadId: "main-a", sourceRunId: "run-a", sourceMessageId: "message-a", sourceHash: taskSourceHash,
    objective: "Ship the reviewed change.", agreement: {status: "agreed", message: "Accepted.", proposalId: "proposal-a", agreedAt: 10,
      evidence: {kind: "supervisor_message", messageId: "supervisor-message"}, agentMessageId: "agent-message", workflow: proposal}};
  assert.equal((yield* stores.workflows.importAcceptedAgreement(owner, agreement, 100)).status, "applied");
  const validation = {pinnedContext: context, originalProposal: proposal, expectedTaskId: "task-a", expectedProposalId: "proposal-a",
    expectedSourceHash: taskSourceHash, acceptedTaskAgreement: null, acceptedTaskAgreementSourceHash: null};
  const main = () => Effect.map(stores.workflows.get("project-a", "main-a"), document => document!);
  type Cite = {sourceThreadId?: string; sourceRunId?: string};
  // records the named local steps' statuses, with the status evidence each change needs, citing the given run
  const advance = (document: WorkflowStateDocument, operationId: string, at: number, changes: Record<string, WorkflowExecutionStatus>,
    options: {status?: WorkflowExecutionStatus; cite?: Cite; contributors?: Record<string, string[]>; evidence?: NonNullable<WorkflowApplyInput["evidence"]>} = {}) => {
    const evidence: NonNullable<WorkflowApplyInput["evidence"]> = [];
    const status = options.status ?? document.status;
    if (status !== document.status) evidence.push({kind: "status_changed", targetNodeId: null, note: `The task is ${status}.`});
    const group = (value: WorkflowPlanGroupInfo): WorkflowPlanGroupInfo => ({...value, nodes: value.nodes.map(visit)});
    const visit = (node: WorkflowPlanNodeInfo): WorkflowPlanNodeInfo => {
      if (node.kind === "sequence" || node.kind === "parallel") return group(node);
      if (node.kind === "branch") return {...node, then: group(node.then), else: node.else ? group(node.else) : null};
      if (node.kind !== "step" || node.localId === null) return node;
      const next = changes[node.localId] ?? node.status;
      if (next !== node.status) evidence.push({kind: "status_changed", targetNodeId: node.nodeId, note: `${node.localId} is ${next}.`, ...options.cite});
      return {...node, status: next, contributorThreadIds: options.contributors?.[node.localId] ?? node.contributorThreadIds};
    };
    return stores.workflows.apply(owner, {operationId, workflowId: document.workflowId, expectedRevision: document.revision, status, objective: document.objective,
      sourceBinding: binding, requirements: [...proposal.requirements], issues: [...proposal.issues], plan: group(document.plan!), note: "Record progress.",
      evidence: [...evidence, ...options.evidence ?? []]}, validation, at);
  };
  const select = (nodeId: string, revision: number, path: "then" | "else", sourceCreatedAt: number, at: number) =>
    stores.workflows.recordBranchSelection(owner, {nodeId, revision, path, reason: `Context decided ${path}.`, sourceThreadId: "main-a", sourceRunId: `main-run-${revision}`,
      sourceMessageId: `main-message-${revision}-${path}`, sourceCreatedAt} satisfies BranchSelectionImport, at);
  return {stores, owner, main, advance, select};
});
const invalidReason = (result: {status: string}) => result.status === "invalid" ? (result as unknown as {reason: string}).reason : result.status;
const diagnosticPath = (result: unknown) => (result as {diagnostic?: {path: string}}).diagnostic?.path ?? null;

it.live("a reached return waits for the Supervisor, then starts a new attempt that keeps the closed one and fences its retired runs", () => Effect.gen(function* () {
  const {stores, owner, main, advance, select} = yield* storeFixture([local("implement"), local("review"), branch("Findings remain.", [local("fix"), backTo("review")]), local("deliver")]);
  let document = yield* main();
  const ids = Object.fromEntries(["implement", "review", "fix", "deliver"].map(id => [id, localNode(document.plan, id).nodeId]));
  const loop = planBranches(document.plan)[0]!;
  const returning = planBackTos(document.plan)[0]!;
  assert.equal((yield* advance(document, "attempt-1-review", 1000, {implement: "completed", review: "completed"}, {status: "underway", contributors: {review: ["reviewer-1"]}})).status, "applied");
  assert.equal((yield* select(loop.nodeId, 1, "then", 1100, 1100)).status, "applied");
  assert.deepEqual((yield* main()).returns, [], "a selection alone does not reach the return while fix is open");
  document = yield* main();
  assert.equal((yield* advance(document, "attempt-1-fix", 1200, {fix: "completed"}, {cite: {sourceThreadId: "child-1", sourceRunId: "child-run-1"}})).status, "applied");
  document = yield* main();
  assert.equal(document.returns.length, 1);
  const [pending] = document.returns;
  assert.deepEqual({...pending!, returnId: "id"}, {returnId: "id", backToNodeId: returning.nodeId, targetNodeId: ids.review, regionNodeIds: [ids.review, loop.nodeId, ids.fix, returning.nodeId],
    attempt: 1, state: "pending", reason: "Context decided then.", sourceThreadId: "main-a", sourceRunId: "main-run-1", sourceMessageId: "main-message-1-then",
    requestedAt: 1200, resolvedAt: null, closed: null, closedSelections: null, retiredRuns: [], resolution: null});
  assert.deepEqual(document.evidence.filter(item => item.kind === "return_requested").map(item => [item.targetNodeId, item.return?.returnId]), [[ids.review, pending!.returnId]]);

  // while it waits, nothing after it is entered, its region keeps the closed attempt and the task does not complete
  const waiting = yield* advance(document, "deliver-early", 1300, {deliver: "underway"});
  assert.deepEqual([invalidReason(waiting), diagnosticPath(waiting)], ["return_pending", "/plan/nodes/3/status"]);
  assert.equal(invalidReason(yield* advance(document, "review-flag", 1300, {review: "needs_attention"})), "return_pending");
  assert.equal((yield* advance(document, "observe", 1300, {}, {evidence: [{kind: "observation", targetNodeId: ids.review!, note: "The reviewer is still writing up findings."}]})).status,
    "applied", "findings are recorded as observations meanwhile");
  document = yield* main();

  // the Supervisor applies it at a safe point, naming the child runs of the closed attempt
  const applyInput = {operationId: "return-1", workflowId: document.workflowId, expectedRevision: document.revision, returnId: pending!.returnId,
    note: "The reviewer found issues; repeat the review.", retiredRuns: [{threadId: "child-1", runId: "child-run-1"}]};
  assert.equal((yield* stores.workflows.applyReturn(owner, {...applyInput, expectedRevision: document.revision - 1}, 2000)).status, "conflict");
  assert.equal(invalidReason(yield* stores.workflows.applyReturn(owner, {...applyInput, returnId: "unknown"}, 2000)), "return_not_pending");
  assert.equal(invalidReason(yield* stores.workflows.applyReturn(owner, {...applyInput, retiredRuns: [{threadId: "child-1"}] as never}, 2000)), "invalid_return_apply");
  const receipt = yield* stores.workflows.applyReturn(owner, applyInput, 2000);
  assert.equal(receipt.status, "applied", JSON.stringify(receipt));
  assert.deepEqual(yield* stores.workflows.applyReturn(owner, applyInput, 2500), receipt, "an exact replay returns the stored receipt");
  assert.deepEqual(yield* stores.workflows.applyReturn(owner, {...applyInput, note: "Another note."}, 2500),
    {status: "conflict", operationId: "return-1", reason: "operation_id_reused", currentRevision: null});
  const agreementKey = document.currentAgreementKey;
  document = yield* main();
  const status = (id: string) => localNode(document.plan, id);
  assert.deepEqual(["implement", "review", "fix", "deliver"].map(id => status(id).status), ["completed", "planned", "planned", "planned"]);
  assert.deepEqual(status("review").contributorThreadIds, ["reviewer-1"], "the same reviewer conversation stays linked");
  assert.equal(document.currentAgreementKey, agreementKey, "the plan and its agreement are unchanged");
  const [applied] = document.returns;
  assert.deepEqual([applied!.state, applied!.resolvedAt, applied!.closed, applied!.closedSelections, applied!.retiredRuns, applied!.resolution],
    ["applied", 2000, [{nodeId: ids.review, status: "completed", contributorThreadIds: ["reviewer-1"]}, {nodeId: ids.fix, status: "completed", contributorThreadIds: []}],
      [{nodeId: loop.nodeId, revision: 1, path: "then"}], [{threadId: "child-1", runId: "child-run-1"}],
      {operationId: "return-1", actorSupervisorThreadId: owner.supervisorThreadId, note: "The reviewer found issues; repeat the review."}]);
  assert.deepEqual(document.branchSelections.map(item => [item.revision, item.state, item.invalidatedAt]), [[1, "invalidated", 2000]]);
  assert.equal(documentBranchSelections(document).size, 0, "the decision is taken again in the new attempt");
  assert.deepEqual([...occurrenceAttempts(document.returns)], [[ids.review, 2], [loop.nodeId, 2], [ids.fix, 2], [returning.nodeId, 2]]);
  assert.deepEqual(planStatusOutline(document.plan, documentBranchSelections(document), new Set(), occurrenceAttempts(document.returns))
    .map(row => [row.kind, row.attempt ?? 1]), [["step", 1], ["step", 2], ["branch", 2], ["step", 2], ["back_to", 2], ["step", 1]]);

  // output of the closed attempt never counts for the new one
  assert.deepEqual(yield* select(loop.nodeId, 2, "else", 1900, 2100), {status: "rejected", code: "branch_record_outdated"}, "a decision written before the return");
  const retired = yield* advance(document, "retired-review", 2200, {review: "completed"}, {cite: {sourceThreadId: "child-1", sourceRunId: "child-run-1"}});
  assert.deepEqual([invalidReason(retired), diagnosticPath(retired)], ["retired_run_evidence", "/evidence/0"]);
  assert.equal((yield* advance(document, "late-observation", 2200, {}, {evidence: [{kind: "observation", targetNodeId: ids.review!, note: "A late report from the first review.",
    sourceThreadId: "child-1", sourceRunId: "child-run-1"}]})).status, "applied", "it stays visible as history of the closed attempt");
  document = yield* main();
  assert.equal((yield* advance(document, "attempt-2-review", 2300, {review: "completed"}, {cite: {sourceThreadId: "child-1", sourceRunId: "child-run-2"}})).status, "applied");
  assert.equal((yield* select(loop.nodeId, 2, "else", 2400, 2400)).status, "applied");
  document = yield* main();
  assert.equal(document.returns.length, 1, "the exit path reaches no return");
  assert.equal((yield* advance(document, "deliver", 2500, {deliver: "completed"}, {status: "completed"})).status, "applied");
  document = yield* main();
  assert.equal(document.status, "completed");
  assert.equal(workflowAssessment(document)?.reassessment, null, "the return was applied before this completion");

  const progress = progressWorkflow(document, []);
  assert.deepEqual(progress.returns?.map(item => [item.state, item.attempt, item.targetName, item.note]), [["applied", 1, "review", "The reviewer found issues; repeat the review."]]);
  assert.deepEqual(progress.attempts?.find(item => item.nodeId === ids.review), {nodeId: ids.review, attempt: 2});
  const html = renderToStaticMarkup(createElement(PlanJourney, {node: progress.plan!, mode: "live", selections: progress.branchSelections,
    attempts: new Map(progress.attempts!.map(item => [item.nodeId, item.attempt]))}));
  assert.ok(html.includes("Attempt 2") && html.includes("Return") && html.includes("Back to"), html);
}), {timeout: 20_000});

it.live("a return no longer reached is dismissed, and while one waits the task cannot complete", () => Effect.gen(function* () {
  const {main, advance, select} = yield* storeFixture([local("implement"), local("review"), branch("Findings remain.", [local("fix"), backTo("review")])]);
  let document = yield* main();
  const loop = planBranches(document.plan)[0]!;
  assert.equal((yield* advance(document, "work", 1000, {implement: "completed", review: "completed"}, {status: "underway"})).status, "applied");
  assert.equal((yield* select(loop.nodeId, 1, "then", 1100, 1100)).status, "applied");
  document = yield* main();
  assert.equal((yield* advance(document, "fix", 1200, {fix: "completed"})).status, "applied");
  document = yield* main();
  assert.deepEqual(document.returns.map(item => item.state), ["pending"]);
  const completing = yield* advance(document, "complete", 1300, {}, {status: "completed"});
  assert.deepEqual([invalidReason(completing), diagnosticPath(completing)], ["return_pending", "/status"]);
  // the operative takes the exit path instead: the return is dismissed and kept as history
  assert.equal((yield* select(loop.nodeId, 2, "else", 1400, 1400)).status, "applied");
  document = yield* main();
  assert.deepEqual(document.returns.map(item => [item.state, item.resolvedAt]), [["dismissed", 1400]]);
  assert.deepEqual(document.evidence.filter(item => item.kind.startsWith("return_")).map(item => item.kind), ["return_requested", "return_dismissed"]);
  assert.equal((yield* advance(document, "complete", 1500, {}, {status: "completed"})).status, "applied");
  // a later change back to the returning path asks again; the completed task then needs reassessment
  assert.equal((yield* select(loop.nodeId, 3, "then", 1600, 1600)).status, "applied");
  document = yield* main();
  assert.deepEqual(document.returns.map(item => [item.state, item.attempt]), [["dismissed", 1], ["pending", 1]]);
  assert.notEqual(document.returns[0]!.returnId, document.returns[1]!.returnId);
  assert.equal(workflowAssessment(document)?.reassessment, "A return to earlier work is pending, so this completion needs reassessment.");
}), {timeout: 20_000});

it("a branch record from a run a return retired never decides the reopened branch", () => {
  const plan = canonical(draft(local("review"), branch("Findings remain.", [local("fix"), backTo("review")])));
  const loop = planBranches(plan)[0]!;
  const document = {workflowId: "workflow-a", plan, branchSelections: [], evidence: [], returns: [{returnId: "return-a", backToNodeId: planBackTos(plan)[0]!.nodeId,
    targetNodeId: localNode(plan, "review").nodeId, regionNodeIds: [localNode(plan, "review").nodeId, loop.nodeId], attempt: 1, state: "applied", reason: "Findings remained.",
    sourceThreadId: null, sourceRunId: null, sourceMessageId: null, requestedAt: 10, resolvedAt: 20, closed: [], closedSelections: [],
    retiredRuns: [{threadId: "main-a", runId: "stale-run"}], resolution: {operationId: "return-a", actorSupervisorThreadId: "supervisor", note: "Repeat."}}]} as unknown as WorkflowStateDocument;
  const record = {nodeId: loop.nodeId, revision: 1, path: "else" as const, reason: "No findings.", sourceCreatedAt: 30};
  assert.deepEqual(branchSelectionImportDecision(document, {...record, sourceThreadId: "main-a", sourceRunId: "stale-run"}), {kind: "rejected", code: "branch_record_outdated"});
  assert.equal(branchSelectionImportDecision(document, {...record, sourceThreadId: "main-a", sourceRunId: "fresh-run"}).kind, "record");
  assert.deepEqual(branchSelectionImportDecision(document, {...record, sourceCreatedAt: 15, sourceThreadId: "main-a", sourceRunId: "fresh-run"}),
    {kind: "rejected", code: "branch_record_outdated"}, "a record written before the return");
});

it("a child's scoped workflow text names each occurrence with its status, attempt and branch reach, and the returns pending", () => {
  const plan = canonical(draft(local("implement"), local("review"), branch("Findings remain.", [local("fix"), backTo("review")])));
  const ids = Object.fromEntries(["implement", "review", "fix"].map(id => [id, localNode(plan, id).nodeId]));
  const loop = planBranches(plan)[0]!;
  const returning = planBackTos(plan)[0]!;
  const progressed = withOccurrenceStatuses(plan, [{nodeId: ids.implement!, status: "completed"}]);
  assert.ok("plan" in progressed);
  const region = [ids.review!, loop.nodeId, ids.fix!, returning.nodeId];
  const returnEntry = (state: "applied" | "pending", attempt: number) => ({returnId: `return-${state}`, backToNodeId: returning.nodeId, targetNodeId: ids.review!, regionNodeIds: region,
    attempt, state, reason: "Findings remained.", sourceThreadId: null, sourceRunId: null, sourceMessageId: null, requestedAt: 10, resolvedAt: state === "applied" ? 20 : null,
    closed: state === "applied" ? [] : null, closedSelections: state === "applied" ? [] : null, retiredRuns: [],
    resolution: state === "applied" ? {operationId: "return-1", actorSupervisorThreadId: "supervisor", note: "Repeat."} : null});
  const document = {workflowId: "child-workflow", revision: 4, status: "underway", parentWorkflowId: "main-workflow", objective: "Build the client.", plan: progressed.plan,
    branchSelections: [], evidence: [], sourceBinding: null, returns: [returnEntry("applied", 1), returnEntry("pending", 2)]} as unknown as WorkflowStateDocument;
  const text = scopedWorkflowText(document);
  assert.ok(text.startsWith("Your scoped workflow child-workflow, revision 4, status underway, inside parent workflow main-workflow.\nObjective: Build the client.\nPlan:\n"), text);
  assert.ok(text.includes(`- implement [local:implement; ${ids.implement}] completed`), text);
  assert.ok(text.includes(`- review [local:review; ${ids.review}] planned, attempt 2`), text);
  assert.ok(text.includes(`- branch [${loop.nodeId}] if: Findings remain. — decision pending\n`), text);
  assert.ok(text.includes(`  - return to review [${returning.nodeId}] (then path, awaiting decision)`), text);
  assert.ok(text.includes(`Return pending since attempt 2: back to [${ids.review}]; your Supervisor starts the next attempt.`), text);
});


it.live("returning clears a prior attempt's not-applicable assessment and retains it in forward history", () => Effect.gen(function* () {
  const {stores, owner, main, select} = yield* storeFixture([{kind: "workflow", definitionId: "fixed-delivery", reason: "Deliver the change."},
    branch("Repeat the review.", [backTo("fixed-delivery")])]);
  let document = yield* main();
  const review = localNode(document.plan, "review").nodeId;
  const workflow = planEntities(document.plan).find(node => node.kind === "workflow")!;
  const statuses = withOccurrenceStatuses(document.plan!, planEntities(document.plan).map(node => ({nodeId: node.nodeId,
    status: node.nodeId === review ? "planned" as const : "completed" as const})));
  assert.ok("plan" in statuses);
  // a valid retained fixed-member disposition is seeded so this regression exercises return application, not disposition creation
  const firstAttempt: WorkflowStateDocument = {...document, status: "underway", plan: statuses.plan, evidence: [...document.evidence,
    {id: randomUUID(), operationId: "first-attempt-skip", kind: "not_applicable", targetNodeId: review, targetNodeName: "review",
      actorSupervisorThreadId: owner.supervisorThreadId, recordedAt: 1000, sourceThreadId: null, sourceRunId: null, sourceMessageId: null, sourceItemId: null,
      scopeRevision: document.sourceBinding!.sourceHash, agreementKey: null, statusFrom: null, statusTo: null, note: "The first attempt needed no review."}]};
  assert.equal(workflow.kind, "workflow");
  yield* execute(stores.sql, "UPDATE supervisor_workflow_state SET document=? WHERE workflow_id=?", JSON.stringify(firstAttempt), document.workflowId);
  const decision = planBranches(document.plan)[0]!;
  assert.equal((yield* select(decision.nodeId, 1, "then", 1000, 1000)).status, "applied");
  document = yield* main();
  const pending = document.returns.find(item => item.state === "pending")!;
  assert.ok(pending);
  assert.equal(notApplicableNodeIds(document.evidence, document.sourceBinding!.sourceHash).has(review), true);
  assert.equal((yield* stores.workflows.applyReturn(owner, {operationId: "return-after-skipping", workflowId: document.workflowId,
    expectedRevision: document.revision, returnId: pending.returnId, note: "A changed result now requires the review."}, 1000)).status, "applied");
  document = yield* main();
  assert.equal(notApplicableNodeIds(document.evidence, document.sourceBinding!.sourceHash).has(review), false);
  const progress = progressWorkflow(document, []);
  assert.equal(progress.observations.some(item => item.targetNodeId === review && item.kind === "not_applicable"), false);
  assert.equal(progress.history?.find(item => item.kind === "not_applicable")?.attempt, 1);
  assert.equal(progress.history?.find(item => item.kind === "return_applied")?.attempt, 2, "append order distinguishes the new attempt even at the same timestamp");
  assert.match(workflowAssessment(document)!.summary, /Attempt 2 starts/);
  assert.equal(document.status, "underway");
}));

it.live("forward history includes the old records beyond the current-step preview", () => Effect.gen(function* () {
  const {main, advance} = yield* storeFixture([local("review")]);
  const document = yield* main();
  const review = localNode(document.plan, "review").nodeId;
  assert.equal((yield* advance(document, "many-observations", 1000, {}, {evidence: Array.from({length: 30}, (_, index) =>
    ({kind: "observation" as const, targetNodeId: review, note: `Observation ${index + 1}`}))})).status, "applied");
  const progress = progressWorkflow(yield* main(), []);
  assert.equal(progress.observations.length, 20);
  assert.equal(progress.historyComplete, true);
  assert.equal(progress.history?.filter(item => item.kind === "observation").length, 30);
  assert.ok(progress.history?.some(item => item.note === "Observation 1"));
  assert.ok(progress.history?.some(item => item.note === "Observation 30"));
  assert.deepEqual(progress.history?.map(item => item.sequence), Array.from({length: progress.history!.length}, (_, index) => index + 1));
}));
