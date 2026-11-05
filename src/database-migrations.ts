import { Data, Effect, Schema } from "effect";
import type { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";
import { rewhitelistStoredShell } from "./store.js";
import { ThreadPolicy } from "./thread-policy-contract.js";

// the format steps of the store files (PRAGMA user_version) and the live schema each current format must have. A step is a
// plain Effect program on the startup upgrade's client (src/database-upgrade.ts), which runs every pending step of one file
// and its new format in one BEGIN IMMEDIATE transaction; this is not a migration framework.
//
// Format 1 is the schema Supervisor 0.0.27 left in place at open: its stores created every table, added the later columns and
// wrote the default rows in their constructors, every time they opened. Those statements moved here verbatim, in the order a
// run's stores executed them (the stored DDL text is golden: fresh and upgraded files get the same text), so a fresh file and
// an upgraded one go through the same program. The constructors keep only their restart recovery.

/** A step that cannot carry a file forward: an unexpected layout or a stored row it cannot read; it names a table, never a row. */
export class MigrationRefused extends Data.TaggedError("MigrationRefused")<{
  readonly table: string;
  readonly reason: "row_invalid" | "layout";
}> {}

export interface MigrationContext {
  /** the directory is genuinely fresh: the only case in which the configured excluded chats seed the policy */
  readonly fresh: boolean;
  readonly excludedThreadIds: ReadonlyArray<string>;
}

export interface MigrationStep {
  readonly from: number;
  readonly to: number;
  readonly apply: (sql: SqlClient.SqlClient, context: MigrationContext) => Effect.Effect<void, SqlError | MigrationRefused>;
}

const ColumnName = Schema.Struct({ name: Schema.String });
const decodeColumn = Schema.decodeUnknownEffect(ColumnName);

/** The column names of a table (none when the table does not exist). */
export const columnsOf = (sql: SqlClient.SqlClient, table: string): Effect.Effect<ReadonlyArray<string>, SqlError | MigrationRefused> =>
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

// format 1: the catalog tables, and the one-time re-whitelisting of every stored thread shell that each open did up to format 0
// (a shell that is not readable refuses the upgrade, as it failed that open); an unchanged shell is not rewritten
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

// the prototype tables the approved one-time reset clears when a file has no supervision scope version yet (format 0 only;
// supervisor-state-reset.ts keeps its own list for the test reset)
const disposableSupervisionTables = [
  "supervisor_project_bindings", "supervisor_main_bindings", "supervisor_task_interpretations",
  "supervisor_conversation_requests", "supervisor_workflow_introductions", "supervisor_workflow_agreement_candidates",
  "supervisor_monitor_project_clock", "supervisor_monitor_binding_clock", "supervisor_monitor_items", "supervisor_monitor_threads",
] as const;

const decodeScopeVersion = Schema.decodeUnknownEffect(Schema.Struct({ value: Schema.String }));

// the reset of the project-scoped prototype, as the project supervision store's open applied it: without a stored scope
// version the disposable state is cleared and main-v1 recorded; a known or an unknown version is kept as it is (an unknown
// one leaves supervision disabled)
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
  // the project supervision store
  yield* run(sql, supervisionStatements);
  yield* addColumn(sql, "supervisor_definition_user_saves", "expected_revision",
    "ALTER TABLE supervisor_definition_user_saves ADD COLUMN expected_revision TEXT NOT NULL DEFAULT ''");
  // the conversation store
  yield* run(sql, conversationStatements);
  yield* addColumn(sql, "supervisor_monitor_binding_clock", "review_misses",
    "ALTER TABLE supervisor_monitor_binding_clock ADD COLUMN review_misses INTEGER NOT NULL DEFAULT 0");
  // the monitor store, whose added activation ordinal starts as the source ordinal
  yield* run(sql, monitorStatements);
  if (!(yield* columnsOf(sql, "supervisor_monitor_threads")).includes("activation_ordinal")) {
    yield* sql.unsafe("ALTER TABLE supervisor_monitor_threads ADD COLUMN activation_ordinal INTEGER");
    yield* sql.unsafe(`UPDATE supervisor_monitor_threads SET activation_ordinal=source_ordinal
        WHERE activation_ordinal IS NULL`);
  }
  yield* addColumn(sql, "supervisor_monitor_threads", "untracked_count",
    "ALTER TABLE supervisor_monitor_threads ADD COLUMN untracked_count INTEGER NOT NULL DEFAULT 0");
  yield* addColumn(sql, "supervisor_monitor_items", "read_item_id", "ALTER TABLE supervisor_monitor_items ADD COLUMN read_item_id TEXT");
  yield* addColumn(sql, "supervisor_monitor_items", "active", "ALTER TABLE supervisor_monitor_items ADD COLUMN active INTEGER NOT NULL DEFAULT 1");
  // the team store, the workflow state store, the workflow write receipts and evidence, the helper transport and the team
  // controller's tool receipts
  yield* run(sql, teamStatements);
  yield* run(sql, workflowStateStatements);
  yield* run(sql, workflowWriteStatements);
  yield* run(sql, helperStatements);
  yield* sql.unsafe(teamToolReceiptsStatement);
  // the one-time scope reset, once every table exists
  yield* scopeReset(sql);
});

export const guidanceMigrations: ReadonlyArray<MigrationStep> = [{ from: 0, to: 1, apply: guidanceFormat1 }];

// ---- thread-settings.sqlite3

const policyStatement = "CREATE TABLE IF NOT EXISTS settings(id INTEGER PRIMARY KEY CHECK(id=1),document TEXT NOT NULL)";
const decodePolicyRow = Schema.decodeUnknownEffect(Schema.Struct({ id: Schema.Literal(1), document: Schema.fromJsonString(ThreadPolicy) }));

/** Exactly one stored policy row that the policy store reads; anything else is never repaired or reseeded. */
export const requirePolicyRow = (sql: SqlClient.SqlClient): Effect.Effect<void, SqlError | MigrationRefused> =>
  sql`SELECT id, document FROM settings`.pipe(Effect.flatMap((rows) => rows.length === 1
    ? Effect.asVoid(decodePolicyRow(rows[0]).pipe(Effect.mapError(() => new MigrationRefused({ table: "settings", reason: "row_invalid" }))))
    : Effect.fail(new MigrationRefused({ table: "settings", reason: "row_invalid" }))));

// format 1: the policy table as the policy store's open created it; only a genuinely fresh directory seeds it, at generation 1,
// from the configured excluded chats; an existing file must already hold its one valid row
const policyFormat1 = (sql: SqlClient.SqlClient, context: MigrationContext) => Effect.gen(function* () {
  yield* sql.unsafe(policyStatement);
  if (context.fresh) yield* sql`INSERT OR IGNORE INTO settings VALUES(1,${JSON.stringify({ generation: 1, excludedThreadIds: context.excludedThreadIds })})`;
  yield* requirePolicyRow(sql);
});

export const policyMigrations: ReadonlyArray<MigrationStep> = [{ from: 0, to: 1, apply: policyFormat1 }];

// ---- the live schema of each current format, and the format 0 layouts an upgrade recognizes

/**
 * The tables (with their columns) and indexes a file at the current format must have. A fresh file has exactly these; an
 * upgraded one may keep a historical table or a column's older declaration (an added column is nullable where an ALTER added
 * it), but never lacks one of them.
 */
export interface SchemaContract {
  readonly tables: Readonly<Record<string, ReadonlyArray<string>>>;
  readonly indexes: ReadonlyArray<string>;
}

export const catalogContract: SchemaContract = {
  tables: {
    activations: ["environment_id", "activated_at"],
    environment_binding: ["id", "environment_id"],
    cursors: ["stream", "sequence"],
    projects: ["id", "document", "deleted"],
    shell_coverage: ["id", "sequence"],
    threads: ["id", "project_id", "document", "location", "revision"],
    thread_revisions: ["thread_id", "revision"],
  },
  indexes: ["threads_project"],
};

export const guidanceContract: SchemaContract = {
  tables: {
    meta: ["key", "value"],
    rules: ["id", "document"],
    mutes: ["rule_id", "scope_id"],
    classifications: ["project_id", "classification"],
    observations: ["thread_id", "hash", "observed_at"],
    episodes: ["thread_id", "rule_id", "epoch", "notified", "object_id"],
    notices: ["id", "thread_id", "rule_id", "run_id", "epoch", "state", "text", "message_id", "created_at", "dispatch_started", "rule_generation", "settings_generation"],
    activity: ["id", "document", "created_at"],
    budget: ["day", "tokens"],
    supervisor_owned_threads: ["id"],
    supervisor_project_settings: ["project_id", "document"],
    supervisor_main_bindings: ["project_id", "main_thread_id", "document"],
    supervisor_task_interpretations: ["thread_id", "project_id", "document", "updated_at"],
    supervisor_definition_user_saves: ["project_id", "workspace_root", "signature", "saved_at", "expected_revision"],
    supervisor_chat_enables: ["thread_id", "enabled_at"],
    supervisor_planning_attempts: ["id", "project_id", "document", "created_at"],
    supervisor_conversation_requests: ["id", "project_id", "document", "created_at"],
    supervisor_workflow_introductions: ["task_id", "project_id", "document"],
    supervisor_workflow_agreement_candidates: ["task_id", "proposal_id", "project_id", "document", "created_at"],
    supervisor_monitor_binding_clock: ["supervisor_thread_id", "last_notice_at", "review_misses"],
    supervisor_monitor_threads: ["project_id", "thread_id", "source_ordinal", "activation_ordinal", "saturated", "saturation_at", "last_acknowledged_at", "untracked_count"],
    supervisor_monitor_items: ["project_id", "thread_id", "item_id", "read_item_id", "type", "status", "ordinal", "detected_at", "version", "priority", "eligible", "active", "reviewed_version", "updated_at"],
    supervisor_team_members: ["owner_thread_id", "owner_generation", "member_thread_id", "state", "epoch", "document"],
    supervisor_team_assignments: ["owner_thread_id", "owner_generation", "subtree_root_thread_id", "document"],
    supervisor_team_notifications: ["owner_thread_id", "owner_generation", "id", "recipient_thread_id", "state", "created_at", "document"],
    supervisor_team_events: ["owner_thread_id", "owner_generation", "id", "created_at", "acknowledged_at", "document"],
    supervisor_team_requests: ["owner_thread_id", "owner_generation", "request_id", "state", "created_at", "updated_at", "document"],
    supervisor_workflow_state: ["workflow_id", "project_id", "main_thread_id", "thread_id", "parent_workflow_id", "parent_thread_id", "revision", "document", "created_at", "updated_at"],
    supervisor_workflow_operations: ["project_id", "main_thread_id", "actor_thread_id", "binding_generation", "operation_namespace", "operation_id", "request_hash", "result", "workflow_id", "created_at"],
    supervisor_workflow_write_receipts: ["operation_id", "operation_namespace", "request_hash", "project_id", "main_thread_id", "supervisor_thread_id", "binding_generation", "result", "created_at"],
    supervisor_workflow_write_evidence: ["supervisor_thread_id", "item_id", "operation_id", "operation_namespace", "request_hash", "project_id", "main_thread_id", "binding_generation", "native_evidence", "result", "successful", "created_at"],
    supervisor_helper_channels: ["owner_thread_id", "owner_generation", "helper_thread_id", "document"],
    supervisor_helper_deliveries: ["owner_thread_id", "owner_generation", "message_id", "document"],
    supervisor_team_tool_receipts: ["owner_thread_id", "actor_thread_id", "binding_generation", "actor_epoch", "operation_id", "request_hash", "evidence_item_id", "document"],
  },
  indexes: [
    "activity_notice", "supervisor_tasks_project", "supervisor_planning_project", "supervisor_conversation_project", "supervisor_workflow_agreement_project",
    "supervisor_monitor_pending", "supervisor_main_binding_thread", "supervisor_team_member_identity", "supervisor_team_notifications_recipient",
    "supervisor_team_events_pending", "supervisor_team_requests_pending", "supervisor_workflow_scope", "supervisor_workflow_write_evidence_operation",
  ],
};

export const policyContract: SchemaContract = { tables: { settings: ["id", "document"] }, indexes: [] };

/**
 * The format 0 layouts an upgrade carries forward: every table is a current one or a known historical one; a current table has
 * at least its original columns (all but the ones a later release added) and no column the current format does not know.
 */
export interface LegacyLayout {
  /** per current table, the columns later releases added with ALTER TABLE */
  readonly added: Readonly<Record<string, ReadonlyArray<string>>>;
  /** tables earlier releases created that the current format no longer uses; they are kept as they are */
  readonly historical: ReadonlyArray<string>;
}

export const catalogLegacy: LegacyLayout = { added: {}, historical: [] };

export const guidanceLegacy: LegacyLayout = {
  added: {
    episodes: ["object_id"],
    notices: ["rule_generation", "settings_generation"],
    supervisor_definition_user_saves: ["expected_revision"],
    supervisor_monitor_binding_clock: ["review_misses"],
    supervisor_monitor_threads: ["activation_ordinal", "untracked_count"],
    supervisor_monitor_items: ["read_item_id", "active"],
  },
  historical: ["supervisor_project_bindings", "supervisor_monitor_project_clock"],
};

export const policyLegacy: LegacyLayout = { added: {}, historical: [] };

const SchemaObject = Schema.Struct({ type: Schema.String, name: Schema.String });
const decodeObjects = Schema.decodeUnknownEffect(Schema.Array(SchemaObject));

/** The user objects of a file (tables, indexes, views, triggers), without SQLite's internal ones. */
export const schemaObjects = (sql: SqlClient.SqlClient): Effect.Effect<ReadonlyArray<typeof SchemaObject.Type>, SqlError | MigrationRefused> =>
  sql.unsafe("SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY type, name").pipe(
    Effect.flatMap((rows) => decodeObjects(rows).pipe(Effect.mapError(() => new MigrationRefused({ table: "sqlite_master", reason: "layout" })))));

/** What a contract finds missing in a file: `table`, `table.column` or `index:name` entries, none when it is complete. */
export const missingSchema = (sql: SqlClient.SqlClient, contract: SchemaContract): Effect.Effect<ReadonlyArray<string>, SqlError | MigrationRefused> =>
  Effect.gen(function* () {
    const objects = yield* schemaObjects(sql);
    const tables = new Set(objects.filter((object) => object.type === "table").map((object) => object.name));
    const indexes = new Set(objects.filter((object) => object.type === "index").map((object) => object.name));
    const missing: Array<string> = [];
    for (const [table, columns] of Object.entries(contract.tables)) {
      if (!tables.has(table)) {
        missing.push(table);
        continue;
      }
      const present = yield* columnsOf(sql, table);
      for (const column of columns) if (!present.includes(column)) missing.push(`${table}.${column}`);
    }
    for (const index of contract.indexes) if (!indexes.has(index)) missing.push(`index:${index}`);
    return missing;
  });

/** How a format 0 file looks to the upgrade: table-less, a recognized earlier layout, or unknown (naming the first unknown object). */
export type LegacyRecognition = { readonly kind: "empty" } | { readonly kind: "recognized" } | { readonly kind: "unknown"; readonly object: string };

export const recognizeLegacy = (sql: SqlClient.SqlClient, contract: SchemaContract, legacy: LegacyLayout): Effect.Effect<LegacyRecognition, SqlError | MigrationRefused> =>
  Effect.gen(function* () {
    const objects = yield* schemaObjects(sql);
    if (objects.length === 0) return { kind: "empty" } as const;
    for (const object of objects) {
      if (object.type === "index") continue;
      if (object.type !== "table") return { kind: "unknown", object: object.name } as const;
      // own entries only: a table named like an object property is simply unknown
      const current = Object.hasOwn(contract.tables, object.name) ? contract.tables[object.name] : undefined;
      if (current === undefined) {
        if (legacy.historical.includes(object.name)) continue;
        return { kind: "unknown", object: object.name } as const;
      }
      const added = Object.hasOwn(legacy.added, object.name) ? legacy.added[object.name] ?? [] : [];
      const present = yield* columnsOf(sql, object.name);
      if (present.some((column) => !current.includes(column)) || current.some((column) => !added.includes(column) && !present.includes(column)))
        return { kind: "unknown", object: object.name } as const;
    }
    return { kind: "recognized" } as const;
  });
