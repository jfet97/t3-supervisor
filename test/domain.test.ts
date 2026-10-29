import assert from "node:assert/strict";
import { it } from "vitest";
import {freshRuntimeRequestStatus, genuineHumanMessage, mainRunNodeReader, nativeUserMessageVisible, projectionHasOngoingWork} from "../src/domain.js";
import type {MessageInfo, Projection, RunInfo, ThreadInfo} from "../src/types.js";

const thread: ThreadInfo = {id: "thread", title: "Work", projectId: "project", lineage: {parentThreadId: null, relationshipToParent: null}};
const run: RunInfo = {
  id: "run",
  threadId: thread.id,
  ordinal: 1,
  status: "completed",
  requestedAt: "2026-10-17T10:00:00.000Z",
  startedAt: "2026-10-17T10:00:01.000Z",
  completedAt: "2026-10-17T10:00:02.000Z",
  rootNodeId: "root",
  userMessageId: "request",
  providerThreadId: "provider-main",
};
const rootNode = {id: "root", threadId: thread.id, runId: run.id, parentNodeId: null, rootNodeId: "root",
  providerThreadId: "provider-main", kind: "root_turn", status: "completed"};
const request: MessageInfo = {id: "request", threadId: thread.id, runId: run.id, nodeId: "root", role: "user", text: "Do the task",
  streaming: false, createdAt: run.requestedAt, updatedAt: run.requestedAt};
const projection = (overrides: Partial<Projection> = {}): Projection => ({thread, runs: [run], messages: [request], nodes: [rootNode], ...overrides});

it("native user-message evidence must match its retained root-turn node", () => {
  assert.equal(nativeUserMessageVisible(projection(), run, request), true);
  assert.equal(nativeUserMessageVisible(projection(), run, {...request, nodeId: "child"}), false);
  assert.equal(nativeUserMessageVisible(projection(), {...run, status: "rolled_back"}, request), false);
  assert.equal(nativeUserMessageVisible(projection({nodes: [{...rootNode, parentNodeId: "parent"}]}), run, request), false);
});

it("main run reader returns only nodes in the native root graph", () => {
  const childNode = {id: "child", threadId: thread.id, runId: run.id, parentNodeId: "root", rootNodeId: "root",
    providerThreadId: "provider-main", kind: "subagent", status: "completed"};
  const childOutput = {id: "child-output", threadId: thread.id, runId: run.id, parentNodeId: "child", rootNodeId: "root",
    providerThreadId: "provider-main", kind: "assistant_message", status: "completed"};
  const reader = mainRunNodeReader(projection({nodes: [rootNode, childNode, childOutput]}), run);
  assert.equal(reader("root")?.kind, "root_turn");
  assert.equal(reader("child"), undefined);
  assert.equal(reader("child-output"), undefined);
});

it("runtime request status is tied to the exact request and owning node", () => {
  const active = projection({runtimeRequests: [{id: "question", nodeId: "root", status: "pending"}]});
  assert.equal(freshRuntimeRequestStatus(active, {requestId: "question", nodeId: "root"}), "pending");
  assert.equal(freshRuntimeRequestStatus(active, {requestId: "question", nodeId: "child"}), "unknown");
  const resolved = projection({runtimeRequests: [{id: "question", nodeId: "root", status: "resolved"}]});
  assert.equal(freshRuntimeRequestStatus(resolved, {requestId: "question", nodeId: "root"}), "resolved");
  assert.equal(freshRuntimeRequestStatus(projection(), {requestId: "question", nodeId: "root"}), "unknown");
});

it("native requests and active descendants keep a conversation classified as ongoing", () => {
  assert.equal(projectionHasOngoingWork(projection()), false);
  assert.equal(projectionHasOngoingWork(projection({runtimeRequests: [{id: "question", nodeId: "root", status: "pending"}]})), true);
  assert.equal(projectionHasOngoingWork(projection({subagents: [{status: "running"}]})), true);
  assert.equal(projectionHasOngoingWork(projection({runs: [{...run, status: "running"}]})), true);
  assert.equal(projectionHasOngoingWork(projection({runs: [], providerTurns: [{status: "pending", nativeTurnRef: null}]})), true, "runless pending work cannot be treated as quiet even without a strong identity");
  assert.equal(projectionHasOngoingWork(projection({runs: [], providerTurns: [{status: "running"}]})), true);
  assert.equal(projectionHasOngoingWork(projection({runs: [], providerTurns: [{status: "completed"}]})), false);
  assert.equal(projectionHasOngoingWork(projection({runs: [], providerTurns: [{status: "unrecognised"}]})), true, "unknown lifecycle never establishes quiescence");
});

it("human provenance: the human's web or mobile message and the human's runtime answer are genuine; agent sends, notices, system messages and the Supervisor's own stop are not", () => {
  const human = (overrides: Partial<MessageInfo> & Record<string, unknown>): MessageInfo => ({...request, id: "m", createdBy: "user", creationSource: "web", ...overrides});
  const withMessage = (message: MessageInfo, extra: Partial<Projection> = {}) => projection({messages: [request, message], ...extra});
  assert.ok(genuineHumanMessage(withMessage(human({})), "m"), "a web message of the human");
  assert.ok(genuineHumanMessage(withMessage(human({creationSource: "mobile"})), "m"), "a mobile message of the human");
  // the human's answer to a runtime input request of this thread is the server-created user message T3 names after the resolved
  // request: `async-answer:<requestId>` for the dispatched answer, `approval-feedback:<requestId>` for the human's approval feedback
  const resolved = {id: "question", nodeId: "root", status: "resolved", resolvedAt: run.completedAt, answers: {text: "Yes."}, feedback: null};
  const answer = human({id: "async-answer:question", creationSource: "server", nodeId: "root"});
  assert.ok(genuineHumanMessage(withMessage(answer, {runtimeRequests: [resolved]}), "async-answer:question"), "a resolved request's dispatched answer");
  assert.ok(genuineHumanMessage(withMessage(human({id: "approval-feedback:question", creationSource: "server"}), {runtimeRequests: [resolved]}), "approval-feedback:question"),
    "a resolved request's approval feedback");
  assert.equal(genuineHumanMessage(withMessage(answer, {runtimeRequests: [{...resolved, status: "pending", resolvedAt: null}]}), "async-answer:question"), null, "a pending request answers nothing");
  assert.equal(genuineHumanMessage(withMessage(answer, {runtimeRequests: [{...resolved, id: "other"}]}), "async-answer:question"), null, "a name no request of this thread has");
  assert.equal(genuineHumanMessage(withMessage(answer, {runtimeRequests: [{...resolved, nodeId: "elsewhere"}]}), "async-answer:question"), null, "a request on no node of this thread");
  assert.equal(genuineHumanMessage(withMessage(answer, {runtimeRequests: [resolved, {...resolved}]}), "async-answer:question"), null, "an ambiguous request");
  assert.equal(genuineHumanMessage(withMessage(answer), "async-answer:question"), null, "an answer-named server message with no request is not human");
  assert.equal(genuineHumanMessage(withMessage(human({id: "async-answer:question", createdBy: "system", creationSource: "server"}), {runtimeRequests: [resolved]}), "async-answer:question"), null,
    "a system message named like an answer");
  assert.equal(genuineHumanMessage(withMessage(answer, {runtimeRequests: [resolved], runs: [{...run, status: "rolled_back"}]}), "async-answer:question"), null, "an answer in a rolled-back run");
  // links T3 does not record are no attribution: a request field naming the message, or the message naming the request, proves nothing
  assert.equal(genuineHumanMessage(withMessage(human({creationSource: "server", runtimeRequestId: "question"}), {runtimeRequests: [{...resolved, responseMessageId: "m", answerMessageId: "m"}]}), "m"),
    null, "a server message with no request name is not human: a missing sender thread alone proves nothing");
  assert.equal(genuineHumanMessage(withMessage(human({senderThreadId: "agent-thread", creationSource: "mcp", createdBy: "agent"})), "m"), null, "an agent's send");
  assert.equal(genuineHumanMessage(withMessage(human({senderThreadId: "agent-thread"})), "m"), null, "a relayed message with a sender thread, whatever else it claims");
  assert.equal(genuineHumanMessage(withMessage(human({createdBy: "system", creationSource: "server"})), "m"), null, "a system message");
  assert.equal(genuineHumanMessage(withMessage(human({id: "supervisor-notice:workflow:task"})), "supervisor-notice:workflow:task"), null, "a service notice");
  assert.equal(genuineHumanMessage(withMessage(human({id: "supervisor-planning:pause:hold"})), "supervisor-planning:pause:hold"), null, "a Supervisor command");
  assert.equal(genuineHumanMessage(withMessage(human({createdBy: "agent", creationSource: "mcp", senderThreadId: "supervisor-root", text: "Stop."})), "m"), null, "a Stop the Supervisor itself authored");
  assert.equal(genuineHumanMessage(withMessage(human({scheduledTaskId: "cron"})), "m"), null, "a scheduled message");
  assert.equal(genuineHumanMessage(withMessage(human({source: "import"})), "m"), null, "an imported message");
  assert.equal(genuineHumanMessage(withMessage(human({streaming: true})), "m"), null);
});
