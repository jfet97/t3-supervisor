import { NodeCrypto } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/http";
import type { NativeEnvelope } from "../../src/native-envelope.js";
import { ProjectCommitter, ProjectFiles, ProjectWriter } from "../../src/project-files.js";
import { NativeRpc, NativeShell } from "../../src/supervisor-native.js";
import { T3Client } from "../../src/t3.js";
import { T3Native } from "../../src/t3-native/index.js";

/**
 * The production T3Native of a run whose file, commit and probe credentials reach a loopback peer, as the composition root builds it
 * (src/guidance-application.ts), on the native envelope in the caller's context: each token given becomes its credential's family,
 * and the read credential is always present. The file, commit and probe suites never reach the orchestration clients, so those are
 * absent and a call to one is a defect.
 */

/** The bearer tokens of the credentials a suite configures; an absent optional token leaves its family null. */
export interface FileTokens {
  readonly read?: string | undefined;
  readonly projectWrite?: string | undefined;
  readonly commit?: string | undefined;
  readonly probe?: string | undefined;
}

const unused = (client: string) => Effect.die(new Error(`unused ${client} in a native file suite`));

// the orchestration clients and the webhook transport T3Native wraps, none of which a file or probe suite reaches
const absentOrchestration = Layer.mergeAll(
  Layer.succeed(T3Client, T3Client.of({descriptor: () => unused("T3 descriptor"), projection: () => unused("T3 projection"),
    watch: () => unused("T3 watch"), watchThread: () => unused("T3 thread watch")})),
  Layer.succeed(NativeRpc, NativeRpc.of({call: () => unused("native read"), initiate: () => unused("native read")})),
  Layer.succeed(NativeShell, NativeShell.of({baseline: unused("native shell baseline"), threads: unused("native lineage")})),
  FetchHttpClient.layer, NodeCrypto.layer);

/** The run's T3Native over the peer at `baseUrl` with the given credentials, on the native envelope in context. */
export const fileNative = (baseUrl: string, tokens: FileTokens): Effect.Effect<T3Native["Service"], never, NativeEnvelope> => {
  const endpoint = (token: string | undefined) => token === undefined ? undefined : {baseUrl, token};
  return T3Native.make({baseUrl, read: {baseUrl, token: tokens.read ?? "read-token"}, projectWrite: endpoint(tokens.projectWrite),
    commit: endpoint(tokens.commit), probe: endpoint(tokens.probe)}).pipe(Effect.provide(absentOrchestration));
};

/** The production file client over the read credential at `baseUrl`. */
export const nativeProjectFiles = (baseUrl: string, token = "read-token") =>
  Effect.flatMap(fileNative(baseUrl, {read: token}), (native) => ProjectFiles.make(native.files.read));

/** The production writer over the project-write credential at `baseUrl`. */
export const nativeProjectWriter = (baseUrl: string, token = "write-token") =>
  Effect.flatMap(fileNative(baseUrl, {projectWrite: token}), (native) => ProjectWriter.make(native.files.write!));

/** The production committer over the commit credential at `baseUrl`. */
export const nativeProjectCommitter = (baseUrl: string, token = "commit-token") =>
  Effect.flatMap(fileNative(baseUrl, {commit: token}), (native) => ProjectCommitter.make(native.files.commit!));
