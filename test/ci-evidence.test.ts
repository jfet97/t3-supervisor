import assert from "node:assert/strict";
import {chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {spawnSync} from "node:child_process";
import {runInNewContext} from "node:vm";
import {it} from "@effect/vitest";
import {Effect} from "effect";
import {parse} from "yaml";
import * as policy from "../scripts/ci-proof.js";
import {planCi, type CiGithub} from "../scripts/ci-evidence.js";

const B = "a".repeat(40), H = "b".repeat(40), S = "c".repeat(40), M = "d".repeat(40), T = "e".repeat(40), U = "f".repeat(40);
const repository = "jfet97/t3-supervisor";
const manifest = '{\n  "name": "@jfet97/t3-supervisor",\n  "version": "0.0.4"\n}\n';
const run = (id: number, head_sha: string, event: string, branch: string): typeof policy.CiRun.Type => ({id, workflow_id: 42, head_sha, head_branch: branch, event, repository: {full_name: repository}, head_repository: {full_name: repository}, status: "completed", conclusion: "success", run_attempt: 1});
const full = (id: number) => policy.requiredFullJobs.map(name => ({name, run_id: id, conclusion: "success"}));
const release = (id: number) => ["plan", "static", "arm64", "startup", "check", "harness", "browser", "main (${{ matrix.shard }}/4)"].map(name => ({name, run_id: id, conclusion: ["plan", "static", "arm64", "startup", "check"].includes(name) ? "success" : "skipped"}));
const pr = (merge: string | null, head: string, branch: string) => ({merged_at: merge ? "2026-10-25T00:00:00Z" : null, merge_commit_sha: merge, base: {ref: "main"}, head: {sha: head, ref: branch, repo: {full_name: repository}}});
const rawChange = (path: string, status = "M") => `:100644 ${status === "D" ? "000000" : "100644"} ${B} ${status === "D" ? "0".repeat(40) : H} ${status}\0${path}\0`;

const fixture = () => {
  const runs = new Map<string, Array<typeof policy.CiRun.Type>>([[B, [run(20, B, "push", "main")]], [S, [run(10, S, "pull_request", "feature")]], [H, [run(30, H, "workflow_dispatch", "changeset-release/main")]]]);
  const jobs = new Map([[10, full(10)], [20, [{name: "check", run_id: 20, conclusion: "success"}]], [30, release(30)]]);
  const context = {eventName: "pull_request", sha: H, ref: "refs/pull/21/merge", repo: {owner: "jfet97", repo: "t3-supervisor"}, payload: {pull_request: pr(null, H, "changeset-release/main")}};
  const state = {raw: rawChange("package.json") + rawChange("CHANGELOG.md") + rawChange(".changeset/quiet.md", "D"), headPackage: manifest.replace("0.0.4", "0.0.5"), truncated: false, badApi: false, chain: false, changedTree: false, freshFailure: false, freshAttempt: false, runReads: new Map<string, number>(), gitReads: [] as string[]};
  const github: CiGithub = {rest: {actions: {
    getWorkflow: async () => ({data: {id: 42}}),
    listWorkflowRuns: async args => {
      const sha = String(args.head_sha), count = (state.runReads.get(sha) ?? 0) + 1;state.runReads.set(sha, count);
      const values = runs.get(sha) ?? [];
      const fresh = state.freshFailure && sha === B && count > 1 ? [...values, {...run(21, B, "push", "main"), status: "in_progress", conclusion: null}] : values;
      return {data: {total_count: state.truncated ? 101 : fresh.length, workflow_runs: state.freshAttempt && count > 1 ? fresh.map(value => ({...value, run_attempt: 2})) : fresh}};
    },
    listJobsForWorkflowRun: async args => ({data: {total_count: jobs.get(Number(args.run_id))?.length ?? 0, jobs: jobs.get(Number(args.run_id)) ?? []}}),
  }, repos: {
    getBranch: async () => ({data: {commit: {sha: M}}}),
    compareCommitsWithBasehead: async () => ({data: state.badApi ? {} : {status: "ahead", merge_base_commit: {sha: B}}}),
    listPullRequestsAssociatedWithCommit: async args => ({data: [args.commit_sha === B ? pr(B, S, state.chain ? "changeset-release/main" : "feature") : pr(M, H, "changeset-release/main")]}),
  }}};
  const git = (args: readonly string[]) => Effect.try(() => {
    state.gitReads.push(args.join(" "));
    if (args[0] === "fetch") return "";
    if (args[0] === "rev-list") return `${H} ${B}\n`;
    if (args[0] === "diff") return state.raw;
    if (args[0] === "show") return args[1] === `${B}:scripts/ci-proof.ts` ? readFileSync(new URL("../scripts/ci-proof.ts", import.meta.url), "utf8") : args[1] === `${B}:package.json` ? manifest : state.headPackage;
    if (args[0] === "rev-parse") return ([`${B}^{tree}`, `${S}^{tree}`].includes(args[1]!) ? T : state.changedTree && args[1] === `${M}^{tree}` ? T : U) + "\n";
    throw new Error("unexpected git operation");
  });
  return {github, context, git, state, runs, jobs, loadPolicy: () => Effect.succeed(policy)};
};

it.effect("release proof follows a lightweight baseline only to its directly checked full PR, while new-version static checks remain required", () => Effect.gen(function*() {
  const f = fixture();
  assert.deepEqual(yield* planCi(f), {mode: "release", baselineRunId: 10, from: "0.0.4", to: "0.0.5"});
  f.jobs.set(20, full(20));
  assert.equal((yield* planCi(f)).baselineRunId, 20);
}));

it.effect("ordinary PRs, forks and default manual dispatches remain full; only automatic version dispatch may fast-track", () => Effect.gen(function*() {
  for (const input of [
    {...fixture(), context: {...fixture().context, payload: {pull_request: pr(null, H, "feature")}}},
    {...fixture(), context: {...fixture().context, payload: {pull_request: {...pr(null, H, "changeset-release/main"), head: {...pr(null, H, "changeset-release/main").head, repo: {full_name: "fork/repo"}}}}}},
    {...fixture(), context: {...fixture().context, eventName: "workflow_dispatch", ref: "refs/heads/changeset-release/main", payload: {}}},
  ]) assert.deepEqual(yield* planCi(input), {mode: "full"});
  const f = fixture();
  assert.equal((yield* planCi({...f, context: {...f.context, eventName: "workflow_dispatch", ref: "refs/heads/changeset-release/main", payload: {}}, validation: "auto"})).mode, "release");
}));

it.effect("source changes, bad manifest inputs, incomplete API responses, reruns and stale evidence select full", () => Effect.gen(function*() {
  for (const change of ["source", "manifest", "truncated", "badApi", "freshFailure", "freshAttempt", "baselineRed", "sourcePending", "sourceFork", "missingJobs", "chain"] as const) {
    const f = fixture();
    if (change === "source") f.state.raw += rawChange("src/main.ts");
    if (change === "manifest") f.state.headPackage = f.state.headPackage.replace('"name"', '"scripts": {},\n  "name"');
    if (change === "truncated" || change === "badApi" || change === "freshFailure" || change === "freshAttempt") f.state[change] = true;
    if (change === "baselineRed") f.runs.set(B, [{...run(20, B, "push", "main"), conclusion: "failure"}]);
    if (change === "sourcePending") {f.runs.set(S, [run(10, S, "pull_request", "feature"), {...run(11, S, "pull_request", "feature"), status: "in_progress", conclusion: null}]);f.jobs.set(11, full(11));}
    if (change === "sourceFork") f.runs.set(S, [{...run(10, S, "pull_request", "feature"), head_repository: null}]);
    if (change === "missingJobs") f.jobs.set(10, full(10).slice(1));
    if (change === "chain") {f.state.chain = true;f.runs.set(S, [run(10, S, "workflow_dispatch", "changeset-release/main")]);f.jobs.set(10, release(10));}
    assert.deepEqual(yield* planCi(f), {mode: "full"}, change);
  }
}));

// a baseline policy from before a newly required job: it proves the same jobs but never asks for that one
const olderPolicyWithout = (required: string) => {
  const withoutRequirement = (input: {jobs: ReadonlyArray<{name: string; run_id: number; conclusion: string | null}>}) =>
    ({...input, jobs: input.jobs.some(job => job.name === required) ? input.jobs : [...input.jobs, {name: required, run_id: input.jobs[0]?.run_id ?? 1, conclusion: "success"}]});
  return {...policy,
    proveMergedValidation: (input: unknown) => policy.proveMergedValidation(withoutRequirement(input as Parameters<typeof withoutRequirement>[0])),
    provePushValidation: (input: unknown) => policy.provePushValidation(withoutRequirement(input as Parameters<typeof withoutRequirement>[0]))};
};

it.effect("evidence from before the native ARM64 job or the browser journeys never counts as a full release baseline, also under the baseline's own older policy", () => Effect.gen(function*() {
  for (const required of ["arm64", "browser"]) {
    const olderPolicy = olderPolicyWithout(required);
    const without = (id: number) => full(id).filter(job => job.name !== required);
    // through the baseline's directly checked PR
    const viaPr = fixture();
    viaPr.jobs.set(10, without(10));
    assert.deepEqual(yield* planCi({...viaPr, loadPolicy: () => Effect.succeed(olderPolicy)}), {mode: "full"}, required);
    // through the baseline's own full push run
    const viaPush = fixture();
    viaPush.jobs.set(20, without(20));
    assert.deepEqual(yield* planCi({...viaPush, loadPolicy: () => Effect.succeed(olderPolicy)}), {mode: "full"}, required);
    // the same evidence with that job still qualifies under that older policy
    const complete = fixture();
    complete.jobs.set(20, full(20));
    assert.equal((yield* planCi({...complete, loadPolicy: () => Effect.succeed(olderPolicy)})).baselineRunId, 20, required);
    // and a full PR proof for main never reuses a run without it
    const merged = fixture();
    merged.jobs.set(30, without(30));
    assert.deepEqual(yield* planCi({...merged, context: {...merged.context, eventName: "push", sha: M, ref: "refs/heads/main", payload: {}}}), {mode: "full"}, required);
  }
}));

it.effect("missing baseline policy never lets the implementing PR approve its own shortcut", () => Effect.gen(function*() {
  const f = fixture();
  assert.deepEqual(yield* planCi({...f, loadPolicy: () => Effect.fail(new Error("old policy has no release proof"))}), {mode: "full"});
  assert.deepEqual(yield* planCi({...f, context: {eventName: "pull_request"}}), {mode: "full"});
}));

it.effect("main independently rederives a fast release and baseline, while ordinary full PR reuse remains valid", () => Effect.gen(function*() {
  const f = fixture(), context = {...f.context, eventName: "push", sha: M, ref: "refs/heads/main", payload: {}};
  assert.deepEqual(yield* planCi({...f, context}), {mode: "reuse", runId: 30, baselineRunId: 10});
  f.jobs.set(30, full(30));
  assert.deepEqual(yield* planCi({...f, context}), {mode: "reuse", runId: 30});
  f.jobs.set(30, release(30));f.state.raw += rawChange("scripts/ci-proof.ts");
  assert.deepEqual(yield* planCi({...f, context}), {mode: "full"});
}));

it.effect("main rejects a different merged tree or an unsuccessful latest release validation", () => Effect.gen(function*() {
  for (const kind of ["tree", "run", "static"] as const) {
    const f = fixture();
    if (kind === "tree") f.state.changedTree = true;
    if (kind === "run") f.runs.set(H, [{...run(30, H, "workflow_dispatch", "changeset-release/main"), conclusion: "cancelled"}]);
    if (kind === "static") f.jobs.set(30, release(30).filter(job => job.name !== "static"));
    assert.deepEqual(yield* planCi({...f, context: {...f.context, eventName: "push", sha: M, ref: "refs/heads/main", payload: {}}}), {mode: "full"});
  }
}));

const workflow = parse(readFileSync(new URL("../.github/workflows/check.yml", import.meta.url), "utf8"));
it.live("loads the baseline TypeScript policy through the real scoped adapter and removes its temporary directory", () => Effect.gen(function*() {
  const before = readdirSync(process.cwd()).filter(name => name.startsWith(".ci-base-"));
  const f = fixture();
  const input = {github: f.github, context: f.context, git: f.git};
  assert.equal((yield* planCi(input)).mode, "release");
  f.state.raw += rawChange("scripts/ci-proof.ts");
  assert.deepEqual(yield* planCi(input), {mode: "full"});
  assert.deepEqual(readdirSync(process.cwd()).filter(name => name.startsWith(".ci-base-")), before);
}));

it.effect("the actual scope adapter preserves default full dispatch and selects only same-repository release metadata candidates", () => Effect.gen(function*() {
  const script = workflow.jobs.plan.steps[0].with.script as string;
  for (const [eventName, ref, validation, pull, expected] of [
    ["workflow_dispatch", "refs/heads/changeset-release/main", "full", undefined, "false"],
    ["workflow_dispatch", "refs/heads/changeset-release/main", "auto", undefined, "true"],
    ["workflow_dispatch", "refs/heads/feature", "auto", undefined, "false"],
    ["pull_request", "refs/pull/21/merge", "full", pr(null, H, "changeset-release/main"), "true"],
    ["pull_request", "refs/pull/21/merge", "full", pr(null, H, "feature"), "false"],
    ["push", "refs/heads/main", "full", undefined, "true"],
  ] as const) {
    const outputs: Record<string, string> = {};
    yield* Effect.tryPromise(() => runInNewContext(`(async()=>{${script}})()`, {context: {eventName, ref, repo: {owner: "jfet97", repo: "t3-supervisor"}, payload: {pull_request: pull}}, process: {env: {VALIDATION: validation}}, core: {setOutput: (key: string, value: string) => {outputs[key] = value;}}}));
    assert.equal(outputs.needed, expected);
  }
  assert.equal(workflow.on.workflow_dispatch.inputs.validation.default, "full");
}));

it.live("the actual aggregate shell rejects missing proof, a skipped or failed static or native ARM64 check, failed suites or browser journeys, a skipped or failed startup and unknown modes", () => Effect.sync(() => {
  const script = workflow.jobs.check.steps[0].run as string;
  for (const [mode, plan, stat, arm64, main, harness, startup, browser, succeeds] of [
    ["full", "success", "success", "success", "success", "success", "success", "success", true],
    ["release", "success", "success", "success", "skipped", "skipped", "success", "skipped", true],
    ["reuse", "success", "skipped", "skipped", "skipped", "skipped", "success", "skipped", true],
    ["release", "success", "skipped", "success", "skipped", "skipped", "success", "skipped", false],
    ["release", "success", "success", "success", "failure", "skipped", "success", "skipped", false],
    ["reuse", "failure", "skipped", "skipped", "skipped", "skipped", "success", "skipped", false],
    ["full", "success", "success", "success", "skipped", "success", "success", "success", false],
    ["", "success", "success", "success", "success", "success", "success", "success", false],
    ["full", "success", "success", "success", "success", "success", "skipped", "success", false],
    ["full", "success", "success", "success", "success", "success", "failure", "success", false],
    ["reuse", "success", "skipped", "skipped", "skipped", "skipped", "skipped", "skipped", false],
    ["reuse", "success", "skipped", "skipped", "skipped", "skipped", "failure", "skipped", false],
    ["release", "success", "success", "success", "skipped", "skipped", "skipped", "skipped", false],
    ["release", "success", "success", "success", "skipped", "skipped", "failure", "skipped", false],
    ["full", "success", "success", "skipped", "success", "success", "success", "success", false],
    ["full", "success", "success", "failure", "success", "success", "success", "success", false],
    ["full", "success", "success", "cancelled", "success", "success", "success", "success", false],
    ["release", "success", "success", "skipped", "skipped", "skipped", "success", "skipped", false],
    ["release", "success", "success", "failure", "skipped", "skipped", "success", "skipped", false],
    ["reuse", "success", "skipped", "success", "skipped", "skipped", "success", "skipped", false],
    // the browser journeys are a full job: required in full validation, skipped exactly where the suites are
    ["full", "success", "success", "success", "success", "success", "success", "skipped", false],
    ["full", "success", "success", "success", "success", "success", "success", "failure", false],
    ["full", "success", "success", "success", "success", "success", "success", "cancelled", false],
    ["full", "success", "success", "success", "success", "success", "success", "", false],
    ["release", "success", "success", "success", "skipped", "skipped", "success", "success", false],
    ["release", "success", "success", "success", "skipped", "skipped", "success", "failure", false],
    ["reuse", "success", "skipped", "skipped", "skipped", "skipped", "success", "success", false],
  ] as const) {
    const result = spawnSync("bash", ["-e", "-c", script], {env: {PATH: process.env.PATH, MODE: mode, PLAN_RESULT: plan, STATIC_RESULT: stat, ARM64_RESULT: arm64,
      MAIN_RESULT: main, HARNESS_RESULT: harness, STARTUP_RESULT: startup, BROWSER_RESULT: browser}});
    assert.equal(result.status === 0, succeeds, JSON.stringify({mode, plan, stat, arm64, main, harness, startup, browser}));
  }
  // the browser journeys run through the contributors' own entry and are selected exactly where the suites are
  assert.equal(workflow.jobs.browser.if, workflow.jobs.harness.if);
  assert.ok((workflow.jobs.check.needs as Array<string>).includes("browser"));
}));

it.live("the browser job runs the journeys once unless a manual calibration asks for up to twenty runs without retries", () => Effect.sync(() => {
  const step = (workflow.jobs.browser.steps as Array<{name?: string; run?: string; env?: Record<string, string>}>).find((candidate) => candidate.name === "Run the browser journeys");
  assert.ok(step?.run && step.env);
  // only a dispatch supplies a count, kept as the text it was so a 0 reaches the check below instead of falling back to 1
  assert.equal(step.env.REPETITIONS, "${{ github.event_name == 'workflow_dispatch' && format('{0}', inputs.browser_repetitions) || 1 }}");
  assert.equal(workflow.on.workflow_dispatch.inputs.browser_repetitions.default, 1);
  const bin = mkdtempSync(join(tmpdir(), "t3sup-browser-runs-"));
  try {
    // a stand-in ./dev that records each call and fails on the call FAIL_AT names
    writeFileSync(join(bin, "dev"), "#!/bin/sh\necho call >> \"$CALLS\"\n[ \"$(wc -l < \"$CALLS\")\" -ne \"${FAIL_AT:-0}\" ]\n");
    chmodSync(join(bin, "dev"), 0o755);
    const run = (repetitions: string, failAt = "0") => {
      const calls = join(bin, `calls-${repetitions}-${failAt}`);
      writeFileSync(calls, "");
      const result = spawnSync("bash", ["-c", step.run!.replaceAll("./dev e2e", `${join(bin, "dev")} e2e`)], {encoding: "utf8",
        env: {PATH: process.env.PATH, REPETITIONS: repetitions, FAIL_AT: failAt, CALLS: calls, GITHUB_STEP_SUMMARY: join(bin, "summary")}});
      return {ok: result.status === 0, calls: readFileSync(calls, "utf8").split("\n").filter(Boolean).length};
    };
    assert.deepEqual(run("1"), {ok: true, calls: 1});
    assert.deepEqual(run("10"), {ok: true, calls: 10});
    // the first failing run ends the calibration: nothing is retried and no later run starts
    assert.deepEqual(run("10", "3"), {ok: false, calls: 3});
    for (const invalid of ["0", "21", "", "2x"]) assert.deepEqual(run(invalid), {ok: false, calls: 0}, invalid);
  } finally {
    rmSync(bin, {recursive: true, force: true});
  }
}));
