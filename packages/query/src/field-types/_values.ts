/**
 * Shared helpers for a field type's CLOSED VALUE SET (`values`) — the enum the
 * `text` and `number` scalars express as a constraint ON themselves rather than
 * as a separate field-type `kind`.
 *
 * Membership is a QUERY fact, not a display one: it decides equality
 * selectivity, it is the highest-value line the model can be told about a
 * `where` clause, and it is the honest answer for `toValueSchema()`. The
 * human-facing `label` rides along with each member so one closed set has one
 * home (see `FieldValueDef`).
 */
import { z } from 'zod';
import type { FieldValueDef } from '../schema';

/** The Zod schema for the shared `values` slot on `text` / `number` defs. */
export function fieldValuesSchema(): z.ZodTypeAny {
  return z
    .array(
      z.object({
        value: z.union([z.string(), z.number()]).describe('The stored value — one member of the closed set.'),
        label: z.string().optional().describe('Human-facing name for this member (defaults to the value).'),
      }),
    )
    .optional()
    .describe('Closed set of values this field may hold. Declare only a genuinely fixed set.');
}

/** Strip `undefined` entries from a value set, dropping an EMPTY set entirely. */
export function compactFieldValues(values: readonly FieldValueDef[] | undefined): FieldValueDef[] | undefined {
  // An empty array is not a closed set of nothing — it is an absent
  // declaration, and treating it as a set would make `1/n` divide by zero and
  // `toValueSchema` reject every value.
  if (!values || values.length === 0) return undefined;
  return values.map((v) => (v.label === undefined ? { value: v.value } : { value: v.value, label: v.label }));
}

/**
 * A value schema accepting exactly the declared members, or `undefined` when no
 * closed set is declared. A single member is a bare literal (zod's union wants
 * two or more); the general case is a union of literals, which handles a
 * mixed-scalar set that `z.enum` could not.
 */
export function closedSetValueSchema(values: readonly FieldValueDef[] | undefined): z.ZodTypeAny | undefined {
  if (!values || values.length === 0) return undefined;
  const first = values[0]!;
  if (values.length === 1) return z.literal(first.value);
  return z.union(values.map((v) => z.literal(v.value)));
}

/**
 * The equality selectivity a closed set of `n` members implies — `1/n`, the
 * uniform-distribution estimate — or `undefined` when no set is declared (the
 * caller then falls back to the package-wide fixed guess).
 */
export function eqSelectivityOf(values: readonly FieldValueDef[] | undefined): number | undefined {
  if (!values || values.length === 0) return undefined;
  return 1 / values.length;
}

/**
 * How many members of a closed set are rendered into the model-facing type
 * description before it is elided. A closed set is usually small; a long one is
 * still worth ANNOUNCING (so the model knows the column is constrained) but not
 * worth spending the whole prompt budget enumerating.
 */
const MAX_DESCRIBED_VALUES = 12;

/**
 * The `one of a|b|c` clause for a closed value set, or `''` when none is
 * declared. A member renders as its VALUE — that is what a `where` clause has
 * to contain — with its label appended only when it says something the value
 * does not, since the label is how a user's phrasing maps onto the member.
 */
export function describeValues(values: readonly FieldValueDef[] | undefined): string {
  if (!values || values.length === 0) return '';
  const shown = values.slice(0, MAX_DESCRIBED_VALUES).map((v) =>
    v.label !== undefined && v.label !== String(v.value) ? `${v.value} (${v.label})` : `${v.value}`,
  );
  const more = values.length - shown.length;
  return ` one of ${shown.join('|')}${more > 0 ? `|…+${more} more` : ''}`;
}
