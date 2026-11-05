import { createHash } from "node:crypto";
import { NodeFileSystem, NodeRuntime } from "@effect/platform-node";
import { Clock, Console, Data, Effect, FileSystem, Option, Redacted, Schema } from "effect";
import { FetchHttpClient, Headers, HttpClient, HttpClientRequest } from "effect/http";

/*
  `pnpm dev:releases`: the published Supervisor releases the upgrade journeys start from (docs/local-stack.md, "Published upgrade
  journeys"), in two fixed channels: `stable`, the release GHCR's `latest` image tag names, and `nightly`, the release its `nightly`
  tag names. `resolve` reads both tags once, checks every index, manifest and configuration it reads against its SHA-256 digest and
  writes a lock that freezes each channel's version, source revision, index digest and per-platform image digest, with npm's record of
  the same version where npm has one. A journey runs the image by its platform digest; npm's record serves only the journey's separate
  npm-install probe. A missing, ambiguous or inconsistent publication fails the resolution: nothing falls back to another tag, version
  or registry.
*/

export const releaseChannels = ["stable", "nightly"] as const;
export const ReleaseChannel = Schema.Literals(releaseChannels);
export type ReleaseChannel = typeof ReleaseChannel.Type;

/** The image repository every release publishes, and the tag that names each channel's current release. */
export const imageRepository = "ghcr.io/jfet97/t3-supervisor";
export const channelTags: Readonly<Record<ReleaseChannel, string>> = {stable: "latest", nightly: "nightly"};
/** The image platforms a lock carries: the development container's, which every release builds natively. */
export const imagePlatforms = ["linux/amd64", "linux/arm64"] as const;
export type ImagePlatform = typeof imagePlatforms[number];
const platformParts: Readonly<Record<ImagePlatform, {readonly os: string; readonly architecture: string}>> = {
  "linux/amd64": {os: "linux", architecture: "amd64"},
  "linux/arm64": {os: "linux", architecture: "arm64"},
};
/** The source repository the release build stamps into every image's labels. */
export const sourceRepository = "https://github.com/jfet97/t3-supervisor";
export const packumentUrl = "https://registry.npmjs.org/@jfet97%2Ft3-supervisor";
export const tarballUrl = (version: string): string => `https://registry.npmjs.org/@jfet97/t3-supervisor/-/t3-supervisor-${version}.tgz`;
const registryApi = "https://ghcr.io/v2/jfet97/t3-supervisor";
const tokenUrl = "https://ghcr.io/token?scope=repository:jfet97/t3-supervisor:pull";
const requestTimeout = "60 seconds";
const userAgent = {"User-Agent": "t3-supervisor-releases"};
export const imageManifestTypes: ReadonlyArray<string> = ["application/vnd.oci.image.manifest.v1+json", "application/vnd.docker.distribution.manifest.v2+json"];
const imageIndexTypes: ReadonlyArray<string> = ["application/vnd.oci.image.index.v1+json", "application/vnd.docker.distribution.manifest.list.v2+json"];

// the version forms of the channels (scripts/release-policy.ts): a nightly names its source revision's first twelve characters
const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const nightlyVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-nightly\.\d{14}\.g([0-9a-f]{12})$/u;
const digestForm = /^sha256:[0-9a-f]{64}$/u;
const revisionForm = /^[0-9a-f]{40}$/u;
const sha512Integrity = /^sha512-[A-Za-z0-9+/]{86}==$/u;

const NpmRelease = Schema.Struct({tarball: Schema.String, integrity: Schema.String, gitHead: Schema.String});
const LockRelease = Schema.Struct({
  channel: ReleaseChannel,
  tag: Schema.String,
  version: Schema.String,
  revision: Schema.String,
  index: Schema.String,
  platforms: Schema.Record(Schema.String, Schema.String),
  npm: Schema.NullOr(NpmRelease),
});
/** One channel's frozen release: its tag, version, source revision, index digest, per-platform image digests and npm's record. */
export type LockRelease = typeof LockRelease.Type;
const LockFields = Schema.Struct({resolvedAt: Schema.String, repository: Schema.String, releases: Schema.Array(LockRelease)});

/** The first rule a channel's release breaks, as a fixed message that never repeats its contents; undefined when it keeps them all. */
export const releaseProblem = (release: LockRelease): string | undefined => {
  const {channel} = release;
  if (release.tag !== channelTags[channel]) return `the ${channel} release is not named by the ${channelTags[channel]} tag`;
  if (!revisionForm.test(release.revision)) return `the ${channel} release names no 40-character source revision`;
  if (channel === "stable" && !stableVersion.test(release.version)) return "the stable release's version is not <major>.<minor>.<patch>";
  if (channel === "nightly" && nightlyVersion.exec(release.version)?.[4] !== release.revision.slice(0, 12))
    return "the nightly release's version is not <major>.<minor>.<patch>-nightly.<timestamp>.g<its revision>";
  if (!digestForm.test(release.index)) return `the ${channel} release names no sha256 index digest`;
  const platforms = Object.keys(release.platforms).sort().join(" ");
  if (platforms !== [...imagePlatforms].sort().join(" ") || Object.values(release.platforms).some((value) => !digestForm.test(value)))
    return `the ${channel} release does not carry exactly a linux/amd64 and a linux/arm64 image digest`;
  if (release.npm !== null && (release.npm.tarball !== tarballUrl(release.version) || !sha512Integrity.test(release.npm.integrity) ||
    release.npm.gitHead !== release.revision))
    return `npm's record of the ${channel} release is not its own tarball with a sha512 integrity and its revision`;
  return undefined;
};

/** The first rule a lock breaks, as a fixed message; undefined when it keeps them all. */
export const releaseLockProblem = (lock: typeof LockFields.Type): string | undefined => {
  if (lock.repository !== imageRepository) return "it does not name the official image repository";
  if (lock.releases.length !== releaseChannels.length || lock.releases.some((release, index) => release.channel !== releaseChannels[index]))
    return "its releases are not exactly stable and nightly in this order";
  for (const release of lock.releases) {
    const problem = releaseProblem(release);
    if (problem !== undefined) return problem;
  }
  return undefined;
};

/** The two frozen channel releases with when they were resolved; decoding enforces every releaseLockProblem rule. */
export const ReleaseLock = LockFields.check(Schema.makeFilter(releaseLockProblem));
export type ReleaseLock = typeof ReleaseLock.Type;

export class ReleaseLockError extends Data.TaggedError("ReleaseLockError")<{readonly message: string}> {}

const decodeLockFields = Schema.decodeUnknownEffect(Schema.fromJsonString(LockFields));

/** A lock file's text as a valid release lock. A failure names the broken rule in a fixed message and never repeats the text. */
export const decodeReleaseLock = (text: string, name = "the release lock"): Effect.Effect<ReleaseLock, ReleaseLockError> => Effect.gen(function* () {
  const lock = yield* decodeLockFields(text).pipe(Effect.mapError(() => new ReleaseLockError({message: `${name} is not JSON in the shape of a release lock`})));
  const problem = releaseLockProblem(lock);
  if (problem !== undefined) return yield* new ReleaseLockError({message: `${name} is invalid: ${problem}`});
  return lock;
});

/** One channel's release of a decoded lock, which always holds both channels. */
export const channelRelease = (lock: ReleaseLock, channel: ReleaseChannel): LockRelease => {
  const release = lock.releases.find((entry) => entry.channel === channel);
  // a decoded lock holds every channel, so only a lock that never passed decoding can miss one
  if (release === undefined) throw new Error(`the release lock has no ${channel} release`);
  return release;
};

/** The image of one channel's release for one platform: the repository and that platform's digest, the reference Docker pulls. */
export const imageReference = (release: LockRelease, platform: ImagePlatform): string => `${imageRepository}@${release.platforms[platform]}`;

const IndexEntry = Schema.Struct({
  mediaType: Schema.String,
  digest: Schema.String,
  platform: Schema.optionalKey(Schema.Struct({os: Schema.String, architecture: Schema.String})),
});
export const ImageIndex = Schema.Struct({mediaType: Schema.optionalKey(Schema.String), manifests: Schema.Array(IndexEntry)});
export type ImageIndex = typeof ImageIndex.Type;
export const ImageManifest = Schema.Struct({config: Schema.Struct({digest: Schema.String})});
export const ImageConfig = Schema.Struct({
  os: Schema.String,
  architecture: Schema.String,
  config: Schema.optionalKey(Schema.Struct({Labels: Schema.optionalKey(Schema.NullOr(Schema.Record(Schema.String, Schema.String)))})),
});
export type ImageConfig = typeof ImageConfig.Type;

/**
 * The image manifest of each platform a lock carries, from an image index: exactly one image manifest per platform. Entries of other
 * platforms, attestations (platform unknown) and nested indexes are not images of a platform and are ignored.
 */
export const platformDigests = (index: ImageIndex): {readonly platforms: Readonly<Record<ImagePlatform, string>>} | {readonly problem: string} => {
  if (index.mediaType !== undefined && !imageIndexTypes.includes(index.mediaType)) return {problem: "it is not an image index"};
  const platforms: Partial<Record<ImagePlatform, string>> = {};
  for (const platform of imagePlatforms) {
    const {os, architecture} = platformParts[platform];
    const matches = index.manifests.filter((entry) => entry.platform !== undefined && entry.platform.os === os &&
      entry.platform.architecture === architecture && imageManifestTypes.includes(entry.mediaType));
    const [only] = matches;
    if (matches.length !== 1 || only === undefined || !digestForm.test(only.digest)) return {problem: `it does not name exactly one ${platform} image`};
    platforms[platform] = only.digest;
  }
  return {platforms: {"linux/amd64": platforms["linux/amd64"]!, "linux/arm64": platforms["linux/arm64"]!}};
};

/** What one platform image's configuration says about its release: its platform and the version and revision the release build stamps. */
export const imageIdentity = (platform: ImagePlatform, config: ImageConfig):
  {readonly version: string; readonly revision: string} | {readonly problem: string} => {
  const {os, architecture} = platformParts[platform];
  if (config.os !== os || config.architecture !== architecture) return {problem: `its configuration is not ${platform}`};
  const labels: Readonly<Record<string, string>> = config.config?.Labels ?? {};
  const version = labels["org.opencontainers.image.version"];
  const revision = labels["org.opencontainers.image.revision"];
  if (labels["org.opencontainers.image.source"] !== sourceRepository) return {problem: "it does not name the Supervisor source repository"};
  if (version === undefined || version === "" || revision === undefined || !revisionForm.test(revision))
    return {problem: "it carries no version and 40-character revision labels"};
  return {version, revision};
};

/**
 * One channel's release from what its tag names: the index digest, the platform images and their identities, and the index the
 * version's own tag names, which must be the same immutable index. Both platforms must name the same version and revision.
 */
export const imageRelease = (input: {
  readonly channel: ReleaseChannel;
  readonly index: string;
  readonly platforms: Readonly<Record<ImagePlatform, string>>;
  readonly identities: ReadonlyArray<{readonly version: string; readonly revision: string}>;
  readonly versionIndex: string;
}): LockRelease | {readonly problem: string} => {
  const [first, ...others] = input.identities;
  if (first === undefined || others.some((identity) => identity.version !== first.version || identity.revision !== first.revision))
    return {problem: "its platform images name different versions or revisions"};
  if (input.versionIndex !== input.index) return {problem: `its version's own tag ${first.version} names another index`};
  const release: LockRelease = {channel: input.channel, tag: channelTags[input.channel], version: first.version, revision: first.revision,
    index: input.index, platforms: input.platforms, npm: null};
  const problem = releaseProblem(release);
  return problem === undefined ? release : {problem};
};

const PackumentVersion = Schema.Struct({
  version: Schema.String,
  gitHead: Schema.optionalKey(Schema.String),
  dist: Schema.Struct({tarball: Schema.String, integrity: Schema.optionalKey(Schema.String)}),
});
export const Packument = Schema.Struct({versions: Schema.Record(Schema.String, PackumentVersion)});
export type Packument = typeof Packument.Type;

/**
 * npm's record of a release: the version's own tarball with its sha512 integrity, from the same source revision. Null when npm has
 * no such version; a record of another tarball or revision is a problem, since npm and the image would then differ in source.
 */
export const npmRelease = (packument: Packument, release: LockRelease): typeof NpmRelease.Type | null | {readonly problem: string} => {
  const entry = packument.versions[release.version];
  if (entry === undefined) return null;
  const integrity = entry.dist.integrity;
  if (entry.version !== release.version || entry.dist.tarball !== tarballUrl(release.version) || integrity === undefined ||
    !sha512Integrity.test(integrity) || entry.gitHead !== release.revision)
    return {problem: `npm's ${release.version} is not the image's tarball from the same revision`};
  return {tarball: entry.dist.tarball, integrity, gitHead: release.revision};
};

/** A registry did not answer as needed: a network error, a timeout or an HTTP status such as a rate limit or a server error. */
export class ReleasesUnavailable extends Data.TaggedError("ReleasesUnavailable")<{readonly message: string}> {}
/** A reply or a publication that cannot fill both channels as required; no other release is chosen instead. */
export class ReleasesInvalid extends Data.TaggedError("ReleasesInvalid")<{readonly message: string}> {}
const unavailable = (message: string) => new ReleasesUnavailable({message});
const invalid = (message: string) => new ReleasesInvalid({message});

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

// one bounded GET of exactly these bytes; a missing tag, manifest or blob is invalid, while transport failures never select another release
const fetchBytes = (url: string, headers: Readonly<Record<string, string>>, token?: Redacted.Redacted<string>) => Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;
  const request = HttpClientRequest.get(url).pipe(HttpClientRequest.setHeaders({...userAgent, ...headers}));
  const response = yield* client.execute(token === undefined ? request : HttpClientRequest.bearerToken(request, token)).pipe(
    Effect.mapError((error) => unavailable(`GET ${url} failed (${error.reason._tag})`)));
  if (response.status !== 200) {
    yield* Effect.ignore(response.arrayBuffer);
    if (response.status === 404) return yield* invalid(`GET ${url} found nothing (HTTP 404)`);
    return yield* unavailable(`GET ${url} returned HTTP ${response.status}`);
  }
  const body = yield* response.arrayBuffer.pipe(Effect.mapError((error) => unavailable(`GET ${url} broke off (${error.reason._tag})`)));
  return {headers: response.headers, bytes: new Uint8Array(body)};
}).pipe(Effect.timeoutOrElse({duration: requestTimeout, orElse: () => Effect.fail(unavailable(`GET ${url} did not answer within ${requestTimeout}`))}));

const decodeToken = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Struct({token: Schema.String})));
const decodeIndex = Schema.decodeUnknownEffect(Schema.fromJsonString(ImageIndex));
const decodeManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(ImageManifest));
const decodeConfig = Schema.decodeUnknownEffect(Schema.fromJsonString(ImageConfig));
const decodePackument = Schema.decodeUnknownEffect(Schema.fromJsonString(Packument));

/**
 * Resolves both channels from GHCR, with an anonymous pull token for the public image, then npm's record of each version. Every
 * manifest and blob read by digest must hash to that digest, and a tag's index is identified by the SHA-256 of its bytes, which must
 * match the digest GHCR declares for it. npm that cannot be read leaves both npm records empty: they serve only the separate probe.
 */
export const resolveReleases = Effect.gen(function* () {
  const tokenReply = yield* fetchBytes(tokenUrl, {});
  const token = Redacted.make((yield* decodeToken(text(tokenReply.bytes)).pipe(Effect.mapError(() => invalid("GHCR answered no pull token")))).token);
  const manifestAccept = {Accept: [...imageIndexTypes, ...imageManifestTypes].join(", ")};
  const byDigest = (kind: "manifests" | "blobs", wanted: string) => Effect.gen(function* () {
    if (!digestForm.test(wanted)) return yield* invalid(`a manifest names the malformed digest ${wanted}`);
    const reply = yield* fetchBytes(`${registryApi}/${kind}/${wanted}`, kind === "manifests" ? manifestAccept : {}, token);
    if (`sha256:${sha256(reply.bytes)}` !== wanted) return yield* invalid(`the ${kind === "manifests" ? "manifest" : "blob"} ${wanted} does not hash to its digest`);
    return reply.bytes;
  });
  const byTag = (tag: string) => Effect.gen(function* () {
    const reply = yield* fetchBytes(`${registryApi}/manifests/${tag}`, manifestAccept, token);
    const digest = `sha256:${sha256(reply.bytes)}`;
    if (Option.exists(Headers.get(reply.headers, "docker-content-digest"), (declared) => declared !== digest))
      return yield* invalid(`the digest GHCR declares for the ${tag} tag is not the digest of its bytes`);
    return {digest, bytes: reply.bytes};
  });
  const channel = (name: ReleaseChannel) => Effect.gen(function* () {
    const tag = channelTags[name];
    const index = yield* byTag(tag);
    const parsed = yield* decodeIndex(text(index.bytes)).pipe(Effect.mapError(() => invalid(`the ${tag} tag does not name an image index`)));
    const selected = platformDigests(parsed);
    if ("problem" in selected) return yield* invalid(`the ${tag} tag's index: ${selected.problem}`);
    const identities = yield* Effect.forEach(imagePlatforms, (platform) => Effect.gen(function* () {
      const manifest = yield* decodeManifest(text(yield* byDigest("manifests", selected.platforms[platform]))).pipe(
        Effect.mapError(() => invalid(`the ${tag} tag's ${platform} manifest is not an image manifest`)));
      const config = yield* decodeConfig(text(yield* byDigest("blobs", manifest.config.digest))).pipe(
        Effect.mapError(() => invalid(`the ${tag} tag's ${platform} configuration is not an image configuration`)));
      const identity = imageIdentity(platform, config);
      if ("problem" in identity) return yield* invalid(`the ${tag} tag's ${platform} image: ${identity.problem}`);
      return identity;
    }));
    const version = identities[0]?.version ?? "";
    if (!/^[0-9A-Za-z.+-]+$/u.test(version)) return yield* invalid(`the ${tag} tag's images name an unexpected version`);
    const versionIndex = yield* byTag(version);
    const release = imageRelease({channel: name, index: index.digest, platforms: selected.platforms, identities, versionIndex: versionIndex.digest});
    if ("problem" in release) return yield* invalid(`the ${tag} tag: ${release.problem}`);
    return release;
  });
  const releases = [yield* channel("stable"), yield* channel("nightly")];
  // npm's records only serve the probe: a registry that cannot be read leaves them empty, a record of another source fails
  const packument = yield* fetchBytes(packumentUrl, {Accept: "application/json"}).pipe(
    Effect.flatMap((reply) => decodePackument(text(reply.bytes)).pipe(Effect.mapError(() => invalid("npm's package record is not in the expected shape")))),
    Effect.map(Option.some),
    Effect.catchTag("ReleasesUnavailable", (error) => Effect.as(Console.error(`npm records left empty: ${error.message}`), Option.none<Packument>())));
  const withNpm = yield* Effect.forEach(releases, (release) => Effect.gen(function* () {
    if (Option.isNone(packument)) return release;
    const npm = npmRelease(packument.value, release);
    if (npm !== null && "problem" in npm) return yield* invalid(npm.problem);
    return {...release, npm};
  }));
  const lock = {resolvedAt: new Date(yield* Clock.currentTimeMillis).toISOString(), repository: imageRepository, releases: withNpm};
  return yield* Schema.decodeUnknownEffect(ReleaseLock)(lock).pipe(Effect.mapError(() => invalid("the resolved releases do not form a valid release lock")));
});

class UsageError extends Data.TaggedError("UsageError")<{readonly message: string}> {}
const usage = "usage: pnpm dev:releases resolve --out <file>";
const outcome = (error: ReleasesUnavailable | ReleasesInvalid) => error._tag === "ReleasesUnavailable" ? "unavailable" : "invalid";

const main = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const [command, option, out, ...rest] = process.argv.slice(2);
  if (command !== "resolve" || option !== "--out" || out === undefined || out === "" || rest.length > 0) return yield* new UsageError({message: usage});
  const lock = yield* resolveReleases.pipe(Effect.provide(FetchHttpClient.layer),
    Effect.tapError((error) => Console.log(JSON.stringify({outcome: outcome(error), message: error.message}))));
  const content = `${JSON.stringify(lock, null, 2)}\n`;
  yield* fs.writeFileString(out, content);
  for (const release of lock.releases)
    yield* Console.log(`${release.channel.padEnd(8)} Supervisor ${release.version}  revision ${release.revision}  index ${release.index}`);
  yield* Console.log(JSON.stringify({outcome: "resolved", lock: out, sha256: sha256(new TextEncoder().encode(content)), resolvedAt: lock.resolvedAt,
    releases: lock.releases.map(({channel, version, revision, index, npm}) => ({channel, version, revision, index, npm: npm !== null}))}));
});

if (import.meta.main) NodeRuntime.runMain(main.pipe(Effect.tapError((error) => Console.error(error._tag === "ReleasesUnavailable" || error._tag === "ReleasesInvalid"
  ? `${outcome(error)}: ${error.message}` : error.message)), Effect.provide(NodeFileSystem.layer)), {disableErrorReporting: true});
