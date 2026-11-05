import { appendFileSync } from "node:fs";
import { workerData } from "node:worker_threads";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeWorkerRunner from "@effect/platform-node/NodeWorkerRunner";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { WorkerRunnerPlatform } from "effect/workers/WorkerRunner";
import { serveDatabase } from "../../src/db-worker-serve.js";

/*
 * a database worker for test/database-guard.test.ts: the production worker, which first appends every connection it is asked
 * to open ({filename, readonly}) to a json-lines log, so a test sees whether any connection that can write opened a file
 * workerData: { log: the log file }
 */

const { log } = Schema.decodeUnknownSync(Schema.Struct({ log: Schema.String }))(workerData);
const isOpen = Schema.is(Schema.Struct({ op: Schema.Literal("open"), config: Schema.Struct({ filename: Schema.String, readonly: Schema.Boolean }) }));

const logOpens = Layer.effect(WorkerRunnerPlatform, Effect.map(WorkerRunnerPlatform, (platform) => WorkerRunnerPlatform.of({
  start: <O, I>() => Effect.map(platform.start<O, I>(), (runner) => ({
    ...runner,
    run: <A, E, R>(handler: (portId: number, message: I) => Effect.Effect<A, E, R> | void) =>
      runner.run((portId: number, message: I) => {
        if (isOpen(message)) appendFileSync(log, `${JSON.stringify({ filename: message.config.filename, readonly: message.config.readonly })}\n`);
        return handler(portId, message);
      }),
  })),
}))).pipe(Layer.provide(NodeWorkerRunner.layer));

NodeRuntime.runMain(serveDatabase.pipe(Effect.provide(logOpens)), { disableErrorReporting: true });
