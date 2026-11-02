import { Context, Data, Deferred, Effect, Layer, Schema } from "effect";
import { posix } from "node:path";
import type {
  CommitOutcome, DirectoryListing, FileContents, FileFailure, FileScope, T3FileCommits, T3FileError, T3FileReads, T3FileWrites, T3InvalidInput, VcsRefs,
} from "./t3-native/index.js";

export type { CommitOutcome, FileFailure, FileScope };
export type GitOperationState = {status: "safe"} | {status: "in_progress"; marker: string} | {status: "unavailable"; message: string};
export interface FreshGitInfo {
  workspaceRoot: string;
  branch: string | null;
  isRepo: boolean;
  changedPaths: string[];
  operationState: GitOperationState;
}

const fileErrorMessage = (code: FileFailure, scope: FileScope): string => code === "permission_required"
  ? `Enable filesystem:${scope} on the Supervisor ${scope} credential through deployment setup.`
  : code === "missing" ? "The requested project path does not exist."
    : code === "invalid_file" ? "Definitions must be readable UTF-8 text files, not binary files or directories."
      : "T3 project file access is unavailable.";

// a native file failure with its fixed message per code and credential scope; the positional constructor is the baseline call shape
export class ProjectFileError extends Data.TaggedError("ProjectFileError")<{readonly code: FileFailure; readonly scope: FileScope}> {
  constructor(code: FileFailure, scope: FileScope = "read") {
    super({code, scope});
  }
  override readonly message: string = fileErrorMessage(this.code, this.scope);
}

// a T3Native file failure keeps its classification and credential scope; an input T3Native refuses before connecting is the local refusal it replaces
const projectFileError = (scope: FileScope) => (error: T3FileError | T3InvalidInput): ProjectFileError =>
  error._tag === "T3FileError" ? new ProjectFileError(error.code, error.scope) : new ProjectFileError("unavailable", scope);

/**
 * The listing the file client accepts: files and directories only. The client returns the native value itself, so revisions hash
 * exactly what T3 returned.
 */
const Entry = Schema.Struct({path: Schema.String, kind: Schema.Literals(["file", "directory"])});
export const ListEntries = Schema.Struct({truncated: Schema.Boolean, entries: Schema.Array(Entry)});
export type ListEntries = typeof ListEntries.Type;
// a file's text as T3 read it, the native value itself
export type ReadFileResult = FileContents;
export type VcsInfo = {isRepo: boolean; branch: string | null; changedPaths?: string[]; refs?: VcsRefs["refs"]};
const isListEntries = Schema.is(ListEntries);
const record = Schema.is(Schema.Record(Schema.String, Schema.Unknown));
const validPath = (path: string): boolean => path.startsWith(".t3-supervisor/") && !path.includes("\\") && !path.includes("\0") &&
  path.split("/").every(part => part !== ".." && part !== "." && part.length > 0);

const unavailable = (message: string): GitOperationState => ({status: "unavailable", message});

const makeProjectFiles = (reads: T3FileReads): ProjectFiles["Service"] => {
  const readError = projectFileError("read");
  // T3Native refuses a path over 512 characters or with a NUL or a backslash before connecting
  const readNativeFile = (root: string, path: string, cancel: Deferred.Deferred<void> | undefined): Effect.Effect<ReadFileResult, ProjectFileError> =>
    Effect.mapError(reads.readFile({cwd: root, relativePath: path}, cancel), readError);
  // one metadata entry per requested path; an entry that is not a record describes no file
  const metadataOf = (path: string, cancel: Deferred.Deferred<void> | undefined) => Effect.mapError(reads.metadata({paths: [path]}, cancel), readError);
  const gitOperationState = (root: string, cancel?: Deferred.Deferred<void>): Effect.Effect<GitOperationState, ProjectFileError> => Effect.gen(function* () {
    if (!posix.isAbsolute(root)) return unavailable("T3 requires an absolute checkout path to inspect Git state.");
    const metadataPath = posix.join(root, ".git");
    if (metadataPath.length > 512) return unavailable("The checkout path is too long to inspect Git state safely.");
    const metadata = yield* metadataOf(metadataPath, cancel);
    const entry = metadata.entries.length === 1 ? metadata.entries[0] : undefined;
    const kind = record(entry) ? entry.kind : undefined;
    if (kind !== "directory" && kind !== "file") return unavailable("T3 could not identify this checkout's Git metadata directory.");
    let readGitFile: (path: string) => Effect.Effect<ReadFileResult, ProjectFileError>;
    if (kind === "directory") readGitFile = path => readNativeFile(root, `.git/${path}`, cancel);
    else {
      const read = yield* Effect.result(readNativeFile(root, ".git", cancel));
      if (read._tag === "Failure") return unavailable("T3 could not read this checkout's Git directory pointer.");
      const pointer = read.success;
      if (pointer.truncated || pointer.byteLength > 4096) return unavailable("This checkout's Git directory pointer is incomplete.");
      const match = /^gitdir:[ \t]*(.+?)[ \t]*\r?\n?$/.exec(pointer.contents);
      if (!match || !match[1] || match[1].includes("\0") || match[1].includes("\\")) return unavailable("This checkout has an unsupported Git directory pointer.");
      const gitDirectory = posix.isAbsolute(match[1]) ? posix.normalize(match[1]) : posix.resolve(root, match[1]);
      if (!posix.isAbsolute(gitDirectory) || gitDirectory.length > 512) return unavailable("This checkout's Git directory path is invalid or too long.");
      const gitDirectoryMetadata = yield* metadataOf(gitDirectory, cancel);
      const gitDirectoryEntry = gitDirectoryMetadata.entries.length === 1 ? gitDirectoryMetadata.entries[0] : undefined;
      if (!record(gitDirectoryEntry) || gitDirectoryEntry.kind !== "directory") return unavailable("T3 could not verify this checkout's Git metadata directory.");
      // linked worktrees store private metadata outside the checkout; inspect only fixed filenames read from the native pointer.
      readGitFile = path => readNativeFile(root, posix.join(gitDirectory, path), cancel);
    }
    const head = yield* Effect.result(readGitFile("HEAD"));
    if (head._tag === "Failure" || head.success.truncated || head.success.byteLength > 4096) return unavailable("T3 could not verify the checkout's Git HEAD file.");
    const operationFiles = ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "REBASE_HEAD", "BISECT_LOG", "BISECT_START", "SQUASH_MSG", "AUTO_MERGE", "index.lock", "HEAD.lock", "packed-refs.lock", "config.lock"];
    const operationDirectories = ["rebase-merge", "rebase-apply", "sequencer"];
    for (const marker of operationFiles) {
      const found = yield* Effect.result(readGitFile(marker));
      if (found._tag === "Success") return {status: "in_progress", marker};
      if (found.failure.code !== "missing") return unavailable("T3 could not verify the checkout's Git operation state.");
    }
    for (const marker of operationDirectories) {
      const found = yield* Effect.result(readGitFile(marker));
      if (found._tag === "Success" || found.failure.code === "invalid_file") return {status: "in_progress", marker};
      if (found.failure.code !== "missing") return unavailable("T3 could not verify the checkout's Git operation state.");
    }
    return {status: "safe"};
  });
  return ProjectFiles.of({
    directoryExists: (root, cancel) => Effect.gen(function* () {
      const value = yield* metadataOf(root, cancel);
      if (value.entries.length !== 1) return yield* new ProjectFileError("unavailable");
      const entry = value.entries[0];
      return record(entry) && entry.kind === "directory";
    }),
    list: (root, path, cancel) => Effect.gen(function* () {
      if (path !== "" && path !== ".t3-supervisor" && !validPath(path)) return yield* new ProjectFileError("unavailable");
      const value = yield* Effect.mapError(reads.listEntries({cwd: root, directoryPath: path}, cancel), readError);
      if (!isListEntries(value) || value.entries.length > 512) return yield* new ProjectFileError("unavailable");
      return value;
    }),
    read: (root, path, cancel) => validPath(path) ? readNativeFile(root, path, cancel) : Effect.fail(new ProjectFileError("unavailable")),
    vcsInfo: (root, cancel) => Effect.gen(function* () {
      const refs = yield* Effect.mapError(reads.vcsRefs({cwd: root}, cancel), readError);
      const current = refs.refs.filter(ref => ref.current === true && !ref.isRemote);
      if (current.length > 1) return yield* new ProjectFileError("unavailable");
      if (!refs.isRepo) return {isRepo: false, branch: null, changedPaths: []};
      const status = yield* Effect.mapError(reads.vcsStatus({cwd: root}, cancel), readError);
      return {isRepo: true, branch: current[0] ? String(current[0].name) : null, refs: refs.refs, changedPaths: status.workingTree.files.map(entry => String(entry.path))};
    }),
    gitOperationState,
  });
};

/** Uses native T3 read RPCs; it never reads project content from the container filesystem. */
export class ProjectFiles extends Context.Service<ProjectFiles, {
  // each call is one native request with a 10 s deadline; a completed cancel ends it, before connecting when already completed, as unavailable
  readonly directoryExists: (root: string, cancel?: Deferred.Deferred<void>) => Effect.Effect<boolean, ProjectFileError>;
  readonly list: (root: string, path: string, cancel?: Deferred.Deferred<void>) => Effect.Effect<ListEntries, ProjectFileError>;
  readonly read: (root: string, path: string, cancel?: Deferred.Deferred<void>) => Effect.Effect<ReadFileResult, ProjectFileError>;
  readonly vcsInfo?: ((root: string, cancel?: Deferred.Deferred<void>) => Effect.Effect<VcsInfo, ProjectFileError>) | undefined;
  readonly gitOperationState?: ((root: string, cancel?: Deferred.Deferred<void>) => Effect.Effect<GitOperationState, ProjectFileError>) | undefined;
}>()("t3-supervisor/ProjectFiles") {
  // over the run's T3Native file reads (the read credential)
  static readonly make = (reads: T3FileReads): Effect.Effect<ProjectFiles["Service"]> => Effect.sync(() => makeProjectFiles(reads));
  static readonly layer = (reads: T3FileReads): Layer.Layer<ProjectFiles> => Layer.effect(ProjectFiles, ProjectFiles.make(reads));
}

const makeProjectWriter = (writes: T3FileWrites): ProjectWriter["Service"] => {
  const writeError = projectFileError("write");
  // T3Native writes only fixed .t3-supervisor paths, before connecting, and requires the echoed path to be the written one
  const writeFile = (root: string, path: string, contents: string, cancel?: Deferred.Deferred<void>): Effect.Effect<void, ProjectFileError> =>
    Effect.asVoid(Effect.mapError(writes.writeFile({cwd: root, relativePath: path, contents}, cancel), writeError));
  const includes = (listing: DirectoryListing, path: string, kind: string) => listing.truncated === false &&
    listing.entries.some(entry => entry.path === path && entry.kind === kind);
  return ProjectWriter.of({
    checkProjectConfigFile: (root, cancel) => Effect.gen(function* () {
      const list = (directoryPath: string) => Effect.mapError(writes.listEntries({cwd: root, directoryPath}, cancel), writeError);
      if (!includes(yield* list(""), ".t3-supervisor", "directory")) return false;
      return includes(yield* list(".t3-supervisor"), ".t3-supervisor/project.yaml", "file");
    }),
    writeProjectConfig: (root, contents, cancel) => writeFile(root, ".t3-supervisor/project.yaml", contents, cancel),
    writeFile,
  });
};

// writes only fixed .t3-supervisor paths through the native filesystem:write credential and verifies the echoed path
export class ProjectWriter extends Context.Service<ProjectWriter, {
  // whether .t3-supervisor is a directory holding a regular project.yaml, both from complete listings
  readonly checkProjectConfigFile: (root: string, cancel?: Deferred.Deferred<void>) => Effect.Effect<boolean, ProjectFileError>;
  readonly writeProjectConfig: (root: string, contents: string, cancel?: Deferred.Deferred<void>) => Effect.Effect<void, ProjectFileError>;
  readonly writeFile: (root: string, path: string, contents: string, cancel?: Deferred.Deferred<void>) => Effect.Effect<void, ProjectFileError>;
}>()("t3-supervisor/ProjectWriter") {
  // over the run's T3Native file writes (the project-write credential)
  static readonly make = (writes: T3FileWrites): Effect.Effect<ProjectWriter["Service"]> => Effect.sync(() => makeProjectWriter(writes));
  static readonly layer = (writes: T3FileWrites): Layer.Layer<ProjectWriter> => Layer.effect(ProjectWriter, ProjectWriter.make(writes));
}

const makeProjectCommitter = (commits: T3FileCommits): ProjectCommitter["Service"] => ProjectCommitter.of({
  // T3Native refuses an empty or non-Supervisor path list before connecting, and an already cancelled commit connects nothing
  commitFiles: (root, paths, message, actionId, cancel) =>
    Effect.mapError(commits.commit({cwd: root, filePaths: paths, message, actionId}, cancel), projectFileError("write")),
});

// commits fixed setup paths through git.runStackedAction under the caller's deterministic action id; it never retries
export class ProjectCommitter extends Context.Service<ProjectCommitter, {
  // committed only for a finished action that created a commit; a lost connection, cancel or 30 s deadline after connecting is uncertain
  readonly commitFiles: (root: string, paths: readonly string[], message: string, actionId: string, cancel?: Deferred.Deferred<void>) =>
    Effect.Effect<CommitOutcome, ProjectFileError>;
}>()("t3-supervisor/ProjectCommitter") {
  // over the run's T3Native commit (the commit credential)
  static readonly make = (commits: T3FileCommits): Effect.Effect<ProjectCommitter["Service"]> => Effect.sync(() => makeProjectCommitter(commits));
  static readonly layer = (commits: T3FileCommits): Layer.Layer<ProjectCommitter> => Layer.effect(ProjectCommitter, ProjectCommitter.make(commits));
}
