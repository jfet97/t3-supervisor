import { dashboardInvalidation } from "./dashboard-updates.js";
import { Context, Data, Effect, Layer, Schema } from "effect";
import { GuidanceDb, untracedSql } from "./db.js";
import { type GuidanceStoreError, mapSqlError, rowFindings, rowKey, rowsOf, type StoredRowScan, tableExists } from "./guidance-sql.js";
import type { SqlError } from "effect/sql";

import { ThreadPolicy as ThreadPolicyDocument, type ThreadPolicySettings } from "./thread-policy-contract.js";
const validId = (id: string) => id.length > 0 && id.length <= 512 && !/[\s\x00-\x1f\x7f]/u.test(id);

// a failure of the policy row in guidance.sqlite3: a statement failed (sqlReason is the driver's classification) or the stored
// policy row did not decode; it carries no statement text, row content or cause, and a missing or invalid row is never read as
// absent
export class ThreadPolicyStoreError extends Data.TaggedError("ThreadPolicyStoreError")<{
  readonly reason: "sql_failed" | "row_invalid";
  readonly sqlReason: string | null;
}> {
  override get message(): string {
    return this.reason === "row_invalid" ? "thread policy row invalid" : `thread policy sql failed: ${this.sqlReason}`;
  }
}

/** A save with an invalid generation or chat id list, with the baseline store's message. */
export class ThreadPolicyInvalid extends Schema.TaggedError<ThreadPolicyInvalid>()("ThreadPolicyInvalid", {
  message: Schema.Literal("Choose valid, unique chat IDs."),
}) {}

/** A save whose generation no longer matches the stored policy, with the baseline store's message. */
export class ThreadPolicyConflict extends Schema.TaggedError<ThreadPolicyConflict>()("ThreadPolicyConflict", {
  message: Schema.Literal("Chat settings changed in another tab. Reload first."),
}) {}

const decodePolicyRow = Schema.decodeUnknownEffect(Schema.Struct({ document: Schema.fromJsonString(ThreadPolicyDocument) }));
const decodeChanges = Schema.decodeUnknownEffect(Schema.Struct({ changes: Schema.Number }));
const rowInvalid = () => new ThreadPolicyStoreError({ reason: "row_invalid", sqlReason: null });

const policySql = mapSqlError((error) => new ThreadPolicyStoreError({ reason: "sql_failed", sqlReason: error.reason._tag }));

/** The excluded-chat policy of the instance (its one row in guidance.sqlite3). */
export interface ThreadPolicyStoreShape {
  /** An authoritative read of the stored policy on every call; nothing is cached. */
  readonly get: () => Effect.Effect<ThreadPolicySettings, ThreadPolicyStoreError>;
  /** Saves by compare-and-set on the stored generation and returns the saved policy with the next generation. */
  readonly save: (input: ThreadPolicySettings) => Effect.Effect<ThreadPolicySettings, ThreadPolicyStoreError | ThreadPolicyInvalid | ThreadPolicyConflict>;
}

/**
 * Builds the thread-policy store on the run's guidance client, the one its consumers' transactions run on, so a save inside a
 * guidance transaction commits or rolls back with that transaction's bookkeeping. The table and its one row exist from the
 * startup upgrade, which seeds the configured excluded chats only into a genuinely fresh directory and otherwise imports the
 * retired thread-settings.sqlite3; a missing or invalid row is never repaired here and fails every read as row_invalid.
 */
export const makeThreadPolicyStore = () => Effect.gen(function* () {
  const db = yield* GuidanceDb;
  const invalidate = yield* dashboardInvalidation(db);

  const get = () => policySql(db`SELECT document FROM thread_policy WHERE id=1`.pipe(
    Effect.flatMap(([row]) => decodePolicyRow(row).pipe(Effect.mapError(rowInvalid))),
    Effect.map((row) => row.document)));

  // the compare-and-set is one statement: exactly one changed row commits the next generation
  const save = (input: ThreadPolicySettings) => policySql(Effect.gen(function* () {
    if (!Number.isSafeInteger(input.generation) || input.excludedThreadIds.length > 500 ||
      !input.excludedThreadIds.every(validId) || new Set(input.excludedThreadIds).size !== input.excludedThreadIds.length)
      return yield* new ThreadPolicyInvalid({ message: "Choose valid, unique chat IDs." });
    const next = { ...input, generation: input.generation + 1 };
    const updated = yield* db`UPDATE thread_policy SET document=${JSON.stringify(next)} WHERE id=1 AND json_extract(document,'$.generation')=${input.generation}`.raw.pipe(
      Effect.flatMap((result) => decodeChanges(result).pipe(Effect.mapError(rowInvalid))));
    if (!updated.changes) return yield* new ThreadPolicyConflict({ message: "Chat settings changed in another tab. Reload first." });
    yield* invalidate(null);
    return next;
  }));

  return ThreadPolicyStore.of({ get, save });
}).pipe(untracedSql);

/** The thread-policy store on the run's guidance client. */
export class ThreadPolicyStore extends Context.Service<ThreadPolicyStore, ThreadPolicyStoreShape>()("t3-supervisor/ThreadPolicyStore") {
  static readonly layer: Layer.Layer<ThreadPolicyStore, never, GuidanceDb> = Layer.effect(ThreadPolicyStore, makeThreadPolicyStore());
}

/**
 * The rollout scan of the policy in guidance.sqlite3 (read only): the stored policy row through the decoder of every read, which
 * each supervision cycle and Stop check performs. A guidance file below format 2 has no policy table yet: its start creates it
 * with the policy it imports from the retired thread-settings.sqlite3.
 */
export const checkThreadPolicyRows: Effect.Effect<StoredRowScan, SqlError.SqlError | GuidanceStoreError, GuidanceDb> = Effect.gen(function* () {
  const db = yield* GuidanceDb;
  if (!(yield* tableExists(db, "thread_policy")))
    return { findings: [], changes: [{ table: "thread_policy", change: "created by the upgrade with the policy imported from thread-settings.sqlite3", rows: 1 }] };
  const rows = yield* rowsOf(db, "thread_policy", "SELECT id,document FROM thread_policy");
  const findings = yield* rowFindings(rows, { table: "thread_policy", kind: "thread policy", problem: "undecodable", read: "cycle" }, (row) => rowKey(row, ["id"]), decodePolicyRow);
  // a policy table without its row is never reseeded: the startup upgrade refuses it
  const missing = rows.length === 0 ? [{ table: "thread_policy", kind: "thread policy", key: "1", problem: "incompatible" as const, read: "open" as const }] : [];
  return { findings: [...findings, ...missing], changes: [] };
});
