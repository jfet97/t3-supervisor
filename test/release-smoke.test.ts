import assert from "node:assert/strict";
import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Cause, Effect, Exit, Fiber } from "effect";
import { groupAlive } from "./support/cli-process.js";
import { supervisorHarness } from "./support/g8-cli.js";
import { httpGet, startProcess } from "./support/g8-process.js";
import { waitForReleaseReady } from "./support/release-smoke.js";

// real child/HTTP boundaries: an available health listener is not necessarily a ready release
const unready = {
  ok: false, readiness: { alive: true, ready: false, supervisionProgress: true }, t3Connected: false,
  storeState: "ready", supervisionState: "ready", lastErrorPhase: "t3_stream",
};
const fixture = `const http = require('node:http');
let ready = false;
const server = http.createServer((request, response) => {
  if (request.url === '/activate') { ready = true; response.end(); return; }
  const body = JSON.parse(process.env.HEALTH_BODY);
  if (ready) { body.ok = true; body.readiness.ready = true; body.t3Connected = true; body.lastErrorPhase = null; }
  response.writeHead(ready ? 200 : 503, {'content-type':'application/json'});
  response.end(JSON.stringify(body));
  console.log('health observed');
});
server.listen(Number(process.env.HEALTH_PORT), '127.0.0.1', () => {
  process.stdout.write('fixture output '.repeat(1000) + ' startup=' + process.env.FIXTURE_SECRET + '\\nlistening\\n');
  process.stderr.write('fixture warning Bearer ' + process.env.FIXTURE_SECRET + '\\n');
});`;

const diagnostic = (exit: Exit.Exit<unknown>) => {
  assert.ok(Exit.isFailure(exit), "an unready release must fail");
  const message = String(Cause.squash(exit.cause));
  assert.match(message, /release readiness failed within \d+ ms:/u);
  return { message, detail: JSON.parse(message.slice(message.indexOf(": {") + 2)) };
};

it.live("release readiness retains safe health and bounded redacted startup output on a 503 deadline", () => Effect.gen(function* () {
  const harness = yield* supervisorHarness();
  let pid = 0;
  yield* Effect.scoped(Effect.gen(function* () {
    const child = yield* startProcess(process.execPath, ["-e", fixture], {
      cwd: harness.home, env: { ...harness.env, FIXTURE_SECRET: harness.token,
        HEALTH_BODY: JSON.stringify({ ...unready, nativeBody: "private-native-body-canary" }) },
    });
    pid = child.pid;
    yield* child.waitForStdout((text) => text.includes("listening\n"), 5_000, "fixture listener");
    const { message, detail } = diagnostic(yield* Effect.exit(waitForReleaseReady(harness, child, 200)));
    assert.deepEqual(detail.health, { status: 503, body: unready });
    assert.equal(message.includes(harness.token), false);
    assert.equal(message.includes("private-native-body-canary"), false);
    assert.ok(detail.stdout.length <= 4096);
    assert.match(detail.stdout, /listening/u);
    assert.match(detail.stderr, /fixture warning/u);
    assert.equal(detail.exitCode, null);
  }));
  assert.equal(groupAlive(pid), false, "the failed fixture leaves no child process behind");
}).pipe(Effect.provide(NodeFileSystem.layer)));

it.live("release readiness reports an early child exit with its redacted startup output", () => Effect.gen(function* () {
  const harness = yield* supervisorHarness();
  const child = yield* startProcess(process.execPath, ["-e", "console.log('startup failed'); console.error(process.env.FIXTURE_SECRET); process.exitCode = 23;"], {
    cwd: harness.home, env: { ...harness.env, FIXTURE_SECRET: harness.token },
  });
  yield* child.closed(5_000);
  const { message, detail } = diagnostic(yield* Effect.exit(waitForReleaseReady(harness, child, 200)));
  assert.equal(detail.exitCode, 23);
  assert.deepEqual(detail.health, { state: "no response" });
  assert.match(detail.stdout, /startup failed/u);
  assert.equal(message.includes(harness.token), false);
}).pipe(Effect.provide(NodeFileSystem.layer)));

it.live("release readiness waits through a 503 and accepts the later real HTTP 200", () => Effect.gen(function* () {
  const harness = yield* supervisorHarness();
  const child = yield* startProcess(process.execPath, ["-e", fixture], {
    cwd: harness.home, env: { ...harness.env, FIXTURE_SECRET: harness.token, HEALTH_BODY: JSON.stringify(unready) },
  });
  yield* child.waitForStdout((text) => text.includes("listening\n"), 5_000, "fixture listener");
  const waiting = yield* Effect.forkChild(waitForReleaseReady(harness, child, 5_000));
  yield* child.waitForStdout((text) => text.includes("health observed\n"), 5_000, "the first unready health response");
  yield* httpGet(`http://127.0.0.1:${harness.ports.health}/activate`, 2_000);
  const health = yield* Fiber.join(waiting);
  assert.equal(health.status, 200);
  assert.equal((JSON.parse(health.body) as { ok: boolean }).ok, true);
}).pipe(Effect.provide(NodeFileSystem.layer)));
