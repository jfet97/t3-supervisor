import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {spawnSync} from "node:child_process";
import {chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {it} from "@effect/vitest";
import {Effect} from "effect";
import {parse} from "yaml";

/*
  The published-T3 compatibility workflow (docs/ci.md): the daily advisory canary, a manual reproduction and the version PR's gate, all from
  one frozen target lock. Its own shell steps run here for real over stand-in files and commands: the slot selection, the record of the
  lock, the dashboard built once and its verification, the native runner check, the evidence folder, the lock verification, the runtime
  cache record and the judge of a slot. Nothing resolves, downloads or starts T3.
*/

interface Step {
  readonly id?: string; readonly name?: string; readonly uses?: string; readonly run?: string; readonly if?: string;
  readonly env?: Readonly<Record<string, string>>; readonly with?: Readonly<Record<string, unknown>>; readonly "timeout-minutes"?: number;
}
interface Job {
  readonly if?: string; readonly "runs-on": string; readonly "timeout-minutes"?: number; readonly permissions?: Readonly<Record<string, string>>;
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
const source = readFileSync(new URL("../.github/workflows/compatibility.yml", import.meta.url), "utf8");
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
  const files = mkdtempSync(join(tmpdir(), "t3sup-compat-step-"));
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
  const dir = mkdtempSync(join(tmpdir(), "t3sup-compat-"));
  try {
    return use(dir);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
};

// a frozen lock as the resolver writes it, and its SHA-256
const versions = {stable: "0.1.6", nightly: "0.1.7-nightly.20261102.4100", "nightly-1": "0.1.7-nightly.20261101.4016", "nightly-2": "0.1.7-nightly.20261031.3990"};
const lockText = `${JSON.stringify({resolvedAt: "2026-11-03T04:41:00.000Z", source: "https://api.github.com/repos/pingdotgg/t3code/releases?per_page=100",
  targets: Object.entries(versions).map(([slot, version]) => ({slot, version, tag: `v${version}`, publishedAt: "2026-11-02T04:00:00Z",
    baseUrl: "https://github.com/pingdotgg/t3code/releases/download", archives: {"linux-arm64": "a".repeat(64), "linux-x64": "b".repeat(64)}}))}, null, 2)}\n`;
const digest = createHash("sha256").update(lockText).digest("hex");
const commit = "c".repeat(40);

it("runs only by its daily schedule, a manual dispatch or check.yml's version PR gate, with read-only permissions and no stored credential", () => {
  assert.deepEqual(Object.keys(workflow.on).sort(), ["schedule", "workflow_call", "workflow_dispatch"]);
  assert.equal(workflow.on.schedule.length, 1);
  assert.deepEqual(Object.keys(workflow.on.workflow_call.inputs), ["gate"]);
  assert.deepEqual(Object.keys(workflow.on.workflow_dispatch.inputs).sort(), ["architecture", "lock_run", "slots"]);
  assert.deepEqual(workflow.permissions, {contents: "read"});
  assert.deepEqual(Object.fromEntries(Object.entries(workflow.jobs).map(([name, {permissions}]) => [name, permissions])),
    {"earlier-lock": {actions: "read"}, lock: {contents: "read"}, assets: {contents: "read"}, slot: {contents: "read"}});
  assert.doesNotMatch(source, /\bsecrets\.|\bvars\.|\bGITHUB_TOKEN\b/u);
  // the automatic read-only token reaches ./dev on the resolve step alone; the earlier lock's download reads another run's artifact with it
  const holders = Object.entries(workflow.jobs).flatMap(([name, {steps}]) => steps.filter((candidate) => JSON.stringify(candidate).includes("github.token"))
    .map((candidate) => `${name}: ${candidate.name ?? ""}`));
  assert.deepEqual(holders, ["earlier-lock: Fetch the earlier run's frozen lock", "lock: Resolve the published T3 targets once"]);
  assert.deepEqual(step("lock", "resolve").env, {T3SUP_DEV_GITHUB_TOKEN: "${{ github.token }}"});
  assert.equal(source.split("T3SUP_DEV_GITHUB_TOKEN").length, 2);
  // every job and every long step is bounded, and a failing slot never cancels another
  for (const [name, {"timeout-minutes": minutes}] of Object.entries(workflow.jobs)) assert.ok(typeof minutes === "number" && minutes > 0, name);
  const bounded = ["prepare", "check", "probe"].map((id) => step("slot", id)["timeout-minutes"] ?? Number.POSITIVE_INFINITY);
  assert.ok(bounded.reduce((sum, minutes) => sum + minutes, 0) < (job("slot")["timeout-minutes"] ?? 0));
  for (const id of ["prepare", "resolve"]) assert.ok(Number.isFinite(step("lock", id)["timeout-minutes"] ?? Number.POSITIVE_INFINITY), id);
  assert.equal(job("slot").strategy?.["fail-fast"], false);
});

it("keeps the lock and every slot's evidence as artifacts, also after a failure, and runs the contributors' own ./dev commands", () => {
  const uploads = (jobName: string) => job(jobName).steps.filter((candidate) => candidate.uses?.startsWith("actions/upload-artifact@") === true);
  const [lock] = uploads("lock");
  assert.deepEqual([lock?.if, lock?.with?.name, lock?.with?.path], ["${{ !cancelled() && steps.record.outputs.sha256 != '' }}", "t3-lock", "t3-compat/lock/t3-lock.json"]);
  const [evidence] = uploads("slot");
  // the runtime stays in the job's Docker cache, outside the uploaded evidence
  assert.deepEqual([evidence?.if, evidence?.with?.name, evidence?.with?.path],
    ["${{ always() }}", "t3-compat-${{ matrix.slot }}-${{ matrix.arch }}-${{ github.run_attempt }}", "t3-compat/"]);
  const [dashboard] = uploads("assets");
  assert.deepEqual([dashboard?.with?.name, dashboard?.with?.path, dashboard?.with?.["include-hidden-files"]], ["t3-compat-assets", "ui-dist/\nt3-compat/assets/\n", true]);
  assert.equal(step("slot", "judge").if, "${{ always() }}");
  // an unusable lock still starts every slot, which then reports that lock's outcome rather than appearing skipped
  assert.equal(job("slot").if, "${{ !cancelled() && needs.lock.outputs.matrix != '' }}");
  const commands = (jobName: string) => job(jobName).steps.flatMap((candidate) => (candidate.run ?? "").split("\n").map((line) => line.trim())
    .filter((line) => line.startsWith("./dev")).map((line) => line.split(" 2>")[0]));
  assert.deepEqual(commands("lock"), ["./dev setup", "./dev pnpm dev:targets resolve --out t3-compat/lock/t3-lock.json | tee t3-compat/resolve.log"]);
  assert.deepEqual(commands("assets"), ["./dev setup", "./dev pnpm build"]);
  // both runs use the job's Docker runtime cache; ./dev check supplies that cache directory itself
  assert.deepEqual(commands("slot"), ["./dev setup",
    './dev check --t3-lock t3-compat/lock/t3-lock.json --slot "$SLOT"',
    './dev pnpm exec node --import tsx scripts/t3-cohort.ts --probe --cache-dir /cache/t3-runtime --t3-lock t3-compat/lock/t3-lock.json --slot "$SLOT"']);
  // a slot downloads the one lock its run recorded and the dashboard its run built, and neither resolves nor builds again
  assert.ok(!JSON.stringify(job("slot")).includes("dev:targets"));
  assert.ok(!JSON.stringify(job("slot")).includes("pnpm build"));
});

const selection = (env: Readonly<Record<string, string>>) => inFolder((dir) =>
  runStep(script("lock", "plan"), dir, {GATE: "false", EVENT: "workflow_dispatch", SLOTS: "all", LOCK_RUN: "", ARCHITECTURE: "x64", ...env}));
const slotsOf = (run: StepRun): ReadonlyArray<string> =>
  (JSON.parse(run.outputs.matrix ?? "null") as {readonly include: ReadonlyArray<{readonly slot: string; readonly arch: string; readonly runner: string}>})
    .include.map(({slot, arch, runner}) => `${slot} ${arch} ${runner}`);
const all = ["stable", "nightly", "nightly-1", "nightly-2"];
const x64 = (slot: string) => `${slot} x64 ubuntu-latest`;
const arm64 = (slot: string) => `${slot} arm64 ubuntu-24.04-arm`;

it.live("selects the version PR's gate, the daily canary or a manual reproduction's slots, each on a native runner of its architecture", () => Effect.sync(() => {
  // check.yml calls the gate for the version PR and for a dispatch on its branch alike
  for (const event of ["pull_request", "workflow_dispatch"]) {
    const gate = selection({GATE: "true", EVENT: event, SLOTS: "", ARCHITECTURE: ""});
    assert.ok(gate.ok, gate.stderr);
    assert.deepEqual(slotsOf(gate), [...all.map(x64), arm64("stable"), arm64("nightly")]);
    assert.deepEqual([gate.outputs.purpose, gate.outputs.source, gate.outputs.lock_run], ["gate", "resolve", ""]);
  }
  const canary = selection({EVENT: "schedule", SLOTS: "", ARCHITECTURE: ""});
  assert.deepEqual(slotsOf(canary), all.map(x64));
  assert.deepEqual([canary.outputs.purpose, canary.outputs.source], ["canary", "resolve"]);
  const fresh = selection({ARCHITECTURE: "arm64"});
  assert.deepEqual(slotsOf(fresh), all.map(arm64));
  assert.deepEqual([fresh.outputs.purpose, fresh.outputs.source], ["reproduction", "resolve"]);
  const frozen = selection({SLOTS: " nightly-2, stable ", LOCK_RUN: "123456789"});
  assert.deepEqual(slotsOf(frozen), [x64("nightly-2"), x64("stable")]);
  assert.deepEqual([frozen.outputs.source, frozen.outputs.lock_run], ["earlier", "123456789"]);
  const refusals: ReadonlyArray<Readonly<Record<string, string>>> = [{SLOTS: "bogus"}, {SLOTS: "stable,stable"}, {SLOTS: ""}, {SLOTS: "stable,,nightly"},
    {LOCK_RUN: "12a"}, {LOCK_RUN: " 12"}, {ARCHITECTURE: "riscv64"}, {EVENT: "push"}];
  for (const refused of refusals) {
    const run = selection(refused);
    assert.equal(run.ok, false, JSON.stringify(refused));
    assert.equal(run.outputs.matrix, undefined, JSON.stringify(refused));
    assert.match(run.summary, /did not start/u);
  }
}), 30_000);

const record = (env: Readonly<Record<string, string>>, files: {readonly lock?: string; readonly log?: string}) => inFolder((dir) => {
  mkdirSync(join(dir, "t3-compat", "lock"), {recursive: true});
  if (files.lock !== undefined) writeFileSync(join(dir, "t3-compat", "lock", "t3-lock.json"), files.lock);
  if (files.log !== undefined) writeFileSync(join(dir, "t3-compat", "resolve.log"), files.log);
  return runStep(script("lock", "record"), dir, {SOURCE: "resolve", PURPOSE: "canary", LOCK_RUN: "", FETCHED: "skipped", PREPARED: "success", RESOLVED: "success", ...env});
});
// the resolver's stdout after pnpm's script header: its outcome as the last JSON line
const resolverLine = (outcome: string, message: string) => `> @jfet97/t3-supervisor dev:targets /workspace\n${JSON.stringify({outcome, message})}\n`;

it.live("records the frozen lock with its SHA-256, or the resolver's unavailable or invalid outcome, and never a lock it cannot use", () => Effect.sync(() => {
  const resolved = record({}, {lock: lockText, log: `stable     T3 ${versions.stable}\n`});
  assert.ok(resolved.ok, resolved.stderr);
  assert.deepEqual(resolved.outputs, {outcome: "resolved", message: "", sha256: digest});
  assert.match(resolved.summary, /^### Frozen T3 lock: resolved$/mu);
  assert.ok(resolved.summary.includes(`| nightly-1 | ${versions["nightly-1"]} | 2026-11-02T04:00:00Z |`));
  const reused = record({SOURCE: "earlier", PURPOSE: "reproduction", LOCK_RUN: "123456789", FETCHED: "success", PREPARED: "", RESOLVED: ""}, {lock: lockText});
  assert.deepEqual(reused.outputs, {outcome: "reused", message: "", sha256: digest});
  assert.match(reused.summary, /from run 123456789/u);
  for (const [env, files, outcome, message] of [
    [{SOURCE: "earlier", LOCK_RUN: "123456789", FETCHED: "failure", PREPARED: "", RESOLVED: ""}, {}, "unavailable", /run 123456789 has no t3-lock artifact/u],
    [{RESOLVED: "failure"}, {log: resolverLine("unavailable", "GET https://api.github.com/x returned HTTP 403; GitHub's API rate limit is exhausted")}, "unavailable", /HTTP 403/u],
    [{RESOLVED: "failure"}, {log: resolverLine("invalid", "the 300 releases on 3 page(s) of the release list hold fewer than 3 nightly releases (2)")}, "invalid", /fewer than 3/u],
    [{RESOLVED: "failure"}, {log: "the release list broke off\n"}, "harness", /without reporting its outcome/u],
    [{PREPARED: "failure", RESOLVED: "skipped"}, {}, "harness", /could not be prepared/u],
    [{}, {lock: lockText.replace('"nightly-2"', '"nightly-3"')}, "invalid", /does not hold the slots/u],
  ] as const) {
    const run = record(env, files);
    assert.equal(run.ok, false, outcome);
    assert.deepEqual([run.outputs.outcome, run.outputs.sha256], [outcome, ""]);
    assert.match(run.outputs.message ?? "", message);
    assert.match(run.summary, new RegExp(`^### Frozen T3 lock: ${outcome}$`, "mu"));
  }
}), 30_000);

it.live("runs every slot on a native runner of its own architecture and emulates nothing", () => Effect.sync(() => {
  assert.equal(job("slot")["runs-on"], "${{ matrix.runner }}");
  assert.doesNotMatch(source, /qemu|binfmt/iu);
  inFolder((dir) => {
    mkdirSync(join(dir, "bin"));
    writeFileSync(join(dir, "bin", "uname"), "#!/bin/sh\necho \"$MACHINE\"\n");
    chmodSync(join(dir, "bin", "uname"), 0o755);
    const native = (arch: string, machine: string) => runStep(script("slot", "native"), dir, {ARCH: arch, MACHINE: machine, PATH: `${join(dir, "bin")}:${process.env.PATH ?? ""}`}).ok;
    assert.deepEqual([native("x64", "x86_64"), native("arm64", "aarch64"), native("arm64", "x86_64"), native("x64", "aarch64"), native("riscv64", "riscv64")],
      [true, true, false, false, false]);
  });
}));

// a Git command in a throwaway repository with no user or system configuration of its own
const git = (dir: string, ...args: ReadonlyArray<string>): string => {
  const result = spawnSync("git", ["-c", "user.name=CI", "-c", "user.email=ci@example.invalid", ...args], {cwd: dir, encoding: "utf8", timeout: 30_000,
    env: {PATH: process.env.PATH ?? "", HOME: dir, GIT_CONFIG_NOSYSTEM: "1"}});
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};

it.live("keeps the evidence out of the checkout's status and runs a slot only from the recorded lock's exact bytes", () => Effect.sync(() => inFolder((dir) => {
  git(dir, "init", "--quiet");
  git(dir, "commit", "--quiet", "--allow-empty", "--message", "checked");
  const head = git(dir, "rev-parse", "HEAD");
  assert.ok(runStep(script("slot", "evidence"), dir, {}).ok);
  writeFileSync(join(dir, "t3-compat", "lock", "t3-lock.json"), lockText);
  writeFileSync(join(dir, "t3-compat", "check.log"), "PASS  published T3 descriptor\n");
  // so each report truthfully names the checked commit's tree as clean
  assert.equal(git(dir, "status", "--porcelain"), "");
  const verified = runStep(script("slot", "lock"), dir, {SLOT: "nightly-1", ARCH: "x64", LOCK_SHA256: digest});
  assert.ok(verified.ok, verified.stderr);
  assert.deepEqual(verified.outputs, {version: versions["nightly-1"], platform: "linux-x64", archive: "b".repeat(64), commit: head});
  assert.deepEqual(runStep(script("slot", "lock"), dir, {SLOT: "stable", ARCH: "arm64", LOCK_SHA256: digest}).outputs,
    {version: versions.stable, platform: "linux-arm64", archive: "a".repeat(64), commit: head});
  for (const env of [{SLOT: "nightly-1", ARCH: "x64", LOCK_SHA256: "0".repeat(64)}, {SLOT: "nightly-3", ARCH: "x64", LOCK_SHA256: digest},
    {SLOT: "nightly-1", ARCH: "riscv64", LOCK_SHA256: digest}]) {
    const refused = runStep(script("slot", "lock"), dir, env);
    assert.equal(refused.ok, false, JSON.stringify(env));
    assert.deepEqual(refused.outputs, {});
  }
  // the selected platform archive must have a valid digest before any runtime is installed
  const broken = lockText.replace("b".repeat(64), "not a digest");
  writeFileSync(join(dir, "t3-compat", "lock", "t3-lock.json"), broken);
  assert.equal(runStep(script("slot", "lock"), dir, {SLOT: "stable", ARCH: "x64", LOCK_SHA256: createHash("sha256").update(broken).digest("hex")}).ok, false);
})), 30_000);

const checkReport = {t3: versions.nightly, slot: "nightly", lock: {file: "t3-compat/lock/t3-lock.json", sha256: digest}, supervisor: {revision: commit, clean: true},
  passed: true, totalMs: 103_240,
  stages: [{stage: "runtime install", durationMs: 9_812, ok: true, detail: "download + verify + unpack"}, {stage: "T3 start", durationMs: 2_950, ok: true},
    {stage: "teardown", durationMs: 1_020, ok: true}],
  results: [{name: "published T3 descriptor", ok: true, detail: "descriptor", durationMs: 12}, {name: "teardown leaves nothing running", ok: true, detail: "ports refused", durationMs: 30}]};
const probeReport = {t3: versions.nightly, reported: versions.nightly, slot: "nightly", lock: {file: "t3-compat/lock/t3-lock.json", sha256: digest},
  supervisor: {revision: commit, clean: true}, passed: true,
  steps: [{name: "stack", operations: ["local-stack startStack"], outcome: "accepted", detail: "started", elapsedMs: 6_100},
    {name: "thread-stop-idle", operations: ["orchestration/dispatchCommand ThreadStop"], outcome: "accepted", detail: "stopped", elapsedMs: 240}]};
interface Run {readonly report?: unknown; readonly status?: string; readonly log?: string}
const passing = {check: {report: checkReport, status: "0"}, probe: {report: probeReport, status: "0"}};
// the judge over each run's stand-in output and exit status, with this slot's frozen inputs unless `env` changes them
const judged = (runs: {readonly check?: Run; readonly probe?: Run}, env: Readonly<Record<string, string>> = {}) => inFolder((dir) => {
  mkdirSync(join(dir, "t3-compat"));
  for (const [name, run] of Object.entries(runs)) {
    if (run === undefined) continue;
    writeFileSync(join(dir, "t3-compat", `${name}.log`), run.log ?? `PASS  a check\n${JSON.stringify(run.report)}\n`);
    if (run.status !== undefined) writeFileSync(join(dir, "t3-compat", `${name}.status`), `${run.status} 104\n`);
  }
  const result = runStep(script("slot", "judge"), dir, {SLOT: "nightly", ARCH: "x64", NATIVE: "success", LOCK_OUTCOME: "resolved", LOCK_MESSAGE: "",
    LOCK_SHA256: digest, VERIFIED: "success", VERSION: versions.nightly, COMMIT: commit, ASSETS: "success", PREPARED: "success", ...env});
  return {...result, kept: readFileSync(join(dir, "t3-compat", "summary.md"), "utf8")};
});

it.live("passes a slot only when both runs passed and both reports name the slot, its locked T3, the lock's SHA-256 and the clean checked commit", () => Effect.sync(() => {
  const passed = judged(passing);
  assert.ok(passed.ok, passed.stderr);
  assert.equal(passed.summary, passed.kept);
  assert.match(passed.summary, /^### nightly on x64: passed$/mu);
  assert.ok(passed.summary.includes(`T3 \`${versions.nightly}\` from the frozen lock \`${digest}\` (resolved), Supervisor \`${commit}\`.`));
  assert.ok(passed.summary.includes("| 12-check run | passed | none | 103.2 s | 104 s |"));
  assert.ok(passed.summary.includes("| cohort probe | passed | none | 6.3 s | 104 s |"));
  assert.ok(passed.summary.includes("12-check run stages: runtime install 9.8 s (download + verify + unpack); T3 start 3 s; teardown 1 s"));
  assert.ok(passed.summary.includes("Cohort probe steps: stack 6.1 s; thread-stop-idle 0.2 s"));

  const failedCheck = judged({...passing, check: {status: "1", report: {...checkReport, passed: false, results: [{name: "published T3 descriptor", ok: true, detail: ""},
    {name: "Supervisor ingests the T3 catalog", ok: false, detail: "no catalog"}, {name: "teardown leaves nothing running", ok: false, detail: "", notRun: true}]}}});
  assert.equal(failedCheck.ok, false);
  assert.match(failedCheck.summary, /^### nightly on x64: failed$/mu);
  assert.ok(failedCheck.summary.includes("| 12-check run | failed | Supervisor ingests the T3 catalog, teardown leaves nothing running (not run) |"));
  const failedProbe = judged({...passing, probe: {status: "1", report: {...probeReport, passed: false,
    steps: [...probeReport.steps, {name: "helper-webhook", operations: [], outcome: "uncertain", detail: "no answer", elapsedMs: 900}]}}});
  assert.equal(failedProbe.ok, false);
  assert.match(failedProbe.summary, /^### nightly on x64: failed$/mu);
  assert.ok(failedProbe.summary.includes("| cohort probe | failed | helper-webhook (uncertain) |"));

  // a report of other inputs, a missing report or an exit that contradicts its report is a harness or provenance failure, never a pass
  const withoutLock = Object.fromEntries(Object.entries(probeReport).filter(([key]) => key !== "lock"));
  for (const [label, runs, reason] of [
    ["another lock", {...passing, check: {status: "0", report: {...checkReport, lock: {file: "other.json", sha256: "f".repeat(64)}}}}, /a lock with SHA-256 f{64}/u],
    ["no lock", {...passing, probe: {status: "0", report: withoutLock}}, /cohort probe report names no lock/u],
    ["another T3", {...passing, probe: {status: "0", report: {...probeReport, t3: versions["nightly-1"]}}}, /names T3 0\.1\.7-nightly\.20261101\.4016/u],
    ["another slot", {...passing, check: {status: "0", report: {...checkReport, slot: "stable"}}}, /12-check run report names slot stable/u],
    ["another commit", {...passing, check: {status: "0", report: {...checkReport, supervisor: {revision: "d".repeat(40), clean: true}}}}, /commit d{40}/u],
    ["a dirty tree", {...passing, probe: {status: "0", report: {...probeReport, supervisor: {revision: commit, clean: false}}}}, /a tree that was not clean/u],
    ["no summary", {...passing, check: {status: "1", log: "FAIL  the stack did not start\n"}}, /12-check run exited 1 without a JSON summary/u],
    ["unfinished", {check: passing.check}, /cohort probe did not finish/u],
    ["a failing exit", {...passing, check: {status: "1", report: checkReport}}, /12-check run exited 1 despite a passing summary/u],
    ["a passing exit", {...passing, probe: {status: "0", report: {...probeReport, passed: false}}}, /cohort probe exited 0 despite a failing summary/u],
  ] as const) {
    const run = judged(runs);
    assert.equal(run.ok, false, label);
    assert.match(run.summary, /^### nightly on x64: harness$/mu, label);
    assert.match(run.summary, reason, label);
  }

  // an unusable lock fails every slot with its own outcome, and no runner, lock or setup problem passes on earlier reports
  const unavailable = judged({}, {LOCK_OUTCOME: "unavailable", LOCK_MESSAGE: "GET https://api.github.com/x returned HTTP 403", LOCK_SHA256: "",
    VERIFIED: "skipped", VERSION: "", COMMIT: "", ASSETS: "skipped", PREPARED: "skipped"});
  assert.equal(unavailable.ok, false);
  assert.match(unavailable.summary, /^### nightly on x64: unavailable$/mu);
  assert.match(unavailable.summary, /no usable frozen T3 lock \(unavailable\): GET \S+ returned HTTP 403/u);
  for (const env of [{NATIVE: "failure"}, {VERIFIED: "failure"}, {ASSETS: "failure"}, {ASSETS: "skipped"}, {PREPARED: "failure"}] as const) {
    const run = judged(passing, env);
    assert.equal(run.ok, false, JSON.stringify(env));
    assert.match(run.summary, /^### nightly on x64: harness$/mu, JSON.stringify(env));
  }
}), 30_000);

it.live("builds the dashboard once per run and runs a slot only with the build of its own checked commit, file for file", () => Effect.sync(() => inFolder((dir) => {
  git(dir, "init", "--quiet");
  git(dir, "commit", "--quiet", "--allow-empty", "--message", "checked");
  mkdirSync(join(dir, "ui-dist", "assets"), {recursive: true});
  writeFileSync(join(dir, "ui-dist", "index.html"), "<!doctype html>\n");
  writeFileSync(join(dir, "ui-dist", "assets", "index-0a1b2c.js"), "export {};\n");
  const recorded = runStep(script("assets", "manifest"), dir, {});
  assert.ok(recorded.ok, recorded.stderr);
  assert.equal(readFileSync(join(dir, "t3-compat", "assets", "commit"), "utf8").trim(), git(dir, "rev-parse", "HEAD"));
  const verified = () => runStep(script("slot", "assets"), dir, {}).ok;
  assert.equal(verified(), true);
  // another file content, an extra file or another commit's build is refused
  writeFileSync(join(dir, "ui-dist", "assets", "index-0a1b2c.js"), "export const changed = 1;\n");
  assert.equal(verified(), false);
  writeFileSync(join(dir, "ui-dist", "assets", "index-0a1b2c.js"), "export {};\n");
  assert.equal(verified(), true);
  writeFileSync(join(dir, "ui-dist", "extra.js"), "");
  assert.equal(verified(), false);
  rmSync(join(dir, "ui-dist", "extra.js"));
  git(dir, "commit", "--quiet", "--allow-empty", "--message", "another");
  assert.equal(verified(), false);
  // a build without its page is never recorded
  rmSync(join(dir, "ui-dist", "index.html"));
  assert.equal(runStep(script("assets", "manifest"), dir, {}).ok, false);
})), 30_000);

it.live("both workflow commands share the verified runtime cache inside one job without saving it across runs", () => Effect.sync(() => inFolder((dir) => {
  mkdirSync(join(dir, "bin"));
  mkdirSync(join(dir, "t3-compat"));
  const calls = join(dir, "calls");
  writeFileSync(join(dir, "dev"), readFileSync(new URL("../dev", import.meta.url)));
  chmodSync(join(dir, "dev"), 0o755);
  writeFileSync(join(dir, "bin", "docker"), `#!/usr/bin/env bash
printf '%s\\0' "$@" >> "$CALLS"
printf '\\0' >> "$CALLS"
printf '{}\\n'
`);
  chmodSync(join(dir, "bin", "docker"), 0o755);
  for (const name of ["check", "probe"]) {
    const result = runStep(script("slot", name), dir, {SLOT: "stable", CALLS: calls, PATH: `${join(dir, "bin")}:${process.env.PATH ?? ""}`});
    assert.ok(result.ok, result.stderr);
  }
  const commands = readFileSync(calls, "utf8").split("\0\0").filter(Boolean).map((frame) => frame.split("\0"))
    .filter((args) => args.includes("tools")).map((args) => args.slice(args.indexOf("tools") + 1));
  assert.equal(commands.length, 2);
  const roots = commands.map((args) => {
    const at = args.indexOf("--cache-dir");
    assert.ok(at >= 0, "both real ./dev entry points supply the runtime cache");
    return args[at + 1];
  });
  assert.ok(roots[0]?.startsWith("/"), "runtime installation uses an absolute cache path");
  assert.equal(roots[0], roots[1]);
  assert.ok(job("slot").steps.every((candidate) => !candidate.uses?.startsWith("actions/cache/")));
})), 30_000);

it("check.yml grants the gate call every permission any job of the compatibility workflow declares, all of them read-only", () => {
  /* GitHub only keeps or reduces a token's permissions down a call chain, and refuses the call when a callee job asks for more, even one
     its condition would skip */
  const caller = (parse(readFileSync(new URL("../.github/workflows/check.yml", import.meta.url), "utf8")) as {
    readonly jobs: Readonly<Record<string, {readonly uses?: string; readonly permissions?: Readonly<Record<string, string>>}>>}).jobs["t3-compatibility"];
  assert.equal(caller?.uses, "./.github/workflows/compatibility.yml");
  const granted: Readonly<Record<string, string>> = caller?.permissions ?? {};
  assert.deepEqual({...granted}, {contents: "read", actions: "read"});
  const rank = (level: string | undefined) => ["none", "read", "write"].indexOf(level ?? "none");
  const requests: ReadonlyArray<readonly [string, Readonly<Record<string, string>>]> = [["the workflow", workflow.permissions],
    ...Object.entries(workflow.jobs).map(([name, {permissions}]) => [name, permissions ?? {}] as const)];
  for (const [owner, requested] of requests) {
    for (const [scope, level] of Object.entries(requested)) {
      assert.ok(rank(level) >= 0 && rank(level) <= rank(granted[scope]), `${owner} asks for ${scope}: ${level}, the caller grants ${granted[scope] ?? "none"}`);
      assert.equal(level, "read", `${owner} ${scope}`);
    }
  }
});
