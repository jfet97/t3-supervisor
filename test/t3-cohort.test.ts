import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Effect, Ref, Result } from "effect";
import {
  accepted, afterAnswer, afterFailure, classifyFailure, classifyGitProbe, confirmed, contradicted, harness, idle, inconclusive, initiated, judgeDelivery,
  makeLedger, notRun, parseArguments, passedOf, plannedSteps, porcelainPaths, refuted, rejected, sendOnce, stated, stepOperations, uncertain, worst,
  type DeliveryObservation, type OutcomeClass, type StepEvidence,
} from "../scripts/t3-cohort.js";
import {
  T3FileError, T3InvalidInput, T3ReadError, T3RequestError, T3TerminalError, T3Unsupported, T3WebhookError, type CommandReceipt, type NativeRecord,
  type T3PreparedCommand,
} from "../src/t3-native/index.js";
import type { MessageInfo, RunInfo } from "../src/types.js";

/*
  The cohort probe's evidence rules (scripts/t3-cohort.ts), without any T3: how T3Native's failures and the read-backs after a send
  become outcome classes, that only a definite positive answer confirmed by its read-back passes, that a missing or not-run step fails
  the run, and that a command identity is sent at most once. The probe itself runs against published T3 builds in the development
  environment.
*/

type RequestFlags = {readonly outcome: "rejected" | "uncertain"; readonly definiteRejection: boolean; readonly providerDisabled: boolean;
  readonly dispatchCommandFailure: boolean; readonly malformedReply: boolean};
const request = (flags: Partial<RequestFlags> = {}) => new T3RequestError({operation: "orchestration/dispatchCommand", outcome: "uncertain",
  definiteRejection: false, providerDisabled: false, dispatchCommandFailure: false, malformedReply: false, ...flags});

it("only T3's definite rejection of a request is rejected; any other request failure is uncertain", () => {
  assert.equal(classifyFailure(request({outcome: "rejected", definiteRejection: true})).outcome, "rejected");
  assert.equal(classifyFailure(request({outcome: "rejected", definiteRejection: true, providerDisabled: true})).outcome, "rejected");
  // a received dispatch-command failure stays uncertain as T3Native classifies it, and the probe never replays it
  assert.equal(classifyFailure(request({dispatchCommandFailure: true})).outcome, "uncertain");
  assert.match(classifyFailure(request({dispatchCommandFailure: true})).detail, /dispatchCommandFailure=true/u);
  assert.equal(classifyFailure(request({malformedReply: true})).outcome, "uncertain");
  assert.equal(classifyFailure(request({outcome: "rejected"})).outcome, "uncertain");
  assert.equal(classifyFailure(request()).outcome, "uncertain");
});

it("a read answered with 401, 403 or another 4xx is a refusal; a lost, late or unreadable answer is uncertain", () => {
  const read = (message: string, httpStatus?: number) => new T3ReadError({operation: "orchestration/thread", message,
    ...(httpStatus === undefined ? {} : {httpStatus})});
  assert.equal(classifyFailure(read("T3 thread projection returned HTTP 403", 403)).outcome, "rejected");
  assert.equal(classifyFailure(read("T3 thread projection returned HTTP 404", 404)).outcome, "rejected");
  assert.equal(classifyFailure(read("T3 thread projection returned HTTP 503", 503)).outcome, "uncertain");
  assert.equal(classifyFailure(read("T3 thread projection request timed out")).outcome, "uncertain");
  assert.equal(classifyFailure(read("T3 thread projection has an unsupported schema or shape")).outcome, "uncertain");
});

it("file, terminal, webhook and input failures keep their classes", () => {
  assert.equal(classifyFailure(new T3FileError({operation: "files/writeFile", code: "permission_required", scope: "write"})).outcome, "rejected");
  assert.equal(classifyFailure(new T3FileError({operation: "files/readFile", code: "missing", scope: "read"})).outcome, "rejected");
  assert.equal(classifyFailure(new T3FileError({operation: "files/readFile", code: "unavailable", scope: "read"})).outcome, "uncertain");
  assert.equal(classifyFailure(new T3TerminalError({operation: "terminal/open", reason: "rejected"})).outcome, "rejected");
  assert.equal(classifyFailure(new T3TerminalError({operation: "terminal/attach", reason: "socket_closed"})).outcome, "uncertain");
  assert.equal(classifyFailure(new T3TerminalError({operation: "terminal/open", reason: "malformed_reply"})).outcome, "uncertain");
  assert.equal(classifyFailure(new T3WebhookError({operation: "helper/postWebhook"})).outcome, "uncertain");
  assert.equal(classifyFailure(new T3InvalidInput({operation: "orchestration/launchThread"})).outcome, "harness");
  assert.equal(classifyFailure(new T3Unsupported({operation: "files/commit", serverVersion: "0.1.7-nightly.20261101.4016"})).outcome, "rejected");
});

it("the production Git probe's failures: T3's refusals are rejected, the probe's process environment harness, any other end uncertain", () => {
  assert.equal(classifyGitProbe("T3 rejected a terminal Git probe request.").outcome, "rejected");
  assert.equal(classifyGitProbe("T3 rejected the terminal attach request.").outcome, "rejected");
  assert.equal(classifyGitProbe("The probe terminal exited before the Git check started.").outcome, "harness");
  assert.equal(classifyGitProbe("The Git probe process did not exit successfully.").outcome, "harness");
  assert.equal(classifyGitProbe("The Git probe RPC was canceled or timed out.").outcome, "uncertain");
  assert.equal(classifyGitProbe("T3 did not start the Git probe terminal in the selected checkout.").outcome, "uncertain");
  assert.equal(classifyGitProbe("an unknown message").outcome, "uncertain");
});

it("a definite answer is accepted only when its read-back confirms it, and contradicted when the read-back refutes it", () => {
  assert.equal(afterAnswer("receipt", confirmed("seen")).outcome, "accepted");
  assert.equal(afterAnswer("receipt", refuted("the accepted write is not readable")).outcome, "contradicted");
  assert.equal(afterAnswer("receipt", inconclusive("the read failed")).outcome, "uncertain");
});

it("an uncertain send never becomes accepted, whatever is read back", () => {
  for (const readBack of [confirmed("the message is in the thread"), refuted("absent"), inconclusive("unreadable")])
    assert.equal(afterFailure(uncertain("connection lost after the request left"), readBack).outcome, "uncertain");
  assert.equal(afterFailure(harness("the probe's input"), confirmed("seen")).outcome, "harness");
  assert.equal(afterFailure(accepted("not a failure"), confirmed("seen")).outcome, "uncertain");
});

it("a definite refusal stays a refusal unless its effect is visible, which contradicts it", () => {
  assert.equal(afterFailure(rejected("refused"), confirmed("the commit exists")).outcome, "contradicted");
  assert.equal(afterFailure(rejected("refused"), refuted("HEAD did not move")).outcome, "rejected");
  assert.equal(afterFailure(rejected("refused"), inconclusive("unreadable")).outcome, "rejected");
});

it("a step that ran several operations takes the most severe of their classes", () => {
  assert.equal(worst([accepted("a"), uncertain("b"), rejected("c")]).outcome, "rejected");
  assert.equal(worst([accepted("a"), contradicted("b"), rejected("c")]).outcome, "contradicted");
  assert.equal(worst([accepted("a"), harness("b")]).outcome, "harness");
  assert.equal(worst([accepted("a"), accepted("b")]).outcome, "accepted");
  assert.equal(worst([]).outcome, "harness");
});

const report = (outcome: OutcomeClass): ReadonlyArray<StepEvidence> =>
  plannedSteps.map((name) => ({name, operations: stepOperations[name], outcome, detail: name, elapsedMs: 0}));

it("a run passes only with exactly one accepted evidence of every planned step", () => {
  const all = report("accepted");
  assert.equal(passedOf(all), true);
  assert.equal(passedOf(all.filter((step) => step.name !== "helper-webhook")), false);
  assert.equal(passedOf(all.map((step) => step.name === "thread-stop-idle" ? {...step, ...notRun("the thread stayed busy")} : step)), false);
  assert.equal(passedOf(all.map((step) => step.name === "commit" ? {...step, ...uncertain("lost after it left")} : step)), false);
  assert.equal(passedOf(all.map((step) => step.name === "stack" ? {...step, ...harness("the stack did not start")} : step)), false);
  assert.equal(passedOf([...all, ...all.slice(0, 1)]), false);
  assert.equal(passedOf([]), false);
  for (const outcome of ["not-run", "harness", "uncertain", "rejected", "contradicted"] as const) assert.equal(passedOf(report(outcome)), false);
});

it.effect("a command identity is sent at most once, whatever its first answer was", () => Effect.gen(function* () {
  const ledger = yield* makeLedger;
  const sends = yield* Ref.make(0);
  const send = (fail: boolean): Effect.Effect<string, string> =>
    Effect.flatMap(Ref.update(sends, (count) => count + 1), () => fail ? Effect.fail("lost") : Effect.succeed("receipt"));
  const first = yield* sendOnce(ledger, "command-1", send(true));
  const again = yield* sendOnce(ledger, "command-1", send(false));
  const other = yield* sendOnce(ledger, "command-2", send(false));
  assert.equal(first._tag === "Sent" && Result.isFailure(first.result), true);
  assert.equal(again._tag, "Duplicate");
  assert.equal(other._tag === "Sent" && Result.isSuccess(other.result), true);
  assert.equal(yield* Ref.get(sends), 2);
}));

it.effect("a prepared command is initiated once and its flight released once, on an answer and on a failure", () => Effect.gen(function* () {
  const counts = {initiations: 0, releases: 0};
  const prepared = (result: Effect.Effect<CommandReceipt, T3RequestError>): T3PreparedCommand<CommandReceipt, T3RequestError> => ({
    operation: "orchestration/dispatchCommand",
    initiate: () => Effect.sync(() => {
      counts.initiations += 1;
      return {sent: Effect.succeed(true), result, release: Effect.sync(() => {counts.releases += 1;})};
    }),
  });
  const ledger = yield* makeLedger;
  const answered = yield* sendOnce(ledger, "stop", initiated(prepared(Effect.succeed({sequence: 7}))));
  const failed = yield* sendOnce(ledger, "cancel", initiated(prepared(Effect.fail(request({dispatchCommandFailure: true})))));
  const replay = yield* sendOnce(ledger, "cancel", initiated(prepared(Effect.succeed({sequence: 8}))));
  assert.equal(answered._tag === "Sent" && Result.isSuccess(answered.result) ? answered.result.success.sequence : null, 7);
  assert.equal(failed._tag === "Sent" && Result.isFailure(failed.result) ? classifyFailure(failed.result.failure).outcome : null, "uncertain");
  assert.equal(replay._tag, "Duplicate");
  assert.deepEqual(counts, {initiations: 2, releases: 2});
}));

const taskId = "t3-cohort-probe-helper:1";
const deliveryId = "delivery-1";
const body = JSON.stringify({batchId: "t3-cohort-probe-batch:1", text: "check-in"});
const expected = {taskId, body, bodyBytes: Buffer.byteLength(body)};
const rendered = "<webhook-data-0123456789ab>check-in</webhook-data-0123456789ab>\n\nText between the frame tags was copied from the webhook request.";
const message: MessageInfo = {id: `scheduled-task-message:${taskId}:webhook:${deliveryId}`, runId: null, nodeId: null, role: "user", text: rendered,
  streaming: false, createdAt: "2026-11-03T10:00:01.000Z", updatedAt: "2026-11-03T10:00:01.000Z", scheduledTaskId: taskId, creationSource: "server",
  createdBy: "system"};
const detail: NativeRecord = {id: deliveryId, taskId, outcome: "accepted", method: "POST", contentType: "application/json", bodyBytes: expected.bodyBytes,
  body, bodyTruncated: false, missingFields: [], renderedPrompt: rendered, receivedAt: "2026-11-03T10:00:00.000Z"};
const observed = (overrides: Partial<DeliveryObservation> = {}): DeliveryObservation => ({
  logFailure: null, listed: 1, deliveryId, summary: {id: deliveryId, taskId, outcome: "accepted"}, detail, detailFailure: null, message, threadFailure: null,
  ...overrides,
});
const acceptedPost = {_tag: "Reply", reply: {_tag: "Accepted", deliveryId}} as const;
const withDetail = (fields: Record<string, unknown>): Partial<DeliveryObservation> => ({detail: {...detail, ...fields}});

it("a helper delivery passes only with the exact logged request, a rendered prompt and the attributed scheduled message", () => {
  assert.equal(judgeDelivery(acceptedPost, observed(), expected).outcome, "accepted");
  assert.equal(judgeDelivery(acceptedPost, observed({message: {...message, text: "another text"}}), expected).outcome, "contradicted");
  assert.equal(judgeDelivery(acceptedPost, observed({message: {...message, createdBy: "user"}}), expected).outcome, "contradicted");
  assert.equal(judgeDelivery(acceptedPost, observed(withDetail({bodyTruncated: true})), expected).outcome, "contradicted");
  assert.equal(judgeDelivery(acceptedPost, observed(withDetail({renderedPrompt: null})), expected).outcome, "contradicted");
  // T3 logged that it could not dispatch: without a message that is its definite refusal, beside a message a contradiction
  assert.equal(judgeDelivery(acceptedPost, observed({...withDetail({outcome: "dispatch_failed"}), message: null}), expected).outcome, "rejected");
  assert.equal(judgeDelivery(acceptedPost, observed(withDetail({outcome: "dispatch_failed"})), expected).outcome, "contradicted");
  assert.equal(judgeDelivery(acceptedPost, observed({message: null}), expected).outcome, "uncertain");
  assert.equal(judgeDelivery(acceptedPost, observed({deliveryId: null, summary: null, detail: null}), expected).outcome, "contradicted");
});

it("a refused or unconfirmed POST never passes, and a delivery after a refusal contradicts it", () => {
  const refused = {_tag: "Reply", reply: {_tag: "Refused", httpStatus: 404}} as const;
  assert.equal(judgeDelivery(refused, observed({message: null, deliveryId: null, summary: null, detail: null}), expected).outcome, "rejected");
  assert.equal(judgeDelivery(refused, observed(), expected).outcome, "contradicted");
  assert.equal(judgeDelivery({_tag: "Reply", reply: {_tag: "Unconfirmed", httpStatus: 502}}, observed(), expected).outcome, "uncertain");
  assert.equal(judgeDelivery({_tag: "Failed", failure: classifyFailure(new T3WebhookError({operation: "helper/postWebhook"}))}, observed(), expected).outcome,
    "uncertain");
});

it("helper evidence names facts, never the request body, the rendered prompt or the message text", () => {
  for (const seen of [observed(), observed({message: {...message, text: "another text"}}), observed({message: null})]) {
    const printed = judgeDelivery(acceptedPost, seen, expected).detail;
    assert.equal(printed.includes(body), false);
    assert.equal(printed.includes("check-in"), false);
    assert.equal(printed.includes("another text"), false);
  }
  assert.equal(stated("x".repeat(500)).length, 66);
  assert.equal(stated({token: "secret"}), "object");
});

it("git status paths include both paths of a rename", () => {
  assert.deepEqual(porcelainPaths("?? .t3-supervisor/project.yaml\0R  new.txt\0old.txt\0 M README.md\0"),
    [".t3-supervisor/project.yaml", "new.txt", "old.txt", "README.md"]);
  assert.deepEqual(porcelainPaths(""), []);
});

it("a thread is idle only without a live, waiting or queued run", () => {
  const run = (status: string): RunInfo => ({id: status, ordinal: 1, status, requestedAt: "", startedAt: null, completedAt: null, rootNodeId: null});
  assert.equal(idle({runs: []}), true);
  assert.equal(idle({runs: [run("failed"), run("completed"), run("cancelled")]}), true);
  for (const status of ["preparing", "starting", "running", "waiting", "queued"]) assert.equal(idle({runs: [run("failed"), run(status)]}), false);
});

it("the probe's arguments", () => {
  assert.deepEqual(parseArguments(["--probe"]), {_tag: "Probe", keep: false, cacheDir: null, lock: null});
  assert.deepEqual(parseArguments(["--probe", "--keep", "--cache-dir", "/cache/t3-runtime", "--t3-lock", "t3-targets.lock.json", "--slot", "nightly-1"]),
    {_tag: "Probe", keep: true, cacheDir: "/cache/t3-runtime", lock: {file: "t3-targets.lock.json", slot: "nightly-1"}});
  for (const args of [[], ["--keep"], ["--probe", "--t3-lock", "lock.json"], ["--probe", "--slot", "nightly"], ["--probe", "--t3-lock", "lock.json", "--slot", "latest"],
    ["--probe", "--check"], ["--probe", "--cache-dir"], ["--probe", "--probe"]])
    assert.equal(parseArguments(args)._tag, "Invalid");
});
