import { join } from "node:path";
import { NodeFileSystem } from "@effect/platform-node";
import { Effect, FileSystem } from "effect";
import { type DatabaseUpgradeError, upgradeDataDirectory } from "../../src/database-upgrade.js";

const storeFiles = ["catalog.sqlite3", "guidance.sqlite3", "thread-settings.sqlite3"] as const;

/*
 * the files the production startup upgrade writes for a fresh directory, kept per test module and excluded-chat list: no file
 * records its directory, so every later fresh directory gets exactly the bytes the coordinator would write there again,
 * without starting its database workers for each test. The startup upgrade itself is tested on its own, from frozen
 * historical inputs (database-upgrade.test.ts and the other database-* tests call it directly).
 */
const freshFiles = new Map<string, ReadonlyArray<readonly [string, Uint8Array]>>();

const writtenByTheCoordinator = (excludedThreadIds: ReadonlyArray<string>) => Effect.gen(function* () {
  const key = JSON.stringify(excludedThreadIds);
  const known = freshFiles.get(key);
  if (known !== undefined) return known;
  const files = yield* Effect.scoped(Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-supervisor-fresh-" }).pipe(Effect.orDie);
    yield* upgradeDataDirectory({ dataDirectory: directory, excludedThreadIds });
    return yield* Effect.forEach(storeFiles, (file) => fs.readFile(join(directory, file)).pipe(
      Effect.map((bytes): readonly [string, Uint8Array] => [file, bytes]), Effect.orDie));
  }));
  freshFiles.set(key, files);
  return files;
});

/**
 * Prepares `directory` as a fresh current-format data directory as the production startup coordinator does: catalog,
 * guidance and thread-settings at their current formats, the policy seeded with `excludedThreadIds` at generation 1, the
 * directory 0700 and the files 0600. The access database is left to the auth service's own bootstrap. Stores only open files
 * the coordinator prepared, so a test that opens them on a temporary directory calls this first. A directory that already
 * holds a store file or an access database goes through the coordinator itself.
 */
export const initializeDataDirectory = (directory: string, options: { readonly excludedThreadIds?: ReadonlyArray<string> } = {}):
  Effect.Effect<void, DatabaseUpgradeError> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const excludedThreadIds = options.excludedThreadIds ?? [];
    const existing = yield* Effect.forEach([...storeFiles, join("access", "login.sqlite3")], (file) => fs.exists(join(directory, file))).pipe(Effect.orDie);
    if (existing.some((present) => present)) return yield* Effect.asVoid(upgradeDataDirectory({ dataDirectory: directory, excludedThreadIds }));
    const files = yield* writtenByTheCoordinator(excludedThreadIds);
    yield* Effect.gen(function* () {
      yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
      yield* fs.chmod(directory, 0o700);
      for (const [file, bytes] of files) {
        yield* fs.writeFile(join(directory, file), bytes, { flag: "wx", mode: 0o600 });
        yield* fs.chmod(join(directory, file), 0o600);
      }
    }).pipe(Effect.orDie);
  }).pipe(Effect.provide(NodeFileSystem.layer));
