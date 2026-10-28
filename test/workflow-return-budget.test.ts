import assert from "node:assert/strict";
import {it} from "@effect/vitest";
import {Effect} from "effect";
import {parseDefinitionWorkflow} from "../src/project-definitions.js";
import type {WorkflowPlanGroupInfo, WorkflowPlanNodeInfo, WorkflowProposalInfo} from "../src/project-supervisor-contract.js";
import {defaultSupervisorModel} from "../src/project-supervisor-store.js";
import {canonicalizeProposalDraft, proposalContextFromDefinitions, validateWorkflowPlan} from "../src/supervisor-workflow.js";
import type {WorkflowAgreementImport, WorkflowApplyInput, WorkflowExecutionStatus, WorkflowOwner, WorkflowStateDocument, WorkflowStateSourceBinding} from "../src/workflow-state-contract.js";
import {backToContext, occurrenceAttempts, planBackTos, planBranches, returnBudgetUsed, strictlyNestedReplayReturns} from "../src/workflow-plan-tree.js";
import {effectiveIndex, indexSource, projectIndex} from "./project-definitions-fixture.js";
import {execute, openWorkflowStores, query, temporaryDirectory} from "./support/g12-stores.js";

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

const open = (nodes: unknown[]) => Effect.gen(function* () {
  const directory = yield* temporaryDirectory("return-budget-");
  const stores = yield* openWorkflowStores(directory);
  yield* execute(stores.sql, "INSERT INTO meta VALUES(?,?)", `supervisor_control:${JSON.stringify("project-a")}`, JSON.stringify({generation: 1, enabled: true, manual: true}));
  const reserved = yield* stores.supervisors.reserve("project-a", "main-a", "Main conversation", defaultSupervisorModel, 1, 1);
  yield* stores.supervisors.setBinding({...reserved, state: "ready"});
  const owner: WorkflowOwner = {projectId: "project-a", mainThreadId: "main-a", supervisorThreadId: reserved.threadId, bindingGeneration: reserved.generation};
  const plan = validateWorkflowPlan(draft(...nodes), context);
  assert.ok(plan?.plan, "the agreed plan resolves");
  const proposal = {status: "proposed", message: "A draft.", workspaceRoot: "/workspace/project-a", revision: "definitions-1", globalRevision: null, ...plan} as WorkflowProposalInfo;
  const binding: WorkflowStateSourceBinding = {workspaceRoot: "/workspace/project-a", revision: "definitions-1", globalRevision: null, definitionsStatus: "ready",
    definitionsComplete: true, requirementsKnown: true, taskId: "task-a", proposalId: "proposal-a", sourceHash: taskSourceHash};
  const agreement: WorkflowAgreementImport = {taskId: "task-a", sourceThreadId: "main-a", sourceRunId: "run-a", sourceMessageId: "message-a", sourceHash: taskSourceHash,
    objective: "Ship the reviewed change.", agreement: {status: "agreed", message: "Accepted.", proposalId: "proposal-a", agreedAt: 10,
      evidence: {kind: "supervisor_message", messageId: "supervisor-message"}, agentMessageId: "agent-message", workflow: proposal}};
  assert.equal((yield* stores.workflows.importAcceptedAgreement(owner, agreement, 100)).status, "applied");
  const validation = {pinnedContext: context, originalProposal: proposal, expectedTaskId: "task-a", expectedProposalId: "proposal-a",
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
  const before = String((yield* query(ambiguous.box.stores.sql, "SELECT document FROM supervisor_workflow_state WHERE workflow_id=?", current.workflowId))[0]?.document);
  const refused = yield* ambiguous.submit(current, "retitle-returns", other.tick(), retitled);
  assert.equal(invalidReason(refused), "return_budget_identity_ambiguous");
  const after = String((yield* query(ambiguous.box.stores.sql, "SELECT document FROM supervisor_workflow_state WHERE workflow_id=?", current.workflowId))[0]?.document);
  assert.equal(after, before, "an ambiguous move does not refill or rewrite the ledger");
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
