import { Context, type Deferred, type Effect } from "effect";
import type { SupervisorModelInfo } from "../project-supervisor-contract.js";
import type { ThreadInfo } from "../types.js";
import type {
  BuildFacts, CommandReceipt, CommitOutcome, CommitRequest, DirectoryListing, FileContents, FileMetadata, HelperTask, HelperTaskDelete,
  HelperTaskUpsert, LaunchReceipt, LaunchThread, ListEntriesRequest, MetadataRequest, OrchestrationCommand, ReadFileRequest, ShellBaseline,
  ShellSourceItem, T3Environment, T3Operation, TerminalAttachEvent, TerminalAttachExit, TerminalAttachRequest, TerminalCloseRequest,
  TerminalOpenRequest, TerminalSnapshot, TerminalWriteRequest, ThreadSnapshot, ThreadStreamItem, TurnItemReply, TurnItemRequest, VcsRefs,
  VcsRequest, VcsStatus, VerifiedBuild, WebhookDeliveriesRequest, WebhookDelivery, WebhookDeliveryRequest, WebhookPost, WebhookReply,
  WriteFileReceipt, WriteFileRequest,
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
  readonly verifiedBuilds: ReadonlyArray<VerifiedBuild>;
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

/** The typed T3 integration: business code reaches T3 only through this service */
export class T3Native extends Context.Service<T3Native, T3NativeShape>()("t3-supervisor/T3Native") {}
