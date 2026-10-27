import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ProjectDefinitionSnapshot } from "../src/project-definitions-contract.js";
import { workflowProposalText } from "../src/supervisor-conversation.js";
import { conversationMayContact } from "../src/supervision-conversation-contract.js";
import { prepareWorkflowRequest, proportionatePlanRule, readerWorkflowInstruction } from "../src/supervisor-workflow.js";
import { planEntities } from "../src/workflow-plan-tree.js";
import { alignmentLabel, TaskAlignment } from "../ui/src/workflow-journey.js";
import { effectiveIndex, projectIndex, testSummary } from "./project-definitions-fixture.js";
import { definitionSnapshot, makeWorkflowFixture, sourceMessageId, sourceThreadId, submitAndComplete, type WorkflowFixture } from "./support/ctl-workflow.js";
import { interpretationSubmitter } from "./support/g1a-conversation.js";
import { submissionArguments } from "./support/interpretation-submit.js";

// a project catalog with a broad change workflow, individually reusable steps and one required step
const step = (id: string, name: string, description: string) => ({id, name, description, summary: testSummary(id), origin: "project" as const,
  path: `.t3-supervisor/steps/${id}.md`, sourceId: id});
const catalog = (): ProjectDefinitionSnapshot => {
  const base = definitionSnapshot();
  const steps = [...base.steps,
    step("design-approach", "Design the approach", "Design the change before implementing it."),
    step("data-and-rollout", "Data and rollout plan", "Plan stored data changes and their rollout."),
    step("implement-in-scope", "Implement within scope", "Implement the requested change."),
    step("update-docs", "Update documentation", "Update the documentation the change affects."),
    step("finalize", "Finalize", "Close out the task.")];
  const workflows = [{id: "change", name: "Change", description: "Change repository behavior, from design through rollout and close-out.", summary: testSummary("change"),
    fixed: false, sequence: [{step: "design-approach"}, {step: "data-and-rollout"}, {step: "implement-in-scope"}, {step: "test-plan"}, {step: "update-docs"}, {step: "finalize"}],
    origin: "project" as const, path: ".t3-supervisor/workflows/change.yaml", sourceId: "change"}] as ProjectDefinitionSnapshot["workflows"];
  const indexed = {steps: steps.map(item => item.id), workflows: workflows.map(item => item.id)};
  return {...base, steps, workflows,
    config: effectiveIndex({steps: indexed.steps.map(id => ({id})), workflows: indexed.workflows.map(id => ({id}))}, [{step: "test-plan"}]),
    projectConfig: projectIndex({...indexed, required: [{step: "test-plan"}]})};
};
const catalogNames = ["Design the approach", "Data and rollout plan", "Implement within scope", "Finalize", "Change"];

const authorized = (outcome: string) => ({draft: {objective: outcome, constraints: [], questions: [], findings: [], duties: []}, intent: "authorize", outcome,
  limits: [], sourceMessageIds: [sourceMessageId], antecedentMessageIds: [], scope: "changed"});
// one requested outcome, interpreted through the real submission and supervisor cycle
const interpret = (request: string, outcome: string, fields: Record<string, unknown>, options: {contactable?: boolean} = {}) => Effect.gen(function* () {
  const fixture = yield* makeWorkflowFixture(catalog());
  fixture.projections.get(sourceThreadId)!.messages[0]!.text = request;
  const supervisor = yield* fixture.makeSupervisor();
  yield* supervisor.cycle;
  if (options.contactable) {
    // both conversations use native modes that permit Supervisor contact, and the operative has no pending owner question
    for (const projection of [fixture.projections.get(sourceThreadId)!, fixture.projections.get((yield* fixture.binding())!.threadId)!])
      Object.assign(projection.thread, {runtimeMode: "full-access", interactionMode: "default"});
    (fixture.projections.get(sourceThreadId)! as {runtimeRequests?: unknown[]}).runtimeRequests = [];
  }
  const pending = (yield* fixture.task())!;
  yield* submitAndComplete(fixture, supervisor, pending, {objective: outcome, sourceMessageIds: [sourceMessageId], conversation: authorized(outcome), ...fields});
  yield* supervisor.cycle;
  return {fixture, supervisor, task: (yield* fixture.task())!};
});
const operativeSends = (fixture: WorkflowFixture) => fixture.dispatches().filter(call => call.payload.threadId === sourceThreadId).length;

it("the complete interpretation instructions decide whether a plan helps first and keep unused catalog entries out", () => {
  const prepared = prepareWorkflowRequest("thread-a", "message-a", "Pull the latest changes, then refresh the local index.", catalog());
  assert.doesNotMatch(prepared.requestText, /Pull the latest changes|not_needed|requirements/u);
  for (const text of [readerWorkflowInstruction]) {
    assert.equal(text.split(proportionatePlanRule).length - 1, 1, "the planning rule is stated once");
    assert.match(text, /Decide first, from the request itself and before reading or assessing any definitions, whether it warrants supervision/u);
    assert.match(text, /It is "not_needed" when a plan would add nothing: a communication, lookup or status request, or quick routine work the operative completes and checks itself/u);
    assert.match(text, /there is no proposal, agreement or contact, never an empty workflow/u);
    assert.match(text, /"omit":\[\{"member":"member definitionId or localId","reason":"why it does not apply"\}\] naming members of a flexible workflow left out \(never a fixed workflow\)/u);
    assert.match(text, /Assess every configured required reference once for this main task against its own described applicability/u);
    assert.doesNotMatch(text, /Use any workflow reference that fits|short, self-contained communication, lookup or status request with no workflow obligations/u);
  }
  assert.match(readerWorkflowInstruction, /quick routine work is not_needed with workflow:null and needs no proposal, agreement or contact/u);
  assert.match(proportionatePlanRule, /leave out every step or workflow that does not serve this outcome, with no not-applicable note, even if that is all of them/u);
  assert.doesNotMatch(proportionatePlanRule, /\d/u, "no numeric threshold decides a plan's size");
});

it.effect("quick routine work authorized by the requester proceeds with no plan, proposal, acceptance or contact", () => Effect.gen(function* () {
  const {fixture, supervisor, task} = yield* interpret("Check whether this checkout is current with its remote, pull if needed, then refresh the local knowledge index.",
    "Bring the checkout up to date and refresh the local knowledge index", {reason: "A quick routine sync and documented refresh the operative completes and checks itself.",
      supervision: "not_needed", workflow: null});
  assert.deepEqual([task.status, task.supervision, task.workflow ?? null], ["inferred", "not_needed", null], "no workflow record exists, not even an empty one");
  assert.equal(task.conversation?.authorization?.state, "authorized", "the requested outcome stays authorized");
  assert.equal(conversationMayContact(task), false);
  yield* supervisor.cycle;
  yield* supervisor.cycle;
  assert.equal(operativeSends(fixture), 0, "no introduction, acceptance request or check-in reaches the operative");
  assert.equal(fixture.dispatches().length, 1, "the interpretation request is the only Supervisor turn");
  assert.equal(alignmentLabel(task), "No plan needed");
  const html = renderToStaticMarkup(createElement(TaskAlignment, {task}));
  assert.match(html, /No plan needed for this task/u);
  assert.match(html, /Continues without a plan or acceptance/u);
  assert.doesNotMatch(html, /Plan unavailable|Acceptance has not been recorded|Plan provenance/u);
}));

it.effect("a proportionate plan reuses individual steps and adds local ones while unused catalog entries stay absent", () => Effect.gen(function* () {
  const {task} = yield* interpret("Correct the outdated setup section of the README.", "Correct the README setup section", {
    reason: "A small tracked documentation change.", supervision: "needed",
    workflow: {requirements: [{kind: "step", id: "test-plan", applies: false, reason: "Only prose changes; there is no behavior to verify."}],
      plan: {kind: "sequence", nodes: [
        {kind: "step", definitionId: null, localId: "check-setup", name: "Check the setup steps", description: "Run the documented setup steps against the current checkout.",
          reason: "The corrected text must match what actually works."},
        {kind: "step", definitionId: "update-docs", reason: "The requested outcome is a documentation correction."}]}}});
  assert.equal(task.workflow?.status, "proposed");
  assert.deepEqual(planEntities(task.workflow!.plan).map(node => node.definitionId), [null, "update-docs"]);
  assert.deepEqual(task.workflow?.requirements.map(item => [item.id, item.state]), [["test-plan", "not_applicable"]]);
  const introduction = workflowProposalText(task);
  assert.match(introduction, /Check the setup steps/u);
  assert.match(introduction, /Update documentation/u);
  for (const name of catalogNames) assert.equal(introduction.includes(name), false, `${name} is absent, not listed as not applicable`);
  assert.doesNotMatch(introduction, /not applicable: /u);
  assert.match(introduction, /The plan should hold only what this task needs; .+ If a commitment is unnecessary for this task, ask for a smaller plan instead of accepting\./u);
}));

it.effect("an applicable required step left out of the plan stays unresolved instead of becoming a formal proposal", () => Effect.gen(function* () {
  const {task} = yield* interpret("Fix the export retry bug.", "Fix the export retry bug", {reason: "A behavior change.", supervision: "needed",
    workflow: {requirements: [{kind: "step", id: "test-plan", applies: true, reason: "The fix changes behavior that must be verified."}],
      plan: {kind: "sequence", nodes: [{kind: "step", definitionId: "implement-in-scope", reason: "Implement the fix."}]}}});
  assert.notEqual(task.workflow?.status, "proposed");
  assert.deepEqual(task.workflow?.requirements.map(item => [item.id, item.state]), [["test-plan", "unresolved"]]);
}));

it.effect("a consequential change still selects the complete workflow whose composition fits", () => Effect.gen(function* () {
  const {task} = yield* interpret("Migrate the stored export settings to the new schema and roll it out.", "Migrate the export settings and roll it out", {
    reason: "A data migration with rollout risk.", supervision: "needed",
    workflow: {requirements: [{kind: "step", id: "test-plan", applies: true, reason: "The migration changes stored behavior."}],
      plan: {kind: "sequence", nodes: [{kind: "workflow", definitionId: "change", reason: "Design, data rollout, verification and close-out all apply."}]}}});
  assert.equal(task.workflow?.status, "proposed");
  assert.deepEqual(planEntities(task.workflow!.plan).map(node => node.definitionId),
    ["change", "design-approach", "data-and-rollout", "implement-in-scope", "test-plan", "update-docs", "finalize"]);
  assert.deepEqual(task.workflow?.requirements.map(item => [item.id, item.state]), [["test-plan", "included"]]);
}));

it.effect("a first proposal can leave members of a flexible workflow out, and an unknown member is a typed diagnostic to correct", () => Effect.gen(function* () {
  const omitted = {kind: "workflow", definitionId: "change", reason: "An in-place behavior fix.",
    omit: [{member: "data-and-rollout", reason: "No stored data or rollout is involved."}]};
  const {task} = yield* interpret("Fix the export retry bug.", "Fix the export retry bug", {reason: "A behavior change.", supervision: "needed",
    workflow: {requirements: [{kind: "step", id: "test-plan", applies: true, reason: "The fix must be verified."}], plan: {kind: "sequence", nodes: [omitted]}}});
  assert.equal(task.workflow?.status, "proposed");
  const change = planEntities(task.workflow!.plan).find(node => node.kind === "workflow")!;
  assert.equal(planEntities(task.workflow!.plan).some(node => node.definitionId === "data-and-rollout"), false);
  assert.deepEqual(change.kind === "workflow" ? change.omissions.map(item => [item.id, item.reason]) : null, [["data-and-rollout", "No stored data or rollout is involved."]]);

  // a misnamed member is reported where it is, so the Supervisor corrects it in the same run rather than repairing a provisional plan
  const fresh = yield* makeWorkflowFixture(catalog());
  const unit = yield* fresh.makeSupervisor();
  yield* unit.cycle;
  const pending = (yield* fresh.task())!;
  const submitter = yield* interpretationSubmitter({stores: fresh.stores, workflows: unit.workflows, projections: fresh.projections});
  const rejected = yield* submitter.submit(pending, submissionArguments(pending, {objective: "Fix the export retry bug", reason: "A behavior change.",
    sourceMessageIds: [sourceMessageId], conversation: authorized("Fix the export retry bug"), supervision: "needed",
    workflow: {requirements: [{kind: "step", id: "test-plan", applies: true, reason: "The fix must be verified."}],
      plan: {kind: "sequence", nodes: [{...omitted, omit: [{member: "rollout", reason: "Not involved."}]}]}}}));
  assert.equal(rejected.status, "invalid", JSON.stringify(rejected));
  assert.match(JSON.stringify(rejected), /"code":"workflow_omission_invalid","path":"\/workflow\/plan\/nodes\/0\/omit\/0\/member"/u);
}));

it.effect("a first proposal omitting a flexible member goes out to the operative in the cycle its real submission completes", () => Effect.gen(function* () {
  const {fixture, task} = yield* interpret("Fix the export retry bug.", "Fix the export retry bug", {reason: "A behavior change.", supervision: "needed",
    workflow: {requirements: [{kind: "step", id: "test-plan", applies: true, reason: "The fix must be verified."}],
      plan: {kind: "sequence", nodes: [{kind: "workflow", definitionId: "change", reason: "An in-place behavior fix.",
        omit: [{member: "data-and-rollout", reason: "No stored data or rollout is involved."}]}]}}}, {contactable: true});
  assert.deepEqual([task.status, task.workflow?.status], ["inferred", "proposed"]);
  const introduction = fixture.dispatches().find(call => call.payload.threadId === sourceThreadId);
  assert.equal(introduction?.payload.messageId, `supervisor-notice:workflow:${task.id}:${task.sourceHash.slice(0, 20)}`,
    "the recorded interpretation confirms the omitted-member proposal, so it is not held back");
  assert.ok(String(introduction?.payload.text).includes(JSON.stringify({callerThreadId: task.threadId, taskId: task.id, proposalId: task.workflowProposalId ?? task.id})),
    "the notice pins the operative's read of this proposal");
  assert.match(workflowProposalText(task), /not applicable: Data and rollout plan — No stored data or rollout is involved\./u);
}));
