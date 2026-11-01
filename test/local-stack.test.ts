import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { join } from "node:path";
import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Effect, Exit, FileSystem } from "effect";
import { toolPath } from "../scripts/local-run.js";
import { archiveName, completeMarker, credentials, ensureRuntime, nativeAccess, platformKey, serveArguments, t3Environment, t3Release } from "../scripts/local-stack.js";
import { freePort, runProcess } from "./support/g8-process.js";

/*
  The published-T3 local stack's fixed contracts (scripts/local-stack.ts) and its pinned-archive integrity guard, against
  a loopback release server: no real T3 download or process runs in this suite.
*/

it("each Supervisor credential is a separate T3 session with exactly the scopes its calls need", () => {
  assert.deepEqual(credentials.map(({name, variable, scopes}) => [name, variable, [...scopes]]), [
    ["read", "T3_TOKEN_FILE", ["orchestration:read", "filesystem:read"]],
    ["guidance", "T3_GUIDANCE_TOKEN_FILE", ["orchestration:operate"]],
    ["project-write", "T3_PROJECT_WRITE_TOKEN_FILE", ["filesystem:read", "filesystem:write"]],
    ["project-commit", "T3_PROJECT_COMMIT_TOKEN_FILE", ["source-control:write"]],
    ["git-probe", "T3_GIT_PROBE_TOKEN_FILE", ["terminal:operate"]],
  ]);
});

it("the pinned release names one exact published nightly and a SHA-256 per supported platform", () => {
  // an exact nightly build, never a channel tag such as `nightly` or `latest` and never a stable fallback
  assert.match(t3Release.version, /^\d+\.\d+\.\d+-nightly\.\d{8}\.\d+$/u);
  // the development container runs Linux on the host's own architecture
  assert.deepEqual(Object.keys(t3Release.archives).sort(), ["linux-arm64", "linux-x64"]);
  for (const digest of Object.values(t3Release.archives)) assert.match(digest, /^[0-9a-f]{64}$/u);
  assert.equal(archiveName(t3Release, "linux-x64"), `t3-${t3Release.version}-linux-x64.tar.gz`);
});

it("the run's T3 serves on loopback from the run's own data directory, with telemetry off and the run's home", () => {
  const run = {path: "/tmp/t3-supervisor-local-stack-a", kind: "stack" as const, dir: (...parts: ReadonlyArray<string>) => join("/tmp/t3-supervisor-local-stack-a", ...parts)};
  assert.deepEqual(serveArguments(run, 41234), ["serve", "--host", "127.0.0.1", "--port", "41234", "--base-dir", "/tmp/t3-supervisor-local-stack-a/t3",
    "--no-browser", "/tmp/t3-supervisor-local-stack-a/projects"]);
  const env = t3Environment(run);
  assert.equal(env.T3CODE_HOME, "/tmp/t3-supervisor-local-stack-a/t3");
  assert.equal(env.HOME, "/tmp/t3-supervisor-local-stack-a/home");
  assert.equal(env.T3CODE_TELEMETRY_ENABLED, "false");
  assert.equal(env.T3CODE_OTEL_SDK_DISABLED, "true");
  assert.equal(env.T3_URL, undefined);
});

// a loopback release folder serving one archive, counting its downloads
const releaseServer = (version: string, name: string, bytes: Buffer) => Effect.acquireRelease(Effect.callback<{url: string; downloads: () => number; close: () => void}>((resume) => {
  let downloads = 0;
  const server = createServer((request, response) => {
    if (request.url !== `/v${version}/${name}`) {
      response.writeHead(404).end();
      return;
    }
    downloads += 1;
    response.writeHead(200, {"content-length": bytes.length}).end(bytes);
  });
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    resume(Effect.succeed({url: `http://127.0.0.1:${port}`, downloads: () => downloads, close: () => server.close()}));
  });
}), (server) => Effect.sync(() => server.close()));

it.live("the runtime installs only an archive matching its pinned digest, once per version", () => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const work = yield* fs.makeTempDirectoryScoped({prefix: "local-stack-test-"});
  yield* fs.makeDirectory(join(work, "source", "t3-test"), {recursive: true});
  yield* fs.writeFileString(join(work, "source", "t3-test", "t3"), "#!/bin/sh\necho t3 test\n", {mode: 0o755});
  const platform = platformKey();
  const version = "0.0.1";
  const release = {version, baseUrl: "", archives: {} as Record<string, string>};
  const name = archiveName(release, platform);
  const packed = yield* runProcess("tar", ["-czf", join(work, name), "-C", join(work, "source"), "t3-test"],
    {env: {PATH: toolPath(["tar", "gzip"], process.env.PATH ?? "")}, cwd: work, timeoutMs: 30_000});
  assert.equal(packed.code, 0, packed.stderr);
  const bytes = Buffer.from(yield* fs.readFile(join(work, name)));
  const digest = createHash("sha256").update(bytes).digest("hex");
  const server = yield* releaseServer(version, name, bytes);
  const cache = join(work, "cache");

  const tampered = yield* Effect.exit(ensureRuntime(cache, {...release, baseUrl: server.url, archives: {[platform]: "0".repeat(64)}}, platform));
  assert.ok(Exit.isFailure(tampered));
  assert.match(JSON.stringify(tampered.cause), /not the pinned/u);
  assert.equal(yield* fs.exists(join(cache, `t3-${version}-${platform}`)), false);
  assert.deepEqual((yield* fs.readDirectory(cache)).filter((entry) => entry.includes(".staging-")), []);

  const pinned = {...release, baseUrl: server.url, archives: {[platform]: digest}};
  const executable = yield* ensureRuntime(cache, pinned, platform);
  assert.equal(executable, join(cache, `t3-${version}-${platform}`, "t3"));
  assert.equal(yield* fs.readFileString(executable), "#!/bin/sh\necho t3 test\n");
  assert.equal((yield* fs.readFileString(join(cache, `t3-${version}-${platform}`, completeMarker))).trim(), digest);
  assert.equal(yield* ensureRuntime(cache, pinned, platform), executable);
  assert.equal(server.downloads(), 2, "the tampered attempt and one install; the second call reuses the installed runtime");
  assert.equal((yield* Effect.exit(ensureRuntime(cache, {...pinned, archives: {}}, platform)))._tag, "Failure");
}).pipe(Effect.provide(NodeFileSystem.layer)));

// a loopback stand-in for T3's native shell route that answers each bearer with one status
const shellRoute = Effect.acquireRelease(Effect.callback<{url: string; close: () => void}>((resume) => {
  const statuses: Record<string, number> = {"Bearer granted": 200, "Bearer forged": 401, "Bearer underscoped": 403, "Bearer overloaded": 503};
  const server = createServer((request, response) => {
    const status = request.url === "/api/orchestration/shell" ? statuses[request.headers.authorization ?? ""] ?? 500 : 404;
    response.writeHead(status, {"content-type": "application/json"}).end(status === 200 ? "{\"threads\":[]}" : "{\"error\":\"refused\"}");
  });
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    resume(Effect.succeed({url: `http://127.0.0.1:${port}`, close: () => server.close()}));
  });
}), (server) => Effect.sync(() => server.close()));

it.live("only T3's own 401 or 403 counts as a refused credential; an outage never does", () => Effect.gen(function* () {
  const route = yield* shellRoute;
  assert.deepEqual(yield* nativeAccess(route.url, "granted"), {kind: "granted"});
  assert.deepEqual(yield* nativeAccess(route.url, "forged"), {kind: "refused", status: 401});
  assert.deepEqual(yield* nativeAccess(route.url, "underscoped"), {kind: "refused", status: 403});
  assert.deepEqual(yield* nativeAccess(route.url, "overloaded"), {kind: "unavailable", reason: "HTTP 503"});
  const stopped = yield* nativeAccess(`http://127.0.0.1:${yield* freePort}`, "forged");
  assert.equal(stopped.kind, "unavailable", "a stopped T3 is not a refusal");
}));
