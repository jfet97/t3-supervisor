import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { join, posix } from "node:path";
import { NodeFileSystem } from "@effect/platform-node";
import { Effect, FileSystem, Schedule, type Scope } from "effect";
import { defaultSupervisorModel, type TaskRecord } from "../../src/project-supervisor-store.js";
import type { Projection, SupervisorConfig, ThreadInfo } from "../../src/types.js";
import { appConfig, buildT3Client, readToken, runApp, type AppCatalog } from "./g8-app.js";
import { temporaryDirectory } from "./g8-auth.js";
import { within } from "./g8-process.js";
import { httpJson, mcpCall } from "./glinint-wiring.js";
import { installSubmission, submissionDetail, workflowFields } from "./interpretation-submit.js";
import { intPeer, json, nativeReadRoutes, nativeReadState, type NativeReadState, type PeerRoutes } from "./int-native-peer.js";

/*
  The production startup chain over runGuidanceApplication. The driver exposes discover and call only.
  SQLite and the peer are observations of that chain, not a second controller. The suites run it with its defaults; the
  local dashboard fixture (scripts/dev-fixture.ts) serves the compiled dashboard over the same chain.
*/

const projectYaml = "workflows: []\nsteps: []\n";
const modelConfig = {providers: [{enabled: true, instanceId: "codex", displayName: "Codex", installed: true, status: "ready",
  models: ["gpt-6-luna", "gpt-6.1-sol"].map((slug) => ({slug, name: slug, capabilities: {optionDescriptors: [{id: "reasoningEffort", label: "Reasoning effort", type: "select",
    currentValue: "high", options: [{id: "low", label: "Low"}, {id: "medium", label: "Medium"}, {id: "high", label: "High"}, {id: "max", label: "Max"}]}]}}))}]};

export const startupProjectId = "startup-project";
export const startupMainThreadId = "startup-main";
const humanMessageId = "startup-human";
const createdAt = "2026-10-28T12:00:00.000Z";

export type StartupDispatch = {readonly threadId: string; readonly commandId: string; readonly text: string};

export type StartupGateway = {
  readonly discover: () => Effect.Effect<ReadonlyArray<string>>;
  readonly call: (name: string, args: Record<string, unknown>) => Effect.Effect<unknown>;
};

export type StartupTaskView = {readonly status?: string; readonly supervision?: string | undefined; readonly workflow?: unknown};

export type StartupObservations = {
  readonly dispatches: () => ReadonlyArray<StartupDispatch>;
  readonly objectiveDispatches: () => ReadonlyArray<StartupDispatch>;
  readonly mainDispatches: () => ReadonlyArray<StartupDispatch>;
  readonly taskDocument: () => StartupTaskView | null;
  readonly interpretationReceipts: () => number;
  readonly requestRunStatus: () => string | null;
  readonly completeRequestRun: () => void;
  readonly debug: () => unknown;
};

/** A plain native conversation beside the startup main: the user's request and the operative's completed reply. */
export type ExtraConversation = {readonly id: string; readonly title: string; readonly request: string; readonly reply: string};
/** Another catalog project; an unavailable one is listed by T3 but its folder is not readable. */
export type ExtraProject = {readonly id: string; readonly title: string; readonly available: boolean; readonly conversations: ReadonlyArray<ExtraConversation>};

export type StartupSessionOptions = {
  // the data directory; a scoped temporary directory when absent
  readonly directory?: string;
  // the compiled dashboard the production app serves, and its port; the suites need neither
  readonly uiAssetsDirectory?: string;
  readonly uiPort?: number;
  // "empty" lists no project and no conversation
  readonly catalog?: "startup" | "empty";
  readonly titles?: {readonly project: string; readonly main: string};
  readonly projects?: ReadonlyArray<ExtraProject>;
  // while `up` is false the scripted T3 answers like an unreachable server: 503 over HTTP and a failure for every request
  readonly availability?: {up: boolean};
};

export type StartupApp = {readonly origin: string; readonly dataDirectory: string};

export type StartupSession = {readonly gateway: StartupGateway; readonly observe: StartupObservations; readonly app: StartupApp};

const messageDispatch = (payload: Record<string, unknown>): StartupDispatch | null => payload.type === "message.dispatch"
  ? {threadId: String(payload.threadId), commandId: String(payload.commandId), text: String(payload.text)} : null;

const readSqlite = <A>(file: string, read: (db: DatabaseSync) => A, fallback: A): A => {
  try {
    const db = new DatabaseSync(file, {readOnly: true, timeout: 5_000});
    try {return read(db);} finally {db.close();}
  } catch {return fallback;}
};

const userThread = (id: string, title: string, projectId: string): ThreadInfo => ({id, title, projectId, archivedAt: null, deletedAt: null,
  createdBy: "user", creationSource: "web", lineage: {parentThreadId: null, relationshipToParent: null},
  runtimeMode: "full-access", interactionMode: "default", worktreePath: null});

// one completed native run of `thread`: the user's request, optionally the operative's reply, as T3 projects them
const completedConversation = (thread: ThreadInfo, request: {id: string; text: string}, reply?: string,
  sourceItemId = `${thread.id}-published-source-item`): Projection => {
  const runId = `${thread.id}-run-1`;
  const rootNodeId = `${thread.id}-root-1`;
  const providerThreadId = `${thread.id}-provider`;
  const answer = reply === undefined ? [] : [{id: `${runId}-answer`, threadId: thread.id, runId, nodeId: `${runId}-answer`, role: "assistant", text: reply,
    streaming: false, createdAt, updatedAt: createdAt}];
  return {thread: {...thread}, runs: [{id: runId, threadId: thread.id, ordinal: 1, status: "completed", requestedAt: createdAt, startedAt: createdAt,
    completedAt: createdAt, rootNodeId, userMessageId: request.id, providerThreadId}],
  messages: [{id: request.id, threadId: thread.id, runId, nodeId: rootNodeId, role: "user", text: request.text, streaming: false, createdAt, updatedAt: createdAt,
    createdBy: "user", creationSource: "web"}, ...answer],
  turnItems: [{id: sourceItemId, type: "user_message", messageId: request.id, threadId: thread.id, runId, status: "completed",
    text: request.text, streaming: false}],
  nodes: [{id: rootNodeId, threadId: thread.id, runId, parentNodeId: null, rootNodeId, kind: "root_turn", status: "completed", providerThreadId},
    ...answer.map((message) => ({id: message.id, threadId: thread.id, runId, parentNodeId: rootNodeId, rootNodeId, kind: "assistant_message", status: "completed", providerThreadId}))],
  runtimeRequests: []} as Projection;
};

/** A production app with no ready binding, a native peer, and a gateway of discover and call. */
export const startupSession = (options: StartupSessionOptions = {}): Effect.Effect<StartupSession, never, Scope.Scope> => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const directory = options.directory ?? (yield* temporaryDirectory("startup-integration-"));
  const workspaceRoot = posix.normalize(join(directory, "workspace"));
  yield* fs.makeDirectory(workspaceRoot);
  const state: NativeReadState = nativeReadState();
  const commands: Array<Record<string, unknown>> = [];
  let sequence = 20;
  const titles = options.titles ?? {project: "Startup", main: "Operative main"};
  const mainThread = userThread(startupMainThreadId, titles.main, startupProjectId);
  const catalog: AppCatalog = {projects: [], threads: []};
  if (options.catalog !== "empty") {
    catalog.projects.push({project: {id: startupProjectId, title: titles.project, workspaceRoot}, available: true});
    catalog.threads.push(mainThread);
    state.shellThreads.push({...mainThread, latestRunId: null});
    state.projections.set(startupMainThreadId, completedConversation(mainThread, {id: humanMessageId, text: "Is this checkout current with its remote?"},
      undefined, "startup-published-source-item"));
  }
  for (const project of options.projects ?? []) {
    catalog.projects.push({project: {id: project.id, title: project.title, workspaceRoot: posix.join(directory, "projects", project.id)}, available: project.available});
    for (const conversation of project.conversations) {
      const thread = userThread(conversation.id, conversation.title, project.id);
      catalog.threads.push(thread);
      state.shellThreads.push({...thread, latestRunId: `${thread.id}-run-1`});
      state.projections.set(thread.id, completedConversation(thread, {id: `${thread.id}-request`, text: conversation.request}, conversation.reply));
    }
  }
  const knownDirectory = (path: string): boolean => {
    const normalized = posix.normalize(path);
    return normalized === workspaceRoot || normalized === posix.join(workspaceRoot, ".t3-supervisor");
  };
  const guidance = join(directory, "guidance.sqlite3");
  const readTask = (): TaskRecord | null => readSqlite(guidance, (db) => {
    const row = db.prepare("SELECT document FROM supervisor_task_interpretations").get() as {document?: string} | undefined;
    return row?.document ? JSON.parse(row.document) as TaskRecord : null;
  }, null);
  const operate: PeerRoutes = {rpc: (entry) => {
    if (entry.tag === "server.getConfig") return {value: modelConfig};
    // empty answers so a stray list does not hold the cycle; this harness does not exercise those paths
    if (entry.tag === "scheduledTasks.list") return {value: {tasks: []}};
    if (entry.tag === "vcs.listRefs") return {value: {isRepo: false, refs: []}};
    if (entry.tag === "filesystem.getMetadata") {
      const paths = Array.isArray(entry.payload.paths) ? entry.payload.paths : [];
      if (paths.length === 0 || paths.some((path) => typeof path !== "string" || !knownDirectory(path))) return undefined;
      return {value: {entries: paths.map(() => ({kind: "directory"}))}};
    }
    if (entry.tag === "projects.listEntries") {
      if (posix.normalize(String(entry.payload.cwd)) !== workspaceRoot || entry.payload.directoryPath !== ".t3-supervisor") return undefined;
      return {value: {truncated: false, entries: [{path: ".t3-supervisor/project.yaml", kind: "file"}]}};
    }
    if (entry.tag === "projects.readFile") {
      if (posix.normalize(String(entry.payload.cwd)) !== workspaceRoot || entry.payload.relativePath !== ".t3-supervisor/project.yaml") return undefined;
      return {value: {contents: projectYaml, byteLength: Buffer.byteLength(projectYaml), truncated: false}};
    }
    if (entry.tag === "orchestration.launchThread") {
      const threadId = String(entry.payload.threadId);
      const thread: ThreadInfo = {id: threadId, title: String(entry.payload.title ?? "Supervisor"), projectId: String(entry.payload.projectId),
        archivedAt: null, deletedAt: null, createdBy: "system", creationSource: "server", lineage: {parentThreadId: null, relationshipToParent: null},
        modelSelection: entry.payload.modelSelection ?? defaultSupervisorModel, runtimeMode: "full-access", interactionMode: "default", worktreePath: null};
      if (!catalog.threads.some((item) => item.id === threadId)) catalog.threads.push(thread);
      if (!state.shellThreads.some((item) => item.id === threadId)) state.shellThreads.push({...thread, latestRunId: null});
      if (!state.projections.has(threadId)) state.projections.set(threadId, {thread, runs: [], messages: [], nodes: [], turnItems: [], runtimeRequests: []} as Projection);
      return {value: {threadId}};
    }
    if (entry.tag !== "orchestration.dispatchCommand") return undefined;
    const payload = entry.payload;
    commands.push(payload);
    if (payload.type === "message.dispatch") {
      const projection = state.projections.get(String(payload.threadId));
      assert.ok(projection, "dispatch target exists");
      const ordinal = projection.runs.length + 1;
      const dispatchedRunId = `${projection.thread.id}-run-${ordinal}`;
      const dispatchedRoot = `${projection.thread.id}-root-${ordinal}`;
      const now = new Date().toISOString();
      const providerThreadId = `${projection.thread.id}-provider`;
      projection.runs.push({id: dispatchedRunId, threadId: projection.thread.id, ordinal, status: "running", requestedAt: now, startedAt: now, completedAt: null,
        rootNodeId: dispatchedRoot, userMessageId: String(payload.messageId), providerThreadId});
      projection.messages.push({id: String(payload.messageId), threadId: projection.thread.id, runId: dispatchedRunId, nodeId: dispatchedRoot, role: "user",
        text: String(payload.text), streaming: false, createdAt: now, updatedAt: now, createdBy: "system", creationSource: "server"});
      (projection.nodes as Array<Record<string, unknown>>).push({id: dispatchedRoot, threadId: projection.thread.id, runId: dispatchedRunId, parentNodeId: null,
        rootNodeId: dispatchedRoot, kind: "root_turn", status: "running", providerThreadId});
    }
    return {value: {accepted: true, sequence: sequence++}};
  }};
  const environment: PeerRoutes = {http: (entry) => entry.method === "GET" && entry.path === "/.well-known/t3/environment"
    ? json(200, {environmentId: "startup-environment", orchestrationProtocolVersion: 2, serverVersion: "startup-peer"}) : undefined};
  // an unreachable T3: the descriptor and every read fail, so the run reports T3 unavailable and keeps its last read
  const availability = options.availability ?? {up: true};
  const outage: PeerRoutes = {http: () => availability.up ? undefined : json(503, {error: "t3_unavailable"}), rpc: () => availability.up ? undefined : {fail: true}};
  const peer = yield* intPeer([outage, environment, nativeReadRoutes(state), operate]);
  const served: Partial<SupervisorConfig> = {...(options.uiAssetsDirectory === undefined ? {} : {uiAssetsDirectory: options.uiAssetsDirectory}),
    ...(options.uiPort === undefined ? {} : {uiPort: options.uiPort})};
  const config = yield* appConfig(directory, peer.baseUrl, {guidanceTokenFile: join(directory, "read-token"), ...served});
  assert.equal(config.t3TokenFile.endsWith("read-token"), true);
  const app = yield* runApp(config, yield* buildT3Client(peer.baseUrl), () => catalog);
  yield* within(app.ready, 15_000, "application readiness");
  const token = (yield* fs.readFileString(join(directory, "access", "workflow-mcp-token"))).trim();
  const endpoint = {port: app.port, token};
  const dispatches = (): StartupDispatch[] => commands.flatMap((payload) => {
    const dispatch = messageDispatch(payload);
    return dispatch ? [dispatch] : [];
  });
  const requestRun = (): Projection["runs"][number] | null => {
    const task = readTask();
    const projection = task ? state.projections.get(task.supervisorThreadId) : undefined;
    return projection?.runs.find((item) => item.userMessageId === task?.messageId) ?? null;
  };
  const debug = () => ({readToken, unexpected: peer.unexpected.map((entry) => entry.kind === "http" ? `${entry.method} ${entry.path}` : entry.tag),
    rpc: peer.log.flatMap((entry) => entry.kind === "rpc" ? [entry.tag] : []),
    dispatches: dispatches().map((item) => ({threadId: item.threadId, commandId: item.commandId, chars: item.text.length}))});
  const gateway: StartupGateway = {
    discover: () => Effect.gen(function* () {
      const reply = yield* httpJson(`http://127.0.0.1:${endpoint.port}/mcp/workflows`, {method: "POST",
        headers: {Authorization: `Bearer ${endpoint.token}`, Accept: "application/json, text/event-stream"},
        body: {jsonrpc: "2.0", id: 1, method: "tools/list", params: {}}});
      if (reply.status !== 200) return yield* Effect.die(new Error(`gateway discover http ${reply.status}: ${JSON.stringify(debug())}`));
      const tools = (reply.body as {result?: {tools?: Array<{name?: string}>}}).result?.tools ?? [];
      return tools.flatMap((tool) => typeof tool.name === "string" ? [tool.name] : []);
    }),
    call: (name, args) => Effect.gen(function* () {
      if (name === "supervision_interpretation_submit") {
        const task = readTask();
        const root = task ? state.projections.get(task.supervisorThreadId) : undefined;
        if (!task?.attempt || !task.messageId || !root) return yield* Effect.die(new Error(`interpretation submit has no request run: ${JSON.stringify(debug())}`));
        const itemId = installSubmission(root, task, args);
        state.details.set(itemId, submissionDetail(root, itemId));
      }
      if (name === "supervision_plan") {
        const task = readTask();
        const caller = state.projections.get(String(args.callerThreadId));
        const run = caller?.runs.at(-1);
        assert.ok(task && caller && run, "the proposal reader has its own native run");
        const itemId = installSubmission(caller, task, args, {tool: "plan", runId: run.id});
        state.details.set(itemId, submissionDetail(caller, itemId));
      }
      const reply = yield* mcpCall(endpoint, name, args);
      if (reply.httpStatus !== 200) return yield* Effect.die(new Error(`gateway ${name} http ${reply.httpStatus}: ${JSON.stringify(reply.value)}`));
      return reply.value;
    }),
  };
  const observe: StartupObservations = {
    dispatches, debug,
    objectiveDispatches: () => dispatches().filter((item) => item.commandId.startsWith("supervisor-objective:")),
    mainDispatches: () => dispatches().filter((item) => item.threadId === startupMainThreadId),
    taskDocument: () => {
      const task = readTask();
      return task ? {status: task.status, supervision: task.supervision, workflow: task.workflow ?? null} : null;
    },
    interpretationReceipts: () => readSqlite(guidance, (db) => {
      const row = db.prepare("SELECT count(*) AS n FROM supervisor_workflow_write_receipts WHERE operation_namespace='interpretation'").get() as {n?: number} | undefined;
      return Number(row?.n ?? 0);
    }, 0),
    requestRunStatus: () => requestRun()?.status ?? null,
    completeRequestRun: () => {
      const task = readTask();
      const projection = task ? state.projections.get(task.supervisorThreadId) : undefined;
      const run = projection?.runs.find((item) => item.userMessageId === task?.messageId);
      assert.ok(projection, "the supervisor projection");
      assert.ok(run?.rootNodeId, "the interpretation request is still running");
      assert.equal(run.status, "running");
      run.status = "completed";
      run.completedAt = new Date().toISOString();
      const nodes = projection.nodes as Array<Record<string, unknown>>;
      const rootNode = nodes.find((node) => node.id === run.rootNodeId);
      assert.ok(rootNode, "the request root node");
      rootNode.status = "completed";
      const nodeId = `${run.id}-answer`;
      nodes.push({id: nodeId, threadId: projection.thread.id, runId: run.id, parentNodeId: run.rootNodeId, rootNodeId: run.rootNodeId,
        kind: "assistant_message", status: "completed", providerThreadId: run.providerThreadId});
      projection.messages.push({id: nodeId, threadId: projection.thread.id, runId: run.id, nodeId, role: "assistant",
        text: "I submitted the interpretation through the tool.", streaming: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()});
    },
  };
  return {gateway, observe, app: {origin: app.origin, dataDirectory: directory}};
}).pipe(Effect.provide(NodeFileSystem.layer), Effect.orDie);

/** The startup chain with its defaults, as the startup integration suite runs it. */
export const startStartupSession: Effect.Effect<StartupSession, never, Scope.Scope> = startupSession();

// the first value `read` returns, read every 250 ms on the live clock for at most 75 s
const eventually = <A>(read: Effect.Effect<A | null>, label: () => string): Effect.Effect<A> =>
  read.pipe(Effect.flatMap((value) => value === null ? Effect.fail("pending" as const) : Effect.succeed(value)),
    Effect.retry(Schedule.spaced("250 millis")), Effect.timeout("75 seconds"), Effect.orElseSucceed(() => null),
    Effect.flatMap((value) => value === null ? Effect.die(new Error(label())) : Effect.succeed(value)));

export type NeededWork = {
  // the root's interpretation request, the short notice the main received and the operative's read of the proposal
  readonly objective: StartupDispatch;
  readonly tools: ReadonlyArray<string>;
  readonly notice: StartupDispatch;
  readonly proposal: {readonly status: string; readonly proposal?: string};
};

/**
 * The root's part of a needed-work startup over the real gateway: it reads its context, submits a source-linked two-step
 * interpretation, completes its request run, and the operative reads the proposal its notice names.
 */
export const driveNeededWork = ({gateway, observe}: StartupSession): Effect.Effect<NeededWork> => Effect.gen(function* () {
  const objective = yield* eventually(Effect.sync(() => observe.objectiveDispatches()[0] ?? null),
    () => `the fresh root did not receive its interpretation request: ${JSON.stringify(observe.debug())}`);
  const tools = yield* gateway.discover();
  const match = /with (\{"supervisorThreadId":"[^"]+","bindingGeneration":\d+\})/u.exec(objective.text);
  if (!match?.[1]) return yield* Effect.die(new Error("the interpretation request names no workflow reader"));
  const reader = JSON.parse(match[1]) as {supervisorThreadId: string; bindingGeneration: number};
  const context = yield* eventually(gateway.call("workflow_read", {...reader, view: "context"}).pipe(Effect.map((value) => {
    const view = value as {status?: string; submission?: {arguments?: Record<string, unknown>}} | null;
    return view?.status === "ok" && view.submission?.arguments?.sourcePin ? view.submission.arguments : null;
  })), () => "the fresh context did not expose interpretation pins");
  const source = (context.sourcePin as {messageId: string}).messageId;
  const fields = workflowFields("Inspect the checkout and explain its status.", "Two bounded evidence and reporting duties.", {
    sourceMessageIds: [source],
    workflow: {requirements: [], plan: {kind: "sequence", nodes: [
      {kind: "step", definitionId: null, localId: "inspect", name: "Inspect checkout", description: "Read the current checkout and its remote state.", reason: "Establish the facts."},
      {kind: "step", definitionId: null, localId: "explain", name: "Explain status", description: "Explain the observed status and any gaps.", reason: "Answer from the evidence.",
        references: [".t3-supervisor/project.yaml"], skills: ["catalog-reading"]},
    ]}},
    conversation: {draft: {objective: "Inspect the checkout and explain its status.", constraints: [], questions: [], findings: [], duties: []},
      intent: "authorize", outcome: "Inspect the checkout and explain its status.", limits: [], sourceMessageIds: [source], antecedentMessageIds: [], scope: "changed"},
  });
  const submitted = (yield* gateway.call("supervision_interpretation_submit", {...context, ...fields})) as {status?: string};
  if (submitted.status !== "submitted") return yield* Effect.die(new Error(`the interpretation was not submitted: ${JSON.stringify(submitted)}`));
  observe.completeRequestRun();
  const notice = yield* eventually(Effect.sync(() => observe.mainDispatches().find((item) => item.text.includes("supervision_plan")) ?? null),
    () => `the needed interpretation never delivered its proposal: ${JSON.stringify(observe.debug())}`);
  const args = /supervision_plan (\{"callerThreadId":"[^"]+","taskId":"[^"]+","proposalId":"[^"]+"\})/u.exec(notice.text);
  if (!args?.[1]) return yield* Effect.die(new Error("the notice names no operative reader arguments"));
  const proposal = (yield* gateway.call("supervision_plan", JSON.parse(args[1]) as Record<string, unknown>)) as NeededWork["proposal"];
  return {objective, tools, notice, proposal};
});
