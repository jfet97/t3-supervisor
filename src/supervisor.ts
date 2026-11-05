import { DashboardUpdates } from "./dashboard-updates.js";
import { NodeCrypto, NodeFileSystem, NodeHttpServer } from "@effect/platform-node";
import { Cause, Clock, Context, Crypto, Deferred, Effect, Fiber, FileSystem, Layer, Redacted, Schedule, Schema, SubscriptionRef } from "effect";
import { FetchHttpClient, HttpClient, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { createServer } from "node:http";
import { SupervisorConfig } from "./config.js";
import { failureReason, T3TokenUnavailable } from "./errors.js";
import { runGuidanceApplication } from "./guidance-application.js";
import { logEvent } from "./logging.js";
import { SupervisorOwnership } from "./project-supervisor-store.js";
import { makeStore, Store, type StoreStats } from "./store.js";
import { NativeEnvelope } from "./native-envelope.js";
import { NativeRpc, NativeShell } from "./supervisor-native.js";
import { T3Client } from "./t3.js";
import { T3Native } from "./t3-native/index.js";
import { persistenceStartup } from "./database-upgrade.js";
import type { SupervisorSettings } from "./types.js";
import { buildInfo } from "./version.js";

export interface SupervisorStatus {
  startedAt: string;
  activation: string | null;
  environmentId: string | null;
  t3Connected: boolean;
  storeState: "starting" | "ready" | "degraded";
  supervisionState: "disabled" | "starting" | "ready" | "degraded";
  heartbeat: number;
  lastErrorPhase: string | null;
  store: StoreStats | null;
}

export const createStatus = (config: Pick<SupervisorSettings, "uiPort">, now: number): SupervisorStatus => ({
  startedAt: new Date(now).toISOString(),
  activation: null,
  environmentId: null,
  t3Connected: false,
  storeState: "starting",
  supervisionState: config.uiPort === undefined ? "disabled" : "starting",
  heartbeat: now,
  lastErrorPhase: null,
  store: null,
});

export const readiness = (status: SupervisorStatus, config: SupervisorSettings, now: number) => {
  const alive = now - status.heartbeat < 60_000;
  const supervisionProgress = config.uiPort === undefined || status.supervisionState === "ready";
  const ready = supervisionProgress && alive && status.activation !== null && status.t3Connected && status.storeState === "ready";
  return { alive, ready, supervisionProgress };
};

// the current status: written by the maintenance, watch and supervision fibers, read by every health request
export class SupervisorStatusRef extends Context.Service<SupervisorStatusRef, SubscriptionRef.SubscriptionRef<SupervisorStatus>>()(
  "t3-supervisor/SupervisorStatus") {
  static readonly layer: Layer.Layer<SupervisorStatusRef, never, SupervisorConfig> = Layer.effect(SupervisorStatusRef, Effect.gen(function* () {
    const config = yield* SupervisorConfig;
    return yield* SubscriptionRef.make(createStatus(config, yield* Clock.currentTimeMillis));
  }));
}

// the exact request target decides: a query string or a trailing slash is a 404 with an empty body, as any other path
const health = (path: "/health" | "/live") => Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  if (request.url !== path) return HttpServerResponse.empty({ status: 404 });
  const config = yield* SupervisorConfig;
  const status = yield* SubscriptionRef.get(yield* SupervisorStatusRef);
  const checked = readiness(status, config, yield* Clock.currentTimeMillis);
  const healthy = path === "/live" ? checked.alive : checked.ready;
  return HttpServerResponse.text(JSON.stringify({ ok: healthy, version: buildInfo.version, revision: buildInfo.gitHead ?? null, readiness: checked, ...status }),
    { status: healthy ? 200 : 503, contentType: "application/json" });
});

// /health and /live for every method on the health port; the http logger and the listen log stay disabled. Like the dashboard it
// listens on loopback unless HEALTH_HOST names another address (the container image sets 0.0.0.0 inside its own network namespace,
// where its published port decides the exposure); an empty value never widens it
const healthServer = Layer.unwrap(SupervisorConfig.useSync((config) => HttpRouter.serve(
  Layer.mergeAll(HttpRouter.add("*", "/health", health("/health")), HttpRouter.add("*", "/live", health("/live"))),
  { disableLogger: true, disableListenLog: true },
).pipe(Layer.provide(NodeHttpServer.layerServer(createServer, { port: config.healthPort, host: config.healthHost || "127.0.0.1" })))));

export const runSupervisor = Effect.gen(function* () {
  const config = yield* SupervisorConfig;
  const status = yield* SupervisorStatusRef;
  const store = yield* Store;
  // the root's T3 client is only handed to each supervision run; the root's own environment read and catalog watch go through T3Native
  const t3 = yield* T3Client;
  const native = yield* T3Native;
  const update = (change: (current: SupervisorStatus) => Partial<SupervisorStatus>) =>
    SubscriptionRef.update(status, (current) => ({ ...current, ...change(current) }));
  yield* Layer.build(healthServer);
  yield* logEvent("supervisor_started");

  const guard = <A, E, R>(effect: Effect.Effect<A, E, R>, phase: string) =>
    effect.pipe(Effect.catchCause((cause) => {
      if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
      return update(() => ({ lastErrorPhase: phase, ...(phase === "maintenance" ? { storeState: "degraded" as const } : {}) })).pipe(
        Effect.andThen(logEvent("operation_deferred", { phase })), Effect.andThen(Effect.sleep("10 seconds")));
    }));

  const maintenance = Effect.gen(function* () {
    const heartbeat = yield* Clock.currentTimeMillis;
    yield* update(() => ({ heartbeat }));
    const stats = yield* store.stats();
    const checked = yield* Clock.currentTimeMillis;
    yield* update((current) => {
      const next = { ...current, store: stats, storeState: "ready" as const };
      return readiness(next, config, checked).ready ? { ...next, lastErrorPhase: null } : next;
    });
    yield* Effect.sleep("30 seconds");
  }).pipe((effect) => guard(effect, "maintenance"), Effect.forever);
  yield* Effect.forkScoped(maintenance);

  const descriptor = yield* native.orchestration.environment.pipe(
    Effect.tapError(() => update(() => ({ lastErrorPhase: "t3_authentication" }))),
    Effect.retry(Schedule.spaced("10 seconds")),
  );
  const activatedAt = yield* store.activate(descriptor.environmentId, yield* Clock.currentTimeMillis);
  yield* update(() => ({ environmentId: descriptor.environmentId, activation: new Date(activatedAt).toISOString() }));
  let supervising: Fiber.Fiber<never, Effect.Error<ReturnType<typeof runGuidanceApplication>>> | undefined;
  if (config.uiPort !== undefined) {
    yield* update(() => ({ supervisionState: "starting" }));
    const supervision = Effect.gen(function* () {
      // the application reports readiness through a synchronous callback; within this attempt the status follows it
      const ready = yield* Deferred.make<void>();
      yield* Effect.forkScoped(Deferred.await(ready).pipe(Effect.andThen(update((current) => ({
        supervisionState: "ready", ...(current.lastErrorPhase === "supervision" ? { lastErrorPhase: null } : {}),
      })))));
      return yield* runGuidanceApplication(config, store, t3, () => { Deferred.doneUnsafe(ready, Effect.void); });
    }).pipe(
      Effect.scoped,
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
        return update(() => ({ supervisionState: "degraded", lastErrorPhase: "supervision" })).pipe(
          Effect.andThen(logEvent("supervision_unavailable")), Effect.andThen(Effect.sleep("10 seconds")));
      }),
      Effect.forever,
    );
    supervising = yield* Effect.forkScoped(supervision);
  }

  const watch = Effect.gen(function* () {
    const covered = yield* store.coverage();
    const cursor = yield* store.cursor("active");
    // a cursor left by a partial stream is not an archive bootstrap, so the next open asks for a full snapshot
    const resume = covered === null || cursor === 0 ? undefined : cursor;
    yield* native.orchestration.watchShell(resume, (item) => store.ingest(item).pipe(
      Effect.flatMap((outcome) => outcome.connected ? update(() => ({ t3Connected: true })) : Effect.void),
    ));
  }).pipe(
    Effect.ensuring(update(() => ({ t3Connected: false }))),
    (effect) => guard(effect, "t3_stream"),
    Effect.forever,
  );

  return yield* supervising ? Effect.raceFirst(watch, Fiber.join(supervising)) : watch;
});

// the read token, trimmed and non-empty, as a Redacted value; a missing, unreadable or blank file fails without its path or
// cause before any request to T3
const T3Token = Schema.RedactedFromValue(Schema.Trim.check(Schema.isNonEmpty()));
const readT3Token = (path: string) => FileSystem.FileSystem.use((files) => files.readFileString(path)).pipe(
  Effect.flatMap(Schema.decodeUnknownEffect(T3Token)),
  Effect.mapError(() => new T3TokenUnavailable()),
);

/**
 * The root's T3 access over the read token, read once: the T3 client each supervision run is handed, and a read-only T3Native over
 * that same client, with the read credential's native client and shell reads, for the root's environment read and catalog watch. The
 * operate, project-write, commit and probe families stay absent, as wherever their credential is not configured.
 */
const rootAccess = Layer.unwrap(Effect.gen(function* () {
  const config = yield* SupervisorConfig;
  const token = Redacted.value(yield* readT3Token(config.t3TokenFile));
  const read = { baseUrl: config.t3Url, token };
  return T3Native.layer({ baseUrl: config.t3Url, read }).pipe(
    Layer.provide(NativeShell.layer(read).pipe(Layer.provideMerge(NativeRpc.layer(read)))),
    Layer.provideMerge(T3Client.layer(read)));
}));

// the native transport, built once for the process: the shared websocket envelope, the platform crypto and the fetch
// client; the T3 client and every native client of the guidance application run on these instances
export const NativeTransportLive = Layer.mergeAll(NativeEnvelope.layer, NodeCrypto.layer, FetchHttpClient.layer);
export type NativeTransport = NativeEnvelope | Crypto.Crypto | HttpClient.HttpClient;

const catalog = Layer.unwrap(SupervisorConfig.useSync((config) => makeStore(config.dataDirectory)));

export type SupervisorServices = DashboardUpdates | SupervisorConfig | SupervisorStatusRef | Store | T3Client | T3Native | SupervisorOwnership |
  NativeTransport | FileSystem.FileSystem;

/**
 * The root services over the configuration, acquired in today's order: ownership, the native transport and the T3 access over
 * the read token, then the catalog and the status; they release in reverse. Each supervision run reloads the permanent ownership
 * into the process's set when its guidance stores are acquired, and builds the thread-policy store on its own guidance client.
 */
export const SupervisorServicesLive = Layer.mergeAll(catalog, SupervisorStatusRef.layer).pipe(
  Layer.provideMerge(rootAccess),
  Layer.provideMerge(NativeTransportLive),
  Layer.provideMerge(SupervisorOwnership.layer),
  Layer.provideMerge(DashboardUpdates.layer),
);

/*
 * the startup upgrade of the configured data directory (src/database-upgrade.ts): provided to the root services, it is built
 * before any of them, so no store, seeding, listener, watch or worker starts until every database file has its current format,
 * and the health listener (readiness) is not up meanwhile; a failure fails the start
 */
const persistence = Layer.unwrap(SupervisorConfig.useSync((config) =>
  persistenceStartup({ dataDirectory: config.dataDirectory, excludedThreadIds: config.excludedThreadIds })));

/*
 * the server graph over the current ConfigProvider: the configuration, the node file system, the startup upgrade and the
 * root services
 */
export const SupervisorLive = SupervisorServicesLive.pipe(
  Layer.provideMerge(persistence),
  Layer.provideMerge(SupervisorConfig.layer),
  Layer.provideMerge(NodeFileSystem.layer),
);

// the supervisor run over its services: the run scope (health listener and supervision, maintenance and watch fibers)
// closes before the services release, so no store closes under a running fiber (D-10)
export const supervise = <E, R>(services: Layer.Layer<SupervisorServices, E, R>) =>
  runSupervisor.pipe(Effect.scoped, Effect.provide(services));

// one classified line for a failed program; an interruption prints nothing
export const reportFailure = (cause: Cause.Cause<unknown>): Effect.Effect<void> =>
  Cause.hasInterruptsOnly(cause) ? Effect.void : logEvent("supervisor_failed", { reason: failureReason(cause) });
