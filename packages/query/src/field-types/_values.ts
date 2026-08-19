/**
 * Shared helpers for a field type's CLOSED VALUE SET (`values`) — the enum the
 * `text` and `number` scalars express as a constraint ON themselves rather than
 * as a separate field-type `kind`.
 *
 * Membership is a QUERY fact, not a display one: it decides equality
 * selectivity, it is the highest-value line the model can be told about a
 * `where` clause, it is what a WRITE to the column is checked against
 * ({@link isClosedSetMember}), it is the narrowing a bind param inherits from
 * its uses ({@link meetFieldValues}), and it is the honest answer for
 * `toValueSchema()`. The human-facing `label` rides along with each member so
 * one closed set has one home (see `FieldValueDef`).
 */
import { z } from 'zod';
import type { FieldValueDef, JsonValue } from '../schema';
import { met, MEET_CONFLICT, type MeetResult } from './_meet';

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

/**
 * Normalize a declared value set: strip `undefined` labels, DEDUPE by `value`,
 * and drop an EMPTY set entirely. This function owns "what is a legal closed
 * set", so every consumer — selectivity, membership, the description, the meet —
 * inherits one answer.
 *
 * DEDUPING IS NOT COSMETIC. A set is a SET: `1/n` is only a selectivity if `n`
 * counts distinct values, `describeValues` would otherwise render `one of
 * done|todo|todo`, and — the reason it was found — the meet's INTERSECTION takes
 * its multiplicity from whichever operand it iterates, so a duplicated member
 * made `a ⊓ b` differ from `b ⊓ a`. Nothing forbids a duplicate upstream
 * (`fieldValuesSchema` does not, and `registry.parseType` accepted one
 * unchanged), so it is normalized here rather than defended against at each use.
 * The FIRST occurrence wins, keeping declaration order and its label.
 */
export function compactFieldValues(values: readonly FieldValueDef[] | undefined): FieldValueDef[] | undefined {
  // An empty array is not a closed set of nothing — it is an absent
  // declaration, and treating it as a set would make `1/n` divide by zero and
  // `toValueSchema` reject every value.
  if (!values || values.length === 0) return undefined;
  const seen = new Set<string | number>();
  const out: FieldValueDef[] = [];
  for (const v of values) {
    if (seen.has(v.value)) continue;
    seen.add(v.value);
    out.push(v.label === undefined ? { value: v.value } : { value: v.value, label: v.label });
  }
  return out;
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
 * Whether `raw` is one of the declared members — the MEMBERSHIP half of a
 * closed set, asked one value at a time. `true` when no set is declared: an
 * absent declaration constrains nothing, so every value is a member of it.
 *
 * Deliberately NOT routed through {@link closedSetValueSchema}: that builds a
 * zod union of `n` literals, and this is called once per written CELL, where the
 * only question is "is this one of them". The two MUST agree, and agreeing means
 * using zod's comparator, which is SameValueZero — MEASURED, not assumed:
 *
 *     z.literal(0).safeParse(-0)     -> accepted   (so not `Object.is`)
 *     z.literal(NaN).safeParse(NaN)  -> accepted   (so not `===` either)
 *
 * `Object.is` was the original choice here and it made `UPDATE t SET n = -0`
 * against `values:[{value:0}]` fail `write.value` while naming a member list
 * containing the very value being written. `x !== x` is the allocation-free NaN
 * test (`Number.isNaN` types its argument as `number`, which these are not yet).
 * A non-scalar `raw` — a document, a bool, `null` — is never a member; a closed
 * set holds only `string | number`.
 */
export function isClosedSetMember(values: readonly FieldValueDef[] | undefined, raw: JsonValue): boolean {
  if (!values || values.length === 0) return true;
  if (typeof raw !== 'string' && typeof raw !== 'number') return false;
  return values.some((v) => v.value === raw || (v.value !== v.value && raw !== raw));
}

/**
 * A closed-set violation found inside a written value: the offending value, the
 * set it had to belong to, and WHERE it sits — an empty `at` for the value
 * itself, or the array indices leading to it (outermost first) when the set is
 * declared on a container's ELEMENT type.
 *
 * Structured rather than a rendered string so the message lives at the ONE place
 * that knows the column's name (`validateWriteValue`), instead of every field
 * type re-deriving the same sentence.
 */
export interface ClosedSetViolation {
  /** Array indices from the written value down to the offender; empty = the value itself. */
  readonly at: readonly number[];
  /** The value that is not a member. */
  readonly value: JsonValue;
  /** The set it had to belong to. */
  readonly values: readonly FieldValueDef[];
}

/**
 * The MEET of two closed value sets — the set a value must belong to in order to
 * satisfy BOTH. An absent set is TOP (unconstrained), so `enum ⊓ text = enum`;
 * two declared sets INTERSECT.
 *
 * AN EMPTY INTERSECTION IS A CONFLICT, not "a closed set of nothing". Two
 * reasons, and the first is structural: an empty `values` array is not
 * representable here at all — {@link compactFieldValues} drops it, precisely so
 * `1/n` cannot divide by zero — so a "set of nothing" would round-trip into an
 * UNCONSTRAINED type, i.e. the exact opposite of what was computed. The second
 * is that a param which can never be satisfied is a defect the author wants
 * named, in the same breath as `enum ⊓ number`.
 *
 * ORDER-INDEPENDENT BY CONSTRUCTION. Intersecting reorders (which member list do
 * you keep?), so the result is sorted into a canonical order and a member's
 * `label` — display text, never a query fact — takes the lexicographically
 * smallest of the two rather than "the left one's". Two IDENTICAL lists
 * short-circuit to the left one untouched, which is what makes the meet exactly
 * idempotent instead of merely idempotent-up-to-ordering.
 */
export function meetFieldValues(
  a: readonly FieldValueDef[] | undefined,
  b: readonly FieldValueDef[] | undefined,
): MeetResult<FieldValueDef[]> {
  const left = compactFieldValues(a);
  const right = compactFieldValues(b);
  if (!left) return met(right);
  if (!right) return met(left);
  if (sameValueList(left, right)) return met(left);
  const byValue = new Map(right.map((v) => [v.value, v]));
  const shared: FieldValueDef[] = [];
  for (const v of left) {
    const other = byValue.get(v.value);
    if (other === undefined) continue;
    const label = minLabel(v.label, other.label);
    shared.push(label === undefined ? { value: v.value } : { value: v.value, label });
  }
  if (shared.length === 0) return MEET_CONFLICT;
  return met(shared.sort(compareMembers));
}

/** Whether two member lists are element-wise identical (value AND label, in order). */
function sameValueList(a: readonly FieldValueDef[], b: readonly FieldValueDef[]): boolean {
  return a.length === b.length && a.every((v, i) => v.value === b[i]!.value && v.label === b[i]!.label);
}

/** The lexicographically smaller of two optional labels; absent is TOP, so the other wins. */
function minLabel(a: string | undefined, b: string | undefined): string | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return a <= b ? a : b;
}

/**
 * Canonical member order: numbers ascending FIRST, then text ascending. It has
 * to be a STRICT total order, not just a consistent one — a mixed-scalar set can
 * hold both `1` and `'1'`, and comparing them as strings makes them TIE, at
 * which point `Array.sort`'s stability preserves the left operand's order and
 * the merge stops being commutative. Sorting numbers ahead of text breaks that
 * tie on the one thing that distinguishes them.
 *
 * PRECONDITION: both members come from a {@link compactFieldValues} result, so
 * no two of them are equal — which is what lets the final comparison be
 * two-way. Ties are the one thing this comparator cannot express consistently
 * (`cmp(a,b)` and `cmp(b,a)` would both be `1`), and deduping is what makes them
 * impossible rather than merely unlikely.
 */
function compareMembers(a: FieldValueDef, b: FieldValueDef): number {
  if (typeof a.value === 'number' && typeof b.value === 'number') return a.value - b.value;
  if (typeof a.value === 'number') return -1;
  if (typeof b.value === 'number') return 1;
  return a.value < b.value ? -1 : 1;
}

/**
 * The members of `values` that also satisfy `admits` — used when a meet's scalar
 * CONSTRAINTS come from a different use than its closed SET (`text{minLength:5}`
 * met with `enum{todo,pending}` admits only `pending`). It matters because a
 * closed set IS the value schema (`toValueSchema` short-circuits on it), so a
 * member left in the merged set is a value the merged type would ACCEPT even
 * though one of the uses that produced it would not. An EMPTY result is the
 * caller's conflict to report (see {@link meetFieldValues}).
 */
export function narrowFieldValues(
  values: readonly FieldValueDef[],
  admits: (value: string | number) => boolean,
): FieldValueDef[] {
  return values.filter((v) => admits(v.value));
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
