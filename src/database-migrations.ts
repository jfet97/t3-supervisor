import { createHash } from "node:crypto";
import { Data, Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";
import { rewhitelistStoredShell } from "./store.js";
import { ThreadPolicy, type ThreadPolicySettings } from "./thread-policy-contract.js";

/*
 * the format steps of the store files (PRAGMA user_version) and the declared schema each current format must have. A step is a
 * plain Effect program on the startup upgrade's client (src/database-upgrade.ts), which runs every pending step of one file
 * and its new format in one BEGIN IMMEDIATE transaction; this is not a migration framework.
 *
 * Format 1 is the schema Supervisor 0.0.27 left in place at open: its stores created every table, added the later columns and
 * wrote the default rows in their constructors, every time they opened. Those statements moved here verbatim, in the order a
 * run's stores executed them (the stored DDL text is golden: fresh and upgraded files get the same text), so a fresh file and
 * an upgraded one go through the same program. Every published release declared each object exactly as format 1 does, so the
 * column additions only unpublished prototypes needed are gone: no file the upgrade recognizes lacks those columns. The
 * constructors keep only their restart recovery.
 *
 * Guidance format 2 adds the excluded-chat policy, which earlier formats kept in thread-settings.sqlite3; that file is retired
 * once the startup upgrade imported its policy (src/database-upgrade.ts).
 */

/** A step that cannot carry a file forward: an unexpected layout or a stored row it cannot read; it names a table, never a row. */
export class MigrationRefused extends Data.TaggedError("MigrationRefused")<{
  readonly table: string;
  readonly reason: "row_invalid" | "layout";
}> {}

/**
 * Where guidance format 2 takes its one policy row from: the configured excluded chats of a genuinely fresh directory, the
 * retired policy file's document (its stored bytes, with the marker the import records), or nowhere, for every other file.
 */
export type PolicySource =
  | { readonly kind: "fresh"; readonly excludedThreadIds: ReadonlyArray<string> }
  | { readonly kind: "import"; readonly bytes: Uint8Array; readonly marker: PolicyImportMarker }
  | { readonly kind: "none" };

export interface MigrationContext {
  readonly policy: PolicySource;
}

export interface MigrationStep {
  readonly from: number;
  readonly to: number;
  readonly apply: (sql: SqlClient.SqlClient, context: MigrationContext) => Effect.Effect<void, SqlError | MigrationRefused>;
}

const ColumnName = Schema.Struct({ name: Schema.String });
const decodeColumn = Schema.decodeUnknownEffect(ColumnName);

// the column names of a table (none when the table does not exist)
const columnsOf = (sql: SqlClient.SqlClient, table: string): Effect.Effect<ReadonlyArray<string>, SqlError | MigrationRefused> =>
  sql.unsafe(`PRAGMA table_info(${table})`).pipe(Effect.flatMap(Effect.forEach((row) => decodeColumn(row).pipe(
    Effect.map((column) => column.name), Effect.mapError(() => new MigrationRefused({ table, reason: "layout" }))))));

// a later column, added once with the exact statement the constructor used (its text becomes part of the stored DDL)
const addColumn = (sql: SqlClient.SqlClient, table: string, column: string, statement: string) =>
  Effect.flatMap(columnsOf(sql, table), (columns) => columns.includes(column) ? Effect.void : Effect.asVoid(sql.unsafe(statement)));

const run = (sql: SqlClient.SqlClient, statements: ReadonlyArray<string>) => Effect.forEach(statements, (statement) => sql.unsafe(statement), { discard: true });

// ---- the format 1 statements, moved verbatim from the constructors of Supervisor 0.0.27

const catalogStatements = [
  `CREATE TABLE IF NOT EXISTS activations (
    environment_id TEXT PRIMARY KEY,
    activated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS environment_binding (
    id INTEGER PRIMARY KEY CHECK(id=1),
    environment_id TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS cursors (
    stream TEXT PRIMARY KEY CHECK(stream IN ('active', 'archive')),
    sequence INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    document TEXT NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS shell_coverage (
    id INTEGER PRIMARY KEY CHECK(id=1),
    sequence INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS threads (
    id TEXT PRIMARY KEY,
    project_id TEXT,
    document TEXT NOT NULL,
    location TEXT NOT NULL CHECK(location IN ('active', 'archive', 'removed')),
    revision INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS thread_revisions (
    thread_id TEXT PRIMARY KEY,
    revision INTEGER NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS threads_project ON threads(project_id)",
];

const guidanceStoreStatements = [
  "CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS rules(id TEXT PRIMARY KEY,document TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS mutes(rule_id TEXT NOT NULL,scope_id TEXT NOT NULL,PRIMARY KEY(rule_id,scope_id))",
  "CREATE TABLE IF NOT EXISTS classifications(project_id TEXT PRIMARY KEY,classification TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS observations(thread_id TEXT PRIMARY KEY,hash TEXT NOT NULL,observed_at INTEGER NOT NULL)",
  `CREATE TABLE IF NOT EXISTS episodes(thread_id TEXT NOT NULL,rule_id TEXT NOT NULL,epoch INTEGER NOT NULL DEFAULT 0,
        notified INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(thread_id,rule_id))`,
  `CREATE TABLE IF NOT EXISTS notices(id TEXT PRIMARY KEY,thread_id TEXT NOT NULL,rule_id TEXT NOT NULL,run_id TEXT NOT NULL,
        epoch INTEGER NOT NULL,state TEXT NOT NULL,text TEXT NOT NULL,message_id TEXT,created_at INTEGER NOT NULL,
        dispatch_started INTEGER NOT NULL DEFAULT 0)`,
  "CREATE TABLE IF NOT EXISTS activity(id TEXT PRIMARY KEY,document TEXT NOT NULL,created_at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS budget(day TEXT PRIMARY KEY,tokens INTEGER NOT NULL)",
  "CREATE INDEX IF NOT EXISTS activity_notice ON activity(json_extract(document,'$.noticeId'),created_at)",
];

const supervisionStatements = [
  "CREATE TABLE IF NOT EXISTS supervisor_owned_threads(id TEXT PRIMARY KEY)",
  "CREATE TABLE IF NOT EXISTS supervisor_project_settings(project_id TEXT PRIMARY KEY,document TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS supervisor_main_bindings(project_id TEXT NOT NULL,main_thread_id TEXT NOT NULL,document TEXT NOT NULL,PRIMARY KEY(project_id,main_thread_id))",
  "CREATE TABLE IF NOT EXISTS supervisor_task_interpretations(thread_id TEXT PRIMARY KEY,project_id TEXT NOT NULL,document TEXT NOT NULL,updated_at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS supervisor_definition_user_saves(project_id TEXT NOT NULL,workspace_root TEXT NOT NULL,signature TEXT NOT NULL,saved_at INTEGER NOT NULL,expected_revision TEXT NOT NULL,PRIMARY KEY(project_id,workspace_root))",
  "CREATE TABLE IF NOT EXISTS supervisor_chat_enables(thread_id TEXT PRIMARY KEY,enabled_at INTEGER NOT NULL)",
  "CREATE INDEX IF NOT EXISTS supervisor_tasks_project ON supervisor_task_interpretations(project_id)",
] as const;

const conversationStatements = [
  "CREATE TABLE IF NOT EXISTS supervisor_planning_attempts(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,document TEXT NOT NULL,created_at INTEGER NOT NULL)",
  "CREATE INDEX IF NOT EXISTS supervisor_planning_project ON supervisor_planning_attempts(project_id)",
  "CREATE TABLE IF NOT EXISTS supervisor_conversation_requests(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,document TEXT NOT NULL,created_at INTEGER NOT NULL)",
  "CREATE INDEX IF NOT EXISTS supervisor_conversation_project ON supervisor_conversation_requests(project_id)",
  "CREATE TABLE IF NOT EXISTS supervisor_workflow_introductions(task_id TEXT PRIMARY KEY,project_id TEXT NOT NULL,document TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS supervisor_workflow_agreement_candidates(task_id TEXT NOT NULL,proposal_id TEXT NOT NULL,project_id TEXT NOT NULL,document TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(task_id,proposal_id))",
  "CREATE INDEX IF NOT EXISTS supervisor_workflow_agreement_project ON supervisor_workflow_agreement_candidates(project_id)",
  "CREATE TABLE IF NOT EXISTS supervisor_monitor_binding_clock(supervisor_thread_id TEXT PRIMARY KEY,last_notice_at INTEGER NOT NULL,review_misses INTEGER NOT NULL DEFAULT 0)",
];

const monitorStatements = [
  `CREATE TABLE IF NOT EXISTS supervisor_monitor_threads(
        project_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        source_ordinal INTEGER NOT NULL,
        activation_ordinal INTEGER NOT NULL,
        saturated INTEGER NOT NULL DEFAULT 0,
        saturation_at INTEGER,
        last_acknowledged_at INTEGER,
        untracked_count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(project_id, thread_id)
      )`,
  `CREATE TABLE IF NOT EXISTS supervisor_monitor_items(
        project_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        read_item_id TEXT,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        detected_at INTEGER NOT NULL,
        version TEXT NOT NULL,
        priority TEXT,
        eligible INTEGER NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        reviewed_version TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(project_id, thread_id, item_id)
      )`,
  `CREATE INDEX IF NOT EXISTS supervisor_monitor_pending
        ON supervisor_monitor_items(project_id, thread_id, eligible, reviewed_version)`,
];

const teamStatements = [
  "CREATE INDEX IF NOT EXISTS supervisor_main_binding_thread ON supervisor_main_bindings(json_extract(document,'$.threadId'))",
  "CREATE TABLE IF NOT EXISTS supervisor_team_members(owner_thread_id TEXT NOT NULL,owner_generation INTEGER NOT NULL,member_thread_id TEXT NOT NULL,state TEXT NOT NULL,epoch INTEGER NOT NULL,document TEXT NOT NULL,PRIMARY KEY(owner_thread_id,owner_generation,member_thread_id))",
  "CREATE UNIQUE INDEX IF NOT EXISTS supervisor_team_member_identity ON supervisor_team_members(member_thread_id) WHERE state<>'retired'",
  "CREATE TABLE IF NOT EXISTS supervisor_team_assignments(owner_thread_id TEXT NOT NULL,owner_generation INTEGER NOT NULL,subtree_root_thread_id TEXT NOT NULL,document TEXT NOT NULL,PRIMARY KEY(owner_thread_id,owner_generation,subtree_root_thread_id))",
  "CREATE TABLE IF NOT EXISTS supervisor_team_notifications(owner_thread_id TEXT NOT NULL,owner_generation INTEGER NOT NULL,id TEXT NOT NULL,recipient_thread_id TEXT NOT NULL,state TEXT NOT NULL,created_at INTEGER NOT NULL,document TEXT NOT NULL,PRIMARY KEY(owner_thread_id,owner_generation,id))",
  "CREATE INDEX IF NOT EXISTS supervisor_team_notifications_recipient ON supervisor_team_notifications(owner_thread_id,owner_generation,recipient_thread_id,state,created_at)",
  "CREATE TABLE IF NOT EXISTS supervisor_team_events(owner_thread_id TEXT NOT NULL,owner_generation INTEGER NOT NULL,id TEXT NOT NULL,created_at INTEGER NOT NULL,acknowledged_at INTEGER,document TEXT NOT NULL,PRIMARY KEY(owner_thread_id,owner_generation,id))",
  "CREATE INDEX IF NOT EXISTS supervisor_team_events_pending ON supervisor_team_events(owner_thread_id,owner_generation,acknowledged_at,created_at)",
  "CREATE TABLE IF NOT EXISTS supervisor_team_requests(owner_thread_id TEXT NOT NULL,owner_generation INTEGER NOT NULL,request_id TEXT NOT NULL,state TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,document TEXT NOT NULL,PRIMARY KEY(owner_thread_id,owner_generation,request_id))",
  "CREATE INDEX IF NOT EXISTS supervisor_team_requests_pending ON supervisor_team_requests(owner_thread_id,owner_generation,state,created_at)",
] as const;

const workflowStateStatements = [
  "CREATE TABLE IF NOT EXISTS supervisor_workflow_state (" +
      "workflow_id TEXT PRIMARY KEY,project_id TEXT NOT NULL,main_thread_id TEXT NOT NULL,thread_id TEXT NOT NULL," +
      "parent_workflow_id TEXT,parent_thread_id TEXT,revision INTEGER NOT NULL,document TEXT NOT NULL," +
      "created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(project_id,main_thread_id,thread_id))",
  "CREATE INDEX IF NOT EXISTS supervisor_workflow_scope ON supervisor_workflow_state(project_id,main_thread_id)",
  "CREATE TABLE IF NOT EXISTS supervisor_workflow_operations (" +
      "project_id TEXT NOT NULL,main_thread_id TEXT NOT NULL,actor_thread_id TEXT NOT NULL,binding_generation INTEGER NOT NULL," +
      "operation_namespace TEXT NOT NULL,operation_id TEXT NOT NULL,request_hash TEXT NOT NULL,result TEXT NOT NULL,workflow_id TEXT NOT NULL," +
      "created_at INTEGER NOT NULL,PRIMARY KEY(project_id,main_thread_id,actor_thread_id,binding_generation,operation_namespace,operation_id))",
];

const workflowWriteReceiptsStatement = `CREATE TABLE IF NOT EXISTS supervisor_workflow_write_receipts (
        operation_id TEXT NOT NULL,
        operation_namespace TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        project_id TEXT NOT NULL,
        main_thread_id TEXT NOT NULL,
        supervisor_thread_id TEXT NOT NULL,
        binding_generation INTEGER NOT NULL,
        result TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(project_id,main_thread_id,supervisor_thread_id,binding_generation,operation_namespace,operation_id)
      )`;

const workflowWriteStatements = [
  workflowWriteReceiptsStatement,
  `CREATE TABLE IF NOT EXISTS supervisor_workflow_write_evidence (
        supervisor_thread_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        operation_namespace TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        project_id TEXT NOT NULL,
        main_thread_id TEXT NOT NULL,
        binding_generation INTEGER NOT NULL,
        native_evidence TEXT NOT NULL,
        result TEXT NOT NULL,
        successful INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(supervisor_thread_id,item_id)
      )`,
  `CREATE INDEX IF NOT EXISTS supervisor_workflow_write_evidence_operation
        ON supervisor_workflow_write_evidence(project_id,main_thread_id,supervisor_thread_id,binding_generation,operation_namespace,operation_id,created_at)`,
];

const helperStatements = [
  "CREATE TABLE IF NOT EXISTS supervisor_helper_channels(\n      owner_thread_id TEXT NOT NULL,owner_generation INTEGER NOT NULL,helper_thread_id TEXT NOT NULL,document TEXT NOT NULL,\n      PRIMARY KEY(owner_thread_id,owner_generation,helper_thread_id))",
  "CREATE TABLE IF NOT EXISTS supervisor_helper_deliveries(\n      owner_thread_id TEXT NOT NULL,owner_generation INTEGER NOT NULL,message_id TEXT NOT NULL,document TEXT NOT NULL,\n      PRIMARY KEY(owner_thread_id,owner_generation,message_id))",
];

const teamToolReceiptsStatement = `CREATE TABLE IF NOT EXISTS supervisor_team_tool_receipts(
      owner_thread_id TEXT NOT NULL,actor_thread_id TEXT NOT NULL,binding_generation INTEGER NOT NULL,actor_epoch INTEGER NOT NULL,operation_id TEXT NOT NULL,
      request_hash TEXT NOT NULL,evidence_item_id TEXT NOT NULL,document TEXT NOT NULL,
      PRIMARY KEY(owner_thread_id,actor_thread_id,binding_generation,actor_epoch,operation_id))`;
// ---- catalog.sqlite3

const decodeThreadRow = Schema.decodeUnknownEffect(Schema.Struct({ id: Schema.String, document: Schema.String }));

/*
 * format 1: the catalog tables, and the one-time re-whitelisting of every stored thread shell that each open did up to format 0
 * (a shell that is not readable refuses the upgrade, as it failed that open); an unchanged shell is not rewritten
 */
const catalogFormat1 = (sql: SqlClient.SqlClient) => Effect.gen(function* () {
  yield* run(sql, catalogStatements);
  for (const raw of yield* sql`SELECT id, document FROM threads`) {
    const row = yield* decodeThreadRow(raw).pipe(Effect.mapError(() => new MigrationRefused({ table: "threads", reason: "row_invalid" })));
    const document = yield* rewhitelistStoredShell(row.document).pipe(Effect.mapError(() => new MigrationRefused({ table: "threads", reason: "row_invalid" })));
    if (document !== row.document) yield* sql`UPDATE threads SET document=${document} WHERE id=${row.id}`;
  }
});

export const catalogMigrations: ReadonlyArray<MigrationStep> = [{ from: 0, to: 1, apply: catalogFormat1 }];

// ---- guidance.sqlite3

/*
 * the disposable supervision tables the approved one-time reset clears when a file has no supervision scope version yet (format
 * 0 only; supervisor-state-reset.ts keeps its own list for the test reset)
 */
const disposableSupervisionTables = [
  "supervisor_main_bindings", "supervisor_task_interpretations", "supervisor_conversation_requests", "supervisor_workflow_introductions",
  "supervisor_workflow_agreement_candidates", "supervisor_monitor_binding_clock", "supervisor_monitor_items", "supervisor_monitor_threads",
] as const;

const decodeScopeVersion = Schema.decodeUnknownEffect(Schema.Struct({ value: Schema.String }));

/*
 * the reset of the project-scoped prototype, as the project supervision store's open applied it: without a stored scope
 * version the disposable state is cleared and main-v1 recorded; a known or an unknown version is kept as it is (an unknown
 * one leaves supervision disabled)
 */
const scopeReset = (sql: SqlClient.SqlClient) => Effect.gen(function* () {
  const [row] = yield* sql`SELECT value FROM meta WHERE key='supervisor_scope_version'`;
  if (row !== undefined) {
    yield* decodeScopeVersion(row).pipe(Effect.mapError(() => new MigrationRefused({ table: "meta", reason: "row_invalid" })));
    return;
  }
  for (const table of disposableSupervisionTables)
    if ((yield* sql`SELECT 1 FROM sqlite_master WHERE type='table' AND name=${table}`).length > 0) yield* sql.unsafe(`DELETE FROM "${table}"`);
  yield* sql`DELETE FROM meta WHERE key IN ('supervisor_activation_baseline','supervisor_activation_sequence')`;
  yield* sql`INSERT INTO meta VALUES('supervisor_scope_version','main-v1')`;
});

const guidanceFormat1 = (sql: SqlClient.SqlClient) => Effect.gen(function* () {
  // the guidance store: its tables, the default settings row and its later columns
  yield* run(sql, guidanceStoreStatements);
  yield* sql`INSERT OR IGNORE INTO meta VALUES('settings',${JSON.stringify({ generation: 1, evidenceHours: 24 })})`;
  yield* addColumn(sql, "episodes", "object_id", "ALTER TABLE episodes ADD COLUMN object_id TEXT");
  for (const column of ["rule_generation", "settings_generation"])
    yield* addColumn(sql, "notices", column, `ALTER TABLE notices ADD COLUMN ${column} INTEGER NOT NULL DEFAULT -1`);
  // the project supervision store, the conversation store and the monitor store
  yield* run(sql, supervisionStatements);
  yield* run(sql, conversationStatements);
  yield* run(sql, monitorStatements);
  /*
   * the team store, the workflow state store, the workflow write receipts and evidence, the helper transport and the team
   * controller's tool receipts
   */
  yield* run(sql, teamStatements);
  yield* run(sql, workflowStateStatements);
  yield* run(sql, workflowWriteStatements);
  yield* run(sql, helperStatements);
  yield* sql.unsafe(teamToolReceiptsStatement);
  // the one-time scope reset, once every table exists
  yield* scopeReset(sql);
});

// ---- the excluded-chat policy, in guidance from format 2

// one row: the policy document as the policy store reads and writes it
const threadPolicyStatement = "CREATE TABLE IF NOT EXISTS thread_policy(id INTEGER PRIMARY KEY CHECK(id=1),document TEXT NOT NULL)";

/** The meta row of an imported policy: the SHA-256 of the document's stored bytes, its generation and the backup set holding the retired file. */
export const policyImportKey = "thread_policy_import";
export const PolicyImportMarker = Schema.Struct({ documentSha256: Schema.String, generation: Schema.Number, backupSet: Schema.String });
export type PolicyImportMarker = typeof PolicyImportMarker.Type;

/** The meta row of a fresh initialization that committed guidance but has not yet verified its catalog. */
export const bootstrapPendingKey = "bootstrap_pending";

/** A stored policy row: the document as the policy store decodes it, its exact stored bytes and their SHA-256. */
export interface StoredPolicy {
  readonly policy: ThreadPolicySettings;
  readonly bytes: Uint8Array;
  readonly sha256: string;
}

const PolicyRows = Schema.Tuple([Schema.Struct({ id: Schema.Literal(1), document: Schema.fromJsonString(ThreadPolicy), bytes: Schema.Uint8Array })]);
const decodePolicyRows = Schema.decodeUnknownEffect(PolicyRows);

/**
 * The one policy row of `table` (the retired file's settings, or guidance's thread_policy): id 1 with a document the policy store
 * decodes, read with its stored bytes. Anything else is refused, never repaired or reseeded.
 */
export const readStoredPolicy = (sql: SqlClient.SqlClient, table: "settings" | "thread_policy"): Effect.Effect<StoredPolicy, SqlError | MigrationRefused> =>
  sql.unsafe(`SELECT id, document, CAST(document AS BLOB) AS bytes FROM ${table}`).pipe(
    Effect.provideService(SqlClient.SafeIntegers, false),
    Effect.flatMap((rows) => decodePolicyRows(rows).pipe(Effect.mapError(() => new MigrationRefused({ table, reason: "row_invalid" })))),
    Effect.map(([row]) => ({ policy: row.document, bytes: row.bytes, sha256: createHash("sha256").update(row.bytes).digest("hex") })));

/*
 * format 2: the excluded-chat policy moves into guidance, so Stop, Enable and Start write it and their bookkeeping in one
 * transaction. A genuinely fresh directory gets the configured excluded chats at generation 1 and the fresh initialization's
 * pending marker; an existing installation gets the retired file's document byte for byte, with the import marker. Without
 * either there is no policy to write, and the step refuses.
 */
const guidanceFormat2 = (sql: SqlClient.SqlClient, context: MigrationContext) => Effect.gen(function* () {
  yield* sql.unsafe(threadPolicyStatement);
  const source = context.policy;
  if (source.kind === "none") return yield* new MigrationRefused({ table: "thread_policy", reason: "row_invalid" });
  if (source.kind === "fresh") {
    yield* sql`INSERT INTO thread_policy VALUES(1,${JSON.stringify({ generation: 1, excludedThreadIds: source.excludedThreadIds })})`;
    yield* sql`INSERT INTO meta VALUES(${bootstrapPendingKey},'{}')`;
  } else {
    // the stored bytes themselves, so the copy is the document exactly as the retired file held it
    yield* sql`INSERT INTO thread_policy VALUES(1,CAST(${source.bytes} AS TEXT))`;
    yield* sql`INSERT INTO meta VALUES(${policyImportKey},${JSON.stringify(source.marker)})`;
  }
  const stored = yield* readStoredPolicy(sql, "thread_policy");
  if (source.kind === "import" && stored.sha256 !== source.marker.documentSha256) return yield* new MigrationRefused({ table: "thread_policy", reason: "row_invalid" });
});

export const guidanceMigrations: ReadonlyArray<MigrationStep> = [{ from: 0, to: 1, apply: guidanceFormat1 }, { from: 1, to: 2, apply: guidanceFormat2 }];

// ---- the retired thread-settings.sqlite3

/*
 * the one table of the retired policy file, as Supervisor 0.0.27 created it and format 1 kept it; the startup upgrade imports its
 * row into guidance format 2 and then removes the file, and nothing else opens it
 */
export const policyDonorStatement = "CREATE TABLE IF NOT EXISTS settings(id INTEGER PRIMARY KEY CHECK(id=1),document TEXT NOT NULL)";
/** The formats of the retired policy file an upgrade imports: the unversioned file of 0.0.27 and earlier, and format 1. */
export const policyDonorFormats: ReadonlyArray<number> = [0, 1];

// ---- the declared schema of each current format, and the format 0 layouts an upgrade recognizes

/**
 * A file's schema as SQLite stores it: every user object (table, index, view or trigger, without SQLite's internal ones) keyed
 * as `type:name`, with its stored declaration's layout normalized. Equal signatures mean the same tables with the same columns,
 * types, defaults, keys and constraints, and the same index definitions.
 */
export type SchemaSignature = ReadonlyMap<string, string>;

const Declaration = Schema.Struct({ type: Schema.String, name: Schema.String, sql: Schema.String });
const decodeDeclarations = Schema.decodeUnknownEffect(Schema.Array(Declaration));

const wordCharacter = (char: string): boolean => char >= "\u0080" || /[A-Za-z0-9_$]/u.test(char);

/*
 * a stored declaration with its layout normalized, so the same statement laid out differently still matches: whitespace between
 * tokens is dropped, except one space between two words, which would otherwise read as one (`document TEXT` is no
 * `documentTEXT`). Quoted text keeps every byte, since whitespace there is data: a 'string literal' of a check, default or
 * partial index, or a "quoted", `quoted` or [quoted] identifier; a doubled quote character stays inside its quoted text, as
 * SQLite reads it. Only SQLite's five whitespace characters count as layout
 */
const declarationText = (sql: string): string => {
  let text = "";
  let close: string | null = null;
  let separated = false;
  for (let index = 0; index < sql.length; index++) {
    const char = sql.charAt(index);
    if (close !== null) {
      text += char;
      if (char !== close) continue;
      if (close !== "]" && sql.charAt(index + 1) === close) text += sql.charAt(++index);
      else close = null;
      continue;
    }
    if (/[ \t\n\f\r]/u.test(char)) {
      separated = true;
      continue;
    }
    if (separated && wordCharacter(text.charAt(text.length - 1)) && wordCharacter(char)) text += " ";
    separated = false;
    if (char === "'" || char === '"' || char === "`" || char === "[") close = char === "[" ? "]" : char;
    text += char;
  }
  return text;
};

/** The signature of the schema a file stores. */
export const schemaSignature = (sql: SqlClient.SqlClient): Effect.Effect<SchemaSignature, SqlError | MigrationRefused> =>
  sql.unsafe("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY type, name").pipe(
    Effect.flatMap((rows) => decodeDeclarations(rows).pipe(Effect.mapError(() => new MigrationRefused({ table: "sqlite_master", reason: "layout" })))),
    Effect.map((rows) => new Map(rows.map((row): readonly [string, string] => [`${row.type}:${row.name}`, declarationText(row.sql)]))));

/**
 * The objects of `reference` (the signature the current format's steps give an empty database) that a file does not have or
 * declares differently, as `type:name`; none when the file has the whole declared schema of its format.
 */
export const schemaDifferences = (sql: SqlClient.SqlClient, reference: SchemaSignature): Effect.Effect<ReadonlyArray<string>, SqlError | MigrationRefused> =>
  Effect.map(schemaSignature(sql), (file) => [...reference].filter(([key, declaration]) => file.get(key) !== declaration).map(([key]) => key));

/**
 * The format 0 layouts an upgrade carries forward. Every published release declared each of its objects exactly as format 1
 * does (only whole tables were added over time; test/fixtures/persistence holds the frozen layouts), so every object of a
 * recognized file has the declaration of the current format's reference, and the file has every table and index its first
 * schema transaction created in every release. Tables a later constructor would have created may be missing (a run stopped
 * before it, or the release predates it); the step creates them. Any other object or declaration (another column, type,
 * default, key, constraint or index definition) or a missing part of the first transaction was never written by a release,
 * so the file is not upgraded.
 */
export interface LegacyLayout {
  /** the tables and indexes every release created together, in the file's first transaction */
  readonly required: { readonly tables: ReadonlyArray<string>; readonly indexes: ReadonlyArray<string> };
}

// the whole catalog schema is one transaction; shell_coverage came with a later release
export const catalogLegacy: LegacyLayout = {
  required: { tables: ["activations", "environment_binding", "cursors", "projects", "threads", "thread_revisions"], indexes: ["threads_project"] },
};

// the guidance store's own tables come first, in one transaction; the supervision stores add theirs later, one by one
export const guidanceLegacy: LegacyLayout = {
  required: { tables: ["meta", "rules", "mutes", "classifications", "observations", "episodes", "notices", "activity", "budget"], indexes: ["activity_notice"] },
};

const SchemaObject = Schema.Struct({ type: Schema.String, name: Schema.String });
const decodeObjects = Schema.decodeUnknownEffect(Schema.Array(SchemaObject));

/** The user objects of a file (tables, indexes, views, triggers), without SQLite's internal ones. */
export const schemaObjects = (sql: SqlClient.SqlClient): Effect.Effect<ReadonlyArray<typeof SchemaObject.Type>, SqlError | MigrationRefused> =>
  sql.unsafe("SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY type, name").pipe(
    Effect.flatMap((rows) => decodeObjects(rows).pipe(Effect.mapError(() => new MigrationRefused({ table: "sqlite_master", reason: "layout" })))));

/** How a format 0 file looks to the upgrade: table-less, a recognized earlier layout, or unknown (naming the first unknown or missing object). */
export type LegacyRecognition = { readonly kind: "empty" } | { readonly kind: "recognized" } | { readonly kind: "unknown"; readonly object: string };

const objectName = (key: string): string => key.slice(key.indexOf(":") + 1);

export const recognizeLegacy = (sql: SqlClient.SqlClient, reference: SchemaSignature, legacy: LegacyLayout): Effect.Effect<LegacyRecognition, SqlError | MigrationRefused> =>
  Effect.gen(function* () {
    const file = yield* schemaSignature(sql);
    if (file.size === 0) return { kind: "empty" } as const;
    for (const [key, declaration] of file)
      if (reference.get(key) !== declaration) return { kind: "unknown", object: objectName(key) } as const;
    const required = [...legacy.required.tables.map((name) => `table:${name}`), ...legacy.required.indexes.map((name) => `index:${name}`)];
    const missing = required.find((key) => !file.has(key));
    return missing === undefined ? { kind: "recognized" } as const : { kind: "unknown", object: objectName(missing) } as const;
  });
