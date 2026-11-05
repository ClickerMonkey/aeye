import type { FormatDescriptor, SchemaSizeLimits } from './descriptor';

// ============================================================================
// Descriptor self-consistency
// ============================================================================

/**
 * JSON-Schema keywords each `anyEncoding` has to emit. Single source of truth
 * for both `buildAnyValueSchema` (which produces the shape) and
 * `checkDescriptorConsistency` (which checks the descriptor is allowed to).
 */
const ANY_ENCODING_REQUIREMENTS: Readonly<Record<
  FormatDescriptor['anyEncoding'],
  { readonly anyOf: boolean; readonly defsRef: boolean }
>> = Object.freeze({
  'recursive-strict': { anyOf: true, defsRef: true },
  'recursive-open': { anyOf: true, defsRef: true },
  'flat': { anyOf: true, defsRef: false },
  'unconstrained': { anyOf: false, defsRef: false },
});

/**
 * Report the ways a `FormatDescriptor` contradicts itself — settings that ask
 * the emitter to produce a keyword the same descriptor forbids, or a limit
 * that would quietly strip every constraint it governs. Returns one
 * human-readable line per problem; an empty array means the descriptor is
 * internally consistent.
 *
 * This exists because a contradiction here is invisible until a provider
 * answers HTTP 400: `GOOGLE_STRICT` shipped with `allowAnyOf: false` +
 * `allowDefsRef: false` AND `anyEncoding: 'recursive-open'` (which needs
 * both), so every `z.any()` in a Gemini tool schema emitted exactly the
 * `anyOf` + `$defs/Any` shape the descriptor declared unrepresentable.
 * Nothing checked, so nothing caught it.
 *
 * Called by `registerDescriptor` (which warns) and asserted over every
 * built-in by the test suite.
 *
 * @example
 * ```ts
 * checkDescriptorConsistency(GOOGLE_STRICT);   // → []
 * checkDescriptorConsistency({ ...GOOGLE_STRICT, anyEncoding: 'flat' });
 * //  → ["anyEncoding 'flat' emits `anyOf`, but allowAnyOf is false"]
 * ```
 */
export function checkDescriptorConsistency(descriptor: FormatDescriptor): string[] {
  const problems: string[] = [];
  const needs = ANY_ENCODING_REQUIREMENTS[descriptor.anyEncoding];
  if (needs === undefined) {
    problems.push(`anyEncoding '${descriptor.anyEncoding}' is not a known encoding`);
    return problems;
  }
  if (needs.anyOf && !descriptor.allowAnyOf) {
    problems.push(`anyEncoding '${descriptor.anyEncoding}' emits \`anyOf\`, but allowAnyOf is false`);
  }
  if (needs.defsRef && !descriptor.allowDefsRef) {
    problems.push(`anyEncoding '${descriptor.anyEncoding}' emits a self-referencing \`$defs/Any\`, but allowDefsRef is false`);
  }
  if (needs.defsRef && !descriptor.supportsRecursion) {
    problems.push(`anyEncoding '${descriptor.anyEncoding}' emits a self-referencing \`$defs/Any\`, but supportsRecursion is false`);
  }
  // `maxEnumValues` is an independent scalar — there is no other field it can
  // contradict — but a cap below 1 widens EVERY enum the dialect ever emits
  // (including a two-member one), and a fractional cap reads as a threshold
  // nobody intended. Both are silent: the schema stays valid, it just stops
  // constraining anything, which is the "invisible until you read the wire"
  // class this function exists to catch. Only reachable through
  // `registerDescriptor`; the built-ins are asserted clean by the test suite.
  const cap = descriptor.maxEnumValues;
  if (cap !== undefined && (!Number.isInteger(cap) || cap < 1)) {
    problems.push(`maxEnumValues must be a positive integer, got ${cap}`);
  }
  problems.push(...schemaSizeLimitProblems(descriptor));
  return problems;
}

/**
 * The ways a `schemaSizeLimits` group contradicts itself or the descriptor
 * carrying it. Split out only to keep `checkDescriptorConsistency` readable;
 * it is part of the same contract.
 *
 * The failures below are all SILENT: a non-positive bound degrades every
 * schema to lenient (strict mode simply stops happening, with no error
 * anywhere), a threshold above the total makes the large-enum rule
 * unreachable, and limits on a non-strict descriptor describe a rule the API
 * does not apply — each one is a rule that reads as enforced and is not.
 */
function schemaSizeLimitProblems(descriptor: FormatDescriptor): string[] {
  const limits = descriptor.schemaSizeLimits;
  if (limits === undefined) return [];
  const problems: string[] = [];
  if (!descriptor.strict) {
    problems.push('schemaSizeLimits is declared on a non-strict descriptor, but the size rules bound Structured Outputs only');
  }
  // Keyed off the interface, so a bound added to `SchemaSizeLimits` is checked
  // here without an edit — `satisfies` makes a missed key a compile error.
  const bounds = {
    maxObjectProperties: limits.maxObjectProperties,
    maxNestingDepth: limits.maxNestingDepth,
    maxTotalStringChars: limits.maxTotalStringChars,
    maxTotalEnumValues: limits.maxTotalEnumValues,
    largeEnumValueCount: limits.largeEnumValueCount,
    maxLargeEnumStringChars: limits.maxLargeEnumStringChars,
  } satisfies Record<keyof SchemaSizeLimits, number>;
  for (const [name, value] of Object.entries(bounds)) {
    if (!Number.isInteger(value) || value < 1) {
      problems.push(`schemaSizeLimits.${name} must be a positive integer, got ${value}`);
    }
  }
  if (limits.largeEnumValueCount >= limits.maxTotalEnumValues) {
    problems.push(
      `schemaSizeLimits.largeEnumValueCount (${limits.largeEnumValueCount}) is not below maxTotalEnumValues ` +
        `(${limits.maxTotalEnumValues}), so the large-enum character rule can never apply`,
    );
  }
  return problems;
}
