import assert from "node:assert/strict";
import { join } from "node:path";
import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Clock, Console, Effect, FileSystem, Layer, Option, Redacted } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { checkoutInputs } from "../../scripts/local-run.js";
import { forgeDashboardToken } from "../../src/service-auth.js";
import { repositoryRoot, tsxLoader } from "../support/cli-process.js";
import { supervisorHarness, waitUntilReady } from "../support/g8-cli.js";
import { httpGet } from "../support/g8-process.js";
import { httpJson } from "../support/glinint-wiring.js";

/*
  A scripted soak (docs/testing.md, execution type 4): the production Supervisor process serves a steady workload on the wall
  clock against a loopback fake T3, and the operating system's view of the process shows what the workload leaves behind. Each
  cycle reads the dashboard snapshot, lists the workflow MCP tools with Supervisor's own bearer, opens the dashboard event
  stream and drops it, and reads health; each of these opens its own connection, subscription or MCP server. A connection or
  file a request leaves open is a descriptor that accumulates over hundreds of cycles, so after the workload stops and the
  process idles past its keep-alive timeout, its open file descriptors return within the warmed-up descriptor budget. A subscription or
  MCP server retained only in memory holds no descriptor: the resident memory is reported with its peak and bounded only
  against runaway growth, since the garbage collector decides when it shrinks, so this soak detects no smaller memory leak.
  SOAK_RESOURCE_MS asks for a longer window; no provider and no credential beyond the run's own is involved.
*/

const windowMs = Math.max(Number(process.env.SOAK_RESOURCE_MS ?? 0) || 0, 3 * 60_000);
const loops = 4;
// Node's HTTP server ends an idle keep-alive connection after 5 s; the process idles three times that before a count
const settle = "15 seconds";
// descriptors the process may open once after the baseline without holding any per request, such as a database journal
const descriptorSlack = 4;
// resident memory may move with the garbage collector; only growth past this marks a runaway retention
const runawayKiB = 512 * 1024;

// the platform fetch, whose request a closing scope aborts
const fetchClient = FetchHttpClient.layer.pipe(Layer.provide(Layer.sync(FetchHttpClient.Fetch, () => globalThis.fetch)));

// what the operating system reports for the process: its open descriptors and its resident memory in KiB
const usage = (pid: number) => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const descriptors = (yield* fs.readDirectory(`/proc/${pid}/fd`)).length;
  const status = yield* fs.readFileString(`/proc/${pid}/status`);
  const resident = Number(/^VmRSS:\s+(\d+)\s+kB$/mu.exec(status)?.[1] ?? Number.NaN);
  assert.ok(Number.isFinite(resident), "the process reports its resident memory");
  return {descriptors, residentKiB: resident};
});

it.live(`${loops} loops of dashboard, workflow MCP, event stream and health requests for ${Math.round(windowMs / 1000)} s return within the warmed descriptor budget`,
  () => Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const harness = yield* supervisorHarness({activeThreads: 1, archiveThreads: 1});
    const child = yield* harness.start(process.execPath, ["--import", tsxLoader, join(repositoryRoot, "src", "main.ts")]);
    yield* waitUntilReady(harness, child);
    // a signed-in dashboard session, as the page holds it, and the workflow MCP bearer Supervisor created at startup
    const origin = `http://127.0.0.1:${harness.ports.ui}`;
    const forged = yield* forgeDashboardToken(harness.dataDirectory).pipe(Effect.orDie);
    const login = yield* httpJson(`${origin}/auth/login`, {method: "POST", headers: {Origin: origin}, body: {token: Redacted.value(forged.token)}});
    assert.equal(login.status, 200);
    const session = {"x-supervisor-session": (login.body as {session: string}).session};
    const bearer = Redacted.make((yield* fs.readFileString(join(harness.dataDirectory, "access", "workflow-mcp-token"))).trim());
    const health = `http://127.0.0.1:${harness.ports.health}/health`;

    // the event stream answers its headers, then the closing scope drops the connection while the stream is open
    const openEvents = Effect.scoped(Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const response = yield* HttpClient.withScope(client).execute(HttpClientRequest.get(`${origin}/api/events`).pipe(HttpClientRequest.setHeaders(session)));
      return response.status;
    })).pipe(Effect.timeout("5 seconds"), Effect.option, Effect.map(Option.getOrElse(() => 0)), Effect.provide(fetchClient));
    // one cycle's answers, each the HTTP status its request got
    const statuses = new Map<string, number>();
    const unexpected: Array<string> = [];
    const answered = (request: string, status: number) => {
      statuses.set(`${request} ${status}`, (statuses.get(`${request} ${status}`) ?? 0) + 1);
      if (status !== 200 && unexpected.length < 5) unexpected.push(`${request} answered ${status}`);
    };
    const cycle = Effect.gen(function* () {
      answered("snapshot", (yield* httpJson(`${origin}/api/guidance/snapshot`, {headers: session})).status);
      answered("workflow MCP tools/list", (yield* httpJson(`${origin}/mcp/workflows`, {method: "POST",
        headers: {Authorization: `Bearer ${Redacted.value(bearer)}`, Accept: "application/json, text/event-stream"},
        body: {jsonrpc: "2.0", id: 1, method: "tools/list", params: {}}})).status);
      answered("event stream", yield* openEvents);
      answered("health", (yield* httpGet(health, 5_000).pipe(Effect.option)).pipe(Option.match({onNone: () => 0, onSome: (reply) => reply.status})));
    });

    // the baseline is taken warmed up and idle: every kind of request has run, and its connections have timed out
    yield* Effect.all(Array.from({length: loops}, () => Effect.forEach(Array.from({length: 5}), () => cycle, {discard: true})), {concurrency: "unbounded"});
    yield* Effect.sleep(settle);
    const baseline = yield* usage(child.pid);
    statuses.clear();

    const started = yield* Clock.currentTimeMillis;
    let cycles = 0;
    let peak = baseline;
    const loop = Effect.gen(function* () {
      while ((yield* Clock.currentTimeMillis) - started < windowMs) {
        yield* cycle;
        cycles += 1;
      }
    });
    // the operating system's view while the workload runs, every 10 s
    const watch = Effect.gen(function* () {
      while ((yield* Clock.currentTimeMillis) - started < windowMs) {
        yield* Effect.sleep("10 seconds");
        const now = yield* usage(child.pid);
        peak = {descriptors: Math.max(peak.descriptors, now.descriptors), residentKiB: Math.max(peak.residentKiB, now.residentKiB)};
      }
    });
    yield* Effect.all([...Array.from({length: loops}, () => loop), watch], {concurrency: "unbounded"});
    yield* Effect.sleep(settle);
    const after = yield* usage(child.pid);

    const outcome = {soak: "resource-use", windowMs, loops, cycles, statuses: Object.fromEntries(statuses), baseline, peak, after,
      ...(yield* checkoutInputs)};
    assert.deepEqual(unexpected, [], `every request was answered: ${JSON.stringify(outcome)}`);
    assert.ok(cycles >= loops * 10, `the workload ran: ${JSON.stringify(outcome)}`);
    assert.ok(after.descriptors <= baseline.descriptors + descriptorSlack,
      `the process holds no descriptor per request once idle: ${JSON.stringify(outcome)}`);
    assert.ok(after.residentKiB <= baseline.residentKiB + runawayKiB, `resident memory did not run away: ${JSON.stringify(outcome)}`);
    yield* waitUntilReady(harness, child);
    yield* Console.log(JSON.stringify(outcome));
  }).pipe(Effect.provide(NodeFileSystem.layer)), {timeout: windowMs + 180_000});
