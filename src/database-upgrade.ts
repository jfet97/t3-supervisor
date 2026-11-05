import { join } from "node:path";
import { Context, Data, Effect, FileSystem, Layer, Schema, type Scope } from "effect";
import { SqlClient } from "effect/sql";
import { backupCopy, type BackupSource, syncDirectory, writeBackupSet } from "./database-backup.js";
import {
  bootstrapPendingKey, catalogLegacy, catalogMigrations, guidanceLegacy, guidanceMigrations, type LegacyLayout, type MigrationContext, type MigrationStep,
  policyDonorFormats, policyDonorStatement, PolicyImportMarker, policyImportKey, type PolicySource, readStoredPolicy, recognizeLegacy, schemaDifferences,
  schemaObjects, schemaSignature, type SchemaSignature, type StoredPolicy,
} from "./database-migrations.js";
import {
  CatalogDb, catalogDbLayer, DatabaseFiles, DatabaseFormats, type DatabaseKind, GuidanceDb, guidanceDbLayer, memoryDatabase, openUpgradeDatabase,
  readFormat, readOnlyBackupSource, readOnlyDatabase, type UpgradeDatabase,
} from "./db.js";
import { snapshotRead } from "./guidance-sql.js";
import { logEvent } from "./logging.js";
import { inspectExistingAccessDatabase, openExistingAccessDatabase, verifyAccessDatabase } from "./service-auth.js";

/*
 * the startup coordinator of a data directory: the only code that creates store files or moves them between formats. The
 * service start runs it before any store, seeding, listener, watch or worker (src/supervisor.ts), while readiness stays false.
 * It reads every file first (read only), refuses anything it cannot carry forward without touching it, backs up and verifies
 * every existing file whose format changes, then upgrades one file at a time, each in one BEGIN IMMEDIATE transaction that
 * rereads the format after taking the lock, so a concurrent start never applies a step twice. Different files never share a
 * transaction: a failure leaves earlier files upgraded and later ones as they were, and the next start resumes from the
 * committed formats. Guidance format 2 holds the excluded-chat policy that thread-settings.sqlite3 kept before: its upgrade
 * imports that file's document, backed up and verified first, and the file is removed once guidance holds the verified copy.
 * Upgrades are offline: an older Supervisor must not run on the directory meanwhile, and there is no supported downgrade or
 * automatic restore.
 */

export interface UpgradeOptions {
  readonly dataDirectory: string;
  /** the configured excluded chats; read only when a genuinely fresh directory is initialized */
  readonly excludedThreadIds: ReadonlyArray<string>;
}

export interface UpgradedFile {
  readonly file: string;
  /** the format before the upgrade, or null when the file was created */
  readonly from: number | null;
  readonly to: number;
}

export interface UpgradeReport {
  /** a genuinely fresh directory was initialized */
  readonly fresh: boolean;
  /** the verified backup set written by this run, if an existing file changed format or the retired policy file was imported */
  readonly backupSet: string | null;
  readonly files: ReadonlyArray<UpgradedFile>;
  /** this run removed the retired policy file or its leftover sidecars, its policy held by guidance */
  readonly policyFileRemoved: boolean;
}

/** Why the data directory could not be prepared; every reason leaves the service down and the files as last committed. */
export type UpgradeFailure =
  | "unreadable" | "future_format" | "unknown_layout" | "incomplete_schema" | "invalid_policy" | "missing_policy" | "missing_catalog"
  | "policy_conflict" | "interrupted_bootstrap" | "access_invalid" | "backup_failed" | "migration_failed" | "concurrent_change"
  | "validation_failed" | "cleanup_failed";

/** The data directory could not be prepared; it names the file and a fixed reason, never a path, row or cause. */
export class DatabaseUpgradeError extends Data.TaggedError("DatabaseUpgradeError")<{
  readonly file: string | null;
  readonly reason: UpgradeFailure;
}> {
  override get message(): string {
    return `database upgrade failed: ${this.file ?? "data directory"}: ${this.reason}`;
  }
}

const accessFile = "access/login.sqlite3";
// the retired policy file: guidance format 2 imports its one row, and the file is removed once guidance holds the verified copy
const donorFile = "thread-settings.sqlite3";

const refusal = (file: string | null, reason: UpgradeFailure) => new DatabaseUpgradeError({ file, reason });
// any other failure of a stage becomes that stage's reason; the cause (statement text, rows, paths) is dropped
const asUpgradeError = (file: string | null, reason: UpgradeFailure) => <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, DatabaseUpgradeError, R> =>
  Effect.mapError(effect, (error) => error instanceof DatabaseUpgradeError ? error : refusal(file, reason));

/** What the preflight reads from a store file already at the current format, besides its declared schema. */
interface CurrentFacts {
  /** no table holds a row: a catalog that a fresh initialization created */
  readonly empty: boolean;
  /** guidance: the marker of the policy imported from the retired file, if any */
  readonly imported: PolicyImportMarker | null;
  /** guidance: a fresh initialization committed guidance and has not completed yet */
  readonly bootstrapPending: boolean;
}

const decodeTableNames = Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ name: Schema.String })));
const decodeRowCount = Schema.decodeUnknownEffect(Schema.Tuple([Schema.Struct({ rows: Schema.Number })]));
const decodeMetaValues = Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ value: Schema.String })));
const decodeImportMarker = Schema.decodeUnknownEffect(Schema.fromJsonString(PolicyImportMarker));

// whether no table of the file holds a row
const holdsNoRows = (sql: SqlClient.SqlClient) => Effect.gen(function* () {
  const tables = yield* sql.unsafe("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'").pipe(Effect.flatMap(decodeTableNames));
  for (const { name } of tables) {
    const [{ rows }] = yield* sql.unsafe(`SELECT count(*) AS rows FROM "${name.replaceAll('"', '""')}"`).pipe(Effect.flatMap(decodeRowCount));
    if (rows > 0) return false;
  }
  return true;
}).pipe(Effect.provideService(SqlClient.SafeIntegers, false));

const metaValue = (sql: SqlClient.SqlClient, key: string) =>
  sql`SELECT value FROM meta WHERE key=${key}`.pipe(Effect.flatMap(decodeMetaValues), Effect.map((rows) => rows[0]?.value ?? null));

const catalogFacts = (sql: SqlClient.SqlClient): Effect.Effect<CurrentFacts, DatabaseUpgradeError> =>
  holdsNoRows(sql).pipe(Effect.map((empty) => ({ empty, imported: null, bootstrapPending: false })), asUpgradeError(DatabaseFiles.catalog.file, "unreadable"));

// guidance holds its one valid policy row; its markers say whether that policy was imported and whether a fresh start is unfinished
const guidanceFacts = (sql: SqlClient.SqlClient): Effect.Effect<CurrentFacts, DatabaseUpgradeError> => Effect.gen(function* () {
  yield* readStoredPolicy(sql, "thread_policy");
  const marker = yield* metaValue(sql, policyImportKey);
  const imported = marker === null ? null : yield* decodeImportMarker(marker);
  return { empty: false, imported, bootstrapPending: (yield* metaValue(sql, bootstrapPendingKey)) !== null };
}).pipe(asUpgradeError(DatabaseFiles.guidance.file, "invalid_policy"));

// a store file of the directory with what its upgrade needs
interface StoreSpec {
  readonly kind: DatabaseKind;
  readonly legacy: LegacyLayout;
  readonly steps: ReadonlyArray<MigrationStep>;
  readonly facts: (sql: SqlClient.SqlClient) => Effect.Effect<CurrentFacts, DatabaseUpgradeError>;
}

const stores: Readonly<Record<DatabaseKind, StoreSpec>> = {
  catalog: { kind: "catalog", legacy: catalogLegacy, steps: catalogMigrations, facts: catalogFacts },
  guidance: { kind: "guidance", legacy: guidanceLegacy, steps: guidanceMigrations, facts: guidanceFacts },
};

/*
 * a declared schema of each store file, computed at most once per run and only when an existing file needs it: a fresh
 * directory's files come from the same steps on an empty file and are never compared with it
 */
type References = Readonly<Record<DatabaseKind, Effect.Effect<SchemaSignature, DatabaseUpgradeError>>>;

// the policy of every step but guidance's, whose format 2 is the only one that writes a policy
const noPolicy: PolicySource = { kind: "none" };

// format 1 of the access database is the schema the auth service has always validated exactly; the step only records it
const accessSteps: ReadonlyArray<MigrationStep> = [{ from: 0, to: 1, apply: () => Effect.void }];

/** What the read-only preflight found: no file, a table-less format 0 file, the current format, or an older recognized one. */
type FileState =
  | { readonly state: "absent" }
  | { readonly state: "empty" }
  | { readonly state: "current"; readonly facts: CurrentFacts }
  | { readonly state: "upgradable"; readonly format: number };

const hasTables = (file: FileState): boolean => file.state === "current" || file.state === "upgradable";

// the steps from `from` to `to` in order, or none when a step is missing
const stepsBetween = (steps: ReadonlyArray<MigrationStep>, from: number, to: number): ReadonlyArray<MigrationStep> | null => {
  const chain: Array<MigrationStep> = [];
  for (let format = from; format < to;) {
    const step = steps.find((candidate) => candidate.from === format);
    if (step === undefined || step.to <= format) return null;
    chain.push(step);
    format = step.to;
  }
  return chain;
};

// the schema the steps of `kind` up to `format` give an empty private in-memory database, creating a new file or replaying history
const stepsSignature = (kind: DatabaseKind, format: number, creating: boolean): Effect.Effect<SchemaSignature, DatabaseUpgradeError> => {
  const { file } = DatabaseFiles[kind];
  return Effect.scoped(Effect.gen(function* () {
    const steps = stepsBetween(stores[kind].steps, 0, format);
    if (steps === null) return yield* refusal(file, "migration_failed");
    const sql = yield* memoryDatabase;
    const context: MigrationContext = { policy: { kind: "fresh", excludedThreadIds: [] }, creating };
    yield* sql.withTransaction(Effect.forEach(steps, (step) => step.apply(sql, context), { discard: true }));
    return yield* schemaSignature(sql);
  })).pipe(asUpgradeError(file, "migration_failed"));
};

/**
 * The declared schema of a store file at `format` (its current one by default) as its history built it: its steps applied to an
 * empty private in-memory database as they upgrade an existing file, never a second copy of the statements. Format 1 is the
 * layout every release declared: format 0 files are recognized against it, and a format 1 file must declare all of it.
 */
export const referenceSignature = (kind: DatabaseKind, format: number = DatabaseFiles[kind].format): Effect.Effect<SchemaSignature, DatabaseUpgradeError> =>
  stepsSignature(kind, format, false);

/**
 * The live schema of a store file at its current format: what this version creates for a new file, its steps applied to an empty
 * private in-memory database. Every current file must declare it; an upgraded one also keeps the tables of retired features.
 */
export const liveSignature = (kind: DatabaseKind): Effect.Effect<SchemaSignature, DatabaseUpgradeError> =>
  stepsSignature(kind, DatabaseFiles[kind].format, true);

/*
 * the preflight of one store file, read only: a read-only client never writes, creates no file and leaves a live WAL as it is. A
 * current file is compared with `reference`, the live schema; a format 0 file is recognized against `releases`, the layout every
 * release declared, which an older file with a format must declare whole
 */
const inspect = (dataDirectory: string, spec: StoreSpec, reference: Effect.Effect<SchemaSignature, DatabaseUpgradeError>,
  releases: Effect.Effect<SchemaSignature, DatabaseUpgradeError>): Effect.Effect<FileState, DatabaseUpgradeError, FileSystem.FileSystem> => {
  const { file, format: target } = DatabaseFiles[spec.kind];
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    if (!(yield* fs.exists(join(dataDirectory, file)))) return { state: "absent" } as const;
    return yield* Effect.scoped(Effect.gen(function* () {
      const sql = yield* readOnlyDatabase(dataDirectory, file);
      const format = yield* readFormat(sql);
      if (format > target) return yield* refusal(file, "future_format");
      if (format === target) {
        if ((yield* schemaDifferences(sql, yield* reference)).length > 0) return yield* refusal(file, "incomplete_schema");
        return { state: "current", facts: yield* spec.facts(sql) } as const;
      }
      if (format === 0) {
        if ((yield* schemaObjects(sql)).length === 0) return { state: "empty" } as const;
        const recognition = yield* recognizeLegacy(sql, yield* releases, spec.legacy);
        if (recognition.kind === "empty") return { state: "empty" } as const;
        if (recognition.kind === "unknown") return yield* refusal(file, "unknown_layout");
      } else if ((yield* schemaDifferences(sql, yield* releases)).length > 0) return yield* refusal(file, "incomplete_schema");
      if (stepsBetween(spec.steps, format, target) === null) return yield* refusal(file, "unknown_layout");
      return { state: "upgradable", format } as const;
    }));
  }).pipe(asUpgradeError(file, "unreadable"));
};

// the preflight of the access database, through the auth service's own checks, read only
const inspectAccess = (dataDirectory: string): Effect.Effect<FileState, DatabaseUpgradeError, FileSystem.FileSystem> =>
  inspectExistingAccessDatabase(dataDirectory).pipe(
    asUpgradeError(accessFile, "access_invalid"),
    Effect.flatMap((format): Effect.Effect<FileState, DatabaseUpgradeError> => {
      if (format === null) return Effect.succeed({ state: "absent" });
      if (format === DatabaseFormats.access) return Effect.succeed({ state: "current", facts: { empty: false, imported: null, bootstrapPending: false } });
      if (format > DatabaseFormats.access) return Effect.fail(refusal(accessFile, "future_format"));
      return stepsBetween(accessSteps, format, DatabaseFormats.access) === null
        ? Effect.fail(refusal(accessFile, "unknown_layout")) : Effect.succeed({ state: "upgradable", format });
    }));

/** The preflight's view of the retired policy file: nothing to import (no file, or a table-less one), or its one policy row. */
type DonorState = { readonly state: "absent" } | { readonly state: "present"; readonly stored: StoredPolicy };

// the declared schema of the retired policy file: its one statement on an empty private in-memory database
const donorSignature = (): Effect.Effect<SchemaSignature, DatabaseUpgradeError> => Effect.scoped(Effect.gen(function* () {
  const sql = yield* memoryDatabase;
  yield* sql.unsafe(policyDonorStatement);
  return yield* schemaSignature(sql);
})).pipe(asUpgradeError(donorFile, "migration_failed"));

// the file declares exactly the reference's objects: none missing, none declared differently and none besides them
const declaresExactly = (file: SchemaSignature, reference: SchemaSignature): boolean =>
  file.size === reference.size && [...reference].every(([key, declaration]) => file.get(key) === declaration);

// a stored document is the one a marker names: the same bytes and generation
const sameDocument = (stored: StoredPolicy, marker: PolicyImportMarker): boolean =>
  stored.sha256 === marker.documentSha256 && stored.policy.generation === marker.generation;

/*
 * the preflight of the retired policy file, read only and as one snapshot, a committed write-ahead log included: an existing file
 * holds exactly its one recognized table at a format an upgrade imports, and its one policy row
 */
const inspectDonor = (dataDirectory: string, reference: Effect.Effect<SchemaSignature, DatabaseUpgradeError>):
  Effect.Effect<DonorState, DatabaseUpgradeError, FileSystem.FileSystem> => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(join(dataDirectory, donorFile)))) return { state: "absent" } as const;
  return yield* Effect.scoped(Effect.gen(function* () {
    const sql = yield* readOnlyDatabase(dataDirectory, donorFile);
    return yield* snapshotRead(sql)(Effect.gen(function* () {
      const format = yield* readFormat(sql);
      if (!policyDonorFormats.includes(format)) return yield* refusal(donorFile, "unknown_layout");
      if (format === 0 && (yield* schemaObjects(sql)).length === 0) return { state: "absent" } as const;
      if (!declaresExactly(yield* schemaSignature(sql), yield* reference)) return yield* refusal(donorFile, "unknown_layout");
      return { state: "present", stored: yield* readStoredPolicy(sql, "settings").pipe(asUpgradeError(donorFile, "invalid_policy")) } as const;
    }));
  }));
}).pipe(asUpgradeError(donorFile, "unreadable"));

// the copy of the retired policy file in `backupSet` holds the document `sha256`; it is read only, like every backup
const backupHoldsPolicy = (dataDirectory: string, backupSet: string, sha256: string): Effect.Effect<void, DatabaseUpgradeError, FileSystem.FileSystem> =>
  Effect.scoped(Effect.gen(function* () {
    const copy = yield* backupCopy(dataDirectory, backupSet, donorFile);
    if (copy === null) return yield* refusal(donorFile, "backup_failed");
    const stored = yield* readStoredPolicy(yield* readOnlyDatabase(copy.directory, copy.file), "settings");
    if (stored.sha256 !== sha256) return yield* refusal(donorFile, "backup_failed");
  })).pipe(asUpgradeError(donorFile, "backup_failed"));

/*
 * removes the retired policy file once guidance holds the verified copy its marker names: a file still present must still hold
 * that document (read again, read only, then closed) and its archived copy must too. The main file goes first, then its
 * write-ahead log and shared-memory sidecars, and the directory is synced, so a crash in between leaves only sidecars, which the
 * next start removes on the strength of the marker. True when anything was removed
 */
const removeDonor = (dataDirectory: string, marker: PolicyImportMarker, reference: Effect.Effect<SchemaSignature, DatabaseUpgradeError>):
  Effect.Effect<boolean, DatabaseUpgradeError, FileSystem.FileSystem> => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = join(dataDirectory, donorFile);
  let removed = false;
  if (yield* fs.exists(path)) {
    const live = yield* inspectDonor(dataDirectory, reference);
    if (live.state === "present" && !sameDocument(live.stored, marker)) return yield* refusal(donorFile, "policy_conflict");
    yield* backupHoldsPolicy(dataDirectory, marker.backupSet, marker.documentSha256);
    yield* fs.remove(path);
    removed = true;
  }
  for (const sidecar of [`${path}-wal`, `${path}-shm`]) if (yield* fs.exists(sidecar)) {
    yield* fs.remove(sidecar);
    removed = true;
  }
  if (removed) yield* syncDirectory(dataDirectory, refusal(donorFile, "cleanup_failed"));
  return removed;
}).pipe(asUpgradeError(donorFile, "cleanup_failed"));

const JournalMode = Schema.Tuple([Schema.Struct({ journal_mode: Schema.String })]);
const decodeJournalMode = Schema.decodeUnknownEffect(JournalMode);

interface Migration {
  readonly file: string;
  readonly from: number;
  readonly target: number;
  readonly steps: ReadonlyArray<MigrationStep>;
  /*
   * the live schema an upgraded file must declare before the commit; none for a file this run creates (the same steps on an
   * empty file) or for the access database, which the auth service validates exactly
   */
  readonly reference: SchemaSignature | null;
  /** the file must still be table-less when the transaction holds the lock (it is being created) */
  readonly creating: boolean;
  readonly journal: "wal" | "delete";
  readonly context: MigrationContext;
}

/**
 * One file's pending steps and its new format, in one BEGIN IMMEDIATE transaction that rereads the format once it holds the
 * lock: a file a concurrent start already upgraded is left as it is, any other change since the preflight fails closed. The
 * live schema of the new format is checked before the commit. True when this call upgraded the file.
 */
const migrate = (database: UpgradeDatabase, migration: Migration): Effect.Effect<boolean, DatabaseUpgradeError> => {
  const { sql } = database;
  return Effect.gen(function* () {
    const applied = yield* sql.withTransaction(Effect.gen(function* () {
      const found = yield* readFormat(sql);
      if (found === migration.target) return false;
      if (found !== migration.from) return yield* refusal(migration.file, "concurrent_change");
      if (migration.creating && (yield* schemaObjects(sql)).length > 0) return yield* refusal(migration.file, "concurrent_change");
      const steps = stepsBetween(migration.steps, migration.from, migration.target);
      if (steps === null) return yield* refusal(migration.file, "migration_failed");
      for (const step of steps) yield* step.apply(sql, migration.context);
      yield* sql.unsafe(`PRAGMA user_version = ${migration.target}`);
      if (migration.reference !== null && (yield* schemaDifferences(sql, migration.reference)).length > 0) return yield* refusal(migration.file, "incomplete_schema");
      return true;
    }));
    // a new file gets the store's journal mode once it has its format; an existing one already has it
    if (migration.journal === "wal") {
      const [{ journal_mode }] = yield* sql.unsafe("PRAGMA journal_mode=WAL").pipe(Effect.flatMap(decodeJournalMode));
      if (journal_mode.toLowerCase() !== "wal") return yield* refusal(migration.file, "migration_failed");
    }
    return applied;
  }).pipe(asUpgradeError(migration.file, "migration_failed"));
};

const storeMigration = (spec: StoreSpec, state: FileState, policy: PolicySource, reference: SchemaSignature | null): Migration => {
  const { file, format, journal } = DatabaseFiles[spec.kind];
  const creating = state.state !== "upgradable";
  return {
    file, target: format, steps: spec.steps, reference, journal, creating, context: { policy, creating },
    from: state.state === "upgradable" ? state.format : 0,
  };
};

const upgradeStore = (dataDirectory: string, spec: StoreSpec, state: FileState, policy: PolicySource, reference: SchemaSignature | null) =>
  Effect.scoped(Effect.flatMap(
    openUpgradeDatabase(dataDirectory, spec.kind, { create: state.state === "absent" }).pipe(asUpgradeError(DatabaseFiles[spec.kind].file, "unreadable")),
    (database) => migrate(database, storeMigration(spec, state, policy, reference))));

const upgradeAccess = (dataDirectory: string, from: number) => Effect.scoped(Effect.gen(function* () {
  const opened = yield* openExistingAccessDatabase(dataDirectory).pipe(asUpgradeError(accessFile, "access_invalid"));
  if (opened === null || opened.database === null) return yield* refusal(accessFile, "concurrent_change");
  return yield* migrate(opened.database, {
    file: accessFile, from, target: DatabaseFormats.access, steps: accessSteps, reference: null, creating: false, journal: "delete",
    context: { policy: noPolicy, creating: false },
  });
}));

// every existing file whose format changes, and the retired policy file whose policy moves, copied and verified before any upgrade write
const backupChanging = (dataDirectory: string, access: FileState, files: Readonly<Record<DatabaseKind, FileState>>, donor: boolean) =>
  Effect.scoped(Effect.gen(function* () {
    const sources: Array<BackupSource> = [];
    if (access.state === "upgradable") {
      const opened = yield* openExistingAccessDatabase(dataDirectory).pipe(asUpgradeError(accessFile, "access_invalid"));
      if (opened === null || opened.database === null) return yield* refusal(accessFile, "concurrent_change");
      sources.push({ file: accessFile, name: "access-login.sqlite3", targetFormat: DatabaseFormats.access, database: opened.database });
    }
    for (const kind of ["catalog", "guidance"] as const) {
      if (files[kind].state !== "upgradable") continue;
      const { file, format } = DatabaseFiles[kind];
      const database = yield* openUpgradeDatabase(dataDirectory, kind, { create: false }).pipe(asUpgradeError(file, "unreadable"));
      sources.push({ file, name: file, targetFormat: format, database });
    }
    // copied through a read-only connection: the retired file is never opened for writing
    if (donor) sources.push({ file: donorFile, name: donorFile, targetFormat: null,
      database: yield* readOnlyBackupSource(dataDirectory, donorFile).pipe(asUpgradeError(donorFile, "unreadable")) });
    if (sources.length === 0) return null;
    return yield* writeBackupSet(dataDirectory, sources).pipe(
      Effect.mapError((failure) => refusal(failure.file, "backup_failed")),
      Effect.map((set) => set.id));
  }));

const openCatalog = (dataDirectory: string) => Effect.map(Layer.build(catalogDbLayer(dataDirectory)), (services) => Context.get(services, CatalogDb));
const openGuidance = (dataDirectory: string) => Effect.map(Layer.build(guidanceDbLayer(dataDirectory)), (services) => Context.get(services, GuidanceDb));

/*
 * the result as the stores and the auth service will open it: a file this start created or upgraded through its guarded open,
 * guidance with its one policy row. The declared schema needs no second comparison: each upgrade compared its file before the
 * commit, and a created file is the steps' own result
 */
const verifyStore = (kind: DatabaseKind, open: Effect.Effect<SqlClient.SqlClient, unknown, Scope.Scope | FileSystem.FileSystem>) =>
  Effect.scoped(Effect.gen(function* () {
    const sql = yield* open;
    if (kind === "guidance") yield* readStoredPolicy(sql, "thread_policy");
  })).pipe(asUpgradeError(DatabaseFiles[kind].file, "validation_failed"));

// every file this start changed; a file it left as it was passed the same checks, read only, in the preflight
const verify = (dataDirectory: string, changed: ReadonlyArray<UpgradedFile>) => Effect.gen(function* () {
  const touched = new Set(changed.map((file) => file.file));
  if (touched.has(DatabaseFiles.catalog.file)) yield* verifyStore("catalog", openCatalog(dataDirectory));
  if (touched.has(DatabaseFiles.guidance.file)) yield* verifyStore("guidance", openGuidance(dataDirectory));
  if (touched.has(accessFile)) yield* verifyAccessDatabase(dataDirectory).pipe(asUpgradeError(accessFile, "validation_failed"));
});

/*
 * guidance after an import, as the stores open it: its policy row is the retired file's document byte for byte and its marker
 * names that document (a concurrent start may have imported it first, under its own backup set); the marker is returned
 */
const verifyImport = (dataDirectory: string, expected: StoredPolicy) => Effect.scoped(Effect.gen(function* () {
  const sql = yield* openGuidance(dataDirectory);
  const stored = yield* readStoredPolicy(sql, "thread_policy");
  const { imported } = yield* guidanceFacts(sql);
  if (imported === null || stored.sha256 !== expected.sha256 || !sameDocument(expected, imported)) return yield* refusal(DatabaseFiles.guidance.file, "validation_failed");
  return imported;
})).pipe(asUpgradeError(DatabaseFiles.guidance.file, "validation_failed"));

// the end of a fresh initialization: the catalog opens as its store opens it, then guidance drops its pending marker
const completeBootstrap = (dataDirectory: string) => Effect.gen(function* () {
  yield* verifyStore("catalog", openCatalog(dataDirectory));
  yield* Effect.scoped(Effect.flatMap(openGuidance(dataDirectory), (sql) => sql.withTransaction(sql`DELETE FROM meta WHERE key=${bootstrapPendingKey}`))).pipe(
    asUpgradeError(DatabaseFiles.guidance.file, "migration_failed"));
});

/**
 * Prepares the data directory for this Supervisor before anything else opens it. A genuinely fresh directory (catalog, guidance
 * and the retired policy file all absent or table-less at format 0) is created at the current formats, guidance first with the
 * policy seeded from `excludedThreadIds` at generation 1 and a pending marker that the catalog's verified creation clears, so the
 * next start recognizes and completes an interrupted creation. An existing directory keeps its policy: guidance below format 2
 * imports the retired file's document byte for byte (never a default), and that file is removed once guidance holds the verified
 * copy. Every existing file whose format changes, and the retired file, is backed up and verified first, then the files are
 * upgraded in the fixed order access, catalog, guidance. The access database is created by the auth service's own bootstrap,
 * never here.
 */
export const upgradeDataDirectory = (options: UpgradeOptions): Effect.Effect<UpgradeReport, DatabaseUpgradeError, FileSystem.FileSystem> => {
  const { dataDirectory } = options;
  return Effect.gen(function* () {
    // 0. the live schema of every file at its current format, from its own statements, once and only if a file needs it
    const references: References = {
      catalog: yield* Effect.cached(liveSignature("catalog")),
      guidance: yield* Effect.cached(liveSignature("guidance")),
    };
    // the layout every release declared, format 1: the catalog's current one, guidance's before its policy table
    const releases: References = {
      catalog: yield* Effect.cached(referenceSignature("catalog", 1)),
      guidance: yield* Effect.cached(referenceSignature("guidance", 1)),
    };
    const donorReference = yield* Effect.cached(donorSignature());
    // 1. the read-only preflight of every file; nothing is written before every file passed it
    const access = yield* inspectAccess(dataDirectory);
    const files = {
      catalog: yield* inspect(dataDirectory, stores.catalog, references.catalog, releases.catalog),
      guidance: yield* inspect(dataDirectory, stores.guidance, references.guidance, releases.guidance),
    };
    const donor = yield* inspectDonor(dataDirectory, donorReference);
    const current = files.guidance.state === "current" ? files.guidance.facts : null;
    const fresh = !hasTables(files.catalog) && !hasTables(files.guidance) && donor.state === "absent";
    const pending = current?.bootstrapPending === true;
    /*
     * guidance below format 2 takes its policy from the retired file and nowhere else; at format 2 it already holds it, and a
     * retired file beside it must be the document it imported
     */
    if (!fresh && current === null && donor.state === "absent") return yield* refusal(donorFile, "missing_policy");
    if (current !== null && donor.state === "present" && (pending || current.imported === null || !sameDocument(donor.stored, current.imported)))
      return yield* refusal(donorFile, "policy_conflict");
    // an interrupted fresh initialization committed guidance first: its catalog is still missing, or created and still empty
    if (pending && (files.catalog.state === "upgradable" || files.catalog.state === "current" && !files.catalog.facts.empty))
      return yield* refusal(DatabaseFiles.catalog.file, "interrupted_bootstrap");
    if (!fresh && !pending && hasTables(files.guidance) && !hasTables(files.catalog)) return yield* refusal(DatabaseFiles.catalog.file, "missing_catalog");

    // 2. the verified backup of every existing file whose format changes, and of the retired policy file whose policy moves
    const importing = current === null && donor.state === "present" ? donor.stored : null;
    const backupSet = yield* backupChanging(dataDirectory, access, files, importing !== null);
    let policy: PolicySource = fresh ? { kind: "fresh", excludedThreadIds: options.excludedThreadIds } : { kind: "none" };
    if (importing !== null) {
      // the import copies the document the verified backup holds, and its marker names that backup
      if (backupSet === null) return yield* refusal(donorFile, "backup_failed");
      yield* backupHoldsPolicy(dataDirectory, backupSet, importing.sha256);
      policy = { kind: "import", bytes: importing.bytes, marker: { documentSha256: importing.sha256, generation: importing.policy.generation, backupSet } };
    }

    // 3. the upgrades, one file and one transaction at a time; a fresh directory creates guidance, with its policy, first
    const changed: Array<UpgradedFile> = [];
    const record = (file: string, state: FileState, to: number) => (applied: boolean) => {
      if (applied) changed.push({ file, from: state.state === "upgradable" ? state.format : null, to });
    };
    if (access.state === "upgradable") yield* upgradeAccess(dataDirectory, access.format).pipe(Effect.map(record(accessFile, access, DatabaseFormats.access)));
    const order: ReadonlyArray<DatabaseKind> = fresh ? ["guidance", "catalog"] : ["catalog", "guidance"];
    for (const kind of order) {
      const state = files[kind];
      if (state.state === "current") continue;
      const reference = state.state === "upgradable" ? yield* references[kind] : null;
      yield* upgradeStore(dataDirectory, stores[kind], state, kind === "guidance" ? policy : noPolicy, reference)
        .pipe(Effect.map(record(DatabaseFiles[kind].file, state, DatabaseFiles[kind].format)));
    }

    // 4. the result as the stores will open it, the end of a fresh initialization, then the retired policy file's removal
    yield* verify(dataDirectory, changed);
    if (fresh || pending) yield* completeBootstrap(dataDirectory);
    const marker = importing !== null ? yield* verifyImport(dataDirectory, importing) : current?.imported ?? null;
    const policyFileRemoved = marker === null ? false : yield* removeDonor(dataDirectory, marker, donorReference);
    const report: UpgradeReport = { fresh, backupSet, files: changed, policyFileRemoved };
    // an upgrade of existing files is reported; creating the files of a new directory is the ordinary first start
    if (backupSet !== null) yield* logEvent("database_upgrade_completed", {
      backup_set: backupSet, files: changed.map((file) => `${file.file}:${file.from ?? "new"}>${file.to}`).join(","), policy_imported: importing !== null,
    });
    if (marker !== null && policyFileRemoved) yield* logEvent("database_policy_file_removed", { file: donorFile, backup_set: marker.backupSet });
    return report;
  }).pipe(Effect.tapError((error) => logEvent("database_upgrade_failed", { file: error.file, reason: error.reason })));
};

/**
 * The service start's upgrade of its configured data directory, before every other service of the process is built (layers
 * provided to the root services build first). It provides nothing; a failure fails the start.
 */
export const persistenceStartup = (options: UpgradeOptions): Layer.Layer<never, DatabaseUpgradeError, FileSystem.FileSystem> =>
  Layer.effectDiscard(upgradeDataDirectory(options));
