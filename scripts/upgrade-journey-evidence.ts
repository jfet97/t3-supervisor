import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { Option, Schema } from "effect";

/*
  The judgements of a published Supervisor upgrade journey (scripts/upgrade-journey.ts) as pure functions over what the journey read:
  the frozen seed set that a data directory's persisted shape selects, the backup set and log events a start must leave, the stored
  rows it must keep and the identities of the catalog it may rebuild from T3. Nothing here reads a file, starts a process or contacts
  a service.
*/

/** The database files of a data directory in the order the startup upgrade prepares them (src/database-upgrade.ts). */
export const databaseFiles = ["access/login.sqlite3", "catalog.sqlite3", "guidance.sqlite3", "thread-settings.sqlite3"] as const;
export type DatabaseFile = typeof databaseFiles[number];
/** Each file's format at the candidate; null for a retired file, whose content the candidate moves into another file before removing it. */
export type Formats = Readonly<Record<DatabaseFile, number | null>>;

/** A stored SQLite value, typed exactly: an integer as its decimal text, a real as its text, a string or a blob as it is stored. */
export type StoredValue = null | {readonly i: string} | {readonly r: string} | {readonly s: string} | {readonly b: string};
export type StoredRow = Readonly<Record<string, StoredValue>>;
/** Every table of one file with its rows in rowid order. */
export type FileRows = Readonly<Record<string, ReadonlyArray<StoredRow>>>;

/** One database file of a data directory as the journey read it, read only. */
export interface FileShape {
  readonly file: DatabaseFile;
  readonly present: boolean;
  /** its PRAGMA user_version, null when it is absent */
  readonly format: number | null;
  /** its user objects keyed as type:name with their stored declarations */
  readonly declarations: Readonly<Record<string, string>>;
  /** the values of the meta rows a seed set names, for a file with a meta table */
  readonly meta: Readonly<Record<string, string>>;
}

export const seedLabel = "synthetic fixture input, not published-binary output";
const SeedSet = Schema.Struct({
  id: Schema.String,
  file: Schema.Literals(databaseFiles),
  format: Schema.Number,
  requires: Schema.Struct({declarations: Schema.Record(Schema.String, Schema.String), meta: Schema.Record(Schema.String, Schema.String)}),
  statements: Schema.String,
});
export type SeedSet = typeof SeedSet.Type;
/** The frozen seed file (test/fixtures/upgrade-journeys/seed-sets.json). */
export const SeedFile = Schema.Struct({
  label: Schema.Literal(seedLabel),
  description: Schema.String,
  provenance: Schema.String,
  sets: Schema.Array(SeedSet),
  statements: Schema.Record(Schema.String, Schema.Array(Schema.String)),
});
export type SeedFile = typeof SeedFile.Type;

/** The meta keys the seed sets of `file` name, which the journey reads for its shape. */
export const requiredMeta = (seeds: SeedFile, file: DatabaseFile): ReadonlyArray<string> =>
  [...new Set(seeds.sets.filter((set) => set.file === file).flatMap((set) => Object.keys(set.requires.meta)))].sort();

const compact = (sql: string): string => sql.replace(/\s+/gu, "");

/** Why `set` does not apply to `shape`, or undefined when the file has the set's format, declarations and meta rows. */
export const contractMismatch = (set: SeedSet, shape: FileShape): string | undefined => {
  if (!shape.present) return `${set.file} is missing`;
  if (shape.format !== set.format) return `${set.file} has format ${String(shape.format)}`;
  for (const [key, declaration] of Object.entries(set.requires.declarations)) {
    const found = shape.declarations[key];
    if (found === undefined) return `${set.file} has no ${key}`;
    if (compact(found) !== compact(declaration)) return `${set.file} declares ${key} differently`;
  }
  for (const [key, value] of Object.entries(set.requires.meta))
    if (shape.meta[key] !== value) return `${set.file} has no meta ${key} of ${JSON.stringify(value)}`;
  return undefined;
};

export type SeedSelection =
  | {readonly kind: "recognized"; readonly set: SeedSet; readonly statements: ReadonlyArray<string>}
  | {readonly kind: "unsupported"; readonly reason: string};

/**
 * The frozen seed set the persisted shape of a data directory selects: every database file is there, none at a newer format than
 * the candidate runs, and exactly one set's contract holds for its file. Anything else is an unsupported shape, which fails the
 * journey; nothing is ever seeded from the candidate instead.
 */
export const selectSeedSet = (seeds: SeedFile, shapes: ReadonlyArray<FileShape>, current: Formats): SeedSelection => {
  for (const file of databaseFiles) {
    const target = current[file];
    // a retired file is absent when the binary that created the directory had retired it already; the candidate judges any format of it
    if (target === null) continue;
    const shape = shapes.find((candidate) => candidate.file === file);
    if (shape === undefined || !shape.present || shape.format === null) return {kind: "unsupported", reason: `${file} is missing`};
    if (shape.format > target) return {kind: "unsupported", reason: `${file} has format ${shape.format}, newer than format ${target}, which the candidate runs`};
  }
  const matching = seeds.sets.filter((set) => {
    const shape = shapes.find((candidate) => candidate.file === set.file);
    return shape !== undefined && contractMismatch(set, shape) === undefined;
  });
  const [only] = matching;
  if (matching.length > 1) return {kind: "unsupported", reason: `the seed sets ${matching.map((set) => set.id).join(" and ")} both match`};
  if (only === undefined) {
    const reasons = seeds.sets.map((set) => `${set.id}: ${contractMismatch(set, shapes.find((candidate) => candidate.file === set.file)!) ?? "matches"}`);
    return {kind: "unsupported", reason: `no frozen seed set matches what the binary left (${reasons.join("; ")})`};
  }
  const statements = seeds.statements[only.statements];
  if (statements === undefined || statements.length === 0) return {kind: "unsupported", reason: `the seed set ${only.id} names no statements`};
  return {kind: "recognized", set: only, statements};
};

/** The table each literal seed statement writes, or none for a statement of another form. */
export const statementTable = (statement: string): string | undefined => /^INSERT INTO ([a-z_]+)\(/u.exec(statement)?.[1];

/** A file a start changes: its format before and the candidate's current one, null for a retired file whose content it moves. */
export interface ChangingFile {
  readonly file: DatabaseFile;
  readonly format: number;
  readonly targetFormat: number | null;
}

/**
 * The files a start must back up before changing them, in upgrade order: every file at an older format than the candidate runs, and
 * a retired file, which the candidate imports into another file and then removes.
 */
export const changingFiles = (shapes: ReadonlyArray<FileShape>, current: Formats): ReadonlyArray<ChangingFile> =>
  databaseFiles.flatMap((file) => {
    const shape = shapes.find((candidate) => candidate.file === file);
    const target = current[file];
    return shape?.present === true && shape.format !== null && (target === null || shape.format < target) ? [{file, format: shape.format, targetFormat: target}] : [];
  });

/** The parts of a backup set's manifest.json (src/database-backup.ts) the journey checks. */
export const BackupManifest = Schema.Struct({
  kind: Schema.Literal("t3-supervisor-backup"),
  manifestFormat: Schema.Literal(1),
  backupSet: Schema.String,
  files: Schema.Array(Schema.Struct({
    file: Schema.String, backup: Schema.String, format: Schema.Number, targetFormat: Schema.NullOr(Schema.Number), sha256: Schema.String, integrity: Schema.Literal("ok"),
  })),
});
export type BackupManifest = typeof BackupManifest.Type;

/** One copy of a backup set as the journey read it: the SHA-256 of its bytes, its format and its rows. */
export interface BackupCopy {
  readonly sha256: string;
  readonly format: number | null;
  readonly rows: FileRows;
}

/** What a start left in the data directory's backups folder. */
export interface BackupObservation {
  readonly setsBefore: ReadonlyArray<string>;
  readonly setsAfter: ReadonlyArray<string>;
  /** the manifest of the one new set, decoded; null when it is absent or unreadable */
  readonly manifest: BackupManifest | null;
  /** each copy of the new set by its name in the manifest */
  readonly copies: Readonly<Record<string, BackupCopy>>;
}

/**
 * What contradicts the backup a start must make: exactly one new verified set whose manifest names every changed file with its
 * format, the copies holding exactly the rows the files had before, and no earlier set touched. A start whose files were all at the
 * current format must make none.
 */
export const backupProblems = (expected: ReadonlyArray<ChangingFile>, before: Readonly<Partial<Record<DatabaseFile, FileRows>>>,
  observed: BackupObservation): ReadonlyArray<string> => {
  const added = observed.setsAfter.filter((id) => !observed.setsBefore.includes(id));
  const removed = observed.setsBefore.filter((id) => !observed.setsAfter.includes(id));
  const problems = removed.length > 0 ? [`the earlier backup set(s) ${removed.join(", ")} disappeared`] : [];
  if (expected.length === 0) return added.length > 0 ? [...problems, `a start at the current formats wrote the backup set(s) ${added.join(", ")}`] : problems;
  const [set] = added;
  if (added.length !== 1 || set === undefined) return [...problems, `expected exactly one new backup set, found ${added.length}`];
  const manifest = observed.manifest;
  if (manifest === null || manifest.backupSet !== set) return [...problems, `the backup set ${set} has no readable manifest naming it`];
  const named = manifest.files.map((entry) => entry.file).sort();
  const wanted = expected.map((entry) => entry.file).sort();
  if (!isDeepStrictEqual(named, wanted)) problems.push(`the manifest names ${named.join(", ") || "no file"} instead of ${wanted.join(", ")}`);
  for (const change of expected) {
    const entry = manifest.files.find((candidate) => candidate.file === change.file);
    if (entry === undefined) continue;
    if (entry.format !== change.format || entry.targetFormat !== change.targetFormat)
      problems.push(`the manifest records ${change.file} at format ${entry.format} to ${entry.targetFormat} instead of ${change.format} to ${change.targetFormat}`);
    const copy = observed.copies[entry.backup];
    if (copy === undefined) problems.push(`the copy ${entry.backup} of ${change.file} is missing`);
    else {
      if (copy.sha256 !== entry.sha256) problems.push(`the copy ${entry.backup} does not have its recorded SHA-256`);
      if (copy.format !== change.format) problems.push(`the copy ${entry.backup} is at format ${String(copy.format)}, not ${change.format}`);
      const differences = rowDifferences(before[change.file] ?? {}, copy.rows, false);
      if (differences.length > 0) problems.push(`the copy ${entry.backup} does not hold ${change.file} as it was: ${differences.slice(0, 3).join("; ")}`);
    }
  }
  return problems;
};

/**
 * The differences of `after` from `before`, at most a few per table: a table or row that disappeared, a row that appeared, or a
 * stored value that changed, compared byte for byte. With `allowAdditions` a start may add tables and columns, never rows.
 */
export const rowDifferences = (before: FileRows, after: FileRows, allowAdditions = true): ReadonlyArray<string> => {
  const problems: Array<string> = [];
  for (const [table, rows] of Object.entries(before)) {
    const now = after[table];
    if (now === undefined) {
      problems.push(`table ${table} is gone`);
      continue;
    }
    if (now.length !== rows.length) {
      problems.push(`${table} holds ${now.length} rows instead of ${rows.length}`);
      continue;
    }
    const changed = rows.flatMap((row, index) => {
      const stored = now[index] ?? {};
      const projected = Object.fromEntries(Object.keys(row).map((column) => [column, stored[column] ?? null]));
      return isDeepStrictEqual(projected, row) ? [] : [index + 1];
    });
    if (changed.length > 0) problems.push(`${table} row(s) ${changed.slice(0, 5).join(", ")} changed`);
  }
  if (!allowAdditions)
    for (const table of Object.keys(after)) if (before[table] === undefined) problems.push(`table ${table} was added`);
  return problems;
};

// the meta key of guidance's import marker (src/database-migrations.ts): the one row the policy's move adds to meta
const importKey = "thread_policy_import";
const ImportMarker = Schema.Struct({documentSha256: Schema.String, generation: Schema.Number, backupSet: Schema.String});
const decodeImportMarker = Schema.decodeUnknownOption(Schema.fromJsonString(ImportMarker));
const decodeGeneration = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({generation: Schema.Number})));
const textOf = (value: StoredValue | undefined): string | null => value !== null && value !== undefined && "s" in value ? value.s : null;
const isImportMarker = (stored: StoredRow): boolean => textOf(stored.key) === importKey;

/** Guidance's rows `after` a start without its import marker, unless `before` held one already: the one row the policy's move adds. */
export const withoutImportMarker = (before: FileRows, after: FileRows): FileRows =>
  (before.meta ?? []).some(isImportMarker) || after.meta === undefined ? after : {...after, meta: after.meta.filter((stored) => !isImportMarker(stored))};

/**
 * What contradicts the move of a retired thread-settings.sqlite3's policy into guidance: the file's one row must be guidance's
 * thread_policy row byte for byte, the import marker must name the document's SHA-256, its generation and a backup set of the
 * directory, and the file must be gone. A directory whose creator had retired the file already has nothing to move.
 */
export const movedPolicyProblems = (retired: FileRows | undefined, guidance: FileRows | undefined, retiredPresent: boolean,
  sets: ReadonlyArray<string>): ReadonlyArray<string> => {
  const policy = retired?.settings;
  if (policy === undefined) return retiredPresent ? ["the retired policy file appeared"] : [];
  const problems = retiredPresent ? ["the retired policy file is still there"] : [];
  if (!isDeepStrictEqual(guidance?.thread_policy, policy)) problems.push("guidance's thread_policy is not the policy row byte for byte");
  const document = textOf(policy[0]?.document);
  const marker = Option.flatMap(Option.fromNullishOr(textOf((guidance?.meta ?? []).find(isImportMarker)?.value)), decodeImportMarker);
  if (Option.isNone(marker)) return [...problems, "guidance has no import marker"];
  if (document === null || marker.value.documentSha256 !== createHash("sha256").update(document, "utf8").digest("hex"))
    problems.push("the import marker does not name the document's SHA-256");
  if (!Option.exists(document === null ? Option.none() : decodeGeneration(document), (value) => value.generation === marker.value.generation))
    problems.push("the import marker does not name the document's generation");
  if (!sets.includes(marker.value.backupSet)) problems.push("the import marker names no backup set of the directory");
  return problems;
};

/**
 * The identities the catalog keeps across a start that may rebuild its documents from T3: the environment binding and activations,
 * the projects and each conversation with its project.
 */
export const catalogIdentities = (rows: FileRows): Readonly<Record<string, ReadonlyArray<string>>> => {
  const text = (value: StoredValue | undefined): string => value === null || value === undefined ? "null" : Object.values(value)[0] ?? "null";
  const column = (table: string, names: ReadonlyArray<string>) =>
    (rows[table] ?? []).map((row) => names.map((name) => text(row[name])).join(" ")).sort();
  return {
    environment: column("environment_binding", ["environment_id"]),
    activations: column("activations", ["environment_id", "activated_at"]),
    projects: column("projects", ["id"]),
    threads: column("threads", ["id", "project_id"]),
  };
};

/** One event line of Supervisor's output ({"time","event",...fields}, src/logging.ts), reduced to the fields the journey reads. */
const EventLine = Schema.Struct({
  event: Schema.String,
  reason: Schema.optionalKey(Schema.String),
  file: Schema.optionalKey(Schema.NullOr(Schema.String)),
  backup_set: Schema.optionalKey(Schema.String),
  files: Schema.optionalKey(Schema.String),
  policy_imported: Schema.optionalKey(Schema.Boolean),
});
export type EventLine = typeof EventLine.Type;
const decodeEventLine = Schema.decodeUnknownOption(Schema.fromJsonString(EventLine));

/** The event lines of a process's output in order; other lines are ignored. */
export const eventLines = (output: string): ReadonlyArray<EventLine> =>
  output.split("\n").flatMap((line) => Option.toArray(decodeEventLine(line.trim())));

/** Why a start failed, by its own classified events: the upgrade's file and reason, else the failure's reason; null without one. */
export const startupFailure = (events: ReadonlyArray<EventLine>): string | null => {
  const upgrade = events.find((event) => event.event === "database_upgrade_failed");
  if (upgrade !== undefined) return `database_upgrade_${upgrade.reason ?? "failed"}${upgrade.file ? ` (${upgrade.file})` : ""}`;
  return events.find((event) => event.event === "supervisor_failed")?.reason ?? null;
};

/**
 * What a start's own events must say about its upgrade: one completed upgrade naming the new set and every format change, recording
 * whether it imported a retired file's policy, and that file's one removal under the same set; none of it at the current formats.
 */
export const upgradeEventProblems = (events: ReadonlyArray<EventLine>, expected: ReadonlyArray<ChangingFile>, set: string | null): ReadonlyArray<string> => {
  const completed = events.filter((event) => event.event === "database_upgrade_completed");
  const failed = events.filter((event) => event.event === "database_upgrade_failed");
  const removals = events.filter((event) => event.event === "database_policy_file_removed");
  const problems = failed.length > 0 ? [`the start logged ${failed.length} failed upgrade(s)`] : [];
  if (expected.length === 0) return [...problems, ...(completed.length > 0 ? [`a start at the current formats logged ${completed.length} upgrade(s)`] : []),
    ...(removals.length > 0 ? [`a start at the current formats logged ${removals.length} removal(s) of a retired file`] : [])];
  if (completed.length !== 1) return [...problems, `the start logged ${completed.length} completed upgrades instead of one`];
  const [event] = completed;
  if (event?.backup_set !== set) problems.push("the completed upgrade does not name the new backup set");
  // a retired file changes no format: the upgrade records its import, and its removal follows under the same set
  const imported = expected.some((change) => change.targetFormat === null);
  const logged = (event?.files ?? "").split(",").filter(Boolean).sort();
  const wanted = expected.filter((change) => change.targetFormat !== null).map((change) => `${change.file}:${change.format}>${change.targetFormat}`).sort();
  if (!isDeepStrictEqual(logged, wanted)) problems.push(`the completed upgrade names ${logged.join(", ") || "no file"} instead of ${wanted.join(", ")}`);
  if ((event?.policy_imported === true) !== imported) problems.push(imported ? "the completed upgrade does not record the policy import" : "the completed upgrade records a policy import");
  const named = removals.filter((removal) => removal.backup_set === set).length;
  if (imported ? removals.length !== 1 || named !== 1 : removals.length > 0)
    problems.push(`the start logged ${removals.length} removal(s) of the retired policy file${imported ? " instead of one under the new set" : ""}`);
  return problems;
};

/** The outcome of a journey: passed, a contradicted check, an unrecognized shape, a creator that never became ready, or no verdict. */
export type JourneyOutcome = "passed" | "failed" | "unsupported_shape" | "creator_unready" | "harness";

export interface JourneyCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

/** A journey's outcome: the outcome of the phase it stopped in, else a pass only when it ran checks and every one passed. */
export const journeyOutcome = (checks: ReadonlyArray<JourneyCheck>, stopped: Exclude<JourneyOutcome, "passed"> | null): JourneyOutcome =>
  stopped ?? (checks.length > 0 && checks.every((check) => check.ok) ? "passed" : "failed");
