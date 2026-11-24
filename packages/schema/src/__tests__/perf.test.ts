/**
 * Performance and memory regressions found by the benchmarks (bench/, PERFORMANCE.md).
 */
import { describe, expect, it, vi } from 'vitest';
import { a, Compiler, LENIENT, newStats, Node, OPENAI_STRICT, variant } from '../index';

/** A recursive grammar whose values go through UNTAGGED unions on encode (the option is found by checking the value). */
const Grammar = a
  .define({
    Expr: a.union([
      a.number(),
      a.string(),
      a.object({ op: a.enum(['+', '-']), left: a.ref('Expr'), right: a.ref('Expr') }),
      a.object({ call: a.string(), args: a.record(a.ref('Expr')) }),
    ]),
  })
  .result(a.object({ rows: a.array(a.record(a.ref('Expr'))) }));

const rows = (n: number) => ({ rows: Array.from({ length: n }, (_, i) => ({ id: i, total: { op: '+' as const, left: i, right: { call: 'tax', args: { of: i } } } })) });

describe('rendering keeps a fixed size however many values go through it', () => {
  it('encoding through untagged unions compiles each option once (was: a new compile per value, growing the compiler)', () => {
    const bound = Grammar.bind();
    const r = bound.render(variant(OPENAI_STRICT, { rootObject: true }));
    const lenient = bound.render(LENIENT);
    const nodes = () => (lenient.compiler.nodes.length + r.compiler.nodes.length);
    r.encode(rows(10));
    const after = nodes();
    for (let i = 0; i < 20; i++) r.encode(rows(50));
    expect(nodes()).toBe(after);
    // and the encoded value still decodes back
    const v = rows(3);
    const res = r.parse(r.encode(v));
    expect(res.ok && res.value).toEqual(v);
  });

  // Counted, not timed: wall time flaked under the full suite's load. The work is node visits,
  // compiles and allocations; each must grow exactly linearly with the rows (the rows are alike).
  it('encoding work is linear in the value: node visits and allocations per row are constant, nothing compiles', () => {
    const r = Grammar.bind().render(variant(OPENAI_STRICT, { rootObject: true }));
    r.encode(rows(100));
    const work = (n: number) => {
      const v = rows(n);
      const visits = vi.spyOn(Node.prototype, 'encode');
      const compiles = vi.spyOn(Compiler.prototype, 'compile');
      const stats = newStats();
      try {
        r.encode(v, stats);
        return { visits: visits.mock.calls.length, compiles: compiles.mock.calls.length, allocations: stats.objects + stats.arrays };
      } finally {
        visits.mockRestore();
        compiles.mockRestore();
      }
    };
    const [w100, w200, w1000] = [work(100), work(200), work(1000)];
    expect([w100.compiles, w200.compiles, w1000.compiles]).toEqual([0, 0, 0]);
    expect(w100.visits).toBeGreaterThan(100);
    // f(1000) - f(100) = 9 · (f(200) - f(100)) exactly when f is linear in the rows.
    expect(w1000.visits - w100.visits).toBe(9 * (w200.visits - w100.visits));
    expect(w1000.allocations - w100.allocations).toBe(9 * (w200.allocations - w100.allocations));
  });

  it('a rejected answer costs work linear in the answer, and the message stays the same size', () => {
    // The invalid-path cost (pass 4): suggestions and the echo are computed only for the problems shown.
    const R = a.object({ rows: a.array(a.object({ id: a.int(), kind: a.enum(['open', 'closed', 'pending']) })) });
    const r = R.render(variant(OPENAI_STRICT, { rootObject: true }));
    const bad = (n: number) => ({ rows: Array.from({ length: n }, (_, i) => ({ id: i, kind: i % 2 ? 'opn' : 'open' })) });
    const work = (n: number) => {
      const visits = vi.spyOn(Node.prototype, 'run');
      try {
        const res = r.parse(bad(n));
        return { visits: visits.mock.calls.length, message: res.ok ? '' : res.message };
      } finally {
        visits.mockRestore();
      }
    };
    const [w100, w200, w1000] = [work(100), work(200), work(1000)];
    expect(w1000.visits - w100.visits).toBe(9 * (w200.visits - w100.visits));
    expect(w1000.message).toContain('did you mean `open`?');
    expect(w1000.message).toContain('and 497 more places');
    expect(w1000.message.length).toBe(w100.message.length + 3); // "50 problems" → "500", "47 more" → "497", "… 98 items" → "998"
  });
});

describe('caches do not keep binds alive', () => {
  it('a static ref-free part rendered in a bind does not pin that bind once it is dropped', async () => {
    const { setFlagsFromString } = await import('node:v8');
    const { runInNewContext } = await import('node:vm');
    setFlagsFromString('--expose-gc');
    const gc = runInNewContext('gc') as () => void;

    // A static, ref-free part (cached per profile for as long as it lives) inside a dynamic module.
    const Shared = a.object({ name: a.string(), tags: a.array(a.string()).optional(), limits: a.record(a.number()) });
    const Mod = a
      .define({ Row: a.object({ shared: Shared, kind: a.ref('Kind') }) })
      .declare<{ Kind: string }>()
      .dynamic((kinds: readonly string[]) => ({ Kind: a.enum(kinds as [string, ...string[]]) }), { key: (k) => k.join(','), cacheSize: 1 })
      .result(a.object({ rows: a.array(a.ref('Row')) }));

    const refs: WeakRef<object>[] = [];
    (() => {
      for (let i = 0; i < 3; i++) {
        const b = Mod.bind([`k${i}`]);
        for (const p of [LENIENT, OPENAI_STRICT]) b.render(p).jsonSchema;
        refs.push(new WeakRef(b));
      }
    })();
    Mod.bind(['other']); // the bind cache (size 1) now holds only this one
    for (let i = 0; i < 6; i++) { gc(); await new Promise((r) => setTimeout(r, 0)); }
    expect(refs.map((r) => r.deref() === undefined)).toEqual([true, true, true]);
    // The shared part still renders the same in a new bind.
    const r = Mod.bind(['z']).render(OPENAI_STRICT);
    expect(r.parse({ rows: [{ shared: { name: 'n', tags: null, limits: [{ key: 'a', value: 1 }] }, kind: 'z' }] }).ok).toBe(true);
  });
});
