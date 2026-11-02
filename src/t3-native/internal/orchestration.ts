import { Effect, Ref, Schema, type Deferred } from "effect";
import { supervisorModels, type NativeRpcInFlight, type NativeRpcShape, type NativeShellShape } from "../../supervisor-native.js";
import type { T3ClientShape } from "../../t3.js";
import type { JsonRecord, SourceItem, ThreadInfo } from "../../types.js";
import { buildFacts, selectTranslation } from "../build.js";
import {
  CommandReceipt, LaunchReceipt, LaunchThread, OrchestrationCommand, ShellBaseline, ShellSourceItem, ShellThread, T3Environment, ThreadSnapshot,
  ThreadStreamItem, TurnItemReply, TurnItemRequest, type BuildFacts, type T3Operation,
} from "../contracts.js";
import { T3InvalidInput, T3ReadError, T3RequestError } from "../errors.js";
import type { T3Command, T3InFlight, T3OrchestrationFamily } from "../service.js";
import { ConsumerFailed, malformedReply, readError, requestError } from "./classify.js";

// the orchestration family over the run's own client instances: the T3 client (HTTP reads and the subscription sockets of the read
// token), the read credential's native client and its coherent shell reads, and the operate credential's native client. Every
// deadline, byte bound, framing, retry and acknowledgement stays the wrapped client's; this module adds input validation before any
// request, receipt validation before exposure and the typed failures

export interface OrchestrationClients {
  readonly t3: T3ClientShape;
  readonly read: NativeRpcShape;
  readonly shell: NativeShellShape;
  // null where the operate credential is not configured
  readonly operate: NativeRpcShape | null;
  // the facts of the last environment read, for translation selection
  readonly observed: Ref.Ref<BuildFacts | null>;
}

const NonBlank = Schema.String.check(Schema.makeFilter((value: string) => value.trim().length > 0));
const isNonBlank = Schema.is(NonBlank);
const isSequence = Schema.is(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)));
const isEnvironment: (value: unknown) => value is T3Environment = Schema.is(T3Environment);
const isThreadSnapshot: (value: unknown) => value is ThreadSnapshot = Schema.is(ThreadSnapshot);
const isShellBaseline: (value: unknown) => value is ShellBaseline = Schema.is(ShellBaseline);
const isShellThread: (value: unknown) => value is ThreadInfo = Schema.is(ShellThread);
const isTurnItemRequest: (value: unknown) => value is TurnItemRequest = Schema.is(TurnItemRequest);
const isTurnItemReply: (value: unknown) => value is TurnItemReply = Schema.is(TurnItemReply);
const isShellSourceItem: (value: unknown) => value is ShellSourceItem = Schema.is(ShellSourceItem);
const isThreadStreamItem: (value: unknown) => value is ThreadStreamItem = Schema.is(ThreadStreamItem);
const isLaunchThread: (value: unknown) => value is LaunchThread = Schema.is(LaunchThread);
const isOrchestrationCommand: (value: unknown) => value is OrchestrationCommand = Schema.is(OrchestrationCommand);
const isLaunchReceipt: (value: unknown) => value is LaunchReceipt = Schema.is(LaunchReceipt);
const isCommandReceipt: (value: unknown) => value is CommandReceipt = Schema.is(CommandReceipt);

// the native command of a typed one: the fixed system origin of a message, and nothing the caller did not decide
const nativeCommand = (command: OrchestrationCommand): Readonly<Record<string, unknown>> => {
  switch (command._tag) {
    case "MessageDispatch":
      return {type: "message.dispatch", commandId: command.commandId, messageId: command.messageId, threadId: command.threadId, text: command.text,
        attachments: [], createdBy: "system", creationSource: "server",
        dispatchMode: command.dispatchMode.type === "steer_active"
          ? {type: "steer_active", targetRunId: command.dispatchMode.targetRunId} : {type: "queue_after_active"}};
    case "ThreadSettle":
      return {type: "thread.settle", commandId: command.commandId, threadId: command.threadId};
    case "ThreadAutoSettle":
      return {type: "thread.auto-settle", commandId: command.commandId, threadId: command.threadId, snapshotAt: command.snapshotAt};
    case "ThreadStop":
      return {type: "thread.stop", commandId: command.commandId, threadId: command.threadId, stopDelegatedTasks: command.stopDelegatedTasks,
        reason: command.reason};
    case "QueuedRunCancel":
      return {type: "queued-run.cancel", commandId: command.commandId, threadId: command.threadId, runId: command.runId};
    case "DelegatedCompletionDispose":
      return {type: "delegated_task.completion-delivery.dispose", commandId: command.commandId, parentThreadId: command.parentThreadId,
        taskId: command.taskId};
  }
};

// the Supervisor conversation's launch profile: created by the server, titled by the caller, full access in the default mode on the
// project root
const nativeLaunch = (launch: LaunchThread): Readonly<Record<string, unknown>> => ({
  commandId: launch.commandId, threadId: launch.threadId, creationSource: "server", projectId: launch.projectId, title: launch.title,
  generateTitle: false, modelSelection: launch.modelSelection, runtimeMode: "full-access", interactionMode: "default",
  workspaceStrategy: {type: "root"},
});

// the client's committed request, its reply checked against the operation's receipt; a reply that is not one is uncertain
const flightOf = <A>(operation: T3Operation, flight: NativeRpcInFlight, receipt: (value: unknown) => value is A): T3InFlight<A, T3RequestError> => ({
  sent: flight.sent,
  result: Effect.flatMap(Effect.mapError(flight.result, (error) => requestError(operation, error)),
    (value) => receipt(value) ? Effect.succeed(value) : Effect.fail(malformedReply(operation))),
  release: flight.release,
});

export const makeOrchestration = ({t3, read, shell, operate, observed}: OrchestrationClients): T3OrchestrationFamily => {
  const environment = Effect.flatMap(
    Effect.mapError(Effect.suspend(() => t3.descriptor()), (error) => readError("orchestration/environment", error)),
    (descriptor) => isEnvironment(descriptor)
      ? Effect.as(Ref.set(observed, buildFacts(descriptor)), descriptor)
      : Effect.fail(new T3ReadError({operation: "orchestration/environment", message: "T3 environment descriptor has an unsupported protocol or shape"})),
  );

  const thread = (threadId: string): Effect.Effect<ThreadSnapshot, T3ReadError | T3InvalidInput> => {
    if (!isNonBlank(threadId)) return Effect.fail(new T3InvalidInput({operation: "orchestration/thread"}));
    return Effect.flatMap(Effect.mapError(Effect.suspend(() => t3.projection(threadId)), (error) => readError("orchestration/thread", error)),
      (snapshot) => isThreadSnapshot(snapshot) ? Effect.succeed(snapshot)
        : Effect.fail(new T3ReadError({operation: "orchestration/thread", message: "T3 thread projection has an unsupported schema or shape"})));
  };

  const shellBaseline = Effect.flatMap(Effect.mapError(shell.baseline, (error) => requestError("orchestration/shellBaseline", error)),
    (baseline) => isShellBaseline(baseline) ? Effect.succeed(baseline) : Effect.fail(malformedReply("orchestration/shellBaseline")));

  const shellThreads = Effect.flatMap(Effect.mapError(shell.threads, (error) => requestError("orchestration/shellThreads", error)),
    (threads) => threads.every(isShellThread) ? Effect.succeed(threads) : Effect.fail(malformedReply("orchestration/shellThreads")));

  // a configuration the normalization refuses is the refusal the models read always reported
  const config = Effect.flatMap(
    Effect.mapError(Effect.suspend(() => read.call("server.getConfig", {})), (error) => requestError("orchestration/config", error)),
    (value) => Effect.try({
      try: () => supervisorModels(value),
      catch: () => new T3RequestError({operation: "orchestration/config", outcome: "rejected", definiteRejection: false, providerDisabled: false,
        dispatchCommandFailure: false, malformedReply: true}),
    }),
  );

  const turnItem = (request: TurnItemRequest, cancel?: Deferred.Deferred<void>): Effect.Effect<TurnItemReply, T3RequestError | T3InvalidInput> => {
    if (!isTurnItemRequest(request)) return Effect.fail(new T3InvalidInput({operation: "orchestration/turnItem"}));
    return Effect.flatMap(
      Effect.mapError(Effect.suspend(() => read.call("orchestration.getTurnItem", {threadId: request.threadId, itemId: request.itemId}, cancel)),
        (error) => requestError("orchestration/turnItem", error)),
      (reply) => isTurnItemReply(reply) ? Effect.succeed(reply) : Effect.fail(malformedReply("orchestration/turnItem")));
  };

  // every item is checked before the consumer sees it; a failed check or ingestion fails the subscription before its chunk's Ack
  const watchShell = <E = never, R = never>(cursor: number | undefined, onItem: (item: ShellSourceItem) => Effect.Effect<void, E, R>):
    Effect.Effect<never, T3ReadError | T3InvalidInput | E, R> => {
    const operation = "orchestration/watchShell" as const;
    if (cursor !== undefined && !isSequence(cursor)) return Effect.fail(new T3InvalidInput({operation}));
    return t3.watch<ConsumerFailed<E> | T3ReadError, R>(cursor, (source: SourceItem): Effect.Effect<void, ConsumerFailed<E> | T3ReadError, R> =>
      isShellSourceItem(source)
        ? Effect.mapError(onItem(source), (error) => new ConsumerFailed(error))
        : Effect.fail(new T3ReadError({operation, message: "T3 subscription item has an unsupported schema or shape"}))).pipe(
      Effect.mapError((error) => error instanceof ConsumerFailed ? error.error : error instanceof T3ReadError ? error : readError(operation, error)),
    );
  };

  const watchThread = <E = never, R = never>(threadId: string, cursor: number | undefined,
    onItem: (item: ThreadStreamItem) => Effect.Effect<void, E, R>): Effect.Effect<never, T3ReadError | T3InvalidInput | E, R> => {
    const operation = "orchestration/watchThread" as const;
    if (!isNonBlank(threadId) || cursor !== undefined && !isSequence(cursor)) return Effect.fail(new T3InvalidInput({operation}));
    return t3.watchThread<ConsumerFailed<E> | T3ReadError, R>(threadId, cursor, (item: JsonRecord): Effect.Effect<void, ConsumerFailed<E> | T3ReadError, R> =>
      isThreadStreamItem(item)
        ? Effect.mapError(onItem(item), (error) => new ConsumerFailed(error))
        : Effect.fail(new T3ReadError({operation, message: "T3 thread subscription item has an unsupported schema or shape"}))).pipe(
      Effect.mapError((error) => error instanceof ConsumerFailed ? error.error : error instanceof T3ReadError ? error : readError(operation, error)),
    );
  };

  const commands = (rpc: NativeRpcShape): NonNullable<T3OrchestrationFamily["commands"]> => {
    const launchThread: T3Command<LaunchThread, LaunchReceipt, T3RequestError> = {
      prepare: (launch) => Effect.gen(function* () {
        const operation = "orchestration/launchThread" as const;
        if (!isLaunchThread(launch)) return yield* new T3InvalidInput({operation});
        yield* selectTranslation(operation, yield* Ref.get(observed));
        const payload = nativeLaunch(launch);
        return {operation, initiate: (cancel?: Deferred.Deferred<void>) =>
          Effect.map(rpc.initiate("orchestration.launchThread", payload, cancel), (flight) => flightOf(operation, flight, isLaunchReceipt))};
      }),
    };
    const dispatchCommand: T3Command<OrchestrationCommand, CommandReceipt, T3RequestError> = {
      prepare: (command) => Effect.gen(function* () {
        const operation = "orchestration/dispatchCommand" as const;
        if (!isOrchestrationCommand(command)) return yield* new T3InvalidInput({operation});
        yield* selectTranslation(operation, yield* Ref.get(observed));
        const payload = nativeCommand(command);
        return {operation, initiate: (cancel?: Deferred.Deferred<void>) =>
          Effect.map(rpc.initiate("orchestration.dispatchCommand", payload, cancel), (flight) => flightOf(operation, flight, isCommandReceipt))};
      }),
    };
    return {launchThread, dispatchCommand};
  };

  return {
    environment, thread, shellBaseline, shellThreads, config, turnItem, watchShell, watchThread,
    commands: operate === null ? null : commands(operate),
  };
};
