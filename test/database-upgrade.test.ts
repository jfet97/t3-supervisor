import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { NodeCrypto, NodeFileSystem } from "@effect/platform-node";
import { describe, it } from "@effect/vitest";
import { Effect, Exit, FileSystem, Layer, Schema } from "effect";
import { catalogContract, guidanceContract, policyContract, type SchemaContract } from "../src/database-migrations.js";
import { DatabaseUpgradeError, type UpgradeReport, upgradeDataDirectory } from "../src/database-upgrade.js";
import { guidanceDbLayer } from "../src/db.js";
import { GuidanceStore } from "../src/guidance-store.js";
import { SupervisorIds } from "../src/ids.js";
import { forgeDashboardToken } from "../src/service-auth.js";
import { fixtureShapes, materializeFixture, verifyFixtureIntegrity } from "./support/persistence-fixtures.js";
import { decodeJson, sqliteRow, sqliteRows } from "./support/sqlite-rows.js";

/*
 * the startup coordinator (src/database-upgrade.ts) on real files: a fresh directory, a repeated start, an interrupted
 * creation, the refusals that change nothing, the backup and upgrade of format 0 files with their rows preserved, a failure
 * between files and its resumption, two starts at once, and every frozen historical layout of test/fixtures/persistence
 * (released schema statements with synthetic rows). The format 0 inputs are written literally here or come from those
 * fixtures, never from today's schema statements.
 */

const temporaryDirectory = Effect.flatMap(FileSystem.FileSystem, (fs) => fs.makeTempDirectoryScoped({ prefix: "t3-supervisor-upgrade-" }));

const upgrade = (dataDirectory: string, excludedThreadIds: ReadonlyArray<string> = []) =>
  upgradeDataDirectory({ dataDirectory, excludedThreadIds });

const exec = (path: string, statements: string) => {
  const db = new DatabaseSync(path);
  try {
    db.exec(statements);
  } finally {
    db.close();
  }
};

const read = <A>(path: string, use: (db: DatabaseSync) => A): A => {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return use(db);
  } finally {
    db.close();
  }
};

const formatOf = (path: string): number => read(path, (db) => sqliteRow(db, Schema.Struct({ user_version: Schema.Number }), "PRAGMA user_version").user_version);
const journalOf = (path: string): string => read(path, (db) => sqliteRow(db, Schema.Struct({ journal_mode: Schema.String }), "PRAGMA journal_mode").journal_mode);
const countOf = (path: string, sql: string, ...params: Array<number>): number => read(path, (db) => sqliteRow(db, Schema.Struct({ n: Schema.Number }), sql, ...params).n);
const Named = Schema.Struct({ name: Schema.String });
// the parts of a backup manifest these tests read
const BackupManifest = Schema.Struct({ files: Schema.Array(Schema.Struct({ file: Schema.String, backup: Schema.String, format: Schema.Number, sha256: Schema.String })) });
const JsonObject = Schema.Record(Schema.String, Schema.Unknown);
const digest = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

// every row of every table, values typed exactly, for preservation checks
type Rows = Readonly<Record<string, ReadonlyArray<Readonly<Record<string, unknown>>>>>;
const tableRows = (path: string): Rows => read(path, (db) => {
  const result: Record<string, ReadonlyArray<Record<string, unknown>>> = {};
  const tables = sqliteRows(db, Named, "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name");
  for (const { name } of tables) {
    const statement = db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`);
    statement.setReadBigInts(true);
    result[name] = statement.all().map((row) => ({ ...row }));
  }
  return result;
});

/**
 * Every table and row that existed before is still there with every original column's value byte for byte (an upgrade may add
 * tables, columns with defaults and the rows `allowed` names); throws on any rewritten value or dropped row.
 */
const assertPreserved = (before: Rows, after: Rows, allowed: (table: string) => boolean = () => false) => {
  for (const [table, rows] of Object.entries(before)) {
    if (allowed(table)) continue;
    const upgraded = after[table];
    assert.ok(upgraded !== undefined, `table ${table} kept`);
    assert.equal(upgraded.length, rows.length, `rows of ${table} kept`);
    rows.forEach((row, index) => {
      const projected = Object.fromEntries(Object.keys(row).map((column) => [column, upgraded[index]?.[column]]));
      assert.deepEqual(projected, row, `row ${index} of ${table} preserved`);
    });
  }
};

// the live schema of a file against a contract: exactly its tables and columns for a fresh file
const liveSchema = (path: string) => read(path, (db) => {
  const objects = sqliteRows(db, Schema.Struct({ type: Schema.String, name: Schema.String }), "SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\'");
  const tables: Record<string, Array<string>> = {};
  for (const { name } of objects.filter((object) => object.type === "table"))
    tables[name] = sqliteRows(db, Named, `PRAGMA table_info("${name}")`).map((column) => column.name).sort();
  return { tables, indexes: objects.filter((object) => object.type === "index").map((object) => object.name).sort() };
});
const sortedContract = (contract: SchemaContract) => ({
  tables: Object.fromEntries(Object.entries(contract.tables).map(([table, columns]) => [table, [...columns].sort()])),
  indexes: [...contract.indexes].sort(),
});

// format 0 files as Supervisor 0.0.27 left them, written literally (test input, not today's statements)
const legacyCatalog = (directory: string, threadDocument = '{"id":"thread-1","title":"A chat","projectId":"project-1","lineage":{"parentThreadId":null,"relationshipToParent":null}}') =>
  exec(join(directory, "catalog.sqlite3"), `
    PRAGMA journal_mode=WAL;
    CREATE TABLE activations (environment_id TEXT PRIMARY KEY, activated_at INTEGER NOT NULL);
    CREATE TABLE environment_binding (id INTEGER PRIMARY KEY CHECK(id=1), environment_id TEXT NOT NULL);
    CREATE TABLE cursors (stream TEXT PRIMARY KEY CHECK(stream IN ('active', 'archive')), sequence INTEGER NOT NULL);
    CREATE TABLE projects (id TEXT PRIMARY KEY, document TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE shell_coverage (id INTEGER PRIMARY KEY CHECK(id=1), sequence INTEGER NOT NULL);
    CREATE TABLE threads (id TEXT PRIMARY KEY, project_id TEXT, document TEXT NOT NULL, location TEXT NOT NULL CHECK(location IN ('active', 'archive', 'removed')), revision INTEGER NOT NULL);
    CREATE TABLE thread_revisions (thread_id TEXT PRIMARY KEY, revision INTEGER NOT NULL);
    CREATE INDEX threads_project ON threads(project_id);
    INSERT INTO environment_binding VALUES (1, 'environment-1');
    INSERT INTO activations VALUES ('environment-1', 1762300000000);
    INSERT INTO cursors VALUES ('active', 42);
    INSERT INTO projects VALUES ('project-1', '{"id":"project-1","title":"Project","workspaceRoot":"/work/project","nativeExtra":{"kept":true}}', 0);
    INSERT INTO threads VALUES ('thread-1', 'project-1', '${threadDocument}', 'active', 3);
    INSERT INTO thread_revisions VALUES ('thread-1', 3);
  `);

const legacyPolicy = (directory: string, document = '{"generation":7,"excludedThreadIds":["thread-excluded"]}') =>
  exec(join(directory, "thread-settings.sqlite3"), `
    PRAGMA journal_mode=WAL;
    CREATE TABLE settings(id INTEGER PRIMARY KEY CHECK(id=1),document TEXT NOT NULL);
    INSERT INTO settings VALUES(1,'${document}');
  `);

/*
 * a guidance file with only the guidance store's own tables (the file's first transaction; the step creates the supervision
 * stores' tables), its settings, scope version and a stop marker in meta
 */
const legacyGuidance = (directory: string) =>
  exec(join(directory, "guidance.sqlite3"), `
    PRAGMA journal_mode=WAL;
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
    INSERT INTO meta VALUES('settings','{"generation":5,"evidenceHours":24}');
    INSERT INTO meta VALUES('supervisor_scope_version','main-v1');
    INSERT INTO meta VALUES('supervisor_unbound_stop:thread-stopped','{"threadId":"thread-stopped","stoppedAt":1762300000000,"nativeExtra":{"opaque":[1,2]}}');
  `);

const sessionHash = "a".repeat(64);
const legacyAccess = (directory: string) => {
  const access = join(directory, "access");
  exec(join(access, "login.sqlite3"), `
    PRAGMA journal_mode=DELETE;
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
    INSERT INTO dashboard_login_sessions VALUES ('${sessionHash}', 1762300000000, 1762300000001);
  `);
};

const makeAccessDirectory = (directory: string) => Effect.flatMap(FileSystem.FileSystem, (fs) => fs.makeDirectory(join(directory, "access"), { mode: 0o700 }));

const legacyDirectory = (directory: string) => Effect.gen(function* () {
  legacyCatalog(directory);
  legacyGuidance(directory);
  legacyPolicy(directory);
  yield* makeAccessDirectory(directory);
  legacyAccess(directory);
});

const storeFiles = ["catalog.sqlite3", "guidance.sqlite3", "thread-settings.sqlite3"] as const;
const allFiles = [...storeFiles, join("access", "login.sqlite3")] as const;
const backupSets = (directory: string): ReadonlyArray<string> => existsSync(join(directory, "backups")) ? readdirSync(join(directory, "backups")).sort() : [];
const snapshotDirectory = (directory: string) => Object.fromEntries(allFiles.filter((file) => existsSync(join(directory, file))).map((file) => [file, tableRows(join(directory, file))]));

const refusedWith = (exit: Exit.Exit<UpgradeReport, DatabaseUpgradeError>, file: string | null, reason: DatabaseUpgradeError["reason"]) => {
  assert.ok(Exit.isFailure(exit), "the upgrade was refused");
  const failure = exit.cause.reasons.find((entry) => entry._tag === "Fail");
  assert.ok(failure !== undefined && failure._tag === "Fail" && failure.error instanceof DatabaseUpgradeError, "a typed upgrade failure");
  assert.deepEqual([failure.error.file, failure.error.reason], [file, reason]);
};

/*
 * the shell the frozen fixtures store with keys outside the catalog whitelist: the catalog step rewrites it once, as every open
 * of the releases that wrote it did
 */
const unwhitelistedShell = "fixture-thread-unknown-keys";

describe("startup upgrade of the frozen historical layouts", () => {
  for (const shape of fixtureShapes) {
    it.live(`${shape}: backed up, upgraded in place with its rows preserved, its stores and sign-in usable, and a later start changes nothing`, () => Effect.gen(function* () {
      yield* verifyFixtureIntegrity(shape);
      const directory = yield* temporaryDirectory;
      yield* materializeFixture(shape, directory);
      const before = snapshotDirectory(directory);
      const report = yield* upgrade(directory, ["ignored-for-an-existing-directory"]);
      assert.equal(report.fresh, false);
      assert.ok(report.backupSet !== null);
      assert.deepEqual(report.files.map((file) => [file.file, file.from, file.to]), [
        ["access/login.sqlite3", 0, 1], ["catalog.sqlite3", 0, 1], ["guidance.sqlite3", 0, 1], ["thread-settings.sqlite3", 0, 1],
      ]);
      for (const file of allFiles) assert.equal(formatOf(join(directory, file)), 1, file);
      for (const file of storeFiles) assert.equal(journalOf(join(directory, file)), "wal", file);
      assert.equal(journalOf(join(directory, "access", "login.sqlite3")), "delete");

      /*
       * every stored row keeps its identity and every original value byte for byte (documents, native evidence with unknown
       * keys, Stops, Start records, uncertain sends, sessions and the policy at its generation), except the one shell the
       * whitelist trims
       */
      const after = snapshotDirectory(directory);
      for (const file of [...allFiles].filter((file) => file !== "catalog.sqlite3")) assertPreserved(before[file] ?? {}, after[file] ?? {});
      assertPreserved(before["catalog.sqlite3"] ?? {}, after["catalog.sqlite3"] ?? {}, (table) => table === "threads");
      const threadsBefore = before["catalog.sqlite3"]?.threads ?? [];
      const threadsAfter = after["catalog.sqlite3"]?.threads ?? [];
      assert.equal(threadsAfter.length, threadsBefore.length);
      threadsBefore.forEach((row, index) => {
        const upgraded = threadsAfter[index];
        assert.ok(upgraded !== undefined);
        assert.deepEqual({ ...upgraded, document: null }, { ...row, document: null }, `thread row ${String(row.id)} identity kept`);
        if (row.id !== unwhitelistedShell) assert.equal(upgraded.document, row.document, `thread ${String(row.id)} document kept byte for byte`);
        else {
          const original = decodeJson(JsonObject, String(row.document));
          const trimmed = decodeJson(JsonObject, String(upgraded.document));
          assert.ok(Object.keys(trimmed).every((key) => Object.hasOwn(original, key)), "the whitelist only removes keys");
          assert.ok(Object.keys(trimmed).length < Object.keys(original).length, "keys outside the whitelist are removed");
          assert.deepEqual([trimmed.id, trimmed.title, trimmed.projectId], [original.id, original.title, original.projectId]);
        }
      });

      // the verified backup set holds the format 0 files exactly as they were
      const set = join(directory, "backups", report.backupSet);
      const manifest = decodeJson(BackupManifest, readFileSync(join(set, "manifest.json"), "utf8"));
      assert.deepEqual(manifest.files.map((entry) => entry.file), ["access/login.sqlite3", "catalog.sqlite3", "guidance.sqlite3", "thread-settings.sqlite3"]);
      for (const entry of manifest.files) {
        assert.equal(digest(join(set, entry.backup)), entry.sha256, entry.backup);
        assert.equal(formatOf(join(set, entry.backup)), 0, entry.backup);
        assert.deepEqual(tableRows(join(set, entry.backup)), before[entry.file], entry.backup);
      }

      /*
       * the stores open the upgraded files and still run their own restart recovery (committed notices), and the forge issues
       * a token on the upgraded access database
       */
      const committed = () => countOf(join(directory, "guidance.sqlite3"), "SELECT count(*) AS n FROM notices WHERE state='committed'");
      assert.ok(committed() > 0, "the fixture holds committed notices from before a restart");
      yield* Effect.scoped(Layer.build(GuidanceStore.layer.pipe(Layer.provideMerge(guidanceDbLayer(directory)),
        Layer.provide(SupervisorIds.layer.pipe(Layer.provide(NodeCrypto.layer))))));
      assert.equal(committed(), 0);
      const grants = () => countOf(join(directory, "access", "login.sqlite3"), "SELECT count(*) AS n FROM dashboard_login_grants WHERE expires_at > ?", Date.now());
      const unexpired = grants();
      yield* forgeDashboardToken(directory);
      assert.equal(grants(), unexpired + 1);
      assert.deepEqual(tableRows(join(directory, "access", "login.sqlite3")).dashboard_login_sessions, before[join("access", "login.sqlite3")]?.dashboard_login_sessions);

      // a later start finds every file current: no upgrade, no backup
      const again = yield* upgrade(directory);
      assert.deepEqual(again, { fresh: false, backupSet: null, files: [] });
      assert.deepEqual(backupSets(directory), [report.backupSet]);
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)), { timeout: 60_000 });
  }
});

describe("startup upgrade", () => {
  it.live("a fresh directory gets every store file at its current format, the policy seeded once, and a repeated start changes nothing", () => Effect.gen(function* () {
    const directory = yield* temporaryDirectory;
    const first = yield* upgrade(directory, ["thread-a", "thread-b"]);
    assert.deepEqual(first, { fresh: true, backupSet: null, files: [
      { file: "thread-settings.sqlite3", from: null, to: 1 }, { file: "catalog.sqlite3", from: null, to: 1 }, { file: "guidance.sqlite3", from: null, to: 1 },
    ] });
    for (const file of storeFiles) assert.deepEqual([formatOf(join(directory, file)), journalOf(join(directory, file))], [1, "wal"], file);
    assert.deepEqual(tableRows(join(directory, "thread-settings.sqlite3")).settings, [{ id: 1n, document: '{"generation":1,"excludedThreadIds":["thread-a","thread-b"]}' }]);
    // a fresh file has exactly the live schema of its format
    assert.deepEqual(liveSchema(join(directory, "catalog.sqlite3")), sortedContract(catalogContract));
    assert.deepEqual(liveSchema(join(directory, "guidance.sqlite3")), sortedContract(guidanceContract));
    assert.deepEqual(liveSchema(join(directory, "thread-settings.sqlite3")), sortedContract(policyContract));
    assert.deepEqual(tableRows(join(directory, "guidance.sqlite3")).meta, [
      { key: "settings", value: '{"generation":1,"evidenceHours":24}' }, { key: "supervisor_scope_version", value: "main-v1" },
    ]);
    assert.equal(existsSync(join(directory, "access")), false, "the access database is the auth service's to create");
    const before = Object.fromEntries(storeFiles.map((file) => [file, digest(join(directory, file))]));
    const again = yield* upgrade(directory, ["another-seed"]);
    assert.deepEqual(again, { fresh: false, backupSet: null, files: [] });
    assert.deepEqual(backupSets(directory), []);
    assert.deepEqual(tableRows(join(directory, "thread-settings.sqlite3")).settings, [{ id: 1n, document: '{"generation":1,"excludedThreadIds":["thread-a","thread-b"]}' }]);
    assert.deepEqual(Object.fromEntries(storeFiles.map((file) => [file, digest(join(directory, file))])), before);
  }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)), { timeout: 60_000 });

  it.live("an interrupted creation resumes from the policy it left and never reseeds it", () => Effect.gen(function* () {
    const directory = yield* temporaryDirectory;
    yield* upgrade(directory, ["thread-a"]);
    // as if the first start stopped after the policy: catalog and guidance not created yet
    for (const file of ["catalog.sqlite3", "guidance.sqlite3"]) rmSync(join(directory, file), { force: true });
    for (const file of ["catalog.sqlite3", "guidance.sqlite3"]) for (const sidecar of ["-wal", "-shm"]) rmSync(join(directory, `${file}${sidecar}`), { force: true });
    const resumed = yield* upgrade(directory, ["different-seed"]);
    assert.deepEqual(resumed, { fresh: false, backupSet: null, files: [{ file: "catalog.sqlite3", from: null, to: 1 }, { file: "guidance.sqlite3", from: null, to: 1 }] });
    assert.deepEqual(tableRows(join(directory, "thread-settings.sqlite3")).settings, [{ id: 1n, document: '{"generation":1,"excludedThreadIds":["thread-a"]}' }]);
  }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)), { timeout: 60_000 });

  it.live("an existing directory without its policy, or with guidance state but no catalog, is refused unchanged", () => Effect.gen(function* () {
    const withoutPolicy = yield* temporaryDirectory;
    legacyCatalog(withoutPolicy);
    legacyGuidance(withoutPolicy);
    const before = snapshotDirectory(withoutPolicy);
    refusedWith(yield* Effect.exit(upgrade(withoutPolicy, ["seed"])), "thread-settings.sqlite3", "missing_policy");
    assert.equal(existsSync(join(withoutPolicy, "thread-settings.sqlite3")), false, "the policy is never reseeded");
    assert.deepEqual(snapshotDirectory(withoutPolicy), before);
    assert.deepEqual(backupSets(withoutPolicy), []);
    assert.deepEqual([formatOf(join(withoutPolicy, "catalog.sqlite3")), formatOf(join(withoutPolicy, "guidance.sqlite3"))], [0, 0]);

    const withoutCatalog = yield* temporaryDirectory;
    legacyGuidance(withoutCatalog);
    legacyPolicy(withoutCatalog);
    refusedWith(yield* Effect.exit(upgrade(withoutCatalog)), "catalog.sqlite3", "missing_catalog");
    assert.equal(existsSync(join(withoutCatalog, "catalog.sqlite3")), false);
    assert.deepEqual(backupSets(withoutCatalog), []);
  }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)), { timeout: 60_000 });

  it.live("a newer format, an unknown layout or an invalid policy is refused before anything is backed up or written", () => Effect.gen(function* () {
    const newer = yield* temporaryDirectory;
    yield* upgrade(newer);
    exec(join(newer, "guidance.sqlite3"), "PRAGMA user_version=2;");
    const newerBefore = snapshotDirectory(newer);
    refusedWith(yield* Effect.exit(upgrade(newer)), "guidance.sqlite3", "future_format");
    assert.deepEqual(snapshotDirectory(newer), newerBefore);
    assert.equal(formatOf(join(newer, "guidance.sqlite3")), 2);

    const unknown = yield* temporaryDirectory;
    yield* legacyDirectory(unknown);
    exec(join(unknown, "guidance.sqlite3"), "CREATE TABLE someone_elses(id TEXT);");
    const unknownBefore = snapshotDirectory(unknown);
    refusedWith(yield* Effect.exit(upgrade(unknown)), "guidance.sqlite3", "unknown_layout");
    assert.deepEqual(snapshotDirectory(unknown), unknownBefore);
    assert.deepEqual(backupSets(unknown), []);
    for (const file of allFiles) assert.equal(formatOf(join(unknown, file)), 0, file);

    const invalid = yield* temporaryDirectory;
    legacyCatalog(invalid);
    legacyGuidance(invalid);
    legacyPolicy(invalid, '{"generation":"seven"}');
    refusedWith(yield* Effect.exit(upgrade(invalid)), "thread-settings.sqlite3", "invalid_policy");
    assert.deepEqual(backupSets(invalid), []);
  }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)), { timeout: 60_000 });

  it.live("format 0 files are backed up and verified, then upgraded in place with every stored row preserved; a later start upgrades nothing", () => Effect.gen(function* () {
    const directory = yield* temporaryDirectory;
    yield* legacyDirectory(directory);
    const before = snapshotDirectory(directory);
    const report = yield* upgrade(directory, ["ignored-for-an-existing-directory"]);
    assert.equal(report.fresh, false);
    assert.ok(report.backupSet !== null);
    assert.deepEqual(report.files, [
      { file: "access/login.sqlite3", from: 0, to: 1 }, { file: "catalog.sqlite3", from: 0, to: 1 },
      { file: "guidance.sqlite3", from: 0, to: 1 }, { file: "thread-settings.sqlite3", from: 0, to: 1 },
    ]);
    for (const file of allFiles) assert.equal(formatOf(join(directory, file)), 1, file);
    assert.equal(journalOf(join(directory, "access", "login.sqlite3")), "delete");
    const after = snapshotDirectory(directory);
    for (const file of allFiles) assertPreserved(before[file] ?? {}, after[file] ?? {});
    // the backup set holds the format 0 files exactly as they were, with a manifest naming each
    assert.deepEqual(backupSets(directory), [report.backupSet]);
    const set = join(directory, "backups", report.backupSet);
    const manifest = decodeJson(BackupManifest, readFileSync(join(set, "manifest.json"), "utf8"));
    assert.deepEqual(manifest.files.map((entry) => [entry.file, entry.backup, entry.format]), [
      ["access/login.sqlite3", "access-login.sqlite3", 0], ["catalog.sqlite3", "catalog.sqlite3", 0],
      ["guidance.sqlite3", "guidance.sqlite3", 0], ["thread-settings.sqlite3", "thread-settings.sqlite3", 0],
    ]);
    for (const entry of manifest.files) {
      assert.equal(digest(join(set, entry.backup)), entry.sha256, entry.backup);
      assert.equal(formatOf(join(set, entry.backup)), 0, entry.backup);
      assert.deepEqual(tableRows(join(set, entry.backup)), before[entry.file], entry.backup);
    }
    // the session survives, and the policy keeps its generation and document byte for byte
    assert.deepEqual(after[join("access", "login.sqlite3")]?.dashboard_login_sessions, [{ token_hash: sessionHash, issued_at: 1762300000000n, expires_at: 1762300000001n }]);
    assert.deepEqual(after["thread-settings.sqlite3"]?.settings, [{ id: 1n, document: '{"generation":7,"excludedThreadIds":["thread-excluded"]}' }]);
    const again = yield* upgrade(directory);
    assert.deepEqual(again, { fresh: false, backupSet: null, files: [] });
    assert.deepEqual(backupSets(directory), [report.backupSet]);
  }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)), { timeout: 60_000 });

  it.live("a broken migration that rewrites a document or drops a row fails the preservation check", () => Effect.gen(function* () {
    const directory = yield* temporaryDirectory;
    yield* legacyDirectory(directory);
    const before = snapshotDirectory(directory);
    yield* upgrade(directory);
    const rewritten = join(directory, "guidance.sqlite3");
    exec(rewritten, "UPDATE meta SET value=json_set(value,'$.nativeExtra',NULL) WHERE key='supervisor_unbound_stop:thread-stopped';");
    assert.throws(() => assertPreserved(before["guidance.sqlite3"] ?? {}, tableRows(rewritten)));
    exec(join(directory, "access", "login.sqlite3"), "DELETE FROM dashboard_login_sessions;");
    assert.throws(() => assertPreserved(before[join("access", "login.sqlite3")] ?? {}, tableRows(join(directory, "access", "login.sqlite3"))));
  }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)), { timeout: 60_000 });

  it.live("a failure between files leaves earlier files upgraded and later ones untouched, and the next start resumes after the cause is fixed", () => Effect.gen(function* () {
    const directory = yield* temporaryDirectory;
    yield* legacyDirectory(directory);
    // a stored thread shell without its title: the catalog step cannot carry it forward (as its open could not read it)
    exec(join(directory, "catalog.sqlite3"), `UPDATE threads SET document='{"id":"thread-1","lineage":{}}' WHERE id='thread-1';`);
    refusedWith(yield* Effect.exit(upgrade(directory)), "catalog.sqlite3", "migration_failed");
    assert.deepEqual(allFiles.map((file) => formatOf(join(directory, file))), [0, 0, 0, 1], "access committed first; catalog rolled back; the rest untouched");
    const [firstSet] = backupSets(directory);
    assert.ok(firstSet !== undefined && existsSync(join(directory, "backups", firstSet, "manifest.json")));
    // a start that fails again with nothing changed reuses its verified set: a restart loop never piles up copies
    refusedWith(yield* Effect.exit(upgrade(directory)), "catalog.sqlite3", "migration_failed");
    assert.deepEqual(backupSets(directory), [firstSet]);
    exec(join(directory, "catalog.sqlite3"), `UPDATE threads SET document='{"id":"thread-1","title":"A chat","lineage":{}}' WHERE id='thread-1';`);
    const resumed = yield* upgrade(directory);
    assert.deepEqual(resumed.files.map((file) => file.file), ["catalog.sqlite3", "guidance.sqlite3", "thread-settings.sqlite3"]);
    assert.equal(backupSets(directory).length, 2, "a new set for the files still changing; the first one is kept");
    const manifest = decodeJson(BackupManifest, readFileSync(join(directory, "backups", resumed.backupSet ?? "", "manifest.json"), "utf8"));
    assert.deepEqual(manifest.files.map((entry) => entry.file), ["catalog.sqlite3", "guidance.sqlite3", "thread-settings.sqlite3"]);
    for (const file of allFiles) assert.equal(formatOf(join(directory, file)), 1, file);
  }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)), { timeout: 60_000 });

  it.live("two starts at once upgrade each file exactly once and agree on the result", () => Effect.gen(function* () {
    const directory = yield* temporaryDirectory;
    yield* legacyDirectory(directory);
    const before = snapshotDirectory(directory);
    const [left, right] = yield* Effect.all([Effect.exit(upgrade(directory)), Effect.exit(upgrade(directory))], { concurrency: 2 });
    const reports = [left, right].filter(Exit.isSuccess).map((exit) => exit.value);
    assert.ok(reports.length >= 1, "at least one start completed");
    for (const exit of [left, right]) if (Exit.isFailure(exit)) {
      const failure = exit.cause.reasons.find((entry) => entry._tag === "Fail");
      assert.ok(failure?._tag === "Fail" && failure.error instanceof DatabaseUpgradeError && ["backup_failed", "concurrent_change"].includes(failure.error.reason),
        "a start that lost the race failed closed");
    }
    const upgraded = reports.flatMap((report) => report.files.map((file) => file.file)).sort();
    assert.equal(new Set(upgraded).size, upgraded.length, "no file was upgraded twice");
    if (reports.length === 2) assert.deepEqual(upgraded, [...allFiles].sort());
    // a start that failed closed leaves the rest to the next start
    yield* upgrade(directory);
    for (const file of allFiles) assert.equal(formatOf(join(directory, file)), 1, file);
    const after = snapshotDirectory(directory);
    for (const file of allFiles) assertPreserved(before[file] ?? {}, after[file] ?? {});
  }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)), { timeout: 60_000 });
});
