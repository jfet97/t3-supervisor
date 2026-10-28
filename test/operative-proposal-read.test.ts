import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { TestClock } from "effect/testing";
import type { ProjectDefinitionSnapshot } from "../src/project-definitions-contract.js";
import { preparedAcceptanceRecord } from "../src/supervisor-conversation.js";
import { T3TransportError } from "../src/t3.js";
import { taskScopeRevision } from "../src/supervision-conversation-contract.js";
import type { TaskRecord } from "../src/project-supervisor-store.js";
import type { Projection } from "../src/types.js";
import { effectiveIndex, projectIndex, testSummary } from "./project-definitions-fixture.js";
import { appendSourceMessage, completeSupervisorRequest, definitionSnapshot, makeWorkflowFixture, sourceMessageId, sourceThreadId, submitAndComplete, type WorkflowFixture } from "./support/ctl-workflow.js";
import { proposalContextFromDefinitions } from "../src/supervisor-workflow.js";
import { verifyWorkflowToolEvidence, workflowEvidenceCandidates } from "../src/workflow-write-evidence.js";
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
  assert.ok(text.includes(`supervision_plan ${JSON.stringify(args)}`), "the notice carries the exact read");
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
  yield* TestClock.adjust("5 seconds");
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

// a native child of the main whose scoped workflow its Supervisor linked, the controller that serves its reads over a lineage and a main
// projection the test changes, and the bind that gives the child its plan under the main's current task and scope
const childScoped = Effect.gen(function* () {
  const {fixture, supervisor, task} = yield* introduced;
  const binding = (yield* fixture.binding())!;
  const owner = {projectId: binding.projectId, mainThreadId: binding.mainThreadId, supervisorThreadId: binding.threadId, bindingGeneration: binding.generation};
  assert.ok(["created", "exists"].includes((yield* supervisor.workflows.ensureMain(owner, "main-draft", "Connect the main.")).status));
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
  const native = {lineage: [{...operative.thread}, {...child.thread}], mainReadable: true};
  const controller = yield* writeController({stores: fixture.stores, workflows: supervisor.workflows, conversation: supervisor.conversation, policyStops: true, native: {
    listThreads: () => Effect.sync(() => native.lineage),
    projection: (threadId) => {
      const projection = threadId === sourceThreadId && !native.mainReadable ? undefined : fixture.projections.get(threadId);
      return projection ? Effect.succeed(projection) : Effect.fail(new T3TransportError("missing projection", 404));
    },
    getTurnItem: ({threadId, itemId}) => Effect.succeed({item: submissionDetail(fixture.projections.get(threadId), itemId)}),
  }});
  // a task-local duty with its pointers, which no definition file holds, and a defined step
  const workflow = task.workflow!;
  const proposalId = task.workflowProposalId ?? task.id;
  const bind = Effect.gen(function* () {
    const applied = yield* supervisor.workflows.apply(owner, {operationId: "bind-child-plan", workflowId: scoped.workflowId, expectedRevision: scoped.revision,
      status: "planned", objective: "Build the export client.", requirements: [], issues: [...workflow.issues], note: "Assign the client to the child.",
      sourceBinding: {workspaceRoot: workflow.workspaceRoot!, revision: workflow.revision, globalRevision: workflow.globalRevision ?? null, definitionsStatus: "ready",
        definitionsComplete: true, requirementsKnown: true, taskId: task.id, proposalId, sourceHash: taskScopeRevision(task)},
      plan: {kind: "sequence", nodes: [{kind: "step", definitionId: null, localId: "client", name: "Build the client", reason: "The child owns the client.",
        description: "Retry each failed export with capped backoff.\nKeep every export request idempotent.", references: ["docs/export.md"], skills: ["effect-v4-development"]},
      {kind: "step", definitionId: "implement", reason: "The client is implemented as agreed."}]} as never},
    {pinnedContext: proposalContextFromDefinitions(task.definitionSnapshot!), originalProposal: workflow, expectedTaskId: task.id, expectedProposalId: proposalId,
      expectedSourceHash: taskScopeRevision(task), acceptedTaskAgreement: task.agreement ?? null, acceptedTaskAgreementSourceHash: task.agreementSourceHash ?? null});
    assert.equal(applied.status, "applied", JSON.stringify(applied));
    return (yield* supervisor.workflows.get(owner.projectId, owner.mainThreadId, childId))!;
  });
  return {fixture, task, operative, child, scoped, native, controller, bind, args: {callerThreadId: childId, taskId: task.id, proposalId: scoped.workflowId}};
});
const denied = {status: "denied", reason: "proposal_not_current"};

it.effect("a verified child reads its own bound scoped workflow with every recorded duty under its main's current task, and nothing else", () => Effect.gen(function* () {
  const {fixture, task, operative, child, scoped, native, controller, bind, args} = yield* childScoped;
  assert.notEqual((yield* readAs(fixture, controller, child, args, false)).status, "ok", "only through the child's own executed call");
  assert.deepEqual(yield* readAs(fixture, controller, child, args), denied, "a document its Supervisor has not bound to the current task holds no current plan");
  const bound = yield* bind;
  const read = yield* readAs(fixture, controller, child, args);
  assert.equal(read.status, "ok", JSON.stringify(read));
  const text = read.status === "ok" ? read.proposal : "";
  assert.ok(text.startsWith(`Your scoped workflow ${scoped.workflowId}, revision ${bound.revision}, status planned, inside parent workflow ${scoped.parentWorkflowId}.\nObjective: Build the export client.\nPlan:\n`), text);
  // the task-local duty is only in the plan, so the read carries its whole description, references and skills, as it does each defined step's duty
  assert.match(text, /\n- Build the client \[local:client; [0-9a-f-]{36}\] planned\n  Duty: Retry each failed export with capped backoff\.\n    Keep every export request idempotent\.\n  Reference: docs\/export\.md\n  Skill: effect-v4-development\n- Step implement \[step:implement; [0-9a-f-]{36}\] planned\n  Duty: Do implement\.\n/u);
  assert.ok(text.includes(`References and skill paths are relative to the checkout root ${task.workflow!.workspaceRoot};`), text);
  assert.deepEqual(read.status === "ok" ? [read.taskId, read.proposalId] : null, [task.id, scoped.workflowId]);

  assert.deepEqual(yield* readAs(fixture, controller, child, {...args, proposalId: task.workflowProposalId ?? task.id}), denied, "the main's proposal is not the child's to read");
  assert.deepEqual(yield* readAs(fixture, controller, child, {...args, taskId: `${task.id}-earlier`}), denied, "only under the main's current task");
  // a conversation the native lineage does not connect to the main reads nothing
  native.lineage = [{...operative.thread}, {...child.thread, lineage: {parentThreadId: sourceThreadId, relationshipToParent: "fork"}}];
  assert.deepEqual(yield* readAs(fixture, controller, child, args), denied, "an independent fork");
  native.lineage = [{...operative.thread}, {...child.thread}];
  // nor once the human stopped supervision of the main
  const policy = yield* fixture.stores.policy.get();
  yield* fixture.stores.policy.save({...policy, excludedThreadIds: [...policy.excludedThreadIds, sourceThreadId]});
  assert.deepEqual(yield* readAs(fixture, controller, child, args), denied, "a stopped main");
}));

it.effect("a child's read follows its main's requester messages, read fresh, and the scope its own plan was bound to", () => Effect.gen(function* () {
  const {fixture, task, operative, child, native, controller, bind, args} = yield* childScoped;
  yield* bind;
  const read = () => readAs(fixture, controller, child, args);
  assert.equal((yield* read()).status, "ok");
  const before = JSON.stringify(yield* fixture.task());
  // the requester edits the request to stop and discuss: the read refuses at once, before any cycle reconsiders the task
  const request = operative.messages[0]!;
  const original = request.text;
  request.text = "Stop implementing the retry fix; let's discuss alternatives first.";
  assert.deepEqual(yield* read(), denied, "an edited request");
  request.text = original;
  assert.equal((yield* read()).status, "ok", "the unchanged request grants it again");
  // an unreadable main answers nothing from stored state alone
  native.mainReadable = false;
  assert.deepEqual(yield* read(), {status: "unavailable", reason: "main_projection_unavailable", retryable: true});
  native.mainReadable = true;
  // the task's scope moved under the same task and request: the plan bound to the earlier scope is not current until its Supervisor binds it again
  yield* fixture.stores.supervisors.saveTask({...task, conversation: {...task.conversation!, authorization: {...task.conversation!.authorization!,
    scopeRevision: `${taskScopeRevision(task)}:moved`}}});
  assert.deepEqual(yield* read(), denied, "a plan bound to an earlier scope");
  yield* fixture.stores.supervisors.saveTask(task);
  assert.equal((yield* read()).status, "ok");
  assert.equal(JSON.stringify(yield* fixture.task()), before, "no read changes the task");
  // a newer requester message the task has not considered withdraws it too
  appendSourceMessage(operative, "newer-request", 2, "Stop implementing; let's discuss alternatives first.");
  assert.deepEqual(yield* read(), denied, "a newer request");
}));

// the child's own read call as a provider-native child records it: no AppRun, its item and node inside one provider turn that its
// projection publishes with strong native provenance
const providerNativeCall = (child: Projection, args: Record<string, unknown>) => {
  const itemId = installSubmission(child, {messageId: child.runs.at(-1)!.userMessageId} as never, args, {tool: "plan", runId: child.runs.at(-1)!.id});
  const providerThreadId = "child-provider-thread", turnId = "child-provider-turn", rootId = "child-turn-root";
  child.runs = [];
  const item = child.turnItems!.find(entry => entry.id === itemId)! as Record<string, unknown>;
  Object.assign(item, {runId: null, providerThreadId, providerTurnId: turnId});
  const root: Record<string, unknown> = {id: rootId, threadId: child.thread.id, runId: null, parentNodeId: null, rootNodeId: rootId, kind: "root_turn",
    providerThreadId, providerTurnId: turnId, status: "running"};
  const node: Record<string, unknown> = {id: item.nodeId, threadId: child.thread.id, runId: null, parentNodeId: rootId, rootNodeId: rootId, kind: "dynamic_tool",
    providerThreadId, providerTurnId: turnId, status: "completed"};
  child.nodes = [root, node];
  const turn: Record<string, unknown> = {id: turnId, providerThreadId, nodeId: rootId, runAttemptId: null,
    nativeTurnRef: {driver: "codex", nativeId: "native-child-turn", strength: "strong"}, ordinal: 1, status: "running", startedAt: "2026-10-27T12:00:00.000Z", completedAt: null};
  child.providerTurns = [turn];
  return {item, root, node, turn};
};

it.effect("a provider-native child with no AppRun reads its own bound plan through its strongly published turn, under the same fresh checks", () => Effect.gen(function* () {
  const {fixture, task, operative, child, native, controller, bind, args} = yield* childScoped;
  const bound = yield* bind;
  providerNativeCall(child, args);
  const read = () => controller.readOwnProposal(args);
  const ok = yield* read();
  assert.equal(ok.status, "ok", JSON.stringify(ok));
  assert.ok(ok.status === "ok" && ok.taskId === task.id && ok.proposal.startsWith(`Your scoped workflow ${bound.workflowId}, revision ${bound.revision},`), JSON.stringify(ok));
  // the same fresh main authority, lineage and Stop fences hold on this path
  const request = operative.messages[0]!;
  const original = request.text;
  request.text = "Stop implementing the retry fix; let's discuss alternatives first.";
  assert.deepEqual(yield* read(), denied, "an edited request");
  request.text = original;
  assert.equal((yield* read()).status, "ok");
  native.lineage = [{...operative.thread}, {...child.thread, lineage: {parentThreadId: sourceThreadId, relationshipToParent: "fork"}}];
  assert.deepEqual(yield* read(), denied, "an independent fork");
  native.lineage = [{...operative.thread}, {...child.thread}];
  const policy = yield* fixture.stores.policy.get();
  yield* fixture.stores.policy.save({...policy, excludedThreadIds: [...policy.excludedThreadIds, sourceThreadId]});
  assert.deepEqual(yield* read(), denied, "a stopped main");
}));

it.effect("a run-less child call proves nothing outside a strongly published turn of its own and never stands for an AppRun proof", () => Effect.gen(function* () {
  type Call = ReturnType<typeof providerNativeCall>;
  const cases: ReadonlyArray<readonly [string, (call: Call, child: Projection) => void, {status: string; reason: string}]> = [
    ["a weakly identified turn", ({turn}) => {turn.nativeTurnRef = {driver: "codex", nativeId: "native-child-turn", strength: "weak"};},
      {status: "denied", reason: "native_provider_turn_not_strong"}],
    ["an unpublished turn", (_call, child) => {child.providerTurns = [];}, {status: "pending", reason: "native_provider_turn_not_visible"}],
    ["another provider thread", ({item}) => {item.providerThreadId = "other-provider-thread";}, {status: "denied", reason: "native_provider_turn_mismatch"}],
    ["a node under a nested subagent", ({root, node}, child) => {
      (child.nodes as Array<Record<string, unknown>>).push({...node, id: "nested-subagent", kind: "subagent", parentNodeId: root.id});
      node.parentNodeId = "nested-subagent";
    }, {status: "denied", reason: "native_item_outside_provider_turn"}],
    ["a weakly identified item", ({item}) => {item.nativeItemRef = {driver: "codex", nativeId: "native-item", strength: "weak"};},
      {status: "denied", reason: "native_item_not_turn_strong"}],
    ["a call that never executed", ({item}) => {item.toolNonExecutionKind = "approval_declined";}, {status: "denied", reason: "native_item_not_executed"}],
  ];
  const {child, controller, bind, args} = yield* childScoped;
  yield* bind;
  const {item} = providerNativeCall(child, args);
  const verified = structuredClone({item, nodes: child.nodes, providerTurns: child.providerTurns});
  for (const [label, change, expected] of cases) {
    // the verified call again, its item kept as the object the detail read answers
    for (const key of Object.keys(item)) delete item[key];
    Object.assign(item, structuredClone(verified.item));
    child.nodes = structuredClone(verified.nodes);
    child.providerTurns = structuredClone(verified.providerTurns);
    const [root, node] = child.nodes as Array<Record<string, unknown>>;
    const [turn] = child.providerTurns as Array<Record<string, unknown>>;
    assert.equal((yield* controller.readOwnProposal(args)).status, "ok", `${label}: verified before the change`);
    change({item, root: root!, node: node!, turn: turn!}, child);
    const result = yield* controller.readOwnProposal(args);
    assert.deepEqual({status: result.status, reason: result.status === "ok" ? null : result.reason}, expected, label);
  }
  // writes and the interpretation submission search and verify AppRun calls only: the same run-less call is neither listed nor verified
  assert.deepEqual(workflowEvidenceCandidates(child, child.thread.id, "plan", args), []);
  assert.equal(verifyWorkflowToolEvidence({projection: child, supervisorThreadId: child.thread.id, itemId: String(item.id), detail: item, tool: "plan",
    arguments: args}).status, "pending");
}));
