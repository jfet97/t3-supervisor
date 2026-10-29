import assert from "node:assert/strict";
import {it} from "@effect/vitest";
import {Effect} from "effect";
import {parseDefinitionWorkflow} from "../src/project-definitions.js";
import type {WorkflowPlanGroupInfo, WorkflowPlanNodeInfo, WorkflowProposalInfo} from "../src/project-supervisor-contract.js";
import {defaultSupervisorModel} from "../src/project-supervisor-store.js";
import {canonicalizeProposalDraft, proposalContextFromDefinitions, validateWorkflowPlan} from "../src/supervisor-workflow.js";
import {workflowMutationLimits, type WorkflowAgreementImport, type WorkflowApplyInput, type WorkflowExecutionStatus, type WorkflowOwner, type WorkflowStateDocument, type WorkflowStateSourceBinding} from "../src/workflow-state-contract.js";
import {backToContext, occurrenceAttempts, planBackTos, planBranches, planEntities, retainReturnBudgetIds, returnBudgetAddress, returnBudgetUsed, strictlyNestedReplayReturns, withOccurrenceStatuses} from "../src/workflow-plan-tree.js";
import {effectiveIndex, indexSource, projectIndex} from "./project-definitions-fixture.js";
import {execute, openWorkflowStores, query, temporaryDirectory} from "./support/g12-stores.js";
import {guidanceTransaction} from "../src/guidance-sql.js";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {progressWorkflow} from "../src/workflow-progress.js";
import {PlanJourney, previousAttempts, readyAfterReturn} from "../ui/src/workflow-journey.js";
import {historyOperations, operationHeadline, WorkflowHistory} from "../ui/src/workflow-history.js";

// parser and workflow-store proof for a bounded return: the budget is the applied-jump ledger, and resets follow replay scope

const context = proposalContextFromDefinitions({
  projectId: "project-a", threadId: "main-a", workspaceRoot: "/workspace/project-a", globalOnly: false, globalRevision: null, revision: "definitions-1",
  editingAvailable: true, status: "ready", steps: [], workflows: [], config: effectiveIndex({steps: [], workflows: []}, []),
  projectConfig: projectIndex({steps: [], workflows: [], required: []}), definitionFiles: [], complete: true,
  sources: [{path: ".t3-supervisor/project.yaml", content: indexSource({steps: [], workflows: [], required: []}), origin: "project"}], issues: [],
});
const local = (id: string) => ({kind: "step", definitionId: null, localId: id, name: id, description: `Complete ${id}.`, reason: `The task needs ${id}.`});
const backTo = (target: string, maximum: number) => ({kind: "back_to", target, maximum, reason: `Repeat from ${target} while findings remain.`});
const branch = (condition: string, then: unknown[]) => ({kind: "branch", condition, reason: "The findings decide.", then: {kind: "sequence", nodes: then}});
const draft = (...nodes: unknown[]) => ({requirements: [], plan: {kind: "sequence", nodes}});
const composed = (...nodes: unknown[]): WorkflowPlanGroupInfo => {
  const result = canonicalizeProposalDraft(draft(...nodes), context, "return-budget");
  assert.ok(result.ok, JSON.stringify(result));
  return result.workflow.plan!;
};
const taskSourceHash = "ship-the-reviewed-change";
const planOf = (document: WorkflowStateDocument): WorkflowPlanGroupInfo => {
  if (document.plan === null) throw new Error("expected a live plan");
  return document.plan;
};

const laneA = [local("implement"), {kind: "parallel", nodes: [
  {kind: "sequence", nodes: [local("reviewa"), branch("Lane A findings.", [local("fixa"), backTo("reviewa", 2)])]},
  {kind: "sequence", nodes: [local("reviewb"), branch("Lane B findings.", [local("fixb"), backTo("reviewb", 2)])]},
]}, branch("Overall findings.", [backTo("implement", 2)]), local("deliver")];
const laneB = [local("setup"), {kind: "parallel", nodes: [
  {kind: "sequence", nodes: [local("worka"), branch("Lane A repeats.", [local("checka"), branch("Nested check fails.", [backTo("checka", 2)]), backTo("worka", 2)])]},
  {kind: "sequence", nodes: [local("workb"), branch("Lane B repeats.", [backTo("workb", 2)])]},
]}, branch("Outer repeats.", [backTo("setup", 2)])];
const equalScopes = [local("implement"), {kind: "sequence", nodes: [branch("Path A.", [backTo("implement", 3)]), branch("Path B.", [backTo("implement", 3)])]}];
const crossingScopes = [local("a"), local("b"), branch("Back to a.", [backTo("a", 3)]), branch("Back to b.", [backTo("b", 3)])];

const targetsOf = (nodes: readonly {target: string}[]) => nodes.map(node => node.target).sort();

it("replay reset follows the resolved region and refuses a missing or unsafe maximum", () => {
  const reason = (body: string) => {
    try {parseDefinitionWorkflow("broken", `name: Broken\ndescription: Broken workflow.\n${body}`); return null;}
    catch (error) {return (error as Error).message;}
  };
  assert.match(reason("sequence:\n  - step: a\n  - back_to: a\n") ?? "accepted", /back_to requires a maximum as back_to\(n\)/u);
  for (const token of ["0", "01", "-1", "1.5", "1e2"])
    assert.match(reason(`sequence:\n  - step: a\n  - back_to(${token}): a\n`) ?? "accepted", /no sign, fraction, or leading zero/u, token);
  assert.match(reason("sequence:\n  - step: a\n  - back_to(100): a\n") ?? "accepted", /integer from 1 to 99/u);
  assert.equal(reason("sequence:\n  - step: a\n  - back_to(1): a\n"), null);

  const outer = composed(...laneA);
  const [reviewA, reviewB, implement] = planBackTos(outer);
  assert.deepEqual(targetsOf(strictlyNestedReplayReturns(outer, implement!.nodeId)), ["reviewa", "reviewb"]);
  assert.deepEqual(strictlyNestedReplayReturns(outer, reviewA!.nodeId), []);
  assert.deepEqual(strictlyNestedReplayReturns(outer, reviewB!.nodeId), []);

  const confined = composed(...laneB);
  const nested = planBackTos(confined).find(node => node.target === "checka")!;
  const workA = planBackTos(confined).find(node => node.target === "worka")!;
  const workB = planBackTos(confined).find(node => node.target === "workb")!;
  const setup = planBackTos(confined).find(node => node.target === "setup")!;
  assert.deepEqual(targetsOf(strictlyNestedReplayReturns(confined, workA.nodeId)), ["checka"]);
  assert.deepEqual(strictlyNestedReplayReturns(confined, workB.nodeId), []);
  assert.deepEqual(strictlyNestedReplayReturns(confined, nested.nodeId), []);
  assert.deepEqual(targetsOf(strictlyNestedReplayReturns(confined, setup.nodeId)), ["checka", "worka", "workb"]);
  assert.ok(strictlyNestedReplayReturns(confined, setup.nodeId).every(node => node.nodeId !== setup.nodeId));

  const equal = composed(...equalScopes);
  const [pathA, pathB] = planBackTos(equal);
  assert.deepEqual(strictlyNestedReplayReturns(equal, pathA!.nodeId), []);
  assert.deepEqual(strictlyNestedReplayReturns(equal, pathB!.nodeId), []);
  const crossing = composed(...crossingScopes);
  const [toA, toB] = planBackTos(crossing);
  assert.deepEqual(strictlyNestedReplayReturns(crossing, toA!.nodeId), []);
  assert.deepEqual(strictlyNestedReplayReturns(crossing, toB!.nodeId), []);
  assert.notDeepEqual(backToContext(crossing, toA!.nodeId).earlier, backToContext(crossing, toB!.nodeId).earlier);
});

const invalidReason = (result: {status: string}) => result.status === "invalid" ? (result as {reason?: string}).reason ?? result.status : result.status;

const open = (nodes: unknown[], pinned = context) => Effect.gen(function* () {
  const directory = yield* temporaryDirectory("return-budget-");
  const stores = yield* openWorkflowStores(directory);
  yield* execute(stores.sql, "INSERT INTO meta VALUES(?,?)", `supervisor_control:${JSON.stringify("project-a")}`, JSON.stringify({generation: 1, enabled: true, manual: true}));
  const reserved = yield* stores.supervisors.reserve("project-a", "main-a", "Main conversation", defaultSupervisorModel, 1, 1);
  yield* stores.supervisors.setBinding({...reserved, state: "ready"});
  const owner: WorkflowOwner = {projectId: "project-a", mainThreadId: "main-a", supervisorThreadId: reserved.threadId, bindingGeneration: reserved.generation};
  const plan = validateWorkflowPlan(draft(...nodes), pinned);
  assert.ok(plan?.plan, "the agreed plan resolves");
  const proposal = {status: "proposed", message: "A draft.", workspaceRoot: "/workspace/project-a", revision: "definitions-1", globalRevision: null, ...plan} as WorkflowProposalInfo;
  const binding: WorkflowStateSourceBinding = {workspaceRoot: "/workspace/project-a", revision: "definitions-1", globalRevision: null, definitionsStatus: "ready",
    definitionsComplete: true, requirementsKnown: true, taskId: "task-a", proposalId: "proposal-a", sourceHash: taskSourceHash};
  const agreement: WorkflowAgreementImport = {taskId: "task-a", sourceThreadId: "main-a", sourceRunId: "run-a", sourceMessageId: "message-a", sourceHash: taskSourceHash,
    objective: "Ship the reviewed change.", agreement: {status: "agreed", message: "Accepted.", proposalId: "proposal-a", agreedAt: 10,
      evidence: {kind: "supervisor_message", messageId: "supervisor-message"}, agentMessageId: "agent-message", workflow: proposal}};
  assert.equal((yield* stores.workflows.importAcceptedAgreement(owner, agreement, 100)).status, "applied");
  const validation = {pinnedContext: pinned, originalProposal: proposal, expectedTaskId: "task-a", expectedProposalId: "proposal-a",
    expectedSourceHash: taskSourceHash, acceptedTaskAgreement: null, acceptedTaskAgreementSourceHash: null};
  const box = {stores};
  const main = () => Effect.map(box.stores.workflows.get("project-a", "main-a"), document => {
    assert.ok(document);
    return document;
  });
  const advance = (document: WorkflowStateDocument, operationId: string, at: number, changes: Record<string, WorkflowExecutionStatus>,
    status?: WorkflowExecutionStatus) => {
    const evidence: NonNullable<WorkflowApplyInput["evidence"]> = [];
    const nextStatus = status ?? document.status;
    if (nextStatus !== document.status) evidence.push({kind: "status_changed", targetNodeId: null, note: `The task is ${nextStatus}.`});
    const group = (value: WorkflowPlanGroupInfo): WorkflowPlanGroupInfo => ({...value, nodes: value.nodes.map(visit)});
    const visit = (node: WorkflowPlanNodeInfo): WorkflowPlanNodeInfo => {
      if (node.kind === "sequence" || node.kind === "parallel") return group(node);
      if (node.kind === "branch") return {...node, then: group(node.then), else: node.else ? group(node.else) : null};
      if (node.kind === "workflow") return {...node, plan: node.plan ? group(node.plan) : null};
      if (node.kind !== "step" || node.localId === null) return node;
      const next = changes[node.localId] ?? node.status;
      if (next !== node.status) evidence.push({kind: "status_changed", targetNodeId: node.nodeId, note: `${node.localId} is ${next}.`});
      return {...node, status: next};
    };
    return box.stores.workflows.apply(owner, {operationId, workflowId: document.workflowId, expectedRevision: document.revision, status: nextStatus,
      objective: document.objective, sourceBinding: binding, requirements: [...proposal.requirements], issues: [...proposal.issues], plan: group(document.plan!),
      note: "Record progress.", evidence}, validation, at);
  };
  const select = (nodeId: string, revision: number, path: "then" | "else", at: number) =>
    box.stores.workflows.recordBranchSelection(owner, {nodeId, revision, path, reason: `Context decided ${path}.`, sourceThreadId: "main-a",
      sourceRunId: `main-run-${revision}`, sourceMessageId: `main-message-${nodeId}-${revision}`, sourceCreatedAt: at}, at);
  const submit = (document: WorkflowStateDocument, operationId: string, at: number, planNode: WorkflowPlanGroupInfo) =>
    box.stores.workflows.apply(owner, {operationId, workflowId: document.workflowId, expectedRevision: document.revision, status: document.status,
      objective: document.objective, sourceBinding: binding, requirements: [...proposal.requirements], issues: [...proposal.issues], plan: planNode,
      note: "Revise the return.", evidence: []}, validation, at);
  let at = 1_000;
  const tick = () => at += 10;
  const complete = (ids: readonly string[], operationId: string) => Effect.gen(function* () {
    const document = yield* main();
    const changes = Object.fromEntries(ids.map(id => [id, "completed" as const]));
    const result = yield* advance(document, operationId, tick(), changes, document.status === "planned" ? "underway" : undefined);
    assert.equal(result.status, "applied", `${operationId} ${JSON.stringify(result)}`);
  });
  const choose = (condition: string, path: "then" | "else") => Effect.gen(function* () {
    const document = yield* main();
    const node = planBranches(document.plan).find(item => item.condition === condition);
    assert.ok(node, condition);
    const revision = document.branchSelections.filter(item => item.nodeId === node.nodeId).reduce((max, item) => Math.max(max, item.revision), 0) + 1;
    const result = yield* select(node.nodeId, revision, path, tick());
    assert.equal(result.status, "applied", `${condition} ${path} ${JSON.stringify(result)}`);
  });
  const jump = (target: string, operationId: string) => Effect.gen(function* () {
    const document = yield* main();
    const node = planBackTos(document.plan).find(item => item.target === target);
    assert.ok(node, target);
    const pending = document.returns.find(item => item.state === "pending" && item.backToNodeId === node.nodeId);
    assert.ok(pending, `pending return to ${target}`);
    const result = yield* box.stores.workflows.applyReturn(owner, {operationId, workflowId: document.workflowId, expectedRevision: document.revision,
      returnId: pending.returnId, note: `Apply the return to ${target}.`}, tick());
    assert.equal(result.status, "applied", `${operationId} ${JSON.stringify(result)}`);
    return result;
  });
  const budget = (target: string) => Effect.gen(function* () {
    const document = yield* main();
    const nodes = planBackTos(document.plan).filter(item => item.target === target);
    assert.equal(nodes.length, 1, target);
    const events = document.returnBudgets?.find(item => item.budgetId === nodes[0]!.budgetId)?.events ?? [];
    return {document, node: nodes[0]!, events, used: returnBudgetUsed(events)};
  });
  return {directory, box, owner, main, advance, select, submit, validation, proposal, binding, tick, complete, choose, jump, budget};
});

it.live("a maximum of one applied jump stays exhausted, and dismissal, rejection and replay consume nothing", () => Effect.gen(function* () {
  const opened = yield* open([local("work"), branch("Findings remain.", [backTo("work", 1)]), local("deliver")]);
  const {complete, choose, jump, budget, tick} = opened;
  let row = yield* budget("work");
  assert.equal(row.used, 0, "agreeing the plan consumes no jump");
  assert.deepEqual(row.events, []);
  yield* complete(["work"], "work-1");
  yield* choose("Findings remain.", "then");
  row = yield* budget("work");
  assert.equal(row.used, 0);
  assert.deepEqual(row.document.returns.map(item => item.state), ["pending"]);
  yield* choose("Findings remain.", "else");
  row = yield* budget("work");
  assert.equal(row.used, 0, "leaving the return unreached consumes nothing");
  assert.deepEqual(row.document.returns.map(item => item.state), ["dismissed"]);
  yield* choose("Findings remain.", "then");
  row = yield* budget("work");
  const pending = row.document.returns.find(item => item.state === "pending")!;
  const stale = yield* opened.box.stores.workflows.applyReturn(opened.owner, {operationId: "stale-return", workflowId: row.document.workflowId,
    expectedRevision: row.document.revision - 1, returnId: pending.returnId, note: "A stale apply."}, tick());
  assert.equal(stale.status, "conflict");
  row = yield* budget("work");
  assert.equal(row.used, 0, "a rejected apply consumes nothing");
  assert.equal(row.document.returns.find(item => item.returnId === pending.returnId)?.state, "pending");
  const applied = yield* jump("work", "return-1");
  const replay = yield* opened.box.stores.workflows.applyReturn(opened.owner, {operationId: "return-1", workflowId: row.document.workflowId,
    expectedRevision: row.document.revision, returnId: pending.returnId, note: "Apply the return to work."}, tick());
  assert.deepEqual(replay, applied, "replaying the applied operation does not debit again");
  row = yield* budget("work");
  assert.equal(row.used, 1);
  assert.deepEqual(row.events.map(event => event.kind), ["consumed"]);
  const second = yield* opened.box.stores.workflows.applyReturn(opened.owner, {operationId: "return-2", workflowId: row.document.workflowId,
    expectedRevision: row.document.revision, returnId: pending.returnId, note: "Apply it again."}, tick());
  assert.equal(invalidReason(second), "return_not_pending");
  row = yield* budget("work");
  assert.equal(row.used, 1);

  yield* complete(["work"], "work-2");
  yield* choose("Findings remain.", "then");
  row = yield* budget("work");
  const exhausted = row.document.returns.find(item => item.state === "exhausted")!;
  assert.equal(exhausted.resolvedAt, null);
  assert.equal(row.used, 1, "reaching the maximum requests no further jump");
  assert.ok(row.document.evidence.some(item => item.kind === "return_budget_exhausted"));
  const early = yield* opened.advance(row.document, "deliver-early", tick(), {deliver: "underway"});
  assert.equal(invalidReason(early), "return_budget_exhausted");
  const settled = yield* open([local("work"), branch("Findings remain.", [backTo("work", 1)])]);
  yield* settled.complete(["work"], "settled-work");
  yield* settled.choose("Findings remain.", "then");
  yield* settled.jump("work", "settled-jump");
  yield* settled.complete(["work"], "settled-work-2");
  yield* settled.choose("Findings remain.", "then");
  const completing = yield* settled.advance(yield* settled.main(), "complete-early", settled.tick(), {}, "completed");
  assert.equal(invalidReason(completing), "return_budget_exhausted");
  row = yield* budget("work");
  assert.equal(row.used, 1);
  assert.equal(row.document.status === "completed", false);

  yield* opened.box.stores.close;
  opened.box.stores = yield* openWorkflowStores(opened.directory);
  row = yield* budget("work");
  assert.equal(row.used, 1, "a restart keeps the consumed jump");
  assert.equal(row.document.returns.find(item => item.returnId === exhausted.returnId)?.state, "exhausted");
  const restated = yield* opened.advance(row.document, "restate", tick(), {});
  assert.equal(restated.status, "applied", JSON.stringify(restated));
  const restatedRow = yield* budget("work");
  assert.equal(restatedRow.node.budgetId, row.node.budgetId);
  assert.equal(restatedRow.used, 1, "submitting the same return does not refill its budget");

  yield* choose("Findings remain.", "else");
  row = yield* budget("work");
  const closed = row.document.returns.find(item => item.returnId === exhausted.returnId)!;
  assert.equal(closed.state, "exhausted");
  assert.equal(typeof closed.resolvedAt, "number");
  assert.equal(row.used, 1);
  yield* complete(["deliver"], "deliver");
  const done = yield* opened.advance(yield* opened.main(), "complete", tick(), {}, "completed");
  assert.equal(done.status, "applied", JSON.stringify(done));
  assert.equal((yield* opened.main()).status, "completed");
}), {timeout: 30_000});

it.live("applyReturn refuses a pending return whose ledger is already at its maximum and writes nothing", () => Effect.gen(function* () {
  const opened = yield* open([local("work"), branch("Findings remain.", [backTo("work", 2)])]);
  const {complete, choose, jump, budget, tick} = opened;
  yield* complete(["work"], "work-1");
  yield* choose("Findings remain.", "then");
  yield* jump("work", "return-1");
  yield* complete(["work"], "work-2");
  yield* choose("Findings remain.", "then");
  const row = yield* budget("work");
  assert.equal(row.used, 1);
  const pending = row.document.returns.find(item => item.state === "pending")!;
  const rawRows = yield* query(opened.box.stores.sql, "SELECT document FROM supervisor_workflow_state WHERE workflow_id=?", row.document.workflowId);
  const parsed = JSON.parse(String(rawRows[0]?.document)) as {returnBudgets: Array<{budgetId: string; events: Array<{kind: string; returnId: string; at: number}>}>};
  const ledger = parsed.returnBudgets.find(item => item.budgetId === row.node.budgetId)!;
  ledger.events.push({kind: "consumed", returnId: pending.returnId, at: 50});
  const mutated = JSON.stringify(parsed);
  yield* execute(opened.box.stores.sql, "UPDATE supervisor_workflow_state SET document=? WHERE workflow_id=?", mutated, row.document.workflowId);
  const refused = yield* opened.box.stores.workflows.applyReturn(opened.owner, {operationId: "return-over-max", workflowId: row.document.workflowId,
    expectedRevision: row.document.revision, returnId: pending.returnId, note: "This jump is already spent."}, tick());
  assert.equal(invalidReason(refused), "return_budget_exhausted");
  const stored = String((yield* query(opened.box.stores.sql, "SELECT document,revision FROM supervisor_workflow_state WHERE workflow_id=?", row.document.workflowId))[0]?.document);
  assert.equal(stored, mutated, "the refusal leaves the stored document unchanged");
  const reread = yield* budget("work");
  assert.equal(reread.used, 2);
  assert.equal(reread.document.returns.find(item => item.returnId === pending.returnId)?.state, "pending");
}), {timeout: 30_000});

it.live("an enclosing replay resets nested budgets, and a lane-local return leaves the sibling and the outer budget", () => Effect.gen(function* () {
  const covered = yield* open(laneA);
  const coveredRun = covered;
  yield* coveredRun.complete(["implement", "reviewa"], "lane-a-review");
  yield* coveredRun.choose("Lane A findings.", "then");
  yield* coveredRun.complete(["fixa"], "lane-a-fix");
  yield* coveredRun.jump("reviewa", "jump-review-a");
  yield* coveredRun.complete(["reviewb"], "lane-b-review");
  yield* coveredRun.choose("Lane B findings.", "then");
  yield* coveredRun.complete(["fixb"], "lane-b-fix");
  yield* coveredRun.jump("reviewb", "jump-review-b");
  const beforeOuter = yield* covered.main();
  const innerId = planBackTos(beforeOuter.plan).find(node => node.target === "reviewa")!.nodeId;
  const attemptsBefore = occurrenceAttempts(beforeOuter.returns).get(innerId) ?? 1;
  yield* coveredRun.complete(["reviewa"], "lane-a-exit");
  yield* coveredRun.choose("Lane A findings.", "else");
  yield* coveredRun.complete(["reviewb"], "lane-b-exit");
  yield* coveredRun.choose("Lane B findings.", "else");
  yield* coveredRun.choose("Overall findings.", "then");
  yield* coveredRun.jump("implement", "jump-outer");
  const afterOuter = yield* covered.main();
  const used = (target: string) => {
    const node = planBackTos(afterOuter.plan).find(item => item.target === target)!;
    return returnBudgetUsed(afterOuter.returnBudgets?.find(item => item.budgetId === node.budgetId)?.events ?? []);
  };
  assert.equal(used("reviewa"), 0);
  assert.equal(used("reviewb"), 0);
  assert.equal(used("implement"), 1);
  assert.ok((occurrenceAttempts(afterOuter.returns).get(innerId) ?? 1) > attemptsBefore, "attempt history stays monotonic when the budget resets");

  const confined = yield* open(laneB);
  const confinedRun = confined;
  yield* confinedRun.complete(["setup", "worka"], "setup-1");
  yield* confinedRun.choose("Lane A repeats.", "else");
  yield* confinedRun.complete(["workb"], "workb-1");
  yield* confinedRun.choose("Lane B repeats.", "else");
  yield* confinedRun.choose("Outer repeats.", "then");
  yield* confinedRun.jump("setup", "jump-setup");
  yield* confinedRun.complete(["setup", "worka"], "nested-setup");
  yield* confinedRun.choose("Lane A repeats.", "then");
  yield* confinedRun.complete(["checka"], "nested-check");
  yield* confinedRun.choose("Nested check fails.", "then");
  yield* confinedRun.jump("checka", "jump-nested");
  yield* confinedRun.complete(["workb"], "workb-2");
  yield* confinedRun.choose("Lane B repeats.", "then");
  yield* confinedRun.jump("workb", "jump-lane-b");
  const siblingBefore = (yield* confinedRun.budget("workb")).events.map(event => event.kind);
  const outerBefore = (yield* confinedRun.budget("setup")).events.map(event => event.kind);
  yield* confinedRun.complete(["checka"], "check-again");
  yield* confinedRun.choose("Nested check fails.", "else");
  yield* confinedRun.jump("worka", "jump-lane-a");
  const nestedAfter = yield* confinedRun.budget("checka");
  const siblingAfter = yield* confinedRun.budget("workb");
  const outerAfter = yield* confinedRun.budget("setup");
  const laneAfter = yield* confinedRun.budget("worka");
  assert.equal(nestedAfter.used, 0);
  assert.equal(laneAfter.used, 1);
  assert.deepEqual(siblingAfter.events.map(event => event.kind), siblingBefore);
  assert.deepEqual(outerAfter.events.map(event => event.kind), outerBefore);
  assert.equal(outerAfter.used, 1);
  assert.equal(siblingAfter.used, 1);
}), {timeout: 30_000});

it.live("equal and crossing replay scopes do not reset each other", () => Effect.gen(function* () {
  const equal = yield* open(equalScopes);
  const equalRun = equal;
  const jumpAt = (label: "Path A." | "Path B.", operationId: string) => Effect.gen(function* () {
    yield* equalRun.complete(["implement"], `${operationId}-work`);
    yield* equalRun.choose(label === "Path A." ? "Path B." : "Path A.", "else");
    yield* equalRun.choose(label, "then");
    const document = yield* equal.main();
    const plan = planOf(document);
    const branch = planBranches(plan).find(item => item.condition === label)!;
    const node = planBackTos(plan).find(item => backToContext(plan, item.nodeId).branches.at(-1)?.nodeId === branch.nodeId)!;
    const pending = document.returns.find(item => item.state === "pending" && item.backToNodeId === node.nodeId)!;
    const result = yield* equal.box.stores.workflows.applyReturn(equal.owner, {operationId, workflowId: document.workflowId, expectedRevision: document.revision,
      returnId: pending.returnId, note: `Apply ${label}.`}, equalRun.tick());
    assert.equal(result.status, "applied", JSON.stringify(result));
  });
  yield* jumpAt("Path A.", "equal-a-1");
  yield* jumpAt("Path B.", "equal-b-1");
  const midway = yield* equal.main();
  const usedAt = (document: WorkflowStateDocument, condition: string) => {
    const plan = planOf(document);
    const branch = planBranches(plan).find(item => item.condition === condition)!;
    const node = planBackTos(plan).find(item => backToContext(plan, item.nodeId).branches.at(-1)?.nodeId === branch.nodeId)!;
    return returnBudgetUsed(document.returnBudgets?.find(item => item.budgetId === node.budgetId)?.events ?? []);
  };
  assert.deepEqual([usedAt(midway, "Path A."), usedAt(midway, "Path B.")], [1, 1]);
  yield* jumpAt("Path A.", "equal-a-2");
  const after = yield* equal.main();
  assert.deepEqual([usedAt(after, "Path A."), usedAt(after, "Path B.")], [2, 1]);

  const crossing = yield* open(crossingScopes);
  const crossingRun = crossing;
  yield* crossingRun.complete(["a", "b"], "cross-a");
  yield* crossingRun.choose("Back to a.", "then");
  yield* crossingRun.jump("a", "jump-a");
  yield* crossingRun.complete(["a", "b"], "cross-b");
  yield* crossingRun.choose("Back to a.", "else");
  yield* crossingRun.choose("Back to b.", "then");
  yield* crossingRun.jump("b", "jump-b");
  const crossed = yield* crossing.main();
  const usedTarget = (target: string) => {
    const node = planBackTos(crossed.plan).find(item => item.target === target)!;
    return returnBudgetUsed(crossed.returnBudgets?.find(item => item.budgetId === node.budgetId)?.events ?? []);
  };
  assert.deepEqual([usedTarget("a"), usedTarget("b")], [1, 1]);
}), {timeout: 30_000});

it.live("a retained address keeps its usage, a single moved return inherits it, and an ambiguous move writes nothing", () => Effect.gen(function* () {
  const opened = yield* open([local("work"), branch("Findings remain.", [backTo("work", 5)])]);
  const run = opened;
  yield* run.complete(["work"], "work-1");
  yield* run.choose("Findings remain.", "then");
  yield* run.jump("work", "return-1");
  const spent = yield* run.budget("work");
  assert.ok(spent.document.plan);
  const edited = JSON.parse(JSON.stringify(spent.document.plan)) as WorkflowPlanGroupInfo;
  const visit = (node: WorkflowPlanNodeInfo): WorkflowPlanNodeInfo => {
    if (node.kind === "sequence" || node.kind === "parallel") return {...node, nodes: node.nodes.map(visit)};
    if (node.kind === "branch") return {...node, then: visit(node.then) as WorkflowPlanGroupInfo, else: node.else ? visit(node.else) as WorkflowPlanGroupInfo : null};
    if (node.kind === "back_to" && node.target === "work") return {...node, maximum: 4};
    return node;
  };
  const visited = visit(edited);
  if (visited.kind !== "sequence" && visited.kind !== "parallel") throw new Error("expected a group");
  const lowered = yield* opened.submit(spent.document, "lower-maximum", run.tick(), visited);
  assert.equal(lowered.status, "applied", JSON.stringify(lowered));
  const loweredRow = yield* run.budget("work");
  assert.equal(loweredRow.node.budgetId, spent.node.budgetId);
  assert.equal(loweredRow.node.maximum, 4);
  assert.equal(loweredRow.used, 1);

  assert.ok(loweredRow.document.plan);
  const movedSource = JSON.parse(JSON.stringify(loweredRow.document.plan)) as WorkflowPlanGroupInfo;
  const extra: WorkflowPlanNodeInfo = {kind: "step", nodeId: "00000000-0000-4000-8000-0000000000aa", definitionId: null, localId: "extra", templatePath: null,
    name: "extra", description: "Complete extra.", source: null, resolution: "resolved", reason: "The task needs extra.", status: "planned", contributorThreadIds: []};
  const moved = yield* opened.submit(loweredRow.document, "move-return", run.tick(), {...movedSource, nodes: [extra, ...movedSource.nodes]});
  assert.equal(moved.status, "applied", JSON.stringify(moved));
  const movedRow = yield* run.budget("work");
  assert.equal(movedRow.node.budgetId, spent.node.budgetId, "the only residual budget stays with the moved return");
  assert.equal(movedRow.used, 1);

  const ambiguous = yield* open([local("a"), branch("First.", [backTo("a", 5)]), local("b"), branch("Second.", [backTo("b", 5)])]);
  const other = ambiguous;
  yield* other.complete(["a"], "a-1");
  yield* other.choose("First.", "then");
  yield* other.jump("a", "jump-a");
  yield* other.complete(["a"], "a-2");
  yield* other.choose("First.", "else");
  yield* other.complete(["b"], "b-1");
  yield* other.choose("Second.", "then");
  yield* other.jump("b", "jump-b");
  const current = yield* ambiguous.main();
  assert.ok(current.plan);
  const renamed = JSON.parse(JSON.stringify(current.plan)) as WorkflowPlanGroupInfo;
  const retitle = (node: WorkflowPlanNodeInfo): WorkflowPlanNodeInfo => {
    if (node.kind === "sequence" || node.kind === "parallel") return {...node, nodes: node.nodes.map(retitle)};
    if (node.kind === "branch") return {...node, condition: `${node.condition} moved`, then: retitle(node.then) as WorkflowPlanGroupInfo, else: node.else ? retitle(node.else) as WorkflowPlanGroupInfo : null};
    return node;
  };
  const retitled = retitle(renamed);
  if (retitled.kind !== "sequence" && retitled.kind !== "parallel") throw new Error("expected a group");
  const spentIds = planBackTos(current.plan).map(node => [node.nodeId, node.budgetId]);
  const retitledResult = yield* ambiguous.submit(current, "retitle-returns", other.tick(), retitled);
  assert.equal(retitledResult.status, "applied", JSON.stringify(retitledResult));
  const kept = yield* ambiguous.main();
  assert.ok(kept.plan);
  assert.deepEqual(planBackTos(kept.plan).map(node => [node.nodeId, node.budgetId]), spentIds, "a preserved node keeps its budget across a retitle");
  const usedTarget = (document: WorkflowStateDocument, target: string) => {
    const node = planBackTos(document.plan).find(item => item.target === target)!;
    return returnBudgetUsed(document.returnBudgets?.find(item => item.budgetId === node.budgetId)?.events ?? []);
  };
  assert.deepEqual([usedTarget(kept, "a"), usedTarget(kept, "b")], [1, 1]);

  const detached = JSON.parse(JSON.stringify(kept.plan)) as WorkflowPlanGroupInfo;
  let slot = 0;
  const detach = (node: WorkflowPlanNodeInfo): WorkflowPlanNodeInfo => {
    if (node.kind === "sequence" || node.kind === "parallel") return {...node, nodes: node.nodes.map(detach)};
    if (node.kind === "branch") return {...node, condition: `${node.condition} again`, then: detach(node.then) as WorkflowPlanGroupInfo, else: node.else ? detach(node.else) as WorkflowPlanGroupInfo : null};
    if (node.kind !== "back_to") return node;
    slot += 1;
    return {...node, nodeId: `00000000-0000-4000-8000-0000000000d${slot}`, budgetId: (slot === 1 ? "c" : "d").repeat(64)};
  };
  const unidentified = detach(detached);
  if (unidentified.kind !== "sequence" && unidentified.kind !== "parallel") throw new Error("expected a group");
  const before = String((yield* query(ambiguous.box.stores.sql, "SELECT document FROM supervisor_workflow_state WHERE workflow_id=?", kept.workflowId))[0]?.document);
  const refused = yield* ambiguous.submit(kept, "unidentified-moves", other.tick(), unidentified);
  assert.equal(invalidReason(refused), "return_budget_identity_ambiguous");
  const after = String((yield* query(ambiguous.box.stores.sql, "SELECT document FROM supervisor_workflow_state WHERE workflow_id=?", kept.workflowId))[0]?.document);
  assert.equal(after, before, "two unidentified moves are not paired or zeroed");
}), {timeout: 30_000});

it.live("a stored return without a maximum stays raw and incompatible, and a plan without a return still reads with no ledger", () => Effect.gen(function* () {
  const opened = yield* open([local("work"), branch("Findings remain.", [backTo("work", 1)])]);
  const document = yield* opened.main();
  const raw = String((yield* query(opened.box.stores.sql, "SELECT document FROM supervisor_workflow_state WHERE workflow_id=?", document.workflowId))[0]?.document);
  const broken = JSON.parse(raw) as {workflowId: string; threadId: string; plan: {nodes: Array<Record<string, unknown>>}; revision: number};
  const strip = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(strip);
    if (value === null || typeof value !== "object") return value;
    const record = {...value as Record<string, unknown>};
    if (record.kind === "back_to") delete record.maximum;
    for (const [key, item] of Object.entries(record)) record[key] = strip(item);
    return record;
  };
  const stripped = strip(broken) as typeof broken;
  stripped.workflowId = "stored-without-maximum";
  stripped.threadId = "stored-without-maximum";
  const strippedText = JSON.stringify(stripped);
  yield* execute(opened.box.stores.sql, "INSERT INTO supervisor_workflow_state(workflow_id,project_id,main_thread_id,thread_id,parent_workflow_id,parent_thread_id,revision,document,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
    stripped.workflowId, "project-a", "main-a", stripped.threadId, null, null, stripped.revision, strippedText, 10, 11);
  assert.deepEqual(yield* opened.box.stores.workflows.getState("project-a", "main-a", stripped.threadId),
    {status: "incompatible", workflowId: stripped.workflowId, formatVersion: 2});
  assert.equal(String((yield* query(opened.box.stores.sql, "SELECT document FROM supervisor_workflow_state WHERE workflow_id=?", stripped.workflowId))[0]?.document), strippedText);

  const readable = {formatVersion: 2, workflowId: "readable-without-ledger", projectId: "project-a", mainThreadId: "main-a", threadId: "readable-without-ledger",
    parentWorkflowId: null, parentThreadId: null, revision: 1, status: "planned", objective: null, sourceBinding: null, requirements: [], issues: [], plan: null,
    currentAgreementKey: null, acceptedAgreements: [], returns: [], evidence: [], createdAt: 10, updatedAt: 11};
  yield* execute(opened.box.stores.sql, "INSERT INTO supervisor_workflow_state(workflow_id,project_id,main_thread_id,thread_id,parent_workflow_id,parent_thread_id,revision,document,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
    readable.workflowId, readable.projectId, readable.mainThreadId, readable.threadId, null, null, 1, JSON.stringify(readable), 10, 11);
  const found = yield* opened.box.stores.workflows.getState("project-a", "main-a", readable.threadId);
  assert.equal(found.status, "found");
  if (found.status === "found") assert.equal(found.document.plan, null);
  assert.equal(String((yield* query(opened.box.stores.sql, "SELECT document FROM supervisor_workflow_state WHERE workflow_id=?", readable.workflowId))[0]?.document).includes("returnBudgets"), false);
}), {timeout: 20_000});

it("two expansions of one workflow have different budgets, and one supplied budget id cannot be shared", () => {
  const parsed = parseDefinitionWorkflow("loop", "name: Loop\ndescription: Repeat work.\nsequence:\n  - step: {id: work, name: Work, description: Do the work.}\n  - branch:\n      if: Again?\n      then:\n        - back_to(2): work\n");
  const loopContext = {...context, workflows: [{...parsed, summary: "Repeat work.", origin: "project" as const, path: ".t3-supervisor/workflows/loop.yaml", sourceId: "loop"}]};
  const expanded = canonicalizeProposalDraft(draft({kind: "parallel", nodes: [
    {kind: "workflow", definitionId: "loop", reason: "Use the first loop."},
    {kind: "workflow", definitionId: "loop", reason: "Use the second loop."},
  ]}), loopContext, "two-loops");
  assert.ok(expanded.ok, JSON.stringify(expanded));
  if (!expanded.ok || !expanded.workflow.plan) return;
  const [first, second] = planBackTos(expanded.workflow.plan);
  assert.ok(first && second);
  assert.equal(first.templatePath, second.templatePath, "both occurrences expand the same template path");
  assert.notEqual(first.budgetId, second.budgetId);
  assert.notEqual(first.nodeId, second.nodeId);
  const ledger = planBackTos(expanded.workflow.plan).map(node => ({budgetId: node.budgetId, address: node.templatePath ?? node.budgetId}));
  const retained = retainReturnBudgetIds(expanded.workflow.plan, expanded.workflow.plan, ledger);
  assert.equal(retained.ambiguous, false);
  assert.deepEqual(planBackTos(retained.plan).map(node => node.budgetId), [first.budgetId, second.budgetId]);

  const shared = "ab".repeat(32);
  const aliased = canonicalizeProposalDraft(draft(local("work"), branch("Inner.", [{...backTo("work", 2), budgetId: shared}]),
    branch("Outer.", [{...backTo("work", 5), budgetId: shared}])), context, "aliased-budget");
  assert.equal(aliased.ok, false);
  if (!aliased.ok) assert.equal(aliased.code, "duplicate_return_budget");
});

const storedCopy = (document: WorkflowStateDocument, workflowId: string, edit: (value: Record<string, unknown>) => void) => {
  const copy = JSON.parse(JSON.stringify(document)) as Record<string, unknown>;
  copy.workflowId = workflowId;
  copy.threadId = workflowId;
  edit(copy);
  return copy;
};

it.live("then and else returns stay writable and independent, and a preserved swap does not refill", () => Effect.gen(function* () {
  const arms = yield* open([local("work"), {kind: "branch", condition: "Retry?", reason: "The findings decide.", then: {kind: "sequence", nodes: [
    {kind: "branch", condition: "Which retry?", reason: "The findings decide.", then: {kind: "sequence", nodes: [backTo("work", 2)]},
      else: {kind: "sequence", nodes: [backTo("work", 2)]}}]}}]);
  const armed = yield* arms.main();
  const armedPlan = planOf(armed);
  const addresses = planBackTos(armedPlan).map(node => returnBudgetAddress(armedPlan, node.nodeId));
  assert.equal(addresses.length, 2);
  assert.ok(addresses[0]?.includes(":then") && addresses[1]?.includes(":else"), JSON.stringify(addresses));
  assert.notEqual(addresses[0], addresses[1]);
  const restated = yield* arms.submit(armed, "restate-arms", arms.tick(), armedPlan);
  assert.equal(restated.status, "applied", JSON.stringify(restated));
  const afterRestate = yield* arms.main();
  assert.deepEqual(planBackTos(afterRestate.plan).map(node => node.budgetId), planBackTos(armed.plan).map(node => node.budgetId));

  const swappedRun = yield* open([local("work"), branch("Retry?", [backTo("work", 1)]), branch("Retry?", [backTo("work", 2)])]);
  yield* swappedRun.complete(["work"], "work-1");
  yield* swappedRun.choose("Retry?", "then");
  const pending = yield* swappedRun.main();
  const max1 = planBackTos(pending.plan).find(node => node.maximum === 1)!;
  const max2 = planBackTos(pending.plan).find(node => node.maximum === 2)!;
  const waiting = pending.returns.find(item => item.state === "pending" && item.backToNodeId === max1.nodeId);
  assert.ok(waiting);
  assert.equal((yield* swappedRun.box.stores.workflows.applyReturn(swappedRun.owner, {operationId: "swap-jump", workflowId: pending.workflowId,
    expectedRevision: pending.revision, returnId: waiting.returnId, note: "Apply the first return."}, swappedRun.tick())).status, "applied");
  const spent = yield* swappedRun.main();
  assert.ok(spent.plan);
  const used = (document: WorkflowStateDocument, budgetId: string) =>
    returnBudgetUsed(document.returnBudgets?.find(item => item.budgetId === budgetId)?.events ?? []);
  assert.deepEqual([used(spent, max1.budgetId), used(spent, max2.budgetId)], [1, 0]);
  const nodes = [...spent.plan.nodes];
  const swapped = yield* swappedRun.submit(spent, "swap-branches", swappedRun.tick(), {...spent.plan, nodes: [nodes[0]!, nodes[2]!, nodes[1]!]});
  assert.equal(swapped.status, "applied", JSON.stringify(swapped));
  const after = yield* swappedRun.main();
  const kept1 = planBackTos(after.plan).find(node => node.nodeId === max1.nodeId)!;
  const kept2 = planBackTos(after.plan).find(node => node.nodeId === max2.nodeId)!;
  assert.equal(kept1.budgetId, max1.budgetId);
  assert.equal(kept2.budgetId, max2.budgetId);
  assert.deepEqual([used(after, kept1.budgetId), used(after, kept2.budgetId)], [1, 0]);
  assert.equal(returnBudgetAddress(planOf(after), kept1.nodeId), returnBudgetAddress(planOf(spent), max2.nodeId), "the spent return now occupies the other address");
}), {timeout: 30_000});

it.live("a supplied duplicate budget writes nothing, and a missing or stripped ledger is not seeded", () => Effect.gen(function* () {
  const opened = yield* open([local("work")]);
  const document = yield* opened.main();
  assert.ok(document.plan);
  const work = document.plan.nodes[0]!;
  const shared = "ab".repeat(32);
  const arm = (branchId: string, returnId: string, condition: string, maximum: number): WorkflowPlanNodeInfo => ({
    kind: "branch", nodeId: branchId, templatePath: null, condition, reason: "The findings decide.",
    then: {kind: "sequence", templatePath: null, nodes: [{kind: "back_to", nodeId: returnId, templatePath: null, target: "work", targetNodeId: null,
      maximum, budgetId: shared, reason: "Repeat from work while findings remain."}]},
    else: null,
  });
  const before = String((yield* query(opened.box.stores.sql, "SELECT document FROM supervisor_workflow_state WHERE workflow_id=?", document.workflowId))[0]?.document);
  const aliased = yield* opened.submit(document, "alias-budgets", opened.tick(), {kind: "sequence", templatePath: document.plan.templatePath, nodes: [
    work, arm("00000000-0000-4000-8000-0000000000b1", "00000000-0000-4000-8000-0000000000c1", "Inner.", 2),
    arm("00000000-0000-4000-8000-0000000000b2", "00000000-0000-4000-8000-0000000000c2", "Outer.", 5)]});
  assert.equal(invalidReason(aliased), "return_budget_duplicate");
  assert.equal(String((yield* query(opened.box.stores.sql, "SELECT document FROM supervisor_workflow_state WHERE workflow_id=?", document.workflowId))[0]?.document), before);

  const spentRun = yield* open([local("work"), branch("Findings remain.", [backTo("work", 2)])]);
  yield* spentRun.complete(["work"], "work-1");
  yield* spentRun.choose("Findings remain.", "then");
  yield* spentRun.jump("work", "spend-1");
  const spent = yield* spentRun.main();
  const insert = (workflowId: string, edit: (value: Record<string, unknown>) => void) => Effect.gen(function* () {
    const copy = storedCopy(spent, workflowId, edit);
    const text = JSON.stringify(copy);
    yield* execute(spentRun.box.stores.sql, "INSERT INTO supervisor_workflow_state(workflow_id,project_id,main_thread_id,thread_id,parent_workflow_id,parent_thread_id,revision,document,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
      workflowId, "project-a", "main-a", workflowId, null, null, copy.revision, text, 10, 11);
    return {copy, text};
  });
  const empty = yield* insert("empty-return-ledger", value => {value.returnBudgets = [];});
  assert.deepEqual(yield* spentRun.box.stores.workflows.getState("project-a", "main-a", "empty-return-ledger"),
    {status: "incompatible", workflowId: "empty-return-ledger", formatVersion: 2});
  const repair = yield* spentRun.box.stores.workflows.apply(spentRun.owner, {operationId: "repair-empty-ledger", workflowId: "empty-return-ledger",
    expectedRevision: Number(empty.copy.revision), status: spent.status, objective: spent.objective, sourceBinding: spentRun.binding,
    requirements: [], issues: [], plan: spent.plan, note: "Attempt to repair a missing ledger.", evidence: []}, spentRun.validation, spentRun.tick());
  assert.equal(repair.status, "incompatible", JSON.stringify(repair));
  assert.equal(String((yield* query(spentRun.box.stores.sql, "SELECT document FROM supervisor_workflow_state WHERE workflow_id=?", "empty-return-ledger"))[0]?.document), empty.text);

  const stripped = yield* insert("stripped-return-ledger", value => {
    const rows = value.returnBudgets as Array<Record<string, unknown>>;
    value.returnBudgets = rows.map(row => ({...row, events: []}));
  });
  assert.deepEqual(yield* spentRun.box.stores.workflows.getState("project-a", "main-a", "stripped-return-ledger"),
    {status: "incompatible", workflowId: "stripped-return-ledger", formatVersion: 2});
  assert.equal(String((yield* query(spentRun.box.stores.sql, "SELECT document FROM supervisor_workflow_state WHERE workflow_id=?", "stripped-return-ledger"))[0]?.document), stripped.text);
}), {timeout: 30_000});

const laterAcceptance = (proposalId: string, workflow: WorkflowProposalInfo): WorkflowAgreementImport => ({
  taskId: "task-a", sourceThreadId: "main-a", sourceRunId: "run-b", sourceMessageId: `message-${proposalId}`, sourceHash: taskSourceHash,
  objective: "Ship the reviewed change.", agreement: {status: "agreed", message: "Accepted.", proposalId, agreedAt: 20,
    evidence: {kind: "supervisor_message", messageId: "supervisor-message"}, agentMessageId: "agent-message", workflow},
});

it.live("a later acceptance adds a new return, and a fresh id does not refill a spent one", () => Effect.gen(function* () {
  const added = yield* open([local("work")]);
  const broad = yield* added.main();
  assert.equal(broad.returnBudgets?.length ?? 0, 0);
  const drafted = canonicalizeProposalDraft(draft(local("work"), branch("Findings remain.", [backTo("work", 2)])), context, "added-return", planOf(broad));
  assert.ok(drafted.ok, JSON.stringify(drafted));
  if (!drafted.ok || !drafted.workflow.plan) return;
  const addedReturn = planBackTos(drafted.workflow.plan)[0];
  assert.ok(addedReturn);
  const proposal = {status: "proposed", message: "A later draft.", workspaceRoot: "/workspace/project-a", revision: "definitions-1", globalRevision: null, ...drafted.workflow} as WorkflowProposalInfo;
  const imported = yield* added.box.stores.workflows.importAcceptedAgreement(added.owner, laterAcceptance("proposal-added", proposal), added.tick());
  assert.equal(imported.status, "applied", JSON.stringify(imported));
  const held = yield* added.main();
  assert.equal(held.acceptedAgreements.length, 2);
  assert.equal(held.returnBudgets?.length ?? 0, 0);
  assert.equal(planBackTos(held.plan).length, 0);
  assert.equal(planBackTos(held.acceptedAgreements[1]!.plan)[0]?.budgetId, addedReturn.budgetId);
  assert.equal(planBackTos(held.acceptedAgreements[1]!.agreement.workflow.plan)[0]?.budgetId, addedReturn.budgetId);
  assert.equal((yield* added.box.stores.workflows.getState("project-a", "main-a")).status, "found");
  const adopted = yield* added.submit(held, "adopt-added-return", added.tick(), drafted.workflow.plan);
  assert.equal(adopted.status, "applied", JSON.stringify(adopted));
  const freshUse = yield* added.budget("work");
  assert.equal(freshUse.used, 0);
  assert.deepEqual(freshUse.events, []);
  assert.equal(freshUse.node.budgetId, addedReturn.budgetId);
  assert.equal(planBackTos((yield* added.main()).acceptedAgreements[1]!.plan)[0]?.budgetId, addedReturn.budgetId);

  const spentRun = yield* open([local("work"), branch("Findings remain.", [backTo("work", 1)])]);
  yield* spentRun.complete(["work"], "work-for-fresh");
  yield* spentRun.choose("Findings remain.", "then");
  yield* spentRun.jump("work", "spend-for-fresh");
  const spent = yield* spentRun.main();
  const owned = planBackTos(spent.plan).find(node => node.target === "work");
  assert.ok(owned);
  const consumedId = spent.returnBudgets?.find(item => item.budgetId === owned.budgetId)?.events.find(event => event.kind === "consumed")?.returnId;
  assert.ok(consumedId);
  const freshBudget = "cd".repeat(32);
  const redrafted = canonicalizeProposalDraft(draft(local("work"), branch("Findings remain.", [{...backTo("work", 1), nodeId: "00000000-0000-4000-8000-0000000000e1", budgetId: freshBudget}])), context, "fresh-return", planOf(spent));
  assert.ok(redrafted.ok, JSON.stringify(redrafted));
  if (!redrafted.ok || !redrafted.workflow.plan) return;
  const proposed = planBackTos(redrafted.workflow.plan)[0];
  assert.ok(proposed);
  assert.equal(proposed.budgetId, freshBudget);
  assert.notEqual(proposed.nodeId, owned.nodeId);
  const freshProposal = {status: "proposed", message: "A later draft.", workspaceRoot: "/workspace/project-a", revision: "definitions-1", globalRevision: null, ...redrafted.workflow} as WorkflowProposalInfo;
  const second = yield* spentRun.box.stores.workflows.importAcceptedAgreement(spentRun.owner, laterAcceptance("proposal-fresh", freshProposal), spentRun.tick());
  assert.equal(second.status, "applied", JSON.stringify(second));
  const stored = yield* spentRun.main();
  assert.equal((yield* spentRun.box.stores.workflows.getState("project-a", "main-a")).status, "found");
  assert.equal(stored.returnBudgets?.some(item => item.budgetId === freshBudget), false);
  assert.equal(returnBudgetUsed(stored.returnBudgets?.find(item => item.budgetId === owned.budgetId)?.events ?? []), 1);
  assert.equal(planBackTos(stored.acceptedAgreements[1]!.plan)[0]?.budgetId, freshBudget);
  assert.equal(planBackTos(stored.plan).find(node => node.target === "work")?.budgetId, owned.budgetId);
  const replaced = yield* spentRun.submit(stored, "adopt-fresh-return", spentRun.tick(), redrafted.workflow.plan);
  assert.equal(replaced.status, "applied", JSON.stringify(replaced));
  const kept = yield* spentRun.budget("work");
  assert.equal(kept.node.budgetId, owned.budgetId);
  assert.equal(kept.used, 1);
  assert.equal(kept.events.find(event => event.kind === "consumed")?.returnId, consumedId);
  assert.equal(kept.document.returnBudgets?.some(item => item.budgetId === freshBudget), false);
  const unchanged = yield* spentRun.main();
  assert.equal(planBackTos(unchanged.acceptedAgreements[1]!.plan)[0]?.budgetId, freshBudget);
  assert.equal(planBackTos(unchanged.acceptedAgreements[1]!.agreement.workflow.plan)[0]?.budgetId, freshBudget);
}), {timeout: 30_000});

const loopYaml = "name: Loop\ndescription: Repeat work.\nfixed: true\nsequence:\n  - step: {id: work, name: Work, description: Do the work.}\n  - branch:\n      if: Again?\n      then:\n        - back_to(2): work\n";

// the live blocker on 4cd74dd7: after task A completed with one applied jump, task B agreed the same fixed workflow; its new occurrence
// kept the retained budget, and the next status-only apply failed pinned_definition_context_mismatch because the stored plan was rechecked
// strictly without its own occurrences as the baseline
it.live("a status-only apply after a new task agreed the same fixed workflow keeps its occurrence ids, its retained budget and the used count", () => Effect.gen(function* () {
  const parsed = parseDefinitionWorkflow("loop", loopYaml);
  const loopContext = {...context, workflows: [{...parsed, summary: "Repeat work.", origin: "project" as const, path: ".t3-supervisor/workflows/loop.yaml", sourceId: "loop"}]};
  const run = yield* open([{kind: "workflow", definitionId: "loop", reason: "Use the loop."}], loopContext);
  const statusEdit = (document: WorkflowStateDocument, operationId: string, statuses: Array<{nodeId: string; status: WorkflowExecutionStatus}>,
    taskStatus: WorkflowExecutionStatus, binding: WorkflowStateSourceBinding, validation: typeof run.validation, proposal: WorkflowProposalInfo) => {
    const current = new Map(planEntities(document.plan).map(node => [node.nodeId, node.status]));
    const changed = statuses.filter(item => current.get(item.nodeId) !== item.status);
    const edited = withOccurrenceStatuses(document.plan!, changed);
    assert.ok("plan" in edited, JSON.stringify(edited));
    const evidence: NonNullable<WorkflowApplyInput["evidence"]> = changed.map(item => ({kind: "status_changed" as const, targetNodeId: item.nodeId, note: `${item.nodeId} is ${item.status}.`}));
    if (taskStatus !== document.status) evidence.push({kind: "status_changed", targetNodeId: null, note: `The task is ${taskStatus}.`});
    return run.box.stores.workflows.apply(run.owner, {operationId, workflowId: document.workflowId, expectedRevision: document.revision, status: taskStatus,
      objective: document.objective, sourceBinding: binding, requirements: [...proposal.requirements], issues: [...proposal.issues], plan: edited.plan,
      note: "Record progress.", evidence}, validation, run.tick());
  };
  // task A: work, one applied jump, the second pass, then completed
  const initial = yield* run.main();
  const occurrenceA = planEntities(initial.plan).find(node => node.kind === "workflow");
  const workA = planEntities(initial.plan).find(node => node.kind === "step" && node.localId === "work");
  assert.ok(occurrenceA && workA);
  const pass = (document: WorkflowStateDocument, operationId: string) =>
    statusEdit(document, operationId, [{nodeId: occurrenceA.nodeId, status: "underway"}, {nodeId: workA.nodeId, status: "completed"}], "underway", run.binding, run.validation, run.proposal);
  const firstPass = yield* pass(initial, "a-work");
  assert.equal(firstPass.status, "applied", JSON.stringify(firstPass));
  yield* run.choose("Again?", "then");
  yield* run.jump("work", "a-jump");
  const spentA = yield* run.budget("work");
  assert.equal(spentA.used, 1);
  const secondPass = yield* pass(yield* run.main(), "a-work-again");
  assert.equal(secondPass.status, "applied", JSON.stringify(secondPass));
  yield* run.choose("Again?", "else");
  const doneA = yield* run.main();
  const finishedA = yield* statusEdit(doneA, "a-complete", [{nodeId: occurrenceA.nodeId, status: "completed"}], "completed", run.binding, run.validation, run.proposal);
  assert.equal(finishedA.status, "applied", JSON.stringify(finishedA));

  // task B agrees the same fixed workflow: a new occurrence with the same template path
  const draftedB = canonicalizeProposalDraft(draft({kind: "workflow", definitionId: "loop", reason: "Use the loop again."}), loopContext, "task-b");
  assert.ok(draftedB.ok, JSON.stringify(draftedB));
  if (!draftedB.ok || !draftedB.workflow.plan) return;
  const proposalB = {status: "proposed", message: "The next draft.", workspaceRoot: "/workspace/project-a", revision: "definitions-1", globalRevision: null, ...draftedB.workflow} as WorkflowProposalInfo;
  const bindingB: WorkflowStateSourceBinding = {...run.binding, taskId: "task-b", proposalId: "proposal-b", sourceHash: "ship-the-next-change"};
  const agreementB: WorkflowAgreementImport = {taskId: "task-b", sourceThreadId: "main-a", sourceRunId: "run-b", sourceMessageId: "message-b", sourceHash: "ship-the-next-change",
    objective: "Ship the next change.", agreement: {status: "agreed", message: "Accepted.", proposalId: "proposal-b", agreedAt: 30,
      evidence: {kind: "supervisor_message", messageId: "supervisor-message-b"}, agentMessageId: "agent-message-b", workflow: proposalB}};
  assert.equal((yield* run.box.stores.workflows.importAcceptedAgreement(run.owner, agreementB, run.tick())).status, "applied");
  const validationB = {pinnedContext: loopContext, originalProposal: proposalB, expectedTaskId: "task-b", expectedProposalId: "proposal-b",
    expectedSourceHash: "ship-the-next-change", acceptedTaskAgreement: null, acceptedTaskAgreementSourceHash: null};
  const before = yield* run.main();
  const appliedB = yield* run.box.stores.workflows.apply(run.owner, {operationId: "b-plan", workflowId: before.workflowId, expectedRevision: before.revision, status: "planned",
    objective: "Ship the next change.", sourceBinding: bindingB, requirements: [...proposalB.requirements], issues: [...proposalB.issues], plan: draftedB.workflow.plan,
    note: "Adopt task B.", evidence: [{kind: "status_changed", targetNodeId: null, note: "The next task is planned."}]}, validationB, run.tick());
  assert.equal(appliedB.status, "applied", JSON.stringify(appliedB));
  const planned = yield* run.main();
  const occurrenceB = planEntities(planned.plan).find(node => node.kind === "workflow");
  const workB = planEntities(planned.plan).find(node => node.kind === "step" && node.localId === "work");
  assert.ok(occurrenceB && workB);
  assert.notEqual(occurrenceB.nodeId, occurrenceA.nodeId, "task B is a new occurrence");
  const returnB = planBackTos(planned.plan)[0];
  assert.ok(returnB);
  assert.equal(returnB.budgetId, spentA.node.budgetId, "the store retains the budget at its address, as before");
  assert.equal(returnBudgetUsed(planned.returnBudgets?.find(item => item.budgetId === returnB.budgetId)?.events ?? []), 1);

  // the blocked live write: a status-only apply with the identities the status read returned
  const statusOnly = yield* statusEdit(planned, "b-status", [{nodeId: occurrenceB.nodeId, status: "underway"}, {nodeId: workB.nodeId, status: "underway"}], "underway", bindingB, validationB, proposalB);
  assert.equal(statusOnly.status, "applied", JSON.stringify(statusOnly));
  const after = yield* run.main();
  assert.deepEqual(planEntities(after.plan).map(node => node.nodeId), planEntities(planned.plan).map(node => node.nodeId), "occurrence ids are stable");
  assert.equal(planBackTos(after.plan)[0]?.budgetId, returnB.budgetId, "the retained budget is unchanged");
  assert.equal(returnBudgetUsed(after.returnBudgets?.find(item => item.budgetId === returnB.budgetId)?.events ?? []), 1, "the used count is unchanged");
  assert.equal(planEntities(after.plan).find(node => node.nodeId === workB.nodeId)?.status, "underway");

  // provenance stays guarded: task A's binding cannot write task B's plan, and a tampered budget on the retained return is not adopted
  const stale = yield* statusEdit(after, "b-stale-binding", [{nodeId: workB.nodeId, status: "completed"}], "underway", run.binding, validationB, proposalB);
  assert.equal(invalidReason(stale), "pinned_definition_context_mismatch");
  const tampered = JSON.parse(JSON.stringify(after.plan)) as WorkflowPlanGroupInfo;
  const tamperedReturn = planBackTos(tampered)[0] as {budgetId: string};
  tamperedReturn.budgetId = "ef".repeat(32);
  const resubmitted = yield* run.box.stores.workflows.apply(run.owner, {operationId: "b-tampered-budget", workflowId: after.workflowId, expectedRevision: after.revision,
    status: after.status, objective: after.objective, sourceBinding: bindingB, requirements: [...proposalB.requirements], issues: [...proposalB.issues], plan: tampered,
    note: "Resend the plan.", evidence: []}, validationB, run.tick());
  assert.equal(resubmitted.status, "applied", JSON.stringify(resubmitted));
  const kept = yield* run.main();
  assert.equal(planBackTos(kept.plan)[0]?.budgetId, returnB.budgetId, "the occurrence keeps its retained budget identity");
  assert.equal(kept.returnBudgets?.some(item => item.budgetId === "ef".repeat(32)), false);
  assert.equal(returnBudgetUsed(kept.returnBudgets?.find(item => item.budgetId === returnB.budgetId)?.events ?? []), 1);
}), {timeout: 30_000});

// G: continuous observation never consumes the evidence history: an identical receipt is one entry that counts its repeats, and an
// observation-only apply records no plan update, so far more reads than the evidence cap stay writable with history intact
it.live("repeated identical receipts compact into one counted entry and observation-only applies add no plan_updated, so reads never exhaust the evidence cap", () => Effect.gen(function* () {
  const run = yield* open([local("work")]);
  const document = yield* run.main();
  const work = planEntities(document.plan).find(node => node.kind === "step")!;
  const recorded = yield* guidanceTransaction(run.box.stores.sql)(run.box.stores.workflows.recordContribution(run.owner, {contributionId: "ext:1", nodeId: work.nodeId, revision: 1,
    state: "awaiting_result", summary: "External work.", references: [], externalRef: null, participant: {kind: "external", ref: "agent:1"},
    sourceThreadId: "main-a", sourceRunId: "run-main", sourceMessageId: "message-1"}, 500));
  assert.equal(recorded.status, "applied", JSON.stringify(recorded));
  const before = yield* run.main();
  const receipt = {contributionId: "ext:1", revision: 1, attempt: 1, participant: {kind: "external" as const, ref: "agent:1"}, receipt: {kind: "read" as const, toolName: "mcp__agent__status", inputDigest: "digest"}};
  const observe = (index: number) => Effect.gen(function* () {
    const current = yield* run.main();
    return yield* run.box.stores.workflows.apply(run.owner, {operationId: `observe-${index}`, workflowId: current.workflowId, expectedRevision: current.revision, status: current.status,
      objective: current.objective, sourceBinding: run.binding, requirements: [...run.proposal.requirements], issues: [...run.proposal.issues], plan: current.plan!,
      note: `Read ${index}.`, evidence: [{kind: "observation", note: `Read ${index}.`, participantContributionId: "ext:1", observation: "read", sourceItemId: `item-${index}`, participantReceipt: receipt}]},
    run.validation, 1_000 + index);
  });
  for (let index = 1; index <= workflowMutationLimits.maxEvidence + 100; index++) {
    const result = yield* observe(index);
    assert.equal(result.status, "applied", `read ${index}: ${JSON.stringify(result)}`);
  }
  const after = yield* run.main();
  assert.equal(after.evidence.length, before.evidence.length + 1, "all reads are one receipt entry");
  const entry = after.evidence.find(item => item.participant)!;
  assert.deepEqual([entry.participant!.repeats, entry.participant!.firstRecordedAt, entry.recordedAt, entry.sourceItemId, entry.note],
    [workflowMutationLimits.maxEvidence + 100, 1_001, 1_000 + workflowMutationLimits.maxEvidence + 100, `item-${workflowMutationLimits.maxEvidence + 100}`, `Read ${workflowMutationLimits.maxEvidence + 100}.`]);
  assert.equal(after.evidence.filter(item => item.kind === "plan_updated").length, before.evidence.filter(item => item.kind === "plan_updated").length, "observation-only applies record no plan update");
  assert.equal(after.revision, before.revision + workflowMutationLimits.maxEvidence + 100, "every apply still advanced the revision");
  // a different fact (another tool) is its own entry; a status change still records its plan update
  const other = yield* run.box.stores.workflows.apply(run.owner, {operationId: "observe-other", workflowId: after.workflowId, expectedRevision: after.revision, status: after.status,
    objective: after.objective, sourceBinding: run.binding, requirements: [...run.proposal.requirements], issues: [...run.proposal.issues], plan: after.plan!, note: "Another tool.",
    evidence: [{kind: "observation", note: "Another tool.", participantContributionId: "ext:1", observation: "read", sourceItemId: "item-other",
      participantReceipt: {...receipt, receipt: {...receipt.receipt, toolName: "mcp__agent__log"}}}]}, run.validation, 9_000);
  assert.equal(other.status, "applied", JSON.stringify(other));
  const final = yield* run.main();
  assert.equal(final.evidence.length, after.evidence.length + 1);
  const progressed = yield* run.advance(final, "work-underway", 9_100, {work: "underway"}, "underway");
  assert.equal(progressed.status, "applied", JSON.stringify(progressed));
  assert.equal((yield* run.main()).evidence.filter(item => item.kind === "plan_updated").length, before.evidence.filter(item => item.kind === "plan_updated").length + 1);
}), {timeout: 60_000});

// H: the real store's return output, projected and rendered: the returned target is ready, not absent; earlier outcomes on an unselected
// path are neutral history; previous attempts keep their closed status and selection with reason and source after a fresh selection;
// history keeps every record of one write under one headline; attempt 1 is explicit and a lane's return leaves the other lane untouched
it.live("a real return renders a ready target, neutral earlier outcomes, previous attempts, grouped history and explicit attempts", () => Effect.gen(function* () {
  const run = yield* open([local("implement"), {kind: "parallel", nodes: [
    {kind: "sequence", nodes: [local("reviewa"), branch("Lane A findings.", [local("fixa"), backTo("reviewa", 2)])]},
    {kind: "sequence", nodes: [local("reviewb"), branch("Lane B findings.", [local("fixb"), backTo("reviewb", 2)])]},
  ]}, local("deliver")]);
  yield* run.complete(["implement", "reviewa", "reviewb"], "first-pass");
  // lane B: corrections were done, then the decision was revised so the then path is no longer selected
  yield* run.choose("Lane B findings.", "then");
  yield* run.complete(["fixb"], "lane-b-fix");
  yield* run.choose("Lane B findings.", "else");
  // lane A: findings remain, the correction is done and the return is reached and applied
  yield* run.choose("Lane A findings.", "then");
  yield* run.complete(["fixa"], "lane-a-fix");
  yield* run.jump("reviewa", "lane-a-return");
  const document = yield* run.main();
  const ids = Object.fromEntries(planEntities(document.plan).filter(node => node.kind === "step").map(node => [node.localId, node.nodeId])) as Record<string, string>;
  const workflow = progressWorkflow(document, []);
  const attempts = new Map(workflow.attempts!.map(item => [item.nodeId, item.attempt]));
  assert.deepEqual([attempts.get(ids.reviewa!), attempts.get(ids.fixa!)], [2, 2], "the reopened lane is in attempt 2");
  assert.deepEqual([attempts.get(ids.reviewb!), attempts.get(ids.fixb!)], [1, 1], "the sibling lane keeps its explicit attempt 1");
  assert.deepEqual([attempts.get(ids.implement!), attempts.get(ids.deliver!)], [undefined, undefined], "occurrences outside every return region carry no attempt");
  const statuses = new Map(planEntities(document.plan).map(node => [node.nodeId, node.status]));
  assert.deepEqual([statuses.get(ids.reviewa!), statuses.get(ids.fixa!), statuses.get(ids.reviewb!), statuses.get(ids.fixb!)], ["planned", "planned", "completed", "completed"],
    "a real return plans every repeated member and leaves the sibling lane's outcomes in place");
  // the returned target is ready work while nothing in its region is active
  const ready = readyAfterReturn(workflow.plan, workflow.returns);
  assert.deepEqual([...ready], [ids.reviewa], "only the return's target is ready");
  const render = () => renderToStaticMarkup(createElement(PlanJourney, {node: workflow.plan!, mode: "live", selections: workflow.branchSelections, attempts,
    returns: workflow.returns, branchEvents: workflow.branchEvents, ready, notApplicable: new Set(workflow.notApplicable ?? [])}));
  let html = render();
  assert.match(html, /class="journey-stop state-ready"/);
  assert.match(html, /reviewa<span class="step-flags"><span class="pill">Attempt 2<\/span><\/span><\/span><span class="step-state">Ready to start · attempt 2</);
  assert.match(html, /fixa<span class="step-flags"><span class="pill">Attempt 2</, "the repeated member shows its attempt");
  assert.match(html, /reviewb<span class="step-flags"><span class="pill">Attempt 1<\/span><\/span><\/span><span class="step-state">Completed</, "a returnable member shows attempt 1 explicitly");
  // lane B's completed correction sits on the path no longer selected: history in the current plan, not a live outcome
  assert.match(html, /class="journey-stop state-historical"/);
  assert.match(html, /fixb<span class="step-flags"><span class="pill">Attempt 1<\/span><\/span><\/span><span class="step-state">Completed earlier · path not selected</);
  assert.doesNotMatch(html, /fixb[^]{0,200}state-completed/, "no completed tone on the unselected path");
  // the closed attempt of lane A: reviewa ended completed, the branch's then selection revision 1 with its reason and source
  const previous = previousAttempts(ids.reviewa!, workflow.returns);
  assert.deepEqual(previous.map(item => [item.attempt, item.closed?.status]), [[1, "completed"]]);
  const laneA = planBranches(workflow.plan).find(item => item.condition === "Lane A findings.")!;
  assert.deepEqual(previousAttempts(laneA.nodeId, workflow.returns).map(item => item.selection), [{nodeId: laneA.nodeId, revision: 1, path: "then"}]);
  assert.match(html, /Previous attempt 1/);
  assert.match(html, /then path selected \(revision 1\)/);
  assert.match(html, /Decision reason: Context decided then\./);
  assert.match(html, /message <code>main-message-/);
  // a fresh selection in the new attempt keeps the previous attempt's record
  yield* run.choose("Lane A findings.", "then");
  const reselected = progressWorkflow(yield* run.main(), []);
  const again = renderToStaticMarkup(createElement(PlanJourney, {node: reselected.plan!, mode: "live", selections: reselected.branchSelections, attempts,
    returns: reselected.returns, branchEvents: reselected.branchEvents, ready: readyAfterReturn(reselected.plan, reselected.returns)}));
  assert.match(again, /Previous attempt 1/);
  assert.match(again, /then path selected \(revision 1\)/);
  assert.match(again, /Then path selected/);
  // history: the return and the task status it records are one write with one headline and two unmerged records in stored order
  const operations = historyOperations(workflow.history!);
  const returned = operations.find(operation => operation.some(event => event.kind === "return_applied"))!;
  assert.equal(returned.length, 2, "the return and its task status share the operation");
  assert.equal(returned[0]!.operationId, returned[1]!.operationId);
  assert.equal(returned[0]!.recordedAt, returned[1]!.recordedAt, "equal timestamps stay separate records");
  assert.ok(returned[0]!.sequence < returned[1]!.sequence);
  assert.equal(operationHeadline(returned), "Returned to reviewa: attempt 2 starts");
  const history = renderToStaticMarkup(createElement(WorkflowHistory, {workflow}));
  assert.match(history, /<h3>Returned to reviewa: attempt 2 starts<\/h3>/);
  assert.match(history, /2 records of one write/);
  assert.match(history, /Returned to an earlier step · reviewa/);
  assert.match(history, /Attempt 2 starts after returning to earlier work/);
  html = history;
  assert.ok((html.match(/<li/g) ?? []).length >= workflow.history!.length, "no record is merged away");
}), {timeout: 30_000});

it.live("an omitted ledger does not hide an applied jump after the return leaves the plan", () => Effect.gen(function* () {
  const opened = yield* open([local("work"), branch("Findings remain.", [backTo("work", 1)])]);
  yield* opened.complete(["work"], "work-omit");
  yield* opened.choose("Findings remain.", "then");
  yield* opened.jump("work", "spend-omit");
  const spent = yield* opened.main();
  const work = planOf(spent).nodes[0];
  assert.equal(work?.kind, "step");
  const removed = yield* opened.submit(spent, "drop-spent-return", opened.tick(), {kind: "sequence", templatePath: planOf(spent).templatePath, nodes: [work!]});
  assert.equal(removed.status, "applied", JSON.stringify(removed));
  const after = yield* opened.main();
  assert.equal(planBackTos(after.plan).length, 0);
  assert.equal(after.returns.filter(item => item.state === "applied").length, 1);
  assert.ok((after.returnBudgets ?? []).length > 0);
  assert.equal((yield* opened.box.stores.workflows.getState("project-a", "main-a")).status, "found");
  const insert = (workflowId: string, edit: (value: Record<string, unknown>) => void) => Effect.gen(function* () {
    const copy = storedCopy(after, workflowId, edit);
    const text = JSON.stringify(copy);
    yield* execute(opened.box.stores.sql, "INSERT INTO supervisor_workflow_state(workflow_id,project_id,main_thread_id,thread_id,parent_workflow_id,parent_thread_id,revision,document,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
      workflowId, "project-a", "main-a", workflowId, null, null, copy.revision, text, 10, 11);
    return {copy, text};
  });
  const omitted = yield* insert("omitted-return-ledger", value => {delete value.returnBudgets;});
  assert.deepEqual(yield* opened.box.stores.workflows.getState("project-a", "main-a", "omitted-return-ledger"),
    {status: "incompatible", workflowId: "omitted-return-ledger", formatVersion: 2});
  const repair = yield* opened.box.stores.workflows.apply(opened.owner, {operationId: "repair-omitted-ledger", workflowId: "omitted-return-ledger",
    expectedRevision: Number(omitted.copy.revision), status: after.status, objective: after.objective, sourceBinding: opened.binding,
    requirements: [], issues: [], plan: after.plan, note: "Attempt to repair an omitted ledger.", evidence: []}, opened.validation, opened.tick());
  assert.equal(repair.status, "incompatible", JSON.stringify(repair));
  assert.equal(String((yield* query(opened.box.stores.sql, "SELECT document FROM supervisor_workflow_state WHERE workflow_id=?", "omitted-return-ledger"))[0]?.document), omitted.text);
  const empty = yield* insert("empty-after-removal", value => {value.returnBudgets = [];});
  assert.deepEqual(yield* opened.box.stores.workflows.getState("project-a", "main-a", "empty-after-removal"),
    {status: "incompatible", workflowId: "empty-after-removal", formatVersion: 2});
  assert.equal(String((yield* query(opened.box.stores.sql, "SELECT document FROM supervisor_workflow_state WHERE workflow_id=?", "empty-after-removal"))[0]?.document), empty.text);
  const stripped = yield* insert("stripped-after-removal", value => {
    const rows = value.returnBudgets as Array<Record<string, unknown>>;
    value.returnBudgets = rows.map(row => ({...row, events: []}));
  });
  assert.deepEqual(yield* opened.box.stores.workflows.getState("project-a", "main-a", "stripped-after-removal"),
    {status: "incompatible", workflowId: "stripped-after-removal", formatVersion: 2});
  assert.equal(String((yield* query(opened.box.stores.sql, "SELECT document FROM supervisor_workflow_state WHERE workflow_id=?", "stripped-after-removal"))[0]?.document), stripped.text);
  const quiet = yield* insert("omitted-without-applied", value => {delete value.returnBudgets; value.returns = [];});
  assert.equal((yield* opened.box.stores.workflows.getState("project-a", "main-a", "omitted-without-applied")).status, "found");
  assert.equal(String((yield* query(opened.box.stores.sql, "SELECT document FROM supervisor_workflow_state WHERE workflow_id=?", "omitted-without-applied"))[0]?.document), quiet.text);
  assert.equal(quiet.text.includes("\"returnBudgets\""), false);
}), {timeout: 30_000});

it.live("an enclosing return resets the inner budget, and the inner return does not reset it", () => Effect.gen(function* () {
  const opened = yield* open([local("implement"), branch("Review findings.", [backTo("implement", 5)]), branch("CI failed.", [backTo("implement", 10)])]);
  const conditionOf = (document: WorkflowStateDocument, nodeId: string) => {
    const branch = backToContext(planOf(document), nodeId).branches.at(-1);
    return branch ? planBranches(document.plan).find(item => item.nodeId === branch.nodeId)?.condition : undefined;
  };
  const byCondition = (document: WorkflowStateDocument, condition: string) => {
    const node = planBackTos(document.plan).find(item => conditionOf(document, item.nodeId) === condition);
    assert.ok(node, condition);
    const events = document.returnBudgets?.find(item => item.budgetId === node.budgetId)?.events ?? [];
    return {node, events, used: returnBudgetUsed(events)};
  };
  const applyCondition = (condition: string, operationId: string) => Effect.gen(function* () {
    const document = yield* opened.main();
    const node = byCondition(document, condition).node;
    const pending = document.returns.find(item => item.state === "pending" && item.backToNodeId === node.nodeId);
    assert.ok(pending, condition);
    const result = yield* opened.box.stores.workflows.applyReturn(opened.owner, {operationId, workflowId: document.workflowId, expectedRevision: document.revision,
      returnId: pending.returnId, note: `Apply ${condition}.`}, opened.tick());
    assert.equal(result.status, "applied", JSON.stringify(result));
    return pending.returnId;
  });
  yield* opened.complete(["implement"], "implement-1");
  yield* opened.choose("Review findings.", "then");
  const reviewId = yield* applyCondition("Review findings.", "jump-review");
  const reviewed = yield* opened.main();
  const reviewEvents = byCondition(reviewed, "Review findings.").events;
  assert.deepEqual(reviewEvents.map(event => event.kind), ["consumed"], "a return does not reset itself");
  assert.equal(reviewEvents[0]?.returnId, reviewId);
  yield* opened.complete(["implement"], "implement-2");
  yield* opened.choose("Review findings.", "else");
  yield* opened.choose("CI failed.", "then");
  const ciId = yield* applyCondition("CI failed.", "jump-ci");
  const reset = yield* opened.main();
  assert.equal(byCondition(reset, "Review findings.").used, 0);
  assert.equal(byCondition(reset, "CI failed.").used, 1);
  assert.ok(byCondition(reset, "Review findings.").events.some(event => event.kind === "reset" && event.returnId === ciId));
  assert.deepEqual(byCondition(reset, "CI failed.").events.map(event => event.kind), ["consumed"]);
  yield* opened.complete(["implement"], "implement-3");
  yield* opened.choose("Review findings.", "then");
  yield* applyCondition("Review findings.", "jump-review-again");
  const again = yield* opened.main();
  assert.equal(byCondition(again, "Review findings.").used, 1);
  assert.equal(byCondition(again, "CI failed.").used, 1, "the inner return does not reset the enclosing budget");
}), {timeout: 30_000});

it.live("one of two competing applies debits once, and a full ledger rolls back", () => Effect.gen(function* () {
  const opened = yield* open([local("work"), branch("Findings remain.", [backTo("work", 3)])]);
  yield* opened.complete(["work"], "work-1");
  yield* opened.choose("Findings remain.", "then");
  const pending = yield* opened.main();
  const waiting = pending.returns.find(item => item.state === "pending")!;
  const attempt = (operationId: string, at: number) => opened.box.stores.workflows.applyReturn(opened.owner, {operationId, workflowId: pending.workflowId,
    expectedRevision: pending.revision, returnId: waiting.returnId, note: "Apply the return."}, at);
  const results = yield* Effect.all([attempt("race-a", 2_000), attempt("race-b", 2_001)], {concurrency: "unbounded"});
  const applied = results.filter(result => result.status === "applied");
  const conflicts = results.filter(result => result.status === "conflict");
  assert.equal(applied.length, 1, JSON.stringify(results));
  assert.equal(conflicts.length, 1, JSON.stringify(results));
  const raced = yield* opened.main();
  const racedNode = planBackTos(raced.plan).find(node => node.target === "work")!;
  const racedEvents = raced.returnBudgets?.find(item => item.budgetId === racedNode.budgetId)?.events ?? [];
  assert.equal(returnBudgetUsed(racedEvents), 1);
  assert.equal(racedEvents.filter(event => event.kind === "consumed").length, 1);

  const capped = yield* open([local("work"), branch("Findings remain.", [backTo("work", 3)])]);
  yield* capped.complete(["work"], "cap-work");
  yield* capped.choose("Findings remain.", "then");
  const ready = yield* capped.main();
  const raw = String((yield* query(capped.box.stores.sql, "SELECT document FROM supervisor_workflow_state WHERE workflow_id=?", ready.workflowId))[0]?.document);
  const padded = JSON.parse(raw) as WorkflowStateDocument;
  const events: Array<{kind: "consumed" | "reset"; returnId: string; at: number}> = Array.from({length: workflowMutationLimits.maxEvidence - 1}, (_item, index) =>
    ({kind: "consumed", returnId: `pad-${index}`, at: 10}));
  events.push({kind: "reset", returnId: "pad-reset", at: 11});
  const budgetId = planBackTos(padded.plan).find(node => node.target === "work")!.budgetId;
  padded.returnBudgets = (padded.returnBudgets ?? []).map(row => row.budgetId === budgetId ? {...row, events} : row);
  const paddedText = JSON.stringify(padded);
  yield* execute(capped.box.stores.sql, "UPDATE supervisor_workflow_state SET document=? WHERE workflow_id=?", paddedText, ready.workflowId);
  const loaded = yield* capped.box.stores.workflows.getState("project-a", "main-a", ready.threadId);
  assert.equal(loaded.status, "found", JSON.stringify(loaded));
  const loadedDocument = yield* capped.main();
  const loadedNode = planBackTos(loadedDocument.plan).find(node => node.target === "work")!;
  assert.equal(returnBudgetUsed(loadedDocument.returnBudgets?.find(item => item.budgetId === loadedNode.budgetId)?.events ?? []), 0);
  const refusal = yield* capped.box.stores.workflows.applyReturn(capped.owner, {operationId: "over-capacity", workflowId: ready.workflowId,
    expectedRevision: ready.revision, returnId: ready.returns.find(item => item.state === "pending")!.returnId, note: "This jump does not fit."}, capped.tick());
  assert.equal(invalidReason(refusal), "return_budget_capacity");
  const stored = yield* query(capped.box.stores.sql, "SELECT revision,document FROM supervisor_workflow_state WHERE workflow_id=?", ready.workflowId);
  assert.equal(stored[0]?.revision, ready.revision);
  assert.equal(String(stored[0]?.document), paddedText);
}), {timeout: 30_000});
