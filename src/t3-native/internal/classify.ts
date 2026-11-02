import { Cause, Data, Deferred, Effect } from "effect";
import type { SupervisorRpcError } from "../../supervisor-native.js";
import type { T3TransportError } from "../../t3.js";
import type { T3Operation } from "../contracts.js";
import { T3ReadError, T3RequestError } from "../errors.js";

// the classification T3Native carries over from the clients it wraps, unchanged

/** A native request's failure, with exactly the request client's classification */
export const requestError = (operation: T3Operation, error: SupervisorRpcError): T3RequestError => new T3RequestError({
  operation,
  outcome: error.outcome,
  definiteRejection: error.definiteRejection,
  providerDisabled: error.providerDisabled,
  dispatchCommandFailure: error.dispatchCommandFailure,
  malformedReply: false,
});

/** A reply that arrived but is not the operation's receipt: T3 may have acted on the request, so it is uncertain */
export const malformedReply = (operation: T3Operation): T3RequestError => new T3RequestError({
  operation, outcome: "uncertain", definiteRejection: false, providerDisabled: false, dispatchCommandFailure: false, malformedReply: true,
});

/** An HTTP read's or a subscription's failure, with the T3 client's fixed message, HTTP status and code */
export const readError = (operation: T3Operation, error: T3TransportError): T3ReadError => new T3ReadError({
  operation,
  message: error.message,
  ...(error.httpStatus === undefined ? {} : {httpStatus: error.httpStatus}),
  ...(error.code === undefined ? {} : {code: error.code}),
});

/** A consumer's own failure, carried through a client's failure channel and handed back unchanged */
export class ConsumerFailed<E> {
  readonly _tag = "ConsumerFailed";
  constructor(readonly error: E) {}
}

// a caller's cancel completed during an awaited exchange: it ends like the aborted read it replaces
export class Cancelled extends Data.TaggedError("Cancelled") {}

/** The caller's cancel trigger: a completed cancel ends the awaited effect as a failure */
export const untilCancelled = <A, E, R>(effect: Effect.Effect<A, E, R>, cancel: Deferred.Deferred<void> | undefined): Effect.Effect<A, E | Cancelled, R> =>
  cancel === undefined ? effect : Effect.raceFirst(effect, Effect.andThen(Deferred.await(cancel), Effect.fail(new Cancelled())));

/** Any failure or defect gives the fallback; an interruption stays an interruption */
export const otherwise = <B>(fallback: B) => <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A | B, never, R> =>
  Effect.catchCauseIf(effect, (cause) => !Cause.hasInterruptsOnly(cause), () => Effect.succeed(fallback)) as Effect.Effect<A | B, never, R>;
