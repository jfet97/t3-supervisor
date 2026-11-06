import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { makeLedger, nativeOver, threadLifecycleSteps, type StepEvidence, type StepName } from "../scripts/t3-cohort.js";
import type { Projection, ThreadInfo } from "../src/types.js";
import { intPeer, json, nativeReadRoutes, nativeReadState, rpcRequests, type PeerRoutes } from "./support/int-native-peer.js";

/*
  The cohort probe's thread lifecycle (scripts/t3-cohort.ts) through the production T3Native, composed as the probe composes it, on
  real loopback sockets to a scripted native peer (test/support/int-native-peer.ts) that answers as a published T3 with no provider
  signed in. Launch, watch, settle, idle Stop and message dispatch are the real typed operations with their receipts and independent
  read-backs. The turn a message starts never ends, as on the current nightly: the idle operations still run and read back
  positively, the message is judged without waiting for that turn, and every command is sent once.
*/

const projectId = "t3-cohort-project";
const at = "2026-11-06T12:00:00.000Z";
const model = {instanceId: "claudeAgent", model: "claude-sonnet-5-5", available: false};

type Script = {
  // the launched thread already has a live turn
  readonly launchedBusy?: boolean;
  // T3 applies the settle and its reply is lost
  readonly settleReplyLost?: boolean;
};

const scriptedT3 = (script: Script) => Effect.gen(function* () {
  const state = nativeReadState();
  state.archivedSequence = () => state.snapshotSequence;
  const commit = (): number => ++state.snapshotSequence;
  // a native turn that stays busy, matching the observed credential-free nightly
  const turn = (projection: Projection, userMessageId: string | null, status: "starting" | "running"): {runId: string; nodeId: string} => {
    const ordinal = projection.runs.length + 1;
    const runId = `${projection.thread.id}-run-${ordinal}`;
    const nodeId = `${projection.thread.id}-root-${ordinal}`;
    const providerThreadId = `${projection.thread.id}-provider`;
    projection.runs.push({id: runId, threadId: projection.thread.id, ordinal, status, requestedAt: at, startedAt: at, completedAt: null,
      rootNodeId: nodeId, userMessageId, providerThreadId} as Projection["runs"][number]);
    (projection.nodes as Array<Record<string, unknown>>).push({id: nodeId, threadId: projection.thread.id, runId, parentNodeId: null, rootNodeId: nodeId,
      kind: "root_turn", status, providerThreadId});
    return {runId, nodeId};
  };
  const t3: PeerRoutes = {
    http: (entry) => entry.method === "GET" && entry.path === "/.well-known/t3/environment"
      ? json(200, {environmentId: "cohort-environment", orchestrationProtocolVersion: 2, serverVersion: "cohort-peer"}) : undefined,
    rpc: (entry) => {
      const threadId = String(entry.payload.threadId);
      const projection = state.projections.get(threadId);
      if (entry.tag === "orchestration.subscribeThread") return projection
        ? {stream: [{kind: "snapshot", snapshotSequence: state.snapshotSequence, projection: structuredClone(projection)}, {kind: "synchronized"}]} : {fail: true};
      if (entry.tag === "orchestration.launchThread") {
        const thread = {id: threadId, title: String(entry.payload.title), projectId: String(entry.payload.projectId), archivedAt: null, deletedAt: null,
          settledAt: null, createdBy: "system", creationSource: "server", lineage: {parentThreadId: null, relationshipToParent: null},
          modelSelection: entry.payload.modelSelection, runtimeMode: "full-access", interactionMode: "default", worktreePath: null} as unknown as ThreadInfo;
        const launched = {thread, runs: [], messages: [], nodes: [], turnItems: [], runtimeRequests: []} as unknown as Projection;
        if (script.launchedBusy) turn(launched, null, "running");
        state.projections.set(threadId, launched);
        state.shellThreads.push({...thread, latestRunId: launched.runs.at(-1)?.id ?? null});
        return {value: {threadId, projection: structuredClone(launched), resumed: false, sequence: commit()}};
      }
      if (entry.tag !== "orchestration.dispatchCommand") return undefined;
      if (projection === undefined) return {fail: true};
      if (entry.payload.type === "thread.settle") {
        projection.thread.settledAt = at;
        projection.thread.settledOverride = "settled";
        for (const row of state.shellThreads) if (row.id === threadId) Object.assign(row, {settledAt: at, settledOverride: "settled"});
        const sequence = commit();
        return script.settleReplyLost ? {drop: true} : {value: {sequence}};
      }
      if (entry.payload.type === "thread.stop") return {value: {sequence: state.snapshotSequence}};
      if (entry.payload.type === "message.dispatch") {
        const messageId = String(entry.payload.messageId);
        const started = turn(projection, messageId, "starting");
        projection.messages.push({id: messageId, threadId, runId: started.runId, nodeId: started.nodeId, role: "user", text: String(entry.payload.text),
          streaming: false, createdAt: at, updatedAt: at, createdBy: String(entry.payload.createdBy), creationSource: String(entry.payload.creationSource),
        } as unknown as Projection["messages"][number]);
        return {value: {sequence: commit()}};
      }
      return undefined;
    },
  };
  return {state, peer: yield* intPeer([t3, nativeReadRoutes(state)])};
});

// the lifecycle steps over the scripted T3, with the report each step wrote and the commands T3 received, in order
const lifecycle = (script: Script = {}) => Effect.gen(function* () {
  const {state, peer} = yield* scriptedT3(script);
  const native = yield* nativeOver(peer.baseUrl, {read: "read-token", operate: "operate-token", projectWrite: "write-token", commit: "commit-token",
    probe: "probe-token"});
  const steps: StepEvidence[] = [];
  let identities = 0;
  const threadId = yield* threadLifecycleSteps({native, ledger: yield* makeLedger, projectId,
    uuid: Effect.sync(() => `00000000-0000-4000-8000-${String(++identities).padStart(12, "0")}`),
    report: (evidence) => Effect.sync(() => {steps.push(evidence);})}, model);
  const step = (name: StepName): StepEvidence => {
    const found = steps.find((item) => item.name === name);
    assert.ok(found, `${name} reported`);
    return found;
  };
  return {state, peer, steps, threadId, step, commands: rpcRequests(peer, "orchestration.dispatchCommand").map((entry) => String(entry.payload.type))};
});

const outcomes = (steps: ReadonlyArray<StepEvidence>) => steps.map((step) => [step.name, step.outcome]);

it.live("the idle settle and Stop meet the launched thread before its message, whose turn never ends and is never awaited", () => Effect.gen(function* () {
  const {state, peer, steps, threadId, step, commands} = yield* lifecycle();
  assert.deepEqual(outcomes(steps), [["thread-launch", "accepted"], ["thread-watch", "accepted"], ["thread-settle", "accepted"],
    ["thread-stop-idle", "accepted"], ["message-dispatch", "accepted"]], JSON.stringify(steps));
  assert.deepEqual(commands, ["thread.settle", "thread.stop", "message.dispatch"], "each command once, the idle ones before the message");
  assert.equal(rpcRequests(peer, "orchestration.launchThread").length, 1, "one owned thread");
  assert.ok(threadId !== null);
  // the turn is still running once every step reported; nothing waited for it
  assert.deepEqual(state.projections.get(threadId)!.runs.map((run) => run.status), ["starting"]);
  assert.ok(step("message-dispatch").elapsedMs < 10_000, `message-dispatch took ${step("message-dispatch").elapsedMs} ms`);
}), {timeout: 30_000});

it.live("a thread that is not idle when read is neither settled nor Stopped, and its message still goes once", () => Effect.gen(function* () {
  const {steps, commands} = yield* lifecycle({launchedBusy: true});
  assert.deepEqual(outcomes(steps), [["thread-launch", "accepted"], ["thread-watch", "accepted"], ["thread-settle", "not-run"],
    ["thread-stop-idle", "not-run"], ["message-dispatch", "accepted"]], JSON.stringify(steps));
  assert.deepEqual(commands, ["message.dispatch"], "no idle-only command reaches a busy thread");
}), {timeout: 30_000});

it.live("a settle whose reply is lost stays uncertain and is never sent again; the idle Stop and the message still run", () => Effect.gen(function* () {
  const {state, threadId, steps, commands} = yield* lifecycle({settleReplyLost: true});
  assert.deepEqual(outcomes(steps), [["thread-launch", "accepted"], ["thread-watch", "accepted"], ["thread-settle", "uncertain"],
    ["thread-stop-idle", "accepted"], ["message-dispatch", "accepted"]], JSON.stringify(steps));
  assert.ok(threadId !== null);
  assert.equal(state.projections.get(threadId)!.thread.settledAt, at, "the applied effect is visible while the lost receipt stays uncertain");
  assert.deepEqual(commands, ["thread.settle", "thread.stop", "message.dispatch"], "the settle is sent once");
}), {timeout: 30_000});
