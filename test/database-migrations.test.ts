import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { NodeFileSystem } from "@effect/platform-node";
import { describe, it } from "@effect/vitest";
import { Effect, Exit, FileSystem } from "effect";
import {
  catalogLegacy, catalogMigrations, guidanceLegacy, guidanceMigrations, type MigrationStep, policyMigrations, recognizeLegacy, schemaDifferences,
  type SchemaSignature,
} from "../src/database-migrations.js";
import { DatabaseUpgradeError, referenceSignature, upgradeDataDirectory } from "../src/database-upgrade.js";
import { type DatabaseKind, openUpgradeDatabase, readOnlyDatabase } from "../src/db.js";

/*
 * the format steps and the declared schema (src/database-migrations.ts) on real files: what the stores' constructors used to do
 * at every open now happens once, in the step's transaction, and a file is recognized only with the declarations its format's
 * steps give an empty database. The format 0 inputs are written literally (test input), never with today's statements.
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

const recognition = (directory: string, file: "guidance.sqlite3" | "catalog.sqlite3", reference: SchemaSignature) =>
  Effect.scoped(Effect.flatMap(readOnlyDatabase(directory, file),
    (sql) => recognizeLegacy(sql, reference, file === "catalog.sqlite3" ? catalogLegacy : guidanceLegacy)));

const differences = (directory: string, file: string, reference: SchemaSignature) =>
  Effect.scoped(Effect.flatMap(readOnlyDatabase(directory, file), (sql) => schemaDifferences(sql, reference)));

const refusal = (exit: Exit.Exit<unknown, DatabaseUpgradeError>) => {
  assert.ok(Exit.isFailure(exit));
  const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail");
  assert.ok(failure?._tag === "Fail" && failure.error instanceof DatabaseUpgradeError);
  return [failure.error.file, failure.error.reason];
};

/*
 * the guidance store's own tables as every release declared them, in the file's first transaction (episodes and notices with
 * the columns that transaction added to their first declaration)
 */
const guidanceCore = `
  CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
  CREATE TABLE rules(id TEXT PRIMARY KEY,document TEXT NOT NULL);
  CREATE TABLE mutes(rule_id TEXT NOT NULL,scope_id TEXT NOT NULL,PRIMARY KEY(rule_id,scope_id));
  CREATE TABLE classifications(project_id TEXT PRIMARY KEY,classification TEXT NOT NULL);
  CREATE TABLE observations(thread_id TEXT PRIMARY KEY,hash TEXT NOT NULL,observed_at INTEGER NOT NULL);
  CREATE TABLE episodes(thread_id TEXT NOT NULL,rule_id TEXT NOT NULL,epoch INTEGER NOT NULL DEFAULT 0,
    notified INTEGER NOT NULL DEFAULT 0, object_id TEXT,PRIMARY KEY(thread_id,rule_id));
  CREATE TABLE notices(id TEXT PRIMARY KEY,thread_id TEXT NOT NULL,rule_id TEXT NOT NULL,run_id TEXT NOT NULL,
    epoch INTEGER NOT NULL,state TEXT NOT NULL,text TEXT NOT NULL,message_id TEXT,created_at INTEGER NOT NULL,
    dispatch_started INTEGER NOT NULL DEFAULT 0, rule_generation INTEGER NOT NULL DEFAULT -1, settings_generation INTEGER NOT NULL DEFAULT -1);
  CREATE TABLE activity(id TEXT PRIMARY KEY,document TEXT NOT NULL,created_at INTEGER NOT NULL);
  CREATE TABLE budget(day TEXT PRIMARY KEY,tokens INTEGER NOT NULL);
  CREATE INDEX activity_notice ON activity(json_extract(document,'$.noticeId'),created_at);
`;

// a guidance file whose run stopped after the guidance store's own transaction, with stored settings, scope and a notice
const firstTransactionGuidance = (path: string) => exec(path, `
  PRAGMA journal_mode=WAL;
  ${guidanceCore}
  INSERT INTO meta VALUES('settings','{"generation":2,"evidenceHours":24}'),('supervisor_scope_version','main-v1');
  INSERT INTO notices VALUES('notice-1','thread','rule','run',0,'uncertain','text',NULL,1,1,3,4);
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
  it.live("guidance format 1 completes a file its guidance store alone wrote with every later store's declared table, keeping every row; a second application changes nothing", () => Effect.gen(function* () {
    const directory = yield* temporaryDirectory;
    const path = join(directory, "guidance.sqlite3");
    firstTransactionGuidance(path);
    const reference = yield* referenceSignature("guidance");
    assert.deepEqual(yield* recognition(directory, "guidance.sqlite3", reference), { kind: "recognized" });
    const rows = () => ({ meta: query(path, "SELECT key, value FROM meta ORDER BY key"), notices: query(path, "SELECT * FROM notices") });
    const before = rows();
    assert.ok((yield* differences(directory, "guidance.sqlite3", reference)).includes("table:supervisor_team_members"));
    yield* applyStep(directory, "guidance", guidanceMigrations[0]);
    // the stored settings, scope and notice are kept as they were; the file now has the whole declared schema
    assert.deepEqual(rows(), before);
    assert.deepEqual(before.notices.map((notice) => [notice.rule_generation, notice.settings_generation]), [[3, 4]]);
    assert.deepEqual(yield* differences(directory, "guidance.sqlite3", reference), []);
    const once = schemaText(path);
    yield* applyStep(directory, "guidance", guidanceMigrations[0]);
    assert.deepEqual(schemaText(path), once);
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
    assert.deepEqual(refusal(yield* Effect.exit(upgradeDataDirectory({ dataDirectory: directory, excludedThreadIds: [] }))), ["catalog.sqlite3", "migration_failed"]);
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

describe("declared schema and recognized layouts", () => {
  it.live("a current file without part of its declared schema, or declaring a table differently under the same names, is incomplete and refused", () => Effect.gen(function* () {
    const reference = yield* referenceSignature("catalog");
    const missing = yield* temporaryDirectory;
    yield* upgradeDataDirectory({ dataDirectory: missing, excludedThreadIds: [] });
    exec(join(missing, "catalog.sqlite3"), "DROP INDEX threads_project; ALTER TABLE cursors DROP COLUMN sequence;");
    assert.deepEqual(yield* differences(missing, "catalog.sqlite3", reference), ["index:threads_project", "table:cursors"]);
    assert.deepEqual(refusal(yield* Effect.exit(upgradeDataDirectory({ dataDirectory: missing, excludedThreadIds: [] }))), ["catalog.sqlite3", "incomplete_schema"]);

    // the same table and column names without the primary key
    const redeclared = yield* temporaryDirectory;
    yield* upgradeDataDirectory({ dataDirectory: redeclared, excludedThreadIds: [] });
    exec(join(redeclared, "catalog.sqlite3"), "DROP TABLE thread_revisions; CREATE TABLE thread_revisions (thread_id TEXT, revision INTEGER NOT NULL);");
    assert.deepEqual(yield* differences(redeclared, "catalog.sqlite3", reference), ["table:thread_revisions"]);
    assert.deepEqual(refusal(yield* Effect.exit(upgradeDataDirectory({ dataDirectory: redeclared, excludedThreadIds: [] }))), ["catalog.sqlite3", "incomplete_schema"]);

    // a check whose literal differs only by a space inside the quotes: a different constraint, not a different layout
    const literal = yield* temporaryDirectory;
    yield* upgradeDataDirectory({ dataDirectory: literal, excludedThreadIds: [] });
    exec(join(literal, "catalog.sqlite3"), "DROP TABLE cursors; CREATE TABLE cursors (stream TEXT PRIMARY KEY CHECK(stream IN ('active', 'arc hive')), sequence INTEGER NOT NULL);");
    assert.deepEqual(yield* differences(literal, "catalog.sqlite3", reference), ["table:cursors"]);
    assert.deepEqual(refusal(yield* Effect.exit(upgradeDataDirectory({ dataDirectory: literal, excludedThreadIds: [] }))), ["catalog.sqlite3", "incomplete_schema"]);
  }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)), { timeout: 30_000 });

  it.live("format 0 layouts: table-less is empty, a release's declarations with its first transaction are recognized, anything else is unknown", () => Effect.gen(function* () {
    const references = { guidance: yield* referenceSignature("guidance"), catalog: yield* referenceSignature("catalog") };
    const recognized = (file: "guidance.sqlite3" | "catalog.sqlite3", statements: string) => Effect.gen(function* () {
      const directory = yield* temporaryDirectory;
      exec(join(directory, file), statements);
      return yield* recognition(directory, file, file === "catalog.sqlite3" ? references.catalog : references.guidance);
    });
    const guidance = (statements: string) => recognized("guidance.sqlite3", statements);
    const catalog = (statements: string) => recognized("catalog.sqlite3", statements);
    assert.deepEqual(yield* guidance(""), { kind: "empty" });
    // a run that stopped after the guidance store's own transaction, then the same with a later store's table
    assert.deepEqual(yield* guidance(guidanceCore), { kind: "recognized" });
    assert.deepEqual(yield* guidance(`${guidanceCore} CREATE TABLE supervisor_owned_threads(id TEXT PRIMARY KEY);`), { kind: "recognized" });
    // part of that first transaction is missing: no release wrote such a file, so it is not repaired into one
    assert.deepEqual(yield* guidance("CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE supervisor_owned_threads(id TEXT PRIMARY KEY);"),
      { kind: "unknown", object: "rules" });
    assert.deepEqual(yield* guidance(guidanceCore.replace(/CREATE INDEX activity_notice[^;]*;/u, "")), { kind: "unknown", object: "activity_notice" });
    // an object or a declaration no release wrote: an unknown index or table, a prototype table, a missing or extra column
    assert.deepEqual(yield* guidance(`${guidanceCore} CREATE INDEX someone_elses ON meta(value);`), { kind: "unknown", object: "someone_elses" });
    assert.deepEqual(yield* guidance(`${guidanceCore} CREATE TABLE supervisor_project_bindings(project_id TEXT PRIMARY KEY,document TEXT NOT NULL);`),
      { kind: "unknown", object: "supervisor_project_bindings" });
    assert.deepEqual(yield* guidance(`${guidanceCore} CREATE TABLE supervisor_monitor_binding_clock(supervisor_thread_id TEXT PRIMARY KEY,last_notice_at INTEGER NOT NULL);`),
      { kind: "unknown", object: "supervisor_monitor_binding_clock" });
    assert.deepEqual(yield* guidance(guidanceCore.replace(", object_id TEXT", "")), { kind: "unknown", object: "episodes" });
    assert.deepEqual(yield* guidance("CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL,extra TEXT);"), { kind: "unknown", object: "meta" });
    assert.deepEqual(yield* guidance("CREATE TABLE meta(key TEXT PRIMARY KEY);"), { kind: "unknown", object: "meta" });
    assert.deepEqual(yield* guidance("CREATE TABLE constructor(id TEXT);"), { kind: "unknown", object: "constructor" });
    assert.deepEqual(yield* guidance(`${guidanceCore} CREATE VIEW recent AS SELECT key FROM meta;`), { kind: "unknown", object: "recent" });
    // the catalog schema is one transaction; only shell_coverage came with a later release
    assert.deepEqual(yield* catalog(catalogTables), { kind: "recognized" });
    assert.deepEqual(yield* catalog(catalogTables.replace(/CREATE TABLE shell_coverage[^;]*;/u, "")), { kind: "recognized" });
    assert.deepEqual(yield* catalog(catalogTables.replace(/CREATE TABLE thread_revisions[^;]*;/u, "")), { kind: "unknown", object: "thread_revisions" });
    // the same names with another declaration: no primary key, no check constraint, an index on another column
    assert.deepEqual(yield* catalog(catalogTables.replace("threads (id TEXT PRIMARY KEY,", "threads (id TEXT,")), { kind: "unknown", object: "threads" });
    assert.deepEqual(yield* catalog(catalogTables.replace(" CHECK(stream IN ('active', 'archive'))", "")), { kind: "unknown", object: "cursors" });
    assert.deepEqual(yield* catalog(catalogTables.replace("ON threads(project_id)", "ON threads(document)")), { kind: "unknown", object: "threads_project" });
    // whitespace between tokens is layout, whitespace inside a quoted literal is data: another check, path or partial index
    assert.deepEqual(yield* catalog(catalogTables.replace("CHECK(stream IN ('active', 'archive'))", "CHECK(stream IN ('active', 'arc hive'))")),
      { kind: "unknown", object: "cursors" });
    assert.deepEqual(yield* catalog(catalogTables.replace("CHECK(location IN ('active', 'archive', 'removed'))", "CHECK(location IN ('act ive', 'archive', 'removed'))")),
      { kind: "unknown", object: "threads" });
    assert.deepEqual(yield* guidance(guidanceCore.replace("'$.noticeId'", "'$.notice Id'")), { kind: "unknown", object: "activity_notice" });
    // and the space between two words separates two tokens: a column named documentTEXT without a type is another column
    assert.deepEqual(yield* catalog(catalogTables.replace("document TEXT NOT NULL, deleted", "documentTEXT NOT NULL, deleted")), { kind: "unknown", object: "projects" });
    // a Unicode separator belongs to the identifier in SQLite, even though JavaScript treats it as whitespace
    assert.deepEqual(yield* catalog(catalogTables.replace("document TEXT NOT NULL, deleted", "document\u2000TEXT NOT NULL, deleted")), { kind: "unknown", object: "projects" });
    const members = (condition: string) => `${guidanceCore}
      CREATE TABLE supervisor_team_members(owner_thread_id TEXT NOT NULL,owner_generation INTEGER NOT NULL,member_thread_id TEXT NOT NULL,state TEXT NOT NULL,
        epoch INTEGER NOT NULL,document TEXT NOT NULL,PRIMARY KEY(owner_thread_id,owner_generation,member_thread_id));
      CREATE UNIQUE INDEX supervisor_team_member_identity ON supervisor_team_members(member_thread_id) WHERE ${condition};`;
    assert.deepEqual(yield* guidance(members("state<>'retired'")), { kind: "recognized" });
    assert.deepEqual(yield* guidance(members("state <> 'retired'")), { kind: "recognized" });
    assert.deepEqual(yield* guidance(members("state<>'ret ired'")), { kind: "unknown", object: "supervisor_team_member_identity" });
  }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)), { timeout: 30_000 });
});
