import { Cause, Effect, Exit, Schema } from "effect";
import { mainRunNodeReader, timestampMs } from "./domain.js";
import { record } from "./supervisor-native.js";
import type { ConversationRequest } from "./supervisor-conversation-store.js";
import type { Projection } from "./types.js";
import { recognisedThreadReadArguments, type WorkflowToolRoutes } from "./workflow-write-evidence.js";

import { type NativeActivityRead } from "./supervisor-awareness-contract.js";
export { NativeActivityRead } from "./supervisor-awareness-contract.js";
const ReadSnapshot = Schema.Struct({
  thread: Schema.Struct({threadId: Schema.String}),
  items: Schema.Array(Schema.Struct({itemId: Schema.String, position: Schema.Number, textTruncated: Schema.Boolean})),
  hasMore: Schema.Boolean,
});

const decodedObject = (input: unknown): unknown => {
  if (typeof input !== "string" || input.length > 2_000_000) return input;
  try {return JSON.parse(input);} catch {return null;}
};
const toolValue = (input: unknown): unknown => {
  const value = decodedObject(input);
  if (!record(value) || value.isError === true) return null;
  if (record(value.structuredContent)) return value.structuredContent;
  if (Array.isArray(value.content)) {
    const texts = value.content.filter(item => record(item) && item.type === "text" && typeof item.text === "string");
    return texts.length === 1 ? decodedObject(texts[0].text) : null;
  }
  return value;
};
// a read is recognised on the deployment's configured native routes, as every other call; its input may be recorded as JSON text
const readArguments = (item: Record<string, unknown>, routes: WorkflowToolRoutes): Record<string, unknown> | null => {
  const input = decodedObject(item.input);
  return record(input) ? recognisedThreadReadArguments({...item, input}, routes) : null;
};

/** A successful native read is a fetched page, never proof that its contents were assessed or earlier gaps were filled. */
export const nativeActivityRead = (projection: Projection, detail: unknown, allowed: ReadonlySet<string>, now: number,
  routes: WorkflowToolRoutes): NativeActivityRead | null => {
  if (!record(detail) || detail.type !== "dynamic_tool" || detail.status !== "completed" || detail.threadId !== projection.thread.id ||
    typeof detail.id !== "string" || typeof detail.runId !== "string" || typeof detail.nodeId !== "string" ||
    (detail.toolNonExecutionKind !== undefined && detail.toolNonExecutionKind !== null)) return null;
  const run = projection.runs.find(run => run.id === detail.runId && run.status !== "rolled_back");
  const node = run ? mainRunNodeReader(projection, run)(detail.nodeId) : null;
  if (!node || (node.kind !== "dynamic_tool" && node.kind !== "tool_call") || node.status !== "completed") return null;
  const input = readArguments(detail, routes);
  if (!input || typeof input.threadId !== "string" || !allowed.has(input.threadId)) return null;
  const result = Schema.decodeUnknownExit(ReadSnapshot)(toolValue(detail.output));
  if (Exit.isFailure(result) || result.value.thread.threadId !== input.threadId) return null;
  const latest = result.value.items.at(-1);
  const partial = result.value.items.some(item => item.textTruncated);
  return {actorThreadId: projection.thread.id, targetThreadId: input.threadId, callItemId: detail.id, runId: detail.runId,
    at: timestampMs(detail.updatedAt) ?? now, itemId: latest?.itemId ?? null, position: latest?.position ?? null,
    partial, snapshotEndReached: input.view === "activity" && !input.itemId && !partial && !result.value.hasMore};
};

/** Bounded native detail reads stay on the existing read adapter and request record, including during a busy owner turn. */
export const collectNativeReads = <E>(request: ConversationRequest, projection: Projection,
  read: (itemId: string) => Effect.Effect<unknown, E>, now: number, routes: WorkflowToolRoutes) => Effect.gen(function* () {
  const allowed = new Set(request.batch?.threads.map(item => item.threadId) ?? []);
  const run = projection.runs.find(run => run.id === request.runId || run.userMessageId === request.messageId);
  if (!run || !allowed.size) return [];
  const seen = new Set(request.nativeReadCallIds ?? request.nativeReads?.map(item => item.callItemId));
  const candidates = (projection.turnItems ?? []).filter(item => item.runId === run.id && item.threadId === projection.thread.id &&
    item.type === "dynamic_tool" && item.status === "completed" && !seen.has(String(item.id)) && readArguments(item, routes) !== null).slice(-8);
  const reads: NativeActivityRead[] = [];
  for (const item of candidates) {
    const result = yield* Effect.exit(read(String(item.id)));
    if (Exit.isFailure(result)) {if (Cause.hasInterruptsOnly(result.cause)) return yield* Effect.interrupt;continue;}
    const value = record(result.value) && "item" in result.value ? result.value.item : result.value;
    const observation = nativeActivityRead(projection, value, allowed, now, routes);
    if (observation) reads.push(observation);
  }
  return reads;
});
