import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import type { ProjectDefinitionSnapshot } from "../src/project-definitions-contract.js";
import { workflowReadToolDefinition } from "../src/workflow-write-controller.js";
import {taskScopeRevision} from "../src/supervision-conversation-contract.js";
import { effectiveIndex, projectIndex, testSummary } from "./project-definitions-fixture.js";
import { appendSourceMessage, definitionSnapshot, makeWorkflowFixture, sourceMessageId, sourceThreadId, submitAndComplete } from "./support/ctl-workflow.js";

// a catalog with a broad workflow, a nested workflow, an inline local step, a branch, and a required entry whose file is missing
const step = (id: string) => ({id, name: `Step ${id}`, description: `CONTRACT_${id}: ${"Preserve the authorized outcome and its evidence. ".repeat(6)}`,
  summary: testSummary(id), origin: "project" as const, path: `.t3-supervisor/steps/${id}.md`, sourceId: id});
const catalog = (): ProjectDefinitionSnapshot => {
  const base = definitionSnapshot();
  const steps = [...base.steps, step("design"), step("implement"), step("correctness"), step("finalize")];
  const workflows = [
    {id: "change", name: "Change", description: "WORKFLOW_change: change repository behavior.", summary: testSummary("change"), fixed: false,
      sequence: [{step: "design"}, {step: "implement"}, {step: {id: "local-check", name: "Inline check", description: "INLINE_local-check: an inline contract."}},
        {branch: {if: "The change is contained.", then: [{workflow: "review"}], else: [{step: "test-plan"}]}}, {step: "finalize"}],
      origin: "project" as const, path: ".t3-supervisor/workflows/change.yaml", sourceId: "change"},
    {id: "review", name: "Review", description: "WORKFLOW_review: review the frozen artifact.", summary: testSummary("review"), fixed: true,
      sequence: [{step: "correctness"}], origin: "project" as const, path: ".t3-supervisor/workflows/review.yaml", sourceId: "review"},
  ] as ProjectDefinitionSnapshot["workflows"];
  const required = [{step: "test-plan"}, {workflow: "missing-audit"}];
  const indexed = {steps: steps.map(item => item.id), workflows: workflows.map(item => item.id)};
  return {...base, steps, workflows, config: effectiveIndex({steps, workflows}, required), projectConfig: projectIndex({...indexed, required})};
};
const count = (text: string, part: string) => text.split(part).length - 1;

it.effect("definitions are served index-first: the index once, then each selected complete definition once, never repeated or pre-expanded", () => Effect.gen(function* () {
  const fixture = yield* makeWorkflowFixture(catalog());
  const supervisor = yield* fixture.makeSupervisor();
  yield* supervisor.cycle;
  const binding = (yield* fixture.binding())!;

  const index = yield* supervisor.conversation.readContextView(binding, {view: "definitions"});
  const indexText = JSON.stringify(index);
  assert.equal(index.status, "ok");
  assert.equal("config" in index, false, "the index is not sent a second time beside its rows");
  for (const id of ["test-plan", "design", "implement", "correctness", "finalize", "change", "review"])
    assert.equal(count(indexText, JSON.stringify(testSummary(id))), 1, `${id}'s summary appears once`);
  assert.doesNotMatch(indexText, /CONTRACT_|WORKFLOW_|INLINE_/u, "no complete contract is pushed with the index");
  const rows = [...(index.steps as Array<Record<string, unknown>>), ...(index.workflows as Array<Record<string, unknown>>)];
  assert.deepEqual(rows.filter(row => row.required).map(row => row.id).sort(), ["missing-audit", "test-plan"]);
  assert.equal(rows.find(row => row.id === "missing-audit")?.missing, true, "a required entry without its file keeps its row");
  assert.deepEqual(rows.find(row => row.id === "change")?.members, ["step:design", "step:implement", "local:local-check",
    "if \"The change is contained.\" then: workflow:review", "if \"The change is contained.\" else: step:test-plan", "step:finalize"],
  "a workflow row names its members, inline steps and branch paths by ID");

  const selected = yield* supervisor.conversation.readContextView(binding, {view: "definitions", definitionIds: ["change", "design"]});
  const selectedText = JSON.stringify(selected);
  assert.equal("config" in selected || "workflowTemplates" in selected, false, "neither the index nor an expanded plan is repeated");
  for (const marker of ["CONTRACT_design", "WORKFLOW_change", "INLINE_local-check", "The change is contained."])
    assert.equal(count(selectedText, marker), 1, `${marker} appears exactly once`);
  assert.match(selectedText, /"workflow":"review"/u, "a nested workflow is named by its ID for an on-demand read");
  assert.doesNotMatch(selectedText, /CONTRACT_implement|CONTRACT_correctness|WORKFLOW_review/u, "unselected contracts stay unread");

  const context = yield* supervisor.conversation.readContextView(binding, {view: "context"});
  assert.equal("config" in (context.definitions as Record<string, unknown>), false, "the context view carries the read's identity, not the index");

  assert.equal("$defs" in workflowReadToolDefinition.inputSchema, false, "the read tool advertises no plan schema it never references");
}));

it.effect("an interpretation request quotes no body, and its context keeps every requester relationship as handles", () => Effect.gen(function* () {
  const fixture = yield* makeWorkflowFixture(catalog());
  const source = fixture.projections.get(sourceThreadId)!;
  const link = "https://issues.example/browse/PROJ-1 needs the retry behavior described in the attached report.";
  source.messages[0]!.text = link;
  const supervisor = yield* fixture.makeSupervisor();
  yield* supervisor.cycle;
  yield* submitAndComplete(fixture, supervisor, (yield* fixture.task())!, {objective: null, reason: "Only an issue link was supplied.", sourceMessageIds: [],
    supervision: "needed", workflow: null});
  yield* supervisor.cycle;
  const previousReply = "PRIOR_OPERATIVE_DETAILS ".repeat(300);
  source.messages.push({...source.messages[0]!, id: "prior-operative-reply", role: "assistant", text: previousReply, creationSource: "provider"});
  const request = "Recover the failed worktree manually with Nix, then continue with the retry fix from that issue.";
  appendSourceMessage(source, "bootstrap-message", 2, request);
  yield* supervisor.cycle;
  const dispatched = String(fixture.dispatches().at(-1)?.payload.text);
  // the request quotes no body: the root reads them natively by the handles its context view names
  for (const body of [request, link, "PRIOR_OPERATIVE_DETAILS"]) assert.equal(count(dispatched, body), 0, body);
  assert.ok(dispatched.length < 1_200, `changed-request wake ${dispatched.length}`);
  const pending = (yield* fixture.task())!;
  const context = (yield* supervisor.conversation.readContextView((yield* fixture.binding())!, {view: "context"})) as unknown as {
    task: {taskId: string; taskRevision: string; sourceMessageId: string; contextMessageIds: string[];
      sources: {requestedBy: unknown; requesterMessages: Array<{messageId: string; requester: string}>; operativeMessages: Array<{messageId: string}>}}};
  assert.equal(context.task.sourceMessageId, "bootstrap-message");
  assert.deepEqual(context.task.contextMessageIds, [sourceMessageId], "the earlier unresolved request stays a handle");
  assert.deepEqual(context.task.sources.requestedBy, {kind: "human"});
  assert.deepEqual(context.task.sources.requesterMessages.map(item => [item.messageId, item.requester]),
    [[sourceMessageId, "human"], ["bootstrap-message", "human"]], "each requester keeps its identity and relationship");
  assert.deepEqual(context.task.sources.operativeMessages.map(item => item.messageId), ["prior-operative-reply"], "prior replies are read on demand");
  assert.equal(JSON.stringify(context).includes("PRIOR_OPERATIVE_DETAILS"), false);
  assert.equal(context.task.taskRevision, taskScopeRevision(pending), "planning pins name the current scope, never a guessed source-body hash");
}));

it.effect("view context is compact by default; conversation facts, the plan and diagnostics are sections read on demand", () => Effect.gen(function* () {
  const fixture = yield* makeWorkflowFixture(catalog());
  const supervisor = yield* fixture.makeSupervisor();
  yield* supervisor.cycle;
  const task = (yield* fixture.task())!;
  yield* submitAndComplete(fixture, supervisor, task, {objective: "Implement the export", reason: "A substantive change.", sourceMessageIds: [sourceMessageId],
    supervision: "needed", workflow: {requirements: [{kind: "step", id: "test-plan", applies: true, reason: "The change needs a behavior check."},
      {kind: "workflow", id: "missing-audit", applies: "unknown", reason: "The audit definition is missing."}],
    plan: {kind: "sequence", nodes: [{kind: "step", definitionId: "test-plan", reason: "Verify the export."}]}}});
  yield* supervisor.cycle;
  const binding = (yield* fixture.binding())!;
  const context = yield* supervisor.conversation.readContextView(binding, {view: "context"});
  for (const key of ["requirements", "outline"]) assert.equal(key in context, false, key);
  assert.equal("conversation" in (context.task as Record<string, unknown>), false);
  assert.deepEqual(context.sections, ["conversation", "plan", "diagnostics"]);
  assert.equal(typeof (context.definitions as {issues: unknown}).issues, "number", "issues are counted, read with section diagnostics");
  const plan = yield* supervisor.conversation.readContextView(binding, {view: "context", section: "plan"});
  assert.ok(Array.isArray(plan.requirements) && (plan.requirements as unknown[]).length > 0);
  assert.match(String(plan.outline), /test-plan/u);
  const conversation = yield* supervisor.conversation.readContextView(binding, {view: "context", section: "conversation"});
  assert.ok("conversation" in conversation);
  const diagnostics = yield* supervisor.conversation.readContextView(binding, {view: "context", section: "diagnostics"});
  assert.ok(Array.isArray((diagnostics.definitions as {issues: unknown[]}).issues));
  assert.equal((yield* supervisor.conversation.readContextView(binding, {view: "context", section: "other"})).status, "invalid");
}));
