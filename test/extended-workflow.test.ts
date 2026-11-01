import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {it} from "@effect/vitest";
import {Effect} from "effect";
import {parse} from "yaml";

/* The extended runs (docs/testing.md, "Where tests run") are started by hand only: no event, schedule or other workflow starts
 * them, the check aggregate never waits for them, they hold no credentials and they run the contributors' own ./dev commands.
 */

type Step = {readonly run?: string; readonly uses?: string};
type Job = {readonly if?: string; readonly steps: ReadonlyArray<Step>};
const source = readFileSync(new URL("../.github/workflows/extended.yml", import.meta.url), "utf8");
const extended = parse(source) as {on: Record<string, unknown>; permissions: Record<string, string>; jobs: Record<string, Job>};
const check = parse(readFileSync(new URL("../.github/workflows/check.yml", import.meta.url), "utf8")) as {jobs: Record<string, {needs?: unknown}>};
const commands = (job: Job): string[] => job.steps.flatMap((step) => (step.run ?? "").split("\n").map((line) => line.trim()).filter((line) => line.startsWith("./dev")));

it.live("extended runs start only by a manual dispatch, read the repository only, hold no credentials and gate nothing", () => Effect.sync(() => {
  assert.deepEqual(Object.keys(extended.on), ["workflow_dispatch"]);
  assert.deepEqual(extended.permissions, {contents: "read"});
  assert.doesNotMatch(source, /\bsecrets\.|\bvars\.|GITHUB_TOKEN|schedule:/u);
  assert.deepEqual(Object.keys(extended.jobs).sort(), ["compatibility", "soaks"]);
  // the ordinary check never waits for an extended job, and no extended job is part of it
  for (const [name, job] of Object.entries(check.jobs)) {
    assert.equal(name in extended.jobs, false, name);
    for (const needed of [job.needs ?? []].flat()) assert.equal(String(needed) in extended.jobs, false, `${name} needs ${String(needed)}`);
  }
}));

it.live("each extended job runs the same ./dev commands a contributor runs, selected by the dispatch", () => Effect.sync(() => {
  assert.deepEqual(commands(extended.jobs.soaks!), ["./dev soak"]);
  assert.deepEqual(commands(extended.jobs.compatibility!), ["./dev setup", "./dev pnpm build", "./dev check"]);
  assert.equal(extended.jobs.soaks!.if, "${{ inputs.runs != 'compatibility' }}");
  assert.equal(extended.jobs.compatibility!.if, "${{ inputs.runs != 'soaks' }}");
}));
