import { NodeCrypto } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/http";
import { SupervisorConfig as Configuration } from "../../src/config.js";
import { SupervisionLive } from "../../src/supervision-live.js";
import { NativeOperateRpc, NativeShell, type NativeRpcShape } from "../../src/supervisor-native.js";
import { Store, type StoreShape } from "../../src/store.js";
import { T3Client, type T3ClientShape } from "../../src/t3.js";
import type { SupervisorConfig } from "../../src/types.js";
import { policyLayer, supervisionStoresLayer } from "./g11-stores.js";
import { fakeNativeLayer } from "./native-access.js";

// one supervision run of src/supervision-live.ts over the stores of a temporary data directory, as runGuidanceApplication
// builds it, with every native client a forbidden fake: a read-only case proves it makes no native call because each of
// them dies when used

const forbidden = (client: string) => Effect.die(new Error(`a read-only case must not call the native ${client}`));

const forbiddenRpc = (client: string): NativeRpcShape => ({ call: () => forbidden(client), initiate: () => forbidden(client) });

const forbiddenT3: T3ClientShape = {watchThread: () => Effect.never,  descriptor: () => forbidden("T3 descriptor"), projection: () => forbidden("T3 projection"), watch: () => forbidden("T3 watch") };

// the webhook POST of a helper delivery
const forbiddenFetch: typeof globalThis.fetch = () => Promise.reject(new Error("a read-only case must not post a webhook"));
const forbiddenHttp = FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, forbiddenFetch)));

/** The native clients of a run (read, shell, operate, T3 and fetch), each dying when used, its T3Native over them, and the given catalog. */
export const forbiddenNatives = (catalog: Pick<StoreShape, "catalog">) => {
  const read = forbiddenRpc("read rpc");
  const shell = NativeShell.of({ baseline: forbidden("shell baseline"), threads: forbidden("shell threads") });
  const operate = forbiddenRpc("operate rpc");
  return Layer.mergeAll(
    Layer.succeed(NativeOperateRpc, operate),
    Layer.succeed(T3Client, forbiddenT3),
    fakeNativeLayer({ t3: forbiddenT3, read, shell, operate, http: forbiddenHttp }),
    Layer.succeed(Store, catalog as StoreShape),
    forbiddenHttp);
};

/** The run's services over the stores of the configuration's data directory, the process's policy store and the natives. */
export const supervisionRun = (config: SupervisorConfig, natives: ReturnType<typeof forbiddenNatives>) =>
  SupervisionLive({ operateRpcAvailable: true, baseUrl: config.t3Url }).pipe(
    Layer.provideMerge(natives),
    Layer.provideMerge(Layer.mergeAll(supervisionStoresLayer(config.dataDirectory), policyLayer(config), Layer.succeed(Configuration, config))),
    // the run's own ids draw from the platform crypto
    Layer.provide(NodeCrypto.layer));
