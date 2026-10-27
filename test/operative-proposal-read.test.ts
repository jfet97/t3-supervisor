import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import type { ProjectDefinitionSnapshot } from "../src/project-definitions-contract.js";
import { preparedAcceptanceRecord } from "../src/supervisor-conversation.js";
import { T3TransportError } from "../src/t3.js";
import { taskScopeRevision } from "../src/supervision-conversation-contract.js";
import type { TaskRecord } from "../src/project-supervisor-store.js";
import type { Projection } from "../src/types.js";
import { effectiveIndex, projectIndex, testSummary } from "./project-definitions-fixture.js";
import { completeSupervisorRequest, definitionSnapshot, makeWorkflowFixture, sourceMessageId, sourceThreadId, submitAndComplete, type WorkflowFixture } from "./support/ctl-workflow.js";
import { writeController } from "./support/g1a-conversation.js";
import { installSubmission, submissionDetail } from "./support/interpretation-submit.js";

// a catalog with a flexible change workflow, a required step and a branch the operative will decide
const step = (id: string) => ({id, name: `Step ${id}`, description: `Do ${id}.`, summary: testSummary(id), origin: "project" as const,
  path: `.t3-supervisor/steps/${id}.md`, sourceId: id});
const catalog = (): ProjectDefinitionSnapshot => {
  const base = definitionSnapshot();
  const steps = [...base.steps, step("design"), step("rollout"), step("implement"), step("solo"), step("paired")];
  const workflows = [{id: "change", name: "Change", description: "Change behavior.", summary: testSummary("change"), fixed: false,
    sequence: [{step: "design"}, {step: "rollout"}, {step: "implement"}, {branch: {if: "The change is contained.", then: [{step: "solo"}], else: [{step: "paired"}]}},
      {step: "test-plan"}],
    origin: "project" as const, path: ".t3-supervisor/workflows/change.yaml", sourceId: "change"}] as ProjectDefinitionSnapshot["workflows"];
  const indexed = {steps: steps.map(item => item.id), workflows: ["change"]};
  return {...base, steps, workflows, config: effectiveIndex({steps, workflows}, [{step: "test-plan"}]), projectConfig: projectIndex({...indexed, required: [{step: "test-plan"}]})};
};
const outcome = "Fix the export retry bug";
// a requested change interpreted through the real submission path, with its omitted member, and the controller that serves its reads
const introduced = Effect.gen(function* () {
  const fixture = yield* makeWorkflowFixture(catalog());
  fixture.projections.get(sourceThreadId)!.messages[0]!.text = "Fix the export retry bug.";
  const supervisor = yield* fixture.makeSupervisor();
  yield* supervisor.cycle;
  for (const projection of [fixture.projections.get(sourceThreadId)!, fixture.projections.get((yield* fixture.binding())!.threadId)!])
    Object.assign(projection.thread, {runtimeMode: "full-access", interactionMode: "default"});
  (fixture.projections.get(sourceThreadId)! as {runtimeRequests?: unknown[]}).runtimeRequests = [];
  yield* submitAndComplete(fixture, supervisor, (yield* fixture.task())!, {objective: outcome, reason: "A behavior change.", sourceMessageIds: [sourceMessageId],
    conversation: {draft: {objective: outcome, constraints: [], questions: [], findings: [], duties: []}, intent: "authorize", outcome, limits: ["Do not deploy"],
      sourceMessageIds: [sourceMessageId], antecedentMessageIds: [], scope: "changed"},
    supervision: "needed", workflow: {requirements: [{kind: "step", id: "test-plan", applies: true, reason: "The fix must be verified."}],
      plan: {kind: "sequence", nodes: [{kind: "workflow", definitionId: "change", reason: "An in-place fix.", omit: [{member: "rollout", reason: "No stored data or rollout."}]}]}}});
  yield* supervisor.cycle;
  const task = (yield* fixture.task())!;
  const notice = fixture.dispatches().find(call => call.payload.threadId === sourceThreadId)!;
  const controller = yield* writeController({stores: fixture.stores, workflows: supervisor.workflows, conversation: supervisor.conversation, native: {
    listThreads: () => Effect.succeed([]),
    projection: (threadId) => {
      const projection = fixture.projections.get(threadId);
      return projection ? Effect.succeed(projection) : Effect.fail(new T3TransportError("missing projection", 404));
    },
    getTurnItem: ({threadId, itemId}) => Effect.succeed({item: submissionDetail(fixture.projections.get(threadId), itemId)}),
  }});
  return {fixture, supervisor, task, notice, controller};
});
// the caller's own executed supervision_plan call in its current run, then the controller's answer to it
const readAs = (fixture: WorkflowFixture, controller: Effect.Success<typeof introduced>["controller"], caller: Projection, args: Record<string, unknown>, install = true) =>
  Effect.suspend(() => {
    if (install) installSubmission(caller, {messageId: caller.runs.at(-1)!.userMessageId} as never, args, {tool: "plan", runId: caller.runs.at(-1)!.id});
    return controller.readOwnProposal(args);
  });

it.effect("the operative gets a short pinned notice, reads its own complete proposal through its own verified call and agrees it", () => Effect.gen(function* () {
  const {fixture, supervisor, task, notice, controller} = yield* introduced;
  const proposalId = task.workflowProposalId ?? task.id;
  const args = {callerThreadId: sourceThreadId, taskId: task.id, proposalId};
  const text = String(notice.payload.text);
  assert.ok(text.includes(`supervision_plan and exactly ${JSON.stringify(args)}`), "the notice carries the exact read");
  assert.doesNotMatch(text, /Plan outline|workflow-acceptance|branch-selection|Do design\./u, "the notice pastes no plan, record, protocol or contract");

  const operative = fixture.projections.get(sourceThreadId)!;
  const read = yield* readAs(fixture, controller, operative, args);
  assert.equal(read.status, "ok", JSON.stringify(read));
  if (read.status !== "ok") return;
  const acceptance = preparedAcceptanceRecord(task)!;
  assert.match(read.proposal, /not applicable: Step rollout — No stored data or rollout\./u, "the omission is in the proposal it reads");
  assert.match(read.proposal, /- branch \[branch:[0-9a-f-]{36}\] if: The change is contained\./u, "and the branch it decides, with its protocol");
  assert.match(read.proposal, /```branch-selection\n/u);
  assert.match(read.proposal, /Limits: \["Do not deploy"\]/u);
  assert.ok(read.proposal.includes(`\`\`\`workflow-acceptance\n${JSON.stringify(acceptance)}\n\`\`\``), "and the exact acceptance record");
  console.log(`MEASURE notice ${text.length} chars ${Buffer.byteLength(text)} bytes; proposal read ${read.proposal.length} chars ${Buffer.byteLength(read.proposal)} bytes`);

  // the operative copies the record from what it read into its own reply after the notice
  completeSupervisorRequest(operative, String(notice.payload.messageId), `\`\`\`workflow-acceptance\n${JSON.stringify(acceptance)}\n\`\`\``);
  yield* supervisor.cycle;
  yield* supervisor.cycle;
  assert.deepEqual([(yield* fixture.task())?.agreement?.status, (yield* fixture.task())?.agreement?.proposalId], ["agreed", proposalId]);
  // the agreed plan stays readable for later branch decisions and contracts, while an earlier proposal of the task never is
  const later = yield* readAs(fixture, controller, operative, args);
  assert.equal(later.status, "ok", JSON.stringify(later));
  assert.match(later.status === "ok" ? later.proposal : "", /- branch \[branch:[0-9a-f-]{36}\] if: The change is contained\./u);
  yield* fixture.stores.requests.saveAgreementCandidate({...(yield* fixture.stores.requests.agreementCandidate(task.id, proposalId))!, proposalId: `${proposalId}:earlier`});
  const earlier = yield* readAs(fixture, controller, operative, {...args, proposalId: `${proposalId}:earlier`});
  assert.deepEqual(earlier, {status: "denied", reason: "proposal_not_current"});
}));

it.effect("a read that is forged, foreign, outdated or for a stopped chat returns nothing and changes nothing", () => Effect.gen(function* () {
  const {fixture, task, controller} = yield* introduced;
  const proposalId = task.workflowProposalId ?? task.id;
  const operative = fixture.projections.get(sourceThreadId)!;
  const before = JSON.stringify(yield* fixture.task());
  const noProposal = (result: unknown, label: string) => {
    assert.equal(JSON.stringify(result).includes("Plan outline") || JSON.stringify(result).includes(task.id) || Object.hasOwn(result as object, "proposal"), false, `${label}: nothing is disclosed`);
    assert.notEqual((result as {status: string}).status, "ok", label);
  };
  // forged: the arguments name the operative, but the operative never executed the call
  noProposal(yield* readAs(fixture, controller, operative, {callerThreadId: sourceThreadId, taskId: task.id, proposalId}, false), "forged");
  // foreign: another conversation's own verified call names this task and proposal
  const other = structuredClone(operative);
  Object.assign(other.thread, {id: "other-chat"});
  for (const run of other.runs) run.threadId = "other-chat";
  for (const message of other.messages) message.threadId = "other-chat";
  for (const node of other.nodes as Array<Record<string, unknown>>) node.threadId = "other-chat";
  fixture.projections.set("other-chat", other);
  noProposal(yield* readAs(fixture, controller, other, {callerThreadId: "other-chat", taskId: task.id, proposalId}), "foreign");
  // outdated: the operative's own verified call names an earlier proposal of its task
  yield* fixture.stores.requests.saveAgreementCandidate({...(yield* fixture.stores.requests.agreementCandidate(task.id, proposalId))!, proposalId: `${proposalId}-earlier`});
  const outdated = yield* readAs(fixture, controller, operative, {callerThreadId: sourceThreadId, taskId: task.id, proposalId: `${proposalId}-earlier`});
  noProposal(outdated, "outdated");
  assert.equal(outdated.status, "denied");
  // unknown: a proposal ID of its own task that was never recorded
  const unknown = yield* readAs(fixture, controller, operative, {callerThreadId: sourceThreadId, taskId: task.id, proposalId: `${proposalId}-next`});
  noProposal(unknown, "unknown");
  assert.equal(unknown.status, "denied");
  // stopped: the human stopped supervision of this chat
  const policy = yield* fixture.stores.policy.get();
  yield* fixture.stores.policy.save({...policy, excludedThreadIds: [...policy.excludedThreadIds, sourceThreadId]});
  noProposal(yield* readAs(fixture, controller, operative, {callerThreadId: sourceThreadId, taskId: task.id, proposalId}), "stopped");
  assert.equal(JSON.stringify(yield* fixture.task()), before, "no read changes the task");
}));

// each change makes the proposal the notice named obsolete for the same call: the operative's request was edited, a new Supervisor generation
// took over, or the task's scope pin moved under the same proposal ID so its recorded acceptance no longer matches
const obsolete: ReadonlyArray<readonly [string, (fixture: WorkflowFixture, task: TaskRecord) => Effect.Effect<void, unknown>]> = [
  ["edited source", (fixture) => Effect.sync(() => { fixture.projections.get(sourceThreadId)!.messages[0]!.text = "Fix the export retry bug and redesign exports."; })],
  ["new generation", (fixture) => Effect.flatMap(fixture.binding(), (binding) => fixture.stores.supervisors.setBinding({...binding!, generation: binding!.generation + 1}))],
  ["moved scope pin", (fixture, task) => fixture.stores.supervisors.saveTask({...task, conversation: {...task.conversation!,
    authorization: {...task.conversation!.authorization!, scopeRevision: `${taskScopeRevision(task)}:moved`}}})],
];
for (const [label, change] of obsolete) it.effect(`a read after an obsolete ${label} returns nothing and changes nothing`, () => Effect.gen(function* () {
  const {fixture, task, controller} = yield* introduced;
  const operative = fixture.projections.get(sourceThreadId)!;
  const args = {callerThreadId: sourceThreadId, taskId: task.id, proposalId: task.workflowProposalId ?? task.id};
  assert.equal((yield* readAs(fixture, controller, operative, args)).status, "ok", "current before the change");
  yield* change(fixture, task);
  const before = JSON.stringify(yield* fixture.task());
  assert.deepEqual(yield* readAs(fixture, controller, operative, args), {status: "denied", reason: "proposal_not_current"});
  assert.equal(JSON.stringify(yield* fixture.task()), before, "the read changes nothing");
}));

it.effect("a verified child reads its own scoped workflow under its main's current task, and nothing else", () => Effect.gen(function* () {
  const {fixture, supervisor, task} = yield* introduced;
  const binding = (yield* fixture.binding())!;
  const owner = {projectId: binding.projectId, mainThreadId: binding.mainThreadId, supervisorThreadId: binding.threadId, bindingGeneration: binding.generation};
  assert.ok(["created", "exists"].includes((yield* supervisor.workflows.ensureMain(owner, "main-draft", "Connect the main.")).status));
  // a native child of the main whose scoped workflow its Supervisor connected
  const operative = fixture.projections.get(sourceThreadId)!;
  const childId = "child-chat";
  const child = structuredClone(operative);
  Object.assign(child.thread, {id: childId, lineage: {parentThreadId: sourceThreadId, relationshipToParent: "subagent", rootThreadId: sourceThreadId}});
  for (const run of child.runs) run.threadId = childId;
  for (const message of child.messages) message.threadId = childId;
  for (const node of child.nodes as Array<Record<string, unknown>>) node.threadId = childId;
  fixture.projections.set(childId, child);
  const linked = yield* supervisor.workflows.linkChild(owner, {operationId: "link-child", lineage: {threadId: childId, parentThreadId: sourceThreadId,
    relationshipToParent: "subagent"}, note: "The child builds the client."});
  assert.equal(linked.status, "created", JSON.stringify(linked));
  const scoped = (yield* supervisor.workflows.get(owner.projectId, owner.mainThreadId, childId))!;
  let lineage = [{...operative.thread}, {...child.thread}];
  const controller = yield* writeController({stores: fixture.stores, workflows: supervisor.workflows, conversation: supervisor.conversation, policyStops: true, native: {
    listThreads: () => Effect.sync(() => lineage),
    projection: (threadId) => {
      const projection = fixture.projections.get(threadId);
      return projection ? Effect.succeed(projection) : Effect.fail(new T3TransportError("missing projection", 404));
    },
    getTurnItem: ({threadId, itemId}) => Effect.succeed({item: submissionDetail(fixture.projections.get(threadId), itemId)}),
  }});
  const args = {callerThreadId: childId, taskId: task.id, proposalId: scoped.workflowId};
  assert.notEqual((yield* readAs(fixture, controller, child, args, false)).status, "ok", "only through the child's own executed call");
  const read = yield* readAs(fixture, controller, child, args);
  assert.equal(read.status, "ok", JSON.stringify(read));
  assert.ok(read.status === "ok" && read.proposal.startsWith(`Your scoped workflow ${scoped.workflowId}, revision 1, status planned, inside parent workflow ${scoped.parentWorkflowId}.`), JSON.stringify(read));
  assert.match(read.status === "ok" ? read.proposal : "", /No plan is recorded for you yet\./u);
  assert.deepEqual(read.status === "ok" ? [read.taskId, read.proposalId] : null, [task.id, scoped.workflowId]);

  const denied = {status: "denied", reason: "proposal_not_current"};
  assert.deepEqual(yield* readAs(fixture, controller, child, {...args, proposalId: task.workflowProposalId ?? task.id}), denied, "the main's proposal is not the child's to read");
  assert.deepEqual(yield* readAs(fixture, controller, child, {...args, taskId: `${task.id}-earlier`}), denied, "only under the main's current task");
  // a conversation the native lineage does not connect to the main reads nothing
  lineage = [{...operative.thread}, {...child.thread, lineage: {parentThreadId: sourceThreadId, relationshipToParent: "fork"}}];
  assert.deepEqual(yield* readAs(fixture, controller, child, args), denied, "an independent fork");
  lineage = [{...operative.thread}, {...child.thread}];
  // nor once the human stopped supervision of the main
  const policy = yield* fixture.stores.policy.get();
  yield* fixture.stores.policy.save({...policy, excludedThreadIds: [...policy.excludedThreadIds, sourceThreadId]});
  assert.deepEqual(yield* readAs(fixture, controller, child, args), denied, "a stopped main");
}));
