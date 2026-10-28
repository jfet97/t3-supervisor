import { Schema } from "effect";
import { isDeepStrictEqual } from "node:util";

const Sha = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/u));
const Name = Schema.Struct({ full_name: Schema.String });
const Id = Schema.Number.check(Schema.makeFilter((value) => Number.isSafeInteger(value) && value > 0));
export const CiRun = Schema.Struct({
  id: Id,
  workflow_id: Id,
  head_sha: Sha,
  head_branch: Schema.NullOr(Schema.String),
  head_repository: Schema.NullOr(Name),
  repository: Name,
  event: Schema.String,
  status: Schema.String,
  conclusion: Schema.NullOr(Schema.String),
  run_attempt: Schema.optionalKey(Id),
});
export const decodeCiRuns = Schema.decodeUnknownSync(Schema.Array(CiRun));
export const MergeProof = Schema.Struct({
  expected: Schema.Struct({ repository: Schema.String, workflowId: Id, head: Sha, branch: Schema.String, tree: Sha }),
  headTree: Sha,
  runs: Schema.Array(CiRun),
  jobs: Schema.Array(Schema.Struct({ name: Schema.String, run_id: Id, conclusion: Schema.NullOr(Schema.String) })),
});

// these are the full jobs in check.yml; a lightweight main run can never supply this proof
export const requiredFullJobs = ["static", "main (1/4)", "main (2/4)", "main (3/4)", "main (4/4)", "harness", "startup", "check"] as const;

export const newestPrRun = (runs: ReadonlyArray<typeof CiRun.Type>, expected: typeof MergeProof.Type.expected) =>
  runs.filter((run) => run.workflow_id === expected.workflowId && run.head_sha === expected.head &&
    run.repository.full_name === expected.repository && run.head_repository?.full_name === expected.repository &&
    (run.event === "pull_request" || (run.event === "workflow_dispatch" && run.head_branch === expected.branch)))
    .sort((left, right) => right.id - left.id)[0];

export const proveMergedValidation = (input: unknown): { readonly runId: number; readonly tree: string } => {
  const { expected, headTree, runs, jobs } = Schema.decodeUnknownSync(MergeProof)(input);
  if (headTree !== expected.tree) throw new Error("merged files differ from the checked PR head");
  const run = newestPrRun(runs, expected);
  if (!run || run.status !== "completed" || run.conclusion !== "success") throw new Error("latest PR validation is not successful");
  for (const name of requiredFullJobs) {
    const matches = jobs.filter((job) => job.name === name);
    if (matches.length !== 1 || matches[0]!.run_id !== run.id || matches[0]!.conclusion !== "success") {
      throw new Error("full validation job is missing or unsuccessful");
    }
  }
  return { runId: run.id, tree: headTree };
};

const StableVersion = Schema.String.check(Schema.isPattern(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u));
const Package = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown));
const ReleaseChange = Schema.Struct({
  parents: Schema.Array(Sha),
  changes: Schema.Array(Schema.Struct({status: Schema.String, path: Schema.String, oldMode: Schema.String, newMode: Schema.String})),
  basePackage: Schema.String,
  headPackage: Schema.String,
});

/** Only the exact generated version line, changelog and consumed note deletions may differ. */
export const releaseOnlyChange = (input: unknown): {readonly baseline: string; readonly from: string; readonly to: string} => {
  const {parents, changes, basePackage, headPackage} = Schema.decodeUnknownSync(ReleaseChange)(input);
  if (parents.length !== 1) throw new Error("release head must have one parent");
  const seen = new Set<string>();
  let notes = 0;
  for (const change of changes) {
    if (seen.has(change.path)) throw new Error("duplicate changed path");
    seen.add(change.path);
    if (change.path === "package.json" && change.status === "M" && change.oldMode === "100644" && change.newMode === "100644") continue;
    if (change.path === "CHANGELOG.md" && ["A", "M"].includes(change.status) && change.newMode === "100644" && change.oldMode === (change.status === "A" ? "000000" : "100644")) continue;
    if (/^\.changeset\/[^/.][^/]*\.md$/u.test(change.path) && change.path.toLowerCase() !== ".changeset/readme.md" && change.status === "D" && change.oldMode === "100644" && change.newMode === "000000") {notes++;continue;}
    throw new Error("change is not release metadata");
  }
  if (!seen.has("package.json") || !seen.has("CHANGELOG.md") || notes === 0) throw new Error("release metadata is incomplete");
  const before = basePackage.split("\n");
  const after = headPackage.split("\n");
  const differing = before.map((line, index) => line === after[index] ? -1 : index).filter(index => index >= 0);
  const versionLine = /^(\s*)"version": "((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))"(,?)$/u;
  const index = differing[0];
  const oldLine = index === undefined ? null : versionLine.exec(before[index]!);
  const newLine = index === undefined ? null : versionLine.exec(after[index] ?? "");
  if (before.length !== after.length || differing.length !== 1 || !oldLine || !newLine || oldLine[1] !== newLine[1] || oldLine[3] !== newLine[3] ||
    before.filter(line => versionLine.test(line)).length !== 1 || after.filter(line => versionLine.test(line)).length !== 1) throw new Error("manifest differs beyond its version line");
  const {version: from, ...base} = Schema.decodeUnknownSync(Package)(basePackage);
  const {version: to, ...head} = Schema.decodeUnknownSync(Package)(headPackage);
  Schema.decodeUnknownSync(StableVersion)(from);
  Schema.decodeUnknownSync(StableVersion)(to);
  if (typeof from !== "string" || typeof to !== "string" || base.name !== "@jfet97/t3-supervisor" || !isDeepStrictEqual(base, head)) throw new Error("manifest fields differ");
  const left = from.split(".").map(BigInt), right = to.split(".").map(BigInt);
  const first = right.findIndex((value, position) => value !== left[position]);
  if (first < 0 || right[first]! <= left[first]!) throw new Error("release version must increase");
  return {baseline: parents[0]!, from, to};
};

const PushProof = Schema.Struct({
  expected: Schema.Struct({repository: Schema.String, workflowId: Id, commit: Sha}),
  runs: Schema.Array(CiRun), jobs: MergeProof.fields.jobs,
});

export const newestPushRun = (runs: ReadonlyArray<typeof CiRun.Type>, expected: typeof PushProof.Type.expected) =>
  runs.filter(run => run.workflow_id === expected.workflowId && run.head_sha === expected.commit && run.head_branch === "main" && run.event === "push" &&
    run.repository.full_name === expected.repository && run.head_repository?.full_name === expected.repository).sort((a, b) => b.id - a.id)[0];

/** A push that merely reused another verdict cannot prove the release baseline. */
export const provePushValidation = (input: unknown): {readonly runId: number} => {
  const {expected, runs, jobs} = Schema.decodeUnknownSync(PushProof)(input);
  const run = newestPushRun(runs, expected);
  if (!run || run.status !== "completed" || run.conclusion !== "success") throw new Error("latest baseline push is not successful");
  for (const name of requiredFullJobs) {
    const matches = jobs.filter(job => job.name === name);
    if (matches.length !== 1 || matches[0]!.run_id !== run.id || matches[0]!.conclusion !== "success") throw new Error("baseline full job is missing or unsuccessful");
  }
  return {runId: run.id};
};

/** Main rechecks the release diff and baseline separately; this proves only that version's static validation. */
export const proveReleaseRun = (input: unknown): {readonly runId: number; readonly tree: string} => {
  const {expected, headTree, runs, jobs} = Schema.decodeUnknownSync(MergeProof)(input);
  if (new Set(jobs.map(job => job.name)).size !== jobs.length) throw new Error("duplicate release job");
  if (headTree !== expected.tree) throw new Error("merged files differ from the checked release head");
  const run = newestPrRun(runs, expected);
  if (!run || run.status !== "completed" || run.conclusion !== "success") throw new Error("latest release validation is not successful");
  const releaseJobs = ["plan", "static", "startup", "check"];
  for (const name of releaseJobs) {
    const matches = jobs.filter(job => job.name === name);
    if (matches.length !== 1 || matches[0]!.run_id !== run.id || matches[0]!.conclusion !== "success") throw new Error("release validation job is missing or unsuccessful");
  }
  if (jobs.filter(job => job.name === "harness" && job.conclusion === "skipped").length !== 1 || !jobs.some(job => job.name.startsWith("main (") && job.conclusion === "skipped")) throw new Error("skipped release suites are missing");
  if (jobs.some(job => job.run_id !== run.id || !releaseJobs.includes(job.name) && job.conclusion !== "skipped")) throw new Error("release validation contains an unexpected job");
  return {runId: run.id, tree: headTree};
};
