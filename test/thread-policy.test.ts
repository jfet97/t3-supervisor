import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { ThreadPolicyConflict, ThreadPolicyInvalid, ThreadPolicyStoreError } from "../src/thread-policy.js";
import { failsWith, rows } from "./support/guidance-store-services.js";
import { dataDirectory, withThreadPolicy } from "./support/g9-stores.js";

/*
 * the ThreadPolicyStore service over the policy row of a temporary guidance.sqlite3 (its production client and layer): the
 * baseline case, then the authoritative read on every call and typed row failures. Seeding the configured excluded chats once
 * into a fresh directory, and never into an existing one, is the startup upgrade's (test/database-upgrade.test.ts)
 */

it.effect("excluded-thread policy persists and uses compare-and-swap generations", () => Effect.gen(function* () {
  const directory = yield* dataDirectory("supervisor-policy-", { excludedThreadIds: ["excluded"] });
  const saved = yield* withThreadPolicy(directory, (store) => Effect.gen(function* () {
    const previous = yield* store.get();
    const saved = yield* store.save({...previous, excludedThreadIds: []});
    assert.ok((yield* failsWith(store.save(previous), /another tab/u)) instanceof ThreadPolicyConflict);
    assert.ok((yield* failsWith(store.save({...saved, excludedThreadIds: ["invalid id"]}), /valid/u)) instanceof ThreadPolicyInvalid);
    assert.ok((yield* failsWith(store.save({...saved, excludedThreadIds: ["excluded", "excluded"]}), /unique/u)) instanceof ThreadPolicyInvalid);
    return saved;
  }));
  // the first client closed; the store reopens on the same file and reads the saved policy
  yield* withThreadPolicy(directory, (store) => Effect.gen(function* () {
    assert.deepEqual(yield* store.get(), saved);
  }));
}));

it.effect("every get is an authoritative read of the stored row", () => Effect.gen(function* () {
  const directory = yield* dataDirectory("supervisor-policy-");
  const observed = yield* withThreadPolicy(directory, (store, db) => Effect.gen(function* () {
    const stored = yield* store.get();
    // a write the store did not make is seen by the next read: nothing is cached
    yield* db`UPDATE thread_policy SET document=${JSON.stringify({ generation: 7, excludedThreadIds: ["written-elsewhere"] })} WHERE id=1`;
    return { stored, reread: yield* store.get() };
  }));
  assert.deepEqual(observed, { stored: { generation: 1, excludedThreadIds: [] }, reread: { generation: 7, excludedThreadIds: ["written-elsewhere"] } });
  // a store on a new client of the file reads the same row
  assert.deepEqual(yield* withThreadPolicy(directory, (store) => store.get()), { generation: 7, excludedThreadIds: ["written-elsewhere"] });
}));

it.effect("a stored policy row that is missing or does not decode is a typed failure, never a default", () => Effect.gen(function* () {
  const directory = yield* dataDirectory("supervisor-policy-");
  const failures = yield* withThreadPolicy(directory, (store, db) => Effect.gen(function* () {
    yield* db`UPDATE thread_policy SET document='{"generation":"one"}' WHERE id=1`;
    const invalid = yield* Effect.flip(store.get());
    yield* db`DELETE FROM thread_policy`;
    const missing = yield* Effect.flip(store.get());
    const save = yield* Effect.flip(store.save({ generation: 1, excludedThreadIds: [] }));
    return { invalid, missing, save, rows: yield* rows(db, "SELECT * FROM thread_policy") };
  }));
  for (const failure of [failures.invalid, failures.missing]) {
    assert.ok(failure instanceof ThreadPolicyStoreError);
    assert.equal(failure.reason, "row_invalid");
  }
  assert.ok(failures.save instanceof ThreadPolicyConflict, "a save against a missing row changes nothing and conflicts");
  assert.deepEqual(failures.rows, []);
}));
