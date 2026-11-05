import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { NodeFileSystem } from "@effect/platform-node";
import { describe, it } from "@effect/vitest";
import { Effect, Exit, FileSystem } from "effect";
import {
  catalogContract, catalogLegacy, catalogMigrations, guidanceContract, guidanceLegacy, guidanceMigrations, type MigrationStep, missingSchema,
  policyMigrations, recognizeLegacy,
} from "../src/database-migrations.js";
import { DatabaseUpgradeError, upgradeDataDirectory } from "../src/database-upgrade.js";
import { type DatabaseKind, openUpgradeDatabase, readOnlyDatabase } from "../src/db.js";
import { initializeDataDirectory } from "./support/data-directory.js";

/*
 * the format steps and the live schema contracts (src/database-migrations.ts) on real files: what the stores' constructors used to
 * do at every open now happens once, in the step's transaction. The format 0 inputs are written literally (test input), never
 * with today's statements.
 */

const temporaryDirectory = Effect.flatMap(FileSystem.FileSystem, (fs) => fs.makeTempDirectoryScoped({ prefix: "t3-supervisor-migrations-" }));

const exec = (path: string, statements: string) => {
  const db = new DatabaseSync(path);
  try {
    db.exec(statements);
  } finally {
    db.close();
  }
};

const query = (path: string, sql: string): ReadonlyArray<Record<string, unknown>> => {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db.prepare(sql).all().map((row) => ({ ...row }));
  } finally {
    db.close();
  }
};

const schemaText = (path: string) => query(path, "SELECT type, name, sql FROM sqlite_master ORDER BY type, name");

// one step on the file through the startup upgrade's client, in one transaction, as the coordinator runs it
const applyStep = (directory: string, kind: DatabaseKind, step: MigrationStep | undefined, fresh = false) => Effect.scoped(Effect.gen(function* () {
  assert.ok(step !== undefined && step.from === 0 && step.to === 1);
  const { sql } = yield* openUpgradeDatabase(directory, kind, { create: false });
  yield* sql.withTransaction(step.apply(sql, { fresh, excludedThreadIds: ["seed"] }));
}));

/*
 * the guidance store's own tables as the first releases created them, in the file's first transaction (episodes and notices
 * without the columns later releases added)
 */
const guidanceCore = `
  CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
  CREATE TABLE rules(id TEXT PRIMARY KEY,document TEXT NOT NULL);
  CREATE TABLE mutes(rule_id TEXT NOT NULL,scope_id TEXT NOT NULL,PRIMARY KEY(rule_id,scope_id));
  CREATE TABLE classifications(project_id TEXT PRIMARY KEY,classification TEXT NOT NULL);
  CREATE TABLE observations(thread_id TEXT PRIMARY KEY,hash TEXT NOT NULL,observed_at INTEGER NOT NULL);
  CREATE TABLE episodes(thread_id TEXT NOT NULL,rule_id TEXT NOT NULL,epoch INTEGER NOT NULL DEFAULT 0,notified INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(thread_id,rule_id));
  CREATE TABLE notices(id TEXT PRIMARY KEY,thread_id TEXT NOT NULL,rule_id TEXT NOT NULL,run_id TEXT NOT NULL,epoch INTEGER NOT NULL,state TEXT NOT NULL,
    text TEXT NOT NULL,message_id TEXT,created_at INTEGER NOT NULL,dispatch_started INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE activity(id TEXT PRIMARY KEY,document TEXT NOT NULL,created_at INTEGER NOT NULL);
  CREATE TABLE budget(day TEXT PRIMARY KEY,tokens INTEGER NOT NULL);
  CREATE INDEX activity_notice ON activity(json_extract(document,'$.noticeId'),created_at);
`;

// a guidance file from before the later columns were added (tables as their first releases created them)
const olderGuidance = (path: string) => exec(path, `
  PRAGMA journal_mode=WAL;
  ${guidanceCore}
  INSERT INTO meta VALUES('settings','{"generation":2,"evidenceHours":24}'),('supervisor_scope_version','main-v1');
  INSERT INTO notices VALUES('notice-1','thread','rule','run',0,'uncertain','text',NULL,1,1);
  CREATE TABLE supervisor_definition_user_saves(project_id TEXT NOT NULL,workspace_root TEXT NOT NULL,signature TEXT NOT NULL,saved_at INTEGER NOT NULL,
    PRIMARY KEY(project_id,workspace_root));
  INSERT INTO supervisor_definition_user_saves VALUES('project','/work','signature',1);
  CREATE TABLE supervisor_monitor_binding_clock(supervisor_thread_id TEXT PRIMARY KEY,last_notice_at INTEGER NOT NULL);
  INSERT INTO supervisor_monitor_binding_clock VALUES('supervisor',5);
  CREATE TABLE supervisor_monitor_threads(project_id TEXT NOT NULL,thread_id TEXT NOT NULL,source_ordinal INTEGER NOT NULL,saturated INTEGER NOT NULL DEFAULT 0,
    saturation_at INTEGER,last_acknowledged_at INTEGER,PRIMARY KEY(project_id, thread_id));
  INSERT INTO supervisor_monitor_threads(project_id,thread_id,source_ordinal) VALUES('project','thread',7);
  CREATE TABLE supervisor_monitor_items(project_id TEXT NOT NULL,thread_id TEXT NOT NULL,item_id TEXT NOT NULL,type TEXT NOT NULL,status TEXT NOT NULL,
    ordinal INTEGER NOT NULL,detected_at INTEGER NOT NULL,version TEXT NOT NULL,priority TEXT,eligible INTEGER NOT NULL,reviewed_version TEXT,
    updated_at INTEGER NOT NULL,PRIMARY KEY(project_id, thread_id, item_id));
  INSERT INTO supervisor_monitor_items VALUES('project','thread','item','message','open',1,2,'v1',NULL,1,NULL,3);
`);

const catalogTables = `
  PRAGMA journal_mode=WAL;
  CREATE TABLE activations (environment_id TEXT PRIMARY KEY, activated_at INTEGER NOT NULL);
  CREATE TABLE environment_binding (id INTEGER PRIMARY KEY CHECK(id=1), environment_id TEXT NOT NULL);
  CREATE TABLE cursors (stream TEXT PRIMARY KEY CHECK(stream IN ('active', 'archive')), sequence INTEGER NOT NULL);
  CREATE TABLE projects (id TEXT PRIMARY KEY, document TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE shell_coverage (id INTEGER PRIMARY KEY CHECK(id=1), sequence INTEGER NOT NULL);
  CREATE TABLE threads (id TEXT PRIMARY KEY, project_id TEXT, document TEXT NOT NULL, location TEXT NOT NULL CHECK(location IN ('active', 'archive', 'removed')), revision INTEGER NOT NULL);
  CREATE TABLE thread_revisions (thread_id TEXT PRIMARY KEY, revision INTEGER NOT NULL);
  CREATE INDEX threads_project ON threads(project_id);
`;
const canonicalShell = '{"id":"thread-kept","title":"Kept","projectId":null,"lineage":{"parentThreadId":null,"relationshipToParent":null}}';

describe("format steps", () => {
  it.live("guidance format 1 adds every later column once, starting the activation ordinal at the source ordinal, and a second application changes nothing", () => Effect.gen(function* () {
    const directory = yield* temporaryDirectory;
    const path = join(directory, "guidance.sqlite3");
    olderGuidance(path);
    const recognized = yield* Effect.scoped(Effect.flatMap(readOnlyDatabase(directory, "guidance.sqlite3"), (sql) => recognizeLegacy(sql, guidanceContract, guidanceLegacy)));
    assert.deepEqual(recognized, { kind: "recognized" });
    yield* applyStep(directory, "guidance", guidanceMigrations[0]);
    assert.deepEqual(query(path, "SELECT rule_generation, settings_generation FROM notices"), [{ rule_generation: -1, settings_generation: -1 }]);
    assert.deepEqual(query(path, "SELECT expected_revision FROM supervisor_definition_user_saves"), [{ expected_revision: "" }]);
    assert.deepEqual(query(path, "SELECT review_misses FROM supervisor_monitor_binding_clock"), [{ review_misses: 0 }]);
    assert.deepEqual(query(path, "SELECT source_ordinal, activation_ordinal, untracked_count FROM supervisor_monitor_threads"),
      [{ source_ordinal: 7, activation_ordinal: 7, untracked_count: 0 }]);
    assert.deepEqual(query(path, "SELECT read_item_id, active FROM supervisor_monitor_items"), [{ read_item_id: null, active: 1 }]);
    assert.deepEqual(query(path, "SELECT object_id FROM episodes"), []);
    // the stored settings and scope are kept; the file now has the whole live schema
    assert.deepEqual(query(path, "SELECT key, value FROM meta ORDER BY key"), [
      { key: "settings", value: '{"generation":2,"evidenceHours":24}' }, { key: "supervisor_scope_version", value: "main-v1" },
    ]);
    const missing = yield* Effect.scoped(Effect.flatMap(readOnlyDatabase(directory, "guidance.sqlite3"), (sql) => missingSchema(sql, guidanceContract)));
    assert.deepEqual(missing, []);
    const once = { schema: schemaText(path), monitor: query(path, "SELECT * FROM supervisor_monitor_threads") };
    yield* applyStep(directory, "guidance", guidanceMigrations[0]);
    assert.deepEqual({ schema: schemaText(path), monitor: query(path, "SELECT * FROM supervisor_monitor_threads") }, once);
  }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)), { timeout: 30_000 });

  it.live("catalog format 1 rewrites stored shells through the whitelist once, leaving a whitelisted shell byte for byte", () => Effect.gen(function* () {
    const directory = yield* temporaryDirectory;
    const path = join(directory, "catalog.sqlite3");
    exec(path, `${catalogTables}
      INSERT INTO threads VALUES ('thread-kept', NULL, '${canonicalShell}', 'active', 1);
      INSERT INTO threads VALUES ('thread-trimmed', NULL, '{"id":"thread-trimmed","title":"Trimmed","lineage":{},"privateNativeField":"dropped"}', 'archive', 2);
    `);
    yield* applyStep(directory, "catalog", catalogMigrations[0]);
    assert.deepEqual(query(path, "SELECT id, document FROM threads ORDER BY id"), [
      { id: "thread-kept", document: canonicalShell },
      { id: "thread-trimmed", document: '{"id":"thread-trimmed","title":"Trimmed","projectId":null,"lineage":{"parentThreadId":null,"relationshipToParent":null}}' },
    ]);
  }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)), { timeout: 30_000 });

  it.live("an unreadable stored shell fails the catalog step: the upgrade rolls the file back and refuses", () => Effect.gen(function* () {
    const directory = yield* temporaryDirectory;
    const path = join(directory, "catalog.sqlite3");
    exec(path, `${catalogTables}
      INSERT INTO threads VALUES ('thread-kept', NULL, '${canonicalShell}', 'active', 1);
      INSERT INTO threads VALUES ('thread-broken', NULL, '{"id":"thread-broken"}', 'active', 1);
    `);
    exec(join(directory, "thread-settings.sqlite3"), `PRAGMA journal_mode=WAL; CREATE TABLE settings(id INTEGER PRIMARY KEY CHECK(id=1),document TEXT NOT NULL);
      INSERT INTO settings VALUES(1,'{"generation":4,"excludedThreadIds":[]}');`);
    const before = { schema: schemaText(path), rows: query(path, "SELECT * FROM threads ORDER BY id") };
    const exit = yield* Effect.exit(upgradeDataDirectory({ dataDirectory: directory, excludedThreadIds: [] }));
    assert.ok(Exit.isFailure(exit));
    const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail");
    assert.ok(failure?._tag === "Fail" && failure.error instanceof DatabaseUpgradeError);
    assert.deepEqual([failure.error.file, failure.error.reason], ["catalog.sqlite3", "migration_failed"]);
    assert.deepEqual({ schema: schemaText(path), rows: query(path, "SELECT * FROM threads ORDER BY id") }, before);
    assert.deepEqual(query(path, "PRAGMA user_version"), [{ user_version: 0 }]);
  }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)), { timeout: 30_000 });

  it.live("the policy step seeds only a fresh file and never an existing one without its row", () => Effect.gen(function* () {
    const fresh = yield* temporaryDirectory;
    exec(join(fresh, "thread-settings.sqlite3"), "");
    yield* applyStep(fresh, "policy", policyMigrations[0], true);
    assert.deepEqual(query(join(fresh, "thread-settings.sqlite3"), "SELECT document FROM settings"), [{ document: '{"generation":1,"excludedThreadIds":["seed"]}' }]);

    const existing = yield* temporaryDirectory;
    exec(join(existing, "thread-settings.sqlite3"), "CREATE TABLE settings(id INTEGER PRIMARY KEY CHECK(id=1),document TEXT NOT NULL);");
    const refused = yield* Effect.flip(applyStep(existing, "policy", policyMigrations[0]));
    assert.deepEqual([refused._tag, "table" in refused ? refused.table : null], ["MigrationRefused", "settings"]);
    assert.deepEqual(query(join(existing, "thread-settings.sqlite3"), "SELECT count(*) AS n FROM settings"), [{ n: 0 }]);
  }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)), { timeout: 30_000 });
});

describe("live schema and recognized layouts", () => {
  it.live("a current file missing part of its live schema is incomplete, and the upgrade refuses it", () => Effect.gen(function* () {
    const directory = yield* temporaryDirectory;
    yield* initializeDataDirectory(directory);
    exec(join(directory, "catalog.sqlite3"), "DROP INDEX threads_project; ALTER TABLE cursors DROP COLUMN sequence;");
    const missing = yield* Effect.scoped(Effect.flatMap(readOnlyDatabase(directory, "catalog.sqlite3"), (sql) => missingSchema(sql, catalogContract)));
    assert.deepEqual(missing, ["cursors.sequence", "index:threads_project"]);
    const exit = yield* Effect.exit(upgradeDataDirectory({ dataDirectory: directory, excludedThreadIds: [] }));
    assert.ok(Exit.isFailure(exit));
    const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail");
    assert.ok(failure?._tag === "Fail" && failure.error instanceof DatabaseUpgradeError);
    assert.deepEqual([failure.error.file, failure.error.reason], ["catalog.sqlite3", "incomplete_schema"]);
  }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)), { timeout: 30_000 });

  it.live("format 0 layouts: table-less is empty, a release's first transaction with later and historical tables is recognized, anything else is unknown", () => Effect.gen(function* () {
    const recognition = (file: "guidance.sqlite3" | "catalog.sqlite3", statements: string) => Effect.gen(function* () {
      const directory = yield* temporaryDirectory;
      exec(join(directory, file), statements);
      const contract = file === "catalog.sqlite3" ? catalogContract : guidanceContract;
      const legacy = file === "catalog.sqlite3" ? catalogLegacy : guidanceLegacy;
      return yield* Effect.scoped(Effect.flatMap(readOnlyDatabase(directory, file), (sql) => recognizeLegacy(sql, contract, legacy)));
    });
    const guidance = (statements: string) => recognition("guidance.sqlite3", statements);
    const catalog = (statements: string) => recognition("catalog.sqlite3", statements);
    assert.deepEqual(yield* guidance(""), { kind: "empty" });
    // a run that stopped after the guidance store's own transaction, then the same with a later and a historical table
    assert.deepEqual(yield* guidance(guidanceCore), { kind: "recognized" });
    assert.deepEqual(yield* guidance(`${guidanceCore} CREATE TABLE supervisor_owned_threads(id TEXT PRIMARY KEY);
      CREATE TABLE supervisor_project_bindings(project_id TEXT PRIMARY KEY,document TEXT NOT NULL);`), { kind: "recognized" });
    // part of that first transaction is missing: no release wrote such a file, so it is not repaired into one
    assert.deepEqual(yield* guidance("CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE supervisor_owned_threads(id TEXT PRIMARY KEY);"),
      { kind: "unknown", object: "rules" });
    assert.deepEqual(yield* guidance(guidanceCore.replace(/CREATE INDEX activity_notice[^;]*;/u, "")), { kind: "unknown", object: "activity_notice" });
    assert.deepEqual(yield* guidance(`${guidanceCore} CREATE INDEX someone_elses ON meta(value);`), { kind: "unknown", object: "someone_elses" });
    assert.deepEqual(yield* guidance("CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL,extra TEXT);"), { kind: "unknown", object: "meta" });
    assert.deepEqual(yield* guidance("CREATE TABLE meta(key TEXT PRIMARY KEY);"), { kind: "unknown", object: "meta" });
    assert.deepEqual(yield* guidance("CREATE TABLE constructor(id TEXT);"), { kind: "unknown", object: "constructor" });
    assert.deepEqual(yield* guidance(`${guidanceCore} CREATE VIEW recent AS SELECT key FROM meta;`), { kind: "unknown", object: "recent" });
    // the catalog schema is one transaction; only shell_coverage came with a later release
    assert.deepEqual(yield* catalog(catalogTables), { kind: "recognized" });
    assert.deepEqual(yield* catalog(catalogTables.replace(/CREATE TABLE shell_coverage[^;]*;/u, "")), { kind: "recognized" });
    assert.deepEqual(yield* catalog(catalogTables.replace(/CREATE TABLE thread_revisions[^;]*;/u, "")), { kind: "unknown", object: "thread_revisions" });
  }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)), { timeout: 30_000 });
});
