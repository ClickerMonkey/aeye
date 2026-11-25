import { z } from 'zod';
import { a, type AnySchema } from '@aeye/schema';
import type { ValueSchemaOptions } from './node';
import type { SchemaOptions } from './node';
import type { Type } from './type';

/** Type classes whose value is a plain JSON scalar: a `new` value slot of one takes that scalar as is. */
const PLAIN = new Set(['text', 'num', 'bool', 'enum', 'literal', 'date', 'timestamp', 'duration', 'color', 'null']);

/** The type under optional / nullable wrappers and named extensions. */
function core(type: Type): Type {
  let current: Type = type;
  for (let depth = 0; depth < 16; depth += 1) {
    const next = (current as { inner?: Type }).inner ?? (current as { base?: Type }).base;
    if (next === undefined || next === current) return current;
    current = next;
  }
  return current;
}

/** Whether a slot of this type holds a plain scalar (text, a number, an enum member, a date …). */
export function isPlainSlot(type: Type): boolean {
  return PLAIN.has(core(type).name);
}

/**
 * The schema of one field of a `new` value. A composite field is any Expr (its type is checked when the program is
 * checked). A plain field takes its value as is (`method: "GET"`, `url: "/repos"`) or an Expr that computes it, so a
 * strict tool call can write a constant directly instead of wrapping it in a `new`. The field's optionality is the
 * caller's; this is the schema of a present value.
 */
export function newSlotA(type: Type, opts?: ValueSchemaOptions): AnySchema {
  const present = type.isOptional() ? ((type as { inner?: Type }).inner ?? type) : type;
  if (!isPlainSlot(present)) return a.ref('Expr');
  return a.union([present.toA(opts), a.ref('Expr')]);
}

/** `newSlotA`'s zod twin (the deprecated zod grammar). */
export function newSlotSchema(type: Type, opts: SchemaOptions): z.ZodTypeAny {
  const present = type.isOptional() ? ((type as { inner?: Type }).inner ?? type) : type;
  if (!isPlainSlot(present)) return opts.Expr;
  return z.union([present.toValueSchema(opts), opts.Expr]);
}
