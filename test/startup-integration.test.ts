import assert from "node:assert/strict";
import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/http";
import { toolRouteReminder } from "../src/supervisor-workflow.js";
import { startStartupSession, type StartupDispatch } from "./support/startup-gateway.js";
import { workflowFields } from "./support/interpretation-submit.js";

// one production startup: real launch, gateway reads, submitted then finalized interpretation.
// an initial notice that lacks the discovery hint before workflow_read fails this test.

const hintBeforeRead = (dispatch: StartupDispatch): boolean => {
  const hintAt = dispatch.text.indexOf(toolRouteReminder);
  return hintAt >= 0 && dispatch.text.indexOf("workflow_read") > hintAt;
};

const waitFor = <A>(read: Effect.Effect<A | null>, label: () => string): Effect.Effect<A> => Effect.gen(function* () {
  const deadline = Date.now() + 75_000;
  for (;;) {
    const value = yield* read;
    if (value !== null) return value;
    if (Date.now() >= deadline) return yield* Effect.die(new Error(label()));
    yield* Effect.sleep("250 millis");
  }
});

type InstructionView = {status?: string; view?: string; core?: string};
type ContextView = {
  status?: string;
  submission?: {arguments?: Record<string, unknown>; startVerdict?: unknown} | null;
  task?: {sourceMessageId?: string};
};

const contextView = (value: unknown): ContextView | null => {
  if (typeof value !== "object" || value === null) return null;
  const view = value as ContextView;
  const source = view.submission?.arguments?.sourcePin;
  return view.status === "ok" && view.submission?.arguments && view.task?.sourceMessageId && source && typeof source === "object" ? view : null;
};

it.live("the production app launches a root and finalizes a gateway interpretation only when the initial discovery hint is present", () => Effect.gen(function* () {
  const {gateway, observe} = yield* startStartupSession;
  const objective = yield* waitFor(Effect.sync(() => observe.objectiveDispatches()[0] ?? null),
    () => `root launch did not dispatch an interpretation: ${JSON.stringify(observe.debug())}`);
  assert.ok(hintBeforeRead(objective), "initial discovery hint is missing before workflow_read");
  for (const dispatch of observe.dispatches()) {
    if (!dispatch.commandId.startsWith("supervisor-objective:") && !dispatch.text.startsWith("Supervisor helper")) continue;
    assert.ok(hintBeforeRead(dispatch), "initial discovery hint is missing before workflow_read");
  }
  const names = yield* gateway.discover();
  assert.ok(names.includes("workflow_read") && names.includes("supervision_interpretation_submit"), "gateway discovery is missing the startup tools");
  const readerMatch = /with (\{"supervisorThreadId":"[^"]+","bindingGeneration":\d+\})/u.exec(objective.text);
  assert.ok(readerMatch?.[1], "the initial notice did not name a workflow reader");
  const reader = JSON.parse(readerMatch[1]) as {supervisorThreadId: string; bindingGeneration: number};
  const instructions = (yield* gateway.call("workflow_read", {...reader, view: "instructions"})) as InstructionView;
  assert.equal(instructions.status, "ok");
  assert.equal(instructions.view, "instructions");
  assert.equal(typeof instructions.core, "string");
  const context = yield* waitFor(gateway.call("workflow_read", {...reader, view: "context"}).pipe(Effect.map(contextView)),
    () => `workflow_read context did not return submission pins: ${JSON.stringify(observe.debug())}`);
  assert.notEqual(context.submission?.startVerdict, true);
  const pins = context.submission?.arguments;
  const sourcePin = pins?.sourcePin as {messageId?: string} | undefined;
  assert.ok(pins && sourcePin?.messageId, "the context view did not name the source message");
  assert.equal(sourcePin.messageId, context.task?.sourceMessageId);
  const objectiveText = "Confirm whether this checkout is current with its remote.";
  const submitted = (yield* gateway.call("supervision_interpretation_submit", {...pins, objective: objectiveText,
    reason: "A lookup the operative completes and checks itself.", sourceMessageIds: [sourcePin.messageId], supervision: "not_needed", workflow: null,
    conversation: {draft: {objective: objectiveText, constraints: [], questions: [], findings: [], duties: []}, intent: "following", outcome: objectiveText,
      limits: [], sourceMessageIds: [sourcePin.messageId], antecedentMessageIds: [], scope: "changed"}})) as {status?: string};
  assert.equal(submitted.status, "submitted", JSON.stringify(submitted));
  assert.equal(observe.requestRunStatus(), "running");
  assert.ok(observe.interpretationReceipts() >= 1, "the submission was not persisted");
  assert.notEqual(observe.taskDocument()?.status, "inferred");
  observe.completeRequestRun();
  const finalized = yield* waitFor(Effect.sync(() => {
    const task = observe.taskDocument();
    return task?.status === "inferred" && task.supervision === "not_needed" ? task : null;
  }), () => `interpretation did not finalize: ${JSON.stringify(observe.taskDocument())} ${JSON.stringify(observe.debug())}`);
  assert.equal(finalized.workflow ?? null, null);
  assert.equal(observe.mainDispatches().length, 0, "a not_needed interpretation does not contact the main");
}).pipe(Effect.provide(Layer.mergeAll(NodeFileSystem.layer, FetchHttpClient.layer))), {timeout: 90_000});

it.live("the production startup recovers once from an unread-source interpretation with a fresh attempt", () => Effect.gen(function* () {
  const {gateway, observe} = yield* startStartupSession;
  const first = yield* waitFor(Effect.sync(() => observe.objectiveDispatches()[0] ?? null), () => "initial interpretation was not dispatched");
  yield* gateway.discover();
  const match = /with (\{"supervisorThreadId":"[^"]+","bindingGeneration":\d+\})/u.exec(first.text);
  assert.ok(match?.[1]);
  const reader = JSON.parse(match[1]) as {supervisorThreadId: string; bindingGeneration: number};
  const instructions = (yield* gateway.call("workflow_read", {...reader, view: "instructions"})) as InstructionView;
  assert.match(instructions.core ?? "", /Try the native operation once before declaring it unavailable/u);
  assert.match(instructions.core ?? "", /a connector search covers only that connector/u);
  const initial = yield* waitFor(gateway.call("workflow_read", {...reader, view: "context"}).pipe(Effect.map(contextView)),
    () => "initial submission pins missing");
  const empty = {...initial.submission!.arguments, objective: null, reason: "The source was not read.", sourceMessageIds: [], supervision: "needed", workflow: null,
    conversation: {draft: {objective: null, constraints: [], questions: [], findings: [], duties: []}, intent: "following", outcome: null,
      limits: [], sourceMessageIds: [], antecedentMessageIds: [], scope: "same"}};
  assert.equal(((yield* gateway.call("supervision_interpretation_submit", empty)) as {status: string}).status, "submitted");
  observe.completeRequestRun();
  const second = yield* waitFor(Effect.sync(() => observe.objectiveDispatches()[1] ?? null),
    () => `the empty interpretation did not retry: ${JSON.stringify(observe.debug())}`);
  assert.equal(second.threadId, first.threadId);
  assert.notEqual(second.commandId, first.commandId);
  const retried = yield* waitFor(gateway.call("workflow_read", {...reader, view: "context"}).pipe(Effect.map(contextView)),
    () => "retry submission pins missing");
  assert.notEqual(retried.submission!.arguments!.attemptId, initial.submission!.arguments!.attemptId);
  assert.deepEqual(retried.submission!.arguments!.sourcePin, initial.submission!.arguments!.sourcePin);
  const source = retried.task!.sourceMessageId!;
  const objective = "Confirm whether the checkout is current.";
  const fields = {...retried.submission!.arguments, objective, reason: "The source was read.", sourceMessageIds: [source], supervision: "not_needed", workflow: null,
    conversation: {draft: {objective, constraints: [], questions: [], findings: [], duties: []}, intent: "following", outcome: objective,
      limits: [], sourceMessageIds: [source], antecedentMessageIds: [], scope: "changed"}};
  assert.equal(((yield* gateway.call("supervision_interpretation_submit", fields)) as {status: string}).status, "submitted");
  observe.completeRequestRun();
  yield* waitFor(Effect.sync(() => observe.taskDocument()?.status === "inferred" ? true : null), () => "the retry did not finalize");
  assert.equal(observe.interpretationReceipts(), 2);
  assert.equal(observe.objectiveDispatches().length, 2);
  assert.equal(observe.mainDispatches().length, 0);
}).pipe(Effect.provide(Layer.mergeAll(NodeFileSystem.layer, FetchHttpClient.layer))), {timeout: 90_000});

it.live("a needed-work startup delivers a short notice and the operative reads its own step contracts through the gateway", () => Effect.gen(function* () {
  const {gateway, observe} = yield* startStartupSession;
  const objective = yield* waitFor(Effect.sync(() => observe.objectiveDispatches()[0] ?? null),
    () => "the fresh root did not receive its interpretation request");
  assert.ok(hintBeforeRead(objective));
  assert.ok((yield* gateway.discover()).includes("supervision_plan"));
  const match = /with (\{"supervisorThreadId":"[^"]+","bindingGeneration":\d+\})/u.exec(objective.text);
  assert.ok(match?.[1]);
  const reader = JSON.parse(match[1]) as {supervisorThreadId: string; bindingGeneration: number};
  const context = yield* waitFor(gateway.call("workflow_read", {...reader, view: "context"}).pipe(Effect.map(contextView)),
    () => "the fresh context did not expose interpretation pins");
  const pins = context.submission!.arguments!;
  const source = pins.sourcePin as {messageId: string};
  const fields = workflowFields("Inspect the checkout and explain its status.", "Two bounded evidence and reporting duties.", {
    sourceMessageIds: [source.messageId],
    workflow: {requirements: [], plan: {kind: "sequence", nodes: [
      {kind: "step", definitionId: null, localId: "inspect", name: "Inspect checkout", description: "Read the current checkout and its remote state.", reason: "Establish the facts."},
      {kind: "step", definitionId: null, localId: "explain", name: "Explain status", description: "Explain the observed status and any gaps.", reason: "Answer from the evidence.",
        references: [".t3-supervisor/project.yaml"], skills: ["catalog-reading"]},
    ]}},
    conversation: {draft: {objective: "Inspect the checkout and explain its status.", constraints: [], questions: [], findings: [], duties: []},
      intent: "authorize", outcome: "Inspect the checkout and explain its status.", limits: [], sourceMessageIds: [source.messageId], antecedentMessageIds: [], scope: "changed"},
  });
  assert.equal(((yield* gateway.call("supervision_interpretation_submit", {...pins, ...fields})) as {status: string}).status, "submitted");
  observe.completeRequestRun();
  const notice = yield* waitFor(Effect.sync(() => observe.mainDispatches().find(item => item.text.includes("supervision_plan")) ?? null),
    () => `the needed interpretation never delivered its proposal: ${JSON.stringify(observe.debug())}`);
  assert.doesNotMatch(notice.text, /Step entry:|Inspect checkout|Explain status/u, "the native notice remains a pointer");
  const args = /supervision_plan (\{"callerThreadId":"[^"]+","taskId":"[^"]+","proposalId":"[^"]+"\})/u.exec(notice.text);
  assert.ok(args?.[1], "the notice names the actual operative reader arguments");
  const proposal = (yield* gateway.call("supervision_plan", JSON.parse(args[1]))) as {status: string; proposal?: string};
  assert.equal(proposal.status, "ok", JSON.stringify(proposal));
  const text = proposal.proposal!;
  assert.equal(text.split("Step entry:").length, 2);
  assert.match(text, /Before substantive work there, read or refresh its contract and applicable references and skills/u);
  assert.match(text, /Continue without waiting for routine confirmation/u);
  assert.match(text, /Inspect checkout/u);
  assert.match(text, /Explain status/u);
  assert.match(text, /\.t3-supervisor\/project\.yaml/u);
  assert.match(text, /catalog-reading/u);
  assert.equal(observe.taskDocument()?.status, "inferred");
}).pipe(Effect.provide(Layer.mergeAll(NodeFileSystem.layer, FetchHttpClient.layer))), {timeout: 90_000});
