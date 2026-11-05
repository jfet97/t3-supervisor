import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { NodeFileSystem } from "@effect/platform-node";
import { describe, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Schema } from "effect";
import { guidanceMigrations } from "../src/database-migrations.js";
import { GuidanceDb, openUpgradeDatabase } from "../src/db.js";
import { GuidanceStore } from "../src/guidance-store.js";
import { SupervisorStateReset, type SupervisorStateResetShape } from "../src/supervisor-state-reset.js";
import { guidanceDb, rows, sequentialIds, temporaryDirectory } from "./support/guidance-store-services.js";
import { sqliteRow } from "./support/sqlite-rows.js";

/* The approved one-time reset of the project-scoped prototype is part of the guidance format 1 step (src/database-migrations.ts):
 * a format 0 file without a stored scope version has its disposable prototype state cleared and main-v1 recorded, in the step's
 * transaction; a stored version is kept as it is. The SupervisorStateReset service on a current file only reads the scope
 * (an unknown one disables supervision without touching anything) and keeps the test reset, which joins the caller's
 * transaction.
 */

const layer = (directory: string) => SupervisorStateReset.layer.pipe(Layer.provideMerge(GuidanceStore.layer), Layer.provideMerge(guidanceDb(directory)),
  Layer.provide(sequentialIds()));

const withReset = <A, E>(directory: string, use: (reset: SupervisorStateResetShape, db: GuidanceDb["Service"]) => Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    return yield* use(yield* SupervisorStateReset, yield* GuidanceDb);
  }).pipe(Effect.provide(layer(directory)));

const tableDigest = (db: GuidanceDb["Service"]) => Effect.gen(function* () {
  const hash = createHash("sha256");
  for (const { name } of yield* rows(db, "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"))
    hash.update(`${String(name)}\0${JSON.stringify(yield* rows(db, `SELECT * FROM "${String(name)}" ORDER BY rowid`))}\0`);
  return hash.digest("hex");
});

const count = (db: GuidanceDb["Service"], table: string) => Effect.map(rows(db, `SELECT count(*) AS n FROM ${table}`), ([row]) => Number(row?.n));

/*
 * a format 0 guidance file with disposable supervision state in tables the reset clears, beside permanent ownership, the
 * default settings and a table outside the reset's list (literal statements, not today's schema); the step is applied to it
 * directly, since which files the upgrade accepts is database-migrations.test.ts's subject
 */
const legacyGuidance = (path: string, scopeVersion: string | null) => Effect.sync(() => {
  const db = new DatabaseSync(path);
  try {
    db.exec(`
      CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      INSERT INTO meta VALUES('settings','{"generation":3,"evidenceHours":24}');
      INSERT INTO meta VALUES('supervisor_activation_baseline','{}'),('supervisor_activation_sequence','4'),('supervisor_model:p','chosen-default');
      CREATE TABLE supervisor_owned_threads(id TEXT PRIMARY KEY);
      INSERT INTO supervisor_owned_threads VALUES('owned-supervisor');
      CREATE TABLE unrelated_delivery(id TEXT);
      INSERT INTO unrelated_delivery VALUES('retained');
      CREATE TABLE supervisor_task_interpretations(thread_id TEXT PRIMARY KEY,project_id TEXT NOT NULL,document TEXT NOT NULL,updated_at INTEGER NOT NULL);
      INSERT INTO supervisor_task_interpretations VALUES('task','p','{}',1);
      CREATE TABLE supervisor_main_bindings(project_id TEXT NOT NULL,main_thread_id TEXT NOT NULL,document TEXT NOT NULL,PRIMARY KEY(project_id,main_thread_id));
      INSERT INTO supervisor_main_bindings VALUES('p','main','{"threadId":"supervisor"}');
      CREATE TABLE supervisor_conversation_requests(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,document TEXT NOT NULL,created_at INTEGER NOT NULL);
      INSERT INTO supervisor_conversation_requests VALUES('request','p','{}',1);
      CREATE TABLE supervisor_monitor_binding_clock(supervisor_thread_id TEXT PRIMARY KEY,last_notice_at INTEGER NOT NULL,review_misses INTEGER NOT NULL DEFAULT 0);
      INSERT INTO supervisor_monitor_binding_clock VALUES('owned-supervisor',1,0);
    `);
    if (scopeVersion !== null) db.prepare("INSERT INTO meta VALUES('supervisor_scope_version',?)").run(scopeVersion);
  } finally {
    db.close();
  }
});

// the guidance format 1 step on the raw file, in one transaction, as the startup upgrade runs it
const applyFormat1 = (directory: string) => Effect.scoped(Effect.gen(function* () {
  const { sql } = yield* openUpgradeDatabase(directory, "guidance", { create: false });
  const [step] = guidanceMigrations;
  assert.ok(step !== undefined && step.from === 0 && step.to === 1);
  yield* sql.withTransaction(step.apply(sql, { policy: { kind: "none" }, creating: false }));
  const read = (query: string) => sql.unsafe<Record<string, unknown>>(query).pipe(Effect.map((result) => result.map((row) => ({ ...row }))));
  return {
    cleared: yield* Effect.forEach(["supervisor_task_interpretations", "supervisor_main_bindings", "supervisor_conversation_requests", "supervisor_monitor_binding_clock"],
      (table) => Effect.map(read(`SELECT count(*) AS n FROM ${table}`), ([row]) => Number(row?.n))),
    owned: yield* read("SELECT id FROM supervisor_owned_threads"),
    unrelated: yield* read("SELECT id FROM unrelated_delivery"),
    meta: yield* read("SELECT key,value FROM meta WHERE key<>'settings' ORDER BY key"),
    settings: yield* read("SELECT value FROM meta WHERE key='settings'"),
  };
}));

const rawDirectory = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.makeTempDirectoryScoped({ prefix: "t3-supervisor-scope-reset-" });
}).pipe(Effect.provide(NodeFileSystem.layer));

describe("SupervisorStateReset", () => {
  it.live("the format 1 step clears the disposable supervision state once and records main-v1, preserving unrelated state", () => Effect.gen(function* () {
    const directory = yield* rawDirectory;
    yield* legacyGuidance(join(directory, "guidance.sqlite3"), null);
    const first = yield* applyFormat1(directory);
    assert.deepEqual(first.cleared, [0, 0, 0, 0]);
    assert.deepEqual(first.owned, [{ id: "owned-supervisor" }]);
    assert.deepEqual(first.unrelated, [{ id: "retained" }]);
    assert.deepEqual(first.meta, [{ key: "supervisor_model:p", value: "chosen-default" }, { key: "supervisor_scope_version", value: "main-v1" }]);
    // the stored settings row is kept as it is, never replaced by the default
    assert.deepEqual(first.settings, [{ value: "{\"generation\":3,\"evidenceHours\":24}" }]);
  }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)), { timeout: 10_000 });

  it.live("the step's reset is atomic: a failed scope version insert leaves every cleared row and table as it was, and the next start resets", () => Effect.gen(function* () {
    const directory = yield* rawDirectory;
    const path = join(directory, "guidance.sqlite3");
    yield* legacyGuidance(path, null);
    const counts = () => {
      const db = new DatabaseSync(path, { readOnly: true });
      try {
        return ["supervisor_task_interpretations", "supervisor_main_bindings", "supervisor_conversation_requests", "meta"].map((table) =>
          sqliteRow(db, Schema.Struct({ n: Schema.Number }), `SELECT count(*) AS n FROM ${table}`).n);
      } finally {
        db.close();
      }
    };
    const raw = new DatabaseSync(path);
    raw.exec("CREATE TRIGGER refuse_scope BEFORE INSERT ON meta WHEN NEW.key='supervisor_scope_version' BEGIN SELECT RAISE(ABORT, 'refused'); END;");
    raw.close();
    const before = counts();
    yield* Effect.flip(applyFormat1(directory));
    assert.deepEqual(counts(), before);
    const tables = new DatabaseSync(path, { readOnly: true });
    assert.equal(sqliteRow(tables, Schema.Struct({ n: Schema.Number }), "SELECT count(*) AS n FROM sqlite_master WHERE name='rules'").n, 0, "the step's tables rolled back too");
    tables.close();
    const writable = new DatabaseSync(path);
    writable.exec("DROP TRIGGER refuse_scope;");
    writable.close();
    const applied = yield* applyFormat1(directory);
    assert.deepEqual(applied.cleared, [0, 0, 0, 0]);
    assert.ok(applied.meta.some((row) => row.key === "supervisor_scope_version" && row.value === "main-v1"));
  }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)), { timeout: 10_000 });

  it.live("a stored scope version, known or unknown, is kept and nothing is cleared", () => Effect.gen(function* () {
    for (const version of ["main-v1", "future"]) {
      const directory = yield* rawDirectory;
      yield* legacyGuidance(join(directory, "guidance.sqlite3"), version);
      const applied = yield* applyFormat1(directory);
      assert.deepEqual(applied.cleared, [1, 1, 1, 1], version);
      assert.ok(applied.meta.some((row) => row.key === "supervisor_scope_version" && row.value === version), version);
      assert.ok(applied.meta.some((row) => row.key === "supervisor_activation_sequence"), version);
    }
  }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)), { timeout: 10_000 });

  it.live("on a current file the scope check reads main-v1 as compatible and an unknown version as incompatible, changing nothing", () => Effect.gen(function* () {
    const directory = yield* temporaryDirectory;
    const observed = yield* withReset(directory, (reset, db) => Effect.gen(function* () {
      const compatible = yield* reset.scopeCompatible();
      yield* db.unsafe("UPDATE meta SET value='future' WHERE key='supervisor_scope_version'");
      const before = yield* tableDigest(db);
      return { compatible, unknown: yield* reset.scopeCompatible(), unchanged: before === (yield* tableDigest(db)) };
    }));
    assert.deepEqual(observed, { compatible: true, unknown: false, unchanged: true });
  }), { timeout: 10_000 });

  it.live("the test reset joins the caller's transaction and rolls back with it", () => Effect.gen(function* () {
    const directory = yield* temporaryDirectory;
    const observed = yield* withReset(directory, (reset, db) => Effect.gen(function* () {
      yield* db.unsafe("INSERT INTO supervisor_main_bindings VALUES('p','main','{\"threadId\":\"supervisor\"}')");
      yield* db.unsafe("INSERT INTO meta VALUES('supervisor_activation_sequence','4')");
      const before = yield* tableDigest(db);
      const failed = yield* Effect.flip(db.withTransaction(Effect.gen(function* () {
        yield* reset.resetSupervisorTestState();
        assert.equal(yield* count(db, "supervisor_main_bindings"), 0);
        return yield* Effect.fail("caller failed" as const);
      })));
      return { failed, unchanged: before === (yield* tableDigest(db)), retained: yield* count(db, "supervisor_main_bindings") };
    }));
    assert.deepEqual(observed, { failed: "caller failed", unchanged: true, retained: 1 });
  }), { timeout: 10_000 });
});
