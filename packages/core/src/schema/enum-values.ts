import z from 'zod';
import type { FormatDescriptor } from './descriptor';

/**
 * The values a `z.enum` actually EMITS as JSON-Schema `enum` members.
 *
 * A numeric TypeScript enum compiles to a two-way map (`{A: 0, 0: 'A'}`), so
 * the reverse-mapping keys have to be dropped or every value appears twice.
 * Shared with `analyzeSchema` deliberately: the size budget counts what goes on
 * the wire, and "what goes on the wire" must have ONE definition (a second
 * copy of this filter would drift from the emitter it is supposed to measure).
 */
export function enumEmittedValues(schema: z.ZodEnum): unknown[] {
  const numericValues = Object.values(schema.def.entries).filter((v) => typeof v === 'number');
  return Object.entries(schema.def.entries)
    .filter(([k]) => numericValues.indexOf(+k) === -1)
    .map(([, v]) => v);
}

/**
 * The values a `z.literal` emits — one for the `const` form, several for the
 * multi-value form that emits `enum`. Types JSON Schema cannot carry
 * (functions, symbols, bigints, `undefined`) are dropped, matching the
 * emitter. Shared with `analyzeSchema` for the same reason as above.
 */
export function literalEmittedValues(schema: z.ZodLiteral): unknown[] {
  return Array.from(schema.values).filter(
    (v) => v !== undefined && typeof v !== 'function' && typeof v !== 'symbol' && typeof v !== 'bigint',
  );
}

/**
 * Decide whether a set of values may be emitted as a JSON-Schema `enum` under
 * this descriptor, per `maxEnumValues`.
 *
 * Under the cap (or with no cap declared) the caller emits its `enum` as
 * normal. Over it, the caller emits NO `enum` — just the widened `type` — and
 * attaches `note`, which lists EVERY value in prose.
 *
 * Widening rather than truncating is the deliberate choice, and the two differ
 * in what the model can still say. A truncated `enum` makes the values past the
 * cap **unreachable**: the wire schema constrains them away, so a caller whose
 * 96 values are all legitimately selectable loses 56 of them. Widening removes
 * the wire-level constraint that the dialect can't compile in the first place
 * and moves the full list into the `description`, so the model retains complete
 * information and can name any of the 96. Nothing is hidden — it is described
 * instead of enforced, and enforcement moves to whatever validates the value
 * afterwards (`Tool.parse` against the ORIGINAL zod schema still rejects a name
 * that was never in the enum, with a message the model can act on).
 *
 * The note is deliberately DOMAIN-NEUTRAL. This library has no idea what the
 * values mean; whichever caller relies on the cap (a session's known-name enum,
 * a country list, anything) reads its own semantics into them.
 */
export function describeOversizeEnum(values: readonly unknown[], descriptor: FormatDescriptor): string | undefined {
  const cap = descriptor.maxEnumValues;
  if (cap === undefined || values.length <= cap) return undefined;
  // A flat comma-separated list: it is how an enum reads in prose anyway, and
  // the values are single tokens by construction (they were `enum` members).
  return `One of these ${values.length} values: ${values.map((v) => String(v)).join(', ')}`;
}
