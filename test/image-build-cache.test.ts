import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "@effect/vitest";
import { parse } from "yaml";

// the layer cache only speeds up image builds: one writer per scope, and a failed export never fails or cancels a build or push
type Step = { uses?: string; with?: Record<string, unknown> };
type Workflow = { jobs: Record<string, { steps: Step[] }> };

const attributes = (value: unknown): Record<string, string> | undefined => typeof value !== "string" ? undefined
  : Object.fromEntries(value.split(",").map(part => [part.slice(0, part.indexOf("=")).trim(), part.slice(part.indexOf("=") + 1).trim()]));

const builds = ["check.yml", "release.yml"].flatMap(file => {
  const workflow = parse(readFileSync(new URL(`../.github/workflows/${file}`, import.meta.url), "utf8")) as Workflow;
  return Object.values(workflow.jobs).flatMap(({ steps }) => steps
    .filter(step => step.uses?.startsWith("docker/build-push-action@"))
    .map(step => ({ file, step, from: attributes(step.with?.["cache-from"]), to: attributes(step.with?.["cache-to"]) })));
});

it("gives every image cache scope exactly one writer whose failed export is ignored", () => {
  const writers: string[] = [];
  for (const { from, to } of builds) {
    assert.ok(from);
    assert.equal(from.type, "gha");
    if (to === undefined) continue;
    const { type, scope, "ignore-error": ignoreError } = to;
    assert.ok(scope);
    assert.deepEqual({ type, scope, ignoreError }, { type: "gha", scope: from.scope, ignoreError: "true" });
    writers.push(scope);
  }
  assert.deepEqual(writers.sort(), ["ci-image", "ci-image-arm64", "release-image"]);
});

it("lets the published release build own the cache that the local smoke build only reads", () => {
  const release = builds.filter(build => build.file === "release.yml");
  const pushed = release.find(build => build.step.with?.push === true);
  const smoke = release.find(build => build.step.with?.load === true);
  assert.ok(pushed?.to && smoke?.from);
  assert.equal(pushed.to.scope, "release-image");
  assert.equal(smoke.to, undefined);
  assert.equal(smoke.from.scope, pushed.to.scope);
});
