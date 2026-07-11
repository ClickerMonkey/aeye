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

/** A stable, key-sorted JSON key for a record (distinct / set-op dedupe). */
export function recordSignature(record: SourceRecord): string {
  const keys = Object.keys(record).sort();
  return JSON.stringify(keys.map((k) => [k, record[k]!]));
}
