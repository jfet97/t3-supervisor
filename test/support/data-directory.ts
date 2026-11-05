import { NodeFileSystem } from "@effect/platform-node";
import { Effect } from "effect";
import { type DatabaseUpgradeError, upgradeDataDirectory } from "../../src/database-upgrade.js";

/**
 * Prepares `directory` as a fresh current-format data directory through the production startup coordinator: catalog,
 * guidance and thread-settings at their current formats, the policy seeded with `excludedThreadIds` at generation 1. The
 * access database is left to the auth service's own bootstrap. Stores only open files the coordinator prepared, so a test
 * that opens them on a temporary directory calls this first.
 */
export const initializeDataDirectory = (directory: string, options: { readonly excludedThreadIds?: ReadonlyArray<string> } = {}):
  Effect.Effect<void, DatabaseUpgradeError> =>
  upgradeDataDirectory({ dataDirectory: directory, excludedThreadIds: options.excludedThreadIds ?? [] }).pipe(
    Effect.asVoid,
    Effect.provide(NodeFileSystem.layer),
  );
