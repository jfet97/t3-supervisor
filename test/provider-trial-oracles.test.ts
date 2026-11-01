import assert from "node:assert/strict";
import {it} from "@effect/vitest";
import {Effect} from "effect";
import {classifyWorkload, quietTailMs, repeatedContent, trafficContradictions, trafficKind, type NativeRun, type TrafficMessage, type WorkloadObservation,
  type WorkloadScenario} from "../scripts/provider-trial-oracles.js";

/* The oracles of the provider trials that share a substantive workload (scripts/provider-trial-oracles.ts) are pure over everything a
 * trial observed for its budget; the trials themselves run only locally in the signed-in environment (docs/testing.md, execution type 6).
 */

const op = "operative", root = "root", child = "child-a", helper = "helper-a";
const at = (minute: number, second = 0) => new Date(Date.UTC(2026, 10, 1, 18, minute, second)).toISOString();
const ms = (minute: number, second = 0) => Date.UTC(2026, 10, 1, 18, minute, second);
const run = (id: string, status: string, started: number, completed: number | null, userMessageId: string | null = null): NativeRun =>
  ({id, status, requestedAt: at(started), startedAt: at(started), completedAt: completed === null ? null : at(completed), userMessageId});
const message = (id: string, threadId: string, minute: number, runId: string | null = null, textHash: string | null = id): TrafficMessage =>
  ({id, threadId, kind: trafficKind(id, !id.startsWith("supervisor-") && !id.startsWith("guide:"))!, runId, createdAt: at(minute), textHash});
const proposal = message("supervisor-notice:workflow:task-a:rev", op, 2);
const base: WorkloadObservation = {
  operativeThreadId: op,
  supervisors: [{threadId: root, generation: 1, firstSeenAt: ms(1)}],
  helpers: {threadIds: [], ready: [], assigned: [], mostAtOnce: 0, limit: 5},
  task: {id: "task-a", supervision: "needed"},
  traffic: [proposal],
  runs: {[op]: [run("op-1", "completed", 0, 10)], [root]: [run("root-1", "completed", 1, 11)]},
  stopPresses: 0,
  agreement: null,
  children: [],
  monitoring: [],
  monitor: {state: "idle", pendingItems: 0},
  settlements: [],
  compactions: [],
  rootLatestStart: {},
  instructionReads: [],
  writes: [],
  history: [],
  parking: null,
  start: null,
  endedAt: ms(30),
};
const judge = (scenario: WorkloadScenario, overrides: Partial<WorkloadObservation> = {}) => classifyWorkload(scenario, {...base, ...overrides});
const outcome = (scenario: WorkloadScenario, overrides: Partial<WorkloadObservation> = {}) => judge(scenario, overrides).outcome;

it.live("Supervisor's traffic is told apart by the identities Supervisor gives it, and a model's message by its sender", () => Effect.sync(() => {
  const kinds: ReadonlyArray<readonly [string, boolean, string | null]> = [
    ["supervisor-notice:workflow:task-a:rev", false, "proposal"], ["supervisor-notice:workflow:task-a:queue", false, "proposal"],
    ["supervisor-notice:stop:s1", false, "stop"], ["supervisor-notice:compaction:c1", false, "compaction"], ["supervisor-review:r1", false, "check-in"],
    ["supervisor-objective:task-a", false, "interpretation"], ["supervisor-task-revision:v1", false, "interpretation"],
    ["supervisor-planning:a1:hold:h", false, "planning"], ["supervisor-team-notice:n1:attempt:0", false, "team-notice"],
    ["guide:abc:message:0", false, "guide"], ["supervisor-settle-like", false, "service"], ["message-1", true, "contact"], ["message-1", false, null],
  ];
  for (const [id, fromSupervisor, kind] of kinds) assert.equal(trafficKind(id, fromSupervisor), kind, id);
  assert.equal(trafficKind("message-1", true, true), "coordination", "a root's message to its own helper");
  assert.equal(trafficKind("supervisor-review:r1", false, true), "check-in", "an identity Supervisor gave decides first");
}));

it.live("the shared traffic rules fail repeats, misplaced or doubled reminders and overlapping check-ins, and nothing else", () => Effect.sync(() => {
  const context = {operativeThreadId: op, supervisorThreadIds: [root], runs: base.runs, stopPresses: 0};
  const contradictions = (messages: ReadonlyArray<TrafficMessage>, overrides: Partial<typeof context> = {}) => trafficContradictions(messages, {...context, ...overrides});
  assert.deepEqual(contradictions([proposal, message("supervisor-notice:workflow:task-a:rev2", op, 6)]), [], "a revised proposal has its own text");
  assert.equal(contradictions([proposal, message("supervisor-notice:workflow:task-a:queue", op, 3, null, proposal.textHash)]).length, 1, "one proposal twice");
  // a model's plain contact repeated under two identities is ambiguous: a diagnostic, never a contradiction
  const repeatedPlain = [message("m1", op, 3, null, "same"), message("m2", op, 4, null, "same")];
  assert.deepEqual(contradictions(repeatedPlain), [], "a repeated plain contact");
  assert.deepEqual(repeatedContent(repeatedPlain), [{threadId: op, ids: ["m1", "m2"]}]);
  assert.deepEqual(repeatedContent([message("m1", op, 3, null, "same"), message("m2", child, 4, null, "same")]), [], "the same delta to another thread");
  // a text T3 did not show is unknown and never matches another
  assert.deepEqual(repeatedContent([message("m1", op, 3, null, null), message("m2", op, 4, null, null)]), [], "two unknown texts");
  assert.deepEqual(contradictions([proposal, message("supervisor-notice:workflow:task-a:queue", op, 3, null, null),
    message("supervisor-notice:workflow:task-a:retry:1", op, 4, null, null)]), [], "proposal notices whose texts are unknown");
  assert.equal(contradictions([message("guide:g1:message:0", child, 3), message("guide:g1:message:1", op, 4)]).length, 1, "one guide request twice");
  assert.equal(contradictions([message("supervisor-team-notice:n1:attempt:0", helper, 3), message("supervisor-team-notice:n1:attempt:1", helper, 4)]).length, 1);
  assert.equal(contradictions([message("supervisor-notice:stop:s1", op, 3)]).length, 1, "a Stop notice without a Stop");
  assert.deepEqual(contradictions([message("supervisor-notice:stop:s1", op, 3)], {stopPresses: 1}), []);
  assert.equal(contradictions([message("supervisor-notice:stop:s1", op, 3), message("supervisor-notice:stop:s2", op, 4)], {stopPresses: 1}).length, 1);
  assert.equal(contradictions([message("supervisor-notice:compaction:c1", op, 3, "op-1")]).length, 1, "a reminder outside the root");
  assert.equal(contradictions([message("supervisor-notice:compaction:c1", root, 3, "root-1"), message("supervisor-notice:compaction:c2", root, 4, "root-1", "c")]).length, 1,
    "two reminders in one root run");
  assert.deepEqual(contradictions([message("supervisor-notice:compaction:c1", root, 3, "root-1"), message("supervisor-notice:compaction:c2", root, 9, "root-2", "c")]), [],
    "one reminder in each of two runs");
  // one durable service request per Supervisor: the next check-in only after the previous one's own run ended
  const checkIns = [message("supervisor-review:r1", root, 3), message("supervisor-review:r2", root, 8)];
  const runs = (first: NativeRun) => ({...base.runs, [root]: [first]});
  assert.deepEqual(contradictions(checkIns, {runs: runs(run("root-1", "completed", 3, 7, "supervisor-review:r1"))}), []);
  assert.equal(contradictions(checkIns, {runs: runs(run("root-1", "completed", 3, 9, "supervisor-review:r1"))}).length, 1, "the next check-in before the run ended");
  assert.equal(contradictions(checkIns, {runs: runs(run("root-1", "running", 3, null, "supervisor-review:r1"))}).length, 1, "the run is still open");
  assert.deepEqual(contradictions(checkIns, {runs: runs(run("root-1", "completed", 3, 9, "another"))}), [], "a check-in whose run is unknown is not judged");
}));

it.live("negotiation passes only on an agreement recorded from the operative's own reply after the proposal", () => Effect.sync(() => {
  const agreement = (role: string | null, minute: number, senderThreadId: string | null = null) => ({proposalId: "p1", agentMessageId: "reply-1",
    message: {role, createdAt: at(minute), senderThreadId}});
  assert.equal(outcome("negotiation", {agreement: agreement("assistant", 5)}), "pass");
  assert.equal(outcome("negotiation", {agreement: agreement("user", 5)}), "fail", "a user message is not the operative's agreement");
  assert.equal(outcome("negotiation", {agreement: agreement("assistant", 5, root)}), "fail", "a relayed message is not the operative's own");
  assert.equal(outcome("negotiation", {agreement: agreement("assistant", 1)}), "fail", "an agreement before the proposal");
  assert.equal(outcome("negotiation", {agreement: agreement("assistant", 5), traffic: [proposal, {...proposal, id: "supervisor-notice:workflow:task-a:queue"}]}), "fail",
    "the introduction delivered twice");
  const open: ReadonlyArray<readonly [string, Partial<WorkloadObservation>]> = [
    ["no agreement within the budget", {}],
    ["its message never shown", {agreement: {proposalId: "p1", agentMessageId: "reply-1", message: null}}],
    ["no creation time", {agreement: {proposalId: "p1", agentMessageId: "reply-1", message: {role: "assistant", createdAt: null, senderThreadId: null}}}],
    ["not needed", {task: {id: "task-a", supervision: "not_needed"}, traffic: []}],
    ["no proposal", {traffic: []}],
    ["nothing decided", {task: null, traffic: []}],
  ];
  for (const [why, overrides] of open) assert.equal(outcome("negotiation", overrides), "inconclusive", why);
}));

it.live("message volume passes only once the whole supervised work ended within the shared traffic rules", () => Effect.sync(() => {
  assert.equal(outcome("message-volume"), "pass");
  assert.equal(outcome("message-volume", {runs: {...base.runs, [op]: [run("op-1", "running", 0, null)]}}), "inconclusive", "the operative still working");
  assert.equal(outcome("message-volume", {runs: {...base.runs, [root]: [run("root-1", "running", 1, null)]}}), "inconclusive", "Supervisor still working");
  assert.equal(outcome("message-volume", {monitor: {state: "busy", pendingItems: 2}}), "inconclusive", "a check-in outstanding");
  // a model's plain contact repeated with the same text cannot be told from a deliberate repeat without its operation's identity
  const repeated = [proposal, message("m1", op, 5, null, "x"), message("m2", op, 6, null, "x")];
  assert.equal(outcome("message-volume", {traffic: repeated}), "inconclusive", "a repeated plain contact");
  assert.equal(outcome("message-volume", {traffic: [proposal, message("m1", op, 5, null, null), message("m2", op, 6, null, null)]}), "pass",
    "two contacts whose texts T3 did not show");
  assert.equal(outcome("negotiation", {traffic: repeated, agreement: {proposalId: "p1", agentMessageId: "reply-1",
    message: {role: "assistant", createdAt: at(7), senderThreadId: null}}}), "pass", "no failure of another scenario either");
  // settlement waits for the whole scope to be quiet
  assert.equal(outcome("message-volume", {settlements: [{threadId: root, settledAt: at(5)}]}), "fail", "parked while the operative's run was open");
  assert.equal(outcome("message-volume", {settlements: [{threadId: root, settledAt: at(12)}]}), "pass");
  assert.equal(outcome("message-volume", {settlements: [{threadId: root, settledAt: at(5)}], stopPresses: 1,
    traffic: [proposal, message("supervisor-notice:stop:s1", op, 4)]}), "pass", "a human Stop settles at once");
}));

it.live("active children passes on a delegated child that ran and that Supervisor read or assessed", () => Effect.sync(() => {
  const children = [{threadId: child, lineageVerified: true, lineageKnown: true}];
  const runs = {...base.runs, [child]: [run("child-1", "completed", 3, 6)]};
  assert.equal(outcome("active-children", {children, runs, monitoring: [{actorThreadId: root, targetThreadId: child, at: ms(4), kind: "read"}]}), "pass");
  assert.equal(outcome("active-children", {children, runs, helpers: {...base.helpers, threadIds: [helper]},
    monitoring: [{actorThreadId: helper, targetThreadId: child, at: ms(7), kind: "assessment"}]}), "pass", "a helper's assessment");
  const open: ReadonlyArray<readonly [string, Partial<WorkloadObservation>]> = [
    ["no child", {}],
    ["a child whose lineage was never verified", {children: [{threadId: child, lineageVerified: false, lineageKnown: false}], runs}],
    ["a child that never ran", {children}],
    ["no read of it", {children, runs}],
    ["only a read before it ran", {children, runs, monitoring: [{actorThreadId: root, targetThreadId: child, at: ms(2), kind: "read"}]}],
    ["a read by a thread that is not Supervisor's", {children, runs, monitoring: [{actorThreadId: op, targetThreadId: child, at: ms(4), kind: "read"}]}],
  ];
  for (const [why, overrides] of open) assert.equal(outcome("active-children", overrides), "inconclusive", why);
  assert.equal(outcome("active-children", {children, runs: {...runs, [op]: [run("op-1", "completed", 0, 2)]}, settlements: [{threadId: root, settledAt: at(4)}]}),
    "fail", "parked while the child ran");
}));

it.live("sustained monitoring passes on the agreed work watched to its end, then a parked Supervisor quiet for the rest of the budget", () => Effect.sync(() => {
  const agreement = {proposalId: "p1", agentMessageId: "reply-1", message: {role: "assistant", createdAt: at(4), senderThreadId: null}};
  const watched: Partial<WorkloadObservation> = {agreement, monitoring: [{actorThreadId: root, targetThreadId: op, at: ms(5), kind: "read"},
    {actorThreadId: root, targetThreadId: op, at: ms(11), kind: "assessment"}], settlements: [{threadId: root, settledAt: at(12)}]};
  assert.equal(outcome("sustained-monitoring", watched), "pass");
  assert.equal(outcome("sustained-monitoring", {...watched, traffic: [proposal, message("supervisor-review:r9", root, 13)]}), "fail", "a check-in after parking");
  assert.equal(outcome("sustained-monitoring", {...watched, runs: {...base.runs, [root]: [run("root-1", "completed", 1, 11), run("root-2", "completed", 14, 15)]}}),
    "fail", "the parked root ran again");
  const open: ReadonlyArray<readonly [string, Partial<WorkloadObservation>]> = [
    ["no agreement", {...watched, agreement: null}],
    ["one look only", {...watched, monitoring: [{actorThreadId: root, targetThreadId: op, at: ms(11), kind: "read"}]}],
    ["the last run unread", {...watched, monitoring: [{actorThreadId: root, targetThreadId: op, at: ms(5), kind: "read"},
      {actorThreadId: root, targetThreadId: op, at: ms(8), kind: "read"}]}],
    ["not parked", {...watched, settlements: []}],
    ["parked before the work ended", {...watched, runs: {...base.runs, [op]: [run("op-1", "completed", 0, 10), run("op-2", "completed", 13, 14)]}}],
    ["a quiet tail too short", {...watched, endedAt: ms(12) + quietTailMs - 1}],
    ["activity still pending", {...watched, monitor: {state: "idle", pendingItems: 1}}],
    ["still working", {...watched, runs: {...base.runs, [op]: [run("op-1", "running", 0, null)]}, settlements: []}],
  ];
  for (const [why, overrides] of open) assert.equal(outcome("sustained-monitoring", overrides), "inconclusive", why);
}));

it.live("compaction passes only on a root compaction its root recovered from: its instructions read again and its own watch going on", () => Effect.sync(() => {
  const compacted: Partial<WorkloadObservation> = {compactions: [{threadId: root, itemId: "item-c", runId: "root-1", status: "completed", completedAt: at(8)}],
    rootLatestStart: {[root]: at(9)}};
  const reread = {instructionReads: [{threadId: root, startedAt: at(9)}]};
  const watch = (actorThreadId: string, minute: number) => ({monitoring: [{actorThreadId, targetThreadId: op, at: ms(minute), kind: "read" as const}]});
  // a completed compaction and a later start, with no reread and no watch after it, is no recovery
  assert.equal(outcome("compaction", compacted), "inconclusive", "a later start alone");
  assert.equal(outcome("compaction", {...compacted, ...reread}), "inconclusive", "the instructions read again, the watch not seen going on");
  assert.equal(outcome("compaction", {...compacted, ...watch(root, 10)}), "inconclusive", "the watch going on, the instructions not read again");
  assert.equal(outcome("compaction", {...compacted, instructionReads: [{threadId: root, startedAt: at(7)}], ...watch(root, 10)}), "inconclusive",
    "the instructions read only before the compaction");
  assert.equal(outcome("compaction", {...compacted, ...reread, ...watch(root, 7)}), "inconclusive", "a read only before the compaction");
  assert.equal(outcome("compaction", {...compacted, ...reread, helpers: {...base.helpers, threadIds: [helper]}, ...watch(helper, 10)}), "inconclusive",
    "a helper's read is not the compacted root going on");
  // recovered: the reread and the root's own read, completed check-in or workflow progress after the compaction
  assert.equal(outcome("compaction", {...compacted, ...reread, ...watch(root, 10)}), "pass");
  const checkIn = {traffic: [proposal, message("supervisor-review:r2", root, 10)]};
  assert.equal(outcome("compaction", {...compacted, ...reread, ...checkIn,
    runs: {...base.runs, [root]: [run("root-1", "completed", 1, 8), run("root-2", "completed", 10, 11, "supervisor-review:r2")]}}), "pass", "a check-in it completed");
  assert.equal(outcome("compaction", {...compacted, ...reread, ...checkIn,
    runs: {...base.runs, [root]: [run("root-1", "completed", 1, 8), run("root-2", "running", 10, null, "supervisor-review:r2")]}}), "inconclusive",
    "a check-in it has not completed");
  assert.equal(outcome("compaction", {...compacted, ...reread, writes: [{threadId: root, itemId: "w1", runId: "root-2", startedAt: at(10),
    completedAt: at(10, 30), operationId: "op-a", receipt: {status: "applied", hash: "h1"}}], history: [{operationId: "op-a", recordedAt: ms(10, 10)}]}), "pass",
    "workflow progress it wrote");
  // a reminder is never required, and the shared reminder rules still fail
  assert.equal(outcome("compaction", {...compacted, traffic: [proposal, message("supervisor-notice:compaction:c1", op, 7, "op-1")]}), "fail", "a reminder to the operative");
  assert.equal(outcome("compaction", {...compacted, traffic: [proposal, message("supervisor-notice:compaction:c1", root, 7, "root-1"),
    message("supervisor-notice:compaction:c2", root, 8, "root-1", "c2")]}), "fail", "two reminders in one run");
  assert.equal(outcome("compaction"), "inconclusive", "no compaction happened");
  assert.equal(outcome("compaction", {...reread, ...watch(root, 10), compactions: [{threadId: op, itemId: "item-o", runId: "op-1", status: "completed",
    completedAt: at(8)}]}), "inconclusive", "only the operative compacted");
}));

it.live("idle parking passes on a settlement after the quiet window, a parked Supervisor through the hold and the same one woken by the follow-up", () => Effect.sync(() => {
  const parking = {threadId: root, generation: 1, after: ms(12, 20), seenAt: ms(12, 30), settledAt: at(12, 25),
    followUp: {sentAt: ms(15), messageId: "provider-trial:follow-up", answer: "accepted", createdAt: at(15)}};
  const resumed = {...base.runs, [root]: [run("root-1", "completed", 1, 11), run("root-2", "completed", 15, 16)]};
  assert.equal(outcome("idle-parking", {parking, runs: resumed}), "pass");
  // judged at T3's settlement time, never at the look that showed it: the root's own run ended at 11:00 and T3 settled it at 11:20,
  // although the trial first saw that only at 12:30
  assert.equal(outcome("idle-parking", {parking: {...parking, after: ms(11, 10), seenAt: ms(12, 30), settledAt: at(11, 20)}, runs: resumed}), "fail",
    "settled 20 s after the root's last run, inside the quiet window");
  assert.equal(outcome("idle-parking", {parking: {...parking, after: ms(11, 10), seenAt: ms(12, 30), settledAt: at(12, 1)}, runs: resumed}), "pass",
    "settled 61 s after it");
  assert.equal(outcome("idle-parking", {parking, runs: resumed, traffic: [proposal, message("supervisor-review:r9", root, 13)]}), "fail", "woke before any human message");
  assert.equal(outcome("idle-parking", {parking, runs: resumed, supervisors: [...base.supervisors, {threadId: "root-b", generation: 1, firstSeenAt: ms(16)}]}),
    "fail", "the follow-up went to another Supervisor");
  assert.equal(outcome("idle-parking", {parking, runs: resumed, supervisors: [...base.supervisors, {threadId: root, generation: 2, firstSeenAt: ms(16)}]}),
    "fail", "the follow-up went to a new generation");
  const open: ReadonlyArray<readonly [string, Partial<WorkloadObservation>]> = [
    ["never parked", {}],
    ["the budget ended before the follow-up", {parking: {...parking, followUp: null}}],
    ["the follow-up never shown", {parking: {...parking, followUp: {...parking.followUp, createdAt: null}}, runs: resumed}],
    ["the Supervisor did not run again", {parking}],
    ["no settlement time", {parking: {...parking, settledAt: "not a time"}, runs: resumed}],
    ["a descendant whose lineage is unknown", {parking, runs: resumed, children: [{threadId: child, lineageVerified: false, lineageKnown: false}]}],
    ["a finished run without its completion time", {parking, runs: {...resumed, [op]: [{...run("op-1", "completed", 0, 10), completedAt: null}]}}],
  ];
  for (const [why, overrides] of open) assert.equal(outcome("idle-parking", overrides), "inconclusive", why);
}));

it.live("helpers pass on one recruited within the limit, ready with an assignment and checked in", () => Effect.sync(() => {
  const team = {threadIds: [helper], ready: [helper], assigned: [helper], mostAtOnce: 1, limit: 5};
  assert.equal(outcome("helpers", {helpers: team, traffic: [proposal, message("supervisor-review:h1", helper, 6)]}), "pass");
  assert.equal(outcome("helpers", {helpers: {...team, mostAtOnce: 6}}), "fail", "more helpers than the limit");
  assert.equal(outcome("helpers", {helpers: team, traffic: [proposal, message("supervisor-team-notice:n1:attempt:0", helper, 6),
    message("supervisor-team-notice:n1:attempt:1", helper, 7)]}), "fail", "a notification delivered twice");
  assert.equal(outcome("helpers"), "inconclusive", "no helper");
  assert.equal(outcome("helpers", {helpers: {...team, ready: []}}), "inconclusive", "never ready");
  assert.equal(outcome("helpers", {helpers: team}), "inconclusive", "never checked in");
}));

it.live("guides pass on one guide steered into a running delegated child, never outside the operative's scope", () => Effect.sync(() => {
  const children = [{threadId: child, lineageVerified: true, lineageKnown: true}];
  const runs = {...base.runs, [child]: [run("child-1", "running", 3, null)]};
  assert.equal(outcome("guides", {children, runs, traffic: [proposal, message("guide:g1:message:0", child, 5, "child-1")]}), "pass");
  // outside is decided: a descendant read and shown outside the scope, or Supervisor's own helper
  assert.equal(outcome("guides", {children: [...children, {threadId: "elsewhere", lineageVerified: false, lineageKnown: true}], runs,
    traffic: [proposal, message("guide:g1:message:0", "elsewhere", 5, "x-1")]}), "fail", "a descendant shown outside the scope");
  assert.equal(outcome("guides", {children, runs, helpers: {...base.helpers, threadIds: [helper]},
    traffic: [proposal, message("guide:g1:message:0", helper, 5, "h-1")]}), "fail", "Supervisor's own helper");
  // unknown is no failure: a descendant the trial could not read, or a thread it never found
  assert.equal(outcome("guides", {children: [{threadId: child, lineageVerified: false, lineageKnown: false}], runs,
    traffic: [proposal, message("guide:g1:message:0", child, 5, "child-1")]}), "inconclusive", "a descendant whose lineage is unknown");
  assert.equal(outcome("guides", {children, runs, traffic: [proposal, message("guide:g1:message:0", "elsewhere", 5, "x-1")]}), "inconclusive",
    "a thread the trial never found");
  assert.equal(outcome("guides", {children, runs, traffic: [proposal, message("guide:g1:message:0", child, 5, "child-1"), message("guide:g1:message:1", op, 6)]}),
    "fail", "one guide delivered twice");
  assert.equal(outcome("guides"), "inconclusive", "no guide");
  assert.equal(outcome("guides", {children, runs: {...runs, [child]: [run("child-1", "completed", 3, 4)]},
    traffic: [proposal, message("guide:g1:message:0", child, 5, "child-1")]}), "inconclusive", "the child's run had ended");
}));

it.live("a root's workflow_write passes when applied within its own native call, and one operation never has two receipts", () => Effect.sync(() => {
  const call = (itemId: string, hash: string | null, started: number, completed: number) => ({threadId: root, itemId, runId: "root-1", startedAt: at(started),
    completedAt: at(completed), operationId: "op-a", receipt: hash === null ? null : {status: "applied", hash}});
  assert.equal(outcome("workflow-write", {writes: [call("w1", "h1", 5, 6)], history: [{operationId: "op-a", recordedAt: ms(5, 30)}]}), "pass");
  assert.equal(outcome("workflow-write", {writes: [call("w1", null, 3, 4), call("w2", "h1", 5, 6)], history: [{operationId: "op-a", recordedAt: ms(5, 30)}]}), "pass",
    "a pending first write and its identical retry");
  assert.equal(outcome("workflow-write", {writes: [call("w1", "h1", 5, 6), call("w2", "h2", 7, 8)]}), "fail", "two different receipts for one operation");
  assert.equal(outcome("workflow-write", {writes: [call("w1", "h1", 5, 6)], history: [{operationId: "op-a", recordedAt: ms(0, 30)}]}), "fail",
    "recorded before the root's run started");
  assert.equal(outcome("workflow-write"), "inconclusive", "no write");
  assert.equal(outcome("workflow-write", {writes: [call("w1", null, 5, 6)]}), "inconclusive", "no readable receipt");
  assert.equal(outcome("workflow-write", {writes: [call("w1", "h1", 5, 6)], history: [{operationId: "op-a", recordedAt: ms(7)}]}), "inconclusive",
    "the history falls outside the call");
  assert.equal(outcome("workflow-write", {writes: [{...call("w1", "h1", 5, 6), threadId: op}]}), "inconclusive", "the operative's call is not the root's");
  // a receipt read from T3's full record of the call counts as the call's own, and says so; no receipt anywhere is no pass
  const detail = judge("workflow-write", {writes: [{...call("w1", "h1", 5, 6), receiptSource: "detail"}], history: [{operationId: "op-a", recordedAt: ms(5, 30)}]});
  assert.equal(detail.outcome, "pass");
  assert.equal(outcome("workflow-write", {writes: [call("w1", null, 5, 6)], history: [{operationId: "op-a", recordedAt: ms(5, 30)}]}), "inconclusive",
    "history alone, without a receipt from the projection or the full record, is no pass");
}));

it.live("the uncoached No Project Start passes on the active Start, one interpretation and its verdict carried out", () => Effect.sync(() => {
  const start = {pressed: {answer: "active", status: "active"}, runEndedFirst: false};
  const interpretation = message("supervisor-objective:task-a", root, 1);
  assert.equal(outcome("no-project-start", {start, traffic: [interpretation, proposal]}), "pass");
  assert.equal(outcome("no-project-start", {start, task: {id: "task-a", supervision: "not_needed"}, traffic: [interpretation]}), "pass", "a not-needed verdict contacts nobody");
  const open: ReadonlyArray<readonly [string, Partial<WorkloadObservation>]> = [
    ["the request's run ended first", {start: {pressed: null, runEndedFirst: true}}],
    ["never pressed", {start: {pressed: null, runEndedFirst: false}}],
    ["denied", {start: {pressed: {answer: "denied", status: null}, runEndedFirst: false}}],
    ["no decision", {start, task: null, traffic: [interpretation]}],
    ["two interpretations", {start, traffic: [interpretation, message("supervisor-objective:task-a:1:x", root, 3), proposal]}],
    ["needed, no proposal yet", {start, traffic: [interpretation]}],
  ];
  for (const [why, overrides] of open) assert.equal(outcome("no-project-start", overrides), "inconclusive", why);
}));
