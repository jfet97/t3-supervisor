import { join } from "node:path";
import { Context, Data, Effect, FileSystem, Layer, Schema, type Scope } from "effect";
import type { SqlClient } from "effect/sql";
import { type BackupSource, writeBackupSet } from "./database-backup.js";
import {
  catalogLegacy, catalogMigrations, guidanceLegacy, guidanceMigrations, type LegacyLayout, type MigrationContext, type MigrationStep, policyLegacy,
  policyMigrations, recognizeLegacy, requirePolicyRow, schemaDifferences, schemaObjects, schemaSignature, type SchemaSignature,
} from "./database-migrations.js";
import {
  CatalogDb, catalogDbLayer, DatabaseFiles, DatabaseFormats, type DatabaseKind, GuidanceDb, guidanceDbLayer, memoryDatabase, openUpgradeDatabase, PolicyDb,
  policyDbLayer, readFormat, readOnlyDatabase, type UpgradeDatabase,
} from "./db.js";
import { logEvent } from "./logging.js";
import { openExistingAccessDatabase, verifyAccessDatabase } from "./service-auth.js";

/*
 * the startup coordinator of a data directory: the only code that creates store files or moves them between formats. The
 * service start runs it before any store, seeding, listener, watch or worker (src/supervisor.ts), while readiness stays false.
 * It reads every file first (read only), refuses anything it cannot carry forward without touching it, backs up and verifies
 * every existing file whose format changes, then upgrades one file at a time, each in one BEGIN IMMEDIATE transaction that
 * rereads the format after taking the lock, so a concurrent start never applies a step twice. Different files never share a
 * transaction: a failure leaves earlier files upgraded and later ones as they were, and the next start resumes from the
 * committed formats. Upgrades are offline: an older Supervisor must not run on the directory meanwhile, and there is no
 * supported downgrade or automatic restore.
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
  /** the verified backup set written by this run, if any existing file changed format */
  readonly backupSet: string | null;
  readonly files: ReadonlyArray<UpgradedFile>;
}

/** Why the data directory could not be prepared; every reason leaves the service down and the files as last committed. */
export type UpgradeFailure =
  | "unreadable" | "future_format" | "unknown_layout" | "incomplete_schema" | "invalid_policy" | "missing_policy" | "missing_catalog"
  | "access_invalid" | "backup_failed" | "migration_failed" | "concurrent_change" | "validation_failed";

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

// a store file of the directory with what its upgrade needs
interface StoreSpec {
  readonly kind: DatabaseKind;
  readonly legacy: LegacyLayout;
  readonly steps: ReadonlyArray<MigrationStep>;
  readonly policy: boolean;
}

const stores: Readonly<Record<DatabaseKind, StoreSpec>> = {
  catalog: { kind: "catalog", legacy: catalogLegacy, steps: catalogMigrations, policy: false },
  guidance: { kind: "guidance", legacy: guidanceLegacy, steps: guidanceMigrations, policy: false },
  policy: { kind: "policy", legacy: policyLegacy, steps: policyMigrations, policy: true },
};

/*
 * the declared schema of each store file at its current format, computed at most once per run and only when an existing file
 * needs it: a fresh directory's files come from the same steps on an empty file and are never compared with it
 */
type References = Readonly<Record<DatabaseKind, Effect.Effect<SchemaSignature, DatabaseUpgradeError>>>;

// format 1 of the access database is the schema the auth service has always validated exactly; the step only records it
const accessSteps: ReadonlyArray<MigrationStep> = [{ from: 0, to: 1, apply: () => Effect.void }];

/** What the read-only preflight found: no file, a table-less format 0 file, the current format, or an older recognized one. */
type FileState =
  | { readonly state: "absent" }
  | { readonly state: "empty" }
  | { readonly state: "current" }
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

const refusal = (file: string | null, reason: UpgradeFailure) => new DatabaseUpgradeError({ file, reason });
// any other failure of a stage becomes that stage's reason; the cause (statement text, rows, paths) is dropped
const asUpgradeError = (file: string | null, reason: UpgradeFailure) => <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, DatabaseUpgradeError, R> =>
  Effect.mapError(effect, (error) => error instanceof DatabaseUpgradeError ? error : refusal(file, reason));

/**
 * The declared schema of a store file at its current format: its steps applied to an empty private in-memory database, the
 * program a fresh file goes through. Existing files are compared with it, never with a second copy of the statements.
 */
export const referenceSignature = (kind: DatabaseKind): Effect.Effect<SchemaSignature, DatabaseUpgradeError> => {
  const { file, format } = DatabaseFiles[kind];
  return Effect.scoped(Effect.gen(function* () {
    const steps = stepsBetween(stores[kind].steps, 0, format);
    if (steps === null) return yield* refusal(file, "migration_failed");
    const sql = yield* memoryDatabase;
    yield* sql.withTransaction(Effect.forEach(steps, (step) => step.apply(sql, { fresh: true, excludedThreadIds: [] }), { discard: true }));
    return yield* schemaSignature(sql);
  })).pipe(asUpgradeError(file, "migration_failed"));
};

// the preflight of one store file, read only: a read-only client never writes, creates no file and leaves a live WAL as it is
const inspect = (dataDirectory: string, spec: StoreSpec, reference: Effect.Effect<SchemaSignature, DatabaseUpgradeError>):
  Effect.Effect<FileState, DatabaseUpgradeError, FileSystem.FileSystem> => {
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
        if (spec.policy) yield* requirePolicyRow(sql).pipe(asUpgradeError(file, "invalid_policy"));
        return { state: "current" } as const;
      }
      if (format === 0) {
        if ((yield* schemaObjects(sql)).length === 0) return { state: "empty" } as const;
        const recognition = yield* recognizeLegacy(sql, yield* reference, spec.legacy);
        if (recognition.kind === "empty") return { state: "empty" } as const;
        if (recognition.kind === "unknown") return yield* refusal(file, "unknown_layout");
      } else if ((yield* schemaObjects(sql)).length === 0) return yield* refusal(file, "unknown_layout");
      if (stepsBetween(spec.steps, format, target) === null) return yield* refusal(file, "unknown_layout");
      if (spec.policy) yield* requirePolicyRow(sql).pipe(asUpgradeError(file, "invalid_policy"));
      return { state: "upgradable", format } as const;
    }));
  }).pipe(asUpgradeError(file, "unreadable"));
};

// the preflight of the access database, through the auth service's own checks
const inspectAccess = (dataDirectory: string): Effect.Effect<FileState, DatabaseUpgradeError, FileSystem.FileSystem> =>
  Effect.scoped(openExistingAccessDatabase(dataDirectory)).pipe(
    asUpgradeError(accessFile, "access_invalid"),
    Effect.flatMap((opened): Effect.Effect<FileState, DatabaseUpgradeError> => {
      if (opened === null) return Effect.succeed({ state: "absent" });
      if (opened.format === DatabaseFormats.access) return Effect.succeed({ state: "current" });
      if (opened.format > DatabaseFormats.access) return Effect.fail(refusal(accessFile, "future_format"));
      return stepsBetween(accessSteps, opened.format, DatabaseFormats.access) === null
        ? Effect.fail(refusal(accessFile, "unknown_layout")) : Effect.succeed({ state: "upgradable", format: opened.format });
    }));

const JournalMode = Schema.Tuple([Schema.Struct({ journal_mode: Schema.String })]);
const decodeJournalMode = Schema.decodeUnknownEffect(JournalMode);

interface Migration {
  readonly file: string;
  readonly from: number;
  readonly target: number;
  readonly steps: ReadonlyArray<MigrationStep>;
  /*
   * the declared schema an upgraded file must have before the commit; none for a file this run creates (the same steps on an
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

const storeMigration = (spec: StoreSpec, state: FileState, context: MigrationContext, reference: SchemaSignature | null): Migration => {
  const { file, format, journal } = DatabaseFiles[spec.kind];
  return {
    file, target: format, steps: spec.steps, reference, journal, context,
    from: state.state === "upgradable" ? state.format : 0,
    creating: state.state !== "upgradable",
  };
};

const upgradeStore = (dataDirectory: string, spec: StoreSpec, state: FileState, context: MigrationContext, reference: SchemaSignature | null) =>
  Effect.scoped(Effect.flatMap(
    openUpgradeDatabase(dataDirectory, spec.kind, { create: state.state === "absent" }).pipe(asUpgradeError(DatabaseFiles[spec.kind].file, "unreadable")),
    (database) => migrate(database, storeMigration(spec, state, context, reference))));

const upgradeAccess = (dataDirectory: string, from: number) => Effect.scoped(Effect.gen(function* () {
  const opened = yield* openExistingAccessDatabase(dataDirectory).pipe(asUpgradeError(accessFile, "access_invalid"));
  if (opened === null || opened.database === null) return yield* refusal(accessFile, "concurrent_change");
  return yield* migrate(opened.database, {
    file: accessFile, from, target: DatabaseFormats.access, steps: accessSteps, reference: null, creating: false, journal: "delete",
    context: { fresh: false, excludedThreadIds: [] },
  });
}));

// every existing file whose format changes, copied and verified before any upgrade write
const backupChanging = (dataDirectory: string, access: FileState, files: Readonly<Record<DatabaseKind, FileState>>) =>
  Effect.scoped(Effect.gen(function* () {
    const sources: Array<BackupSource> = [];
    if (access.state === "upgradable") {
      const opened = yield* openExistingAccessDatabase(dataDirectory).pipe(asUpgradeError(accessFile, "access_invalid"));
      if (opened === null || opened.database === null) return yield* refusal(accessFile, "concurrent_change");
      sources.push({ file: accessFile, name: "access-login.sqlite3", targetFormat: DatabaseFormats.access, database: opened.database });
    }
    for (const kind of ["catalog", "guidance", "policy"] as const) {
      if (files[kind].state !== "upgradable") continue;
      const { file, format } = DatabaseFiles[kind];
      const database = yield* openUpgradeDatabase(dataDirectory, kind, { create: false }).pipe(asUpgradeError(file, "unreadable"));
      sources.push({ file, name: file, targetFormat: format, database });
    }
    if (sources.length === 0) return null;
    return yield* writeBackupSet(dataDirectory, sources).pipe(
      Effect.mapError((failure) => refusal(failure.file, "backup_failed")),
      Effect.map((set) => set.id));
  }));

/*
 * the result as the stores and the auth service will open it: each file through its guarded open, the policy with its row. The
 * declared schema needs no second comparison: the preflight compared every current file, each upgrade compared its file
 * before the commit, and a created file is the steps' own result
 */
const verifyStore = (spec: StoreSpec, open: Effect.Effect<SqlClient.SqlClient, unknown, Scope.Scope | FileSystem.FileSystem>) =>
  Effect.scoped(Effect.gen(function* () {
    const sql = yield* open;
    if (spec.policy) yield* requirePolicyRow(sql);
  })).pipe(asUpgradeError(DatabaseFiles[spec.kind].file, "validation_failed"));

const verify = (dataDirectory: string, accessPresent: boolean) => Effect.gen(function* () {
  yield* verifyStore(stores.catalog, Effect.map(Layer.build(catalogDbLayer(dataDirectory)), (services) => Context.get(services, CatalogDb)));
  yield* verifyStore(stores.guidance, Effect.map(Layer.build(guidanceDbLayer(dataDirectory)), (services) => Context.get(services, GuidanceDb)));
  yield* verifyStore(stores.policy, Effect.map(Layer.build(policyDbLayer(dataDirectory)), (services) => Context.get(services, PolicyDb)));
  if (accessPresent) yield* verifyAccessDatabase(dataDirectory).pipe(asUpgradeError(accessFile, "validation_failed"));
});

/**
 * Prepares the data directory for this Supervisor before anything else opens it. A genuinely fresh directory (catalog,
 * guidance and thread-settings all absent or table-less at format 0) is created at the current formats, the policy first and
 * seeded from `excludedThreadIds` at generation 1, so an interrupted creation always leaves a directory whose policy exists.
 * An existing directory must still have its policy (it is never reseeded) and, when it has guidance state, its catalog; every
 * existing file whose format changes is backed up and verified first, then upgraded in the fixed order access, catalog,
 * guidance, thread-settings. The access database is created by the auth service's own bootstrap, never here.
 */
export const upgradeDataDirectory = (options: UpgradeOptions): Effect.Effect<UpgradeReport, DatabaseUpgradeError, FileSystem.FileSystem> => {
  const { dataDirectory } = options;
  return Effect.gen(function* () {
    // 0. the declared schema of every store file at its current format, from its own steps, once and only if a file needs it
    const references: References = {
      catalog: yield* Effect.cached(referenceSignature("catalog")),
      guidance: yield* Effect.cached(referenceSignature("guidance")),
      policy: yield* Effect.cached(referenceSignature("policy")),
    };
    // 1. the read-only preflight of every file; nothing is written before every file passed it
    const access = yield* inspectAccess(dataDirectory);
    const files = {
      catalog: yield* inspect(dataDirectory, stores.catalog, references.catalog),
      guidance: yield* inspect(dataDirectory, stores.guidance, references.guidance),
      policy: yield* inspect(dataDirectory, stores.policy, references.policy),
    };
    const fresh = !hasTables(files.catalog) && !hasTables(files.guidance) && !hasTables(files.policy);
    if (!fresh && !hasTables(files.policy)) return yield* refusal(DatabaseFiles.policy.file, "missing_policy");
    if (!fresh && hasTables(files.guidance) && !hasTables(files.catalog)) return yield* refusal(DatabaseFiles.catalog.file, "missing_catalog");

    // 2. the verified backup of every existing file whose format changes
    const backupSet = yield* backupChanging(dataDirectory, access, files);

    // 3. the upgrades, one file and one transaction at a time
    const changed: Array<UpgradedFile> = [];
    const context: MigrationContext = { fresh, excludedThreadIds: options.excludedThreadIds };
    const record = (file: string, state: FileState, to: number) => (applied: boolean) => {
      if (applied) changed.push({ file, from: state.state === "upgradable" ? state.format : null, to });
    };
    if (access.state === "upgradable") yield* upgradeAccess(dataDirectory, access.format).pipe(Effect.map(record(accessFile, access, DatabaseFormats.access)));
    const order: ReadonlyArray<DatabaseKind> = fresh ? ["policy", "catalog", "guidance"] : ["catalog", "guidance", "policy"];
    for (const kind of order) {
      const state = files[kind];
      if (state.state === "current") continue;
      const reference = state.state === "upgradable" ? yield* references[kind] : null;
      yield* upgradeStore(dataDirectory, stores[kind], state, context, reference).pipe(Effect.map(record(DatabaseFiles[kind].file, state, DatabaseFiles[kind].format)));
    }

    // 4. the result as the stores will open it
    yield* verify(dataDirectory, access.state !== "absent");
    const report: UpgradeReport = { fresh, backupSet, files: changed };
    // an upgrade of existing files is reported; creating the files of a new directory is the ordinary first start
    if (backupSet !== null) yield* logEvent("database_upgrade_completed", {
      backup_set: backupSet, files: changed.map((file) => `${file.file}:${file.from ?? "new"}>${file.to}`).join(","),
    });
    return report;
  }).pipe(Effect.tapError((error) => logEvent("database_upgrade_failed", { file: error.file, reason: error.reason })));
};

/**
 * The service start's upgrade of its configured data directory, before every other service of the process is built (layers
 * provided to the root services build first). It provides nothing; a failure fails the start.
 */
export const persistenceStartup = (options: UpgradeOptions): Layer.Layer<never, DatabaseUpgradeError, FileSystem.FileSystem> =>
  Layer.effectDiscard(upgradeDataDirectory(options));
