import { createHash } from "node:crypto";
import { join, posix } from "node:path";
import { NodeCrypto, NodeFileSystem, NodeRuntime } from "@effect/platform-node";
import { Cause, Clock, Console, Context, Crypto, Data, Deferred, Effect, Exit, Fiber, FileSystem, Layer, Option, Ref, Result, Schedule, Schema } from "effect";
import { upgradeDataDirectory } from "../src/database-upgrade.js";
import { guidanceDbLayer } from "../src/db.js";
import { GitProbe } from "../src/git-probe.js";
import { GuidanceStore } from "../src/guidance-store.js";
import { SupervisorIds } from "../src/ids.js";
import { ProjectDefinitions, type DefinitionSourceFailure } from "../src/project-definitions.js";
import { ProjectFileError, ProjectFiles, ProjectWriter } from "../src/project-files.js";
import type { SupervisorModelInfo } from "../src/project-supervisor-contract.js";
import { makeStore, Store, StoreError, type StoreShape } from "../src/store.js";
import { NativeTransportLive } from "../src/supervisor.js";
import { NativeOperateRpc, NativeRpc, NativeShell } from "../src/supervisor-native.js";
import { T3Client } from "../src/t3.js";
import {
  InteractionMode, isHelperWebhookPath, NativeModelSelection, RuntimeMode, T3Native, webhookBody,
  type CommandReceipt, type HelperTaskView, type NativeRecord, type OrchestrationCommand, type T3FileError, type T3HelperFamily, type T3InvalidInput,
  type T3NativeShape, type T3PreparedCommand, type T3ReadError, type T3RequestError, type T3TerminalError, type T3Unsupported, type T3WebhookError,
  type ThreadSnapshot, type WebhookReply,
} from "../src/t3-native/index.js";
import type { MessageInfo, Projection, ThreadInfo } from "../src/types.js";
import { groupAlive, type ProcessResult } from "../test/support/cli-process.js";
import { portState, runProcess } from "../test/support/g8-process.js";
import { checkoutInputs } from "./local-run.js";
import { defaultCacheRoot, LocalStackError, startStack, t3Release, type RunningStack, type T3Release } from "./local-stack.js";
import { decodeTargetLock, targetRelease, TargetSlot } from "./t3-targets.js";

/*
  `node --import tsx scripts/t3-cohort.ts --probe`: the provider-free feasibility probe of one real published T3. It starts its own
  disposable stack (scripts/local-stack.ts) for the pinned release or a slot of a target lock (scripts/t3-targets.ts), builds the
  production T3Native from the stack's credential files as Supervisor's composition does, and exercises real operations through it:
  the environment and model configuration, project file reads, the production project setup path, the fresh Git probe, an
  explicit-message commit, the command lifecycle of a disposable thread and the helper webhook channel. Every step records classified
  evidence (docs/testing.md): accepted only for a definite positive answer whose read-back confirms it. A command is sent at most
  once; after an answer that is not definite the probe only reads back. Evidence names ids, field names, counts, lengths, equality
  booleans and classifications, never a token, a native body, a prompt, file contents or a raw cause. The stack signs in no provider
  and qualifies native operations only. Model answers, the Stop of a running turn, the cancellation of a genuinely queued run,
  check-in turn items, helper model behavior and compaction stay with the provider tier. Cancelling an idle thread's run is
  deliberately invalid input that T3 refuses, which T3Native classifies
  as uncertain, so it is no step here. Without a provider the turn a message starts may fail or stay running, so the settle and the
  idle Stop are sent to the launched thread while a read just before each shows it idle, before its message, and nothing waits for
  that turn to end.
*/

// ---- evidence ----

/** The evidence classes of a step, in rising severity */
export const outcomeClasses = ["accepted", "not-run", "harness", "uncertain", "rejected", "contradicted"] as const;
export type OutcomeClass = typeof outcomeClasses[number];

export interface Classified {
  readonly outcome: OutcomeClass;
  readonly detail: string;
}

/** The steps of one probe run, in order; each appears exactly once in a complete report */
export const plannedSteps = [
  "stack", "environment", "model-config", "files-read", "setup-scaffold", "git-probe", "commit", "thread-launch", "thread-watch",
  "thread-settle", "thread-stop-idle", "message-dispatch", "helper-task", "helper-webhook", "helper-delete", "teardown",
] as const;
export type StepName = typeof plannedSteps[number];

export interface StepEvidence extends Classified {
  readonly name: StepName;
  readonly operations: ReadonlyArray<string>;
  readonly elapsedMs: number;
}

/** What each step exercises: T3Native operations by their `family/operation` names, and the production paths over them */
export const stepOperations: Readonly<Record<StepName, ReadonlyArray<string>>> = {
  "stack": ["local-stack startStack"],
  "environment": ["orchestration/environment"],
  "model-config": ["orchestration/config"],
  "files-read": ["git (test setup)", "files/readFile", "files/listEntries", "files/metadata", "files/vcsRefs", "files/vcsStatus"],
  "setup-scaffold": ["orchestration/watchShell", "ProjectDefinitions.initialize create", "files/listEntries", "files/metadata", "files/readFile",
    "files/vcsRefs", "files/vcsStatus", "files/writeFile"],
  "git-probe": ["GitProbe.probe", "terminal/open", "terminal/attach", "terminal/write", "terminal/close", "git (read-back)"],
  "commit": ["files/commit", "git (read-back)"],
  "thread-launch": ["orchestration/launchThread", "orchestration/thread"],
  "thread-watch": ["orchestration/watchThread"],
  "message-dispatch": ["orchestration/dispatchCommand MessageDispatch", "orchestration/thread"],
  "thread-settle": ["orchestration/dispatchCommand ThreadSettle", "orchestration/thread", "orchestration/shellThreads"],
  "thread-stop-idle": ["orchestration/dispatchCommand ThreadStop", "orchestration/thread"],
  "helper-task": ["orchestration/thread", "helper/upsertTask", "helper/tasks"],
  "helper-webhook": ["helper/postWebhook", "helper/webhookDeliveries", "helper/webhookDelivery", "orchestration/thread"],
  "helper-delete": ["helper/deleteTask", "helper/tasks"],
  "teardown": ["stack scope close"],
};

const classified = (outcome: OutcomeClass) => (detail: string): Classified => ({outcome, detail});
export const accepted = classified("accepted");
export const rejected = classified("rejected");
export const uncertain = classified("uncertain");
export const contradicted = classified("contradicted");
export const harness = classified("harness");
export const notRun = classified("not-run");

/** A step that ran several operations takes the most severe of their classes and keeps every detail */
export const worst = (parts: ReadonlyArray<Classified>): Classified => parts.length === 0 ? harness("the step recorded no evidence") : {
  outcome: parts.reduce<OutcomeClass>((current, part) =>
    outcomeClasses.indexOf(part.outcome) > outcomeClasses.indexOf(current) ? part.outcome : current, "accepted"),
  detail: parts.map((part) => part.detail).join("; "),
};

/** A run passes only with exactly one evidence of every planned step, each accepted */
export const passedOf = (steps: ReadonlyArray<StepEvidence>): boolean =>
  plannedSteps.every((name) => steps.filter((step) => step.name === name).length === 1) && steps.every((step) => step.outcome === "accepted");

/** Every failure a T3Native operation reports */
export type T3Failure = T3RequestError | T3ReadError | T3InvalidInput | T3Unsupported | T3FileError | T3TerminalError | T3WebhookError;

/**
 * T3Native's classification of a failure as evidence: only T3's definite refusal is rejected; a request that may have left without a
 * definite answer, or whose reply does not satisfy the operation's receipt guard, is uncertain; an input the probe built wrong is
 * harness. The detail is the classification itself, never a native body.
 */
export const classifyFailure = (error: T3Failure): Classified => {
  switch (error._tag) {
    case "T3RequestError": {
      const detail = `${error.operation}: T3RequestError outcome=${error.outcome} definiteRejection=${error.definiteRejection} ` +
        `providerDisabled=${error.providerDisabled} dispatchCommandFailure=${error.dispatchCommandFailure} malformedReply=${error.malformedReply}`;
      return error.definiteRejection ? rejected(detail) : uncertain(detail);
    }
    case "T3ReadError": {
      const detail = `${error.operation}: T3ReadError "${error.message}"${error.httpStatus === undefined ? "" : ` httpStatus=${error.httpStatus}`}` +
        `${error.code === undefined ? "" : ` code=${error.code}`}`;
      return error.httpStatus !== undefined && error.httpStatus >= 400 && error.httpStatus < 500 ? rejected(detail) : uncertain(detail);
    }
    case "T3InvalidInput":
      return harness(`${error.operation}: T3InvalidInput, the probe's input failed the operation's contract and nothing was sent`);
    case "T3Unsupported":
      return rejected(`${error.operation}: T3Unsupported for ${error.serverVersion}, the reference profile records it absent and nothing was sent`);
    case "T3FileError": {
      const detail = `${error.operation}: T3FileError code=${error.code} scope=${error.scope}`;
      return error.code === "unavailable" ? uncertain(detail) : rejected(detail);
    }
    case "T3TerminalError": {
      const detail = `${error.operation}: T3TerminalError reason=${error.reason}`;
      return error.reason === "rejected" ? rejected(detail) : error.reason === "cancelled" ? harness(detail) : uncertain(detail);
    }
    case "T3WebhookError":
      return uncertain(`${error.operation}: T3WebhookError, the POST was started and its outcome is unknown`);
  }
};

/** What a read after a send showed: the claimed effect, its contradiction, or neither (an unreadable or neutral read) */
export type ReadBack =
  | {readonly _tag: "Confirmed"; readonly detail: string}
  | {readonly _tag: "Contradicted"; readonly detail: string}
  | {readonly _tag: "Inconclusive"; readonly detail: string};
export const confirmed = (detail: string): ReadBack => ({_tag: "Confirmed", detail});
export const refuted = (detail: string): ReadBack => ({_tag: "Contradicted", detail});
export const inconclusive = (detail: string): ReadBack => ({_tag: "Inconclusive", detail});

/** A definite positive answer is accepted only when its read-back confirms what it claimed */
export const afterAnswer = (answer: string, readBack: ReadBack): Classified => {
  const detail = `${answer}; read back: ${readBack.detail}`;
  return readBack._tag === "Confirmed" ? accepted(detail) : readBack._tag === "Contradicted" ? contradicted(detail) : uncertain(detail);
};

/**
 * A send without a definite positive answer keeps its class whatever is read back, so an uncertain send never becomes accepted; a
 * definite refusal whose effect is nevertheless visible is a contradiction
 */
export const afterFailure = (failure: Classified, readBack: ReadBack): Classified => {
  const detail = `${failure.detail}; read back: ${readBack.detail}`;
  if (failure.outcome === "rejected" && readBack._tag === "Confirmed") return contradicted(detail);
  return {outcome: failure.outcome === "accepted" ? "uncertain" : failure.outcome, detail};
};

/** The command identities this run sent: a command is sent at most once, whatever its answer was */
export type SendLedger = Ref.Ref<ReadonlySet<string>>;
export const makeLedger: Effect.Effect<SendLedger> = Ref.make<ReadonlySet<string>>(new Set());

export type Sent<A, E> = {readonly _tag: "Sent"; readonly result: Result.Result<A, E>} | {readonly _tag: "Duplicate"};

/** Sends under an identity only the first time; a second send of the same identity sends nothing */
export const sendOnce = <A, E, R>(ledger: SendLedger, identity: string, send: Effect.Effect<A, E, R>): Effect.Effect<Sent<A, E>, never, R> =>
  Effect.flatMap(Ref.modify(ledger, (sent): readonly [boolean, ReadonlySet<string>] => sent.has(identity) ? [false, sent] : [true, new Set([...sent, identity])]),
    (fresh) => fresh ? Effect.map(Effect.result(send), (result): Sent<A, E> => ({_tag: "Sent", result})) : Effect.succeed<Sent<A, E>>({_tag: "Duplicate"}));

/** A prepared command's one initiation and its reply; the flight is released exactly once at any end */
export const initiated = <A, E>(prepared: T3PreparedCommand<A, E>): Effect.Effect<A, E> =>
  Effect.acquireUseRelease(Effect.suspend(() => prepared.initiate()), (flight) => flight.result, (flight) => flight.release);

const gitProbeRefusals: ReadonlySet<string> = new Set(["T3 rejected a terminal Git probe request.", "T3 rejected the terminal attach request."]);
// the probe's terminal process, its own input or its own pending-session store failed around T3's answers
const gitProbeEnvironment: ReadonlySet<string> = new Set([
  "The probe terminal exited before the Git check started.", "The Git probe process did not exit successfully.", "The terminal Git probe reported an error.",
  "The Git probe bootstrap exceeded its input limit.", "The Git probe helper exceeded its input limit.", "The selected checkout path is invalid.",
  "Pending native Git probe cleanup state is invalid.", "A fresh native Git probe failed.", "The Git probe was canceled.",
]);

/** The production Git probe's fixed failure messages as evidence; any other end (a deadline, a lost socket, a reply off its guard) is uncertain */
export const classifyGitProbe = (message: string): Classified => {
  const detail = `GitProbeError "${message}"`;
  return gitProbeRefusals.has(message) ? rejected(detail) : gitProbeEnvironment.has(message) ? harness(detail) : uncertain(detail);
};

/** The paths of `git status --porcelain=v1 -z`: each entry's path, and both paths of a rename or copy */
export const porcelainPaths = (raw: string): ReadonlyArray<string> => {
  const fields = raw.split("\0");
  const paths: string[] = [];
  for (let index = 0; index < fields.length; index++) {
    const entry = fields[index] ?? "";
    if (entry.length < 4) continue;
    paths.push(entry.slice(3));
    const code = entry.slice(0, 2);
    if (code.includes("R") || code.includes("C")) {
      const source = fields[index + 1];
      if (source !== undefined && source.length > 0) paths.push(source);
      index++;
    }
  }
  return paths;
};

export const sameSet = (left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean => {
  const a = new Set(left);
  const b = new Set(right);
  return a.size === b.size && [...a].every((item) => b.has(item));
};

// run states that keep a thread from being idle: live, waiting on post-terminal output, or queued
const busyRunStatuses: ReadonlySet<string> = new Set(["preparing", "starting", "running", "waiting", "queued"]);
export const idle = (projection: Pick<Projection, "runs">): boolean => projection.runs.every((run) => !busyRunStatuses.has(run.status));

export const runSummary = (projection: Pick<Projection, "runs">): string => {
  if (projection.runs.length === 0) return "no runs";
  const counts = new Map<string, number>();
  for (const run of projection.runs) counts.set(run.status, (counts.get(run.status) ?? 0) + 1);
  return [...counts].map(([status, count]) => `${count} ${stated(status)}`).join(", ");
};

/** A native scalar as evidence may show it: short strings, numbers and booleans; otherwise only its kind */
export const stated = (value: unknown): string => typeof value === "string" ? JSON.stringify(value.slice(0, 64))
  : typeof value === "number" || typeof value === "boolean" ? String(value)
    : value === null ? "null" : value === undefined ? "absent" : Array.isArray(value) ? "an array" : typeof value;

const isRecord = Schema.is(Schema.Record(Schema.String, Schema.Unknown));

// ---- helper delivery evidence ----

/** The delivery log and the thread as read after one webhook POST */
export interface DeliveryObservation {
  // the delivery log read's failure, null once it was read
  readonly logFailure: Classified | null;
  readonly listed: number;
  readonly deliveryId: string | null;
  readonly summary: NativeRecord | null;
  readonly detail: NativeRecord | null;
  readonly detailFailure: Classified | null;
  readonly message: MessageInfo | null;
  readonly threadFailure: Classified | null;
}

export interface DeliveryExpectation {
  readonly taskId: string;
  readonly body: string;
  readonly bodyBytes: number;
}

// outcomes T3 logs for a delivery it did not dispatch to the thread (ScheduledTaskService.ts at the pinned tag)
const refusedDeliveryOutcomes: ReadonlySet<string> = new Set(["dispatch_failed", "rejected_signature", "disabled", "rate_limited", "expired", "prompt_too_long"]);

const deliveryFacts = (seen: DeliveryObservation, expected: DeliveryExpectation): string => {
  const detail = seen.detail;
  const log = seen.logFailure !== null ? `delivery log unreadable (${seen.logFailure.detail})`
    : `${seen.listed} deliveries listed, delivery ${seen.deliveryId === null ? "not identified" : "identified"}`;
  const record = detail === null ? (seen.detailFailure === null ? "no delivery detail" : `delivery detail unreadable (${seen.detailFailure.detail})`)
    : `outcome ${stated(detail.outcome)}, method ${stated(detail.method)}, contentType ${stated(detail.contentType)}, bodyBytes ${stated(detail.bodyBytes)} ` +
      `(sent ${expected.bodyBytes}), body equal ${detail.body === expected.body}, bodyTruncated ${stated(detail.bodyTruncated)}, missingFields ` +
      `${Array.isArray(detail.missingFields) ? `${detail.missingFields.length} named` : "absent"}, renderedPrompt ` +
      `${typeof detail.renderedPrompt === "string" ? (detail.renderedPrompt.length > 0 ? "present and non-empty" : "empty") : stated(detail.renderedPrompt)}`;
  const message = seen.message === null ? (seen.threadFailure === null ? "no delivered message in the thread" : `thread unreadable (${seen.threadFailure.detail})`)
    : `message present, role ${stated(seen.message.role)}, scheduledTaskId equal ${seen.message.scheduledTaskId === expected.taskId}, creationSource ` +
      `${stated(seen.message.creationSource)}, createdBy ${stated(seen.message.createdBy)}, text equals renderedPrompt ` +
      `${detail !== null && typeof detail.renderedPrompt === "string" && seen.message.text === detail.renderedPrompt}`;
  return `${log}; ${record}; ${message}`;
};

/**
 * The helper channel's evidence for one POST, judged as the helper transport proves a delivery (src/supervisor-helper-transport.ts):
 * the exact request in the native delivery log with its rendered prompt, and the deterministic scheduled message, from the system on
 * the server, whose text is that rendered prompt
 */
export const judgeDelivery = (post: {readonly _tag: "Reply"; readonly reply: WebhookReply} | {readonly _tag: "Failed"; readonly failure: Classified},
  seen: DeliveryObservation, expected: DeliveryExpectation): Classified => {
  const facts = deliveryFacts(seen, expected);
  const delivered = seen.message !== null ? confirmed(facts) : inconclusive(facts);
  if (post._tag === "Failed") return afterFailure(post.failure, delivered);
  if (post.reply._tag === "Refused") return afterFailure(rejected(`helper/postWebhook refused with HTTP ${post.reply.httpStatus}`), delivered);
  if (post.reply._tag === "Unconfirmed") return afterFailure(uncertain(`helper/postWebhook answered HTTP ${post.reply.httpStatus}`), delivered);
  const answer = `helper/postWebhook accepted, delivery id ${post.reply.deliveryId === undefined ? "absent from" : "named in"} the reply`;
  if (seen.deliveryId === null) return afterAnswer(answer, seen.logFailure === null ? refuted(`the delivery log does not show it; ${facts}`) : inconclusive(facts));
  const detail = seen.detail;
  if (detail === null) return afterAnswer(answer, inconclusive(facts));
  const outcome = typeof detail.outcome === "string" ? detail.outcome : null;
  if (seen.message === null) {
    if (outcome !== null && refusedDeliveryOutcomes.has(outcome)) return rejected(`${answer}; T3 logged ${outcome} and created no message; ${facts}`);
    return afterAnswer(answer, inconclusive(`no delivered message within the read-back window; ${facts}`));
  }
  const message = seen.message;
  const exact = detail.id === seen.deliveryId && detail.taskId === expected.taskId && detail.method === "POST" && detail.contentType === "application/json" &&
    detail.bodyBytes === expected.bodyBytes && detail.bodyTruncated === false && detail.body === expected.body &&
    Array.isArray(detail.missingFields) && detail.missingFields.length === 0 && (seen.summary === null || seen.summary.outcome === detail.outcome);
  const rendered = typeof detail.renderedPrompt === "string" && detail.renderedPrompt.length > 0;
  const attributed = message.id === `scheduled-task-message:${expected.taskId}:webhook:${seen.deliveryId}` && message.role === "user" &&
    message.scheduledTaskId === expected.taskId && message.creationSource === "server" && message.createdBy === "system" && message.text === detail.renderedPrompt;
  return afterAnswer(answer, outcome === "accepted" && exact && rendered && attributed ? confirmed(facts) : refuted(facts));
};

// ---- arguments ----

const usage = "usage: node --import tsx scripts/t3-cohort.ts --probe [--keep] [--cache-dir <path>] [--t3-lock <file> --slot <stable|nightly|nightly-1|nightly-2>]";

export type ParsedArguments =
  | {readonly _tag: "Probe"; readonly keep: boolean; readonly cacheDir: string | null; readonly lock: {readonly file: string; readonly slot: TargetSlot} | null}
  | {readonly _tag: "Invalid"; readonly message: string};

const decodeSlot = Schema.decodeUnknownOption(TargetSlot);

export const parseArguments = (args: ReadonlyArray<string>): ParsedArguments => {
  const invalid = (message: string): ParsedArguments => ({_tag: "Invalid", message});
  const flags = new Set<string>();
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? "";
    if (arg === "--probe" || arg === "--keep") {
      if (flags.has(arg)) return invalid(`${arg} is given twice`);
      flags.add(arg);
    } else if (arg === "--cache-dir" || arg === "--t3-lock" || arg === "--slot") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) return invalid(`${arg} needs a value`);
      if (values.has(arg)) return invalid(`${arg} is given twice`);
      values.set(arg, value);
      index++;
    } else return invalid(`unknown argument ${arg}`);
  }
  if (!flags.has("--probe")) return invalid("--probe is required");
  const file = values.get("--t3-lock");
  const slotText = values.get("--slot");
  if ((file === undefined) !== (slotText === undefined)) return invalid("--t3-lock and --slot are given together");
  let lock: {readonly file: string; readonly slot: TargetSlot} | null = null;
  if (file !== undefined && slotText !== undefined) {
    const slot = decodeSlot(slotText);
    if (Option.isNone(slot)) return invalid(`unknown slot ${slotText}`);
    lock = {file, slot: slot.value};
  }
  return {_tag: "Probe", keep: flags.has("--keep"), cacheDir: values.get("--cache-dir") ?? null, lock};
};

// ---- the probe ----

export class CohortProbeError extends Data.TaggedError("CohortProbeError")<{readonly message: string}> {}

/** What the thread lifecycle needs of a run: its T3Native, its send ledger, fresh identities, its report and the stack's project */
export interface ThreadContext {
  readonly native: T3NativeShape;
  readonly ledger: SendLedger;
  readonly uuid: Effect.Effect<string>;
  readonly report: (evidence: StepEvidence) => Effect.Effect<void>;
  readonly projectId: string;
}

interface ProbeContext extends ThreadContext {
  readonly stack: RunningStack;
  readonly release: T3Release;
}

interface StepOutcome<P> {
  readonly result: Classified;
  readonly provides: P | null;
}
const finished = <P>(result: Classified, provides: P | null = null): StepOutcome<P> => ({result, provides});

const elapsedSince = (started: bigint): Effect.Effect<number> =>
  Effect.map(Clock.monotonicTimeNanos, (now) => Math.round(Number(now - started) / 1_000_000));

// the tag or class name of a defect, never its message or cause
const defectName = (cause: Cause.Cause<unknown>): string => {
  const value = Cause.squash(cause);
  if (isRecord(value) && typeof value._tag === "string") return value._tag;
  return value instanceof Error ? value.name : typeof value;
};

/** Runs one step and reports its evidence with its elapsed time; a probe defect inside it is harness, an interruption stays one */
const runStep = <P, R>(ctx: Pick<ThreadContext, "report">, name: StepName, body: Effect.Effect<StepOutcome<P>, never, R>): Effect.Effect<P | null, never, R> =>
  Effect.gen(function* () {
    const started = yield* Clock.monotonicTimeNanos;
    const exit = yield* Effect.exit(body);
    if (Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)) return yield* Effect.failCause(exit.cause);
    const outcome = Exit.isSuccess(exit) ? exit.value : finished<P>(harness(`the probe failed inside the step (${defectName(exit.cause)})`));
    yield* ctx.report({name, operations: stepOperations[name], ...outcome.result, elapsedMs: yield* elapsedSince(started)});
    return outcome.provides;
  });

const skip = <P>(ctx: Pick<ThreadContext, "report">, name: StepName, reason: string): Effect.Effect<P | null> =>
  Effect.as(ctx.report({name, operations: stepOperations[name], ...notRun(reason), elapsedMs: 0}), null);

// git in the disposable project folder with T3's own environment; null when git could not run there
const git = (stack: RunningStack, args: ReadonlyArray<string>): Effect.Effect<ProcessResult | null> =>
  runProcess("git", args, {env: stack.cli.env, cwd: stack.project.path, timeoutMs: 30_000}).pipe(Effect.catchDefect(() => Effect.succeed(null)));

const gitLine = (stack: RunningStack, args: ReadonlyArray<string>): Effect.Effect<string | null> =>
  Effect.map(git(stack, args), (result) => result !== null && result.code === 0 && result.stdout.trim().length > 0 ? result.stdout.trim() : null);

// the changed paths git itself reports, with the options the production probe's helper uses; null when git could not run
const gitChanges = (stack: RunningStack): Effect.Effect<ReadonlyArray<string> | null> =>
  Effect.map(git(stack, ["--no-optional-locks", "status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none"]),
    (result) => result !== null && result.code === 0 ? porcelainPaths(result.stdout) : null);

type ThreadRead = Result.Result<ThreadSnapshot, T3ReadError | T3InvalidInput>;
const readThread = (ctx: Pick<ThreadContext, "native">, threadId: string): Effect.Effect<ThreadRead> => Effect.result(ctx.native.orchestration.thread(threadId));
// read until a snapshot at or past `sequence`, a command's commit point: at most twenty more reads, half a second apart
const readThreadAt = (ctx: Pick<ThreadContext, "native">, threadId: string, sequence: number | null): Effect.Effect<ThreadRead> =>
  readThread(ctx, threadId).pipe(Effect.repeat({schedule: Schedule.spaced("500 millis"), times: 20,
    until: (read: ThreadRead) => Result.isSuccess(read) && (sequence === null || read.success.snapshotSequence >= sequence)}));
const unreadableThread = (read: ThreadRead): ReadBack => inconclusive(Result.isFailure(read) ? classifyFailure(read.failure).detail : "read");
const notFound = (read: ThreadRead): boolean => {
  if (Result.isSuccess(read)) return false;
  const failure = read.failure;
  return failure._tag === "T3ReadError" && failure.httpStatus === 404;
};

// ---- 1. environment and model configuration ----

const environmentStep = (ctx: ProbeContext) => runStep(ctx, "environment", Effect.gen(function* () {
  const read = yield* Effect.result(ctx.native.orchestration.environment);
  if (Result.isFailure(read)) return finished<never>(classifyFailure(read.failure));
  const descriptor = read.success;
  const facts = yield* ctx.native.build.observed;
  const detail = `serverVersion ${stated(descriptor.serverVersion)}, orchestration protocol ${descriptor.orchestrationProtocolVersion}, build facts recorded ` +
    `${facts !== null}, reference build ${facts?.referenceBuild === true}`;
  return finished<never>(descriptor.serverVersion === ctx.release.version && facts !== null ? accepted(detail)
    : contradicted(`${detail}; the requested release is ${ctx.release.version}`));
}));

export interface ModelChoice {
  readonly instanceId: string;
  readonly model: string;
  readonly available: boolean;
}

export const describeProviders = (models: ReadonlyArray<SupervisorModelInfo>): string => {
  const providers = new Map<string, {readonly name: string; readonly models: number; readonly available: number}>();
  for (const model of models) {
    const entry = providers.get(model.instanceId) ?? {name: model.providerName, models: 0, available: 0};
    providers.set(model.instanceId, {name: entry.name, models: entry.models + 1, available: entry.available + (model.available ? 1 : 0)});
  }
  return providers.size === 0 ? "no provider advertises a model"
    : [...providers].map(([id, entry]) => `${stated(id)} (${stated(entry.name)}): ${entry.models} models, ${entry.available} available`).join(", ");
};

const modelConfigStep = (ctx: ProbeContext) => runStep(ctx, "model-config", Effect.gen(function* () {
  const read = yield* Effect.result(ctx.native.orchestration.config);
  if (Result.isFailure(read)) return finished<ModelChoice>(classifyFailure(read.failure));
  const models = read.success;
  const choice = models.find((model) => model.available) ?? models[0];
  return finished<ModelChoice>(accepted(`${models.length} models; ${describeProviders(models)}`),
    choice === undefined ? null : {instanceId: choice.instanceId, model: choice.model, available: choice.available});
}));

// ---- 2. project files ----

export interface Repository {
  readonly branch: string;
  readonly head: string;
}

const testIdentity = {name: "T3 cohort probe", email: "t3-cohort-probe@example.invalid"} as const;

const sameDirectory = (left: string, right: string) => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const a = yield* Effect.option(fs.realPath(left));
  const b = yield* Effect.option(fs.realPath(right));
  return Option.isSome(a) && Option.isSome(b) && a.value === b.value;
});

// test setup of the disposable project only: its own Git repository with a repo-local test identity and an initial commit
const prepareRepository = (ctx: ProbeContext): Effect.Effect<Result.Result<Repository & {readonly created: boolean}, string>, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const top = yield* git(ctx.stack, ["rev-parse", "--show-toplevel"]);
    if (top === null) return Result.fail("git could not run in the project folder");
    const own = top.code === 0 && (yield* sameDirectory(top.stdout.trim(), ctx.stack.project.path));
    const setup: ReadonlyArray<ReadonlyArray<string>> = [
      ...(own ? [] : [["init", "-q", "-b", "main"]]),
      ["config", "user.name", testIdentity.name], ["config", "user.email", testIdentity.email], ["config", "commit.gpgsign", "false"],
    ];
    for (const args of setup) {
      const result = yield* git(ctx.stack, args);
      if (result === null || result.code !== 0) return Result.fail(`git ${args[0] ?? ""} failed in the project folder`);
    }
    if ((yield* gitLine(ctx.stack, ["rev-parse", "-q", "--verify", "HEAD"])) === null)
      for (const args of [["add", "-A"], ["commit", "-q", "-m", "Disposable cohort probe project"]]) {
        const result = yield* git(ctx.stack, args);
        if (result === null || result.code !== 0) return Result.fail(`git ${args[0] ?? ""} failed in the project folder`);
      }
    const branch = yield* gitLine(ctx.stack, ["symbolic-ref", "--short", "-q", "HEAD"]);
    const head = yield* gitLine(ctx.stack, ["rev-parse", "HEAD"]);
    if (branch === null || head === null) return Result.fail("the project folder has no branch or no commit");
    return Result.succeed({branch, head, created: !own});
  });

// a definite missing or invalid answer about a path that exists contradicts it
const existingPath = (error: T3FileError | T3InvalidInput): Classified => {
  const failure = classifyFailure(error);
  return error._tag === "T3FileError" && (error.code === "missing" || error.code === "invalid_file")
    ? contradicted(`${failure.detail} for a path that exists`) : failure;
};

const filesReadStep = (ctx: ProbeContext) => runStep(ctx, "files-read", Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const prepared = yield* prepareRepository(ctx);
  if (Result.isFailure(prepared)) return finished<Repository>(harness(prepared.failure));
  const repository = prepared.success;
  const root = ctx.stack.project.path;
  const reads = ctx.native.files.read;
  const parts: Array<Classified> = [accepted(`git ${repository.created ? "initialized" : "found"} on ${stated(repository.branch)} with a repo-local test identity`)];

  const local = yield* Effect.option(fs.readFileString(join(root, "README.md")));
  const file = yield* Effect.result(reads.readFile({cwd: root, relativePath: "README.md"}));
  if (Result.isFailure(file)) parts.push(existingPath(file.failure));
  else {
    const contents = file.success;
    parts.push(afterAnswer(`readFile README.md byteLength ${contents.byteLength}, truncated ${contents.truncated}`, Option.isNone(local)
      ? inconclusive("the container could not read README.md")
      : !contents.truncated && contents.contents === local.value && contents.byteLength === Buffer.byteLength(local.value)
        ? confirmed("equal to the file on disk") : refuted("differs from the file on disk")));
  }

  const listing = yield* Effect.result(reads.listEntries({cwd: root, directoryPath: ""}));
  if (Result.isFailure(listing)) parts.push(existingPath(listing.failure));
  else parts.push(afterAnswer(`listEntries ${listing.success.entries.length} entries, truncated ${listing.success.truncated}`,
    listing.success.entries.some((entry) => entry.path === "README.md" && entry.kind === "file") ? confirmed("README.md listed as a file")
      : refuted("README.md not listed as a file")));

  const metadata = yield* Effect.result(reads.metadata({paths: [root, join(root, ".git"), join(root, "README.md")]}));
  if (Result.isFailure(metadata)) parts.push(existingPath(metadata.failure));
  else {
    const kinds = metadata.success.entries.map((entry) => isRecord(entry) ? stated(entry.kind) : "not a record").join(",");
    parts.push(afterAnswer(`metadata kinds ${kinds}`, kinds === "\"directory\",\"directory\",\"file\"" ? confirmed("the root, .git and README.md as on disk")
      : refuted("expected a directory, a directory and a file")));
  }

  const refs = yield* Effect.result(reads.vcsRefs({cwd: root}));
  if (Result.isFailure(refs)) parts.push(existingPath(refs.failure));
  else {
    const current = refs.success.refs.filter((ref) => ref.current && ref.isRemote !== true).map((ref) => ref.name);
    parts.push(afterAnswer(`vcsRefs isRepo ${refs.success.isRepo}, ${refs.success.refs.length} refs, current ${current.map(stated).join(",") || "none"}`,
      refs.success.isRepo && current.length === 1 && current[0] === repository.branch ? confirmed("the current branch git reports")
        : refuted(`git reports ${stated(repository.branch)}`)));
  }

  const status = yield* Effect.result(reads.vcsStatus({cwd: root}));
  const changes = yield* gitChanges(ctx.stack);
  if (Result.isFailure(status)) parts.push(existingPath(status.failure));
  else {
    const paths = status.success.workingTree.files.map((entry) => entry.path);
    parts.push(afterAnswer(`vcsStatus isRepo ${status.success.isRepo}, ${paths.length} changed paths`, changes === null ? inconclusive("git status could not run")
      : status.success.isRepo && sameSet(paths, changes) ? confirmed(`the same ${changes.length} paths as git status`)
        : refuted(`git status reports ${changes.length} paths`)));
  }
  return finished<Repository>(worst(parts), {branch: repository.branch, head: repository.head});
}));

/** The scaffold Supervisor's project setup writes (src/project-definitions.ts createScaffold), in its order */
export const setupScaffold = [
  {path: ".t3-supervisor/project.yaml", contents: "workflows: []\nsteps: []\n"},
  {path: ".t3-supervisor/steps/.gitkeep", contents: ""},
  {path: ".t3-supervisor/workflows/.gitkeep", contents: ""},
] as const;

type Catalog = {readonly _tag: "Ready"; readonly store: StoreShape; readonly root: string} | {readonly _tag: "Failed"; readonly result: Classified};

/*
 * Supervisor's catalog store fed by the read credential's shell watch until it connected, as Supervisor's root ingests T3 (src/supervisor.ts);
 * its fresh data directory is first prepared by the startup upgrade, as the service's first start prepares one
 */
const catalogOf = (ctx: ProbeContext) => Effect.gen(function* () {
  const failed = (result: Classified): Catalog => ({_tag: "Failed", result});
  const directory = ctx.stack.run.dir("cohort", "catalog");
  const built = yield* Effect.result(upgradeDataDirectory({dataDirectory: directory, excludedThreadIds: []}).pipe(
    Effect.andThen(Layer.build(makeStore(directory)))));
  if (Result.isFailure(built)) return failed(harness("the probe's catalog store could not be opened"));
  const store = Context.get(built.success, Store);
  const connected = yield* Deferred.make<void>();
  const watch = yield* Effect.forkScoped(ctx.native.orchestration.watchShell(undefined, (item) =>
    Effect.flatMap(store.ingest(item), (result) => result.connected ? Effect.asVoid(Deferred.succeed(connected, undefined)) : Effect.void)));
  const waited = yield* Effect.raceFirst(Deferred.await(connected), Fiber.join(watch)).pipe(Effect.result, Effect.timeoutOption("30 seconds"));
  yield* Fiber.interrupt(watch);
  if (Option.isNone(waited)) return failed(uncertain("orchestration/watchShell: the catalog did not connect within 30 s"));
  if (Result.isFailure(waited.value)) {
    const error = waited.value.failure;
    return failed(error instanceof StoreError ? uncertain(`orchestration/watchShell: the catalog store refused an item ("${error.message.slice(0, 120)}")`)
      : classifyFailure(error));
  }
  const catalog = yield* Effect.result(store.catalog());
  if (Result.isFailure(catalog)) return failed(harness("the probe's catalog store could not be read"));
  const project = catalog.success.projects.find((item) => item.project.id === ctx.stack.project.id && item.available);
  if (project === undefined) return failed(contradicted(`the connected catalog lists ${catalog.success.projects.length} projects without the stack's project`));
  return {_tag: "Ready", store, root: project.project.workspaceRoot} satisfies Catalog;
});

interface ScaffoldRead {
  readonly written: ReadonlyArray<string>;
  readonly unreadable: boolean;
  readonly detail: string;
}

// each scaffold file through T3's read credential and on disk: written only when both show exactly the setup's contents
const scaffoldRead = (ctx: ProbeContext) => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const written: string[] = [];
  let unreadable = false;
  for (const file of setupScaffold) {
    const native = yield* Effect.result(ctx.native.files.read.readFile({cwd: ctx.stack.project.path, relativePath: file.path}));
    const disk = yield* Effect.option(fs.readFileString(join(ctx.stack.project.path, file.path)));
    if (Result.isFailure(native) && classifyFailure(native.failure).outcome === "uncertain") unreadable = true;
    if (Result.isSuccess(native) && !native.success.truncated && native.success.contents === file.contents && Option.isSome(disk) &&
      disk.value === file.contents) written.push(file.path);
  }
  return {written, unreadable, detail: `${written.length} of ${setupScaffold.length} scaffold files equal through T3 and on disk`} satisfies ScaffoldRead;
});

const definitionFailure = (failure: DefinitionSourceFailure): Classified => {
  const error = failure.error;
  if (error instanceof ProjectFileError) {
    const detail = `the setup path failed: ProjectFileError code=${error.code} scope=${error.scope}`;
    return error.code === "unavailable" ? uncertain(detail) : rejected(detail);
  }
  return uncertain(`the setup path failed: DefinitionSourceFailure (${isRecord(error) && typeof error._tag === "string" ? error._tag : typeof error})`);
};

/** The scaffold files the setup wrote, and the checkout root Supervisor's definitions resolve from the catalog for the project */
interface Scaffold {
  readonly written: ReadonlyArray<string>;
  readonly root: string;
}

const setupScaffoldStep = (ctx: ProbeContext, repository: Repository) => runStep(ctx, "setup-scaffold", Effect.scoped(Effect.gen(function* () {
  const writes = ctx.native.files.write;
  if (writes === null) return finished<Scaffold>(harness("the project-write credential is not configured"));
  const catalog = yield* catalogOf(ctx);
  if (catalog._tag === "Failed") return finished<Scaffold>(catalog.result);
  const writer = yield* ProjectWriter.make(writes);
  const definitions = yield* ProjectDefinitions.make({source: catalog.store, t3: ctx.native.orchestration, files: yield* ProjectFiles.make(ctx.native.files.read),
    options: {setupWriter: {writeFile: writer.writeFile}}});
  const setup = yield* Effect.result(definitions.initialize(ctx.stack.project.id, null,
    {origin: "project", action: "create", expectedWorkspaceRoot: catalog.root, expectedBranch: repository.branch}));
  const read = yield* scaffoldRead(ctx);
  const scaffold = {written: read.written, root: posix.normalize(catalog.root)} satisfies Scaffold;
  const effect = read.written.length > 0 ? confirmed(read.detail) : read.unreadable ? inconclusive(read.detail) : refuted(read.detail);
  if (Result.isFailure(setup)) return finished<Scaffold>(afterFailure(definitionFailure(setup.failure), effect), scaffold);
  const answer = `ProjectDefinitions.initialize create: ${setup.success.status} ("${setup.success.message.slice(0, 160)}")` +
    `${scaffold.root === ctx.stack.project.path ? "" : "; the catalog registers the project under another path"}`;
  switch (setup.success.status) {
    case "created":
      return finished<Scaffold>(afterAnswer(answer, read.written.length === setupScaffold.length ? confirmed(read.detail)
        : read.unreadable ? inconclusive(read.detail) : refuted(read.detail)), scaffold);
    case "permission_required":
      return finished<Scaffold>(afterFailure(rejected(answer), effect), scaffold);
    case "uncertain":
    case "unavailable":
      return finished<Scaffold>(afterFailure(uncertain(answer), effect), scaffold);
    default:
      // the disposable project has no setup folder and one branch: a conflict, a stale checkout or another status contradicts T3's own reads
      return finished<Scaffold>(contradicted(`${answer}; read back: ${read.detail}`), scaffold);
  }
})));

// ---- 3. fresh Git probe ----

// whether `tool` resolves on T3's own PATH, which T3's terminals inherit
const onT3Path = (stack: RunningStack, tool: "python3" | "stty"): Effect.Effect<boolean> =>
  runProcess("/bin/sh", ["-c", `command -v ${tool}`], {env: stack.cli.env, cwd: stack.project.path, timeoutMs: 10_000}).pipe(
    Effect.map((result) => result.code === 0), Effect.catchDefect(() => Effect.succeed(false)));

// the probe runs on the root Supervisor's definitions would hand it: T3's registered root of the project once the catalog read it
const gitProbeStep = (ctx: ProbeContext, root: string) => runStep(ctx, "git-probe", Effect.scoped(Effect.gen(function* () {
  const terminal = ctx.native.terminal;
  if (terminal === null) return finished<never>(harness("the git-probe credential is not configured"));
  const python = yield* onT3Path(ctx.stack, "python3");
  const stty = yield* onT3Path(ctx.stack, "stty");
  if (!python || !stty) return finished<never>(harness(`python3 on T3's PATH ${python}, stty on T3's PATH ${stty}`));
  /*
   * the probe keeps its pending sessions in a guidance database of its own, in a fresh data directory the startup upgrade prepares as
   * the service's first start does, composed as src/guidance-application.ts composes the run's
   */
  const directory = ctx.stack.run.dir("cohort", "guidance");
  const guidance = yield* Effect.result(upgradeDataDirectory({dataDirectory: directory, excludedThreadIds: []}).pipe(
    Effect.andThen(Layer.build(GuidanceStore.layer.pipe(Layer.provideMerge(guidanceDbLayer(directory)), Layer.provide(SupervisorIds.layer))))));
  if (Result.isFailure(guidance)) return finished<never>(harness("the probe's guidance database could not be opened"));
  const probe = yield* GitProbe.make(terminal).pipe(Effect.provide(guidance.success));
  const fresh = yield* Effect.result(probe.probe(root));
  if (Result.isFailure(fresh)) return finished<never>(classifyGitProbe(fresh.failure.message));
  const info = fresh.success;
  const changes = yield* gitChanges(ctx.stack);
  const branch = yield* gitLine(ctx.stack, ["symbolic-ref", "--short", "-q", "HEAD"]);
  const answer = `branch ${info.branch === null ? "none" : stated(info.branch)}, isRepo ${info.isRepo}, dirty ${info.changedPaths.length > 0}, ` +
    `${info.changedPaths.length} changed paths, operation state ${info.operationState.status}`;
  return finished<never>(afterAnswer(answer, changes === null || branch === null ? inconclusive("git could not read the project folder")
    : info.isRepo && info.branch === branch && info.operationState.status === "safe" && sameSet(info.changedPaths, changes)
      ? confirmed(`git reports the same branch and the same ${changes.length} changed paths`)
      : refuted(`git reports branch ${stated(branch)} and ${changes.length} changed paths, the same paths ${sameSet(info.changedPaths, changes)}`)));
})));

// ---- 4. explicit-message commit ----

export const commitMessage = "T3 cohort probe: commit the Supervisor setup scaffold";
const commitSha = /^[0-9a-f]{7,64}$/u;

type History =
  | {readonly _tag: "Unreadable"}
  | {readonly _tag: "Unchanged"}
  | {readonly _tag: "Moved"; readonly shaIsHead: boolean | null; readonly parentIsPrevious: boolean; readonly messageEqual: boolean;
    readonly paths: ReadonlyArray<string>};

// the project's history after a commit request, read by git itself
const historyAfter = (stack: RunningStack, previous: string, sha: string | null): Effect.Effect<History> => Effect.gen(function* () {
  const head = yield* gitLine(stack, ["rev-parse", "HEAD"]);
  if (head === null) return {_tag: "Unreadable"} satisfies History;
  if (head === previous) return {_tag: "Unchanged"} satisfies History;
  const parent = yield* gitLine(stack, ["rev-parse", "-q", "--verify", "HEAD^"]);
  const message = yield* git(stack, ["log", "-1", "--format=%B", "HEAD"]);
  const tree = yield* git(stack, ["diff-tree", "--root", "--no-commit-id", "--name-only", "-r", "-z", "HEAD"]);
  const resolved = sha === null ? null : yield* gitLine(stack, ["rev-parse", "-q", "--verify", `${sha}^{commit}`]);
  if (message === null || message.code !== 0 || tree === null || tree.code !== 0) return {_tag: "Unreadable"} satisfies History;
  return {_tag: "Moved", shaIsHead: sha === null ? null : resolved === head, parentIsPrevious: parent === previous,
    messageEqual: message.stdout.replace(/\n+$/u, "") === commitMessage, paths: tree.stdout.split("\0").filter((path) => path.length > 0)} satisfies History;
});

const commitStep = (ctx: ProbeContext, scaffold: Scaffold) => runStep(ctx, "commit", Effect.gen(function* () {
  const commits = ctx.native.files.commit;
  if (commits === null) return finished<never>(harness("the project-commit credential is not configured"));
  const paths = scaffold.written;
  const previous = yield* gitLine(ctx.stack, ["rev-parse", "HEAD"]);
  if (previous === null) return finished<never>(harness("git could not read the project's HEAD before the commit"));
  const actionId = `t3-cohort-probe-commit:${yield* ctx.uuid}`;
  const sent = yield* sendOnce(ctx.ledger, actionId, commits.commit({cwd: scaffold.root, filePaths: paths, message: commitMessage, actionId}));
  if (sent._tag === "Duplicate") return finished<never>(harness("the commit was already sent; nothing was sent again"));
  const answered = Result.isSuccess(sent.result) ? sent.result.success : null;
  const committed = answered !== null && answered.status === "committed" ? answered : null;
  const sha = committed !== null && commitSha.test(committed.commitSha) ? committed.commitSha : null;
  const history = yield* historyAfter(ctx.stack, previous, sha);
  // the effect a commit that was not confirmed may still have had
  const effect = history._tag === "Moved" ? (history.messageEqual ? confirmed("git HEAD moved to a commit with the explicit message")
    : refuted("git HEAD moved to a commit with another message")) : history._tag === "Unchanged" ? refuted("git HEAD did not move")
    : inconclusive("git could not read the history");
  if (Result.isFailure(sent.result)) {
    const failure = sent.result.failure;
    return finished<never>(afterFailure(failure._tag === "T3InvalidInput" ? classifyFailure(failure)
      : rejected(`files/commit: T3FileError code=${failure.code} scope=${failure.scope}, T3 reported no created commit`), effect));
  }
  if (committed === null) return finished<never>(afterFailure(uncertain("files/commit: CommitOutcome uncertain"), effect));
  const answer = `files/commit committed ${sha === null ? "an unrecognized commit sha" : sha.slice(0, 12)} for ${paths.length} paths`;
  if (history._tag !== "Moved") return finished<never>(afterAnswer(answer, history._tag === "Unchanged" ? refuted("git HEAD did not move")
    : inconclusive("git could not read the history")));
  const exact = history.shaIsHead === true && history.parentIsPrevious && history.messageEqual && sameSet(history.paths, paths);
  return finished<never>(afterAnswer(answer, exact
    ? confirmed(`git HEAD is that commit on the previous HEAD, with the explicit message and exactly those ${paths.length} paths`)
    : refuted(`git HEAD is that commit ${history.shaIsHead}, on the previous HEAD ${history.parentIsPrevious}, message equal ${history.messageEqual}, ` +
      `${history.paths.length} paths, exactly those ${sameSet(history.paths, paths)}`)));
}));

// ---- 5. command lifecycle on a disposable thread ----

interface Launch {
  readonly result: Classified;
  readonly threadId: string | null;
}

// one launch in Supervisor's launch profile under a reserved thread identity, sent once and read back
const launch = (ctx: ThreadContext, model: ModelChoice, title: string): Effect.Effect<Launch> => Effect.gen(function* () {
  const commands = ctx.native.orchestration.commands;
  if (commands === null) return {result: harness("the guidance credential's commands are not configured"), threadId: null} satisfies Launch;
  const threadId = `t3-cohort-probe:${yield* ctx.uuid}`;
  const commandId = `t3-cohort-probe-launch:${yield* ctx.uuid}`;
  const prepared = yield* Effect.result(commands.launchThread.prepare({commandId, threadId, projectId: ctx.projectId, title,
    modelSelection: {instanceId: model.instanceId, model: model.model, options: []}}));
  if (Result.isFailure(prepared)) return {result: classifyFailure(prepared.failure), threadId: null} satisfies Launch;
  const sent = yield* sendOnce(ctx.ledger, commandId, initiated(prepared.success));
  if (sent._tag === "Duplicate") return {result: harness("the launch was already sent; nothing was sent again"), threadId: null} satisfies Launch;
  const receipt = Result.isSuccess(sent.result) ? sent.result.success : null;
  const read = yield* readThreadAt(ctx, threadId, receipt?.sequence ?? null);
  const shown = Result.isSuccess(read) ? read.success.projection : null;
  const inProject = shown !== null && shown.thread.id === threadId && shown.thread.projectId === ctx.projectId &&
    shown.thread.archivedAt == null && shown.thread.deletedAt == null;
  const readBack = shown === null ? (notFound(read) ? refuted("the thread is not readable (HTTP 404)") : unreadableThread(read))
    : inProject ? confirmed(`an active thread of the stack's project, ${shown.messages.length} messages, ${runSummary(shown)}`)
      : refuted("not an active thread of the stack's project");
  if (receipt === null) {
    const failure = Result.isFailure(sent.result) ? classifyFailure(sent.result.failure) : uncertain("orchestration/launchThread: no reply");
    return {result: afterFailure(failure, readBack), threadId: inProject ? threadId : null} satisfies Launch;
  }
  const answer = `launch receipt for the reserved thread ${receipt.threadId === threadId}, resumed ${receipt.resumed}, sequence ` +
    `${receipt.sequence === undefined ? "absent" : receipt.sequence}`;
  return {result: receipt.threadId === threadId ? afterAnswer(answer, readBack) : contradicted(`${answer}; read back: ${readBack.detail}`),
    threadId: inProject ? threadId : null} satisfies Launch;
});

const threadLaunchStep = (ctx: ThreadContext, model: ModelChoice) => runStep(ctx, "thread-launch",
  Effect.map(launch(ctx, model, "T3 cohort probe"), (launched) => finished<string>(launched.result, launched.threadId)));

interface WatchedSnapshot {
  readonly threadId: string;
  readonly sequence: number;
  readonly messages: number;
  readonly runs: number;
}

const threadWatchStep = (ctx: ThreadContext, threadId: string) => runStep(ctx, "thread-watch", Effect.scoped(Effect.gen(function* () {
  const snapshot = yield* Deferred.make<WatchedSnapshot>();
  const marker = yield* Deferred.make<void>();
  // the consumer reads each item before T3Native acknowledges its chunk; the subscription ends with this step's scope
  const watch = yield* Effect.forkScoped(ctx.native.orchestration.watchThread(threadId, undefined, (item) =>
    item.kind === "snapshot" ? Effect.asVoid(Deferred.succeed(snapshot, {threadId: item.projection.thread.id, sequence: item.snapshotSequence,
      messages: item.projection.messages.length, runs: item.projection.runs.length}))
      : item.kind === "synchronized" ? Effect.asVoid(Deferred.succeed(marker, undefined)) : Effect.void));
  const first = yield* Effect.raceFirst(
    Effect.map(Deferred.await(snapshot), (value) => ({_tag: "Snapshot" as const, value})),
    Effect.map(Effect.result(Fiber.join(watch)), (ended) => ({_tag: "Ended" as const,
      result: Result.isFailure(ended) ? classifyFailure(ended.failure) : uncertain("orchestration/watchThread ended without a snapshot")})),
  ).pipe(Effect.timeoutOption("15 seconds"));
  if (Option.isNone(first)) return finished<never>(uncertain("orchestration/watchThread: no snapshot within 15 s"));
  if (first.value._tag === "Ended") return finished<never>(first.value.result);
  const seen = first.value.value;
  const synchronized = Option.isSome(yield* Deferred.await(marker).pipe(Effect.timeoutOption("5 seconds")));
  const detail = `snapshot of the launched thread ${seen.threadId === threadId}, snapshotSequence ${seen.sequence}, ${seen.messages} messages, ` +
    `${seen.runs} runs, read before its acknowledgement; completion marker ${synchronized ? "received" : "not received within 5 s"}`;
  return finished<never>(seen.threadId === threadId ? accepted(detail) : contradicted(detail));
})));

type Dispatch = {readonly _tag: "Unsent"; readonly result: Classified} | {readonly _tag: "Sent"; readonly result: Result.Result<CommandReceipt, T3RequestError>};

// one orchestration command through the operate credential, prepared and sent once under its own command identity
const dispatch = (ctx: Pick<ThreadContext, "native" | "ledger">, command: OrchestrationCommand): Effect.Effect<Dispatch> => Effect.gen(function* () {
  const commands = ctx.native.orchestration.commands;
  if (commands === null) return {_tag: "Unsent", result: harness("the guidance credential's commands are not configured")} satisfies Dispatch;
  const prepared = yield* Effect.result(commands.dispatchCommand.prepare(command));
  if (Result.isFailure(prepared)) return {_tag: "Unsent", result: classifyFailure(prepared.failure)} satisfies Dispatch;
  const sent = yield* sendOnce(ctx.ledger, command.commandId, initiated(prepared.success));
  if (sent._tag === "Duplicate") return {_tag: "Unsent", result: harness("the command was already sent; nothing was sent again")} satisfies Dispatch;
  return {_tag: "Sent", result: sent.result} satisfies Dispatch;
});

/**
 * An idle-only command is sent only while a read just before it shows the owned thread idle, with no live, waiting or queued run:
 * null then, otherwise the step's evidence without a send, the read's own failure or not-run with the runs it showed
 */
const idleGate = (read: ThreadRead): Classified | null => Result.isFailure(read) ? classifyFailure(read.failure)
  : idle(read.success.projection) ? null : notRun(`the thread was not idle when read (${runSummary(read.success.projection)}), so nothing was sent`);

const messageText = "T3 Supervisor cohort probe message. No reply is needed.";

const messageDispatchStep = (ctx: ThreadContext, threadId: string) => runStep(ctx, "message-dispatch", Effect.gen(function* () {
  const messageId = `t3-cohort-probe-message:${yield* ctx.uuid}`;
  const sending = yield* dispatch(ctx, {_tag: "MessageDispatch", commandId: `t3-cohort-probe-dispatch:${yield* ctx.uuid}`, messageId, threadId,
    text: messageText, dispatchMode: {type: "queue_after_active"}});
  if (sending._tag === "Unsent") return finished<never>(sending.result);
  const receipt = Result.isSuccess(sending.result) ? sending.result.success : null;
  const read = yield* readThreadAt(ctx, threadId, receipt?.sequence ?? null);
  const message = Result.isSuccess(read) ? read.success.projection.messages.find((item) => item.id === messageId) : undefined;
  const facts = message === undefined ? "" : `role ${stated(message.role)}, text equal ${message.text === messageText}, createdBy ` +
    `${stated(message.createdBy)}, creationSource ${stated(message.creationSource)}`;
  const readBack = Result.isFailure(read) ? unreadableThread(read) : message === undefined ? refuted("the message is not in the thread")
    : message.role === "user" && message.text === messageText ? confirmed(`the message under its reserved id, ${facts}`) : refuted(`the message under its reserved id, ${facts}`);
  const result = receipt === null
    ? afterFailure(Result.isFailure(sending.result) ? classifyFailure(sending.result.failure) : uncertain("no reply"), readBack)
    : afterAnswer(`dispatch receipt at sequence ${receipt.sequence}`, readBack);
  /* Report the turn as that same read showed it. Without a signed-in provider it may fail or stay running; nothing waits for it. */
  return finished<never>({outcome: result.outcome,
    detail: `${result.detail}; runs then: ${Result.isSuccess(read) ? runSummary(read.success.projection) : "unreadable"}`});
}));

// a settle as Supervisor reads it back (src/supervisor-lifecycle.ts): settledAt set or the settled override
const settledReadBack = (read: ThreadRead): ReadBack => {
  if (Result.isFailure(read)) return unreadableThread(read);
  const shown = read.success.projection.thread;
  const facts = `settledAt ${shown.settledAt == null ? "null" : "set"}, settledOverride ${stated(shown.settledOverride)}, archivedAt ${shown.archivedAt == null ? "null" : "set"}`;
  return shown.settledAt != null || shown.settledOverride === "settled" ? confirmed(`settled: ${facts}`) : refuted(`not settled: ${facts}`);
};

// where the thread went: the coherent active and archived shell pair lists each thread once, an archived one with archivedAt set
const shellLocation = (threadId: string, shell: Result.Result<ReadonlyArray<ThreadInfo>, T3RequestError>): Classified => {
  if (Result.isFailure(shell)) return classifyFailure(shell.failure);
  const row = shell.success.find((item) => item.id === threadId);
  return row === undefined ? contradicted(`orchestration/shellThreads: ${shell.success.length} threads without the settled thread`)
    : accepted(`orchestration/shellThreads lists it with archivedAt ${row.archivedAt == null ? "null or absent (the active part)" : "set (the archived part)"}, ` +
      `settledOverride ${stated(row.settledOverride)}, settledAt ${row.settledAt == null ? "null or absent" : "set"}`);
};

const threadSettleStep = (ctx: ThreadContext, threadId: string) => runStep(ctx, "thread-settle", Effect.gen(function* () {
  const gate = idleGate(yield* readThread(ctx, threadId));
  if (gate !== null) return finished<never>(gate);
  const sending = yield* dispatch(ctx, {_tag: "ThreadSettle", commandId: `t3-cohort-probe-settle:${yield* ctx.uuid}`, threadId});
  if (sending._tag === "Unsent") return finished<never>(sending.result);
  const receipt = Result.isSuccess(sending.result) ? sending.result.success : null;
  const read = yield* readThreadAt(ctx, threadId, receipt?.sequence ?? null);
  const readBack = settledReadBack(read);
  const command = receipt === null
    ? afterFailure(Result.isFailure(sending.result) ? classifyFailure(sending.result.failure) : uncertain("no reply"), readBack)
    : afterAnswer(`settle receipt at sequence ${receipt.sequence}`, readBack);
  const location = shellLocation(threadId, yield* Effect.result(ctx.native.orchestration.shellThreads));
  return finished<never>(worst([command, location]));
}));

const threadStopStep = (ctx: ThreadContext, threadId: string) => runStep(ctx, "thread-stop-idle", Effect.gen(function* () {
  const before = yield* readThread(ctx, threadId);
  if (Result.isFailure(before)) return finished<never>(classifyFailure(before.failure));
  const gate = idleGate(before);
  if (gate !== null) return finished<never>(gate);
  const sending = yield* dispatch(ctx, {_tag: "ThreadStop", commandId: `t3-cohort-probe-stop:${yield* ctx.uuid}`, threadId,
    stopDelegatedTasks: true, reason: "T3 Supervisor cohort probe: Stop on an idle thread."});
  if (sending._tag === "Unsent") return finished<never>(sending.result);
  const receipt = Result.isSuccess(sending.result) ? sending.result.success : null;
  const read = yield* readThreadAt(ctx, threadId, receipt?.sequence ?? null);
  const shown = Result.isSuccess(read) ? read.success.projection : null;
  const facts = shown === null ? "" : `${runSummary(shown)}, deletedAt ${shown.thread.deletedAt == null ? "null" : "set"}`;
  if (receipt === null) {
    // the idle thread looks the same with or without a Stop, so what is read back neither confirms nor contradicts a refusal
    const failure = Result.isFailure(sending.result) ? classifyFailure(sending.result.failure) : uncertain("no reply");
    return finished<never>(afterFailure(failure, shown === null ? unreadableThread(read) : inconclusive(facts)));
  }
  const earlier = before.success.snapshotSequence;
  const answer = `stop receipt at sequence ${receipt.sequence} (${receipt.sequence > earlier ? "T3 recorded new events" : "T3 recorded no new event"})`;
  return finished<never>(afterAnswer(answer, shown === null ? unreadableThread(read)
    : idle(shown) && shown.thread.deletedAt == null ? confirmed(`the thread stays idle: ${facts}`) : refuted(`after the Stop: ${facts}`)));
}));

/**
 * The command lifecycle of one disposable thread: launched and watched, then settled and Stopped while each read just before shows it
 * idle, and only then given a message, whose turn is reported as read and never awaited. It provides the thread for the helper channel.
 */
export const threadLifecycleSteps = (ctx: ThreadContext, model: ModelChoice | null): Effect.Effect<string | null> => Effect.gen(function* () {
  const threadId = model === null ? yield* skip<string>(ctx, "thread-launch", "model-config offered no model") : yield* threadLaunchStep(ctx, model);
  if (threadId === null) {
    for (const name of ["thread-watch", "thread-settle", "thread-stop-idle", "message-dispatch"] as const)
      yield* skip(ctx, name, "thread-launch provided no readable thread");
    return null;
  }
  yield* threadWatchStep(ctx, threadId);
  yield* threadSettleStep(ctx, threadId);
  yield* threadStopStep(ctx, threadId);
  yield* messageDispatchStep(ctx, threadId);
  return threadId;
});

// ---- 6. helper webhook channel ----

// the helper channel's prompt template, as src/supervisor-helper-transport.ts upserts it
const helperPrompt = "{{body.text}}";
const isNativeModelSelection = Schema.is(NativeModelSelection);
const isRuntimeMode = Schema.is(RuntimeMode);
const isInteractionMode = Schema.is(InteractionMode);

interface HelperChannel {
  readonly taskId: string;
  readonly threadId: string;
  // the task's webhook path once it is owned and ready; it holds the hook token and is never printed
  readonly path: string | null;
  readonly exists: boolean;
}

interface TaskFacts {
  readonly owned: boolean;
  readonly path: string | null;
  readonly createdAt: string | null;
  readonly detail: string;
}

// one task's ownership and readiness as the helper transport checks them, never its webhook path
const taskFacts = (view: HelperTaskView, expected: {readonly taskId: string; readonly threadId: string; readonly projectId: string}): TaskFacts => {
  const task: NativeRecord = view.task;
  const webhook = isRecord(task.webhook) ? task.webhook : null;
  const path = webhook !== null && typeof webhook.path === "string" && isHelperWebhookPath(webhook.path) ? webhook.path : null;
  const schedule = isRecord(task.schedule) ? task.schedule.type : undefined;
  const owned = view._tag === "Task" && task.id === expected.taskId && task.threadId === expected.threadId && task.projectId === expected.projectId &&
    task.prompt === helperPrompt && schedule === "webhook" && task.enabled === true && typeof task.createdAt === "string" && path !== null;
  return {owned, path, createdAt: typeof task.createdAt === "string" ? task.createdAt : null,
    detail: `${view._tag === "Task" ? "a typed" : "a nonconforming"} task, bound to the thread ${task.threadId === expected.threadId}, project equal ` +
      `${task.projectId === expected.projectId}, prompt template ${task.prompt === helperPrompt}, schedule ${stated(schedule)}, enabled ${stated(task.enabled)}, ` +
      `webhook path present ${path !== null}`};
};

const helperTaskStep = (ctx: ProbeContext, threadId: string, model: ModelChoice) => runStep(ctx, "helper-task", Effect.gen(function* () {
  const helper = ctx.native.helper;
  if (helper === null) return finished<HelperChannel>(harness("the guidance credential's helper family is not configured"));
  const parts: Array<Classified> = [];
  let bound = threadId;
  let read = yield* readThread(ctx, bound);
  if (Result.isSuccess(read) && (read.success.projection.thread.archivedAt != null || read.success.projection.thread.deletedAt != null)) {
    // settling made the thread unusable: a fresh disposable thread in the same launch profile
    const fresh = yield* launch(ctx, model, "T3 cohort probe helper");
    parts.push({outcome: fresh.result.outcome, detail: `a fresh thread for the helper: ${fresh.result.detail}`});
    if (fresh.threadId === null) return finished<HelperChannel>(worst(parts));
    bound = fresh.threadId;
    read = yield* readThread(ctx, bound);
  }
  if (Result.isFailure(read)) return finished<HelperChannel>(worst([...parts, classifyFailure(read.failure)]));
  // the helper thread's own model selection and modes, sent back exactly as read
  const {modelSelection, runtimeMode, interactionMode} = read.success.projection.thread;
  if (!isNativeModelSelection(modelSelection) || !isRuntimeMode(runtimeMode) || !isInteractionMode(interactionMode))
    return finished<HelperChannel>(worst([...parts, contradicted("the thread's model selection or modes do not have the pinned wire's types")]));
  const taskId = `t3-cohort-probe-helper:${yield* ctx.uuid}`;
  const commandId = `t3-cohort-probe-helper-task:${yield* ctx.uuid}`;
  const expected = {taskId, threadId: bound, projectId: ctx.stack.project.id};
  const sent = yield* sendOnce(ctx.ledger, commandId, helper.upsertTask({taskId, requireExisting: false, commandId, title: "T3 cohort probe helper",
    prompt: helperPrompt, projectId: ctx.stack.project.id, threadId: bound, modelSelection, runtimeMode, interactionMode}));
  if (sent._tag === "Duplicate") return finished<HelperChannel>(worst([...parts, harness("the task upsert was already sent; nothing was sent again")]));
  const listed = yield* Effect.result(helper.tasks());
  const found = Result.isSuccess(listed) ? listed.success.find((view) => view.task.id === taskId) : undefined;
  const listedFacts = found === undefined ? null : taskFacts(found, expected);
  const ownedPath = listedFacts !== null && listedFacts.owned ? listedFacts.path : null;
  const listing = Result.isFailure(listed) ? null : listed.success.length;
  const channel = (path: string | null, exists: boolean): HelperChannel => ({taskId, threadId: bound, path, exists});
  if (Result.isFailure(sent.result)) {
    // a task the upsert may have created is only read back; its webhook is posted only once it reads back owned and ready
    const existence = listing === null ? inconclusive("helper/tasks unreadable") : listedFacts === null ? refuted(`helper/tasks lists ${listing} tasks without it`)
      : confirmed(`helper/tasks lists it: ${listedFacts.detail}`);
    return finished<HelperChannel>(worst([...parts, afterFailure(classifyFailure(sent.result.failure), existence)]), channel(ownedPath, found !== undefined));
  }
  const reply = taskFacts(sent.result.success, expected);
  const answer = `helper/upsertTask returned ${reply.detail}`;
  const readBack = Result.isFailure(listed) ? inconclusive(`helper/tasks: ${classifyFailure(listed.failure).detail}`)
    : listedFacts === null ? refuted(`helper/tasks lists ${listing ?? 0} tasks without it`)
      : listedFacts.owned && listedFacts.createdAt === reply.createdAt ? confirmed(`helper/tasks lists it with the same creation: ${listedFacts.detail}`)
        : refuted(`helper/tasks lists it: ${listedFacts.detail}, same creation ${listedFacts.createdAt === reply.createdAt}`);
  const result = reply.owned ? afterAnswer(answer, readBack) : contradicted(`${answer}; read back: ${readBack.detail}`);
  return finished<HelperChannel>(worst([...parts, result]), channel(ownedPath ?? (reply.owned && Result.isFailure(listed) ? reply.path : null),
    found !== undefined || Result.isFailure(listed)));
}));

// the delivery log and the thread after the POST, read only
const observeDelivery = (ctx: ProbeContext, helper: T3HelperFamily, channel: HelperChannel, replyId: string | null, bodyBytes: number):
  Effect.Effect<DeliveryObservation> => Effect.gen(function* () {
  const listed = yield* Effect.result(helper.webhookDeliveries({taskId: channel.taskId}));
  const deliveries = Result.isSuccess(listed) ? listed.success.map((view) => view.delivery) : [];
  const candidates = deliveries.filter((delivery) => replyId !== null ? delivery.id === replyId : delivery.taskId === channel.taskId && delivery.bodyBytes === bodyBytes);
  const summary = candidates.length === 1 ? candidates[0] ?? null : null;
  const deliveryId = replyId ?? (summary !== null && typeof summary.id === "string" ? summary.id : null);
  const detail = deliveryId === null ? null : yield* Effect.result(helper.webhookDelivery({taskId: channel.taskId, deliveryId}));
  const thread = yield* readThread(ctx, channel.threadId);
  const messageId = deliveryId === null ? null : `scheduled-task-message:${channel.taskId}:webhook:${deliveryId}`;
  return {
    logFailure: Result.isFailure(listed) ? classifyFailure(listed.failure) : null,
    listed: deliveries.length,
    deliveryId,
    summary,
    detail: detail !== null && Result.isSuccess(detail) ? detail.success.delivery : null,
    detailFailure: detail !== null && Result.isFailure(detail) ? classifyFailure(detail.failure) : null,
    message: messageId !== null && Result.isSuccess(thread) ? thread.success.projection.messages.find((item) => item.id === messageId) ?? null : null,
    threadFailure: Result.isFailure(thread) ? classifyFailure(thread.failure) : null,
  } satisfies DeliveryObservation;
});

const helperWebhookStep = (ctx: ProbeContext, channel: HelperChannel & {readonly path: string}) => runStep(ctx, "helper-webhook", Effect.gen(function* () {
  const helper = ctx.native.helper;
  if (helper === null) return finished<never>(harness("the guidance credential's helper family is not configured"));
  const batchId = `t3-cohort-probe-batch:${yield* ctx.uuid}`;
  const text = "T3 Supervisor cohort probe check-in. No reply is needed.";
  const prepared = yield* Effect.result(helper.postWebhook.prepare({path: channel.path, batchId, text}));
  if (Result.isFailure(prepared)) return finished<never>(classifyFailure(prepared.failure));
  const sent = yield* sendOnce(ctx.ledger, batchId, initiated(prepared.success));
  if (sent._tag === "Duplicate") return finished<never>(harness("the webhook POST was already sent; nothing was sent again"));
  const body = webhookBody({batchId, text});
  const expected = {taskId: channel.taskId, body, bodyBytes: new TextEncoder().encode(body).length} satisfies DeliveryExpectation;
  const reply = Result.isSuccess(sent.result) ? sent.result.success : null;
  const replyId = reply !== null && reply._tag === "Accepted" ? reply.deliveryId ?? null : null;
  // T3 renders and logs the delivery before it dispatches the message; read until the message shows or the outcome is final: at most 30 s
  const seen = yield* observeDelivery(ctx, helper, channel, replyId, expected.bodyBytes).pipe(Effect.repeat({schedule: Schedule.spaced("500 millis"),
    times: 60, until: (current: DeliveryObservation) => current.message !== null || (current.detail !== null && current.detail.outcome !== "accepted")}));
  return finished<never>(judgeDelivery(reply !== null ? {_tag: "Reply", reply}
    : {_tag: "Failed", failure: Result.isFailure(sent.result) ? classifyFailure(sent.result.failure) : uncertain("helper/postWebhook: no reply")}, seen, expected));
}));

const helperDeleteStep = (ctx: ProbeContext, taskId: string) => runStep(ctx, "helper-delete", Effect.gen(function* () {
  const helper = ctx.native.helper;
  if (helper === null) return finished<never>(harness("the guidance credential's helper family is not configured"));
  const sent = yield* sendOnce(ctx.ledger, `t3-cohort-probe-helper-delete:${taskId}`, helper.deleteTask({taskId}));
  if (sent._tag === "Duplicate") return finished<never>(harness("the task delete was already sent; nothing was sent again"));
  const listed = yield* Effect.result(helper.tasks());
  const readBack = Result.isFailure(listed) ? inconclusive(`helper/tasks: ${classifyFailure(listed.failure).detail}`)
    : listed.success.some((view) => view.task.id === taskId) ? refuted("helper/tasks still lists the task")
      : confirmed(`helper/tasks lists ${listed.success.length} tasks without it`);
  return finished<never>(Result.isFailure(sent.result) ? afterFailure(classifyFailure(sent.result.failure), readBack)
    : afterAnswer("helper/deleteTask answered", readBack));
}));

// ---- the run ----

/** The bearer tokens of a run's T3Native: the read, operate (guidance), project-write, project-commit and Git probe credentials */
export interface NativeTokens {
  readonly read: string;
  readonly operate: string;
  readonly projectWrite: string;
  readonly commit: string;
  readonly probe: string;
}

/** T3Native over one T3, composed as src/guidance-application.ts composes it over the root native transport */
export const nativeOver = (baseUrl: string, tokens: NativeTokens) => Effect.gen(function* () {
  const endpoint = (value: string) => ({baseUrl, token: value});
  const read = endpoint(tokens.read);
  const access = yield* Layer.build(T3Native.layer({baseUrl, read, projectWrite: endpoint(tokens.projectWrite), commit: endpoint(tokens.commit),
    probe: endpoint(tokens.probe)}).pipe(Layer.provideMerge(Layer.mergeAll(
    NativeShell.layer(read).pipe(Layer.provideMerge(NativeRpc.layer(read))),
    NativeOperateRpc.layer(endpoint(tokens.operate)),
    T3Client.layer(read),
  )), Layer.provideMerge(NativeTransportLive)));
  return Context.get(access, T3Native);
});

// the run's T3Native over the stack's credential files
const nativeAccess = (stack: RunningStack) => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const token = (name: string): Effect.Effect<string, string> => {
    const session = stack.sessions.find((item) => item.credential.name === name);
    if (session === undefined) return Effect.fail(`the stack issued no ${name} credential`);
    return fs.readFileString(session.file).pipe(Effect.mapError(() => `the ${name} credential file could not be read`),
      Effect.flatMap((text) => text.trim().length > 0 ? Effect.succeed(text.trim()) : Effect.fail(`the ${name} credential file is empty`)));
  };
  return yield* nativeOver(stack.t3.url, {read: yield* token("read"), operate: yield* token("guidance"), projectWrite: yield* token("project-write"),
    commit: yield* token("project-commit"), probe: yield* token("git-probe")});
});

const probeSteps = (ctx: ProbeContext) => Effect.gen(function* () {
  yield* environmentStep(ctx);
  const model = yield* modelConfigStep(ctx);
  const repository = yield* filesReadStep(ctx);
  const scaffold = repository === null ? yield* skip<Scaffold>(ctx, "setup-scaffold", "files-read did not prepare the Git repository")
    : yield* setupScaffoldStep(ctx, repository);
  if (repository === null) yield* skip(ctx, "git-probe", "files-read did not prepare the Git repository");
  else yield* gitProbeStep(ctx, scaffold?.root ?? ctx.stack.project.path);
  if (scaffold === null || scaffold.written.length === 0) yield* skip(ctx, "commit", "setup-scaffold wrote no file to commit");
  else yield* commitStep(ctx, scaffold);

  const threadId = yield* threadLifecycleSteps(ctx, model);

  const channel = threadId === null || model === null ? yield* skip<HelperChannel>(ctx, "helper-task", "thread-launch provided no readable thread")
    : yield* helperTaskStep(ctx, threadId, model);
  if (channel === null || channel.path === null) yield* skip(ctx, "helper-webhook", "helper-task provided no owned task with a webhook path");
  else yield* helperWebhookStep(ctx, {...channel, path: channel.path});
  if (channel === null || !channel.exists) yield* skip(ctx, "helper-delete", "helper-task left no task to delete");
  else yield* helperDeleteStep(ctx, channel.taskId);
});

// nothing of the stack is left once its scope closed: its ports refuse, its process groups ended, and its folder is gone unless kept
const teardownEvidence = (stack: RunningStack, keep: boolean) => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const ports = yield* Effect.exit(Effect.forEach([stack.t3.port, ...stack.supervisor.ports], portState));
  const live = [stack.t3.process.pid, stack.supervisor.process.pid].filter(groupAlive);
  const folder = yield* fs.exists(stack.run.path).pipe(Effect.catch(() => Effect.succeed(true)));
  const states = Exit.isSuccess(ports) ? ports.value : null;
  const detail = `ports ${states === null ? "unreadable" : states.join(",")}, live process groups ${live.length}, run folder ${folder ? "kept" : "removed"}`;
  return states !== null && states.every((state) => state === "refused") && live.length === 0 && folder === keep ? accepted(detail) : harness(detail);
});

export interface ProbeOptions {
  readonly cacheRoot: string;
  readonly keep: boolean;
  readonly lock: {readonly file: string; readonly slot: TargetSlot} | null;
}

/** A lock a run used: its path as given and the SHA-256 of the exact bytes the run read once, as `./dev check --t3-lock` names it */
export interface LockInput {
  readonly file: string;
  readonly sha256: string;
}

export interface ProbeReport {
  readonly requested: string | null;
  readonly reported: string | null;
  // null for the pinned release, or for a lock whose bytes could not be read
  readonly lock: LockInput | null;
  readonly steps: ReadonlyArray<StepEvidence>;
  readonly passed: boolean;
}

const evidenceLine = (evidence: StepEvidence): string =>
  `${evidence.outcome.toUpperCase().padEnd(12)} ${evidence.name} (${evidence.elapsedMs} ms): ${evidence.detail}`;

/**
 * The pinned release, or the release of a slot of a target lock decoded from the lock's bytes, read once; the lock is named by
 * those exact bytes' SHA-256 whenever they could be read, also when they do not decode
 */
export const releaseOf = (lock: ProbeOptions["lock"]): Effect.Effect<{readonly lock: LockInput | null; readonly release: Result.Result<T3Release, string>},
  never, FileSystem.FileSystem> => Effect.gen(function* () {
  if (lock === null) return {lock: null, release: Result.succeed(t3Release)};
  const {file, slot} = lock;
  const fs = yield* FileSystem.FileSystem;
  const bytes = yield* Effect.result(fs.readFile(file));
  if (Result.isFailure(bytes)) return {lock: null, release: Result.fail(`target lock ${file} could not be read`)};
  const input = {file, sha256: createHash("sha256").update(bytes.success).digest("hex")};
  const decoded = yield* Effect.result(decodeTargetLock(new TextDecoder().decode(bytes.success), `target lock ${file}`));
  if (Result.isFailure(decoded)) return {lock: input, release: Result.fail(decoded.failure.message.slice(0, 300))};
  const release = yield* Effect.result(Effect.try({try: () => targetRelease(decoded.success, slot), catch: () => `the target lock has no usable ${slot} target`}));
  return {lock: input, release};
});

/** One probe run against one published T3; every step reports as it ends, and nothing of the stack is left afterwards */
export const runProbe = (options: ProbeOptions) => Effect.gen(function* () {
  const recorded = yield* Ref.make<ReadonlyArray<StepEvidence>>([]);
  const report = (evidence: StepEvidence) => Effect.andThen(Ref.update(recorded, (all) => [...all, evidence]), Console.log(evidenceLine(evidence)));
  const unreported = (stackStarted: boolean) => Effect.map(Ref.get(recorded), (steps) => {
    const seen = new Set(steps.map((step) => step.name));
    // the teardown of a stack that started is reported once its scope closed
    return plannedSteps.filter((name) => !seen.has(name) && !(stackStarted && name === "teardown"));
  });
  const skipRest = (reason: string, stackStarted: boolean) => Effect.gen(function* () {
    for (const name of yield* unreported(stackStarted)) yield* report({name, operations: stepOperations[name], ...notRun(reason), elapsedMs: 0});
  });
  const started = yield* Clock.monotonicTimeNanos;
  const {lock: lockInput, release} = yield* releaseOf(options.lock);
  if (Result.isFailure(release)) {
    yield* report({name: "stack", operations: stepOperations.stack, ...harness(release.failure), elapsedMs: yield* elapsedSince(started)});
    yield* skipRest("the stack did not start", false);
    const steps = yield* Ref.get(recorded);
    return {requested: null, reported: null, lock: lockInput, steps, passed: passedOf(steps)} satisfies ProbeReport;
  }
  const requested = release.success;
  const ran = yield* Effect.scoped(Effect.gen(function* () {
    const exit = yield* Effect.exit(startStack({cacheRoot: options.cacheRoot, keep: options.keep, release: requested}));
    if (Exit.isFailure(exit)) {
      if (Cause.hasInterrupts(exit.cause)) return yield* Effect.failCause(exit.cause);
      const failure = Cause.squash(exit.cause);
      yield* report({name: "stack", operations: stepOperations.stack, elapsedMs: yield* elapsedSince(started), ...harness(failure instanceof LocalStackError
        ? `the stack did not start: ${failure.message.slice(0, 300)}` : `the stack did not start (${defectName(exit.cause)})`)});
      return null;
    }
    const stack = exit.value;
    const stackDetail = `T3 ${stated(stack.t3.version)} serves orchestration protocol ${stack.t3.protocol}; the stack ran release ${stated(stack.t3.release.version)}` +
      ` for the requested ${requested.version}; run folder ${stack.run.path}`;
    yield* report({name: "stack", operations: stepOperations.stack, elapsedMs: yield* elapsedSince(started),
      ...(stack.t3.release.version === requested.version ? accepted(stackDetail) : harness(stackDetail))});
    const nativeStarted = yield* Clock.monotonicTimeNanos;
    const native = yield* Effect.result(nativeAccess(stack));
    if (Result.isFailure(native)) {
      yield* report({name: "environment", operations: stepOperations.environment, ...harness(native.failure), elapsedMs: yield* elapsedSince(nativeStarted)});
      yield* skipRest("the probe could not build T3Native from the stack's credential files", true);
    } else {
      const crypto = yield* Crypto.Crypto;
      const probed = yield* Effect.exit(probeSteps({stack, release: requested, native: native.success, ledger: yield* makeLedger,
        uuid: Effect.orDie(crypto.randomUUIDv4()), report, projectId: stack.project.id}));
      // each step reports its own defect; one between the steps is reported on the next step, and the rest did not run
      if (Exit.isFailure(probed)) {
        if (Cause.hasInterrupts(probed.cause)) return yield* Effect.failCause(probed.cause);
        const [next] = yield* unreported(true);
        if (next !== undefined) yield* report({name: next, operations: stepOperations[next], ...harness(`the probe failed before this step (${defectName(probed.cause)})`),
          elapsedMs: 0});
        yield* skipRest("the probe failed before this step", true);
      }
    }
    return {stack, closing: yield* Clock.monotonicTimeNanos};
  }));
  if (ran === null) yield* skipRest("the stack did not start", false);
  else yield* report({name: "teardown", operations: stepOperations.teardown, ...(yield* teardownEvidence(ran.stack, options.keep)),
    elapsedMs: yield* elapsedSince(ran.closing)});
  const steps = yield* Ref.get(recorded);
  return {requested: requested.version, reported: ran === null ? null : ran.stack.t3.version, lock: lockInput, steps, passed: passedOf(steps)} satisfies ProbeReport;
});

const main = Effect.gen(function* () {
  const parsed = parseArguments(process.argv.slice(2));
  if (parsed._tag === "Invalid") return yield* new CohortProbeError({message: `${parsed.message}\n${usage}`});
  const outcome = yield* runProbe({cacheRoot: parsed.cacheDir ?? defaultCacheRoot(), keep: parsed.keep, lock: parsed.lock});
  // the outcome with its inputs: the requested and reported T3, the slot, the lock's SHA-256, and this checkout's commit and whether its tree was clean
  const supervisor = yield* checkoutInputs.pipe(Effect.catchDefect(() => Effect.succeed({revision: null, clean: null})));
  yield* Console.log(JSON.stringify({t3: outcome.requested, reported: outcome.reported, slot: parsed.lock?.slot ?? null, lock: outcome.lock, supervisor,
    passed: outcome.passed, steps: outcome.steps}));
  if (!outcome.passed) return yield* new CohortProbeError({message: "the T3 cohort probe did not pass"});
});

if (import.meta.main) NodeRuntime.runMain(main.pipe(Effect.tapError((error) => Console.error(error.message)),
  Effect.provide(Layer.mergeAll(NodeFileSystem.layer, NodeCrypto.layer))), {disableErrorReporting: true});
