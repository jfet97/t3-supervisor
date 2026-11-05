import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker as WorkerThread } from "node:worker_threads";
import { NodeWorker } from "@effect/platform-node";
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import { Context, Data, Deferred, Effect, Exit, FileSystem, Layer, Option, type PlatformError as Platform, Schema, type Scope, Semaphore, Stream } from "effect";
import { Reactivity } from "effect/reactivity";
import { SqlClient, Statement } from "effect/sql";
import type { Connection } from "effect/sql/SqlConnection";
import { SqlError, UnknownError } from "effect/sql/SqlError";
import * as Worker from "effect/workers/Worker";
import { BackupMetadata, connectionLost, sqlErrorOf, type StatementOperation, type WorkerDatabaseConfig, WorkerReply, type WorkerRequest } from "./db-worker-protocol.js";

type PlatformError = Platform.PlatformError;

// one client per database file, each behind its own named service, so a generic SqlClient never shadows another
// file's client; only this module opens SQLite clients (lint rule), and each client's connection runs in its own worker
// thread (src/db-worker-serve.ts), so synchronous statements and busy waits never block the main event loop

/** catalog.sqlite3, process lifetime (S3). */
export class CatalogDb extends Context.Service<CatalogDb, SqlClient.SqlClient>()("t3-supervisor/CatalogDb") {}
/** guidance.sqlite3 with the excluded-chat policy, one client per supervision run; activated with the S6d engine switch only. */
export class GuidanceDb extends Context.Service<GuidanceDb, SqlClient.SqlClient>()("t3-supervisor/GuidanceDb") {}
/** access/login.sqlite3, dashboard server lifetime or one forge operation; activated in S6c only. */
export class AccessDb extends Context.Service<AccessDb, SqlClient.SqlClient>()("t3-supervisor/AccessDb") {}

/**
 * The current format of each database file, stored as its SQLite user_version and independent of release numbers and
 * channels. Supervisor 0.0.27 and earlier never wrote it, so their files are format 0. Only the startup upgrade
 * (src/database-upgrade.ts) creates files or moves them between formats; every other open refuses a file whose format is
 * not the current one, before any journal-mode change, write-affecting pragma or store code.
 */
export const DatabaseFormats = { catalog: 1, guidance: 2, access: 1 } as const;

/** Why a database could not be opened: the file is missing, older or newer than this version, or failed to open. */
export type DatabaseOpenFailure = "open_failed" | "not_initialized" | "upgrade_required" | "unsupported_format";

export class DatabaseOpenError extends Data.TaggedError("DatabaseOpenError")<{
  readonly file: string;
  readonly reason: DatabaseOpenFailure;
  /** the stored format of a file that is not at the current one */
  readonly found?: number | undefined;
  readonly expected?: number | undefined;
  readonly cause?: unknown;
}> {
  override get message(): string {
    switch (this.reason) {
      case "not_initialized": return `${this.file} does not exist yet; start the service once (t3-supervisor start) to create it`;
      case "upgrade_required": return `${this.file} has format ${this.found}; start the service once (t3-supervisor start) to upgrade it to format ${this.expected}`;
      case "unsupported_format": return `${this.file} has format ${this.found}, newer than format ${this.expected} that this Supervisor supports; install a newer Supervisor`;
      case "open_failed": return `${this.file} could not be opened`;
    }
  }
}

const maxCatalogPages = 16_384;

/** One store file of a data directory: its name, journal mode, current format and connection pragmas. */
export interface DatabaseFile {
  readonly file: string;
  readonly journal: "wal" | "delete";
  readonly format: number;
  /** connection settings applied in order once the format check passed (busy_timeout is set by the client itself) */
  readonly pragmas: ReadonlyArray<string>;
}

/** The store files of a data directory that the startup upgrade prepares; access/login.sqlite3 stays with the auth service. */
export const DatabaseFiles = {
  catalog: {file: "catalog.sqlite3", journal: "wal", format: DatabaseFormats.catalog,
    pragmas: ["synchronous=FULL", "foreign_keys=ON", "wal_autocheckpoint=256", "secure_delete=ON", `max_page_count=${maxCatalogPages}`]},
  guidance: {file: "guidance.sqlite3", journal: "wal", format: DatabaseFormats.guidance, pragmas: ["synchronous=FULL", "secure_delete=ON", "max_page_count=16384"]},
} as const satisfies Record<string, DatabaseFile>;
export type DatabaseKind = keyof typeof DatabaseFiles;

const accessPragmas = ["synchronous=FULL", "max_page_count=256"] as const;

const sidecars = (path: string): ReadonlyArray<string> => [path, `${path}-wal`, `${path}-shm`];

// a sidecar may disappear between the check and the change (sqlite removes -wal/-shm on the last close)
const ignoreMissing = <R>(effect: Effect.Effect<void, PlatformError, R>): Effect.Effect<void, PlatformError, R> =>
  Effect.catch(effect, (error) => error.reason._tag === "NotFound" ? Effect.void : Effect.fail(error));

/** Restores 0600 on a database file and its -wal/-shm sidecars (after commits and on close, as the baseline store does). */
export const securePrivateFiles = (path: string): Effect.Effect<void, PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    for (const file of sidecars(path)) if (yield* fs.exists(file)) yield* fs.chmod(file, 0o600).pipe(ignoreMissing);
  });

// the directory and a new, empty file made private before a client opens them, so the sidecars SQLite creates are private too
const preparePrivateFile = (directory: string, path: string): Effect.Effect<void, PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
    yield* fs.chmod(directory, 0o700);
    // created empty with 0600 and closed again; an existing file is not opened, so its bytes and times stay as they are
    if (!(yield* fs.exists(path))) yield* Effect.scoped(fs.open(path, { flag: "a", mode: 0o600 }));
    yield* fs.chmod(path, 0o600);
  });

/**
 * Runs database work with tracing disabled. effect/sql opens a span per statement and per transaction carrying the
 * query text and the transaction exit, neither of which is a sanitized telemetry field (plan 3.10, CT-REDACT-01);
 * every service built on these clients wraps its operations with it.
 */
export const untracedSql: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R> = Effect.withTracerEnabled(false);

/** The script a database worker thread runs, with the node options and data it starts with. */
export interface DatabaseWorkerEntry {
  readonly url: URL;
  readonly execArgv: Array<string> | undefined;
  readonly workerData?: unknown;
}

/**
 * The worker entry every database client starts: the one beside this module, the built file in dist or the source file
 * through tsx when running from source (the loader is resolved from this module, since a bare specifier in execArgv
 * resolves from the working directory). Only tests provide another entry, one that serves through `serveDatabase`.
 */
export const DatabaseWorker = Context.Reference<DatabaseWorkerEntry>("t3-supervisor/DatabaseWorker", {
  defaultValue: () => import.meta.url.endsWith(".ts")
    ? {url: new URL("./db-worker.ts", import.meta.url), execArgv: ["--import", import.meta.resolve("tsx")]}
    : {url: new URL("./db-worker.js", import.meta.url), execArgv: undefined},
});

const decodeReply = Schema.decodeUnknownExit(WorkerReply);
const decodeBackup = Schema.decodeUnknownEffect(BackupMetadata);

type WorkerConnection = Connection & {readonly isTransaction: () => boolean};

/** A worker client with the connection's online backup, which only the startup upgrade uses. */
interface WorkerClient {
  readonly client: SqlClient.SqlClient;
  /**
   * Copies the committed database into `destination` with SQLite's online backup API, on the worker's own connection: the
   * client's lease is held for the call, so no other fiber's statement or transaction interleaves, and a call made inside a
   * transaction fails at once rather than waiting for its own lease or copying uncommitted pages.
   */
  readonly backup: (destination: string) => Effect.Effect<BackupMetadata, SqlError>;
}

/*
 * an open's admission: the worker reads the stored format of `filename` through a read-only connection of its own, closed
 * again before the reply, and the open only proceeds at `expected`; a refused file is never opened by a connection that can
 * write, which would recover and checkpoint a log on close
 */
interface Admission {
  readonly filename: string;
  readonly file: string;
  readonly expected: number;
}

/**
 * One SQLite client whose single connection lives in a dedicated worker thread. The client itself is the stock one that
 * `@effect/sql-sqlite-node` builds in-process (one leased connection behind a semaphore, BEGIN IMMEDIATE, savepoints and
 * the failed-COMMIT cleanup), so transactions, savepoints and cross-service atomicity stay with the caller's fibers and only
 * the statements cross the thread boundary.
 *
 * A statement, once sent, is awaited uninterruptibly: the caller's lease is held until the worker answers, because the
 * synchronous statement cannot be stopped and may still take effect. The worker is never replaced: if it exits, errors,
 * breaks the protocol or cannot be reached, the client is poisoned for good, every waiting statement fails with an unknown
 * outcome and every later one fails without being sent, so nothing is replayed and no transaction continues on another
 * connection. The worker is stopped at once, which closes its connection: SQLite rolls back what it left uncommitted and
 * the file's lock is released without waiting for the client to close. From then on the client has no transaction, so the
 * stock rollback after the failure sends nothing and the caller sees the unknown outcome as a typed `SqlError`. A new
 * client (a rebuilt layer) opens a new worker. A backup request travels the same way and has the same outcomes.
 */
const workerClient = (config: WorkerDatabaseConfig, admission?: Admission): Effect.Effect<WorkerClient, SqlError | DatabaseOpenError, Scope.Scope> => Effect.gen(function* () {
  const entry = yield* DatabaseWorker;
  let thread: WorkerThread | undefined;
  const spawn = () => thread = new WorkerThread(entry.url, {...(entry.execArgv ? {execArgv: entry.execArgv} : {}), ...(entry.workerData === undefined ? {} : {workerData: entry.workerData})});
  const worker = yield* Effect.flatMap(Worker.WorkerPlatform, (platform) => platform.spawn<unknown, WorkerRequest>(0)).pipe(
    Effect.provideService(Worker.Spawner, spawn), Effect.provide(NodeWorker.layerPlatform), Effect.orDie);
  const pending = new Map<number, Deferred.Deferred<unknown, SqlError>>();
  let fault: SqlError | undefined;
  let inTransaction = false;
  let sequence = 0;
  const poison = (error: SqlError) => {
    fault ??= error;
    for (const done of pending.values()) Deferred.doneUnsafe(done, Exit.fail(fault));
    pending.clear();
  };
  // a fault: poisoned, and the worker stopped so that its connection closes now
  const abandon = (error: SqlError) => Effect.andThen(Effect.sync(() => poison(error)),
    Effect.promise(() => thread?.terminate() ?? Promise.resolve(0)));
  const settle = (message: unknown) => Effect.suspend(() => {
    const decoded = decodeReply(message);
    if (Exit.isFailure(decoded)) return abandon(connectionLost("The database worker sent a malformed reply"));
    const reply = decoded.value;
    const done = pending.get(reply.id);
    if (done === undefined) return abandon(connectionLost("The database worker answered a request it was not sent"));
    pending.delete(reply.id);
    inTransaction = reply.inTransaction;
    Deferred.doneUnsafe(done, reply.ok ? Exit.succeed(reply.value) : Exit.fail(sqlErrorOf(reply.failure)));
    return Effect.void;
  });
  yield* worker.run(settle).pipe(
    Effect.catchCause(() => abandon(connectionLost("The database worker stopped; a statement in flight has an unknown outcome"))),
    Effect.forkScoped);
  // runs before the worker is closed: nothing is sent once teardown begins, and a waiting statement fails as unknown
  yield* Effect.addFinalizer(() => Effect.sync(() => poison(connectionLost("The database client is closed"))));

  const call = (request: WorkerRequest): Effect.Effect<unknown, SqlError> => Effect.uninterruptible(Effect.suspend(() => {
    if (fault) return Effect.fail(fault);
    const done = Deferred.makeUnsafe<unknown, SqlError>();
    pending.set(request.id, done);
    return worker.send(request).pipe(
      Effect.catchCause(() => abandon(connectionLost("The database worker could not be reached"))),
      Effect.andThen(Deferred.await(done)));
  }));
  const statement = (op: StatementOperation, sql: string, params: ReadonlyArray<unknown>) =>
    Effect.flatMap(SqlClient.SafeIntegers, (safeIntegers) => call({id: ++sequence, op, sql, params, safeIntegers}));
  // rows are the driver's opaque values, carried by structured cloning
  const rows = (op: StatementOperation, sql: string, params: ReadonlyArray<unknown>) =>
    Effect.map(statement(op, sql, params), (value) => value as ReadonlyArray<object>);
  const connection: WorkerConnection = {
    isTransaction: () => fault === undefined && inTransaction,
    execute: (sql, params, transformRows) => Effect.map(rows("execute", sql, params), (all) => transformRows ? transformRows(all) : all),
    executeRaw: (sql, params) => statement("executeRaw", sql, params),
    executeValues: (sql, params) => Effect.map(rows("executeValues", sql, params), (all) => all as ReadonlyArray<ReadonlyArray<unknown>>),
    executeValuesUnprepared: (sql, params) => Effect.map(rows("executeValuesUnprepared", sql, params), (all) => all as ReadonlyArray<ReadonlyArray<unknown>>),
    executeUnprepared: (sql, params, transformRows) => Effect.map(rows("executeUnprepared", sql, params), (all) => transformRows ? transformRows(all) : all),
    executeStream: () => Stream.die("executeStream not implemented"),
  };
  if (admission !== undefined) yield* call({id: ++sequence, op: "format", filename: admission.filename, busyTimeoutMs: config.busyTimeoutMs}).pipe(
    Effect.flatMap(decodeUserVersion),
    Effect.mapError((cause) => new DatabaseOpenError({file: admission.file, reason: "open_failed", cause})),
    Effect.flatMap(([row]) => formatCheck(admission.file, admission.expected, row.user_version)));
  yield* call({id: ++sequence, op: "open", config});

  const { acquirer, borrower, isTransaction, onCommitFailure, transactionAcquirer } = SqlClient.makeSqliteAcquirers({
    connection: Effect.succeed(connection),
    semaphore: yield* Semaphore.make(1),
    isTransaction: (conn) => conn.isTransaction(),
  });
  const client = yield* SqlClient.make({
    driver: "sqlite-node-worker",
    acquirer,
    borrower,
    compiler: Statement.makeCompilerSqlite(),
    transactionAcquirer,
    onCommitFailure,
    isTransaction,
    releaseSavepoint: (name) => `RELEASE SAVEPOINT ${name}`,
    beginTransaction: config.readonly ? "BEGIN" : "BEGIN IMMEDIATE",
    spanAttributes: [["db.system.name", "sqlite"]],
  }).pipe(Effect.provide(Reactivity.layer));
  /*
   * inside a transaction of this client the caller already holds the lease it would wait for; any other fiber's transaction
   * only delays the backup until it ends
   */
  const backup = (destination: string): Effect.Effect<BackupMetadata, SqlError> => Effect.flatMap(Effect.serviceOption(client.transactionService),
    (transaction) => Option.isSome(transaction)
      ? Effect.fail(insideTransaction)
      : Effect.scoped(Effect.andThen(client.reserve, call({id: ++sequence, op: "backup", destination}))).pipe(
        Effect.flatMap((value) => decodeBackup(value).pipe(Effect.mapError(() => malformedBackup)))));
  return {client, backup};
});

const insideTransaction = new SqlError({reason: new UnknownError({cause: "backup_in_transaction", message: "A backup cannot run inside a transaction", operation: "backup"})});
const malformedBackup = new SqlError({reason: new UnknownError({cause: "backup_report", message: "The database worker reported a malformed backup", operation: "backup"})});

/*
 * a format counts up from 0 and is stored in SQLite's signed 32-bit user_version, so a stored format is an integer from 0 to
 * 2^31 - 1; a negative value is no format of any Supervisor
 */
const StoredFormat = Schema.Int.check(Schema.isBetween({minimum: 0, maximum: 2_147_483_647}));
const UserVersion = Schema.Tuple([Schema.Struct({user_version: StoredFormat})]);
const decodeUserVersion = Schema.decodeUnknownEffect(UserVersion);

/**
 * The file's stored format (its SQLite user_version), read through the client's connection, a committed WAL included. The
 * pragma is read as a plain number whatever integer mode the caller runs in (a backup snapshot reads its rows as exact
 * bigints), so every caller decodes, compares and records the same number.
 */
export const readFormat = (sql: SqlClient.SqlClient): Effect.Effect<number, SqlError | Schema.SchemaError> =>
  sql.unsafe("PRAGMA user_version").pipe(
    Effect.provideService(SqlClient.SafeIntegers, false),
    Effect.flatMap(decodeUserVersion),
    Effect.map(([row]) => row.user_version));

// a file at `expected` passes; an older one asks for the service to start once, a newer one is refused
const formatCheck = (file: string, expected: number, found: number): Effect.Effect<void, DatabaseOpenError> => found === expected ? Effect.void
  : Effect.fail(new DatabaseOpenError({file, reason: found < expected ? "upgrade_required" : "unsupported_format", found, expected}));

// the format check of every store open on a connection, before any journal-mode change, pragma or store code
const requireFormat = (sql: SqlClient.SqlClient, file: string, expected: number): Effect.Effect<void, DatabaseOpenError> =>
  readFormat(sql).pipe(
    Effect.mapError((cause) => new DatabaseOpenError({file, reason: "open_failed", cause})),
    Effect.flatMap((found) => formatCheck(file, expected, found)));

/*
 * how a read-only connection reads a file: with a write-ahead log beside it, through the log (a live server keeps one, a killed
 * one leaves one), which a read-only connection never checkpoints or removes; without one every committed row is in the file
 * itself, which is then opened immutable, so no log or shared-memory file is created
 */
const readOnlyFilename = (path: string): string => existsSync(`${path}-wal`) ? path : `${pathToFileURL(path).href}?immutable=1`;

// a refusal keeps its reason; any other failure of an open is open_failed
const openFailure = (file: string) => (cause: unknown): DatabaseOpenError =>
  cause instanceof DatabaseOpenError ? cause : new DatabaseOpenError({ file, reason: "open_failed", cause });

// the directory and an existing file made private before the client opens them, so the sidecars it creates are private too
const secureExisting = (directory: string, path: string): Effect.Effect<void, PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.chmod(directory, 0o700);
    yield* fs.chmod(path, 0o600);
  });

/**
 * A store's client on its file: the file must exist and already have the current format. Nothing is created here; a
 * missing, older or newer file fails with its reason before the journal mode, any pragma or the store touch it.
 */
const openDatabase = (directory: string, options: DatabaseFile): Effect.Effect<SqlClient.SqlClient, DatabaseOpenError, Scope.Scope | FileSystem.FileSystem> => {
  const resolved = resolve(directory);
  const path = join(resolved, options.file);
  const failed = (cause: unknown) => new DatabaseOpenError({ file: options.file, reason: "open_failed", cause });
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    if (!(yield* fs.exists(path).pipe(Effect.mapError(failed))))
      return yield* new DatabaseOpenError({file: options.file, reason: "not_initialized", expected: options.format});
    yield* secureExisting(resolved, path).pipe(Effect.mapError(failed));
    // sidecar modes are restored when the client closes, as the baseline close does; registered before the client,
    // so it runs after the client's own finalizer has closed the connection
    yield* Effect.addFinalizer(() => securePrivateFiles(path).pipe(Effect.provideService(FileSystem.FileSystem, fs), Effect.orDie));
    /*
     * only an admitted file is opened for writing; the client never switches the journal mode on its own, and the format is
     * checked again on its connection first, since the file could have changed in between
     */
    const { client } = yield* workerClient({filename: path, readonly: false, disableWAL: true, busyTimeoutMs: 5_000},
      {filename: readOnlyFilename(path), file: options.file, expected: options.format}).pipe(Effect.mapError(openFailure(options.file)));
    yield* requireFormat(client, options.file, options.format);
    if (options.journal === "wal") yield* client.unsafe("PRAGMA journal_mode=WAL").pipe(Effect.mapError(failed));
    for (const pragma of options.pragmas) yield* client.unsafe(`PRAGMA ${pragma}`).pipe(Effect.mapError(failed));
    yield* securePrivateFiles(path).pipe(Effect.mapError(failed));
    return client;
  }).pipe(untracedSql);
};

/** The catalog file with the baseline pragmas of `store.ts`, at the current catalog format. */
export const catalogDbLayer = (dataDirectory: string): Layer.Layer<CatalogDb, DatabaseOpenError, FileSystem.FileSystem> =>
  Layer.effect(CatalogDb, openDatabase(dataDirectory, DatabaseFiles.catalog));

/** guidance.sqlite3 with the baseline pragmas of `guidance-store.ts`, at the current guidance format. */
export const guidanceDbLayer = (dataDirectory: string): Layer.Layer<GuidanceDb, DatabaseOpenError, FileSystem.FileSystem> =>
  Layer.effect(GuidanceDb, openDatabase(dataDirectory, DatabaseFiles.guidance));

/**
 * The access database (access/login.sqlite3) on a file the caller already validated: DELETE journal, synchronous=FULL,
 * busy_timeout 5000 and max_page_count=256 (plan 3.2), at the current access format, which is checked before the pragmas.
 * It neither creates, secures, upgrades nor bootstraps the file: only the service initializes a missing database through its
 * own temp-file-and-link procedure, only the startup upgrade moves an existing one to the current format, the forge never
 * does either, and service-auth keeps the identity checks before and after the open and the schema validation (a file
 * replaced in between fails that validation, as at baseline). Provide it once per dashboard server lifetime or per forge
 * operation; never two clients in one process.
 */
export const accessDbLayer = (path: string): Layer.Layer<AccessDb, DatabaseOpenError> =>
  Layer.effect(AccessDb, Effect.gen(function* () {
    const failed = (cause: unknown) => new DatabaseOpenError({ file: "login.sqlite3", reason: "open_failed", cause });
    // admitted read only first, then checked again on the connection that can write
    const { client } = yield* workerClient({filename: path, readonly: false, disableWAL: true, busyTimeoutMs: 5_000},
      {filename: readOnlyFilename(path), file: "login.sqlite3", expected: DatabaseFormats.access}).pipe(Effect.mapError(openFailure("login.sqlite3")));
    yield* requireFormat(client, "login.sqlite3", DatabaseFormats.access);
    for (const pragma of accessPragmas) yield* client.unsafe(`PRAGMA ${pragma}`).pipe(Effect.mapError(failed));
    return client;
  }).pipe(untracedSql));

/** An unguarded client for the startup upgrade or the auth bootstrap only, with the connection's online backup. */
export interface UpgradeDatabase {
  readonly sql: SqlClient.SqlClient;
  readonly backup: (destination: string) => Effect.Effect<BackupMetadata, SqlError>;
}

/**
 * The startup upgrade's client on a store file of `dataDirectory`, whatever its format: no format check, no journal-mode
 * change (the upgrade sets it once a file has its format), the file's pragmas. A missing file fails unless `create`, which
 * creates it empty and private (and the directory, 0700). Stores never open their files this way.
 */
export const openUpgradeDatabase = (dataDirectory: string, kind: DatabaseKind, options: { readonly create: boolean }):
  Effect.Effect<UpgradeDatabase, DatabaseOpenError, Scope.Scope | FileSystem.FileSystem> => {
  const spec = DatabaseFiles[kind];
  const directory = resolve(dataDirectory);
  const path = join(directory, spec.file);
  const failed = (cause: unknown) => new DatabaseOpenError({ file: spec.file, reason: "open_failed", cause });
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const exists = yield* fs.exists(path).pipe(Effect.mapError(failed));
    if (!exists && !options.create) return yield* new DatabaseOpenError({file: spec.file, reason: "not_initialized", expected: spec.format});
    yield* (exists ? secureExisting(directory, path) : preparePrivateFile(directory, path)).pipe(Effect.mapError(failed));
    yield* Effect.addFinalizer(() => securePrivateFiles(path).pipe(Effect.provideService(FileSystem.FileSystem, fs), Effect.orDie));
    const { client, backup } = yield* workerClient({filename: path, readonly: false, disableWAL: true, busyTimeoutMs: 5_000}).pipe(Effect.mapError(failed));
    for (const pragma of spec.pragmas) yield* client.unsafe(`PRAGMA ${pragma}`).pipe(Effect.mapError(failed));
    return {sql: client, backup};
  }).pipe(untracedSql);
};

/**
 * An unguarded client on an access database file the auth service already identity-checked: its bootstrap's temporary
 * file, or an existing file the startup upgrade moves to the current format. DELETE journal and the access pragmas; it never
 * creates, secures or validates the file.
 */
export const openAccessUpgradeDatabase = (path: string): Effect.Effect<UpgradeDatabase, DatabaseOpenError, Scope.Scope> =>
  Effect.gen(function* () {
    const failed = (cause: unknown) => new DatabaseOpenError({ file: "login.sqlite3", reason: "open_failed", cause });
    const { client, backup } = yield* workerClient({filename: path, readonly: false, disableWAL: true, busyTimeoutMs: 5_000}).pipe(Effect.mapError(failed));
    for (const pragma of accessPragmas) yield* client.unsafe(`PRAGMA ${pragma}`).pipe(Effect.mapError(failed));
    return {sql: client, backup};
  }).pipe(untracedSql);

/*
 * a private in-memory database for the startup upgrade's reference schema only: no file is created or opened. It is the one
 * client of this module that stays in this thread: it has no file, no lock and no busy wait, and the few statements of a
 * format's steps run at most once per start, before anything listens, so a worker thread would only add its start-up time
 */
export const memoryDatabase: Effect.Effect<SqlClient.SqlClient, DatabaseOpenError, Scope.Scope> =
  SqliteClient.make({filename: ":memory:", disableWAL: true}).pipe(
    Effect.provide(Reactivity.layer),
    Effect.mapError((cause) => new DatabaseOpenError({ file: ":memory:", reason: "open_failed", cause })), untracedSql);

/**
 * A read-only client on the access database, a rollback-journal file, for its admission and exact validation. Unlike an
 * immutable client it takes SQLite's shared lock like any reader, so a write the service is committing is waited for rather
 * than read half written; it creates no file and cannot roll back a hot journal (the admission recovers one first).
 */
export const readOnlyAccessDatabase = (path: string): Effect.Effect<SqlClient.SqlClient, DatabaseOpenError, Scope.Scope> =>
  workerClient({filename: path, readonly: true, disableWAL: true, busyTimeoutMs: 5_000}).pipe(
    Effect.map(({ client }) => client),
    Effect.mapError((cause) => new DatabaseOpenError({ file: "login.sqlite3", reason: "open_failed", cause })), untracedSql);

/**
 * A read-only client on an existing store file, for the startup upgrade's preflight, the rollout scan and backup verification:
 * no statement, pragma or file creation writes, and nothing is checkpointed or removed (see `readOnlyFilename`).
 */
export const readOnlyDatabase = (directory: string, file: string): Effect.Effect<SqlClient.SqlClient, DatabaseOpenError, Scope.Scope> =>
  Effect.map(readOnlyBackupSource(directory, file), ({ sql }) => sql);

/**
 * A read-only client on an existing file with its connection's online backup, for a file the startup upgrade copies but never
 * writes: the retired policy file, whose policy moves into guidance. Like `readOnlyDatabase`, it creates, checkpoints and
 * removes nothing.
 */
export const readOnlyBackupSource = (directory: string, file: string): Effect.Effect<UpgradeDatabase, DatabaseOpenError, Scope.Scope> => {
  const filename = readOnlyFilename(join(resolve(directory), file));
  return workerClient({filename, readonly: true, disableWAL: false, busyTimeoutMs: 5_000}).pipe(
    Effect.map(({ client, backup }) => ({ sql: client, backup })),
    Effect.mapError((cause) => new DatabaseOpenError({ file, reason: "open_failed", cause })), untracedSql);
};
