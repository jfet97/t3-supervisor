import { Effect } from "effect";
import type { BuildFacts, T3Environment, T3Operation, VerifiedBuild } from "./contracts.js";
import { T3Unsupported } from "./errors.js";

/**
 * The T3 builds this Supervisor was verified against: only the pinned published nightly the local stack downloads
 * (scripts/local-stack.ts `t3Release`). No operation is recorded absent, so every operation uses the one current implementation.
 * There is no version matrix: an unknown build keeps today's behavior with the same implementation.
 */
export const verifiedBuilds: ReadonlyArray<VerifiedBuild> = [
  {serverVersion: "0.1.7-nightly.20261101.4016", source: "scripts/local-stack.ts t3Release", absent: []},
];

/**
 * The facts an environment descriptor selects. serverVersion is metadata T3 reported over HTTP; every native request opens its own
 * socket, so it is not proof of the build that executes that request.
 */
export const buildFacts = (environment: T3Environment, builds: ReadonlyArray<VerifiedBuild> = verifiedBuilds): BuildFacts => ({
  environmentId: environment.environmentId,
  serverVersion: environment.serverVersion,
  orchestrationProtocolVersion: environment.orchestrationProtocolVersion,
  verified: builds.some((build) => build.serverVersion === environment.serverVersion),
});

/**
 * The translation selection of an operation, without I/O: unsupported only where the observed build is a verified build that records
 * the operation as absent. Before any descriptor was read, and for an unknown build, the one current implementation applies. This
 * selection rests on the HTTP-reported version, not on proof of the build a native socket reaches.
 */
export const selectTranslation = (operation: T3Operation, facts: BuildFacts | null,
  builds: ReadonlyArray<VerifiedBuild> = verifiedBuilds): Effect.Effect<void, T3Unsupported> => {
  if (facts === null) return Effect.void;
  const build = builds.find((candidate) => candidate.serverVersion === facts.serverVersion);
  return build !== undefined && build.absent.includes(operation)
    ? Effect.fail(new T3Unsupported({operation, serverVersion: facts.serverVersion}))
    : Effect.void;
};
