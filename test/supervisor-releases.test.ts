import assert from "node:assert/strict";
import { describe, it } from "@effect/vitest";
import { Effect } from "effect";
import {
  channelRelease, decodeReleaseLock, type ImageConfig, imageIdentity, type ImageIndex, imageReference, imageRelease, type LockRelease, npmRelease,
  type Packument, platformDigests, sourceRepository, tarballUrl,
} from "../scripts/supervisor-releases.js";

/*
 * The resolution of the published Supervisor releases the upgrade journeys start from (scripts/supervisor-releases.ts), over
 * constructed registry documents: each channel is the image index its GHCR tag names, exactly one image per Linux platform, both
 * platforms stamped with one version and revision, that version's own tag naming the same index, and npm's record of the same
 * source. Nothing here contacts a registry.
 */

const digest = (character: string) => `sha256:${character.repeat(64)}`;
const integrity = `sha512-${"A".repeat(86)}==`;
const stableRevision = "4".repeat(40);
const nightlyRevision = "5".repeat(40);
const nightlyVersion = `0.0.28-nightly.20261105031700.g${"5".repeat(12)}`;

const stablePlatforms = {"linux/amd64": digest("b"), "linux/arm64": digest("c")};
const nightlyPlatforms = {"linux/amd64": digest("e"), "linux/arm64": digest("f")};
const stableNpm = {tarball: tarballUrl("0.0.27"), integrity, gitHead: stableRevision};
const stable: LockRelease = {channel: "stable", tag: "latest", version: "0.0.27", revision: stableRevision, index: digest("a"), platforms: stablePlatforms, npm: stableNpm};
const nightly: LockRelease = {channel: "nightly", tag: "nightly", version: nightlyVersion, revision: nightlyRevision, index: digest("d"), platforms: nightlyPlatforms, npm: null};
const lockText = (releases: ReadonlyArray<unknown>, repository = "ghcr.io/jfet97/t3-supervisor") =>
  JSON.stringify({resolvedAt: "2026-11-05T06:11:00.000Z", repository, releases});

const index = (manifests: ImageIndex["manifests"]): ImageIndex => ({mediaType: "application/vnd.oci.image.index.v1+json", manifests});
const image = (architecture: string, character: string) =>
  ({mediaType: "application/vnd.oci.image.manifest.v1+json", digest: digest(character), platform: {os: "linux", architecture}});
const attestation = (character: string) =>
  ({mediaType: "application/vnd.oci.image.manifest.v1+json", digest: digest(character), platform: {os: "unknown", architecture: "unknown"}});
const config = (architecture: string, labels: Readonly<Record<string, string>> | null): ImageConfig =>
  ({os: "linux", architecture, config: {Labels: labels}});
const labels = (version: string, revision: string) =>
  ({"org.opencontainers.image.version": version, "org.opencontainers.image.revision": revision, "org.opencontainers.image.source": sourceRepository});

describe("the image a channel's tag names", () => {
  it("is one image manifest per Linux platform, whatever attestations the index also lists", () => {
    assert.deepEqual(platformDigests(index([image("amd64", "b"), attestation("1"), image("arm64", "c"), attestation("2")])),
      {platforms: {"linux/amd64": digest("b"), "linux/arm64": digest("c")}});
    assert.deepEqual(platformDigests(index([image("amd64", "b")])), {problem: "it does not name exactly one linux/arm64 image"});
    assert.deepEqual(platformDigests(index([image("amd64", "b"), image("amd64", "9"), image("arm64", "c")])), {problem: "it does not name exactly one linux/amd64 image"});
    assert.deepEqual(platformDigests({mediaType: "application/vnd.oci.image.manifest.v1+json", manifests: []}), {problem: "it is not an image index"});
    // a nested index is no image of a platform
    assert.deepEqual(platformDigests(index([{...image("amd64", "b"), mediaType: "application/vnd.oci.image.index.v1+json"}, image("arm64", "c")])),
      {problem: "it does not name exactly one linux/amd64 image"});
  });

  it("is identified by the version, revision and source its release build stamps, on its own platform", () => {
    assert.deepEqual(imageIdentity("linux/arm64", config("arm64", labels("0.0.27", stableRevision))), {version: "0.0.27", revision: stableRevision});
    assert.deepEqual(imageIdentity("linux/amd64", config("arm64", labels("0.0.27", stableRevision))), {problem: "its configuration is not linux/amd64"});
    assert.deepEqual(imageIdentity("linux/amd64", config("amd64", null)), {problem: "it does not name the Supervisor source repository"});
    assert.deepEqual(imageIdentity("linux/amd64", config("amd64", {...labels("0.0.27", "unknown")})), {problem: "it carries no version and 40-character revision labels"});
  });
});

describe("a channel's release", () => {
  const identities = (version: string, revision: string) => [{version, revision}, {version, revision}];

  it("freezes the index, both platform images and the version and revision they share", () => {
    assert.deepEqual(imageRelease({channel: "stable", index: digest("a"), platforms: stablePlatforms, identities: identities("0.0.27", stableRevision),
      versionIndex: digest("a")}), {...stable, npm: null});
    assert.deepEqual(imageRelease({channel: "nightly", index: digest("d"), platforms: nightlyPlatforms, identities: identities(nightlyVersion, nightlyRevision),
      versionIndex: digest("d")}), nightly);
  });

  it("is refused when the platforms disagree, the version's tag names another index or the version does not fit the channel", () => {
    const platforms = stablePlatforms;
    assert.deepEqual(imageRelease({channel: "stable", index: digest("a"), platforms, identities: [{version: "0.0.27", revision: stableRevision},
      {version: "0.0.26", revision: stableRevision}], versionIndex: digest("a")}), {problem: "its platform images name different versions or revisions"});
    assert.deepEqual(imageRelease({channel: "stable", index: digest("a"), platforms, identities: identities("0.0.27", stableRevision), versionIndex: digest("9")}),
      {problem: "its version's own tag 0.0.27 names another index"});
    assert.deepEqual(imageRelease({channel: "stable", index: digest("a"), platforms, identities: identities(nightlyVersion, nightlyRevision), versionIndex: digest("a")}),
      {problem: "the stable release's version is not <major>.<minor>.<patch>"});
    // a nightly names its own revision's first twelve characters
    assert.deepEqual(imageRelease({channel: "nightly", index: digest("d"), platforms, identities: identities(nightlyVersion, stableRevision), versionIndex: digest("d")}),
      {problem: "the nightly release's version is not <major>.<minor>.<patch>-nightly.<timestamp>.g<its revision>"});
  });

  it("carries npm's record of the same version only when npm holds that very tarball from the same revision", () => {
    const packument = (gitHead: string | undefined, recordedIntegrity: string | undefined = integrity): Packument => ({versions: {"0.0.27": {version: "0.0.27",
      ...(gitHead === undefined ? {} : {gitHead}), dist: {tarball: tarballUrl("0.0.27"), ...(recordedIntegrity === undefined ? {} : {integrity: recordedIntegrity})}}}});
    const release = {...stable, npm: null};
    assert.deepEqual(npmRelease(packument(stableRevision), release), stableNpm);
    assert.equal(npmRelease({versions: {}}, release), null);
    assert.deepEqual(npmRelease(packument(nightlyRevision), release), {problem: "npm's 0.0.27 is not the image's tarball from the same revision"});
    assert.deepEqual(npmRelease(packument(stableRevision, "sha1-abc"), release), {problem: "npm's 0.0.27 is not the image's tarball from the same revision"});
  });
});

describe("the release lock", () => {
  it.effect("holds exactly stable and nightly, in this order, each with its image digests", () => Effect.gen(function* () {
    const lock = yield* decodeReleaseLock(lockText([stable, nightly]));
    assert.deepEqual(channelRelease(lock, "nightly"), nightly);
    assert.equal(imageReference(channelRelease(lock, "stable"), "linux/arm64"), `ghcr.io/jfet97/t3-supervisor@${digest("c")}`);
  }));

  it.effect("is refused with a fixed message for any broken rule, never repeating its text", () => Effect.gen(function* () {
    const refused = (text: string) => Effect.map(Effect.flip(decodeReleaseLock(text, "release lock L")), (error) => error.message);
    assert.match(yield* refused("{\"secret\":"), /release lock L is not JSON in the shape of a release lock/u);
    assert.match(yield* refused(lockText([nightly, stable])), /its releases are not exactly stable and nightly in this order/u);
    assert.match(yield* refused(lockText([stable, nightly], "ghcr.io/someone/else")), /it does not name the official image repository/u);
    assert.match(yield* refused(lockText([{...stable, index: "sha256:short"}, nightly])), /the stable release names no sha256 index digest/u);
    assert.match(yield* refused(lockText([{...stable, platforms: {"linux/amd64": digest("b")}}, nightly])), /does not carry exactly a linux\/amd64 and a linux\/arm64/u);
    assert.match(yield* refused(lockText([stable, {...nightly, tag: "latest"}])), /the nightly release is not named by the nightly tag/u);
    assert.match(yield* refused(lockText([{...stable, npm: {...stableNpm, gitHead: nightlyRevision}}, nightly])), /npm's record of the stable release/u);
    assert.doesNotMatch(yield* refused(lockText([{...stable, index: "sha256:short"}, nightly])), /sha256:short/u);
  }));
});
