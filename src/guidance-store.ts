import { dashboardInvalidation } from "./dashboard-updates.js";
import { projectKeys } from "./dashboard-events.js";
import { createHash } from "node:crypto";
import { Clock, Context, Effect, Layer, Schema } from "effect";
import type { SqlError } from "effect/sql";
import { GuidanceDb, untracedSql } from "./db.js";
import { decodeGuidanceRow, type GuidanceStoreError, guidanceSql, rowFindings, rowKey, rowsOf, schemaChanges, type StoredRowScan, tableColumns } from "./guidance-sql.js";
import { SupervisorIds } from "./ids.js";
import {
  Activity,
  Settings,
  type GuidanceActivity,
  type GuidanceSettings,
} from "./guidance-contract.js";

// a new store's settings row: the classification generation and the evidence retention
const defaults: GuidanceSettings = {
  generation: 1,
  evidenceHours: 24,
};
export const fingerprint = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** A user-facing guidance conflict, with the baseline store's message. */
export class GuidanceConflictError extends Schema.TaggedError<GuidanceConflictError>()("GuidanceConflict", {
  message: Schema.String,
}) {}

const MetaValue = Schema.Struct({ value: Schema.String });
const DocumentColumn = Schema.Struct({ document: Schema.String });
const decodeSettingsRow = decodeGuidanceRow(Schema.Struct({ value: Schema.fromJsonString(Settings) }), "settings");
const decodeActivityDocument = decodeGuidanceRow(Schema.fromJsonString(Activity), "activity");
const decodeActivityRow = decodeGuidanceRow(Schema.Struct({ id: Schema.String, document: Schema.String }), "activity");
const decodeDocumentColumn = decodeGuidanceRow(DocumentColumn, "activity");
const decodeMetaValue = decodeGuidanceRow(MetaValue, "meta");
const decodeClassificationRow = decodeGuidanceRow(Schema.Struct({ classification: Schema.String }), "classification");
const NoticeColumns = Schema.Struct({
  id: Schema.String, thread_id: Schema.String, rule_id: Schema.String, run_id: Schema.String, epoch: Schema.Number, state: Schema.String,
  text: Schema.String, message_id: Schema.NullOr(Schema.String), created_at: Schema.Number, dispatch_started: Schema.Number,
  rule_generation: Schema.Number, settings_generation: Schema.Number,
});
const decodeNoticeRow = decodeGuidanceRow(NoticeColumns, "notice");
const decodeUnresolvedRow = decodeGuidanceRow(NoticeColumns.mapFields((fields) => ({
  id: fields.id, thread_id: fields.thread_id, rule_id: fields.rule_id, run_id: fields.run_id, epoch: fields.epoch, created_at: fields.created_at,
})), "notice");

type GuidanceFailure = GuidanceStoreError | GuidanceConflictError;
type RecordInput = Omit<GuidanceActivity, "id" | "createdAt"> & ({kind:"guidance";episodeEpoch:number;noticeId:string|null}|{kind:"owner_action"});

/**
 * The guidance store: the environment binding, project classifications, retained activity history and its retention. The tables of the
 * retired reminder rules (rules, mutes, observations, episodes, notices, budget) stay as they are; only history and retention read them.
 */
export interface GuidanceStoreShape {
  readonly settings: () => Effect.Effect<GuidanceSettings, GuidanceStoreError>;
  readonly bind: (environmentId: string) => Effect.Effect<void, GuidanceFailure>;
  readonly classification: (id: string) => Effect.Effect<"project" | "scratch" | "unclassified", GuidanceStoreError>;
  readonly classify: (id: string, classification: "project" | "scratch", generation: number) => Effect.Effect<void, GuidanceFailure>;
  readonly record: (value: RecordInput, now?: number) => Effect.Effect<GuidanceActivity, GuidanceStoreError>;
  readonly activities: () => Effect.Effect<GuidanceActivity[], GuidanceStoreError>;
  readonly prune: (now?: number) => Effect.Effect<void, GuidanceStoreError>;
}

const schema = [
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

const budgetDay = (now: number): string => new Date(now).toISOString().slice(0, 10);

const makeGuidanceStore = Effect.gen(function* () {
  const db = yield* GuidanceDb;
  const invalidate = yield* dashboardInvalidation(db);
  const ids = yield* SupervisorIds;
  const conflict = (message: string) => Effect.fail(new GuidanceConflictError({ message }));

  const readSettings = db`SELECT value FROM meta WHERE key='settings'`.pipe(
    Effect.flatMap(([row]) => decodeSettingsRow(row)), Effect.map((row) => row.value));
  const nowOr = (now: number | undefined) => now === undefined ? Clock.currentTimeMillis : Effect.succeed(now);
  const writeActivity = Effect.fnUntraced(function* (value: RecordInput, now: number) {
    const activity = { ...value, id: yield* ids.uuid, createdAt: now };
    yield* db`INSERT INTO activity VALUES(${activity.id},${JSON.stringify(activity)},${now})`;
    return activity;
  });

  // schema, the default settings row, the column additions and the restart recovery of committed notices, in the
  // baseline constructor's order and in one transaction
  yield* guidanceSql(db.withTransaction(Effect.gen(function* () {
    for (const statement of schema) yield* db.unsafe(statement);
    yield* db`INSERT OR IGNORE INTO meta VALUES('settings',${JSON.stringify(defaults)})`;
    if (!(yield* tableColumns(db, "episodes")).includes("object_id")) yield* db.unsafe("ALTER TABLE episodes ADD COLUMN object_id TEXT");
    const noticeColumns = yield* tableColumns(db, "notices");
    for (const column of ["rule_generation", "settings_generation"])
      if (!noticeColumns.includes(column)) yield* db.unsafe(`ALTER TABLE notices ADD COLUMN ${column} INTEGER NOT NULL DEFAULT -1`);
    const recovering = yield* Effect.forEach(yield* db`SELECT * FROM notices WHERE state='committed'`, (row) => decodeNoticeRow(row));
    yield* db`UPDATE notices SET state=CASE WHEN dispatch_started=0 THEN 'not_delivered_restart' ELSE 'uncertain' END WHERE state='committed'`;
    const now = yield* Clock.currentTimeMillis;
    for (const row of recovering)
      yield* writeActivity({kind:"guidance",threadId:row.thread_id,ruleId:row.rule_id,runId:row.run_id,
        noticeId:row.id,episodeEpoch:row.epoch,state:row.dispatch_started===1?"uncertain":"not_delivered_restart",
        reason:"process_recovery",detail:null}, now);
  })));

  const settings = () => guidanceSql(readSettings);

  // read-check-write: joins the caller's transaction
  const bind = (environmentId: string) => guidanceSql(db.withTransaction(Effect.gen(function* () {
    const [row] = yield* db`SELECT value FROM meta WHERE key='environment'`;
    const previous = row === undefined ? undefined : (yield* decodeMetaValue(row)).value;
    if (previous !== undefined && previous !== environmentId) return yield* conflict("Guidance belongs to another T3 environment.");
    yield* db`INSERT OR IGNORE INTO meta VALUES('environment',${environmentId})`;
  })));

  const classification = (id: string) => guidanceSql(db`SELECT classification FROM classifications WHERE project_id=${id}`.pipe(
    Effect.flatMap(([row]) => row === undefined ? Effect.succeed(undefined) : Effect.map(decodeClassificationRow(row), (value) => value.classification)),
    Effect.map((value) => value === "project" || value === "scratch" ? value : "unclassified" as const)));

  const classify = (id: string, value: "project" | "scratch", generation: number) => guidanceSql(db.withTransaction(Effect.gen(function* () {
    const current = yield* readSettings;
    if (current.generation !== generation) return yield* conflict("Settings changed. Reload first.");
    yield* db`INSERT INTO classifications VALUES(${id},${value}) ON CONFLICT(project_id) DO UPDATE SET classification=excluded.classification`;
    // only the generation moves; the row's other stored fields stay as they are
    yield* db`UPDATE meta SET value=json_set(value,'$.generation',${generation + 1}) WHERE key='settings'`;
    yield* invalidate(projectKeys(id));
  })));

  const record = (value: RecordInput, now?: number) => guidanceSql(Effect.flatMap(nowOr(now), (at) => writeActivity(value, at).pipe(Effect.tap(() => invalidate(["snapshot"])))));

  // two reads of one snapshot
  const activities = () => guidanceSql(db.withTransaction(Effect.gen(function* () {
    const unresolved: GuidanceActivity[] = [];
    for (const raw of yield* db`SELECT id,thread_id,rule_id,run_id,epoch,created_at FROM notices WHERE state='uncertain' ORDER BY created_at DESC`) {
      const row = yield* decodeUnresolvedRow(raw);
      const [evidence] = yield* db`SELECT document FROM activity WHERE json_extract(document,'$.noticeId')=${row.id} AND json_extract(document,'$.detail') IS NOT NULL ORDER BY created_at DESC LIMIT 1`;
      const detail = evidence === undefined ? null : (yield* decodeActivityDocument((yield* decodeDocumentColumn(evidence)).document)).detail;
      unresolved.push({
        id:`notice:${row.id}`,noticeId:row.id,episodeEpoch:row.epoch,threadId:row.thread_id,ruleId:row.rule_id,runId:row.run_id,
        kind:"guidance",state:"uncertain",reason:"unreconciled_notice",detail,createdAt:row.created_at,
      });
    }
    const recent: GuidanceActivity[] = [];
    for (const row of yield* db`SELECT document FROM activity ORDER BY created_at DESC LIMIT 200`)
      recent.push(yield* decodeActivityDocument((yield* decodeDocumentColumn(row)).document));
    return [...unresolved,...recent.filter(row=>!unresolved.some(notice=>notice.noticeId===row.noticeId))];
  })));

  // CC-GDB-IMPLICIT: every pruning statement commits together, or none does
  const prune = (now?: number) => guidanceSql(Effect.flatMap(nowOr(now), (at) => db.withTransaction(Effect.gen(function* () {
    const evidenceCutoff = at - (yield* readSettings).evidenceHours * 3600_000;
    yield* db`UPDATE notices SET text='' WHERE created_at<${evidenceCutoff} AND state IN ('visible','accepted','rejected','not_delivered_restart')`;
    for (const raw of yield* db`SELECT id,document FROM activity WHERE created_at<${evidenceCutoff}`) {
      const row = yield* decodeActivityRow(raw);
      const activity = yield* decodeActivityDocument(row.document);
      if (activity.detail !== null) {
        yield* db`UPDATE activity SET document=${JSON.stringify({ ...activity, detail: null })} WHERE id=${row.id}`;
        yield* invalidate(["snapshot"]);
      }
    }
    const removed = yield* db`DELETE FROM activity WHERE created_at<${at - 30 * 86400_000} RETURNING id`;
    if (removed.length > 0) yield* invalidate(["snapshot"]);
    yield* db`DELETE FROM budget WHERE day<${budgetDay(at - 7 * 86400_000)}`;
  }))));

  return GuidanceStore.of({settings, bind, classification, classify, record, activities, prune});
});

/**
 * The guidance store on the run's GuidanceDb client. Its layer creates the schema, the default settings, the column
 * additions and the restart recovery once. Every multi-statement method runs in one transaction and joins the caller's
 * transaction when there is one (a savepoint); time comes from Clock and identities from SupervisorIds.
 */
export class GuidanceStore extends Context.Service<GuidanceStore, GuidanceStoreShape>()("t3-supervisor/GuidanceStore") {
  static readonly layer: Layer.Layer<GuidanceStore, GuidanceStoreError, GuidanceDb | SupervisorIds> =
    Layer.effect(GuidanceStore, untracedSql(makeGuidanceStore));
}

/**
 * The rollout scan of the guidance tables (read only): every stored row through the decoder its reader uses, the open's table
 * and column additions, and the committed notices the open recovers as the baseline open did.
 */
export const checkGuidanceRows: Effect.Effect<StoredRowScan, SqlError.SqlError | GuidanceStoreError, GuidanceDb> = Effect.gen(function* () {
  const db = yield* GuidanceDb;
  const changes = [
    ...(yield* Effect.forEach(["meta", "rules", "mutes", "classifications", "observations", "activity", "budget"], (table) => schemaChanges(db, table))).flat(),
    ...yield* schemaChanges(db, "episodes", ["object_id"]),
    ...yield* schemaChanges(db, "notices", ["rule_generation", "settings_generation"]),
  ];
  const call = {problem: "undecodable", read: "call"} as const;
  const notices = yield* rowsOf(db, "notices", "SELECT * FROM notices");
  // a column the open adds reads as its default
  const withNoticeDefaults = (row: Record<string, unknown>) => ({rule_generation: -1, settings_generation: -1, ...row});
  const findings = [
    ...yield* rowFindings(yield* rowsOf(db, "meta", "SELECT key,value FROM meta WHERE key='settings'"), {...call, table: "meta", kind: "settings"}, (row) => rowKey(row, ["key"]), decodeSettingsRow),
    ...yield* rowFindings(yield* rowsOf(db, "activity", "SELECT id,document FROM activity"), {...call, table: "activity", kind: "activity"}, (row) => rowKey(row, ["id"]),
      (row) => Effect.flatMap(decodeActivityRow(row), (activity) => decodeActivityDocument(activity.document))),
    ...yield* rowFindings(yield* rowsOf(db, "classifications", "SELECT project_id,classification FROM classifications"), {...call, table: "classifications", kind: "classification"},
      (row) => rowKey(row, ["project_id"]), decodeClassificationRow),
    ...yield* rowFindings(notices, {problem: "undecodable", table: "notices", kind: "notice", read: "call"}, (row) => rowKey(row, ["id"]),
      (row) => row.state === "committed" ? Effect.void : decodeNoticeRow(withNoticeDefaults(row))),
    ...yield* rowFindings(notices.filter((row) => row.state === "committed"), {problem: "undecodable", table: "notices", kind: "committed notice", read: "open"},
      (row) => rowKey(row, ["id"]), (row) => decodeNoticeRow(withNoticeDefaults(row))),
  ];
  const recovered = notices.filter((row) => row.state === "committed").length;
  return {findings, changes: recovered ? [...changes, {table: "notices", change: "committed notices recovered as not delivered or uncertain (as the baseline open did)", rows: recovered}] : changes};
});
