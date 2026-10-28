import assert from "node:assert/strict";
import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import { GuidanceDb } from "../src/db.js";
import type { GuidanceSettings } from "../src/guidance-contract.js";
import { GuidanceStoreError } from "../src/guidance-sql.js";
import { GuidanceConflictError, GuidanceStore, type GuidanceStoreShape } from "../src/guidance-store.js";
import { guidanceDb, rows, sequentialIds, temporaryDirectory } from "./support/guidance-store-services.js";

// target regressions of the GuidanceStore effect service on a temporary guidance.sqlite3 through the production layers:
// open-time schema (recovery and migration, CT-GDB-01 and CT-GDB-02, live in test/guidance.characterization.test.ts),
// transactions that join the caller's (CT-GDB-06's target), the CC-GDB-IMPLICIT sequences in one transaction, typed row and
// sql failures and the synchronous store's method results

const layer = (directory: string) => GuidanceStore.layer.pipe(Layer.provideMerge(guidanceDb(directory)), Layer.provide(sequentialIds()));

// every use opens the client and the store afresh and closes them again, as a process restart would
const withGuidance = <A, E>(directory: string, use: (store: GuidanceStoreShape, db: GuidanceDb["Service"]) => Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    return yield* use(yield* GuidanceStore, yield* GuidanceDb);
  }).pipe(Effect.provide(layer(directory)));

const defaults: GuidanceSettings = { generation: 1, evidenceHours: 24 };

const conflictMessage = (error: unknown): string => {
  assert.ok(error instanceof GuidanceConflictError, `expected a GuidanceConflict, got ${String(error)}`);
  return error.message;
};

describe("GuidanceStore", () => {
  it.effect("the layer creates the schema and the default settings once and keeps a moved generation on reopen", () => Effect.gen(function* () {
    const directory = yield* temporaryDirectory;
    const first = yield* withGuidance(directory, (store, db) => Effect.gen(function* () {
      const tables = (yield* rows(db, "SELECT name FROM sqlite_master WHERE type IN ('table','index') AND name NOT LIKE 'sqlite_%' ORDER BY name")).map((row) => row.name);
      const settings = yield* store.settings();
      yield* store.classify("project-a", "scratch", settings.generation);
      return { tables, settings, saved: yield* store.settings() };
    }));
    // the retired reminder tables stay: existing installations keep their rows
    assert.deepEqual(first.tables, ["activity", "activity_notice", "budget", "classifications", "episodes", "meta", "mutes", "notices", "observations", "rules"]);
    assert.deepEqual(first.settings, defaults);
    assert.deepEqual(first.saved, { ...defaults, generation: 2 });
    assert.deepEqual(yield* withGuidance(directory, (store) => store.settings()), first.saved);
  }), { timeout: 10_000 });

  // audit F10: the dashboard no longer serves the retired reminder settings, but an existing installation's stored row is never
  // rewritten to drop them; only its generation moves
  it.effect("a stored settings row of the retired reminder rules reads its live fields and keeps the rest when classification moves it", () => Effect.gen(function* () {
    const directory = yield* temporaryDirectory;
    const legacy = { generation: 4, guidancePaused: true, monitoringPaused: false, allowFollowupRace: false, verifiedServerVersion: null, model: "gpt-6-luna",
      reasoning: "high", dailyTokenBudget: 5_000, evidenceHours: 168, maxAnchorAgeSeconds: 60 };
    const observed = yield* withGuidance(directory, (store, db) => Effect.gen(function* () {
      yield* db`UPDATE meta SET value=${JSON.stringify(legacy)} WHERE key='settings'`;
      const read = yield* store.settings();
      yield* store.classify("project-a", "project", read.generation);
      return { read, after: yield* store.settings(), stored: yield* rows(db, "SELECT value FROM meta WHERE key='settings'") };
    }));
    assert.deepEqual(observed.read, { generation: 4, evidenceHours: 168 });
    assert.deepEqual(observed.after, { generation: 5, evidenceHours: 168 });
    assert.deepEqual(JSON.parse(String(observed.stored[0]!.value)), { ...legacy, generation: 5 });
  }), { timeout: 10_000 });

  it.live("CT-GDB-06 target: a store transaction inside the caller's transaction joins it, committing and rolling back with the caller", () => Effect.gen(function* () {
    const directory = yield* temporaryDirectory;
    const observed = yield* withGuidance(directory, (store, db) => Effect.gen(function* () {
      const settings = yield* store.settings();
      // the caller fails after the joined classification: its writes roll back with the caller's own
      const failed = yield* Effect.flip(db.withTransaction(Effect.gen(function* () {
        yield* db`INSERT INTO meta VALUES('s6d-outer','1')`;
        yield* store.classify("project-a", "scratch", settings.generation);
        return yield* Effect.fail("caller failed" as const);
      })));
      const afterFailure = { settings: yield* store.settings(), classification: yield* store.classification("project-a"),
        outer: yield* rows(db, "SELECT key FROM meta WHERE key LIKE 's6d-%'") };
      // the caller commits: the joined classification commits with it
      yield* db.withTransaction(Effect.gen(function* () {
        yield* db`INSERT INTO meta VALUES('s6d-committed','1')`;
        yield* store.classify("project-a", "scratch", settings.generation);
      }));
      const saved = yield* store.settings();
      // a joined conflict fails the caller without leaving the connection inside a transaction
      const conflict = yield* Effect.flip(db.withTransaction(store.classify("project-a", "project", settings.generation)));
      yield* store.classify("project-a", "project", saved.generation);
      return { failed, afterFailure, saved, conflict: conflictMessage(conflict), next: yield* store.settings(),
        classification: yield* store.classification("project-a"), outer: yield* rows(db, "SELECT key FROM meta WHERE key LIKE 's6d-%' ORDER BY key") };
    }));
    assert.equal(observed.failed, "caller failed");
    assert.deepEqual(observed.afterFailure, { settings: defaults, classification: "unclassified", outer: [] });
    assert.deepEqual(observed.saved, { ...defaults, generation: 2 });
    assert.equal(observed.conflict, "Settings changed. Reload first.");
    assert.deepEqual(observed.next, { ...defaults, generation: 3 });
    assert.equal(observed.classification, "project");
    assert.deepEqual(observed.outer, [{ key: "s6d-committed" }]);
  }), { timeout: 10_000 });

  it.effect("bind keeps the first environment and refuses another with the synchronous store's message", () => Effect.gen(function* () {
    const directory = yield* temporaryDirectory;
    const observed = yield* withGuidance(directory, (store, db) => Effect.gen(function* () {
      yield* store.bind("environment-a");
      yield* store.bind("environment-a");
      const refused = conflictMessage(yield* Effect.flip(store.bind("environment-b")));
      return { refused, environment: yield* rows(db, "SELECT value FROM meta WHERE key='environment'") };
    }));
    assert.deepEqual(observed, { refused: "Guidance belongs to another T3 environment.", environment: [{ value: "environment-a" }] });
  }), { timeout: 10_000 });

  it.effect("classifications move the settings generation and a stale generation is refused", () => Effect.gen(function* () {
    const directory = yield* temporaryDirectory;
    yield* TestClock.setTime(5_000);
    const observed = yield* withGuidance(directory, (store) => Effect.gen(function* () {
      const before = yield* store.classification("project-a");
      yield* store.classify("project-a", "scratch", 1);
      const staleClassify = conflictMessage(yield* Effect.flip(store.classify("project-a", "project", 1)));
      return { before, after: yield* store.classification("project-a"), staleClassify, settings: yield* store.settings() };
    }));
    assert.deepEqual([observed.before, observed.after], ["unclassified", "scratch"]);
    assert.equal(observed.staleClassify, "Settings changed. Reload first.");
    assert.equal(observed.settings.generation, 2);
  }), { timeout: 10_000 });

  it.effect("records and activities: unresolved uncertain notices first with their latest detail evidence, then the 200 most recent", () => Effect.gen(function* () {
    const directory = yield* temporaryDirectory;
    yield* TestClock.setTime(9_000);
    const observed = yield* withGuidance(directory, (store, db) => Effect.gen(function* () {
      yield* db`INSERT INTO notices(id,thread_id,rule_id,run_id,epoch,state,text,created_at) VALUES('uncertain-a','thread-a','rule-a','run-a',2,'uncertain','text',${100})`;
      const evidence = yield* store.record({ kind: "guidance", threadId: "thread-a", ruleId: "rule-a", runId: "run-a", noticeId: "uncertain-a", episodeEpoch: 2,
        state: "uncertain", reason: "dispatch_unknown", detail: "evidence" }, 200);
      yield* store.record({ kind: "guidance", threadId: "thread-a", ruleId: "rule-a", runId: "run-a", noticeId: "uncertain-a", episodeEpoch: 2,
        state: "uncertain", reason: "later", detail: null }, 300);
      const stamped = yield* store.record({ kind: "owner_action", threadId: null, ruleId: null, runId: null, state: "done", reason: "owner", detail: null });
      for (let index = 0; index < 205; index++)
        yield* store.record({ kind: "owner_action", threadId: null, ruleId: null, runId: null, state: "done", reason: `bulk-${index}`, detail: null }, 1_000 + index);
      return { evidence, stamped, activities: yield* store.activities() };
    }));
    assert.deepEqual(observed.evidence, { kind: "guidance", threadId: "thread-a", ruleId: "rule-a", runId: "run-a", noticeId: "uncertain-a", episodeEpoch: 2,
      state: "uncertain", reason: "dispatch_unknown", detail: "evidence", id: "00000000-0000-4000-8000-000000000001", createdAt: 200 });
    assert.equal(observed.stamped.createdAt, 9_000);
    assert.deepEqual(observed.activities[0], { id: "notice:uncertain-a", noticeId: "uncertain-a", episodeEpoch: 2, threadId: "thread-a", ruleId: "rule-a",
      runId: "run-a", kind: "guidance", state: "uncertain", reason: "unreconciled_notice", detail: "evidence", createdAt: 100 });
    assert.equal(observed.activities.length, 201);
    assert.deepEqual(observed.activities.slice(1, 3).map((item) => item.reason), ["owner", "bulk-204"]);
    assert.equal(observed.activities.some((item) => item.noticeId === "uncertain-a" && item.reason !== "unreconciled_notice"), false);
  }), { timeout: 10_000 });

  it.effect("prune blanks old notice text and activity detail, deletes month-old activity and week-old budget days", () => Effect.gen(function* () {
    const directory = yield* temporaryDirectory;
    const now = Date.parse("2026-10-23T12:00:00.000Z");
    yield* TestClock.setTime(now);
    const observed = yield* withGuidance(directory, (store, db) => Effect.gen(function* () {
      const old = now - 25 * 3_600_000;
      yield* db`INSERT INTO notices(id,thread_id,rule_id,run_id,epoch,state,text,created_at) VALUES('old-visible','t','r','run',0,'visible','old text',${old}),('old-uncertain','t','r','run',0,'uncertain','kept text',${old}),('new-visible','t','r','run',0,'visible','new text',${now})`;
      yield* store.record({ kind: "owner_action", threadId: null, ruleId: null, runId: null, state: "done", reason: "old", detail: "old detail" }, old);
      yield* store.record({ kind: "owner_action", threadId: null, ruleId: null, runId: null, state: "done", reason: "new", detail: "new detail" }, now);
      yield* store.record({ kind: "owner_action", threadId: null, ruleId: null, runId: null, state: "done", reason: "ancient", detail: null }, now - 31 * 86_400_000);
      yield* db`INSERT INTO budget VALUES('2026-10-15',1),('2026-10-16',2),('2026-10-23',3)`;
      yield* store.prune();
      return {
        notices: yield* rows(db, "SELECT id,text FROM notices ORDER BY id"),
        activity: yield* rows(db, "SELECT json_extract(document,'$.reason') AS reason, json_extract(document,'$.detail') AS detail FROM activity ORDER BY created_at"),
        budget: yield* rows(db, "SELECT day FROM budget ORDER BY day"),
      };
    }));
    assert.deepEqual(observed.notices, [{ id: "new-visible", text: "new text" }, { id: "old-uncertain", text: "kept text" }, { id: "old-visible", text: "" }]);
    assert.deepEqual(observed.activity, [{ reason: "old", detail: null }, { reason: "new", detail: "new detail" }]);
    assert.deepEqual(observed.budget, [{ day: "2026-10-16" }, { day: "2026-10-23" }]);
  }), { timeout: 10_000 });

  it.live("CC-GDB-IMPLICIT: a prune that meets an activity row it cannot decode fails typed and leaves every row as it was", () => Effect.gen(function* () {
    const directory = yield* temporaryDirectory;
    const now = Date.parse("2026-10-23T12:00:00.000Z");
    const observed = yield* withGuidance(directory, (store, db) => Effect.gen(function* () {
      const old = now - 25 * 3_600_000;
      yield* db`INSERT INTO notices(id,thread_id,rule_id,run_id,epoch,state,text,created_at) VALUES('old-visible','t','r','run',0,'visible','old text',${old})`;
      yield* store.record({ kind: "owner_action", threadId: null, ruleId: null, runId: null, state: "done", reason: "old", detail: "old detail" }, old);
      yield* db`INSERT INTO activity VALUES('corrupt','{"kind":"owner_action"}',${old + 1})`;
      const before = [yield* rows(db, "SELECT * FROM notices"), yield* rows(db, "SELECT * FROM activity ORDER BY id")];
      const failure = yield* Effect.flip(store.prune(now));
      return { failure, before, after: [yield* rows(db, "SELECT * FROM notices"), yield* rows(db, "SELECT * FROM activity ORDER BY id")] };
    }));
    assert.ok(observed.failure instanceof GuidanceStoreError);
    assert.deepEqual({ reason: observed.failure.reason, row: observed.failure.row }, { reason: "row_invalid", row: "activity" });
    assert.deepEqual(observed.after, observed.before, "the notice text blanked before the failing row is rolled back");
  }), { timeout: 10_000 });

  it.live("R19: a stored settings row that does not decode is a typed failure naming the row kind, never absent", () => Effect.gen(function* () {
    const directory = yield* temporaryDirectory;
    const observed = yield* withGuidance(directory, (store, db) => Effect.gen(function* () {
      yield* db`UPDATE meta SET value='{"broken":true}' WHERE key='settings'`;
      const settings = yield* Effect.flip(store.settings());
      yield* db`DELETE FROM meta WHERE key='settings'`;
      const missing = yield* Effect.flip(store.settings());
      return [settings, missing];
    }));
    assert.deepEqual(observed.map((error) => error instanceof GuidanceStoreError ? [error.reason, error.row] : String(error)),
      [["row_invalid", "settings"], ["row_invalid", "settings"]]);
    // the typed failure carries neither the row content nor a cause
    assert.equal(JSON.stringify(observed).includes("broken"), false);
  }), { timeout: 10_000 });

  it.live("a failed statement is a typed sql failure with the driver's classification and no statement or cause", () => Effect.gen(function* () {
    const directory = yield* temporaryDirectory;
    const failure = yield* withGuidance(directory, (store, db) => Effect.gen(function* () {
      yield* db.unsafe("CREATE TEMP TRIGGER s6d_fail_classify BEFORE INSERT ON classifications BEGIN SELECT RAISE(ABORT, 's6d injected secret failure'); END");
      return yield* Effect.flip(store.classify("project-a", "scratch", 1));
    }));
    assert.ok(failure instanceof GuidanceStoreError);
    assert.deepEqual({ reason: failure.reason, row: failure.row, sqlReason: failure.sqlReason }, { reason: "sql_failed", row: null, sqlReason: "ConstraintError" });
    assert.equal(`${failure.message} ${JSON.stringify(failure)}`.includes("secret"), false);
    assert.equal("cause" in failure, false);
  }), { timeout: 10_000 });

});
