import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { NodeFileSystem } from "@effect/platform-node";
import { describe, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { type BackupSource, writeBackupSet } from "../src/database-backup.js";
import { openUpgradeDatabase, type UpgradeDatabase } from "../src/db.js";
import { buildInfo } from "../src/version.js";

// the verified backup set of the startup upgrade (src/database-backup.ts) on real files: a new private directory per set, each
// copy made with SQLite's online backup API through the worker connection (committed write-ahead log included) and checked
// read only against its source, and the manifest written last; a copy that does not match leaves the set without a manifest

const temporaryDirectory = Effect.flatMap(FileSystem.FileSystem, (fs) => fs.makeTempDirectoryScoped({ prefix: "t3-supervisor-backup-" }));

const mode = (path: string): string => (statSync(path).mode & 0o777).toString(8);
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const rowsOf = (path: string): ReadonlyArray<unknown> => {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    // integers exactly, as the backup's own comparison reads them
    const statement = db.prepare("SELECT id, v, n, b FROM t ORDER BY id");
    statement.setReadBigInts(true);
    return statement.all().map((row) => ({ ...row }));
  } finally {
    db.close();
  }
};

// a source in the write-ahead log mode of the store files, with its last commit still only in the log
const source = (directory: string) => Effect.gen(function* () {
  const database = yield* openUpgradeDatabase(directory, "catalog", { create: true });
  const { sql } = database;
  yield* sql.unsafe("PRAGMA journal_mode=WAL");
  yield* sql.unsafe("PRAGMA wal_autocheckpoint=0");
  yield* sql.withTransaction(Effect.gen(function* () {
    yield* sql.unsafe("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT, n INTEGER, b BLOB)");
    yield* sql.unsafe("INSERT INTO t (v, n, b) VALUES ('{\"unknown\":{\"kept\":true}}', 9007199254740993, x'00ff'), ('second', -1, NULL)");
  }));
  yield* sql.withTransaction(sql.unsafe("INSERT INTO t (v, n) VALUES ('only in the log', 3)"));
  return database;
});

const catalogSource = (database: UpgradeDatabase): BackupSource => ({ file: "catalog.sqlite3", name: "catalog.sqlite3", targetFormat: 1, database });

describe("verified backup sets", () => {
  it.live("writes a new private set whose copies and manifest match the source, the committed log included", () => Effect.gen(function* () {
    const directory = yield* temporaryDirectory;
    const database = yield* source(directory);
    const set = yield* writeBackupSet(directory, [catalogSource(database)]);
    const setDirectory = join(directory, "backups", set.id);
    const copy = join(setDirectory, "catalog.sqlite3");
    assert.match(set.id, /^\d{8}T\d{6}Z-[0-9a-f]{8}$/u);
    assert.deepEqual([mode(join(directory, "backups")), mode(setDirectory), mode(copy), mode(join(setDirectory, "manifest.json"))], ["700", "700", "600", "600"]);
    assert.deepEqual(rowsOf(copy), rowsOf(join(directory, "catalog.sqlite3")));
    assert.equal(rowsOf(copy).length, 3);
    const manifest = JSON.parse(readFileSync(join(setDirectory, "manifest.json"), "utf8")) as Record<string, unknown>;
    const bytes = readFileSync(copy);
    assert.equal(manifest.kind, "t3-supervisor-backup");
    assert.equal(manifest.backupSet, set.id);
    assert.deepEqual(manifest.supervisor, { version: buildInfo.version, revision: buildInfo.gitHead ?? null });
    assert.deepEqual(manifest.files, set.entries);
    const [entry] = set.entries;
    assert.ok(entry !== undefined);
    assert.deepEqual({ file: entry.file, backup: entry.backup, format: entry.format, targetFormat: entry.targetFormat, integrity: entry.integrity, tables: entry.tables },
      { file: "catalog.sqlite3", backup: "catalog.sqlite3", format: 0, targetFormat: 1, integrity: "ok", tables: { t: 3 } });
    assert.deepEqual([entry.bytes, entry.sha256], [bytes.byteLength, sha256(bytes)]);
  }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)), { timeout: 30_000 });

  it.live("never reuses a set: a later set gets its own directory and leaves the earlier one untouched", () => Effect.gen(function* () {
    const directory = yield* temporaryDirectory;
    const database = yield* source(directory);
    const first = yield* writeBackupSet(directory, [catalogSource(database)]);
    const firstManifest = readFileSync(join(directory, "backups", first.id, "manifest.json"));
    const firstCopy = readFileSync(join(directory, "backups", first.id, "catalog.sqlite3"));
    yield* database.sql.withTransaction(database.sql.unsafe("INSERT INTO t (v) VALUES ('after the first set')"));
    const second = yield* writeBackupSet(directory, [catalogSource(database)]);
    assert.notEqual(second.id, first.id);
    assert.deepEqual(readFileSync(join(directory, "backups", first.id, "manifest.json")), firstManifest);
    assert.deepEqual(readFileSync(join(directory, "backups", first.id, "catalog.sqlite3")), firstCopy);
    assert.equal(rowsOf(join(directory, "backups", second.id, "catalog.sqlite3")).length, 4);
  }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)), { timeout: 30_000 });

  it.live("an earlier complete set that already holds the source unchanged, with intact copies, is reused instead of copied again", () => Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* temporaryDirectory;
    const database = yield* source(directory);
    const first = yield* writeBackupSet(directory, [catalogSource(database)]);
    const again = yield* writeBackupSet(directory, [catalogSource(database)]);
    assert.deepEqual([first.reused, again.reused, again.id, again.entries], [false, true, first.id, first.entries]);
    assert.deepEqual(yield* fs.readDirectory(join(directory, "backups")), [first.id]);
    // a damaged copy is never trusted: the next set is written anew
    const copy = join(directory, "backups", first.id, "catalog.sqlite3");
    yield* fs.chmod(copy, 0o600);
    const bytes = readFileSync(copy);
    bytes[bytes.length - 1] = (bytes.at(-1) ?? 0) ^ 0xff;
    yield* fs.writeFile(copy, bytes);
    const fresh = yield* writeBackupSet(directory, [catalogSource(database)]);
    assert.equal(fresh.reused, false);
    assert.notEqual(fresh.id, first.id);
  }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)), { timeout: 30_000 });

  it.live("a copy that does not match its source fails verification and leaves the set without a manifest", () => Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* temporaryDirectory;
    const database = yield* source(directory);
    // a deliberately broken copy: the backup of another database lands in the destination
    const other = yield* temporaryDirectory;
    const decoy = yield* openUpgradeDatabase(other, "catalog", { create: true });
    yield* decoy.sql.unsafe("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT, n INTEGER, b BLOB)");
    const broken: UpgradeDatabase = { sql: database.sql, backup: (destination) => decoy.backup(destination) };
    const failure = yield* Effect.flip(writeBackupSet(directory, [catalogSource(broken)]));
    assert.deepEqual([failure._tag, failure.stage, failure.file], ["BackupFailed", "verify", "catalog.sqlite3"]);
    const [set] = yield* fs.readDirectory(join(directory, "backups"));
    assert.ok(set !== undefined);
    assert.equal(yield* fs.exists(join(directory, "backups", set, "manifest.json")), false);
  }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)), { timeout: 30_000 });

  it.live("a set that cannot be created fails before copying anything", () => Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* temporaryDirectory;
    const database = yield* source(directory);
    yield* fs.writeFileString(join(directory, "backups"), "not a directory");
    const failure = yield* Effect.flip(writeBackupSet(directory, [catalogSource(database)]));
    assert.deepEqual([failure.stage, failure.file], ["directory", null]);
  }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)), { timeout: 30_000 });
});
