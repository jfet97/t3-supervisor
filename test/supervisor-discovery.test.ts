import assert from "node:assert/strict";
import {it} from "@effect/vitest";
import {freshThreads, rotationFill, runLifecycleKey, type DiscoveryThread} from "../src/supervisor-discovery.js";

// the pure discovery selection: which mains are fresh and in what order, and the rotation's share of a cycle

type Thread = DiscoveryThread & {projectId: string};
const at = (offsetMinutes: number) => new Date(Date.parse("2026-10-13T10:00:00.000Z") + offsetMinutes * 60_000).toISOString();
const thread = (id: string, latestRunId: unknown, requestedAt?: unknown, lifecycle: Partial<Thread> = {}): Thread =>
  ({id, projectId: "project-a", latestRunId, ...(requestedAt === undefined ? {} : {latestRunRequestedAt: requestedAt}), ...lifecycle});
const anchored = (count: number): Thread[] => Array.from({length: count}, (_, index) => thread(`old-${index}`, `run-old-${index}`, at(-100)));
const anchorsOf = (threads: readonly Thread[]): Map<string, string | null> => new Map(threads.map(item => [item.id, typeof item.latestRunId === "string" ? item.latestRunId : null]));
const empty = new Map<string, string>();
const ids = (threads: readonly {id: string}[]) => threads.map(item => item.id);
const fresh = (threads: readonly Thread[], memories: Partial<{anchors: Map<string, string | null>; sourceRuns: Map<string, string>; examined: Map<string, string>; considered: Map<string, string>}> = {}) =>
  freshThreads({threads, anchors: memories.anchors ?? empty, sourceRuns: memories.sourceRuns ?? empty, examined: memories.examined ?? empty, considered: memories.considered ?? empty});

it("the run lifecycle key names the run, its activity status and its start and completion, and is null without a run", () => {
  assert.equal(runLifecycleKey(thread("a", "run-1")), "run-1|||");
  assert.equal(runLifecycleKey(thread("a", "run-1", undefined, {activityRunStatus: "preparing"})), "run-1|preparing||");
  assert.equal(runLifecycleKey(thread("a", "run-1", undefined, {activityRunStatus: "running", latestRunStartedAt: at(1)})), `run-1|running|${at(1)}|`);
  assert.equal(runLifecycleKey(thread("a", "run-1", undefined, {latestRunCompletedAt: at(2)})), `run-1||${""}|${at(2)}`);
  assert.equal(runLifecycleKey(thread("a", null)), null);
  assert.equal(runLifecycleKey(thread("a", undefined)), null);
  assert.equal(runLifecycleKey(thread("a", 7)), null);
});

it("a cold start with ninety-eight anchored chats and one new request finds exactly that request fresh", () => {
  const threads = anchored(98);
  threads.splice(60, 0, thread("fresh", "run-fresh", at(0)));
  assert.deepEqual(ids(fresh(threads, {anchors: anchorsOf(threads.filter(item => item.id !== "fresh"))})), ["fresh"]);
  const anchoredToo = anchorsOf(threads);
  assert.deepEqual(fresh(threads, {anchors: anchoredToo}), [], "a request anchored in the baseline is not fresh");
});

it("fresh threads are ordered oldest request first, unknown request times last, catalog order for ties", () => {
  const threads = [thread("c", "run-c", at(3)), thread("unknown-b", "run-ub"), thread("a", "run-a", at(1)), thread("b", "run-b", at(1)), thread("unknown-a", "run-ua"), thread("d", "run-d", "not a time")];
  assert.deepEqual(ids(fresh(threads)), ["a", "b", "c", "unknown-b", "unknown-a", "d"]);
});

it("each memory blocks freshness on its own: the anchor, the task's source run, the examined non-task and the considered lifecycle", () => {
  const item = thread("a", "run-2", at(0), {activityRunStatus: "running"});
  assert.deepEqual(ids(fresh([item])), ["a"]);
  assert.deepEqual(fresh([item], {anchors: new Map([["a", "run-2"]])}), []);
  assert.deepEqual(ids(fresh([item], {anchors: new Map([["a", "run-1"]])})), ["a"], "a changed run is fresh past its anchor");
  assert.deepEqual(ids(fresh([item], {anchors: new Map([["a", null]])})), ["a"], "an anchor without a run never matches");
  assert.deepEqual(fresh([item], {sourceRuns: new Map([["a", "run-2"]])}), []);
  assert.deepEqual(fresh([item], {examined: new Map([["a", "run-2"]])}), []);
  assert.deepEqual(fresh([item], {considered: new Map([["a", runLifecycleKey(item)!]])}), []);
  assert.deepEqual(ids(fresh([item], {considered: new Map([["a", "run-2|preparing||"]])})), ["a"], "the same run in another lifecycle state is fresh again");
  assert.deepEqual(fresh([thread("a", null, at(0)), thread("b", undefined, at(0))]), [], "a thread without a latest run is never fresh");
});

it("a preparing chat is offered once per lifecycle state: memorized while preparing, fresh again when T3 reports the run started on the same run", () => {
  const preparing = thread("p", "run-p", at(0), {activityRunStatus: "preparing"});
  const considered = new Map<string, string>();
  assert.deepEqual(ids(fresh([preparing], {considered})), ["p"]);
  considered.set("p", runLifecycleKey(preparing)!);
  assert.deepEqual(fresh([preparing], {considered}), [], "still preparing: no second slot");
  const started = {...preparing, activityRunStatus: "running", latestRunStartedAt: at(1)};
  assert.deepEqual(ids(fresh([started], {considered})), ["p"], "the ready transition is fresh");
  considered.set("p", runLifecycleKey(started)!);
  assert.deepEqual(fresh([started], {considered}), [], "and it is offered once");
  const admitted = new Map([["p", "run-p"]]);
  assert.deepEqual(fresh([{...started, activityRunStatus: null, latestRunCompletedAt: at(5)}], {considered, sourceRuns: admitted}), [], "once its run is a task's source run, later lifecycle changes are not fresh");
});

it("the rotation share without exclusions is the plain rotation: twenty from the cursor and the cursor moves by twenty", () => {
  const threads = anchored(45);
  const first = rotationFill({threads, exclude: new Set(), cursor: 30, limit: 20});
  assert.deepEqual(ids(first.rotated), [...threads.slice(30), ...threads.slice(0, 5)].map(item => item.id));
  assert.equal(first.nextCursor, 5);
  const wrapped = rotationFill({threads, exclude: new Set(), cursor: 50, limit: 20});
  assert.equal(ids(wrapped.rotated)[0], "old-5", "the cursor is taken modulo the catalog");
  assert.equal(wrapped.nextCursor, 25);
});

it("the rotation share walks past considered ids without offering them twice, keeps the cursor on a zero share, and bounds itself to one lap", () => {
  const threads = anchored(10);
  const share = rotationFill({threads, exclude: new Set(["old-1", "old-2"]), cursor: 0, limit: 3});
  assert.deepEqual(ids(share.rotated), ["old-0", "old-3", "old-4"]);
  assert.equal(share.nextCursor, 5, "the cursor advances by the positions walked, excluded ones included");
  assert.deepEqual(rotationFill({threads, exclude: new Set(), cursor: 4, limit: 0}), {rotated: [], nextCursor: 4});
  const lap = rotationFill({threads, exclude: new Set(ids(threads)), cursor: 7, limit: 20});
  assert.deepEqual([lap.rotated, lap.nextCursor], [[], 7], "one full lap of excluded positions returns to the cursor");
  assert.deepEqual(rotationFill({threads: [], exclude: new Set(), cursor: 3, limit: 20}), {rotated: [], nextCursor: 0});
  const small = rotationFill({threads: threads.slice(0, 4), exclude: new Set(), cursor: 1, limit: 20});
  assert.deepEqual([ids(small.rotated), small.nextCursor], [["old-1", "old-2", "old-3", "old-0"], 1], "a catalog smaller than the share is offered whole, once");
});

it("thirty changed chats over a hundred are offered oldest first and each exactly once across cycles when the caller memorizes what it considered", () => {
  const threads = anchored(70);
  for (let index = 0; index < 30; index++) threads.splice(index * 3 + 1, 0, thread(`new-${index}`, `run-new-${index}`, at(30 - index)));
  const anchors = anchorsOf(threads.filter(item => item.id.startsWith("old-")));
  const considered = new Map<string, string>();
  const seen: string[] = [];
  for (let cycle = 0; cycle < 3; cycle++) {
    const batch = fresh(threads, {anchors, considered}).slice(0, 20);
    for (const item of batch) considered.set(item.id, runLifecycleKey(item)!);
    seen.push(...ids(batch));
    if (cycle === 0) assert.deepEqual(ids(batch), Array.from({length: 20}, (_, index) => `new-${29 - index}`), "the twenty oldest requests go first");
    if (cycle === 1) assert.equal(batch.length, 10);
    if (cycle === 2) assert.deepEqual(batch, []);
  }
  assert.equal(new Set(seen).size, 30);
  assert.equal(seen.length, 30, "no changed chat is offered twice");
});
