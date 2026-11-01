import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { workflowToolNames } from "../src/workflow-write-evidence.js";
import { interpretationRules } from "../src/supervisor-workflow.js";
import type { TaskRecord } from "../src/project-supervisor-store.js";
import { mcpCall } from "./support/glinint-wiring.js";
import { submissionArguments } from "./support/interpretation-submit.js";
import { planFields, startInterpretationFixture, type InterpretationFixture } from "./support/interpretation-fixture.js";

// a pending start's verdict inside the typed interpretation (plan 3.12 items 5 and 7; extends the project-supervisor start cases)
// over the production boundary: the main's own supervision_start call and the root's submission both go through the authenticated
// /mcp/workflows route, with their native items in the loopback peer's projections.
// it.live: every case crosses the real mcp listener and the peer's http and websocket sockets, and the real sqlite files

const startText = "Have Supervisor follow this task: add a CSV export.";

it.live("an identical pending Start after an older Stop keeps its receipt without lifting the Stop early", () => Effect.gen(function* () {
  const f = yield* startInterpretationFixture({noProject: true});
  const policy = yield* f.core.policy.get();
  assert.equal((yield* f.core.control.setChatPolicy(f.mainThreadId, false, policy.generation)).status, "saved");
  f.addRequest("fresh-start-after-stop", startText);
  const main = f.main();
  const message = main.messages.find(item => item.id === "fresh-start-after-stop")!;
  const stop = (yield* f.core.store.chatStop(f.mainThreadId))!;
  message.createdAt = new Date(stop.stoppedAt + 10).toISOString();
  const run = main.runs.find(item => item.id === message.runId)!;
  const args = {callerThreadId: f.mainThreadId, userMessageId: message.id, operationId: "new-start-after-old-stop"};
  const nodeId = "retry-start-node";
  (main.nodes as Array<Record<string, unknown>>).push({id: nodeId, kind: "dynamic_tool", threadId: f.mainThreadId, runId: run.id,
    rootNodeId: run.rootNodeId, parentNodeId: run.rootNodeId, providerThreadId: run.providerThreadId, status: "completed"});
  const item = {id: "retry-start-item", type: "dynamic_tool", threadId: f.mainThreadId, runId: run.id, nodeId,
    providerThreadId: run.providerThreadId, parentItemId: null, ordinal: 1, status: "completed",
    toolName: workflowToolNames.start.direct[1], input: args};
  main.turnItems = [item];
  f.native.details.set(item.id, {...item, nativeItemRef: {driver: "codex", nativeId: "native-retry-start-item", strength: "strong"}, toolNonExecutionKind: null});
  const first = yield* mcpCall(f.endpoint, "supervision_start", args);
  assert.equal((first.value as {status: string}).status, "pending", JSON.stringify(first.value));
  const savedPolicy = yield* f.core.policy.get();
  const second = yield* mcpCall(f.endpoint, "supervision_start", args);
  assert.deepEqual(second.value, first.value);
  assert.deepEqual(yield* f.core.policy.get(), savedPolicy, "a retry does not activate the pending Start");
  assert.deepEqual(yield* f.core.store.chatStop(f.mainThreadId), stop);
}), {timeout: 60_000});

// a no project main whose genuine request asked for supervision through its own native supervision_start call, interpreted once
const pendingStart = Effect.gen(function* () {
  const f = yield* startInterpretationFixture({noProject: true});
  f.addRequest("request-start", startText);
  const main = f.main();
  const run = main.runs.find(value => value.userMessageId === "request-start")!;
  const args = {callerThreadId: f.mainThreadId, userMessageId: "request-start", operationId: "own-start"};
  const nodeId = "start-node";
  (main.nodes as Array<Record<string, unknown>>).push({id: nodeId, kind: "dynamic_tool", threadId: f.mainThreadId, runId: run.id, rootNodeId: run.rootNodeId,
    parentNodeId: run.rootNodeId, providerThreadId: run.providerThreadId, status: "completed"});
  const item = {id: "start-item", type: "dynamic_tool", threadId: f.mainThreadId, runId: run.id, nodeId, providerThreadId: run.providerThreadId,
    parentItemId: null, ordinal: 1, status: "completed", toolName: workflowToolNames.start.direct[1], input: args};
  main.turnItems = [item];
  f.native.details.set(item.id, {...item, nativeItemRef: {driver: "codex", nativeId: "native-start-item", strength: "strong"}, toolNonExecutionKind: null});
  assert.equal(((yield* mcpCall(f.endpoint, "supervision_start", args)).value as {status: string}).status, "pending");
  assert.equal((yield* f.core.store.start(f.mainThreadId).pipe(Effect.orDie))?.status, "pending");
  yield* f.runOnce();
  yield* f.runOnce();
  const task = yield* f.task();
  assert.equal(task.status, "waiting");
  // the request is a handle; the root reads the pending Start's verdict request and its rules through its authenticated reads
  const request = String(f.interpretationDispatches().at(-1)?.text);
  assert.doesNotMatch(request, /startRequested|sourcePin/u);
  const context = yield* f.read({view: "context"});
  assert.equal(context.status, "ok");
  assert.equal(context.supervision, "pending_start");
  assert.deepEqual(context.submission, {tool: "supervision_interpretation_submit", arguments: {supervisorThreadId: f.binding.threadId,
    bindingGeneration: f.binding.generation, taskId: task.id, attemptId: task.attempt!.attemptId, sourcePin: task.attempt!.key.source}, startVerdict: true});
  const rules = yield* f.read({view: "interpretation"});
  assert.equal(rules.instructions, interpretationRules, "the verdict rule is stage one of the rules the root reads");
  return {f, task};
});

const verdict = (task: TaskRecord, startRequested: boolean, objective: string | null = null) =>
  submissionArguments(task, {...planFields(task, objective ?? "unused"), objective, ...(objective === null ? {workflow: null} : {}), startRequested});

it.live("CT-ISUB-07: a positive verdict activates the Start only after its run completes; recording never activates it and grants no general effect", () => Effect.gen(function* () {
  const {f, task} = yield* pendingStart;
  assert.equal((yield* f.submit(task, verdict(task, true))).value.status, "submitted");
  assert.equal((yield* f.core.store.start(f.mainThreadId).pipe(Effect.orDie))?.status, "pending", "recording never activates a Start");
  assert.equal(yield* f.core.scope.scopeEnabled(task.projectId, f.mainThreadId).pipe(Effect.orDie), false, "no widening to general effects before activation");
  f.endRun(task, "completed");
  yield* f.runOnce();
  assert.equal((yield* f.core.store.start(f.mainThreadId).pipe(Effect.orDie))?.status, "active");
  assert.equal(yield* f.core.scope.scopeEnabled(task.projectId, f.mainThreadId).pipe(Effect.orDie), true);
  // a bare start without a task activates permission and contacts nobody
  assert.equal((yield* f.task()).status, "needs_context");
  assert.equal(f.operativeSends().length, 0);
}), {timeout: 60_000});

it.live("CT-ISUB-07: a negative verdict rejects the Start and a submission without the verdict is invalid", () => Effect.gen(function* () {
  {
    const {f, task} = yield* pendingStart;
    const missing = submissionArguments(task, {...planFields(task, "unused"), objective: null, workflow: null});
    const reply = yield* f.submit(task, missing);
    assert.equal(reply.value.status, "invalid");
    assert.deepEqual(reply.value.status === "invalid" ? reply.value.issues : [], [{code: "missing_key", path: "/startRequested"}]);
    assert.equal((yield* f.receipts()).length, 0);
    assert.equal((yield* f.submit(task, verdict(task, false))).value.status, "submitted", "a corrected submission in the same run");
    f.endRun(task, "completed");
    yield* f.runOnce();
    assert.equal((yield* f.core.store.start(f.mainThreadId).pipe(Effect.orDie))?.status, "rejected");
    assert.equal((yield* f.task()).status, "not_supervised");
    assert.equal(yield* f.core.scope.scopeEnabled(task.projectId, f.mainThreadId).pipe(Effect.orDie), false);
    assert.equal(f.operativeSends().length, 0);
  }
}), {timeout: 60_000});

it.live("CT-ISUB-07: a mode change, a later Stop or a rolled-back tool item before activation prevents it", () => Effect.gen(function* () {
  for (const change of ["mode", "stop", "rolled_back"] as const) {
    const {f, task} = yield* pendingStart;
    const args = verdict(task, true);
    assert.equal((yield* f.submit(task, args, {itemId: "start-verdict"})).value.status, "submitted", change);
    if (change === "mode") {
      const control = yield* f.core.supervisor.noProjectControl().pipe(Effect.orDie);
      assert.equal((yield* f.core.supervisor.saveNoProjectControl({expectedGeneration: control.generation, mode: "off"}).pipe(Effect.orDie)).status, "saved");
    }
    if (change === "stop") yield* f.core.supervisor.setChatSupervision({projectId: task.projectId, mainThreadId: f.mainThreadId,
      policyGeneration: (yield* f.core.policy.get().pipe(Effect.orDie)).generation, enabled: false}).pipe(Effect.orDie);
    if (change === "rolled_back") f.setItemStatus("start-verdict", "rolled_back");
    f.endRun(task, "completed");
    yield* f.runOnce();
    assert.notEqual((yield* f.core.store.start(f.mainThreadId).pipe(Effect.orDie))?.status, "active", change);
    assert.equal(yield* f.core.scope.scopeEnabled(task.projectId, f.mainThreadId).pipe(Effect.orDie), false, change);
    if (change === "stop") {
      const notice = (yield* f.core.store.binding(task.projectId, f.mainThreadId).pipe(Effect.orDie))?.stopNotice;
      assert.ok(notice);
      assert.deepEqual(f.operativeSends().map(command => ({commandId: command.commandId, messageId: command.messageId, text: command.text})),
        [{commandId: notice.commandId, messageId: notice.messageId, text: notice.text}], "only the explicit Stop notice reaches the main; no Start or introduction");
    } else assert.equal(f.operativeSends().length, 0, change);
  }
}), {timeout: 60_000});

// a no project main whose request a person started from the dashboard while its run was open: the Start activates at once and pins
// that request, written before the Start's own intent (663 ms before it, as observed live), as its task's source
const uiRequest = "Add a CSV export to the report page.";
const activeStart = Effect.gen(function* () {
  const f = yield* startInterpretationFixture({noProject: true});
  f.addRequest("request-ui", uiRequest);
  const run = f.main().runs.find(value => value.userMessageId === "request-ui")!;
  Object.assign(run, {status: "running", completedAt: null});
  assert.equal((yield* f.core.control.dashboardStart(f.mainThreadId, "ui-start").pipe(Effect.orDie)).status, "active");
  const start = (yield* f.core.store.start(f.mainThreadId).pipe(Effect.orDie))!;
  assert.deepEqual([start.route, start.status, start.source?.messageId], ["ui", "active", "request-ui"]);
  assert.equal(yield* f.core.store.chatEnabledAt(f.mainThreadId).pipe(Effect.orDie), start.intentAt, "the Start records its own Enable");
  f.main().messages.find(message => message.id === "request-ui")!.createdAt = new Date(start.intentAt - 663).toISOString();
  Object.assign(run, {status: "completed", completedAt: new Date().toISOString()});
  yield* f.runOnce();
  yield* f.runOnce();
  const task = yield* f.task();
  assert.equal(task.id, start.taskId, "the task the Start pinned");
  assert.equal(task.status, "waiting");
  // the root reads the pinned request among its requester messages although it precedes the Start's Enable
  const context = yield* f.read({view: "context"});
  assert.equal(context.supervision, "enabled");
  assert.ok((context.task as {sources: {requesterMessages: Array<{messageId: string}>}}).sources.requesterMessages
    .some(item => item.messageId === "request-ui"), JSON.stringify(context.task));
  return {f, task};
});

// a typed interpretation whose conversation decision authorizes the pinned request's scope
const decided = (task: TaskRecord, scope: "same" | "changed") => submissionArguments(task, {...planFields(task, uiRequest),
  conversation: {draft: {objective: uiRequest, constraints: [], questions: [], findings: [], duties: []}, intent: "authorize", outcome: uiRequest, limits: [],
    sourceMessageIds: [task.sourceMessageId], antecedentMessageIds: [], scope}});

it.live("an active dashboard Start's pinned request sources the typed conversation decision from submission through its finalization", () => Effect.gen(function* () {
  const {f, task} = yield* activeStart;
  // a fresh decision cannot keep a scope nobody authorized before
  const same = yield* f.submit(task, decided(task, "same"));
  assert.equal(same.value.status, "invalid");
  assert.deepEqual(same.value.status === "invalid" ? same.value.issues : [], [{code: "invalid_value", path: "/conversation"}]);
  assert.equal((yield* f.receipts()).length, 0);
  assert.equal((yield* f.submit(task, decided(task, "changed"))).value.status, "submitted", "the corrected decision in the same run");
  f.endRun(task, "completed");
  yield* f.runOnce();
  const finalized = yield* f.task();
  assert.equal(finalized.status, "inferred");
  assert.equal(finalized.supervision, "needed");
  assert.equal(finalized.conversation?.authorization?.state, "authorized");
  assert.deepEqual(finalized.conversation?.authorization?.scopeSources.map(source => source.messageId), ["request-ui"]);
  assert.equal(finalized.conversation?.considered?.messageId, "request-ui");
  // the decided request's proposal reaches the operative once: the Start's own Enable does not block its introduction
  yield* f.runOnce();
  assert.equal(f.operativeSends().filter(command => String(command.messageId).startsWith("supervisor-notice:workflow:")).length, 1,
    JSON.stringify(f.operativeSends().map(command => command.messageId)));
  assert.deepEqual(f.peer.unexpected, []);
}), {timeout: 60_000});

it.live("a Stop after the Start-pinned request's proposal was admitted waits for that delivery and sends it nothing again", () => Effect.gen(function* () {
  const {f, task} = yield* activeStart;
  assert.equal((yield* f.submit(task, decided(task, "changed"))).value.status, "submitted");
  f.endRun(task, "completed");
  yield* f.runOnce();
  yield* f.runOnce();
  const proposals = () => f.operativeSends().filter(command => String(command.messageId).startsWith("supervisor-notice:workflow:"));
  assert.equal(proposals().length, 1, "the proposal was admitted and dispatched once");
  // the accepted delivery is not yet in the main's projection, including the queued run it creates
  const main = f.main();
  const proposalMessageId = proposals()[0]!.messageId;
  main.messages = main.messages.filter(message => message.id !== proposalMessageId);
  main.runs = main.runs.filter(run => run.userMessageId !== proposalMessageId);
  yield* f.core.supervisor.setChatSupervision({projectId: task.projectId, mainThreadId: f.mainThreadId,
    policyGeneration: (yield* f.core.policy.get().pipe(Effect.orDie)).generation, enabled: false}).pipe(Effect.orDie);
  yield* f.runOnce();
  const notice = (yield* f.core.store.binding(task.projectId, f.mainThreadId).pipe(Effect.orDie))?.stopNotice;
  assert.ok(notice, "the Stop prepared its notice");
  assert.equal(notice.enabledAt, (yield* f.core.store.start(f.mainThreadId).pipe(Effect.orDie))?.intentAt, "the epoch the Stop ends is the Start's own");
  assert.equal(f.operativeSends().filter(command => command.messageId === notice.messageId).length, 0, "the Stop notice waits for the earlier proposal");
  assert.deepEqual(f.peer.unexpected, []);
  assert.equal(proposals().length, 1, "the proposal is not sent again");
}), {timeout: 60_000});

it.live("a later Stop, a later Enable or an edited request keeps an active Start's pinned request from sourcing a decision", () => Effect.gen(function* () {
  for (const change of ["stop", "enable", "edited"] as const) {
    const {f, task} = yield* activeStart;
    const stop = (enabled: boolean) => Effect.gen(function* () {
      yield* f.core.supervisor.setChatSupervision({projectId: task.projectId, mainThreadId: f.mainThreadId,
        policyGeneration: (yield* f.core.policy.get().pipe(Effect.orDie)).generation, enabled}).pipe(Effect.orDie);
    });
    if (change !== "edited") yield* stop(false);
    // a person's Enable after the Stop is a later boundary: the earlier Start and its request no longer apply
    if (change === "enable") yield* stop(true);
    if (change === "edited") f.main().messages.find(message => message.id === "request-ui")!.text = "Changed request";
    const reply = yield* f.submit(task, decided(task, "changed"));
    assert.notEqual(reply.value.status, "submitted", `${change}: ${JSON.stringify(reply.value)}`);
    assert.equal((yield* f.receipts()).length, 0, change);
    f.endRun(task, "completed");
    yield* f.runOnce();
    assert.notEqual((yield* f.task()).conversation?.authorization?.state, "authorized", change);
    assert.ok(f.operativeSends().every(command => !String(command.messageId).startsWith("supervisor-notice:workflow:")), `${change}: no introduction`);
  }
}), {timeout: 60_000});

// the final proof read awaits getturnitem after its main snapshot. a genuine source edit inside that await is a later revision
const editSourceAtProof = (f: InterpretationFixture, task: TaskRecord) => {
  let changed = 0;
  f.native.beforeTurnItem = Effect.sync(() => {
    if (changed++) return;
    f.main().messages.find(message => message.id === task.sourceMessageId)!.text = "Hello, I do not request supervision.";
  });
  return () => changed;
};

it.live("SOL-R42-01: a genuine source edit during the final proof read does not activate a bare Start", () => Effect.gen(function* () {
  const {f, task} = yield* pendingStart;
  assert.equal((yield* f.submit(task, verdict(task, true))).value.status, "submitted");
  f.endRun(task, "completed");
  const changed = editSourceAtProof(f, task);
  yield* f.runOnce();
  assert.ok(changed() > 0, "mutation crossed actual getTurnItem boundary");
  const closed = yield* f.task();
  assert.notEqual((yield* f.core.store.start(f.mainThreadId).pipe(Effect.orDie))?.status, "active", "edited source must be checked after final native proof read");
  assert.equal(closed.status, "unavailable");
  assert.equal(closed.reason, "The task source changed before the interpretation completed.");
  assert.equal(closed.interpretationEvidence, undefined);
  assert.equal((yield* f.receipts()).length, 1, "the recorded receipt stays; nothing is resent");
  assert.equal(f.interpretationDispatches().length, 1);
  assert.equal(f.operativeSends().length, 0);
}), {timeout: 60_000});

it.live("SOL-R42-01: a genuine source edit during the final proof read does not apply a negative Start", () => Effect.gen(function* () {
  const {f, task} = yield* pendingStart;
  assert.equal((yield* f.submit(task, verdict(task, false))).value.status, "submitted");
  f.endRun(task, "completed");
  const changed = editSourceAtProof(f, task);
  yield* f.runOnce();
  assert.ok(changed() > 0, "mutation crossed actual getTurnItem boundary");
  const closed = yield* f.task();
  assert.notEqual((yield* f.core.store.start(f.mainThreadId).pipe(Effect.orDie))?.status, "active");
  assert.equal(closed.status, "unavailable");
  assert.equal(closed.reason, "The task source changed before the interpretation completed.");
  assert.equal((yield* f.receipts()).length, 1);
  assert.equal(f.interpretationDispatches().length, 1);
  assert.equal(f.operativeSends().length, 0);
}), {timeout: 60_000});
