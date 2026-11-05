import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { Schema } from "effect";

/*
 * Rows a test reads from a database file with its own node:sqlite connection, decoded with an explicit row contract, as the
 * stores decode theirs: a column that is missing or has another type fails the test instead of being cast into shape.
 */

type RowContract = Schema.Top & { readonly DecodingServices: never };

/** Every row of `sql`, each decoded with `row`. */
export const sqliteRows = <S extends RowContract>(db: DatabaseSync, row: S, sql: string, ...params: Array<SQLInputValue>): ReadonlyArray<S["Type"]> => {
  const decode = Schema.decodeUnknownSync(row);
  return db.prepare(sql).all(...params).map((value) => decode(value));
};

/** The single row of `sql`, decoded with `row`; no row fails. */
export const sqliteRow = <S extends RowContract>(db: DatabaseSync, row: S, sql: string, ...params: Array<SQLInputValue>): S["Type"] =>
  Schema.decodeUnknownSync(row)(db.prepare(sql).get(...params));

const parseJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

/** A JSON text, parsed and then decoded with `value`. */
export const decodeJson = <S extends RowContract>(value: S, text: string): S["Type"] => Schema.decodeUnknownSync(value)(parseJson(text));
