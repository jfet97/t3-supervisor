import {mkdirSync, writeFileSync} from "node:fs";
import {join} from "node:path";

// the exchange audit: one measurement per rendered path of the Supervisor's traffic, pure over the texts and the serialized tool
// arguments and results a path carries. Bytes are UTF-8; a unit (a sentence or a line of at least 24 characters) counts as duplicate
// when it appears verbatim in the previous wake of the same path, and as a rule when it appears verbatim in the standing reference,
// which is read on demand; retrievable names the fields of the wake that one named read returns

export type ExchangeSample = {
  /** The path's audit id (N1..N15, R1..R15, L for liveness, Q for the own inbox). */
  readonly path: string;
  readonly label: string;
  /** The rendered text, or the serialized tool result of an answer path. */
  readonly text: string;
  /** The previous wake of the same path, when one exists. */
  readonly previous?: string;
  /** The standing reference texts the wake must not repeat. */
  readonly rules?: readonly string[];
  /** The fields of the wake that one named read returns, with that read. */
  readonly retrievable?: readonly string[];
  readonly read?: string;
  /** The serialized tool arguments the path's read or write takes, when it has one. */
  readonly args?: unknown;
};

export type ExchangeRow = {
  path: string;
  label: string;
  bytes: number;
  /** Bytes repeated from the previous wake of the same path; null when only one sample exists, so repetition is unmeasured. */
  duplicateBytes: number | null;
  ruleBytes: number;
  retrievable: number;
  read: string;
  argsBytes: number | null;
};

const bytes = (text: string): number => Buffer.byteLength(text, "utf8");
const units = (text: string): string[] => text.split(/\n|(?<=[.;:])\s+(?=[A-Z])/u).map(unit => unit.trim()).filter(unit => unit.length >= 24);

/** The units of a text that repeat the standing reference verbatim. */
export const repeatedUnits = (text: string, rules: readonly string[]): string[] => {
  const corpus = rules.join("\n");
  return units(text).filter(unit => corpus.includes(unit));
};

/** The measurement of one path. */
export const measureExchange = (sample: ExchangeSample): ExchangeRow => {
  const own = units(sample.text);
  const previous = sample.previous ?? "";
  const rules = (sample.rules ?? []).join("\n");
  const duplicateBytes = sample.previous === undefined ? null : own.filter(unit => previous.includes(unit)).reduce((sum, unit) => sum + bytes(unit), 0);
  const ruleBytes = own.filter(unit => rules.includes(unit)).reduce((sum, unit) => sum + bytes(unit), 0);
  return {path: sample.path, label: sample.label, bytes: bytes(sample.text), duplicateBytes, ruleBytes, retrievable: sample.retrievable?.length ?? 0,
    read: sample.read ?? "", argsBytes: sample.args === undefined ? null : bytes(JSON.stringify(sample.args))};
};

/** The rows as one markdown table, in path order of first appearance. */
export const exchangeTable = (rows: readonly ExchangeRow[]): string => [
  "| Path | Exchange | Bytes | Duplicate bytes (vs previous wake) | Rule bytes (vs reference) | Retrievable fields | Read | Args bytes |",
  "|---|---|---:|---:|---:|---:|---|---:|",
  ...rows.map(row => `| ${row.path} | ${row.label} | ${row.bytes} | ${row.duplicateBytes ?? "unmeasured (single sample)"} | ${row.ruleBytes} | ${row.retrievable} | ${row.read} | ${row.argsBytes ?? ""} |`),
].join("\n");

/**
 * The actual rendered texts, serialized arguments and results behind a table, written as JSON when EXCHANGE_AUDIT_DIR names a directory,
 * so a table is reproducible from its samples; a test run without it writes nothing.
 */
export const recordExchangeSamples = (name: string, samples: readonly ExchangeSample[]): void => {
  const directory = process.env.EXCHANGE_AUDIT_DIR;
  if (!directory) return;
  mkdirSync(directory, {recursive: true});
  writeFileSync(join(directory, `${name}.json`), `${JSON.stringify(samples.map(sample => ({path: sample.path, label: sample.label, bytes: bytes(sample.text), text: sample.text,
    ...(sample.args === undefined ? {} : {args: sample.args}), ...(sample.previous === undefined ? {} : {previousBytes: bytes(sample.previous)})})), null, 2)}\n`);
  writeFileSync(join(directory, `${name}.md`), `${exchangeTable(samples.map(measureExchange))}\n`);
};
