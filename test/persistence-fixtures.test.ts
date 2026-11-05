import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { NodeFileSystem } from "@effect/platform-node";
import { describe, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { dumpDatabase, expectedDump, fixtureDatabaseNames, fixtureShapes, fixturesDirectory, materializeFixture, verifyFixtureIntegrity,
  type DatabaseDump } from "./support/persistence-fixtures.js";

// it.live: the frozen fixtures are read from the checkout and materialized into real SQLite files in temporary directories.
// The fixtures stand for files older releases wrote, so their checks use no production module: the manifest records their
// provenance and integrity, the expected dumps their layout at format 0.

const mode = (path: string): number => statSync(path).mode & 0o777;
const syntheticLabel = "synthetic fixture input, not old-binary output";
const names = (dump: DatabaseDump, type: string): ReadonlyArray<string> => dump.sqliteMaster.filter((row) => row.type === type).map((row) => row.name);
const without = (left: ReadonlyArray<string>, right: ReadonlyArray<string>): ReadonlyArray<string> => left.filter((name) => !right.includes(name));

describe("historical persistence fixtures", () => {
  it.live("each shape keeps exactly its manifest's files with their recorded SHA-256, labelled synthetic", () =>
    Effect.gen(function* () {
      const shapeDirectories = readdirSync(fixturesDirectory).filter((entry) => statSync(join(fixturesDirectory, entry)).isDirectory()).sort();
      assert.deepEqual(shapeDirectories, [...fixtureShapes].sort());
      for (const shape of fixtureShapes) {
        const manifest = yield* verifyFixtureIntegrity(shape);
        assert.equal(manifest.format, 0);
        assert.deepEqual(manifest.databases.map((database) => database.name), [...fixtureDatabaseNames]);
        assert.equal(manifest.syntheticData.label, syntheticLabel);
        for (const database of manifest.databases) {
          assert.equal(database.syntheticRows.label, syntheticLabel);
          const rows = readFileSync(join(fixturesDirectory, shape, database.rows), "utf8");
          assert.ok(rows.startsWith("-- SYNTHETIC fixture input, not old-binary output"), `${shape}/${database.rows} starts with its synthetic label`);
          // the schema file holds the old statements only: no comment, and none of them writes the format marker
          const schema = readFileSync(join(fixturesDirectory, shape, database.schema), "utf8");
          assert.ok(!schema.includes("--") && !/user_version/iu.test(schema) && !/user_version/iu.test(rows), `${shape}/${database.schema} sets no format`);
        }
      }
    }));

  it.live("materialized files are format 0 with the frozen layout, the old journal modes and private modes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dumps: Record<string, Record<string, DatabaseDump>> = {};
      for (const shape of fixtureShapes) {
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-supervisor-fixture-" });
        const materialized = yield* materializeFixture(shape, directory);
        assert.equal(mode(directory), 0o700);
        assert.equal(mode(join(directory, "access")), 0o700);
        const byName: Record<string, DatabaseDump> = {};
        for (const file of materialized.files) {
          assert.equal(mode(file.absolutePath), 0o600, `${shape}/${file.path} is private`);
          for (const sidecar of ["-wal", "-shm", "-journal"]) assert.ok(!existsSync(`${file.absolutePath}${sidecar}`), `${shape}/${file.path}${sidecar} was removed`);
          const dump = yield* dumpDatabase(file.absolutePath);
          assert.equal(dump.userVersion, 0, `${shape}/${file.path} is format 0`);
          assert.equal(dump.journalMode, file.journalMode);
          const { database, ...expected } = yield* expectedDump(shape, file.name);
          assert.equal(database, file.path);
          assert.deepEqual(dump, expected, `${shape}/${file.path} matches its frozen dump`);
          byName[file.name] = dump;
        }
        dumps[shape] = byName;
        // a second materialization into the same directory is refused instead of overwriting the files
        const refused = yield* Effect.flip(materializeFixture(shape, directory));
        assert.match(refused.reason, /already exists/u);
      }

      // the two layouts differ exactly by the later table additions, as their names say
      const current = dumps["format0-current-unversioned"];
      const older = dumps["format0-pre-coverage-pre-planning"];
      assert.ok(current && older);
      const pick = (layout: Record<string, DatabaseDump>, name: string): DatabaseDump => {
        const dump = layout[name];
        assert.ok(dump, name);
        return dump;
      };
      assert.deepEqual(without(names(pick(current, "catalog"), "table"), names(pick(older, "catalog"), "table")), ["shell_coverage"]);
      assert.deepEqual(without(names(pick(current, "guidance"), "table"), names(pick(older, "guidance"), "table")), ["supervisor_planning_attempts"]);
      assert.deepEqual(without(names(pick(current, "guidance"), "index"), names(pick(older, "guidance"), "index")),
        ["sqlite_autoindex_supervisor_planning_attempts_1", "supervisor_planning_project"]);
      for (const name of fixtureDatabaseNames) {
        assert.deepEqual(without(names(pick(older, name), "table"), names(pick(current, name), "table")), [], `${name}: no table only in the older layout`);
        assert.deepEqual(without(names(pick(older, name), "index"), names(pick(current, name), "index")), [], `${name}: no index only in the older layout`);
      }
      assert.deepEqual(pick(current, "thread-settings").sqliteMaster, pick(older, "thread-settings").sqliteMaster);
      assert.deepEqual(pick(current, "access-login").sqliteMaster, pick(older, "access-login").sqliteMaster);
    }).pipe(Effect.provide(NodeFileSystem.layer)));

  it.live("the fixture support and this suite import nothing from src/", () =>
    Effect.sync(() => {
      const allowed = new Set(["effect", "@effect/platform-node", "@effect/vitest", "./support/persistence-fixtures.js"]);
      for (const url of [new URL("./support/persistence-fixtures.ts", import.meta.url), new URL(import.meta.url)]) {
        const text = readFileSync(fileURLToPath(url), "utf8");
        const specifiers = [...text.matchAll(/\b(?:from|import)\s*\(?\s*["']([^"']+)["']/gu)].map((match) => match[1] ?? "");
        assert.ok(specifiers.length > 0);
        for (const specifier of specifiers)
          assert.ok(specifier.startsWith("node:") || allowed.has(specifier), `${fileURLToPath(url)} imports ${specifier}`);
      }
    }));
});
