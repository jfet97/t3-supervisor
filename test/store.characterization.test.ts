import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { CatalogDb, catalogDbLayer } from "../src/db.js";
import { makeStore, Store, StoreError, type StoreShape } from "../src/store.js";
import { ThreadPolicyStore } from "../src/thread-policy.js";
import type { ProjectInfo, SourceItem, ThreadInfo } from "../src/types.js";
import { initializeDataDirectory } from "./support/data-directory.js";
import { dataDirectory, withGuidanceStore, withThreadPolicy } from "./support/g9-stores.js";

/*
 * it.live: real database files, an external node:sqlite connection as the other actor (it reads the raw catalog file without
 * the production layer's pragmas or modes) and node:fs inspection of the files and their modes
 */

const project = (id: string, title = `Project ${id}`): ProjectInfo => ({ id, title, workspaceRoot: `/work/${id}` });

const thread = (id: string, projectId: string | null = "project-1"): ThreadInfo => ({
  id,
  title: `Conversation ${id}`,
  projectId,
  lineage: { parentThreadId: null, relationshipToParent: null },
  archivedAt: null,
});

const snapshot = (sequence: number, projects: unknown[], threads: unknown[]): SourceItem => ({
  stream: "active",
  item: { kind: "snapshot", snapshot: { schemaVersion: 2, snapshotSequence: sequence, projects, threads, archivedThreads: [] } },
});

const withStore = <A, E, R>(directory: string, use: (store: StoreShape) => Effect.Effect<A, E, R>) =>
  Effect.scoped(Effect.provide(Store.use(use), makeStore(directory)));

// `run` on a fresh temporary directory, removed when `run` ends
const withTemporaryDirectory = <A, E, R>(run: (directory: string) => Effect.Effect<A, E, R>) =>
  Effect.scoped(Effect.flatMap(dataDirectory("t3-supervisor-catalog-characterization-"), run));

const catalogPath = (directory: string): string => join(directory, "catalog.sqlite3");

// node:sqlite rows have a null prototype; strict deep equality compares plain copies
const plain = (row: unknown): Record<string, unknown> => ({ ...row as Record<string, unknown> });

// an external connection plays the other actor; closing it as the last connection checkpoints and removes the wal
const withConnection = <A>(path: string, use: (database: DatabaseSync) => A): A => {
  const database = new DatabaseSync(path);
  try {return use(database);} finally {database.close();}
};

const catalogTables = ["activations", "cursors", "environment_binding", "projects", "thread_revisions", "threads"];

const dumpCatalog = (directory: string): Record<string, unknown[]> => withConnection(catalogPath(directory), database =>
  Object.fromEntries(catalogTables.map(table => [table, database.prepare(`SELECT rowid, * FROM ${table} ORDER BY rowid`).all().map(plain)])));

const mode = (path: string): number => statSync(path).mode & 0o777;

it.live("CT-STORE-01: a snapshot ingest failing mid-way leaves projects, threads and cursor exactly as before", () =>
  withTemporaryDirectory(directory => Effect.gen(function* () {
    yield* withStore(directory, store => Effect.gen(function* () {
      yield* store.activate("environment-1", 1_000);
      yield* store.ingest(snapshot(10, [project("project-1")], [thread("thread-a"), thread("thread-b")]));
    }));
    const before = dumpCatalog(directory);
    assert.equal(before.threads?.length, 2);
    assert.equal(before.cursors?.length, 1);

    // the second thread fails after the project writes and before any thread write (missing lineage), or after the first thread write (id over the limit)
    const failures = [
      { shell: { id: "thread-c", title: "Missing lineage" }, message: "thread shell is missing lineage metadata" },
      { shell: thread("x".repeat(513)), message: "thread id exceeds the T3 contract limit" },
    ];
    const observed = yield* withStore(directory, store => Effect.gen(function* () {
      const errors: unknown[] = [];
      for (const failure of failures) {
        errors.push(yield* Effect.flip(store.ingest(snapshot(20,
          [project("project-1", "Renamed project"), project("project-2")],
          [{ ...thread("thread-a"), title: "Changed title" }, failure.shell]))));
      }
      return { errors, catalog: yield* store.catalog(), cursor: yield* store.cursor("active") };
    }));
    assert.deepEqual(observed.errors.map(error => error instanceof StoreError ? error.message : error),
      failures.map(failure => failure.message));
    assert.equal(observed.cursor, 10);
    assert.deepEqual(observed.catalog.projects.map(entry => [entry.project.id, entry.project.title, entry.available]),
      [["project-1", "Project project-1", true]]);
    assert.deepEqual(observed.catalog.threads.map(value => [value.id, value.title]),
      [["thread-a", "Conversation thread-a"], ["thread-b", "Conversation thread-b"]]);
    assert.deepEqual(dumpCatalog(directory), before);

    // the rolled-back transaction leaves the connection usable for the next valid snapshot
    yield* withStore(directory, store => store.ingest(snapshot(20, [project("project-1", "Renamed project")], [thread("thread-a")])));
    const after = dumpCatalog(directory);
    assert.deepEqual(after.cursors, [{ rowid: 1, stream: "active", sequence: 20 }]);
    assert.deepEqual((after.threads as Array<Record<string, unknown>>).map(row => [row.id, row.location]),
      [["thread-a", "active"], ["thread-b", "removed"]]);
  })), { timeout: 10_000 });

/*
 * CT-STORE-02's rule, the one-time rewrite of stored legacy shells through the whitelist, and an unreadable stored shell that
 * fails it with the file unchanged, is the catalog format 1 step of the startup upgrade (test/database-migrations.test.ts); the
 * store's open rewrites nothing
 */

it.live("CT-STORE-03: the store connection carries the pragma golden and only journal_mode persists", () =>
  withTemporaryDirectory(directory => Effect.gen(function* () {
    const pragmas = yield* Effect.scoped(Effect.gen(function* () {
      // the store is built on the catalog client that the layer also exposes, so the pragmas are read on the store's connection
      yield* Store;
      const database = yield* CatalogDb;
      const read = (name: string) => database.unsafe(`PRAGMA ${name}`).pipe(Effect.map(([row]) => plain(row)));
      return yield* Effect.forEach(["journal_mode", "synchronous", "foreign_keys", "busy_timeout", "wal_autocheckpoint", "secure_delete", "max_page_count"],
        name => read(name).pipe(Effect.map(value => [name, value])));
    }).pipe(Effect.provide(Store.layer.pipe(Layer.provideMerge(catalogDbLayer(directory)), Layer.provide(NodeFileSystem.layer)))));
    assert.deepEqual(pragmas, [
      ["journal_mode", { journal_mode: "wal" }],
      ["synchronous", { synchronous: 2 }],
      ["foreign_keys", { foreign_keys: 1 }],
      ["busy_timeout", { timeout: 5000 }],
      ["wal_autocheckpoint", { wal_autocheckpoint: 256 }],
      ["secure_delete", { secure_delete: 1 }],
      ["max_page_count", { max_page_count: 16384 }],
    ]);
    assert.deepEqual(withConnection(catalogPath(directory), database => plain(database.prepare("PRAGMA journal_mode").get())), { journal_mode: "wal" });
  })), { timeout: 10_000 });

it.live("CT-FILES-MODE-01: after first open and one write the stores keep private file modes", () => Effect.gen(function* () {
  yield* Effect.acquireRelease(Effect.sync(() => process.umask(0o022)), (previousMask) => Effect.sync(() => process.umask(previousMask)));
  const root = yield* dataDirectory("t3-supervisor-file-modes-");
  /*
   * a data directory that exists before startup with the umask-default 0755 mode; the startup coordinator prepares it before
   * any store opens it, as `t3-supervisor start` does
   */
  const dataDirectoryAt = (name: string) => Effect.gen(function* () {
    const path = join(root, name);
    mkdirSync(path);
    chmodSync(path, 0o755);
    assert.equal(mode(path), 0o755);
    yield* initializeDataDirectory(path);
    return path;
  });
  const databaseModes = (directory: string, file: string) => {
    const paths = [file, `${file}-wal`, `${file}-shm`].map(name => join(directory, name));
    assert.deepEqual(paths.map(path => existsSync(path)), [true, true, true], `${file} and its wal and shm exist while open`);
    return paths.map(mode);
  };
  const catalogDirectory = yield* dataDirectoryAt("catalog");
  const catalogModes = yield* withStore(catalogDirectory, store => store.activate("environment-1", 1_000).pipe(
    Effect.map(() => databaseModes(catalogDirectory, "catalog.sqlite3"))));
  assert.deepEqual(catalogModes, [0o600, 0o600, 0o600]);

  const guidanceDirectory = yield* dataDirectoryAt("guidance");
  yield* withGuidanceStore(guidanceDirectory, guidance => Effect.gen(function* () {
    yield* guidance.bind("environment-1");
    assert.deepEqual(databaseModes(guidanceDirectory, "guidance.sqlite3"), [0o600, 0o600, 0o600]);
  }));

  const policyDirectory = yield* dataDirectoryAt("policy");
  yield* withThreadPolicy(policyDirectory, policy => Effect.gen(function* () {
    yield* policy.save({ generation: 1, excludedThreadIds: ["thread-1"] });
    assert.deepEqual(databaseModes(policyDirectory, "guidance.sqlite3"), [0o600, 0o600, 0o600]);
  }));

  // main.ts opens the catalog store, then supervision opens the guidance client with the guidance and thread-policy stores over it
  const startup = yield* dataDirectoryAt("startup");
  const modes = yield* withStore(startup, store => Effect.gen(function* () {
    yield* store.activate("environment-1", 1_000);
    return yield* withGuidanceStore(startup, startupGuidance => Effect.gen(function* () {
      const startupPolicy = yield* ThreadPolicyStore;
      yield* startupGuidance.bind("environment-1");
      yield* startupPolicy.save({ generation: 1, excludedThreadIds: ["thread-1"] });
      return {
        directory: mode(startup),
        files: ["catalog.sqlite3", "guidance.sqlite3"].map(file => databaseModes(startup, file)),
      };
    }).pipe(Effect.provide(Layer.fresh(ThreadPolicyStore.layer))));
  }));
  assert.deepEqual(modes, {
    directory: 0o700,
    files: [[0o600, 0o600, 0o600], [0o600, 0o600, 0o600]],
  });
}), { timeout: 10_000 });
