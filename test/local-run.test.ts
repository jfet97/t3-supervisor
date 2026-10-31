import assert from "node:assert/strict";
import { delimiter, dirname, join } from "node:path";
import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Effect, Exit, FileSystem, Option } from "effect";
import { cleanRuns, createRun, isolatedEnv, readMarker, removeRun, runMarker, runPrefix, runRoot } from "../scripts/local-run.js";
import { startProcess } from "./support/g8-process.js";

/*
  The local stack's run folders and child environments (scripts/local-run.ts): nothing of the invoking T3 address,
  credentials, state, provider logins or MCP registrations reaches a child, and only marked folders are ever removed.
*/

const invoking: NodeJS.ProcessEnv = {
  PATH: [dirname(process.execPath), "/usr/bin"].join(delimiter), HOME: "/home/operator", T3_URL: "http://127.0.0.1:3773",
  T3_TOKEN_FILE: "/run/secrets/t3-read-token", T3_GUIDANCE_TOKEN_FILE: "/run/secrets/t3-guidance-token", DATA_DIRECTORY: "/srv/t3-supervisor",
  XDG_STATE_HOME: "/home/operator/.local/state", CODEX_HOME: "/home/operator/.codex", CLAUDE_CONFIG_DIR: "/home/operator/.claude",
  T3CODE_HOME: "/home/operator/.t3", WORKFLOW_MCP_HOSTS: "t3-supervisor:9008", OPENAI_API_KEY: "sk-operator", GH_TOKEN: "ghp-operator",
};

it("a child's environment is built from the run folder, never from the invoking environment", () => {
  const env = isolatedEnv("/tmp/t3-supervisor-local-stack-a", ["node"], invoking, {T3_URL: "http://127.0.0.1:41234"});
  for (const [key, value] of Object.entries(invoking)) {
    if (key === "PATH") continue;
    assert.ok(!Object.values(env).includes(value!), `${key} must not reach the child`);
  }
  assert.equal(env.T3_URL, "http://127.0.0.1:41234");
  for (const key of ["HOME", "TMPDIR", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR"])
    assert.ok(env[key]!.startsWith("/tmp/t3-supervisor-local-stack-a/"), `${key} stays in the run folder`);
  assert.deepEqual(Object.keys(env).filter((key) => key.includes("TOKEN") || key.endsWith("_KEY") || key === "DATA_DIRECTORY" || key === "T3CODE_HOME"), []);
  assert.ok(env.PATH!.split(delimiter).includes(dirname(process.execPath)));
});

it.live("a run folder is private, marked, and removed with its scope unless kept", () => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({prefix: "local-run-test-"});
  const removed = yield* Effect.scoped(Effect.gen(function* () {
    const run = yield* createRun("fixture", {root});
    assert.ok(run.path.startsWith(join(root, `${runPrefix}fixture-`)));
    assert.equal((yield* fs.stat(run.path)).mode & 0o777, 0o700);
    assert.equal((yield* fs.stat(run.dir(runMarker))).mode & 0o777, 0o600);
    const marker = yield* readMarker(run.path);
    assert.ok(Option.isSome(marker));
    assert.equal(marker.value.kind, "fixture");
    assert.equal(marker.value.pid, process.pid);
    return run.path;
  }));
  assert.equal(yield* fs.exists(removed), false);
  const kept = yield* Effect.scoped(Effect.map(createRun("stack", {root, keep: true}), (run) => run.path));
  assert.equal(yield* fs.exists(kept), true);
}).pipe(Effect.provide(NodeFileSystem.layer)));

it.live("removal refuses a folder without the run marker and leaves it untouched", () => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({prefix: "local-run-test-"});
  const unmarked = join(root, `${runPrefix}stack-unmarked`);
  yield* fs.makeDirectory(unmarked);
  yield* fs.writeFileString(join(unmarked, "keep.txt"), "user data\n");
  const forged = join(root, `${runPrefix}stack-forged`);
  yield* fs.makeDirectory(forged);
  yield* fs.writeFileString(join(forged, runMarker), "{\"kind\":\"somebody-else\"}\n");
  for (const path of [unmarked, forged]) {
    const exit = yield* Effect.exit(removeRun(path));
    assert.ok(Exit.isFailure(exit), `${path} is refused`);
    assert.equal(yield* fs.exists(path), true);
  }
  assert.equal(yield* fs.readFileString(join(unmarked, "keep.txt")), "user data\n");
}).pipe(Effect.provide(NodeFileSystem.layer)));

it.live("cleaning removes only the marked folders of finished runs", () => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({prefix: "local-run-test-"});
  const ended = yield* Effect.scoped(Effect.gen(function* () {
    const child = yield* startProcess(process.execPath, ["-e", ""], {env: {PATH: dirname(process.execPath)}, cwd: root});
    yield* child.closed(10_000);
    return child.pid;
  }));
  const write = (name: string, pid: number) => Effect.gen(function* () {
    const path = join(root, `${runPrefix}${name}`);
    yield* fs.makeDirectory(path);
    yield* fs.writeFileString(join(path, runMarker), `${JSON.stringify({kind: "stack", createdAt: "2026-10-31T00:00:00.000Z", pid})}\n`);
    return path;
  });
  const finished = yield* write("stack-finished", ended);
  const running = yield* write("stack-running", process.pid);
  const unmarked = join(root, `${runPrefix}stack-unmarked`);
  yield* fs.makeDirectory(unmarked);
  const other = join(root, "unrelated");
  yield* fs.makeDirectory(other);
  const result = yield* cleanRuns(root);
  assert.deepEqual(result.removed, [finished]);
  assert.deepEqual(result.live, [running]);
  for (const path of [running, unmarked, other]) assert.equal(yield* fs.exists(path), true);
  assert.equal(yield* fs.exists(finished), false);
}).pipe(Effect.provide(NodeFileSystem.layer)));

it("the run root is the same for every invoking TMPDIR and follows only the cache home", () => {
  const home = "/home/operator";
  assert.equal(runRoot({HOME: home, TMPDIR: "/tmp/nix-shell.a"}), runRoot({HOME: home, TMPDIR: "/tmp/nix-shell.b"}));
  assert.equal(runRoot({HOME: home, TMPDIR: "/tmp/nix-shell.a"}), "/home/operator/.cache/t3-supervisor/local-runs");
  assert.equal(runRoot({HOME: home, XDG_CACHE_HOME: "/cache"}), "/cache/t3-supervisor/local-runs");
  assert.equal(runRoot({HOME: home, XDG_CACHE_HOME: "relative/cache"}), "/home/operator/.cache/t3-supervisor/local-runs");
});

it.live("a run kept by one invocation is cleaned by another with a different TMPDIR", () => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const home = yield* fs.makeTempDirectoryScoped({prefix: "local-run-home-"});
  const ended = yield* Effect.scoped(Effect.gen(function* () {
    const child = yield* startProcess(process.execPath, ["-e", ""], {env: {PATH: dirname(process.execPath)}, cwd: home});
    yield* child.closed(10_000);
    return child.pid;
  }));
  // the first invocation kept its run, then its process ended
  const kept = yield* Effect.scoped(Effect.map(createRun("stack", {root: runRoot({HOME: home, TMPDIR: "/tmp/nix-shell.first"}), keep: true}), (run) => run.path));
  yield* fs.writeFileString(join(kept, runMarker), `${JSON.stringify({kind: "stack", createdAt: "2026-10-31T00:00:00.000Z", pid: ended})}\n`);
  const result = yield* cleanRuns(runRoot({HOME: home, TMPDIR: "/tmp/nix-shell.second"}));
  assert.deepEqual(result.removed, [kept]);
  assert.equal(yield* fs.exists(kept), false);
  assert.deepEqual(yield* cleanRuns(join(home, "absent")), {removed: [], live: []}, "a missing root has nothing to clean");
}).pipe(Effect.provide(NodeFileSystem.layer)));
