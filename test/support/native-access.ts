import { NodeCrypto } from "@effect/platform-node";
import { Context, Effect, Layer, type Scope } from "effect";
import { FetchHttpClient, type HttpClient } from "effect/http";
import { NativeEnvelope } from "../../src/native-envelope.js";
import { NativeOperateRpc, NativeRpc, NativeShell, SupervisorRpcError, type NativeRpcShape, type NativeShellShape } from "../../src/supervisor-native.js";
import { T3Client, type T3ClientShape } from "../../src/t3.js";
import { T3Native } from "../../src/t3-native/index.js";

/**
 * The production T3Native of a supervision run over a suite's fake clients, built as the composition root builds it over the real
 * ones (src/guidance-application.ts): the fakes' scripted replies stay the source of truth, and T3Native adds only its input and
 * receipt validation and its typed failures. The files and terminal families stay absent (no project-write, commit or probe
 * credential); the commands and the helper family follow the operate fake's presence; the helper webhook POST and the file reads run
 * on the process transport and open nothing unless they are called.
 */

/** The fake clients a suite's services received as raw services, each wrapped unchanged. */
export interface FakeNativeClients {
  // the T3 client's reads and watches; without one, each is a defect
  readonly t3?: T3ClientShape | undefined;
  // the read credential's client; without one, every native read is refused before it leaves (absentRead)
  readonly read?: NativeRpcShape | undefined;
  // the read credential's shell reads; without them, a shell read is a defect
  readonly shell?: NativeShellShape | undefined;
  // the operate credential's client; without one the commands and the helper family are absent, as in a run without its token file
  readonly operate?: NativeRpcShape | null | undefined;
  // the run's T3 base url, against which the helper webhook paths resolve
  readonly baseUrl?: string | undefined;
  // the HTTP client of the helper webhook POSTs; the platform fetch by default
  readonly http?: Layer.Layer<HttpClient.HttpClient> | undefined;
}

/**
 * The read credential of a fixture whose services were given none: every request is refused before it leaves, so a native read
 * yields nothing, as the absent client yielded nothing.
 */
export const absentRead: NativeRpcShape = {
  call: () => Effect.fail(new SupervisorRpcError("rejected")),
  initiate: () => Effect.succeed({sent: Effect.succeed(false), result: Effect.fail(new SupervisorRpcError("rejected")), release: Effect.void}),
};

const unusedT3: T3ClientShape = {descriptor: () => Effect.die(new Error("unused T3 descriptor")), projection: () => Effect.die(new Error("unused T3 projection")),
  watch: () => Effect.die(new Error("unused T3 watch")), watchThread: () => Effect.die(new Error("unused T3 thread watch"))};
const unusedShell = NativeShell.of({baseline: Effect.die(new Error("unused native shell read")), threads: Effect.die(new Error("unused native lineage read"))});

/** The production T3Native layer over the fakes and the process transport. */
export const fakeNativeLayer = (clients: FakeNativeClients): Layer.Layer<T3Native> => {
  const baseUrl = clients.baseUrl ?? "http://unused";
  return T3Native.layer({baseUrl, read: {baseUrl, token: "fake-read-token"}}).pipe(Layer.provide(Layer.mergeAll(
    Layer.succeed(T3Client, clients.t3 ?? unusedT3), Layer.succeed(NativeRpc, clients.read ?? absentRead), Layer.succeed(NativeShell, clients.shell ?? unusedShell),
    clients.operate ? Layer.succeed(NativeOperateRpc, clients.operate) : Layer.empty,
    NativeEnvelope.layer, clients.http ?? FetchHttpClient.layer, NodeCrypto.layer)));
};

/** The production T3Native over the fakes, built once in the current scope, as a run builds its own once. */
export const fakeNative = (clients: FakeNativeClients): Effect.Effect<T3Native["Service"], never, Scope.Scope> =>
  Effect.map(Layer.build(fakeNativeLayer(clients)), (context) => Context.get(context, T3Native));
