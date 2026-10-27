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

it.effect("an interpretation envelope quotes each request body once and keeps every requester relationship", () => Effect.gen(function* () {
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
  const envelope = JSON.parse(dispatched.slice(dispatched.indexOf("UNTRUSTED_WORKFLOW_ENVELOPE\n") + "UNTRUSTED_WORKFLOW_ENVELOPE\n".length,
    dispatched.indexOf("\nEND_UNTRUSTED_WORKFLOW_ENVELOPE"))) as {text: string; earlierMessages: Array<{messageId: string; text: string}>;
      planning: {taskId: string; taskRevision: string};
      conversation: {facts: {readView: string}; requesterMessages: Array<{messageId: string; requester: string; text?: string; quoted?: string}>;
        operativeMessages: Array<{messageId: string; text?: string}>}};
  assert.equal(count(dispatched, request), 1, "the request text is quoted once");
  assert.equal(count(dispatched, link), 1, "the earlier unresolved request is quoted once");
  assert.equal(envelope.text, request);
  assert.deepEqual(envelope.earlierMessages, [{messageId: sourceMessageId, text: link}]);
  assert.deepEqual(envelope.conversation.requesterMessages.map(item => [item.messageId, item.requester, item.quoted ?? null, item.text ?? null]),
    [[sourceMessageId, "human", "earlierMessages", null], ["bootstrap-message", "human", "text", null]], "each requester keeps its identity and relationship");
  assert.doesNotMatch(dispatched, /PRIOR_OPERATIVE_DETAILS/u, "prior replies are read on demand rather than copied into the wake");
  assert.deepEqual(envelope.conversation.facts, {readView: "context"});
  assert.deepEqual(envelope.conversation.operativeMessages, [{messageId: "prior-operative-reply"}]);
  assert.ok(dispatched.length < 6_500, `changed-request wake ${dispatched.length}`);
  const pending = (yield* fixture.task())!;
  assert.deepEqual(envelope.planning, {taskId: pending.id, taskRevision: taskScopeRevision(pending)}, "planning pins name the current scope, never a guessed source-body hash");
}));
