import assert from "node:assert/strict";
import {it} from "@effect/vitest";
import {releaseOnlyChange, provePushValidation, proveReleaseRun, requiredFullJobs, type CiRun} from "../scripts/ci-proof.js";
import {parseRawChanges} from "../scripts/ci-evidence.js";

const baseline = "a".repeat(40), head = "b".repeat(40), tree = "c".repeat(40);
const repository = "jfet97/t3-supervisor";
const manifest = JSON.stringify({name: "@jfet97/t3-supervisor", version: "0.0.4", scripts: {test: "vitest"}}, null, 2) + "\n";
const changed = (path: string, status = "M", oldMode = "100644", newMode = "100644") => ({path, status, oldMode, newMode});
const delta = () => ({parents: [baseline], basePackage: manifest, headPackage: manifest.replace('"0.0.4"', '"0.0.5"'), changes: [changed("package.json"), changed("CHANGELOG.md"), changed(".changeset/quiet-release.md", "D", "100644", "000000")]});
const run = (event = "pull_request"): typeof CiRun.Type => ({id: 10, workflow_id: 42, head_sha: event === "push" ? baseline : head, head_branch: event === "push" ? "main" : "changeset-release/main", event, repository: {full_name: repository}, head_repository: {full_name: repository}, status: "completed", conclusion: "success", run_attempt: 1});
const fullJobs = () => requiredFullJobs.map(name => ({name, run_id: 10, conclusion: "success"}));
const releaseSuccess = ["plan", "static", "arm64", "startup", "check"];
const releaseJobs = () => [...releaseSuccess, "harness", "browser", "main (${{ matrix.shard }}/4)"].map(name => ({name, run_id: 10, conclusion: releaseSuccess.includes(name) ? "success" : "skipped"}));
const releaseProof = () => ({expected: {repository, workflowId: 42, head, branch: "changeset-release/main", tree}, headTree: tree, runs: [run()], jobs: releaseJobs()});

it("accepts the generated stable version line, changelog and deleted pending notes", () => {
  assert.deepEqual(releaseOnlyChange(delta()), {baseline, from: "0.0.4", to: "0.0.5"});
  assert.equal(releaseOnlyChange({...delta(), changes: [changed("package.json"), changed("CHANGELOG.md", "A", "000000"), changed(".changeset/a.md", "D", "100644", "000000")]}).to, "0.0.5");
});

it.each(["src/main.ts", "test/cli.test.ts", "scripts/ci-proof.ts", ".github/workflows/check.yml", "pnpm-lock.yaml", "Dockerfile", ".changeset/config.json", ".changeset/README.md", "docs/CHANGELOG.md", "changelog.md"])("rejects release metadata with an additional %s change", path => {
  assert.throws(() => releaseOnlyChange({...delta(), changes: [...delta().changes, changed(path)]}));
});

it("rejects manifest scripts, dependencies, formatting, reordering and duplicate version keys", () => {
  for (const headPackage of [
    delta().headPackage.replace("vitest", "other"), delta().headPackage.replace('  "scripts"', '  "dependencies": {},\n  "scripts"'),
    delta().headPackage.replace('  "version"', '    "version"'), delta().headPackage.replace('  "version": "0.0.5",', '  "version": "0.0.5",\n  "version": "0.0.5",'),
    JSON.stringify({version: "0.0.5", name: "@jfet97/t3-supervisor", scripts: {test: "vitest"}}, null, 2),
  ]) assert.throws(() => releaseOnlyChange({...delta(), headPackage}));
});

it.each(["0.0.4", "0.0.3", "0.0.5-beta.1", "00.0.5"])("rejects unchanged, lower or non-stable version %s", version => {
  assert.throws(() => releaseOnlyChange({...delta(), headPackage: manifest.replace("0.0.4", version)}));
});

it("rejects edited/added/nested notes, removed changelog, modes, symlinks, duplicates and incomplete deltas", () => {
  const before = delta();
  for (const changes of [
    [], before.changes.slice(0, 2), before.changes.slice(1), [before.changes[0]!, before.changes[2]!],
    [...before.changes, before.changes[0]!], [...before.changes.slice(0, 2), changed(".changeset/nested/a.md", "D", "100644", "000000")],
    [changed("package.json", "M", "100644", "100755"), ...before.changes.slice(1)],
    [changed("package.json", "M", "120000", "120000"), ...before.changes.slice(1)],
    [before.changes[0]!, changed("CHANGELOG.md", "D", "100644", "000000"), before.changes[2]!],
    [...before.changes.slice(0, 2), changed(".changeset/new.md", "A", "000000")],
    [...before.changes.slice(0, 2), changed(".changeset/quiet-release.md")],
  ]) assert.throws(() => releaseOnlyChange({...before, changes}));
  for (const parents of [[], [baseline, head]]) assert.throws(() => releaseOnlyChange({...before, parents}));
});

it("requires direct full push evidence, never a lightweight or older green main verdict", () => {
  const input = {expected: {repository, workflowId: 42, commit: baseline}, runs: [run("push")], jobs: fullJobs()};
  assert.deepEqual(provePushValidation(input), {runId: 10});
  for (const conclusion of ["skipped", "failure", "cancelled", null]) {
    assert.throws(() => provePushValidation({...input, jobs: input.jobs.map(job => job.name === "main (1/4)" ? {...job, conclusion} : job)}));
  }
  assert.throws(() => provePushValidation({...input, runs: [...input.runs, {...run("push"), id: 11, status: "in_progress", conclusion: null}]}));
  for (const candidate of [{...run("push"), workflow_id: 99}, {...run("push"), head_sha: head}, {...run("push"), head_repository: null}, {...run("push"), repository: {full_name: "fork/repo"}}]) assert.throws(() => provePushValidation({...input, runs: [candidate]}));
  assert.throws(() => provePushValidation({...input, jobs: [...input.jobs, input.jobs[0]!]}));
});

it("reuses only a complete release run with successful static checks and skipped suites", () => {
  assert.deepEqual(proveReleaseRun(releaseProof()), {runId: 10, tree});
  assert.equal(proveReleaseRun({...releaseProof(), runs: [run("workflow_dispatch")]}).runId, 10);
  assert.throws(() => proveReleaseRun({...releaseProof(), headTree: baseline}));
  for (const name of releaseJobs().map(job => job.name)) {
    assert.throws(() => proveReleaseRun({...releaseProof(), jobs: releaseJobs().filter(job => job.name !== name)}));
    assert.throws(() => proveReleaseRun({...releaseProof(), jobs: [...releaseJobs(), releaseJobs().find(job => job.name === name)!]}));
  }
  // the native ARM64 artifact check runs on every new version, exactly like the static checks
  for (const target of ["static", "arm64", "startup"]) {
    for (const conclusion of ["failure", "cancelled", "skipped", null]) assert.throws(() => proveReleaseRun({...releaseProof(), jobs: releaseJobs().map(job => job.name === target ? {...job, conclusion} : job)}));
  }
  assert.throws(() => proveReleaseRun({...releaseProof(), jobs: [...releaseJobs(), {name: "extra", run_id: 10, conclusion: "success"}]}));
  // the browser journeys skip on a version exactly like the suites; the full baseline already ran them
  for (const conclusion of ["success", "failure", "cancelled", null]) {
    assert.throws(() => proveReleaseRun({...releaseProof(), jobs: releaseJobs().map(job => job.name === "browser" ? {...job, conclusion} : job)}));
  }
  assert.throws(() => proveReleaseRun({...releaseProof(), jobs: releaseJobs().map(job => job.name.startsWith("main") ? {...job, conclusion: "failure"} : job)}));
});

it("parses exact local raw Git changes and refuses malformed or rename-shaped records", () => {
  assert.deepEqual(parseRawChanges(`:100644 100644 ${baseline} ${head} M\0package.json\0`), [changed("package.json")]);
  assert.deepEqual(parseRawChanges(""), []);
  for (const raw of ["truncated", `:100644 100644 ${baseline} ${head} R100\0old\0new\0`, `:100644 100644 ${baseline} ${head} M\0`]) assert.throws(() => parseRawChanges(raw));
});
