import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { newestPrRun, proveMergedValidation, requiredFullJobs, upgradeGateJobs, versionBranch, versionGateJobs, type CiRun } from "../scripts/ci-proof.js";

const head = "a".repeat(40);
const tree = "b".repeat(40);
const repository = "jfet97/t3-supervisor";
const expected = { repository, workflowId: 42, head, branch: "feature", tree };
const run = (id = 10): typeof CiRun.Type => ({ id, workflow_id: 42, head_sha: head, head_branch: "feature",
  repository: { full_name: repository }, head_repository: { full_name: repository }, event: "pull_request", status: "completed", conclusion: "success" });
const proof = () => ({ expected, headTree: tree, runs: [run()], jobs: requiredFullJobs.map((name) => ({ name, run_id: 10, conclusion: "success" })) });

it("reuses an exact tree with every successful full job, including a version-PR dispatch", () => {
  assert.deepEqual(proveMergedValidation(proof()), { runId: 10, tree });
  const dispatch = { ...proof(), runs: [{ ...run(), event: "workflow_dispatch" }] };
  assert.equal(proveMergedValidation(dispatch).runId, 10);
});

it("rejects changed merged files even if an admin approved the merge", () => {
  assert.throws(() => proveMergedValidation({ ...proof(), headTree: "c".repeat(40) }), /files differ/u);
});

it.each(["failure", "cancelled", "skipped", "timed_out"])("rejects a %s full job", (conclusion) => {
  for (const name of requiredFullJobs) {
    const input = proof();
    input.jobs.find((job) => job.name === name)!.conclusion = conclusion;
    assert.throws(() => proveMergedValidation(input), /full validation/u);
  }
});

it("rejects missing and duplicate jobs", () => {
  const missing = proof(); missing.jobs.pop();
  assert.throws(() => proveMergedValidation(missing), /full validation/u);
  const duplicate = proof(); duplicate.jobs.push(duplicate.jobs[0]!);
  assert.throws(() => proveMergedValidation(duplicate), /full validation/u);
  const foreign = proof(); foreign.jobs[0]!.run_id = 99;
  assert.throws(() => proveMergedValidation(foreign), /full validation/u);
});

it("an earlier green run cannot replace a newer failed or unfinished run", () => {
  for (const latest of [{ ...run(11), conclusion: "failure" }, { ...run(11), status: "in_progress", conclusion: null }]) {
    const input = { ...proof(), runs: [run(10), latest] };
    assert.equal(newestPrRun(input.runs, expected)?.id, 11);
    assert.throws(() => proveMergedValidation(input), /latest PR/u);
  }
});

it("ignores runs for other heads, repositories, workflows and dispatch branches, and never chains main reuse", () => {
  for (const candidate of [
    { ...run(), head_sha: "c".repeat(40) }, { ...run(), workflow_id: 99 },
    { ...run(), repository: { full_name: "other/repo" } }, { ...run(), head_repository: { full_name: "fork/repo" } },
    { ...run(), event: "push" }, { ...run(), event: "workflow_dispatch", head_branch: "other" },
  ]) assert.throws(() => proveMergedValidation({ ...proof(), runs: [candidate] }), /latest PR/u);
});

it("rejects malformed proof rather than authorizing a skip", () => {
  assert.throws(() => proveMergedValidation({ ...proof(), headTree: "main" }));
  assert.throws(() => proveMergedValidation({ ...proof(), jobs: null }));
});

it("proves a version branch run only together with its whole passing gate, the published-T3 compatibility and the Supervisor upgrade journeys, which no other branch needs", () => {
  const version = { ...expected, branch: versionBranch };
  const gate = () => versionGateJobs.map((name) => ({ name, run_id: 10, conclusion: "success" as string | null }));
  assert.deepEqual(upgradeGateJobs.filter((name) => !versionGateJobs.includes(name)), []);
  assert.equal(proveMergedValidation(proof()).runId, 10);
  assert.throws(() => proveMergedValidation({ ...proof(), expected: version }), /full validation/u);
  assert.deepEqual(proveMergedValidation({ ...proof(), expected: version, jobs: [...proof().jobs, ...gate()] }), { runId: 10, tree });
  for (const name of versionGateJobs) {
    for (const conclusion of ["failure", "cancelled", "skipped", null]) {
      const jobs = [...proof().jobs, ...gate().map((job) => job.name === name ? { ...job, conclusion } : job)];
      assert.throws(() => proveMergedValidation({ ...proof(), expected: version, jobs }), /full validation/u, `${name} ${String(conclusion)}`);
    }
    assert.throws(() => proveMergedValidation({ ...proof(), expected: version, jobs: [...proof().jobs, ...gate().filter((job) => job.name !== name)] }), /full validation/u, name);
  }
});
