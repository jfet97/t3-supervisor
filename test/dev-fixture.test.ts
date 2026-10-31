import assert from "node:assert/strict";
import { join } from "node:path";
import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Effect, FileSystem, Redacted, Schedule } from "effect";
import { fixtureSession, type FixtureScenario, type FixtureSession } from "../scripts/dev-fixture.js";
import { httpGet, portState } from "./support/g8-process.js";
import { httpJson } from "./support/glinint-wiring.js";

// the dashboard fixture (scripts/dev-fixture.ts): the production application over the scripted native T3 peer serves the
// given compiled dashboard, signs in with a production one-time token, shows each scenario's data, and removes its run
// folder and listener with its scope. The stand-in assets keep the suite independent of a dashboard build

const assets = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* fs.makeTempDirectoryScoped({prefix: "dev-fixture-assets-"});
  yield* fs.makeDirectory(join(directory, "assets"));
  yield* fs.writeFileString(join(directory, "index.html"),
    "<!doctype html><html><head><script type=\"module\" src=\"/assets/app.js\"></script></head><body><div id=\"root\"></div></body></html>\n");
  yield* fs.writeFileString(join(directory, "assets", "app.js"), "document.getElementById('root').textContent = 'fixture assets';\n");
  return directory;
});

const signIn = (session: FixtureSession) => Effect.gen(function* () {
  const reply = yield* httpJson(`${session.url}/auth/login`, {method: "POST", headers: {Origin: session.url}, body: {token: Redacted.value(session.signInToken)}});
  assert.equal(reply.status, 200);
  const signedIn = reply.body as {session?: string};
  assert.equal(typeof signedIn.session, "string");
  return (path: string) => Effect.map(httpJson(`${session.url}/api/guidance${path}`, {headers: {"x-supervisor-session": signedIn.session!}}), (answer) => {
    assert.equal(answer.status, 200, `${path}: HTTP ${answer.status}`);
    return answer.body as Record<string, unknown>;
  });
});

type Snapshot = {connected: boolean; projects: Array<{id: string; title: string; available: boolean}>; threads: unknown[]};

const scenario = (name: FixtureScenario, check: (read: (path: string) => Effect.Effect<Record<string, unknown>>) => Effect.Effect<void>) => Effect.gen(function* () {
  const directory = yield* assets;
  const ended = yield* Effect.scoped(Effect.gen(function* () {
    const session = yield* fixtureSession({scenario: name, assets: directory});
    assert.equal(session.scenario, name);
    const page = yield* Effect.orDie(httpGet(`${session.url}/`, 5_000));
    assert.equal(page.status, 200);
    assert.match(page.body, /<div id="root">/u);
    yield* check(yield* signIn(session));
    return {folder: session.runFolder, port: Number(new URL(session.url).port)};
  }));
  const fs = yield* FileSystem.FileSystem;
  assert.equal(yield* fs.exists(ended.folder), false, "the run folder is removed with the scope");
  assert.equal(yield* portState(ended.port), "refused", "the dashboard listener is closed with the scope");
}).pipe(Effect.provide(NodeFileSystem.layer));

it.live("the populated fixture serves the supervised main's needed-work task beside plain and unavailable projects", () => scenario("populated", (read) => Effect.gen(function* () {
  const snapshot = (yield* read("/snapshot")) as unknown as Snapshot;
  assert.equal(snapshot.connected, true);
  assert.deepEqual(snapshot.projects.map((item) => [item.title, item.available]),
    [["Fixture: startup project", true], ["Fixture: documentation", true], ["Fixture: folder unavailable", false]]);
  assert.equal(snapshot.threads.length, 4);
  const supervisor = (yield* read("/project-supervisor?projectId=startup-project&mainThreadId=startup-main")) as {
    binding?: {state?: string}; tasks?: Array<{status?: string; supervision?: string; objective?: string; workflow?: {plan?: {nodes?: Array<{name?: string}>}}}>};
  assert.equal(supervisor.binding?.state, "ready");
  const task = supervisor.tasks?.[0];
  assert.equal(task?.status, "inferred");
  assert.equal(task?.supervision, "needed");
  assert.equal(task?.objective, "Inspect the checkout and explain its status.");
  assert.deepEqual(task?.workflow?.plan?.nodes?.map((node) => node.name), ["Inspect checkout", "Explain status"]);
})), {timeout: 60_000});

it.live("the empty fixture lists no project and no conversation", () => scenario("empty", (read) => Effect.gen(function* () {
  const snapshot = (yield* read("/snapshot")) as unknown as Snapshot;
  assert.equal(snapshot.connected, true);
  assert.deepEqual([snapshot.projects.length, snapshot.threads.length], [0, 0]);
})), {timeout: 60_000});

it.live("the unavailable fixture keeps its last read while T3 does not answer", () => scenario("unavailable", (read) => Effect.gen(function* () {
  const snapshot = yield* read("/snapshot").pipe(Effect.map((value) => value as unknown as Snapshot),
    Effect.flatMap((value) => value.connected ? Effect.fail("still connected" as const) : Effect.succeed(value)),
    Effect.retry(Schedule.spaced("500 millis")), Effect.timeout("40 seconds"), Effect.orDie);
  assert.equal(snapshot.connected, false);
  assert.equal(snapshot.projects.length, 3);
  assert.equal(snapshot.threads.length, 4);
})), {timeout: 60_000});
