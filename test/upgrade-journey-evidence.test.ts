import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { referenceSignature } from "../src/database-upgrade.js";
import { DatabaseFormats } from "../src/db.js";
import {
  type BackupManifest, type BackupObservation, backupProblems, catalogIdentities, changingFiles, contractMismatch, type DatabaseFile, databaseFiles, eventLines,
  type FileRows, type FileShape, type Formats, journeyOutcome, requiredMeta, rowDifferences, SeedFile, seedLabel, selectSeedSet, startupFailure, statementTable,
  upgradeEventProblems,
} from "../scripts/upgrade-journey-evidence.js";
import { expectedDumpSync, fixturesDirectory } from "./support/persistence-fixtures.js";

/*
 * The judgements of the published upgrade journeys (scripts/upgrade-journey-evidence.ts) over constructed shapes, rows and events: the
 * seed set a persisted format and structural contract selects, the backup and log events a start must leave and the rows it must keep.
 * The frozen seed sets are checked against the frozen 0.0.27 layout they were copied from and their format 1 contract against the
 * candidate's declared schema; the journeys themselves run only in the Docker environment (./dev upgrade).
 */

const seeds = Schema.decodeUnknownSync(Schema.fromJsonString(SeedFile))(readFileSync(new URL("./fixtures/upgrade-journeys/seed-sets.json", import.meta.url), "utf8"));
const current: Formats = {
  "access/login.sqlite3": DatabaseFormats.access, "catalog.sqlite3": DatabaseFormats.catalog,
  "guidance.sqlite3": DatabaseFormats.guidance, "thread-settings.sqlite3": DatabaseFormats.policy,
};
const compact = (sql: string) => sql.replace(/\s+/gu, "");
const setOf = (format: number) => {
  const set = seeds.sets.find((candidate) => candidate.format === format);
  assert.ok(set !== undefined, `the seed sets hold one for format ${format}`);
  return set;
};
const formatZero = setOf(0);
const formatOne = setOf(1);
const omit = <V>(record: Readonly<Record<string, V>>, key: string): Readonly<Record<string, V>> =>
  Object.fromEntries(Object.entries(record).filter(([name]) => name !== key));

// the guidance file as a journey reads it, by default with exactly what the format 0 set requires
const guidance = (format: number, changes: {readonly declarations?: Readonly<Record<string, string>>; readonly meta?: Readonly<Record<string, string>>} = {}): FileShape =>
  ({file: "guidance.sqlite3", present: true, format, declarations: changes.declarations ?? formatZero.requires.declarations, meta: changes.meta ?? formatZero.requires.meta});
const directory = (format: number, guidanceShape: FileShape = guidance(format)): ReadonlyArray<FileShape> => [
  ...(["access/login.sqlite3", "catalog.sqlite3", "thread-settings.sqlite3"] as const).map((file): FileShape => ({file, present: true, format, declarations: {}, meta: {}})),
  guidanceShape,
];

describe("the frozen seed sets", () => {
  it("are labelled fixture input, copied verbatim from the frozen 0.0.27 rows, and write only the tables their contracts declare", () => {
    assert.equal(seeds.label, seedLabel);
    const frozen = readFileSync(join(fixturesDirectory, "format0-current-unversioned", "guidance.rows.sql"), "utf8").split("\n");
    assert.deepEqual(seeds.sets.map((set) => [set.file, set.format]), [["guidance.sqlite3", 0], ["guidance.sqlite3", 1]]);
    for (const set of seeds.sets) {
      const statements = seeds.statements[set.statements];
      assert.ok(statements !== undefined && statements.length > 0, set.id);
      for (const statement of statements) {
        assert.ok(frozen.includes(statement), `${set.id}: ${statement.slice(0, 60)} is a frozen 0.0.27 row`);
        const table = statementTable(statement);
        assert.ok(table !== undefined && set.requires.declarations[`table:${table}`] !== undefined, `${set.id} declares the table ${table}`);
      }
      assert.deepEqual(set.requires.meta, {supervisor_scope_version: "main-v1"});
    }
    assert.deepEqual(requiredMeta(seeds, "guidance.sqlite3"), ["supervisor_scope_version"]);
    assert.deepEqual(requiredMeta(seeds, "catalog.sqlite3"), []);
  });

  it("bind format 0 to the declarations of the frozen 0.0.27 layout", () => {
    const dump = expectedDumpSync("format0-current-unversioned", "guidance");
    for (const [key, declaration] of Object.entries(formatZero.requires.declarations)) {
      const frozen = dump.sqliteMaster.find((row) => `${row.type}:${row.name}` === key);
      assert.ok(frozen?.sql !== undefined && frozen.sql !== null, `the frozen layout declares ${key}`);
      assert.equal(compact(frozen.sql), compact(declaration), key);
    }
  });

  it.live("bind format 1 to the candidate's declared guidance schema", () => Effect.gen(function* () {
    const reference = yield* referenceSignature("guidance");
    for (const [key, declaration] of Object.entries(formatOne.requires.declarations)) assert.equal(reference.get(key), compact(declaration), key);
  }));
});

describe("seed set selection", () => {
  it("chooses the set of the persisted format and structural contract, never a release name", () => {
    const zero = selectSeedSet(seeds, directory(0), current);
    assert.equal(zero.kind === "recognized" ? zero.set.id : zero.reason, "format0-supervision-history");
    assert.equal(zero.kind === "recognized" ? zero.statements.length : 0, 7);
    const one = selectSeedSet(seeds, directory(1), current);
    assert.equal(one.kind === "recognized" ? one.set.id : one.reason, "format1-supervision-history");
  });

  it("fails visibly on a newer format, a changed declaration, a missing table or scope version and a missing file", () => {
    const unsupported = (shapes: ReadonlyArray<FileShape>) => {
      const selection = selectSeedSet(seeds, shapes, current);
      assert.equal(selection.kind, "unsupported");
      return selection.kind === "unsupported" ? selection.reason : "";
    };
    assert.match(unsupported(directory(1, guidance(2))), /guidance\.sqlite3 has format 2, newer than format 1/u);
    const widened = {...formatZero.requires.declarations, "table:supervisor_owned_threads": "CREATE TABLE supervisor_owned_threads(id TEXT PRIMARY KEY, extra TEXT)"};
    assert.match(unsupported(directory(0, guidance(0, {declarations: widened}))), /declares table:supervisor_owned_threads differently/u);
    const withoutEvidence = omit(formatZero.requires.declarations, "table:supervisor_workflow_write_evidence");
    assert.match(unsupported(directory(0, guidance(0, {declarations: withoutEvidence}))), /has no table:supervisor_workflow_write_evidence/u);
    assert.match(unsupported(directory(0, guidance(0, {meta: {}}))), /has no meta supervisor_scope_version/u);
    const withoutAccess = directory(0).map((shape): FileShape => shape.file === "access/login.sqlite3" ? {...shape, present: false, format: null} : shape);
    assert.match(unsupported(withoutAccess), /access\/login\.sqlite3 is missing/u);
    // whitespace alone never changes a declaration
    const spaced = Object.fromEntries(Object.entries(formatZero.requires.declarations).map(([key, value]) => [key, value.replaceAll(",", ",\n  ")]));
    assert.equal(contractMismatch(formatZero, guidance(0, {declarations: spaced})), undefined);
  });
});

const row = (values: Readonly<Record<string, string | bigint | null>>) => Object.fromEntries(Object.entries(values).map(([column, value]) =>
  [column, value === null ? null : typeof value === "bigint" ? {i: value.toString()} : {s: value}] as const));
const rows: FileRows = {
  meta: [row({key: "supervisor_scope_version", value: "main-v1"})],
  supervisor_owned_threads: [row({id: "supervisor-root:1"})],
  supervisor_workflow_write_evidence: [row({item_id: "item-1", native_evidence: "{\"kept\":true}", binding_generation: 1n})],
};

describe("stored rows", () => {
  it("are compared byte for byte: a changed byte or integer, a dropped or added row and a dropped table are differences", () => {
    assert.deepEqual(rowDifferences(rows, rows), []);
    assert.deepEqual(rowDifferences(rows, {...rows, supervisor_workflow_write_evidence: [row({item_id: "item-1", native_evidence: "{\"kept\": true}", binding_generation: 1n})]}),
      ["supervisor_workflow_write_evidence row(s) 1 changed"]);
    assert.deepEqual(rowDifferences(rows, {...rows, supervisor_workflow_write_evidence: [row({item_id: "item-1", native_evidence: "{\"kept\":true}", binding_generation: 2n})]}),
      ["supervisor_workflow_write_evidence row(s) 1 changed"]);
    assert.deepEqual(rowDifferences(rows, {...rows, supervisor_owned_threads: []}), ["supervisor_owned_threads holds 0 rows instead of 1"]);
    assert.deepEqual(rowDifferences(rows, omit(rows, "meta")), ["table meta is gone"]);
    // a start may add tables and columns with their defaults, never rows; a backup copy must hold exactly the tables it had
    const widened = {...rows, added: [], meta: [{...row({key: "supervisor_scope_version", value: "main-v1"}), added: null}]};
    assert.deepEqual(rowDifferences(rows, widened), []);
    assert.deepEqual(rowDifferences(rows, widened, false), ["table added was added"]);
  });

  it("of the catalog keep their identities when a start rebuilds documents from T3", () => {
    const catalog = (thread: string, document: string): FileRows => ({
      environment_binding: [row({environment_id: "environment-1"})], activations: [row({environment_id: "environment-1"})],
      projects: [row({id: "project-1", document})], threads: [row({id: thread, project_id: "project-1", document})],
    });
    assert.deepEqual(catalogIdentities(catalog("thread-1", "{\"a\":1}")), catalogIdentities(catalog("thread-1", "{\"b\":2}")));
    assert.notDeepEqual(catalogIdentities(catalog("thread-1", "{}")), catalogIdentities(catalog("thread-2", "{}")));
  });
});

const before: Readonly<Partial<Record<DatabaseFile, FileRows>>> = Object.fromEntries(databaseFiles.map((file) => [file, rows] as const));
const manifestOf = (set: string, files: ReadonlyArray<{readonly file: DatabaseFile; readonly format: number}>): BackupManifest => ({
  kind: "t3-supervisor-backup", manifestFormat: 1, backupSet: set,
  files: files.map(({file, format}) => ({file, backup: file.replace("/", "-"), format, targetFormat: 1, sha256: `${file}-digest`, integrity: "ok"})),
});
const observation = (changes: Partial<BackupObservation> = {}): BackupObservation => ({
  setsBefore: [], setsAfter: ["20261105T120000Z-1a2b3c4d"],
  manifest: manifestOf("20261105T120000Z-1a2b3c4d", databaseFiles.map((file) => ({file, format: 0}))),
  copies: Object.fromEntries(databaseFiles.map((file) => [file.replace("/", "-"), {sha256: `${file}-digest`, format: 0, rows}] as const)),
  ...changes,
});

describe("the backup a start leaves", () => {
  const expected = changingFiles(directory(0), current);

  it("names every file at an older format with its format, and none at the current formats", () => {
    assert.deepEqual(expected.map((change) => [change.file, change.format, change.targetFormat]), databaseFiles.map((file) => [file, 0, 1]));
    assert.deepEqual(changingFiles(directory(1), current), []);
  });

  it("is exactly one new verified set whose copies hold the files as they were", () => {
    assert.deepEqual(backupProblems(expected, before, observation()), []);
    assert.deepEqual(backupProblems(expected, before, observation({setsAfter: []})), ["expected exactly one new backup set, found 0"]);
    assert.deepEqual(backupProblems(expected, before, observation({setsAfter: ["a", "b"]})), ["expected exactly one new backup set, found 2"]);
    assert.match(backupProblems(expected, before, observation({manifest: null})).join(), /has no readable manifest naming it/u);
    assert.match(backupProblems(expected, before, observation({manifest: manifestOf("20261105T120000Z-1a2b3c4d",
      databaseFiles.slice(1).map((file) => ({file, format: 0})))})).join(), /instead of access\/login\.sqlite3, catalog\.sqlite3/u);
    assert.match(backupProblems(expected, before, observation({manifest: manifestOf("20261105T120000Z-1a2b3c4d",
      databaseFiles.map((file) => ({file, format: file === "guidance.sqlite3" ? 1 : 0})))})).join(), /records guidance\.sqlite3 at format 1 to 1 instead of 0 to 1/u);
    const tampered = {...observation().copies, "guidance.sqlite3": {sha256: "other", format: 0, rows: {...rows, supervisor_owned_threads: []}}};
    const problems = backupProblems(expected, before, observation({copies: tampered})).join("; ");
    assert.match(problems, /the copy guidance\.sqlite3 does not have its recorded SHA-256/u);
    assert.match(problems, /does not hold guidance\.sqlite3 as it was/u);
    assert.match(backupProblems(expected, before, observation({setsBefore: ["earlier"], setsAfter: ["20261105T120000Z-1a2b3c4d"]})).join(), /earlier backup set\(s\) earlier disappeared/u);
  });

  it("is none at the current formats, where any new set is a redundant backup", () => {
    assert.deepEqual(backupProblems([], before, observation({setsAfter: [], manifest: null, copies: {}})), []);
    assert.match(backupProblems([], before, observation()).join(), /a start at the current formats wrote the backup set/u);
  });
});

describe("the candidate's own events", () => {
  const output = (...events: ReadonlyArray<Readonly<Record<string, unknown>>>) =>
    ["not an event", ...events.map((event) => JSON.stringify({time: "2026-11-05T12:00:00.000Z", ...event}))].join("\n");

  it("classify a failed start by its upgrade reason or its failure reason", () => {
    assert.equal(startupFailure(eventLines(output({event: "database_upgrade_failed", file: "guidance.sqlite3", reason: "unknown_layout"},
      {event: "supervisor_failed", reason: "database_upgrade_unknown_layout"}))), "database_upgrade_unknown_layout (guidance.sqlite3)");
    assert.equal(startupFailure(eventLines(output({event: "supervisor_failed", reason: "t3_token_unavailable"}))), "t3_token_unavailable");
    assert.equal(startupFailure(eventLines(output({event: "supervisor_started"}))), null);
  });

  it("log one completed upgrade naming the new set and every changed file, and none at the current formats", () => {
    const expected = changingFiles(directory(0), current);
    const completed = {event: "database_upgrade_completed", backup_set: "set-1", files: databaseFiles.map((file) => `${file}:0>1`).join(",")};
    assert.deepEqual(upgradeEventProblems(eventLines(output(completed)), expected, "set-1"), []);
    assert.deepEqual(upgradeEventProblems(eventLines(output()), expected, "set-1"), ["the start logged 0 completed upgrades instead of one"]);
    assert.deepEqual(upgradeEventProblems(eventLines(output(completed)), expected, "set-2"), ["the completed upgrade does not name the new backup set"]);
    assert.match(upgradeEventProblems(eventLines(output({...completed, files: "catalog.sqlite3:0>1"})), expected, "set-1").join(), /names catalog\.sqlite3:0>1 instead of/u);
    assert.deepEqual(upgradeEventProblems(eventLines(output()), [], null), []);
    assert.deepEqual(upgradeEventProblems(eventLines(output(completed)), [], null), ["a start at the current formats logged 1 upgrade(s)"]);
    assert.deepEqual(upgradeEventProblems(eventLines(output({event: "database_upgrade_failed", file: null, reason: "backup_failed"})), [], null),
      ["the start logged 1 failed upgrade(s)"]);
  });
});

describe("the journey's outcome", () => {
  it("passes only on checks that all passed, and keeps the outcome of the phase it stopped in", () => {
    const passing = [{name: "a", ok: true, detail: ""}];
    assert.equal(journeyOutcome(passing, null), "passed");
    assert.equal(journeyOutcome([...passing, {name: "b", ok: false, detail: ""}], null), "failed");
    assert.equal(journeyOutcome([], null), "failed");
    assert.equal(journeyOutcome(passing, "creator_unready"), "creator_unready");
    assert.equal(journeyOutcome(passing, "unsupported_shape"), "unsupported_shape");
  });
});
