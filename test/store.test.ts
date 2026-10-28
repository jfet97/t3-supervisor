import assert from "node:assert/strict";
import { join } from "node:path";
import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Effect, FileSystem, Layer } from "effect";
import { CatalogDb, catalogDbLayer } from "../src/db.js";
import { makeStore, Store, StoreError, type StoreShape } from "../src/store.js";
import type { ProjectInfo, SourceItem, ThreadInfo } from "../src/types.js";

const project = (id = "project-1", title = "Project one", workspaceRoot = "/work/project-one"): ProjectInfo => ({
  id,
  title,
  workspaceRoot,
});

const thread = (id = "thread-1", projectId: string | null = "project-1"): ThreadInfo => ({
  id,
  title: `Conversation ${id}`,
  projectId,
  lineage: {parentThreadId: null, relationshipToParent: null},
  archivedAt: null,
});

const sourceItem = (stream: SourceItem["stream"], item: Record<string, unknown>): SourceItem => ({stream, item});

// every use opens the store afresh and closes it again, as a process restart would
const withStore = <A>(directory: string, use: (store: StoreShape) => Effect.Effect<A, StoreError>): Effect.Effect<A, StoreError> =>
  Effect.scoped(Effect.provide(Store.use(use), Layer.fresh(makeStore(directory))));

const temporaryDirectory = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.makeTempDirectoryScoped({prefix: "t3-supervisor-catalog-"});
});

const mode = (path: string) => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return (yield* fs.stat(path)).mode & 0o777;
});

it.live("activation, catalog shells and source cursors persist in a private catalog store", () => Effect.gen(function* () {
  const directory = yield* temporaryDirectory;
  assert.equal(yield* withStore(directory, store => store.activate("environment-1", 1_000)), 1_000);
  assert.equal(yield* withStore(directory, store => store.activate("environment-1", 2_000)), 1_000);
  const mismatch = yield* Effect.flip(withStore(directory, store => store.activate("environment-2", 3_000)));
  assert.ok(mismatch instanceof StoreError && mismatch._tag === "environment_mismatch");
  yield* withStore(directory, store => Effect.gen(function* () {
    yield* store.ingest(sourceItem("active", {kind: "project.updated", sequence: 3, project: project()}));
    yield* store.ingest(sourceItem("active", {kind: "thread.updated", sequence: 4, location: "active", thread: thread()}));
  }));

  const state = yield* withStore(directory, store => Effect.gen(function* () {
    return {cursor: yield* store.cursor("active"), catalog: yield* store.catalog(), project: yield* store.project("thread-1")};
  }));
  assert.equal(state.cursor, 4);
  assert.equal(state.catalog.projects[0]?.project.title, "Project one");
  assert.equal(state.catalog.threads[0]?.id, "thread-1");
  assert.equal(state.project?.title, "Project one");
  assert.equal(yield* mode(directory), 0o700);
  assert.equal(yield* mode(join(directory, "catalog.sqlite3")), 0o600);
}).pipe(Effect.provide(NodeFileSystem.layer)));

it.live("catalog store creates only the generic T3 and activation tables", () => Effect.gen(function* () {
  const directory = yield* temporaryDirectory;
  yield* withStore(directory, store => store.stats());
  // a separate client on the closed file
  const tables = yield* Effect.gen(function* () {
    const database = yield* CatalogDb;
    return (yield* database.unsafe<{ readonly name: unknown }>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"))
      .map(row => String(row.name));
  }).pipe(Effect.provide(Layer.fresh(catalogDbLayer(directory))));
  assert.deepEqual(tables, ["activations", "cursors", "environment_binding", "projects", "shell_coverage", "thread_revisions", "threads"]);
}).pipe(Effect.provide(NodeFileSystem.layer)));

it.live("metadata enrichment updates projects without replacing inventory or rewinding the cursor", () => Effect.gen(function* () {
  const directory = yield* temporaryDirectory;
  yield* withStore(directory, store => Effect.gen(function* () {
    yield* store.ingest(sourceItem("active", {kind: "snapshot", snapshot: {
      schemaVersion: 2, snapshotSequence: 10, projects: [project()], threads: [thread()], archivedThreads: [],
    }}));
    yield* store.ingest(sourceItem("active", {kind: "snapshot", resolvedRepositoryIdentityRoots: ["/work/project-one"], snapshot: {
      schemaVersion: 2, snapshotSequence: 100, projects: [project("project-1", "Enriched title")], threads: [], archivedThreads: [],
    }}));
    yield* store.ingest(sourceItem("active", {kind: "thread.updated", sequence: 11, thread: thread("thread-2")}));
  }));

  const state = yield* withStore(directory, store => Effect.gen(function* () {
    return {cursor: yield* store.cursor("active"), catalog: yield* store.catalog(), firstProject: yield* store.project("thread-1")};
  }));
  assert.equal(state.cursor, 11);
  assert.deepEqual(state.catalog.threads.map(value => value.id), ["thread-1", "thread-2"]);
  assert.equal(state.firstProject?.title, "Enriched title");
}).pipe(Effect.provide(NodeFileSystem.layer)));

it.live("archive removal keeps the known shell and advances the archived cursor", () => Effect.gen(function* () {
  const directory = yield* temporaryDirectory;
  yield* withStore(directory, store => Effect.gen(function* () {
    yield* store.ingest(sourceItem("archive", {kind: "snapshot", snapshot: {
      schemaVersion: 2, snapshotSequence: 5, projects: [project()],
      threads: [{...thread("archived-1"), archivedAt: "2025-01-01T00:00:00.000Z"}],
    }}));
    yield* store.ingest(sourceItem("archive", {kind: "thread.removed", sequence: 6, threadId: "archived-1"}));
  }));
  const state = yield* withStore(directory, store => Effect.gen(function* () {
    return {cursor: yield* store.cursor("archive"), shell: yield* store.thread("archived-1"), catalog: yield* store.catalog()};
  }));
  assert.equal(state.cursor, 6);
  assert.equal(state.shell?.id, "archived-1");
  assert.equal(state.catalog.threads.some(value => value.id === "archived-1"), false);
}).pipe(Effect.provide(NodeFileSystem.layer)));

it.live("an empty archivedThreads list keeps the unary archive on a cold store and a populated one", () => Effect.gen(function* () {
  const directory = yield* temporaryDirectory;
  const archived = {...thread("x"), archivedAt: "2026-01-01T00:00:00.000Z"};
  const live = thread("live");
  const cut = (sequence: number, threads: ReadonlyArray<unknown>) => ({
    stream: "active" as const,
    item: {kind: "snapshot", snapshot: {
      schemaVersion: 2, snapshotSequence: sequence, projects: [project()], threads: [live], archivedThreads: [],
    }},
    archiveCut: {snapshotSequence: sequence, threads},
  });
  const location = (id: string) => Effect.gen(function* () {
    const database = yield* CatalogDb;
    const rows = yield* database.unsafe<{readonly location: unknown}>(`SELECT location FROM threads WHERE id='${id}'`);
    return rows[0] === undefined ? null : String(rows[0].location);
  }).pipe(Effect.provide(Layer.fresh(catalogDbLayer(directory))));

  yield* withStore(directory, store => Effect.gen(function* () {
    const cold = yield* store.ingest(cut(5, [archived]));
    assert.equal(cold.connected, true);
    assert.equal(yield* store.coverage(), 5);
    assert.equal(yield* store.cursor("active"), 5);
    assert.deepEqual((yield* store.catalog()).threads.map(value => value.id), ["live"]);
    assert.equal((yield* store.thread("x"))?.id, "x");
  }));
  assert.equal(yield* location("x"), "archive");

  yield* withStore(directory, store => Effect.gen(function* () {
    // a later snapshot that still carries no embedded archive rows does not remove x
    const plain = yield* store.ingest(sourceItem("active", {kind: "snapshot", snapshot: {
      schemaVersion: 2, snapshotSequence: 6, projects: [project()], threads: [live], archivedThreads: [],
    }}));
    assert.equal(plain.connected, false);
    assert.equal(yield* store.coverage(), 5);
    assert.equal(yield* store.cursor("active"), 6);
    assert.equal((yield* store.thread("x"))?.id, "x");
  }));
  assert.equal(yield* location("x"), "archive");

  yield* withStore(directory, store => Effect.gen(function* () {
    const again = yield* store.ingest(cut(7, [archived]));
    assert.equal(again.connected, true);
    assert.equal(yield* store.coverage(), 7);
    assert.equal((yield* store.thread("x"))?.id, "x");
  }));
  assert.equal(yield* location("x"), "archive");

  yield* withStore(directory, store => Effect.gen(function* () {
    const moved = yield* store.ingest(sourceItem("active", {
      kind: "thread.updated", sequence: 8, location: "active", thread: {...thread("x"), archivedAt: "2026-01-01T00:00:00.000Z"},
    }));
    assert.equal(moved.connected, true);
    assert.deepEqual((yield* store.catalog()).threads.map(value => value.id).sort(), ["live", "x"]);
    const removed = yield* store.ingest(sourceItem("active", {kind: "thread.removed", sequence: 9, location: "archive", threadId: "x"}));
    assert.equal(removed.connected, true);
    const delayed = yield* store.ingest(cut(7, [archived]));
    assert.equal(delayed.connected, false);
    assert.equal(yield* store.cursor("active"), 9);
    assert.equal(yield* store.coverage(), 7);
  }));
  assert.equal(yield* location("x"), "removed");
  assert.equal(yield* withStore(directory, store => store.cursor("active")), 9);
}).pipe(Effect.provide(NodeFileSystem.layer)));

it.live("a covered completion marker connects without moving the archive, and an uncovered marker or enrichment does not", () => Effect.gen(function* () {
  const bare = yield* temporaryDirectory;
  yield* withStore(bare, store => Effect.gen(function* () {
    const marker = yield* store.ingest(sourceItem("active", {kind: "synchronized"}));
    assert.equal(marker.connected, false);
    assert.equal(yield* store.coverage(), null);
    assert.equal(yield* store.cursor("active"), 0);
  }));

  const directory = yield* temporaryDirectory;
  const archived = {...thread("x"), archivedAt: "2026-01-01T00:00:00.000Z"};
  yield* withStore(directory, store => store.ingest({
    stream: "active",
    item: {kind: "snapshot", snapshot: {
      schemaVersion: 2, snapshotSequence: 8, projects: [project()], threads: [thread("live")], archivedThreads: [],
    }},
    archiveCut: {snapshotSequence: 8, threads: [archived]},
  }).pipe(Effect.asVoid));
  yield* withStore(directory, store => Effect.gen(function* () {
    const marker = yield* store.ingest(sourceItem("active", {kind: "synchronized"}));
    assert.equal(marker.connected, true);
    assert.equal(yield* store.cursor("active"), 8);
    assert.equal(yield* store.coverage(), 8);
    assert.equal((yield* store.thread("x"))?.id, "x");
    assert.deepEqual((yield* store.catalog()).threads.map(value => value.id), ["live"]);
    const enriched = yield* store.ingest(sourceItem("active", {
      kind: "snapshot", resolvedRepositoryIdentityRoots: ["/work/project-one"], snapshot: {
        schemaVersion: 2, snapshotSequence: 100, projects: [project("project-1", "Renamed")], threads: [thread("live")], archivedThreads: [],
      },
    }));
    assert.equal(enriched.connected, false);
    assert.equal(yield* store.cursor("active"), 8);
    assert.equal(yield* store.coverage(), 8);
    assert.equal((yield* store.catalog()).projects[0]?.project.title, "Renamed");
    assert.equal((yield* store.thread("x"))?.id, "x");
  }));
}).pipe(Effect.provide(NodeFileSystem.layer)));

it.live("explicit location wins over archivedAt, and a partial cursor is not archive coverage", () => Effect.gen(function* () {
  const directory = yield* temporaryDirectory;
  yield* withStore(directory, store => Effect.gen(function* () {
    yield* store.ingest(sourceItem("active", {
      kind: "thread.updated", sequence: 4, location: "active",
      thread: {...thread("kept"), archivedAt: "2026-01-01T00:00:00.000Z"},
    }));
    yield* store.ingest(sourceItem("active", {
      kind: "thread.updated", sequence: 5, location: "archive", thread: thread("filed"),
    }));
    assert.equal(yield* store.coverage(), null);
    assert.equal(yield* store.cursor("active"), 5);
    assert.deepEqual((yield* store.catalog()).threads.map(value => value.id), ["kept"]);
    const overlap = yield* Effect.flip(store.ingest({
      stream: "active",
      item: {kind: "snapshot", snapshot: {
        schemaVersion: 2, snapshotSequence: 6, projects: [], threads: [thread("kept")], archivedThreads: [],
      }},
      archiveCut: {snapshotSequence: 6, threads: [thread("kept")]},
    })).pipe(Effect.mapError(() => new StoreError({message: "shell snapshot was stored"})));
    assert.match(overlap.message, /active and archived/);
    assert.equal(yield* store.cursor("active"), 5);
    assert.equal(yield* store.coverage(), null);
  }));
}).pipe(Effect.provide(NodeFileSystem.layer)));

it.live("failed shell ingestion leaves its cursor unacknowledged", () => Effect.gen(function* () {
  const directory = yield* temporaryDirectory;
  yield* Effect.flip(withStore(directory, store => store.ingest(sourceItem("active", {
    kind: "thread.updated", sequence: 1, thread: {id: "malformed", title: "Missing lineage"},
  }))));
  assert.equal(yield* withStore(directory, store => store.cursor("active")), 0);
}).pipe(Effect.provide(NodeFileSystem.layer)));

it.live("stored shells omit conversation and goal text while retaining policy fields", () => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* temporaryDirectory;
  const privateValues = ["private latest visible message body", "private provider goal objective", "private last error details",
    "private background task description", "private runtime request text"];
  const shell = {
    ...thread(),
    status: "running",
    latestVisibleMessage: {id: "message", role: "assistant", text: privateValues[0]},
    goal: {status: "active", objective: privateValues[1]},
    lastError: privateValues[2],
    pendingBackgroundTasks: [{kind: "monitor", status: "running", description: privateValues[3]}],
    pendingRuntimeRequest: {id: "request", kind: "user_input", text: privateValues[4]},
  };
  const persisted = yield* withStore(directory, store => Effect.gen(function* () {
    yield* store.ingest(sourceItem("active", {kind: "thread.updated", sequence: 1, thread: shell}));
    return yield* store.thread("thread-1");
  }));
  assert.equal(persisted?.status, "running");
  assert.deepEqual(persisted?.pendingBackgroundTasks, [{kind: "monitor", status: "running"}]);
  assert.deepEqual(persisted?.pendingRuntimeRequest, {id: "request", kind: "user_input"});
  const files = yield* Effect.forEach(yield* fs.readDirectory(directory), name => fs.readFile(join(directory, name)).pipe(Effect.map(bytes => Buffer.from(bytes))));
  for (const privateValue of privateValues) {
    assert.equal(files.some(content => content.includes(Buffer.from(privateValue))), false);
    assert.equal(JSON.stringify(persisted).includes(privateValue), false);
  }
}).pipe(Effect.provide(NodeFileSystem.layer)));
