import { Context, Effect, Layer, Schema } from "effect";
import type { SqlError } from "effect/sql";
import { GuidanceDb, untracedSql } from "./db.js";
import { decodeGuidanceRow, type GuidanceStoreError, guidanceSql, rowFindings, rowKey, rowsOf, type StoredRowScan } from "./guidance-sql.js";
import { GuidanceStore } from "./guidance-store.js";

const disposableTables = [
  "supervisor_project_bindings", "supervisor_main_bindings", "supervisor_task_interpretations",
  "supervisor_conversation_requests", "supervisor_workflow_introductions", "supervisor_workflow_agreement_candidates",
  "supervisor_monitor_project_clock", "supervisor_monitor_binding_clock", "supervisor_monitor_items", "supervisor_monitor_threads",
] as const;

const decodeVersionRow = decodeGuidanceRow(Schema.Struct({ value: Schema.String }), "meta");

/** The Effect API of the supervision state reset; both join the caller's transaction. */
export interface SupervisorStateResetShape {
  /** Resets the explicitly disposable prototype state, preserving defaults and permanent ownership. */
  readonly resetSupervisorTestState: () => Effect.Effect<void, GuidanceStoreError>;
  /**
   * Whether the stored supervision scope is the main-thread one; any other stored scope disables supervision. The approved
   * one-time reset of the project-scoped prototype is part of the startup upgrade to guidance format 1, which records main-v1.
   */
  readonly scopeCompatible: () => Effect.Effect<boolean, GuidanceStoreError>;
}

const makeSupervisorStateReset = Effect.gen(function* () {
  const db = yield* GuidanceDb;
  // the reset reads and writes the guidance store's meta table, which its layer creates
  yield* GuidanceStore;

  const reset = Effect.gen(function* () {
    for (const table of disposableTables) {
      if ((yield* db`SELECT 1 FROM sqlite_master WHERE type='table' AND name=${table}`).length > 0) yield* db`DELETE FROM ${db(table)}`;
    }
    yield* db`DELETE FROM meta WHERE key IN ('supervisor_activation_baseline','supervisor_activation_sequence')`;
  });

  const resetSupervisorTestState = () => guidanceSql(db.withTransaction(reset));

  // a read only: a file at the current format always has a stored scope version
  const scopeCompatible = () => guidanceSql(Effect.gen(function* () {
    const [row] = yield* db`SELECT value FROM meta WHERE key='supervisor_scope_version'`;
    return row !== undefined && (yield* decodeVersionRow(row)).value === "main-v1";
  }));

  return SupervisorStateReset.of({ resetSupervisorTestState, scopeCompatible });
});

/**
 * The scope check and the test reset on the run's GuidanceDb client; the project-supervisor store's layer reads the scope
 * before any other supervision store use, after GuidanceStore.layer (both run on the guidance store's meta table).
 */
export class SupervisorStateReset extends Context.Service<SupervisorStateReset, SupervisorStateResetShape>()("t3-supervisor/SupervisorStateReset") {
  static readonly layer: Layer.Layer<SupervisorStateReset, never, GuidanceDb | GuidanceStore> = Layer.effect(SupervisorStateReset, untracedSql(makeSupervisorStateReset));
}

/**
 * The rollout scan of the scope version (read only): an undecodable version fails the run's start; an unknown version disables
 * supervision; an absent one makes the startup upgrade to guidance format 1 run the one-time reset, whose cleared rows are listed
 * per table.
 */
export const checkScopeVersion: Effect.Effect<StoredRowScan, SqlError.SqlError | GuidanceStoreError, GuidanceDb> = Effect.gen(function* () {
  const db = yield* GuidanceDb;
  const rows = yield* rowsOf(db, "meta", "SELECT key,value FROM meta WHERE key='supervisor_scope_version'");
  const findings = yield* rowFindings(rows, { table: "meta", kind: "scope version", problem: "undecodable", read: "open" }, (row) => rowKey(row, ["key"]), decodeVersionRow);
  const [row] = rows;
  if (row !== undefined) return {
    findings: typeof row.value === "string" && row.value !== "main-v1" ? [...findings, { table: "meta", kind: "scope version", key: "supervisor_scope_version",
      problem: "incompatible" as const, read: "open" as const }] : findings,
    changes: [],
  };
  const changes = [];
  for (const table of disposableTables) {
    const [count] = yield* rowsOf(db, table, `SELECT count(*) AS n FROM ${table}`);
    if (count !== undefined && Number(count.n) > 0) changes.push({ table, change: "cleared by the upgrade's one-time reset (no stored scope version)", rows: Number(count.n) });
  }
  const [activation] = yield* rowsOf(db, "meta", "SELECT count(*) AS n FROM meta WHERE key IN ('supervisor_activation_baseline','supervisor_activation_sequence')");
  if (activation !== undefined && Number(activation.n) > 0) changes.push({ table: "meta", change: "activation rows cleared by the upgrade's one-time reset", rows: Number(activation.n) });
  return { findings, changes };
});
