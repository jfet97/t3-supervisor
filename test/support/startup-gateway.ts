import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { join, posix } from "node:path";
import { NodeFileSystem } from "@effect/platform-node";
import { Effect, FileSystem, type Scope } from "effect";
import { defaultSupervisorModel, type TaskRecord } from "../../src/project-supervisor-store.js";
import type { Projection, ThreadInfo } from "../../src/types.js";
import { appConfig, buildT3Client, readToken, runApp, type AppCatalog } from "./g8-app.js";
import { temporaryDirectory } from "./g8-auth.js";
import { within } from "./g8-process.js";
import { httpJson, mcpCall } from "./glinint-wiring.js";
import { installSubmission, submissionDetail } from "./interpretation-submit.js";
import { intPeer, json, nativeReadRoutes, nativeReadState, type NativeReadState, type PeerRoutes } from "./int-native-peer.js";

// the production startup chain over runGuidanceApplication. the driver exposes discover and call only.
// sqlite and the peer are observations of that chain, not a second controller.

const projectYaml = "workflows: []\nsteps: []\n";
const modelConfig = {providers: [{enabled: true, instanceId: "codex", displayName: "Codex", installed: true, status: "ready",
  models: ["gpt-6-luna", "gpt-6.1-sol"].map((slug) => ({slug, name: slug, capabilities: {optionDescriptors: [{id: "reasoningEffort", label: "Reasoning effort", type: "select",
    currentValue: "high", options: [{id: "low", label: "Low"}, {id: "high", label: "High"}, {id: "max", label: "Max"}]}]}}))}]};

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

export type StartupSession = {readonly gateway: StartupGateway; readonly observe: StartupObservations};

const messageDispatch = (payload: Record<string, unknown>): StartupDispatch | null => payload.type === "message.dispatch"
  ? {threadId: String(payload.threadId), commandId: String(payload.commandId), text: String(payload.text)} : null;

const readSqlite = <A>(file: string, read: (db: DatabaseSync) => A, fallback: A): A => {
  try {
    const db = new DatabaseSync(file, {readOnly: true, timeout: 5_000});
    try {return read(db);} finally {db.close();}
  } catch {return fallback;}
};

/** A production app with no ready binding, a native peer, and a gateway of discover and call. */
export const startStartupSession: Effect.Effect<StartupSession, never, Scope.Scope> = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* temporaryDirectory("startup-integration-");
  const workspaceRoot = posix.normalize(join(directory, "workspace"));
  yield* fs.makeDirectory(workspaceRoot);
  const state: NativeReadState = nativeReadState();
  const commands: Array<Record<string, unknown>> = [];
  let sequence = 20;
  const mainThread: ThreadInfo = {id: startupMainThreadId, title: "Operative main", projectId: startupProjectId, archivedAt: null, deletedAt: null,
    createdBy: "user", creationSource: "web", lineage: {parentThreadId: null, relationshipToParent: null},
    runtimeMode: "full-access", interactionMode: "default", worktreePath: null};
  const catalog: AppCatalog = {projects: [{project: {id: startupProjectId, title: "Startup", workspaceRoot}, available: true}], threads: [mainThread]};
  const runId = "startup-main-run-1";
  const rootNodeId = "startup-main-root-1";
  state.shellThreads = [{...mainThread, latestRunId: null}];
  state.projections.set(startupMainThreadId, {thread: {...mainThread}, runs: [{id: runId, threadId: startupMainThreadId, ordinal: 1, status: "completed",
    requestedAt: createdAt, startedAt: createdAt, completedAt: createdAt, rootNodeId, userMessageId: humanMessageId, providerThreadId: "startup-main-provider"}],
  messages: [{id: humanMessageId, threadId: startupMainThreadId, runId, nodeId: rootNodeId, role: "user", text: "Is this checkout current with its remote?",
    streaming: false, createdAt, updatedAt: createdAt, createdBy: "user", creationSource: "web"}],
  nodes: [{id: rootNodeId, threadId: startupMainThreadId, runId, parentNodeId: null, rootNodeId, kind: "root_turn", status: "completed", providerThreadId: "startup-main-provider"}],
  runtimeRequests: []} as Projection);
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
  const peer = yield* intPeer([environment, nativeReadRoutes(state), operate]);
  const config = yield* appConfig(directory, peer.baseUrl, {guidanceTokenFile: join(directory, "read-token")});
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
  return {gateway, observe};
}).pipe(Effect.provide(NodeFileSystem.layer), Effect.orDie);
