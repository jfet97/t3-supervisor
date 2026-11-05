import { createHash } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Data, Effect, Schema } from "effect";

/*
 * The frozen historical persistence fixtures (test/fixtures/persistence/<shape>/): their manifests, an integrity check, the
 * materialization of their database files and a dump to compare files with. A small synchronous adapter over node:sqlite and
 * node:fs (the fixture files are written and read the way an external SQLite client would), with Effect wrappers for the
 * suites. It imports nothing from src/: the fixtures stand for files that older releases wrote, so neither their text nor
 * their materialization may follow today's schema code, serializers or factories.
 */

/** The directory of the frozen fixtures, one subdirectory per persisted layout. */
export const fixturesDirectory = fileURLToPath(new URL("../fixtures/persistence/", import.meta.url));

/** Every frozen layout, keyed by persisted format and shape (not by release). */
export const fixtureShapes = ["format0-current-unversioned", "format0-pre-coverage-pre-planning"] as const;
export type FixtureShape = typeof fixtureShapes[number];

export const fixtureDatabaseNames = ["catalog", "guidance", "thread-settings", "access-login"] as const;
export type FixtureDatabaseName = typeof fixtureDatabaseNames[number];

/** A fixture whose files, manifest or materialization do not hold; it names the shape and the reason, never row content. */
export class FixtureError extends Data.TaggedError("FixtureError")<{
  readonly shape: string;
  readonly reason: string;
  readonly cause?: unknown;
}> {
  override get message(): string {
    return `persistence fixture ${this.shape}: ${this.reason}`;
  }
}

const FixtureDatabase = Schema.Struct({
  name: Schema.Literals(fixtureDatabaseNames),
  path: Schema.Literals(["catalog.sqlite3", "guidance.sqlite3", "thread-settings.sqlite3", "access/login.sqlite3"]),
  journalMode: Schema.Literals(["wal", "delete"]),
  fileMode: Schema.Literal("0600"),
  directoryMode: Schema.Literal("0700"),
  userVersion: Schema.Literal(0),
  schema: Schema.String,
  rows: Schema.String,
  expected: Schema.String,
  syntheticRows: Schema.Struct({ label: Schema.Literal("synthetic fixture input, not old-binary output") }),
});
/** The fields of a fixture manifest this module relies on; the manifest's provenance stays in the file for readers. */
export const FixtureManifest = Schema.Struct({
  shape: Schema.Literals(fixtureShapes),
  format: Schema.Literal(0),
  databases: Schema.Array(FixtureDatabase),
  syntheticData: Schema.Struct({ label: Schema.Literal("synthetic fixture input, not old-binary output") }),
  sha256: Schema.Record(Schema.String, Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u))),
});
export type FixtureManifest = typeof FixtureManifest.Type;
export type FixtureDatabase = FixtureManifest["databases"][number];

/** One database file as an external client reads it back: the layout, the format marker and the persisted journal mode. */
export const DatabaseDump = Schema.Struct({
  userVersion: Schema.Number,
  journalMode: Schema.Literals(["wal", "delete"]),
  sqliteMaster: Schema.Array(Schema.Struct({ type: Schema.String, name: Schema.String, tbl_name: Schema.String, sql: Schema.NullOr(Schema.String) })),
  objectOrder: Schema.Array(Schema.String),
  tableInfo: Schema.Record(Schema.String, Schema.Array(Schema.Struct({
    cid: Schema.Number, name: Schema.String, type: Schema.String, notnull: Schema.Number, dflt_value: Schema.NullOr(Schema.String), pk: Schema.Number,
  }))),
  rowCounts: Schema.Record(Schema.String, Schema.Number),
});
export type DatabaseDump = typeof DatabaseDump.Type;
const ExpectedDump = Schema.Struct({ database: Schema.String, ...DatabaseDump.fields });

const manifestFile = "manifest.json";
const decodeManifest = Schema.decodeUnknownSync(Schema.fromJsonString(FixtureManifest));
const decodeExpected = Schema.decodeUnknownSync(Schema.fromJsonString(ExpectedDump));
const decodeDump = Schema.decodeUnknownSync(DatabaseDump);

const shapeDirectory = (shape: FixtureShape): string => join(fixturesDirectory, shape);
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const quoteIdentifier = (name: string): string => `"${name.replaceAll("\"", "\"\"")}"`;
// node:sqlite rows have a null prototype; plain copies compare and serialize as ordinary objects
const plain = (row: object): Record<string, unknown> => ({ ...row });

/** The decoded manifest of a shape. */
export const fixtureManifestSync = (shape: FixtureShape): FixtureManifest => {
  const manifest = decodeManifest(readFileSync(join(shapeDirectory(shape), manifestFile), "utf8"));
  if (manifest.shape !== shape) throw new FixtureError({ shape, reason: `the manifest names ${manifest.shape}` });
  return manifest;
};

/** A file of the shape directory that is missing, not listed in the manifest or whose SHA-256 differs from the recorded one. */
export interface FixtureIntegrityProblem {
  readonly file: string;
  readonly problem: "missing" | "unlisted" | "sha256_mismatch";
}

/** Recomputes the SHA-256 of every file of the shape directory except the manifest and compares it with the manifest. */
export const fixtureIntegrityProblems = (shape: FixtureShape): ReadonlyArray<FixtureIntegrityProblem> => {
  const manifest = fixtureManifestSync(shape);
  const present = readdirSync(shapeDirectory(shape)).filter((file) => file !== manifestFile).sort();
  const listed = Object.keys(manifest.sha256).sort();
  const problems: Array<FixtureIntegrityProblem> = [];
  for (const file of listed) {
    if (!present.includes(file)) problems.push({ file, problem: "missing" });
    else if (sha256(readFileSync(join(shapeDirectory(shape), file))) !== manifest.sha256[file]) problems.push({ file, problem: "sha256_mismatch" });
  }
  for (const file of present) if (!listed.includes(file)) problems.push({ file, problem: "unlisted" });
  return problems;
};

/** The journal mode a file's header records (bytes 18 and 19: 1 for a rollback journal, 2 for WAL). */
export const headerJournalMode = (path: string): "wal" | "delete" => {
  const header = Buffer.alloc(100);
  const descriptor = openSync(path, "r");
  try {
    readSync(descriptor, header, 0, header.length, 0);
  } finally {
    closeSync(descriptor);
  }
  if (header[18] === 2 && header[19] === 2) return "wal";
  if (header[18] === 1 && header[19] === 1) return "delete";
  throw new Error(`unexpected file format bytes ${header[18]}/${header[19]}`);
};

/**
 * The dump of a closed database file, read through an immutable read-only connection so that no journal or shared-memory
 * file is created beside it: sqlite_master ordered by type and name, the creation (rowid) order, PRAGMA table_info and the
 * row count of every table, PRAGMA user_version and the journal mode of the file header. A file with a write-ahead log
 * beside it is refused: its committed state may not be in the main file yet.
 */
export const dumpDatabaseSync = (path: string): DatabaseDump => {
  if (existsSync(`${path}-wal`)) throw new Error("the database has a write-ahead log; close every connection before dumping it");
  const database = new DatabaseSync(`${pathToFileURL(path).href}?immutable=1`, { readOnly: true });
  try {
    const sqliteMaster = database.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all().map(plain);
    const tables = sqliteMaster.filter((row) => row.type === "table").map((row) => String(row.name));
    return decodeDump({
      userVersion: database.prepare("PRAGMA user_version").get()?.user_version,
      journalMode: headerJournalMode(path),
      sqliteMaster,
      objectOrder: database.prepare("SELECT name FROM sqlite_master ORDER BY rowid").all().map((row) => row.name),
      tableInfo: Object.fromEntries(tables.map((table) => [table, database.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all().map(plain)])),
      rowCounts: Object.fromEntries(tables.map((table) => [table, database.prepare(`SELECT count(*) AS n FROM ${quoteIdentifier(table)}`).get()?.n])),
    });
  } finally {
    database.close();
  }
};

/** The frozen dump of one database of a shape, as its expected file records it after its schema and rows. */
export const expectedDumpSync = (shape: FixtureShape, name: FixtureDatabaseName): DatabaseDump & { readonly database: string } => {
  const database = fixtureManifestSync(shape).databases.find((entry) => entry.name === name);
  if (database === undefined) throw new FixtureError({ shape, reason: `no database ${name}` });
  return decodeExpected(readFileSync(join(shapeDirectory(shape), database.expected), "utf8"));
};

/** The materialized database files of a shape: each manifest entry with its absolute path. */
export interface MaterializedFixture {
  readonly shape: FixtureShape;
  readonly dataDirectory: string;
  readonly files: ReadonlyArray<FixtureDatabase & { readonly absolutePath: string }>;
}

/**
 * Creates the shape's database files in `dataDirectory` as the old binaries left them after a clean stop: each file gets its
 * recorded journal mode first (WAL for catalog, guidance and thread-settings, DELETE for access/login.sqlite3), then its frozen
 * schema statements and its synthetic rows, and is closed, so a WAL file is checkpointed and its sidecars removed. The data
 * directory and access/ are 0700, every file 0600. The format marker is never written: every file stays at user_version 0.
 * An existing file is never overwritten.
 */
export const materializeFixtureSync = (shape: FixtureShape, dataDirectory: string): MaterializedFixture => {
  const manifest = fixtureManifestSync(shape);
  mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  chmodSync(dataDirectory, 0o700);
  const files = manifest.databases.map((entry) => {
    const absolutePath = join(dataDirectory, entry.path);
    for (const path of [absolutePath, `${absolutePath}-wal`, `${absolutePath}-shm`, `${absolutePath}-journal`])
      if (existsSync(path)) throw new FixtureError({ shape, reason: `${entry.path} already exists in the data directory` });
    const directory = dirname(absolutePath);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    const database = new DatabaseSync(absolutePath);
    try {
      database.exec(entry.journalMode === "wal" ? "PRAGMA journal_mode=WAL" : "PRAGMA journal_mode=DELETE");
      database.exec(readFileSync(join(shapeDirectory(shape), entry.schema), "utf8"));
      database.exec(readFileSync(join(shapeDirectory(shape), entry.rows), "utf8"));
    } finally {
      database.close();
    }
    chmodSync(absolutePath, 0o600);
    return { ...entry, absolutePath };
  });
  return { shape, dataDirectory, files };
};

const attempt = <A>(shape: string, reason: string, run: () => A): Effect.Effect<A, FixtureError> =>
  Effect.try({ try: run, catch: (cause) => cause instanceof FixtureError ? cause : new FixtureError({ shape, reason, cause }) });

/** The decoded manifest of a shape. */
export const fixtureManifest = (shape: FixtureShape): Effect.Effect<FixtureManifest, FixtureError> =>
  attempt(shape, "the manifest could not be read", () => fixtureManifestSync(shape));

/** Recomputes the shape's SHA-256s and fails with the problems when a file is missing, unlisted or changed. */
export const verifyFixtureIntegrity = (shape: FixtureShape): Effect.Effect<FixtureManifest, FixtureError> =>
  attempt(shape, "the fixture files could not be checked", () => {
    const problems = fixtureIntegrityProblems(shape);
    if (problems.length > 0) throw new FixtureError({ shape, reason: problems.map(({ file, problem }) => `${file}: ${problem}`).join(", ") });
    return fixtureManifestSync(shape);
  });

/** The shape's database files in `dataDirectory`, at format 0 (see materializeFixtureSync). */
export const materializeFixture = (shape: FixtureShape, dataDirectory: string): Effect.Effect<MaterializedFixture, FixtureError> =>
  attempt(shape, "the fixture could not be materialized", () => materializeFixtureSync(shape, dataDirectory));

/** The dump of a closed database file (see dumpDatabaseSync). */
export const dumpDatabase = (path: string): Effect.Effect<DatabaseDump, FixtureError> =>
  attempt(path, "the database could not be dumped", () => dumpDatabaseSync(path));

/** The frozen dump of one database of a shape. */
export const expectedDump = (shape: FixtureShape, name: FixtureDatabaseName): Effect.Effect<DatabaseDump & { readonly database: string }, FixtureError> =>
  attempt(shape, `the expected dump of ${name} could not be read`, () => expectedDumpSync(shape, name));
