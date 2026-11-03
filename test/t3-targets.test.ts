import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Effect, FileSystem, Option, Redacted } from "effect";
import { FetchHttpClient } from "effect/http";
import { archiveName } from "../scripts/local-stack.js";
import { decodeTargetLock, downloadBase, readTargetLock, resolveTargets, selectTargets, targetRelease, targetSlots, type PublishedRelease,
  type TargetLock } from "../scripts/t3-targets.js";
import { freePort } from "./support/g8-process.js";

/*
  The published T3 targets (scripts/t3-targets.ts): the slot selection over small release lists shaped like pingdotgg/t3code's
  list of 2026-11-03, the resolution against a loopback stand-in for GitHub's release list and release downloads, and the
  lock's validation. No request leaves the loopback interface.
*/

const digestOf = (text: string): string => createHash("sha256").update(text).digest("hex");

// a published release as GitHub's list shows it, without assets unless given
const published = (tag: string, prerelease: boolean, publishedAt: string, more: Partial<PublishedRelease> = {}): PublishedRelease =>
  ({tag_name: tag, draft: false, prerelease, published_at: publishedAt, assets: [], ...more});

it("the designated stable is kept and nightly versions use precedence, ignoring drafts and other channels", () => {
  const stable = published("v0.1.6", false, "2026-10-31T10:52:24Z");
  const selection = selectTargets(stable, [
    published("v0.1.7-nightly.20261103.4120", true, "2026-11-03T10:00:00Z", {draft: true}),
    published("android-beta-735", true, "2026-11-03T09:30:00Z"),
    published("v0.1.6-preview.20261030.3948", true, "2026-11-03T09:00:00Z"),
    published("v0.1.7-rc.1", true, "2026-11-03T08:00:00Z"),
    published("v0.1.7-nightly.20261103.4106", false, "2026-11-03T02:27:59Z"),
    published("v0.1.7-nightly.20261102.999", true, "2026-11-02T23:00:00Z"),
    published("v0.1.7-nightly.20261102.4080", true, "2026-11-02T13:24:45Z"),
    published("v0.1.7-nightly.20261102.4093", true, "2026-11-02T09:48:59Z"),
    published("v0.1.8-nightly.20261101.1", true, "2026-11-01T01:00:00Z"),
    published("v0.1.9", true, "2026-11-01T00:30:00Z"),
    published("v0.1.10", false, "2026-10-01T00:00:00Z"),
  ]);
  assert.deepEqual("selected" in selection ? selection.selected.map((entry) => entry.tag_name) : selection,
    ["v0.1.6", "v0.1.8-nightly.20261101.1", "v0.1.7-nightly.20261102.4093", "v0.1.7-nightly.20261102.4080"]);
});

it("fewer than three distinct nightlies never fills the window", () => {
  const nightlies = ["v0.1.7-nightly.20261103.4119", "v0.1.7-nightly.20261103.4106", "v0.1.7-nightly.20261102.4093"]
    .map((tag) => published(tag, true, "2026-11-03T08:49:52Z"));
  const stable = published("v0.1.6", false, "2026-10-31T10:52:24Z");
  assert.deepEqual(selectTargets(stable, nightlies.slice(0, 2)), {missing: "fewer than 3 nightly releases (2)"});
  assert.deepEqual(selectTargets(stable, [nightlies[0]!, nightlies[0]!, nightlies[1]!]), {missing: "fewer than 3 nightly releases (2)"});
  assert.deepEqual(selectTargets(stable, [published("v0.1.6", true, "2026-10-31T10:52:24Z"),
    published("v0.1.6-preview.20261030.3948", true, "2026-10-30T21:40:34Z")]), {missing: "fewer than 3 nightly releases (0)"});
});

interface Reply {
  readonly status?: number;
  readonly headers?: Record<string, string>;
  readonly body: string;
}

/*
  A loopback stand-in for GitHub's release list and downloads: it answers each path from `routes`, built once its origin is
  known, and records each request's path and Authorization header.
*/
const github = (routes: (origin: string) => Readonly<Record<string, Reply>>) => Effect.acquireRelease(Effect.gen(function* () {
  const requests: Array<{readonly path: string; readonly authorization: string | undefined}> = [];
  const table: Record<string, Reply> = {};
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const path = request.url ?? "";
    requests.push({path, authorization: request.headers.authorization});
    const reply = table[path];
    if (reply === undefined) response.writeHead(404).end();
    else response.writeHead(reply.status ?? 200, reply.headers).end(reply.body);
  });
  yield* Effect.callback<void>((resume) => {server.listen(0, "127.0.0.1", () => resume(Effect.void));});
  const address = server.address();
  const origin = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`;
  Object.assign(table, routes(origin));
  return {origin, requests, server};
}), ({server}) => Effect.callback<void>((resume) => {server.close(() => resume(Effect.void)); server.closeAllConnections();}));

const listPath = "/repos/pingdotgg/t3code/releases?per_page=100";
const latestPath = "/repos/pingdotgg/t3code/releases/latest";

// the stable release and the three nightlies GitHub listed on 2026-11-03, newest first, with a preview among them
const cohort = [
  {tag: "v0.1.7-nightly.20261103.4119", prerelease: true, publishedAt: "2026-11-03T08:49:52Z"},
  {tag: "v0.1.7-preview.20261103.4110", prerelease: true, publishedAt: "2026-11-03T05:00:00Z"},
  {tag: "v0.1.7-nightly.20261103.4106", prerelease: true, publishedAt: "2026-11-03T02:27:59Z"},
  {tag: "v0.1.7-nightly.20261102.4093", prerelease: true, publishedAt: "2026-11-02T19:48:59Z"},
  {tag: "v0.1.6", prerelease: false, publishedAt: "2026-10-31T10:52:24Z"},
] as const;

// T3's SHA256SUMS of one version in its own format; each archive's digest is that of its file name
const sumsOf = (version: string, platforms: ReadonlyArray<string> = ["darwin-arm64", "linux-arm64", "linux-x64"]) =>
  platforms.map((platform) => `t3-${version}-${platform}.tar.gz`).map((name) => `${digestOf(name)}  ${name}\n`).join("");

// a release with T3's Linux archives and SHA256SUMS on the loopback download path, each with GitHub's own digest
const withAssets = (origin: string, entry: typeof cohort[number], sums: string): PublishedRelease => published(entry.tag, entry.prerelease, entry.publishedAt, {
  assets: [
    ...["linux-x64", "linux-arm64"].map((platform) => `t3-${entry.tag.slice(1)}-${platform}.tar.gz`)
      .map((name) => ({name, browser_download_url: `${origin}/download/${entry.tag}/${name}`, digest: `sha256:${digestOf(name)}`})),
    {name: "SHA256SUMS", browser_download_url: `${origin}/download/${entry.tag}/SHA256SUMS`, digest: `sha256:${digestOf(sums)}`},
  ],
});

/*
  GitHub's routes for the cohort: the release list as one page and each release's SHA256SUMS. `sums` replaces a release's
  SHA256SUMS before GitHub's digest of it is taken; `edit` changes a release as the list shows it.
*/
const routesFor = (origin: string, change: {readonly sums?: Readonly<Record<string, string>>; readonly edit?: (release: PublishedRelease) => PublishedRelease} = {}):
  Record<string, Reply> => {
  const sums = Object.fromEntries(cohort.map((entry) => [entry.tag, change.sums?.[entry.tag] ?? sumsOf(entry.tag.slice(1))]));
  const releases = cohort.map((entry) => (change.edit ?? ((same: PublishedRelease) => same))(withAssets(origin, entry, sums[entry.tag]!)));
  return {
    [listPath]: {body: JSON.stringify(releases)},
    [latestPath]: {body: JSON.stringify(releases.find((release) => !release.prerelease))},
    ...Object.fromEntries(cohort.map((entry) => [`/download/${entry.tag}/SHA256SUMS`, {body: sums[entry.tag]!}])),
  };
};

const resolveFrom = (origin: string, token: Option.Option<Redacted.Redacted<string>> = Option.none()) =>
  resolveTargets({source: `${origin}${listPath}`, token}).pipe(Effect.provide(FetchHttpClient.layer));

it.live("a resolution freezes the four slots with their SHA256SUMS digests and sends the token only to the latest-release and list APIs", () => Effect.gen(function* () {
  const site = yield* github((origin) => {
    const routes = routesFor(origin);
    const releases = JSON.parse(routes[listPath]!.body) as Array<PublishedRelease>;
    routes[listPath] = {body: JSON.stringify([...releases, published("v99.0.0", false, "2026-11-03T10:00:00Z")])};
    return routes;
  });
  const lock = yield* resolveFrom(site.origin, Option.some(Redacted.make("test-token")));
  assert.deepEqual(lock.targets.map(({slot, version, tag, publishedAt, baseUrl}) => ({slot, version, tag, publishedAt, baseUrl})), [
    {slot: "stable", version: "0.1.6", tag: "v0.1.6", publishedAt: "2026-10-31T10:52:24Z", baseUrl: downloadBase},
    {slot: "nightly", version: "0.1.7-nightly.20261103.4119", tag: "v0.1.7-nightly.20261103.4119", publishedAt: "2026-11-03T08:49:52Z", baseUrl: downloadBase},
    {slot: "nightly-1", version: "0.1.7-nightly.20261103.4106", tag: "v0.1.7-nightly.20261103.4106", publishedAt: "2026-11-03T02:27:59Z", baseUrl: downloadBase},
    {slot: "nightly-2", version: "0.1.7-nightly.20261102.4093", tag: "v0.1.7-nightly.20261102.4093", publishedAt: "2026-11-02T19:48:59Z", baseUrl: downloadBase},
  ]);
  for (const target of lock.targets) {
    assert.deepEqual(target.archives, {"linux-x64": digestOf(`t3-${target.version}-linux-x64.tar.gz`), "linux-arm64": digestOf(`t3-${target.version}-linux-arm64.tar.gz`)});
  }
  assert.equal(lock.source, `${site.origin}${listPath}`);
  assert.ok(Number.isFinite(Date.parse(lock.resolvedAt)));
  assert.deepEqual(site.requests.map(({path, authorization}) => [path, authorization ?? null]),
    [[latestPath, "Bearer test-token"], [listPath, "Bearer test-token"], ...lock.targets.map((target) => [`/download/${target.tag}/SHA256SUMS`, null])]);
  assert.doesNotMatch(JSON.stringify(lock), /test-token/u);
  assert.deepEqual(yield* decodeTargetLock(JSON.stringify(lock)), lock);

  const anonymous = yield* github((origin) => routesFor(origin));
  yield* resolveFrom(anonymous.origin);
  assert.equal(anonymous.requests.length, 6);
  assert.ok(anonymous.requests.every((request) => request.authorization === undefined));
}));

it.live("a missing archive or SHA256SUMS, a missing checksum line or a digest GitHub lists otherwise is invalid", () => Effect.gen(function* () {
  const invalid = (change: Parameters<typeof routesFor>[1]) => Effect.gen(function* () {
    const site = yield* github((origin) => routesFor(origin, change));
    const failure = yield* Effect.flip(resolveFrom(site.origin));
    assert.equal(failure._tag, "TargetsInvalid", failure.message);
    return failure.message;
  });
  const without = (tag: string, name: string) => (entry: PublishedRelease): PublishedRelease =>
    entry.tag_name === tag ? {...entry, assets: entry.assets.filter((asset) => asset.name !== name)} : entry;
  const digested = (tag: string, name: string, digest: string) => (entry: PublishedRelease): PublishedRelease =>
    entry.tag_name === tag ? {...entry, assets: entry.assets.map((asset) => asset.name === name ? {...asset, digest} : asset)} : entry;
  assert.equal(yield* invalid({edit: without("v0.1.7-nightly.20261103.4106", "t3-0.1.7-nightly.20261103.4106-linux-arm64.tar.gz")}),
    "nightly-1 release v0.1.7-nightly.20261103.4106 has no t3-0.1.7-nightly.20261103.4106-linux-arm64.tar.gz asset");
  assert.equal(yield* invalid({edit: without("v0.1.6", "SHA256SUMS")}), "stable release v0.1.6 has no SHA256SUMS asset");
  assert.equal(yield* invalid({sums: {"v0.1.7-nightly.20261102.4093": sumsOf("0.1.7-nightly.20261102.4093", ["darwin-arm64", "linux-arm64"])}}),
    "the SHA256SUMS of v0.1.7-nightly.20261102.4093 has no line for t3-0.1.7-nightly.20261102.4093-linux-x64.tar.gz");
  assert.equal(yield* invalid({edit: digested("v0.1.7-nightly.20261103.4119", "t3-0.1.7-nightly.20261103.4119-linux-x64.tar.gz", `sha256:${"0".repeat(64)}`)}),
    "GitHub lists another SHA-256 for t3-0.1.7-nightly.20261103.4119-linux-x64.tar.gz than the SHA256SUMS of v0.1.7-nightly.20261103.4119");
  assert.equal(yield* invalid({edit: digested("v0.1.6", "SHA256SUMS", `sha256:${"1".repeat(64)}`)}),
    "the SHA256SUMS of v0.1.6 differs from the digest GitHub lists for it");
}));

it.live("GitHub refusing, failing or gone is unavailable, and a reply of another shape is invalid", () => Effect.gen(function* () {
  const listReply = (reply: Reply) => Effect.gen(function* () {
    const site = yield* github((origin) => ({...routesFor(origin), [listPath]: reply}));
    return yield* Effect.flip(resolveFrom(site.origin));
  });
  const limited = yield* listReply({status: 403, headers: {"x-ratelimit-remaining": "0"}, body: "{\"message\":\"API rate limit exceeded for 192.0.2.1\"}"});
  assert.equal(limited._tag, "TargetsUnavailable");
  assert.match(limited.message, /returned HTTP 403; GitHub's API rate limit is exhausted, and GITHUB_TOKEN raises it$/u);
  assert.doesNotMatch(limited.message, /192\.0\.2\.1/u, "GitHub's reply body is never repeated");
  const failing = yield* listReply({status: 502, body: "Bad gateway"});
  assert.deepEqual([failing._tag, failing.message.endsWith("returned HTTP 502")], ["TargetsUnavailable", true]);
  const gone = yield* Effect.flip(resolveTargets({source: `http://127.0.0.1:${yield* freePort}${listPath}`, token: Option.none()})
    .pipe(Effect.provide(FetchHttpClient.layer)));
  assert.equal(gone._tag, "TargetsUnavailable");
  for (const body of ["{\"message\":\"Not Found\"}", "[{\"tag_name\":\"v0.1.6\"", "[{\"tag_name\":\"v0.1.6\",\"draft\":false}]"]) {
    const malformed = yield* listReply({body});
    assert.deepEqual([malformed._tag, malformed.message], ["TargetsInvalid", "page 1 of the release list is not GitHub's release JSON"]);
  }
  const site = yield* github((origin) => ({...routesFor(origin), "/download/v0.1.7-nightly.20261103.4106/SHA256SUMS": {status: 404, body: "Not Found"}}));
  const download = yield* Effect.flip(resolveFrom(site.origin));
  assert.deepEqual([download._tag, download.message],
    ["TargetsUnavailable", `GET ${site.origin}/download/v0.1.7-nightly.20261103.4106/SHA256SUMS returned HTTP 404`]);
}));

// a later page of the release list as GitHub links it
const page = (number: number) => `/repositories/1/releases?per_page=100&page=${number}`;
const linkTo = (origin: string, number: number) => ({link: `<${origin}${page(number)}>; rel="next", <${origin}${page(9)}>; rel="last"`});

it.live("stable comes from its designation even beyond three pages; only the nightly search is bounded", () => Effect.gen(function* () {
  const paged = (pages: ReadonlyArray<"nightlies" | "stable" | "empty">) => github((origin) => {
    const routes = routesFor(origin);
    const releases = JSON.parse(routes[listPath]!.body) as Array<PublishedRelease>;
    const bodies = {nightlies: releases.filter((entry) => entry.prerelease), stable: releases.filter((entry) => !entry.prerelease), empty: []};
    return {...routes, ...Object.fromEntries(pages.map((content, index) => [index === 0 ? listPath : page(index + 1),
      {body: JSON.stringify(bodies[content]), ...(index + 1 < pages.length ? {headers: linkTo(origin, index + 2)} : {})}]))};
  });
  const oldStable = yield* paged(["nightlies", "empty", "empty", "stable"]);
  const lock = yield* resolveFrom(oldStable.origin);
  assert.deepEqual(lock.targets.map((target) => target.tag),
    ["v0.1.6", "v0.1.7-nightly.20261103.4119", "v0.1.7-nightly.20261103.4106", "v0.1.7-nightly.20261102.4093"]);
  assert.deepEqual(oldStable.requests.map((request) => request.path).filter((path) => !path.startsWith("/download/")), [latestPath, listPath]);
  const twoPages = yield* paged(["empty", "nightlies", "stable"]);
  yield* resolveFrom(twoPages.origin);
  assert.deepEqual(twoPages.requests.map((request) => request.path).filter((path) => !path.startsWith("/download/")), [latestPath, listPath, page(2)]);
  const fourPages = yield* paged(["empty", "empty", "empty", "nightlies"]);
  const failure = yield* Effect.flip(resolveFrom(fourPages.origin));
  assert.deepEqual([failure._tag, failure.message], ["TargetsInvalid", "the 0 releases on 3 page(s) of the release list hold fewer than 3 nightly releases (0)"]);
  assert.deepEqual(fourPages.requests.map((request) => request.path), [latestPath, listPath, page(2), page(3)]);
}));

it.live("an absent or invalid stable designation never falls back to a listed stable", () => Effect.gen(function* () {
  const reply = (value: Reply) => Effect.gen(function* () {
    const site = yield* github((origin) => ({...routesFor(origin), [latestPath]: value}));
    const failure = yield* Effect.flip(resolveFrom(site.origin));
    assert.deepEqual(site.requests.map((request) => request.path), [latestPath]);
    return failure;
  });
  assert.equal((yield* reply({status: 404, body: "not found"}))._tag, "TargetsInvalid");
  for (const status of [403, 502]) assert.equal((yield* reply({status, body: "unavailable"}))._tag, "TargetsUnavailable");
  assert.equal((yield* reply({body: "{}"})).message, "the latest full release is not GitHub's release JSON");
  for (const change of [{draft: true}, {prerelease: true}, {tag_name: "v0.1.6-preview.20261030.3948"}]) {
    const release = {...published("v0.1.6", false, "2026-10-31T10:52:24Z"), ...change};
    assert.equal((yield* reply({body: JSON.stringify(release)})).message,
      "the designated latest full release is not a published stable v<major>.<minor>.<patch>");
  }
}));

// a valid lock of the cohort, as `resolve` writes it
const validLock = (): TargetLock => ({
  resolvedAt: "2026-11-03T09:17:54.000Z",
  source: "https://api.github.com/repos/pingdotgg/t3code/releases?per_page=100",
  targets: ["0.1.6", "0.1.7-nightly.20261103.4119", "0.1.7-nightly.20261103.4106", "0.1.7-nightly.20261102.4093"].map((version, index) => ({
    slot: targetSlots[index]!, version, tag: `v${version}`, publishedAt: "2026-11-03T08:49:52Z", baseUrl: downloadBase,
    archives: {"linux-x64": digestOf(`t3-${version}-linux-x64.tar.gz`), "linux-arm64": digestOf(`t3-${version}-linux-arm64.tar.gz`)},
  })),
});

// the lock with one target changed
const withTarget = (lock: TargetLock, index: number, change: Partial<TargetLock["targets"][number]>): TargetLock =>
  ({...lock, targets: lock.targets.map((target, at) => at === index ? {...target, ...change} : target)});

it.effect("a lock decodes only with the four slots in order, distinct versions, descending nightlies, a stable tag and both Linux digests", () => Effect.gen(function* () {
  const lock = validLock();
  const target = (index: number) => lock.targets[index]!;
  assert.deepEqual(yield* decodeTargetLock(JSON.stringify(lock)), lock);
  const rejected = (value: unknown) => Effect.flip(decodeTargetLock(typeof value === "string" ? value : JSON.stringify(value))).pipe(Effect.map((error) => error.message));
  const invalid = (problem: string) => `the target lock is invalid: ${problem}`;
  assert.equal(yield* rejected(withTarget(lock, 0, {baseUrl: "https://example.invalid/releases"})),
    invalid("a target does not use the official T3 release download base"));
  const order = invalid("its targets are not exactly stable, nightly, nightly-1 and nightly-2 in this order");
  assert.equal(yield* rejected({...lock, targets: [target(1), target(0), target(2), target(3)]}), order);
  assert.equal(yield* rejected({...lock, targets: lock.targets.slice(0, 3)}), order);
  assert.equal(yield* rejected(withTarget(lock, 3, {version: target(2).version, tag: target(2).tag})), invalid("two of its targets name the same version"));
  assert.equal(yield* rejected(withTarget(withTarget(lock, 2, {version: target(3).version, tag: target(3).tag}), 3, {version: target(2).version, tag: target(2).tag})),
    invalid("its nightly targets are not in strictly descending version order"));
  assert.equal(yield* rejected(withTarget(lock, 0, {tag: "0.1.6"})), invalid("a target's tag is not v followed by its version"));
  const stableTag = invalid("its stable target's tag is not v<major>.<minor>.<patch>");
  assert.equal(yield* rejected(withTarget(lock, 0, {version: "0.1.7-nightly.20261101.4016", tag: "v0.1.7-nightly.20261101.4016"})), stableTag);
  assert.equal(yield* rejected(withTarget(lock, 1, {version: "0.1.7", tag: "v0.1.7"})),
    invalid("a nightly target's tag is not v<major>.<minor>.<patch>-nightly.<date>.<build>"));
  const digests = invalid("a target does not carry exactly a linux-x64 and a linux-arm64 SHA-256 of 64 lowercase hex characters");
  for (const archives of [{...target(2).archives, "linux-x64": target(2).archives["linux-x64"]!.toUpperCase()}, {"linux-x64": target(2).archives["linux-x64"]!},
    {...target(2).archives, "darwin-arm64": digestOf("t3-darwin-arm64.tar.gz")}, {...target(2).archives, "linux-arm64": "0".repeat(63)}]) {
    assert.equal(yield* rejected(withTarget(lock, 2, {archives})), digests);
  }
  const shape = "the target lock is not JSON in the shape of a target lock";
  assert.equal(yield* rejected("{"), shape);
  assert.equal(yield* rejected({source: lock.source, targets: lock.targets}), shape);
  assert.equal(yield* rejected({...lock, targets: lock.targets.map((entry, index) => index === 0 ? {...entry, slot: "latest"} : entry)}), shape);
  // a broken lock is named by its rule, never by its contents
  assert.equal(yield* rejected(withTarget(lock, 0, {version: "LEAKED-1234", tag: "vLEAKED-1234"})), stableTag);
}));

it.live("a lock file is read and validated, and an unreadable or broken one fails without repeating its text", () => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const folder = yield* fs.makeTempDirectoryScoped({prefix: "t3-targets-test-"});
  const file = join(folder, "lock.json");
  yield* fs.writeFileString(file, JSON.stringify(validLock()));
  assert.deepEqual(yield* readTargetLock(file), validLock());
  const absent = join(folder, "absent.json");
  const missing = yield* Effect.flip(readTargetLock(absent));
  assert.deepEqual([missing._tag, missing.message], ["TargetLockError", `target lock ${absent} could not be read`]);
  yield* fs.writeFileString(file, "{\"marker\": \"LEAKED-5678\"");
  const broken = yield* Effect.flip(readTargetLock(file));
  assert.deepEqual([broken._tag, broken.message], ["TargetLockError", `target lock ${file} is not JSON in the shape of a target lock`]);
}).pipe(Effect.provide(NodeFileSystem.layer)));

it("each slot of a lock maps to the build the stack installs", () => {
  const lock = validLock();
  for (const [index, slot] of targetSlots.entries()) {
    const target = lock.targets[index]!;
    const release = targetRelease(lock, slot);
    assert.deepEqual(release, {version: target.version, baseUrl: downloadBase, archives: target.archives});
    assert.equal(archiveName(release, "linux-x64"), `t3-${target.version}-linux-x64.tar.gz`);
  }
});
