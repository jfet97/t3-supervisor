import assert from "node:assert/strict";
import {it} from "@effect/vitest";
import {createPlanningAttempt, defaultPlanningTimeoutMs, planningAttemptAnswer, planningDraftInstruction, planningDraftNotice, planningHoldText, planningReleaseText,
  resolvePlanningAttempt, type PlanningAttempt} from "../src/supervisor-planning.js";
import {supervisionPlanningToolDefinition} from "../src/supervisor-planning-controller.js";
import {supervisionGuideToolDefinition, supervisionTeamToolDefinition} from "../src/supervisor-team-controller.js";
import {checkinTarget, helperCheckinEnvelope, helperCheckinText, teamNotificationText} from "../src/supervisor-team-runtime.js";
import {helperInstructions} from "../src/supervisor-helper-instructions.js";
import {supervisionInterpretationSubmitToolDefinition, supervisionPlanToolDefinition, supervisionStartToolDefinition, supervisionStopToolDefinition,
  workflowReadToolDefinition, workflowWriteToolDefinition} from "../src/workflow-write-controller.js";
import type {BindingRecord} from "../src/project-supervisor-store.js";
import type {SupervisorMonitorThreadBatch} from "../src/supervisor-monitor.js";
import type {TeamNotification} from "../src/supervisor-team-store.js";
import {toolRouteReminder} from "../src/supervisor-workflow.js";
import {exchangeTable, measureExchange, recordExchangeSamples, repeatedUnits, type ExchangeRow, type ExchangeSample} from "./support/exchange-audit.js";

// the exchange audit over the pure builders: planning holds, releases and drafter texts (N8-N10), helper check-ins and team notifications
// (N13-N14), planning answers (R11) and the tool discovery schemas (R15); the fixture-rendered paths are audited in the conversation suite

const now = Date.parse("2026-10-29T10:00:00.000Z");
const attempt = (): PlanningAttempt => createPlanningAttempt({
  id: "pause-a", operationId: "request-a", projectId: "project-a", mainThreadId: "main-a", ownerThreadId: "supervisor-root:owner-a",
  bindingGeneration: 1, taskId: "task-a", taskRevision: "source-a", reason: "Reconcile the implementation plan", createdAt: now,
  timeoutMs: defaultPlanningTimeoutMs, targets: [
    {threadId: "main-a", recipientThreadId: "main-a", scope: "main implementation"},
    {threadId: "child-a", recipientThreadId: "main-a", scope: "child implementation"},
  ],
});
const binding = {threadId: "supervisor-root:owner-a", generation: 1} as BindingRecord;
const notification = {id: "notification-1", kind: "note", recipientThreadId: "helper-a", memberEpoch: 1, deliveryAttempt: 0} as unknown as TeamNotification;
const monitored = (threadId: string): SupervisorMonitorThreadBatch => ({threadId, trigger: "activity_threshold", finalizedActivityCount: 3, pendingItemCount: 3, oldestAt: now,
  priority: false, priorityKinds: [], saturated: false, untrackedCount: 0,
  items: [], previewItems: [{id: "item-1", readItemId: "turn-item:1", type: "command_execution", status: "completed", ordinal: 1, detectedAt: now, version: "v1", priority: null},
    {id: "message:m-1", readItemId: null, type: "user_message", status: "completed", ordinal: 2, detectedAt: now, version: "v1", priority: "user_instruction"}]});

export const pureExchangeSamples = (): ExchangeSample[] => {
  const original = attempt();
  const continued = resolvePlanningAttempt({...original, targets: original.targets.map(target => ({...target, state: "acknowledged" as const}))}, "continue", now + 100);
  const authority = {supervisorThreadId: "helper-a", bindingGeneration: 1, memberEpoch: 1};
  const targets = ["operative-a", "operative-a:child-1"].map(threadId => checkinTarget({targetThreadId: threadId, assignmentRootThreadId: "operative-a", assignmentEpoch: 1} as never,
    monitored(threadId), {id: threadId, title: threadId, projectId: "project-a", lineage: {parentThreadId: null, relationshipToParent: null}}));
  const checkin = helperCheckinText(authority, targets.map(target => target.threadId), [notification], "Supervisor team check-in team-review:1 completed", "team-review:1");
  const checkinRows = helperCheckinEnvelope(targets, [notification]);
  const schema = (name: string, definition: unknown): ExchangeSample => ({path: "R15", label: `schema ${name}`, text: JSON.stringify(definition)});
  return [
    ({path: "N8", label: "planning hold, main", text: planningHoldText(original, original.targets[0]!)}),
    ({path: "N8", label: "planning hold, child relay", text: planningHoldText(original, original.targets[1]!)}),
    ({path: "N9", label: "planning release, agreed or timeout", text: planningReleaseText(continued, continued.targets[0]!)}),
    ({path: "N9", label: "planning release, unagreed proposal", text: planningReleaseText(continued, continued.targets[0]!, {taskId: "task-a", proposalId: "proposal-a"}),
      retrievable: ["proposal"], read: "supervision_plan"}),
    ({path: "N10", label: "drafter task", text: planningDraftInstruction(original)}),
    ({path: "N10", label: "drafter notice", text: planningDraftNotice(original, {threadId: "writer-a", messageId: "draft-result", readItemId: "turn-item:draft"})}),
    ({path: "N13", label: "helper check-in, two targets (builder)", text: checkin, rules: [helperInstructions],
      retrievable: ["rows"], read: "workflow_read view request"}),
    ({path: "R2", label: "helper check-in frozen rows (view request envelope)", text: JSON.stringify(checkinRows)}),
    ({path: "N14", label: "team notification", text: teamNotificationText(binding, notification).text, rules: [helperInstructions],
      retrievable: ["notification"], read: "supervision_team read"}),
    ({path: "R11", label: "planning answer with drafter instruction", text: JSON.stringify(planningAttemptAnswer(original, true))}),
    ({path: "R11", label: "planning answer", text: JSON.stringify(planningAttemptAnswer(continued))}),
    schema("workflow_read", workflowReadToolDefinition), schema("workflow_write", workflowWriteToolDefinition), schema("supervision_planning", supervisionPlanningToolDefinition),
    schema("supervision_team", supervisionTeamToolDefinition), schema("supervision_guide", supervisionGuideToolDefinition), schema("supervision_plan", supervisionPlanToolDefinition),
    schema("supervision_interpretation_submit", supervisionInterpretationSubmitToolDefinition), schema("supervision_start", supervisionStartToolDefinition),
    schema("supervision_stop", supervisionStopToolDefinition),
  ];
};

it("the pure exchange paths carry identities, pins, read routes and markers, never a rule of the standing reference", () => {
  const samples = pureExchangeSamples();
  const rows: ExchangeRow[] = samples.map(measureExchange);
  recordExchangeSamples("pure-builders", samples);
  console.log(`EXCHANGE AUDIT (pure builders)\n${exchangeTable(rows)}`);
  for (const row of rows.filter(item => ["N8", "N9", "N10"].includes(item.path))) {
    assert.equal(row.ruleBytes, 0, `${row.label} repeats ${row.ruleBytes} bytes of the standing reference`);
    assert.ok(row.bytes < 1_600, `${row.label}: ${row.bytes} bytes`);
  }
  // a helper message repeats one sentence of its reference: the discovery route of its core line, which is how it finds the reader at all
  for (const sample of samples.filter(item => item.path === "N13" || item.path === "N14")) {
    const repeated = repeatedUnits(sample.text, [helperInstructions]);
    assert.ok(repeated.length > 0 && repeated.every(unit => toolRouteReminder.includes(unit)), `${sample.label}: ${JSON.stringify(repeated)}`);
  }
  // transport neutrality: no gateway product, wrapper or recipe is named on any path
  for (const row of rows) assert.doesNotMatch(row.label, /mcpx/iu);
});
