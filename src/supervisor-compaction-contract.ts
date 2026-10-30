import { Schema } from "effect";
import { fingerprint } from "./guidance-store.js";

const NonBlank = Schema.String.check(Schema.makeFilter(value => value.trim().length > 0));
const Ordinal = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** The latest successful native compaction of this owned root, ordered by native run and item ordinals. */
export const RootCompaction = Schema.Struct({
  itemId: NonBlank,
  runId: NonBlank,
  runOrdinal: Ordinal,
  itemOrdinal: Ordinal,
});
export type RootCompaction = typeof RootCompaction.Type;

/** One immutable attempt to deliver a short reminder to a running root; uncertain delivery keeps its identity. */
export const CompactionReminder = Schema.Struct({
  itemId: NonBlank,
  runId: NonBlank,
  messageId: NonBlank,
  commandId: NonBlank,
  text: NonBlank,
  state: Schema.Literals(["sending", "accepted", "rejected", "uncertain", "visible"]),
});
export type CompactionReminder = typeof CompactionReminder.Type;

type CompactedBinding = {readonly roleCompaction?: RootCompaction};
const compactionSuffix = (binding: CompactedBinding): string | null => binding.roleCompaction
  ? `:compaction:${fingerprint(binding.roleCompaction).slice(0, 16)}` : null;

/** The content version stays stable; a completed compaction gives its delivery a new confirmation identity. */
export const roleDeliveryVersion = (version: string, binding: CompactedBinding): string => version + (compactionSuffix(binding) ?? "");

export const roleDeliveryMatchesCompaction = (version: string, binding: CompactedBinding): boolean => {
  const suffix = compactionSuffix(binding);
  return suffix === null ? !version.includes(":compaction:") : version.endsWith(suffix);
};

export const laterRootCompaction = (next: RootCompaction, previous: RootCompaction | undefined): boolean => !previous ||
  next.runOrdinal > previous.runOrdinal || next.runOrdinal === previous.runOrdinal && next.itemOrdinal > previous.itemOrdinal;
