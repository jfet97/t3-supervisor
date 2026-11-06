import assert from "node:assert/strict";
import { join } from "node:path";
import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { repositoryRoot } from "../../scripts/local-run.js";
import { forgeDashboardToken } from "../../src/service-auth.js";
import { journeyPage } from "../support/browser.js";
import { httpJson } from "../support/glinint-wiring.js";
import { driveInterpretation, eventuallyValue, startupMainThreadId, startupProjectId, startupSession } from "../support/startup-gateway.js";
import { dashboard } from "./dashboard.js";

/*
  A supervised task is completed, then the person changes its request, and the agent accepts the Supervisor's revised plan
  (docs/testing.md). The dashboard shows that accepted plan as the current one, planned and not yet assessed, while the earlier
  completion stays in History, and a restart of the application changes nothing it shows. The production Supervisor runs over the
  scripted T3 peer: the root interprets each request through the workflow MCP route and records the accepted work completed with its
  own workflow write, the agent reads each proposal and copies its acceptance record into its reply, and the person edits the
  original request in T3. The page reads the durable state through the dashboard API with the browser's own session.
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

it.live("a revised plan the agent accepts after a completed task changed is the dashboard's current plan, with the earlier completion in History across a restart", () => Effect.gen(function* () {
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
}).pipe(Effect.provide(NodeFileSystem.layer)), {timeout: 240_000});
