import assert from "node:assert/strict";
import { it } from "vitest";
import { nativeUserMessageVisible } from "../src/domain.js";
import { fingerprint } from "../src/guidance-store.js";
import type { ProjectDefinitionSnapshot } from "../src/project-definitions-contract.js";
import { buildProjectDefinitionReviewRequest, definitionChangedProcedure, definitionReassessProcedure, extractApprovedProjectDefinitions, extractProjectDefinitionDecisionRecords, parseProjectDefinitionDecisionRecord } from "../src/supervisor-definition-review.js";
import type { TaskRecord } from "../src/project-supervisor-store.js";
import type { Projection } from "../src/types.js";
import { prepareWorkflowRequest, validateWorkflowPlan } from "../src/supervisor-workflow.js";
import { effectiveIndex, indexSource, projectIndex, stepSource, testSummary } from "./project-definitions-fixture.js";

const projectId = "project-a";
const operativeThreadId = "operative-thread";
const supervisorThreadId = "supervisor-thread";
const sourceText = "Add a carefully bounded feature.";
const userText = "Please update the project's required checks for this feature.";
const root = "/workspace/project";
const oldRevision = "a".repeat(64);
const newRevision = "b".repeat(64);
const definitions = (overrides: Partial<ProjectDefinitionSnapshot> = {}): ProjectDefinitionSnapshot => {
  const steps: ProjectDefinitionSnapshot["steps"] = overrides.steps ??
    [{id: "verify", name: "Verification", description: "Verify the change.", summary: testSummary("verify"), origin: "project", path: ".t3-supervisor/steps/verify.md", sourceId: "verify"}];
  const workflows: ProjectDefinitionSnapshot["workflows"] = overrides.workflows ?? [];
  const index = {steps: steps.map(step => step.id), workflows: workflows.map(workflow => workflow.id), required: [{step: "verify"}]};
  return {
    projectId,
    threadId: operativeThreadId,
    workspaceRoot: root,
    revision: oldRevision,
    globalOnly: false,
    globalRevision: null,
    editingAvailable: true,
    status: "ready",
    steps,
    workflows,
    config: effectiveIndex({steps, workflows}, index.required),
    projectConfig: projectIndex(index),
    definitionFiles: [],
    complete: true,
    sources: [
      {path: ".t3-supervisor/project.yaml", content: indexSource({steps: ["verify"], required: [{step: "verify"}]}), origin: "project"},
      {path: ".t3-supervisor/steps/verify.md", content: stepSource("verify", "Verify the change."), origin: "project"},
    ],
    issues: [],
    ...overrides,
  };
};

const task = (overrides: Partial<TaskRecord> = {}): TaskRecord => {
  const approved = definitions();
  const prepared = prepareWorkflowRequest(operativeThreadId, "source-0", sourceText, approved);
  assert.ok(prepared.context);
  const plan = validateWorkflowPlan({requirements: [{kind: "step", id: "verify", applies: true, reason: "The task changes behavior."}],
    plan: {kind: "sequence", nodes: [{kind: "step", definitionId: "verify", reason: "Check the change."}]}}, prepared.context);
  assert.ok(plan);
  return {
    threadId: operativeThreadId,
    projectId,
    sourceRunId: "operative-run-1",
    sourceMessageId: "source-0",
    status: "inferred",
    objective: "Add a carefully bounded feature.",
    reason: "The user requested a concrete feature.",
    updatedAt: 100,
    workflow: {status: "proposed", message: "Draft.", workspaceRoot: root, revision: oldRevision, globalRevision: null, ...plan},
    id: "task-1",
    sourceHash: fingerprint(sourceText),
    requestText: prepared.requestText,
    supervisorThreadId,
    messageId: "supervisor-request-1",
    dispatchedAt: 100,
    replayCount: 0,
    supervisorRunId: "supervisor-run-1",
    sourceOrdinal: 1,
    definitionContext: prepared.context,
    definitionSnapshot: approved,
    ...overrides,
  };
};

type UserFixture = {id: string; text: string; runStatus?: string; rootKind?: string; rootStatus?: string; nodeId?: string; historicalRoot?: boolean; streaming?: boolean;
  createdBy?: string; creationSource?: string; senderThreadId?: string | null; scheduledTaskId?: string | null; source?: string | null};

const agentProjection = (users: UserFixture[] = [{id: "user-1", text: userText}], sourceRunStatus = "completed", sourceRestarted = false): Projection => {
  const messages = [{id: "source-0", runId: "operative-run-1", nodeId: "root-operative-run-1", role: "user", text: sourceText, streaming: false,
    createdAt: "2026-10-13T10:00:00.000Z", updatedAt: "2026-10-13T10:00:00.000Z", createdBy: "user", creationSource: "web", threadId: operativeThreadId},
  ...users.map((user, index) => ({id: user.id, runId: `operative-run-${index + 2}`, nodeId: user.nodeId ?? `root-operative-run-${index + 2}`, role: "user", text: user.text,
    streaming: user.streaming ?? false, createdAt: `2026-10-13T10:${String(index + 1).padStart(2, "0")}:00.000Z`, updatedAt: "2026-10-13T10:30:00.000Z",
    createdBy: user.createdBy ?? "user", creationSource: user.creationSource ?? "web", senderThreadId: user.senderThreadId,
    scheduledTaskId: user.scheduledTaskId, source: user.source, threadId: operativeThreadId}))];
  const runs = [
    {id: "operative-run-1", threadId: operativeThreadId, ordinal: 1, status: sourceRunStatus, userMessageId: sourceRestarted ? "source-restart-message" : "source-0", requestedAt: "2026-10-13T10:00:00.000Z",
      startedAt: "2026-10-13T10:00:00.000Z", completedAt: sourceRunStatus === "completed" ? "2026-10-13T10:00:30.000Z" : null,
      rootNodeId: sourceRestarted ? "restart-root-operative-run-1" : "root-operative-run-1", providerThreadId: "provider"},
    ...users.map((user, index) => ({id: `operative-run-${index + 2}`, threadId: operativeThreadId, ordinal: index + 2,
      status: user.runStatus ?? "running", userMessageId: user.historicalRoot ? `${user.id}-restart` : user.id,
      requestedAt: "2026-10-13T10:01:00.000Z", startedAt: "2026-10-13T10:01:00.000Z",
      completedAt: null, rootNodeId: user.historicalRoot ? `restart-root-operative-run-${index + 2}` : `root-operative-run-${index + 2}`, providerThreadId: "provider"})),
  ];
  const nodes = runs.map((run, index) => ({id: run.rootNodeId!, kind: index === 0 ? "root_turn" : users[index - 1]!.rootKind ?? "root_turn",
    threadId: operativeThreadId, runId: run.id, rootNodeId: run.rootNodeId, providerThreadId: "provider",
    status: index === 0 ? sourceRunStatus : users[index - 1]!.runStatus ?? "running", parentNodeId: null}));
  for (const [index, user] of users.entries()) {
    if (user.historicalRoot) nodes.push({id: `root-operative-run-${index + 2}`, kind: "root_turn", threadId: operativeThreadId,
      runId: `operative-run-${index + 2}`, rootNodeId: `root-operative-run-${index + 2}`, providerThreadId: "provider",
      status: user.rootStatus ?? "interrupted", parentNodeId: null});
  }
  if (sourceRestarted) nodes.push({id: "root-operative-run-1", kind: "root_turn", threadId: operativeThreadId, runId: "operative-run-1",
    rootNodeId: "root-operative-run-1", providerThreadId: "provider", status: "interrupted", parentNodeId: null});
  // T3 publishes each message as its own turn item, which is the exact read handle; a message ID is never one
  const turnItems = messages.filter(message => !unpublishedMessageIds.has(message.id)).map(message => ({id: `turn-item:message:${encodeURIComponent(message.id)}`,
    type: "user_message", messageId: message.id, threadId: operativeThreadId, runId: message.runId}));
  return {thread: {id: operativeThreadId, title: "Task", projectId, workspaceRoot: root,
    lineage: {parentThreadId: null, relationshipToParent: null}}, runs, messages, nodes, turnItems};
};
// messages a test keeps unpublished as read items
const unpublishedMessageIds = new Set<string>();

const decisionRecord = (overrides: Record<string, unknown> = {}) => ({taskId: "task-1", expectedRevision: oldRevision, observedRevision: newRevision,
  decision: "authorized", userMessageIds: ["user-1"], reason: "The user explicitly requested these checks.", ...overrides});

// the review's handles: revisions, changed entries, message IDs and the exact record templates; bodies are read on demand
// the review's data is the request's frozen envelope, read with view request; the text carries the revisions, the reads and the marker
const parseEnvelope = (built: {envelope: Record<string, unknown> | null}): Record<string, unknown> => {
  assert.ok(built.envelope, "a built review carries its envelope");
  return built.envelope;
};

it("approved definitions require the stored complete snapshot and do not use a legacy fallback", () => {
  const current = task();
  assert.deepEqual(extractApprovedProjectDefinitions(current), definitions());

  const fallback = task({definitionSnapshot: null});
  assert.equal(extractApprovedProjectDefinitions(fallback), null);

  assert.equal(extractApprovedProjectDefinitions(task({definitionSnapshot: null, requestText: "partial prompt"})), null);
  assert.equal(extractApprovedProjectDefinitions(task({definitionSnapshot: null, workflow: {...current.workflow!, revision: newRevision}})), null);
});

it("approved snapshots retain reusable, workflow and inline file references and reject malformed lists", () => {
  const approved = definitions({steps: definitions().steps.map(step => ({...step, references: ["docs/verify.md"], skills: ["plugin:review"]})),
    workflows: [{id: "delivery", name: "Delivery", description: "Deliver the change.", summary: testSummary("delivery"), fixed: false, references: ["docs/delivery.md"], skills: ["SKILL.md"],
      sequence: [{step: {id: "local", name: "Local", description: "Check local behavior.", references: ["src/local.ts"], skills: [".claude/skills/testing/SKILL.md"]}}]}]});
  assert.deepEqual(extractApprovedProjectDefinitions(task({definitionSnapshot: approved})), approved);
  const malformed = structuredClone(approved);
  Object.assign(malformed.steps[0]!, {references: ["/absolute/path.md"]});
  assert.equal(extractApprovedProjectDefinitions(task({definitionSnapshot: malformed})), null);
  Object.assign(malformed.steps[0]!, {references: ["docs/ghp_" + "A".repeat(32) + ".md"]});
  assert.equal(extractApprovedProjectDefinitions(task({definitionSnapshot: malformed})), null);
  Object.assign(malformed.steps[0]!, {references: [], skills: [{skill: {scope: "global", name: "review"}}]});
  assert.equal(extractApprovedProjectDefinitions(task({definitionSnapshot: malformed})), null);
});

it("decision fences are exact and bounded by message and record caps", () => {
  const content = ["```project-definition-decision", JSON.stringify(decisionRecord()), "```", "```workflow-acceptance", "{}", "```"].join("\n");
  assert.deepEqual(extractProjectDefinitionDecisionRecords(content), [decisionRecord()]);
  assert.deepEqual(extractProjectDefinitionDecisionRecords("yes"), []);
  assert.deepEqual(extractProjectDefinitionDecisionRecords("x".repeat(128_001)), []);
  const tooMany = Array.from({length: 21}, () => ["```project-definition-decision", "{}", "```"].join("\n")).join("\n");
  assert.equal(extractProjectDefinitionDecisionRecords(tooMany).length, 20);
});

it("authorized decisions require exact revisions and native main-root external user messages", () => {
  const current = task();
  const agent = agentProjection();
  const parsed = parseProjectDefinitionDecisionRecord(decisionRecord(), current, definitions({revision: newRevision}), agent);
  assert.ok(parsed);
  assert.equal(parsed.decision.decision, "authorized");
  assert.deepEqual(parsed.decision.userMessageIds, ["user-1"]);
  assert.deepEqual(parsed.userTextHashes, [{messageId: "user-1", textHash: fingerprint(userText)}]);

  assert.equal(parseProjectDefinitionDecisionRecord(decisionRecord({taskId: "another-task"}), current, definitions({revision: newRevision}), agent), null);
  assert.equal(parseProjectDefinitionDecisionRecord(decisionRecord({expectedRevision: newRevision}), current, definitions({revision: newRevision}), agent), null);
  assert.equal(parseProjectDefinitionDecisionRecord(decisionRecord({observedRevision: oldRevision}), current, definitions({revision: newRevision}), agent), null);
  assert.equal(parseProjectDefinitionDecisionRecord(decisionRecord({observedRevision: oldRevision}), current, definitions(), agent), null);
  assert.equal(parseProjectDefinitionDecisionRecord(decisionRecord({unexpected: true}), current, definitions({revision: newRevision}), agent), null);
  assert.equal(parseProjectDefinitionDecisionRecord(decisionRecord({reason: "r".repeat(1001)}), current, definitions({revision: newRevision}), agent), null);
  assert.equal(parseProjectDefinitionDecisionRecord(decisionRecord({userMessageIds: []}), current, definitions({revision: newRevision}), agent), null);
  assert.equal(parseProjectDefinitionDecisionRecord(decisionRecord(), current, definitions({status: "invalid", revision: newRevision,
    issues: [{path: ".t3-supervisor/project.yaml", code: "project_configuration_invalid", message: "Invalid configuration."}]}), agent), null);
});

it("native primary user messages use the running root_turn node", () => {
  const projection = agentProjection([{id: "user-1", text: userText, runStatus: "waiting", rootStatus: "starting"}], "running");
  const source = projection.messages[0]!;
  const sourceRun = projection.runs.find(run => run.id === source.runId)!;
  const user = projection.messages[1]!;
  const userRun = projection.runs.find(run => run.id === user.runId)!;
  assert.equal(nativeUserMessageVisible(projection, sourceRun, source), true);
  assert.equal(nativeUserMessageVisible(projection, userRun, user), true);
  assert.equal(buildProjectDefinitionReviewRequest(task(), definitions(), definitions({revision: newRevision}), projection, "Running marker").text !== null, true);
});

it("restart_active preserves source and citation messages on interrupted historical roots", () => {
  const projection = agentProjection([{id: "user-1", text: userText, runStatus: "running", historicalRoot: true}], "running", true);
  const source = projection.messages[0]!;
  const sourceRun = projection.runs.find(run => run.id === source.runId)!;
  const user = projection.messages[1]!;
  const userRun = projection.runs.find(run => run.id === user.runId)!;
  assert.notEqual(source.nodeId, sourceRun.rootNodeId);
  assert.notEqual(user.nodeId, userRun.rootNodeId);
  assert.equal(nativeUserMessageVisible(projection, sourceRun, source), true);
  assert.equal(nativeUserMessageVisible(projection, userRun, user), true);

  const current = task();
  const observed = definitions({revision: newRevision});
  const parsed = parseProjectDefinitionDecisionRecord(decisionRecord(), current, observed, projection);
  assert.ok(parsed);
  assert.deepEqual(parsed.decision.userMessageIds, ["user-1"]);
  const built = buildProjectDefinitionReviewRequest(current, definitions(), observed, projection, "Restart marker");
  assert.ok(built.text);
  assert.deepEqual(parseEnvelope(built).userMessages, [{messageId: "source-0", readItemId: "turn-item:message:source-0"},
    {messageId: "user-1", readItemId: "turn-item:message:user-1"}]);

  const rolledBack = agentProjection([{id: "user-1", text: userText, runStatus: "running", historicalRoot: true, rootStatus: "rolled_back"}], "running", true);
  const rolledBackUser = rolledBack.messages[1]!;
  const rolledBackRun = rolledBack.runs.find(run => run.id === rolledBackUser.runId)!;
  assert.equal(nativeUserMessageVisible(rolledBack, rolledBackRun, rolledBackUser), false);
  assert.equal(parseProjectDefinitionDecisionRecord(decisionRecord(), current, observed, rolledBack), null);
});

it("forwarded, scheduled, source-tagged, streaming, rolled-back and non-root user messages cannot authorize definitions", () => {
  const current = task();
  const observed = definitions({revision: newRevision});
  const rejected: UserFixture[] = [
    {id: "sender", text: userText, senderThreadId: "parent-thread"},
    {id: "scheduled", text: userText, scheduledTaskId: "schedule-1"},
    {id: "source-tagged", text: userText, source: "import"},
    {id: "assistant-authored", text: userText, createdBy: "assistant"},
    {id: "other-origin", text: userText, creationSource: "import"},
    {id: "streaming", text: userText, streaming: true},
    {id: "rolled-back-run", text: userText, runStatus: "rolled_back"},
    {id: "off-root-node", text: userText, nodeId: "off-root-user-node"},
    {id: "wrong-root-kind", text: userText, rootKind: "subagent"},
  ];
  for (const user of rejected) {
    assert.equal(parseProjectDefinitionDecisionRecord(decisionRecord({userMessageIds: [user.id]}), current, observed, agentProjection([user])), null, user.id);
  }
});

it("stopped, failed and cancelled runs retain their real user request and authorization history", () => {
  for (const status of ["interrupted", "failed", "cancelled"]) {
    const projection = agentProjection([{id: "user-1", text: userText, runStatus: status}], status);
    const source = projection.messages[0]!;const sourceRun = projection.runs.find(run => run.id === source.runId)!;
    assert.equal(nativeUserMessageVisible(projection, sourceRun, source), true, status);
    assert.ok(parseProjectDefinitionDecisionRecord(decisionRecord(), task(), definitions({revision: newRevision}), projection), status);
    assert.ok(buildProjectDefinitionReviewRequest(task(), definitions(), definitions({revision: newRevision}), projection, "Stopped history marker").text, status);
  }
});

it("revert decisions may cite no users and retain a null observed revision for missing definitions", () => {
  const current = task();
  const missing = definitions({status: "missing", revision: null, projectConfig: null, config: effectiveIndex({steps: [], workflows: []}), steps: [], workflows: [], complete: false,
    sources: [], issues: [{path: ".t3-supervisor/project.yaml", code: "configuration_missing", message: "Missing."}]});
  const parsed = parseProjectDefinitionDecisionRecord(decisionRecord({observedRevision: null, decision: "revert_requested", userMessageIds: [],
    reason: "No real user message authorized these agent-authored file changes."}), current, missing, agentProjection([]));
  assert.ok(parsed);
  assert.equal(parsed.decision.observedRevision, null);
  assert.deepEqual(parsed.decision.userMessageIds, []);
  assert.deepEqual(parsed.userTextHashes, []);
  assert.equal(parseProjectDefinitionDecisionRecord(decisionRecord({observedRevision: null, decision: "authorized", userMessageIds: ["user-1"]}),
    current, missing, agentProjection()), null);
});

it("decision reasons redact credentials, and a review request names changes and messages without any body", () => {
  const current = task();
  const observed = definitions({revision: newRevision,
    steps: [{id: "verify", name: "secret=step-token", description: "Keep token=step-secret private.", summary: testSummary("verify"), origin: "project",
      path: ".t3-supervisor/steps/verify.md", sourceId: "verify"}],
    sources: definitions().sources.map(source => source.path.endsWith("steps/verify.md")
      ? {...source, content: stepSource("verify", "Check safely with api_key=private-instructions and password:private-result.")} : source)});
  const parsed = parseProjectDefinitionDecisionRecord(decisionRecord({reason: "Bearer abcdefghijklmnopqrstuvwxyz123456"}), current, observed, agentProjection());
  assert.equal(parsed?.decision.reason, "[redacted credential]");

  const builtReview = buildProjectDefinitionReviewRequest(current, definitions(), observed, agentProjection(), "Review marker",
    {supervisorThreadId: "supervisor-a", bindingGeneration: 3, requestId: "review-request-a"});
  const prompt = builtReview.text;
  assert.ok(prompt);
  // the wake names the revisions and the read of its data; the data itself is the frozen envelope
  assert.match(prompt, /Read its changed entries, user message handles and templates with workflow_read \{"supervisorThreadId":"supervisor-a","bindingGeneration":3,"requestId":"review-request-a","view":"request"\}/u);
  assert.doesNotMatch(prompt, /REVIEW |"userMessages"|"decisionTemplate"/u);
  // the request is a handle: it names the revisions, the changed entries and the messages, and carries no definition or message body
  assert.match(prompt, /^Definition review for task /u);
  assert.match(prompt, /Review marker/u);
  for (const secret of ["step-secret", "step-token", "private-instructions", "private-result", userText]) assert.equal(prompt.includes(secret), false);
  const envelope = parseEnvelope(builtReview);
  // the procedure names the templates this frozen envelope carries and the fenced records the service reads back
  for (const template of ["decisionTemplate", "proposalTemplate"]) assert.ok(Object.hasOwn(envelope, template) && definitionChangedProcedure.includes(template), template);
  for (const fence of ["workflow-proposal", "project-definition-decision"]) assert.ok(definitionChangedProcedure.includes(fence), fence);
  assert.equal(envelope.approvedRevision, oldRevision);
  assert.equal((envelope.observed as Record<string, unknown>).revision, newRevision);
  assert.equal(envelope.sourceMessageId, "source-0");
  // each user message is read by its published turn item; its message ID is the provenance a decision cites
  assert.deepEqual(envelope.userMessages, [{messageId: "source-0", readItemId: "turn-item:message:source-0"},
    {messageId: "user-1", readItemId: "turn-item:message:user-1"}]);
  assert.match(prompt, /the user messages by their readItemId in the main; a decision cites their messageIds/u);
  // before T3 publishes a message as a read item it has no handle: no ID is constructed for it
  unpublishedMessageIds.add("user-1");
  try {
    const pending = parseEnvelope(buildProjectDefinitionReviewRequest(current, definitions(), observed, agentProjection(), "Review marker"));
    assert.deepEqual(pending.userMessages, [{messageId: "source-0", readItemId: "turn-item:message:source-0"}, {messageId: "user-1", readItemId: null}]);
  } finally {
    unpublishedMessageIds.delete("user-1");
  }
  assert.deepEqual((envelope.changed as {steps: string[]}).steps, ["verify"], "the changed step is named, compared before redaction");
  assert.equal(envelope.decisionTemplate !== null, true);
  assert.equal(envelope.proposalTemplate !== null, true);
});

it("review requests handle invalid snapshots and refresh proposals after restore or authorization", () => {
  const current = task();
  const invalid = definitions({status: "invalid", revision: null, projectConfig: null, config: effectiveIndex({steps: [], workflows: []}), steps: [], workflows: [], complete: false,
    sources: [], issues: [{path: ".t3-supervisor/project.yaml", code: "project_configuration_invalid", message: "The configuration is invalid."}]});
  const invalidBuilt = buildProjectDefinitionReviewRequest(current, definitions(), invalid, agentProjection(), "Invalid marker");
  assert.ok(invalidBuilt.text);
  const invalidEnvelope = parseEnvelope(invalidBuilt);
  assert.equal(invalidEnvelope.decisionTemplate !== null, true);
  assert.equal((invalidEnvelope.decisionTemplate as Record<string, unknown>).observedRevision, null);
  assert.equal(invalidEnvelope.proposalTemplate, null);

  const authorized = definitions({revision: newRevision});
  const refreshBuilt = buildProjectDefinitionReviewRequest(current, authorized, authorized, agentProjection(), "Refresh marker");
  const refreshRequest = refreshBuilt.text;
  assert.ok(refreshRequest);
  const refreshEnvelope = parseEnvelope(refreshBuilt);
  assert.equal(refreshEnvelope.decisionTemplate, null);
  assert.equal(refreshEnvelope.proposalTemplate !== null, true);
  assert.match(refreshRequest, /approved definitions were restored or authorized; reassess/u);
  assert.ok(definitionReassessProcedure.includes("proposalTemplate"), "the reassessment names the template its envelope carries");

  assert.equal(buildProjectDefinitionReviewRequest(current, definitions(), definitions({status: "permission_required", revision: null}), agentProjection(), "Blocked").text, null);
  const staleSource = agentProjection();
  staleSource.messages[0]!.text = "tampered original source";
  assert.equal(buildProjectDefinitionReviewRequest(current, definitions(), authorized, staleSource, "Stale source").text, null);
});

it("a review names exactly the changed entries and sources, compared before redaction, and never their bodies", () => {
  const approved = definitions();
  const current = task();
  const changedOf = (observed: ProjectDefinitionSnapshot) => {
    const built = buildProjectDefinitionReviewRequest(current, approved, observed, agentProjection(), "Changed entries marker");
    assert.ok(built.text);
    return {request: `${built.text}\n${JSON.stringify(built.envelope)}`, changed: parseEnvelope(built).changed as {steps: string[]; workflows: string[]; sources: string[]}};
  };
  assert.deepEqual(changedOf(definitions({revision: newRevision})).changed, {steps: [], workflows: [], sources: []}, "a new revision alone changes no entry");
  const edited = changedOf(definitions({revision: newRevision, sources: approved.sources.map(source => ({...source, content: `${source.content}\n# token=different-secret`}))}));
  assert.deepEqual(edited.changed.sources, approved.sources.map(source => source.path).sort(), "comparison occurs before credential redaction");
  assert.equal(edited.request.includes("different-secret"), false);
  const removed = changedOf(definitions({revision: newRevision, steps: [], config: effectiveIndex({steps: [], workflows: []}), projectConfig: projectIndex(),
    sources: approved.sources.filter(source => source.path.endsWith("project.yaml"))}));
  assert.deepEqual(removed.changed.steps, approved.steps.map(step => step.id));
  assert.ok(removed.changed.sources.length > 0);
  const invalid = changedOf(definitions({status: "invalid", revision: null, projectConfig: null, config: effectiveIndex({steps: [], workflows: []}), steps: [], workflows: [], complete: false,
    sources: [], issues: [{path: ".t3-supervisor/project.yaml", code: "project_configuration_invalid", message: "The configuration is invalid."}]}));
  assert.deepEqual(invalid.changed.sources, approved.sources.map(source => source.path).sort());
});

it("recovery retains effective parsed global guidance and rewritten references", () => {
  const base = definitions();
  const step = {...base.steps[0]!, id: "g123_verify", origin: "global" as const};
  const workflow = {id: "g123_review", name: "Global review", description: "Keep the effective global contract.", summary: testSummary("review"), fixed: true,
    sequence: [{step: "g123_verify"}], origin: "global" as const, path: ".t3-supervisor/workflows/review.yaml", sourceId: "review"};
  const approved = {...base, globalRevision: "global-old", globalOnly: true, projectConfig: null, config: effectiveIndex({steps: [step], workflows: [workflow]}, [{step: "g123_verify"}]),
    steps: [step], workflows: [workflow], sources: [...base.sources.map(source => ({...source, origin: "global" as const})),
      {path: workflow.path, origin: "global" as const, content: "name: Global review\nsequence:\n  - step: verify\n"}]};
  const observed = {...approved, revision: newRevision, globalRevision: "global-new"};
  const result = buildProjectDefinitionReviewRequest(task(), approved, observed, agentProjection(), "Global marker");
  assert.ok(result.text, result.error ?? "missing recovery");
  // the effective global guidance is read with view definitions; the review names the changed global revision
  const envelope = parseEnvelope(result) as {observed: {globalRevision: string | null}; changed: {steps: string[]; workflows: string[]}};
  assert.equal(envelope.observed.globalRevision, "global-new");
  assert.deepEqual([envelope.changed.steps, envelope.changed.workflows], [[], []]);
});

it("a stored snapshot with a branch round-trips; a malformed branch makes the snapshot unusable", () => {
  const workflow = (branch: unknown): ProjectDefinitionSnapshot["workflows"][number] => ({id: "review", name: "Review", description: "Review the change.", summary: testSummary("review"), fixed: false,
    sequence: [branch as ProjectDefinitionSnapshot["workflows"][number]["sequence"] extends readonly (infer N)[] | undefined ? N : never, {step: "verify"}],
    origin: "project", path: ".t3-supervisor/workflows/review.yaml", sourceId: "review"});
  const branched = definitions({workflows: [workflow({branch: {if: "The change is contained.", then: [{step: "verify"}], else: [{parallel: [{step: "verify"}, {workflow: "other"}]}]}})]});
  assert.deepEqual(extractApprovedProjectDefinitions(task({definitionSnapshot: branched})), branched);
  for (const broken of [{branch: {if: "Two\nlines", then: [{step: "verify"}]}}, {branch: {if: "Contained.", then: []}}, {branch: {if: "Contained.", then: [{step: "verify"}], elif: []}}])
    assert.equal(extractApprovedProjectDefinitions(task({definitionSnapshot: definitions({workflows: [workflow(broken)]})})), null, JSON.stringify(broken));
});
