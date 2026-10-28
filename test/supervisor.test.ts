import assert from "node:assert/strict";
import {it} from "@effect/vitest";
import {Clock, Deferred, Effect, Fiber, Option, Stream, SubscriptionRef} from "effect";
import {makeStore, Store, type StoreShape} from "../src/store.js";
import {createStatus, readiness, supervise} from "../src/supervisor.js";
import {T3TransportError, type T3ClientShape} from "../src/t3.js";
import type {ProjectInfo, SupervisorConfig} from "../src/types.js";
import {dataDirectory} from "./support/g9-stores.js";
import {rootServices} from "./support/g9-supervisor.js";

const config = (directory: string): SupervisorConfig => ({
  dataDirectory: directory,
  t3Url: "http://unused",
  t3TokenFile: "unused",
  excludedThreadIds: [],
  healthPort: 0,
});

it("readiness depends on native T3 connection, activation, catalog health, and enabled supervision", () => {
  const settings = config("/tmp/supervisor-readiness");
  settings.uiPort = 9008;
  const now = Date.now();
  const status = createStatus(settings, now);
  status.heartbeat = now;
  assert.equal(readiness(status, settings, now).ready, false);
  status.activation = new Date(now).toISOString();
  status.t3Connected = true;
  status.storeState = "ready";
  assert.equal(readiness(status, settings, now).ready, false);
  status.supervisionState = "ready";
  assert.equal(readiness(status, settings, now).ready, true);
  status.supervisionState = "degraded";
  assert.equal(readiness(status, settings, now).ready, false);
});

// it.live: the run listens on a real health port and the catalog and thread-policy files are real; the 3 s bound is a hang
// guard on the live clock
it.live("native T3 events persist into the generic catalog and mark the service connected", () => Effect.gen(function* () {
  const directory = yield* dataDirectory("supervisor-loop-");
  const settings = config(directory);
  const statusRef = yield* SubscriptionRef.make(createStatus(settings, yield* Clock.currentTimeMillis));
  const project: ProjectInfo = {id: "project", title: "Project", workspaceRoot: "/work/project"};
  const fake: T3ClientShape = {
    descriptor: () => Effect.succeed({environmentId: "environment", serverVersion: "test", orchestrationProtocolVersion: 2}),
    projection: () => Effect.fail(new T3TransportError("No projection is expected")),
    watch: (_cursor, onItem) => onItem({
      stream: "active",
      item: {kind: "snapshot", snapshot: {schemaVersion: 2, snapshotSequence: 1, projects: [project], threads: [], archivedThreads: []}},
      archiveCut: {snapshotSequence: 1, threads: []},
    }).pipe(Effect.andThen(Effect.never)),
  };
  const fiber = yield* Effect.forkScoped(supervise(rootServices(settings, statusRef, fake)));
  // the first status in which the stored item marked the service connected after activation
  const status = Option.getOrThrow(yield* SubscriptionRef.changes(statusRef).pipe(
    Stream.filter((current) => current.t3Connected && current.activation !== null), Stream.runHead, Effect.timeout("3 seconds")));
  assert.equal(status.t3Connected, true);
  assert.equal(status.environmentId, "environment");
  assert.ok(status.activation);
  yield* Fiber.interrupt(fiber);
  const catalog = yield* Store.use(store => store.catalog()).pipe(Effect.provide(makeStore(directory)));
  assert.deepEqual(catalog.projects.map(item => item.project.id), ["project"]);
}));

it.live("an active cursor without a stored archive snapshot resumes from a full shell", () => Effect.gen(function* () {
  const descriptor = {environmentId: "environment", serverVersion: "test", orchestrationProtocolVersion: 2 as const};
  const shell = {id: "thread-1", title: "Conversation", projectId: null, lineage: {parentThreadId: null, relationshipToParent: null}};
  const open = (directory: string, body: (store: StoreShape) => Effect.Effect<void, unknown>) =>
    Store.use((store) => Effect.gen(function* () {
      yield* store.activate("environment", yield* Clock.currentTimeMillis);
      yield* body(store);
    })).pipe(Effect.provide(makeStore(directory)));
  const resume = (directory: string) => Effect.gen(function* () {
    const seen = yield* Deferred.make<number | undefined>();
    const client: T3ClientShape = {
      descriptor: () => Effect.succeed(descriptor),
      projection: () => Effect.fail(new T3TransportError("No projection is expected")),
      watch: (cursor) => Deferred.succeed(seen, cursor).pipe(Effect.andThen(Effect.never)),
    };
    const status = yield* SubscriptionRef.make(createStatus(config(directory), yield* Clock.currentTimeMillis));
    const fiber = yield* Effect.forkScoped(supervise(rootServices(config(directory), status, client)));
    const cursor = yield* Deferred.await(seen).pipe(Effect.timeout("3 seconds"));
    yield* Fiber.interrupt(fiber);
    return cursor;
  });

  const partial = yield* dataDirectory("supervisor-partial-");
  yield* open(partial, (store) => store.ingest({
    stream: "active",
    item: {kind: "thread.updated", sequence: 8, thread: shell},
  }).pipe(Effect.asVoid));
  assert.equal(yield* resume(partial), undefined);

  const covered = yield* dataDirectory("supervisor-covered-");
  yield* open(covered, (store) => store.ingest({
    stream: "active",
    item: {kind: "snapshot", snapshot: {schemaVersion: 2, snapshotSequence: 8, projects: [], threads: [], archivedThreads: []}},
    archiveCut: {snapshotSequence: 8, threads: []},
  }).pipe(Effect.asVoid));
  assert.equal(yield* resume(covered), 8);
}));
