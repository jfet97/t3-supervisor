import { Exit, Schema } from "effect";

// t3 publishes a provider turn for each identifiable native child execution; observation,
// planning and the write controller read them through this one decoder

export const nativeProviderTurnStatuses = ["pending", "running", "completed", "interrupted", "failed", "cancelled"] as const;
export type NativeProviderTurnStatus = typeof nativeProviderTurnStatuses[number];

/** One published provider turn with strong native provenance; startedAt is in epoch milliseconds, null before the turn starts. */
export type NativeProviderTurn = {
  id: string;
  providerThreadId: string;
  nodeId: string;
  status: NativeProviderTurnStatus;
  startedAt: number | null;
};

const NativeId = Schema.String.check(Schema.isMinLength(1));
const PublishedProviderTurns = Schema.Array(Schema.Struct({
  id: NativeId,
  providerThreadId: NativeId,
  nodeId: NativeId,
  nativeTurnRef: Schema.NullOr(Schema.Struct({
    driver: Schema.String,
    nativeId: Schema.NullOr(Schema.String),
    strength: Schema.Literals(["strong", "weak", "none"]),
  })),
  status: Schema.Literals(nativeProviderTurnStatuses),
  startedAt: Schema.NullOr(Schema.String),
}));
const decodePublishedProviderTurns = Schema.decodeUnknownExit(PublishedProviderTurns);

/**
 * The provider turns a thread projection publishes with strong native provenance: [] when it publishes none, null when the published list is
 * malformed, a turn ID repeats or a start time does not parse. A turn without a strong native turn reference identifies nothing and is left
 * out.
 */
export const readNativeProviderTurns = (projection: Readonly<Record<string, unknown>>): NativeProviderTurn[] | null => {
  if (projection.providerTurns === undefined) return [];
  const decoded = decodePublishedProviderTurns(projection.providerTurns);
  if (Exit.isFailure(decoded)) return null;
  const seen = new Set<string>();
  const turns: NativeProviderTurn[] = [];
  for (const turn of decoded.value) {
    if (seen.has(turn.id)) return null;
    seen.add(turn.id);
    const startedAt = turn.startedAt === null ? null : Date.parse(turn.startedAt);
    if (startedAt !== null && !Number.isFinite(startedAt)) return null;
    const ref = turn.nativeTurnRef;
    if (ref === null || ref.strength !== "strong" || ref.driver.length === 0 || !ref.nativeId) continue;
    turns.push({id: turn.id, providerThreadId: turn.providerThreadId, nodeId: turn.nodeId, status: turn.status, startedAt});
  }
  return turns;
};

/**
 * Whether a published execution node of the thread lies in the provider turn's own graph: the turn's published root node and every
 * node up to it carry this thread, the turn, its provider thread and no AppRun, and the walk crosses no nested subagent and nothing
 * rolled back.
 */
export const providerTurnNode = (projection: Readonly<Record<string, unknown>> & {thread: {id: string}}, turn: NativeProviderTurn, nodeId: string): boolean => {
  const nodes = new Map<string, Record<string, unknown>>();
  for (const node of Array.isArray(projection.nodes) ? projection.nodes as unknown[] : [])
    if (typeof node === "object" && node !== null && typeof (node as {id?: unknown}).id === "string") nodes.set((node as {id: string}).id, node as Record<string, unknown>);
  const inTurn = (node: Record<string, unknown> | undefined): node is Record<string, unknown> => node !== undefined &&
    node.threadId === projection.thread.id && node.providerTurnId === turn.id && node.providerThreadId === turn.providerThreadId &&
    node.runId == null && node.rootNodeId === turn.nodeId && node.kind !== "subagent" && node.status !== "rolled_back";
  const root = nodes.get(turn.nodeId);
  if (!inTurn(root) || root.parentNodeId != null) return false;
  const visited = new Set<string>();
  for (let current = nodes.get(nodeId); inTurn(current) && !visited.has(current.id as string);
    current = typeof current.parentNodeId === "string" ? nodes.get(current.parentNodeId) : undefined) {
    if (current.id === turn.nodeId) return true;
    visited.add(current.id as string);
  }
  return false;
};

const PublishedNodes = Schema.Array(Schema.Struct({
  id: Schema.String,
  threadId: Schema.String,
  providerThreadId: Schema.optional(Schema.NullOr(Schema.String)),
  providerTurnId: Schema.optional(Schema.NullOr(Schema.String)),
}));
const decodePublishedNodes = Schema.decodeUnknownExit(PublishedNodes);

/**
 * The provider turn a thread's published execution node belongs to, such as the node of a cited message: undefined when the node is not
 * published or the node list is malformed, null when the node names no turn.
 */
export const nativeNodeTurn = (projection: Readonly<Record<string, unknown>>, nodeId: string, threadId: string):
  {providerTurnId: string; providerThreadId: string | null} | null | undefined => {
  const decoded = decodePublishedNodes(projection.nodes ?? []);
  if (Exit.isFailure(decoded)) return undefined;
  const node = decoded.value.find(candidate => candidate.id === nodeId && candidate.threadId === threadId);
  if (!node) return undefined;
  return node.providerTurnId ? {providerTurnId: node.providerTurnId, providerThreadId: node.providerThreadId || null} : null;
};
