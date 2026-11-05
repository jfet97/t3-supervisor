import assert from "node:assert/strict";
import { join } from "node:path";
import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Cause, Effect, Exit, Fiber, FileSystem } from "effect";
import { groupAlive, nodePath } from "./support/cli-process.js";
import { supervisorHarness } from "./support/g8-cli.js";
import { httpGet, runProcess, startProcess } from "./support/g8-process.js";
import { effectFamilyProbe, effectFamilyProblems, readEffectFamily, verifyEffectFamily, waitForReleaseReady } from "./support/release-smoke.js";

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

// installed trees in npm's layout, written as manifests only; the probe runs node's own resolution over them in a real child process
type Manifest = { readonly name: string; readonly version: string; readonly dependencies?: Record<string, string>; readonly peerDependencies?: Record<string, string> };
const application = "node_modules/@jfet97/t3-supervisor";
const supervisor = (effectPins: Record<string, string>): Manifest =>
  ({ name: "@jfet97/t3-supervisor", version: "0.0.27", dependencies: { ...effectPins, react: "19.3.0", ws: "8.22.0" } });
const effectPackage = (name: string, version: string, effect: string, dependencies: Record<string, string> = {}): Manifest =>
  ({ name, version, dependencies, peerDependencies: { effect } });
const publishedPins = { "@effect/atom-react": "4.0.6", "@effect/platform-node": "4.0.6", "@effect/sql-sqlite-node": "4.0.6", effect: "4.0.6" };

const installedTree = (packages: Readonly<Record<string, Manifest>>) => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const prefix = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "effect-family-" }));
  for (const [location, manifest] of Object.entries(packages)) {
    yield* fs.makeDirectory(join(prefix, location), { recursive: true });
    yield* fs.writeFileString(join(prefix, location, "package.json"), JSON.stringify(manifest));
  }
  return prefix;
});
const probe = (prefix: string) =>
  runProcess(process.execPath, ["-e", effectFamilyProbe, join(prefix, application)], { cwd: prefix, env: { PATH: nodePath() }, timeoutMs: 10_000 });

it.live("the observed fresh npm install of 0.0.27 splits effect between the application and its adapters, and every split is named", () => Effect.gen(function* () {
  // Supervisor's exact effect nests under it, while npm's newest platform-node-shared, through platform-node's caret range, moved the root effect
  const prefix = yield* installedTree({
    [application]: supervisor(publishedPins),
    [`${application}/node_modules/effect`]: { name: "effect", version: "4.0.6" },
    "node_modules/effect": { name: "effect", version: "4.1.2" },
    "node_modules/@effect/atom-react": effectPackage("@effect/atom-react", "4.0.6", "^4.0.6"),
    "node_modules/@effect/platform-node": effectPackage("@effect/platform-node", "4.0.6", "^4.0.6", { "@effect/platform-node-shared": "^4.0.6", undici: "^8.12.2" }),
    "node_modules/@effect/platform-node-shared": effectPackage("@effect/platform-node-shared", "4.1.2", "^4.1.2"),
    "node_modules/@effect/sql-sqlite-node": effectPackage("@effect/sql-sqlite-node", "4.0.6", "^4.0.6"),
  });
  assert.deepEqual(effectFamilyProblems(yield* readEffectFamily(probe(prefix))), [
    "@effect/atom-react@4.0.6 resolves effect@4.1.2, not the pinned 4.0.6",
    "@effect/platform-node@4.0.6 reaches @effect/platform-node-shared@4.1.2, which @jfet97/t3-supervisor does not pin as an exact direct dependency",
    "@effect/platform-node@4.0.6 resolves effect@4.1.2, not the pinned 4.0.6",
    "@effect/sql-sqlite-node@4.0.6 resolves effect@4.1.2, not the pinned 4.0.6",
    "@effect/platform-node-shared@4.1.2 resolves effect@4.1.2, not the pinned 4.0.6",
    `effect resolves to 2 installed copies: ${join(prefix, application, "node_modules/effect")}, ${join(prefix, "node_modules/effect")}`,
  ]);
  const verdict = yield* Effect.exit(verifyEffectFamily(probe(prefix)));
  assert.ok(Exit.isFailure(verdict), "a split Effect set fails the release check");
  assert.match(String(Cause.squash(verdict.cause)), /not one exactly pinned set:\n@effect\/atom-react@4\.0\.6 resolves effect@4\.1\.2/u);
}).pipe(Effect.provide(NodeFileSystem.layer)));

it.live("the exactly pinned manifest's npm layout gives the application and every adapter one copy of each Effect package", () => Effect.gen(function* () {
  const prefix = yield* installedTree({
    [application]: supervisor({ ...publishedPins, "@effect/platform-node-shared": "4.0.6" }),
    "node_modules/effect": { name: "effect", version: "4.0.6" },
    "node_modules/@effect/atom-react": effectPackage("@effect/atom-react", "4.0.6", "^4.0.6"),
    "node_modules/@effect/platform-node": effectPackage("@effect/platform-node", "4.0.6", "^4.0.6", { "@effect/platform-node-shared": "^4.0.6", undici: "^8.12.2" }),
    "node_modules/@effect/platform-node-shared": effectPackage("@effect/platform-node-shared", "4.0.6", "^4.0.6"),
    "node_modules/@effect/sql-sqlite-node": effectPackage("@effect/sql-sqlite-node", "4.0.6", "^4.0.6"),
  });
  const family = yield* verifyEffectFamily(probe(prefix));
  assert.deepEqual(family.resolutions.map(({ importer, name, version }) => `${importer} -> ${name}@${String(version)}`), [
    "@jfet97/t3-supervisor -> @effect/atom-react@4.0.6",
    "@jfet97/t3-supervisor -> @effect/platform-node@4.0.6",
    "@jfet97/t3-supervisor -> @effect/platform-node-shared@4.0.6",
    "@jfet97/t3-supervisor -> @effect/sql-sqlite-node@4.0.6",
    "@jfet97/t3-supervisor -> effect@4.0.6",
    "@effect/atom-react@4.0.6 -> effect@4.0.6",
    "@effect/platform-node@4.0.6 -> @effect/platform-node-shared@4.0.6",
    "@effect/platform-node@4.0.6 -> effect@4.0.6",
    "@effect/platform-node-shared@4.0.6 -> effect@4.0.6",
    "@effect/sql-sqlite-node@4.0.6 -> effect@4.0.6",
  ]);
  assert.deepEqual([...new Set(family.resolutions.filter(({ name }) => name === "effect").map(({ directory }) => directory))],
    [join(prefix, "node_modules/effect")]);
}).pipe(Effect.provide(NodeFileSystem.layer)));

it.live("an exact pin alone does not pass: a nested second copy, a range and a missing Effect package are each named", () => Effect.gen(function* () {
  const prefix = yield* installedTree({
    [application]: supervisor({ "@effect/platform-node": "4.0.6", "@effect/platform-node-shared": "4.0.6", "@effect/sql-sqlite-node": "^4.0.6", effect: "4.0.6" }),
    "node_modules/effect": { name: "effect", version: "4.0.6" },
    "node_modules/@effect/platform-node": effectPackage("@effect/platform-node", "4.0.6", "^4.0.6", { "@effect/platform-node-shared": "^4.0.6" }),
    "node_modules/@effect/platform-node/node_modules/@effect/platform-node-shared": effectPackage("@effect/platform-node-shared", "4.1.2", "^4.1.2"),
    "node_modules/@effect/platform-node-shared": effectPackage("@effect/platform-node-shared", "4.0.6", "^4.0.6"),
  });
  assert.deepEqual(effectFamilyProblems(yield* readEffectFamily(probe(prefix))), [
    "@jfet97/t3-supervisor declares @effect/sql-sqlite-node ^4.0.6, not an exact version",
    "@jfet97/t3-supervisor cannot resolve @effect/sql-sqlite-node",
    "@effect/platform-node@4.0.6 resolves @effect/platform-node-shared@4.1.2, not the pinned 4.0.6",
    `@effect/platform-node-shared resolves to 2 installed copies: ${join(prefix, "node_modules/@effect/platform-node-shared")}, `
      + join(prefix, "node_modules/@effect/platform-node/node_modules/@effect/platform-node-shared"),
  ]);
}).pipe(Effect.provide(NodeFileSystem.layer)));
