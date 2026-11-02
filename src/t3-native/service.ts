import { Context, Crypto, Effect, Layer, Option, Ref, type Deferred } from "effect";
import { HttpClient } from "effect/http";
import { NativeEnvelope } from "../native-envelope.js";
import type { SupervisorModelInfo } from "../project-supervisor-contract.js";
import { NativeOperateRpc, NativeRpc, NativeShell } from "../supervisor-native.js";
import { T3Client } from "../t3.js";
import type { ThreadInfo } from "../types.js";
import { referenceBuilds } from "./build.js";
import { makeFiles } from "./internal/files.js";
import { makeHelper } from "./internal/helper.js";
import { makeOrchestration } from "./internal/orchestration.js";
import { makeTerminal } from "./internal/terminal.js";
import type {
  BuildFacts, CommandReceipt, CommitOutcome, CommitRequest, DirectoryListing, FileContents, FileMetadata, HelperTask, HelperTaskDelete,
  HelperTaskUpsert, LaunchReceipt, LaunchThread, ListEntriesRequest, MetadataRequest, OrchestrationCommand, ReadFileRequest, ReferenceBuild,
  ShellBaseline, ShellSourceItem, T3Environment, T3Operation, TerminalAttachEvent, TerminalAttachExit, TerminalAttachRequest,
  TerminalCloseRequest, TerminalOpenRequest, TerminalSnapshot, TerminalWriteRequest, ThreadSnapshot, ThreadStreamItem, TurnItemReply,
  TurnItemRequest, VcsRefs, VcsRequest, VcsStatus, WebhookDeliveriesRequest, WebhookDelivery, WebhookDeliveryRequest, WebhookPost,
  WebhookReply, WriteFileReceipt, WriteFileRequest,
} from "./contracts.js";
import type {
  T3FileError, T3InvalidInput, T3ReadError, T3RequestError, T3TerminalError, T3Unsupported, T3WebhookError,
} from "./errors.js";

// The public shape of T3Native: every runtime Supervisor -> T3 operation, grouped by family. Reads are effects; watches hand each
// validated item to their consumer and acknowledge a chunk only after the consumer ingested every item of it; commands are prepared
// without I/O and then initiated. A completed `cancel` ends a request as its client always ended it.

/** A committed request: initiation created it, `result` awaits its reply and `release` ends it without sending anything */
export interface T3InFlight<A, E> {
  // true once the request may have reached T3; from then on a failed or interrupted result is uncertain
  readonly sent: Effect.Effect<boolean>;
  readonly result: Effect.Effect<A, E>;
  // idempotent
  readonly release: Effect.Effect<void>;
}

/** A command that passed validation and translation selection; nothing was connected or sent */
export interface T3PreparedCommand<A, E> {
  readonly operation: T3Operation;
  // commits synchronously, as NativeRpcShape.initiate does: an admission section that runs it knows the request exists before it
  // yields, and the reply is awaited outside the section
  readonly initiate: (cancel?: Deferred.Deferred<void>) => Effect.Effect<T3InFlight<A, E>>;
}

/** A command: validation and the native translation for the observed build, without I/O */
export interface T3Command<I, A, E> {
  readonly prepare: (input: I) => Effect.Effect<T3PreparedCommand<A, E>, T3InvalidInput | T3Unsupported>;
}

export interface T3BuildFamily {
  // the builds the reference profile was captured from; not a claim of live tests of every operation on them
  readonly referenceBuilds: ReadonlyArray<ReferenceBuild>;
  // the facts of the last environment this service read; null before its first read
  readonly observed: Effect.Effect<BuildFacts | null>;
}

/** The read credential's orchestration reads and watches, with the operate credential's commands */
export interface T3OrchestrationFamily {
  // the environment descriptor over HTTP; each read records the build facts it selects
  readonly environment: Effect.Effect<T3Environment, T3ReadError>;
  // one full thread snapshot over HTTP within its byte budgets; a thread over a budget is not read again in full for ten minutes
  readonly thread: (threadId: string) => Effect.Effect<ThreadSnapshot, T3ReadError | T3InvalidInput>;
  // active and archived run anchors from one coherent active shell (HTTP) and archived snapshot: three pairs at most, then fail closed
  readonly shellBaseline: Effect.Effect<ShellBaseline, T3RequestError>;
  // fresh native lineage of the same coherent pair, active threads first
  readonly shellThreads: Effect.Effect<ReadonlyArray<ThreadInfo>, T3RequestError>;
  // the models T3 advertises now, normalized as T3 exposes them to its composer
  readonly config: Effect.Effect<ReadonlyArray<SupervisorModelInfo>, T3RequestError>;
  readonly turnItem: (request: TurnItemRequest, cancel?: Deferred.Deferred<void>) => Effect.Effect<TurnItemReply, T3RequestError | T3InvalidInput>;
  // the shell subscription from a cursor; a snapshot's archive cut is read on its own socket and must match the live snapshot
  readonly watchShell: <E = never, R = never>(cursor: number | undefined, onItem: (item: ShellSourceItem) => Effect.Effect<void, E, R>) =>
    Effect.Effect<never, T3ReadError | T3InvalidInput | E, R>;
  // one thread's subscription from a cursor, accepting a bounded snapshot
  readonly watchThread: <E = never, R = never>(threadId: string, cursor: number | undefined,
    onItem: (item: ThreadStreamItem) => Effect.Effect<void, E, R>) => Effect.Effect<never, T3ReadError | T3InvalidInput | E, R>;
  // the operate credential's commands; null where that credential is not configured
  readonly commands: T3OrchestrationCommands | null;
}

export interface T3OrchestrationCommands {
  readonly launchThread: T3Command<LaunchThread, LaunchReceipt, T3RequestError>;
  readonly dispatchCommand: T3Command<OrchestrationCommand, CommandReceipt, T3RequestError>;
}

/** The operate credential's scheduler requests and the helper webhook */
export interface T3HelperFamily {
  // the first value of the scheduler subscription; its socket ends on that value
  readonly tasks: (cancel?: Deferred.Deferred<void>) => Effect.Effect<ReadonlyArray<HelperTask>, T3RequestError>;
  readonly webhookDeliveries: (request: WebhookDeliveriesRequest, cancel?: Deferred.Deferred<void>) =>
    Effect.Effect<ReadonlyArray<WebhookDelivery>, T3RequestError | T3InvalidInput>;
  readonly webhookDelivery: (request: WebhookDeliveryRequest, cancel?: Deferred.Deferred<void>) =>
    Effect.Effect<WebhookDelivery, T3RequestError | T3InvalidInput>;
  readonly upsertTask: (request: HelperTaskUpsert, cancel?: Deferred.Deferred<void>) => Effect.Effect<HelperTask, T3RequestError | T3InvalidInput>;
  readonly deleteTask: (request: HelperTaskDelete, cancel?: Deferred.Deferred<void>) => Effect.Effect<void, T3RequestError | T3InvalidInput>;
  // the POST has no idempotency key: once initiated its outcome may be unknown, and it is never repeated
  readonly postWebhook: T3Command<WebhookPost, WebhookReply, T3WebhookError>;
}

/** Native file requests of the read credential */
export interface T3FileReads {
  readonly readFile: (request: ReadFileRequest, cancel?: Deferred.Deferred<void>) => Effect.Effect<FileContents, T3FileError | T3InvalidInput>;
  readonly listEntries: (request: ListEntriesRequest, cancel?: Deferred.Deferred<void>) =>
    Effect.Effect<DirectoryListing, T3FileError | T3InvalidInput>;
  readonly metadata: (request: MetadataRequest, cancel?: Deferred.Deferred<void>) => Effect.Effect<FileMetadata, T3FileError | T3InvalidInput>;
  readonly vcsRefs: (request: VcsRequest, cancel?: Deferred.Deferred<void>) => Effect.Effect<VcsRefs, T3FileError | T3InvalidInput>;
  // the first local status snapshot of a status subscription, never acknowledged
  readonly vcsStatus: (request: VcsRequest, cancel?: Deferred.Deferred<void>) => Effect.Effect<VcsStatus, T3FileError | T3InvalidInput>;
}

/** Native file requests of the project-write credential: only fixed `.t3-supervisor/` paths are written */
export interface T3FileWrites {
  readonly listEntries: (request: ListEntriesRequest, cancel?: Deferred.Deferred<void>) =>
    Effect.Effect<DirectoryListing, T3FileError | T3InvalidInput>;
  // the receipt echoes the written path; a write is never retried
  readonly writeFile: (request: WriteFileRequest, cancel?: Deferred.Deferred<void>) =>
    Effect.Effect<WriteFileReceipt, T3FileError | T3InvalidInput>;
}

/** The commit credential's stacked Git action */
export interface T3FileCommits {
  // committed only for a finished action that created a commit; a lost connection, cancel or deadline after connecting is uncertain
  readonly commit: (request: CommitRequest, cancel?: Deferred.Deferred<void>) => Effect.Effect<CommitOutcome, T3FileError | T3InvalidInput>;
}

export interface T3FilesFamily {
  readonly read: T3FileReads;
  // null where the project-write credential is not configured
  readonly write: T3FileWrites | null;
  // null where the commit credential is not configured
  readonly commit: T3FileCommits | null;
}

/** What an attach consumer does after a chunk: keep waiting, acknowledge it and then run afterAck, or end the attach */
export type TerminalAttachStep =
  | {readonly _tag: "Continue"}
  | {readonly _tag: "Acknowledge"; readonly afterAck: Effect.Effect<void>}
  | {readonly _tag: "Stop"};

/** The consumer of one attach request: each chunk's events in order, and the attach request's exit, which never ends the attach */
export interface TerminalAttachHandlers<E> {
  readonly onChunk: (events: ReadonlyArray<TerminalAttachEvent>) => Effect.Effect<TerminalAttachStep, E>;
  readonly onExit: (exit: TerminalAttachExit) => Effect.Effect<void, E>;
}

/** The probe credential's terminal requests, with the probe's framing, payload bound and deadlines */
export interface T3TerminalFamily {
  readonly open: (request: TerminalOpenRequest, cancel?: Deferred.Deferred<void>) => Effect.Effect<TerminalSnapshot, T3TerminalError | T3InvalidInput>;
  readonly write: (request: TerminalWriteRequest, cancel?: Deferred.Deferred<void>) => Effect.Effect<void, T3TerminalError | T3InvalidInput>;
  // runs until the consumer stops it, or fails with the attach socket's end
  readonly attach: <E>(request: TerminalAttachRequest, handlers: TerminalAttachHandlers<E>, cancel?: Deferred.Deferred<void>) =>
    Effect.Effect<void, T3TerminalError | T3InvalidInput | E>;
  readonly close: (request: TerminalCloseRequest, cancel?: Deferred.Deferred<void>) => Effect.Effect<void, T3TerminalError | T3InvalidInput>;
}

export interface T3NativeShape {
  readonly build: T3BuildFamily;
  readonly orchestration: T3OrchestrationFamily;
  // the operate credential's scheduler and helper webhook; null where that credential is not configured
  readonly helper: T3HelperFamily | null;
  readonly files: T3FilesFamily;
  // the probe credential's terminal; null where that credential is not configured
  readonly terminal: T3TerminalFamily | null;
}

/** A credential's endpoint: the T3 base url and the credential's bearer token */
export interface T3Endpoint {
  readonly baseUrl: string | URL;
  readonly token: string;
}

/** The credentials of one supervision run; an absent optional credential leaves its family unconstructed (null) */
export interface T3NativeCredentials {
  // the T3 base url the helper webhook paths resolve against
  readonly baseUrl: string;
  // the read credential of the file reads; its native client, shell reads and T3 client are the provided services
  readonly read: T3Endpoint;
  readonly projectWrite?: T3Endpoint | undefined;
  readonly commit?: T3Endpoint | undefined;
  readonly probe?: T3Endpoint | undefined;
}

// the client instances and process transport T3Native wraps
export type T3NativeClients = T3Client | NativeRpc | NativeShell | NativeEnvelope | HttpClient.HttpClient | Crypto.Crypto;

// a facade over the run's own client instances: the T3 client, the read credential's native client with its shell reads and the
// operate credential's client when configured, plus the shared envelope, crypto and HTTP client of the process; it builds no client,
// memo or heartbeat of its own. The operate client's presence gates the commands and the helper family exactly as before
const makeT3Native = (credentials: T3NativeCredentials): Effect.Effect<T3NativeShape, never, T3NativeClients> => Effect.gen(function* () {
  const t3 = yield* T3Client;
  const read = yield* NativeRpc;
  const shell = yield* NativeShell;
  const operate = Option.getOrNull(yield* Effect.serviceOption(NativeOperateRpc));
  const envelope = yield* NativeEnvelope;
  const http = yield* HttpClient.HttpClient;
  const crypto = yield* Crypto.Crypto;
  const observed = yield* Ref.make<BuildFacts | null>(null);
  return T3Native.of({
    build: {referenceBuilds, observed: Ref.get(observed)},
    orchestration: makeOrchestration({t3, read, shell, operate, observed}),
    helper: operate === null ? null : makeHelper({operate, http, baseUrl: credentials.baseUrl, observed}),
    files: makeFiles(envelope, {read: credentials.read, projectWrite: credentials.projectWrite, commit: credentials.commit}),
    terminal: credentials.probe === undefined ? null : makeTerminal(envelope, credentials.probe, crypto),
  });
});

/** The typed T3 integration: business code reaches T3 only through this service */
export class T3Native extends Context.Service<T3Native, T3NativeShape>()("t3-supervisor/T3Native") {
  static readonly make: (credentials: T3NativeCredentials) => Effect.Effect<T3NativeShape, never, T3NativeClients> = makeT3Native;
  static readonly layer = (credentials: T3NativeCredentials): Layer.Layer<T3Native, never, T3NativeClients> =>
    Layer.effect(T3Native, makeT3Native(credentials));
}
