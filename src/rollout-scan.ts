import { existsSync } from "node:fs";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import type { SqlClient } from "effect/sql";
import { DatabaseFormats, GuidanceDb, PolicyDb, readFormat, readOnlyDatabase } from "./db.js";
import { checkGitProbeRows } from "./git-probe.js";
import type { OpenChange, StoredRowFinding, StoredRowScan } from "./guidance-sql.js";
import { checkGuidanceRows } from "./guidance-store.js";
import { checkProjectSupervisorRows } from "./project-supervisor-store.js";
import { checkConversationRows } from "./supervisor-conversation-store.js";
import { checkHelperRows } from "./supervisor-helper-transport.js";
import { checkMonitorRows } from "./supervisor-monitor-store.js";
import { checkScopeVersion } from "./supervisor-state-reset.js";
import { checkTeamToolReceipts } from "./supervisor-team-controller.js";
import { checkTeamRows } from "./supervisor-team-store.js";
import { checkThreadPolicyRows } from "./thread-policy.js";
import { checkWorkflowStateRows } from "./workflow-state-store.js";
import { checkWorkflowWriteRows } from "./workflow-write-controller.js";

/*
 * the read-only rollout scan of a data directory before a version is started on it: every database file is opened read only
 * (no file is created, no pragma or statement writes) and reported with its format, its SQLite user_version, beside the format
 * this version runs; only the service's start creates or upgrades a file (src/database-upgrade.ts). The rows of guidance.sqlite3
 * and thread-settings.sqlite3 go through the decoders their readers use, and what the service's start changes in them is listed:
 * its upgrade creates tables and clears the one-time reset's rows, the stores' open recovers committed notices.
 * Nothing contacts T3
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
   * the rows of guidance.sqlite3 and thread-settings.sqlite3 at a format this version runs or upgrades; null for another file,
   * an absent one, or a newer format, whose rows this version's readers cannot judge
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
const guidanceChecks = [checkGuidanceRows, checkScopeVersion, checkProjectSupervisorRows, checkConversationRows, checkMonitorRows, checkTeamRows,
  checkWorkflowStateRows, checkHelperRows, checkTeamToolReceipts, checkWorkflowWriteRows, checkGitProbeRows];

const accessFile = "access/login.sqlite3";

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

/** The row checks of a file, on its read-only client behind the service its stores use. */
interface RowChecks<S> {
  readonly client: (sql: SqlClient.SqlClient) => Layer.Layer<S>;
  readonly checks: ReadonlyArray<Effect.Effect<StoredRowScan, unknown, S>>;
}

/*
 * one file read only through its own read-only client (src/db.ts), or absent; a missing file is reported, never created. Its
 * format is read first (through a live write-ahead log too), its rows only at a format this version runs or upgrades
 */
const scanFile = <S>(directory: string, file: string, current: number, rows?: RowChecks<S>): Effect.Effect<FileScan, unknown> =>
  Effect.scoped(Effect.gen(function* () {
    if (!existsSync(join(directory, file))) return {file, present: false, format: null, current, rows: null} satisfies FileScan;
    const sql = yield* readOnlyDatabase(directory, file);
    const format = yield* readFormat(sql);
    if (rows === undefined || format > current) return {file, present: true, format, current, rows: null} satisfies FileScan;
    const {client, checks} = rows;
    const scans = yield* Effect.forEach(checks, (check) => Effect.provide(check, client(sql)));
    return {file, present: true, format, current,
      rows: {findings: grouped(scans.flatMap((scan) => scan.findings)), changes: scans.flatMap((scan) => scan.changes)}} satisfies FileScan;
  }));

/** Scans the database files of `directory` read only, in the order the service's start upgrades them. */
export const rolloutScan = (directory: string): Effect.Effect<RolloutScan, unknown> => Effect.gen(function* () {
  const files = [
    yield* scanFile(directory, accessFile, DatabaseFormats.access),
    yield* scanFile(directory, "catalog.sqlite3", DatabaseFormats.catalog),
    yield* scanFile(directory, "guidance.sqlite3", DatabaseFormats.guidance, {client: (sql) => Layer.succeed(GuidanceDb, sql), checks: guidanceChecks}),
    yield* scanFile(directory, "thread-settings.sqlite3", DatabaseFormats.policy, {client: (sql) => Layer.succeed(PolicyDb, sql), checks: [checkThreadPolicyRows]}),
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
  if (file.format === null) return `${file.file}: absent (${file.file === accessFile
    ? "the service creates it when it starts the dashboard" : "only the service's start creates it, for a new installation"})`;
  if (file.format === file.current) return `${file.file}: present, format ${file.format} (current)`;
  return file.format < file.current
    ? `${file.file}: present, format ${file.format} (older than format ${file.current}, which this version runs: the service's start upgrades it, or refuses a layout it does not recognize)`
    : `${file.file}: present, format ${file.format} (newer than format ${file.current}, which this version runs: the service refuses to start on it)`;
};

/** The scan as text: per file its format, and for guidance and thread-settings each finding group with its keys and what the start changes. */
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
