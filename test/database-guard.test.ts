import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { NodeFileSystem } from "@effect/platform-node";
import { describe, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { upgradeDataDirectory } from "../src/database-upgrade.js";
import { accessDbLayer, catalogDbLayer, DatabaseOpenError, guidanceDbLayer, openUpgradeDatabase, policyDbLayer, readFormat } from "../src/db.js";
import { forgeDashboardToken } from "../src/service-auth.js";
import { sqliteRow, sqliteRows } from "./support/sqlite-rows.js";

/*
 * the format guard of every store open (src/db.ts): only a file at its current format opens. A missing file is never created,
 * an older one asks for the service to start once (only the startup upgrade migrates), a newer one is refused, and none of
 * them is changed: the format is read through the connection, so a version committed only in the write-ahead log counts.
 * The forge and the maintenance paths go through the same opens.
 */

const temporaryDirectory = Effect.flatMap(FileSystem.FileSystem, (fs) => fs.makeTempDirectoryScoped({ prefix: "t3-supervisor-guard-" }));

// a fresh directory through the production startup upgrade itself
const initialized = (directory: string) => upgradeDataDirectory({ dataDirectory: directory, excludedThreadIds: [] });

const opened = <A, R>(layer: Layer.Layer<A, DatabaseOpenError, R>) => Effect.scoped(Layer.build(layer)).pipe(Effect.asVoid);

const refusal = <A, R>(layer: Layer.Layer<A, DatabaseOpenError, R>) => Effect.flip(opened(layer));

const sha256 = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

const UserVersionRow = Schema.Struct({ user_version: Schema.Number });
const CountRow = Schema.Struct({ n: Schema.Number });

// the format a database file's own header records (bytes 60-63), or null while the main file has no complete header
const headerFormat = (path: string): number | null => {
  const bytes = readFileSync(path);
  return bytes.length >= 64 ? bytes.readUInt32BE(60) : null;
};

const raw = (path: string, statements: string) => {
  const db = new DatabaseSync(path);
  try {
    db.exec(statements);
  } finally {
    db.close();
  }
};

// the access tables of Supervisor 0.0.27, written literally
const accessTables = `
  CREATE TABLE dashboard_login_grants (
        token_hash TEXT PRIMARY KEY NOT NULL CHECK(length(token_hash)=64),
        issued_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL CHECK(expires_at > issued_at)
      ) STRICT;
  CREATE TABLE dashboard_login_sessions (
        token_hash TEXT PRIMARY KEY NOT NULL CHECK(length(token_hash)=64),
        issued_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL CHECK(expires_at > issued_at AND expires_at - issued_at <= 2592000000)
      ) STRICT;
`;

// a format 0 access database the forge must not migrate
const legacyAccess = `PRAGMA journal_mode=DELETE; ${accessTables}`;

/*
 * a separate process commits `statements` to the write-ahead log of a new file and is killed before any checkpoint or close:
 * no connection of any process is left on the file, so the next connection that can write would recover the log and
 * checkpoint it into the file when it closes
 */
const killedWriter = 'const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync(process.argv[1]); db.exec(process.argv[2]); process.kill(process.pid, "SIGKILL");';
const orphanedLog = (path: string, statements: string) => {
  const result = spawnSync(process.execPath, ["-e", killedWriter, path, statements], { encoding: "utf8", timeout: 30_000 });
  assert.equal(result.signal, "SIGKILL", result.stderr);
  assert.ok(existsSync(`${path}-wal`), "the killed writer left its log");
};
const newerInLog = (tables: string) => `PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; ${tables} PRAGMA user_version=2;`;

// the file and its log, byte for byte
const fileAndLog = (path: string) => ({ main: sha256(path), log: sha256(`${path}-wal`), logBytes: statSync(`${path}-wal`).size });

/*
 * the negative control of an orphaned log: a connection that can write, closing as the last one, checkpoints the log into the
 * file and removes it, so the byte checks before it would have seen any such open
 */
const checkpointedByWritableClose = (path: string, before: { readonly main: string }) => {
  const writable = new DatabaseSync(path);
  try {
    assert.equal(sqliteRow(writable, UserVersionRow, "PRAGMA user_version").user_version, 2);
  } finally {
    writable.close();
  }
  assert.equal(existsSync(`${path}-wal`), false, "the log was checkpointed and removed");
  assert.equal(headerFormat(path), 2);
  assert.notEqual(sha256(path), before.main);
};

describe("database format guard", () => {
  it.live("a missing store file is not created: the open asks for the service to start once", () => Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* temporaryDirectory;
    // one refusal per store layer, each with its own layer type
    const refusals = [
      { file: "catalog.sqlite3", refused: refusal(catalogDbLayer(directory)) },
      { file: "guidance.sqlite3", refused: refusal(guidanceDbLayer(directory)) },
      { file: "thread-settings.sqlite3", refused: refusal(policyDbLayer(directory)) },
    ];
    for (const { file, refused } of refusals) {
      const error = yield* refused;
      assert.equal(error.reason, "not_initialized", file);
      assert.equal(error.file, file);
      assert.match(error.message, /start the service once/u);
    }
    assert.deepEqual(yield* fs.readDirectory(directory), []);
  }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)), { timeout: 20_000 });

  it.live("an older file is refused unchanged, whether table-less or with data", () => Effect.gen(function* () {
    const directory = yield* temporaryDirectory;
    const catalog = join(directory, "catalog.sqlite3");
    const guidance = join(directory, "guidance.sqlite3");
    raw(catalog, "");
    raw(guidance, "PRAGMA journal_mode=DELETE; CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); INSERT INTO meta VALUES('settings','{}');");
    const before = [sha256(catalog), sha256(guidance)];
    const catalogError = yield* refusal(catalogDbLayer(directory));
    const guidanceError = yield* refusal(guidanceDbLayer(directory));
    assert.deepEqual([catalogError.reason, catalogError.found, catalogError.expected], ["upgrade_required", 0, 1]);
    assert.deepEqual([guidanceError.reason, guidanceError.found, guidanceError.expected], ["upgrade_required", 0, 1]);
    assert.deepEqual([sha256(catalog), sha256(guidance)], before);
  }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)), { timeout: 20_000 });

  it.live("a newer format committed only in the write-ahead log is refused, leaving the file, its log and its rows unchanged", () => Effect.gen(function* () {
    const directory = yield* temporaryDirectory;
    const path = join(directory, "guidance.sqlite3");
    // another connection keeps the file open, so its committed log is not checkpointed into the main file
    const holder = new DatabaseSync(path);
    yield* Effect.addFinalizer(() => Effect.sync(() => holder.close()));
    holder.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE kept(v TEXT); INSERT INTO kept VALUES('row'); PRAGMA user_version=2;");
    assert.notEqual(headerFormat(path), 2, "the newer format is still only in the log");
    const before = { main: sha256(path), log: sha256(`${path}-wal`), logBytes: statSync(`${path}-wal`).size };
    const error = yield* refusal(guidanceDbLayer(directory));
    assert.deepEqual([error.reason, error.found, error.expected], ["unsupported_format", 2, 1]);
    assert.match(error.message, /newer than format 1/u);
    assert.deepEqual({ main: sha256(path), log: sha256(`${path}-wal`), logBytes: statSync(`${path}-wal`).size }, before);
    assert.equal(sqliteRow(holder, UserVersionRow, "PRAGMA user_version").user_version, 2);
    assert.deepEqual(sqliteRows(holder, Schema.Struct({ v: Schema.String }), "SELECT v FROM kept"), [{ v: "row" }]);
  }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)), { timeout: 20_000 });

  it.live("a newer format that a killed process left only in its write-ahead log is refused by the open and the preflight, which neither recover nor checkpoint it", () => Effect.gen(function* () {
    const directory = yield* temporaryDirectory;
    const path = join(directory, "guidance.sqlite3");
    orphanedLog(path, newerInLog("CREATE TABLE kept(v TEXT); INSERT INTO kept VALUES('row');"));
    assert.equal(headerFormat(path), 0, "the newer format is only in the log");
    const before = fileAndLog(path);
    const error = yield* refusal(guidanceDbLayer(directory));
    assert.deepEqual([error.reason, error.found, error.expected], ["unsupported_format", 2, 1]);
    assert.deepEqual(fileAndLog(path), before);
    const failure = yield* Effect.flip(upgradeDataDirectory({ dataDirectory: directory, excludedThreadIds: [] }));
    assert.deepEqual([failure.file, failure.reason], ["guidance.sqlite3", "future_format"]);
    assert.deepEqual(fileAndLog(path), before);
    assert.equal(existsSync(join(directory, "backups")), false);
    checkpointedByWritableClose(path, before);
    const kept = new DatabaseSync(path, { readOnly: true });
    try {
      assert.deepEqual(sqliteRows(kept, Schema.Struct({ v: Schema.String }), "SELECT v FROM kept"), [{ v: "row" }]);
    } finally {
      kept.close();
    }
  }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)), { timeout: 30_000 });

  it.live("a newer access database that a killed process left only in its write-ahead log is refused by the preflight and the forge without being opened for writing", () => Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* temporaryDirectory;
    yield* fs.makeDirectory(join(directory, "access"), { mode: 0o700 });
    const path = join(directory, "access", "login.sqlite3");
    orphanedLog(path, newerInLog(accessTables));
    yield* fs.chmod(path, 0o600);
    assert.equal(headerFormat(path), 0, "the newer format is only in the log");
    const before = fileAndLog(path);
    const failure = yield* Effect.flip(upgradeDataDirectory({ dataDirectory: directory, excludedThreadIds: [] }));
    assert.deepEqual([failure.file, failure.reason], ["access/login.sqlite3", "future_format"]);
    assert.deepEqual(fileAndLog(path), before);
    const forged = yield* Effect.flip(forgeDashboardToken(directory));
    assert.equal(forged.reason, "login_grant_state");
    assert.deepEqual(fileAndLog(path), before);
    assert.equal(existsSync(join(directory, "backups")), false);
    checkpointedByWritableClose(path, before);
  }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)), { timeout: 30_000 });

  it.live("a file at the current format opens", () => Effect.gen(function* () {
    const directory = yield* temporaryDirectory;
    yield* initialized(directory);
    yield* opened(catalogDbLayer(directory));
    yield* opened(guidanceDbLayer(directory));
    yield* opened(policyDbLayer(directory));
  }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)), { timeout: 20_000 });

  it.live("the stored format reads as the same number whatever integer mode the caller runs in", () => Effect.gen(function* () {
    const directory = yield* temporaryDirectory;
    yield* initialized(directory);
    const { sql } = yield* openUpgradeDatabase(directory, "guidance", { create: false });
    // the mode a backup snapshot reads its rows in: other statements see exact bigints
    const exact = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.provideService(effect, SqlClient.SafeIntegers, true);
    const [row] = yield* exact(sql.unsafe<{one: unknown}>("SELECT 1 AS one"));
    assert.equal(typeof row?.one, "bigint");
    assert.equal(yield* exact(readFormat(sql)), 1);
    assert.equal(yield* readFormat(sql), 1);
  }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)), { timeout: 20_000 });

  it.live("a negative user_version is no format: the open and the startup upgrade refuse the file and leave it as it is", () => Effect.gen(function* () {
    const directory = yield* temporaryDirectory;
    yield* initialized(directory);
    const path = join(directory, "guidance.sqlite3");
    raw(path, "PRAGMA user_version=-1;");
    const error = yield* refusal(guidanceDbLayer(directory));
    assert.deepEqual([error.reason, error.found], ["open_failed", undefined]);
    const failure = yield* Effect.flip(upgradeDataDirectory({ dataDirectory: directory, excludedThreadIds: [] }));
    assert.deepEqual([failure.file, failure.reason], ["guidance.sqlite3", "unreadable"]);
    assert.equal(existsSync(join(directory, "backups")), false);
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      assert.equal(sqliteRow(db, UserVersionRow, "PRAGMA user_version").user_version, -1);
    } finally {
      db.close();
    }
  }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)), { timeout: 20_000 });

  it.live("the access client refuses an older or newer access database before its pragmas", () => Effect.gen(function* () {
    const directory = yield* temporaryDirectory;
    const older = join(directory, "older.sqlite3");
    const newer = join(directory, "newer.sqlite3");
    raw(older, legacyAccess);
    raw(newer, `${legacyAccess} PRAGMA user_version=2;`);
    const olderError = yield* refusal(accessDbLayer(older));
    const newerError = yield* refusal(accessDbLayer(newer));
    assert.deepEqual([olderError.reason, olderError.found], ["upgrade_required", 0]);
    assert.deepEqual([newerError.reason, newerError.found], ["unsupported_format", 2]);
  }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)), { timeout: 20_000 });

  it.live("the forge refuses a format 0 access database and does not migrate it", () => Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* temporaryDirectory;
    const access = join(directory, "access");
    yield* fs.makeDirectory(access, { mode: 0o700 });
    const path = join(access, "login.sqlite3");
    raw(path, legacyAccess);
    yield* fs.chmod(path, 0o600);
    const before = sha256(path);
    const failure = yield* Effect.flip(forgeDashboardToken(directory));
    assert.equal(failure.reason, "login_grant_state");
    assert.equal(sha256(path), before);
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      assert.equal(sqliteRow(db, UserVersionRow, "PRAGMA user_version").user_version, 0);
      assert.equal(sqliteRow(db, CountRow, "SELECT count(*) AS n FROM dashboard_login_grants").n, 0);
    } finally {
      db.close();
    }
  }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)), { timeout: 20_000 });
});
