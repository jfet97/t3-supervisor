import { createHash } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Data, Effect, FileSystem, Option, Schema } from "effect";
import {
  BackupManifest, type BackupCopy, type BackupObservation, type DatabaseFile, databaseFiles, type FileRows, type FileShape, type StoredRow,
  type StoredValue,
} from "./upgrade-journey-evidence.js";

/*
  The upgrade journey's own reads of a data directory and its one write, through node:sqlite: a small native adapter with a recorded
  reason. The journey must read and seed the files a stopped binary left before any Supervisor store or upgrade code opens them, and
  must read backup copies that no store ever opens, so it cannot go through the candidate's SQL layer. Every inspection opens its file
  read only; a backup copy is read from a private copy of its bytes, so SQLite never opens the backup set itself. The only write is the
  seeding of the frozen statements, in one transaction, after the creating binary stopped and before the candidate starts.
*/

export class JourneyFileError extends Data.TaggedError("JourneyFileError")<{readonly message: string}> {}

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

// a value as SQLite stored it, with integers read as bigints, so a comparison sees every byte and every exact integer
const typed = (value: unknown): StoredValue => {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") return {i: value.toString()};
  if (typeof value === "number") return {r: String(value)};
  if (typeof value === "string") return {s: value};
  if (value instanceof Uint8Array) return {b: Buffer.from(value).toString("hex")};
  return {s: String(value)};
};

// one connection on one file, read only unless the caller writes, always closed; any failure is the given fixed message
const withDatabase = <A>(path: string, mode: "read" | "write", use: (db: DatabaseSync) => A, message: string): Effect.Effect<A, JourneyFileError> =>
  Effect.try(() => {
    const db = new DatabaseSync(path, mode === "read" ? {readOnly: true, timeout: 5_000} : {timeout: 5_000});
    try {
      return use(db);
    } finally {
      db.close();
    }
  }).pipe(Effect.mapError(() => new JourneyFileError({message})));

const Declared = Schema.Struct({type: Schema.String, name: Schema.String, sql: Schema.NullOr(Schema.String)});
const decodeDeclared = Schema.decodeUnknownSync(Schema.Array(Declared));
const decodeVersion = Schema.decodeUnknownSync(Schema.Struct({user_version: Schema.Number}));
const decodeNames = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({name: Schema.String})));
const decodeMeta = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({key: Schema.String, value: Schema.String})));
const decodeManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(BackupManifest));
const userObjects = "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY type, name";
const userTables = "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name";

/** A file's stored format, PRAGMA user_version, read only. */
export const formatOf = (path: string): Effect.Effect<number, JourneyFileError> =>
  withDatabase(path, "read", (db) => decodeVersion(db.prepare("PRAGMA user_version").get()).user_version, `${path} has no readable format`);

/** One database file of `directory` as the seed contracts read it: present or not, its format, declarations and the named meta rows. */
export const fileShape = (directory: string, file: DatabaseFile, metaKeys: ReadonlyArray<string>) => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = join(directory, file);
  if (!(yield* fs.exists(path))) return {file, present: false, format: null, declarations: {}, meta: {}} satisfies FileShape;
  return yield* withDatabase(path, "read", (db): FileShape => {
    const format = decodeVersion(db.prepare("PRAGMA user_version").get()).user_version;
    const declarations = Object.fromEntries(decodeDeclared(db.prepare(userObjects).all())
      .flatMap((row) => row.sql === null ? [] : [[`${row.type}:${row.name}`, row.sql] as const]));
    const meta = declarations["table:meta"] === undefined || metaKeys.length === 0 ? {}
      : Object.fromEntries(decodeMeta(db.prepare(`SELECT key, value FROM meta WHERE key IN (${metaKeys.map(() => "?").join(",")})`).all(...metaKeys))
        .map((row) => [row.key, row.value] as const));
    return {file, present: true, format, declarations, meta};
  }, `${file} could not be read`);
});

/** Every table of a file with its rows in rowid order, each value typed exactly, read only. */
export const fileRows = (path: string): Effect.Effect<FileRows, JourneyFileError> => withDatabase(path, "read", (db) => {
  const rows: Record<string, ReadonlyArray<StoredRow>> = {};
  for (const {name} of decodeNames(db.prepare(userTables).all())) {
    const statement = db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`);
    statement.setReadBigInts(true);
    rows[name] = statement.all().map((row) => Object.fromEntries(Object.entries(row).map(([column, value]) => [column, typed(value)] as const)));
  }
  return rows;
}, `${path} could not be read`);

/** Runs the frozen seed statements on one stopped file in one transaction; the number of rows they wrote. */
export const seedFile = (path: string, statements: ReadonlyArray<string>): Effect.Effect<number, JourneyFileError> => withDatabase(path, "write", (db) => {
  db.exec("BEGIN IMMEDIATE");
  try {
    let written = 0;
    for (const statement of statements) written += Number(db.prepare(statement).run().changes);
    db.exec("COMMIT");
    return written;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}, `the frozen seed statements could not be written into ${path}`);

/** The backup set folders of a data directory, sorted; none when it has no backups folder. */
export const backupSets = (directory: string) => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = join(directory, "backups");
  if (!(yield* fs.exists(root))) return [] as ReadonlyArray<string>;
  const sets: Array<string> = [];
  for (const name of yield* fs.readDirectory(root)) if ((yield* fs.stat(join(root, name))).type === "Directory") sets.push(name);
  return sets.sort() as ReadonlyArray<string>;
});

/** A data directory's database files with their formats and rows, the SHA-256 of its workflow MCP bearer and its backup sets. */
export interface DirectorySnapshot {
  readonly formats: Readonly<Partial<Record<DatabaseFile, number | null>>>;
  readonly rows: Readonly<Partial<Record<DatabaseFile, FileRows>>>;
  readonly bearer: string | null;
  readonly sets: ReadonlyArray<string>;
}

export const snapshotDirectory = (directory: string) => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const formats: Partial<Record<DatabaseFile, number | null>> = {};
  const rows: Partial<Record<DatabaseFile, FileRows>> = {};
  for (const file of databaseFiles) {
    const path = join(directory, file);
    if (!(yield* fs.exists(path))) {
      formats[file] = null;
      continue;
    }
    formats[file] = yield* formatOf(path);
    rows[file] = yield* fileRows(path);
  }
  const token = join(directory, "access", "workflow-mcp-token");
  const bearer = (yield* fs.exists(token)) ? sha256(yield* fs.readFile(token)) : null;
  return {formats, rows, bearer, sets: yield* backupSets(directory)} satisfies DirectorySnapshot;
});

const copyName = /^[A-Za-z0-9._-]+$/u;

/**
 * What a start left in the backups folder: the sets before and after and, for exactly one new set, its manifest and each copy's
 * SHA-256, format and rows. A copy is read from a private copy of its bytes in `scratch`, which is removed again.
 */
export const backupObservation = (directory: string, setsBefore: ReadonlyArray<string>, scratch: string) => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const setsAfter = yield* backupSets(directory);
  const added = setsAfter.filter((id) => !setsBefore.includes(id));
  const [only] = added;
  if (added.length !== 1 || only === undefined) return {setsBefore, setsAfter, manifest: null, copies: {}} satisfies BackupObservation;
  const set = join(directory, "backups", only);
  const manifest = yield* fs.readFileString(join(set, "manifest.json")).pipe(Effect.flatMap(decodeManifest), Effect.option);
  if (Option.isNone(manifest)) return {setsBefore, setsAfter, manifest: null, copies: {}} satisfies BackupObservation;
  const copies: Record<string, BackupCopy> = {};
  for (const [index, entry] of manifest.value.files.entries()) {
    if (!copyName.test(entry.backup) || !(yield* fs.exists(join(set, entry.backup)))) continue;
    const bytes = yield* fs.readFile(join(set, entry.backup));
    const probe = join(scratch, `backup-copy-${index}.db`);
    yield* fs.writeFile(probe, bytes, {mode: 0o600});
    const read = yield* Effect.all({format: formatOf(probe), rows: fileRows(probe)}).pipe(
      Effect.ensuring(Effect.forEach([probe, `${probe}-wal`, `${probe}-shm`], (path) => Effect.ignore(fs.remove(path)), {discard: true})));
    copies[entry.backup] = {sha256: sha256(bytes), format: read.format, rows: read.rows};
  }
  return {setsBefore, setsAfter, manifest: manifest.value, copies} satisfies BackupObservation;
});
