import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeWorkerRunner from "@effect/platform-node/NodeWorkerRunner";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import { WorkerRunnerPlatform } from "effect/workers/WorkerRunner";
import { serveDatabase } from "../../src/db-worker-serve.js";

// a database worker for test/db-worker-backup.test.ts: the production worker, except that this thread exits as soon as it
// receives a backup request, before answering it (a backup whose outcome the main thread cannot know)

const exitOnBackup = Layer.effect(WorkerRunnerPlatform, Effect.map(WorkerRunnerPlatform, (platform) => WorkerRunnerPlatform.of({
  start: <O, I>() => Effect.map(platform.start<O, I>(), (runner) => ({
    ...runner,
    run: <A, E, R>(handler: (portId: number, message: I) => Effect.Effect<A, E, R> | void) =>
      runner.run((portId: number, message: I) => {
        if (Predicate.hasProperty(message, "op") && message.op === "backup") process.exit(1);
        return handler(portId, message);
      }),
  })),
}))).pipe(Layer.provide(NodeWorkerRunner.layer));

NodeRuntime.runMain(serveDatabase.pipe(Effect.provide(exitOnBackup)), { disableErrorReporting: true });
