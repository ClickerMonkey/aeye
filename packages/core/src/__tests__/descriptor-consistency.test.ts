/**
 * FormatDescriptor self-consistency.
 *
 * A descriptor declares BOTH what the dialect forbids (`allow*`) and which
 * shape to emit for an open "any" value (`anyEncoding`). Nothing used to tie
 * the two together, and they drifted apart exactly once — with consequences:
 * `GOOGLE_STRICT` shipped `allowAnyOf: false` + `allowDefsRef: false`
 * alongside `anyEncoding: 'recursive-open'`, an encoding that needs both. So
 * every `z.any()` in a Gemini tool schema emitted the `anyOf` + self-
 * referencing `$defs/Any` the descriptor itself called unrepresentable, and
 * the only report of it was a `400 INVALID_ARGUMENT` from Google.
 *
 * These tests make that class of contradiction impossible to reintroduce
 * quietly — for the built-ins here, and for any family registered later.
 */

import {
  ANTHROPIC_NON_STRICT,
  ANTHROPIC_STRICT,
  checkDescriptorConsistency,
  GOOGLE_NON_STRICT,
  GOOGLE_STRICT,
  LENIENT,
  OPENAI_NON_STRICT,
  OPENAI_STRICT,
  registerDescriptor,
  type FormatDescriptor,
} from '../schema';

const BUILT_INS: ReadonlyArray<readonly [string, FormatDescriptor]> = [
  ['LENIENT', LENIENT],
  ['OPENAI_STRICT', OPENAI_STRICT],
  ['OPENAI_NON_STRICT', OPENAI_NON_STRICT],
  ['ANTHROPIC_STRICT', ANTHROPIC_STRICT],
  ['ANTHROPIC_NON_STRICT', ANTHROPIC_NON_STRICT],
  ['GOOGLE_STRICT', GOOGLE_STRICT],
  ['GOOGLE_NON_STRICT', GOOGLE_NON_STRICT],
];

describe('FormatDescriptor self-consistency', () => {
  describe('every built-in descriptor can emit its own anyEncoding', () => {
    it.each(BUILT_INS)('%s', (_name, descriptor) => {
      expect(checkDescriptorConsistency(descriptor)).toEqual([]);
    });
  });

  describe('checkDescriptorConsistency detects each contradiction', () => {
    it('flags a recursive encoding under allowDefsRef: false', () => {
      // This is verbatim the bug that shipped.
      const problems = checkDescriptorConsistency({
        ...GOOGLE_STRICT,
        anyEncoding: 'recursive-open',
      });
      expect(problems).toEqual([
        expect.stringContaining('allowAnyOf is false'),
        expect.stringContaining('allowDefsRef is false'),
      ]);
    });

    it('flags a flat encoding under allowAnyOf: false', () => {
      // The other tempting "fix" for Google — flat needs no `$defs` but still
      // emits `anyOf`, so it is equally unavailable there.
      const problems = checkDescriptorConsistency({ ...GOOGLE_STRICT, anyEncoding: 'flat' });
      expect(problems).toEqual([expect.stringContaining('allowAnyOf is false')]);
    });

    it('flags a recursive encoding under supportsRecursion: false', () => {
      // Anthropic's real constraint: `$defs` is fine, a CYCLE in it is not.
      const problems = checkDescriptorConsistency({
        ...ANTHROPIC_STRICT,
        anyEncoding: 'recursive-strict',
      });
      expect(problems).toEqual([expect.stringContaining('supportsRecursion is false')]);
    });

    it('flags a maxEnumValues that would strip every enum constraint', () => {
      // A cap below 1 widens EVERY enum the dialect emits, including a
      // two-member one, and a fractional cap reads as a threshold nobody
      // intended. Both are silent — the schema stays valid, it just stops
      // constraining anything — which is what this function is for.
      expect(checkDescriptorConsistency({ ...GOOGLE_STRICT, maxEnumValues: 0 })).toEqual([
        expect.stringContaining('maxEnumValues must be a positive integer'),
      ]);
      expect(checkDescriptorConsistency({ ...GOOGLE_STRICT, maxEnumValues: -5 })).toEqual([
        expect.stringContaining('maxEnumValues must be a positive integer'),
      ]);
      expect(checkDescriptorConsistency({ ...GOOGLE_STRICT, maxEnumValues: 2.5 })).toEqual([
        expect.stringContaining('maxEnumValues must be a positive integer'),
      ]);
    });

    it('accepts a descriptor that declares no maxEnumValues at all', () => {
      // The field is optional: "no cap" is the default, not a contradiction.
      expect(checkDescriptorConsistency({ ...GOOGLE_STRICT, maxEnumValues: undefined })).toEqual([]);
    });

    it('accepts the unconstrained encoding under every combination of flags', () => {
      // `unconstrained` emits no keyword, so no `allow*` flag can forbid it —
      // which is what makes it the fallback for a maximally restrictive
      // dialect.
      const maximallyRestrictive: FormatDescriptor = {
        ...GOOGLE_STRICT,
        allowAllOf: false,
        allowAnyOf: false,
        allowOneOf: false,
        allowRootRef: false,
        allowDefsRef: false,
        supportsRecursion: false,
        anyEncoding: 'unconstrained',
      };
      expect(checkDescriptorConsistency(maximallyRestrictive)).toEqual([]);
    });
  });

  describe('registerDescriptor', () => {
    it('warns once per problem when a custom descriptor contradicts itself', () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        registerDescriptor({
          ...GOOGLE_STRICT,
          id: 'consistency-test-broken',
          family: 'consistency-test-broken',
          anyEncoding: 'recursive-open',
        });
        expect(warn).toHaveBeenCalledTimes(2);
        expect(warn.mock.calls.map((c) => String(c[0]))).toEqual([
          expect.stringContaining("'consistency-test-broken' is inconsistent"),
          expect.stringContaining("'consistency-test-broken' is inconsistent"),
        ]);
      } finally {
        warn.mockRestore();
      }
    });

    it('stays silent for a consistent custom descriptor', () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        registerDescriptor({
          ...GOOGLE_STRICT,
          id: 'consistency-test-ok',
          family: 'consistency-test-ok',
        });
        expect(warn).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    });
  });
});
