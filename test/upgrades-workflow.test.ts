import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { parse } from "yaml";

/*
  The published Supervisor upgrades workflow (docs/ci.md): the daily advisory canary, a manual reproduction and the version PR's gate, all
  from one frozen T3 target lock and one frozen release lock. Its own shell steps run here for real over stand-in files: the journey
  selection, the record of the locks, their verification and the judge of a journey. Nothing resolves, pulls or starts anything.
*/

interface Step {
  readonly id?: string; readonly name?: string; readonly uses?: string; readonly run?: string; readonly if?: string;
  readonly env?: Readonly<Record<string, string>>; readonly with?: Readonly<Record<string, unknown>>; readonly "timeout-minutes"?: number;
}
interface Job {
  readonly if?: string; readonly name?: string; readonly "runs-on": string; readonly "timeout-minutes"?: number; readonly permissions?: Readonly<Record<string, string>>;
  readonly strategy?: {readonly "fail-fast"?: boolean}; readonly steps: ReadonlyArray<Step>;
}
interface Workflow {
  readonly on: {
    readonly schedule: ReadonlyArray<{readonly cron: string; readonly timezone?: string}>;
    readonly workflow_dispatch: {readonly inputs: Readonly<Record<string, unknown>>};
    readonly workflow_call: {readonly inputs: Readonly<Record<string, unknown>>};
  };
  readonly permissions: Readonly<Record<string, string>>;
  readonly jobs: Readonly<Record<string, Job>>;
}
const source = readFileSync(new URL("../.github/workflows/upgrades.yml", import.meta.url), "utf8");
const workflow = parse(source) as Workflow;
const job = (name: string): Job => {
  const found = workflow.jobs[name];
  assert.ok(found, `the workflow has a ${name} job`);
  return found;
};
const step = (jobName: string, id: string): Step => {
  const found = job(jobName).steps.find((candidate) => candidate.id === id);
  assert.ok(found, `${jobName} has a ${id} step`);
  return found;
};
const script = (jobName: string, id: string): string => {
  const {run} = step(jobName, id);
  assert.ok(run, `${jobName} ${id} runs a script`);
  return run;
};

interface StepRun {readonly ok: boolean; readonly outputs: Readonly<Record<string, string>>; readonly summary: string; readonly stderr: string}
// a step's own script as GitHub runs it (bash -eo pipefail) in `cwd`, with its outputs and step summary in files of their own
const runStep = (code: string, cwd: string, env: Readonly<Record<string, string>>): StepRun => {
  const files = mkdtempSync(join(tmpdir(), "t3sup-upgrades-step-"));
  try {
    const output = join(files, "output");
    const summary = join(files, "summary");
    writeFileSync(output, "");
    writeFileSync(summary, "");
    const result = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", code], {cwd, encoding: "utf8", timeout: 30_000,
      env: {PATH: process.env.PATH ?? "", HOME: files, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary, ...env}});
    const outputs: Record<string, string> = {};
    for (const line of readFileSync(output, "utf8").split("\n").filter((entry) => entry !== "")) outputs[line.slice(0, line.indexOf("="))] = line.slice(line.indexOf("=") + 1);
    return {ok: result.status === 0, outputs, summary: readFileSync(summary, "utf8"), stderr: result.stderr};
  } finally {
    rmSync(files, {recursive: true, force: true});
  }
};
const inFolder = <A>(use: (dir: string) => A): A => {
  const dir = mkdtempSync(join(tmpdir(), "t3sup-upgrades-"));
  try {
    return use(dir);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
};

// the frozen locks as the resolvers write them, and their SHA-256
const t3Lock = `${JSON.stringify({resolvedAt: "2026-11-05T05:11:00.000Z", source: "https://api.github.com/repos/pingdotgg/t3code/releases?per_page=100",
  targets: [["stable", "0.1.7"], ["nightly", "0.1.8-nightly.20261104.4165"], ["nightly-1", "0.1.8-nightly.20261103.4119"], ["nightly-2", "0.1.8-nightly.20261102.4100"]]
    .map(([slot, version]) => ({slot, version, tag: `v${version}`, publishedAt: "2026-11-04T04:00:00Z", baseUrl: "https://github.com/pingdotgg/t3code/releases/download",
      archives: {"linux-arm64": "a".repeat(64), "linux-x64": "b".repeat(64)}}))}, null, 2)}\n`;
const amd64 = `sha256:${"e".repeat(64)}`;
const releasesLock = `${JSON.stringify({resolvedAt: "2026-11-05T05:11:00.000Z", repository: "ghcr.io/jfet97/t3-supervisor", releases: [
  {channel: "stable", tag: "latest", version: "0.0.27", revision: "4".repeat(40), index: `sha256:${"a".repeat(64)}`,
    platforms: {"linux/amd64": amd64, "linux/arm64": `sha256:${"f".repeat(64)}`}, npm: null},
  {channel: "nightly", tag: "nightly", version: `0.0.28-nightly.20261105031700.g${"5".repeat(12)}`, revision: "5".repeat(40), index: `sha256:${"d".repeat(64)}`,
    platforms: {"linux/amd64": `sha256:${"c".repeat(64)}`, "linux/arm64": `sha256:${"b".repeat(64)}`}, npm: null},
]}, null, 2)}\n`;
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const commit = "c".repeat(40);

it("runs only by its daily schedule, a manual dispatch or check.yml's version PR gate, with read-only permissions and no stored credential", () => {
  assert.deepEqual(Object.keys(workflow.on).sort(), ["schedule", "workflow_call", "workflow_dispatch"]);
  assert.equal(workflow.on.schedule.length, 1);
  assert.deepEqual(Object.keys(workflow.on.workflow_call.inputs), ["gate"]);
  assert.deepEqual(Object.keys(workflow.on.workflow_dispatch.inputs).sort(), ["journeys", "lock_run"]);
  assert.deepEqual(workflow.permissions, {contents: "read"});
  assert.deepEqual(Object.fromEntries(Object.entries(workflow.jobs).map(([name, {permissions}]) => [name, permissions])),
    {"earlier-lock": {actions: "read"}, lock: {contents: "read"}, journey: {contents: "read"}});
  assert.doesNotMatch(source, /\bsecrets\.|\bvars\.|\bGITHUB_TOKEN\b/u);
  // the automatic read-only token reaches ./dev on the T3 resolve step alone; the earlier locks' download reads another run's artifact with it
  const holders = Object.entries(workflow.jobs).flatMap(([name, {steps}]) => steps.filter((candidate) => JSON.stringify(candidate).includes("github.token"))
    .map((candidate) => `${name}: ${candidate.name ?? ""}`));
  assert.deepEqual(holders, ["earlier-lock: Fetch the earlier run's frozen locks", "lock: Resolve the T3 targets once"]);
  assert.deepEqual(step("lock", "targets").env, {T3SUP_DEV_GITHUB_TOKEN: "${{ github.token }}"});
  assert.equal(step("lock", "releases").env, undefined);
  // every job and every long step is bounded, the journey step within its job, and a failing journey never cancels another
  for (const [name, {"timeout-minutes": minutes}] of Object.entries(workflow.jobs)) assert.ok(typeof minutes === "number" && minutes > 0, name);
  assert.ok((step("journey", "journey")["timeout-minutes"] ?? Number.POSITIVE_INFINITY) < (job("journey")["timeout-minutes"] ?? 0));
  for (const id of ["prepare", "targets", "releases"]) assert.ok(Number.isFinite(step("lock", id)["timeout-minutes"] ?? Number.POSITIVE_INFINITY), id);
  assert.equal(job("journey").strategy?.["fail-fast"], false);
  assert.equal(job("journey").name, "${{ matrix.journey }} journey");
});

it("keeps the locks and every journey's evidence as artifacts, also after a failure, and runs the contributors' own ./dev commands", () => {
  const uploads = (jobName: string) => job(jobName).steps.filter((candidate) => candidate.uses?.startsWith("actions/upload-artifact@") === true);
  const [lock] = uploads("lock");
  assert.deepEqual([lock?.if, lock?.with?.name, lock?.with?.path], ["${{ !cancelled() && steps.record.outputs.releases_sha256 != '' }}", "upgrade-lock",
    "upgrade/lock/t3-lock.json\nupgrade/lock/supervisor-releases.json\n"]);
  const [evidence] = uploads("journey");
  assert.deepEqual([evidence?.if, evidence?.with?.name, evidence?.with?.path], ["${{ always() }}", "upgrade-${{ matrix.journey }}-${{ github.run_attempt }}", "upgrade/"]);
  assert.equal(step("journey", "judge").if, "${{ always() }}");
  assert.equal(job("journey").if, "${{ !cancelled() && needs.lock.outputs.matrix != '' }}");
  const commands = (jobName: string) => job(jobName).steps.flatMap((candidate) => (candidate.run ?? "").split("\n").map((line) => line.trim())
    .filter((line) => line.startsWith("./dev")).map((line) => line.split(" 2>")[0]));
  assert.deepEqual(commands("lock"), ["./dev setup", "./dev pnpm dev:targets resolve --out upgrade/lock/t3-lock.json | tee upgrade/resolve-t3.log",
    "./dev pnpm dev:releases resolve --out upgrade/lock/supervisor-releases.json | tee upgrade/resolve-releases.log"]);
  assert.deepEqual(commands("journey"), ['./dev upgrade "${args[@]}"']);
  // a journey downloads the locks its run recorded and never resolves again
  assert.ok(!JSON.stringify(job("journey")).includes("dev:targets") && !JSON.stringify(job("journey")).includes("dev:releases"));
});

const selection = (env: Readonly<Record<string, string>>) => inFolder((dir) =>
  runStep(script("lock", "plan"), dir, {GATE: "false", EVENT: "workflow_dispatch", JOURNEYS: "all", LOCK_RUN: "", ...env}));
const journeysOf = (run: StepRun): ReadonlyArray<string> => (JSON.parse(run.outputs.matrix ?? "null") as {readonly journey: ReadonlyArray<string>}).journey;

it.live("selects every journey for the version PR's gate and the daily canary, and a manual reproduction's own list", () => Effect.sync(() => {
  for (const event of ["pull_request", "workflow_dispatch"]) {
    const gate = selection({GATE: "true", EVENT: event, JOURNEYS: ""});
    assert.ok(gate.ok, gate.stderr);
    assert.deepEqual(journeysOf(gate), ["stable", "nightly", "baseline"]);
    assert.deepEqual([gate.outputs.purpose, gate.outputs.source, gate.outputs.lock_run], ["gate", "resolve", ""]);
  }
  const canary = selection({EVENT: "schedule", JOURNEYS: ""});
  assert.deepEqual(journeysOf(canary), ["stable", "nightly", "baseline"]);
  assert.deepEqual([canary.outputs.purpose, canary.outputs.source], ["canary", "resolve"]);
  const frozen = selection({JOURNEYS: " nightly, baseline ", LOCK_RUN: "123456789"});
  assert.deepEqual(journeysOf(frozen), ["nightly", "baseline"]);
  assert.deepEqual([frozen.outputs.purpose, frozen.outputs.source, frozen.outputs.lock_run], ["reproduction", "earlier", "123456789"]);
  for (const refused of [{JOURNEYS: "bogus"}, {JOURNEYS: "stable,stable"}, {JOURNEYS: ""}, {JOURNEYS: "stable,,nightly"}, {LOCK_RUN: "12a"}, {EVENT: "push"}]) {
    const run = selection(refused);
    assert.equal(run.ok, false, JSON.stringify(refused));
    assert.equal(run.outputs.matrix, undefined, JSON.stringify(refused));
    assert.match(run.summary, /did not start/u);
  }
}), 30_000);

const record = (env: Readonly<Record<string, string>>, files: {readonly t3?: string; readonly releases?: string; readonly t3Log?: string; readonly releasesLog?: string}) =>
  inFolder((dir) => {
    mkdirSync(join(dir, "upgrade", "lock"), {recursive: true});
    if (files.t3 !== undefined) writeFileSync(join(dir, "upgrade", "lock", "t3-lock.json"), files.t3);
    if (files.releases !== undefined) writeFileSync(join(dir, "upgrade", "lock", "supervisor-releases.json"), files.releases);
    if (files.t3Log !== undefined) writeFileSync(join(dir, "upgrade", "resolve-t3.log"), files.t3Log);
    if (files.releasesLog !== undefined) writeFileSync(join(dir, "upgrade", "resolve-releases.log"), files.releasesLog);
    return runStep(script("lock", "record"), dir, {SOURCE: "resolve", PURPOSE: "canary", LOCK_RUN: "", FETCHED: "skipped", PREPARED: "success",
      TARGETS: "success", RELEASES: "success", ...env});
  });
// a resolver's stdout after pnpm's script header: its outcome as the last JSON line
const resolverLine = (outcome: string, message: string) => `> @jfet97/t3-supervisor dev:releases /workspace\n${JSON.stringify({outcome, message})}\n`;

it.live("records both frozen locks with their SHA-256, or the failing resolver's outcome, and never locks it cannot use", () => Effect.sync(() => {
  const resolved = record({}, {t3: t3Lock, releases: releasesLock});
  assert.ok(resolved.ok, resolved.stderr);
  assert.deepEqual(resolved.outputs, {outcome: "resolved", message: "", t3_sha256: sha256(t3Lock), releases_sha256: sha256(releasesLock)});
  assert.match(resolved.summary, /^### Frozen upgrade locks: resolved$/mu);
  assert.ok(resolved.summary.includes(`| stable | 0.0.27 | ${"4".repeat(40)} | sha256:${"a".repeat(64)} |`));
  assert.match(resolved.summary, /T3 stable 0\.1\.7/u);
  const reused = record({SOURCE: "earlier", PURPOSE: "reproduction", LOCK_RUN: "123456789", FETCHED: "success", PREPARED: "", TARGETS: "", RELEASES: ""},
    {t3: t3Lock, releases: releasesLock});
  assert.equal(reused.outputs.outcome, "reused");
  assert.match(reused.summary, /from run 123456789/u);
  for (const [env, files, outcome, message] of [
    [{SOURCE: "earlier", LOCK_RUN: "123456789", FETCHED: "failure", PREPARED: "", TARGETS: "", RELEASES: ""}, {}, "unavailable", /run 123456789 has no upgrade-lock artifact/u],
    [{RELEASES: "failure"}, {t3: t3Lock, releasesLog: resolverLine("unavailable", "GET https://ghcr.io/token returned HTTP 503")}, "unavailable", /HTTP 503/u],
    [{RELEASES: "failure"}, {t3: t3Lock, releasesLog: resolverLine("invalid", "the latest tag's index: it does not name exactly one linux/arm64 image")}, "invalid", /linux\/arm64/u],
    [{TARGETS: "failure", RELEASES: "skipped"}, {t3Log: resolverLine("unavailable", "GET https://api.github.com/x returned HTTP 403")}, "unavailable", /HTTP 403/u],
    [{RELEASES: "failure"}, {t3: t3Lock, releasesLog: "the registry broke off\n"}, "harness", /without reporting its outcome/u],
    [{PREPARED: "failure", TARGETS: "skipped", RELEASES: "skipped"}, {}, "harness", /could not be prepared/u],
    [{}, {t3: t3Lock, releases: releasesLock.replace('"nightly",\n      "tag"', '"beta",\n      "tag"')}, "invalid", /do not hold the T3 slots and the stable and nightly releases/u],
  ] as const) {
    const run = record(env, files);
    assert.equal(run.ok, false, outcome);
    assert.deepEqual([run.outputs.outcome, run.outputs.t3_sha256, run.outputs.releases_sha256], [outcome, "", ""], outcome);
    assert.match(run.outputs.message ?? "", message, outcome);
  }
}), 30_000);

const verify = (journey: string, changes: {readonly t3Sha?: string; readonly releases?: string} = {}) => inFolder((dir) => {
  mkdirSync(join(dir, "upgrade", "lock"), {recursive: true});
  writeFileSync(join(dir, "upgrade", "lock", "t3-lock.json"), t3Lock);
  writeFileSync(join(dir, "upgrade", "lock", "supervisor-releases.json"), changes.releases ?? releasesLock);
  for (const args of [["init", "-q"], ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "--allow-empty", "-m", "c"]])
    spawnSync("git", args, {cwd: dir, env: {PATH: process.env.PATH ?? "", HOME: dir}});
  return runStep(script("journey", "lock"), dir, {JOURNEY: journey, T3_SHA256: changes.t3Sha ?? sha256(t3Lock), RELEASES_SHA256: sha256(releasesLock)});
});

it.live("verifies the downloaded locks by their SHA-256 and names the T3 stable slot and the journey's own release and image", () => Effect.sync(() => {
  const stable = verify("stable");
  assert.ok(stable.ok, stable.stderr);
  assert.deepEqual([stable.outputs.t3_version, stable.outputs.version, stable.outputs.image], ["0.1.7", "0.0.27", `ghcr.io/jfet97/t3-supervisor@${amd64}`]);
  assert.match(stable.outputs.commit ?? "", /^[0-9a-f]{40}$/u);
  const baseline = verify("baseline");
  assert.deepEqual([baseline.ok, baseline.outputs.version, baseline.outputs.image], [true, "", ""]);
  assert.equal(verify("stable", {t3Sha: "0".repeat(64)}).ok, false);
  assert.equal(verify("nightly", {releases: releasesLock.replace("0.0.27", "0.0.26")}).ok, false);
}), 30_000);

// a journey's report as scripts/upgrade-journey.ts writes it
const report = (journey: string, changes: Readonly<Record<string, unknown>> = {}) => ({
  journey, outcome: "passed", passed: true, reason: "every check passed",
  inputs: {
    published: journey === "baseline" ? null : {channel: journey, version: "0.0.27", revision: "4".repeat(40), image: `ghcr.io/jfet97/t3-supervisor@${amd64}`,
      index: `sha256:${"a".repeat(64)}`, platform: "linux/amd64", releases: {file: "upgrade/lock/supervisor-releases.json", sha256: sha256(releasesLock)}},
    t3: {version: "0.1.7", source: "lock", lock: {file: "upgrade/lock/t3-lock.json", sha256: sha256(t3Lock)}},
    supervisor: {revision: commit, clean: true},
  },
  checks: [{name: "persisted shape recognized", ok: true, detail: "every file format 0; seed set format0-supervision-history"}],
  findings: [{name: "npm install path", outcome: "boot_failed", detail: "a fresh npm install of 0.0.27 did not boot"}],
  stages: [{stage: "candidate start", durationMs: 12_345, ok: true}],
  ...changes,
});
const judge = (env: Readonly<Record<string, string>>, files: {readonly report?: unknown; readonly status?: string} = {}) => inFolder((dir) => {
  mkdirSync(join(dir, "upgrade", "evidence", env.JOURNEY ?? "stable"), {recursive: true});
  if (files.report !== undefined) writeFileSync(join(dir, "upgrade", "evidence", env.JOURNEY ?? "stable", "report.json"), JSON.stringify(files.report));
  if (files.status !== undefined) writeFileSync(join(dir, "upgrade", "journey.status"), files.status);
  return runStep(script("journey", "judge"), dir, {JOURNEY: "stable", NATIVE: "success", LOCK_OUTCOME: "resolved", LOCK_MESSAGE: "", T3_SHA256: sha256(t3Lock),
    RELEASES_SHA256: sha256(releasesLock), VERIFIED: "success", T3_VERSION: "0.1.7", VERSION: "0.0.27", IMAGE: `ghcr.io/jfet97/t3-supervisor@${amd64}`,
    COMMIT: commit, ...env});
});

it.live("passes a journey only on a passing report of exactly its frozen inputs, and keeps every other outcome visible", () => Effect.sync(() => {
  const passed = judge({}, {report: report("stable"), status: "0 300"});
  assert.ok(passed.ok, passed.summary);
  assert.match(passed.summary, /^### stable journey: passed$/mu);
  assert.match(passed.summary, /\| persisted shape recognized \| passed \|/u);
  assert.match(passed.summary, /Separate finding, npm install path: boot_failed/u);
  const baseline = judge({JOURNEY: "baseline", VERSION: "", IMAGE: ""}, {report: report("baseline"), status: "0 200"});
  assert.ok(baseline.ok, baseline.summary);
  for (const [files, outcome, problem] of [
    [{report: report("stable", {outcome: "failed", passed: false}), status: "1 300"}, "failed", null],
    [{report: report("stable", {outcome: "creator_unready", passed: false}), status: "1 300"}, "creator_unready", null],
    [{report: report("stable", {outcome: "unsupported_shape", passed: false}), status: "1 300"}, "unsupported_shape", null],
    [{report: report("nightly"), status: "0 300"}, "harness", /names journey nightly/u],
    [{report: {...report("stable"), inputs: {...report("stable").inputs, supervisor: {revision: commit, clean: false}}}, status: "0 300"}, "harness", /a tree that was not clean/u],
    [{report: {...report("stable"), inputs: {...report("stable").inputs, t3: {version: "0.1.7", source: "pin", lock: null}}}, status: "0 300"}, "harness", /T3 0\.1\.7 from pin/u],
    [{report: report("stable"), status: "1 300"}, "harness", /exited 1 despite a passing report/u],
    [{report: report("stable", {outcome: "failed", passed: false}), status: "0 300"}, "harness", /exited 0 despite a report that did not pass/u],
    [{status: "1 30"}, "harness", /exited 1 without a report/u],
  ] as const) {
    const run = judge({}, files);
    assert.equal(run.ok, false, outcome);
    assert.match(run.summary, new RegExp(`^### stable journey: ${outcome}$`, "mu"), outcome);
    if (problem !== null) assert.match(run.summary, problem, outcome);
  }
  const unusable = judge({LOCK_OUTCOME: "unavailable", LOCK_MESSAGE: "GHCR did not answer", RELEASES_SHA256: "", T3_SHA256: "", VERIFIED: "skipped"});
  assert.match(unusable.summary, /^### stable journey: unavailable$/mu);
  assert.match(unusable.summary, /GHCR did not answer/u);
}), 30_000);

it("check.yml grants the gate call every permission any job of the upgrades workflow declares, all of them read-only", () => {
  const caller = (parse(readFileSync(new URL("../.github/workflows/check.yml", import.meta.url), "utf8")) as {
    readonly jobs: Readonly<Record<string, {readonly uses?: string; readonly permissions?: Readonly<Record<string, string>>}>>}).jobs["supervisor-upgrades"];
  assert.equal(caller?.uses, "./.github/workflows/upgrades.yml");
  const granted: Readonly<Record<string, string>> = caller?.permissions ?? {};
  const rank = (level: string | undefined) => ["none", "read", "write"].indexOf(level ?? "none");
  for (const [owner, requested] of [["the workflow", workflow.permissions], ...Object.entries(workflow.jobs).map(([name, {permissions}]) => [name, permissions ?? {}] as const)] as const) {
    for (const [scope, level] of Object.entries(requested)) {
      assert.ok(rank(level) >= 0 && rank(level) <= rank(granted[scope]), `${owner} asks for ${scope}: ${level}, the caller grants ${granted[scope] ?? "none"}`);
      assert.equal(level, "read", `${owner} ${scope}`);
    }
  }
});
