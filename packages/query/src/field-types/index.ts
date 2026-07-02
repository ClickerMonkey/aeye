/**
 * Field-type barrel: re-exports every concrete FieldType class plus the
 * `BUILTIN_FIELD_TYPES` array the Registry bootstraps from.
 */
import { z } from 'zod';
import type { FieldTypeClass } from '../field-type';
import { NumberFieldType } from './number';
import { TextFieldType } from './text';
import { MoneyFieldType } from './money';
import { BoolFieldType } from './bool';
import { RelationFieldType } from './relation';
import { DateFieldType } from './date';
import { TimestampFieldType } from './timestamp';
import { JsonFieldType } from './json';
import { ArrayFieldType } from './array';

export { NumberFieldType, NUMERIC_FILTER_OPS } from './number';
export { TextFieldType, TEXT_FILTER_OPS, type TextOptions } from './text';
export { MoneyFieldType, type MoneyOptions } from './money';
export { BoolFieldType, BOOL_FILTER_OPS } from './bool';
export {
  RelationFieldType,
  RELATION_FILTER_OPS,
  type RelationKey,
} from './relation';
export { DateFieldType } from './date';
export { TimestampFieldType, TEMPORAL_FILTER_OPS, timezoneSchema } from './timestamp';
export { JsonFieldType, JSON_FILTER_OPS, jsonValueSchema } from './json';
export { ArrayFieldType, ARRAY_FILTER_OPS } from './array';

/** All built-in FieldType classes, in a stable order for tests / docs. */
export const BUILTIN_FIELD_TYPES: readonly FieldTypeClass[] = [
  NumberFieldType,
  TextFieldType,
  MoneyFieldType,
  BoolFieldType,
  RelationFieldType,
  DateFieldType,
  TimestampFieldType,
  JsonFieldType,
  ArrayFieldType,
];

/**
 * Zod schema for the full `FieldTypeDef` discriminated union — the union of
 * each built-in field type's `toSchema()`. Built with `.or` folding to
 * avoid the tuple cast `z.union([...])` would require.
 */
export function fieldTypeDefSchema(): z.ZodTypeAny {
  const branches = BUILTIN_FIELD_TYPES.map((c) => c.toSchema());
  const first = branches[0];
  /* v8 ignore next -- defensive: BUILTIN_FIELD_TYPES is never empty, so `first` is always defined */
  if (!first) return z.never();
  return branches.slice(1).reduce<z.ZodTypeAny>((acc, s) => acc.or(s), first)
    .describe('Field type definition (one of the 8 built-in kinds).');
}
