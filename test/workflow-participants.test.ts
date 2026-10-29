import assert from "node:assert/strict";
import {it} from "@effect/vitest";
import {workflowParticipants, type ParticipantCoverageOwner, type ParticipantScopeThread} from "../src/workflow-progress.js";
import type {ExternalContribution, ExternalContributionParticipant, WorkflowStateDocument, WorkflowStateEvidence} from "../src/workflow-state-contract.js";

// the participants projection is pure: it reads the plan's contributors, the applied returns, the contributions and the observation
// receipts of one document, and the verified scope rows and coverage owners the reader supplies
const step = (nodeId: string, name: string, contributorThreadIds: string[]) => ({kind: "step" as const, nodeId, definitionId: null, localId: name.toLowerCase(), templatePath: null,
  name, description: `${name} the change.`, source: null, resolution: "resolved" as const, reason: "Needed.", status: "underway" as const, contributorThreadIds});
const contribution = (contributionId: string, nodeId: string, participant: ExternalContributionParticipant | null, overrides: Partial<ExternalContribution> = {}): ExternalContribution =>
  ({contributionId, nodeId, state: "awaiting_result", revision: 1, summary: "Reported work.", references: [], externalRef: null, participant,
    sourceThreadId: "main", sourceRunId: "run", sourceMessageId: "message", recordedAt: 10, assessment: null, ...overrides});
const receipt = (id: string, contributionId: string, revision: number, attempt: number, participant: ExternalContributionParticipant | null, kind: "read" | "lifecycle" | "unsupported",
  recordedAt: number): WorkflowStateEvidence => ({id, operationId: `op-${id}`, kind: "observation", recordedAt, actorSupervisorThreadId: "supervisor", targetNodeId: null, targetNodeName: null,
  statusFrom: null, statusTo: null, sourceThreadId: "supervisor", sourceRunId: "root-run", sourceMessageId: null, sourceItemId: kind === "unsupported" ? null : `item-${id}`, agreementKey: null,
  note: "Observed.", participant: {contributionId, revision, attempt, participant: participant ?? null, receipt: {kind, toolName: kind === "unsupported" ? null : `tool-${kind}`, inputDigest: null}}});

it("participants merge attached and linked native children with declared participants, each coverage, completion and attempt a distinct fact", () => {
  const document = {
    plan: {kind: "sequence", templatePath: null, nodes: [step("step-review", "Review", ["reviewer-a", "reviewer-b"]), step("step-deliver", "Deliver", [])]},
    returns: [{returnId: "r1", backToNodeId: "back", targetNodeId: "step-review", regionNodeIds: ["step-review"], attempt: 1, state: "applied", reason: "Findings.",
      sourceThreadId: null, sourceRunId: null, sourceMessageId: null, requestedAt: 5, resolvedAt: 6, closed: null, closedSelections: null,
      retiredRuns: [{kind: "thread", threadId: "reviewer-b", reason: "Rounds cannot be told apart."}], resolution: null}],
    contributions: [
      contribution("c-t3", "step-review", {kind: "t3_conversation", threadId: "ext-thread", environmentId: "lab"}, {revision: 2, state: "result",
        assessment: {decision: "accepted", resultRevision: 2, note: "Good.", actorSupervisorThreadId: "supervisor", evidenceId: "a1", recordedAt: 30}}),
      contribution("c-ext", "step-deliver", {kind: "external", ref: "github:pr-42"}),
      contribution("c-none", "step-deliver", null),
      contribution("c-native", "step-review", {kind: "t3_conversation", threadId: "reviewer-a", environmentId: null}),
      contribution("c-unsupported", "step-deliver", {kind: "unknown"}),
      contribution("c-lifecycle", "step-deliver", {kind: "external", ref: "queue:7"}, {state: "withdrawn"}),
    ],
    evidence: [
      receipt("old", "c-t3", 1, 1, {kind: "t3_conversation", threadId: "ext-thread", environmentId: "lab"}, "read", 11),
      receipt("current", "c-t3", 2, 2, {kind: "t3_conversation", threadId: "ext-thread", environmentId: "lab"}, "read", 21),
      receipt("other-declaration", "c-t3", 2, 2, {kind: "t3_conversation", threadId: "ext-thread", environmentId: null}, "read", 22),
      receipt("stated", "c-unsupported", 1, 1, {kind: "unknown"}, "unsupported", 12),
      receipt("waited", "c-lifecycle", 1, 1, {kind: "external", ref: "queue:7"}, "lifecycle", 13),
    ],
  } as unknown as WorkflowStateDocument;
  const row = (threadId: string, lifecycle: ParticipantScopeThread["lifecycle"], projectionRead = true): ParticipantScopeThread => ({threadId, lifecycle, projectionRead, archivedAt: null, deletedAt: null});
  const scope = new Map<string, ParticipantScopeThread>([["reviewer-a", row("reviewer-a", "completed")], ["linked-only", row("linked-only", "running")]]);
  const owners = new Map<string, ParticipantCoverageOwner>([["reviewer-a", "assigned"], ["reviewer-b", "root"]]);
  const rows = workflowParticipants(document, ["linked-only", "reviewer-a"], scope, owners);
  const byId = new Map(rows.map(row => [row.id, row]));
  assert.deepEqual([...byId.keys()], ["reviewer-a", "reviewer-b", "linked-only", "contribution:c-t3", "contribution:c-ext", "contribution:c-none", "contribution:c-native", "contribution:c-unsupported", "contribution:c-lifecycle"]);

  const attached = byId.get("reviewer-a")!;
  assert.deepEqual(attached.roles, [{nodeId: "step-review", nodeName: "Review", attempt: 2, retired: false}]);
  assert.deepEqual([attached.coverage, attached.lifecycle, attached.completion, attached.owner, attached.kind, attached.settlement], ["native", "completed", "native_completed", "helper", "native_child", "not_evaluated"]);
  const replaced = byId.get("reviewer-b")!;
  assert.deepEqual(replaced.roles, [{nodeId: "step-review", nodeName: "Review", attempt: 2, retired: true}], "an applied return that retired the conversation marks the role replaced");
  assert.deepEqual([replaced.coverage, replaced.lifecycle, replaced.owner], ["unknown", "unknown", "root"], "a contributor outside the verified scope rows stays unknown");
  const linked = byId.get("linked-only")!;
  assert.deepEqual([linked.roles, linked.coverage, linked.lifecycle, linked.owner], [[], "native", "running", "unknown"], "a linked child with no attached occurrence has no role");

  const observed = byId.get("contribution:c-t3")!;
  assert.deepEqual([observed.kind, observed.handle, observed.environmentId, observed.threadId, observed.revision, observed.completion, observed.coverage, observed.lifecycle, observed.reportedState],
    ["t3_conversation", "ext-thread", "lab", "ext-thread", 2, "accepted", "supervisor_observed", "reported", "result"]);
  assert.deepEqual(observed.roles, [{nodeId: "step-review", nodeName: "Review", attempt: 2, retired: false}]);
  assert.equal(observed.currentReceipt?.evidenceId, "current", "only the receipt for the current revision, declaration and attempt is current");
  assert.deepEqual([observed.currentReceipt?.kind, observed.currentReceipt?.toolName, observed.currentReceipt?.sourceItemId], ["read", "tool-read", "item-current"]);
  assert.equal(observed.priorReceipts, 2, "the earlier revision and the other declaration stay as history");
  assert.deepEqual([byId.get("contribution:c-ext")!.coverage, byId.get("contribution:c-ext")!.completion, byId.get("contribution:c-ext")!.handle], ["reported", "none", "github:pr-42"]);
  assert.deepEqual([byId.get("contribution:c-none")!.coverage, byId.get("contribution:c-none")!.kind, byId.get("contribution:c-none")!.handle], ["unknown", "unknown", null]);
  assert.deepEqual([byId.get("contribution:c-native")!.coverage, byId.get("contribution:c-native")!.lifecycle], ["native", "completed"], "a declared conversation inside the verified scope is observed by the service");
  assert.deepEqual([byId.get("contribution:c-unsupported")!.coverage, byId.get("contribution:c-unsupported")!.currentReceipt?.kind], ["unsupported", "unsupported"]);
  assert.deepEqual([byId.get("contribution:c-lifecycle")!.coverage, byId.get("contribution:c-lifecycle")!.completion], ["lifecycle_only", "withdrawn"]);
  for (const row of rows) assert.equal(row.settlement, row.kind === "native_child" || row.kind === "t3_conversation" ? "not_evaluated" : "not_applicable", row.id);
});

it("native coverage needs the service's own read of a live local thread, and a conversation declared in another environment never joins a local row", () => {
  const document = {
    plan: {kind: "sequence", templatePath: null, nodes: [step("step-review", "Review", ["read-child", "unread-child", "archived-child", "gone-child"])]},
    returns: [],
    contributions: [
      contribution("c-local", "step-review", {kind: "t3_conversation", threadId: "read-child", environmentId: null}),
      contribution("c-foreign", "step-review", {kind: "t3_conversation", threadId: "read-child", environmentId: "lab-vm"}),
    ],
    evidence: [],
  } as unknown as WorkflowStateDocument;
  const row = (threadId: string, lifecycle: ParticipantScopeThread["lifecycle"], projectionRead: boolean, archivedAt: string | null = null, deletedAt: string | null = null): ParticipantScopeThread =>
    ({threadId, lifecycle, projectionRead, archivedAt, deletedAt});
  const scope = new Map<string, ParticipantScopeThread>([
    ["read-child", row("read-child", "completed", true)],
    ["unread-child", row("unread-child", "completed", false)],
    ["archived-child", row("archived-child", "completed", true, "2026-10-29T00:00:00Z")],
    ["gone-child", row("gone-child", "unknown", true, null, "2026-10-29T00:00:00Z")],
  ]);
  const byId = new Map(workflowParticipants(document, [], scope, new Map()).map(item => [item.id, item]));
  assert.equal(byId.get("read-child")!.coverage, "native");
  assert.deepEqual([byId.get("unread-child")!.coverage, byId.get("unread-child")!.lifecycle], ["unknown", "completed"], "lifecycle metadata without the service's read is not coverage");
  assert.equal(byId.get("archived-child")!.coverage, "unknown", "an archived thread is no live read");
  assert.equal(byId.get("gone-child")!.coverage, "unknown");
  assert.deepEqual([byId.get("contribution:c-local")!.coverage, byId.get("contribution:c-local")!.lifecycle], ["native", "completed"], "a local declaration joins the read local row");
  assert.deepEqual([byId.get("contribution:c-foreign")!.coverage, byId.get("contribution:c-foreign")!.lifecycle, byId.get("contribution:c-foreign")!.environmentId],
    ["reported", "reported", "lab-vm"], "the same thread id in another environment is another conversation and never aliases the local one");
});

it("settlement states join the rows by thread and environment: T3 conversations carry what was recorded, everything else is not applicable", () => {
  const document = {
    plan: {kind: "sequence", templatePath: null, nodes: [step("step-review", "Review", ["reviewer-a"])]},
    returns: [],
    contributions: [
      contribution("c-local", "step-review", {kind: "t3_conversation", threadId: "reviewer-a", environmentId: null}),
      contribution("c-vm", "step-review", {kind: "t3_conversation", threadId: "reviewer-a", environmentId: "lab-vm"}),
      contribution("c-ext", "step-review", {kind: "external", ref: "github:pr-42"}),
      contribution("c-none", "step-review", null),
    ],
    evidence: [],
  } as unknown as WorkflowStateDocument;
  const settlements = new Map([[":reviewer-a", {state: "settled" as const, reason: null}], ["lab-vm:reviewer-a", {state: "unresolved" as const, reason: "environment_settle_unsupported"}]]);
  const byId = new Map(workflowParticipants(document, [], new Map(), new Map(), settlements).map(item => [item.id, item]));
  assert.deepEqual([byId.get("reviewer-a")!.settlement, byId.get("contribution:c-local")!.settlement], ["settled", "settled"], "a local declaration shares the local thread's settlement");
  assert.deepEqual([byId.get("contribution:c-vm")!.settlement, byId.get("contribution:c-vm")!.settlementReason], ["unresolved", "environment_settle_unsupported"],
    "the same thread id in another environment has its own settlement");
  assert.deepEqual([byId.get("contribution:c-ext")!.settlement, byId.get("contribution:c-none")!.settlement], ["not_applicable", "not_applicable"]);
  assert.equal(workflowParticipants(document, [], new Map(), new Map()).find(item => item.id === "reviewer-a")!.settlement, "not_evaluated", "nothing recorded reads as not evaluated");
});

it("a receipt for a stale attempt is history once a return reopened the occurrence", () => {
  const document = {
    plan: {kind: "sequence", templatePath: null, nodes: [step("step-review", "Review", [])]},
    returns: [{returnId: "r1", backToNodeId: "back", targetNodeId: "step-review", regionNodeIds: ["step-review"], attempt: 1, state: "applied", reason: "Findings.",
      sourceThreadId: null, sourceRunId: null, sourceMessageId: null, requestedAt: 5, resolvedAt: 6, closed: null, closedSelections: null, retiredRuns: [], resolution: null}],
    contributions: [contribution("c", "step-review", {kind: "external", ref: "agent:1"})],
    evidence: [receipt("first-attempt", "c", 1, 1, {kind: "external", ref: "agent:1"}, "read", 4)],
  } as unknown as WorkflowStateDocument;
  const [row] = workflowParticipants(document, [], new Map(), new Map());
  assert.deepEqual([row!.roles[0]?.attempt, row!.coverage, row!.currentReceipt, row!.priorReceipts], [2, "reported", null, 1]);
});
