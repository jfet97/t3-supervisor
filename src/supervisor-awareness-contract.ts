import { Schema } from "effect";

export const NativeActivityRead = Schema.Struct({
  actorThreadId: Schema.String, targetThreadId: Schema.String, callItemId: Schema.String, runId: Schema.String,
  at: Schema.Number, itemId: Schema.NullOr(Schema.String), position: Schema.NullOr(Schema.Number),
  partial: Schema.Boolean, snapshotEndReached: Schema.Boolean,
});
export type NativeActivityRead = typeof NativeActivityRead.Type;
