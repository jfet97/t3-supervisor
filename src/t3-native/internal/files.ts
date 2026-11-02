import { Deferred, Effect, Schema } from "effect";
import { nativeMaxPayload, NativeStep, type NativeCall, type NativeEndpoint, type NativeEnvelope, type NativeExit } from "../../native-envelope.js";
import {
  CommitRequest, DirectoryListing, FileContents, FileMetadata, ListEntriesRequest, MetadataRequest, ReadFileRequest, VcsRefs, VcsRequest, VcsStatus,
  WriteFileReceipt, WriteFileRequest, type CommitOutcome, type FileFailure, type FileScope, type T3Operation,
} from "../contracts.js";
import { T3FileError, T3InvalidInput } from "../errors.js";
import type { T3FileCommits, T3FileReads, T3FilesFamily, T3FileWrites } from "../service.js";

// the files family over the shared native envelope, one native request per call on its own socket with the project file clients'
// bounds: 2 MiB frames, a 5 s handshake and a deadline over the whole call (10 s, 30 s for a commit). A completed cancel ends a
// request as unavailable, before connecting when it was already completed. Native failures keep the file clients' classification.

export interface FileEndpoints {
  readonly read: NativeEndpoint;
  // the project-write credential; absent where it is not configured
  readonly projectWrite?: NativeEndpoint | undefined;
  // the commit credential; absent where it is not configured
  readonly commit?: NativeEndpoint | undefined;
}

const record = Schema.is(Schema.Record(Schema.String, Schema.Unknown));

// the file failure a native failure value names, searched through the value as T3 nests its causes
const failure = (value: unknown, depth = 0): FileFailure => {
  if (depth > 12 || !value || typeof value !== "object") return "unavailable";
  if (record(value)) {
    if (value._tag === "EnvironmentAuthorizationError") return "permission_required";
    if (value.code === "ENOENT" || typeof value.message === "string" && /^ENOENT:/.test(value.message)) return "missing";
    if (value.code === "EACCES" || value.code === "EPERM" || typeof value.message === "string" && /^(?:EACCES|EPERM):/.test(value.message)) return "invalid_file";
    if (value.failure === "binary_file" || value.failure === "path_not_file") return "invalid_file";
  }
  const codes = Object.values(value).map(v => failure(v, depth + 1));
  return codes.includes("permission_required") ? "permission_required" : codes.includes("invalid_file") ? "invalid_file" : codes.includes("missing") ? "missing" : "unavailable";
};

// only fixed Supervisor paths are written or committed: relative, below .t3-supervisor, without empty, current or parent segments
const supervisorPath = (path: string): boolean => path.startsWith(".t3-supervisor/") && !path.includes("\\") && !path.includes("\0") &&
  path.split("/").every(part => part !== ".." && part !== "." && part.length > 0);
// a path T3 reads relative to a checkout: bounded, without NUL or backslash
const readablePath = (path: string): boolean => path.length <= 512 && !path.includes("\0") && !path.includes("\\");
const listablePath = (path: string): boolean => !path.includes("\0") && !path.includes("\\");

const fileCall = <A, E>(endpoint: NativeEndpoint, call: Pick<NativeCall<A, E>, "request" | "onChunk" | "onExit" | "cancel">, timeout: "10 seconds" | "30 seconds") =>
  ({endpoint, maxPayload: nativeMaxPayload.files, handshakeTimeout: "5 seconds", timeout, ...call}) satisfies NativeCall<A, E>;

const isReadFileRequest = Schema.is(ReadFileRequest);
const isListEntriesRequest = Schema.is(ListEntriesRequest);
const isMetadataRequest = Schema.is(MetadataRequest);
const isVcsRequest = Schema.is(VcsRequest);
const isWriteFileRequest = Schema.is(WriteFileRequest);
const isCommitRequest = Schema.is(CommitRequest);
const isFileContents: (value: unknown) => value is FileContents = Schema.is(FileContents);
const isDirectoryListing: (value: unknown) => value is DirectoryListing = Schema.is(DirectoryListing);
const isFileMetadata: (value: unknown) => value is FileMetadata = Schema.is(FileMetadata);
const isVcsRefs: (value: unknown) => value is VcsRefs = Schema.is(VcsRefs);
const isVcsStatus: (value: unknown) => value is VcsStatus = Schema.is(VcsStatus);
const isWriteFileReceipt: (value: unknown) => value is WriteFileReceipt = Schema.is(WriteFileReceipt);
const isCreatedCommit = Schema.is(Schema.Struct({commit: Schema.Struct({status: Schema.Literal("created"), commitSha: Schema.String})}));

const uncertain: CommitOutcome = {status: "uncertain"};

export const makeFiles = (native: NativeEnvelope["Service"], endpoints: FileEndpoints): T3FilesFamily => {
  // one unary request under a credential; its failure is classified for that credential's scope
  const rpc = (endpoint: NativeEndpoint, scope: FileScope) =>
    (operation: T3Operation, tag: string, payload: Readonly<Record<string, unknown>>, cancel: Deferred.Deferred<void> | undefined): Effect.Effect<unknown, T3FileError> =>
      native.call(fileCall(endpoint, {request: {id: "definitions", tag, payload}, cancel,
        onExit: (exit: NativeExit) => exit._tag === "Success" ? Effect.succeed(NativeStep.done(exit.value))
          : Effect.fail(new T3FileError({operation, code: exit._tag === "Malformed" ? "unavailable" : failure(exit.exit), scope})),
      }, "10 seconds")).pipe(Effect.catchTag("NativeEnvelopeError", () => Effect.fail(new T3FileError({operation, code: "unavailable", scope}))));
  // a reply that is not the operation's result is unavailable, as the file clients reported it
  const unavailable = (operation: T3Operation, scope: FileScope) => new T3FileError({operation, code: "unavailable", scope});
  const listEntries = (call: ReturnType<typeof rpc>, scope: FileScope) =>
    (request: ListEntriesRequest, cancel?: Deferred.Deferred<void>): Effect.Effect<DirectoryListing, T3FileError | T3InvalidInput> => {
      if (!isListEntriesRequest(request) || !listablePath(request.directoryPath)) return Effect.fail(new T3InvalidInput({operation: "files/listEntries"}));
      return Effect.flatMap(call("files/listEntries", "projects.listEntries", {cwd: request.cwd, directoryPath: request.directoryPath}, cancel),
        (value) => isDirectoryListing(value) ? Effect.succeed(value) : Effect.fail(unavailable("files/listEntries", scope)));
    };

  const readRpc = rpc(endpoints.read, "read");
  const read: T3FileReads = {
    readFile: (request, cancel) => {
      if (!isReadFileRequest(request) || !readablePath(request.relativePath)) return Effect.fail(new T3InvalidInput({operation: "files/readFile"}));
      return Effect.flatMap(readRpc("files/readFile", "projects.readFile", {cwd: request.cwd, relativePath: request.relativePath}, cancel),
        (value) => isFileContents(value) ? Effect.succeed(value) : Effect.fail(unavailable("files/readFile", "read")));
    },
    listEntries: listEntries(readRpc, "read"),
    metadata: (request, cancel) => {
      if (!isMetadataRequest(request)) return Effect.fail(new T3InvalidInput({operation: "files/metadata"}));
      return Effect.flatMap(readRpc("files/metadata", "filesystem.getMetadata", {paths: [...request.paths]}, cancel),
        (value) => isFileMetadata(value) ? Effect.succeed(value) : Effect.fail(unavailable("files/metadata", "read")));
    },
    vcsRefs: (request, cancel) => {
      if (!isVcsRequest(request)) return Effect.fail(new T3InvalidInput({operation: "files/vcsRefs"}));
      return Effect.flatMap(readRpc("files/vcsRefs", "vcs.listRefs", {cwd: request.cwd, refKind: "all", limit: 200}, cancel),
        (value) => isVcsRefs(value) ? Effect.succeed(value) : Effect.fail(unavailable("files/vcsRefs", "read")));
    },
    // the first snapshot or local update of a status subscription, never acknowledged; an Exit before it is a failure
    vcsStatus: (request, cancel) => {
      const operation = "files/vcsStatus" as const;
      if (!isVcsRequest(request)) return Effect.fail(new T3InvalidInput({operation}));
      return Effect.flatMap(native.call(fileCall(endpoints.read, {
        request: {id: "definition-vcs-snapshot", tag: "subscribeVcsStatus", payload: {cwd: request.cwd, includeRemote: false}}, cancel,
        onChunk: (values: ReadonlyArray<unknown>) => {
          const event = values.find(value => record(value) && (value._tag === "snapshot" || value._tag === "localUpdated" || value.type === "snapshot" || value.type === "localUpdated"));
          return Effect.succeed(record(event) && record(event.local) ? NativeStep.done<unknown>(event.local) : NativeStep.continue);
        },
        onExit: (exit: NativeExit) => Effect.fail(new T3FileError({operation, code: exit._tag === "Failure" ? failure(exit.exit) : "unavailable", scope: "read"})),
      }, "10 seconds")).pipe(Effect.catchTag("NativeEnvelopeError", () => Effect.fail(unavailable(operation, "read")))),
      (value) => isVcsStatus(value) ? Effect.succeed(value) : Effect.fail(unavailable(operation, "read")));
    },
  };

  const writes = (endpoint: NativeEndpoint): T3FileWrites => {
    const writeRpc = rpc(endpoint, "write");
    return {
      listEntries: listEntries(writeRpc, "write"),
      // the echoed path must be the written one
      writeFile: (request, cancel) => {
        if (!isWriteFileRequest(request) || !supervisorPath(request.relativePath)) return Effect.fail(new T3InvalidInput({operation: "files/writeFile"}));
        return Effect.flatMap(writeRpc("files/writeFile", "projects.writeFile",
          {cwd: request.cwd, relativePath: request.relativePath, contents: request.contents}, cancel),
        (value) => isWriteFileReceipt(value) && value.relativePath === request.relativePath ? Effect.succeed(value)
          : Effect.fail(unavailable("files/writeFile", "write")));
      },
    };
  };

  // committed only for a finished action that created a commit; an already cancelled commit connects nothing, and once a socket
  // exists every unconfirmed end is uncertain. Every chunk of the action is acknowledged once its events were taken in
  const commits = (endpoint: NativeEndpoint): T3FileCommits => ({
    commit: (request, cancel) => Effect.gen(function* () {
      const operation = "files/commit" as const;
      if (!isCommitRequest(request) || request.filePaths.length === 0 || !request.filePaths.every(supervisorPath)) return yield* new T3InvalidInput({operation});
      if (cancel !== undefined && (yield* Deferred.isDone(cancel))) return yield* new T3FileError({operation, code: "unavailable", scope: "write"});
      const payload = {actionId: request.actionId, cwd: request.cwd, action: "commit", commitMessage: request.message, filePaths: [...request.filePaths]};
      let actionResult: unknown;
      let actionFailed = false;
      let actionFinished = false;
      return yield* native.call(fileCall(endpoint, {request: {id: "definition-setup-commit", tag: "git.runStackedAction", payload}, cancel,
        onChunk: (values: ReadonlyArray<unknown>) => Effect.sync(() => {
          for (const event of values) {
            if (!record(event)) return NativeStep.done(uncertain);
            if (event.actionId !== payload.actionId) continue;
            if (event.kind === "action_failed") actionFailed = true;
            if (event.kind === "action_finished") {actionFinished = true;actionResult = event.result;}
          }
          return NativeStep.ack();
        }),
        onExit: (exit: NativeExit) => {
          if (exit._tag === "Failure") {
            if (failure(exit.exit) === "permission_required") return Effect.fail(new T3FileError({operation, code: "permission_required", scope: "write"}));
            return actionFinished || actionFailed ? Effect.succeed(NativeStep.done(uncertain)) : Effect.fail(new T3FileError({operation, code: "unavailable", scope: "write"}));
          }
          if (exit._tag !== "Success") return Effect.succeed(NativeStep.done(uncertain));
          if (actionFailed || !actionFinished || !isCreatedCommit(actionResult)) return Effect.fail(new T3FileError({operation, code: "unavailable", scope: "write"}));
          return Effect.succeed(NativeStep.done<CommitOutcome>({status: "committed", commitSha: actionResult.commit.commitSha}));
        },
      }, "30 seconds")).pipe(Effect.catchTag("NativeEnvelopeError", () => Effect.succeed(uncertain)));
    }),
  });

  return {
    read,
    write: endpoints.projectWrite === undefined ? null : writes(endpoints.projectWrite),
    commit: endpoints.commit === undefined ? null : commits(endpoints.commit),
  };
};
