import { GOOGLE_STRICT, type FormatDescriptor } from '../../schema';

/**
 * A strict dialect with no combinators and no named `$ref`s — Gemini's before
 * its November 2025 JSON Schema expansion. Tests use it for the mechanics a
 * restrictive dialect triggers, independent of what any provider accepts today.
 */
export const NO_COMBINATORS_STRICT: FormatDescriptor = Object.freeze({
  ...GOOGLE_STRICT,
  id: 'no-combinators-strict',
  family: 'no-combinators',
  allowAnyOf: false,
  allowDefsRef: false,
});
