import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {it} from "@effect/vitest";
import {Schema} from "effect";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {ProjectSupervisorSnapshot, type WorkflowPlanGroupInfo} from "../src/project-supervisor-contract.js";
import {WorkflowProgressSnapshotSchema} from "../src/workflow-progress.js";
import {currentBranchPaths, liveProgress, PlanChanges, PlanJourney, planSteps, TaskAlignment, TaskOutcome} from "../ui/src/workflow-journey.js";
import {acceptedAgreement, journeyRecord, pendingProposal, planChanges, stepNotes} from "../ui/src/task-record.js";
import {fixtureJourney, journeyCases, journeyObjective, journeyTitle} from "./ui-fixture/journey.js";
import {FixtureModel, fixtureIds, isScenarioName} from "./ui-fixture/scenarios.js";

const example = (phase: typeof journeyCases[number]) => fixtureJourney(phase, fixtureIds.projectA, fixtureIds.threadA1, "fixture-supervisor-a1", 1_800_000_000_000);
const live = (phase: typeof journeyCases[number]) => {
  const {task, progress} = example(phase);
  const record = journeyRecord(task, progress.workflows[0]);
  if (record.kind !== "live") throw new Error(`${phase} has no live workflow bound to the task`);
  return {task, record, html: renderToStaticMarkup(createElement(PlanJourney, {node: record.plan, mode: "live", notes: stepNotes(task, record)}))};
};
const states = (plan: WorkflowPlanGroupInfo) => planSteps(plan).map(step => [step.nodeId, step.status] as const);

it("the complete nested plan retains parallel boundaries and every step beyond eight without completing its parent", () => {
  const {record, html} = live("nested");
  assert.ok(planSteps(record.plan).length > 8);
  assert.match(html, /aria-label="Parallel work"/);
  assert.match(html, /aria-label="Plan sequence"/);
  assert.match(html, /Deliver and close out/);
  assert.match(html, /aria-current="step"/);
  assert.match(html, /Review<span class="step-flags"><small>Workflow<\/small><\/span><\/span><span class="step-state">In progress/);
  assert.doesNotMatch(html, /first 8|percent|%/);
});

it("a proposal or accepted plan never borrows execution states", () => {
  const {task} = example("completed");
  const proposed = renderToStaticMarkup(createElement(PlanJourney, {node: task.workflow!.plan!, mode: "proposed"}));
  assert.match(proposed, /Proposed/);
  assert.doesNotMatch(proposed, />Completed<|aria-current="step"|state-completed|Supervisor assessment/);
  const accepted = renderToStaticMarkup(createElement(PlanJourney, {node: task.agreement!.workflow.plan!, mode: "agreed"}));
  assert.match(accepted, /class="step-state">Accepted</);
  assert.doesNotMatch(accepted, />Proposed<|>Completed<|state-completed|Supervisor assessment/);
});

it("journey disclosures expose separate read-only file and skill lists", () => {
  const {task} = example("working");
  const html = renderToStaticMarkup(createElement(PlanJourney, {node: task.workflow!.plan!, mode: "agreed"}));
  assert.match(html, /<strong>References<\/strong>/);
  assert.match(html, /<strong>Skills<\/strong>/);
  assert.match(html, /<code>AGENTS.md<\/code>/);
  assert.match(html, /<code>browser-testing<\/code>/);
  assert.doesNotMatch(html, /href="(?:AGENTS|e2e)/);
});

it("a step shows a Supervisor assessment only from its own status record; planned steps show plan notes", () => {
  const {html} = live("working");
  const design = html.slice(html.indexOf("Design the approach"), html.indexOf("Data and rollout plan"));
  assert.match(design, /Supervisor assessment<\/strong><p>Reconstructed example: reusing the existing packing scan planner/);
  assert.match(design, /Recorded planned → in progress/);
  const rollout = html.slice(html.indexOf("Data and rollout plan"), html.indexOf("Implement within scope"));
  assert.match(rollout, /Plan note<\/strong><p>Check whether stored data/);
  assert.doesNotMatch(rollout, /Supervisor assessment/);
});

it("a revision awaiting acceptance keeps the recorded statuses and shows both plan notes", () => {
  const attention = live("attention"), revised = live("revised");
  assert.deepEqual(states(revised.record.plan), states(attention.record.plan), "a proposal never resets or merges live statuses");
  const verify = revised.html.slice(revised.html.indexOf("Verify behavior"), revised.html.indexOf("Review<small>"));
  assert.match(verify, /class="step-state">Needs attention</);
  assert.match(verify, /Update proposed/);
  assert.match(verify, /Proposed plan note · awaiting acceptance<\/strong><p>Required: the GTIN selects without counting/);
  assert.match(verify, /Plan note<\/strong><p>Required: a GTIN scan then quantity-label scans/);
  assert.match(verify, /Supervisor assessment<\/strong><p>Reconstructed example: evidence shows GTIN → 0/);
  const changes = planChanges(acceptedAgreement(revised.task)!.workflow.plan, pendingProposal(revised.task)!.plan);
  assert.deepEqual(changes.map(change => [change.kind, change.nodeId]), [["changed", "packing-verify"]]);
  const panel = renderToStaticMarkup(createElement(PlanChanges, {changes, proposal: pendingProposal(revised.task)!}));
  assert.match(panel, /Proposed update awaiting acceptance/);
  assert.match(panel, /step statuses below are unchanged/);
  const accepted = live("reagreed");
  assert.doesNotMatch(accepted.html, /Update proposed|awaiting acceptance/);
  assert.match(accepted.html, /Plan note<\/strong><p>Required: the GTIN selects without counting/);
});

it("plan changes match occurrences by ID, so a renamed step is changed rather than removed and added", () => {
  const {task} = example("agreed");
  const before = task.agreement!.workflow.plan!;
  const renamed = {...before, nodes: before.nodes.map(node => "nodeId" in node && node.nodeId === "packing-design" ? {...node, name: "Design the scan flow"} : node)
    .filter(node => !("nodeId" in node) || node.nodeId !== "packing-rollout")};
  const added = {...renamed, nodes: [...renamed.nodes, {...(before.nodes[0] as Extract<typeof before.nodes[number], {kind: "step"}>), nodeId: "packing-extra", name: "Extra local check"}]};
  const changes = planChanges(before, added);
  assert.deepEqual(changes.map(change => [change.kind, change.nodeId]).sort(), [["added", "packing-extra"], ["changed", "packing-design"], ["removed", "packing-rollout"]]);
});

type PlanNode = WorkflowPlanGroupInfo["nodes"][number];
const mapPlan = (plan: WorkflowPlanGroupInfo, change: (node: Extract<PlanNode, {kind: "step" | "workflow"}>) => PlanNode): WorkflowPlanGroupInfo => ({...plan, nodes: plan.nodes.map(node =>
  "nodes" in node ? mapPlan(node, change) : node.kind === "branch" ? {...node, then: mapPlan(node.then, change), else: node.else ? mapPlan(node.else, change) : null}
    : node.kind === "back_to" ? node : change(node.kind === "workflow" && node.plan ? {...node, plan: mapPlan(node.plan, change)} : node))});

const accepted = () => example("agreed").task.agreement!.workflow.plan!;
const changed = (before: WorkflowPlanGroupInfo, after: WorkflowPlanGroupInfo) =>
  planChanges(before, after).map(change => change.kind === "changed" ? [change.nodeId, ...change.fields] : [change.kind, change.nodeId]);
const at = (plan: WorkflowPlanGroupInfo, key: string) => plan.nodes.findIndex(node => "nodeId" in node && node.nodeId === `packing-${key}`);

it("plan changes report a same-ID reorder and steps regrouped into parallel work", () => {
  const before = accepted(), reordered = [...before.nodes];
  reordered.splice(at(before, "evidence"), 0, ...reordered.splice(at(before, "rollout"), 1));
  assert.deepEqual(changed(before, {...before, nodes: reordered}), [["packing-rollout", "order"]], "same IDs in a new sequence order");
  const panel = renderToStaticMarkup(createElement(PlanChanges, {changes: planChanges(before, {...before, nodes: reordered}), proposal: pendingProposal(example("revised").task)!}));
  assert.match(panel, /Data and rollout plan<\/strong><span class="small muted"> · changes order/);
  assert.equal(at(before, "rollout"), at(before, "design") + 1);
  const grouped = [...before.nodes];
  grouped.splice(at(before, "design"), 2, {kind: "parallel", templatePath: null, nodes: before.nodes.slice(at(before, "design"), at(before, "design") + 2)});
  assert.deepEqual(changed(before, {...before, nodes: grouped}), [["packing-design", "grouping"], ["packing-rollout", "grouping"]], "sequence steps made parallel");
});

it("plan changes report a step moved to another parallel branch even when the flattened order is unchanged", () => {
  const step = (key: string) => before.nodes[at(before, key)]!, before = accepted();
  const plan = (...branches: string[][]): WorkflowPlanGroupInfo => ({kind: "sequence", templatePath: null, nodes: branches.map(keys => ({kind: "parallel", templatePath: null, nodes: keys.map(step)}))});
  assert.deepEqual(changed(plan(["design", "evidence", "implement"], ["recurrence"]), plan(["design", "evidence"], ["implement", "recurrence"])),
    [["packing-design", "grouping"], ["packing-evidence", "grouping"], ["packing-implement", "grouping"], ["packing-recurrence", "grouping"]]);
  assert.deepEqual(changed(plan(["design", "evidence"], ["implement", "recurrence"]), plan(["evidence", "design"], ["recurrence", "implement"])), [], "branch order inside a parallel group is not a change");
  assert.deepEqual(changed(plan(["design", "evidence"], ["implement", "recurrence"]), plan(["implement", "recurrence"], ["design", "evidence"])).map(([, field]) => field), ["order", "order"], "the parallel groups swapped places in the sequence");
});

it("plan changes report supporting references, skills and the fixed workflow flag", () => {
  const before = accepted();
  assert.deepEqual(changed(before, mapPlan(before, node => node.nodeId === "packing-scope" ? {...node, references: [...node.references ?? [], "docs/packing.md"]} : node)), [["packing-scope", "references"]]);
  assert.deepEqual(changed(before, mapPlan(before, node => node.nodeId === "packing-verify" ? {...node, skills: []} : node)), [["packing-verify", "skills"]]);
  assert.deepEqual(changed(before, mapPlan(before, node => node.kind === "workflow" ? {...node, fixed: !node.fixed} : node)), [["packing-review", "fixed"]]);
  const panel = renderToStaticMarkup(createElement(PlanChanges, {changes: [], proposal: pendingProposal(example("revised").task)!}));
  assert.match(panel, /No changes to the plan’s steps were found; inspect the proposal details/);
});

it("runtime status is not a plan change", () => {
  const before = accepted();
  assert.deepEqual(changed(before, mapPlan(before, node => ({...node, status: "completed", contributorThreadIds: [fixtureIds.threadA1]}))), []);
  const working = example("working");
  assert.deepEqual(planChanges(working.task.agreement!.workflow.plan, working.progress.workflows[0]!.plan), [], "the live statuses of the accepted plan are not changes");
});

it("the journey shows the bound live workflow, else the accepted plan, else the proposal, and never an unrelated workflow", () => {
  assert.equal(journeyRecord(example("proposal").task, undefined).kind, "proposed");
  assert.equal(journeyRecord(example("agreed").task, undefined).kind, "agreed");
  const revised = example("revised");
  assert.equal(journeyRecord(revised.task, revised.progress.workflows[0]).kind, "live");
  const retained = example("retained");
  assert.equal(journeyRecord(retained.task, retained.progress.workflows[0]).kind, "agreed", "an earlier task's workflow is history");
});

it("alignment states proposal and acceptance once, without implying an enforcement gate", () => {
  const proposal = renderToStaticMarkup(createElement(TaskAlignment, {task: example("proposal").task}));
  assert.match(proposal, /Proposed the plan/);
  assert.match(proposal, /Acceptance has not been recorded/);
  assert.doesNotMatch(proposal, /Accepted this plan/);
  const stale = renderToStaticMarkup(createElement(TaskAlignment, {task: example("stale").task}));
  assert.match(stale, /Earlier acceptance is out of date/);
  assert.doesNotMatch(stale, /Accepted this plan/);
  const agreed = renderToStaticMarkup(createElement(TaskAlignment, {task: example("agreed").task}));
  assert.match(agreed, /Accepted this plan/);
  assert.match(agreed, /fixture-packing-agent-packing-proposal-1/);
  assert.equal(agreed.split("acceptance is not execution evidence").length - 1, 1, "the acceptance message has one home");
  assert.doesNotMatch(agreed, /proposed the project’s change workflow/, "an accepted proposal is described by its acceptance");
  const revised = renderToStaticMarkup(createElement(TaskAlignment, {task: example("revised").task}));
  assert.match(revised, /Proposed an updated plan/);
  assert.match(revised, /Earlier plan accepted; update awaiting acceptance/);
  assert.equal(revised.split("sharper Verify behavior criterion").length - 1, 1);
  assert.doesNotMatch(revised, /in force|Accepted this plan/);
});

it("a stopped task cannot retain the completed outcome heading and source text stays escaped", () => {
  const {progress} = example("completed");
  const html = renderToStaticMarkup(createElement(TaskOutcome, {assessment: {...progress.workflows[0]!.assessment!, summary: "<script>untrusted</script>"}, stopped: true, fallback: "No assessment"}));
  assert.match(html, /Supervision stopped/);
  assert.doesNotMatch(html, /Task completed|<script>/);
  assert.match(html, /&lt;script&gt;/);
});

it("every journey fixture decodes through the production contracts, agrees across Home and the task, and stays in its environment", () => {
  const model = new FixtureModel(() => 1_800_000_000_000);
  for (const phase of journeyCases) {
    assert.ok(isScenarioName(`journey-${phase}`), `journey-${phase} must be exposed by the HTTP fixture`);
    model.setJourney(phase);
    const supervisor = Schema.decodeUnknownSync(ProjectSupervisorSnapshot)(model.projectSupervisor(fixtureIds.projectA, fixtureIds.threadA1));
    const progress = Schema.decodeUnknownSync(WorkflowProgressSnapshotSchema)(model.workflowProgress({projectId: fixtureIds.projectA, mainThreadId: fixtureIds.threadA1}, 1_800_000_000_000));
    const task = supervisor.tasks.find(item => item.threadId === fixtureIds.threadA1)!;
    assert.equal(task.id, "fixture-task-packing");
    assert.ok(progress.workflows.every(workflow => workflow.assessment?.taskId === (phase === "retained" ? "fixture-task-earlier" : "fixture-task-packing")));
    const row = model.dashboardOverview({}, 1_800_000_000_000).work.find(item => item.mainThreadId === fixtureIds.threadA1)!;
    assert.equal(row.title, journeyTitle);
    assert.equal(row.objective, task.objective);
    if (phase !== "request") assert.equal(row.objective, journeyObjective);
    assert.equal(model.guidanceSnapshot(1_800_000_000_000).threads.find(thread => thread.id === fixtureIds.threadA1)!.title, journeyTitle);
    model.switchEnvironment("b");
    assert.equal(model.projectSupervisor(fixtureIds.projectA, fixtureIds.threadA1).tasks.some(item => item.id === "fixture-task-packing"), false);
    model.switchEnvironment("a");
  }
});

it("a planned workflow opens to reveal active descendants without borrowing their assessment", () => {
  const {progress} = example("nested-attention");
  const root = progress.workflows[0]!.plan!;
  const branch = root.nodes.find(node => "nodeId" in node && node.nodeId === "packing-review");
  if (!branch || branch.kind !== "workflow" || !branch.plan) throw new Error("expected the Review workflow");
  for (const status of ["underway", "needs_attention"] as const) {
    const node = {...branch, status: "planned" as const, plan: {...branch.plan, nodes: branch.plan.nodes.map(child => "nodes" in child ? child : {...child, status})}};
    const shown = renderToStaticMarkup(createElement(PlanJourney, {node, mode: "live"}));
    assert.match(shown, /state-planned"><details open="" class="disclosure disclosure-entity journey-step"/);
    assert.match(shown, /Review<span class="step-flags"><small>Workflow<\/small><\/span><\/span><span class="step-state">Planned/);
    const accepted = renderToStaticMarkup(createElement(PlanJourney, {node, mode: "agreed"}));
    assert.doesNotMatch(accepted, /open=""|aria-current="step"/);
  }
});

const branchCase = (phase: "branch-proposal" | "branch-pending" | "branch-selected" | "branch-changed") => example(phase);
const branchSection = (html: string, path: "Then" | "Else") => {
  const start = html.indexOf(`aria-label="${path} path,`);
  const end = path === "Then" ? html.indexOf('aria-label="Else path,', start) : html.indexOf("Account for findings", start);
  return html.slice(start, end);
};

const branchParts = (html: string) => {
  const head = html.slice(html.indexOf('class="branch-head"'), html.indexOf('class="branch-explanation'));
  const explanation = html.slice(html.indexOf('class="branch-explanation'), html.indexOf('class="branch-paths"'));
  const split = explanation.includes("Decision details") ? explanation.indexOf("Decision details") : explanation.length;
  return {head, primary: explanation.slice(0, split), details: explanation.slice(split)};
};

it("a live branch shows its condition and labelled paths; a pending decision is current work and neither path is outstanding", () => {
  const {task, progress} = branchCase("branch-pending");
  const record = journeyRecord(task, progress.workflows[0]);
  assert.equal(record.kind, "live");
  if (record.kind !== "live") return;
  const html = renderToStaticMarkup(createElement(PlanJourney, {node: record.plan, mode: "live", notes: stepNotes(task, record), selections: record.workflow.branchSelections}));
  assert.match(html, /role="group" aria-label="Branch: if The change is contained, well understood and low risk\."/);
  assert.match(html, /<span class="branch-label">Branch<\/span> <span>If The change is contained, well understood and low risk\.<\/span>/);
  assert.match(html, /class="step-state">Decision pending</);
  assert.match(html, /aria-label="Then path, when the condition holds: awaiting decision"/);
  assert.match(html, /aria-label="Else path, when the condition does not hold: awaiting decision"/);
  assert.match(branchSection(html, "Then"), /Single independent review.*class="step-state">Awaiting decision</su);
  assert.doesNotMatch(branchSection(html, "Else"), />Planned</, "an undecided alternative is not shown as outstanding planned work");
  assert.ok(html.indexOf("Account for findings") > html.indexOf('aria-label="Else path,'), "the following step comes after the whole branch");
  assert.match(html, /How branches work/);
  const {head, primary, details} = branchParts(html);
  assert.match(head, /class="step-mark state-decision-pending"/, "a pending decision has its own marker");
  assert.doesNotMatch(head, /state-completed|state-needs_attention/);
  assert.match(branchSection(html, "Then"), /class="pill amber">Awaiting decision</);
  assert.doesNotMatch(primary, /Plan note|Reason:/, "with no selection, only the condition, the decision state and the help link are primary");
  assert.match(details, /Plan note: Review depth follows the change’s scope and risk\./);
  const progressText = liveProgress(record.plan, currentBranchPaths(record.workflow));
  assert.deepEqual(progressText.pending.map(branch => branch.nodeId), ["packing-review-depth"]);
  assert.ok(!progressText.steps.some(step => ["packing-review-single", "packing-correctness", "packing-fit"].includes(step.nodeId)), "alternatives are not counted as applicable steps");
});

it("a selected path shows the agent's reason and the other path stays visible as not selected, never completed", () => {
  const {task, progress} = branchCase("branch-selected");
  const record = journeyRecord(task, progress.workflows[0]);
  if (record.kind !== "live") throw new Error("live workflow expected");
  const html = renderToStaticMarkup(createElement(PlanJourney, {node: record.plan, mode: "live", notes: stepNotes(task, record), selections: record.workflow.branchSelections}));
  assert.match(html, /class="step-state">Then path selected</);
  const {head, primary, details} = branchParts(html);
  assert.match(head, /class="step-mark state-decision"/);
  assert.doesNotMatch(head, /state-completed/, "a selection is a decision, not a completion checkmark");
  assert.match(primary, /<p>Reason: Reconstructed example: one scan module changes[^<]*<\/p>/);
  assert.doesNotMatch(primary, /revision|<code>|t3-thread:/, "provenance stays in the decision details");
  assert.match(details, /revision 1 · .* · <a href="t3-thread:\/\/v1\/[^"]+">Open conversation<\/a> · message <code>[^<]+<\/code>/su);
  assert.match(details, /A selection records the decision, not completed work\./);
  assert.match(branchSection(html, "Then"), /class="pill blue">Selected</);
  assert.match(html, /aria-label="Then path, when the condition holds: selected"/);
  assert.match(html, /aria-label="Else path, when the condition does not hold: not selected"/);
  assert.match(branchSection(html, "Then"), /aria-current="step"/);
  assert.match(branchSection(html, "Else"), /Correctness review.*class="step-state">Not selected</su);
  assert.doesNotMatch(branchSection(html, "Else"), /Completed|aria-current/);
  const {steps, pending} = liveProgress(record.plan, currentBranchPaths(record.workflow));
  assert.deepEqual(pending, []);
  assert.ok(steps.some(step => step.nodeId === "packing-review-single") && !steps.some(step => step.nodeId === "packing-correctness"));

  const accepted = renderToStaticMarkup(createElement(PlanJourney, {node: task.agreement!.workflow.plan!, mode: "agreed"}));
  assert.match(accepted, /class="step-state">Agreed alternatives</, "the accepted plan shows its alternatives as of acceptance");
  assert.doesNotMatch(accepted, /path selected|Not selected|Decision pending|Reason:/, "a later live selection is not applied to the accepted record");
  const proposed = renderToStaticMarkup(createElement(PlanJourney, {node: branchCase("branch-proposal").task.workflow!.plan!, mode: "proposed"}));
  assert.match(proposed, /class="step-state">Proposed alternatives</);
  assert.doesNotMatch(branchParts(proposed).head + branchParts(proposed).primary, /agreed/i, "proposed alternatives are not described as agreed");
});

it("a decision changed after completion keeps the recorded status but presents completion as needing reassessment", () => {
  const {task, progress} = branchCase("branch-changed");
  const record = journeyRecord(task, progress.workflows[0]);
  if (record.kind !== "live") throw new Error("live workflow expected");
  const html = renderToStaticMarkup(createElement(PlanJourney, {node: record.plan, mode: "live", notes: stepNotes(task, record), selections: record.workflow.branchSelections}));
  assert.match(html, /class="step-state">Else path selected</);
  assert.match(branchSection(html, "Then"), /Single independent review.*class="step-state">Completed · path not selected</su, "work on the earlier path stays as history");
  const outcome = renderToStaticMarkup(createElement(TaskOutcome, {assessment: record.workflow.assessment ?? null, fallback: "No assessment", stopped: false}));
  assert.match(outcome, /<strong>Completion needs reassessment<\/strong>/);
  assert.match(outcome, /A branch decision changed after this completion was assessed/);
  assert.match(outcome, /Recorded assessment: Reconstructed example: the single review found nothing/);
  assert.doesNotMatch(outcome, /Task completed/);
});

it("plan changes name a changed branch condition and an occurrence moved between alternatives", () => {
  const before = branchCase("branch-proposal").task.workflow!.plan!;
  const mapBranch = (plan: WorkflowPlanGroupInfo, change: (node: Extract<PlanNode, {kind: "branch"}>) => PlanNode): WorkflowPlanGroupInfo => ({...plan, nodes: plan.nodes.map(node =>
    "nodes" in node ? mapBranch(node, change) : node.kind === "branch" ? change(node) : node.kind === "workflow" && node.plan ? {...node, plan: mapBranch(node.plan, change)} : node)});
  assert.deepEqual(changed(before, mapBranch(before, node => ({...node, condition: "The change touches one module."}))), [["packing-review-depth", "condition"]]);
  assert.deepEqual(changed(before, mapBranch(before, node => ({...node, else: null}))).find(change => change[0] === "packing-review-depth"), ["packing-review-depth", "paths"]);
  const moved = changed(before, mapBranch(before, node => ({...node, then: {...node.then, nodes: [...node.then.nodes, ...(node.else!.nodes[0] as WorkflowPlanGroupInfo).nodes.slice(0, 1)]},
    else: {...node.else!, nodes: [{...(node.else!.nodes[0] as WorkflowPlanGroupInfo), nodes: (node.else!.nodes[0] as WorkflowPlanGroupInfo).nodes.slice(1)}]}})));
  assert.deepEqual(moved.find(change => change[0] === "packing-correctness"), ["packing-correctness", "grouping"], "moving into the other path is a regrouping");
});

it("branch styling keeps step chips on their own step, marks a selected path in blue and bounds narrow branch indentation", () => {
  const css = readFileSync(new URL("../ui/src/style.css", import.meta.url), "utf8");
  assert.doesNotMatch(css, /\.state-(?:underway|completed|needs_attention) > \.journey-step \.step-state/, "a step's state chip does not colour nested branch or path chips");
  assert.match(css, /\.state-completed > \.journey-step > summary \.step-state \{/);
  assert.match(css, /\.branch-path\.path-selected \{ border-inline-start-color: var\(--blue\); \}/);
  const narrow = css.slice(css.indexOf("@media (max-width: 600px) {\n  .branch-head"));
  assert.match(narrow.slice(0, narrow.indexOf("\n}")), /\.journey-branch \.journey-step\.disclosure > \.disclosure-body \{ padding-inline-start: 8px; \}/);
});
