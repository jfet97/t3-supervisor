import { Schema } from "effect";
import { ModelSelection, SupervisorModel } from "../project-supervisor-contract.js";
import type { Projection, ThreadInfo } from "../types.js";

/*
 * The typed contract of every Supervisor -> T3 operation behind T3Native: operation names, inputs, receipts and stream items, with
 * their types derived from these schemas. A native value is checked by a guard over its declared fields and kept whole: every key,
 * value and key order stays as T3 sent it, and nothing here decodes a native object through an excess-stripping Struct. Passing a
 * guard never makes a value authoritative; the existing verifiers decide what a native value proves.
 */

// ---- operations ----

/** The operations of T3Native, named `family/operation`; they name Supervisor operations, never native request tags */
export const T3Operation = Schema.Literals([
  "orchestration/environment", "orchestration/thread", "orchestration/shellBaseline", "orchestration/shellThreads",
  "orchestration/config", "orchestration/turnItem", "orchestration/watchShell", "orchestration/watchThread",
  "orchestration/launchThread", "orchestration/dispatchCommand",
  "helper/tasks", "helper/webhookDeliveries", "helper/webhookDelivery", "helper/upsertTask", "helper/deleteTask", "helper/postWebhook",
  "files/readFile", "files/listEntries", "files/metadata", "files/vcsRefs", "files/vcsStatus", "files/writeFile", "files/commit",
  "terminal/open", "terminal/write", "terminal/attach", "terminal/close",
]);
export type T3Operation = typeof T3Operation.Type;

// ---- shared shapes ----

const Id = Schema.String.check(Schema.isMinLength(1));
const NonBlank = Schema.String.check(Schema.makeFilter((value: string) => value.trim().length > 0));
const Sequence = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const NullableString = Schema.NullOr(Schema.String);
const ProtocolVersion = Schema.Literal(2);
const NativeFields = Schema.Record(Schema.String, Schema.Unknown);
const isNativeFields = Schema.is(NativeFields);

/** A native object (never an array), kept whole */
export type NativeRecord = Readonly<Record<string, unknown>>;
export const NativeRecord = Schema.declare((value: unknown): value is NativeRecord => isNativeFields(value));

// ---- build ----

/**
 * A T3 build a pinned reference profile was captured from (its contracts read from that build's published source), with the
 * operations that profile records as absent. It is a captured reference, not a claim that every operation or provider workflow was
 * tested live on that build.
 */
export const ReferenceBuild = Schema.Struct({
  serverVersion: NonBlank,
  // where the pin is kept
  source: Schema.String,
  absent: Schema.Array(T3Operation),
});
export type ReferenceBuild = typeof ReferenceBuild.Type;

/**
 * What an environment descriptor selects. serverVersion is metadata T3 reported over HTTP; native requests open their own sockets,
 * so it is not proof of the build that executes them. `referenceBuild` says only that the reported version is the build a reference
 * profile was captured from; any other build keeps the same implementation.
 */
export const BuildFacts = Schema.Struct({
  environmentId: Schema.String,
  serverVersion: Schema.String,
  orchestrationProtocolVersion: ProtocolVersion,
  referenceBuild: Schema.Boolean,
});
export type BuildFacts = typeof BuildFacts.Type;

// ---- orchestration reads ----

const EnvironmentFields = Schema.Struct({environmentId: NonBlank, orchestrationProtocolVersion: ProtocolVersion, serverVersion: NonBlank});
const isEnvironment = Schema.is(EnvironmentFields);
/** The environment descriptor (GET /.well-known/t3/environment), kept whole */
export type T3Environment = typeof EnvironmentFields.Type & NativeRecord;
export const T3Environment = Schema.declare((value: unknown): value is T3Environment => isEnvironment(value));

const RunFields = Schema.Struct({
  id: Schema.String, ordinal: Schema.Int, status: Schema.String, requestedAt: Schema.String,
  startedAt: NullableString, completedAt: NullableString, rootNodeId: NullableString,
});
const MessageFields = Schema.Struct({
  id: Schema.String, runId: NullableString, nodeId: NullableString, role: Schema.String, text: Schema.String,
  streaming: Schema.Boolean, createdAt: Schema.String, updatedAt: Schema.String,
});
const ProjectionFields = Schema.Struct({
  thread: Schema.Struct({
    id: NonBlank, title: Schema.String, projectId: NullableString,
    lineage: Schema.Struct({parentThreadId: NullableString, relationshipToParent: NullableString}),
  }),
  runs: Schema.Array(RunFields),
  messages: Schema.Array(MessageFields),
  subagents: Schema.optional(Schema.Array(NativeFields)),
  turnItems: Schema.optional(Schema.Array(NativeFields)),
  schemaVersion: Schema.optional(ProtocolVersion),
});
const isProjection = Schema.is(ProjectionFields);
/**
 * A full thread projection, checked on the fields the HTTP read checks at the wire and kept whole; its type is the domain
 * Projection. Provider turns and nodes stay the native values the workflow verifiers read and classify.
 */
export const ThreadProjection = Schema.declare((value: unknown): value is Projection => isProjection(value));

const ThreadSnapshotFields = Schema.Struct({snapshotSequence: Sequence, projection: ThreadProjection});
const isThreadSnapshot = Schema.is(ThreadSnapshotFields);
/** One full thread snapshot (GET /api/orchestration/threads/<id>), kept whole */
export type ThreadSnapshot = typeof ThreadSnapshotFields.Type & NativeRecord;
export const ThreadSnapshot = Schema.declare((value: unknown): value is ThreadSnapshot => isThreadSnapshot(value));

const ShellAnchor = Schema.Struct({id: Schema.String, latestRunId: NullableString});
/** Active and archived run anchors at one global revision */
export const ShellBaseline = Schema.Struct({snapshotSequence: Sequence, threads: Schema.mutable(Schema.Array(ShellAnchor))});
export type ShellBaseline = typeof ShellBaseline.Type;

const ShellText = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512));
const ShellThreadFields = Schema.Struct({
  id: ShellText, title: Schema.String, projectId: Schema.NullOr(ShellText),
  lineage: Schema.Struct({parentThreadId: Schema.NullOr(ShellText), relationshipToParent: Schema.NullOr(Schema.Literals(["subagent", "fork"]))}),
});
const isShellThread = Schema.is(ShellThreadFields);
/** A thread of the coherent active and archived shell with its native lineage, kept whole */
export const ShellThread = Schema.declare((value: unknown): value is ThreadInfo => isShellThread(value));

/** The models T3 advertises to its composer, normalized for the Supervisor's model choice */
export const SupervisorModels = Schema.Array(SupervisorModel);

export const TurnItemRequest = Schema.Struct({threadId: Id, itemId: Id});
export type TurnItemRequest = typeof TurnItemRequest.Type;

const OptionalNullableString = Schema.optionalKey(NullableString);
// the identity and graph fields of the pinned build's turn items (orchestration.getTurnItem); the rest stays native
const TurnItemFields = Schema.Struct({
  id: Id,
  type: Schema.String,
  threadId: Id,
  runId: OptionalNullableString,
  nodeId: OptionalNullableString,
  parentItemId: OptionalNullableString,
  providerThreadId: OptionalNullableString,
  providerTurnId: OptionalNullableString,
  toolName: OptionalNullableString,
  inputTruncated: Schema.optionalKey(Schema.Boolean),
  truncated: Schema.optionalKey(Schema.Boolean),
  outputOmitted: Schema.optionalKey(Schema.Boolean),
});
const isTurnItem = Schema.is(TurnItemFields);
/**
 * One turn item with its typed native identity, graph and truncation fields, kept whole: its tool `input` stays the native value (an
 * object, or JSON text the verifier decodes) within the verifiers' bounds (workflowToolInputMaxBytes, workflowTurnItemDetailMaxBytes)
 */
export type TurnItem = typeof TurnItemFields.Type & NativeRecord;
export const TurnItem = Schema.declare((value: unknown): value is TurnItem => isTurnItem(value));

/**
 * The item of a turn item reply as the verifiers receive it, never a read failure for an item that is present:
 * - `Item`: an item whose identity, graph and truncation fields have the pinned build's types, kept whole;
 * - `Nonconforming`: a present JSON object that breaks those types, kept whole exactly as received (the same value, never copied,
 *   stripped or logged), so the existing verifiers keep their decisions, a numeric nodeId among them;
 * - `Absent`: null or a value that is not an object, the callers' pending path.
 * The detail size bound stays each caller's decision.
 */
export const TurnItemView = Schema.Union([
  Schema.Struct({_tag: Schema.Literal("Item"), item: TurnItem}),
  Schema.Struct({_tag: Schema.Literal("Nonconforming"), item: NativeRecord}),
  Schema.Struct({_tag: Schema.Literal("Absent")}),
]);
export type TurnItemView = typeof TurnItemView.Type;

// ---- orchestration watches ----

const Location = Schema.optional(Schema.Literals(["active", "archive"]));
const ShellStreamFields = Schema.Union([
  Schema.Struct({kind: Schema.Literal("synchronized")}),
  Schema.Struct({
    kind: Schema.Literal("snapshot"),
    // the members stay native values: the catalog store checks each one, and skips a foreign project of an enrichment snapshot
    snapshot: Schema.Struct({
      schemaVersion: ProtocolVersion, snapshotSequence: Sequence,
      projects: Schema.Array(Schema.Unknown), threads: Schema.Array(Schema.Unknown), archivedThreads: Schema.Array(Schema.Unknown),
    }),
    resolvedRepositoryIdentityRoots: Schema.optional(Schema.Array(Schema.String)),
  }),
  Schema.Struct({kind: Schema.Literal("thread.updated"), sequence: Sequence, thread: Schema.Struct({id: NonBlank}), location: Location}),
  Schema.Struct({kind: Schema.Literal("thread.removed"), sequence: Sequence, threadId: NonBlank, location: Location}),
  Schema.Struct({kind: Schema.Literal("project.updated"), sequence: Sequence, project: Schema.Struct({id: NonBlank})}),
  Schema.Struct({kind: Schema.Literal("project.removed"), sequence: Sequence, projectId: NonBlank}),
]);
const isShellStreamItem = Schema.is(ShellStreamFields);
/** One item of the shell subscription: a closed set of kinds, kept whole */
export type ShellStreamItem = typeof ShellStreamFields.Type & NativeRecord;
export const ShellStreamItem = Schema.declare((value: unknown): value is ShellStreamItem => isShellStreamItem(value));

const CatalogThreadFields = Schema.Struct({id: Id, title: Schema.String, lineage: NativeRecord});
const isCatalogThread = Schema.is(CatalogThreadFields);
/**
 * An archived thread of a shell archive cut, kept whole and checked exactly as the catalog store reads every thread it ingests: a
 * non-empty id, a title and a lineage object. Its lineage values stay native, so a relationship an unknown build adds is not refused.
 */
export type CatalogThread = typeof CatalogThreadFields.Type & NativeRecord;
export const CatalogThread = Schema.declare((value: unknown): value is CatalogThread => isCatalogThread(value));

/** The archived half of one live shell snapshot, read from its own unary request before the snapshot is handed on */
export const ShellArchiveCut = Schema.Struct({snapshotSequence: Sequence, threads: Schema.Array(CatalogThread)});
export type ShellArchiveCut = typeof ShellArchiveCut.Type;

/** What the shell watch hands its consumer: an active item, with its archive cut for a non-enrichment snapshot */
export const ShellSourceItem = Schema.Struct({stream: Schema.Literal("active"), item: ShellStreamItem, archiveCut: Schema.optionalKey(ShellArchiveCut)});
export type ShellSourceItem = typeof ShellSourceItem.Type;

const ThreadStreamFields = Schema.Union([
  Schema.Struct({kind: Schema.Literal("synchronized")}),
  Schema.Struct({kind: Schema.Literal("snapshot"), snapshotSequence: Sequence, projection: ThreadProjection}),
  // an event of any type: its payload is the native value of that event
  Schema.Struct({kind: Schema.Literal("event"), sequence: Sequence, event: Schema.Struct({type: NonBlank, payload: Schema.Unknown})}),
  Schema.Struct({kind: Schema.Literal("unknown-event"), sequence: Sequence, eventType: NonBlank}),
]);
const isThreadStreamItem = Schema.is(ThreadStreamFields);
/** One item of a thread subscription, kept whole; an event T3 cannot describe arrives as `unknown-event` */
export type ThreadStreamItem = typeof ThreadStreamFields.Type & NativeRecord;
export const ThreadStreamItem = Schema.declare((value: unknown): value is ThreadStreamItem => isThreadStreamItem(value));

// ---- orchestration commands ----

/** How a message joins the target thread: queued after its active run, or steering that exact run */
export const DispatchMode = Schema.Union([
  Schema.Struct({type: Schema.Literal("queue_after_active")}),
  Schema.Struct({type: Schema.Literal("steer_active"), targetRunId: Id}),
]);
export type DispatchMode = typeof DispatchMode.Type;

/** A system message under the caller's deterministic command and message identities */
export const MessageDispatch = Schema.Struct({
  _tag: Schema.Literal("MessageDispatch"), commandId: Id, messageId: Id, threadId: Id, text: Schema.String, dispatchMode: DispatchMode,
});
export const ThreadSettle = Schema.Struct({_tag: Schema.Literal("ThreadSettle"), commandId: Id, threadId: Id});
/** The automatic settle of a participant, pinned to the snapshot it was judged on */
export const ThreadAutoSettle = Schema.Struct({_tag: Schema.Literal("ThreadAutoSettle"), commandId: Id, threadId: Id, snapshotAt: Schema.String});
export const ThreadStop = Schema.Struct({
  _tag: Schema.Literal("ThreadStop"), commandId: Id, threadId: Id, stopDelegatedTasks: Schema.Boolean, reason: Schema.String,
});
export const QueuedRunCancel = Schema.Struct({_tag: Schema.Literal("QueuedRunCancel"), commandId: Id, threadId: Id, runId: Id});
/** The disposal of a delegated task's pending completion delivery to its parent */
export const DelegatedCompletionDispose = Schema.Struct({
  _tag: Schema.Literal("DelegatedCompletionDispose"), commandId: Id, parentThreadId: Id, taskId: Id,
});
export const OrchestrationCommand = Schema.Union([MessageDispatch, ThreadSettle, ThreadAutoSettle, ThreadStop, QueuedRunCancel, DelegatedCompletionDispose]);
export type OrchestrationCommand = typeof OrchestrationCommand.Type;

/** The launch of a Supervisor conversation under the caller's reserved thread identity, in the Supervisor's launch profile */
export const LaunchThread = Schema.Struct({commandId: Id, threadId: Id, projectId: Id, title: Schema.String, modelSelection: ModelSelection});
export type LaunchThread = typeof LaunchThread.Type;

const CommandReceiptFields = Schema.Struct({sequence: Sequence});
const isCommandReceipt = Schema.is(CommandReceiptFields);
/** T3's acceptance of a dispatched command (orchestration.dispatchCommand): the sequence it was committed at, kept whole */
export type CommandReceipt = typeof CommandReceiptFields.Type & NativeRecord;
export const CommandReceipt = Schema.declare((value: unknown): value is CommandReceipt => isCommandReceipt(value));

const LaunchReceiptFields = Schema.Struct({threadId: Id, projection: NativeRecord, resumed: Schema.Boolean, sequence: Schema.optionalKey(Sequence)});
const isLaunchReceipt = Schema.is(LaunchReceiptFields);
/**
 * T3's launch result on the pinned build (orchestration.launchThread): the thread, its projection, whether an existing thread was
 * resumed, and the initial message's sequence when there was one. Kept whole; the projection stays the native value, and the caller
 * confirms the launched thread by reading it back.
 */
export type LaunchReceipt = typeof LaunchReceiptFields.Type & NativeRecord;
export const LaunchReceipt = Schema.declare((value: unknown): value is LaunchReceipt => isLaunchReceipt(value));

// ---- helper ----

/**
 * A runtime mode on the pinned build's wire; a mode a helper thread already carries is sent back exactly as read, so a value outside
 * the pinned set stays a string rather than a refusal
 */
export const RuntimeMode = Schema.Union([Schema.Literals(["approval-required", "auto-accept-edits", "auto", "full-access"]), NonBlank]);
export type RuntimeMode = typeof RuntimeMode.Type;
/** An interaction mode on the pinned build's wire, open as RuntimeMode is */
export const InteractionMode = Schema.Union([Schema.Literals(["default", "plan"]), NonBlank]);
export type InteractionMode = typeof InteractionMode.Type;

const OptionSelection = Schema.Struct({id: Schema.String, value: Schema.Union([Schema.String, Schema.Boolean])});
const NativeModelSelectionFields = Schema.Struct({instanceId: Schema.String, model: Schema.String, options: Schema.optionalKey(Schema.Array(OptionSelection))});
const isNativeModelSelection = Schema.is(NativeModelSelectionFields);
/** A thread's or a task's model selection as the pinned build writes it (provider instance, model and option choices), kept whole */
export type NativeModelSelection = typeof NativeModelSelectionFields.Type & NativeRecord;
export const NativeModelSelection = Schema.declare((value: unknown): value is NativeModelSelection => isNativeModelSelection(value));

const HelperTaskScheduleFields = Schema.Struct({type: Schema.optionalKey(Schema.String)});
const isHelperTaskSchedule = Schema.is(HelperTaskScheduleFields);
const HelperTaskSchedule = Schema.declare((value: unknown): value is typeof HelperTaskScheduleFields.Type & NativeRecord => isHelperTaskSchedule(value));
const HelperTaskWebhookFields = Schema.Struct({path: Schema.optionalKey(Schema.String)});
const isHelperTaskWebhook = Schema.is(HelperTaskWebhookFields);
const HelperTaskWebhook = Schema.declare((value: unknown): value is typeof HelperTaskWebhookFields.Type & NativeRecord => isHelperTaskWebhook(value));
// the pinned build's scheduled task fields the helper transport reads; a key may be absent, and a webhook may be null
const HelperTaskFields = Schema.Struct({
  id: Id,
  threadId: OptionalNullableString,
  projectId: Schema.optionalKey(Schema.String),
  prompt: Schema.optionalKey(Schema.String),
  schedule: Schema.optionalKey(HelperTaskSchedule),
  enabled: Schema.optionalKey(Schema.Boolean),
  createdAt: Schema.optionalKey(Schema.String),
  modelSelection: Schema.optionalKey(NativeModelSelection),
  runtimeMode: Schema.optionalKey(RuntimeMode),
  interactionMode: Schema.optionalKey(InteractionMode),
  webhook: Schema.optionalKey(Schema.NullOr(HelperTaskWebhook)),
});
const isHelperTask = Schema.is(HelperTaskFields);
/**
 * A scheduled task as T3 records it, kept whole: every task of the scheduler, the helper's webhook tasks among them. It declares
 * exactly the fields the helper transport reads, typed as the pinned build writes them; the transport's own ownership and readiness
 * checks keep their authority.
 */
export type HelperTask = typeof HelperTaskFields.Type & NativeRecord;
export const HelperTask = Schema.declare((value: unknown): value is HelperTask => isHelperTask(value));

// the pinned build's delivery summary and detail fields the helper transport reads (the outcome is an open string there too)
const WebhookDeliveryFields = Schema.Struct({
  id: Id,
  taskId: Schema.optionalKey(Schema.String),
  outcome: Schema.optionalKey(Schema.String),
  method: Schema.optionalKey(Schema.String),
  contentType: OptionalNullableString,
  bodyBytes: Schema.optionalKey(Sequence),
  receivedAt: Schema.optionalKey(Schema.String),
  body: Schema.optionalKey(Schema.String),
  bodyTruncated: Schema.optionalKey(Schema.Boolean),
  missingFields: Schema.optionalKey(Schema.Array(Schema.String)),
  renderedPrompt: OptionalNullableString,
});
const isWebhookDelivery = Schema.is(WebhookDeliveryFields);
/**
 * A webhook delivery as T3's delivery log records it (a list summary or its detail), kept whole. It declares exactly the fields the
 * helper transport reads; the transport's exact body, byte, outcome and rendering checks keep their authority.
 */
export type WebhookDelivery = typeof WebhookDeliveryFields.Type & NativeRecord;
export const WebhookDelivery = Schema.declare((value: unknown): value is WebhookDelivery => isWebhookDelivery(value));

const TaskVariant = Schema.Struct({_tag: Schema.Literal("Task"), task: HelperTask});
const NonconformingTask = Schema.Struct({_tag: Schema.Literal("Nonconforming"), task: NativeRecord});
const DeliveryVariant = Schema.Struct({_tag: Schema.Literal("Delivery"), delivery: WebhookDelivery});
const NonconformingDelivery = Schema.Struct({_tag: Schema.Literal("Nonconforming"), delivery: NativeRecord});

/**
 * One present scheduled task, never a failed read: `Task` is the typed view, kept whole; `Nonconforming` is a JSON object whose
 * declared fields break the pinned types, the same object as received, so the transport's own checks keep deciding it
 */
export const HelperTaskView = Schema.Union([TaskVariant, NonconformingTask]);
export type HelperTaskView = typeof HelperTaskView.Type;
/** One present webhook delivery, typed or nonconforming as HelperTaskView: present delivery evidence is never hidden */
export const WebhookDeliveryView = Schema.Union([DeliveryVariant, NonconformingDelivery]);
export type WebhookDeliveryView = typeof WebhookDeliveryView.Type;

/*
 * Lists must contain only native objects, as the existing helper transport requires. Each object then keeps its typed or
 * nonconforming view; a null, primitive or array invalidates the entire list instead of exposing partial delivery evidence.
 */
export const HelperTaskList = Schema.Struct({tasks: Schema.Array(NativeRecord)});
export const WebhookDeliveriesRequest = Schema.Struct({taskId: Id});
export type WebhookDeliveriesRequest = typeof WebhookDeliveriesRequest.Type;
export const WebhookDeliveryList = Schema.Struct({deliveries: Schema.Array(NativeRecord)});
export const WebhookDeliveryRequest = Schema.Struct({taskId: Id, deliveryId: Id});
export type WebhookDeliveryRequest = typeof WebhookDeliveryRequest.Type;
export const WebhookDeliveryDetail = Schema.Struct({delivery: NativeRecord});

/**
 * The helper's webhook task, created or updated under the caller's deterministic command identity: an enabled webhook task on the
 * project root, created by the system. The model selection and modes are the helper thread's own, sent exactly as read.
 */
export const HelperTaskUpsert = Schema.Struct({
  taskId: Id, requireExisting: Schema.Boolean, commandId: Id, title: Schema.String, prompt: Schema.String, projectId: Id, threadId: Id,
  modelSelection: NativeModelSelection, runtimeMode: RuntimeMode, interactionMode: InteractionMode,
});
export type HelperTaskUpsert = typeof HelperTaskUpsert.Type;
export const HelperTaskUpsertReply = Schema.Struct({task: NativeRecord});
export const HelperTaskDelete = Schema.Struct({taskId: Id});
export type HelperTaskDelete = typeof HelperTaskDelete.Type;

/** One POST to a helper task's webhook path on the T3 origin */
export const WebhookPost = Schema.Struct({path: Schema.String, batchId: Schema.String, text: Schema.String});
export type WebhookPost = typeof WebhookPost.Type;

/** The channel-readiness prefix check; command preparation separately checks the origin, query and fragment. */
export const isHelperWebhookPath = (path: string): boolean => path.startsWith("/api/hooks/");

/** The exact request body of a helper webhook POST; receipts and native delivery detail are compared against these bytes */
export const webhookBody = (post: Pick<WebhookPost, "batchId" | "text">): string => JSON.stringify({batchId: post.batchId, text: post.text});

/**
 * The status of a webhook POST: accepted (2xx, with the native delivery id when its body named one), refused by T3 (4xx), or an
 * answer that confirms nothing
 */
export const WebhookReply = Schema.Union([
  Schema.Struct({_tag: Schema.Literal("Accepted"), deliveryId: Schema.optionalKey(Schema.String)}),
  Schema.Struct({_tag: Schema.Literal("Refused"), httpStatus: Schema.Int}),
  Schema.Struct({_tag: Schema.Literal("Unconfirmed"), httpStatus: Schema.Int}),
]);
export type WebhookReply = typeof WebhookReply.Type;

// ---- files ----

export const FileFailure = Schema.Literals(["missing", "invalid_file", "permission_required", "unavailable"]);
export type FileFailure = typeof FileFailure.Type;
// the credential a file operation ran under
export const FileScope = Schema.Literals(["read", "write"]);
export type FileScope = typeof FileScope.Type;

export const ReadFileRequest = Schema.Struct({cwd: Schema.String, relativePath: Schema.String});
export type ReadFileRequest = typeof ReadFileRequest.Type;
const ByteLength = Schema.Number.check(Schema.makeFilter((value: number) => Number.isSafeInteger(value) && value >= 0));
const FileContentsFields = Schema.Struct({contents: Schema.String, byteLength: ByteLength, truncated: Schema.Boolean});
const isFileContents = Schema.is(FileContentsFields);
/** A file's text as T3 read it, kept whole so a revision hashes exactly what T3 returned */
export type FileContents = typeof FileContentsFields.Type & NativeRecord;
export const FileContents = Schema.declare((value: unknown): value is FileContents => isFileContents(value));

export const ListEntriesRequest = Schema.Struct({cwd: Schema.String, directoryPath: Schema.String});
export type ListEntriesRequest = typeof ListEntriesRequest.Type;
const DirectoryEntryFields = Schema.Struct({path: Schema.String, kind: Schema.String});
const isDirectoryEntry = Schema.is(DirectoryEntryFields);
/** One listed entry, kept whole; a reader requires the kinds it accepts */
export type DirectoryEntry = typeof DirectoryEntryFields.Type & NativeRecord;
export const DirectoryEntry = Schema.declare((value: unknown): value is DirectoryEntry => isDirectoryEntry(value));
const DirectoryListingFields = Schema.Struct({truncated: Schema.Boolean, entries: Schema.Array(DirectoryEntry)});
const isDirectoryListing = Schema.is(DirectoryListingFields);
export type DirectoryListing = typeof DirectoryListingFields.Type & NativeRecord;
export const DirectoryListing = Schema.declare((value: unknown): value is DirectoryListing => isDirectoryListing(value));

export const MetadataRequest = Schema.Struct({paths: Schema.Array(Schema.String)});
export type MetadataRequest = typeof MetadataRequest.Type;
const FileMetadataFields = Schema.Struct({entries: Schema.Array(NativeRecord)});
const isFileMetadata = Schema.is(FileMetadataFields);
export type FileMetadata = typeof FileMetadataFields.Type & NativeRecord;
export const FileMetadata = Schema.declare((value: unknown): value is FileMetadata => isFileMetadata(value));

export const VcsRequest = Schema.Struct({cwd: Schema.String});
export type VcsRequest = typeof VcsRequest.Type;
const VcsRefsFields = Schema.Struct({isRepo: Schema.Boolean, refs: Schema.Array(Schema.Struct({name: Schema.String, current: Schema.Boolean,
  isDefault: Schema.Boolean, worktreePath: NullableString, isRemote: Schema.optionalKey(Schema.Boolean), remoteName: Schema.optionalKey(Schema.String)}))});
const isVcsRefs = Schema.is(VcsRefsFields);
/** The checkout's refs (at most 200 of every kind), kept whole */
export type VcsRefs = typeof VcsRefsFields.Type & NativeRecord;
export const VcsRefs = Schema.declare((value: unknown): value is VcsRefs => isVcsRefs(value));
const VcsStatusFields = Schema.Struct({isRepo: Schema.Boolean, workingTree: Schema.Struct({files: Schema.Array(Schema.Struct({path: Schema.String}))})});
const isVcsStatus = Schema.is(VcsStatusFields);
/** The first local status snapshot of the checkout, kept whole */
export type VcsStatus = typeof VcsStatusFields.Type & NativeRecord;
export const VcsStatus = Schema.declare((value: unknown): value is VcsStatus => isVcsStatus(value));

export const WriteFileRequest = Schema.Struct({cwd: Schema.String, relativePath: Schema.String, contents: Schema.String});
export type WriteFileRequest = typeof WriteFileRequest.Type;
const WriteFileReceiptFields = Schema.Struct({relativePath: Schema.String});
const isWriteFileReceipt = Schema.is(WriteFileReceiptFields);
/** T3's echo of a written path, kept whole */
export type WriteFileReceipt = typeof WriteFileReceiptFields.Type & NativeRecord;
export const WriteFileReceipt = Schema.declare((value: unknown): value is WriteFileReceipt => isWriteFileReceipt(value));

/** A commit of fixed Supervisor paths under the caller's deterministic action identity */
export const CommitRequest = Schema.Struct({cwd: Schema.String, filePaths: Schema.Array(Schema.String), message: Schema.String, actionId: Id});
export type CommitRequest = typeof CommitRequest.Type;
/** committed only for a finished action that created a commit; uncertain for any end that may have committed */
export const CommitOutcome = Schema.Union([
  Schema.Struct({status: Schema.Literal("committed"), commitSha: Schema.String}),
  Schema.Struct({status: Schema.Literal("uncertain")}),
]);
export type CommitOutcome = typeof CommitOutcome.Type;

// ---- terminal ----

export const TerminalOpenRequest = Schema.Struct({
  threadId: Id, terminalId: Id, cwd: Schema.String, cols: Schema.Int, rows: Schema.Int, env: Schema.Record(Schema.String, Schema.String),
});
export type TerminalOpenRequest = typeof TerminalOpenRequest.Type;
export const TerminalWriteRequest = Schema.Struct({threadId: Id, terminalId: Id, data: Schema.String});
export type TerminalWriteRequest = typeof TerminalWriteRequest.Type;
export const TerminalAttachRequest = Schema.Struct({threadId: Id, terminalId: Id, cwd: Schema.String});
export type TerminalAttachRequest = typeof TerminalAttachRequest.Type;
export const TerminalCloseRequest = Schema.Struct({threadId: Id, terminalId: Id, deleteHistory: Schema.Boolean});
export type TerminalCloseRequest = typeof TerminalCloseRequest.Type;

/** The terminal snapshot T3 answers an open with, kept whole for the probe's own target check */
export type TerminalSnapshot = NativeRecord;

/** One event of an attach chunk in its position: a native record, or a value that is not one */
export const TerminalAttachEvent = Schema.Union([
  Schema.Struct({_tag: Schema.Literal("Event"), event: NativeRecord}),
  Schema.Struct({_tag: Schema.Literal("Malformed")}),
]);
export type TerminalAttachEvent = typeof TerminalAttachEvent.Type;

/** How T3 ended the attach request: a success, or any other exit */
export const TerminalAttachExit = Schema.Literals(["Success", "Failure"]);
export type TerminalAttachExit = typeof TerminalAttachExit.Type;
