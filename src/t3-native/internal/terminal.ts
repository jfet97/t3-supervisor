import { type Crypto, Deferred, Effect, Schema } from "effect";
import {
  NativeFraming, nativeMaxPayload, NativeStep, type NativeEndpoint, type NativeEnvelope, type NativeExit, type NativeFailure,
} from "../../native-envelope.js";
import {
  NativeRecord, TerminalAttachRequest, TerminalCloseRequest, TerminalOpenRequest, TerminalWriteRequest, type T3Operation, type TerminalAttachEvent,
  type TerminalSnapshot,
} from "../contracts.js";
import { T3InvalidInput, T3TerminalError, type TerminalFailure } from "../errors.js";
import type { T3TerminalFamily, TerminalAttachHandlers } from "../service.js";
import { ConsumerFailed } from "./classify.js";

// the terminal family over the shared native envelope with the probe credential, with the Git probe's bounds: 2 MiB frames, a 5 s
// handshake, the whole message checked as at most 256 envelopes before any is handled, a 5 s deadline per request and 15 s for an
// attach stream. Each request has its own socket and a fresh id. A Malformed exit is not an answer: the request keeps waiting

const RPC_TIMEOUT = "5 seconds";
const ATTACH_TIMEOUT = "15 seconds";

const isNativeRecord: (value: unknown) => value is NativeRecord = Schema.is(NativeRecord);
const isOpenRequest = Schema.is(TerminalOpenRequest);
const isWriteRequest = Schema.is(TerminalWriteRequest);
const isAttachRequest = Schema.is(TerminalAttachRequest);
const isCloseRequest = Schema.is(TerminalCloseRequest);

// the envelope's reason, as the probe distinguishes it
const terminalFailure = (reason: NativeFailure): TerminalFailure => {
  switch (reason) {
    case "binary_frame":
    case "malformed_json":
    case "invalid_frame":
    case "socket_closed":
      return reason;
    default:
      return "unavailable";
  }
};

const attachEvent = (value: unknown): TerminalAttachEvent => isNativeRecord(value) ? {_tag: "Event", event: value} : {_tag: "Malformed"};

export const makeTerminal = (native: NativeEnvelope["Service"], endpoint: NativeEndpoint, crypto: Crypto.Crypto): T3TerminalFamily => {
  // v4 generation never fails; its signature only shares the platform error of randomBytes
  const uuid = Effect.orDie(crypto.randomUUIDv4());

  // one unary request; a cancel that already completed connects nothing
  const rpc = (operation: T3Operation, tag: string, payload: Readonly<Record<string, unknown>>, cancel: Deferred.Deferred<void> | undefined):
    Effect.Effect<unknown, T3TerminalError> => Effect.gen(function* () {
    if (cancel !== undefined && (yield* Deferred.isDone(cancel))) return yield* new T3TerminalError({operation, reason: "cancelled"});
    const requestId = "git-probe-" + (yield* uuid);
    return yield* native.call({endpoint, request: {id: requestId, tag, payload}, maxPayload: nativeMaxPayload.probe, handshakeTimeout: RPC_TIMEOUT,
      timeout: RPC_TIMEOUT, framing: NativeFraming.flatChecked(4, 256), cancel,
      onExit: (exit: NativeExit) => exit._tag === "Malformed" ? Effect.succeed(NativeStep.continue)
        : exit._tag === "Success" ? Effect.succeed(NativeStep.done(exit.value)) : Effect.fail(new T3TerminalError({operation, reason: "rejected"})),
    }).pipe(Effect.catchTag("NativeEnvelopeError", (error) => Effect.fail(new T3TerminalError({operation, reason: terminalFailure(error.reason)}))));
  });

  const open: T3TerminalFamily["open"] = (request, cancel) => {
    const operation = "terminal/open" as const;
    if (!isOpenRequest(request)) return Effect.fail(new T3InvalidInput({operation}));
    return Effect.flatMap(rpc(operation, "terminal.open", {threadId: request.threadId, terminalId: request.terminalId, cwd: request.cwd,
      worktreePath: null, cols: request.cols, rows: request.rows, env: request.env}, cancel),
    (snapshot): Effect.Effect<TerminalSnapshot, T3TerminalError> => isNativeRecord(snapshot) ? Effect.succeed(snapshot)
      : Effect.fail(new T3TerminalError({operation, reason: "malformed_reply"})));
  };

  const write: T3TerminalFamily["write"] = (request, cancel) => isWriteRequest(request)
    ? Effect.asVoid(rpc("terminal/write", "terminal.write", {threadId: request.threadId, terminalId: request.terminalId, data: request.data}, cancel))
    : Effect.fail(new T3InvalidInput({operation: "terminal/write"}));

  const close: T3TerminalFamily["close"] = (request, cancel) => isCloseRequest(request)
    ? Effect.asVoid(rpc("terminal/close", "terminal.close", {threadId: request.threadId, terminalId: request.terminalId, deleteHistory: request.deleteHistory},
      cancel))
    : Effect.fail(new T3InvalidInput({operation: "terminal/close"}));

  // the attach stream: each chunk's events go to the consumer in order, one value at a time; its exit never ends the stream, which
  // ends only when the consumer stops it or with its socket. A consumer's failure is handed back unchanged; a defect stays a defect
  const attach = <E>(request: TerminalAttachRequest, handlers: TerminalAttachHandlers<E>, cancel?: Deferred.Deferred<void>):
    Effect.Effect<void, T3TerminalError | T3InvalidInput | E> => Effect.gen(function* () {
    const operation = "terminal/attach" as const;
    if (!isAttachRequest(request)) return yield* new T3InvalidInput({operation});
    const requestId = "git-probe-stream-" + (yield* uuid);
    return yield* native.call<void, ConsumerFailed<E>>({endpoint, request: {id: requestId, tag: "terminal.attach", payload: {
      threadId: request.threadId, terminalId: request.terminalId, cwd: request.cwd, worktreePath: null, restartIfNotRunning: false,
    }}, maxPayload: nativeMaxPayload.probe, handshakeTimeout: RPC_TIMEOUT, timeout: ATTACH_TIMEOUT, framing: NativeFraming.flatChecked(4, 256), cancel,
    onChunk: (values: ReadonlyArray<unknown>) => handlers.onChunk(values.map(attachEvent)).pipe(
      Effect.mapError((error) => new ConsumerFailed(error)),
      Effect.map((step): NativeStep<void, ConsumerFailed<E>> => step._tag === "Continue" ? NativeStep.continue
        : step._tag === "Stop" ? NativeStep.done(undefined) : NativeStep.ack(step.afterAck))),
    onExit: (exit: NativeExit) => handlers.onExit(exit._tag === "Success" ? "Success" : "Failure").pipe(
      Effect.mapError((error) => new ConsumerFailed(error)),
      Effect.as(NativeStep.continue)),
    }).pipe(Effect.mapError((error) => error instanceof ConsumerFailed ? error.error : new T3TerminalError({operation, reason: terminalFailure(error.reason)})));
  });

  return {open, write, attach, close};
};
