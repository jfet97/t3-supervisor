import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Clock, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { fingerprint } from "../src/guidance-store.js";
import type { TaskRecord } from "../src/project-supervisor-store.js";
import type { NativeRpcShape } from "../src/supervisor-native.js";
import { planningDraftRead, type PlanningAttempt } from "../src/supervisor-planning.js";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ProjectSupervisorInfo } from "../src/project-supervisor-contract.js";
import { planAuthoringRules, proposalContextFromDefinitions, validateWorkflowPlan } from "../src/supervisor-workflow.js";
import { progressWorkflow, type WorkflowProgressSnapshot } from "../src/workflow-progress.js";
import type { WorkflowStateDocument } from "../src/workflow-state-contract.js";
import { TaskWorkspace } from "../ui/src/project-supervisor.js";
import type { WorkflowProposalInfo } from "../src/project-supervisor-contract.js";
import type { ThreadInfo } from "../src/types.js";
import { workflowToolNames } from "../src/workflow-write-evidence.js";
import { goldenSnapshot } from "./support/c1-workflow-fixture.js";
import { stopMain } from "./support/g11-team.js";
import { planningFixture } from "./support/planning-fixture.js";

// the read-only planning drafter's own route: supervision_planning draft_read with the pins its task names, admitted only as the own
// executed call of this attempt's drafter while the attempt is current, answering one read-only view and changing nothing

type Fixture = Effect.Success<ReturnType<typeof planningFixture>>;
type Result = {status: string; reason?: string; view?: string; [key: string]: unknown};

/** An app-owned child the owner started with delegate_task, as T3 lists it in the owner's subagents. */
const delegatedChild = (f: Fixture, threadId: string, taskId: string, startedAt: number, parentThreadId = f.binding.threadId) => {
  const thread: ThreadInfo = {id: threadId, title: threadId, projectId: "project", lineage: {parentThreadId, relationshipToParent: "subagent"},
    runtimeMode: "full-access", interactionMode: "default"};
  f.threads.push(thread);
  f.projections.set(threadId, {thread, runs: [], nodes: [], messages: [], turnItems: [], runtimeRequests: []});
  const parent = f.projections.get(parentThreadId)!;
  parent.subagents = [...(parent.subagents ?? []), {id: taskId, childThreadId: threadId, origin: "app_owned", status: "running", startedAt: new Date(startedAt).toISOString()}];
  return thread;
};

/** A run-less native child's own executed call, inside a provider turn its projection publishes with strong native provenance. */
const providerTurnCall = (f: Fixture, threadId: string, input: Record<string, unknown>) => {
  const caller = f.projections.get(threadId)!;
  const itemId = `provider-call-${f.details.size}`;
  const providerThreadId = `provider-${threadId}`, providerTurnId = `turn-${itemId}`, rootNodeId = `root-${itemId}`, nodeId = `node-${itemId}`;
  const detail = {id: itemId, type: "dynamic_tool", threadId, runId: null, nodeId, providerThreadId, providerTurnId,
    nativeItemRef: {driver: "claude", nativeId: itemId, strength: "strong"}, parentItemId: null, ordinal: f.details.size + 1, status: "completed",
    toolNonExecutionKind: null, toolName: workflowToolNames.planning.direct[1], input};
  f.details.set(itemId, detail);
  caller.turnItems!.push({...detail});
  (caller.nodes as Record<string, unknown>[]).push(
    {id: rootNodeId, kind: "root_turn", threadId, runId: null, parentNodeId: null, rootNodeId, providerThreadId, providerTurnId, status: "completed"},
    {id: nodeId, kind: "dynamic_tool", threadId, runId: null, parentNodeId: rootNodeId, rootNodeId, providerThreadId, providerTurnId, status: "completed"});
  caller.providerTurns = [...(caller.providerTurns as unknown[] | undefined ?? []), {id: providerTurnId, providerThreadId, nodeId: rootNodeId,
    nativeTurnRef: {driver: "claude", nativeId: providerTurnId, strength: "strong"}, status: "completed", startedAt: "2026-10-27T12:00:00.000Z"}];
};

/**
 * An owner whose pause is open, with readable definitions, and its drafter started for the attempt but not yet attached. The request's
 * read handle is recorded as preparation records it: the turn item T3 published for that message.
 */
const draftingWith = (prepare: (task: TaskRecord) => TaskRecord = task => task, rpc?: NativeRpcShape) => Effect.gen(function* () {
  const f = yield* planningFixture(rpc);
  const now = yield* Clock.currentTimeMillis;
  f.projections.get("main")!.turnItems!.push({id: "turn-item:message:request-a", type: "user_message", messageId: "request-a", threadId: "main",
    runId: "source-run"});
  const task = (yield* f.stores.supervisors.task("main"))!;
  yield* f.stores.supervisors.saveTask(prepare({...task, definitionSnapshot: {...goldenSnapshot, projectId: "project", threadId: "main"},
    interpretationSources: {requestedBy: {kind: "human"}, operativeMessages: [],
      requesterMessages: [{messageId: "request-a", readItemId: "turn-item:message:request-a", requester: "human"}]}}));
  f.proof(f.args);
  const paused = (yield* f.controller.call(f.args)) as {status: string; attempt: {attemptId: string; draftInstruction: string}};
  assert.equal(paused.status, "recorded");
  const attempt = (yield* f.stores.requests.planningAttempts("project"))[0]!;
  delegatedChild(f, "writer", "draft-task", now);
  // the drafter calls exactly what its task names: the arguments are read from the rendered instruction, not rebuilt
  const instruction = paused.attempt.draftInstruction;
  const marker = "Read with supervision_planning ";
  const start = instruction.indexOf(marker) + marker.length;
  const route = JSON.parse(instruction.slice(start, instruction.indexOf("}", start) + 1)) as Record<string, unknown>;
  assert.deepEqual(route, planningDraftRead(attempt, "context"));
  const read = (view: string, extra: Record<string, unknown> = {}) => ({...route, view, ...extra});
  const stored = () => Effect.map(f.stores.requests.planningAttempts("project"), rows => JSON.stringify(rows));
  const call = (input: Record<string, unknown>) => Effect.map(f.controller.call(input), result => result as Result);
  return {f, now, attempt, read, stored, call};
});
const drafting = draftingWith();

it.effect("a drafter reads the context, definitions and plan grammar its task names through its own calls, before and after it is attached, changing nothing", () => Effect.gen(function* () {
  const {f, attempt, read, stored, call} = yield* drafting;
  const before = yield* stored();
  f.callAs("writer", read("context"));
  const context = yield* call(read("context"));
  assert.equal(context.status, "ok", JSON.stringify(context));
  assert.equal(context.view, "context");
  const contextTask = context.task as {taskId: string; taskRevision: string; sourceMessageId: string; contextMessageIds: string[];
    sources: {requesterMessages: Array<{messageId: string; readItemId: string | null}>}};
  assert.deepEqual([contextTask.taskId, contextTask.taskRevision, contextTask.sourceMessageId], [attempt.taskId, attempt.taskRevision, "request-a"]);
  // the drafter reads the main's messages by their published turn items in the thread the answer names; a message ID is provenance
  assert.equal(context.mainThreadId, "main");
  const [request] = contextTask.sources.requesterMessages;
  assert.equal(f.projections.get(String(context.mainThreadId))!.turnItems!.find(item => item.id === request!.readItemId)?.messageId, contextTask.sourceMessageId,
    "the exact read handle resolves to the request");
  assert.notEqual(request!.readItemId, request!.messageId);
  assert.deepEqual(context.sections, ["conversation", "plan"], "the sections a drafter can read");
  assert.ok(!("submission" in context), "the root's own interpretation submission is never offered to a drafter");
  f.callAs("writer", read("definitions"));
  const index = yield* call(read("definitions"));
  assert.equal(index.status, "ok", JSON.stringify(index));
  assert.deepEqual((index.steps as Array<{id: string}>).map(step => step.id), ["verify", "publish"]);
  f.callAs("writer", read("definitions", {definitionIds: ["verify"]}));
  const selected = yield* call(read("definitions", {definitionIds: ["verify"]}));
  assert.deepEqual((selected.steps as Array<{id: string; description: string}>).map(step => [step.id, step.description]), [["verify", "Check the changed behavior."]]);
  f.callAs("writer", read("plan_rules"));
  const rules = yield* call(read("plan_rules"));
  // the shared authoring rules, without the root's pause coordination
  assert.deepEqual([rules.status, rules.view, rules.instructions], ["ok", "plan_rules", planAuthoringRules]);
  assert.doesNotMatch(String(rules.instructions), /PLANNING PAUSE|supervision_planning|ACK/u);
  assert.equal(yield* stored(), before, "reads never write, renew or reopen the attempt");
  // the owner attaches the drafter; its reads continue under the same checks
  const attach = {...f.args, action: "attach_draft", operationId: "attach-a", attemptId: attempt.id, draftThreadId: "writer", draftTaskId: "draft-task"};
  delete (attach as {targetThreadIds?: unknown}).targetThreadIds;
  f.proof(attach);
  assert.equal((yield* call(attach)).status, "recorded");
  assert.equal((yield* call(read("context"))).status, "ok");
  // a run-less native drafter proves its call through its own provider turn
  f.projections.get("writer")!.runs = [];
  assert.equal((yield* call(read("plan_rules"))).status, "pending", "its earlier calls' runs are gone");
  providerTurnCall(f, "writer", read("plan_rules"));
  assert.equal((yield* call(read("plan_rules"))).status, "ok");
  const deadline = (yield* f.stores.requests.planningAttempts("project"))[0]!.deadline;
  assert.equal(deadline, attempt.deadline, "no read moves the deadline");
}));

it.effect("only the attempt's drafter, by its own executed call of exactly these arguments, is admitted", () => Effect.gen(function* () {
  const {f, now, attempt, read, stored, call} = yield* drafting;
  const before = yield* stored();
  const notAdmitted = (result: Result) => assert.ok(result.status !== "ok" && !("task" in result) && !("steps" in result) && !("instructions" in result),
    JSON.stringify(result));
  // a forged call: the owner (or anyone) calls the drafter's route, which no drafter executed
  f.proof(read("context"));
  const forged = yield* call(read("context"));
  notAdmitted(forged);
  assert.deepEqual(forged, {status: "pending", reason: "native_evidence_not_visible", retryable: true});
  // a foreign call: an operative child's own call of the same route
  delegatedChild(f, "operative-child", "operative-task", now, "main");
  f.callAs("operative-child", read("definitions"));
  notAdmitted(yield* call(read("definitions")));
  // the drafter's own call proves only exactly its arguments
  f.callAs("writer", read("context"));
  assert.equal((yield* call(read("context"))).status, "ok");
  notAdmitted(yield* call(read("plan_rules")));
  notAdmitted(yield* call(read("context", {attemptId: "another-attempt"})));
  assert.deepEqual(yield* call(read("context", {taskRevision: "another-revision"})), {status: "denied", reason: "planning_attempt_unknown"});
  // without a new drafter of this attempt nothing is admitted: a helper, an older child or an operative child
  const owner = f.projections.get(f.binding.threadId)!;
  const delegated = owner.subagents!;
  owner.subagents = [];
  assert.deepEqual(yield* call(read("context")), {status: "denied", reason: "planning_drafter_unknown"}, "the drafter's task record is required");
  delegatedChild(f, "older", "older-task", now - 1);
  f.callAs("older", read("context"));
  assert.deepEqual(yield* call(read("context")), {status: "denied", reason: "planning_drafter_unknown"}, "a child started before the attempt");
  const helper = yield* f.stores.team.registerMember(f.binding, {threadId: "helper", taskId: "bootstrap", bootstrapRunId: "bootstrap-run", now: 1});
  delegatedChild(f, helper.threadId, "helper-task", now);
  f.callAs(helper.threadId, read("context"));
  assert.deepEqual(yield* call(read("context")), {status: "denied", reason: "planning_drafter_unknown"}, "a monitoring helper is no drafter");
  assert.equal(yield* stored(), before, "no refused call changed the attempt");
  // once another drafter is attached, the earlier child is no longer this attempt's drafter
  owner.subagents = [...delegated, ...owner.subagents];
  assert.equal((yield* call(read("context"))).status, "ok");
  delegatedChild(f, "second-writer", "second-task", now);
  const attach = {...f.args, action: "attach_draft", operationId: "attach-second", attemptId: attempt.id, draftThreadId: "second-writer", draftTaskId: "second-task"};
  delete (attach as {targetThreadIds?: unknown}).targetThreadIds;
  f.proof(attach);
  assert.equal((yield* call(attach)).status, "recorded");
  f.callAs("writer", read("context"));
  notAdmitted(yield* call(read("context")));
  assert.equal(JSON.parse(yield* stored())[0].draft.threadId, "second-writer");
  assert.notEqual(yield* stored(), before);
}));

it.effect("a drafter cannot write, act through its read or read a closed, expired, stopped or changed attempt", () => Effect.gen(function* () {
  const {f, attempt, read, stored, call} = yield* drafting;
  f.callAs("writer", read("context"));
  assert.equal((yield* call(read("context"))).status, "ok");
  const before = yield* stored();
  // no field of any acting action rides on a read
  for (const extra of [{resolution: "no_plan"}, {operationId: "op"}, {reason: "Publish"}, {targetThreadIds: ["main"]}, {draftThreadId: "writer"},
    {memberEpoch: 1}, {includeSources: true}, {callerThreadId: "writer"}]) {
    f.callAs("writer", read("context", extra));
    assert.deepEqual(yield* call(read("context", extra)), {status: "invalid", reason: "invalid_planning_arguments"}, JSON.stringify(extra));
  }
  f.callAs("writer", read("context", {definitionIds: ["verify"]}));
  assert.deepEqual(yield* call(read("context", {definitionIds: ["verify"]})), {status: "invalid", reason: "invalid_planning_arguments"});
  // the drafter's own release or attach with its owner's pins is no owner call; its own thread is no owner either
  for (const action of [{action: "release", operationId: "writer-release", attemptId: attempt.id, resolution: "no_plan"},
    {action: "attach_draft", operationId: "writer-attach", attemptId: attempt.id, draftThreadId: "writer", draftTaskId: "draft-task"}]) {
    const write = {supervisorThreadId: f.binding.threadId, bindingGeneration: f.binding.generation, taskId: attempt.taskId, taskRevision: attempt.taskRevision, ...action};
    f.callAs("writer", write);
    assert.notEqual((yield* call(write)).status, "recorded", action.action);
  }
  const ownPause = {...f.args, supervisorThreadId: "writer", operationId: "writer-pause"};
  f.callAs("writer", ownPause);
  assert.deepEqual(yield* call(ownPause), {status: "denied", reason: "actor_not_current_ready_enabled"});
  assert.equal(yield* stored(), before, "nothing a drafter called changed the attempt");
  // a changed task revision, a Stop and the end of the attempt each refuse the read
  const task = (yield* f.stores.supervisors.task("main"))!;
  yield* f.stores.supervisors.saveTask({...task, conversation: {...task.conversation!, authorization: {...task.conversation!.authorization!,
    scopeRevision: fingerprint("A reconsidered authorized scope.")}}});
  assert.deepEqual(yield* call(read("context")), {status: "denied", reason: "planning_scope_changed"});
  yield* f.stores.supervisors.saveTask(task);
  assert.equal((yield* call(read("context"))).status, "ok");
  yield* stopMain(f.policy, "main");
  assert.deepEqual(yield* call(read("context")), {status: "denied", reason: "planning_scope_changed"});
  yield* stopMain(f.policy, null);
  assert.equal((yield* call(read("context"))).status, "ok");
  yield* TestClock.adjust(attempt.deadline - (yield* Clock.currentTimeMillis));
  assert.deepEqual(yield* call(read("context")), {status: "closed", reason: "planning_attempt_closed"}, "an expired attempt");
  const expired = JSON.parse(yield* stored())[0] as PlanningAttempt;
  assert.equal(expired.state, "expired", "the deadline ended it; a later read cannot reopen it");
  assert.equal((yield* call(read("context"))).status, "closed");
}));

it.effect("an owner's release closes its drafter's reads", () => Effect.gen(function* () {
  const {f, attempt, read, call} = yield* drafting;
  f.callAs("writer", read("context"));
  assert.equal((yield* call(read("context"))).status, "ok");
  const release = {...f.args, action: "release", operationId: "release-a", attemptId: attempt.id, resolution: "no_plan"};
  delete (release as {targetThreadIds?: unknown}).targetThreadIds;
  f.proof(release);
  assert.equal((yield* call(release)).status, "recorded");
  assert.deepEqual(yield* call(read("context")), {status: "closed", reason: "planning_attempt_closed"});
}));

/** The current proposal, accepted, holding a task-local duty that no definition and no chat message names. */
const acceptedPlan = (duty: string) => (task: TaskRecord): TaskRecord => {
  const definitions = {...goldenSnapshot, projectId: "project", threadId: "main"};
  const normalized = validateWorkflowPlan({requirements: [{kind: "step", id: "verify", applies: true, reason: "The task changes behavior."}],
    plan: {kind: "sequence", nodes: [{kind: "step", definitionId: "verify", reason: "Check the changed behavior."},
      {kind: "step", definitionId: null, localId: "notify-the-release-owner", name: "Notify the release owner", description: duty, reason: "The release needs the owner's go-ahead."}]}},
  proposalContextFromDefinitions(definitions))!;
  const proposal: WorkflowProposalInfo = {status: "proposed", message: "The accepted proposal.", workspaceRoot: definitions.workspaceRoot,
    revision: definitions.revision, globalRevision: definitions.globalRevision ?? null, ...normalized};
  return {...task, definitionContext: proposalContextFromDefinitions(definitions), agreementSourceHash: task.sourceHash, workflow: proposal,
    workflowProposalId: "proposal-accepted", agreement: {status: "agreed", message: "The operative accepted the plan.",
    proposalId: "proposal-accepted", agreedAt: 1, evidence: {kind: "supervisor_message", messageId: "proposal-message"}, agentMessageId: "acceptance-message",
    workflow: proposal}};
};
// every key of an answer, at any depth
const keysOf = (value: unknown): string[] => Array.isArray(value) ? value.flatMap(keysOf)
  : value !== null && typeof value === "object" ? Object.entries(value).flatMap(([key, inner]) => [key, ...keysOf(inner)]) : [];
// what the root's own interpretation submission takes: its pins, its verdict, its attempt and the source pin's revision fields
const submissionInputKeys = ["submission", "sourcePin", "startVerdict", "attemptId", "hash", "runId", "ordinal"];

it.effect("a drafter fetches the intent and the accepted current plan with its task-local duty through explicit sections, before and after it is attached, and no section names the root's submission inputs", () => Effect.gen(function* () {
  const duty = "Ask the release owner in the deploy channel for a written go-ahead before tagging.";
  const {f, attempt, read, call} = yield* draftingWith(acceptedPlan(duty));
  // the root's current interpretation attempt: its submission pins are the root's alone
  const task = (yield* f.stores.supervisors.task("main"))!;
  const interpretationAttemptId = "interpretation-attempt:0f8b5c1e-2a4d-4c3b-9e7f-1a2b3c4d5e6f";
  yield* f.stores.supervisors.saveTask({...task, attempt: {attemptId: interpretationAttemptId, key: {bindingGeneration: f.binding.generation, taskId: task.id,
    source: {messageId: task.sourceMessageId, runId: task.sourceRunId, ordinal: task.sourceOrdinal, hash: task.sourceHash}, requestMessageId: task.messageId,
    requestTextHash: fingerprint("Interpretation requested.")}}});
  // the root reads them, so the drafter's answers below are not trivially free of them
  const rootContext = yield* f.conversation.readContextView(f.binding, {view: "context"});
  assert.equal((rootContext.submission as {arguments: {attemptId: string}}).arguments.attemptId, interpretationAttemptId);
  const rootConversation = yield* f.conversation.readContextView(f.binding, {view: "context", section: "conversation"});
  assert.equal((rootConversation.conversation as {authorization: {attemptId: string}}).authorization.attemptId, "fixture-source");
  // definitions and the chat alone never show the duty: only the current plan does
  f.callAs("writer", read("definitions"));
  f.callAs("writer", read("definitions", {definitionIds: ["verify", "publish"]}));
  for (const answer of [yield* call(read("definitions")), yield* call(read("definitions", {definitionIds: ["verify", "publish"]}))]) {
    assert.equal(answer.status, "ok", JSON.stringify(answer));
    assert.equal(JSON.stringify(answer).includes(duty), false);
  }
  assert.equal(f.projections.get("main")!.messages.some(message => message.text.includes(duty)), false);

  const readSections = Effect.gen(function* () {
    const shown: Record<string, Result> = {};
    for (const section of [undefined, "conversation", "plan"] as const) {
      const input = read("context", section ? {section} : {});
      f.callAs("writer", input);
      const answer = yield* call(input);
      assert.equal(answer.status, "ok", JSON.stringify(answer));
      const keys = keysOf(answer);
      for (const key of submissionInputKeys) assert.equal(keys.includes(key), false, `${section ?? "default"} names ${key}`);
      for (const value of [interpretationAttemptId, "fixture-source"]) assert.equal(JSON.stringify(answer).includes(value), false, `${section ?? "default"} names ${value}`);
      shown[section ?? "default"] = answer;
    }
    // the intent: the authorized outcome and its requester provenance
    const conversation = shown.conversation!.conversation as {authorization: {outcome: string; state: string; scopeSources: unknown[]}};
    assert.deepEqual([conversation.authorization.outcome, conversation.authorization.state], ["Update the application", "authorized"]);
    assert.deepEqual(conversation.authorization.scopeSources, [{messageId: "request-a", requester: "human"}]);
    // the current plan: the accepted proposal, its outline and the task-local duty itself
    const plan = shown.plan!;
    assert.deepEqual([(plan.proposal as {proposalId: string}).proposalId, (plan.agreement as {status: string; proposalId: string})],
      ["proposal-accepted", {status: "agreed", proposalId: "proposal-accepted"}]);
    assert.deepEqual(plan.source, {kind: "proposal", proposalId: "proposal-accepted"}, "without a live workflow the plan is the proposal");
    assert.ok((plan.outline as string[]).some(line => line.includes("Notify the release owner [local:notify-the-release-owner]")), JSON.stringify(plan.outline));
    assert.deepEqual(plan.localDuties, [`- Notify the release owner [local:notify-the-release-owner]:\n  ${duty}`]);
    return shown;
  });
  const before = yield* readSections;
  // the root's diagnostics stay the root's, and a section belongs to view context only
  for (const input of [read("context", {section: "diagnostics"}), read("definitions", {section: "plan"}), read("plan_rules", {section: "plan"})]) {
    f.callAs("writer", input);
    assert.deepEqual(yield* call(input), {status: "invalid", reason: "invalid_planning_arguments"}, JSON.stringify(input));
  }
  // the owner attaches the drafter; the same explicit reads return the same current facts
  const attach = {...f.args, action: "attach_draft", operationId: "attach-a", attemptId: attempt.id, draftThreadId: "writer", draftTaskId: "draft-task"};
  delete (attach as {targetThreadIds?: unknown}).targetThreadIds;
  f.proof(attach);
  assert.equal(((yield* call(attach)) as Result).status, "recorded");
  assert.deepEqual(yield* readSections, before);
}));

it.effect("a drafter reads in the pre-attach window after its owner's turn ended, across service cycles, elapsed time and concurrent reads", () => Effect.gen(function* () {
  const sent: Record<string, unknown>[] = [];
  const rpc: NativeRpcShape = {call: () => Effect.die(new Error("admitted initiation only")), initiate: (_tag, payload) => {
    sent.push({...payload});return Effect.succeed({sent: Effect.succeed(true), release: Effect.void, result: Effect.succeed({sequence: sent.length})});
  }};
  const duty = "Ask the release owner in the deploy channel for a written go-ahead before tagging.";
  const {f, attempt, read, stored, call} = yield* draftingWith(acceptedPlan(duty), rpc);
  // the owner's turn ended with delegate_task: the drafter exists, and no attach_draft was called
  assert.equal(JSON.parse(yield* stored())[0].draft, undefined);
  // while the owner yields, the service delivers the hold, anchors the deadline and time passes
  yield* f.controller.reconcile(f.binding);
  assert.ok(sent.some(command => command.type === "message.dispatch" && command.threadId === "main"), "the hold went out while the owner yielded");
  const anchored = (JSON.parse(yield* stored()) as PlanningAttempt[])[0]!;
  assert.notEqual(anchored.startedAt, null);
  yield* TestClock.adjust(45_000);
  yield* f.controller.reconcile(f.binding);
  const waiting = yield* stored();
  // the drafter's first reads arrive on their own fibers, interleaved with another service cycle
  f.callAs("writer", read("context", {section: "conversation"}));
  f.callAs("writer", read("context", {section: "plan"}));
  const reads = yield* Effect.forkChild(Effect.all([call(read("context", {section: "conversation"})), call(read("context", {section: "plan"}))],
    {concurrency: "unbounded"}));
  yield* f.controller.reconcile(f.binding);
  const [intent, plan] = yield* Fiber.join(reads);
  assert.equal(intent.status, "ok", JSON.stringify(intent));
  assert.equal(plan.status, "ok", JSON.stringify(plan));
  assert.deepEqual(plan.localDuties, [`- Notify the release owner [local:notify-the-release-owner]:\n  ${duty}`]);
  const after = (JSON.parse(yield* stored()) as PlanningAttempt[])[0]!;
  assert.equal(after.draft, undefined, "a pre-attach read attaches nothing");
  assert.equal(after.deadline, anchored.deadline, "no read moves the deadline");
  assert.equal(yield* stored(), waiting, "the reads changed nothing the service cycles had not");
  // the owner's later turn attaches the drafter, and its reads continue
  const attach = {...f.args, action: "attach_draft", operationId: "attach-a", attemptId: attempt.id, draftThreadId: "writer", draftTaskId: "draft-task"};
  delete (attach as {targetThreadIds?: unknown}).targetThreadIds;
  f.proof(attach);
  assert.equal(((yield* call(attach)) as Result).status, "recorded");
  f.callAs("writer", read("context", {section: "plan"}));
  assert.deepEqual(yield* call(read("context", {section: "plan"})), plan);
}));

/** The accepted proposal imported into the main's live workflow, whose content then matches the accepted snapshot. */
const liveAccepted = Effect.gen(function* () {
  const {f, attempt, read, call} = yield* draftingWith(acceptedPlan("Original local duty"));
  const task = (yield* f.stores.supervisors.task("main"))!;
  const owner = {projectId: "project", mainThreadId: "main", supervisorThreadId: f.binding.threadId, bindingGeneration: f.binding.generation};
  const imported = yield* f.states.importAcceptedAgreement(owner, {taskId: task.id, sourceThreadId: "main", sourceRunId: task.sourceRunId,
    sourceMessageId: task.sourceMessageId, sourceHash: task.sourceHash, objective: task.objective!, agreement: task.agreement!}, 1);
  assert.equal(imported.status, "applied", JSON.stringify(imported));
  const accepted = (yield* f.states.get("project", "main"))!;
  return {f, attempt, read, call, task, accepted};
});

/**
 * Astra's reproduction: the production workflow_write controller then adds a task-local duty, so the live plan (revision 2) no
 * longer matches the accepted snapshot.
 */
const liveEdit = Effect.gen(function* () {
  const {f, attempt, read, call, task, accepted} = yield* liveAccepted;
  const duty = "Preserve the deployment recovery evidence before handoff.";
  const writeArgs = {supervisorThreadId: f.binding.threadId, bindingGeneration: f.binding.generation, action: "apply", input: {operationId: "add-live-duty",
    workflowId: accepted.workflowId, expectedRevision: accepted.revision, status: accepted.status, objective: accepted.objective,
    sourceBinding: accepted.sourceBinding!, requirements: accepted.requirements, issues: accepted.issues,
    plan: {...accepted.plan!, nodes: [...accepted.plan!.nodes, {kind: "step", definitionId: null, localId: "recovery-evidence", name: "Recovery evidence",
      description: duty, reason: "Current live supporting duty.", status: "planned"}]}, note: "Add supporting work."}};
  // the root's own executed workflow_write call proves the write
  f.proof(writeArgs);
  const writeDetail = [...f.details.values()].at(-1) as {id: string; toolName: string};
  writeDetail.toolName = workflowToolNames.write.direct[0];
  f.projections.get(f.binding.threadId)!.turnItems!.find(item => item.id === writeDetail.id)!.toolName = writeDetail.toolName;
  const written = (yield* f.workflows.write(writeArgs)) as {status: string};
  assert.equal(written.status, "applied", JSON.stringify(written));
  const live = (yield* f.states.get("project", "main"))!;
  assert.ok(JSON.stringify(live.plan).includes(duty));
  return {f, attempt, read, call, task, accepted, live, duty};
});

it.effect("a drafter reads a duty added to the current live plan before and after attach, with its revision and acceptance validity", () => Effect.gen(function* () {
  const {f, attempt, read, call, task, live, duty} = yield* liveEdit;
  assert.equal(live.currentAgreementKey, null, "the edit leaves the accepted snapshot");
  const args = read("context", {section: "plan"});
  f.callAs("writer", args);
  const before = yield* call(args);
  assert.equal(before.status, "ok", JSON.stringify(before));
  assert.deepEqual(before.source, {kind: "live", workflowId: live.workflowId, revision: live.revision, accepted: false});
  assert.deepEqual(before.localDuties, ["- Notify the release owner [local:notify-the-release-owner]:\n  Original local duty", `- Recovery evidence [local:recovery-evidence]:\n  ${duty}`]);
  assert.ok((before.outline as string[]).some(line => line.includes("Recovery evidence [local:recovery-evidence]")));
  assert.deepEqual(before.requirements, live.requirements);
  // the earlier acceptance stays its own record: it still names the accepted proposal, which never contained the new duty
  assert.deepEqual(before.agreement, {status: "agreed", proposalId: "proposal-accepted"});
  assert.equal(JSON.stringify(task.agreement!.workflow.plan).includes(duty), false);
  const attach = {...f.args, action: "attach_draft", operationId: "attach-current-live", attemptId: attempt.id, draftThreadId: "writer", draftTaskId: "draft-task"};
  delete (attach as {targetThreadIds?: unknown}).targetThreadIds;
  f.proof(attach);
  assert.equal((yield* call(attach)).status, "recorded");
  assert.deepEqual(yield* call(args), before, "the attached drafter reads the same current plan");
}));

const planSection = (f: Fixture) =>
  Effect.map(f.conversation.readContextView(f.binding, {view: "context", section: "plan"}), read => read as Record<string, unknown>);

it.effect("the plan section reports the imported live plan accepted while its content matches the accepted snapshot", () => Effect.gen(function* () {
  const {f, accepted} = yield* liveAccepted;
  assert.notEqual(accepted.currentAgreementKey, null);
  const plan = yield* planSection(f);
  assert.deepEqual(plan.source, {kind: "live", workflowId: accepted.workflowId, revision: accepted.revision, accepted: true});
  assert.deepEqual(plan.localDuties, ["- Notify the release owner [local:notify-the-release-owner]:\n  Original local duty"]);
}));

it.effect("a live plan bound to an earlier scope is not the current plan: the section falls back to the task's proposal", () => Effect.gen(function* () {
  const {f, task, live, duty} = yield* liveEdit;
  assert.equal(((yield* planSection(f)).source as {kind: string}).kind, "live");
  // a new authorized scope unbinds the live workflow: the plan is the task's current proposal again, without the live duty
  yield* f.stores.supervisors.saveTask({...task, conversation: {...task.conversation!, authorization: {...task.conversation!.authorization!,
    scopeRevision: fingerprint("A reconsidered authorized scope.")}}});
  const fallback = yield* planSection(f);
  assert.deepEqual(fallback.source, {kind: "proposal", proposalId: "proposal-accepted"});
  assert.equal(JSON.stringify(fallback).includes(duty), false);
  assert.ok(JSON.stringify(live.plan).includes(duty));
}));

/** The task workspace for the main, rendered from the live workflow the way the dashboard reads it. */
const renderLive = (task: TaskRecord, document: WorkflowStateDocument, initialView: "plan" | "history" = "plan") => {
  const page: WorkflowProgressSnapshot = {status: "ok", message: null, projectId: "project", mainThreadId: "main", observedAt: 2, scope: null,
    incompatibleWorkflows: [], workflows: [progressWorkflow(document, [])], workflowOffset: 0, workflowHasMore: false, lineageOffset: 0, lineageHasMore: false};
  return renderToStaticMarkup(createElement(TaskWorkspace, {snapshot: {available: true} as unknown as ProjectSupervisorInfo, task, threadId: "main", initialView,
    progress: {key: "live-edit", pages: [page], loading: false, error: null}, connected: true, attention: [], stopped: false, readAt: 2, refreshing: false,
    onRefresh: () => {}, onLoadMore: () => {}}));
};
const journeyTitle = (html: string) => /<h2 id="journey-title">(.*?)<\/h2>/su.exec(html)?.[1];

it.effect("the dashboard never labels an edited, unaccepted plan accepted and keeps the accepted plan as its own record", () => Effect.gen(function* () {
  const {task, accepted, live, duty} = yield* liveEdit;
  // control: the imported plan still matches its accepted snapshot
  const acceptedHtml = renderLive(task, accepted);
  assert.equal(journeyTitle(acceptedHtml), "Current accepted plan");
  assert.match(acceptedHtml, /Plan accepted/);
  // the live plan with the added duty: shown as the current plan, its new step outside the acceptance
  const html = renderLive(task, live);
  assert.equal(journeyTitle(html), "Current plan · differs from the accepted plan");
  assert.ok(html.includes(duty), "the unaccepted added duty is rendered");
  assert.match(html, /Recovery evidence<span class="step-flags"><span class="pill">Not in the accepted plan<\/span>/u);
  assert.match(html, /This plan changed after proposal proposal-accepted was accepted/u);
  assert.match(html, /Changes not accepted/u);
  assert.match(html, /Accepted an earlier version; later changes are not accepted/u);
  assert.doesNotMatch(html, /Current accepted plan|Plan accepted|Accepted this plan/u);
  // History keeps the accepted plan distinct: its own steps, without the later duty
  const history = renderLive(task, live, "history");
  // the accepted plan's record is the last part of the History sources, each of its steps its own disclosure
  const acceptedTitle = history.indexOf("Accepted plan (before later changes)");
  assert.notEqual(acceptedTitle, -1);
  const acceptedRecord = history.slice(acceptedTitle);
  assert.match(acceptedRecord, /The plan accepted as proposal proposal-accepted/u);
  assert.match(acceptedRecord, /Notify the release owner/u);
  assert.doesNotMatch(acceptedRecord, /Recovery evidence/u);
}));
