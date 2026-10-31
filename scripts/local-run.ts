import { accessSync, constants } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Clock, Data, Effect, FileSystem, Option, Schema, type Scope } from "effect";

// the run folders of the repository's local development stack (docs/local-stack.md). Each run owns one fresh folder under
// the system temporary directory holding every state, credential, project and log it creates; only a folder carrying the
// run marker is ever removed. Children get an environment built from nothing: the run's own home and configuration
// folders, never the invoking T3 address, credentials, provider logins or MCP registrations

export const runMarker = ".t3-supervisor-local-run";
export const runPrefix = "t3-supervisor-local-";
export const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

export type RunKind = "stack" | "fixture";

const Marker = Schema.Struct({kind: Schema.Literals(["stack", "fixture"]), createdAt: Schema.String, pid: Schema.Number});
const decodeMarker = Schema.decodeUnknownOption(Schema.fromJsonString(Marker));

// removal was refused: the folder carries no run marker
export class NotARunFolder extends Data.TaggedError("NotARunFolder")<{readonly path: string}> {}

export interface RunFolder {
  readonly path: string;
  readonly kind: RunKind;
  readonly dir: (...parts: ReadonlyArray<string>) => string;
}

/** The marker of a run folder, or none when the folder carries no valid marker. */
export const readMarker = (path: string) => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs.readFileString(join(path, runMarker)).pipe(Effect.option);
  return Option.flatMap(text, decodeMarker);
});

/** Removes a run folder and everything in it; any folder without a valid marker is refused and left untouched. */
export const removeRun = (path: string) => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  if (Option.isNone(yield* readMarker(path))) return yield* new NotARunFolder({path});
  yield* fs.remove(path, {recursive: true});
});

/**
 * A fresh private run folder (0700) with its marker, removed with the caller's scope unless `keep` is set. `root` is the
 * system temporary directory unless a test names another.
 */
export const createRun = (kind: RunKind, options: {readonly keep?: boolean; readonly root?: string} = {}): Effect.Effect<RunFolder, never, FileSystem.FileSystem | Scope.Scope> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* fs.makeTempDirectory({directory: options.root ?? tmpdir(), prefix: `${runPrefix}${kind}-`});
    yield* fs.chmod(path, 0o700);
    const createdAt = new Date(yield* Clock.currentTimeMillis).toISOString();
    yield* fs.writeFileString(join(path, runMarker), `${JSON.stringify({kind, createdAt, pid: process.pid})}\n`, {mode: 0o600});
    if (options.keep !== true) yield* Effect.addFinalizer(() => Effect.ignore(removeRun(path)));
    return {path, kind, dir: (...parts: ReadonlyArray<string>) => join(path, ...parts)};
  }).pipe(Effect.orDie);

// whether a process with this id still exists (a signal 0 probe)
export const processAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** Removes the marked run folders under `root` whose creating process has ended; live and unmarked folders stay. */
export const cleanRuns = (root: string = tmpdir()) => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const removed: string[] = [];
  const live: string[] = [];
  for (const name of yield* fs.readDirectory(root)) {
    if (!name.startsWith(runPrefix)) continue;
    const path = join(root, name);
    const marker = yield* readMarker(path);
    if (Option.isNone(marker)) continue;
    if (processAlive(marker.value.pid)) live.push(path);
    else {
      yield* removeRun(path);
      removed.push(path);
    }
  }
  return {removed, live};
});

// the directories of the named tools on the invoking PATH, then node's own and the system defaults, without repeats
export const toolPath = (tools: ReadonlyArray<string>, invokingPath: string): string => {
  const searched = invokingPath.split(delimiter).filter((entry) => isAbsolute(entry));
  const found = tools.flatMap((tool) => searched.filter((entry) => {
    try {
      accessSync(join(entry, tool), constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }).slice(0, 1));
  return [...new Set([dirname(process.execPath), ...found, "/usr/bin", "/bin"])].join(delimiter);
};

/**
 * The environment of a run's child, built from nothing: the run's home, configuration, cache, data, state and provider
 * folders and its temporary directory, the named tools' PATH, and `extra`. Nothing else of `invoking` is copied.
 */
export const isolatedEnv = (run: string, tools: ReadonlyArray<string>, invoking: NodeJS.ProcessEnv,
  extra: Readonly<Record<string, string>> = {}): Record<string, string> => {
  const home = join(run, "home");
  return {
    HOME: home, PATH: toolPath(tools, invoking.PATH ?? ""), LANG: "C.UTF-8", TMPDIR: join(run, "tmp"),
    XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"), XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_STATE_HOME: join(home, ".local", "state"), CODEX_HOME: join(home, ".codex"), CLAUDE_CONFIG_DIR: join(home, ".claude"),
    DO_NOT_TRACK: "1",
    ...extra,
  };
};
