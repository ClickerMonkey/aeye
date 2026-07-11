/**
 * SourceRow / SourceRecord — the row shapes threaded through the in-memory
 * runtime.
 *
 *  - `SourceRecord` is one entity instance: a flat map of field name → JSON
 *    value (e.g. a single `user` row `{ id: 1, name: 'Ada' }`).
 *  - `SourceRow` binds SOURCE NAMES (type aliases / CTE names / join
 *    aliases) to their current `SourceRecord`. Multi-source joins and aliases
 *    work because a single evaluation row can carry one record PER source —
 *    `{ u: {...}, orders: {...} }`. This mirrors cletus's per-alias record
 *    map (`SelectRecord`).
 */
import type { JsonValue } from '../schema';

/** One entity instance: field name → JSON value. */
export type SourceRecord = { [field: string]: JsonValue };

/** Source name → its current record, for one evaluation row. */
export type SourceRow = { [source: string]: SourceRecord };

/** Build a one-source row binding `source` to `record`. */
export function singleRow(source: string, record: SourceRecord): SourceRow {
  return { [source]: record };
}

/** Shallow-merge two rows into a combined row (right wins on key clash). */
export function mergeRows(left: SourceRow, right: SourceRow): SourceRow {
  return { ...left, ...right };
}

/** Deep-ish clone of a record (JSON round-trip; records are pure JSON). */
export function cloneRecord(record: SourceRecord): SourceRecord {
  const out: SourceRecord = {};
  for (const key of Object.keys(record)) {
    const v: JsonValue = record[key]!;
    out[key] = v;
  }
  return out;
}
