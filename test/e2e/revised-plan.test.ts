import assert from "node:assert/strict";
import { join } from "node:path";
import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { repositoryRoot } from "../../scripts/local-run.js";
import { forgeDashboardToken } from "../../src/service-auth.js";
import { journeyPage } from "../support/browser.js";
import { httpJson } from "../support/glinint-wiring.js";
import { driveInterpretation, driveNoPlanInterpretation, eventuallyValue, startupMainThreadId, startupProjectId, startupSession } from "../support/startup-gateway.js";
import { dashboard } from "./dashboard.js";

/*
  A supervised task is completed, then the person changes its request, and the agent accepts the Supervisor's revised plan
  (docs/testing.md). The dashboard shows that accepted plan as the current one, planned and not yet assessed, while the earlier
  completion stays in History, and a restart of the application changes nothing it shows. A later request of the person that needs
  no plan then changes the authorized scope: the accepted plan keeps its own identity as history, with no pending update and no
  reconciliation duty, through a Stop clicked in the dashboard and another restart. The production Supervisor runs over the
  scripted T3 peer: the root interprets each request through the workflow MCP route, answers its other service requests with their
  own final markers and records the accepted work completed with its own workflow write, the agent reads each proposal and copies its
  acceptance record into its reply, and the person edits the original request and sends the later one in T3. The page reads the
  durable state through the dashboard API with the browser's own session.
*/

const chat = startupMainThreadId;
const steps = {
  inspect: {localId: "inspect", name: "Inspect checkout", description: "Read the current checkout and its remote state.", reason: "Establish the facts."},
  explain: {localId: "explain", name: "Explain status", description: "Explain the observed status and any gaps.", reason: "Answer from the evidence."},
  dryRun: {localId: "dry-run", name: "Dry run the cleanup", description: "List exactly what the cleanup would remove, without removing it.",
    reason: "The changed request asks for a dry run first."},
};
// the exact acceptance record a proposal read hands the agent, copied into its reply
const acceptanceOf = (proposal: string | undefined): string => {
  const record = /```workflow-acceptance\n[^\n]+\n```/u.exec(proposal ?? "")?.[0];
  assert.ok(record, `the agent's read carries the exact acceptance record: ${proposal ?? "no proposal"}`);
  return record;
};
// the root's own workflow reader identity, as its interpretation request names it
const readerOf = (text: string): {supervisorThreadId: string; bindingGeneration: number} => {
  const match = /with (\{"supervisorThreadId":"[^"]+","bindingGeneration":\d+\})/u.exec(text);
  assert.ok(match?.[1], "the interpretation request names the root's reader");
  return JSON.parse(match[1]) as {supervisorThreadId: string; bindingGeneration: number};
};
type StatusView = {workflows?: ReadonlyArray<{workflowId: string; threadId: string; revision: number; occurrences: ReadonlyArray<{nodeId: string; kind: string; name: string}>}>};

it.live("a revised plan the agent accepts after a completed task changed is the dashboard's current plan, with the earlier completion in History across a restart, " +
  "and stays history when a later request needs no plan, through a dashboard Stop and another restart", () => Effect.gen(function* () {
  const supervisor = yield* startupSession({uiAssetsDirectory: join(repositoryRoot, "ui-dist"), checkout: {
    ".t3-supervisor/project.yaml": "workflows: []\nsteps: []\n",
    ".t3-supervisor/steps/.gitkeep": "",
    ".t3-supervisor/workflows/.gitkeep": "",
  }});
  const {gateway, observe} = supervisor;
  // the first request: the root's plan, the agent's acceptance and the workflow that accepted plan starts
  const first = yield* driveInterpretation(supervisor, {index: 0, objective: "Inspect the checkout and explain its status.",
    reason: "Two bounded evidence and reporting duties.", steps: [steps.inspect, steps.explain]});
  observe.completeMainRun(acceptanceOf(first.proposal.proposal));
  const accepted = yield* eventuallyValue(Effect.sync(() => {
    const workflow = observe.mainWorkflow();
    return workflow?.currentAgreementKey ? workflow : null;
  }), () => `the first acceptance was not imported: ${JSON.stringify(observe.debug())}`);
  // the root records the accepted work completed with its own write
  const reader = readerOf(first.objective.text);
  const status = (yield* gateway.call("workflow_read", {...reader, view: "status"})) as StatusView;
  const main = status.workflows?.find((item) => item.threadId === chat);
  assert.ok(main, JSON.stringify(status));
  const occurrences = main.occurrences.filter((row) => row.kind === "step" || row.kind === "workflow");
  const written = (yield* gateway.call("workflow_write", {...reader, action: "apply", input: {
    operationId: `${reader.supervisorThreadId}:${reader.bindingGeneration}:complete-first-plan`, workflowId: main.workflowId, expectedRevision: main.revision,
    status: "completed", note: "The checkout was inspected and its status explained.", statuses: occurrences.map((row) => ({nodeId: row.nodeId, status: "completed"})),
    evidence: [{kind: "status_changed", note: "Both accepted duties are done."},
      ...occurrences.map((row) => ({kind: "status_changed", targetNodeId: row.nodeId, note: `${row.name}: done.`}))]}})) as {status?: string};
  assert.equal(written.status, "applied", JSON.stringify(written));
  assert.deepEqual([observe.mainWorkflow()?.status, observe.mainWorkflow()?.proposalId], ["completed", accepted.proposalId]);

  // the person changes the request; the root interprets it afresh and the agent accepts the revised plan
  observe.editRequest("Is this checkout current with its remote? Then clean up its stale branches, with a dry run first.");
  const second = yield* driveInterpretation(supervisor, {index: 1, objective: "Clean up the checkout's stale branches after a dry run.",
    reason: "The changed request adds a cleanup after a dry run.", steps: [steps.inspect, steps.dryRun, steps.explain]});
  observe.completeMainRun(acceptanceOf(second.proposal.proposal));
  const adopted = yield* eventuallyValue(Effect.sync(() => {
    const workflow = observe.mainWorkflow();
    return workflow && workflow.proposalId !== accepted.proposalId ? workflow : null;
  }), () => `the revised acceptance did not become the workflow: ${JSON.stringify({workflow: observe.mainWorkflow(), debug: observe.debug()})}`);
  assert.deepEqual([adopted.status, adopted.acceptedAgreements], ["planned", 2], "the accepted revision starts planned beside the earlier acceptance");
  assert.notEqual(adopted.sourceHash, accepted.sourceHash);
  assert.ok(adopted.currentAgreementKey);

  // the dashboard reads that state: the revised plan is current and unassessed, and History keeps the earlier completion
  const {page} = yield* journeyPage("revised-plan-current");
  const ui = yield* dashboard(page, supervisor.app.origin);
  const {token} = yield* forgeDashboardToken(supervisor.app.dataDirectory).pipe(Effect.orDie);
  yield* ui.signIn(token);
  const shown = Effect.gen(function* () {
    yield* ui.openTask(startupProjectId, chat);
    yield* ui.headingShown("Current accepted plan");
    yield* ui.textShown("Plan accepted · work not yet assessed");
    yield* ui.textShown("0 of 3 applicable steps assessed complete");
    yield* ui.textShown("Dry run the cleanup");
    assert.equal(yield* ui.textAbsent("changed after proposal"), true, "no false change after acceptance");
    assert.equal(yield* ui.textAbsent("Awaiting reconciliation"), true);
    for (const scheme of ["light", "dark"] as const) {
      yield* ui.colorScheme(scheme);
      for (const width of [1280, 320]) {
        const extent = yield* ui.reflow(width, 920);
        assert.ok(extent.scrollWidth <= extent.clientWidth, `the current accepted plan reflows at ${width}px in ${scheme}: ${JSON.stringify(extent)}`);
      }
    }
    yield* ui.clickButton("History");
    yield* ui.textContaining("Inspect checkout: done.");
    yield* ui.textContaining("Both accepted duties are done.");
  });
  yield* shown;
  // the same durable state through the dashboard API, read with the browser's own session
  const progress = yield* httpJson(`${supervisor.app.origin}/api/guidance/workflow-progress?${new URLSearchParams({projectId: startupProjectId, mainThreadId: chat})}`,
    {headers: {"x-supervisor-session": yield* ui.session}});
  assert.equal(progress.status, 200, JSON.stringify(progress.body));
  const workflow = (progress.body as {workflows?: ReadonlyArray<{threadId: string; status: string; acceptedProposalId: string | null}>}).workflows
    ?.find((item) => item.threadId === chat);
  assert.deepEqual([workflow?.status, workflow?.acceptedProposalId], ["planned", adopted.proposalId]);
  // the application restarts over the same data and the page reloads: the same plan and history, and no write
  yield* supervisor.restart;
  yield* ui.reload;
  yield* shown;
  assert.deepEqual(observe.mainWorkflow(), adopted, "neither the restart nor the reads changed the workflow");

  // a later genuine request needs no plan: the root interprets it as a changed authorized scope, and the accepted revised plan keeps its
  // own identity as history, with no pending update, no reconciliation duty and no message to the agent
  type SavedTask = {readonly threadId?: string; readonly sourceMessageId?: string; readonly status?: string; readonly supervision?: string; readonly workflowProposalId?: string;
    readonly agreementSourceHash?: string; readonly agreement?: {readonly proposalId?: string} | null;
    readonly conversation?: {readonly authorization?: {readonly scopeRevision?: string} | null;
      readonly considered?: {readonly messageId?: string} | null; readonly observed?: {readonly messageId?: string} | null} | null};
  const saved = Effect.gen(function* () {
    const reply = yield* httpJson(`${supervisor.app.origin}/api/guidance/project-supervisor?${new URLSearchParams({projectId: startupProjectId, mainThreadId: chat})}`,
      {headers: {"x-supervisor-session": yield* ui.session}});
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    const body = reply.body as {tasks?: ReadonlyArray<SavedTask>; chatSupervision?: {stopped?: boolean; stoppedBy?: string | null} | null};
    return {task: body.tasks?.find((item) => item.threadId === chat) ?? null, chat: body.chatSupervision ?? null};
  });
  const agentMessages = observe.mainDispatches().length;
  observe.sendRequest("Which ticket tracks this cleanup, and what is its status?", "It is tracked as OPS-42 and is in review.");
  yield* driveNoPlanInterpretation(supervisor, {index: 2, objective: "Report the status of the cleanup's ticket.", reason: "A lookup the person follows without a plan."});
  const lookup = yield* eventuallyValue(Effect.map(saved, ({task}) => task?.status === "inferred" && task.supervision === "not_needed" ? task : null),
    () => `the lookup was not interpreted: ${JSON.stringify(observe.debug())}`);
  assert.deepEqual([lookup.workflowProposalId, lookup.agreement?.proposalId, lookup.agreementSourceHash], [adopted.proposalId, adopted.proposalId, adopted.sourceHash],
    "the accepted revised plan keeps its own identity and the scope it accepted");
  assert.notEqual(lookup.conversation?.authorization?.scopeRevision, adopted.sourceHash, "the lookup is a changed authorized scope");
  assert.equal(observe.mainDispatches().length, agentMessages, "a request that needs no plan sends the agent nothing");
  const noPlanShown = (stopped: boolean) => Effect.gen(function* () {
    yield* ui.openTask(startupProjectId, chat);
    yield* ui.stateShown(stopped ? ".task-outcome.state-paused" : ".notice.earlier-scope");
    assert.deepEqual([yield* ui.stateCount("#plan-changes-title"), yield* ui.stateCount(".reconciliation-due"), yield* ui.stateCount(".notice.earlier-scope")], [0, 0, 1],
      "no pending update and no reconciliation duty; the accepted plan's workflow is named as history");
    assert.equal(yield* ui.textAbsent("Dry run the cleanup"), true, "the accepted revised plan is not shown as the current plan");
  });
  yield* noPlanShown(false);
  for (const scheme of ["light", "dark"] as const) {
    yield* ui.colorScheme(scheme);
    for (const width of [1280, 320]) {
      const extent = yield* ui.reflow(width, 920);
      assert.ok(extent.scrollWidth <= extent.clientWidth, `the no-plan follow-up reflows at ${width}px in ${scheme}: ${JSON.stringify(extent)}`);
    }
  }
  // History keeps the earlier completion's records and the accepted plan, as the workflow of an earlier request
  yield* ui.clickButton("History");
  yield* ui.textContaining("Both accepted duties are done.");
  yield* ui.openDisclosure("Sources and earlier plans");
  yield* ui.openDisclosure("Accepted for an earlier request");
  yield* ui.textContaining("Dry run the cleanup");
  assert.deepEqual(observe.mainWorkflow(), adopted, "the no-plan request changed no workflow, history or evidence");

  /* A later question is observed but receives no interpretation. The earlier lookup's no-plan decision must not describe it. */
  const questionId = observe.sendRequest("How did the original incident happen?", "I will trace the cause.");
  const unread = yield* eventuallyValue(Effect.map(saved, ({task}) => task?.sourceMessageId === questionId &&
    task.conversation?.observed?.messageId === questionId && task.conversation.considered?.messageId === lookup.sourceMessageId &&
    ["queued", "dispatching", "waiting"].includes(task.status ?? "") ? task : null),
  () => `the newer question was not observed separately from the lookup: ${JSON.stringify(observe.debug())}`);
  yield* noPlanShown(false);
  yield* ui.textContaining("A newer request is not interpreted yet.");

  // the person stops supervision of the chat in the dashboard: the Stop is the current outcome and nothing else changes, also after a
  // restart; the agent hears only of the Stop and the Supervisor is not woken
  yield* ui.openChatSupervision(startupProjectId, chat);
  yield* ui.clickStop;
  yield* ui.stoppedShown(chat);
  const stopped = yield* saved;
  assert.deepEqual([stopped.chat?.stopped, stopped.chat?.stoppedBy], [true, "ui"]);
  assert.deepEqual([stopped.task?.sourceMessageId, stopped.task?.conversation?.considered?.messageId],
    [questionId, lookup.sourceMessageId], "Stop leaves the newer question uninterpreted");
  const rootTurns = () => observe.dispatches().filter((item) => item.threadId !== chat).length;
  const turns = rootTurns();
  yield* noPlanShown(true);
  yield* ui.textContaining("A newer request was not interpreted before supervision stopped.");
  yield* supervisor.restart;
  yield* ui.reload;
  yield* noPlanShown(true);
  yield* ui.textContaining("A newer request was not interpreted before supervision stopped.");
  // the decisive task facts: the last interpreted request needs no plan, and the accepted plan keeps its identity and its scope
  const facts = (task: SavedTask | null) => [task?.status, task?.supervision, task?.workflowProposalId, task?.agreement?.proposalId, task?.agreementSourceHash,
    task?.conversation?.authorization?.scopeRevision, task?.sourceMessageId, task?.conversation?.considered?.messageId, task?.conversation?.observed?.messageId];
  const restarted = yield* saved;
  assert.equal(restarted.chat?.stopped, true, "the Stop survives the restart");
  assert.deepEqual(facts(restarted.task), facts(stopped.task), "the restart preserves the stopped task's facts");
  assert.deepEqual([restarted.task?.workflowProposalId, restarted.task?.agreementSourceHash, restarted.task?.conversation?.authorization?.scopeRevision,
    restarted.task?.sourceMessageId, restarted.task?.conversation?.considered?.messageId, restarted.task?.conversation?.observed?.messageId],
  [lookup.workflowProposalId, lookup.agreementSourceHash, lookup.conversation?.authorization?.scopeRevision,
    questionId, lookup.sourceMessageId, unread.conversation?.observed?.messageId], "the queued question changes neither the earlier acceptance nor the last interpreted scope");
  assert.deepEqual(observe.mainWorkflow(), adopted, "the accepted plan's workflow, its history and its evidence are unchanged");
  assert.equal(rootTurns(), turns, "a stopped chat wakes no Supervisor turn");
  assert.deepEqual(observe.mainDispatches().slice(agentMessages).filter((item) => !item.commandId.startsWith("supervisor-stop-notice:")), [],
    "the agent hears only of the Stop");
}).pipe(Effect.provide(NodeFileSystem.layer)), {timeout: 360_000});
