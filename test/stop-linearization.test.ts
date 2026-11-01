import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Clock, Effect, Fiber, FiberSet, Option } from "effect";
import type { TaskRecord } from "../src/project-supervisor-store.js";
import type { ConversationRequest } from "../src/supervisor-conversation-store.js";
import { helperDeliveryBody } from "../src/supervisor-helper-transport.js";
import { SUPERVISOR_SETTLE_QUIET_MS } from "../src/supervisor-lifecycle.js";
import { workflowToolNames } from "../src/workflow-write-evidence.js";
import { interpose, rows } from "./support/glinint-wiring.js";
import { json } from "./support/int-native-peer.js";
import {
  addDispatchedMessage, addTurn, assertHelperCredentials, atWallClock, baseTime, dashboard, helperChannelState, helperReceipt, helperRequest, holdRpcReply, hookPath,
  installToolCall, mainThreadId, nativeWrites, once, projectId, publishedWrapper, routeOf, rpcRequests, runHelperBatch, seedIntroduction, seedTeam, startHelperScenario,
  startScenario, teamEventRows, webhookPosts, type Entry, type Scenario,
} from "./support/scenario-driver.js";

/* Stop and Enable publication and send admission on the production run, through the replay scenario driver (support/scenario-driver.ts):
 * production controllers and stores on temporary files, their dashboard and workflow MCP endpoint, and a loopback T3 peer. A case
 * places its race at a native arrival (a peer hook that commits before the peer replies, a held reply, or the transport's own fetch
 * call inside its admission section) and asserts the stored state, the identities sent and the native traffic per route. it.live:
 * every case drives the run over the peer's real HTTP and websocket sockets and the real SQLite files; no case waits on time it
 * controls (the settlement's quiet window is a wall-clock stamp of the one call), and a bound only names a wait that must not happen.
 */

const oldTurn = {id: "old-turn", text: "Earlier request before the boundary."};
const newTurn = {id: "new-turn", text: "Create a migration plan."};
const newRequest = {mainTurns: [oldTurn, newTurn]};
const newSource = {messageId: newTurn.id, runId: `run-${newTurn.id}`, ordinal: 2, text: newTurn.text};

// the bound on a wait that must not happen: a Stop still waiting after it was held by an admission section that should be free
const unheld = "10 seconds";

const task = (f: Scenario): Effect.Effect<TaskRecord> => Effect.map(f.core.store.task(mainThreadId), (value) => value!).pipe(Effect.orDie);
const requests = (f: Scenario, supervisorThreadId: string): Effect.Effect<ConversationRequest[]> =>
  f.core.requests.requests(projectId, supervisorThreadId).pipe(Effect.orDie);
const writes = (f: Scenario): string[] => nativeWrites(f.peer).map(routeOf);
const dispatches = (f: Scenario) => rpcRequests(f.peer, "orchestration.dispatchCommand").map(entry => entry.payload);
const dispatched = (payload: Record<string, unknown>) => ({type: payload.type, commandId: payload.commandId, messageId: payload.messageId,
  threadId: payload.threadId, text: payload.text});

// the Stop notice is a separate authorized effect; it must never hide replay of the operation under test
const assertStopNotice = Effect.fnUntraced(function* (f: Scenario) {
  const notice = (yield* f.binding).stopNotice;
  assert.ok(notice, "the explicit Stop reserves one main notice even before first contact");
  const notices = dispatches(f).filter(payload => payload.commandId === notice.commandId);
  assert.deepEqual(notices.map(dispatched), [{type: "message.dispatch", commandId: notice.commandId, messageId: notice.messageId,
    threadId: mainThreadId, text: notice.text}], "exactly one notice uses its persisted identity and body");
  return {type: "message.dispatch", commandId: notice.commandId};
});

// commits a Stop when the first native command frame arrives, before the peer replies; records whether the commit was visible
const stopOnArrival = (f: Scenario, tag = "orchestration.dispatchCommand") => {
  const seen = {stoppedAtArrival: null as boolean | null};
  let arrived = false;
  const commit = (entry: Entry): Effect.Effect<boolean> => Effect.suspend(() => {
    if (entry.kind !== "rpc" || entry.tag !== tag || arrived) return Effect.succeed(false);
    arrived = true;
    return Effect.gen(function* () {
      yield* f.stop();
      seen.stoppedAtArrival = yield* f.stopped();
      return true;
    });
  });
  return {seen, commit};
};

// whether the stored policy stops the main, read when the read runs (the policy client is never held across a section)
const policyStops = (f: Scenario): Effect.Effect<boolean> => Effect.map(f.core.policy.get(), (policy) => policy.excludedThreadIds.includes(mainThreadId)).pipe(Effect.orDie);

// each page Stop is the page's policy read and the submit it then requests; the submit reaches the gate on the turn it starts
type PageStop = (f: Scenario) => Effect.Effect<Effect.Effect<unknown, unknown>>;

// the Settings excluded-chat editor's Stop: the admitted thread-policy save the HTTP handler yields
const settingsStop: PageStop = (f) => Effect.map(f.core.policy.get().pipe(Effect.orDie), (policy) =>
  f.core.control.saveThreadPolicy({...policy, excludedThreadIds: [...policy.excludedThreadIds, mainThreadId]}));

// the dashboard's Stop supervision control: the admitted chat-policy write and its bookkeeping
const dashboardStop: PageStop = (f) => Effect.map(f.core.policy.get().pipe(Effect.orDie), (policy) =>
  f.core.supervisor.setChatSupervision({projectId, mainThreadId, enabled: false, policyGeneration: policy.generation}));

it.live("CT-LIN-01 (CT-INT-03 H4a): helper: a Stop committed during the channel upsert fails the final guard; the check-in returns to prepared, unposted and without a receipt", () => Effect.gen(function* () {
  const h = yield* startHelperScenario();
  const {f} = h;
  let stoppedDuringUpsert = false;
  // the upsert is the transport's last await before its final guard
  f.peer.onUpsert = Effect.gen(function* () {
    yield* f.stop();
    stoppedDuringUpsert = yield* f.stopped();
  });
  yield* runHelperBatch(h);
  assert.equal(stoppedDuringUpsert, true);
  // the transport answers the fenced send busy, which the runtime records by returning the never-sent request to prepared
  const request = yield* helperRequest(f);
  assert.equal(request.state, "prepared");
  assert.equal(request.sentAt, null);
  assert.equal(yield* helperReceipt(f), null);
  assert.equal(yield* helperChannelState(f), "ready");
  assert.deepEqual((yield* f.core.policy.get()).excludedThreadIds, [mainThreadId]);
  assert.deepEqual(writes(f), ["scheduledTasks.upsert"], "only the channel upsert that carried the Stop; no webhook POST");
  assertHelperCredentials(f.peer.log);
  assert.deepEqual(f.peer.unexpected, []);
}), {timeout: 60_000});

it.live("CT-LIN-01: Stop notice: an Enable committed during the Supervisor read fails the final guard; the ready notice is superseded unsent", () => Effect.gen(function* () {
  const f = yield* startScenario();
  const binding = yield* f.bindSupervisor;
  // an earlier Supervisor message in the main makes the notice due
  f.main.messages.push({id: "supervisor-contact", threadId: mainThreadId, runId: null, nodeId: null, role: "user", text: "Supervisor update.",
    streaming: false, createdAt: baseTime, updatedAt: baseTime, senderThreadId: binding.threadId});
  yield* f.stop();
  const notice = (yield* f.binding).stopNotice!;
  assert.equal(notice.state, "ready");
  let stateAtEnable: string | undefined;
  // the cycle reads the main, then the Supervisor last before the guard
  f.peer.onProjection = once((threadId: string) => threadId === binding.threadId, Effect.gen(function* () {
    stateAtEnable = (yield* f.binding).stopNotice?.state;
    yield* f.enable();
  }));
  yield* f.runOnce;
  assert.equal(stateAtEnable, "ready");
  assert.equal(yield* f.stopped(), false);
  assert.deepEqual((yield* f.binding).stopNotice, {...notice, state: "superseded"});
  assert.equal((yield* f.binding).supervisionStop, undefined);
  assert.equal(typeof (yield* f.core.store.chatEnabledAt(mainThreadId)), "number");
  assert.deepEqual(dispatches(f).filter(payload => payload.commandId === notice.commandId), []);
  assert.deepEqual(writes(f), []);
  assert.deepEqual(f.peer.unexpected, []);
}), {timeout: 10_000});

it.live("CT-LIN-01: introduction: a Stop committed during the Supervisor read fails the final guard; the introduction stays ready and unsent", () => Effect.gen(function* () {
  const f = yield* startScenario(newRequest);
  const binding = yield* f.bindSupervisor;
  const {introduction} = yield* seedIntroduction(f, newSource);
  let definitionsRead = false;
  const definitions = f.definitions.current;
  f.definitions.current = threadId => {definitionsRead = true;return definitions(threadId);};
  // the Supervisor read after the definition read is the last await before the guard
  f.peer.onProjection = once((threadId: string) => threadId === binding.threadId && definitionsRead, f.stop());
  yield* f.runOnce;
  assert.equal(yield* f.stopped(), true);
  assert.deepEqual(yield* f.core.requests.introduction(introduction.taskId), introduction);
  assert.deepEqual(writes(f), []);
  assert.deepEqual(f.peer.unexpected, []);
}), {timeout: 10_000});

it.live("CT-LIN-01: guide: a Stop committed during the ancestor read of the helper's MCP guide is denied by the assignment recheck with no receipt and no request", () => Effect.gen(function* () {
  const f = yield* startScenario();
  const binding = yield* f.bindSupervisor;
  // the target's parent is an operational child, so the walk rechecks the assignment after the parent read
  const {helper, member, assignment} = yield* seedTeam(f, {branchParent: "middle"});
  const payload = {supervisorThreadId: helper.thread.id, bindingGeneration: binding.generation, memberEpoch: member.epoch, assignmentRootThreadId: "branch",
    assignmentEpoch: assignment.epoch, operationId: "lin-guide-stop", targetThreadId: "branch", text: "Continue with the plan."};
  installToolCall(f, helper, workflowToolNames.guide.direct[0], payload);
  const events = (yield* f.core.team.snapshot(binding)).events;
  let targetRead = false;
  const stopOnParentRead = once((threadId: string) => threadId === "middle" && targetRead, f.stop());
  f.peer.onProjection = threadId => {
    if (threadId === "branch") targetRead = true;
    return stopOnParentRead(threadId);
  };
  // the helper's own call through the authenticated workflow MCP route
  const reply = yield* f.mcp("supervision_guide", payload);
  assert.equal(yield* f.stopped(), true);
  assert.deepEqual(f.peer.log.filter(entry => entry.kind === "http").map(routeOf).slice(-2),
    ["GET /api/orchestration/threads/branch", "GET /api/orchestration/threads/middle"], "the Stop landed during the parent read");
  assert.equal(reply.httpStatus, 200);
  assert.equal(reply.isError, true);
  assert.deepEqual(reply.value, {status: "denied", reason: "guidance_assignment_changed"});
  assert.deepEqual(yield* rows(f.core.sql, "SELECT * FROM supervisor_team_tool_receipts"), []);
  assert.deepEqual(yield* f.core.team.unresolvedRequests(binding), []);
  assert.deepEqual((yield* f.core.team.snapshot(binding)).events, events);
  assert.deepEqual(writes(f), []);
  assert.deepEqual(f.peer.unexpected, []);
}), {timeout: 10_000});

/* Recorded target change (S6b): the escalation of a walk without a route runs in an admission section that rechecks the scope, so
 * a Stop committed during the walk leaves no durable write.
 */
it.live("CT-LIN-01: guide: a Stop committed during the ancestor read of a helper's MCP guide whose target is directly under the main writes no escalation and the guide is denied guidance_assignment_changed", () => Effect.gen(function* () {
  const f = yield* startScenario();
  const binding = yield* f.bindSupervisor;
  // the target's parent is the main, so the main read is the walk's last await and the walk then ends without a route
  const {helper, member, assignment} = yield* seedTeam(f);
  const payload = {supervisorThreadId: helper.thread.id, bindingGeneration: binding.generation, memberEpoch: member.epoch, assignmentRootThreadId: "branch",
    assignmentEpoch: assignment.epoch, operationId: "lin-guide-direct-stop", targetThreadId: "branch", text: "Continue with the plan."};
  installToolCall(f, helper, workflowToolNames.guide.direct[0], payload);
  const before = yield* teamEventRows(f);
  const assessmentBefore = (yield* f.core.team.snapshot(binding)).members.find(value => value.threadId === "helper")?.lastAssessment;
  const order: Array<{step: string; stopped: boolean}> = [];
  let targetRead = false;
  const stopOnParentRead = once((threadId: string) => threadId === mainThreadId && targetRead, Effect.gen(function* () {
    yield* f.stop();
    order.push({step: "stop", stopped: yield* f.stopped()});
  }));
  f.peer.onProjection = threadId => {
    if (threadId === "branch") targetRead = true;
    return stopOnParentRead(threadId);
  };
  // records any escalation write, which runs in the escalation's admission section
  yield* interpose(f.core.team, "escalate", (escalate) => (...args) => Effect.flatMap(f.stopped(), (stopped) => {
    order.push({step: "escalation", stopped});
    return escalate(...args);
  }));
  const reply = yield* f.mcp("supervision_guide", payload);
  assert.equal(yield* f.stopped(), true);
  assert.deepEqual(f.peer.log.filter(entry => entry.kind === "http").map(routeOf).slice(-2),
    ["GET /api/orchestration/threads/branch", "GET /api/orchestration/threads/main"], "the Stop landed during the main read");
  assert.equal(reply.isError, true);
  assert.deepEqual(reply.value, {status: "denied", reason: "guidance_assignment_changed"});
  assert.deepEqual(order, [{step: "stop", stopped: true}], "the Stop commits first and no escalation write starts after it");
  assert.deepEqual(yield* teamEventRows(f), before, "no team event row is written after the Stop");
  assert.equal((yield* f.core.team.snapshot(binding)).members.find(value => value.threadId === "helper")?.lastAssessment, assessmentBefore,
    "the helper's last assessment is unchanged");
  assert.equal((yield* f.binding).supervisionStop!.route, "ui");
  assert.deepEqual(yield* rows(f.core.sql, "SELECT * FROM supervisor_team_tool_receipts"), []);
  assert.deepEqual(yield* f.core.team.unresolvedRequests(binding), []);
  assert.deepEqual(writes(f), []);
  assert.deepEqual(f.peer.unexpected, []);
}), {timeout: 10_000});

it.live("CT-LIN-01: creation: a Stop committed during the fresh main read throws main_conversation_unavailable and launches nothing", () => Effect.gen(function* () {
  const f = yield* startScenario(newRequest);
  let supervisorRead = false;
  const stopOnMainRead = once((threadId: string) => threadId === mainThreadId && supervisorRead, f.stop());
  // the reserved Supervisor reads 404, then the main read is the last await before the guard
  f.peer.onProjection = threadId => {
    if (threadId.startsWith("supervisor-root:")) supervisorRead = true;
    return stopOnMainRead(threadId);
  };
  // ensureBinding is internal and its callers swallow its error
  const failure = yield* Effect.flip(f.core.seams.ensureBinding(projectId, mainThreadId, "main"));
  assert.equal(failure.message, "main_conversation_unavailable");
  assert.equal(yield* f.stopped(), true);
  assert.equal((yield* f.binding).state, "creating");
  assert.equal((yield* f.binding).creationAttempts, 0);
  assert.deepEqual(writes(f), []);
  yield* f.runOnce;
  assert.equal((yield* f.binding).creationAttempts, 0);
  assert.deepEqual(writes(f), [], "a later cycle of the stopped chat launches nothing");
  assert.deepEqual(f.peer.unexpected, []);
}), {timeout: 10_000});

it.live("CT-LIN-01: stopped settlement: an Enable committed during the fresh Supervisor read leaves the settlement unsent", () => Effect.gen(function* () {
  const f = yield* startScenario();
  const binding = yield* f.bindSupervisor;
  yield* f.stop();
  let supervisorReads = 0;
  // check() reads the Supervisor; settleStopped re-reads it last before the guard
  f.peer.onProjection = threadId => threadId === binding.threadId && ++supervisorReads === 2 ? f.enable() : Effect.void;
  yield* f.core.lifecycle.check(yield* f.binding, f.threads);
  assert.equal(supervisorReads, 2);
  assert.equal(yield* f.stopped(), false);
  assert.equal((yield* f.binding).settlement, undefined);
  assert.deepEqual(writes(f), []);
  assert.deepEqual(f.peer.unexpected, []);
}), {timeout: 10_000});

type PolicyProbe = {stopped: boolean; stop: unknown; notice: string | null; enabledAt: number | null; start: string | null};

const observe = (f: Scenario): Effect.Effect<PolicyProbe> => Effect.gen(function* () {
  return {stopped: (yield* f.core.policy.get()).excludedThreadIds.includes(mainThreadId),
    stop: (yield* f.core.store.chatStop(mainThreadId)) ?? null, notice: (yield* f.core.store.binding(projectId, mainThreadId))?.stopNotice?.state ?? null,
    enabledAt: yield* f.core.store.chatEnabledAt(mainThreadId), start: (yield* f.core.store.start(mainThreadId))?.status ?? null};
}).pipe(Effect.orDie);

/* Every policy commit starts a probe on a fiber of its own that yields first, so it observes once the committing fiber yields; its
 * guidance reads queue behind any open guidance transaction, so it observes what a reader can see once the commit's turn yields.
 */
const probePolicyCommits = (f: Scenario) => Effect.gen(function* () {
  const seen: Array<Fiber.Fiber<PolicyProbe>> = [];
  const run = yield* FiberSet.makeRuntime<never, PolicyProbe>();
  yield* interpose(f.core.policy, "save", (save) => (input) =>
    Effect.tap(save(input), () => Effect.sync(() => seen.push(run(Effect.andThen(Effect.yieldNow, observe(f)))))));
  return seen;
});

it.live("CT-LIN-02: each MCP, Settings and dashboard Stop or Enable commit is observed only together with its guidance bookkeeping", () => Effect.gen(function* () {
  const f = yield* startScenario({mainTurns: [oldTurn, {id: "stop-turn", text: "Please stop supervising this chat."}]});
  const binding = yield* f.bindSupervisor;
  const seen = yield* probePolicyCommits(f);
  const policyGeneration = Effect.map(f.core.policy.get(), (policy) => policy.generation);

  // the MCP supervision_stop control
  const stopped = yield* f.core.control.stopSupervision({callerThreadId: binding.threadId, targetThreadId: mainThreadId, userMessageId: "stop-turn",
    operationId: "lin-stop"}, {});
  assert.deepEqual(stopped, {status: "stopped", targetThreadId: mainThreadId, route: "relay", alreadyStopped: false});
  assert.equal(seen.length, 1);
  assert.deepEqual(yield* Fiber.join(seen[0]!), {stopped: true, stop: {route: "relay", callerThreadId: binding.threadId, userMessageId: "stop-turn", stoppedAt: Date.parse(baseTime)},
    notice: "ready", enabledAt: null, start: null});

  // the Settings excluded-chat editor's Enable and Stop
  yield* f.enable();
  assert.equal(seen.length, 2);
  assert.deepEqual(yield* Fiber.join(seen[1]!), {...yield* observe(f), stopped: false, stop: null, notice: "superseded"});
  assert.equal(typeof (yield* Fiber.join(seen[1]!)).enabledAt, "number");
  yield* f.stop();
  assert.equal(seen.length, 3);
  assert.deepEqual(yield* Fiber.join(seen[2]!), {...yield* observe(f), stopped: true, notice: "ready", enabledAt: (yield* Fiber.join(seen[1]!)).enabledAt});
  assert.equal(((yield* Fiber.join(seen[2]!)).stop as {route: string}).route, "ui");

  // the dashboard Enable and Stop
  const enabled = yield* f.core.supervisor.setChatSupervision({projectId, mainThreadId, enabled: true, policyGeneration: yield* policyGeneration});
  assert.equal(enabled.status, "saved");
  assert.equal(seen.length, 4);
  assert.deepEqual(yield* Fiber.join(seen[3]!), {...yield* observe(f), stopped: false, stop: null, notice: "superseded"});
  assert.ok((yield* Fiber.join(seen[3]!)).enabledAt! >= (yield* Fiber.join(seen[1]!)).enabledAt!);
  const stoppedAgain = yield* f.core.supervisor.setChatSupervision({projectId, mainThreadId, enabled: false, policyGeneration: yield* policyGeneration});
  assert.equal(stoppedAgain.status, "saved");
  assert.equal(seen.length, 5);
  assert.deepEqual(yield* Fiber.join(seen[4]!), {...yield* observe(f), stopped: true, notice: "ready", enabledAt: (yield* Fiber.join(seen[3]!)).enabledAt});
  assert.equal(((yield* Fiber.join(seen[4]!)).stop as {route: string}).route, "ui");
}), {timeout: 10_000});

it.live("CT-LIN-02: a dashboard Start activation's policy commit is observed only together with the Enable record and the active Start", () => Effect.gen(function* () {
  const f = yield* startScenario();
  // the project is the managed scratch root, so the chat is a No Project chat activated by Start
  f.core.config.managedScratchRoot = "/work/p";
  const policy = yield* f.core.policy.get();
  yield* f.core.policy.save({...policy, excludedThreadIds: [mainThreadId]});
  yield* f.core.store.saveUnboundStop(mainThreadId, {route: "ui", callerThreadId: null, userMessageId: null, stoppedAt: (yield* Clock.currentTimeMillis) - 60_000});
  const seen = yield* probePolicyCommits(f);
  const result = yield* f.core.supervisor.setChatSupervision({projectId, mainThreadId, enabled: true, policyGeneration: (yield* f.core.policy.get()).generation});
  assert.equal(result.status, "saved");
  const start = (yield* f.core.store.start(mainThreadId))!;
  assert.equal(start.status, "active");
  // the policy write and the bookkeeping share one guidance transaction
  assert.deepEqual(yield* Fiber.joinAll(seen), [{stopped: false, stop: null, notice: null, enabledAt: start.intentAt, start: "active"}]);
}), {timeout: 10_000});

it.live("CT-LIN-03: a dashboard Stop whose notice bookkeeping fails keeps the policy stop; sends stay fenced, a retry conflicts, settlement dates from observation and an MCP replay records the stop", () => Effect.gen(function* () {
  const f = yield* startScenario({mainTurns: [oldTurn, {id: "stop-turn", text: "Please stop supervising this chat."}]});
  const binding = yield* f.bindSupervisor;
  const checkIn = yield* f.core.requests.prepare({projectId, supervisorThreadId: binding.threadId, kind: "review", taskId: null,
    text: "Check in on the current activity.", batch: null, completionMarker: "Supervisor check-in completed"}, yield* Clock.currentTimeMillis);
  let noticeWrites = 0;
  yield* interpose(f.core.store, "setStopNotice", (setStopNotice) => (...args) =>
    Effect.suspend(() => noticeWrites++ === 0 ? Effect.die(new Error("injected_stop_notice_failure")) : setStopNotice(...args)));
  const ui = yield* dashboard(f);
  const path = "/api/guidance/project-supervisor/chat-supervision";
  const generation = (yield* f.core.policy.get()).generation;
  const first = yield* ui.post(path, {projectId, mainThreadId, enabled: false, policyGeneration: generation});
  assert.equal(first.status, 400);
  assert.deepEqual(first.body, {_tag: "UiError", message: "The chat supervision change could not be confirmed. Refresh to inspect the saved state."});
  assert.equal(yield* f.stopped(), true);
  assert.equal((yield* f.core.policy.get()).generation, generation + 1);
  assert.equal((yield* f.binding).supervisionStop, undefined, "the per-binding transaction rolled back");
  assert.equal((yield* f.binding).stopNotice, undefined);

  const retry = yield* ui.post(path, {projectId, mainThreadId, enabled: false, policyGeneration: generation});
  assert.equal(retry.status, 200);
  assert.equal((retry.body as {status: string}).status, "conflict");
  assert.equal((retry.body as {message: string}).message, "Chat settings changed in another tab or by the Supervisor. The saved state is shown.");
  assert.equal(noticeWrites, 1, "the retry does not rerun the bookkeeping");
  assert.equal((yield* f.binding).supervisionStop, undefined);

  yield* f.runOnce;
  const fenced = (yield* requests(f, binding.threadId)).find(request => request.id === checkIn.id)!;
  assert.equal(fenced.state, "failed");
  assert.equal(fenced.error, "Supervision was stopped for this chat before this check-in was sent; it was not sent.");
  assert.equal(yield* f.core.store.task(mainThreadId), null, "the new human request is not interpreted");
  const settled = yield* f.binding;
  assert.equal(typeof settled.stopObservedAt, "number", "without a stop record the settlement dates from its observation");
  assert.equal(settled.settlement?.state, "settled");
  assert.deepEqual(dispatches(f).map(payload => ({type: payload.type, commandId: payload.commandId})),
    [{type: "thread.settle", commandId: settled.settlement!.commandId}], "no message is sent; only the Supervisor is settled");

  // an MCP stop replay finds no recorded stop and reruns the bookkeeping
  const replay = yield* f.core.control.stopSupervision({callerThreadId: binding.threadId, targetThreadId: mainThreadId, userMessageId: "stop-turn",
    operationId: "lin-replay"}, {});
  assert.deepEqual(replay, {status: "stopped", targetThreadId: mainThreadId, route: "relay", alreadyStopped: true});
  assert.equal((yield* f.core.policy.get()).generation, generation + 1, "the replay writes no policy");
  const recorded = yield* f.binding;
  assert.deepEqual(recorded.supervisionStop, {route: "relay", callerThreadId: binding.threadId, userMessageId: "stop-turn", stoppedAt: Date.parse(baseTime)});
  assert.equal(recorded.stopNotice?.state, "ready");
  assert.equal(recorded.stopObservedAt, undefined);
  assert.deepEqual(f.peer.unexpected, []);
}), {timeout: 10_000});

const prepareDashboardEnable = (failEnable: boolean) => Effect.gen(function* () {
  const f = yield* startScenario();
  yield* f.bindSupervisor;
  yield* f.stop();
  const stoppedAt = (yield* f.binding).supervisionStop!.stoppedAt;
  addTurn(f.main, {id: "stopped-turn", text: "Request written while supervision was stopped.", createdAt: new Date(stoppedAt).toISOString()});
  yield* interpose(f.core.store, "recordChatEnable", (recordChatEnable) => (...args) =>
    failEnable ? Effect.die(new Error("injected_enable_failure")) : recordChatEnable(...args));
  const ui = yield* dashboard(f);
  const reply = yield* ui.post("/api/guidance/project-supervisor/chat-supervision", {projectId, mainThreadId, enabled: true,
    policyGeneration: (yield* f.core.policy.get()).generation});
  return {f, reply, stoppedAt};
});

it.live("CT-LIN-03: a dashboard Enable whose bookkeeping fails keeps a stale enable time, so a request written while stopped is interpreted", () => Effect.gen(function* () {
  const failed = yield* prepareDashboardEnable(true);
  assert.equal(failed.reply.status, 400);
  assert.deepEqual(failed.reply.body, {_tag: "UiError", message: "The chat supervision change could not be confirmed. Refresh to inspect the saved state."});
  assert.equal(yield* failed.f.stopped(), false);
  assert.equal(yield* failed.f.core.store.chatEnabledAt(mainThreadId), null);
  assert.equal((yield* failed.f.binding).supervisionStop?.stoppedAt, failed.stoppedAt, "the stop record was not cleared");
  assert.equal((yield* failed.f.binding).stopNotice?.state, "ready", "the notice was not superseded");
  yield* failed.f.runOnce;
  const interpreted = yield* task(failed.f);
  assert.equal(interpreted.sourceMessageId, "stopped-turn");
  assert.equal(interpreted.status, "waiting");
  assert.deepEqual(dispatches(failed.f).map(payload => payload.commandId), [`supervisor-objective:${interpreted.attempt!.attemptId}`]);
}), {timeout: 10_000});

// the independent control owns a separate test scope, so the failed case releases its workers before this setup
it.live("CT-LIN-03: a complete dashboard Enable records its time, so a request written while stopped is not interpreted", () => Effect.gen(function* () {
  const enabled = yield* prepareDashboardEnable(false);
  assert.equal(enabled.reply.status, 200);
  assert.ok((yield* enabled.f.core.store.chatEnabledAt(mainThreadId))! >= enabled.stoppedAt);
  yield* enabled.f.runOnce;
  assert.equal(yield* enabled.f.core.store.task(mainThreadId), null);
  assert.deepEqual(dispatches(enabled.f), []);
}), {timeout: 10_000});

it.live("CT-LIN-04: interpretation: a Stop committed right after the dispatching receipt is fenced by the guard; the task returns to queued unsent", () => Effect.gen(function* () {
  const f = yield* startScenario(newRequest);
  yield* f.bindSupervisor;
  let receipt: TaskRecord | null = null;
  let stopSaved = false;
  /* The receipt write returns, then the Stop is saved before the guard runs: the receipt commits in its own admission section,
   * so the Stop is its own section entered right after it, ahead of the dispatch section.
   */
  yield* interpose(f.core.store, "saveTask", (saveTask) => (value) => Effect.tap(saveTask(value), () => Effect.sync(() => {
    if (value.status === "dispatching" && receipt === null) receipt = value;
  })));
  yield* interpose(f.core.gate, "admit", (admit) => (body) => receipt !== null && !stopSaved
    ? Effect.andThen(Effect.suspend(() => {stopSaved = true;return f.stop();}), admit(body)) : admit(body));
  yield* f.runOnce;
  assert.ok(receipt);
  assert.equal(typeof (receipt as TaskRecord).dispatchedAt, "number");
  const fenced = yield* task(f);
  assert.equal(fenced.id, (receipt as TaskRecord).id);
  assert.equal(fenced.status, "queued");
  assert.equal(fenced.dispatchedAt, null);
  assert.equal(fenced.reason, "Supervision was stopped for this chat before dispatch; this task identity remains unsent.");
  assert.deepEqual(dispatches(f), []);
  assert.deepEqual(writes(f), []);
  assert.deepEqual(f.peer.unexpected, []);
}), {timeout: 10_000});

it.live("CT-LIN-06: interpretation: a Stop committed when the frame arrives keeps the accepted identity, later cycles only observe it", () => Effect.gen(function* () {
  const f = yield* startScenario(newRequest);
  const binding = yield* f.bindSupervisor;
  const {seen, commit} = stopOnArrival(f);
  let runId = "";
  // the peer records the accepted message and starts its run, as T3 does
  f.peer.onRpc = entry => Effect.gen(function* () {
    if (yield* commit(entry)) runId = addDispatchedMessage(yield* f.supervisor, entry.payload);
    return undefined;
  });
  yield* f.runOnce;
  assert.equal(seen.stoppedAtArrival, true);
  const sent = yield* task(f);
  assert.equal(sent.status, "waiting");
  assert.equal(sent.reason, "T3 accepted the interpretation request; waiting for its result.");
  assert.deepEqual(dispatches(f).map(dispatched), [{type: "message.dispatch", commandId: `supervisor-objective:${sent.attempt!.attemptId}`, messageId: sent.messageId,
    threadId: binding.threadId, text: sent.requestText}]);

  f.peer.onRpc = null;
  yield* f.runOnce;
  assert.deepEqual(yield* task(f), sent, "a running native outcome is only observed");
  const run = (yield* f.supervisor).runs.find(value => value.id === runId)!;
  run.status = "completed";
  run.completedAt = new Date().toISOString();
  yield* f.runOnce;
  const closed = yield* task(f);
  assert.equal(closed.id, sent.id);
  assert.equal(closed.supervisorRunId, runId);
  assert.equal(closed.status, "unavailable");
  assert.equal(closed.reason, "Supervision was stopped for this chat; the interpretation result was not applied.");
  assert.deepEqual(dispatches(f).map(payload => ({type: payload.type, commandId: payload.commandId})), [
    {type: "message.dispatch", commandId: `supervisor-objective:${sent.attempt!.attemptId}`},
    yield* assertStopNotice(f),
    {type: "thread.settle", commandId: (yield* f.binding).settlement!.commandId},
  ], "no replay and no new identity; the stopped Supervisor settles once the outcome is known");
  assert.deepEqual(f.peer.unexpected, []);
}), {timeout: 10_000});

it.live("CT-LIN-06: interpretation: a Stop committed when the frame arrives and a lost reply leave the identity uncertain, never resent", () => Effect.gen(function* () {
  const f = yield* startScenario(newRequest);
  yield* f.bindSupervisor;
  const {seen, commit} = stopOnArrival(f);
  f.peer.onRpc = entry => Effect.map(commit(entry), (committed) => committed ? {drop: true} as const : undefined);
  yield* f.runOnce;
  assert.equal(seen.stoppedAtArrival, true);
  const sent = yield* task(f);
  assert.equal(sent.status, "uncertain");
  assert.equal(sent.reason, "Interpretation dispatch is uncertain; retry native access to reconcile the original request identity.");
  assert.deepEqual(dispatches(f).map(payload => payload.commandId), [`supervisor-objective:${sent.attempt!.attemptId}`]);
  f.peer.onRpc = null;
  yield* f.runOnce;
  assert.deepEqual(yield* task(f), sent);
  yield* assertStopNotice(f);
  assert.deepEqual(writes(f), ["orchestration.dispatchCommand:message.dispatch", "orchestration.dispatchCommand:message.dispatch"]);
  assert.equal((yield* f.binding).settlementBlockedBy, "stopped_interpretation_unresolved");
}), {timeout: 10_000});

/* The root check-in's admission section ends once its command is started; its reply is awaited outside it (S6b-CONV-01), so a Stop made
 * while the reply is still held takes the section at once.
 */
it.live("CT-LIN-06 (S6b-CONV-01): root check-in: a dashboard Stop made while the accepted check-in's reply is held commits without waiting for it; the check-in keeps its identity and later cycles match its run without resending", () => Effect.gen(function* () {
  const f = yield* startScenario(newRequest);
  const binding = yield* f.bindSupervisor;
  const {introduction} = yield* seedIntroduction(f, newSource);
  yield* f.core.requests.saveIntroduction({...introduction, state: "sent"});
  const prepared = yield* f.core.requests.prepare({projectId, supervisorThreadId: binding.threadId, kind: "review", taskId: null,
    text: "Check in on the current activity.", batch: null, completionMarker: "Supervisor check-in completed"}, yield* Clock.currentTimeMillis);
  const checkIn = Effect.map(requests(f, binding.threadId), (found) => found.find(request => request.id === prepared.id)!);
  let runId = "";
  // the peer records the accepted message and starts its run, as T3 does, then holds its reply
  const held = yield* holdRpcReply(f, entry => entry.tag === "orchestration.dispatchCommand" && entry.payload.messageId === prepared.messageId,
    entry => Effect.map(f.supervisor, (supervisor) => {runId = addDispatchedMessage(supervisor, entry.payload);}));
  const cycle = yield* Effect.forkChild(f.runOnce);
  yield* Effect.raceFirst(Effect.asVoid(held.arrived),
    Effect.andThen(Fiber.join(cycle), Effect.die(new Error("the cycle ended before the check-in reached the peer"))));
  const sending = yield* checkIn;
  assert.equal(sending.state, "sending");
  assert.equal(typeof sending.sentAt, "number");
  // the dashboard Stop runs its policy write in the admission section the check-in's command was started in
  const saved = yield* Effect.timeoutOption(f.core.supervisor.setChatSupervision({projectId, mainThreadId, enabled: false,
    policyGeneration: (yield* f.core.policy.get()).generation}), "3 seconds").pipe(Effect.orDie);
  assert.ok(Option.isSome(saved), "the Stop committed while the check-in's reply was still held");
  assert.equal(saved.value.status, "saved");
  assert.equal(yield* f.stopped(), true);
  assert.deepEqual(yield* checkIn, sending, "the Stop leaves the started check-in's identity untouched");
  yield* held.release;
  yield* Fiber.join(cycle);
  const sent = yield* checkIn;
  assert.deepEqual(sent, {...sending, state: "waiting"});
  assert.deepEqual(dispatches(f).map(dispatched), [{type: "message.dispatch", commandId: `supervisor-review:${prepared.id}`, messageId: prepared.messageId,
    threadId: binding.threadId, text: prepared.text}]);
  f.peer.onRpc = null;
  yield* f.runOnce;
  assert.deepEqual(yield* requests(f, binding.threadId), [{...sent, runId}]);
  assert.deepEqual(writes(f), ["orchestration.dispatchCommand:message.dispatch"]);
  assert.deepEqual(f.peer.unexpected, []);
}), {timeout: 60_000});

it.live("CT-LIN-06: root check-in: a Stop committed when the frame arrives and a lost reply leave the identity uncertain, never resent", () => Effect.gen(function* () {
  const f = yield* startScenario(newRequest);
  const binding = yield* f.bindSupervisor;
  const {introduction} = yield* seedIntroduction(f, newSource);
  yield* f.core.requests.saveIntroduction({...introduction, state: "sent"});
  const prepared = yield* f.core.requests.prepare({projectId, supervisorThreadId: binding.threadId, kind: "review", taskId: null,
    text: "Check in on the current activity.", batch: null, completionMarker: "Supervisor check-in completed"}, yield* Clock.currentTimeMillis);
  const {seen, commit} = stopOnArrival(f);
  f.peer.onRpc = entry => Effect.map(commit(entry), (committed) => committed ? {drop: true} as const : undefined);
  yield* f.runOnce;
  assert.equal(seen.stoppedAtArrival, true);
  const sent = (yield* requests(f, binding.threadId)).find(request => request.id === prepared.id)!;
  assert.equal(sent.state, "uncertain");
  assert.equal(sent.error, "Supervisor request delivery is uncertain; its original identity is retained and only observed, never resent.");
  f.peer.onRpc = null;
  yield* f.runOnce;
  assert.deepEqual(yield* requests(f, binding.threadId), [sent]);
  assert.deepEqual(dispatches(f).map(payload => payload.commandId), [`supervisor-review:${prepared.id}`]);
}), {timeout: 10_000});

it.live("CT-LIN-06: introduction: a Stop committed when the frame arrives keeps the accepted introduction; later cycles never resend it", () => Effect.gen(function* () {
  const f = yield* startScenario(newRequest);
  yield* f.bindSupervisor;
  const {introduction} = yield* seedIntroduction(f, newSource);
  const {seen, commit} = stopOnArrival(f);
  // the peer queues the introduction after the active run, as T3 does; it completes before the next cycle
  f.peer.onRpc = entry => Effect.map(commit(entry), (committed) => {
    if (committed) addDispatchedMessage(f.main, entry.payload, "completed");
    return undefined;
  });
  yield* f.runOnce;
  assert.equal(seen.stoppedAtArrival, true);
  const accepted = (yield* f.core.requests.introduction(introduction.taskId))!;
  assert.equal(accepted.state, "accepted");
  assert.equal(typeof accepted.acceptedAt, "number");
  assert.deepEqual(accepted.dispatchMode, {type: "queue_after_active"});
  assert.deepEqual(dispatches(f).map(dispatched), [{type: "message.dispatch", commandId: introduction.commandId ?? `supervisor-workflow:${introduction.messageId}`,
    messageId: introduction.messageId, threadId: mainThreadId, text: introduction.text}]);
  f.peer.onRpc = null;
  yield* f.runOnce;
  yield* f.runOnce;
  assert.deepEqual(yield* f.core.requests.introduction(introduction.taskId), accepted);
  // the Stop then produces exactly one operative notice, after the introduction became visible, and the Supervisor settles
  const notice = (yield* f.binding).stopNotice!;
  assert.equal(notice.state, "accepted");
  assert.deepEqual(dispatches(f).map(payload => ({type: payload.type, commandId: payload.commandId, threadId: payload.threadId})), [
    {type: "message.dispatch", commandId: introduction.commandId ?? `supervisor-workflow:${introduction.messageId}`, threadId: mainThreadId},
    {type: "message.dispatch", commandId: notice.commandId, threadId: mainThreadId},
    {type: "thread.settle", commandId: (yield* f.binding).settlement!.commandId, threadId: (yield* f.binding).threadId},
  ]);
  assert.deepEqual(f.peer.unexpected, []);
}), {timeout: 10_000});

it.live("CT-LIN-06: guide: a Stop committed when the steer frame of the helper's MCP guide arrives keeps the accepted guide record and sends no other route", () => Effect.gen(function* () {
  const f = yield* startScenario();
  const binding = yield* f.bindSupervisor;
  const {helper, member, assignment} = yield* seedTeam(f);
  const payload = {supervisorThreadId: helper.thread.id, bindingGeneration: binding.generation, memberEpoch: member.epoch, assignmentRootThreadId: "branch",
    assignmentEpoch: assignment.epoch, operationId: "lin-guide-sent", targetThreadId: "branch", text: "Continue with the plan."};
  installToolCall(f, helper, workflowToolNames.guide.direct[0], payload);
  const {seen, commit} = stopOnArrival(f);
  f.peer.onRpc = entry => Effect.as(commit(entry), undefined);
  // the helper's own call through the authenticated workflow MCP route
  const reply = yield* f.mcp("supervision_guide", payload);
  assert.equal(seen.stoppedAtArrival, true);
  assert.equal(reply.isError, false);
  const result = reply.value as {status: string; operationId: string; targetThreadId: string};
  assert.equal(result.status, "accepted");
  // the answer is the compact receipt; the request identity stays in the team store and the command and message in the native dispatch
  const [pending] = yield* f.core.team.unresolvedRequests(binding);
  const [sent] = dispatches(f);
  assert.equal(sent!.commandId, `${pending!.requestId}:command:0`);
  assert.deepEqual(dispatches(f).map(value => ({...dispatched(value), dispatchMode: value.dispatchMode})), [{type: "message.dispatch",
    commandId: sent!.commandId, messageId: sent!.messageId, threadId: "branch", text: payload.text, dispatchMode: {type: "steer_active", targetRunId: "branch-run"}}]);
  const receipts = Effect.map(rows(f.core.sql, "SELECT document FROM supervisor_team_tool_receipts"), (found) => found.map(value => JSON.parse(String(value.document)) as unknown));
  const accepted = yield* receipts;
  const [record] = accepted as Array<{status: string; operationId: string; targetThreadId: string; routedThreadId: string; requestId: string; commandId: string}>;
  assert.equal(accepted.length, 1);
  assert.deepEqual({status: record!.status, operationId: record!.operationId, targetThreadId: record!.targetThreadId, routedThreadId: record!.routedThreadId}, result,
    "the answer is the stored accepted record's compact receipt");
  assert.equal(record!.requestId, pending!.requestId);
  assert.equal(record!.commandId, sent!.commandId);
  assert.deepEqual((yield* f.core.team.unresolvedRequests(binding)).map(request => ({requestId: request.requestId, state: request.state})),
    [{requestId: pending!.requestId, state: "pending"}]);
  f.peer.onRpc = null;
  yield* f.runOnce;
  assert.deepEqual(yield* receipts, accepted);
  yield* assertStopNotice(f);
  assert.deepEqual(writes(f), ["orchestration.dispatchCommand:message.dispatch", "orchestration.dispatchCommand:message.dispatch"]);
  assert.deepEqual(f.peer.unexpected, []);
}), {timeout: 10_000});

it.live("CT-LIN-06: settlement: a Stop committed when the settle frame arrives keeps the settled identity; later cycles send no other settlement", () => Effect.gen(function* () {
  const f = yield* startScenario();
  const binding = yield* f.bindSupervisor;
  // a closed not-needed task leaves nothing to supervise, so the quiet Supervisor settles
  yield* f.core.store.saveTask({id: "task-done", threadId: mainThreadId, projectId, sourceRunId: `run-${oldTurn.id}`, sourceMessageId: oldTurn.id, sourceOrdinal: 1,
    sourceHash: "not-needed", status: "not_supervised", objective: null, reason: "Supervision is not needed.", updatedAt: yield* Clock.currentTimeMillis, requestText: "",
    supervisorThreadId: binding.threadId, messageId: "supervisor-objective:task-done", supervisorRunId: null, dispatchedAt: null, replayCount: 0});
  const now = yield* Clock.currentTimeMillis;
  yield* atWallClock(now)(f.core.lifecycle.check(yield* f.binding, f.threads));
  assert.equal((yield* f.binding).settlementBlockedBy, "quiet_window");
  const {seen, commit} = stopOnArrival(f);
  f.peer.onRpc = entry => Effect.as(commit(entry), undefined);
  yield* atWallClock(now + SUPERVISOR_SETTLE_QUIET_MS)(f.core.lifecycle.check(yield* f.binding, f.threads));
  assert.equal(seen.stoppedAtArrival, true);
  const settlement = (yield* f.binding).settlement!;
  assert.equal(settlement.state, "settled");
  assert.equal(settlement.attempts, 1);
  assert.deepEqual(dispatches(f).map(payload => ({type: payload.type, commandId: payload.commandId, threadId: payload.threadId})),
    [{type: "thread.settle", commandId: settlement.commandId, threadId: binding.threadId}]);
  f.peer.onRpc = null;
  yield* f.runOnce;
  assert.deepEqual((yield* f.binding).settlement, settlement);
  yield* assertStopNotice(f);
  assert.deepEqual(writes(f), ["orchestration.dispatchCommand:thread.settle", "orchestration.dispatchCommand:message.dispatch"]);
  assert.deepEqual(f.peer.unexpected, []);
}), {timeout: 10_000});

it.live("CT-LIN-06 (CT-INT-03 H5): helper: a Stop committed when the webhook POST arrives keeps the posted delivery; a stopped batch makes no native request and later cycles post nothing", () => Effect.gen(function* () {
  const h = yield* startHelperScenario();
  const {f} = h;
  let stoppedAtArrival: boolean | null = null;
  f.peer.webhook = (_entry, deliveryId) => Effect.gen(function* () {
    yield* f.stop();
    stoppedAtArrival = yield* f.stopped();
    return json(202, {deliveryId});
  });
  yield* runHelperBatch(h);
  assert.equal(stoppedAtArrival, true);
  const request = yield* helperRequest(f);
  assert.equal(request.state, "waiting");
  const receipt = (yield* helperReceipt(f))!;
  assert.equal(receipt.state, "posted");
  assert.equal(receipt.nativeDeliveryId, "native-delivery-1");
  assert.equal(receipt.messageId, request.messageId);
  assert.deepEqual(webhookPosts(f.peer).map(entry => entry.body), [helperDeliveryBody(request.messageId, request.text)]);
  // a later helper batch of the stopped chat returns before any native request
  const traffic = f.peer.log.length;
  yield* runHelperBatch(h);
  assert.equal(f.peer.log.length, traffic, "a stopped helper batch returns at once");
  assert.deepEqual(yield* helperReceipt(f), receipt, "the delivery identity is unchanged");
  assertHelperCredentials(f.peer.log);
  yield* f.runOnce;
  const observed = (yield* helperReceipt(f))!;
  assert.deepEqual({...observed, renderedText: undefined}, {...receipt, renderedText: undefined}, "the stopped cycle binds the rendering only");
  assert.equal(observed.renderedText, publishedWrapper(request.text));
  assert.equal((yield* helperRequest(f)).messageId, request.messageId);
  yield* assertStopNotice(f);
  assert.deepEqual(writes(f), ["scheduledTasks.upsert", `POST ${hookPath}`, "orchestration.dispatchCommand:message.dispatch"]);
  assert.deepEqual(f.peer.unexpected, []);
}), {timeout: 60_000});

/* The page Stops against the real helper transport on the one admission gate: production team runtime -> production helper transport
 * -> platform fetch -> loopback socket. Unlike a Stop committed inside a peer hook while nothing holds the section, these Stops contend
 * for the permit: each case records whether the Stop had committed when it was requested and the order of its commit against the
 * start of the POST.
 */
for (const [route, stop] of [["Settings", settingsStop], ["dashboard", dashboardStop]] as const) {
  it.live(`helper: a ${route} Stop requested while the webhook POST starts inside its admission section waits for that section, commits after it, and no later batch starts another request`, () => Effect.gen(function* () {
    const h = yield* startHelperScenario();
    const {f} = h;
    const scope = yield* Effect.scope;
    const order: string[] = [];
    const submit = yield* stop(f);
    let stopping: Fiber.Fiber<unknown, unknown> | undefined;
    let receiptAtPostStart: unknown;
    let committedWhenRequested: boolean | undefined;
    f.peer.onFetch = (url) => Effect.gen(function* () {
      if (!url.endsWith(hookPath)) return;
      order.push("post-start");
      if (stopping) return;
      // the POST starts inside the send's admission section: the Stop requested here, started at once, cannot take the permit
      stopping = yield* Effect.forkIn(Effect.tap(submit, () => Effect.sync(() => order.push("stop-committed"))), scope, {startImmediately: true});
      /* An admitted Stop is one guidance transaction around its policy write, begun on this turn when nothing holds the permit;
       * this guidance read, issued on this turn too, then answers after that commit, and otherwise before the Stop begins.
       */
      receiptAtPostStart = (yield* helperReceipt(f))?.state;
      committedWhenRequested = yield* policyStops(f);
    });
    yield* runHelperBatch(h);
    assert.ok(stopping, "the POST started");
    assert.equal(receiptAtPostStart, "posting", "the section committed the receipt before the POST started");
    assert.equal(committedWhenRequested, false, "the Stop waited while the send's section owned the POST start");
    yield* Fiber.join(stopping);
    assert.equal(yield* policyStops(f), true, "the Stop committed after the section");
    assert.deepEqual(order, ["post-start", "stop-committed"]);
    assert.equal(webhookPosts(f.peer).length, 1);
    const receipt = (yield* helperReceipt(f))!;
    assert.equal(receipt.state, "posted", "the admitted POST kept its identity and was not cancelled by the Stop");

    // after the confirmed commit, a later batch starts no request at all
    yield* runHelperBatch(h);
    assert.deepEqual(order, ["post-start", "stop-committed"]);
    assert.equal(webhookPosts(f.peer).length, 1);
    assert.deepEqual(yield* helperReceipt(f), receipt);
  }), {timeout: 60_000});
}

it.live("helper (CT-INT-03 H4c): a Settings Stop requested during the transport's own helper read commits at once; the send still lists and upserts the channel, then posts nothing and returns the check-in to prepared", () => Effect.gen(function* () {
  const h = yield* startHelperScenario();
  const {f} = h;
  const scope = yield* Effect.scope;
  let committedDuringRead: boolean | undefined;
  let stateAtStop: string | undefined;
  let stopIndex = -1;
  let stopping: Fiber.Fiber<unknown, unknown> | undefined;
  /* The helper's first read is the runtime's own (a Stop there prepares nothing); the second is the transport's, before its admission
   * section, and the peer answers it when this hook ends.
   */
  f.peer.onProjection = (threadId, read) => threadId !== "helper" || read !== 2 ? Effect.void : Effect.gen(function* () {
    stateAtStop = (yield* helperRequest(f)).state;
    stopping = yield* Effect.forkIn(yield* settingsStop(f), scope, {startImmediately: true});
    // a section held across the read would hold the Stop until this hook lets the peer answer: the bound ends that wait
    const ended = yield* Effect.timeoutOption(Fiber.join(stopping), unheld).pipe(Effect.orDie);
    committedDuringRead = Option.isSome(ended) && (yield* policyStops(f));
    stopIndex = f.peer.log.length - 1;
  });
  let fetches = 0;
  f.peer.onFetch = (url) => Effect.sync(() => {if (url.endsWith(hookPath)) fetches += 1;});
  yield* runHelperBatch(h);
  if (stopping) yield* Fiber.join(stopping);
  assert.equal(committedDuringRead, true, "the Stop did not wait for the send's unrelated network read");
  assert.equal(stateAtStop, "sending", "the Stop lands after the runtime admitted the request to the transport");
  assert.deepEqual(f.peer.log.slice(stopIndex + 1).map(routeOf), ["scheduledTasks.list", "scheduledTasks.upsert"]);
  assert.equal(fetches, 0);
  assert.deepEqual(webhookPosts(f.peer), []);
  assert.equal(yield* helperReceipt(f), null);
  const request = yield* helperRequest(f);
  assert.equal(request.state, "prepared");
  assert.equal(request.sentAt, null);
  assertHelperCredentials(f.peer.log);
  assert.deepEqual(f.peer.unexpected, []);
}), {timeout: 60_000});
