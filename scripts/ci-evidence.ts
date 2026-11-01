import {Effect, Schema, type Scope} from "effect";
import {execFileSync} from "node:child_process";
import {mkdtempSync, writeFileSync, rmSync} from "node:fs";
import {join} from "node:path";
import {pathToFileURL} from "node:url";
import {tsImport} from "tsx/esm/api";
import * as currentPolicy from "./ci-proof.js";

const Sha = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/u));
const Count = Schema.Number.check(Schema.makeFilter(value => Number.isSafeInteger(value) && value >= 0));
const Id = Schema.Number.check(Schema.makeFilter(value => Number.isSafeInteger(value) && value > 0));
const Repository = Schema.Struct({full_name: Schema.String});
const PullRequest = Schema.Struct({
  merged_at: Schema.NullOr(Schema.String), merge_commit_sha: Schema.NullOr(Sha),
  base: Schema.Struct({ref: Schema.String}),
  head: Schema.Struct({sha: Sha, ref: Schema.String, repo: Schema.NullOr(Repository)}),
});
const Context = Schema.Struct({
  eventName: Schema.String, sha: Sha, ref: Schema.String,
  repo: Schema.Struct({owner: Schema.String, repo: Schema.String}),
  payload: Schema.Struct({pull_request: Schema.optionalKey(PullRequest)}),
});
const Runs = Schema.Struct({total_count: Count, workflow_runs: Schema.Array(Schema.Struct({...currentPolicy.CiRun.fields, run_attempt: Id}))});
const Jobs = Schema.Struct({total_count: Count, jobs: Schema.Array(Schema.Struct({name: Schema.String, run_id: Id, conclusion: Schema.NullOr(Schema.String)}))});
type Call = (parameters: Record<string, unknown>) => Promise<{data: unknown}>;
export interface CiGithub {
  readonly rest: {
    readonly actions: {readonly getWorkflow: Call; readonly listWorkflowRuns: Call; readonly listJobsForWorkflowRun: Call};
    readonly repos: {readonly listPullRequestsAssociatedWithCommit: Call; readonly getBranch: Call; readonly compareCommitsWithBasehead: Call};
  };
}
type Policy = typeof currentPolicy;
export interface CiEvidenceOptions {
  readonly github: CiGithub;
  readonly context: unknown;
  readonly validation?: string;
  readonly git?: (arguments_: readonly string[]) => Effect.Effect<string, unknown>;
  readonly loadPolicy?: (baseline: string) => Effect.Effect<Policy, unknown, Scope.Scope>;
}
export type CiPlan = {readonly mode: "full" | "reuse" | "release"; readonly runId?: number; readonly baselineRunId?: number; readonly from?: string; readonly to?: string};

// git and github are bounded foreign adapters; policy decisions remain synchronous and Schema-checked
const gitCommand = (args: readonly string[]) => Effect.try(() => execFileSync("git", [...args], {encoding: "utf8", maxBuffer: 8 * 1024 * 1024}));
const decode = <A>(schema: Schema.ConstraintDecoder<A>, value: unknown) => Effect.try(() => Schema.decodeUnknownSync(schema)(value));
const refuse = (message: string) => Effect.fail(new Error(message));

/** Parse the complete NUL-delimited local diff, including modes and without rename inference. */
export const parseRawChanges = (raw: string) => {
  if (!raw) return [];
  const parts = raw.split("\0");
  if (parts.pop() !== "" || parts.length % 2 !== 0) throw new Error("invalid raw diff");
  const changes: Array<{status: string; path: string; oldMode: string; newMode: string}> = [];
  for (let index = 0; index < parts.length; index += 2) {
    const match = /^:(\d{6}) (\d{6}) [a-f0-9]{40} [a-f0-9]{40} ([A-Z])$/u.exec(parts[index]!);
    if (!match || !parts[index + 1]) throw new Error("invalid raw change");
    changes.push({oldMode: match[1]!, newMode: match[2]!, status: match[3]!, path: parts[index + 1]!});
  }
  return changes;
};

// load the baseline policy from an ephemeral workspace child so Effect resolves through this checkout's pinned install
const baselinePolicy = (git: NonNullable<CiEvidenceOptions["git"]>, baseline: string) => Effect.gen(function* () {
  const source = yield* git(["show", `${baseline}:scripts/ci-proof.ts`]);
  const directory = yield* Effect.acquireRelease(Effect.try(() => mkdtempSync(join(process.cwd(), ".ci-base-"))), path => Effect.sync(() => rmSync(path, {recursive: true, force: true})));
  const file = join(directory, "ci-proof.ts");
  yield* Effect.try(() => writeFileSync(file, source));
  const policy = yield* Effect.tryPromise(() => tsImport(pathToFileURL(file).href, import.meta.url));
  for (const name of ["releaseOnlyChange", "newestPushRun", "provePushValidation", "newestPrRun", "proveMergedValidation", "proveReleaseRun"] as const) {
    if (typeof policy[name] !== "function") return yield* refuse("baseline has no release proof policy");
  }
  return policy as Policy;
});

/** Derive a verdict from exact Git objects and current API evidence; every uncertainty selects full validation. */
export const planCi = (options: CiEvidenceOptions): Effect.Effect<CiPlan> => Effect.scoped(Effect.gen(function* () {
  const context = yield* decode(Context, options.context);
  const {github} = options;
  const git = options.git ?? gitCommand;
  const repo = context.repo, repository = `${repo.owner}/${repo.repo}`;
  const api = <A>(method: Call, parameters: Record<string, unknown>, schema: Schema.ConstraintDecoder<A>) =>
    Effect.flatMap(Effect.tryPromise(() => method({...repo, ...parameters})), result => decode(schema, result.data));
  const workflow = yield* api(github.rest.actions.getWorkflow, {workflow_id: "check.yml"}, Schema.Struct({id: Id}));
  const tree = (sha: string) => Effect.flatMap(git(["rev-parse", `${sha}^{tree}`]), value => decode(Sha, value.trim()));
  const fetch = (sha: string) => git(["fetch", "--no-tags", "--depth=2", "origin", sha]);
  const runsAt = (sha: string) => Effect.gen(function* () {
    const result = yield* api(github.rest.actions.listWorkflowRuns, {workflow_id: workflow.id, head_sha: sha, per_page: 100}, Runs);
    if (result.total_count !== result.workflow_runs.length) return yield* refuse("incomplete run listing");
    return result.workflow_runs;
  });
  const jobsOf = (runId: number) => Effect.gen(function* () {
    const first = yield* api(github.rest.actions.listJobsForWorkflowRun, {run_id: runId, filter: "latest", per_page: 100, page: 1}, Jobs);
    if (first.total_count > 200) return yield* refuse("job listing exceeds proof bound");
    const second = first.total_count > 100 ? yield* api(github.rest.actions.listJobsForWorkflowRun, {run_id: runId, filter: "latest", per_page: 100, page: 2}, Jobs) : null;
    const jobs = [...first.jobs, ...(second?.jobs ?? [])];
    if (first.total_count !== jobs.length || second && second.total_count !== first.total_count) return yield* refuse("incomplete job listing");
    return jobs;
  });
  const associated = (sha: string) => Effect.gen(function* () {
    const prs = yield* api(github.rest.repos.listPullRequestsAssociatedWithCommit, {commit_sha: sha, per_page: 100}, Schema.Array(PullRequest));
    if (prs.length >= 100) return yield* refuse("incomplete associated PR listing");
    const matching = prs.filter(pr => pr.merged_at && pr.merge_commit_sha === sha && pr.base.ref === "main" && pr.head.repo?.full_name === repository);
    if (matching.length !== 1) return yield* refuse("no unique matching merged PR");
    return matching[0]!;
  });
  // re-read the candidate run list after jobs so a newer run or rerun cannot hide behind an earlier green attempt
  const currentRun = (sha: string, selected: typeof currentPolicy.CiRun.Type) => Effect.gen(function* () {
    const runs = yield* runsAt(sha);
    const same = runs.find(run => run.id === selected.id);
    if (!same || same.status !== "completed" || same.conclusion !== "success" || same.run_attempt !== selected.run_attempt) return yield* refuse("validation attempt changed");
    return runs;
  });
  const fullPrProof = (commit: string, policy: Policy) => Effect.gen(function* () {
    const pr = yield* associated(commit);
    yield* fetch(pr.head.sha);
    const expected = {repository, workflowId: workflow.id, head: pr.head.sha, branch: pr.head.ref, tree: yield* tree(commit)};
    const headTree = yield* tree(pr.head.sha), runs = yield* runsAt(pr.head.sha);
    const run = policy.newestPrRun(runs, expected);
    if (!run) return yield* refuse("no matching PR validation");
    const jobs = yield* jobsOf(run.id);
    const fresh = yield* currentRun(pr.head.sha, run);
    const proof = yield* Effect.try(() => policy.proveMergedValidation({expected, headTree, runs: fresh, jobs}));
    return {...proof, jobs};
  });
  const releaseProof = (head: string) => Effect.gen(function* () {
    yield* fetch(head);
    const parentLine = (yield* git(["rev-list", "--parents", "-n", "1", head])).trim().split(" ");
    if (parentLine[0] !== head || parentLine.length !== 2) return yield* refuse("release head does not have one parent");
    const baseline = yield* decode(Sha, parentLine[1]);
    const main = yield* api(github.rest.repos.getBranch, {branch: "main"}, Schema.Struct({commit: Schema.Struct({sha: Sha})}));
    const comparison = yield* api(github.rest.repos.compareCommitsWithBasehead, {basehead: `${baseline}...${main.commit.sha}`}, Schema.Struct({status: Schema.String, merge_base_commit: Schema.Struct({sha: Sha})}));
    if (!["ahead", "identical"].includes(comparison.status) || comparison.merge_base_commit.sha !== baseline) return yield* refuse("release baseline is not on main");
    const policy = yield* (options.loadPolicy ? options.loadPolicy(baseline) : baselinePolicy(git, baseline));
    const changes = yield* Effect.flatMap(git(["diff", "--raw", "--no-abbrev", "--no-renames", "-z", baseline, head, "--"]), raw => Effect.try(() => parseRawChanges(raw)));
    const basePackage = yield* git(["show", `${baseline}:package.json`]), headPackage = yield* git(["show", `${head}:package.json`]);
    const release = yield* Effect.try(() => policy.releaseOnlyChange({parents: [baseline], changes, basePackage, headPackage}));
    const expected = {repository, workflowId: workflow.id, commit: baseline};
    const runs = yield* runsAt(baseline), run = policy.newestPushRun(runs, expected);
    if (!run || run.status !== "completed" || run.conclusion !== "success") return yield* refuse("baseline main validation is not green");
    const jobs = yield* jobsOf(run.id), fresh = yield* currentRun(baseline, run);
    const latest = policy.newestPushRun(fresh, expected);
    if (!latest || latest.id !== run.id || latest.status !== "completed" || latest.conclusion !== "success") return yield* refuse("baseline main validation changed");
    const direct = yield* Effect.result(Effect.try(() => policy.provePushValidation({expected, runs: fresh, jobs})));
    const proof = direct._tag === "Success" ? {...direct.success, jobs} : yield* fullPrProof(baseline, policy);
    // the baseline's own policy may predate a job the current policy requires, such as the native ARM64 check
    yield* Effect.try(() => currentPolicy.proveCurrentFullJobs({runId: proof.runId, jobs: proof.jobs}));
    return {...release, baselineRunId: proof.runId};
  });

  if (context.eventName === "push" && context.ref === "refs/heads/main") {
    const full = yield* Effect.result(fullPrProof(context.sha, currentPolicy));
    if (full._tag === "Success") return {mode: "reuse", runId: full.success.runId} as const;
    const pr = yield* associated(context.sha);
    if (pr.head.ref !== "changeset-release/main") return {mode: "full"} as const;
    yield* fetch(pr.head.sha);
    const expected = {repository, workflowId: workflow.id, head: pr.head.sha, branch: pr.head.ref, tree: yield* tree(context.sha)};
    const headTree = yield* tree(pr.head.sha), runs = yield* runsAt(pr.head.sha), run = currentPolicy.newestPrRun(runs, expected);
    if (!run) return yield* refuse("no release validation");
    const jobs = yield* jobsOf(run.id), fresh = yield* currentRun(pr.head.sha, run);
    const proof = yield* Effect.try(() => currentPolicy.proveReleaseRun({expected, headTree, runs: fresh, jobs}));
    const baseline = yield* releaseProof(pr.head.sha);
    return {mode: "reuse", runId: proof.runId, baselineRunId: baseline.baselineRunId} as const;
  }
  const pr = context.payload.pull_request;
  if (context.eventName === "pull_request") {
    if (!pr || pr.head.repo?.full_name !== repository || pr.base.ref !== "main" || pr.head.ref !== "changeset-release/main") return {mode: "full"} as const;
  } else if (context.eventName !== "workflow_dispatch" || options.validation !== "auto" || context.ref !== "refs/heads/changeset-release/main") return {mode: "full"} as const;
  const proof = yield* releaseProof(pr?.head.sha ?? context.sha);
  return {mode: "release", baselineRunId: proof.baselineRunId, from: proof.from, to: proof.to} as const;
})).pipe(Effect.catch(() => Effect.succeed({mode: "full"} as const)));

// the GitHub Actions callback is the foreign execution entry, not application business code
export const runCiPlan = (options: CiEvidenceOptions) => Effect.runPromise(planCi(options));
