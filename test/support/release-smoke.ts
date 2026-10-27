import assert from "node:assert/strict";
import { Cause, Effect, Option, Schema } from "effect";
import { buildInfo } from "../../src/version.js";
import { redact as redactCredentials } from "../../src/credential-redaction.js";
import { httpGet, waitForHttp, type RunningProcess } from "./g8-process.js";
import { readyTimeoutMs, type SupervisorHarness } from "./g8-cli.js";
import { redact } from "./private-assert.js";

const HealthDiagnostic = Schema.fromJsonString(Schema.Struct({
  ok: Schema.Boolean,
  readiness: Schema.Struct({ alive: Schema.Boolean, ready: Schema.Boolean, supervisionProgress: Schema.Boolean }),
  t3Connected: Schema.Boolean,
  storeState: Schema.Literals(["starting", "ready", "degraded"]),
  supervisionState: Schema.Literals(["disabled", "starting", "ready", "degraded"]),
  lastErrorPhase: Schema.NullOr(Schema.Literals(["maintenance", "t3_authentication", "supervision", "t3_stream"])),
}));
const healthDiagnostic = Schema.decodeUnknownOption(HealthDiagnostic);

// only the owned release fixture's status and redacted process output survive a failed readiness check
export const waitForReleaseReady = (harness: SupervisorHarness, child: RunningProcess, timeoutMs = readyTimeoutMs) => Effect.suspend(() => {
  let lastHealth: unknown = { state: "no response" };
  return waitForHttp(`http://127.0.0.1:${harness.ports.health}/health`, (status, body) => {
    lastHealth = { status, body: Option.getOrElse(healthDiagnostic(body), () => "unrecognized health response") };
    return status === 200;
  }, timeoutMs, () => child.child.exitCode === null && child.child.signalCode === null).pipe(Effect.catchCause((cause) => {
    if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
    const output = (value: string) => redactCredentials(redact(value, [harness.token])).slice(-4096);
    return Effect.die(new Error(`release readiness failed within ${timeoutMs} ms: ${JSON.stringify({
      health: lastHealth, exitCode: child.child.exitCode, signal: child.child.signalCode,
      stdout: output(child.stdout()), stderr: output(child.stderr()),
    })}`));
  }));
});

// shared by the archive regression and release artifact checks; all requests hit the running service
export const verifyReleaseDashboard = (harness: SupervisorHarness, child: RunningProcess) => Effect.gen(function* () {
  const health = yield* waitForReleaseReady(harness, child);
  const metadata = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Struct({ version: Schema.String, revision: Schema.NullOr(Schema.String) })))(health.body);
  assert.equal(metadata.version, buildInfo.version);
  assert.equal(metadata.revision, buildInfo.gitHead ?? null);
  const dashboard = yield* httpGet(`http://127.0.0.1:${harness.ports.ui}/`, 5_000);
  assert.equal(dashboard.status, 200);
  assert.match(dashboard.body, /<html/u);
  const asset = /src="(\/assets\/[^"/]+\.js)"/u.exec(dashboard.body)?.[1];
  assert.ok(asset, "the packaged HTML references a built JavaScript asset");
  const javascript = yield* httpGet(`http://127.0.0.1:${harness.ports.ui}${asset}`, 5_000);
  assert.equal(javascript.status, 200);
  assert.ok(javascript.body.length > 1_000);
  assert.doesNotMatch(javascript.body, /<!doctype html>/iu);
});
