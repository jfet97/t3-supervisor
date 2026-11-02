import { Schema } from "effect";
import { FileFailure, FileScope, T3Operation } from "./contracts.js";

// The failures of T3Native operations. Each keeps today's classification exactly and carries a fixed message: never a token, a url,
// a native body or a raw cause.

/** rejected: the request never left, or T3 refused it definitively; uncertain: T3 may have acted on it */
export const RequestOutcome = Schema.Literals(["rejected", "uncertain"]);
export type RequestOutcome = typeof RequestOutcome.Type;

/**
 * A native request failed or its reply was unusable. Only a request T3 refused with a named rejection (an earlier rejection of the
 * command, or a disabled provider instance) is a definite rejection; a reply that arrived but does not satisfy the operation's
 * receipt (`malformedReply`) and any failure once the request may have left are uncertain, never retried and never re-routed.
 */
export class T3RequestError extends Schema.TaggedError<T3RequestError>()("T3RequestError", {
  operation: T3Operation,
  outcome: RequestOutcome,
  definiteRejection: Schema.Boolean,
  providerDisabled: Schema.Boolean,
  dispatchCommandFailure: Schema.Boolean,
  malformedReply: Schema.Boolean,
}) {
  override readonly message: string = "T3 Supervisor access is unavailable.";
}

export const ReadFailureCode = Schema.Literal("response_too_large");
export type ReadFailureCode = typeof ReadFailureCode.Type;

/**
 * An HTTP read or a subscription failed: the HTTP status T3 answered, and `response_too_large` for a body over its byte budget. The
 * message is the read's fixed description of what failed.
 */
export class T3ReadError extends Schema.TaggedError<T3ReadError>()("T3ReadError", {
  operation: T3Operation,
  message: Schema.String,
  httpStatus: Schema.optionalKey(Schema.Int),
  code: Schema.optionalKey(ReadFailureCode),
}) {}

/** An input failed its operation's contract before anything was connected, sent or requested */
export class T3InvalidInput extends Schema.TaggedError<T3InvalidInput>()("T3InvalidInput", {
  operation: T3Operation,
}) {
  override readonly message: string = "The T3 request is invalid.";
}

/** The reference profile of the reported build records this operation as absent; never returned for any other build */
export class T3Unsupported extends Schema.TaggedError<T3Unsupported>()("T3Unsupported", {
  operation: T3Operation,
  serverVersion: Schema.String,
}) {
  override readonly message: string = "The reported T3 build does not offer this operation.";
}

const fileErrorMessage = (code: FileFailure, scope: FileScope): string => code === "permission_required"
  ? `Enable filesystem:${scope} on the Supervisor ${scope} credential through deployment setup.`
  : code === "missing" ? "The requested project path does not exist."
    : code === "invalid_file" ? "Definitions must be readable UTF-8 text files, not binary files or directories."
      : "T3 project file access is unavailable.";

/** A native file operation failed, classified per credential scope as the project file clients classify it */
export class T3FileError extends Schema.TaggedError<T3FileError>()("T3FileError", {
  operation: T3Operation,
  code: FileFailure,
  scope: FileScope,
}) {
  override readonly message: string = fileErrorMessage(this.code, this.scope);
}

/**
 * Why a terminal request failed: cancelled before connecting, refused by T3, a frame that was binary, not JSON or not a protocol
 * envelope, its socket closed, a reply that is not the operation's receipt, or any other end (a cancel, a deadline or a lost connection)
 */
export const TerminalFailure = Schema.Literals([
  "cancelled", "rejected", "binary_frame", "malformed_json", "invalid_frame", "socket_closed", "malformed_reply", "unavailable",
]);
export type TerminalFailure = typeof TerminalFailure.Type;

export class T3TerminalError extends Schema.TaggedError<T3TerminalError>()("T3TerminalError", {
  operation: T3Operation,
  reason: TerminalFailure,
}) {
  override readonly message: string = "A native T3 terminal request failed.";
}

/** A webhook POST that was started may have been delivered: its outcome is unknown, and it is never posted again */
export class T3WebhookError extends Schema.TaggedError<T3WebhookError>()("T3WebhookError", {
  operation: T3Operation,
}) {
  override readonly message: string = "The T3 webhook delivery could not be confirmed.";
}
