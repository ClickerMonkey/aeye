import { describe, it, expect } from 'vitest';
import { canonicalize } from '../expr';
import { Index } from '../index-spec';
import { fixture, ref, cmp, lit } from './_utils';
import type { ExprDef } from '../schema';

const fx = fixture();

describe('canonicalize', () => {
  it('produces the same digest for logically-identical exprs', () => {
    const a = fx.engine.parse(cmp('=', ref('u', 'id'), lit(1)));
    const b = fx.engine.parse(cmp('=', ref('u', 'id'), lit(1)));
    expect(canonicalize(a)).toBe(canonicalize(b));
  });

  it('produces different digests for different exprs', () => {
    const a = fx.engine.parse(cmp('=', ref('u', 'id'), lit(1)));
    const b = fx.engine.parse(cmp('=', ref('u', 'id'), lit(2)));
    const c = fx.engine.parse(cmp('=', ref('u', 'name'), lit('x')));
    expect(canonicalize(a)).not.toBe(canonicalize(b));
    expect(canonicalize(a)).not.toBe(canonicalize(c));
  });

  it('is insensitive to key order in the source JSON', () => {
    // Two defs with the same content but different key insertion order.
    const ordered: ExprDef = { kind: 'comparison', op: '=', left: ref('u', 'id'), right: lit(1) };
    const shuffled = { right: lit(1), left: ref('u', 'id'), op: '=' as const, kind: 'comparison' as const };
    const a = fx.engine.parse(ordered);
    const b = fx.engine.parse(shuffled);
    expect(canonicalize(a)).toBe(canonicalize(b));
  });

  it('Index.prefixReduction agrees with canonicalize', () => {
    const indexed = ref('u', 'id');
    const index = Index.from({ exprs: [{ expr: indexed, count: 1 }] });
    const match = fx.engine.parse(ref('u', 'id'));
    const other = fx.engine.parse(ref('u', 'name'));
    // A matched leading prefix returns its (unique) count; a miss returns undefined.
    expect(index.prefixReduction([match])).toBe(1);
    expect(index.prefixReduction([other])).toBeUndefined();
    // The index part's digest equals the canonical digest of an equivalent expr.
    expect(index.parts[0]!.digest).toBe(canonicalize(match));
  });
});
