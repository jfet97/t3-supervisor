import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import { join } from "node:path";
import { Clock, Data, Effect, FileSystem, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { readFormat, readOnlyDatabase, type UpgradeDatabase } from "./db.js";
import { snapshotRead } from "./guidance-sql.js";
import { buildInfo } from "./version.js";

/*
 * the verified backup set the startup upgrade writes before it changes the format of any existing file
 * (<data directory>/backups/<backup set id>/): each changing file is copied with SQLite's online backup API through its own
 * worker connection (a consistent snapshot, the committed WAL included; never a copy of the live main file), the copy is
 * checked read only (integrity, format, schema and every row against the source as it is after the copy), and the manifest,
 * written last and exclusively, records the checksums and provenance. A set without a manifest is incomplete. Nothing here
 * overwrites or later touches a backup.
 */

/** A backup set could not be completed: the stage that failed and the file, never a path, row or cause. */
export class BackupFailed extends Data.TaggedError("BackupFailed")<{
  readonly file: string | null;
  readonly stage: "directory" | "copy" | "verify" | "manifest";
}> {}

export interface BackupSource {
  /** the file as the manifest names it: its path relative to the data directory */
  readonly file: string;
  /** the copy's file name inside the set */
  readonly name: string;
  /** the format the upgrade moves the file to; null for the retired policy file, whose policy moves into guidance */
  readonly targetFormat: number | null;
  /** the startup upgrade's client on the file */
  readonly database: UpgradeDatabase;
}

/** One verified copy as the manifest records it. */
export interface BackupEntry {
  readonly file: string;
  readonly backup: string;
  readonly format: number;
  readonly targetFormat: number | null;
  readonly bytes: number;
  readonly sha256: string;
  readonly pages: number;
  readonly integrity: "ok";
  readonly tables: Readonly<Record<string, number>>;
  readonly schemaSha256: string;
  readonly contentSha256: string;
}

export interface BackupSet {
  readonly id: string;
  readonly entries: ReadonlyArray<BackupEntry>;
  /** an earlier complete set already held every source exactly as it is, so no copy was made */
  readonly reused: boolean;
}

const ManifestEntry = Schema.Struct({
  file: Schema.String, backup: Schema.String, format: Schema.Number, targetFormat: Schema.NullOr(Schema.Number), bytes: Schema.Number, sha256: Schema.String,
  pages: Schema.Number, integrity: Schema.Literal("ok"), tables: Schema.Record(Schema.String, Schema.Number), schemaSha256: Schema.String,
  contentSha256: Schema.String,
});
const Manifest = Schema.Struct({ kind: Schema.Literal("t3-supervisor-backup"), manifestFormat: Schema.Literal(1), backupSet: Schema.String, files: Schema.Array(ManifestEntry) });
const decodeManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(Manifest));

const privateFile = 0o600;
const privateDirectory = 0o700;
const pageRows = 500;

/*
 * the logical content of a database as one snapshot: its format, its schema rows and every row of every table in rowid order,
 * with each value typed (integers exactly, as bigints), so a copy can be compared with its source
 */
interface Snapshot {
  readonly format: number;
  readonly tables: Readonly<Record<string, number>>;
  readonly schemaSha256: string;
  readonly contentSha256: string;
}

const TableEntry = Schema.Struct({ name: Schema.String, wr: Schema.Union([Schema.Number, Schema.BigInt]) });
const decodeTables = Schema.decodeUnknownEffect(Schema.Array(TableEntry));
const IntegrityRow = Schema.Struct({ integrity_check: Schema.String });
const decodeIntegrity = Schema.decodeUnknownEffect(Schema.Array(IntegrityRow));
const PageCount = Schema.Struct({ page_count: Schema.Union([Schema.Number, Schema.BigInt]) });
const decodePageCount = Schema.decodeUnknownEffect(Schema.Tuple([PageCount]));

const typed = (value: unknown): unknown => {
  if (value === null) return null;
  if (typeof value === "bigint") return { i: value.toString() };
  if (typeof value === "number") return { r: String(value) };
  if (typeof value === "string") return { s: value };
  if (value instanceof Uint8Array) return { b: Buffer.from(value).toString("hex") };
  return { u: String(value) };
};

// the first value of a paged row is its rowid, an exact integer while SafeIntegers is on
const decodeRowId = Schema.decodeUnknownEffect(Schema.BigInt);
const quoted = (identifier: string): string => `"${identifier.replaceAll('"', '""')}"`;

/*
 * Rows are read as positional values (each table's columns in declaration order, the rowid first where it pages): the only
 * row shape the comparison needs, so no row is cast to a record type.
 */
const snapshotOf = (sql: SqlClient.SqlClient) => snapshotRead(sql)(Effect.gen(function* () {
  const format = yield* readFormat(sql);
  const schema = yield* sql.unsafe("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").values;
  const schemaSha256 = createHash("sha256").update(JSON.stringify(schema.map((row) => row.map(typed)))).digest("hex");
  const tables = yield* sql.unsafe(
    "SELECT name, wr FROM pragma_table_list WHERE schema='main' AND type='table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name",
  ).pipe(Effect.flatMap(decodeTables));
  const content = createHash("sha256");
  const counts: Record<string, number> = {};
  for (const table of tables) {
    content.update(JSON.stringify({ table: table.name }));
    let count = 0;
    if (Number(table.wr) !== 0) {
      for (const row of yield* sql.unsafe(`SELECT * FROM ${quoted(table.name)}`).values) {
        content.update(JSON.stringify(row.map(typed)));
        count++;
      }
    } else {
      // pages in rowid order, so a large table never crosses the worker boundary at once
      let after: bigint | null = null;
      for (;;) {
        const rows: ReadonlyArray<ReadonlyArray<unknown>> = yield* (after === null
          ? sql.unsafe(`SELECT rowid, * FROM ${quoted(table.name)} ORDER BY rowid LIMIT ${pageRows}`).values
          : sql.unsafe(`SELECT rowid, * FROM ${quoted(table.name)} WHERE rowid > ? ORDER BY rowid LIMIT ${pageRows}`, [after]).values);
        for (const row of rows) content.update(JSON.stringify(row.map(typed)));
        count += rows.length;
        const last: ReadonlyArray<unknown> | undefined = rows.at(-1);
        if (rows.length < pageRows || last === undefined) break;
        after = yield* decodeRowId(last[0]);
      }
    }
    counts[table.name] = count;
  }
  return { format, tables: counts, schemaSha256, contentSha256: content.digest("hex") } satisfies Snapshot;
})).pipe(Effect.provideService(SqlClient.SafeIntegers, true));

const sameSnapshot = (left: Snapshot, right: Snapshot): boolean =>
  left.format === right.format && left.schemaSha256 === right.schemaSha256 && left.contentSha256 === right.contentSha256 &&
  JSON.stringify(left.tables) === JSON.stringify(right.tables);

// node handles for the directory fsync: the effect FileSystem has no directory open or fsync
const handleCall = <A, F>(call: () => Promise<A>, failure: F): Effect.Effect<A, F> =>
  Effect.tryPromise({ try: call, catch: () => failure });
/** Syncs a directory, so the entries created or removed in it are durable; any failure is `failure`. */
export const syncDirectory = <F>(path: string, failure: F): Effect.Effect<void, F> =>
  Effect.acquireUseRelease(
    handleCall(() => open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW), failure),
    (handle: FileHandle) => handleCall(() => handle.sync(), failure),
    (handle: FileHandle) => Effect.ignore(handleCall(() => handle.close(), failure)),
  );

// the set's id: its UTC creation time and a random suffix, e.g. 20261105T120102Z-1a2b3c4d
const setId = (now: number): string =>
  `${new Date(now).toISOString().replace(/[-:]/gu, "").replace(/\.\d{3}Z$/u, "Z")}-${randomBytes(4).toString("hex")}`;

// a new, private set directory under <data directory>/backups; an existing directory is never reused
const makeSetDirectory = (dataDirectory: string) => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const failed = new BackupFailed({ file: null, stage: "directory" });
  const root = join(dataDirectory, "backups");
  yield* fs.makeDirectory(root, { recursive: true, mode: privateDirectory }).pipe(Effect.mapError(() => failed));
  const info = yield* fs.lstat(root).pipe(Effect.mapError(() => failed));
  if (info.type !== "Directory") return yield* failed;
  yield* fs.chmod(root, privateDirectory).pipe(Effect.mapError(() => failed));
  for (let attempt = 0; attempt < 5; attempt++) {
    const id = setId(yield* Clock.currentTimeMillis);
    const directory = join(root, id);
    // created by this call only: an existing set (the same second and suffix) is never reused
    const created = yield* fs.makeDirectory(directory, { mode: privateDirectory }).pipe(
      Effect.as(true),
      Effect.catchIf((error) => error.reason._tag === "AlreadyExists", () => Effect.succeed(false)),
      Effect.mapError(() => failed));
    if (created) {
      yield* fs.chmod(directory, privateDirectory).pipe(Effect.mapError(() => failed));
      return { id, root, directory };
    }
  }
  return yield* failed;
});

/*
 * one source: an exclusive private file, the online backup into it, then the read-only verification of the copy against the
 * source as it is after the copy (a source that changed in between fails, as a concurrent writer would make it)
 */
const backupOne = (directory: string, source: BackupSource) => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const copyFailed = new BackupFailed({ file: source.file, stage: "copy" });
  const verifyFailed = new BackupFailed({ file: source.file, stage: "verify" });
  const destination = join(directory, source.name);
  yield* Effect.scoped(fs.open(destination, { flag: "wx", mode: privateFile })).pipe(Effect.mapError(() => copyFailed));
  yield* source.database.backup(destination).pipe(Effect.mapError(() => copyFailed));
  yield* fs.chmod(destination, privateFile).pipe(Effect.mapError(() => copyFailed));
  const original = yield* snapshotOf(source.database.sql).pipe(Effect.mapError(() => verifyFailed));
  const copy = yield* Effect.scoped(Effect.gen(function* () {
    const sql = yield* readOnlyDatabase(directory, source.name);
    const integrity = yield* sql.unsafe("PRAGMA integrity_check").pipe(Effect.flatMap(decodeIntegrity));
    const [{ page_count }] = yield* sql.unsafe("PRAGMA page_count").pipe(Effect.flatMap(decodePageCount));
    return { integrity: integrity.map((row) => row.integrity_check), pages: Number(page_count), snapshot: yield* snapshotOf(sql) };
  })).pipe(Effect.mapError(() => verifyFailed));
  if (copy.integrity.length !== 1 || copy.integrity[0] !== "ok" || !sameSnapshot(original, copy.snapshot)) return yield* verifyFailed;
  const bytes = yield* fs.readFile(destination).pipe(Effect.mapError(() => verifyFailed));
  return {
    file: source.file, backup: source.name, format: copy.snapshot.format, targetFormat: source.targetFormat, bytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"), pages: copy.pages, integrity: "ok", tables: copy.snapshot.tables,
    schemaSha256: copy.snapshot.schemaSha256, contentSha256: copy.snapshot.contentSha256,
  } satisfies BackupEntry;
});

/*
 * the newest earlier complete set (with its manifest) that already holds every source with the same format, schema and rows, its
 * copies still matching their recorded checksums: a start that failed after writing it is retried without another copy, so a
 * restart loop never fills the disk with identical sets. A set that cannot be read or does not match is simply not reused.
 */
const reusableSet = (dataDirectory: string, sources: ReadonlyArray<{ readonly source: BackupSource; readonly snapshot: Snapshot }>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = join(dataDirectory, "backups");
    if (!(yield* fs.exists(root))) return null;
    for (const id of [...yield* fs.readDirectory(root)].sort().reverse()) {
      const manifest = yield* fs.readFileString(join(root, id, "manifest.json")).pipe(Effect.flatMap(decodeManifest), Effect.option);
      if (manifest._tag === "None" || manifest.value.backupSet !== id) continue;
      const entries: Array<BackupEntry> = [];
      for (const { source, snapshot } of sources) {
        const entry = manifest.value.files.find((candidate) => candidate.file === source.file);
        if (entry === undefined || entry.format !== snapshot.format || entry.targetFormat !== source.targetFormat ||
          entry.schemaSha256 !== snapshot.schemaSha256 || entry.contentSha256 !== snapshot.contentSha256) break;
        const bytes = yield* fs.readFile(join(root, id, entry.backup)).pipe(Effect.option);
        if (bytes._tag === "None" || createHash("sha256").update(bytes.value).digest("hex") !== entry.sha256) break;
        entries.push(entry);
      }
      if (entries.length === sources.length) return { id, entries };
    }
    return null;
  }).pipe(Effect.catch(() => Effect.succeed(null)));

/**
 * Writes and verifies a new backup set of `sources` before the upgrade changes any of them: every copy verified, then the
 * manifest written exclusively and synced with its directories. Any failure leaves an incomplete set without a manifest and
 * blocks the upgrade; an earlier set is never touched. When an earlier complete set already holds every source exactly as it is
 * now, with intact copies, that set is the backup and nothing is copied.
 */
export const writeBackupSet = (dataDirectory: string, sources: ReadonlyArray<BackupSource>): Effect.Effect<BackupSet, BackupFailed, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const current = yield* Effect.forEach(sources, (source) => snapshotOf(source.database.sql).pipe(
      Effect.map((snapshot) => ({ source, snapshot })), Effect.mapError(() => new BackupFailed({ file: source.file, stage: "verify" }))));
    const earlier = yield* reusableSet(dataDirectory, current);
    if (earlier !== null) return { id: earlier.id, entries: earlier.entries, reused: true };
    const { id, root, directory } = yield* makeSetDirectory(dataDirectory);
    const entries: Array<BackupEntry> = [];
    for (const source of sources) entries.push(yield* backupOne(directory, source));
    const failed = new BackupFailed({ file: null, stage: "manifest" });
    const manifest = {
      kind: "t3-supervisor-backup",
      manifestFormat: 1,
      backupSet: id,
      createdAt: new Date(yield* Clock.currentTimeMillis).toISOString(),
      supervisor: { version: buildInfo.version, revision: buildInfo.gitHead ?? null },
      files: entries,
    };
    yield* Effect.scoped(Effect.gen(function* () {
      const file = yield* fs.open(join(directory, "manifest.json"), { flag: "wx", mode: privateFile });
      yield* file.writeAll(new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`));
      yield* file.sync;
    })).pipe(Effect.mapError(() => failed));
    yield* syncDirectory(directory, failed);
    yield* syncDirectory(root, failed);
    return { id, entries, reused: false };
  });

// a set id as `setId` makes it, so a stored id never names a path outside the backups directory
const setIdPattern = /^\d{8}T\d{6}Z-[0-9a-f]{8}$/u;

/**
 * The copy of `file` in the complete backup set `id`: the directory and name its manifest records, only while the copy still
 * matches its recorded checksum, otherwise null. The copy itself is only ever read.
 */
export const backupCopy = (dataDirectory: string, id: string, file: string):
  Effect.Effect<{ readonly directory: string; readonly file: string } | null, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    if (!setIdPattern.test(id)) return null;
    const fs = yield* FileSystem.FileSystem;
    const directory = join(dataDirectory, "backups", id);
    const manifest = yield* fs.readFileString(join(directory, "manifest.json")).pipe(Effect.flatMap(decodeManifest));
    const entry = manifest.backupSet === id ? manifest.files.find((candidate) => candidate.file === file) : undefined;
    if (entry === undefined) return null;
    const bytes = yield* fs.readFile(join(directory, entry.backup));
    return createHash("sha256").update(bytes).digest("hex") === entry.sha256 ? { directory, file: entry.backup } : null;
  }).pipe(Effect.catch(() => Effect.succeed(null)));
