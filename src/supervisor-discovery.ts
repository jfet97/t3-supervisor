import { timestampMs } from "./timestamp.js";
import type { ThreadInfo } from "./types.js";

// pure discovery selection over the catalog: which mains changed and in what order, and the rotation's share of a cycle

/** The catalog fields discovery selection reads: the id and T3's latest-run fields, which pass through the catalog untyped. */
export type DiscoveryThread = Pick<ThreadInfo, "id"> &
  {latestRunId?: unknown; latestRunRequestedAt?: unknown; activityRunStatus?: unknown; latestRunStartedAt?: unknown; latestRunCompletedAt?: unknown};

const text = (value: unknown): string => typeof value === "string" ? value : "";

/**
 * The lifecycle of a main's latest run as T3's thread summary reports it: the run, its activity status and when it started and
 * completed. A fresh slot is remembered under this key, so a chat whose run is still preparing, whose project is off or whose Start
 * is pending is offered again exactly when T3 reports the next lifecycle change of that run, such as preparing to running, and not
 * before; null without a latest run.
 */
export const runLifecycleKey = (thread: DiscoveryThread): string | null => typeof thread.latestRunId === "string"
  ? [thread.latestRunId, text(thread.activityRunStatus), text(thread.latestRunStartedAt), text(thread.latestRunCompletedAt)].join("|")
  : null;

export type FreshThreadsInput<T extends DiscoveryThread> = {
  /** The eligible mains, in catalog order. */
  readonly threads: readonly T[];
  /** The activation baseline's latestRunId per thread id; a thread absent from it has no anchor. */
  readonly anchors: ReadonlyMap<string, string | null>;
  /** The stored task's sourceRunId per thread id, whether or not the task has a conversation. */
  readonly sourceRuns: ReadonlyMap<string, string>;
  /** The latestRunId examined as a non-task per thread id. */
  readonly examined: ReadonlyMap<string, string>;
  /** The run lifecycle key per thread id when this process last considered the thread, whatever that cycle made of it. */
  readonly considered: ReadonlyMap<string, string>;
};

// a thread whose latest run is a string no memory accounts for: not its activation anchor, not its task's source run, not a run
// examined as a non-task, and whose run lifecycle differs from the one memorized when it was last considered
const isFresh = <T extends DiscoveryThread>(input: FreshThreadsInput<T>, thread: T): boolean => {
  const key = runLifecycleKey(thread);
  const latestRunId = thread.latestRunId;
  return key !== null && typeof latestRunId === "string" && latestRunId !== input.anchors.get(thread.id) &&
    latestRunId !== input.sourceRuns.get(thread.id) && latestRunId !== input.examined.get(thread.id) && key !== input.considered.get(thread.id);
};

/**
 * The fresh mains of a cycle, oldest request first (unknown request times last, catalog order for ties): every thread whose latest run
 * changed since the activation anchor, its task's source run and the non-task examination, and whose run lifecycle T3 reports differently
 * from when this process last considered it. The caller memorizes each considered thread's lifecycle key first, whatever it then makes
 * of the thread, and discovers fresh threads before the rotation.
 *
 * Bounded fairness: a changed run gets one fresh slot per reported lifecycle state, so a skipped or deferred chat holds no slot until
 * T3 reports its run moved on, and the ready transition of a preparing chat is itself fresh; the oldest requests go first; unchanged
 * threads need no discovery and cost nothing beyond the rotation's skip test; the rotation never starves, because no set of chats can
 * occupy the fresh slots for more than one cycle per lifecycle change.
 */
export const freshThreads = <T extends DiscoveryThread>(input: FreshThreadsInput<T>): T[] =>
  input.threads.map((thread, index) => ({thread, index, requestedAt: timestampMs(thread.latestRunRequestedAt)}))
    .filter(({thread}) => isFresh(input, thread))
    .sort((a, b) => {
      if (a.requestedAt === null && b.requestedAt === null) return a.index - b.index;
      if (a.requestedAt === null) return 1;
      if (b.requestedAt === null) return -1;
      return a.requestedAt - b.requestedAt || a.index - b.index;
    })
    .map(({thread}) => thread);

export type RotationFillInput<T extends {id: string}> = {
  /** The eligible mains, in catalog order. */
  readonly threads: readonly T[];
  /** The ids this cycle already considered; they are walked past, never offered twice. */
  readonly exclude: ReadonlySet<string>;
  /** The rotation cursor over `threads`. */
  readonly cursor: number;
  /** The rotation's share of this cycle. */
  readonly limit: number;
};

/**
 * The rotation's share of a cycle: up to `limit` threads from `cursor` around the ring, one position at a time, skipping the excluded
 * ids, until the share is filled or every position was visited once. The cursor advances by the positions walked, so an unexcluded
 * full share is exactly the plain rotation: `limit` threads from the cursor, and the cursor moves by `limit`; a share of zero leaves
 * the cursor where it is.
 */
export const rotationFill = <T extends {id: string}>(input: RotationFillInput<T>): {rotated: T[]; nextCursor: number} => {
  const {threads, exclude, cursor, limit} = input;
  if (threads.length === 0) return {rotated: [], nextCursor: 0};
  const start = ((cursor % threads.length) + threads.length) % threads.length;
  const rotated: T[] = [];
  let advanced = 0;
  while (rotated.length < limit && advanced < threads.length) {
    const thread = threads[(start + advanced) % threads.length]!;
    advanced += 1;
    if (!exclude.has(thread.id)) rotated.push(thread);
  }
  return {rotated, nextCursor: (start + advanced) % threads.length};
};
