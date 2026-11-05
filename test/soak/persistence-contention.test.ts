import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Clock, Console, Effect } from "effect";
import { readDashboardOverview } from "../../src/project-supervisor.js";
import { workflowToolNames } from "../../src/workflow-write-evidence.js";
import { mcpCall, rows } from "../support/glinint-wiring.js";
import { startInterpretationFixture } from "../support/interpretation-fixture.js";

/*
  A scripted soak (docs/testing.md, execution type 4) and the persistence proposal's one bounded query and contention check: the
  production run on temporary files and a loopback T3 peer, its policy at the excluded-chat cap with a recorded Stop for every
  excluded chat and a pending Start, measured on the wall clock. It reports, without asserting a budget, the dashboard and
  identity reads, policy reads alone and during Stop and Enable writes on the shared connection, a small Stop sample, the cost of
  the policy row's statement beside the store's decoded read, and the query plans of the key policy and meta statements. The same
  file runs once on the wiring before the policy moved into guidance (its policy on a client of its own) and once after, for one
  comparison: 250 ms per operation and a doubling against that earlier run are the proposal's provisional budget, not an SLA.
*/

// ThreadPolicyStore saves at most 500 excluded chats; the seed leaves room for the two chats the measurement stops
const excludedCap = 500;
const samples = 200;
const writeCycles = 30;
const budgetMs = 250;

const round = (ms: number) => Math.round(ms * 1000) / 1000;
const summary = (times: ReadonlyArray<number>) => {
  const sorted = [...times].sort((a, b) => a - b);
  const at = (quantile: number) => sorted[Math.min(sorted.length - 1, Math.floor(quantile * sorted.length))] ?? 0;
  return { n: sorted.length, p50: round(at(0.5)), p95: round(at(0.95)), max: round(sorted.at(-1) ?? 0) };
};
// an effect's wall-clock duration in milliseconds
const timed = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<number, E, R> => Effect.gen(function* () {
  const started = yield* Clock.currentTimeNanos;
  yield* effect;
  return Number((yield* Clock.currentTimeNanos) - started) / 1e6;
});
const sampled = <E, R>(count: number, effect: Effect.Effect<unknown, E, R>) => Effect.gen(function* () {
  const times: Array<number> = [];
  for (let index = 0; index < count; index++) times.push(yield* timed(effect));
  return summary(times);
});

// a no project main's own genuine supervision_start call through the authenticated route, pending until its interpretation
const pendingStart = Effect.gen(function* () {
  const f = yield* startInterpretationFixture({noProject: true});
  f.addRequest("request-start", "Have Supervisor follow this task: add a CSV export.");
  const main = f.main();
  const run = main.runs.find(value => value.userMessageId === "request-start")!;
  const args = {callerThreadId: f.mainThreadId, userMessageId: "request-start", operationId: "own-start"};
  (main.nodes as Array<Record<string, unknown>>).push({id: "start-node", kind: "dynamic_tool", threadId: f.mainThreadId, runId: run.id, rootNodeId: run.rootNodeId,
    parentNodeId: run.rootNodeId, providerThreadId: run.providerThreadId, status: "completed"});
  const item = {id: "start-item", type: "dynamic_tool", threadId: f.mainThreadId, runId: run.id, nodeId: "start-node", providerThreadId: run.providerThreadId,
    parentItemId: null, ordinal: 1, status: "completed", toolName: workflowToolNames.start.direct[1], input: args};
  main.turnItems = [item];
  f.native.details.set(item.id, {...item, nativeItemRef: {driver: "codex", nativeId: "native-start-item", strength: "strong"}, toolNonExecutionKind: null});
  assert.equal(((yield* mcpCall(f.endpoint, "supervision_start", args)).value as {status: string}).status, "pending");
  return f;
});

it.live("policy and Stop statements on the shared guidance connection: one bounded measurement, reported against the provisional budget", () => Effect.gen(function* () {
  const f = yield* pendingStart;
  // the policy at the cap, saved as the Settings editor saves it: every excluded chat gets its recorded Stop
  const initial = yield* f.core.policy.get().pipe(Effect.orDie);
  const excluded = Array.from({length: excludedCap - 2}, (_, index) => `chat-${String(index).padStart(4, "0")}`);
  yield* f.core.control.saveThreadPolicy({...initial, excludedThreadIds: [...initial.excludedThreadIds, ...excluded]}).pipe(Effect.orDie);
  assert.equal((yield* f.core.policy.get().pipe(Effect.orDie)).excludedThreadIds.length, excludedCap - 2);
  const policyInGuidance = (yield* rows(f.core.sql, "SELECT name FROM sqlite_master WHERE type='table' AND name='thread_policy'")).length > 0;

  const catalog = yield* f.core.source.catalog();
  const observedAt = yield* Clock.currentTimeMillis;
  const overview = readDashboardOverview({page: {offset: 0, limit: 50}, catalog, available: true, observedAt}).pipe(Effect.provide(f.core.context), Effect.orDie);
  const reads = {
    dashboardOverview: yield* sampled(50, overview),
    bindings: yield* sampled(samples, f.core.store.bindings().pipe(Effect.orDie)),
    start: yield* sampled(samples, f.core.store.start(f.mainThreadId).pipe(Effect.orDie)),
    chatStop: yield* sampled(samples, f.core.store.chatStop(excluded[0] ?? "").pipe(Effect.orDie)),
    stoppedPredicate: yield* sampled(samples, f.core.scope.supervisionStopped(f.mainThreadId).pipe(Effect.orDie)),
    policyDecoded: yield* sampled(samples, f.core.policy.get().pipe(Effect.orDie)),
    // the statement alone, on the guidance client, once the policy is a guidance row
    policyStatement: policyInGuidance ? yield* sampled(samples, rows(f.core.sql, "SELECT document FROM thread_policy WHERE id=1")) : null,
  };

  /*
   * policy reads while Stop and Enable of one chat alternate: each write is an admission section and a transaction on the shared
   * guidance connection, so a read waiting for it shows as its latency here
   */
  let writing = true;
  const during: Array<number> = [];
  const writes: Array<number> = [];
  const reader = Effect.gen(function* () {
    for (let index = 0; index < samples && writing; index++) {
      during.push(yield* timed(f.core.policy.get().pipe(Effect.orDie)));
      // yield outside the timing span so a saturated reader cannot retake every released permit
      yield* Effect.yieldNow;
    }
  });
  const writer = Effect.gen(function* () {
    for (let cycle = 0; cycle < writeCycles; cycle++) {
      const current = yield* f.core.policy.get().pipe(Effect.orDie);
      const started = yield* Clock.currentTimeNanos;
      const result = yield* f.core.control.setChatPolicy("chat-writer", cycle % 2 === 1, current.generation).pipe(Effect.orDie);
      writes.push(Number((yield* Clock.currentTimeNanos) - started) / 1e6);
      assert.equal(result.status, "saved");
    }
  }).pipe(Effect.ensuring(Effect.sync(() => { writing = false; })));
  yield* Effect.all([reader, writer], {concurrency: 2});

  // the main chat's own Stop with its pending Start, the write the policy move made atomic
  const policy = yield* f.core.policy.get().pipe(Effect.orDie);
  const mainStop = yield* timed(f.core.control.setChatPolicy(f.mainThreadId, false, policy.generation).pipe(Effect.orDie));

  const plan = (statement: string, ...params: ReadonlyArray<unknown>) =>
    Effect.map(rows(f.core.sql, `EXPLAIN QUERY PLAN ${statement}`, ...params), (found) => found.map((row) => String(row.detail)));
  const plans = {
    metaKey: yield* plan("SELECT value FROM meta WHERE key=?", `supervisor_start:${f.mainThreadId}`),
    metaPrefixScan: yield* plan("SELECT key,value FROM meta WHERE key LIKE 'supervisor_unbound_stop:%'"),
    ...(policyInGuidance ? {
      policyRead: yield* plan("SELECT document FROM thread_policy WHERE id=1"),
      policyCompareAndSet: yield* plan("UPDATE thread_policy SET document=? WHERE id=1 AND json_extract(document,'$.generation')=?", "{}", 1),
    } : {}),
  };

  const report = {
    wiring: policyInGuidance ? "policy row in guidance.sqlite3" : "policy in thread-settings.sqlite3 on its own client",
    excludedChats: excludedCap - 2, budgetMs, reads, policyDuringWrites: summary(during), stopAndEnable: summary(writes), mainStopMs: round(mainStop), plans,
    overBudget: [...Object.entries(reads).flatMap(([name, value]) => value !== null && value.p95 > budgetMs ? [name] : []),
      ...(summary(writes).p95 > budgetMs ? ["stopAndEnable"] : []), ...(summary(during).p95 > budgetMs ? ["policyDuringWrites"] : [])],
  };
  yield* Console.log(`persistence contention report ${JSON.stringify(report, null, 2)}`);
  assert.ok(during.length > 0, "policy reads ran while the writes did");
  assert.equal(writes.length, writeCycles);
}), {timeout: 300_000});
