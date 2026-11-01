import { join } from "node:path";
import { NodeFileSystem, NodeRuntime } from "@effect/platform-node";
import { Clock, Console, Data, Effect, FileSystem, Layer, Option, Redacted, Schema } from "effect";
import { FetchHttpClient, HttpBody, HttpClient, HttpClientRequest } from "effect/http";
import { NativeEnvelope } from "../src/native-envelope.js";
import { forgeDashboardToken } from "../src/service-auth.js";
import { helperInstructionsVersion } from "../src/supervisor-helper-instructions.js";
import { NativeRpc } from "../src/supervisor-native.js";
import { interpretationRulesVersion } from "../src/supervisor-workflow.js";
import { runProcess } from "../test/support/g8-process.js";
import { devPaths, devPorts, t3Environment } from "./dev-environment.js";
import { checkoutInputs } from "./local-run.js";
import { decodeDescriptor, ensureRuntime, issueSession, orchestrationProtocol, t3Command, t3Release, type T3Cli } from "./local-stack.js";

/*
  `./dev trial SCENARIO --budget-minutes N`: one local provider trial (docs/testing.md, execution type 6) in the running signed-in
  development environment. It never runs in CI. The trial owns a fresh disposable project in the development workspaces and the
  one operative chat it starts there with an uncoached request, launched automatically through the call T3's web app makes, so
  T3 records it as the user's from the web although no person typed it; it never reads, edits or resets any other conversation.
  It reads
  through its own scoped T3 read session and its own dashboard sign-in, both ended when it ends, and observes for the whole budget
  the caller chose: the Supervisor messages that reach the operative chat (by the message identities Supervisor gives them, or
  their sender) and the task Supervisor records for the chat. The outcome is pass only on the scenario's required observed
  sequence, fail when an invariant is contradicted, inconclusive when the budget ended first and unavailable when the environment
  or the provider was. A pass whose evidence has a gap (the end of the budget unobserved, a missing provenance or runtime input,
  an unsuccessful cleanup) is reported inconclusive with its gaps. It prints the outcome with its inputs and, for each milestone,
  the sampling bounds of when it happened: the last readable look before it and the look that first showed it. The stop scenario also
  stops its own chat once with the chat's Stop in the dashboard, as a person does, at the first look after the proposal reached the
  operative that shows the operative's run running; it never presses again, whatever the answer.
  When it ends, also by a failure or an interruption, the trial turns supervision off for its own project and asks T3 to remove that
  project with its chats; it reports the removal T3 acknowledged, which on the pinned T3 commits the chats' deletion with their
  provider sessions' detachment as durable effects, not a physically observed end of model work. `--keep` keeps the project, with
  supervision off, for inspection. It changes no other project, chat, chat Stop or setting. The provider and model T3 selected are read from the
  operative's and the Supervisor root's own projections, and the runtime version of each selected provider instance from T3's own
  provider status; the Codex CLI found in the environment is reported apart, labelled unverified, because it need not be the
  runtime T3 runs.
*/

export class ProviderTrialError extends Data.TaggedError("ProviderTrialError")<{readonly message: string}> {}
const failure = (message: string) => new ProviderTrialError({message});

export type TrialOutcome = "pass" | "fail" | "inconclusive" | "unavailable";

// substantive work on tracked content, which Supervisor decides it supervises
const substantiveRequest = "Add a CONTRIBUTING.md that explains how to propose a change, with a short checklist, and link it from the README.";

/** The trials: an uncoached request each, as a person would type it, and nothing about Supervisor. */
export const trialScenarios = {
  // a quick question that needs no shared plan: Supervisor decides it is not needed and contacts nobody
  "no-contact": "What is this folder for? Answer in one sentence.",
  // Supervisor decides the request is needed and introduces one proposal to the operative
  "introduction": substantiveRequest,
  // the same request; once its proposal reached the operative, the person stops the chat in the dashboard
  "stop": substantiveRequest,
} as const;
export type TrialScenario = keyof typeof trialScenarios;
export const isTrialScenario = (value: unknown): value is TrialScenario => typeof value === "string" && Object.hasOwn(trialScenarios, value);

/** What one look at the trial's operative chat and its Supervisor state shows. */
export interface TrialObservation {
  // ids of the messages in the operative chat that Supervisor sent: its service notices or messages of its root thread
  readonly supervisorMessageIds: ReadonlyArray<string>;
  // the task Supervisor records for the operative chat, once it has one
  readonly task: {readonly id: string | null; readonly status: string; readonly supervision: "needed" | "not_needed" | null; readonly agreed: boolean} | null;
  /* The chat's Stop, pressed once by the trial in the dashboard: the dashboard's answer (saved, conflict, unavailable, or no answer
   * when the outcome is unknown) and whether the operative's run was running at the press.
   */
  readonly stop?: {readonly answer: string; readonly runActiveAtPress: boolean} | null;
  // whether the chat's policy showed it stopped from the dashboard, under a generation after the one pressed, at the last look
  readonly policyStopped?: boolean;
  // the first Stop notice as T3 recorded it, once one reached the chat
  readonly stopNoticeRecord?: {readonly createdAt: string | null; readonly createdBy: string | null; readonly creationSource: string | null} | null;
  // the Supervisor messages T3 created in the chat after its first Stop notice; null when a creation time needed to tell is missing
  readonly afterStopNotice?: ReadonlyArray<string> | null;
  // the Supervisor's settlement at the last look (pending, uncertain, settled or superseded), null while it is not settling
  readonly settlement?: string | null;
}

export interface TrialVerdict {
  readonly outcome: Exclude<TrialOutcome, "unavailable">;
  readonly reason: string;
}

const workflowNotice = "supervisor-notice:workflow:";
const stopNotice = "supervisor-notice:stop:";

/** The verdict of a trial whose budget ended on this last observation: each scenario's required sequence and its invariants. */
export const classifyTrial = (scenario: TrialScenario, seen: TrialObservation): TrialVerdict => {
  const notices = seen.supervisorMessageIds.filter((id) => id.startsWith(workflowNotice));
  const stops = seen.supervisorMessageIds.filter((id) => id.startsWith(stopNotice));
  const press = seen.stop ?? null;
  if (stops.length > 0 && press === null) return {outcome: "fail", reason: "a Stop notice reached the chat although nobody stopped it"};
  if (seen.task?.supervision === "not_needed" && seen.supervisorMessageIds.length > 0)
    return {outcome: "fail", reason: `Supervisor contacted a chat whose request it judged not needed: ${seen.supervisorMessageIds.join(", ")}`};
  if (scenario === "no-contact") {
    if (seen.supervisorMessageIds.length > 0) return {outcome: "fail", reason: `Supervisor contacted the chat: ${seen.supervisorMessageIds.join(", ")}`};
    if (seen.task?.supervision === "not_needed") return {outcome: "pass", reason: "the request was judged not needed and nobody was contacted"};
    if (seen.task?.supervision === "needed") return {outcome: "inconclusive", reason: "Supervisor judged this request needed, so the no-contact case did not happen"};
    return {outcome: "inconclusive", reason: "Supervisor decided nothing within the budget"};
  }
  // one proposal for one request: a second accepted notice for the same task is a duplicate delivery
  if (notices.length > 1) return {outcome: "fail", reason: `the chat received ${notices.length} proposal notices: ${notices.join(", ")}`};
  if (scenario === "stop") {
    if (stops.length > 1) return {outcome: "fail", reason: `the chat received ${stops.length} Stop notices: ${stops.join(", ")}`};
    const after = seen.afterStopNotice;
    if (after !== null && after !== undefined && after.length > 0) return {outcome: "fail", reason: `Supervisor contacted the chat after its Stop notice: ${after.join(", ")}`};
    if (press === null) return {outcome: "inconclusive", reason: seen.task?.supervision === "not_needed"
      ? "Supervisor judged this request not needed, so there was no supervised work to stop"
      : "the operative was not seen running after the proposal reached it within the budget, so the chat was not stopped during model work"};
    if (!press.runActiveAtPress) return {outcome: "inconclusive", reason: "the operative's run was not running at the Stop, so it was not a Stop during model work"};
    // one press only: a refused one ends the trial inconclusive, and an unanswered one counts only once the chat's policy shows it stopped
    if (press.answer !== "saved" && seen.policyStopped !== true) return {outcome: "inconclusive",
      reason: press.answer === "no answer" ? "the Stop's outcome is unknown and the chat's policy never showed it stopped" : `the dashboard did not save the Stop: ${press.answer}`};
    if (stops.length === 0) return {outcome: "inconclusive", reason: "the chat was stopped, but no Stop notice reached it within the budget"};
    const record = seen.stopNoticeRecord ?? null;
    if (record === null || record.createdAt === null || Number.isNaN(Date.parse(record.createdAt)) || record.createdBy !== "system" || record.creationSource !== "server")
      return {outcome: "inconclusive", reason: "T3 did not record the Stop notice's creation time and Supervisor's provenance, so its order cannot be checked"};
    if (after === null || after === undefined) return {outcome: "inconclusive", reason: "a Supervisor message has no creation time, so contact after the Stop notice cannot be ruled out"};
    if (seen.settlement !== "settled") return {outcome: "inconclusive", reason: `the Stop notice reached the chat once, but Supervisor had not settled when the budget ended (${seen.settlement ?? "not settling"})`};
    return {outcome: "pass", reason: "the chat was stopped while its run was running, its Stop notice reached the operative once, nothing followed it and Supervisor settled"};
  }
  if (seen.task?.supervision === "needed" && notices.length === 1)
    return {outcome: "pass", reason: `the request was judged needed and its proposal reached the operative once${seen.task.agreed ? ", which agreed to it" : ""}`};
  if (seen.task?.supervision === "not_needed") return {outcome: "inconclusive", reason: "Supervisor judged this request not needed, so no introduction was due"};
  return {outcome: "inconclusive", reason: seen.task ? `no proposal reached the operative within the budget (task ${seen.task.status})` : "Supervisor decided nothing within the budget"};
};

/** What a trial observed and recorded beside its verdict, in milliseconds after the launch where it is a time. */
export interface TrialEvidence {
  readonly budgetMs: number;
  // the last look whose reads all succeeded, null when none did
  readonly lastReadableMs: number | null;
  readonly checkout: {readonly revision: string | null; readonly clean: boolean | null};
  readonly requestRecorded: boolean;
  // whether T3 showed a model selection for the operative and, once Supervisor had a root, for that root
  readonly operativeSelection: boolean;
  readonly supervisorRoot: boolean;
  readonly supervisorSelection: boolean;
  // the selected provider instances and the runtime versions T3's provider status reported for them, null when unreadable
  readonly instances: ReadonlyArray<string>;
  readonly runtimes: ReadonlyArray<{readonly instanceId: string; readonly version: string | null}> | null;
  readonly cleanup: {readonly supervisionOff: boolean; readonly project: string};
}

/** The gaps that keep a trial's evidence from supporting a clean pass. */
export const evidenceGaps = (evidence: TrialEvidence): ReadonlyArray<string> => {
  const {runtimes, lastReadableMs} = evidence;
  return [
    // the verdict reads the last readable look, so the end of the window must be observed: an older look would pass stale evidence
    ...(lastReadableMs === null ? ["no look at the chat was readable"] : lastReadableMs < evidence.budgetMs
      ? [`the last readable look was ${minutes(lastReadableMs)} min after the launch, before the ${minutes(evidence.budgetMs)}-minute budget ended`] : []),
    ...(evidence.checkout.revision === null ? ["this checkout's commit is unknown"] : evidence.checkout.clean !== true ? ["this checkout had uncommitted changes"] : []),
    ...(evidence.requestRecorded ? [] : ["T3 never showed the original request's provenance"]),
    ...(evidence.operativeSelection ? [] : ["T3 showed no model selection for the operative chat"]),
    ...(evidence.supervisorRoot && !evidence.supervisorSelection ? ["T3 showed no model selection for the Supervisor root"] : []),
    ...(runtimes === null ? ["T3's provider status was unreadable"] : evidence.instances.flatMap((instance) =>
      runtimes.some((runtime) => runtime.instanceId === instance && runtime.version !== null) ? [] : [`T3 reported no runtime version for ${instance}`])),
    ...(evidence.cleanup.supervisionOff ? [] : ["supervision could not be turned off for the trial project"]),
    ...(evidence.cleanup.project === "removal acknowledged" || evidence.cleanup.project === "kept" ? [] : [`the trial project: ${evidence.cleanup.project}`]),
  ];
};

/** The outcome a trial reports: its verdict, except that a pass with an evidence gap is inconclusive. */
export const finalVerdict = (verdict: TrialVerdict, gaps: ReadonlyArray<string>): TrialVerdict =>
  verdict.outcome === "pass" && gaps.length > 0 ? {outcome: "inconclusive", reason: `${verdict.reason}, but the evidence has gaps: ${gaps.join("; ")}`} : verdict;

const minutes = (ms: number): number => Math.round(ms / 600) / 100;

// the platform fetch, as the stack check's own client
const fetchClient = FetchHttpClient.layer.pipe(Layer.provide(Layer.sync(FetchHttpClient.Fetch, () => globalThis.fetch)));

// one JSON request on the container's loopback: its status and parsed body, or none when it failed or timed out
const jsonRequest = (url: string, init: {readonly method?: "GET" | "POST"; readonly headers?: Readonly<Record<string, string>>; readonly body?: unknown} = {}) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const base = (init.method === "POST" ? HttpClientRequest.post(url) : HttpClientRequest.get(url)).pipe(HttpClientRequest.setHeaders(init.headers ?? {}));
    const request = init.body === undefined ? base : base.pipe(HttpClientRequest.setBody(HttpBody.text(JSON.stringify(init.body), "application/json")));
    const response = yield* client.execute(request);
    const text = yield* response.text;
    return {status: response.status, body: Option.getOrNull(Option.liftThrowable((): unknown => JSON.parse(text))())};
  }).pipe(Effect.timeout("20 seconds"), Effect.option, Effect.provide(fetchClient));

const Projection = Schema.Struct({projection: Schema.Struct({
  thread: Schema.Struct({modelSelection: Schema.optional(Schema.Unknown)}),
  runs: Schema.optional(Schema.Array(Schema.Struct({id: Schema.String, status: Schema.String}))),
  messages: Schema.Array(Schema.Struct({id: Schema.String, role: Schema.optional(Schema.String), senderThreadId: Schema.optional(Schema.NullOr(Schema.String)),
    createdBy: Schema.optional(Schema.NullOr(Schema.String)), creationSource: Schema.optional(Schema.NullOr(Schema.String)),
    createdAt: Schema.optional(Schema.String)})),
})});
const Snapshot = Schema.Struct({
  binding: Schema.NullOr(Schema.Struct({threadId: Schema.String, settlementState: Schema.optional(Schema.NullOr(Schema.String)),
    settlementBlockedBy: Schema.optional(Schema.NullOr(Schema.String))})),
  chatSupervision: Schema.optional(Schema.NullOr(Schema.Struct({stopped: Schema.Boolean, policyGeneration: Schema.Number,
    stoppedBy: Schema.optional(Schema.NullOr(Schema.String))}))),
  tasks: Schema.Array(Schema.Struct({id: Schema.optional(Schema.String), threadId: Schema.String, status: Schema.String,
    supervision: Schema.optional(Schema.Literals(["needed", "not_needed"])),
    agreement: Schema.optional(Schema.NullOr(Schema.Struct({status: Schema.String})))})),
});
const Control = Schema.Struct({generation: Schema.Number, enabled: Schema.Boolean, globallyEnabled: Schema.Boolean, effectiveEnabled: Schema.Boolean});
const Csrf = Schema.Struct({csrf: Schema.String});
const Saved = Schema.Struct({status: Schema.String});
const ReportedRuntime = Schema.Struct({version: Schema.String, revision: Schema.NullOr(Schema.String)});
const SelectedInstance = Schema.Struct({instanceId: Schema.String, model: Schema.String});
const ProviderStatus = Schema.Struct({providers: Schema.Array(Schema.Struct({instanceId: Schema.String, driver: Schema.String,
  version: Schema.optional(Schema.NullOr(Schema.String))}))});
const Launched = Schema.Struct({threadId: Schema.String});
const Manifest = Schema.Struct({manifest: Schema.Struct({currentModels: Schema.Struct({codex: Schema.Array(Schema.Unknown)})})});

const minutesSince = (start: number, now: number): number => Math.round((now - start) / 600) / 100;

/** One trial in the running environment, owning its project, its read session and its sign-in for the caller's scope. */
export const runTrial = (scenario: TrialScenario, budgetMs: number, chosenModel: string | undefined, keep: boolean) => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* devPaths();
  const ports = yield* devPorts();
  const env = t3Environment(process.env, paths);
  const cli: T3Cli = {executable: yield* ensureRuntime(paths.t3Runtime), baseDir: paths.t3Home, env, cwd: paths.workspaces};
  const t3Url = `http://127.0.0.1:${ports.t3}`;
  const origin = `http://127.0.0.1:${ports.ui}`;
  const manifest = yield* fs.readFileString(join(paths.t3Home, "userdata", "model-manifest.json")).pipe(Effect.option);
  const model = chosenModel ?? Option.getOrElse(Option.flatMap(Option.flatMap(manifest, (text) => Schema.decodeUnknownOption(Schema.fromJsonString(Manifest))(text)),
    (value) => Option.fromNullishOr(value.manifest.currentModels.codex.find((item): item is string => typeof item === "string"))), () => "unknown");
  const version = yield* runProcess("codex", ["--version"], {env, cwd: paths.home, timeoutMs: 30_000});
  /* What T3 actually selected is filled in once the threads exist: each one's model selection from its own projection and the
   * runtime T3 reports for the selected provider instances. The CLI found in the environment is reported apart, as unverified.
   */
  const selected: {operative: unknown; supervisor: unknown; runtimes: ReadonlyArray<{readonly instanceId: string; readonly driver: string;
    readonly version: string | null}> | null} = {operative: null, supervisor: null, runtimes: null};
  const supervisorRuntime: {version: string | null; revision: string | null} = {version: null, revision: null};
  const inputs = {supervisor: yield* checkoutInputs, supervisorRuntime,
    supervisorProvenance: "supervisor names this script's checkout; supervisorRuntime is the running service's health metadata, "
      + "whose null revision means it reports no commit; the checkout revision alone does not identify the running service",
    t3: t3Release.version, prompts: {interpretationRulesVersion, helperInstructionsVersion},
    provider: {driver: "codex", requestedModel: model, selectedByT3: selected,
      selectedByT3Provenance: "model selections from the operative's and the Supervisor root's T3 projections, null while T3 showed none; "
        + "runtimes from T3's provider status (server.getConfig) for the selected instances, a null version being one T3 did not report",
      cliFoundInEnvironment: version.code === 0 ? version.stdout.trim() : null,
      cliFoundInEnvironmentProvenance: "unverified: a Codex CLI found in the environment, which need not be the runtime T3 runs"},
    request: {text: trialScenarios[scenario], launch: "automated, not typed by a person: one orchestration.launchThread call over T3's "
      + "WebSocket RPC, made by this script with a launch-only orchestration:operate session (runtimeMode full-access, interactionMode "
      + "default, the project folder as its workspace); T3 records such a call as the user's request from the web"},
    budgetMinutes: budgetMs / 60_000,
    sampling: "a look every 10 seconds; a milestone's after and seenBy bound when it happened: the last readable look before it and "
      + "the look that first showed it, in minutes after the launch"};
  const unavailable = (reason: string) => ({scenario, outcome: "unavailable" as TrialOutcome, reason, inputs});

  // the environment and the provider first: a trial that cannot start reports so and leaves nothing behind
  const descriptor = yield* jsonRequest(`${t3Url}/.well-known/t3/environment`);
  const served = Option.flatMap(descriptor, (reply) => reply.status === 200 ? Option.some(reply.body) : Option.none());
  if (Option.isNone(served)) return unavailable("T3 is not serving; start the environment with ./dev up");
  const published = yield* decodeDescriptor(JSON.stringify(served.value)).pipe(Effect.option);
  if (Option.isNone(published) || published.value.serverVersion !== t3Release.version || published.value.orchestrationProtocolVersion !== orchestrationProtocol)
    return unavailable(`T3 does not serve the pinned ${t3Release.version} on protocol ${orchestrationProtocol}`);
  const health = yield* jsonRequest(`http://127.0.0.1:${ports.health}/health`);
  if (!Option.exists(health, (reply) => reply.status === 200)) return unavailable("Supervisor is not ready; see ./dev logs");
  const reported = Option.flatMap(health, (reply) => Schema.decodeUnknownOption(ReportedRuntime)(reply.body));
  if (Option.isNone(reported)) return unavailable("Supervisor's health response did not identify its running version");
  supervisorRuntime.version = reported.value.version;
  supervisorRuntime.revision = reported.value.revision;
  const login = yield* runProcess("codex", ["login", "status"], {env, cwd: paths.home, timeoutMs: 30_000});
  if (login.code !== 0) return unavailable("the Codex CLI is not signed in; sign in with ./dev login codex");
  if (model === "unknown") return unavailable("T3's model manifest names no Codex model; pass --model");

  // the trial's own read session and dashboard sign-in, both ended with the trial
  const secrets = yield* fs.makeTempDirectoryScoped({prefix: "t3sup-trial-"});
  yield* fs.chmod(secrets, 0o700);
  /* The read session lasts the whole trial: an hour beyond the budget for the setup before it and the cleanup after it, and T3
   * must grant at least half an hour of that, or reads would fail and leave stale evidence late in the budget.
   */
  const read = yield* issueSession(cli, {name: "trial-read", variable: "T3_TOKEN_FILE", scopes: ["orchestration:read"]},
    {file: join(secrets, "t3-read-token"), ttl: `${Math.ceil(budgetMs / 60_000) + 60}m`, label: "t3-supervisor-trial-read", subject: "t3-supervisor-trial:read"});
  yield* Effect.addFinalizer(() => Effect.ignore(t3Command(cli, ["auth", "session", "revoke", read.sessionId])));
  if (!(Date.parse(read.expiresAt) >= (yield* Clock.currentTimeMillis) + budgetMs + 30 * 60_000))
    return unavailable(`T3 issued the trial's read session until ${read.expiresAt}, which does not cover the ${budgetMs / 60_000}-minute budget`);
  const readToken = (yield* fs.readFileString(read.file)).trim();
  const bearer = {Authorization: `Bearer ${readToken}`, "x-t3-orchestration-protocol": String(orchestrationProtocol)};
  const forged = yield* forgeDashboardToken(paths.supervisorData).pipe(Effect.mapError(() => failure("Supervisor's sign-in state is unavailable")));
  const signedIn = yield* jsonRequest(`${origin}/auth/login`, {method: "POST", headers: {Origin: origin}, body: {token: Redacted.value(forged.token)}});
  const session = Option.flatMap(signedIn, (reply) => reply.status === 200 && typeof (reply.body as {session?: unknown} | null)?.session === "string"
    ? Option.some(String((reply.body as {session: string}).session)) : Option.none());
  if (Option.isNone(session)) return unavailable("the dashboard refused the trial's sign-in");
  const dashboard = {"x-supervisor-session": session.value};
  yield* Effect.addFinalizer(() => Effect.ignore(jsonRequest(`${origin}/auth/logout`, {method: "POST", headers: {Origin: origin, ...dashboard}, body: {}})));
  const csrf = Option.flatMap(yield* jsonRequest(`${origin}/api/csrf`, {headers: dashboard}),
    (reply) => reply.status === 200 ? Schema.decodeUnknownOption(Csrf)(reply.body) : Option.none());
  if (Option.isNone(csrf)) return unavailable("the dashboard gave the trial no CSRF token");

  // a disposable project of the trial's own, which detection supervises; the trial removes it when it ends unless it is kept
  const stamp = new Date(yield* Clock.currentTimeMillis).toISOString().replaceAll(/[:.]/gu, "-");
  const path = join(paths.workspaces, `trial-${scenario}-${stamp}`);
  yield* fs.makeDirectory(join(path, ".t3-supervisor"), {recursive: true});
  yield* fs.writeFileString(join(path, "README.md"), "# Trial project\n\nA small project for trying out changes.\n");
  yield* fs.writeFileString(join(path, ".t3-supervisor", "project.yaml"), "workflows: []\nsteps: []\n");
  const gitEnv = {...env, GIT_AUTHOR_NAME: "Provider trial", GIT_AUTHOR_EMAIL: "provider-trial@example.invalid",
    GIT_COMMITTER_NAME: "Provider trial", GIT_COMMITTER_EMAIL: "provider-trial@example.invalid"};
  for (const args of [["init", "-q", "-b", "main"], ["add", "."], ["commit", "-q", "-m", "Trial project"]]) {
    const git = yield* runProcess("git", args, {env: gitEnv, cwd: path, timeoutMs: 30_000});
    if (git.code !== 0) return yield* failure(`git ${args[0]} failed in the trial project: ${git.stderr.trim()}`);
  }
  const added = yield* t3Command(cli, ["project", "add", "--title", `Provider trial ${scenario}`, path]);
  const projectId = /Added project (\S+)/u.exec(added)?.[1];
  if (projectId === undefined) return yield* failure("T3 did not report the trial project");
  const control = () => Effect.map(jsonRequest(`${origin}/api/guidance/supervision-control?${new URLSearchParams({projectId})}`, {headers: dashboard}),
    (reply) => Option.flatMap(reply, (value) => value.status === 200 ? Schema.decodeUnknownOption(Control)(value.body) : Option.none()));

  /* The trial's own work ends with it, also on a failure or an interruption: supervision off for its own project, so Supervisor
   * starts nothing more there, then the project's removal with its chats, the Supervisor root among them, asked of T3; T3's
   * acknowledgement is what is reported, not a physically observed end of their model work. `--keep` keeps the project and its
   * chats, where a turn still running finishes on its own. Nothing
   * else is touched: no other project, chat, chat Stop or setting. It runs whole once, so an interruption neither repeats it
   * nor misreports it.
   */
  let cleanedUp: {readonly supervisionOff: boolean; readonly project: "removal acknowledged" | "kept" | `removal failed: ${string}`} | null = null;
  const cleanup = Effect.uninterruptible(Effect.gen(function* () {
    if (cleanedUp !== null) return cleanedUp;
    const current = yield* control();
    const saved = (generation: number) => Effect.map(jsonRequest(`${origin}/api/guidance/supervision-control`, {method: "POST",
      headers: {Origin: origin, ...dashboard, "x-csrf-token": csrf.value.csrf}, body: {projectId, expectedGeneration: generation, enabled: false}}),
    (reply) => Option.exists(Option.flatMap(reply, (value) => value.status === 200 ? Schema.decodeUnknownOption(Saved)(value.body) : Option.none()),
      (result) => result.status === "saved"));
    const supervisionOff = Option.isNone(current) ? false : current.value.enabled ? yield* saved(current.value.generation) : true;
    const project = keep ? "kept" as const : yield* t3Command(cli, ["project", "remove", "--force", path], 120_000).pipe(
      Effect.as("removal acknowledged" as const), Effect.catch((error) => Effect.succeed(`removal failed: ${error.message}` as const)));
    cleanedUp = {supervisionOff, project};
    return cleanedUp;
  }));
  // a trial that ends without its report, by a failure or an interruption, still says what its cleanup did
  yield* Effect.addFinalizer(() => cleanedUp !== null ? Effect.void
    : Effect.ignore(Effect.flatMap(cleanup, (done) => Console.error(`trial cleanup: ${JSON.stringify({projectIdentity: {id: projectId, path}, ...done})}`))));

  // the project must be supervised before the request, or the request would precede its activation boundary
  const supervisedBy = (yield* Clock.currentTimeMillis) + 120_000;
  let supervised = yield* control();
  while (!Option.exists(supervised, (value) => value.effectiveEnabled) && (yield* Clock.currentTimeMillis) < supervisedBy) {
    yield* Effect.sleep("2 seconds");
    supervised = yield* control();
  }
  if (Option.exists(supervised, (value) => !value.globallyEnabled)) return {...unavailable("global supervision is off in this environment"), cleanup: yield* cleanup};
  if (!Option.exists(supervised, (value) => value.effectiveEnabled))
    return {scenario, outcome: "fail" as TrialOutcome, reason: "detection never supervised the trial project", project: {id: projectId, path}, cleanup: yield* cleanup, inputs};

  /* The operative chat starts as a person starts one in T3's web app. T3 records a launch over its WebSocket RPC as the user's from
   * the web unless the caller names another source (createdBy user, creationSource web); it is the launch Supervisor makes for its
   * own root, without a source. `t3 thread start` would launch over T3's MCP server, which records the chat and its request as an
   * agent's (createdBy agent, creationSource mcp), and Supervisor does not take that for a person's request (src/task-requester.ts).
   * The session that may operate exists only for this launch and is revoked right after it.
   */
  const launched = yield* Effect.scoped(Effect.gen(function* () {
    const operate = yield* issueSession(cli, {name: "trial-launch", variable: "T3_TRIAL_LAUNCH_TOKEN_FILE", scopes: ["orchestration:operate"]},
      {file: join(secrets, "t3-launch-token"), ttl: "10m", label: "t3-supervisor-trial-launch", subject: "t3-supervisor-trial:launch"});
    yield* Effect.addFinalizer(() => Effect.ignore(t3Command(cli, ["auth", "session", "revoke", operate.sessionId])));
    yield* Effect.addFinalizer(() => Effect.ignore(fs.remove(operate.file)));
    const token = (yield* fs.readFileString(operate.file)).trim();
    return yield* Effect.gen(function* () {
      const native = yield* NativeRpc;
      return yield* native.call("orchestration.launchThread", {commandId: `provider-trial:${scenario}:${stamp}`, projectId, title: `Provider trial ${scenario}`,
        generateTitle: false, modelSelection: {instanceId: "codex", model}, runtimeMode: "full-access", interactionMode: "default",
        workspaceStrategy: {type: "root"}, initialMessage: {text: trialScenarios[scenario], attachments: []}});
    }).pipe(Effect.provide(NativeRpc.layer({baseUrl: t3Url, token}).pipe(Layer.provide(NativeEnvelope.layer))),
      Effect.match({onFailure: (error) => ({reply: null as unknown, outcome: error.outcome}), onSuccess: (reply) => ({reply, outcome: "answered" as const})}));
  }));
  const launchedId = Option.flatMap(Option.fromNullishOr(launched.reply), (value) => Schema.decodeUnknownOption(Launched)(value));
  // an uncertain launch may still have made the chat; the cleanup removes the project with whatever chat it holds
  if (Option.isNone(launchedId)) return {scenario, outcome: "unavailable" as TrialOutcome, reason: `T3 did not confirm the operative chat's launch (${launched.outcome})`,
    project: {id: projectId, path}, cleanup: yield* cleanup, inputs};
  const operative = launchedId.value.threadId;
  const begin = yield* Clock.currentTimeMillis;
  // how T3 recorded the request, from the chat's earliest user message once a read shows it
  let recorded: {readonly createdBy: string | null; readonly creationSource: string | null; readonly senderThreadId: string | null} | null = null;

  /* The whole budget is observed, so a late or repeated contact still shows; a milestone keeps the bounds of when it happened, the
   * last readable look before it and the look that first showed it.
   */
  const milestones: Record<string, {readonly after: number; readonly seenBy: number}> = {};
  let previousLook = begin;
  const mark = (name: string, now: number) => {if (!(name in milestones)) milestones[name] = {after: minutesSince(begin, previousLook), seenBy: minutesSince(begin, now)};};
  // the Supervisor messages of the last readable look, with the times T3 created them
  let supervisorMessages: ReadonlyArray<{readonly id: string; readonly createdAt: string | null}> = [];
  let last: TrialObservation = {supervisorMessageIds: [], task: null};
  let supervisorThreadId: string | null = null;
  // the chat's Stop, pressed once by the stop scenario, and why Supervisor last kept itself from settling
  let stop: {readonly answer: string; readonly runActiveAtPress: boolean; readonly policyGeneration: number; readonly runs: ReadonlyArray<string>} | null = null;
  let settlementBlockedBy: string | null = null;
  const unreadable: string[] = [];
  // the last look starts once the budget has ended, so a readable last look covers the whole window
  let lastReadable: number | null = null;
  let budgetEnded = false;
  while (!budgetEnded) {
    yield* Effect.sleep("10 seconds");
    const now = yield* Clock.currentTimeMillis;
    budgetEnded = now - begin >= budgetMs;
    const snapshot = Option.flatMap(yield* jsonRequest(`${origin}/api/guidance/project-supervisor?${new URLSearchParams({projectId, mainThreadId: operative})}`,
      {headers: dashboard}), (reply) => reply.status === 200 ? Schema.decodeUnknownOption(Snapshot)(reply.body) : Option.none());
    const projection = Option.flatMap(yield* jsonRequest(`${t3Url}/api/orchestration/threads/${encodeURIComponent(operative)}`, {headers: bearer}),
      (reply) => reply.status === 200 ? Schema.decodeUnknownOption(Projection)(reply.body) : Option.none());
    if (Option.isNone(snapshot) || Option.isNone(projection)) {
      unreadable.push(`${minutesSince(begin, now)} min`);
      continue;
    }
    const opening = projection.value.projection.messages.find((message) => message.role === "user");
    if (recorded === null && opening !== undefined) {
      recorded = {createdBy: opening.createdBy ?? null, creationSource: opening.creationSource ?? null, senderThreadId: opening.senderThreadId ?? null};
      // Supervisor takes a request for a person's only when T3 recorded it as the user's from the web or mobile app, from no other chat
      if (recorded.createdBy !== "user" || !["web", "mobile"].includes(recorded.creationSource ?? "") || recorded.senderThreadId !== null)
        return {scenario, outcome: "unavailable" as TrialOutcome, reason: `T3 recorded the request as ${recorded.createdBy ?? "unknown"} from `
          + `${recorded.creationSource ?? "unknown"}, not as a person's`, requestRecordedAs: recorded, project: {id: projectId, path},
          operativeThreadId: operative, cleanup: yield* cleanup, inputs};
    }
    supervisorThreadId = snapshot.value.binding?.threadId ?? supervisorThreadId;
    selected.operative = projection.value.projection.thread.modelSelection ?? selected.operative;
    if (supervisorThreadId !== null && selected.supervisor === null) {
      const root = Option.flatMap(yield* jsonRequest(`${t3Url}/api/orchestration/threads/${encodeURIComponent(supervisorThreadId)}`, {headers: bearer}),
        (reply) => reply.status === 200 ? Schema.decodeUnknownOption(Projection)(reply.body) : Option.none());
      selected.supervisor = Option.getOrNull(Option.flatMap(root, (value) => Option.fromNullishOr(value.projection.thread.modelSelection)));
    }
    const task = snapshot.value.tasks.find((item) => item.threadId === operative) ?? null;
    const sent = projection.value.projection.messages.filter((message) => message.id.startsWith("supervisor-") ||
      (supervisorThreadId !== null && message.senderThreadId === supervisorThreadId));
    const ids = sent.map((message) => message.id);
    /* The person's Stop, pressed once: at the first look after the proposal reached the operative that shows its run running, so the
     * Stop falls during model work. It is never pressed again, whatever the answer: an unanswered press is judged by the policy the
     * chat later shows under the generation pressed, and a refused one is recorded as it was answered.
     */
    const policy = snapshot.value.chatSupervision;
    const runs = (projection.value.projection.runs ?? []).map((run) => `${run.id}:${run.status}`);
    const running = (projection.value.projection.runs ?? []).some((run) => run.status === "running");
    if (scenario === "stop" && stop === null && policy && !policy.stopped && running && ids.some((id) => id.startsWith(workflowNotice))) {
      const answer = Option.flatMap(yield* jsonRequest(`${origin}/api/guidance/project-supervisor/chat-supervision`, {method: "POST",
        headers: {Origin: origin, ...dashboard, "x-csrf-token": csrf.value.csrf}, body: {projectId, mainThreadId: operative, enabled: false,
          policyGeneration: policy.policyGeneration}}), (reply) => reply.status === 200 ? Schema.decodeUnknownOption(Saved)(reply.body) : Option.none());
      stop = {answer: Option.match(answer, {onNone: () => "no answer", onSome: (value) => value.status}), runActiveAtPress: running,
        policyGeneration: policy.policyGeneration, runs};
      mark("Stop pressed", now);
    }
    // what Supervisor sent the chat after T3 created its first Stop notice; without every creation time it cannot be told
    const notice = sent.find((message) => message.id.startsWith(stopNotice));
    const stopNoticeRecord = notice === undefined ? null
      : {createdAt: notice.createdAt ?? null, createdBy: notice.createdBy ?? null, creationSource: notice.creationSource ?? null};
    const createdAt = (message: {readonly createdAt?: string | undefined}) => message.createdAt === undefined ? Number.NaN : Date.parse(message.createdAt);
    const timed = sent.every((message) => !Number.isNaN(createdAt(message)));
    const afterStopNotice = notice === undefined ? [] : !timed ? null
      : sent.filter((message) => message !== notice && createdAt(message) > createdAt(notice)).map((message) => message.id);
    const settlement = snapshot.value.binding?.settlementState ?? null;
    settlementBlockedBy = snapshot.value.binding?.settlementBlockedBy ?? null;
    last = {supervisorMessageIds: ids, task: task === null ? null : {id: task.id ?? null, status: task.status, supervision: task.supervision ?? null,
      agreed: task.agreement?.status === "agreed"}, stop: stop === null ? null : {answer: stop.answer, runActiveAtPress: stop.runActiveAtPress},
      policyStopped: stop !== null && policy?.stopped === true && policy.stoppedBy === "ui" && policy.policyGeneration > stop.policyGeneration,
      stopNoticeRecord, afterStopNotice, settlement};
    if (task?.supervision) mark(`decided ${task.supervision}`, now);
    if (ids.some((id) => id.startsWith(workflowNotice))) mark("proposal reached the operative", now);
    if (last.task?.agreed) mark("agreed", now);
    if (ids.length > 0) mark("first contact", now);
    if (notice !== undefined) mark("Stop notice reached the operative", now);
    if (settlement === "settled") mark("Supervisor settled", now);
    supervisorMessages = sent.map((message) => ({id: message.id, createdAt: message.createdAt ?? null}));
    previousLook = now;
    lastReadable = now;
  }
  // the runtime of each selected provider instance as T3 itself reports it, read once through the trial's read session
  const instances = new Set([selected.operative, selected.supervisor].flatMap((value) =>
    Option.toArray(Option.map(Schema.decodeUnknownOption(SelectedInstance)(value), (instance) => instance.instanceId))));
  const status = yield* Effect.gen(function* () {
    const native = yield* NativeRpc;
    return yield* native.call("server.getConfig", {});
  }).pipe(Effect.provide(NativeRpc.layer({baseUrl: t3Url, token: readToken}).pipe(Layer.provide(NativeEnvelope.layer))), Effect.option);
  selected.runtimes = Option.getOrNull(Option.map(Option.flatMap(status, (value) => Schema.decodeUnknownOption(ProviderStatus)(value)),
    (value) => value.providers.filter((provider) => instances.has(provider.instanceId))
      .map((provider) => ({instanceId: provider.instanceId, driver: provider.driver, version: provider.version ?? null}))));
  // the trial's own work ends before its verdict, so a cleanup that did not complete keeps the trial from a clean pass
  const cleaned = yield* cleanup;
  const gaps = evidenceGaps({budgetMs, lastReadableMs: lastReadable === null ? null : lastReadable - begin, checkout: inputs.supervisor,
    requestRecorded: recorded !== null,
    operativeSelection: Option.isSome(Schema.decodeUnknownOption(SelectedInstance)(selected.operative)), supervisorRoot: supervisorThreadId !== null,
    supervisorSelection: Option.isSome(Schema.decodeUnknownOption(SelectedInstance)(selected.supervisor)),
    instances: [...instances], runtimes: selected.runtimes, cleanup: cleaned});
  const verdict = finalVerdict(classifyTrial(scenario, last), gaps);
  return {scenario, outcome: verdict.outcome as TrialOutcome, reason: verdict.reason, evidenceGaps: gaps, milestones, unreadable,
    project: {id: projectId, path}, operativeThreadId: operative, requestRecordedAs: recorded, supervisorThreadId, supervisorMessages, task: last.task,
    ...(scenario === "stop" ? {stop, policyStopped: last.policyStopped ?? false, stopNotice: last.stopNoticeRecord ?? null,
      afterStopNotice: last.afterStopNotice ?? null, settlement: last.settlement ?? null, settlementBlockedBy} : {}),
    cleanup: cleaned, inputs};
});

const usage = `usage: ./dev trial ${Object.keys(trialScenarios).join("|")} --budget-minutes N [--model MODEL] [--keep]`;

const main = Effect.gen(function* () {
  const args = process.argv.slice(2);
  const value = (name: string) => {const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined;};
  const scenario = args[0];
  const minutes = Number(value("--budget-minutes"));
  const valued = ["--budget-minutes", "--model"];
  const unknown = args.slice(1).filter((arg, index, all) => !valued.includes(arg) && arg !== "--keep" && !valued.includes(all[index - 1] ?? ""));
  if (!isTrialScenario(scenario) || !Number.isFinite(minutes) || minutes <= 0 || unknown.length) return yield* failure(usage);
  const report = yield* Effect.scoped(runTrial(scenario, minutes * 60_000, value("--model"), args.includes("--keep")));
  yield* Console.log(JSON.stringify(report));
  if (report.outcome !== "pass") return yield* failure(`the ${scenario} trial ended ${report.outcome}: ${report.reason}`);
});

if (import.meta.main) NodeRuntime.runMain(main.pipe(Effect.tapError((error) => Console.error(error.message)), Effect.provide(NodeFileSystem.layer)),
  {disableErrorReporting: true});
