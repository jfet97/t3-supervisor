import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { NodeCrypto, NodeFileSystem } from "@effect/platform-node";
import { describe, it } from "@effect/vitest";
import { Effect, Exit, FileSystem, Layer, Schema } from "effect";
import { DatabaseUpgradeError, type UpgradeReport, upgradeDataDirectory } from "../src/database-upgrade.js";
import { guidanceDbLayer } from "../src/db.js";
import { GuidanceStore } from "../src/guidance-store.js";
import { SupervisorIds } from "../src/ids.js";
import { forgeDashboardToken } from "../src/service-auth.js";
import { expectedDumpSync, type FixtureDatabaseName, fixtureShapes, materializeFixture, verifyFixtureIntegrity } from "./support/persistence-fixtures.js";
import { decodeJson, sqliteRow, sqliteRows } from "./support/sqlite-rows.js";

/*
 * the startup coordinator (src/database-upgrade.ts) on real files: a fresh directory, a repeated start, an interrupted fresh
 * initialization, the refusals that change nothing, the backup and upgrade of format 0 and format 1 files with their rows
 * preserved and the retired policy file imported byte for byte and removed, every restart state of that import, a failure
 * between files and its resumption, two starts at once, and every frozen historical layout of test/fixtures/persistence
 * (released schema statements with synthetic rows). The older inputs are written literally here or come from those fixtures,
 * never from today's schema statements.
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
const BackupManifest = Schema.Struct({ files: Schema.Array(Schema.Struct({
  file: Schema.String, backup: Schema.String, format: Schema.Number, targetFormat: Schema.NullOr(Schema.Number), sha256: Schema.String,
})) });
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

// a file's user objects with their stored declarations, byte for byte, keyed as type:name
const Declared = Schema.Struct({ type: Schema.String, name: Schema.String, sql: Schema.String });
const declarations = (path: string) => read(path, (db) => Object.fromEntries(
  sqliteRows(db, Declared, "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY type, name")
    .map((row) => [`${row.type}:${row.name}`, row.sql])));

// the same for the frozen Supervisor 0.0.27 layout (test/fixtures/persistence), an independent record of the declarations
const frozenDeclarations = (name: FixtureDatabaseName) => Object.fromEntries(expectedDumpSync("format0-current-unversioned", name).sqliteMaster
  .filter((row) => !row.name.startsWith("sqlite_"))
  .map((row) => [`${row.type}:${row.name}`, row.sql ?? ""]));

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
    CREATE TABLE episodes(thread_id TEXT NOT NULL,rule_id TEXT NOT NULL,epoch INTEGER NOT NULL DEFAULT 0,
      notified INTEGER NOT NULL DEFAULT 0, object_id TEXT,PRIMARY KEY(thread_id,rule_id));
    CREATE TABLE notices(id TEXT PRIMARY KEY,thread_id TEXT NOT NULL,rule_id TEXT NOT NULL,run_id TEXT NOT NULL,epoch INTEGER NOT NULL,state TEXT NOT NULL,
      text TEXT NOT NULL,message_id TEXT,created_at INTEGER NOT NULL,dispatch_started INTEGER NOT NULL DEFAULT 0,
      rule_generation INTEGER NOT NULL DEFAULT -1, settings_generation INTEGER NOT NULL DEFAULT -1);
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

const storeFiles = ["catalog.sqlite3", "guidance.sqlite3"] as const;
const accessFile = join("access", "login.sqlite3");
const allFiles = [...storeFiles, accessFile] as const;
// the retired policy file: imported into guidance format 2, then removed
const donorFile = "thread-settings.sqlite3";
// the format every file the start prepares ends at
const currentFormat: Readonly<Record<string, number>> = { "catalog.sqlite3": 1, "guidance.sqlite3": 2, [accessFile]: 1 };
const backupSets = (directory: string): ReadonlyArray<string> => existsSync(join(directory, "backups")) ? readdirSync(join(directory, "backups")).sort() : [];
// the prepared files and, while it exists, the retired policy file
const snapshotDirectory = (directory: string) => Object.fromEntries([...allFiles, donorFile].filter((file) => existsSync(join(directory, file)))
  .map((file) => [file, tableRows(join(directory, file))]));

// a store file and its sidecars removed, as if never created
const removeFile = (directory: string, file: string) => {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(join(directory, `${file}${suffix}`), { force: true });
};
const donorGone = (directory: string) => ["", "-wal", "-shm"].every((suffix) => !existsSync(join(directory, `${donorFile}${suffix}`)));

const policyRows = (directory: string) => tableRows(join(directory, "guidance.sqlite3")).thread_policy;
const metaRow = (directory: string, key: string) => (tableRows(join(directory, "guidance.sqlite3")).meta ?? []).find((row) => row.key === key);
const Marker = Schema.Struct({ documentSha256: Schema.String, generation: Schema.Number, backupSet: Schema.String });
const importMarker = (directory: string) => {
  const row = metaRow(directory, "thread_policy_import");
  return row === undefined ? null : decodeJson(Marker, String(row.value));
};
// a policy document's stored bytes, as hexadecimal, and their SHA-256
const documentHex = (path: string, table: string): string =>
  read(path, (db) => sqliteRow(db, Schema.Struct({ hex: Schema.String }), `SELECT hex(CAST(document AS BLOB)) AS hex FROM ${table}`).hex);
const sha256OfHex = (hex: string): string => createHash("sha256").update(Buffer.from(hex, "hex")).digest("hex");
const generationOf = (document: unknown): number => decodeJson(Schema.Struct({ generation: Schema.Number }), String(document)).generation;
// guidance's rows without the import marker, to compare with a file from before the import
const withoutMarker = (rows: Rows): Rows => ({ ...rows, meta: (rows.meta ?? []).filter((row) => row.key !== "thread_policy_import") });
// the declaration of guidance's policy table: the retired file's own table under its new name
const threadPolicyDeclaration = () => frozenDeclarations("thread-settings")["table:settings"]?.replace("CREATE TABLE settings(", "CREATE TABLE thread_policy(");
// the retired reminder rules' tables: an existing file keeps them with their rows, a new file no longer gets them
const retiredTables = ["table:rules", "table:mutes", "table:observations", "table:episodes", "table:budget"];

const refusedWith = (exit: Exit.Exit<UpgradeReport, DatabaseUpgradeError>, file: string | null, reason: DatabaseUpgradeError["reason"]) => {
  assert.ok(Exit.isFailure(exit), "the upgrade was refused");
  const failure = exit.cause.reasons.find((entry) => entry._tag === "Fail");
  assert.ok(failure !== undefined && failure._tag === "Fail" && failure.error instanceof DatabaseUpgradeError, "a typed upgrade failure");
  assert.deepEqual([failure.error.file, failure.error.reason], [file, reason]);
};

/*
 * the import's evidence after an upgrade that moved the retired file's policy: guidance holds its document byte for byte (the
 * archived copy in the backup set is the reference), the marker names its hash, generation and that set, and the file and its
 * sidecars are gone
 */
const assertImported = (directory: string, backupSet: string, document: unknown) => {
  const archived = documentHex(join(directory, "backups", backupSet, donorFile), "settings");
  assert.equal(documentHex(join(directory, "guidance.sqlite3"), "thread_policy"), archived, "the document moved byte for byte");
  assert.deepEqual(policyRows(directory), [{ id: 1n, document }]);
  assert.deepEqual(importMarker(directory), { documentSha256: sha256OfHex(archived), generation: generationOf(document), backupSet });
  assert.ok(donorGone(directory), "the retired policy file and its sidecars are removed");
};

/*
 * the shell the frozen fixtures store with keys outside the catalog whitelist: the catalog step rewrites it once, as every open
 * of the releases that wrote it did
 */
const unwhitelistedShell = "fixture-thread-unknown-keys";

describe("startup upgrade of the frozen historical layouts", () => {
  for (const shape of fixtureShapes) {
    it.live(`${shape}: backed up, upgraded in place with its rows preserved and its policy moved, its stores and sign-in usable, and a later start changes nothing`, () => Effect.gen(function* () {
      yield* verifyFixtureIntegrity(shape);
      const directory = yield* temporaryDirectory;
      yield* materializeFixture(shape, directory);
      const before = snapshotDirectory(directory);
      const report = yield* upgrade(directory, ["ignored-for-an-existing-directory"]);
      assert.equal(report.fresh, false);
      assert.ok(report.backupSet !== null);
      assert.deepEqual(report.files.map((file) => [file.file, file.from, file.to]), [
        ["access/login.sqlite3", 0, 1], ["catalog.sqlite3", 0, 1], ["guidance.sqlite3", 0, 2],
      ]);
      assert.equal(report.policyFileRemoved, true);
      for (const file of allFiles) assert.equal(formatOf(join(directory, file)), currentFormat[file], file);
      for (const file of storeFiles) assert.equal(journalOf(join(directory, file)), "wal", file);
      assert.equal(journalOf(join(directory, accessFile)), "delete");

      /*
       * every stored row keeps its identity and every original value byte for byte (documents, native evidence with unknown
       * keys, Stops, Start records, uncertain sends, sessions), except the one shell the whitelist trims; the policy keeps its
       * document and generation in guidance
       */
      const after = snapshotDirectory(directory);
      const policy = before[donorFile]?.settings ?? [];
      assert.equal(policy.length, 1, "the fixture holds one policy row");
      assertImported(directory, report.backupSet, policy[0]?.document);
      assertPreserved(before[accessFile] ?? {}, after[accessFile] ?? {});
      assertPreserved(before["guidance.sqlite3"] ?? {}, withoutMarker(after["guidance.sqlite3"] ?? {}));
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

      // the verified backup set holds the format 0 files exactly as they were, the retired policy file among them
      const set = join(directory, "backups", report.backupSet);
      const manifest = decodeJson(BackupManifest, readFileSync(join(set, "manifest.json"), "utf8"));
      assert.deepEqual(manifest.files.map((entry) => [entry.file, entry.targetFormat]), [
        ["access/login.sqlite3", 1], ["catalog.sqlite3", 1], ["guidance.sqlite3", 2], ["thread-settings.sqlite3", null],
      ]);
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
      const grants = () => countOf(join(directory, accessFile), "SELECT count(*) AS n FROM dashboard_login_grants WHERE expires_at > ?", Date.now());
      const unexpired = grants();
      yield* forgeDashboardToken(directory);
      assert.equal(grants(), unexpired + 1);
      assert.deepEqual(tableRows(join(directory, accessFile)).dashboard_login_sessions, before[accessFile]?.dashboard_login_sessions);

      // a later start finds every file current: no upgrade, no backup, nothing to remove
      const again = yield* upgrade(directory);
      assert.deepEqual(again, { fresh: false, backupSet: null, files: [], policyFileRemoved: false });
      assert.deepEqual(backupSets(directory), [report.backupSet]);
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)), { timeout: 60_000 });
  }
});

describe("startup upgrade", () => {
  it.live("a fresh directory gets every store file at its current format, the policy seeded once in guidance, and a repeated start changes nothing", () => Effect.gen(function* () {
    const directory = yield* temporaryDirectory;
    const first = yield* upgrade(directory, ["thread-a", "thread-b"]);
    assert.deepEqual(first, { fresh: true, backupSet: null, files: [
      { file: "guidance.sqlite3", from: null, to: 2 }, { file: "catalog.sqlite3", from: null, to: 1 },
    ], policyFileRemoved: false });
    for (const file of storeFiles) assert.deepEqual([formatOf(join(directory, file)), journalOf(join(directory, file))], [currentFormat[file], "wal"], file);
    assert.deepEqual(policyRows(directory), [{ id: 1n, document: '{"generation":1,"excludedThreadIds":["thread-a","thread-b"]}' }]);
    assert.equal(existsSync(join(directory, donorFile)), false, "no policy file is created");
    /*
     * a fresh file declares what Supervisor 0.0.27 declared, byte for byte, without the retired reminder rules' tables, plus
     * guidance's policy table (the retired file's table under its new name): format 1 is that schema, format 2 adds the table
     */
    assert.deepEqual(declarations(join(directory, "catalog.sqlite3")), frozenDeclarations("catalog"));
    assert.deepEqual(declarations(join(directory, "guidance.sqlite3")), {
      ...Object.fromEntries(Object.entries(frozenDeclarations("guidance")).filter(([key]) => !retiredTables.includes(key))),
      "table:thread_policy": threadPolicyDeclaration(),
    });
    // the fresh initialization completed: its pending marker is gone, and nothing was imported
    assert.deepEqual(tableRows(join(directory, "guidance.sqlite3")).meta, [
      { key: "settings", value: '{"generation":1,"evidenceHours":24}' }, { key: "supervisor_scope_version", value: "main-v1" },
    ]);
    assert.equal(existsSync(join(directory, "access")), false, "the access database is the auth service's to create");
    const before = Object.fromEntries(storeFiles.map((file) => [file, digest(join(directory, file))]));
    const again = yield* upgrade(directory, ["another-seed"]);
    assert.deepEqual(again, { fresh: false, backupSet: null, files: [], policyFileRemoved: false });
    assert.deepEqual(backupSets(directory), []);
    assert.deepEqual(policyRows(directory), [{ id: 1n, document: '{"generation":1,"excludedThreadIds":["thread-a","thread-b"]}' }]);
    assert.deepEqual(Object.fromEntries(storeFiles.map((file) => [file, digest(join(directory, file))])), before);
  }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)), { timeout: 60_000 });

  it.live("an interrupted fresh initialization is completed from the guidance it committed and never reseeds the policy", () => Effect.gen(function* () {
    const directory = yield* temporaryDirectory;
    yield* upgrade(directory, ["thread-a"]);
    const guidance = join(directory, "guidance.sqlite3");
    const policy = policyRows(directory);
    // guidance committed with its policy and pending marker, the catalog not created yet
    exec(guidance, "INSERT INTO meta VALUES('bootstrap_pending','{}');");
    removeFile(directory, "catalog.sqlite3");
    const resumed = yield* upgrade(directory, ["different-seed"]);
    assert.deepEqual(resumed, { fresh: false, backupSet: null, files: [{ file: "catalog.sqlite3", from: null, to: 1 }], policyFileRemoved: false });
    assert.deepEqual(policyRows(directory), policy, "the committed policy is kept, never reseeded");
    assert.equal(metaRow(directory, "bootstrap_pending"), undefined);
    // the catalog created but the marker not cleared yet: only the marker goes
    exec(guidance, "INSERT INTO meta VALUES('bootstrap_pending','{}');");
    assert.deepEqual(yield* upgrade(directory, ["different-seed"]), { fresh: false, backupSet: null, files: [], policyFileRemoved: false });
    assert.equal(metaRow(directory, "bootstrap_pending"), undefined);
    assert.deepEqual(policyRows(directory), policy);

    // the first transaction did not commit: a table-less guidance file leaves a fresh directory, created as one
    const retried = yield* temporaryDirectory;
    exec(join(retried, "guidance.sqlite3"), "PRAGMA journal_mode=WAL;");
    assert.equal((yield* upgrade(retried, ["thread-b"])).fresh, true);
    assert.deepEqual(policyRows(retried), [{ id: 1n, document: '{"generation":1,"excludedThreadIds":["thread-b"]}' }]);
  }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)), { timeout: 60_000 });

  it.live("an interrupted fresh initialization beside catalog data or an old policy file is refused unchanged", () => Effect.gen(function* () {
    const withData = yield* temporaryDirectory;
    yield* upgrade(withData);
    exec(join(withData, "guidance.sqlite3"), "INSERT INTO meta VALUES('bootstrap_pending','{}');");
    exec(join(withData, "catalog.sqlite3"), "INSERT INTO environment_binding VALUES (1, 'environment-1');");
    const dataBefore = snapshotDirectory(withData);
    refusedWith(yield* Effect.exit(upgrade(withData)), "catalog.sqlite3", "interrupted_bootstrap");
    assert.deepEqual(snapshotDirectory(withData), dataBefore);

    const withPolicyFile = yield* temporaryDirectory;
    yield* upgrade(withPolicyFile);
    exec(join(withPolicyFile, "guidance.sqlite3"), "INSERT INTO meta VALUES('bootstrap_pending','{}');");
    legacyPolicy(withPolicyFile);
    const policyBefore = snapshotDirectory(withPolicyFile);
    refusedWith(yield* Effect.exit(upgrade(withPolicyFile)), donorFile, "policy_conflict");
    assert.deepEqual(snapshotDirectory(withPolicyFile), policyBefore);
    assert.deepEqual(backupSets(withPolicyFile), []);
  }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)), { timeout: 60_000 });

  it.live("an existing directory without its policy, or with guidance state but no catalog, is refused unchanged", () => Effect.gen(function* () {
    const withoutPolicy = yield* temporaryDirectory;
    legacyCatalog(withoutPolicy);
    legacyGuidance(withoutPolicy);
    const before = snapshotDirectory(withoutPolicy);
    refusedWith(yield* Effect.exit(upgrade(withoutPolicy, ["seed"])), donorFile, "missing_policy");
    assert.equal(existsSync(join(withoutPolicy, donorFile)), false, "the policy is never reseeded");
    assert.deepEqual(snapshotDirectory(withoutPolicy), before);
    assert.deepEqual(backupSets(withoutPolicy), []);
    assert.deepEqual([formatOf(join(withoutPolicy, "catalog.sqlite3")), formatOf(join(withoutPolicy, "guidance.sqlite3"))], [0, 0]);

    const withoutCatalog = yield* temporaryDirectory;
    legacyGuidance(withoutCatalog);
    legacyPolicy(withoutCatalog);
    refusedWith(yield* Effect.exit(upgrade(withoutCatalog)), "catalog.sqlite3", "missing_catalog");
    assert.equal(existsSync(join(withoutCatalog, "catalog.sqlite3")), false);
    assert.deepEqual(backupSets(withoutCatalog), []);

    // a guidance file at format 2 without a policy row is never reseeded either
    const withoutRow = yield* temporaryDirectory;
    yield* upgrade(withoutRow);
    exec(join(withoutRow, "guidance.sqlite3"), "DELETE FROM thread_policy;");
    refusedWith(yield* Effect.exit(upgrade(withoutRow, ["seed"])), "guidance.sqlite3", "invalid_policy");
    assert.deepEqual(policyRows(withoutRow), []);
  }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)), { timeout: 60_000 });

  it.live("a newer format, an unknown layout or an invalid policy is refused before anything is backed up or written", () => Effect.gen(function* () {
    const newer = yield* temporaryDirectory;
    yield* upgrade(newer);
    exec(join(newer, "guidance.sqlite3"), "PRAGMA user_version=3;");
    const newerBefore = snapshotDirectory(newer);
    refusedWith(yield* Effect.exit(upgrade(newer)), "guidance.sqlite3", "future_format");
    assert.deepEqual(snapshotDirectory(newer), newerBefore);
    assert.equal(formatOf(join(newer, "guidance.sqlite3")), 3);

    const unknown = yield* temporaryDirectory;
    yield* legacyDirectory(unknown);
    exec(join(unknown, "guidance.sqlite3"), "CREATE TABLE someone_elses(id TEXT);");
    const unknownBefore = snapshotDirectory(unknown);
    refusedWith(yield* Effect.exit(upgrade(unknown)), "guidance.sqlite3", "unknown_layout");
    assert.deepEqual(snapshotDirectory(unknown), unknownBefore);
    assert.deepEqual(backupSets(unknown), []);
    for (const file of [...allFiles, donorFile]) assert.equal(formatOf(join(unknown, file)), 0, file);

    // every name as a release wrote it, but the threads table declared without its primary key: never stamped format 1
    const redeclared = yield* temporaryDirectory;
    yield* legacyDirectory(redeclared);
    const catalog = join(redeclared, "catalog.sqlite3");
    exec(catalog, "DROP INDEX threads_project; ALTER TABLE threads RENAME TO threads_kept;" +
      " CREATE TABLE threads (id TEXT, project_id TEXT, document TEXT NOT NULL, location TEXT NOT NULL CHECK(location IN ('active', 'archive', 'removed')), revision INTEGER NOT NULL);" +
      " INSERT INTO threads SELECT * FROM threads_kept; DROP TABLE threads_kept; CREATE INDEX threads_project ON threads(project_id);");
    assert.deepEqual(read(catalog, (db) => sqliteRows(db, Named, "SELECT name FROM pragma_table_info('threads') ORDER BY cid").map((column) => column.name)),
      ["id", "project_id", "document", "location", "revision"]);
    const redeclaredBefore = snapshotDirectory(redeclared);
    refusedWith(yield* Effect.exit(upgrade(redeclared)), "catalog.sqlite3", "unknown_layout");
    assert.deepEqual(snapshotDirectory(redeclared), redeclaredBefore);
    assert.deepEqual(backupSets(redeclared), []);
    for (const file of allFiles) assert.equal(formatOf(join(redeclared, file)), 0, file);

    const invalid = yield* temporaryDirectory;
    legacyCatalog(invalid);
    legacyGuidance(invalid);
    legacyPolicy(invalid, '{"generation":"seven"}');
    refusedWith(yield* Effect.exit(upgrade(invalid)), donorFile, "invalid_policy");
    assert.deepEqual(backupSets(invalid), []);

    // a policy file with another table, or at a format it never had, is no policy to import
    for (const statement of ["CREATE TABLE extra(id TEXT);", "PRAGMA user_version=2;"]) {
      const strange = yield* temporaryDirectory;
      yield* legacyDirectory(strange);
      exec(join(strange, donorFile), statement);
      const strangeBefore = snapshotDirectory(strange);
      refusedWith(yield* Effect.exit(upgrade(strange)), donorFile, "unknown_layout");
      assert.deepEqual(snapshotDirectory(strange), strangeBefore);
      assert.deepEqual(backupSets(strange), []);
    }

    // a current guidance file whose policy row does not decode
    const undecodable = yield* temporaryDirectory;
    yield* upgrade(undecodable);
    exec(join(undecodable, "guidance.sqlite3"), `UPDATE thread_policy SET document='{"generation":"one"}';`);
    refusedWith(yield* Effect.exit(upgrade(undecodable)), "guidance.sqlite3", "invalid_policy");
  }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)), { timeout: 60_000 });

  it.live("format 0 files are backed up and verified, then upgraded in place with every stored row preserved and the policy moved; a later start upgrades nothing", () => Effect.gen(function* () {
    const directory = yield* temporaryDirectory;
    yield* legacyDirectory(directory);
    const before = snapshotDirectory(directory);
    const report = yield* upgrade(directory, ["ignored-for-an-existing-directory"]);
    assert.equal(report.fresh, false);
    assert.ok(report.backupSet !== null);
    assert.deepEqual(report.files, [
      { file: "access/login.sqlite3", from: 0, to: 1 }, { file: "catalog.sqlite3", from: 0, to: 1 }, { file: "guidance.sqlite3", from: 0, to: 2 },
    ]);
    assert.equal(report.policyFileRemoved, true);
    for (const file of allFiles) assert.equal(formatOf(join(directory, file)), currentFormat[file], file);
    assert.equal(journalOf(join(directory, accessFile)), "delete");
    const after = snapshotDirectory(directory);
    for (const file of [accessFile, "catalog.sqlite3"]) assertPreserved(before[file] ?? {}, after[file] ?? {});
    assertPreserved(before["guidance.sqlite3"] ?? {}, withoutMarker(after["guidance.sqlite3"] ?? {}));
    // the backup set holds the format 0 files exactly as they were, with a manifest naming each
    assert.deepEqual(backupSets(directory), [report.backupSet]);
    const set = join(directory, "backups", report.backupSet);
    const manifest = decodeJson(BackupManifest, readFileSync(join(set, "manifest.json"), "utf8"));
    assert.deepEqual(manifest.files.map((entry) => [entry.file, entry.backup, entry.format, entry.targetFormat]), [
      ["access/login.sqlite3", "access-login.sqlite3", 0, 1], ["catalog.sqlite3", "catalog.sqlite3", 0, 1],
      ["guidance.sqlite3", "guidance.sqlite3", 0, 2], [donorFile, donorFile, 0, null],
    ]);
    for (const entry of manifest.files) {
      assert.equal(digest(join(set, entry.backup)), entry.sha256, entry.backup);
      assert.equal(formatOf(join(set, entry.backup)), 0, entry.backup);
      assert.deepEqual(tableRows(join(set, entry.backup)), before[entry.file], entry.backup);
    }
    // the session survives, and the policy keeps its generation and document byte for byte in guidance
    assert.deepEqual(after[accessFile]?.dashboard_login_sessions, [{ token_hash: sessionHash, issued_at: 1762300000000n, expires_at: 1762300000001n }]);
    assertImported(directory, report.backupSet, '{"generation":7,"excludedThreadIds":["thread-excluded"]}');
    const again = yield* upgrade(directory);
    assert.deepEqual(again, { fresh: false, backupSet: null, files: [], policyFileRemoved: false });
    assert.deepEqual(backupSets(directory), [report.backupSet]);
  }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)), { timeout: 60_000 });

  it.live("the policy document moves byte for byte whatever its layout, its unknown fields included", () => Effect.gen(function* () {
    const directory = yield* temporaryDirectory;
    yield* legacyDirectory(directory);
    rmSync(join(directory, donorFile));
    const document = '{ "excludedThreadIds" : [ "thread-é" ], "generation": 12, "native": {"kept": [1, 2.50]} }';
    legacyPolicy(directory, document);
    const report = yield* upgrade(directory);
    assert.ok(report.backupSet !== null);
    assertImported(directory, report.backupSet, document);
    assert.equal(documentHex(join(directory, "guidance.sqlite3"), "thread_policy"), Buffer.from(document, "utf8").toString("hex").toUpperCase());
  }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)), { timeout: 60_000 });

  /*
   * the foundation's formats, as an earlier version of this upgrade left them: every file of the frozen 0.0.27 layout stamped
   * format 1 (format 1 declares exactly that schema), the policy still in its own file at format 1
   */
  it.live("an incomplete format 1 layout is refused before backup or migration writes, a missing retired table included", () => Effect.gen(function* () {
    // every format 1 file has the whole layout every release declared, the retired tables a new file no longer gets among it
    for (const damage of ["DROP INDEX supervisor_main_binding_thread;", "DROP TABLE budget;"]) {
      const directory = yield* temporaryDirectory;
      yield* materializeFixture("format0-current-unversioned", directory);
      for (const file of [...allFiles, donorFile]) exec(join(directory, file), "PRAGMA user_version=1;");
      exec(join(directory, "guidance.sqlite3"), damage);
      const before = snapshotDirectory(directory);
      refusedWith(yield* Effect.exit(upgrade(directory)), "guidance.sqlite3", "incomplete_schema");
      assert.deepEqual(snapshotDirectory(directory), before, damage);
      assert.deepEqual(backupSets(directory), [], damage);
    }
  }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)), { timeout: 60_000 });

  it.live("a directory at the foundation's formats moves guidance to format 2 with the policy file imported and removed", () => Effect.gen(function* () {
    const directory = yield* temporaryDirectory;
    yield* materializeFixture("format0-current-unversioned", directory);
    for (const file of [...allFiles, donorFile]) exec(join(directory, file), "PRAGMA user_version=1;");
    const before = snapshotDirectory(directory);
    const unchanged = Object.fromEntries([accessFile, "catalog.sqlite3"].map((file) => [file, digest(join(directory, file))]));
    const report = yield* upgrade(directory);
    assert.ok(report.backupSet !== null);
    assert.deepEqual(report.files, [{ file: "guidance.sqlite3", from: 1, to: 2 }]);
    assert.equal(report.policyFileRemoved, true);
    assert.equal(formatOf(join(directory, "guidance.sqlite3")), 2);
    assert.deepEqual(Object.fromEntries([accessFile, "catalog.sqlite3"].map((file) => [file, digest(join(directory, file))])), unchanged, "current files are not touched");
    const manifest = decodeJson(BackupManifest, readFileSync(join(directory, "backups", report.backupSet, "manifest.json"), "utf8"));
    assert.deepEqual(manifest.files.map((entry) => [entry.file, entry.format, entry.targetFormat]), [["guidance.sqlite3", 1, 2], [donorFile, 1, null]]);
    assertPreserved(before["guidance.sqlite3"] ?? {}, withoutMarker(snapshotDirectory(directory)["guidance.sqlite3"] ?? {}));
    assertImported(directory, report.backupSet, before[donorFile]?.settings?.[0]?.document);
  }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)), { timeout: 60_000 });

  it.live("a policy file left after its import is removed once proven the same document; a different, unreadable or unarchived one refuses the start", () => Effect.gen(function* () {
    const directory = yield* temporaryDirectory;
    yield* legacyDirectory(directory);
    const report = yield* upgrade(directory);
    assert.ok(report.backupSet !== null);
    const archived = join(directory, "backups", report.backupSet, donorFile);
    const guidance = digest(join(directory, "guidance.sqlite3"));
    // the import committed, but the start stopped before removing the file: the next start removes it, with no other backup
    copyFileSync(archived, join(directory, donorFile));
    assert.deepEqual(yield* upgrade(directory), { fresh: false, backupSet: null, files: [], policyFileRemoved: true });
    assert.ok(donorGone(directory));
    // only the sidecars were left, the main file already gone: the import marker proves they can go
    writeFileSync(join(directory, `${donorFile}-wal`), "");
    writeFileSync(join(directory, `${donorFile}-shm`), "");
    assert.deepEqual(yield* upgrade(directory), { fresh: false, backupSet: null, files: [], policyFileRemoved: true });
    assert.ok(donorGone(directory));
    // a policy file that differs from the imported document (an older Supervisor ran meanwhile) is neither removed nor read
    legacyPolicy(directory, '{"generation":8,"excludedThreadIds":[]}');
    const changed = snapshotDirectory(directory);
    refusedWith(yield* Effect.exit(upgrade(directory)), donorFile, "policy_conflict");
    assert.deepEqual(snapshotDirectory(directory), changed);
    removeFile(directory, donorFile);
    // an unreadable one refuses too, and stays as it is
    writeFileSync(join(directory, donorFile), "not a database");
    refusedWith(yield* Effect.exit(upgrade(directory)), donorFile, "unreadable");
    assert.equal(readFileSync(join(directory, donorFile), "utf8"), "not a database");
    removeFile(directory, donorFile);
    // the same document while its archived copy is missing: the file stays until the archive is back
    const saved = join(directory, "backups", "saved-copy.sqlite3");
    copyFileSync(archived, saved);
    copyFileSync(archived, join(directory, donorFile));
    rmSync(archived);
    refusedWith(yield* Effect.exit(upgrade(directory)), donorFile, "backup_failed");
    assert.ok(existsSync(join(directory, donorFile)), "kept while its archive is missing");
    copyFileSync(saved, archived);
    rmSync(saved);
    assert.equal((yield* upgrade(directory)).policyFileRemoved, true);
    assert.ok(donorGone(directory));
    assert.equal(digest(join(directory, "guidance.sqlite3")), guidance, "no removal changes guidance");
    assert.deepEqual(backupSets(directory), [report.backupSet]);
  }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)), { timeout: 60_000 });

  it.live("a broken migration that rewrites a document or drops a row fails the preservation check", () => Effect.gen(function* () {
    const directory = yield* temporaryDirectory;
    yield* legacyDirectory(directory);
    const before = snapshotDirectory(directory);
    const report = yield* upgrade(directory);
    const rewritten = join(directory, "guidance.sqlite3");
    exec(rewritten, "UPDATE meta SET value=json_set(value,'$.nativeExtra',NULL) WHERE key='supervisor_unbound_stop:thread-stopped';");
    assert.throws(() => assertPreserved(before["guidance.sqlite3"] ?? {}, withoutMarker(tableRows(rewritten))));
    exec(join(directory, accessFile), "DELETE FROM dashboard_login_sessions;");
    assert.throws(() => assertPreserved(before[accessFile] ?? {}, tableRows(join(directory, accessFile))));
    // an import that reformats the document, the same policy in other bytes, fails the byte-for-byte check
    exec(rewritten, "UPDATE thread_policy SET document=replace(document,':',': ');");
    assert.throws(() => assertImported(directory, report.backupSet ?? "", before[donorFile]?.settings?.[0]?.document));
  }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)), { timeout: 60_000 });

  it.live("a failure between files leaves earlier files upgraded and later ones untouched, and the next start resumes after the cause is fixed", () => Effect.gen(function* () {
    const directory = yield* temporaryDirectory;
    yield* legacyDirectory(directory);
    const formats = () => Object.fromEntries([...allFiles, donorFile].map((file) => [file, formatOf(join(directory, file))]));
    // a stored thread shell without its title: the catalog step cannot carry it forward (as its open could not read it)
    exec(join(directory, "catalog.sqlite3"), `UPDATE threads SET document='{"id":"thread-1","lineage":{}}' WHERE id='thread-1';`);
    refusedWith(yield* Effect.exit(upgrade(directory)), "catalog.sqlite3", "migration_failed");
    assert.deepEqual(formats(), { [accessFile]: 1, "catalog.sqlite3": 0, "guidance.sqlite3": 0, [donorFile]: 0 },
      "access committed first; catalog rolled back; the rest untouched");
    const [firstSet] = backupSets(directory);
    assert.ok(firstSet !== undefined && existsSync(join(directory, "backups", firstSet, "manifest.json")));
    // a start that fails again with nothing changed reuses its verified set: a restart loop never piles up copies
    refusedWith(yield* Effect.exit(upgrade(directory)), "catalog.sqlite3", "migration_failed");
    assert.deepEqual(backupSets(directory), [firstSet]);
    exec(join(directory, "catalog.sqlite3"), `UPDATE threads SET document='{"id":"thread-1","title":"A chat","lineage":{}}' WHERE id='thread-1';`);
    const resumed = yield* upgrade(directory);
    assert.deepEqual(resumed.files.map((file) => file.file), ["catalog.sqlite3", "guidance.sqlite3"]);
    assert.equal(resumed.policyFileRemoved, true);
    assert.equal(backupSets(directory).length, 2, "a new set for the files still changing; the first one is kept");
    const manifest = decodeJson(BackupManifest, readFileSync(join(directory, "backups", resumed.backupSet ?? "", "manifest.json"), "utf8"));
    assert.deepEqual(manifest.files.map((entry) => entry.file), ["catalog.sqlite3", "guidance.sqlite3", donorFile]);
    for (const file of allFiles) assert.equal(formatOf(join(directory, file)), currentFormat[file], file);
    assert.ok(donorGone(directory));
  }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)), { timeout: 60_000 });

  it.live("two starts at once upgrade each file exactly once and agree on the result", () => Effect.gen(function* () {
    const directory = yield* temporaryDirectory;
    yield* legacyDirectory(directory);
    const before = snapshotDirectory(directory);
    const [left, right] = yield* Effect.all([Effect.exit(upgrade(directory)), Effect.exit(upgrade(directory))], { concurrency: 2 });
    const reports = [left, right].filter(Exit.isSuccess).map((exit) => exit.value);
    assert.ok(reports.length >= 1, "at least one start completed");
    // a start that lost the race failed closed: its backup, its policy file or its removal was already the other start's
    for (const exit of [left, right]) if (Exit.isFailure(exit)) {
      const failure = exit.cause.reasons.find((entry) => entry._tag === "Fail");
      assert.ok(failure?._tag === "Fail" && failure.error instanceof DatabaseUpgradeError &&
        ["backup_failed", "concurrent_change", "unreadable", "cleanup_failed"].includes(failure.error.reason), "a start that lost the race failed closed");
    }
    const upgraded = reports.flatMap((report) => report.files.map((file) => file.file)).sort();
    assert.equal(new Set(upgraded).size, upgraded.length, "no file was upgraded twice");
    if (reports.length === 2) assert.deepEqual(upgraded, [...allFiles].sort());
    // a start that failed closed leaves the rest to the next start
    yield* upgrade(directory);
    for (const file of allFiles) assert.equal(formatOf(join(directory, file)), currentFormat[file], file);
    const after = snapshotDirectory(directory);
    for (const file of [accessFile, "catalog.sqlite3"]) assertPreserved(before[file] ?? {}, after[file] ?? {});
    assertPreserved(before["guidance.sqlite3"] ?? {}, withoutMarker(after["guidance.sqlite3"] ?? {}));
    assert.deepEqual(policyRows(directory), before[donorFile]?.settings);
    assert.ok(donorGone(directory));
  }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)), { timeout: 60_000 });
});
