import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { isAbsolute, join, relative, resolve } from "node:path";
import { NodeFileSystem, NodeRuntime } from "@effect/platform-node";
import { Cause, Clock, Console, Data, Effect, Exit, FileSystem, Option, Schema } from "effect";
import { FetchHttpClient, HttpBody, HttpClient, HttpClientRequest } from "effect/http";
import { DatabaseFormats } from "../src/db.js";
import { groupAlive, tsxLoader } from "../test/support/cli-process.js";
import { httpGet, runProcess, startProcess, waitForHttp, type RunningProcess } from "../test/support/g8-process.js";
import { checkoutInputs, createRun, isolatedEnv, readMarker, removeRun, repositoryRoot, type RunFolder } from "./local-run.js";
import { decodeDescriptor, installRuntime, issueSession, orchestrationProtocol, platformKey, serveArguments, t3Command, t3Environment, t3Release,
  type StageTiming, type T3Cli, type T3Release } from "./local-stack.js";
import { channelRelease, decodeReleaseLock, imagePlatforms, imageReference, ReleaseChannel, sourceRepository, type ImagePlatform } from "./supervisor-releases.js";
import { decodeTargetLock, targetRelease } from "./t3-targets.js";
import {
  backupProblems, catalogIdentities, changingFiles, databaseFiles, type DatabaseFile, eventLines, type FileRows, type Formats, type JourneyCheck,
  journeyOutcome, type JourneyOutcome, requiredMeta, rowDifferences, SeedFile, selectSeedSet, startupFailure, upgradeEventProblems,
} from "./upgrade-journey-evidence.js";
import { backupObservation, type DirectorySnapshot, fileShape, seedFile, snapshotDirectory } from "./upgrade-journey-files.js";

/*
  `pnpm dev:upgrade`: the provider-free published Supervisor upgrade journeys (docs/local-stack.md, "Published upgrade journeys"), run by
  `./dev upgrade`. A journey owns one marked run folder in the cache volume: a T3 of its own, its read-only session, a disposable
  project with two chats and the Supervisor data directory. The creator, the published release run from its official image by digest
  (`stable`, `nightly`) or this checkout's candidate (`baseline`), initializes that directory and takes the provider-free writes: a
  dashboard sign-in, a chat's Stop and Enable and another chat's Stop, project settings and No Project mode. Once it stopped, the
  journey reads what it left, seeds the frozen synthetic history its persisted shape selects and starts the candidate on it twice,
  judging the formats, the backup, the session, the settings and every stored row.

  Docker stays on the host: `./dev upgrade` pulls and runs the image in the network namespace of the journey container, whose main
  process serves T3 (`serve`), and hands each fact only it sees to one of the steps below on stdin. Every judgement is made here, by
  the evidence functions of scripts/upgrade-journey-evidence.ts. A journey reports one JSON line and exits non-zero unless it passed.
*/

export const journeys = ["stable", "nightly", "baseline"] as const;
const Journey = Schema.Literals(journeys);
export type Journey = typeof Journey.Type;

// the listeners inside the journey container's own network namespace, which the creator, the candidate and the npm probe share in turn
export const journeyPorts = {t3: 3773, ui: 9008, health: 9007, probeUi: 9018, probeHealth: 9017} as const;
const t3Url = `http://127.0.0.1:${journeyPorts.t3}`;
const origin = `http://127.0.0.1:${journeyPorts.ui}`;
const readCredential = {name: "read", variable: "T3_TOKEN_FILE", scopes: ["orchestration:read", "filesystem:read"]} as const;
const readyTimeoutMs = 180_000;
const seedFilePath = join(repositoryRoot, "test", "fixtures", "upgrade-journeys", "seed-sets.json");

/* The candidate's current format of each database file, src/db.ts. How each file's rows must come through its start: byte for byte,
 * or by identity for the catalog, which a start may rebuild from T3. A format that moves rows between files, such as the thread policy
 * into guidance, changes its file's entry here and checks the moved rows in their new file.
 */
const currentFormats: Formats = {
  "access/login.sqlite3": DatabaseFormats.access, "catalog.sqlite3": DatabaseFormats.catalog,
  "guidance.sqlite3": DatabaseFormats.guidance, "thread-settings.sqlite3": DatabaseFormats.policy,
};
const preservation: Readonly<Record<DatabaseFile, "rows" | "identities">> = {
  "access/login.sqlite3": "rows", "catalog.sqlite3": "identities", "guidance.sqlite3": "rows", "thread-settings.sqlite3": "rows",
};

export class JourneyError extends Data.TaggedError("JourneyError")<{readonly message: string}> {}
const failure = (message: string) => new JourneyError({message});

const LockInput = Schema.Struct({file: Schema.String, sha256: Schema.String});
const Plan = Schema.Struct({
  journey: Journey,
  createdAt: Schema.String,
  out: Schema.NullOr(Schema.String),
  checkout: Schema.Struct({revision: Schema.NullOr(Schema.String), clean: Schema.NullOr(Schema.Boolean)}),
  t3: Schema.Struct({
    version: Schema.String, baseUrl: Schema.String, archives: Schema.Record(Schema.String, Schema.String), executable: Schema.String,
    source: Schema.Literals(["pin", "lock"]), lock: Schema.NullOr(LockInput),
  }),
  published: Schema.NullOr(Schema.Struct({
    channel: ReleaseChannel, version: Schema.String, revision: Schema.String, index: Schema.String, platform: Schema.Literals(imagePlatforms),
    image: Schema.String, npm: Schema.NullOr(Schema.Struct({tarball: Schema.String, integrity: Schema.String, gitHead: Schema.String})), lock: LockInput,
  })),
});
type Plan = typeof Plan.Type;
const Stack = Schema.Struct({
  t3Version: Schema.String, sessionId: Schema.String, expiresAt: Schema.String, projectId: Schema.String, projectPath: Schema.String,
  chats: Schema.Tuple([Schema.String, Schema.String]),
});
type Stack = typeof Stack.Type;
const HealthFacts = Schema.Struct({
  status: Schema.Number, ok: Schema.NullOr(Schema.Boolean), version: Schema.NullOr(Schema.String), revision: Schema.NullOr(Schema.String),
  t3Connected: Schema.NullOr(Schema.Boolean), supervisionState: Schema.NullOr(Schema.String), storeState: Schema.NullOr(Schema.String),
  lastErrorPhase: Schema.NullOr(Schema.String), projects: Schema.NullOr(Schema.Number), threads: Schema.NullOr(Schema.Number),
});
type HealthFacts = typeof HealthFacts.Type;
const Creator = Schema.Struct({ready: Schema.Boolean, detail: Schema.String, health: Schema.NullOr(HealthFacts)});
const ImageRecord = Schema.Struct({ok: Schema.Boolean, detail: Schema.String});
const Policy = Schema.Struct({generation: Schema.Number, excludedThreadIds: Schema.Array(Schema.String)});
const Monitoring = Schema.Struct({intervalMinutes: Schema.Number, activityThreshold: Schema.Number});
const Team = Schema.Struct({maxHelpersPerRoot: Schema.Number});
const NoProject = Schema.Struct({generation: Schema.Number, mode: Schema.String});
const Written = Schema.Struct({
  policy: Policy, stoppedAndEnabled: Schema.String, stopped: Schema.String, noProject: NoProject,
  projectSettings: Schema.Struct({projectId: Schema.String, generation: Schema.Number, monitoring: Monitoring, teamSettings: Team}),
});
type Written = typeof Written.Type;
const Drive = Schema.Struct({ok: Schema.Boolean, detail: Schema.String, written: Schema.NullOr(Written)});

const decodePlan = Schema.decodeUnknownEffect(Schema.fromJsonString(Plan));
const decodeStack = Schema.decodeUnknownEffect(Schema.fromJsonString(Stack));
const decodeCreator = Schema.decodeUnknownEffect(Schema.fromJsonString(Creator));
const decodeImageRecord = Schema.decodeUnknownEffect(Schema.fromJsonString(ImageRecord));
const decodeDrive = Schema.decodeUnknownEffect(Schema.fromJsonString(Drive));
const decodeSeeds = Schema.decodeUnknownEffect(Schema.fromJsonString(SeedFile));

const sha256 = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");
const messageOf = (error: unknown): string => error instanceof Error ? error.message : "the step failed without a diagnostic";
const reason = (cause: Cause.Cause<unknown>): string => messageOf(Cause.squash(cause));

// ---- the journey folder and its records

const records = ["plan.json", "stack.json", "image.json", "creator.json", "drive.json", "creator-exit", "creator-log"] as const;
type RecordName = typeof records[number];
const recordPath = (folder: RunFolder, name: RecordName) => folder.dir("records", name);
const writeRecord = (folder: RunFolder, name: RecordName, value: unknown) =>
  FileSystem.FileSystem.use((fs) => fs.writeFileString(recordPath(folder, name), `${JSON.stringify(value, null, 2)}\n`, {mode: 0o600}));
const readRecord = <A>(folder: RunFolder, name: RecordName, decode: (text: string) => Effect.Effect<A, unknown>) =>
  FileSystem.FileSystem.use((fs) => fs.readFileString(recordPath(folder, name))).pipe(Effect.flatMap(decode), Effect.option);
const readPlan = (folder: RunFolder) => readRecord(folder, "plan.json", decodePlan).pipe(
  Effect.flatMap(Option.match({onNone: () => Effect.fail(failure("the journey folder has no readable plan")), onSome: Effect.succeed})));
// the text a host command hands a step, bounded; a missing stdin is empty
const readInput = (limit: number) => FileSystem.FileSystem.use((fs) => fs.readFileString("/dev/stdin")).pipe(
  Effect.map((text) => text.slice(0, limit)), Effect.orElseSucceed(() => ""));

// a marked journey folder of the cache volume, as `plan` created it; any other path is refused
const journeyFolder = (path: string | undefined) => Effect.gen(function* () {
  if (path === undefined || !isAbsolute(path)) return yield* failure("name the journey folder `plan` printed");
  const marker = yield* readMarker(path);
  if (Option.isNone(marker) || marker.value.kind !== "upgrade") return yield* failure(`${path} is no journey folder`);
  return {path, kind: "upgrade", dir: (...parts: ReadonlyArray<string>) => join(path, ...parts)} satisfies RunFolder;
});

// the journey's T3 commands: the planned executable over the folder's T3 data and environment
const journeyCli = (folder: RunFolder, plan: Plan): T3Cli =>
  ({executable: plan.t3.executable, baseDir: folder.dir("t3"), env: t3Environment(folder), cwd: folder.dir("projects")});

/* A Supervisor process of the journey, the candidate or the npm probe's install: the folder's data directory and the read-only session
 * only. The optional credentials name files that do not exist, so no installation default can supply one.
 */
const supervisorEnv = (folder: RunFolder, overrides: Readonly<Record<string, string>> = {}): Record<string, string> =>
  isolatedEnv(folder.path, ["git"], process.env, {
    DATA_DIRECTORY: folder.dir("supervisor"), T3_URL: t3Url, T3_TOKEN_FILE: folder.dir("secrets", "t3-read-token"),
    UI_ASSETS_DIRECTORY: join(repositoryRoot, "ui-dist"), UI_HOST: "127.0.0.1", UI_PORT: String(journeyPorts.ui),
    HEALTH_HOST: "127.0.0.1", HEALTH_PORT: String(journeyPorts.health), T3_MANAGED_SCRATCH_ROOT: folder.dir("t3", "scratch"),
    T3_GUIDANCE_TOKEN_FILE: folder.dir("secrets", "absent"), T3_PROJECT_WRITE_TOKEN_FILE: folder.dir("secrets", "absent"),
    T3_PROJECT_COMMIT_TOKEN_FILE: folder.dir("secrets", "absent"), T3_GIT_PROBE_TOKEN_FILE: folder.dir("secrets", "absent"),
    ...overrides,
  });

// ---- plan: the folder, its inputs and the image the host runs

const imagePlatform = (): ImagePlatform | undefined => process.arch === "x64" ? "linux/amd64" : process.arch === "arm64" ? "linux/arm64" : undefined;

const readLockInput = (file: string) => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const bytes = yield* fs.readFile(file).pipe(Effect.mapError(() => failure(`${file} could not be read`)));
  return {text: new TextDecoder().decode(bytes), input: {file, sha256: sha256(bytes)}};
});

const planJourney = (args: ReadonlyArray<string>) => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const valued = ["--journey", "--releases", "--t3-lock", "--out", "--cache-dir"];
  const unknown = args.filter((arg, index) => !["--keep", ...valued].includes(arg) && !valued.includes(args[index - 1] ?? ""));
  if (unknown.length > 0) return yield* failure(`unknown argument ${unknown[0]}\n${usage}`);
  const value = (name: string) => {const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined;};
  const journey = yield* Schema.decodeUnknownEffect(Journey)(value("--journey")).pipe(Effect.mapError(() => failure(`choose --journey ${journeys.join(", ")}\n${usage}`)));
  const cacheRoot = value("--cache-dir");
  if (cacheRoot === undefined || !isAbsolute(cacheRoot)) return yield* failure(`--cache-dir needs an absolute folder\n${usage}`);
  const releasesFile = value("--releases");
  if ((journey === "baseline") !== (releasesFile === undefined))
    return yield* failure(journey === "baseline" ? "the baseline journey runs no published release; drop --releases" : `the ${journey} journey needs --releases <file>`);
  const platform = imagePlatform();
  if (platform === undefined) return yield* failure(`no published image runs natively on ${process.arch}`);
  // the T3 build: the stable slot of a frozen target lock, else the repository's pin
  const t3LockFile = value("--t3-lock");
  const t3 = t3LockFile === undefined ? {release: t3Release, source: "pin" as const, lock: null}
    : yield* Effect.gen(function* () {
      const read = yield* readLockInput(t3LockFile);
      const lock = yield* decodeTargetLock(read.text, `target lock ${t3LockFile}`).pipe(Effect.mapError((error) => failure(error.message)));
      return {release: targetRelease(lock, "stable") satisfies T3Release, source: "lock" as const, lock: read.input};
    });
  const channel = journey === "baseline" ? null : journey;
  const published = releasesFile === undefined || channel === null ? null : yield* Effect.gen(function* () {
    const read = yield* readLockInput(releasesFile);
    const lock = yield* decodeReleaseLock(read.text, `release lock ${releasesFile}`).pipe(Effect.mapError((error) => failure(error.message)));
    const release = channelRelease(lock, channel);
    return {channel: release.channel, version: release.version, revision: release.revision, index: release.index, platform,
      image: imageReference(release, platform), npm: release.npm, lock: read.input};
  });
  const outValue = value("--out");
  const out = outValue === undefined ? null : resolve(repositoryRoot, outValue);
  if (out !== null && (relative(repositoryRoot, out).startsWith("..") || relative(repositoryRoot, out) === "" || relative(repositoryRoot, out).split("/")[0] === ".git"))
    return yield* failure("--out names a folder inside this checkout, outside .git");
  const runtime = yield* installRuntime(cacheRoot, t3.release, platformKey()).pipe(Effect.mapError((error) => failure(`T3 ${t3.release.version} could not be installed: ${messageOf(error)}`)));
  const folder = yield* Effect.scoped(createRun("upgrade", {keep: true}));
  for (const part of ["home", "tmp", "t3", "projects", "records", "secrets", "supervisor", "npm-probe"]) yield* fs.makeDirectory(folder.dir(part), {recursive: true});
  for (const part of ["secrets", "supervisor"]) yield* fs.chmod(folder.dir(part), 0o700);
  const plan: Plan = {journey, createdAt: new Date(yield* Clock.currentTimeMillis).toISOString(), out, checkout: yield* checkoutInputs,
    t3: {version: t3.release.version, baseUrl: t3.release.baseUrl, archives: t3.release.archives, executable: runtime.executable, source: t3.source, lock: t3.lock},
    published};
  yield* writeRecord(folder, "plan.json", plan);
  // the only lines the host reads: the folder and, for a published journey, the image by its platform digest
  yield* Console.log(`folder=${folder.path}`);
  yield* Console.log(`image=${published?.image ?? ""}`);
});

// ---- serve: T3 for the journey's lifetime, in the journey container's main process

/* On the container's stop the journey's read session, as setup recorded it, is revoked, then T3 stops within its bound, before the
 * process harness kills the rest. The session is issued without a subject, the form every published T3 slot accepts; T3's data dies
 * with the journey folder in any case.
 */
const serve = (folder: RunFolder) => Effect.scoped(Effect.gen(function* () {
  const plan = yield* readPlan(folder);
  const cli = journeyCli(folder, plan);
  const server = yield* startProcess(cli.executable, serveArguments(folder, journeyPorts.t3), {env: cli.env, cwd: cli.cwd});
  yield* Effect.addFinalizer(() => Effect.gen(function* () {
    const stack = yield* readRecord(folder, "stack.json", decodeStack);
    if (Option.isSome(stack)) yield* Effect.ignore(t3Command(cli, ["auth", "session", "revoke", stack.value.sessionId]));
    if (groupAlive(server.pid)) process.kill(-server.pid, "SIGTERM");
    yield* Effect.ignore(server.closed(20_000));
  }));
  yield* Console.log(`T3 ${plan.t3.version} serves the journey at ${t3Url}`);
  return yield* Effect.never;
}));

// ---- setup: the read-only session, the disposable project and its two chats

const ThreadStarted = Schema.Struct({threadId: Schema.String});
const Manifest = Schema.Struct({manifest: Schema.Struct({currentModels: Schema.Struct({codex: Schema.Array(Schema.Unknown)})})});

const setup = (folder: RunFolder) => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const plan = yield* readPlan(folder);
  const cli = journeyCli(folder, plan);
  const reply = yield* Effect.exit(waitForHttp(`${t3Url}/.well-known/t3/environment`, (status) => status === 200, 120_000, () => true));
  if (Exit.isFailure(reply)) return yield* failure(`T3 did not serve its descriptor: ${reason(reply.cause)}`);
  const descriptor = yield* decodeDescriptor(reply.value.body).pipe(Effect.mapError((error) => failure(error.message)));
  if (descriptor.serverVersion !== plan.t3.version || descriptor.orchestrationProtocolVersion !== orchestrationProtocol)
    return yield* failure(`T3 reports ${descriptor.serverVersion} on protocol ${descriptor.orchestrationProtocolVersion}, not ${plan.t3.version} on ${orchestrationProtocol}`);
  const session = yield* issueSession(cli, readCredential, {file: folder.dir("secrets", "t3-read-token"), ttl: "8h",
    label: "t3-supervisor-upgrade-read"}).pipe(Effect.mapError((error) => failure(error.message)));
  const path = folder.dir("projects", "upgrade-journey");
  yield* fs.makeDirectory(path, {recursive: true});
  yield* fs.writeFileString(join(path, "README.md"), "# Upgrade journey\n\nA disposable project created by `pnpm dev:upgrade`.\n");
  const gitEnv = {...cli.env, GIT_AUTHOR_NAME: "Upgrade journey", GIT_AUTHOR_EMAIL: "upgrade-journey@example.invalid",
    GIT_COMMITTER_NAME: "Upgrade journey", GIT_COMMITTER_EMAIL: "upgrade-journey@example.invalid"};
  for (const args of [["init", "-q", "-b", "main"], ["add", "README.md"], ["commit", "-q", "-m", "Disposable upgrade journey project"]]) {
    const git = yield* runProcess("git", args, {env: gitEnv, cwd: path, timeoutMs: 30_000});
    if (git.code !== 0) return yield* failure(`git ${args[0]} failed in the journey project`);
  }
  const added = yield* t3Command(cli, ["project", "add", "--title", "Upgrade journey", path]).pipe(Effect.mapError((error) => failure(error.message)));
  const projectId = /Added project (\S+)/u.exec(added)?.[1];
  if (projectId === undefined) return yield* failure("t3 did not report the added project");
  const manifest = yield* fs.readFileString(join(cli.baseDir, "userdata", "model-manifest.json")).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Manifest))), Effect.option);
  const model = Option.getOrElse(Option.flatMap(manifest, (value) => Option.fromNullishOr(value.manifest.currentModels.codex.find((item) => typeof item === "string") as string | undefined)),
    () => "gpt-6.1-sol");
  // two chats T3 records with their user message only: no provider is signed in, so nothing runs in them
  const chat = (title: string) => t3Command(cli, ["thread", "start", "--json", "--provider", "codex", "--model", model, "--title", title, path,
    "Please list the files in this folder."]).pipe(Effect.flatMap((stdout) => Schema.decodeUnknownEffect(Schema.fromJsonString(ThreadStarted))(stdout.trim())),
    Effect.map((started) => started.threadId), Effect.mapError(() => failure(`t3 did not start the chat ${title}`)));
  const chats = [yield* chat("Upgrade journey chat A"), yield* chat("Upgrade journey chat B")] as const;
  yield* writeRecord(folder, "stack.json", {t3Version: descriptor.serverVersion, sessionId: session.sessionId, expiresAt: session.expiresAt,
    projectId, projectPath: path, chats} satisfies Stack);
  yield* Console.log(`T3 ${descriptor.serverVersion}: read session issued until ${session.expiresAt}, project ${projectId} with chats ${chats.join(" and ")}`);
});

// ---- the creator: readiness, the provider-free writes and its stop

const HealthBody = Schema.Struct({
  ok: Schema.optionalKey(Schema.Boolean), version: Schema.optionalKey(Schema.String), revision: Schema.optionalKey(Schema.NullOr(Schema.String)),
  t3Connected: Schema.optionalKey(Schema.Boolean), supervisionState: Schema.optionalKey(Schema.String), storeState: Schema.optionalKey(Schema.String),
  lastErrorPhase: Schema.optionalKey(Schema.NullOr(Schema.String)),
  store: Schema.optionalKey(Schema.NullOr(Schema.Struct({projects: Schema.Number, threads: Schema.Number}))),
});
const decodeHealth = Schema.decodeUnknownOption(Schema.fromJsonString(HealthBody));
const healthFacts = (status: number, body: string): HealthFacts => Option.match(decodeHealth(body), {
  onNone: () => ({status, ok: null, version: null, revision: null, t3Connected: null, supervisionState: null, storeState: null, lastErrorPhase: null, projects: null, threads: null}),
  onSome: (health) => ({status, ok: health.ok ?? null, version: health.version ?? null, revision: health.revision ?? null, t3Connected: health.t3Connected ?? null,
    supervisionState: health.supervisionState ?? null, storeState: health.storeState ?? null, lastErrorPhase: health.lastErrorPhase ?? null,
    projects: health.store?.projects ?? null, threads: health.store?.threads ?? null}),
});
const describeHealth = (facts: HealthFacts | null): string => facts === null ? "health never answered"
  : `health HTTP ${facts.status}, ok ${String(facts.ok)}, version ${facts.version ?? "unknown"}, t3Connected ${String(facts.t3Connected)}, ` +
    `supervision ${facts.supervisionState ?? "unknown"}, store ${facts.storeState ?? "unknown"}, last error phase ${facts.lastErrorPhase ?? "none"}, ` +
    `${facts.projects ?? "?"} project(s) and ${facts.threads ?? "?"} chat(s) ingested`;

/* A Supervisor on the journey's ports is ready once its health answers 200 with the journey's project and both chats ingested, within
 * the bound. Ready or not, the last health answer is kept, so a binary that cannot reach this T3 is recorded with what it reported.
 */
const awaitReady = (alive: () => boolean) => Effect.gen(function* () {
  const url = `http://127.0.0.1:${journeyPorts.health}/health`;
  const accept = (status: number, body: string) => {
    const facts = healthFacts(status, body);
    return status === 200 && (facts.projects ?? 0) >= 1 && (facts.threads ?? 0) >= 2;
  };
  const waited = yield* Effect.exit(waitForHttp(url, accept, readyTimeoutMs, alive));
  if (Exit.isFailure(waited) && Cause.hasInterrupts(waited.cause)) return yield* Effect.failCause(waited.cause);
  if (Exit.isSuccess(waited)) return {ready: true, facts: healthFacts(waited.value.status, waited.value.body), detail: "ready"};
  const last = yield* Effect.option(httpGet(url, 2_000));
  return {ready: false, facts: Option.match(last, {onNone: () => null, onSome: (reply) => healthFacts(reply.status, reply.body)}), detail: reason(waited.cause)};
});

// one dashboard request on the journey's loopback origin: its status and its JSON body, if it has one
const dashboard = (path: string, init: {readonly method?: "GET" | "POST"; readonly headers?: Readonly<Record<string, string>>; readonly body?: unknown} = {}) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const base = (init.method === "POST" ? HttpClientRequest.post(`${origin}${path}`) : HttpClientRequest.get(`${origin}${path}`)).pipe(HttpClientRequest.setHeaders(init.headers ?? {}));
    const request = init.body === undefined ? base : base.pipe(HttpClientRequest.setBody(HttpBody.text(JSON.stringify(init.body), "application/json")));
    const response = yield* client.execute(request);
    const text = yield* response.text;
    return {status: response.status, body: Option.getOrNull(Option.liftThrowable((): unknown => JSON.parse(text))())};
  }).pipe(Effect.timeout("20 seconds"), Effect.mapError(() => failure(`the dashboard did not answer ${path.split("?")[0]}`)), Effect.provide(FetchHttpClient.layer));

const UiMessage = Schema.Struct({message: Schema.String});
// a 200 answer decoded with `schema`; any other status fails with the dashboard's own message, never with its body
const answer = <A>(what: string, decode: (body: unknown) => Option.Option<A>) => (reply: {readonly status: number; readonly body: unknown}) =>
  reply.status === 200 ? Option.match(decode(reply.body), {onNone: () => Effect.fail(failure(`${what} answered in an unexpected shape`)), onSome: (value) => Effect.succeed(value)})
    : Effect.fail(failure(`${what} answered HTTP ${reply.status}${Option.match(Schema.decodeUnknownOption(UiMessage)(reply.body), {onNone: () => "", onSome: (body) => `: ${body.message}`})}`));

const decodeLogin = Schema.decodeUnknownOption(Schema.Struct({authenticated: Schema.Literal(true), session: Schema.String}));
const decodeCsrf = Schema.decodeUnknownOption(Schema.Struct({csrf: Schema.String}));
const decodeSnapshot = Schema.decodeUnknownOption(Schema.Struct({threadPolicy: Policy, threads: Schema.Array(Schema.Struct({id: Schema.String}))}));
const decodePolicy = Schema.decodeUnknownOption(Policy);
const ModelSelection = Schema.Struct({instanceId: Schema.String, model: Schema.String,
  options: Schema.Array(Schema.Struct({id: Schema.String, value: Schema.Union([Schema.String, Schema.Boolean])}))});
const decodeProjectSettings = Schema.decodeUnknownOption(Schema.Struct({settings: Schema.Struct({generation: Schema.Number, modelSelection: ModelSelection,
  monitoring: Schema.optionalKey(Monitoring), teamSettings: Schema.optionalKey(Team)})}));
const decodeSaved = Schema.decodeUnknownOption(Schema.Struct({status: Schema.String, message: Schema.String}));
const decodeNoProject = Schema.decodeUnknownOption(NoProject);
const decodeNoProjectSaved = Schema.decodeUnknownOption(Schema.Struct({status: Schema.String, message: Schema.String, control: NoProject}));
const decodeAuthStatus = Schema.decodeUnknownOption(Schema.Struct({authenticated: Schema.Boolean}));

const sameIds = (left: ReadonlyArray<string>, right: ReadonlyArray<string>) => isDeepStrictEqual([...left].sort(), [...right].sort());

/* The provider-free writes through the creator's own dashboard, each read back: a sign-in with the forged token, a Stop and an Enable
 * of chat A and a Stop of chat B that stays, other monitoring and helper limits for the project with its model unchanged, and No Project
 * mode entered. The session is kept for the candidate, in a private file of the folder.
 */
const writeThroughDashboard = (folder: RunFolder, stack: Stack, token: string) => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const login = yield* Effect.flatMap(dashboard("/auth/login", {method: "POST", headers: {Origin: origin}, body: {token}}), answer("the sign-in", decodeLogin));
  const signedIn = {"x-supervisor-session": login.session};
  const csrf = yield* Effect.flatMap(dashboard("/api/csrf", {headers: signedIn}), answer("the CSRF read", decodeCsrf));
  const change = {...signedIn, Origin: origin, "x-csrf-token": csrf.csrf};
  const snapshot = yield* Effect.flatMap(dashboard("/api/guidance/snapshot", {headers: signedIn}), answer("the dashboard snapshot", decodeSnapshot));
  const [chatA, chatB] = stack.chats;
  const listed = snapshot.threads.map((thread) => thread.id);
  if (!listed.includes(chatA) || !listed.includes(chatB)) return yield* failure("the dashboard does not list both journey chats");
  const savePolicy = (current: typeof Policy.Type, excluded: ReadonlyArray<string>) => Effect.flatMap(
    dashboard("/api/guidance/thread-policy", {method: "POST", headers: change, body: {generation: current.generation, excludedThreadIds: excluded}}),
    answer("a chat settings save", decodePolicy)).pipe(Effect.flatMap((saved) => saved.generation === current.generation + 1 && sameIds(saved.excludedThreadIds, excluded)
      ? Effect.succeed(saved) : Effect.fail(failure("a chat settings save did not record the requested chats at the next generation"))));
  const stoppedA = yield* savePolicy(snapshot.threadPolicy, [...snapshot.threadPolicy.excludedThreadIds.filter((id) => id !== chatA), chatA]);
  const enabledA = yield* savePolicy(stoppedA, stoppedA.excludedThreadIds.filter((id) => id !== chatA));
  const stoppedB = yield* savePolicy(enabledA, [...enabledA.excludedThreadIds.filter((id) => id !== chatB), chatB]);
  const settingsPath = `/api/guidance/project-supervisor?${new URLSearchParams({projectId: stack.projectId})}`;
  const current = yield* Effect.flatMap(dashboard(settingsPath, {headers: signedIn}), answer("the project settings read", decodeProjectSettings));
  const monitoring = {intervalMinutes: 1, activityThreshold: 7};
  const teamSettings = {maxHelpersPerRoot: 2};
  const saved = yield* Effect.flatMap(dashboard("/api/guidance/project-supervisor", {method: "POST", headers: change, body: {projectId: stack.projectId,
    expectedGeneration: current.settings.generation, modelSelection: current.settings.modelSelection, monitoring, teamSettings}}), answer("the project settings save", decodeSaved));
  if (saved.status !== "saved") return yield* failure(`the project settings save answered ${saved.status}: ${saved.message}`);
  const reread = yield* Effect.flatMap(dashboard(settingsPath, {headers: signedIn}), answer("the project settings read", decodeProjectSettings));
  if (reread.settings.generation !== current.settings.generation + 1 || !isDeepStrictEqual(reread.settings.monitoring, monitoring) ||
    !isDeepStrictEqual(reread.settings.teamSettings, teamSettings)) return yield* failure("the saved project settings do not read back");
  const mode = yield* Effect.flatMap(dashboard("/api/guidance/no-project-control", {headers: signedIn}), answer("the No Project mode read", decodeNoProject));
  const target = mode.mode === "on_request" ? "automatic" : "on_request";
  const entered = yield* Effect.flatMap(dashboard("/api/guidance/no-project-control", {method: "POST", headers: change,
    body: {expectedGeneration: mode.generation, mode: target}}), answer("the No Project mode save", decodeNoProjectSaved));
  if (entered.status !== "saved" || entered.control.mode !== target) return yield* failure(`the No Project mode save answered ${entered.status}: ${entered.message}`);
  const policy = (yield* Effect.flatMap(dashboard("/api/guidance/snapshot", {headers: signedIn}), answer("the dashboard snapshot", decodeSnapshot))).threadPolicy;
  if (!isDeepStrictEqual(policy, stoppedB)) return yield* failure("the saved chat settings do not read back");
  yield* fs.writeFileString(folder.dir("secrets", "dashboard-session"), `${login.session}\n`, {mode: 0o600});
  return {policy, stoppedAndEnabled: chatA, stopped: chatB, noProject: entered.control,
    projectSettings: {projectId: stack.projectId, generation: reread.settings.generation, monitoring, teamSettings}} satisfies Written;
});

const ForgedToken = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{16,256}$/u));

// the writes and their record; the token comes from the creator's own `auth forge`
const drive = (folder: RunFolder, forged: string) => Effect.gen(function* () {
  const stack = yield* readRecord(folder, "stack.json", decodeStack);
  if (Option.isNone(stack)) return yield* failure("the journey has no T3 setup record");
  const token = Schema.decodeUnknownOption(ForgedToken)(forged.trim());
  const outcome = Option.isNone(token) ? Exit.fail(failure("the creator's auth forge issued no sign-in token"))
    : yield* Effect.exit(writeThroughDashboard(folder, stack.value, token.value));
  const detail = Exit.isSuccess(outcome) ? `policy generation ${outcome.value.policy.generation} excluding ${outcome.value.policy.excludedThreadIds.length} chat(s); ` +
    `project settings generation ${outcome.value.projectSettings.generation}; No Project mode ${outcome.value.noProject.mode} at generation ${outcome.value.noProject.generation}`
    : reason(outcome.cause);
  yield* writeRecord(folder, "drive.json", {ok: Exit.isSuccess(outcome), detail, written: Exit.isSuccess(outcome) ? outcome.value : null});
  yield* Console.log(`provider-free writes: ${detail}`);
  if (Exit.isFailure(outcome)) return yield* failure(detail);
});

// the published creator: ready on this T3, and reporting the frozen release's own version and revision
const awaitPublished = (folder: RunFolder) => Effect.gen(function* () {
  const plan = yield* readPlan(folder);
  const published = plan.published;
  if (published === null) return yield* failure("the baseline journey has no published creator");
  const readiness = yield* awaitReady(() => true);
  const identity = readiness.facts?.version === published.version && readiness.facts.revision === published.revision;
  const ready = readiness.ready && identity;
  const detail = !readiness.ready ? `not ready within ${readyTimeoutMs / 1000} s: ${describeHealth(readiness.facts)}`
    : identity ? describeHealth(readiness.facts) : `ready, but reporting ${readiness.facts?.version ?? "no version"} at ${readiness.facts?.revision ?? "no revision"}`;
  yield* writeRecord(folder, "creator.json", {ready, detail, health: readiness.facts});
  yield* Console.log(`the published ${published.version} image: ${detail}`);
  if (!ready) return yield* failure(detail);
});

const InspectedImage = Schema.Array(Schema.Struct({
  Os: Schema.String, Architecture: Schema.String,
  Config: Schema.Struct({Labels: Schema.optionalKey(Schema.NullOr(Schema.Record(Schema.String, Schema.String)))}),
}));
const decodeInspected = Schema.decodeUnknownOption(Schema.fromJsonString(InspectedImage));

// the pulled image as Docker describes it: the frozen release's platform, version, revision and source; Docker itself verified its digest
const verifyImage = (folder: RunFolder, inspected: string) => Effect.gen(function* () {
  const plan = yield* readPlan(folder);
  const published = plan.published;
  if (published === null) return yield* failure("the baseline journey runs no image");
  const image = Option.flatMap(decodeInspected(inspected.trim()), (list) => Option.fromNullishOr(list[0]));
  const architecture = published.platform.split("/")[1];
  const labels: Readonly<Record<string, string>> = Option.match(image, {onNone: (): Readonly<Record<string, string>> => ({}),
    onSome: (value): Readonly<Record<string, string>> => value.Config.Labels ?? {}});
  const problems = Option.isNone(image) ? [`${published.image} was not pulled or could not be inspected`] : [
    ...(image.value.Os !== "linux" || image.value.Architecture !== architecture ? [`it is ${image.value.Os}/${image.value.Architecture}, not ${published.platform}`] : []),
    ...(labels["org.opencontainers.image.version"] !== published.version ? ["its version label is not the frozen version"] : []),
    ...(labels["org.opencontainers.image.revision"] !== published.revision ? ["its revision label is not the frozen revision"] : []),
    ...(labels["org.opencontainers.image.source"] !== sourceRepository ? ["it does not name the Supervisor source repository"] : []),
  ];
  const detail = problems.length === 0 ? `${published.image} (${published.platform}), Supervisor ${published.version} at ${published.revision}` : problems.join("; ");
  yield* writeRecord(folder, "image.json", {ok: problems.length === 0, detail});
  yield* Console.log(`published image: ${detail}`);
  if (problems.length > 0) return yield* failure(detail);
});

const recordInput = (folder: RunFolder, name: string | undefined) => Effect.gen(function* () {
  if (name !== "creator-exit" && name !== "creator-log") return yield* failure("record creator-exit or creator-log");
  const fs = yield* FileSystem.FileSystem;
  yield* fs.writeFileString(recordPath(folder, name), yield* readInput(4 * 1024 * 1024), {mode: 0o600});
});

// a graceful stop of a Supervisor process group within the bound; its exit code, or null when it had to be killed
const stopSupervisor = (child: RunningProcess) => Effect.gen(function* () {
  if (groupAlive(child.pid)) process.kill(-child.pid, "SIGTERM");
  const closed = yield* Effect.exit(child.closed(60_000));
  return Exit.isSuccess(closed) ? closed.value.code : null;
});

const candidateArgs = ["--import", tsxLoader, join(repositoryRoot, "src", "main.ts")];

// the baseline's creator: the candidate itself on the fresh directory, signed in with its own CLI's forged token
const baselineCreator = (folder: RunFolder) => Effect.scoped(Effect.gen(function* () {
  const plan = yield* readPlan(folder);
  if (plan.published !== null) return yield* failure("a published journey's creator is its image");
  const env = supervisorEnv(folder);
  const child = yield* startProcess(process.execPath, candidateArgs, {env, cwd: repositoryRoot});
  const readiness = yield* awaitReady(() => child.child.exitCode === null);
  yield* writeRecord(folder, "creator.json", {ready: readiness.ready, detail: readiness.ready ? describeHealth(readiness.facts)
    : `not ready within ${readyTimeoutMs / 1000} s: ${describeHealth(readiness.facts)}`, health: readiness.facts});
  if (readiness.ready) {
    const forged = yield* runProcess(process.execPath, ["--import", tsxLoader, join(repositoryRoot, "src", "cli.ts"), "auth", "forge", "--data-dir",
      folder.dir("supervisor")], {env, cwd: repositoryRoot, timeoutMs: 60_000});
    yield* Effect.ignore(drive(folder, forged.code === 0 ? forged.stdout : ""));
  }
  const code = yield* stopSupervisor(child);
  const fs = yield* FileSystem.FileSystem;
  yield* fs.writeFileString(recordPath(folder, "creator-exit"), `${code ?? "killed"}\n`, {mode: 0o600});
  yield* fs.writeFileString(recordPath(folder, "creator-log"), `${child.stdout()}${child.stderr()}`, {mode: 0o600});
}));

// ---- finish: the shape, the seed, the candidate's two starts, the npm probe and the report

/** One finding the journey records apart from its verdict, such as whether a fresh npm install of the same version boots. */
interface Finding {
  readonly name: string;
  readonly outcome: string;
  readonly detail: string;
}

const ScanReport = Schema.Struct({
  files: Schema.Array(Schema.Struct({file: Schema.String, present: Schema.Boolean, format: Schema.NullOr(Schema.Number), current: Schema.Number})),
  blocking: Schema.Number, unsupported: Schema.Array(Schema.String),
});
const decodeScan = Schema.decodeUnknownOption(Schema.fromJsonString(ScanReport));
const ProjectSettingsRow = Schema.Struct({generation: Schema.Number, monitoring: Schema.optionalKey(Monitoring), teamSettings: Schema.optionalKey(Team)});
const decodeSettingsRow = Schema.decodeUnknownOption(Schema.fromJsonString(ProjectSettingsRow));

// the stored project settings of one project, from a guidance snapshot's rows
const storedSettings = (rows: FileRows | undefined, projectId: string) => {
  const row = (rows?.supervisor_project_settings ?? []).find((candidate) => isDeepStrictEqual(candidate.project_id, {s: projectId}));
  const document = row?.document;
  return document !== undefined && document !== null && "s" in document ? decodeSettingsRow(document.s) : Option.none();
};

const formatsText = (formats: Readonly<Partial<Record<DatabaseFile, number | null>>>) =>
  databaseFiles.map((file) => `${file} ${formats[file] === null || formats[file] === undefined ? "absent" : `format ${formats[file]}`}`).join(", ");

// the stored rows a start must keep, by each file's preservation rule: every row byte for byte, or the catalog's identities, and the bearer
const preservedProblems = (before: DirectorySnapshot, after: DirectorySnapshot): ReadonlyArray<string> => [
  ...databaseFiles.flatMap((file) => preservation[file] === "rows"
    ? rowDifferences(before.rows[file] ?? {}, after.rows[file] ?? {}).map((problem) => `${file}: ${problem}`)
    : isDeepStrictEqual(catalogIdentities(before.rows[file] ?? {}), catalogIdentities(after.rows[file] ?? {})) ? [] : [`${file}: its identities changed`]),
  ...(before.bearer === null || after.bearer === before.bearer ? [] : ["access/workflow-mcp-token changed or disappeared"]),
];

const npmProbe = (folder: RunFolder, plan: Plan) => Effect.scoped(Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const published = plan.published!;
  if (published.npm === null) return {name: "npm install path", outcome: "unavailable", detail: "npm had no record of this version when the releases were resolved"} satisfies Finding;
  const directory = folder.dir("npm-probe");
  const env = isolatedEnv(folder.path, ["npm", "node"], process.env, {npm_config_update_notifier: "false"});
  // exactly what a person runs: the published version from the registry, its dependencies resolved by npm, nothing patched or pinned
  const installed = yield* runProcess("npm", ["install", "--prefix", directory, "--no-save", "--ignore-scripts", "--no-audit", "--no-fund",
    `@jfet97/t3-supervisor@${published.version}`], {env, cwd: folder.path, timeoutMs: 600_000});
  yield* fs.writeFileString(folder.dir("npm-probe", "install.log"), `${installed.stdout}${installed.stderr}`, {mode: 0o600});
  if (installed.code !== 0) return {name: "npm install path", outcome: "unavailable", detail: `npm install exited ${String(installed.code)}`} satisfies Finding;
  const lockfile = yield* fs.readFileString(join(directory, "node_modules", ".package-lock.json")).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Struct({packages: Schema.Record(Schema.String,
      Schema.Struct({version: Schema.optionalKey(Schema.String), integrity: Schema.optionalKey(Schema.String)}))})))), Effect.option);
  type Installed = Readonly<Record<string, {readonly version?: string; readonly integrity?: string}>>;
  const packages: Installed = Option.match(lockfile, {onNone: (): Installed => ({}), onSome: (value): Installed => value.packages});
  const resolved = Object.entries(packages).filter(([path]) => /(^|\/)node_modules\/(effect|@effect\/[^/]+)$/u.test(path))
    .map(([path, entry]) => `${path.replace(/^node_modules\//u, "")}@${entry.version ?? "?"}`).sort();
  const integrity = packages["node_modules/@jfet97/t3-supervisor"]?.integrity === published.npm.integrity;
  const data = folder.dir("npm-probe", "data");
  yield* fs.makeDirectory(data, {recursive: true, mode: 0o700});
  const child = yield* startProcess(process.execPath, [join(directory, "node_modules", "@jfet97", "t3-supervisor", "dist", "main.js")], {cwd: directory,
    env: supervisorEnv(folder, {DATA_DIRECTORY: data, UI_ASSETS_DIRECTORY: join(directory, "node_modules", "@jfet97", "t3-supervisor", "ui-dist"),
      UI_PORT: String(journeyPorts.probeUi), HEALTH_PORT: String(journeyPorts.probeHealth)})});
  const booted = yield* Effect.exit(waitForHttp(`http://127.0.0.1:${journeyPorts.probeHealth}/health`, (status) => status === 200, 90_000,
    () => child.child.exitCode === null));
  const code = yield* stopSupervisor(child);
  yield* fs.writeFileString(folder.dir("npm-probe", "boot.log"), `${child.stdout()}${child.stderr()}`, {mode: 0o600});
  const firstError = child.stderr().split("\n").find((line) => /Error/u.test(line))?.trim().slice(0, 300) ?? "no error line";
  const facts = `installed tarball integrity ${integrity ? "matches" : "does not match"} the frozen record; resolved ${resolved.join(", ") || "no Effect package"}`;
  return Exit.isSuccess(booted)
    ? {name: "npm install path", outcome: "booted", detail: `a fresh npm install of ${published.version} became ready; ${facts}`} satisfies Finding
    : {name: "npm install path", outcome: "boot_failed", detail: `a fresh npm install of ${published.version} did not boot (exit ${String(code)}: ${firstError}); ${facts}`} satisfies Finding;
}));

// one start of the candidate on the journey's directory: ready within the bound, then `observe` while it runs, then a clean stop
const candidateStart = <A, E>(folder: RunFolder, label: string, observe: Effect.Effect<A, E, FileSystem.FileSystem>) => Effect.scoped(Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const child = yield* startProcess(process.execPath, candidateArgs, {env: supervisorEnv(folder), cwd: repositoryRoot});
  const readiness = yield* awaitReady(() => child.child.exitCode === null);
  const observed = readiness.ready ? Option.some(yield* Effect.exit(observe)) : Option.none<Exit.Exit<A, E>>();
  const code = yield* stopSupervisor(child);
  yield* fs.writeFileString(folder.dir("records", `candidate-${label}.log`), `${child.stdout()}${child.stderr()}`, {mode: 0o600});
  return {readiness, observed, code, events: eventLines(child.stdout())};
}));

// the API reads of a running candidate, read only: the session, the CSRF read, the thread policy and No Project mode
const candidateReads = (folder: RunFolder, written: Written) => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const session = (yield* fs.readFileString(folder.dir("secrets", "dashboard-session"))).trim();
  const signedIn = {"x-supervisor-session": session};
  const status = yield* Effect.flatMap(dashboard("/auth/status", {headers: signedIn}), answer("the sign-in status", decodeAuthStatus));
  const csrf = yield* Effect.exit(Effect.flatMap(dashboard("/api/csrf", {headers: signedIn}), answer("the CSRF read", decodeCsrf)));
  const policy = (yield* Effect.flatMap(dashboard("/api/guidance/snapshot", {headers: signedIn}), answer("the dashboard snapshot", decodeSnapshot))).threadPolicy;
  const mode = yield* Effect.flatMap(dashboard("/api/guidance/no-project-control", {headers: signedIn}), answer("the No Project mode read", decodeNoProject));
  return {
    session: status.authenticated && Exit.isSuccess(csrf),
    policy: isDeepStrictEqual(policy, written.policy) ? null : `the thread policy reads generation ${policy.generation} excluding ${policy.excludedThreadIds.length} chat(s)`,
    noProject: mode.generation === written.noProject.generation && mode.mode === written.noProject.mode ? null : `No Project mode reads ${mode.mode} at generation ${mode.generation}`,
  };
});

type Halt = {readonly outcome: Exclude<JourneyOutcome, "passed">; readonly reason: string};
const halt = (outcome: Halt["outcome"], reason: string): Halt => ({outcome, reason});

const finish = (folder: RunFolder) => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const plan = yield* readPlan(folder);
  const startedAt = yield* Clock.currentTimeMillis;
  const checks: Array<JourneyCheck> = [];
  const findings: Array<Finding> = [];
  const stages: Array<StageTiming> = [];
  const formats: Record<string, Readonly<Partial<Record<DatabaseFile, number | null>>>> = {};
  let seedSet: string | null = null;
  const add = (name: string, ok: boolean, detail: string) => {checks.push({name, ok, detail});};
  const stage = <A, E, R>(name: string, effect: Effect.Effect<A, E, R>) => Effect.gen(function* () {
    const start = yield* Clock.currentTimeMillis;
    const exit = yield* Effect.exit(effect);
    stages.push({stage: name, durationMs: (yield* Clock.currentTimeMillis) - start, ok: Exit.isSuccess(exit)});
    return yield* exit;
  });
  const creatorName = plan.published === null ? "the candidate as creator" : `the published ${plan.published.version} image`;
  const data = folder.dir("supervisor");

  const sequence = Effect.gen(function* () {
    // 1. what the creator's run recorded
    const stack = yield* readRecord(folder, "stack.json", decodeStack);
    if (Option.isNone(stack)) return halt("harness", "the journey's T3 setup did not complete; see its step output");
    const t3Version = stack.value.t3Version;
    if (plan.published !== null) {
      const image = yield* readRecord(folder, "image.json", decodeImageRecord);
      add("published image matches the frozen lock", Option.exists(image, (record) => record.ok),
        Option.match(image, {onNone: () => "no record: the image was not pulled or inspected", onSome: (record) => record.detail}));
      if (!Option.exists(image, (record) => record.ok)) return halt("harness", "the published image was not run: it could not be pulled or does not carry the frozen identity");
    }
    const creator = yield* readRecord(folder, "creator.json", decodeCreator);
    const ready = Option.exists(creator, (record) => record.ready);
    add(`${creatorName} ready on T3 ${t3Version}`, ready, Option.match(creator, {onNone: () => "no record: the creator never started", onSome: (record) => record.detail}));
    if (Option.isNone(creator)) return halt("harness", `${creatorName} was never started, so it recorded no readiness`);
    // a creator that never became ready leaves nothing to upgrade from: nothing is seeded and the candidate does not start on it
    if (!ready) return halt(plan.published === null ? "failed" : "creator_unready", `${creatorName} did not become ready on T3 ${t3Version}; nothing was seeded`);
    const driven = yield* readRecord(folder, "drive.json", decodeDrive);
    const writes = Option.flatMap(driven, (record) => Option.fromNullishOr(record.ok ? record.written : null));
    add(`provider-free writes through ${creatorName}'s dashboard`, Option.isSome(writes),
      Option.match(driven, {onNone: () => "no record: the writes never ran", onSome: (record) => record.detail}));
    if (Option.isNone(writes)) return halt("failed", `${creatorName} did not take the provider-free writes`);
    const written = writes.value;
    const exit = (yield* fs.readFileString(recordPath(folder, "creator-exit")).pipe(Effect.orElseSucceed(() => ""))).trim();
    add(`${creatorName} stopped cleanly`, exit === "130", `exit ${exit || "unknown"}`);

    // 2. the persisted shape, its frozen seed set and the directory as the candidate will find it
    const seeds = yield* decodeSeeds(yield* fs.readFileString(seedFilePath));
    const shapes = yield* stage("shape", Effect.forEach(databaseFiles, (file) => fileShape(data, file, requiredMeta(seeds, file))));
    const created: Partial<Record<DatabaseFile, number | null>> = Object.fromEntries(shapes.map((shape) => [shape.file, shape.format] as const));
    formats.created = created;
    const selection = selectSeedSet(seeds, shapes, currentFormats);
    add("persisted shape recognized", selection.kind === "recognized",
      selection.kind === "recognized" ? `${formatsText(created)}; seed set ${selection.set.id}` : selection.reason);
    if (selection.kind === "unsupported") return halt("unsupported_shape", selection.reason);
    seedSet = selection.set.id;
    const seeded = yield* stage("seed", seedFile(join(data, selection.set.file), selection.statements));
    add("frozen synthetic history seeded as fixture input", seeded === selection.statements.length,
      `${seeded} row(s) of ${selection.set.id} written into ${selection.set.file}`);
    const expected = changingFiles(shapes, currentFormats);
    const before = yield* snapshotDirectory(data);

    // 3. the candidate's read-only rollout scan of the directory it is about to start on
    const scanned = yield* stage("rollout scan", runProcess(process.execPath, ["--import", tsxLoader, join(repositoryRoot, "scripts", "rollout-scan.ts"), data, "--json"],
      {env: supervisorEnv(folder), cwd: repositoryRoot, timeoutMs: 120_000}));
    const scan = decodeScan(scanned.stdout.trim().split("\n").at(-1) ?? "");
    const scanReport = Option.getOrNull(scan);
    const scanFormats = scanReport !== null && databaseFiles.every((file) => scanReport.files.find((entry) => entry.file === file)?.format === created[file]);
    add("rollout scan reads the directory at its formats with nothing blocking", scanned.code === 0 && Option.exists(scan, (value) => value.blocking === 0 &&
      value.unsupported.length === 0) && scanFormats, Option.match(scan, {onNone: () => `exit ${String(scanned.code)} without a readable report`,
      onSome: (value) => `exit ${String(scanned.code)}, ${value.blocking} blocking row(s), unsupported ${value.unsupported.join(", ") || "none"}`}));

    // 4. the first start: the upgrade, judged before any dashboard read, then the dashboard reads
    const first = yield* stage("candidate start", candidateStart(folder, "start-1", Effect.gen(function* () {
      const after = yield* snapshotDirectory(data);
      const backups = yield* backupObservation(data, before.sets, folder.dir("records"));
      const reads = yield* Effect.exit(candidateReads(folder, written));
      return {after, backups, reads};
    })));
    add("candidate ready on the directory", first.readiness.ready, first.readiness.ready ? describeHealth(first.readiness.facts)
      : `${describeHealth(first.readiness.facts)}; start failure ${startupFailure(first.events) ?? "unclassified"}`);
    if (Option.isNone(first.observed)) return halt("failed", `the candidate did not become ready: ${startupFailure(first.events) ?? first.readiness.detail}`);
    if (Exit.isFailure(first.observed.value)) return halt("harness", `the upgraded directory could not be read: ${reason(first.observed.value.cause)}`);
    const {after, backups, reads} = first.observed.value.value;
    formats.upgraded = after.formats;
    add("every database file at the candidate's format", databaseFiles.every((file) => after.formats[file] === currentFormats[file]), formatsText(after.formats));
    const backupIssues = backupProblems(expected, before.rows, backups);
    const set = backups.setsAfter.find((id) => !before.sets.includes(id)) ?? null;
    add(expected.length > 0 ? "one verified backup set of every changed file" : "no backup set at the current formats", backupIssues.length === 0,
      backupIssues.length > 0 ? backupIssues.join("; ") : expected.length > 0
        ? `${set}: ${expected.map((change) => `${change.file} at format ${change.format}`).join(", ")}, each copy as it was` : "nothing was backed up");
    const logged = upgradeEventProblems(first.events, expected, set);
    add(expected.length > 0 ? "upgrade logged once" : "no upgrade logged", logged.length === 0, logged.join("; ") || "as expected");
    add("the creator's dashboard session still authenticates", Exit.isSuccess(reads) && reads.value.session,
      Exit.isSuccess(reads) ? (reads.value.session ? "signed in, CSRF read answered" : "the session is no longer signed in") : reason(reads.cause));
    const settings = storedSettings(after.rows["guidance.sqlite3"], written.projectSettings.projectId);
    const settingsKept = Option.exists(settings, (value) => value.generation === written.projectSettings.generation &&
      isDeepStrictEqual(value.monitoring, written.projectSettings.monitoring) && isDeepStrictEqual(value.teamSettings, written.projectSettings.teamSettings));
    const settingsIssues = [
      ...(Exit.isSuccess(reads) ? [reads.value.policy, reads.value.noProject].filter((issue): issue is string => issue !== null) : ["the dashboard reads failed"]),
      ...(settingsKept ? [] : ["the stored project settings are not the saved ones"]),
    ];
    add("policy, project settings and No Project mode preserved", settingsIssues.length === 0, settingsIssues.join("; ") ||
      `policy generation ${written.policy.generation}, project settings generation ${written.projectSettings.generation}, No Project ${written.noProject.mode}`);
    const kept = preservedProblems(before, after);
    add("stored rows, identities, native evidence and the workflow MCP bearer preserved", kept.length === 0, kept.slice(0, 6).join("; ") ||
      "access, guidance and thread-settings byte for byte, the catalog's identities and the bearer unchanged");
    add("candidate stopped cleanly", first.code === 130, `exit ${String(first.code ?? "killed")}`);

    // 5. a restart over the upgraded directory: no redundant upgrade, no backup, everything still there
    const second = yield* stage("candidate restart", candidateStart(folder, "start-2", Effect.gen(function* () {
      const again = yield* snapshotDirectory(data);
      const status = yield* Effect.exit(Effect.flatMap(Effect.flatMap(fs.readFileString(folder.dir("secrets", "dashboard-session")),
        (session) => dashboard("/auth/status", {headers: {"x-supervisor-session": session.trim()}})), answer("the sign-in status", decodeAuthStatus)));
      return {again, signedIn: Exit.isSuccess(status) && status.value.authenticated};
    })));
    const restarted = Option.isSome(second.observed) && Exit.isSuccess(second.observed.value) ? second.observed.value.value : null;
    const unread = Option.isSome(second.observed) && Exit.isFailure(second.observed.value) ? reason(second.observed.value.cause) : null;
    const restartIssues = restarted === null ? [unread === null ? `not ready: ${startupFailure(second.events) ?? second.readiness.detail}` : `the directory could not be read: ${unread}`] : [
      ...(databaseFiles.every((file) => restarted.again.formats[file] === currentFormats[file]) ? [] : ["a file left its format"]),
      ...(isDeepStrictEqual(restarted.again.sets, after.sets) ? [] : ["the restart changed the backup sets"]),
      ...upgradeEventProblems(second.events, [], null),
      ...preservedProblems(before, restarted.again).slice(0, 3),
      ...(restarted.signedIn ? [] : ["the session no longer authenticates"]),
    ];
    if (restarted !== null) formats.restarted = restarted.again.formats;
    add("restart: ready again with no redundant upgrade or backup", restartIssues.length === 0, restartIssues.join("; ") ||
      "ready, every file current, the backup sets unchanged, no upgrade logged, every row kept and the session signed in");
    add("candidate stopped cleanly after the restart", second.code === 130, `exit ${String(second.code ?? "killed")}`);
    return null as Halt | null;
  });

  const halted = yield* Effect.exit(sequence);
  if (Exit.isFailure(halted) && Cause.hasInterrupts(halted.cause)) return yield* Effect.failCause(halted.cause);
  const stop: Halt | null = Exit.isSuccess(halted) ? halted.value : {outcome: "harness", reason: `the journey could not complete: ${reason(halted.cause)}`};
  // the npm-install path is a separate finding: it never decides the verdict, and it runs whenever this T3 serves a published journey
  if (plan.published !== null && Option.isSome(yield* readRecord(folder, "stack.json", decodeStack))) {
    const probe = yield* Effect.exit(stage("npm probe", npmProbe(folder, plan)));
    findings.push(Exit.isSuccess(probe) ? probe.value : {name: "npm install path", outcome: "unavailable", detail: `the probe could not complete: ${reason(probe.cause)}`});
  }
  const outcome = journeyOutcome(checks, stop?.outcome ?? null);
  const failed = checks.filter((check) => !check.ok).map((check) => check.name);
  const report = {
    journey: plan.journey, outcome, passed: outcome === "passed",
    reason: stop?.reason ?? (failed.length > 0 ? `not passing: ${failed.join(", ")}` : "every check passed"),
    inputs: {
      published: plan.published === null ? null : {channel: plan.published.channel, version: plan.published.version, revision: plan.published.revision,
        image: plan.published.image, index: plan.published.index, platform: plan.published.platform, releases: plan.published.lock},
      t3: {version: plan.t3.version, source: plan.t3.source, lock: plan.t3.lock},
      supervisor: plan.checkout,
    },
    formats, seedSet, checks, findings, stages, totalMs: (yield* Clock.currentTimeMillis) - startedAt,
  };
  for (const check of checks) yield* Console.log(`${check.ok ? "PASS" : "FAIL"}  ${check.name}: ${check.detail}`);
  for (const finding of findings) yield* Console.log(`NOTE  ${finding.name}, ${finding.outcome}: ${finding.detail}`);
  if (plan.out !== null) {
    yield* fs.makeDirectory(plan.out, {recursive: true});
    yield* fs.writeFileString(join(plan.out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
    for (const [from, to] of [[recordPath(folder, "creator-log"), "creator.log"], [folder.dir("records", "candidate-start-1.log"), "candidate-start-1.log"],
      [folder.dir("records", "candidate-start-2.log"), "candidate-start-2.log"], [folder.dir("npm-probe", "install.log"), "npm-install.log"],
      [folder.dir("npm-probe", "boot.log"), "npm-boot.log"]] as const)
      if (yield* fs.exists(from)) yield* fs.copyFile(from, join(plan.out, to));
  }
  yield* Console.log(JSON.stringify(report));
  if (outcome !== "passed") return yield* failure(`the ${plan.journey} upgrade journey did not pass: ${report.reason}`);
});

const usage = [
  "usage: pnpm dev:upgrade plan --journey stable|nightly|baseline --cache-dir <dir> [--releases <file>] [--t3-lock <file>] [--out <dir>] [--keep]",
  "       pnpm dev:upgrade serve|setup|await|baseline|finish|discard <journey folder>",
  "       pnpm dev:upgrade image|drive <journey folder>   (reads docker image inspect output or the forged token on stdin)",
  "       pnpm dev:upgrade record <journey folder> creator-exit|creator-log   (reads the text on stdin)",
].join("\n");

const main = Effect.gen(function* () {
  const [command, ...args] = process.argv.slice(2);
  if (command === "plan") return yield* planJourney(args);
  const folder = yield* journeyFolder(args[0]);
  switch (command) {
    case "serve": return yield* serve(folder);
    case "setup": return yield* setup(folder);
    case "image": return yield* verifyImage(folder, yield* readInput(1024 * 1024));
    case "await": return yield* awaitPublished(folder);
    case "drive": return yield* drive(folder, yield* readInput(4096));
    case "record": return yield* recordInput(folder, args[1]);
    case "baseline": return yield* baselineCreator(folder);
    case "finish": return yield* finish(folder);
    case "discard": return yield* removeRun(folder.path).pipe(Effect.mapError(() => failure(`${folder.path} is no journey folder`)));
    default: return yield* failure(usage);
  }
});

if (import.meta.main) NodeRuntime.runMain(main.pipe(Effect.tapCause((cause) => Cause.hasInterruptsOnly(cause) ? Effect.void : Console.error(reason(cause))),
  Effect.provide(NodeFileSystem.layer)), {disableErrorReporting: true});
