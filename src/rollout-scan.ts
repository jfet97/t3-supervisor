import { existsSync } from "node:fs";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import type { SqlClient } from "effect/sql";
import { DatabaseFormats, GuidanceDb, readFormat, readOnlyDatabase } from "./db.js";
import { checkGitProbeRows } from "./git-probe.js";
import { type OpenChange, rowFindings, rowKey, rowsOf, type StoredRowFinding, type StoredRowScan, tableExists } from "./guidance-sql.js";
import { checkGuidanceRows } from "./guidance-store.js";
import { checkProjectSupervisorRows } from "./project-supervisor-store.js";
import { checkConversationRows } from "./supervisor-conversation-store.js";
import { checkHelperRows } from "./supervisor-helper-transport.js";
import { checkMonitorRows } from "./supervisor-monitor-store.js";
import { checkScopeVersion } from "./supervisor-state-reset.js";
import { checkTeamToolReceipts } from "./supervisor-team-controller.js";
import { checkTeamRows } from "./supervisor-team-store.js";
import { checkThreadPolicyRows } from "./thread-policy.js";
import { ThreadPolicy } from "./thread-policy-contract.js";
import { checkWorkflowStateRows } from "./workflow-state-store.js";
import { checkWorkflowWriteRows } from "./workflow-write-controller.js";

/*
 * the read-only rollout scan of a data directory before a version is started on it: every database file is opened read only
 * (no file is created, no pragma or statement writes) and reported with its format, its SQLite user_version, beside the format
 * this version runs; only the service's start creates or upgrades a file (src/database-upgrade.ts). The rows of guidance.sqlite3
 * go through the decoders their readers use, and what the service's start changes in them is listed: its upgrade creates tables,
 * imports the policy and clears the one-time reset's rows, the stores' open recovers committed notices. The retired
 * thread-settings.sqlite3, whose policy the start imports into guidance before removing it, has its one row decoded as the
 * import reads it. Nothing contacts T3
 */

/** The findings of one row kind, with the keys of its rows (never their content). */
export interface FindingGroup {
  readonly table: string;
  readonly kind: string;
  readonly problem: StoredRowFinding["problem"];
  readonly read: StoredRowFinding["read"];
  readonly count: number;
  readonly keys: ReadonlyArray<string>;
}
/** The stored rows of a file through the decoders its readers use, and what the service's start changes in the file. */
export interface RowScan {
  readonly findings: ReadonlyArray<FindingGroup>;
  readonly changes: ReadonlyArray<OpenChange>;
}
export interface FileScan {
  readonly file: string;
  readonly present: boolean;
  /** the stored format (PRAGMA user_version) of a present file, null for an absent one; Supervisor 0.0.27 and older wrote none, so their files are 0 */
  readonly format: number | null;
  /** the format this version runs */
  readonly current: number;
  /**
   * the rows of guidance.sqlite3, or of the retired thread-settings.sqlite3, at a format this version runs or imports; null for
   * another file, an absent one, or a newer format, whose rows this version's readers cannot judge
   */
  readonly rows: RowScan | null;
}
export interface RolloutScan {
  /** the database files in the order the service's start upgrades them */
  readonly files: ReadonlyArray<FileScan>;
  /** findings the run reads when it opens its stores or in every supervision cycle: they fail its start or its cycles */
  readonly blocking: number;
  /** files at a newer format than this version runs: the service refuses to start on them */
  readonly unsupported: ReadonlyArray<string>;
}

// the stores of guidance.sqlite3 in the order the run opens them
const guidanceChecks: ReadonlyArray<Effect.Effect<StoredRowScan, unknown, GuidanceDb>> = [checkGuidanceRows, checkThreadPolicyRows, checkScopeVersion, checkProjectSupervisorRows, checkConversationRows, checkMonitorRows,
  checkTeamRows, checkWorkflowStateRows, checkHelperRows, checkTeamToolReceipts, checkWorkflowWriteRows, checkGitProbeRows];

const accessFile = "access/login.sqlite3";
// the retired policy file: the start imports its one row into guidance format 2, then removes it
const donorFile = "thread-settings.sqlite3";
// the last format of the retired file; the start imports it and every earlier one
const donorFormat = 1;

const decodeDonorRow = Schema.decodeUnknownEffect(Schema.Struct({ document: Schema.fromJsonString(ThreadPolicy) }));

// the retired file's one policy row, decoded as the import reads it; a file without it fails the start, as does a second row
const checkPolicyDonorRows = (db: SqlClient.SqlClient): Effect.Effect<StoredRowScan, unknown> => Effect.gen(function* () {
  const rows = yield* rowsOf(db, "settings", "SELECT id,document FROM settings");
  const findings = yield* rowFindings(rows, { table: "settings", kind: "thread policy", problem: "undecodable", read: "open" }, (row) => rowKey(row, ["id"]), decodeDonorRow);
  const missing = rows.length !== 1 && (yield* tableExists(db, "settings"))
    ? [{ table: "settings", kind: "thread policy", key: "1", problem: "incompatible" as const, read: "open" as const }] : [];
  // only a row the import reads moves; any other one refuses the start, which changes nothing
  return { findings: [...findings, ...missing], changes: rows.length === 1 && findings.length === 0
    ? [{ table: "settings", change: "imported into guidance.sqlite3 by the upgrade, then the file is removed", rows: 1 }] : [] };
});

const grouped = (findings: ReadonlyArray<StoredRowFinding>): Array<FindingGroup> => {
  const groups = new Map<string, {group: Omit<FindingGroup, "count" | "keys">; keys: Array<string>}>();
  for (const finding of findings) {
    const id = JSON.stringify([finding.table, finding.kind, finding.problem, finding.read]);
    const current = groups.get(id) ?? {group: {table: finding.table, kind: finding.kind, problem: finding.problem, read: finding.read}, keys: []};
    current.keys.push(finding.key);
    groups.set(id, current);
  }
  return [...groups.values()].map(({group, keys}) => ({...group, count: keys.length, keys}));
};

/** The row checks of a file, on its read-only client. */
type RowChecks = (sql: SqlClient.SqlClient) => ReadonlyArray<Effect.Effect<StoredRowScan, unknown>>;

// the guidance checks on the client behind the service its stores use
const guidanceRows: RowChecks = (sql) => guidanceChecks.map((check) => Effect.provideService(check, GuidanceDb, sql));

/*
 * one file read only through its own read-only client (src/db.ts), or absent; a missing file is reported, never created. Its
 * format is read first (through a live write-ahead log too), its rows only at a format this version runs or upgrades
 */
const scanFile = (directory: string, file: string, current: number, rows?: RowChecks): Effect.Effect<FileScan, unknown> =>
  Effect.scoped(Effect.gen(function* () {
    if (!existsSync(join(directory, file))) return {file, present: false, format: null, current, rows: null} satisfies FileScan;
    const sql = yield* readOnlyDatabase(directory, file);
    const format = yield* readFormat(sql);
    if (rows === undefined || format > current) return {file, present: true, format, current, rows: null} satisfies FileScan;
    const scans = yield* Effect.forEach(rows(sql), (check) => check);
    return {file, present: true, format, current,
      rows: {findings: grouped(scans.flatMap((scan) => scan.findings)), changes: scans.flatMap((scan) => scan.changes)}} satisfies FileScan;
  }));

/** Scans the database files of `directory` read only, in the order the service's start upgrades them. */
export const rolloutScan = (directory: string): Effect.Effect<RolloutScan, unknown> => Effect.gen(function* () {
  const files = [
    yield* scanFile(directory, accessFile, DatabaseFormats.access),
    yield* scanFile(directory, "catalog.sqlite3", DatabaseFormats.catalog),
    yield* scanFile(directory, "guidance.sqlite3", DatabaseFormats.guidance, guidanceRows),
    yield* scanFile(directory, donorFile, donorFormat, (sql) => [checkPolicyDonorRows(sql)]),
  ];
  const blocking = files.flatMap((file) => file.rows?.findings ?? []).filter((group) => group.read !== "call").reduce((total, group) => total + group.count, 0);
  const unsupported = files.filter((file) => file.format !== null && file.format > file.current).map((file) => file.file);
  return {files, blocking, unsupported};
});

/*
 * what the service's start does with a file: the auth service creates a missing access database when the service starts its
 * dashboard, the startup upgrade creates the other files only in a new data directory, upgrades an older format whose layout
 * it recognizes (its own preflight decides; the scan does not repeat it) and refuses a newer one
 */
const fileLine = (file: FileScan): string => {
  if (file.file === donorFile) return file.format === null ? `${file.file}: absent (retired: guidance.sqlite3 holds the policy)`
    : file.format > file.current ? `${file.file}: present, format ${file.format} (not a format of the retired policy file: the service refuses to start on it)`
    : `${file.file}: present, format ${file.format} (retired: the service's start imports its policy into guidance.sqlite3 and removes it, or refuses one that differs from the policy guidance already imported)`;
  if (file.format === null) return `${file.file}: absent (${file.file === accessFile
    ? "the service creates it when it starts the dashboard" : "only the service's start creates it, for a new installation"})`;
  if (file.format === file.current) return `${file.file}: present, format ${file.format} (current)`;
  return file.format < file.current
    ? `${file.file}: present, format ${file.format} (older than format ${file.current}, which this version runs: the service's start upgrades it, or refuses a layout it does not recognize)`
    : `${file.file}: present, format ${file.format} (newer than format ${file.current}, which this version runs: the service refuses to start on it)`;
};

/** The scan as text: per file its format, and for guidance and the retired thread-settings each finding group with its keys and what the start changes. */
export const renderRolloutScan = (directory: string, scan: RolloutScan): string => {
  const lines = [`rollout scan of ${directory} (read only; no file was written and T3 was not contacted)`];
  for (const file of scan.files) {
    lines.push(fileLine(file));
    if (file.rows === null) continue;
    const {findings, changes} = file.rows;
    lines.push(findings.length ? `  rows the stores would not read as stored (${findings.reduce((total, group) => total + group.count, 0)}):` : "  every stored row decodes");
    for (const group of findings)
      lines.push(`    ${group.table} / ${group.kind}: ${group.count} ${group.problem}, read at ${group.read}; keys: ${group.keys.join(", ")}`);
    lines.push(changes.length ? "  what the service's start changes, in its upgrade or when its stores open:" : "  the service's start changes no table, column or row");
    for (const change of changes) lines.push(`    ${change.table}: ${change.change}${change.rows ? ` (${change.rows} rows)` : ""}`);
  }
  if (scan.unsupported.length) lines.push(`verdict: the service refuses to start on ${scan.unsupported.join(", ")}, at a newer format than this version runs`);
  lines.push(scan.blocking ? `verdict: ${scan.blocking} row(s) read at open or in every cycle would fail the run`
    : "verdict: no stored row blocks the run's start or its cycles");
  return lines.join("\n");
};
