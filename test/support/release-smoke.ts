import assert from "node:assert/strict";
import { Cause, Effect, Option, Schema } from "effect";
import { buildInfo } from "../../src/version.js";
import { redact as redactCredentials } from "../../src/credential-redaction.js";
import type { ProcessResult } from "./cli-process.js";
import { httpGet, waitForHttp, type RunningProcess } from "./g8-process.js";
import { readyTimeoutMs, type SupervisorHarness } from "./g8-cli.js";
import { redact } from "./private-assert.js";

/* The Effect packages an installed application really loads, by node's own resolution inside the installation: run as
 * `node -e effectFamilyProbe <package directory>`, it resolves from the application's entry every Effect package (effect,
 * @effect/*) its manifest declares, then from each package it reached the Effect packages that one declares as dependencies or
 * peers, and prints each resolution's real directory and version with the application's own Effect pins. It loads no module. */
export const effectFamilyProbe = `const fs = require('node:fs'), path = require('node:path'), { createRequire } = require('node:module');
const family = (name) => name === 'effect' || name.startsWith('@effect/');
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const root = path.resolve(process.argv[1]);
const application = read(path.join(root, 'package.json'));
const resolutions = [];
const visited = new Set();
const queue = [{ importer: application.name, from: path.join(root, 'dist', 'cli.js'), manifest: application }];
while (queue.length > 0) {
  const { importer, from, manifest } = queue.shift();
  const declared = [...Object.keys(manifest.dependencies || {}), ...Object.keys(manifest.peerDependencies || {})];
  for (const name of [...new Set(declared)].filter(family).sort()) {
    let file = null;
    try { file = fs.realpathSync(createRequire(from).resolve(name + '/package.json')); } catch {}
    const found = file === null ? null : read(file);
    resolutions.push({ importer, name, directory: file === null ? null : path.dirname(file), version: found === null ? null : String(found.version) });
    if (found !== null && !visited.has(file)) {
      visited.add(file);
      queue.push({ importer: name + '@' + found.version, from: file, manifest: found });
    }
  }
}
const pins = Object.fromEntries(Object.entries(application.dependencies || {}).filter(([name]) => family(name)));
process.stdout.write(JSON.stringify({ application: application.name, pins, resolutions }));`;

const EffectFamily = Schema.Struct({
  application: Schema.String,
  pins: Schema.Record(Schema.String, Schema.String),
  resolutions: Schema.Array(Schema.Struct({
    importer: Schema.String,
    name: Schema.String,
    directory: Schema.NullOr(Schema.String),
    version: Schema.NullOr(Schema.String),
  })),
});
export type EffectFamily = typeof EffectFamily.Type;

// an exact version: never a range, tag, alias or URL
const exactVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;

// what keeps the resolutions from being one copy of effect and of each @effect package, each at its exact direct pin
export const effectFamilyProblems = ({ application, pins, resolutions }: EffectFamily): ReadonlyArray<string> => {
  const problems: string[] = [];
  if (pins.effect === undefined) problems.push(`${application} has no exact effect dependency`);
  for (const [name, pin] of Object.entries(pins)) {
    if (!exactVersion.test(pin)) problems.push(`${application} declares ${name} ${pin}, not an exact version`);
  }
  const copies = new Map<string, Set<string>>();
  for (const { importer, name, directory, version } of resolutions) {
    if (directory === null) {
      problems.push(`${importer} cannot resolve ${name}`);
      continue;
    }
    copies.set(name, (copies.get(name) ?? new Set<string>()).add(directory));
    const pin = pins[name];
    if (pin === undefined) problems.push(`${importer} reaches ${name}@${String(version)}, which ${application} does not pin as an exact direct dependency`);
    else if (version !== pin) problems.push(`${importer} resolves ${name}@${String(version)}, not the pinned ${pin}`);
  }
  for (const [name, directories] of copies) {
    if (directories.size > 1) problems.push(`${name} resolves to ${directories.size} installed copies: ${[...directories].sort().join(", ")}`);
  }
  return problems;
};

// the probe's report, decoded as untrusted output
export const readEffectFamily = (probe: Effect.Effect<ProcessResult>) => Effect.gen(function* () {
  const result = yield* probe;
  if (result.code !== 0) return yield* Effect.die(new Error(`the Effect package probe failed (exit ${String(result.code)}): ${result.stderr.slice(-2_000)}`));
  return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(EffectFamily))(result.stdout);
});

// one pinned Effect set, or a failure naming every problem and every resolution the probe saw, with versions and paths
export const verifyEffectFamily = (probe: Effect.Effect<ProcessResult>) => Effect.gen(function* () {
  const family = yield* readEffectFamily(probe);
  const problems = effectFamilyProblems(family);
  if (problems.length > 0) {
    return yield* Effect.die(new Error(`the installed Effect packages are not one exactly pinned set:\n${problems.join("\n")}\n`
      + `resolutions: ${JSON.stringify(family.resolutions)}`));
  }
  return family;
});

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
