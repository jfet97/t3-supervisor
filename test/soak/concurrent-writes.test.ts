import assert from "node:assert/strict";
import { join } from "node:path";
import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Clock, Console, Effect, Redacted } from "effect";
import { checkoutInputs } from "../../scripts/local-run.js";
import { forgeDashboardToken } from "../../src/service-auth.js";
import type { SupervisionControlInfo } from "../../src/supervisor-control-contract.js";
import { repositoryRoot, tsxLoader } from "../support/cli-process.js";
import { supervisorHarness, waitUntilReady } from "../support/g8-cli.js";
import { httpJson } from "../support/glinint-wiring.js";

/*
  A scripted soak (docs/testing.md, execution type 4): the production Supervisor process runs its supervision cycle against a
  loopback fake T3 while several writers keep saving the master supervision switch through the dashboard API on the wall clock,
  each against the generation it read last. Every save is one compare-and-set transaction of the guidance store beside the
  cycle's own writes, so through the window none may meet a busy database or contend with itself: every answer is saved or a
  conflict with a newer generation, the switch's generation advanced by exactly the saves, the process never logged a busy
  database and it is ready at the end. Workflow MCP writes reach the same store in the same process but need native proofs that
  the fake T3 cannot give; the replay suite owns them.
*/

const writers = 4;
/* The src/guidance-application.ts runs its supervision cycle and its binding transaction every 5 s and src/supervisor.ts its maintenance
 * every 30 s: the window spans two maintenance periods and so a dozen of each cycle; SOAK_WRITE_MS asks for a longer one.
 */
const windowMs = Math.max(Number(process.env.SOAK_WRITE_MS ?? 0) || 0, 2 * 30_000);

it.live(`${writers} writers saving the master switch for ${Math.round(windowMs / 1000)} s beside the supervision cycle never meet a busy database or lose a save`,
  () => Effect.gen(function* () {
    const harness = yield* supervisorHarness({activeThreads: 1, archiveThreads: 1});
    const child = yield* harness.start(process.execPath, ["--import", tsxLoader, join(repositoryRoot, "src", "main.ts")]);
    yield* waitUntilReady(harness, child);
    // a signed-in dashboard session with its CSRF token, as the page holds them
    const origin = `http://127.0.0.1:${harness.ports.ui}`;
    const forged = yield* forgeDashboardToken(harness.dataDirectory).pipe(Effect.orDie);
    const login = yield* httpJson(`${origin}/auth/login`, {method: "POST", headers: {Origin: origin}, body: {token: Redacted.value(forged.token)}});
    assert.equal(login.status, 200);
    const session = {"x-supervisor-session": (login.body as {session: string}).session};
    const csrf = ((yield* httpJson(`${origin}/api/csrf`, {headers: session})).body as {csrf: string}).csrf;
    const read = Effect.map(httpJson(`${origin}/api/guidance/supervision-control`, {headers: session}), (reply) => {
      assert.equal(reply.status, 200, JSON.stringify(reply.body));
      return reply.body as SupervisionControlInfo;
    });
    const initial = yield* read;
    /* Each answer's status (the save's own, or the HTTP status of a refused or failed request) counted, and the first answer that
     * was neither saved nor a conflict kept whole, so a failure stays bounded however long the window.
     */
    const counts: Record<string, number> = {};
    let firstUnexpected: {readonly status: string; readonly body: string} | null = null;
    const started = yield* Clock.currentTimeMillis;
    const writer = Effect.gen(function* () {
      while ((yield* Clock.currentTimeMillis) - started < windowMs) {
        const current = yield* read;
        const reply = yield* httpJson(`${origin}/api/guidance/supervision-control`, {method: "POST", headers: {Origin: origin, ...session, "x-csrf-token": csrf},
          body: {projectId: null, expectedGeneration: current.generation, enabled: !current.enabled}});
        const status = reply.status === 200 ? String((reply.body as {status?: unknown}).status) : `HTTP ${reply.status}`;
        counts[status] = (counts[status] ?? 0) + 1;
        if (firstUnexpected === null && status !== "saved" && status !== "conflict") firstUnexpected = {status, body: JSON.stringify(reply.body).slice(0, 500)};
      }
    });
    yield* Effect.all(Array.from({length: writers}, () => writer), {concurrency: "unbounded"});
    const saved = counts.saved ?? 0;
    assert.equal(firstUnexpected, null, `every save committed or met a newer generation: ${JSON.stringify({counts, firstUnexpected})}`);
    assert.ok(saved > 0, "the writers committed saves");
    assert.equal((yield* read).generation, initial.generation + saved, "each committed save advanced the generation once and none was lost");
    assert.doesNotMatch(`${child.stdout()}\n${child.stderr()}`, /SQLITE_BUSY|database is locked/iu, "no statement met a busy database");
    yield* waitUntilReady(harness, child);
    // the outcome with its inputs: this checkout's commit and whether its tree was clean
    yield* Console.log(JSON.stringify({soak: "concurrent-writes", windowMs, writers, counts, saved, ...(yield* checkoutInputs)}));
  }).pipe(Effect.provide(NodeFileSystem.layer)), {timeout: windowMs + 120_000});
