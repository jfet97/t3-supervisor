import { createHash } from "node:crypto";
import { NodeFileSystem, NodeRuntime } from "@effect/platform-node";
import { Clock, Console, Data, Effect, FileSystem, Option, Redacted, Schema } from "effect";
import { FetchHttpClient, Headers, HttpClient, HttpClientRequest, type HttpClientError, type HttpClientResponse } from "effect/http";
import type { T3Release } from "./local-stack.js";

/*
  `pnpm dev:targets`: the published T3 builds a compatibility run checks, in four fixed slots (docs/local-stack.md): `stable`,
  the latest official stable release, and `nightly`, `nightly-1` and `nightly-2`, the latest three distinct nightlies of
  pingdotgg/t3code by version precedence. `resolve` reads GitHub's release list once and writes a lock that freezes the four
  builds with their Linux archive digests from each release's own SHA256SUMS; `pnpm dev:stack --check --t3-lock` runs them.
  A missing build, artifact or checksum fails the resolution: nothing falls back to another build, the pin or an earlier lock.
*/

export const targetSlots = ["stable", "nightly", "nightly-1", "nightly-2"] as const;
export const TargetSlot = Schema.Literals(targetSlots);
export type TargetSlot = typeof TargetSlot.Type;

/** The first page of pingdotgg/t3code's releases, newest first; a resolution reads at most three such pages. */
export const releasesUrl = "https://api.github.com/repos/pingdotgg/t3code/releases?per_page=100";
/** Where every published T3 archive is downloaded: `<downloadBase>/<tag>/<archive>`. */
export const downloadBase = "https://github.com/pingdotgg/t3code/releases/download";
/** The platforms of the development container, the only archives a lock carries. */
export const lockPlatforms = ["linux-x64", "linux-arm64"] as const;
const maxPages = 3;
const requestTimeout = "60 seconds";

// exact tag forms: numbers without leading zeros, and a nightly's eight-digit build date and build number
const stableTag = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const nightlyTag = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-nightly\.(\d{8})\.(0|[1-9]\d*)$/u;

// a tag's numbers in precedence order (major, minor, patch, then a nightly's date and build), or none for another tag form
const precedence = (pattern: RegExp, tag: string): ReadonlyArray<string> | undefined => pattern.exec(tag)?.slice(1);

// orders two precedences number by number, exactly at any length: without leading zeros the longer number is the larger
const comparePrecedence = (left: ReadonlyArray<string>, right: ReadonlyArray<string>): number => {
  for (const [index, number] of left.entries()) {
    const other = right[index] ?? "";
    const order = number.length - other.length || (number < other ? -1 : number > other ? 1 : 0);
    if (order !== 0) return order;
  }
  return 0;
};

const LockTarget = Schema.Struct({
  slot: TargetSlot,
  version: Schema.String,
  tag: Schema.String,
  publishedAt: Schema.String,
  baseUrl: Schema.String,
  archives: Schema.Record(Schema.String, Schema.String),
});
const LockFields = Schema.Struct({resolvedAt: Schema.String, source: Schema.String, targets: Schema.Array(LockTarget)});
const sha256Hex = /^[0-9a-f]{64}$/u;

/** The first rule a lock breaks, as a fixed message that never repeats the lock's contents; undefined when it keeps them all. */
export const lockProblem = (lock: typeof LockFields.Type): string | undefined => {
  const {targets} = lock;
  if (targets.length !== targetSlots.length || targets.some((target, index) => target.slot !== targetSlots[index]))
    return "its targets are not exactly stable, nightly, nightly-1 and nightly-2 in this order";
  if (targets.some((target) => target.baseUrl !== downloadBase)) return "a target does not use the official T3 release download base";
  if (new Set(targets.map((target) => target.version)).size !== targets.length) return "two of its targets name the same version";
  if (targets.some((target) => target.tag !== `v${target.version}`)) return "a target's tag is not v followed by its version";
  const [stable, ...nightlies] = targets.map((target) => precedence(target.slot === "stable" ? stableTag : nightlyTag, target.tag));
  if (stable === undefined) return "its stable target's tag is not v<major>.<minor>.<patch>";
  const ordered: Array<ReadonlyArray<string>> = [];
  for (const order of nightlies) {
    if (order === undefined) return "a nightly target's tag is not v<major>.<minor>.<patch>-nightly.<date>.<build>";
    const previous = ordered.at(-1);
    if (previous !== undefined && comparePrecedence(previous, order) <= 0) return "its nightly targets are not in strictly descending version order";
    ordered.push(order);
  }
  const platforms = [...lockPlatforms].sort().join(" ");
  if (targets.some((target) => Object.keys(target.archives).sort().join(" ") !== platforms ||
    Object.values(target.archives).some((digest) => !sha256Hex.test(digest))))
    return "a target does not carry exactly a linux-x64 and a linux-arm64 SHA-256 of 64 lowercase hex characters";
  return undefined;
};

/** The four frozen targets in slot order, with when and from where they were resolved; decoding enforces every lockProblem rule. */
export const TargetLock = LockFields.check(Schema.makeFilter(lockProblem));
export type TargetLock = typeof TargetLock.Type;

export class TargetLockError extends Data.TaggedError("TargetLockError")<{readonly message: string}> {}

const decodeLockFields = Schema.decodeUnknownEffect(Schema.fromJsonString(LockFields));

/** A lock file's text as a valid lock. A failure names the broken rule in a fixed message and never repeats the text. */
export const decodeTargetLock = (text: string, name = "the target lock"): Effect.Effect<TargetLock, TargetLockError> => Effect.gen(function* () {
  const lock = yield* decodeLockFields(text).pipe(Effect.mapError(() => new TargetLockError({message: `${name} is not JSON in the shape of a target lock`})));
  const problem = lockProblem(lock);
  if (problem !== undefined) return yield* new TargetLockError({message: `${name} is invalid: ${problem}`});
  return lock;
});

export const readTargetLock = (file: string): Effect.Effect<TargetLock, TargetLockError, FileSystem.FileSystem> => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs.readFileString(file).pipe(Effect.mapError(() => new TargetLockError({message: `target lock ${file} could not be read`})));
  return yield* decodeTargetLock(text, `target lock ${file}`);
});

/** One slot's build in the form the stack installs (scripts/local-stack.ts): its version, download base and Linux digests. */
export const targetRelease = (lock: TargetLock, slot: TargetSlot): T3Release => {
  const target = lock.targets.find((entry) => entry.slot === slot);
  // a decoded lock holds every slot, so only a lock that never passed decoding can miss one
  if (target === undefined) throw new Error(`the target lock has no ${slot} target`);
  return {version: target.version, baseUrl: target.baseUrl, archives: target.archives};
};

/** GitHub did not answer as needed: a network error, a timeout or an HTTP status such as a rate limit or a server error. */
export class TargetsUnavailable extends Data.TaggedError("TargetsUnavailable")<{readonly message: string}> {}
/** A reply or a publication that cannot fill the four slots as required; no other build is chosen instead. */
export class TargetsInvalid extends Data.TaggedError("TargetsInvalid")<{readonly message: string}> {}
const unavailable = (message: string) => new TargetsUnavailable({message});
const invalid = (message: string) => new TargetsInvalid({message});

const ReleaseAsset = Schema.Struct({name: Schema.String, browser_download_url: Schema.String, digest: Schema.optionalKey(Schema.NullOr(Schema.String))});
const PublishedRelease = Schema.Struct({tag_name: Schema.String, draft: Schema.Boolean, prerelease: Schema.Boolean,
  published_at: Schema.NullOr(Schema.String), assets: Schema.Array(ReleaseAsset)});
/** One release of GitHub's release list, reduced to what a resolution reads. */
export type PublishedRelease = typeof PublishedRelease.Type;
const decodeReleasePage = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(PublishedRelease)));

/**
 * The releases of the four slots in slot order, or what the releases read so far lack. Only published releases count: the
 * stable slot takes the highest non-prerelease `v<major>.<minor>.<patch>`, the nightly slots the three highest distinct
 * prerelease `v<major>.<minor>.<patch>-nightly.<date>.<build>`, by version precedence and never by publication time. Drafts and
 * every other tag, such as previews and Android betas, are ignored.
 */
export const selectTargets = (releases: ReadonlyArray<PublishedRelease>): {readonly selected: ReadonlyArray<PublishedRelease>} | {readonly missing: string} => {
  const ranked = (pattern: RegExp, prerelease: boolean) => {
    const found = new Map<string, {readonly release: PublishedRelease; readonly order: ReadonlyArray<string>}>();
    for (const release of releases) {
      const order = precedence(pattern, release.tag_name);
      if (!release.draft && release.prerelease === prerelease && order !== undefined && !found.has(release.tag_name)) found.set(release.tag_name, {release, order});
    }
    return [...found.values()].sort((left, right) => comparePrecedence(right.order, left.order)).map((entry) => entry.release);
  };
  const [stable] = ranked(stableTag, false);
  const nightlies = ranked(nightlyTag, true).slice(0, 3);
  if (stable !== undefined && nightlies.length === 3) return {selected: [stable, ...nightlies]};
  return {missing: [...(stable === undefined ? ["no stable release"] : []), ...(nightlies.length < 3 ? [`fewer than 3 nightly releases (${nightlies.length})`] : [])].join(" and ")};
};

const downloadHeaders = {"User-Agent": "t3-supervisor-targets"};
const apiHeaders = {...downloadHeaders, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"};

// one GET answered with HTTP 200 and read in full within the bound; any other outcome is unavailability, never a reason to choose another build
const fetched = <A>(url: string, request: HttpClientRequest.HttpClientRequest,
  read: (response: HttpClientResponse.HttpClientResponse) => Effect.Effect<A, HttpClientError.HttpClientError>) => Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;
  const response = yield* client.execute(request).pipe(Effect.mapError((error) => error.reason._tag === "InvalidUrlError"
    ? invalid(`the release list names a malformed URL: ${url}`) : unavailable(`GET ${url} failed (${error.reason._tag})`)));
  if (response.status !== 200) {
    yield* Effect.ignore(response.arrayBuffer);
    const limited = Option.exists(Headers.get(response.headers, "x-ratelimit-remaining"), (remaining) => remaining === "0");
    return yield* unavailable(`GET ${url} returned HTTP ${response.status}${limited ? "; GitHub's API rate limit is exhausted, and GITHUB_TOKEN raises it" : ""}`);
  }
  const body = yield* read(response).pipe(Effect.mapError((error) => unavailable(`GET ${url} broke off (${error.reason._tag})`)));
  return {headers: response.headers, body};
}).pipe(Effect.timeoutOrElse({duration: requestTimeout, orElse: () => Effect.fail(unavailable(`GET ${url} did not answer within ${requestTimeout}`))}));

// the URL of the release list's next page, from its Link header
const nextPage = (headers: Headers.Headers): string | undefined =>
  Option.getOrUndefined(Option.flatMap(Headers.get(headers, "link"), (link) => Option.fromNullishOr(/<([^>]+)>;\s*rel="next"/u.exec(link)?.[1])));

const sha256 = (data: Uint8Array | string): string => createHash("sha256").update(data).digest("hex");

// the files a SHA256SUMS lists with their digests; a file it lists with two different digests maps to null
const listedDigests = (text: string): ReadonlyMap<string, string | null> => {
  const listed = new Map<string, string | null>();
  for (const line of text.split("\n")) {
    const match = /^([0-9a-fA-F]{64}) [ *](.+?)\r?$/u.exec(line);
    if (match === null) continue;
    const digest = match[1]!.toLowerCase();
    const earlier = listed.get(match[2]!);
    listed.set(match[2]!, earlier === undefined || earlier === digest ? digest : null);
  }
  return listed;
};

// a digest GitHub lists for an asset agrees unless it is a SHA-256 of other bytes; digests of other algorithms are not compared
const agrees = (listed: string | null | undefined, digest: string): boolean =>
  listed === null || listed === undefined || !listed.toLowerCase().startsWith("sha256:") || listed.toLowerCase() === `sha256:${digest}`;

// one selected release as a lock target: its Linux archives' digests from its own SHA256SUMS, which GitHub's digests must match
const lockTarget = (slot: TargetSlot, release: PublishedRelease) => Effect.gen(function* () {
  const tag = release.tag_name;
  const version = tag.slice(1);
  const asset = (name: string) => release.assets.find((entry) => entry.name === name);
  const archives = lockPlatforms.map((platform) => ({platform, name: `t3-${version}-${platform}.tar.gz`}));
  for (const name of [...archives.map((archive) => archive.name), "SHA256SUMS"]) {
    if (asset(name) === undefined) return yield* invalid(`${slot} release ${tag} has no ${name} asset`);
  }
  const publishedAt = release.published_at;
  if (publishedAt === null) return yield* invalid(`${slot} release ${tag} has no publication time`);
  const sums = asset("SHA256SUMS")!;
  const download = yield* fetched(sums.browser_download_url, HttpClientRequest.get(sums.browser_download_url).pipe(HttpClientRequest.setHeaders(downloadHeaders)),
    (response) => response.arrayBuffer);
  const bytes = new Uint8Array(download.body);
  if (!agrees(sums.digest, sha256(bytes))) return yield* invalid(`the SHA256SUMS of ${tag} differs from the digest GitHub lists for it`);
  const listed = listedDigests(new TextDecoder().decode(bytes));
  const digests: Record<string, string> = {};
  for (const {platform, name} of archives) {
    const digest = listed.get(name);
    if (digest === undefined) return yield* invalid(`the SHA256SUMS of ${tag} has no line for ${name}`);
    if (digest === null) return yield* invalid(`the SHA256SUMS of ${tag} lists ${name} with two different digests`);
    if (!agrees(asset(name)?.digest, digest)) return yield* invalid(`GitHub lists another SHA-256 for ${name} than the SHA256SUMS of ${tag}`);
    digests[platform] = digest;
  }
  return {slot, version, tag, publishedAt, baseUrl: downloadBase, archives: digests};
});

/**
 * Resolves the four slots from GitHub's release list, following its pages only until the slots are filled and never past the
 * third, then reads each selected release's SHA256SUMS. `token`, when given, is sent as a bearer on the release list's requests
 * only, never on a download. `source` names another first page, such as a test's loopback stand-in.
 */
export const resolveTargets = (options: {readonly token: Option.Option<Redacted.Redacted<string>>; readonly source?: string}) => Effect.gen(function* () {
  const source = options.source ?? releasesUrl;
  const origin = new URL(source).origin;
  const releases: Array<PublishedRelease> = [];
  let next: string | undefined = source;
  let pages = 0;
  let selection = selectTargets(releases);
  while ("missing" in selection && next !== undefined && pages < maxPages) {
    const url: string = next;
    const request = HttpClientRequest.get(url).pipe(HttpClientRequest.setHeaders(apiHeaders));
    const page = yield* fetched(url, Option.match(options.token, {onNone: () => request, onSome: (token) => HttpClientRequest.bearerToken(request, token)}),
      (response) => response.text);
    pages += 1;
    const listed = yield* decodeReleasePage(page.body).pipe(Effect.mapError(() => invalid(`page ${pages} of the release list is not GitHub's release JSON`)));
    releases.push(...listed);
    next = nextPage(page.headers);
    if (next !== undefined && !next.startsWith(`${origin}/`)) return yield* invalid("the release list links its next page outside GitHub's API");
    selection = selectTargets(releases);
  }
  if ("missing" in selection) return yield* invalid(`the ${releases.length} releases on ${pages} page(s) of the release list hold ${selection.missing}`);
  const targets = yield* Effect.forEach(selection.selected, (release, index) => lockTarget(targetSlots[index]!, release));
  const lock = {resolvedAt: new Date(yield* Clock.currentTimeMillis).toISOString(), source, targets};
  return yield* Schema.decodeUnknownEffect(TargetLock)(lock).pipe(Effect.mapError(() => invalid("the selected releases do not form a valid target lock")));
});

class UsageError extends Data.TaggedError("UsageError")<{readonly message: string}> {}
const usage = "usage: pnpm dev:targets resolve --out <file>";
const outcome = (error: TargetsUnavailable | TargetsInvalid) => error._tag === "TargetsUnavailable" ? "unavailable" : "invalid";

const main = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const [command, option, out, ...rest] = process.argv.slice(2);
  if (command !== "resolve" || option !== "--out" || out === undefined || out === "" || rest.length > 0) return yield* new UsageError({message: usage});
  // GITHUB_TOKEN raises GitHub's rate limit; it stays redacted, goes only to the release list and is never printed or written
  const token = Option.map(Option.filter(Option.fromNullishOr(process.env.GITHUB_TOKEN), (value) => value.trim() !== ""), (value) => Redacted.make(value.trim()));
  const lock = yield* resolveTargets({token}).pipe(Effect.provide(FetchHttpClient.layer),
    Effect.tapError((error) => Console.log(JSON.stringify({outcome: outcome(error), message: error.message}))));
  const text = `${JSON.stringify(lock, null, 2)}\n`;
  yield* fs.writeFileString(out, text);
  for (const target of lock.targets) yield* Console.log(`${target.slot.padEnd(9)}  T3 ${target.version}  published ${target.publishedAt}`);
  yield* Console.log(JSON.stringify({outcome: "resolved", lock: out, sha256: sha256(text), resolvedAt: lock.resolvedAt, source: lock.source,
    targets: lock.targets.map(({slot, version, publishedAt}) => ({slot, version, publishedAt}))}));
});

if (import.meta.main) NodeRuntime.runMain(main.pipe(Effect.tapError((error) => Console.error(error._tag === "TargetsUnavailable" || error._tag === "TargetsInvalid"
  ? `${outcome(error)}: ${error.message}` : error.message)), Effect.provide(NodeFileSystem.layer)), {disableErrorReporting: true});
