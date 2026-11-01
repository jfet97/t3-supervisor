import assert from "node:assert/strict";
import { join } from "node:path";
import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Clock, Console, Effect, Option, Schema } from "effect";
import { checkoutInputs } from "../../scripts/local-run.js";
import { repositoryRoot, tsxLoader } from "../support/cli-process.js";
import { supervisorHarness, waitUntilReady } from "../support/g8-cli.js";
import { httpGet } from "../support/g8-process.js";

/*
  A scripted soak (docs/testing.md, execution type 4): the production Supervisor process watches a loopback fake T3 on the wall
  clock with nothing new to ingest. Through the idle window the watch keeps its one subscription by answering heartbeats and
  health stays ready and connected. The window is longer than a minute and spans two heartbeat timeouts plus one interval of
  src/t3.ts, so a heartbeat that stopped, went unanswered or ended in a reconnect shows; SOAK_IDLE_MS asks for a longer one.
  The fake answers every Ping and records every frame and request; no provider and no credential is involved.
*/

// src/t3.ts: a Ping every 15 s, whose Pong must arrive within 40 s
const heartbeatIntervalMs = 15_000;
const heartbeatTimeoutMs = 40_000;
const idleMs = Math.max(Number(process.env.SOAK_IDLE_MS ?? 0) || 0, 2 * heartbeatTimeoutMs + heartbeatIntervalMs);
const sampleEvery = "5 seconds";

const Connected = Schema.Struct({t3Connected: Schema.Boolean});
const connectedOf = (body: string): boolean =>
  Option.match(Schema.decodeUnknownOption(Schema.fromJsonString(Connected))(body), {onNone: () => false, onSome: (value) => value.t3Connected});
const count = (values: ReadonlyArray<string>, value: string): number => values.filter((item) => item === value).length;

it.live(`an idle watch keeps its one subscription and its heartbeat for ${Math.round(idleMs / 1000)} s while health stays ready`, () => Effect.gen(function* () {
  const harness = yield* supervisorHarness({activeThreads: 1, archiveThreads: 1});
  const child = yield* harness.start(process.execPath, ["--import", tsxLoader, join(repositoryRoot, "src", "main.ts")]);
  yield* waitUntilReady(harness, child);
  const traffic = harness.fake.traffic;
  const subscriptions = count(traffic.requests, "orchestration.subscribeShell");
  const pings = count(traffic.frames, "Ping");
  const health = `http://127.0.0.1:${harness.ports.health}/health`;
  const started = yield* Clock.currentTimeMillis;
  // health read on the wall clock through the idle window: its status and whether the watch counts as connected
  const samples: Array<{readonly status: number | null; readonly connected: boolean}> = [];
  while ((yield* Clock.currentTimeMillis) - started < idleMs) {
    yield* Effect.sleep(sampleEvery);
    const reply = yield* Effect.option(httpGet(health, 2_000));
    samples.push(Option.match(reply, {onNone: () => ({status: null, connected: false}),
      onSome: (value) => ({status: value.status, connected: connectedOf(value.body)})}));
  }
  const beats = count(traffic.frames, "Ping") - pings;
  assert.equal(count(traffic.requests, "orchestration.subscribeShell"), subscriptions, "the watch never subscribed again");
  assert.ok(beats >= Math.floor(idleMs / heartbeatIntervalMs) - 1, `${beats} heartbeats in ${idleMs} ms`);
  assert.deepEqual(samples.filter((sample) => sample.status !== 200 || !sample.connected), [], "health stayed ready and connected");
  // the outcome with its inputs: this checkout's commit and whether its tree was clean
  yield* Console.log(JSON.stringify({soak: "idle-watch-heartbeat", idleMs, beats, samples: samples.length, ...(yield* checkoutInputs)}));
}).pipe(Effect.provide(NodeFileSystem.layer)), {timeout: idleMs + 90_000});
