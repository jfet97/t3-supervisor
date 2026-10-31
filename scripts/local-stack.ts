import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { NodeFileSystem, NodeRuntime } from "@effect/platform-node";
import { Console, Data, Effect, FileSystem, Layer, Option, Schema, Stream } from "effect";
import { FetchHttpClient, HttpBody, HttpClient, HttpClientRequest } from "effect/http";
import { groupAlive, tsxLoader } from "../test/support/cli-process.js";
import { freePort, httpGet, portState, runProcess, startProcess, waitForHttp, type RunningProcess } from "../test/support/g8-process.js";
import { cacheHome, cleanRuns, createRun, isolatedEnv, repositoryRoot, shellQuote, toolPath, type RunFolder } from "./local-run.js";

/*
  `pnpm dev:stack`: an unmodified published T3 at a pinned version beside Supervisor from this checkout, each with its own
  state and loopback ports in one fresh run folder (docs/local-stack.md). T3 issues every Supervisor credential through its
  own CLI with the scopes that credential needs; the stack never reads or writes T3's databases, never contacts another T3
  and never copies a login. Stopping it stops Supervisor, revokes the sessions, stops T3 and removes the run folder.
*/

/**
 * The pinned published T3 release. To move the pin, set the version and copy each platform's archive digest from the
 * release's SHA256SUMS; the archive is the one the `t3` npm launcher itself downloads.
 */
export const t3Release = {
  version: "0.1.6",
  baseUrl: "https://github.com/pingdotgg/t3code/releases/download",
  archives: {
    "darwin-arm64": "50c5dfd3e83787c182299a37db3553968346904e7dc7936b2a01061dbfcf90eb",
    "linux-arm64": "b708f059200776f50623a766854841e40eda0bb67614211cf8b6909295ce20da",
    "linux-x64": "7cf31da90dee41f524dd5b679ebb6d404637ca5d9dc6fd8bc019511d57bb77e6",
  } as Readonly<Record<string, string>>,
};
export type T3Release = typeof t3Release;

/**
 * Supervisor's credentials, one T3 session each, scoped to the calls that credential carries as T3 0.1.6 authorizes them:
 * shell, thread and turn reads, server config and project file reads; dispatch and launch; file writes; setup commits
 * (`git.runStackedAction`); the terminal Git probe.
 */
export const credentials = [
  {name: "read", variable: "T3_TOKEN_FILE", scopes: ["orchestration:read", "filesystem:read"]},
  {name: "guidance", variable: "T3_GUIDANCE_TOKEN_FILE", scopes: ["orchestration:operate"]},
  {name: "project-write", variable: "T3_PROJECT_WRITE_TOKEN_FILE", scopes: ["filesystem:read", "filesystem:write"]},
  {name: "project-commit", variable: "T3_PROJECT_COMMIT_TOKEN_FILE", scopes: ["source-control:write"]},
  {name: "git-probe", variable: "T3_GIT_PROBE_TOKEN_FILE", scopes: ["terminal:operate"]},
] as const;
export type Credential = typeof credentials[number];

export const sessionTtl = "8h";
export const completeMarker = ".install-complete";
const workflowTools = ["workflow_read", "workflow_write", "supervision_start", "supervision_stop", "supervision_plan",
  "supervision_interpretation_submit", "supervision_team", "supervision_guide", "supervision_planning"];

export class LocalStackError extends Data.TaggedError("LocalStackError")<{readonly message: string}> {}
const failure = (message: string) => new LocalStackError({message});

export const platformKey = (platform: string = process.platform, arch: string = process.arch): string => `${platform}-${arch}`;
export const archiveName = (release: T3Release, platform: string): string => `t3-${release.version}-${platform}.tar.gz`;

// the platform fetch, which follows the release download's redirect
const fetchClient = FetchHttpClient.layer.pipe(Layer.provide(Layer.sync(FetchHttpClient.Fetch, () => globalThis.fetch)));

// the archive streamed into `file`; its SHA-256, computed over the bytes written
const download = (url: string, file: string) => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const client = yield* HttpClient.HttpClient;
  const response = yield* client.execute(HttpClientRequest.get(url));
  if (response.status !== 200) return yield* failure(`GET ${url} returned HTTP ${response.status}`);
  const hash = createHash("sha256");
  yield* response.stream.pipe(Stream.tap((chunk) => Effect.sync(() => hash.update(chunk))), Stream.run(fs.sink(file)));
  return hash.digest("hex");
}).pipe(Effect.provide(fetchClient));

/**
 * The pinned T3 executable in `cacheRoot`, downloaded once per version and platform: the archive must match the pinned
 * digest before it is unpacked, and a folder is used only with its completion marker naming that digest.
 */
export const ensureRuntime = (cacheRoot: string, release: T3Release = t3Release, platform: string = platformKey()) => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const digest = release.archives[platform];
  if (digest === undefined) return yield* failure(`no pinned T3 ${release.version} archive for ${platform}`);
  const target = join(cacheRoot, `t3-${release.version}-${platform}`);
  const executable = join(target, "t3");
  const installed = yield* fs.readFileString(join(target, completeMarker)).pipe(Effect.option);
  if (Option.isSome(installed) && installed.value.trim() === digest) return executable;
  yield* fs.makeDirectory(cacheRoot, {recursive: true});
  const staging = yield* fs.makeTempDirectory({directory: cacheRoot, prefix: `t3-${release.version}-${platform}.staging-`});
  yield* Effect.gen(function* () {
    const name = archiveName(release, platform);
    const archive = join(staging, name);
    yield* Console.error(`downloading T3 ${release.version} (${platform}) into ${cacheRoot}`);
    const actual = yield* download(`${release.baseUrl}/v${release.version}/${name}`, archive);
    if (actual !== digest) return yield* failure(`${name} has SHA-256 ${actual}, not the pinned ${digest}; nothing was installed`);
    const unpacked = yield* runProcess("tar", ["-xzf", archive, "-C", staging, "--strip-components=1"],
      {env: {PATH: toolPath(["tar", "gzip"], process.env.PATH ?? "")}, cwd: staging, timeoutMs: 300_000});
    if (unpacked.code !== 0) return yield* failure(`could not unpack ${name}: ${unpacked.stderr.trim()}`);
    yield* fs.remove(archive);
    yield* fs.writeFileString(join(staging, completeMarker), `${digest}\n`);
    if (yield* fs.exists(target)) yield* fs.remove(target, {recursive: true});
    yield* fs.rename(staging, target);
  }).pipe(Effect.ensuring(Effect.ignore(fs.remove(staging, {recursive: true}))));
  return executable;
});

export const defaultCacheRoot = (): string => join(cacheHome(), "t3-supervisor", "local-stack");

/** One T3 command of this run: the pinned executable over the run's T3 data directory and environment. */
export interface T3Cli {
  readonly executable: string;
  readonly baseDir: string;
  readonly env: Record<string, string>;
  readonly cwd: string;
}

const t3Command = (cli: T3Cli, args: ReadonlyArray<string>, timeoutMs = 60_000) => Effect.gen(function* () {
  const result = yield* runProcess(cli.executable, [...args, "--base-dir", cli.baseDir], {env: cli.env, cwd: cli.cwd, timeoutMs});
  if (result.code !== 0) return yield* failure(`t3 ${args.slice(0, 3).join(" ")} exited ${String(result.code)}: ${result.stderr.trim().slice(0, 400)}`);
  return result.stdout;
});

/** The environment of the run's T3 processes: the run's home and data directory, telemetry off, no browser. */
export const t3Environment = (run: RunFolder): Record<string, string> => isolatedEnv(run.path, ["git"], process.env, {
  T3CODE_HOME: run.dir("t3"), T3CODE_TELEMETRY_ENABLED: "false", T3CODE_OTEL_SDK_DISABLED: "true", T3CODE_NO_BROWSER: "true",
});

/** The arguments of the run's T3 server: loopback only, its own port and data directory, provider sessions in the run's projects. */
export const serveArguments = (run: RunFolder, port: number): ReadonlyArray<string> =>
  ["serve", "--host", "127.0.0.1", "--port", String(port), "--base-dir", run.dir("t3"), "--no-browser", run.dir("projects")];

const Issued = Schema.Struct({sessionId: Schema.String, token: Schema.String, scopes: Schema.Array(Schema.String), expiresAt: Schema.String});
const decodeIssued = Schema.decodeUnknownEffect(Schema.fromJsonString(Issued));

export interface IssuedSession {
  readonly credential: Credential;
  readonly sessionId: string;
  readonly expiresAt: string;
  readonly file: string;
}

// one bounded, scoped session through T3's own auth CLI; its bearer goes only to a 0600 file in the run's secrets folder
const issueSession = (cli: T3Cli, run: RunFolder, credential: Credential) => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const stdout = yield* t3Command(cli, ["auth", "session", "issue", ...credential.scopes.flatMap((scope) => ["--scope", scope]),
    "--ttl", sessionTtl, "--label", `t3-supervisor-local-${credential.name}`, "--json"]);
  const issued = yield* decodeIssued(stdout.trim()).pipe(Effect.mapError(() => failure(`t3 issued an unreadable ${credential.name} session`)));
  if ([...issued.scopes].sort().join(" ") !== [...credential.scopes].sort().join(" "))
    return yield* failure(`t3 issued the ${credential.name} session with scopes ${issued.scopes.join(", ")}`);
  const file = run.dir("secrets", `t3-${credential.name}-token`);
  yield* fs.writeFileString(file, `${issued.token}\n`, {mode: 0o600});
  return {credential, sessionId: issued.sessionId, expiresAt: issued.expiresAt, file} satisfies IssuedSession;
});

// a disposable Git project in the run folder, added to the run's T3 through its project CLI
const disposableProject = (cli: T3Cli, run: RunFolder) => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = run.dir("projects", "demo");
  yield* fs.makeDirectory(path, {recursive: true});
  yield* fs.writeFileString(join(path, "README.md"), "# Local stack demo\n\nA disposable project created by `pnpm dev:stack`.\n");
  const env = {...cli.env, GIT_AUTHOR_NAME: "Local stack", GIT_AUTHOR_EMAIL: "local-stack@example.invalid",
    GIT_COMMITTER_NAME: "Local stack", GIT_COMMITTER_EMAIL: "local-stack@example.invalid"};
  for (const args of [["init", "-q", "-b", "main"], ["add", "README.md"], ["commit", "-q", "-m", "Disposable local-stack project"]]) {
    const git = yield* runProcess("git", args, {env, cwd: path, timeoutMs: 30_000});
    if (git.code !== 0) return yield* failure(`git ${args[0]} failed: ${git.stderr.trim()}`);
  }
  const added = yield* t3Command(cli, ["project", "add", "--title", "Local stack demo", path]);
  const id = /Added project (\S+)/u.exec(added)?.[1];
  if (id === undefined) return yield* failure("t3 did not report the added project");
  return {id, path};
});

// a graceful stop of a child's process group within the bound; the process harness kills whatever is left
const stop = (child: RunningProcess) => Effect.gen(function* () {
  if (groupAlive(child.pid)) yield* Effect.sync(() => process.kill(-child.pid, "SIGTERM"));
  yield* Effect.ignore(child.closed(20_000));
});

/** The parts of a running stack that the summary and the checks read. */
export interface RunningStack {
  readonly run: RunFolder;
  readonly cli: T3Cli;
  readonly t3: {readonly url: string; readonly port: number; readonly version: string; readonly protocol: number; readonly process: RunningProcess};
  readonly supervisor: {readonly url: string; readonly healthUrl: string; readonly ports: readonly [number, number]; readonly process: RunningProcess};
  readonly sessions: ReadonlyArray<IssuedSession>;
  readonly project: {readonly id: string; readonly path: string};
}

// the native orchestration protocol Supervisor reads (src/t3.ts)
export const orchestrationProtocol = 2;
const Descriptor = Schema.Struct({environmentId: Schema.String, orchestrationProtocolVersion: Schema.Number, serverVersion: Schema.String});

/**
 * Starts the stack in the caller's scope. Closing the scope stops Supervisor, revokes every issued session, stops T3 and
 * removes the run folder unless `keep` is set, in that order.
 */
export const startStack = (options: {readonly cacheRoot: string; readonly keep: boolean}) => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const assets = join(repositoryRoot, "ui-dist");
  if (!(yield* fs.exists(join(assets, "index.html")))) return yield* failure("the dashboard is not built; run `pnpm build` first");
  const executable = yield* ensureRuntime(options.cacheRoot);
  const run = yield* createRun("stack", {keep: options.keep});
  for (const folder of ["home", "tmp", "t3", "projects", "supervisor", "secrets"]) yield* fs.makeDirectory(run.dir(folder), {recursive: true});
  yield* fs.chmod(run.dir("secrets"), 0o700);
  const cli: T3Cli = {executable, baseDir: run.dir("t3"), env: t3Environment(run), cwd: run.dir("projects")};
  const t3Port = yield* freePort;
  const server = yield* startProcess(executable, serveArguments(run, t3Port), {env: cli.env, cwd: cli.cwd});
  yield* Effect.addFinalizer(() => stop(server));
  const t3Url = `http://127.0.0.1:${t3Port}`;
  const reply = yield* waitForHttp(`${t3Url}/.well-known/t3/environment`, (status) => status === 200, 90_000, () => server.child.exitCode === null);
  const descriptor = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Descriptor))(reply.body)
    .pipe(Effect.mapError(() => failure("the T3 descriptor has an unexpected shape")));
  if (descriptor.orchestrationProtocolVersion !== orchestrationProtocol)
    return yield* failure(`T3 ${descriptor.serverVersion} serves orchestration protocol ${descriptor.orchestrationProtocolVersion}; Supervisor reads protocol ${orchestrationProtocol}`);
  const sessions = yield* Effect.forEach(credentials, (credential) => issueSession(cli, run, credential));
  yield* Effect.addFinalizer(() => Effect.forEach(sessions, (session) => Effect.ignore(t3Command(cli, ["auth", "session", "revoke", session.sessionId]))));
  const project = yield* disposableProject(cli, run);
  const [uiPort, healthPort] = [yield* freePort, yield* freePort];
  const env = isolatedEnv(run.path, ["git"], process.env, {
    DATA_DIRECTORY: run.dir("supervisor"), T3_URL: t3Url, UI_ASSETS_DIRECTORY: assets,
    UI_HOST: "127.0.0.1", UI_PORT: String(uiPort), HEALTH_HOST: "127.0.0.1", HEALTH_PORT: String(healthPort),
    ...Object.fromEntries(sessions.map((session) => [session.credential.variable, session.file])),
  });
  const supervisor = yield* startProcess(process.execPath, ["--import", tsxLoader, join(repositoryRoot, "src", "main.ts")], {env, cwd: repositoryRoot});
  yield* Effect.addFinalizer(() => stop(supervisor));
  const healthUrl = `http://127.0.0.1:${healthPort}/health`;
  yield* waitForHttp(healthUrl, (status) => status === 200, 90_000, () => supervisor.child.exitCode === null);
  return {run, cli, t3: {url: t3Url, port: t3Port, version: descriptor.serverVersion, protocol: descriptor.orchestrationProtocolVersion, process: server},
    supervisor: {url: `http://127.0.0.1:${uiPort}`, healthUrl, ports: [uiPort, healthPort], process: supervisor}, sessions, project} satisfies RunningStack;
});

export const summary = (stack: RunningStack): string => {
  const env = (vars: Record<string, string>) => Object.entries(vars).map(([key, value]) => `${key}=${shellQuote(value)}`).join(" ");
  const t3Env = env({HOME: stack.cli.env.HOME!, PATH: stack.cli.env.PATH!, T3CODE_HOME: stack.cli.baseDir, T3CODE_TELEMETRY_ENABLED: "false"});
  return [
    `Local stack running from run folder ${stack.run.path}`,
    `  T3 ${stack.t3.version} (published, unmodified)  ${stack.t3.url}  data ${stack.cli.baseDir}`,
    `  Supervisor (this checkout)        ${stack.supervisor.url}  data ${stack.run.dir("supervisor")}`,
    `  health                            ${stack.supervisor.healthUrl}`,
    `  workflow MCP                      ${stack.supervisor.url}/mcp/workflows  bearer file ${stack.run.dir("supervisor", "access", "workflow-mcp-token")}`,
    `  T3 credentials                    ${stack.sessions.map((session) => `${session.credential.name}=${session.credential.scopes.join("+")}`).join(", ")}`,
    `                                    files in ${stack.run.dir("secrets")}, expire ${stack.sessions[0]?.expiresAt ?? "unknown"}`,
    `  disposable project                ${stack.project.id} at ${stack.project.path}`,
    "",
    "Sign in to the dashboard with a one-time token:",
    `  node --import tsx src/cli.ts auth forge --data-dir ${shellQuote(stack.run.dir("supervisor"))}`,
    "Open the isolated T3 (for example to sign in to a provider on purpose; the login stays in this run folder):",
    `  env -i ${t3Env} ${shellQuote(stack.cli.executable)} auth pairing create --base-dir ${shellQuote(stack.cli.baseDir)} --ttl 15m --base-url ${stack.t3.url}`,
    "Stop with Ctrl-C: Supervisor stops, the sessions are revoked, T3 stops and the run folder is removed.",
  ].join("\n");
};

export interface CheckResult {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

const Health = Schema.Struct({t3Connected: Schema.Boolean, store: Schema.Struct({projects: Schema.Number, threads: Schema.Number})});
const Verdict = Schema.Struct({verified: Schema.Boolean});

// the repository's read-only probe (scripts/probe-t3.ts) against the run's T3 with one token file
const probeWith = (stack: RunningStack, tokenFile: string) => Effect.gen(function* () {
  const result = yield* runProcess(process.execPath, ["--import", tsxLoader, join(repositoryRoot, "scripts", "probe-t3.ts")], {
    env: {PATH: stack.cli.env.PATH!, HOME: stack.cli.env.HOME!, TMPDIR: stack.run.dir("tmp"), T3_URL: stack.t3.url, T3_TOKEN_FILE: tokenFile},
    cwd: repositoryRoot, timeoutMs: 90_000,
  });
  const verdict = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Verdict))(result.stdout.trim().split("\n").at(-1) ?? "").pipe(Effect.option);
  return Option.match(verdict, {onNone: () => false, onSome: (value) => value.verified});
});

// a workflow MCP tools/list with this bearer: the HTTP status and the listed tool names
const listTools = (stack: RunningStack, bearer: string) => Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;
  const response = yield* client.execute(HttpClientRequest.post(`${stack.supervisor.url}/mcp/workflows`).pipe(
    HttpClientRequest.setHeaders({Authorization: `Bearer ${bearer}`, Accept: "application/json, text/event-stream"}),
    HttpClientRequest.setBody(HttpBody.text(JSON.stringify({jsonrpc: "2.0", id: 1, method: "tools/list", params: {}}), "application/json"))));
  const text = yield* response.text;
  if (response.status !== 200) return {status: response.status, tools: [] as string[]};
  const body = JSON.parse(text) as {result?: {tools?: Array<{name?: string}>}};
  return {status: response.status, tools: (body.result?.tools ?? []).flatMap((tool) => typeof tool.name === "string" ? [tool.name] : [])};
}).pipe(Effect.provide(fetchClient));

/** T3's answer to one native shell read: granted, refused by its authorization (HTTP 401 or 403), or no authorization answer. */
export type NativeAccess =
  | {readonly kind: "granted"}
  | {readonly kind: "refused"; readonly status: number}
  | {readonly kind: "unavailable"; readonly reason: string};

/**
  The access T3 at `baseUrl` grants this bearer on its native shell route. Only an actual 401 or 403 is a refusal; a closed
  port, a timeout or any other status is unavailable, so an outage can never pass for a refused credential
*/
export const nativeAccess = (baseUrl: string, bearer: string): Effect.Effect<NativeAccess> => Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;
  const response = yield* client.execute(HttpClientRequest.get(`${baseUrl}/api/orchestration/shell`).pipe(
    HttpClientRequest.setHeaders({Authorization: `Bearer ${bearer}`, "x-t3-orchestration-protocol": String(orchestrationProtocol)})));
  yield* Effect.ignore(response.text);
  if (response.status === 200) return {kind: "granted"} as const;
  if (response.status === 401 || response.status === 403) return {kind: "refused", status: response.status} as const;
  return {kind: "unavailable", reason: `HTTP ${response.status}`} as const;
}).pipe(Effect.timeout("10 seconds"), Effect.catch((error) => Effect.succeed<NativeAccess>({kind: "unavailable", reason: String(error._tag)})),
  Effect.provide(fetchClient));

const describeAccess = (access: NativeAccess): string =>
  access.kind === "granted" ? "granted (HTTP 200)" : access.kind === "refused" ? `refused (HTTP ${access.status})` : `unavailable (${access.reason})`;

const Shell = Schema.Struct({threads: Schema.Array(Schema.Struct({id: Schema.String}))});

// the conversation ids of T3's active shell, read with this bearer over T3's native HTTP route
const shellThreads = (stack: RunningStack, bearer: string) => Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;
  const response = yield* client.execute(HttpClientRequest.get(`${stack.t3.url}/api/orchestration/shell`).pipe(
    HttpClientRequest.setHeaders({Authorization: `Bearer ${bearer}`, "x-t3-orchestration-protocol": "2"})));
  const shell = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Shell))(yield* response.text);
  return shell.threads.map((thread) => thread.id);
}).pipe(Effect.provide(fetchClient));

// rows of Supervisor's own contact records, read-only
const contactRecords = (dataDirectory: string): Record<string, number> => {
  const db = new DatabaseSync(join(dataDirectory, "guidance.sqlite3"), {readOnly: true, timeout: 5_000});
  try {
    return Object.fromEntries(["supervisor_main_bindings", "supervisor_owned_threads", "supervisor_task_interpretations", "supervisor_workflow_operations"]
      .map((table) => [table, Number((db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as {n: number}).n)]));
  } finally {
    db.close();
  }
};

const Manifest = Schema.Struct({manifest: Schema.Struct({currentModels: Schema.Struct({codex: Schema.Array(Schema.Unknown)})})});
const ThreadStarted = Schema.Struct({threadId: Schema.String});
const ThreadShown = Schema.Struct({messages: Schema.Array(Schema.Struct({role: Schema.String}))});

/**
 * The early risky path against the running stack: the published descriptor, Supervisor's native reads, the authenticated
 * workflow MCP route and its refusals, a trivial no-contact conversation, scope refusals and a revoked credential.
 * The no-contact conversation is created through T3's thread CLI and has no provider to run it.
 */
export const runChecks = (stack: RunningStack) => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const results: CheckResult[] = [];
  const check = (name: string, ok: boolean, detail: string) => Effect.sync(() => { results.push({name, ok, detail}); });
  const read = stack.sessions.find((session) => session.credential.name === "read")!;
  const probe = stack.sessions.find((session) => session.credential.name === "git-probe")!;

  yield* check("published T3 descriptor", stack.t3.version === t3Release.version && stack.t3.protocol === orchestrationProtocol,
    `serverVersion ${stack.t3.version}, orchestration protocol ${stack.t3.protocol}`);
  const health = yield* waitForHttp(stack.supervisor.healthUrl, (status, body) => {
    if (status !== 200) return false;
    const parsed = Schema.decodeUnknownOption(Schema.fromJsonString(Health))(body);
    return Option.isSome(parsed) && parsed.value.t3Connected && parsed.value.store.projects >= 1;
  }, 75_000, () => stack.supervisor.process.child.exitCode === null).pipe(Effect.option);
  yield* check("Supervisor ingests the T3 catalog", Option.isSome(health), Option.match(health, {onNone: () => "health never listed the project",
    onSome: (value) => {
      const parsed = Schema.decodeUnknownOption(Schema.fromJsonString(Health))(value.body);
      return Option.match(parsed, {onNone: () => "health unreadable",
        onSome: (current) => `t3Connected ${current.t3Connected}, ${current.store.projects} project(s), ${current.store.threads} conversation(s)`});
    }}));
  yield* check("read credential reaches both shell snapshots", yield* probeWith(stack, read.file), "scripts/probe-t3.ts with orchestration:read + filesystem:read");

  const bearer = (yield* fs.readFileString(stack.run.dir("supervisor", "access", "workflow-mcp-token"))).trim();
  const listed = yield* listTools(stack, bearer);
  yield* check("workflow MCP answers its bearer directly", listed.status === 200 && workflowTools.every((tool) => listed.tools.includes(tool)),
    `HTTP ${listed.status}, ${listed.tools.length} tools`);
  const refused = [(yield* listTools(stack, `wrong-${bearer.length}`)).status, (yield* listTools(stack, "")).status,
    (yield* listTools(stack, (yield* fs.readFileString(read.file)).trim())).status];
  yield* check("workflow MCP refuses other bearers", refused.every((status) => status === 401), `wrong, empty, T3 read token: HTTP ${refused.join(", ")}`);

  const manifest = yield* fs.readFileString(join(stack.cli.baseDir, "userdata", "model-manifest.json")).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Manifest))), Effect.option);
  const model = Option.flatMap(manifest, (value) => Option.fromNullishOr(value.manifest.currentModels.codex.find((item) => typeof item === "string") as string | undefined));
  const started = yield* t3Command(stack.cli, ["thread", "start", "--json", "--provider", "codex", "--model", Option.getOrElse(model, () => "gpt-6.1-sol"),
    "--title", "No-contact conversation", stack.project.path, "Please list the files in this folder."]).pipe(
    Effect.flatMap((stdout) => Schema.decodeUnknownEffect(Schema.fromJsonString(ThreadStarted))(stdout.trim())));
  yield* Effect.sleep("20 seconds");
  const shown = yield* t3Command(stack.cli, ["thread", "show", "--json", started.threadId]).pipe(
    Effect.flatMap((stdout) => Schema.decodeUnknownEffect(Schema.fromJsonString(ThreadShown))(stdout.trim())));
  const threads = yield* shellThreads(stack, (yield* fs.readFileString(read.file)).trim());
  const records = contactRecords(stack.run.dir("supervisor"));
  const untouched = shown.messages.length === 1 && shown.messages[0]?.role === "user" && threads.length === 1 && threads[0] === started.threadId &&
    Object.values(records).every((count) => count === 0);
  yield* check("trivial no-contact conversation stays untouched", untouched,
    `T3 messages [${shown.messages.map((message) => message.role).join(",")}], T3 threads ${threads.length}; Supervisor records ${JSON.stringify(records)}`);

  // each refusal is T3's own 401 or 403 on the native shell route, between positive controls on the same route
  const readBearer = (yield* fs.readFileString(read.file)).trim();
  const refusal = (name: string, bearer: string, detail: string) => Effect.gen(function* () {
    const control = yield* nativeAccess(stack.t3.url, readBearer);
    const access = yield* nativeAccess(stack.t3.url, bearer);
    yield* check(name, control.kind === "granted" && access.kind === "refused", `${detail}: ${describeAccess(access)}; read credential ${describeAccess(control)}`);
  });
  yield* refusal("valid token without orchestration:read is refused", (yield* fs.readFileString(probe.file)).trim(), "git-probe credential (terminal:operate)");
  yield* refusal("forged token is refused", "forged-local-stack-token", "an unissued bearer");
  const beforeRevoke = yield* nativeAccess(stack.t3.url, readBearer);
  yield* t3Command(stack.cli, ["auth", "session", "revoke", read.sessionId]);
  const revoked = yield* nativeAccess(stack.t3.url, readBearer);
  const descriptor = yield* Effect.option(Effect.orDie(httpGet(`${stack.t3.url}/.well-known/t3/environment`, 5_000)));
  yield* check("revoked read session is refused for new requests", beforeRevoke.kind === "granted" && revoked.kind === "refused" &&
    Option.isSome(descriptor) && descriptor.value.status === 200,
  `before ${describeAccess(beforeRevoke)}, after ${describeAccess(revoked)}, T3 descriptor ${Option.match(descriptor, {onNone: () => "unreachable",
    onSome: (value) => `HTTP ${value.status}`})}; T3 0.1.6 keeps an already open subscription, so Supervisor stops before revocation`);
  return results;
});

// the stack's ports and processes once its scope closed
const released = (stack: RunningStack, keep: boolean) => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const ports = yield* Effect.forEach([stack.t3.port, ...stack.supervisor.ports], portState);
  const processes = [stack.t3.process.pid, stack.supervisor.process.pid].filter(groupAlive);
  const folder = yield* fs.exists(stack.run.path);
  return {name: "teardown leaves nothing running", ok: ports.every((state) => state === "refused") && processes.length === 0 && folder === keep,
    detail: `ports ${ports.join(",")}, live process groups ${processes.length}, run folder ${folder ? "kept" : "removed"}`} satisfies CheckResult;
});

const usage = "usage: pnpm dev:stack [--check] [--keep] [--for <seconds>] [--cache-dir <path>] | pnpm dev:stack clean";

const main = Effect.gen(function* () {
  const args = process.argv.slice(2);
  if (args[0] === "clean") {
    const {removed, live} = yield* cleanRuns();
    return yield* Console.log(`removed ${removed.length} finished run folder(s)${removed.map((path) => `\n  ${path}`).join("")}` +
      `${live.length ? `\nkept ${live.length} run folder(s) of running processes` : ""}`);
  }
  const flag = (name: string) => args.includes(name);
  const value = (name: string) => {const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined;};
  const unknown = args.filter((arg, index) => !["--check", "--keep", "--for", "--cache-dir"].includes(arg) && !["--for", "--cache-dir"].includes(args[index - 1] ?? ""));
  if (unknown.length) return yield* failure(`unknown argument ${unknown[0]}\n${usage}`);
  const seconds = value("--for") === undefined ? undefined : Number(value("--for"));
  if (seconds !== undefined && !(seconds > 0)) return yield* failure(`--for needs a positive number of seconds\n${usage}`);
  const keep = flag("--keep");
  const outcome = yield* Effect.scoped(Effect.gen(function* () {
    const stack = yield* startStack({cacheRoot: value("--cache-dir") ?? defaultCacheRoot(), keep});
    yield* Console.log(summary(stack));
    if (flag("--check")) return {stack, results: yield* runChecks(stack)};
    // the stack runs until interrupted or for the bound; a child that stops on its own ends it with that child's last output
    const exited = (name: string, child: RunningProcess) => Effect.flatMap(child.closed(), (result) =>
      failure(`${name} stopped on its own (exit ${String(result.code ?? result.signal)}): ${result.stderr.trim().split("\n").slice(-5).join("\n")}`));
    yield* Effect.raceFirst(seconds === undefined ? Effect.never : Effect.sleep(`${seconds} seconds`),
      Effect.raceFirst(exited("T3", stack.t3.process), exited("Supervisor", stack.supervisor.process)));
    return {stack, results: [] as CheckResult[]};
  }));
  if (!flag("--check")) return;
  const results = [...outcome.results, yield* released(outcome.stack, keep)];
  for (const result of results) yield* Console.log(`${result.ok ? "PASS" : "FAIL"}  ${result.name}: ${result.detail}`);
  yield* Console.log(JSON.stringify({t3: t3Release.version, passed: results.every((result) => result.ok), results}));
  if (!results.every((result) => result.ok)) return yield* failure("the local stack check failed");
});

if (import.meta.main) NodeRuntime.runMain(main.pipe(Effect.tapError((error) => Console.error(error.message)), Effect.provide(NodeFileSystem.layer)),
  {disableErrorReporting: true});
