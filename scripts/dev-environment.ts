import { spawn, type ChildProcess } from "node:child_process";
import { join, resolve } from "node:path";
import { NodeFileSystem, NodeRuntime } from "@effect/platform-node";
import { Cause, Console, Data, Deferred, Effect, Exit, FileSystem, Layer, Option, Schema } from "effect";
import { groupAlive, tsxLoader } from "../test/support/cli-process.js";
import { runProcess, waitForHttp } from "../test/support/g8-process.js";
import { NativeEnvelope } from "../src/native-envelope.js";
import { NativeRpc } from "../src/supervisor-native.js";
import { repositoryRoot } from "./local-run.js";
import { credentials, decodeDescriptor, ensureRuntime, issueSession, orchestrationProtocol, t3Command, t3Release, type T3Cli } from "./local-stack.js";

/*
  The persistent Docker development environment (docs/local-stack.md), run inside the development container that `./dev`
  starts. The private credentials volume holds T3's whole base directory in its own layout (chats, settings, native keys and
  T3-managed provider connections) beside the provider CLIs' home, CODEX_HOME and CLAUDE_CONFIG_DIR. The resettable data
  volume holds Supervisor's data, the development workspaces and this environment's own bookkeeping. `serve` keeps one
  pinned T3 and Supervisor from the mounted checkout running until the container stops; `reset-projects` removes the
  projects of the development workspaces, with all of their threads, through T3's own CLI before `./dev reset` drops the
  data volume; `logout-providers` signs out every provider instance that T3 itself can sign out, including T3-managed
  connections, for `./dev reset-auth`.
*/

export class DevEnvironmentError extends Data.TaggedError("DevEnvironmentError")<{readonly message: string}> {}
const failure = (message: string) => new DevEnvironmentError({message});

/** The volume layout of the development container. */
export interface DevPaths {
  readonly home: string;
  readonly codexHome: string;
  readonly claudeConfig: string;
  readonly t3Home: string;
  readonly supervisorData: string;
  readonly workspaces: string;
  readonly stack: string;
  readonly t3Runtime: string;
}

export interface DevPorts {
  readonly t3: number;
  readonly ui: number;
  readonly health: number;
}

const absolute = (env: NodeJS.ProcessEnv, name: string) => {
  const value = env[name];
  return value !== undefined && value.startsWith("/") ? Option.some(value) : Option.none();
};

/** The container's paths; the compose file sets every variable, and a missing or relative one is refused. */
export const devPaths = (env: NodeJS.ProcessEnv = process.env): Effect.Effect<DevPaths, DevEnvironmentError> => Effect.gen(function* () {
  const required = (name: string) => Option.match(absolute(env, name), {
    onNone: () => Effect.fail(failure(`${name} must name an absolute path inside the development container`)),
    onSome: Effect.succeed,
  });
  const credentialsRoot = yield* required("T3SUP_DEV_CREDENTIALS");
  const data = yield* required("T3SUP_DEV_DATA");
  const cache = yield* required("T3SUP_DEV_CACHE");
  return {
    home: yield* required("HOME"),
    codexHome: yield* required("CODEX_HOME"),
    claudeConfig: yield* required("CLAUDE_CONFIG_DIR"),
    t3Home: join(credentialsRoot, "t3"),
    supervisorData: join(data, "supervisor"),
    workspaces: join(data, "workspaces"),
    stack: join(data, "stack"),
    t3Runtime: join(cache, "t3-runtime"),
  };
});

/** The published ports; each one listens on the same number inside the container, so browser origins match. */
export const devPorts = (env: NodeJS.ProcessEnv = process.env): Effect.Effect<DevPorts, DevEnvironmentError> => Effect.gen(function* () {
  const port = (name: string) => {
    const value = Number(env[name]);
    return Number.isInteger(value) && value > 1024 && value < 65536 ? Effect.succeed(value) : Effect.fail(failure(`${name} must be a TCP port above 1024`));
  };
  return {t3: yield* port("T3SUP_DEV_T3_PORT"), ui: yield* port("T3SUP_DEV_UI_PORT"), health: yield* port("T3SUP_DEV_HEALTH_PORT")};
});

const codexFileStore = 'cli_auth_credentials_store = "file"';

/**
 * The Codex configuration that keeps the CLI login in CODEX_HOME/auth.json instead of an OS credential store; undefined
 * leaves the file as it is. The key goes first, before any table, and every existing line is kept, including an explicit
 * choice of another store.
 */
export const withCodexFileStore = (config: string | undefined): string | undefined =>
  config !== undefined && /^\s*cli_auth_credentials_store\s*=/mu.test(config) ? undefined
    : config === undefined || config.trim() === "" ? `${codexFileStore}\n` : `${codexFileStore}\n${config}`;

/** Prepares the credential and data folders (0700) and Codex file storage before any provider command runs. */
export const prepare = (paths: DevPaths) => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  for (const folder of [paths.home, join(paths.home, ".config"), join(paths.home, ".local", "share"), join(paths.home, ".local", "state"),
    paths.codexHome, paths.claudeConfig, paths.t3Home, paths.supervisorData, paths.workspaces, join(paths.stack, "secrets")]) {
    yield* fs.makeDirectory(folder, {recursive: true});
  }
  for (const folder of [paths.codexHome, paths.claudeConfig, paths.t3Home, join(paths.stack, "secrets")]) yield* fs.chmod(folder, 0o700);
  const config = join(paths.codexHome, "config.toml");
  const current = yield* fs.readFileString(config).pipe(Effect.option);
  const next = withCodexFileStore(Option.getOrUndefined(current));
  if (next !== undefined) yield* fs.writeFileString(config, next, {mode: 0o600});
});

/** The environment of T3 and of the provider CLIs it starts: the container's credential paths, telemetry off. */
export const t3Environment = (env: NodeJS.ProcessEnv, paths: DevPaths): Record<string, string> => {
  // T3SUP_DEV_CONTAINER reaches T3's worktree setup, so `sh dev setup` there uses the container's toolchain
  const inherited = ["PATH", "LANG", "TMPDIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "DISABLE_AUTOUPDATER",
    "COREPACK_HOME", "COREPACK_ENABLE_DOWNLOAD_PROMPT", "T3SUP_DEV_CONTAINER"];
  return {
    ...Object.fromEntries(inherited.flatMap((name) => env[name] === undefined ? [] : [[name, env[name]!]])),
    HOME: paths.home, CODEX_HOME: paths.codexHome, CLAUDE_CONFIG_DIR: paths.claudeConfig, T3CODE_HOME: paths.t3Home,
    T3CODE_TELEMETRY_ENABLED: "false", T3CODE_OTEL_SDK_DISABLED: "true", T3CODE_NO_BROWSER: "true", DO_NOT_TRACK: "1",
  };
};

/*
  Supervisor's environment: its data, the T3 it reads, its dashboard and health listeners on the published ports, and the session
  files it was issued. T3 keeps its No Project chats in its scratch project, at `path.resolve(config.baseDir, "scratch")` for a base
  directory outside a Git checkout (apps/server/src/project/ManagedProjectFolders.ts), and this environment serves T3 with
  `--base-dir paths.t3Home` in the credentials volume; Supervisor takes exactly the project at the absolute, normalized
  T3_MANAGED_SCRATCH_ROOT for No Project (src/guidance-application.ts), as an installation configures it.
*/
export const supervisorEnvironment = (input: {readonly env: Readonly<Record<string, string>>; readonly paths: DevPaths; readonly ports: DevPorts;
  readonly t3Url: string; readonly assets: string; readonly files: Readonly<Record<string, string>>}): Record<string, string> => ({
  PATH: input.env.PATH ?? "", HOME: input.paths.home, LANG: "C.UTF-8", TMPDIR: input.env.TMPDIR ?? "/tmp", DATA_DIRECTORY: input.paths.supervisorData,
  T3_URL: input.t3Url, UI_ASSETS_DIRECTORY: input.assets, UI_HOST: "0.0.0.0", UI_PORT: String(input.ports.ui), HEALTH_HOST: "0.0.0.0",
  HEALTH_PORT: String(input.ports.health), T3_MANAGED_SCRATCH_ROOT: join(input.paths.t3Home, "scratch"), ...input.files,
});

// scoped T3 sessions of this environment carry these subjects, so a later start finds and revokes them after any stop
export const sessionSubjectPrefix = "t3-supervisor-dev:";
export const devSessionTtl = "24h";
const renewEvery = "12 hours";

const ListedSession = Schema.Struct({sessionId: Schema.String, subject: Schema.optionalKey(Schema.NullOr(Schema.String))});
const decodeSessions = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(ListedSession)));

/** The sessions of an `auth session list --json` reply that this environment issued. */
export const environmentSessions = (reply: string) => decodeSessions(reply.trim()).pipe(
  Effect.map((sessions) => sessions.filter((session) => session.subject?.startsWith(sessionSubjectPrefix) === true).map((session) => session.sessionId)),
  Effect.mapError(() => failure("t3 listed its sessions in an unexpected shape")));

const revokeEnvironmentSessions = (cli: T3Cli) => Effect.gen(function* () {
  const stale = yield* environmentSessions(yield* t3Command(cli, ["auth", "session", "list", "--json"]));
  for (const sessionId of stale) yield* t3Command(cli, ["auth", "session", "revoke", sessionId]);
  return stale.length;
});

interface Supervised {
  readonly name: string;
  readonly child: ChildProcess;
  readonly alive: () => boolean;
  readonly exited: Effect.Effect<never, DevEnvironmentError>;
}

/*
  A child for the container's lifetime. Its output goes straight to the container log, which the buffering test-harness
  spawner cannot provide; it leads its own process group, and closing the scope stops that group with SIGTERM, then
  SIGKILL once the grace period has passed.
*/
const supervised = (name: string, command: string, args: ReadonlyArray<string>, env: Record<string, string>, cwd: string) =>
  Effect.acquireRelease(Effect.gen(function* () {
    const done = Deferred.makeUnsafe<{readonly code: number | null; readonly signal: string | null}>();
    const child = spawn(command, [...args], {env, cwd, detached: true, stdio: ["ignore", "inherit", "inherit"]});
    child.once("exit", (code, signal) => Deferred.doneUnsafe(done, Exit.succeed({code, signal})));
    child.once("error", () => Deferred.doneUnsafe(done, Exit.succeed({code: null, signal: null})));
    if (child.pid === undefined) return yield* failure(`could not start ${name}`);
    const exited = Effect.flatMap(Deferred.await(done), (result) =>
      Effect.fail(failure(`${name} stopped on its own (${result.signal ?? `exit ${String(result.code)}`}); see the container log`)));
    return {name, child, alive: () => child.exitCode === null && child.signalCode === null, exited, done} as const;
  }), (running) => Effect.gen(function* () {
    const pid = running.child.pid!;
    if (groupAlive(pid)) process.kill(-pid, "SIGTERM");
    const stopped = yield* Deferred.await(running.done).pipe(Effect.timeoutOption("20 seconds"));
    if (Option.isNone(stopped) && groupAlive(pid)) {
      process.kill(-pid, "SIGKILL");
      yield* Deferred.await(running.done).pipe(Effect.timeoutOption("5 seconds"));
    }
  })).pipe(Effect.map(({name: label, child, alive, exited}): Supervised => ({name: label, child, alive, exited})));

const reason = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause);
  return error instanceof Error ? error.message : String(error);
};

// waits until `url` answers HTTP 200; a deadline or the child's exit becomes this environment's failure with its reason
const ready = (label: string, url: string, alive: () => boolean, timeoutMs: number) =>
  Effect.exit(waitForHttp(url, (status) => status === 200, timeoutMs, alive)).pipe(Effect.flatMap((exit) => Exit.isSuccess(exit)
    ? Effect.succeed(exit.value) : Effect.fail(failure(`${label} did not become ready: ${reason(exit.cause)}`))));

const WorkspaceProject = Schema.Struct({path: Schema.String, id: Schema.NullOr(Schema.String)});

/*
  The development sandbox project, registered with T3 once per data volume: a later start reads the record instead of
  adding another project. A reset that kept T3's earlier registration of the same folder is accepted as that project.
*/
const workspaceProject = (cli: T3Cli, paths: DevPaths) => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const record = join(paths.stack, "workspace-project.json");
  const existing = yield* fs.readFileString(record).pipe(Effect.option);
  if (Option.isSome(existing)) {
    return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(WorkspaceProject))(existing.value)
      .pipe(Effect.mapError(() => failure(`${record} is unreadable; remove it to register the sandbox again`)));
  }
  const path = join(paths.workspaces, "sandbox");
  if (!(yield* fs.exists(join(path, ".git")))) {
    yield* fs.makeDirectory(path, {recursive: true});
    yield* fs.writeFileString(join(path, "README.md"), "# Supervisor development sandbox\n\nA project of the Docker development environment.\n");
    const env = {...cli.env, GIT_AUTHOR_NAME: "Supervisor development", GIT_AUTHOR_EMAIL: "development@example.invalid",
      GIT_COMMITTER_NAME: "Supervisor development", GIT_COMMITTER_EMAIL: "development@example.invalid"};
    for (const args of [["init", "-q", "-b", "main"], ["add", "README.md"], ["commit", "-q", "-m", "Development sandbox"]]) {
      const git = yield* runProcess("git", args, {env, cwd: path, timeoutMs: 30_000});
      if (git.code !== 0) return yield* failure(`git ${args[0]} failed in the sandbox: ${git.stderr.trim()}`);
    }
  }
  const added = yield* t3Command(cli, ["project", "add", "--title", "Supervisor development sandbox", path]).pipe(
    Effect.map((stdout) => Option.fromNullishOr(/Added project (\S+)/u.exec(stdout)?.[1])),
    Effect.catch((error) => /already exists/iu.test(error.message) ? Effect.succeed(Option.none<string>()) : Effect.fail(error)));
  const project = {path, id: Option.getOrNull(added)};
  yield* fs.writeFileString(record, `${JSON.stringify(project)}\n`);
  return project;
});

/** Runs T3 and Supervisor until the container stops; a child that stops on its own ends the environment with an error. */
const serve = Effect.scoped(Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* devPaths();
  const ports = yield* devPorts();
  yield* prepare(paths);
  const assets = join(repositoryRoot, "ui-dist");
  if (!(yield* fs.exists(join(assets, "index.html")))) return yield* failure("the dashboard is not built; `./dev up` builds it");
  const executable = yield* ensureRuntime(paths.t3Runtime);
  const env = t3Environment(process.env, paths);
  const cli: T3Cli = {executable, baseDir: paths.t3Home, env, cwd: paths.workspaces};
  const t3 = yield* supervised("T3", executable, ["serve", "--host", "0.0.0.0", "--port", String(ports.t3), "--base-dir", paths.t3Home,
    "--no-browser", paths.workspaces], env, paths.workspaces);
  const t3Url = `http://127.0.0.1:${ports.t3}`;
  const reply = yield* ready("T3", `${t3Url}/.well-known/t3/environment`, t3.alive, 180_000);
  const descriptor = yield* decodeDescriptor(reply.body);
  if (descriptor.serverVersion !== t3Release.version) return yield* failure(`T3 reports ${descriptor.serverVersion}, not the pinned ${t3Release.version}`);
  if (descriptor.orchestrationProtocolVersion !== orchestrationProtocol)
    return yield* failure(`T3 serves orchestration protocol ${descriptor.orchestrationProtocolVersion}; Supervisor reads protocol ${orchestrationProtocol}`);
  const revoked = yield* revokeEnvironmentSessions(cli);
  const project = yield* workspaceProject(cli, paths);
  const supervisorEnv = (files: Record<string, string>) => supervisorEnvironment({env, paths, ports, t3Url, assets, files});
  yield* Console.log([
    `T3 ${descriptor.serverVersion} (published, unmodified) at http://127.0.0.1:${ports.t3}; ${revoked} earlier scoped session(s) revoked`,
    `development sandbox ${project.id ?? "(registered earlier)"} at ${project.path}`,
  ].join("\n"));
  /*
    Each generation issues fresh scoped sessions, runs Supervisor on them, then stops it before revoking them. A session's
    revocation is registered as soon as it exists, so a failure halfway through issuing revokes the earlier ones; a failed
    generation finally revokes every session of this environment's subjects, also one whose issuance reply was unreadable.
  */
  const generation = Effect.scoped(Effect.gen(function* () {
    yield* Effect.addFinalizer((exit) => Exit.isFailure(exit) ? Effect.ignore(revokeEnvironmentSessions(cli)) : Effect.void);
    const sessions = yield* Effect.forEach(credentials, (credential) => issueSession(cli, credential, {
      file: join(paths.stack, "secrets", `t3-${credential.name}-token`), ttl: devSessionTtl,
      label: `t3-supervisor-dev-${credential.name}`, subject: `${sessionSubjectPrefix}${credential.name}`}).pipe(
      Effect.tap((session) => Effect.addFinalizer(() => Effect.ignore(t3Command(cli, ["auth", "session", "revoke", session.sessionId]))))));
    const supervisor = yield* supervised("Supervisor", process.execPath, ["--import", tsxLoader, join(repositoryRoot, "src", "main.ts")],
      supervisorEnv(Object.fromEntries(sessions.map((session) => [session.credential.variable, session.file]))), repositoryRoot);
    yield* ready("Supervisor", `http://127.0.0.1:${ports.health}/health`, supervisor.alive, 120_000);
    yield* Console.log(`Supervisor ready at http://127.0.0.1:${ports.ui}; scoped T3 sessions expire ${sessions[0]?.expiresAt ?? "unknown"} and renew every 12 hours`);
    yield* Effect.raceFirst(Effect.sleep(renewEvery), supervisor.exited);
  }));
  return yield* Effect.raceFirst(t3.exited, Effect.forever(generation));
}));

// the T3 CLI of the running environment, for the commands `./dev` runs beside `serve`
const runningCli = Effect.gen(function* () {
  const paths = yield* devPaths();
  const executable = yield* ensureRuntime(paths.t3Runtime);
  return {paths, cli: {executable, baseDir: paths.t3Home, env: t3Environment(process.env, paths), cwd: paths.workspaces} satisfies T3Cli};
});

/*
  The T3 part of the ordinary reset: every folder of the development workspaces that T3 knows as a project is removed with
  all of its threads through `t3 project remove --force`, the supported operation. T3's settings, native keys and provider
  connections stay. Any other failure stops the reset before the data volume is dropped.
*/
const resetProjects = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const {paths, cli} = yield* runningCli;
  const folders = (yield* fs.exists(paths.workspaces)) ? yield* fs.readDirectory(paths.workspaces) : [];
  const removed: string[] = [];
  for (const name of folders.toSorted()) {
    const path = join(paths.workspaces, name);
    const outcome = yield* t3Command(cli, ["project", "remove", "--force", path], 120_000).pipe(Effect.as(undefined), Effect.catch((error) => Effect.succeed(error.message)));
    if (outcome === undefined) removed.push(path);
    else if (!/not found|no project|unknown project|is not a project|does not exist/iu.test(outcome)) {
      return yield* failure(`T3 could not remove the project at ${path}, so nothing was reset: ${outcome}`);
    }
  }
  yield* Console.log(removed.length ? `removed ${removed.length} T3 project(s) with their threads:${removed.map((path) => `\n  ${path}`).join("")}`
    : "no T3 project used the development workspaces");
});

const ProviderView = Schema.Struct({instanceId: Schema.String, driver: Schema.String,
  auth: Schema.Struct({status: Schema.String, canLogout: Schema.optionalKey(Schema.Boolean)})});
const decodeProviders = Schema.decodeUnknownEffect(Schema.Struct({providers: Schema.Array(ProviderView)}));

/** The provider instances of a `server.getConfig` reply that T3 offers to sign out, as its Settings page does. */
export const signedOutByT3 = (config: unknown) => decodeProviders(config).pipe(
  Effect.map(({providers}) => providers.filter((provider) => provider.auth.canLogout === true)),
  Effect.mapError(() => failure("T3 reported its providers in an unexpected shape")));

/*
  The T3 part of `./dev reset-auth`: one temporary session (providers:manage, five minutes) reads the provider instances and
  signs out each one T3 can sign out through `provider.auth.logout`, the operation behind Settings > Providers > Sign out.
  It covers T3-managed connections such as Connect with ChatGPT; the session is revoked afterwards and its bearer stays in a
  0600 file removed with it. Chats, settings and data stay.
*/
const logoutProviders = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const {paths, cli} = yield* runningCli;
  const ports = yield* devPorts();
  const credential = {name: "auth-reset", variable: "T3_AUTH_RESET_TOKEN_FILE", scopes: ["orchestration:read", "providers:manage"]} as const;
  const file = join(paths.stack, "secrets", "t3-auth-reset-token");
  yield* Effect.addFinalizer(() => Effect.ignore(fs.remove(file)));
  const session = yield* issueSession(cli, credential, {file, ttl: "5m", label: "t3-supervisor-dev-auth-reset",
    subject: `${sessionSubjectPrefix}auth-reset`});
  yield* Effect.addFinalizer(() => Effect.ignore(t3Command(cli, ["auth", "session", "revoke", session.sessionId])));
  const token = (yield* fs.readFileString(file)).trim();
  const outcomes = yield* Effect.gen(function* () {
    const native = yield* NativeRpc;
    const providers = yield* signedOutByT3(yield* native.call("server.getConfig", {}).pipe(Effect.mapError(() => failure("T3 did not report its providers"))));
    return yield* Effect.forEach(providers, (provider) => native.call("provider.auth.logout", {instanceId: provider.instanceId}).pipe(
      Effect.as(`${provider.instanceId} (${provider.driver}) signed out by T3`),
      Effect.catch((error) => Effect.succeed(`${provider.instanceId} (${provider.driver}) not confirmed: ${error.outcome}`))));
  }).pipe(Effect.provide(NativeRpc.layer({baseUrl: `http://127.0.0.1:${ports.t3}`, token}).pipe(Layer.provide(NativeEnvelope.layer))));
  yield* Console.log(outcomes.length ? outcomes.join("\n") : "T3 reported no provider instance it can sign out");
  if (outcomes.some((outcome) => outcome.includes("not confirmed"))) return yield* failure("T3 did not confirm every sign-out; check Settings > Providers");
}).pipe(Effect.scoped);

/** One finished CLI call, as the sign-out classification reads it. */
export interface CliResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

const ClaudeStatus = Schema.Struct({authMethod: Schema.optionalKey(Schema.String), loggedIn: Schema.optionalKey(Schema.Boolean),
  configDirectory: Schema.optionalKey(Schema.String)});
const decodeClaudeStatus = Schema.decodeUnknownOption(Schema.fromJsonString(ClaudeStatus));

/** Claude's documented `claude auth status` for no login: exit 1 with its status JSON saying so for this config folder. */
export const claudeSignedOut = (result: CliResult, claudeConfig: string): boolean => {
  if (result.code !== 1) return false;
  return Option.match(decodeClaudeStatus(result.stdout.trim()), {
    onNone: () => false,
    onSome: (status) => (status.authMethod !== undefined || status.loggedIn !== undefined) && (status.authMethod === undefined || status.authMethod === "none") &&
      (status.loggedIn === undefined || !status.loggedIn) && (status.configDirectory === undefined || resolve(status.configDirectory) === resolve(claudeConfig)),
  });
};

/*
  The CLI part of `./dev reset-auth`: each provider CLI's own logout, then its own status as the proof. A logout that fails
  because nothing was signed in is fine; the status decides. Claude's status must be its documented JSON for no login, with
  exit 1; Codex exits non-zero and reports "Not logged in". Anything else, including a status that still finds a login or
  any other failure, fails the reset. Status output can name the account, so it is never printed.
*/
export const cliSignOuts = [
  {name: "Codex", logout: ["codex", "logout"], status: ["codex", "login", "status"],
    signedOut: (result: CliResult, _paths: Pick<DevPaths, "claudeConfig">) =>
      result.code !== 0 && result.code !== null && /not logged in/iu.test(`${result.stdout}\n${result.stderr}`)},
  {name: "Claude", logout: ["claude", "auth", "logout"], status: ["claude", "auth", "status"],
    signedOut: (result: CliResult, paths: Pick<DevPaths, "claudeConfig">) => claudeSignedOut(result, paths.claudeConfig)},
] as const;

const logoutClis = Effect.gen(function* () {
  const paths = yield* devPaths();
  const env = t3Environment(process.env, paths);
  const outcomes: string[] = [];
  for (const cli of cliSignOuts) {
    const [command, ...logoutArgs] = cli.logout;
    const logout = yield* runProcess(command, logoutArgs, {env, cwd: paths.home, timeoutMs: 60_000});
    const [statusCommand, ...statusArgs] = cli.status;
    const status = yield* runProcess(statusCommand, statusArgs, {env, cwd: paths.home, timeoutMs: 60_000});
    outcomes.push(cli.signedOut(status, paths) ? `${cli.name} CLI signed out`
      : `${cli.name} CLI still signed in or its status is unknown (logout exit ${String(logout.code)}, status exit ${String(status.code)})`);
  }
  yield* Console.log(outcomes.join("\n"));
  if (outcomes.some((outcome) => !outcome.endsWith("signed out"))) return yield* failure("a provider CLI is not signed out");
});

// a one-time T3 pairing link for this browser; T3 prints it, and it expires after 15 minutes
const pair = Effect.gen(function* () {
  const {cli} = yield* runningCli;
  const ports = yield* devPorts();
  yield* Console.log((yield* t3Command(cli, ["auth", "pairing", "create", "--ttl", "15m", "--base-url", `http://127.0.0.1:${ports.t3}`])).trim());
});

const usage = "usage: node --import tsx scripts/dev-environment.ts serve|prepare|reset-projects|logout-providers|logout-clis|pair";

const main = Effect.gen(function* () {
  const command = process.argv[2];
  if (command === "serve") return yield* serve;
  if (command === "prepare") return yield* Effect.flatMap(devPaths(), prepare);
  if (command === "reset-projects") return yield* resetProjects;
  if (command === "logout-providers") return yield* logoutProviders;
  if (command === "logout-clis") return yield* logoutClis;
  if (command === "pair") return yield* pair;
  return yield* failure(usage);
});

if (import.meta.main) NodeRuntime.runMain(main.pipe(Effect.tapCause((cause) => Console.error(reason(cause))), Effect.provide(NodeFileSystem.layer)),
  {disableErrorReporting: true});
