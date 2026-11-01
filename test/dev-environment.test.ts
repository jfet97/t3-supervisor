import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Effect, Exit, FileSystem } from "effect";
import { parse } from "yaml";
import { cliSignOuts, devPaths, devPorts, environmentSessions, prepare, sessionSubjectPrefix, signedOutByT3, supervisorEnvironment, t3Environment, withCodexFileStore } from "../scripts/dev-environment.js";
import { repositoryRoot } from "../scripts/local-run.js";
import { runProcess } from "./support/g8-process.js";

/*
  The Docker development environment's fixed contracts (scripts/dev-environment.ts, docker/dev and ./dev): credentials and
  T3's own data stay in the private credentials volume, every published port is loopback only, a reset removes only this
  environment's sessions, projects and data volume, and the host entry validates its input before it needs Docker. No
  container runs in this suite.
*/

const containerEnv: NodeJS.ProcessEnv = {
  PATH: "/opt/providers/bin:/usr/local/bin:/usr/bin:/bin", HOME: "/credentials/home", CODEX_HOME: "/credentials/codex",
  CLAUDE_CONFIG_DIR: "/credentials/claude", XDG_CONFIG_HOME: "/credentials/home/.config", XDG_DATA_HOME: "/credentials/home/.local/share",
  XDG_STATE_HOME: "/credentials/home/.local/state", XDG_CACHE_HOME: "/cache/xdg", T3SUP_DEV_CREDENTIALS: "/credentials", T3SUP_DEV_DATA: "/data",
  T3SUP_DEV_CACHE: "/cache", T3SUP_DEV_T3_PORT: "47773", T3SUP_DEV_UI_PORT: "47708", T3SUP_DEV_HEALTH_PORT: "47707",
};

it("Codex keeps its CLI login in CODEX_HOME through file storage, and every existing line stays", () => {
  assert.equal(withCodexFileStore(undefined), 'cli_auth_credentials_store = "file"\n');
  assert.equal(withCodexFileStore("  \n"), 'cli_auth_credentials_store = "file"\n');
  const existing = 'model = "gpt-6"\n\n[mcp_servers.docs]\nurl = "http://127.0.0.1:1"\n';
  assert.equal(withCodexFileStore(existing), `cli_auth_credentials_store = "file"\n${existing}`);
  // an explicit choice of another store is the operator's
  assert.equal(withCodexFileStore('cli_auth_credentials_store = "keyring"\nmodel = "gpt-6"\n'), undefined);
  assert.equal(withCodexFileStore('cli_auth_credentials_store = "file"\n'), undefined);
});

it.effect("a start revokes only the scoped sessions this environment issued", () => Effect.gen(function* () {
  const listed = JSON.stringify([
    {sessionId: "s-read", subject: `${sessionSubjectPrefix}read`, scopes: ["orchestration:read"]},
    {sessionId: "s-browser", subject: "browser", scopes: ["orchestration:read"]},
    {sessionId: "s-none", subject: null},
    {sessionId: "s-unlabelled"},
    {sessionId: "s-probe", subject: `${sessionSubjectPrefix}git-probe`},
  ]);
  assert.deepEqual(yield* environmentSessions(listed), ["s-read", "s-probe"]);
  const malformed = yield* Effect.exit(environmentSessions('{"sessions": "not a list"}'));
  assert.ok(Exit.isFailure(malformed));
}));

it.effect("the auth reset asks T3 to sign out exactly the instances T3 offers a sign-out for", () => Effect.gen(function* () {
  const config = {providers: [
    {instanceId: "codex", driver: "codex", enabled: true, auth: {status: "authenticated", type: "chatgpt", canLogout: true}},
    {instanceId: "claudeAgent", driver: "claudeAgent", auth: {status: "authenticated", canLogout: false}},
    {instanceId: "cursor", driver: "cursor", auth: {status: "unauthenticated"}},
  ], other: "fields are ignored"};
  assert.deepEqual((yield* signedOutByT3(config)).map((provider) => provider.instanceId), ["codex"]);
  assert.ok(Exit.isFailure(yield* Effect.exit(signedOutByT3({providers: [{instanceId: 1}]}))));
}));

it("a CLI counts as signed out only when its own status says so, never because a logout or status command failed", () => {
  const [codex, claude] = cliSignOuts;
  const paths = {claudeConfig: "/credentials/claude"};
  assert.equal(codex.signedOut({code: 1, stdout: "", stderr: "Not logged in\n"}, paths), true);
  assert.equal(codex.signedOut({code: 0, stdout: "Logged in using ChatGPT\n", stderr: ""}, paths), false);
  // a failed status check is not proof of a sign-out
  assert.equal(codex.signedOut({code: 1, stdout: "", stderr: "Error checking login status: permission denied\n"}, paths), false);
  assert.equal(codex.signedOut({code: null, stdout: "", stderr: "Not logged in"}, paths), false);
  // Claude: its documented status JSON for no login, with exit 1, for this environment's config folder
  const status = (fields: Record<string, unknown>) => JSON.stringify({configDirectory: "/credentials/claude", ...fields});
  assert.equal(claude.signedOut({code: 1, stdout: status({authMethod: "none"}), stderr: ""}, paths), true);
  assert.equal(claude.signedOut({code: 1, stdout: status({loggedIn: false, authMethod: "none"}), stderr: ""}, paths), true);
  assert.equal(claude.signedOut({code: 1, stdout: `${status({loggedIn: false})}\n`, stderr: ""}, paths), true);
  for (const [result, why] of [
    [{code: 1, stdout: "", stderr: "EACCES: permission denied, open '/credentials/claude/.credentials.json'"}, "a permission failure"],
    [{code: 1, stdout: "Not logged in", stderr: ""}, "output that is not the status JSON"],
    [{code: 1, stdout: "{\"configDirectory\": \"/credentials/claude\"}", stderr: ""}, "a status without login fields"],
    [{code: 1, stdout: status({authMethod: "claude.ai"}), stderr: ""}, "a status naming a login"],
    [{code: 1, stdout: status({loggedIn: true}), stderr: ""}, "a status saying logged in"],
    [{code: 1, stdout: status({loggedIn: false, authMethod: "api_key"}), stderr: ""}, "an inconsistent status"],
    [{code: 1, stdout: JSON.stringify({authMethod: "none", configDirectory: "/home/someone/.claude"}), stderr: ""}, "another config folder"],
    [{code: 0, stdout: status({loggedIn: true, authMethod: "claude.ai"}), stderr: ""}, "a login"],
    [{code: 0, stdout: status({authMethod: "none"}), stderr: ""}, "exit 0"],
    [{code: 2, stdout: status({authMethod: "none"}), stderr: "unexpected"}, "another exit code"],
    [{code: null, stdout: status({authMethod: "none"}), stderr: ""}, "a signal"],
  ] as const) assert.equal(claude.signedOut(result, paths), false, why);
});

it.effect("paths come from the container's absolute variables, and a missing or relative one is refused", () => Effect.gen(function* () {
  const paths = yield* devPaths(containerEnv);
  assert.deepEqual(paths, {home: "/credentials/home", codexHome: "/credentials/codex", claudeConfig: "/credentials/claude", t3Home: "/credentials/t3",
    supervisorData: "/data/supervisor", workspaces: "/data/workspaces", stack: "/data/stack", t3Runtime: "/cache/t3-runtime"});
  const missing = Object.fromEntries(Object.entries(containerEnv).filter(([name]) => name !== "T3SUP_DEV_DATA"));
  assert.ok(Exit.isFailure(yield* Effect.exit(devPaths(missing))));
  assert.ok(Exit.isFailure(yield* Effect.exit(devPaths({...containerEnv, CODEX_HOME: "credentials/codex"}))));
  assert.deepEqual(yield* devPorts(containerEnv), {t3: 47773, ui: 47708, health: 47707});
  assert.ok(Exit.isFailure(yield* Effect.exit(devPorts({...containerEnv, T3SUP_DEV_UI_PORT: "80"}))));
}));

it.effect("T3 and the provider CLIs it starts see the credentials volume and nothing else of the container environment", () => Effect.gen(function* () {
  const paths = yield* devPaths(containerEnv);
  const env = t3Environment({...containerEnv, T3_URL: "http://host.docker.internal:3773", OPENAI_API_KEY: "never-forwarded", SSH_AUTH_SOCK: "/tmp/agent"}, paths);
  assert.equal(env.T3CODE_HOME, "/credentials/t3");
  assert.equal(env.CODEX_HOME, "/credentials/codex");
  assert.equal(env.CLAUDE_CONFIG_DIR, "/credentials/claude");
  assert.equal(env.HOME, "/credentials/home");
  assert.equal(env.XDG_CONFIG_HOME, "/credentials/home/.config");
  assert.equal(env.T3CODE_TELEMETRY_ENABLED, "false");
  for (const name of ["T3_URL", "OPENAI_API_KEY", "SSH_AUTH_SOCK", "T3SUP_DEV_DATA"]) assert.equal(env[name], undefined, name);
  // T3's worktree setup runs `sh dev setup` with this environment, inside the container
  assert.equal(t3Environment({...containerEnv, T3SUP_DEV_CONTAINER: "1"}, paths).T3SUP_DEV_CONTAINER, "1");
}));

it.effect("Supervisor takes the scratch project T3 keeps under the base directory it is served with for No Project", () => Effect.gen(function* () {
  const paths = yield* devPaths(containerEnv);
  const ports = yield* devPorts(containerEnv);
  const env = supervisorEnvironment({env: t3Environment(containerEnv, paths), paths, ports, t3Url: `http://127.0.0.1:${ports.t3}`, assets: "/workspace/ui-dist",
    files: {T3_TOKEN_FILE: "/data/supervisor/access/t3-token"}});
  // T3 keeps its scratch project at path.resolve(baseDir, "scratch") (apps/server/src/project/ManagedProjectFolders.ts) and runs here
  // with --base-dir paths.t3Home; Supervisor compares an absolute, normalized root with the project's workspace root
  const root = env.T3_MANAGED_SCRATCH_ROOT ?? "";
  assert.equal(root, posix.resolve(paths.t3Home, "scratch"));
  assert.equal(root, "/credentials/t3/scratch");
  assert.ok(posix.isAbsolute(root) && posix.normalize(root) === root, "an absolute, normalized root");
  assert.ok(!root.startsWith(paths.workspaces), "never a development workspace");
  // the rest of Supervisor's environment is unchanged by it: its own data, the T3 it reads and its issued session files
  assert.equal(env.DATA_DIRECTORY, paths.supervisorData);
  assert.equal(env.T3_URL, "http://127.0.0.1:47773");
  assert.equal(env.T3_TOKEN_FILE, "/data/supervisor/access/t3-token");
}));

it.live("preparing makes private folders and file storage and leaves an existing login untouched", () => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({prefix: "t3sup-dev-environment-"});
  const env = {...containerEnv, HOME: join(root, "credentials", "home"), CODEX_HOME: join(root, "credentials", "codex"),
    CLAUDE_CONFIG_DIR: join(root, "credentials", "claude"), T3SUP_DEV_CREDENTIALS: join(root, "credentials"), T3SUP_DEV_DATA: join(root, "data"),
    T3SUP_DEV_CACHE: join(root, "cache")};
  const paths = yield* devPaths(env);
  yield* fs.makeDirectory(paths.codexHome, {recursive: true});
  yield* fs.writeFileString(join(paths.codexHome, "config.toml"), 'model = "gpt-6"\n');
  yield* fs.writeFileString(join(paths.codexHome, "auth.json"), "{\"login\": \"kept\"}\n");
  yield* prepare(paths);
  assert.equal(yield* fs.readFileString(join(paths.codexHome, "config.toml")), 'cli_auth_credentials_store = "file"\nmodel = "gpt-6"\n');
  assert.equal(yield* fs.readFileString(join(paths.codexHome, "auth.json")), "{\"login\": \"kept\"}\n");
  for (const folder of [paths.codexHome, paths.claudeConfig, paths.t3Home, join(paths.stack, "secrets")]) {
    assert.equal(((yield* fs.stat(folder)).mode & 0o777), 0o700, folder);
  }
  for (const folder of [paths.supervisorData, paths.workspaces, join(paths.home, ".config"), join(paths.home, ".local", "state")]) assert.ok(yield* fs.exists(folder), folder);
  // a second preparation changes nothing
  yield* prepare(paths);
  assert.equal(yield* fs.readFileString(join(paths.codexHome, "config.toml")), 'cli_auth_credentials_store = "file"\nmodel = "gpt-6"\n');
}).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)));

type Service = {environment: Record<string, string>; ports?: string[]; volumes: Array<{type: string; source: string; target: string}>;
  build?: {target?: string; args?: Record<string, string>}; profiles?: string[]};

it("the compose file publishes loopback ports only and mounts the checkout and the environment's own volumes, never host credentials", () => {
  const compose = parse(readFileSync(join(repositoryRoot, "docker", "dev", "compose.yaml"), "utf8"), {merge: true}) as {
    services: Record<string, Service>; volumes: Record<string, unknown>};
  assert.deepEqual(Object.keys(compose.volumes).sort(), ["cache", "credentials", "data", "node_modules"]);
  const {e2e, ...environment} = compose.services;
  for (const [name, service] of Object.entries(environment)) {
    assert.equal(service.build?.target, "development", name);
    for (const port of service.ports ?? []) assert.match(port, /^127\.0\.0\.1:\$\{\w+\}:\$\{\w+\}$/u, `${name} publishes ${port}`);
    assert.deepEqual(service.volumes.map((volume) => `${volume.type}:${volume.source}:${volume.target}`), [
      "bind:../..:/workspace", "volume:node_modules:/workspace/node_modules", "volume:credentials:/credentials", "volume:data:/data", "volume:cache:/cache"]);
    const env = service.environment;
    for (const variable of ["HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "T3CODE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"]) {
      assert.match(env[variable] ?? "", /^\/credentials\//u, `${name} ${variable}`);
    }
    assert.equal(env.XDG_CACHE_HOME, "/cache/xdg");
    assert.equal(env.T3SUP_DEV_DATA, "/data");
  }
  assert.deepEqual(compose.services.env?.ports?.length, 3);
  // the browser journeys see the checkout, its dependencies and the shared caches: never a sign-in, T3 data or this
  // environment's Supervisor data, and they publish nothing
  assert.ok(e2e);
  assert.equal(e2e.build?.target, "e2e");
  assert.deepEqual(e2e.profiles, ["e2e"]);
  assert.equal(e2e.ports, undefined);
  assert.deepEqual(e2e.volumes.map((volume) => `${volume.type}:${volume.source}:${volume.target}`), [
    "bind:../..:/workspace", "volume:node_modules:/workspace/node_modules", "volume:cache:/cache"]);
  for (const [variable, value] of Object.entries(e2e.environment)) assert.doesNotMatch(value, /^\/(credentials|data)(\/|$)/u, variable);
});

it("the e2e image installs the headless Chromium of exactly the playwright-core version the lockfile installs", () => {
  const manifest = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8")) as {devDependencies: Record<string, string>};
  const dockerfile = readFileSync(join(repositoryRoot, "docker", "dev", "Dockerfile"), "utf8");
  const pinned = /^ARG PLAYWRIGHT_VERSION=(\S+)$/mu.exec(dockerfile)?.[1];
  assert.match(manifest.devDependencies["playwright-core"] ?? "", /^\d+\.\d+\.\d+$/u, "an exact version");
  assert.equal(pinned, manifest.devDependencies["playwright-core"]);
  assert.match(dockerfile, /^FROM development AS e2e$/mu);
  assert.match(dockerfile, /playwright-core install --with-deps --only-shell chromium/u);
});

it.live("the host entry validates its input before it needs Docker", () => Effect.gen(function* () {
  // the invoking PATH for sh, dirname and id; nothing else of the environment
  const run = (...args: string[]) => runProcess("sh", [join(repositoryRoot, "dev"), ...args], {env: {PATH: process.env.PATH ?? "/usr/bin:/bin"},
    cwd: repositoryRoot, timeoutMs: 10_000});
  const help = yield* run("--help");
  assert.equal(help.code, 0);
  for (const command of ["setup", "up", "down", "recreate", "rebuild", "reset", "reset-auth", "login codex|claude", "fixture", "ui-fixture", "check", "soak", "trial"]) {
    assert.match(help.stdout, new RegExp(`^  ${command.replace("|", "\\|")}\\b`, "mu"), command);
  }
  const badName = yield* run("--env", "Daily_Profile", "status");
  assert.equal(badName.code, 1);
  assert.match(badName.stderr, /environment names use the characters a-z, 0-9 and -/u);
  const badPort = yield* run("--port-base", "80", "status");
  assert.equal(badPort.code, 1);
  assert.match(badPort.stderr, /--port-base must be between 1025 and 65400/u);
  const missing = yield* run();
  assert.equal(missing.code, 2);
}));

// a folder whose only executables are links to the named tools of the invoking PATH, plus `extra` scripts
const toolFolder = (names: ReadonlyArray<string>, extra: Readonly<Record<string, string>> = {}) => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const folder = yield* fs.makeTempDirectoryScoped({prefix: "t3sup-dev-tools-"});
  for (const name of names) {
    const found = (process.env.PATH ?? "").split(":").map((dir) => join(dir, name)).find((path) => path.startsWith("/") && existsSync(path));
    assert.ok(found, `${name} is on the invoking PATH`);
    yield* fs.symlink(found!, join(folder, name));
  }
  for (const [name, body] of Object.entries(extra)) yield* fs.writeFileString(join(folder, name), body, {mode: 0o755});
  return folder;
});

it.live("worktree setup inside the development container installs with the container's toolchain, never Docker", () => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const record = join(yield* fs.makeTempDirectoryScoped({prefix: "t3sup-dev-setup-"}), "pnpm-args");
  // a stand-in pnpm records how it was called; the folder has no docker at all
  const tools = yield* toolFolder(["sh", "dirname", "id"], {pnpm: `#!/bin/sh\nprintf '%s\\n' "$PWD" "$@" > ${JSON.stringify(record)}\n`});
  const inside = yield* runProcess("sh", [join(repositoryRoot, "dev"), "setup"], {env: {PATH: tools, T3SUP_DEV_CONTAINER: "1"}, cwd: "/", timeoutMs: 10_000});
  assert.equal(inside.code, 0, inside.stderr);
  assert.deepEqual((yield* fs.readFileString(record)).trim().split("\n"),
    [repositoryRoot.replace(/\/$/u, ""), "install", "--frozen-lockfile", "--prefer-offline", "--store-dir", "/cache/pnpm-store"]);
  // the same command on a host without Docker stops before doing anything
  const host = yield* runProcess("sh", [join(repositoryRoot, "dev"), "setup"], {env: {PATH: tools}, cwd: "/", timeoutMs: 10_000});
  assert.equal(host.code, 1);
  assert.match(host.stderr, /Docker is required/u);
  // container management stays a host command
  const nested = yield* runProcess("sh", [join(repositoryRoot, "dev"), "up"], {env: {PATH: tools, T3SUP_DEV_CONTAINER: "1"}, cwd: "/", timeoutMs: 10_000});
  assert.equal(nested.code, 1);
  assert.match(nested.stderr, /manages the development containers from the host/u);
}).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)));
