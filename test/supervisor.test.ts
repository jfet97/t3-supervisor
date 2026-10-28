import assert from "node:assert/strict";
import {createServer} from "node:http";
import {it} from "@effect/vitest";
import {Clock, Context, Deferred, Effect, Exit, Fiber, Layer, Option, Stream, SubscriptionRef} from "effect";
import {WebSocketServer} from "ws";
import {makeStore, Store, type StoreShape} from "../src/store.js";
import {createStatus, readiness, supervise} from "../src/supervisor.js";
import {makeT3Client, T3Client, T3TransportError, type T3ClientShape} from "../src/t3.js";
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

it.live("a covered resume connects on the completion marker alone, and an uncovered marker or enrichment does not", () => Effect.gen(function* () {
  const token = "resume-marker-token";
  const archived = {id: "x", title: "Archived", projectId: null, lineage: {parentThreadId: null, relationshipToParent: null}, archivedAt: "2026-01-01T00:00:00.000Z"};
  const seed = (directory: string, covered: boolean) => Store.use((store) => Effect.gen(function* () {
    yield* store.activate("environment", yield* Clock.currentTimeMillis);
    yield* covered
      ? store.ingest({
        stream: "active",
        item: {kind: "snapshot", snapshot: {schemaVersion: 2, snapshotSequence: 8, projects: [], threads: [], archivedThreads: []}},
        archiveCut: {snapshotSequence: 8, threads: [archived]},
      })
      : store.ingest({stream: "active", item: {kind: "thread.updated", sequence: 8, thread: {id: "live", title: "Live", projectId: null, lineage: {parentThreadId: null, relationshipToParent: null}}}});
  })).pipe(Effect.provide(makeStore(directory)), Effect.asVoid);
  const listen = (values: ReadonlyArray<unknown>) => Effect.gen(function* () {
    const subscribed = yield* Deferred.make<unknown>();
    const acked = yield* Deferred.make<void>();
    const http = createServer((request, response) => {
      const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      if (request.method === "GET" && path === "/.well-known/t3/environment") {
        const body = JSON.stringify({environmentId: "environment", orchestrationProtocolVersion: 2, serverVersion: "test"});
        response.writeHead(200, {"content-type": "application/json", "content-length": Buffer.byteLength(body)});
        response.end(body);
        return;
      }
      response.writeHead(404);
      response.end();
    });
    const sockets = new WebSocketServer({server: http, path: "/ws"});
    const acks: string[] = [];
    sockets.on("connection", (socket) => {
      socket.on("message", (data) => {
        const frame: unknown = JSON.parse(data.toString());
        if (typeof frame !== "object" || frame === null || Array.isArray(frame)) return;
        const record = frame as Record<string, unknown>;
        if (record._tag === "Ping") {
          socket.send(JSON.stringify({_tag: "Pong"}));
          return;
        }
        if (record._tag === "Ack" && typeof record.requestId === "string") {
          acks.push(record.requestId);
          Deferred.doneUnsafe(acked, Exit.void);
          return;
        }
        if (record._tag === "Request" && record.tag === "orchestration.subscribeShell") {
          Deferred.doneUnsafe(subscribed, Exit.succeed(record.payload));
          socket.send(JSON.stringify({_tag: "Chunk", requestId: record.id, values}));
        }
      });
    });
    const baseUrl = yield* Effect.acquireRelease(Effect.callback<string>((resume) => {
      http.once("error", (error) => resume(Effect.die(error)));
      http.listen(0, "127.0.0.1", () => {
        const address = http.address();
        resume(address !== null && typeof address !== "string"
          ? Effect.succeed(`http://127.0.0.1:${address.port}`)
          : Effect.die(new Error("resume peer did not bind")));
      });
    }), () => Effect.sync(() => {
      for (const socket of sockets.clients) socket.terminate();
      sockets.close();
      http.close();
    }));
    return {baseUrl, subscribed, acked, acks};
  });
  const watch = (directory: string, values: ReadonlyArray<unknown>) => Effect.gen(function* () {
    const peer = yield* listen(values);
    const client = yield* Layer.build(makeT3Client({baseUrl: peer.baseUrl, token})).pipe(
      Effect.map((context) => Context.get(context, T3Client)));
    const status = yield* SubscriptionRef.make(createStatus(config(directory), yield* Clock.currentTimeMillis));
    const fiber = yield* Effect.forkScoped(supervise(rootServices(config(directory), status, client)));
    const payload = yield* Deferred.await(peer.subscribed).pipe(Effect.timeout("3 seconds"));
    yield* Deferred.await(peer.acked).pipe(Effect.timeout("3 seconds"));
    const connected = (yield* SubscriptionRef.get(status)).t3Connected;
    yield* Fiber.interrupt(fiber);
    return {payload, acks: peer.acks, connected, cleared: (yield* SubscriptionRef.get(status)).t3Connected};
  });

  const covered = yield* dataDirectory("supervisor-marker-");
  yield* seed(covered, true);
  const quiet = yield* watch(covered, [{kind: "synchronized"}]);
  assert.deepEqual(quiet.payload, {requestCompletionMarker: true, afterSequence: 8});
  assert.deepEqual(quiet.acks, ["1"]);
  assert.equal(quiet.connected, true);
  assert.equal(quiet.cleared, false);
  const kept = yield* Store.use((store) => Effect.all({
    cursor: store.cursor("active"),
    coverage: store.coverage(),
    thread: store.thread("x"),
    catalog: store.catalog().pipe(Effect.map((catalog) => catalog.threads.map((item) => item.id))),
  })).pipe(Effect.provide(makeStore(covered)));
  assert.equal(kept.cursor, 8);
  assert.equal(kept.coverage, 8);
  assert.equal(kept.thread?.id, "x");
  assert.deepEqual(kept.catalog, []);

  const partial = yield* dataDirectory("supervisor-uncovered-");
  yield* seed(partial, false);
  const uncovered = yield* watch(partial, [{kind: "synchronized"}]);
  assert.deepEqual(uncovered.payload, {requestCompletionMarker: true});
  assert.deepEqual(uncovered.acks, ["1"]);
  assert.equal(uncovered.connected, false);
  assert.equal(uncovered.cleared, false);
  assert.equal(yield* Store.use((store) => store.coverage()).pipe(Effect.provide(makeStore(partial))), null);

  const enrichedDirectory = yield* dataDirectory("supervisor-enrichment-");
  yield* seed(enrichedDirectory, true);
  const enriched = yield* watch(enrichedDirectory, [{
    kind: "snapshot", resolvedRepositoryIdentityRoots: ["/work/project"], snapshot: {
      schemaVersion: 2, snapshotSequence: 100, projects: [], threads: [], archivedThreads: [],
    },
  }]);
  assert.deepEqual(enriched.payload, {requestCompletionMarker: true, afterSequence: 8});
  assert.deepEqual(enriched.acks, ["1"]);
  assert.equal(enriched.connected, false);
  assert.equal(enriched.cleared, false);
  assert.equal(yield* Store.use((store) => store.cursor("active")).pipe(Effect.provide(makeStore(enrichedDirectory))), 8);
}));
