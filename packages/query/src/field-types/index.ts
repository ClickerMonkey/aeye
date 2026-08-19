/**
 * Field-type barrel: re-exports every concrete FieldType class plus the
 * `BUILTIN_FIELD_TYPES` array the Registry bootstraps from.
 */
import { z } from 'zod';
import type { FieldTypeClass } from '../field-type';
import type { SchemaOptions } from '../node';
import { NumberFieldType } from './number';
import { TextFieldType } from './text';
import { MoneyFieldType } from './money';
import { BoolFieldType } from './bool';
import { RelationFieldType } from './relation';
import { DateFieldType } from './date';
import { TimestampFieldType } from './timestamp';
import { JsonFieldType } from './json';
import { ArrayFieldType } from './array';

export { NumberFieldType } from './number';
export { TextFieldType, type TextOptions } from './text';
export { MoneyFieldType, type MoneyOptions } from './money';
export { BoolFieldType } from './bool';
export {
  RelationFieldType,
  type RelationKey,
} from './relation';
export { DateFieldType } from './date';
export { TimestampFieldType, timezoneSchema } from './timestamp';
export { JsonFieldType, jsonValueSchema } from './json';
export { ArrayFieldType } from './array';

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
 * each field type's `toSchema(opts)`. Built with `.or` folding to avoid the
 * tuple cast `z.union([...])` would require.
 *
 * REGISTRY-DRIVEN when `opts.registry` is supplied: the branches come from the
 * registry's own `fieldTypeClassList()` rather than from the static
 * `BUILTIN_FIELD_TYPES` array, and each branch renders its `as` key as an ENUM
 * of the refinements registered over that base. Without a registry it falls back
 * to the builtins with no `as` offered at all — which is the honest answer,
 * since a schema built from nothing knows of no refinement to name.
 *
 * That distinction is the point rather than a nicety: this schema is what a
 * model authors a Type against, so an `as` left open as a free string is an
 * invitation to invent `{kind:'text', as:'uuid4'}` and find out at parse.
 */
export function fieldTypeDefSchema(opts?: SchemaOptions): z.ZodTypeAny {
  const classes = opts?.registry?.fieldTypeClassList() ?? BUILTIN_FIELD_TYPES;
  const branches = classes.map((c) => c.toSchema(opts));
  const first = branches[0];
  /* v8 ignore next -- defensive: a registry always carries the builtins, so `first` is always defined */
  if (!first) return z.never();
  return branches.slice(1).reduce<z.ZodTypeAny>((acc, s) => acc.or(s), first)
    .describe(`Field type definition (one of the ${branches.length} registered kinds).`);
}
