import assert from "node:assert/strict";
import {it} from "@effect/vitest";
import {redact} from "../src/credential-redaction.js";
import {messageReadRule} from "../src/message-read-handle.js";
import {returnBudgetMaximum} from "../src/project-definitions-contract.js";
import type {BindingRecord} from "../src/project-supervisor-store.js";
import {helperCore, helperInstructions, helperInstructionsVersion} from "../src/supervisor-helper-instructions.js";
import {activeWatchInstructions, helperWatchInstructions, ownInboxInstructions, type SupervisorMonitorThreadBatch} from "../src/supervisor-monitor.js";
import {createPlanningAttempt, defaultPlanningTimeoutMs, planningDraftInstruction, planningDraftNotice, planningDraftRead, planningHoldText, planningInstructions,
  planningReleaseText, resolvePlanningAttempt} from "../src/supervisor-planning.js";
import {supervisionPlanningToolDefinition} from "../src/supervisor-planning-controller.js";
import {supervisionGuideToolDefinition, supervisionTeamToolDefinition} from "../src/supervisor-team-controller.js";
import {checkinTarget, helperCheckinText, teamNotificationText} from "../src/supervisor-team-runtime.js";
import type {TeamNotification, TeamNotificationKind, TeamRequestTarget} from "../src/supervisor-team-store.js";
import {interpretationLimits, interpretationPlanRules, interpretationRules, localThreadToolRules, planAuthoringRules, prepareWorkflowRequest, proportionatePlanRule,
  stepEntryGuidance, toolRouteReminder} from "../src/supervisor-workflow.js";
import {supervisionInterpretationSubmitToolDefinition, supervisionPlanToolDefinition, supervisionStartToolDefinition, supervisionStopToolDefinition,
  workflowReadToolDefinition, workflowWriteToolDefinition} from "../src/workflow-write-controller.js";
import {defaultWorkflowGatewayTools, defaultWorkflowServerAliases, workflowToolNames} from "../src/workflow-write-evidence.js";
import {goldenSnapshot} from "./support/c1-workflow-fixture.js";
import {repeatedUnits} from "./support/exchange-audit.js";

/*
 * Prompt contracts check tools, actions, fields, sections, shared fragments, registries and limits.
 * Agent compliance belongs to controller and replay suites or provider trials.
 */

type ToolDefinition = {readonly name: string; readonly inputSchema: unknown};
const tools: readonly ToolDefinition[] = [workflowReadToolDefinition, workflowWriteToolDefinition, supervisionStartToolDefinition, supervisionStopToolDefinition,
  supervisionPlanToolDefinition, supervisionInterpretationSubmitToolDefinition, supervisionTeamToolDefinition, supervisionGuideToolDefinition, supervisionPlanningToolDefinition];
const toolNames = new Set(tools.map(tool => tool.name));
const word = (identifier: string): RegExp => new RegExp(`\\b${identifier}\\b`, "u");
const count = (text: string, part: string): number => text.split(part).length - 1;
const field = (value: object, key: string): unknown => (value as Record<string, unknown>)[key];

// every property name and enumerated or constant value an input schema advertises, at any depth
const advertised = (tool: ToolDefinition): ReadonlySet<string> => {
  const names = new Set<string>();
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {node.forEach(visit);return;}
    if (typeof node !== "object" || node === null) return;
    const {properties, enum: values, const: constant} = node as {properties?: unknown; enum?: unknown; const?: unknown};
    if (typeof properties === "object" && properties !== null) for (const name of Object.keys(properties)) names.add(name);
    if (Array.isArray(values)) for (const value of values) if (typeof value === "string") names.add(value);
    if (typeof constant === "string") names.add(constant);
    Object.values(node).forEach(visit);
  };
  visit(tool.inputSchema);
  return names;
};
// an argument object a text tells an agent to pass verbatim: each key is a top-level input of the tool and each required input is present
const assertArguments = (tool: ToolDefinition, args: Readonly<Record<string, unknown>>): void => {
  const schema = tool.inputSchema as {properties: Record<string, unknown>; required?: readonly string[]};
  assert.deepEqual(Object.keys(args).filter(key => !Object.hasOwn(schema.properties, key)), [], `${tool.name} advertises every key`);
  for (const key of schema.required ?? []) assert.ok(Object.hasOwn(args, key), `${tool.name} requires ${key}`);
};

// the rendered texts: helper messages, root and interpretation requests, planning notices and the drafter's task
const now = Date.parse("2026-10-29T10:00:00.000Z");
const attempt = createPlanningAttempt({id: "pause-a", operationId: "request-a", projectId: "project-a", mainThreadId: "main-a", ownerThreadId: "supervisor-root:owner-a",
  bindingGeneration: 1, taskId: "task-a", taskRevision: "source-a", reason: "Reconcile the implementation plan", createdAt: now, timeoutMs: defaultPlanningTimeoutMs,
  targets: [{threadId: "main-a", recipientThreadId: "main-a", scope: "main implementation"}, {threadId: "child-a", recipientThreadId: "main-a", scope: "child implementation"}]});
const continued = resolvePlanningAttempt({...attempt, targets: attempt.targets.map(target => ({...target, state: "acknowledged" as const}))}, "continue", now + 100);
const pendingProposal = {taskId: "task-a", proposalId: "proposal-a"};
const proposalRead = {callerThreadId: "main-a", ...pendingProposal};
const release = planningReleaseText(continued, continued.targets[0]!, pendingProposal);
const drafter = planningDraftInstruction(attempt);
const draftNotice = planningDraftNotice(attempt, {threadId: "writer-a", messageId: "draft-result", readItemId: "turn-item:draft"});
const authority = {supervisorThreadId: "helper-a", bindingGeneration: 1, memberEpoch: 1};
const rowsRead = {...authority, view: "request", requestId: "team-review:1"};
const notice = {id: "notification-1", kind: "handover_review", recipientThreadId: "helper-a", memberEpoch: 1, deliveryAttempt: 0} as unknown as TeamNotification;
const checkin = helperCheckinText(authority, ["operative-a"], [notice], "Supervisor team check-in team-review:1 completed", rowsRead.requestId);
const notification = teamNotificationText({threadId: "supervisor-root:owner-a", generation: 1} as BindingRecord, notice).text;
const reader = {supervisorThreadId: "supervisor-a", bindingGeneration: 3};
const submission = (startVerdict: boolean) => ({...reader, taskId: "task-a", attemptId: "interpretation-attempt:00000000-0000-4000-8000-000000000001",
  sourcePin: {messageId: "message-a", runId: "run-a", ordinal: 1, hash: "a".repeat(64)}, startVerdict});
const requests = [{reader, submission: submission(false)}, {reader, submission: submission(true)}, {submission: submission(false)}, {reader}]
  .map(options => prepareWorkflowRequest("thread-a", "message-a", "Change the export format.", goldenSnapshot, options).requestText);

const helperTexts = {helperInstructions, helperCore, checkin, notification};
const texts: Record<string, string> = {...helperTexts, activeWatchInstructions, interpretationRules, interpretationPlanRules, stepEntryGuidance, request: requests[0]!,
  hold: planningHoldText(attempt, attempt.targets[0]!), relayedHold: planningHoldText(attempt, attempt.targets[1]!), release, drafter, draftNotice};
// stage two by composition: the root's planning pause, then the authoring rules a drafter also reads
const pauseRules = interpretationPlanRules.slice(0, interpretationPlanRules.length - planAuthoringRules.length);

// what each text tells an agent to pass to one Supervisor tool: the fields, actions and views it names
const instructed: ReadonlyArray<readonly [string, string, ToolDefinition, readonly string[]]> = [
  ["helper reference", helperInstructions, workflowReadToolDefinition, ["supervisorThreadId", "bindingGeneration", "memberEpoch", "assignmentRootThreadId", "assignmentEpoch",
    "requestId", "lineageOffset", "limit", "status", "documents", "request"]],
  ["helper reference", helperInstructions, workflowWriteToolDefinition, ["action", "input", "operationId", "childThreadId", "note", "statuses", "status_changed",
    "sourceThreadId", "sourceItemId", "sourceMessageId", "sourceRunId", "link_child", "apply"]],
  ["helper reference", helperInstructions, supervisionGuideToolDefinition, ["operationId", "targetThreadId", "text"]],
  ["helper reference", helperInstructions, supervisionTeamToolDefinition, ["action", "operationId", "targetThreadId", "summary", "reportKind", "report", "read", "ready"]],
  ["helper reference", helperInstructions, supervisionPlanningToolDefinition, ["operationId", "reason", "targetThreadIds", "draftThreadId", "draftTaskId", "workflowId",
    "workflowThreadId", "expectedRevision", "returnId", "attemptId", "pause", "attach_draft", "apply_return", "continue", "no_plan"]],
  ["helper core", helperCore, workflowReadToolDefinition, ["instructions"]],
  ["root watch", activeWatchInstructions, workflowReadToolDefinition, ["lineageOffset", "limit", "status"]],
  ["interpretation stage one", interpretationRules, workflowReadToolDefinition, ["definitionIds", "section", "context", "definitions", "interpretation"]],
  ["interpretation stage one", interpretationRules, supervisionStopToolDefinition, ["operationId"]],
  ["interpretation stage one", interpretationRules, supervisionInterpretationSubmitToolDefinition, ["objective", "reason", "sourceMessageIds", "supervision", "workflow",
    "conversation", "startRequested", "needed", "not_needed"]],
  ["stage two planning pause", pauseRules, supervisionPlanningToolDefinition, ["supervisorThreadId", "bindingGeneration", "taskId", "taskRevision", "pause", "read", "release"]],
  ["interpretation stage two", interpretationPlanRules, supervisionInterpretationSubmitToolDefinition, ["requirements", "kind", "id", "applies", "reason", "plan", "nodes",
    "definitionId", "localId", "name", "description", "references", "skills", "omit", "member", "condition", "then", "else", "target", "maximum", "step", "workflow",
    "sequence", "parallel", "branch", "back_to", "unknown"]],
  ["interpretation request", requests[0]!, workflowReadToolDefinition, ["supervisorThreadId", "bindingGeneration", "context", "interpretation"]],
  ["drafter task", drafter, supervisionPlanningToolDefinition, ["draft_read", "attemptId", "view", "section", "definitionIds", "context", "conversation", "plan", "definitions", "plan_rules"]],
  ["draft notice", draftNotice, supervisionPlanningToolDefinition, ["read"]],
  ["planning release", release, supervisionPlanToolDefinition, ["callerThreadId", "taskId", "proposalId"]],
];

it("every Supervisor tool a text names is served and routed, and every field, action and view it tells an agent to use is advertised by that tool", () => {
  const routed = Object.values(workflowToolNames).flatMap((entry): readonly string[] => "mcpxTarget" in entry ? [entry.mcpxTarget] : []);
  for (const [label, text] of Object.entries(texts))
    for (const [name] of text.matchAll(/\b(?:workflow|supervision)_[a-z_]+\b/gu)) {
      assert.ok(toolNames.has(name), `${label} names ${name}, which no tool definition serves`);
      assert.ok(routed.some(target => target.endsWith(`__${name}`)), `${label} names ${name}, which no native route recognizes`);
    }
  for (const [label, text, tool, identifiers] of instructed) {
    const known = advertised(tool);
    for (const identifier of identifiers) {
      assert.match(text, word(identifier), `${label} names ${identifier}`);
      assert.ok(known.has(identifier), `${label}: ${tool.name} advertises ${identifier}`);
    }
  }
  // the helper reference's argument rule: workflow_read takes a target's pins alone and link_child names its child, so neither takes targetThreadId
  for (const tool of [workflowReadToolDefinition, workflowWriteToolDefinition]) assert.equal(advertised(tool).has("targetThreadId"), false, tool.name);
  // the interpretation submission is named through view context, whose submission carries the tool, its arguments and the Start verdict
  for (const identifier of ["submission.tool", "submission.arguments", "submission.startVerdict"]) assert.ok(interpretationRules.includes(identifier), identifier);
  // the arguments a text spells out verbatim are complete and advertised
  for (const request of requests) {
    const pins = JSON.parse(request.slice(request.lastIndexOf("\n{") + 1)) as {reader: Record<string, unknown>};
    assert.deepEqual(pins.reader, reader);
    assertArguments(workflowReadToolDefinition, {...pins.reader, view: "context"});
  }
  assert.ok(checkin.includes(`workflow_read ${JSON.stringify(rowsRead)}`));
  assertArguments(workflowReadToolDefinition, rowsRead);
  assertArguments(supervisionPlanningToolDefinition, planningDraftRead(attempt, "context"));
  assert.ok(release.includes(`supervision_plan ${JSON.stringify(proposalRead)}`));
  assertArguments(supervisionPlanToolDefinition, proposalRead);
});

it("shared fragments are composed verbatim and once: the helper reference, the helper watch, both interpretation stages and the helper core", () => {
  for (const part of [localThreadToolRules, toolRouteReminder, messageReadRule, helperWatchInstructions, planningInstructions])
    assert.equal(count(helperInstructions, part), 1, part.slice(0, 40));
  assert.equal(count(helperWatchInstructions, ownInboxInstructions), 1, "a helper carries its inbox rules inline");
  assert.equal(count(interpretationRules, messageReadRule), 1);
  assert.ok(interpretationPlanRules.endsWith(planAuthoringRules), "stage two closes with the authoring rules a drafter reads");
  assert.equal(count(planAuthoringRules, proportionatePlanRule), 1);
  assert.ok(helperCore.includes(toolRouteReminder) && helperCore.indexOf(toolRouteReminder) < helperCore.indexOf("workflow_read"),
    "a helper can discover the reader before reading its rules");
  assert.match(helperInstructionsVersion, /^[0-9a-f]{16}$/u);
  assert.ok(helperCore.includes(helperInstructionsVersion), "the helper core names the current version of the reference");
});

it("actor and stage boundaries: helper texts carry nothing root-only, the root watch nothing helper-only, stage one no plan stage", () => {
  // root-only content (its watch, interpretation stages and plan grammar) and the root's and operative's own tools and actions
  const outsideHelper = ["record_review", "assess_contribution", "review_handover", supervisionStopToolDefinition.name, supervisionStartToolDefinition.name,
    supervisionInterpretationSubmitToolDefinition.name, supervisionPlanToolDefinition.name];
  for (const identifier of outsideHelper) assert.ok(toolNames.has(identifier) || tools.some(tool => advertised(tool).has(identifier)), identifier);
  for (const [label, text] of Object.entries(helperTexts)) {
    for (const fragment of [activeWatchInstructions, interpretationRules, interpretationPlanRules, planAuthoringRules]) assert.equal(text.includes(fragment), false, label);
    for (const identifier of outsideHelper) assert.doesNotMatch(text, word(identifier), `${label} names ${identifier}`);
  }
  // the root reads its inbox rules in its contact section and escalates to nobody
  assert.equal(activeWatchInstructions.includes(helperWatchInstructions), false);
  assert.equal(activeWatchInstructions.includes(ownInboxInstructions), false);
  assert.doesNotMatch(activeWatchInstructions, word(supervisionTeamToolDefinition.name));
  // a queued entry is read in place, never promoted
  assert.doesNotMatch(ownInboxInstructions, word("promote_to_steer"));
  /* Stage two names the planning tool ahead of the authoring rules, which a drafter reads without the root's pause coordination.
   * Stage one points to the pause and repeats no rule of stage two, which is read when a plan is needed. */
  assert.match(pauseRules, word(supervisionPlanningToolDefinition.name));
  assert.doesNotMatch(planAuthoringRules, word(supervisionPlanningToolDefinition.name));
  assert.deepEqual(repeatedUnits(interpretationRules, [interpretationPlanRules]), []);
});

// a kind added to the team's notifications fails to compile until it is listed here and so checked against the helper reference
const notificationKinds = ["handover_receive", "handover_release", "handover_review", "note"] as const satisfies readonly TeamNotificationKind[];
const everyNotificationKind: [Exclude<TeamNotificationKind, (typeof notificationKinds)[number]>] extends [never] ? true : false = true;

it("source handles: requests carry reads and pins by reference, and the helper reference explains every notification kind and check-in row field", () => {
  // the pins are read from view context, never pushed: no request carries a source pin, a task revision or either stage's rules
  for (const request of requests) {
    for (const pushed of ["sourcePin", "taskRevision", "a".repeat(64)]) assert.equal(request.includes(pushed), false, `${pushed}: ${request}`);
    assert.deepEqual(repeatedUnits(request, [interpretationRules, interpretationPlanRules]), [], request);
  }
  // a notification carries its kind; its meaning is in the reference
  assert.equal(everyNotificationKind, true);
  for (const kind of notificationKinds) assert.match(helperInstructions, word(kind), kind);
  // a check-in's frozen rows, as production builds them for an unavailable and an archived target: every field, reference and reason code
  const monitored: SupervisorMonitorThreadBatch = {threadId: "operative-a", trigger: "priority", finalizedActivityCount: 2, pendingItemCount: 2, oldestAt: now,
    priority: true, priorityKinds: ["user_instruction"], saturated: false, untrackedCount: 1, items: [], previewItems: [
      {id: "item-1", readItemId: "turn-item:1", type: "command_execution", status: "completed", ordinal: 1, detectedAt: now, version: "v1", priority: null},
      {id: "message:m-1", readItemId: null, type: "user_message", status: "completed", ordinal: 2, detectedAt: now, version: "v1", priority: "user_instruction"}]};
  const target: TeamRequestTarget = {targetThreadId: "operative-a", assignmentRootThreadId: "operative-a", assignmentEpoch: 1};
  const thread = {id: "operative-a", title: "operative-a", projectId: "project-a", lineage: {parentThreadId: null, relationshipToParent: null}, archivedAt: new Date(now).toISOString()};
  const rows = [checkinTarget(target, monitored, undefined), checkinTarget(target, monitored, thread)];
  assert.deepEqual(rows.map(row => field(row, "reason")), ["target_thread_unavailable", "target_archived_or_deleted"]);
  const evidence = advertised(workflowWriteToolDefinition);
  for (const row of rows) {
    for (const [key, value] of Object.entries(row)) assert.match(helperInstructions, word(key === "reason" ? String(value) : key), key);
    const refs = field(row, "refs");
    assert.ok(Array.isArray(refs) && refs.length === 2);
    for (const key of refs.flatMap(ref => Object.keys(ref as object))) {
      assert.match(helperInstructions, word(key), key);
      assert.ok(evidence.has(key), `${key} is workflow_write evidence`);
    }
  }
});

it("the plan grammar states the submission budgets production enforces", () => {
  assert.match(planAuthoringRules, word(String(interpretationLimits.maxWorkflowInterpretationReplyLength)), "the arguments' length bound");
  assert.match(planAuthoringRules, word(String(returnBudgetMaximum)), "a return's largest maximum");
});

it("no text names a gateway product, server alias, native route or code recipe, or carries a credential", () => {
  const routes = Object.values(workflowToolNames).flatMap((entry): readonly string[] => "mcpxTarget" in entry ? [...entry.direct, entry.mcpxTarget] : [...entry]);
  for (const [label, text] of Object.entries(texts)) {
    for (const name of [...defaultWorkflowServerAliases, ...defaultWorkflowGatewayTools, ...routes]) assert.equal(text.includes(name), false, `${label} names ${name}`);
    assert.doesNotMatch(text, /mcpx|omegent|search_tools|get_tool_schema|call_tool|code-mode|functions\.exec/iu, label);
    assert.equal(redact(text), text, `${label} carries a credential-shaped value`);
  }
});
