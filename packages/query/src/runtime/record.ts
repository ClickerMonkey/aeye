/**
 * Small helpers for reading `SourceRecord`s at runtime (first field, key
 * stringification for set-ops / distinct). Kept separate so both exprs and
 * query classes can share them without a cycle.
 */
import type { JsonValue } from '../schema';
import type { SourceRecord } from './row';

/** The first field's value of a record (scalar-subquery semantics), or null. */
export function firstField(record: SourceRecord): JsonValue {
  const keys = Object.keys(record);
  if (keys.length === 0) return null;
  return record[keys[0]!]!;
}

/**
 * A stable, key-sorted JSON key for a record (distinct / set-op dedupe).
 *
 * IDENTITY HERE IS RAW, AND A DECLARED `compareValues` DOES NOT REACH IT. That
 * is a stated boundary rather than an oversight, and the signature is the reason
 * it is one: this takes a `SourceRecord` — raw cells, with no `Field` and no
 * `FieldType` anywhere in scope — because a whole ROW's identity is not a
 * question any one column's type can answer. Every road that compares two VALUES
 * (`= <>`, ordering, `BETWEEN`, `IN`, join and relation equality, `min` / `max`)
 * goes through `Value.compareTo` and does honour the comparator.
 *
 * The consequence, for a comparator whose equality is COARSER than raw identity
 * (a `Net` that treats a /24 as one value, a version that ignores build
 * metadata): `WHERE a = b` calls two rows the same while `SELECT DISTINCT`,
 * `GROUP BY`, an aggregate's `DISTINCT` and the set operations keep them apart —
 * and a database whose column type agrees with the comparator collapses them, so
 * the two roads disagree. A comparator that only REORDERS (an `inet`, a semver
 * with no metadata) has identical equality and is unaffected, which is the
 * common case.
 *
 * It is not hidden and it is not un-measurable: `checkFieldType` warns
 * statically when a declaration's comparator merges two values it admits
 * (`conformance.comparator-coarser-than-identity`), and `differentialCheck`
 * ships `distinct` and `group by` probes that settle it against a real column
 * type. Closing it means grouping by SORT-MERGE rather than by hash — a
 * comparator is an ORDER, not a canonical form, so there is no key to build from
 * one — which changes the complexity of every DISTINCT and GROUP BY in the
 * package, including the ones with no refined column in sight. That is a
 * deliberate decision, not a to-do.
 */
export function recordSignature(record: SourceRecord): string {
  const keys = Object.keys(record).sort();
  return JSON.stringify(keys.map((k) => [k, record[k]!]));
}
