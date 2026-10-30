import { Context, Effect, FiberMap, Layer, Option, Ref, Schedule, Schema } from "effect";
import { GuidanceDb } from "./db.js";
import { guidanceTransaction, type SupervisionStoreError } from "./guidance-sql.js";
import { SupervisorIds } from "./ids.js";
import { logEvent } from "./logging.js";
import { ProjectSupervisorStore, type BindingRecord } from "./project-supervisor-store.js";
import { admitSend, SupervisionGate, SupervisionScopeService, type SendPreparation } from "./supervision-gate.js";
import { type CompactionReminder, type RootCompaction } from "./supervisor-compaction-contract.js";
import { hasPendingOwnerInput, resolveSteerableRun } from "./supervisor-conversation.js";
import { NativeOperateRpc, record, SupervisorRpcError } from "./supervisor-native.js";
import { T3Client } from "./t3.js";
import type { Projection, RunInfo } from "./types.js";
import { WorkflowStateStore } from "./workflow-state-store.js";

const NonBlank = Schema.String.check(Schema.makeFilter(value => value.trim().length > 0));
const NativeCompaction = Schema.Struct({id: NonBlank, threadId: NonBlank, runId: NonBlank, nodeId: NonBlank,
  ordinal: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)), type: Schema.Literal("compaction"), status: Schema.String});
const isCompaction = Schema.is(NativeCompaction);
const isSequence = Schema.is(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)));
const busyToolTypes = new Set(["dynamic_tool", "command_execution", "file_change", "file_search", "web_search",
  "approval_request", "user_input_request", "secret_request"]);
const liveStatuses = new Set(["pending", "running", "waiting"]);
const sameOwner = (current: BindingRecord | null, owner: BindingRecord): current is BindingRecord =>
  current?.threadId === owner.threadId && current.generation === owner.generation;
const ownsProjection = (binding: BindingRecord, projection: Projection): boolean =>
  projection.thread.id === binding.threadId && projection.thread.projectId === binding.projectId;
const rootItem = (binding: BindingRecord, projection: Projection, item: unknown) => {
  if (!isCompaction(item) || item.threadId !== binding.threadId) return null;
  const run = projection.runs.find(run => run.id === item.runId && run.rootNodeId === item.nodeId &&
    (run.threadId === undefined || run.threadId === binding.threadId));
  return run && isSequence(run.ordinal) ? {item, run} : null;
};

// native capability evidence prevents T3's interrupt/restart fallback from being selected for this reminder
const supportsNativeSteering = (projection: Projection, run: RunInfo): boolean => {
  const thread = projection.providerThreads?.find(thread => thread.id === run.providerThreadId);
  if (!thread || !Array.isArray(projection.providerSessions)) return false;
  const session: unknown = projection.providerSessions.find((value: unknown) => record(value) && value.id === thread.providerSessionId);
  return record(session) && record(session.capabilities) && record(session.capabilities.turns) && session.capabilities.turns.supportsActiveSteering === true;
};
const hasLiveRootTool = (projection: Projection, run: RunInfo): boolean => (projection.turnItems ?? []).some(item =>
  item.threadId === projection.thread.id && item.runId === run.id && busyToolTypes.has(String(item.type)) && liveStatuses.has(String(item.status)));

export const compactionReminderText = (binding: BindingRecord, workflowReader: boolean): string =>
  `Context compaction does not end your watch. You remain Supervisor for main ${JSON.stringify(binding.mainThreadId)} and verified descendants. ` +
  (workflowReader ? `After compaction, reread core/index with workflow_read view instructions using ${JSON.stringify({supervisorThreadId: binding.threadId, bindingGeneration: binding.generation})}, even if its version is unchanged. ` +
    "If the tool is absent, discover available tools or connected gateways. Read current task/status and the agreed plan on demand. " :
    "After compaction, recover your standing instructions and current request from your conversation. No operative work, files or shell. ") +
  "Check your inbox and current state before acting; preserve human Stops and authority. Continue the current watch if work remains; otherwise finish quietly. This reminder creates no new task or check-in.";

export interface SupervisorCompactionShape {
  readonly sync: Effect.Effect<void, SupervisionStoreError>;
  readonly observe: (binding: BindingRecord, projection: Projection) => Effect.Effect<void, SupervisionStoreError>;
}

const make = Effect.gen(function* () {
  const store = yield* ProjectSupervisorStore;
  const gate = yield* SupervisionGate;
  const scope = yield* SupervisionScopeService;
  const t3 = yield* T3Client;
  const ids = yield* SupervisorIds;
  const transaction = guidanceTransaction(yield* GuidanceDb);
  const operate = Option.getOrNull(yield* Effect.serviceOption(NativeOperateRpc));
  const workflowReader = Option.isSome(yield* Effect.serviceOption(WorkflowStateStore));
  const watchers = yield* FiberMap.make<string, never>();
  const deliveries = yield* FiberMap.make<string, void>();
  const membership = yield* Ref.make(new Set<string>());

  const observe = (binding: BindingRecord, projection: Projection): Effect.Effect<void, SupervisionStoreError> => {
    if (!store.ownedIds.has(binding.threadId) || !ownsProjection(binding, projection)) return Effect.void;
    const completed: RootCompaction[] = [];
    for (const item of projection.turnItems ?? []) {
      const selected = rootItem(binding, projection, item);
      if (selected?.item.status === "completed") completed.push({itemId: selected.item.id, runId: selected.run.id,
        runOrdinal: selected.run.ordinal, itemOrdinal: selected.item.ordinal});
    }
    return gate.admit(() => transaction(Effect.gen(function* () {
      for (const item of completed) yield* store.recordCompaction(binding, item);
      const owner = yield* store.binding(binding.projectId, binding.mainThreadId);
      const receipt = owner?.compactionReminder;
      if (sameOwner(owner, binding) && receipt && receipt.state !== "visible" &&
        projection.messages.some(message => message.threadId === binding.threadId && message.id === receipt.messageId && message.text === receipt.text))
        yield* store.setCompactionReminder(binding, receipt.messageId, {...receipt, state: "visible"});
    })));
  };

  const steer = (binding: BindingRecord, projection: Projection, itemId: string): Effect.Effect<void, SupervisionStoreError> => Effect.gen(function* () {
    if (!operate || !ownsProjection(binding, projection) || projection.thread.archivedAt || projection.thread.deletedAt) return;
    const selected = rootItem(binding, projection, projection.turnItems?.find(item => item.id === itemId));
    const run = resolveSteerableRun(projection);
    if (!selected || selected.item.status !== "running" || !run || run.id !== selected.run.id ||
      !supportsNativeSteering(projection, run) || hasLiveRootTool(projection, run) || hasPendingOwnerInput(projection)) return;
    const messageId = `supervisor-notice:compaction:${yield* ids.uuid}`;
    const commandId = `supervisor-compaction:${yield* ids.uuid}`;
    const receipt: CompactionReminder = {itemId, runId: run.id, messageId, commandId, text: compactionReminderText(binding, workflowReader), state: "sending"};
    const classify = (state: CompactionReminder["state"]) => store.setCompactionReminder(binding, messageId, {...receipt, state}).pipe(Effect.asVoid, Effect.orDie);
    yield* admitSend(gate, {identity: `${binding.threadId}:${binding.generation}:${run.id}`, inFlight: deliveries, reconcile: Effect.void,
      prepare: guard => transaction(Effect.gen(function* (): Effect.fn.Return<SendPreparation<void>, SupervisionStoreError> {
        const owner = yield* store.binding(binding.projectId, binding.mainThreadId);
        if (!sameOwner(owner, binding) || owner.state !== "ready" || !store.ownedIds.has(owner.threadId) ||
          !(yield* guard.scopeEnabled(binding.projectId, binding.mainThreadId)) || (yield* guard.supervisionStopped(binding.mainThreadId)))
          return {_tag: "Answer", value: undefined};
        const previous = owner.compactionReminder;
        // a run gets one attempt; an older uncertain attempt keeps its identity until native visibility resolves it
        if (previous && (previous.runId === run.id || previous.state === "sending" || previous.state === "uncertain"))
          return {_tag: "Answer", value: undefined};
        if (!(yield* store.setCompactionReminder(binding, previous?.messageId ?? null, receipt))) return {_tag: "Answer", value: undefined};
        return {_tag: "Initiate", initiate: Effect.map(operate.initiate("orchestration.dispatchCommand", {
          type: "message.dispatch", commandId, messageId, threadId: binding.threadId, text: receipt.text,
          attachments: [], createdBy: "system", creationSource: "server", dispatchMode: {type: "steer_active", targetRunId: run.id},
        }), flight => ({release: flight.release, result: Effect.matchEffect(flight.result, {
          onSuccess: value => classify(record(value) && isSequence(value.sequence) ? "accepted" : "uncertain"),
          onFailure: error => classify(error instanceof SupervisorRpcError && error.definiteRejection ? "rejected" : "uncertain"),
        }).pipe(Effect.onInterrupt(() => classify("uncertain")))}))};
      })),
    });
  });

  const watchRoot = (binding: BindingRecord) => Effect.gen(function* () {
    const cursor = yield* Ref.make<number | undefined>(undefined);
    return yield* Effect.flatMap(Ref.get(cursor), after => t3.watchThread(binding.threadId, after, item => Effect.gen(function* () {
      if (item.kind === "snapshot" && record(item.projection)) {
        const projection = item.projection as unknown as Projection;
        yield* observe(binding, projection);
        for (const candidate of projection.turnItems ?? []) {
          if (!isCompaction(candidate) || candidate.status !== "running") continue;
          const fresh = yield* t3.projection(binding.threadId);
          yield* observe(binding, fresh.projection);
          yield* steer(binding, fresh.projection, candidate.id);
        }
      } else if (item.kind === "event" && record(item.event) && item.event.type === "turn-item.updated" &&
        isCompaction(item.event.payload) && item.event.payload.threadId === binding.threadId) {
        const candidate = item.event.payload;
        if (candidate.status === "running" || candidate.status === "completed") {
          const fresh = yield* t3.projection(binding.threadId);
          if (!isSequence(item.sequence) || fresh.snapshotSequence >= item.sequence) {
            yield* observe(binding, fresh.projection);
            if (candidate.status === "running") yield* steer(binding, fresh.projection, candidate.id);
          }
        }
      }
      const sequence = item.kind === "snapshot" ? item.snapshotSequence : item.sequence;
      if (isSequence(sequence)) yield* Ref.update(cursor, previous => Math.max(previous ?? 0, sequence));
    }))).pipe(Effect.tapError(() => logEvent("supervisor_compaction_watch_unavailable")), Effect.retry(Schedule.spaced("1 second")));
  });

  const sync = Effect.gen(function* () {
    const bindings = yield* store.bindings();
    const wanted = new Map<string, BindingRecord>();
    for (const binding of bindings) {
      if ((binding.state === "ready" || binding.state === "creating") && store.ownedIds.has(binding.threadId) &&
        (yield* scope.scopeEnabled(binding.projectId, binding.mainThreadId)) && !(yield* scope.supervisionStopped(binding.mainThreadId)))
        wanted.set(`${binding.threadId}:${binding.generation}`, binding);
    }
    const previous = yield* Ref.get(membership);
    for (const key of previous) if (!wanted.has(key)) yield* FiberMap.remove(watchers, key);
    for (const [key, binding] of wanted) yield* FiberMap.run(watchers, key, watchRoot(binding).pipe(Effect.orDie), {onlyIfMissing: true});
    yield* Ref.set(membership, new Set(wanted.keys()));
  });

  return {sync, observe} satisfies SupervisorCompactionShape;
});

/** Scoped native root listeners; normal scheduling only reconciles their membership and the backup notice state. */
export class SupervisorCompaction extends Context.Service<SupervisorCompaction, SupervisorCompactionShape>()("t3-supervisor/SupervisorCompaction") {
  static readonly layer = Layer.effect(SupervisorCompaction, make);
}
