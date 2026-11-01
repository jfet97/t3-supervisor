import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { it } from "@effect/vitest";
import { parse } from "yaml";
import { repositoryRoot } from "../scripts/local-run.js";

/*
  The native ARM64 job pushes an image only after the release job's own pre-write gate: an existing npm version must
  belong to this source and archive, the npm channel may not move backwards, and an existing Git tag must name this
  commit. Finding npm HTTP 200 alone never passes it. The gate steps run here for real, with curl and the GitHub API as
  stand-ins; nothing is published.
*/

type Step = { name?: string; id?: string; uses?: string; run?: string; if?: string; env?: Record<string, unknown>; with?: Record<string, unknown> };
const release = (parse(readFileSync(join(repositoryRoot, ".github", "workflows", "release.yml"), "utf8")) as {
  jobs: Record<string, { steps: Step[] }> }).jobs;
const gate = ["Reconcile immutable package and channel", "Check whether the image package exists", "Reconcile immutable image",
  "Verify the immutable Git tag", "Require source-bound provenance for new publications"];
const step = (job: string, name: string) => {
  const found = release[job]!.steps.find((candidate) => candidate.name === name);
  assert.ok(found, `${job} has ${name}`);
  return found;
};

it("the ARM64 job runs the release job's own pre-write gate, verbatim, before its push", () => {
  const arm64 = release.arm64!.steps;
  const pushed = arm64.findIndex((candidate) => candidate.id === "pushed");
  assert.ok(pushed > 0);
  assert.match(String(arm64[pushed]!.if), /steps\.image\.outputs\.exists != 'true'/u);
  for (const name of gate) {
    assert.deepEqual(step("arm64", name), step("release", name), name);
    assert.ok(arm64.findIndex((candidate) => candidate.name === name) < pushed, `${name} runs before the ARM64 push`);
  }
});

const version = "0.0.23-nightly.20261101120000.g0123456789ab";
const revision = "0123456789abcdef0123456789abcdef01234567";
const plan = { channel: "nightly", version, revision, npmTag: "nightly", tag: `v${version}` };
// a stand-in curl: the registry document for this version or channel comes from a file, a missing file is HTTP 404
const fakeCurl = `#!/bin/sh
out=""; url=""; code=""
while [ $# -gt 0 ]; do
  case $1 in
    --output) out=$2; shift 2 ;;
    --write-out) code=yes; shift 2 ;;
    --connect-timeout|--max-time) shift 2 ;;
    --*) shift ;;
    *) url=$1; shift ;;
  esac
done
case $url in
  */-/*.tgz) cp "$FAKE_TARBALL" "$out"; exit 0 ;;
  */$VERSION) source=$FAKE_VERSION ;;
  */$NPM_TAG) source=$FAKE_ALIAS ;;
  *) echo "unexpected $url" >&2; exit 7 ;;
esac
if [ -n "$source" ] && [ -f "$source" ]; then cp "$source" "$out"; status=200; else printf '{}' > "$out"; status=404; fi
[ -n "$code" ] && printf '%s' "$status"
exit 0
`;

const registryGate = (registry: {version?: object; alias?: object; archive?: string}) => {
  const workspace = mkdtempSync(join(tmpdir(), "t3sup-release-gate-"));
  try {
    mkdirSync(join(workspace, "release"));
    mkdirSync(join(workspace, "bin"));
    symlinkSync(join(repositoryRoot, "scripts"), join(workspace, "scripts"));
    symlinkSync(join(repositoryRoot, "node_modules"), join(workspace, "node_modules"));
    writeFileSync(join(workspace, "release", "plan.json"), JSON.stringify(plan));
    writeFileSync(join(workspace, "bin", "curl"), fakeCurl);
    chmodSync(join(workspace, "bin", "curl"), 0o755);
    // the registry's integrity names the published archive; the served archive differs from it only when asked to
    const published = Buffer.from("the exact published archive");
    writeFileSync(join(workspace, "archive.tgz"), registry.archive ?? published);
    const env: Record<string, string> = {...process.env as Record<string, string>, PATH: `${join(workspace, "bin")}:${process.env.PATH ?? ""}`,
      VERSION: version, NPM_TAG: "nightly", GITHUB_OUTPUT: join(workspace, "output"), FAKE_TARBALL: join(workspace, "archive.tgz"),
      FAKE_VERSION: join(workspace, "version.json"), FAKE_ALIAS: join(workspace, "alias.json")};
    const integrity = `sha512-${createHash("sha512").update(published).digest("base64")}`;
    const dist = {tarball: `https://registry.npmjs.org/@jfet97/t3-supervisor/-/t3-supervisor-${version}.tgz`, integrity};
    if (registry.version) writeFileSync(env.FAKE_VERSION!, JSON.stringify({dist, ...registry.version}));
    if (registry.alias) writeFileSync(env.FAKE_ALIAS!, JSON.stringify(registry.alias));
    writeFileSync(env.GITHUB_OUTPUT!, "");
    const result = spawnSync("bash", ["-e", "-c", step("arm64", "Reconcile immutable package and channel").run!],
      {cwd: workspace, env, encoding: "utf8", timeout: 60_000});
    // the release script reports its failure through Effect's logger on stdout; the shell's own errors go to stderr
    return {ok: result.status === 0, exists: readFileSync(env.GITHUB_OUTPUT!, "utf8").includes("exists=true"),
      output: `${result.stdout}${result.stderr}`};
  } finally {
    rmSync(workspace, {recursive: true, force: true});
  }
};
const slow = 60_000;

it("npm HTTP 200 for this version from another source stops the ARM64 job before its push", () => {
  const conflicting = registryGate({version: {version, gitHead: "f".repeat(40)}});
  assert.equal(conflicting.ok, false);
  assert.match(conflicting.output, /different source revision/u);
  assert.equal(conflicting.exists, false);
}, slow);

it("npm HTTP 200 for this version and source with another archive stops the ARM64 job before its push", () => {
  const replaced = registryGate({version: {version, gitHead: revision}, archive: "another archive"});
  assert.equal(replaced.ok, false);
  assert.match(replaced.output, /integrity mismatch/u);
  assert.equal(replaced.exists, false);
}, slow);

it("npm HTTP 200 for this exact source and archive passes and records the existing publication", () => {
  const matching = registryGate({version: {version, gitHead: revision}});
  assert.equal(matching.ok, true, matching.output);
  assert.equal(matching.exists, true);
}, slow);

it("a version npm does not have is a new publication, which the provenance step then binds to this commit", () => {
  const fresh = registryGate({});
  assert.equal(fresh.ok, true, fresh.output);
  assert.equal(fresh.exists, false);
  assert.equal(step("arm64", "Require source-bound provenance for new publications").run, 'test "$GITHUB_SHA" = "$REVISION"');
}, slow);

it("an npm channel that would move backwards stops the ARM64 job before its push", () => {
  const backwards = registryGate({alias: {version: "0.0.23-nightly.20261102120000.g0123456789ab"}});
  assert.equal(backwards.ok, false);
  assert.match(backwards.output, /backwards/u);
}, slow);

it("an existing Git tag for another commit stops the ARM64 job before its push", async () => {
  const script = step("arm64", "Verify the immutable Git tag").with!.script as string;
  const run = (lookup: () => Promise<unknown>) => runInNewContext(`(async()=>{${script}})()`, {
    github: {rest: {git: {getRef: async (request: unknown) => {
      // the request object comes from the script's own realm, so only its JSON is compared
      assert.deepEqual(JSON.parse(JSON.stringify(request)), {owner: "jfet97", repo: "t3-supervisor", ref: `tags/v${version}`});
      return lookup();
    }}}},
    context: {repo: {owner: "jfet97", repo: "t3-supervisor"}},
    process: {env: {TAG: `v${version}`, REVISION: revision}}}) as Promise<void>;
  await assert.rejects(run(async () => ({data: {object: {type: "commit", sha: "f".repeat(40)}}})), /different source revision/u);
  // an annotated tag object is not the commit itself
  await assert.rejects(run(async () => ({data: {object: {type: "tag", sha: revision}}})), /different source revision/u);
  await run(async () => ({data: {object: {type: "commit", sha: revision}}}));
  await run(async () => {throw Object.assign(new Error("Not Found"), {status: 404});});
  await assert.rejects(run(async () => {throw Object.assign(new Error("Server Error"), {status: 500});}), /Server Error/u);
});
