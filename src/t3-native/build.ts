import { Effect } from "effect";
import type { BuildFacts, ReferenceBuild, T3Environment, T3Operation } from "./contracts.js";
import { T3Unsupported } from "./errors.js";

/**
 * The builds the reference profile was captured from: only the pinned published nightly the local stack downloads
 * (scripts/local-stack.ts `t3Release`), whose published source (pingdotgg/t3code at that tag) the contracts were read from. It is a
 * captured reference, not a claim that every operation or provider workflow was tested live on that build. No operation is recorded
 * absent, so every operation uses the one current implementation; there is no version matrix, and any other build keeps today's
 * behavior with the same implementation.
 */
export const referenceBuilds: ReadonlyArray<ReferenceBuild> = [
  {serverVersion: "0.1.7-nightly.20261101.4016", source: "scripts/local-stack.ts t3Release", absent: []},
];

/**
 * The facts an environment descriptor selects. serverVersion is metadata T3 reported over HTTP; every native request opens its own
 * socket, so it is not proof of the build that executes that request. referenceBuild says only that this version is the build a
 * reference profile was captured from.
 */
export const buildFacts = (environment: T3Environment, builds: ReadonlyArray<ReferenceBuild> = referenceBuilds): BuildFacts => ({
  environmentId: environment.environmentId,
  serverVersion: environment.serverVersion,
  orchestrationProtocolVersion: environment.orchestrationProtocolVersion,
  referenceBuild: builds.some((build) => build.serverVersion === environment.serverVersion),
});

/**
 * The translation selection of an operation, without I/O: unsupported only where the observed build is a reference build whose
 * profile records the operation as absent. Before any descriptor was read, and for any other build, the one current implementation
 * applies. This selection rests on the HTTP-reported version, not on proof of the build a native socket reaches.
 */
export const selectTranslation = (operation: T3Operation, facts: BuildFacts | null,
  builds: ReadonlyArray<ReferenceBuild> = referenceBuilds): Effect.Effect<void, T3Unsupported> => {
  if (facts === null) return Effect.void;
  const build = builds.find((candidate) => candidate.serverVersion === facts.serverVersion);
  return build !== undefined && build.absent.includes(operation)
    ? Effect.fail(new T3Unsupported({operation, serverVersion: facts.serverVersion}))
    : Effect.void;
};
