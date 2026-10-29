import assert from "node:assert/strict";
import {it} from "@effect/vitest";
import {Effect} from "effect";
import type {WorkflowPlanGroupInfo, WorkflowPlanNodeInfo, WorkflowProposalInfo} from "../src/project-supervisor-contract.js";
import {defaultSupervisorModel} from "../src/project-supervisor-store.js";
import {proposalContextFromDefinitions, validateWorkflowPlan} from "../src/supervisor-workflow.js";
import type {WorkflowAgreementImport, WorkflowApplyInput, WorkflowExecutionStatus, WorkflowOwner, WorkflowStateDocument, WorkflowStateSourceBinding} from "../src/workflow-state-contract.js";
import {occurrenceAttempts, planBackTos, planBranches, planEntities, returnBudgetUsed} from "../src/workflow-plan-tree.js";
import {progressHistory, WorkflowHistoryEventSchema} from "../src/workflow-progress.js";
import {Schema} from "effect";
import {effectiveIndex, indexSource, projectIndex} from "./project-definitions-fixture.js";
import {execute, openWorkflowStores, temporaryDirectory} from "./support/g12-stores.js";

// the one return boundary of the workflow store: inside the region of a return the selected path reaches, a status never moves
// backward by hand; off the selected path it moves backward only as an explicit repair; attempts and budgets change only when a
// return is applied

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
const taskSourceHash = "ship-the-reviewed-change";
const reviewFailure = "Review found failures.";
const verificationFailure = "Verification failed.";
// the incident's shape: implementation, review, a review-failure path returning to implementation, delivery
const reviewLoop = (maximum = 5) => [local("implement"), local("review"), branch(reviewFailure, [backTo("implement", maximum)]), local("deliver")];
// the same loop with a verification loop nested inside the review
const nestedLoops = [local("implement"), local("review"), branch(verificationFailure, [local("fixverify"), backTo("review", 3)]),
  branch(reviewFailure, [backTo("implement", 5)]), local("deliver")];

const reason = (result: {status: string}) => result.status === "invalid" ? (result as {reason?: string}).reason ?? result.status : result.status;
const diagnostic = (result: unknown) => (result as {diagnostic?: {code: string; path: string; expected: string}}).diagnostic ?? null;
type ApplyOptions = {status?: WorkflowExecutionStatus; repair?: boolean; evidence?: NonNullable<WorkflowApplyInput["evidence"]>; note?: string};

const open = (nodes: unknown[]) => Effect.gen(function* () {
  const directory = yield* temporaryDirectory("return-boundary-");
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
  const main = () => Effect.map(stores.workflows.get("project-a", "main-a"), document => {
    assert.ok(document);
    return document;
  });
  let at = 1_000;
  const tick = () => at += 10;
  const node = (document: WorkflowStateDocument, localId: string) => {
    const found = planEntities(document.plan).find(item => item.kind === "step" && item.localId === localId);
    assert.ok(found, localId);
    return found;
  };
  // records the named local steps' statuses with the status evidence each change needs, as one apply of the whole plan
  const apply = (document: WorkflowStateDocument, operationId: string, changes: Record<string, WorkflowExecutionStatus>, options: ApplyOptions = {}) => {
    const evidence: NonNullable<WorkflowApplyInput["evidence"]> = [];
    const status = options.status ?? document.status;
    if (status !== document.status) evidence.push({kind: "status_changed", targetNodeId: null, note: `The task is ${status}.`});
    const group = (value: WorkflowPlanGroupInfo): WorkflowPlanGroupInfo => ({...value, nodes: value.nodes.map(visit)});
    const visit = (item: WorkflowPlanNodeInfo): WorkflowPlanNodeInfo => {
      if (item.kind === "sequence" || item.kind === "parallel") return group(item);
      if (item.kind === "branch") return {...item, then: group(item.then), else: item.else ? group(item.else) : null};
      if (item.kind === "workflow") return {...item, plan: item.plan ? group(item.plan) : null};
      if (item.kind !== "step" || item.localId === null) return item;
      const next = changes[item.localId] ?? item.status;
      if (next !== item.status) evidence.push({kind: "status_changed", targetNodeId: item.nodeId, note: options.note ?? `${item.localId} is ${next}.`});
      return {...item, status: next};
    };
    return stores.workflows.apply(owner, {operationId, workflowId: document.workflowId, expectedRevision: document.revision, status, objective: document.objective,
      sourceBinding: binding, requirements: [...proposal.requirements], issues: [...proposal.issues], plan: group(document.plan!), note: "Record progress.",
      evidence: [...evidence, ...(options.evidence ?? [])], ...(options.repair === undefined ? {} : {repair: options.repair})}, validation, at);
  };
  const applied = (operationId: string, changes: Record<string, WorkflowExecutionStatus>, options: ApplyOptions = {}) => Effect.gen(function* () {
    const document = yield* main();
    tick();
    const result = yield* apply(document, operationId, changes, options);
    assert.equal(result.status, "applied", `${operationId} ${JSON.stringify(result)}`);
    return result;
  });
  const rejected = (operationId: string, changes: Record<string, WorkflowExecutionStatus>, options: ApplyOptions = {}) => Effect.gen(function* () {
    const document = yield* main();
    tick();
    const result = yield* apply(document, operationId, changes, options);
    const after = yield* main();
    assert.equal(after.revision, document.revision, `${operationId} wrote nothing`);
    assert.equal(after.evidence.length, document.evidence.length, `${operationId} recorded nothing`);
    return {reason: reason(result), diagnostic: diagnostic(result), result};
  });
  const choose = (condition: string, path: "then" | "else") => Effect.gen(function* () {
    const document = yield* main();
    const found = planBranches(document.plan).find(item => item.condition === condition);
    assert.ok(found, condition);
    const revision = document.branchSelections.filter(item => item.nodeId === found.nodeId).reduce((max, item) => Math.max(max, item.revision), 0) + 1;
    const now = tick();
    const result = yield* stores.workflows.recordBranchSelection(owner, {nodeId: found.nodeId, revision, path, reason: `Context decided ${path}.`,
      sourceThreadId: "main-a", sourceRunId: `main-run-${revision}`, sourceMessageId: `main-message-${found.nodeId}-${revision}`, sourceCreatedAt: now}, now);
    assert.equal(result.status, "applied", `${condition} ${path} ${JSON.stringify(result)}`);
  });
  const jump = (target: string, operationId: string) => Effect.gen(function* () {
    const document = yield* main();
    const found = planBackTos(document.plan).find(item => item.target === target);
    assert.ok(found, target);
    const pending = document.returns.find(item => item.state === "pending" && item.backToNodeId === found.nodeId);
    assert.ok(pending, `pending return to ${target}`);
    const result = yield* stores.workflows.applyReturn(owner, {operationId, workflowId: document.workflowId, expectedRevision: document.revision,
      returnId: pending.returnId, note: `Apply the return to ${target}.`}, tick());
    assert.equal(result.status, "applied", `${operationId} ${JSON.stringify(result)}`);
    return result;
  });
  const budget = (target: string) => Effect.gen(function* () {
    const document = yield* main();
    const found = planBackTos(document.plan).filter(item => item.target === target);
    assert.equal(found.length, 1, target);
    const events = document.returnBudgets?.find(item => item.budgetId === found[0]!.budgetId)?.events ?? [];
    return {document, node: found[0]!, events, used: returnBudgetUsed(events)};
  });
  // the same apply under a changed task scope: the new source hash is pinned and the plan is reassessed against it
  const reassess = (document: WorkflowStateDocument, operationId: string, changes: Record<string, WorkflowExecutionStatus>, options: ApplyOptions & {sourceHash: string}) => {
    const evidence: NonNullable<WorkflowApplyInput["evidence"]> = [];
    const status = options.status ?? document.status;
    if (status !== document.status) evidence.push({kind: "status_changed", targetNodeId: null, note: `The task is ${status}.`});
    const group = (value: WorkflowPlanGroupInfo): WorkflowPlanGroupInfo => ({...value, nodes: value.nodes.map(visit)});
    const visit = (item: WorkflowPlanNodeInfo): WorkflowPlanNodeInfo => {
      if (item.kind === "sequence" || item.kind === "parallel") return group(item);
      if (item.kind === "branch") return {...item, then: group(item.then), else: item.else ? group(item.else) : null};
      if (item.kind === "workflow") return {...item, plan: item.plan ? group(item.plan) : null};
      if (item.kind !== "step" || item.localId === null) return item;
      const next = changes[item.localId] ?? item.status;
      // retained progress is reassessed with an activity reference; a rewind to planned needs only its note
      if (next !== "planned") evidence.push({kind: "status_changed", targetNodeId: item.nodeId, note: `${item.localId} reassessed as ${next}.`, sourceMessageId: `reassess-${item.localId}`});
      else if (next !== item.status) evidence.push({kind: "status_changed", targetNodeId: item.nodeId, note: `${item.localId} starts again in the new scope.`});
      return {...item, status: next};
    };
    return stores.workflows.apply(owner, {operationId, workflowId: document.workflowId, expectedRevision: document.revision, status, objective: document.objective,
      sourceBinding: {...binding, sourceHash: options.sourceHash}, requirements: [...proposal.requirements], issues: [...proposal.issues], plan: group(document.plan!),
      note: "Reassess the retained progress for the edited task.", evidence: [...evidence, ...(options.evidence ?? [])], ...(options.repair === undefined ? {} : {repair: options.repair})},
    {...validation, expectedSourceHash: options.sourceHash}, tick());
  };
  return {stores, owner, main, node, apply, applied, rejected, choose, jump, budget, tick, reassess};
});

const returnRequiredText = /settle the assessing member.*apply_return/u;
const repairRequiredText = /repair: true/u;

it.live("the incident's combined write, settling the review and reopening implementation with the failure path selected, is refused", () => Effect.gen(function* () {
  // (a) the review-failure path is selected while the review is still underway, then one write settles the review and reopens implementation
  const fixture = yield* open(reviewLoop());
  yield* fixture.applied("implement", {implement: "completed", review: "underway"}, {status: "underway"});
  const implement = fixture.node(yield* fixture.main(), "implement");
  yield* fixture.choose(reviewFailure, "then");
  const combined = yield* fixture.rejected("settle-and-reopen", {review: "completed", implement: "underway"});
  assert.equal(combined.reason, "return_required");
  assert.deepEqual([combined.diagnostic?.code, combined.diagnostic?.path], ["return_required", "/plan/nodes/0/status"]);
  assert.match(combined.diagnostic?.expected ?? "", returnRequiredText);
  const unchanged = yield* fixture.main();
  assert.deepEqual(unchanged.returns, [], "no return was requested by the refused write");
  assert.equal(fixture.node(unchanged, "implement").status, "completed");
  assert.equal(fixture.node(unchanged, "review").status, "underway");
  assert.equal(implement.nodeId, fixture.node(unchanged, "implement").nodeId, "the same canonical plan");
  // (a2) the split variant: reopening implementation alone while the review is underway is refused the same way
  const reopenFirst = yield* fixture.rejected("reopen-first", {implement: "underway"});
  assert.deepEqual([reopenFirst.reason, reopenFirst.diagnostic?.path], ["return_required", "/plan/nodes/0/status"]);
  const toPlanned = yield* fixture.rejected("reopen-planned", {implement: "planned"});
  assert.equal(toPlanned.reason, "return_required");
  const reviewBack = yield* fixture.rejected("review-back-to-planned", {review: "planned"});
  assert.deepEqual([reviewBack.reason, reviewBack.diagnostic?.path], ["return_required", "/plan/nodes/1/status"], "an underway member of the region cannot go back to planned either");
  // (b) settling the review alone lets the service request the return
  const settled = yield* fixture.applied("settle-review", {review: "completed"});
  assert.equal((settled as {documentStatus?: string}).documentStatus, "underway", "the receipt states the document's own status");
  const requested = yield* fixture.main();
  assert.deepEqual(requested.returns.map(item => [item.state, item.attempt]), [["pending", 1]]);
  assert.deepEqual(requested.evidence.filter(item => item.kind === "return_requested").length, 1);
  // (h) while the return waits, a repair of its region is still refused as pending
  const whileWaiting = yield* fixture.rejected("repair-while-pending", {implement: "planned"}, {repair: true});
  assert.equal(whileWaiting.reason, "return_pending");
  // (c) applying the return starts attempt 2 of the region, consumes one jump and reopens the region
  yield* fixture.jump("implement", "return-1");
  const next = yield* fixture.main();
  assert.deepEqual(["implement", "review", "deliver"].map(id => fixture.node(next, id).status), ["planned", "planned", "planned"]);
  assert.equal((yield* fixture.budget("implement")).used, 1);
  assert.deepEqual(next.branchSelections.map(item => item.state), ["invalidated"]);
  const branchId = planBranches(next.plan)[0]!.nodeId;
  const backToId = planBackTos(next.plan)[0]!.nodeId;
  assert.deepEqual([...occurrenceAttempts(next.returns)], [[fixture.node(next, "implement").nodeId, 2], [fixture.node(next, "review").nodeId, 2], [branchId, 2], [backToId, 2]]);
}), {timeout: 30_000});

it.live("off the selected path a backward move inside the region is a misrecorded status corrected only as an explicit repair", () => Effect.gen(function* () {
  const fixture = yield* open(reviewLoop());
  const {applied, rejected, choose, main, node, budget} = fixture;
  yield* applied("start", {implement: "completed", review: "underway"}, {status: "underway"});
  // (d2) no failure path selected: the flag is required, and with it the correction is recorded as a repair that starts no attempt
  const missing = yield* rejected("reopen-no-flag", {implement: "planned"});
  assert.deepEqual([missing.reason, missing.diagnostic?.code, missing.diagnostic?.path], ["status_repair_required", "status_repair_required", "/plan/nodes/0/status"]);
  assert.match(missing.diagnostic?.expected ?? "", repairRequiredText);
  const before = yield* main();
  const repaired = yield* applied("reopen-repair", {implement: "planned"}, {repair: true, note: "Implementation was recorded completed before its tests ran."});
  const after = yield* main();
  assert.equal(node(after, "implement").status, "planned");
  const corrected = after.evidence.filter(item => item.kind === "status_changed" && item.targetNodeId === node(after, "implement").nodeId).at(-1);
  assert.equal((corrected as {repair?: boolean} | undefined)?.repair, true, "the status evidence is flagged as a repair");
  const history = progressHistory(after);
  assert.deepEqual(history.filter(event => event.repair === true).map(event => event.targetNodeId), [node(after, "implement").nodeId], "History marks exactly the corrected status");
  assert.ok(history.every(event => Schema.is(WorkflowHistoryEventSchema)(event)));
  assert.deepEqual([...occurrenceAttempts(after.returns)], [], "a repair starts no attempt");
  assert.equal((yield* budget("implement")).used, 0, "a repair spends no jump");
  assert.deepEqual(after.returns, []);
  // (g) an exact replay returns the stored receipt and records nothing twice; a different note under the same id is refused
  const replay = yield* fixture.apply(before, "reopen-repair", {implement: "planned"}, {repair: true, note: "Implementation was recorded completed before its tests ran."});
  assert.deepEqual(replay, repaired);
  assert.equal((yield* main()).evidence.length, after.evidence.length);
  const reused = yield* fixture.apply(before, "reopen-repair", {implement: "planned"}, {repair: true, note: "Another note."});
  assert.deepEqual([reused.status, (reused as {reason?: string}).reason], ["conflict", "operation_id_reused"]);
  // the flag is only for such corrections: an apply that moves nothing backward inside a region refuses it
  const pointless = yield* rejected("flag-without-correction", {implement: "underway"}, {repair: true});
  assert.deepEqual([pointless.reason, pointless.diagnostic?.path], ["repair_not_applicable", "/repair"]);
  // an underway member moved back to planned is the same correction
  const reviewMissing = yield* rejected("review-planned-no-flag", {review: "planned"});
  assert.deepEqual([reviewMissing.reason, reviewMissing.diagnostic?.path], ["status_repair_required", "/plan/nodes/1/status"]);
  yield* applied("review-planned-repair", {review: "planned"}, {repair: true});
  assert.equal(node(yield* main(), "review").status, "planned");
  // (a3) after the repair the loop still counts: the failure path selected later reaches the return once the region settles again
  yield* applied("implement-again", {implement: "completed", review: "underway"});
  yield* choose(reviewFailure, "then");
  assert.deepEqual((yield* main()).returns, [], "the review is still underway, so the return is not reached");
  yield* applied("review-done", {review: "completed"});
  assert.deepEqual((yield* main()).returns.map(item => [item.state, item.attempt]), [["pending", 1]]);
  yield* fixture.jump("implement", "return-1");
  assert.equal((yield* budget("implement")).used, 1, "the jump is counted when applied");
  assert.equal(occurrenceAttempts((yield* main()).returns).get(node(yield* main(), "implement").nodeId), 2);
  // (e) with the exit path selected the region is off the returning path again: a backward move is a repair
  yield* applied("attempt-2", {implement: "completed", review: "completed"});
  yield* choose(reviewFailure, "else");
  const offPath = yield* rejected("reopen-off-path", {review: "underway"});
  assert.equal(offPath.reason, "status_repair_required");
  yield* applied("reopen-off-path-repair", {review: "underway"}, {repair: true});
  assert.equal((yield* budget("implement")).used, 1);
  assert.equal(occurrenceAttempts((yield* main()).returns).get(node(yield* main(), "implement").nodeId), 2, "a repair never reduces an attempt");
  // (d) a backward move outside every return region needs no flag
  yield* applied("review-again", {review: "completed"});
  yield* applied("deliver-start", {deliver: "underway"});
  yield* applied("deliver-back", {deliver: "planned"});
  assert.equal(node(yield* main(), "deliver").status, "planned");
}), {timeout: 30_000});

it.live("an exhausted return keeps its failure unresolved: no manual rewind on the selected path, a repair once another path is taken", () => Effect.gen(function* () {
  const fixture = yield* open(reviewLoop(1));
  const {applied, rejected, choose, main, budget} = fixture;
  yield* applied("start", {implement: "completed", review: "completed"}, {status: "underway"});
  yield* choose(reviewFailure, "then");
  yield* fixture.jump("implement", "return-1");
  yield* applied("attempt-2", {implement: "completed", review: "completed"});
  yield* choose(reviewFailure, "then");
  let row = yield* budget("implement");
  assert.deepEqual(row.document.returns.map(item => item.state), ["applied", "exhausted"]);
  assert.equal(row.used, 1);
  // (f) the selected path still returns, but no jump is left: a rewind by statuses is refused as exhausted
  const rewind = yield* rejected("rewind-exhausted", {implement: "underway"});
  assert.deepEqual([rewind.reason, rewind.diagnostic?.code], ["return_budget_exhausted", "return_budget_exhausted"]);
  const rewindRepair = yield* rejected("rewind-exhausted-repair", {implement: "planned"}, {repair: true});
  assert.equal(rewindRepair.reason, "return_budget_exhausted");
  // another path leaves the exhausted row as history; the region is then correctable as a repair, spending nothing
  yield* choose(reviewFailure, "else");
  row = yield* budget("implement");
  assert.equal(typeof row.document.returns.find(item => item.state === "exhausted")?.resolvedAt, "number");
  const offPath = yield* rejected("reopen-after-exhaustion", {review: "underway"});
  assert.equal(offPath.reason, "status_repair_required");
  yield* applied("reopen-after-exhaustion-repair", {review: "underway"}, {repair: true});
  row = yield* budget("implement");
  assert.equal(row.used, 1);
  assert.equal(occurrenceAttempts(row.document.returns).get(fixture.node(row.document, "implement").nodeId), 2);
  void main;
}), {timeout: 30_000});

it.live("applying the outer return resets the nested verification budget and the guard holds for both loops", () => Effect.gen(function* () {
  const fixture = yield* open(nestedLoops);
  const {applied, rejected, choose, main, node, budget} = fixture;
  yield* applied("start", {implement: "completed", review: "completed"}, {status: "underway"});
  yield* choose(verificationFailure, "then");
  // reopening the review by hand while its verification loop is selected is refused: the inner return is required
  const innerRewind = yield* rejected("review-rewind", {review: "underway"});
  assert.deepEqual([innerRewind.reason, innerRewind.diagnostic?.path], ["return_required", "/plan/nodes/1/status"]);
  yield* applied("fixverify", {fixverify: "completed"});
  assert.deepEqual((yield* main()).returns.map(item => item.state), ["pending"]);
  yield* fixture.jump("review", "inner-return-1");
  assert.equal((yield* budget("review")).used, 1);
  yield* applied("review-2", {review: "completed"});
  yield* choose(verificationFailure, "else");
  yield* choose(reviewFailure, "then");
  assert.deepEqual((yield* main()).returns.map(item => [item.state, item.attempt]), [["applied", 1], ["pending", 1]]);
  yield* fixture.jump("implement", "outer-return-1");
  const next = yield* main();
  assert.deepEqual(["implement", "review", "fixverify", "deliver"].map(id => node(next, id).status), ["planned", "planned", "planned", "planned"]);
  assert.equal((yield* budget("implement")).used, 1, "the outer jump is consumed");
  const inner = yield* budget("review");
  assert.deepEqual(inner.events.map(event => event.kind), ["consumed", "reset"]);
  assert.equal(inner.used, 0, "the nested verification budget is reset by the enclosing replay");
  assert.deepEqual(next.branchSelections.filter(item => item.state === "current"), [], "every selection in the region is taken again");
  assert.equal(occurrenceAttempts(next.returns).get(node(next, "review").nodeId), 3, "the review was reopened by both returns");
}), {timeout: 30_000});

it.live("the reassessment an edited task scope requires may rewind a region without a return, and the repair flag has no place there", () => Effect.gen(function* () {
  const fixture = yield* open(reviewLoop());
  const {applied, choose, main, node, budget, reassess} = fixture;
  yield* applied("start", {implement: "completed", review: "underway"}, {status: "underway"});
  yield* choose(reviewFailure, "then");
  const document = yield* main();
  const flagged = yield* reassess(document, "reassess-flagged", {implement: "planned"}, {sourceHash: "edited-task-request", repair: true});
  assert.deepEqual([reason(flagged), diagnostic(flagged)?.path], ["repair_not_applicable", "/repair"]);
  const reassessed = yield* reassess(document, "reassess", {implement: "planned"}, {sourceHash: "edited-task-request"});
  assert.equal(reassessed.status, "applied", JSON.stringify(reassessed));
  const after = yield* main();
  assert.deepEqual([node(after, "implement").status, node(after, "review").status, after.sourceBinding?.sourceHash], ["planned", "underway", "edited-task-request"]);
  assert.deepEqual(after.returns, []);
  assert.equal((yield* budget("implement")).used, 0);
  assert.equal(after.evidence.some(item => (item as {repair?: boolean}).repair === true), false, "a scope reassessment is not a repair");
}), {timeout: 30_000});
