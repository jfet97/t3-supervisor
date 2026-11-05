import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { NodeFileSystem } from "@effect/platform-node";
import { describe, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, FileSystem } from "effect";
import { SqlError } from "effect/sql/SqlError";
import { DatabaseWorker, type DatabaseWorkerEntry, openUpgradeDatabase } from "../src/db.js";

// the online backup of the database worker (src/db.ts, src/db-worker-serve.ts) on real worker threads and real files. The
// worker leases its one connection for its whole life, so the stock client's own backup (which leases the connection again)
// could never run there; the backup request runs the connection's SQLite backup inside the worker's one-request-at-a-time
// permit while the main thread holds the client's lease, so it neither deadlocks nor interleaves with another fiber's
// transaction, and a worker that stops during it poisons the client like any statement in flight.

const directory = Effect.flatMap(FileSystem.FileSystem, (fs) => fs.makeTempDirectoryScoped({ prefix: "t3-supervisor-db-backup-" }));

// the committed rows of a backup file, read with a connection of this thread
const copiedRows = (path: string): ReadonlyArray<string> => {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const integrity = db.prepare("PRAGMA integrity_check").all() as ReadonlyArray<{ integrity_check: string }>;
    assert.deepEqual(integrity.map((row) => row.integrity_check), ["ok"]);
    return (db.prepare("SELECT v FROM t ORDER BY id").all() as ReadonlyArray<{ v: string }>).map((row) => row.v);
  } finally {
    db.close();
  }
};

const isConnectionLoss = (error: unknown, message: string) =>
  error instanceof SqlError && error.reason._tag === "ConnectionError" && error.reason.message === message;

describe("database worker backup", () => {
  it.live("copies the committed database, the write-ahead log included, through the worker's own leased connection", () => Effect.gen(function* () {
    const root = yield* directory;
    const { sql, backup } = yield* openUpgradeDatabase(root, "catalog", { create: true });
    yield* sql.unsafe("PRAGMA journal_mode=WAL");
    // rows committed into the log and not yet checkpointed into the main file
    yield* sql.unsafe("PRAGMA wal_autocheckpoint=0");
    yield* sql.withTransaction(Effect.gen(function* () {
      yield* sql.unsafe("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
      yield* sql.unsafe("INSERT INTO t (v) VALUES ('first'), ('second')");
    }));
    yield* sql.withTransaction(sql.unsafe("INSERT INTO t (v) VALUES ('in the log')"));
    const destination = join(root, "copy.sqlite3");
    const metadata = yield* backup(destination);
    assert.equal(metadata.remainingPages, 0);
    assert.ok(metadata.totalPages > 0);
    assert.deepEqual(copiedRows(destination), ["first", "second", "in the log"]);
    // the client is still usable after the backup, and a second backup sees later commits
    yield* sql.withTransaction(sql.unsafe("INSERT INTO t (v) VALUES ('later')"));
    const again = join(root, "copy-again.sqlite3");
    yield* backup(again);
    assert.deepEqual(copiedRows(again), ["first", "second", "in the log", "later"]);
  }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)), { timeout: 20_000 });

  it.live("waits for another fiber's transaction and never copies what it did not commit", () => Effect.gen(function* () {
    const root = yield* directory;
    const { sql, backup } = yield* openUpgradeDatabase(root, "catalog", { create: true });
    yield* sql.withTransaction(Effect.gen(function* () {
      yield* sql.unsafe("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
      yield* sql.unsafe("INSERT INTO t (v) VALUES ('committed')");
    }));
    const inserted = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    // a transaction of another fiber that has written and then rolls back
    const writer = yield* Effect.forkChild(Effect.flip(sql.withTransaction(Effect.gen(function* () {
      yield* sql.unsafe("INSERT INTO t (v) VALUES ('rolled back')");
      yield* Deferred.succeed(inserted, undefined);
      yield* Deferred.await(release);
      return yield* Effect.fail("abandoned" as const);
    }))));
    yield* Deferred.await(inserted);
    const destination = join(root, "copy.sqlite3");
    const copying = yield* Effect.forkChild(backup(destination));
    // the backup cannot start while the writer holds the client's lease
    yield* Effect.yieldNow;
    assert.equal(copying.pollUnsafe(), undefined, "the backup waited for the writer's transaction");
    yield* Deferred.succeed(release, undefined);
    assert.equal(yield* Fiber.join(writer), "abandoned");
    yield* Fiber.join(copying);
    assert.deepEqual(copiedRows(destination), ["committed"]);
  }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)), { timeout: 20_000 });

  it.live("a backup requested inside the caller's own transaction fails at once, and the client stays usable", () => Effect.gen(function* () {
    const root = yield* directory;
    const { sql, backup } = yield* openUpgradeDatabase(root, "catalog", { create: true });
    yield* sql.unsafe("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    const destination = join(root, "copy.sqlite3");
    const failure = yield* Effect.flip(sql.withTransaction(Effect.andThen(sql.unsafe("INSERT INTO t (v) VALUES ('inside')"), backup(destination))));
    assert.ok(failure instanceof SqlError);
    assert.equal(failure.reason._tag, "UnknownError");
    const fs = yield* FileSystem.FileSystem;
    assert.equal(yield* fs.exists(destination), false);
    // the transaction rolled back and the connection takes the next one
    yield* sql.withTransaction(sql.unsafe("INSERT INTO t (v) VALUES ('after')"));
    const rows = yield* sql.unsafe<{ readonly v: string }>("SELECT v FROM t ORDER BY id");
    assert.deepEqual(rows.map((row) => row.v), ["after"]);
  }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)), { timeout: 20_000 });

  it.live("a worker that stops during a backup poisons the client: the backup's outcome is unknown and nothing is sent again", () => Effect.gen(function* () {
    const root = yield* directory;
    const entry: DatabaseWorkerEntry = { url: new URL("./support/db-worker-backup-exit.ts", import.meta.url), execArgv: ["--import", import.meta.resolve("tsx")] };
    const { sql, backup } = yield* openUpgradeDatabase(root, "catalog", { create: true }).pipe(Effect.provideService(DatabaseWorker, entry));
    yield* sql.unsafe("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    const lost = yield* Effect.flip(backup(join(root, "copy.sqlite3")));
    assert.ok(isConnectionLoss(lost, "The database worker stopped; a statement in flight has an unknown outcome"), String(lost));
    const later = yield* Effect.flip(sql.unsafe("SELECT 1"));
    assert.ok(isConnectionLoss(later, "The database worker stopped; a statement in flight has an unknown outcome"), String(later));
  }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)), { timeout: 20_000 });
});
