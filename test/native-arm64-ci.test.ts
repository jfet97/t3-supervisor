import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "@effect/vitest";
import { parse } from "yaml";

/*
  ARM64 images are built and run on native ARM64 runners in both the PR check and the release, and AMD64 images on x64
  runners; no workflow emulates another architecture. The release assembles its immutable version only from variants that
  ran natively, and publishes nothing before that verification.
*/

type Step = { name?: string; id?: string; uses?: string; run?: string; if?: string; env?: Record<string, unknown>; with?: Record<string, unknown> };
type Job = { "runs-on": string; needs?: string | string[]; environment?: string; permissions?: Record<string, string>; outputs?: Record<string, string>; steps: Step[] };
const workflow = (file: string) => parse(readFileSync(new URL(`../.github/workflows/${file}`, import.meta.url), "utf8")) as { jobs: Record<string, Job> };
const check = workflow("check.yml");
const release = workflow("release.yml");
const arm64Runner = "ubuntu-24.04-arm";
const needs = (job: Job) => typeof job.needs === "string" ? [job.needs] : job.needs ?? [];
const stepIndex = (job: Job, predicate: (step: Step) => boolean) => {
  const index = job.steps.findIndex(predicate);
  assert.ok(index >= 0);
  return index;
};

it("no workflow emulates, and every image build targets one architecture on a runner of that architecture", () => {
  for (const [file, { jobs }] of [["check.yml", check], ["release.yml", release]] as const) {
    for (const [name, job] of Object.entries(jobs)) {
      for (const step of job.steps) {
        assert.ok(!step.uses?.startsWith("docker/setup-qemu-action"), `${file} ${name} sets up an emulator`);
        if (!step.uses?.startsWith("docker/build-push-action")) continue;
        const platform = step.with?.platforms ?? (job["runs-on"] === arm64Runner ? "linux/arm64" : "linux/amd64");
        assert.ok(platform === "linux/amd64" || platform === "linux/arm64", `${file} ${name} builds ${String(platform)}`);
        assert.equal(job["runs-on"] === arm64Runner, platform === "linux/arm64", `${file} ${name} builds ${platform} on ${job["runs-on"]}`);
      }
      // a job that runs an image runs the one architecture its runner has
      const smokes = job.steps.filter((step) => step.run?.includes("smoke-release.ts image"));
      for (const step of smokes) {
        const platform = String(step.env?.SMOKE_PLATFORM ?? (step.run?.match(/SMOKE_PLATFORM=(?:"?\$platform"?|(linux\/\w+))/u)?.[1] ?? ""));
        if (job["runs-on"] === arm64Runner) assert.ok(step.run!.includes("linux/arm64") || platform === "linux/arm64", `${file} ${name}`);
        else assert.ok(!(step.env?.SMOKE_PLATFORM === "linux/arm64"), `${file} ${name} runs ARM64 on ${job["runs-on"]}`);
      }
    }
  }
});

it("the PR check builds and runs the ARM64 artifact natively and requires it wherever the static checks run", () => {
  const { arm64, static: staticJob, check: aggregate } = check.jobs;
  assert.ok(arm64 && staticJob && aggregate);
  assert.equal(arm64["runs-on"], arm64Runner);
  assert.equal(arm64.steps[0]!.run, 'test "$(uname -m)" = aarch64');
  assert.ok(arm64.steps.some((step) => step.env?.SMOKE_PLATFORM === "linux/arm64" && step.run?.includes("smoke-release.ts image t3-supervisor:ci-check-arm64")));
  assert.ok(!staticJob.steps.some((step) => step.with?.platforms === "linux/arm64"));
  assert.ok(needs(aggregate).includes("arm64"));
  assert.match(String(aggregate.steps[0]!.env?.ARM64_RESULT), /needs\.arm64\.result/u);
});

it("the release verifies the ARM64 variant natively, assembles only verified variants and publishes nothing before", () => {
  const { arm64, release: publish } = release.jobs;
  assert.ok(arm64 && publish);
  assert.equal(arm64["runs-on"], arm64Runner);
  assert.equal(arm64.environment, "release");
  assert.deepEqual(arm64.permissions, { contents: "read", packages: "write" });
  assert.deepEqual(Object.keys(arm64.outputs ?? {}).sort(), ["pushed", "variant"]);
  assert.equal(arm64.steps[0]!.run, 'test "$(uname -m)" = aarch64');
  // the pre-write gate before the ARM64 push is test/release-arm64-gate.test.ts
  const pushed = stepIndex(arm64, (step) => step.id === "pushed");
  const verified = stepIndex(arm64, (step) => step.id === "verify");
  assert.ok(pushed < verified);
  assert.match(String(arm64.steps[verified]!.run), /docker pull --platform linux\/arm64/u);
  assert.match(String(arm64.steps[verified]!.run), /SMOKE_PLATFORM=linux\/arm64 node --import tsx scripts\/smoke-release.ts image/u);

  assert.ok(needs(publish).includes("arm64"));
  assert.equal(publish["runs-on"], "ubuntu-latest");
  const assemble = stepIndex(publish, (step) => step.name === "Assemble the immutable version from both pushed variants");
  const verify = stepIndex(publish, (step) => step.name === "Verify both published image variants by immutable digest");
  assert.match(String(publish.steps[assemble]!.env?.ARM64), /needs\.arm64\.outputs\.pushed/u);
  assert.match(String(publish.steps[verify]!.env?.ARM64_VARIANT), /needs\.arm64\.outputs\.variant/u);
  assert.match(String(publish.steps[verify]!.run), /test "\$variant" = "\$ARM64_VARIANT"/u);
  // npm, the moving channel tag and the GitHub receipt all wait for both variants
  for (const name of ["Publish the immutable package with provenance", "Verify the package channel and advance only the selected image channel",
    "Publish release notes and immutable artifacts"]) assert.ok(stepIndex(publish, (step) => step.name === name) > verify, name);
  assert.ok(assemble < verify);
});
