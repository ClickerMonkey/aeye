import { describe, test, expect } from 'vitest';
import { createRegistry, Engine } from '../index';

describe('Loop.parallel — concurrency + rate', () => {
  test('parallel concurrent=1 iterates every element', async () => {
    // concurrent=1 exercises the parallel path but serializes execution,
    // so we can safely sum via `total = total + x` without races.
    const r = createRegistry();
    const e = new Engine(r);
    const program = {
      kind: 'define',
      vars: [
        { name: 'arr',   value: { kind: 'new', type: { name: 'list', generic: { V: { name: 'num' } } }, value: [1, 2, 3, 4] } },
        { name: 'total', value: { kind: 'new', type: { name: 'num' }, value: 0 } },
      ],
      body: {
        kind: 'block',
        lines: [
          {
            kind: 'loop',
            over: { kind: 'get', path: [{ prop: 'arr' }] },
            value: 'x',
            parallel: { concurrent: { kind: 'new', type: { name: 'num' }, value: 1 } },
            body: {
              kind: 'set',
              path: [{ prop: 'total' }],
              value: {
                kind: 'get',
                path: [
                  { prop: 'total' }, { prop: 'add' },
                  { args: { other: { kind: 'get', path: [{ prop: 'x' }] } } },
                ],
              },
            },
          },
          { kind: 'get', path: [{ prop: 'total' }] },
        ],
      },
    } as const;
    const v = await e.run(program);
    expect(v.raw).toBe(10);
  });

  test('parallel with rate: all iterations land via list.push', async () => {
    // list.push is an atomic native mutation — pushes from concurrent
    // iterations don't race; length is deterministic.
    const r = createRegistry();
    const e = new Engine(r);
    const program = {
      kind: 'define',
      vars: [
        { name: 'src', value: { kind: 'new', type: { name: 'list', generic: { V: { name: 'num' } } }, value: [10, 20, 30] } },
        { name: 'out', value: { kind: 'new', type: { name: 'list', generic: { V: { name: 'num' } } }, value: [] } },
      ],
      body: {
        kind: 'block',
        lines: [
          {
            kind: 'loop',
            over: { kind: 'get', path: [{ prop: 'src' }] },
            parallel: { rate: { kind: 'new', type: { name: 'duration' }, value: { ms: 1 } } },
            body: {
              kind: 'get',
              path: [
                { prop: 'out' }, { prop: 'push' },
                { args: { value: { kind: 'get', path: [{ prop: 'value' }] } } },
              ],
            },
          },
          { kind: 'get', path: [{ prop: 'out' }, { prop: 'length' }] },
        ],
      },
    } as const;
    const v = await e.run(program);
    expect(v.raw).toBe(3);
  });

  test('parallel concurrent=3 still launches all tasks', async () => {
    const r = createRegistry();
    const e = new Engine(r);
    const program = {
      kind: 'define',
      vars: [
        { name: 'src', value: { kind: 'new', type: { name: 'list', generic: { V: { name: 'num' } } }, value: [1, 2, 3, 4, 5] } },
        { name: 'out', value: { kind: 'new', type: { name: 'list', generic: { V: { name: 'num' } } }, value: [] } },
      ],
      body: {
        kind: 'block',
        lines: [
          {
            kind: 'loop',
            over: { kind: 'get', path: [{ prop: 'src' }] },
            parallel: { concurrent: { kind: 'new', type: { name: 'num' }, value: 3 } },
            body: {
              kind: 'get',
              path: [
                { prop: 'out' }, { prop: 'push' },
                { args: { value: { kind: 'get', path: [{ prop: 'value' }] } } },
              ],
            },
          },
          { kind: 'get', path: [{ prop: 'out' }, { prop: 'length' }] },
        ],
      },
    } as const;
    const v = await e.run(program);
    expect(v.raw).toBe(5);
  });
});

/**
 * Empirical concurrency tests — bodies that actually take time, with
 * a probe native that records max in-flight count and total wall time.
 * Asserts what the parallel orchestration in `LoopExpr.evaluate`
 * actually does: with `concurrent: N`, up to N bodies run at once;
 * with `rate: ms`, starts are paced; sequential mode never overlaps.
 *
 * The probe native blocks on `setTimeout(50ms)` and bumps a shared
 * counter — same trick a fans-out HTTP client would exercise. Because
 * the work is real wall-clock time, the timing assertions have a
 * generous lower bound (parallelism MUST cut sequential time roughly
 * by N) and a loose upper bound (CI variance is real).
 */
describe('LoopExpr.parallel — empirical concurrency', () => {
  function setupProbe(): {
    register: (e: import('../index').Engine) => void;
    maxInFlight: () => number;
    totalCalls: () => number;
    reset: () => void;
  } {
    let inFlight = 0;
    let max = 0;
    let total = 0;
    return {
      register(e) {
        e.registry.setNative('test.busy', async (_scope, reg) => {
          inFlight++;
          if (inFlight > max) max = inFlight;
          total++;
          // 50ms is enough overlap to be measurable across CI without
          // making a 4-iteration test painfully slow.
          await new Promise((r) => setTimeout(r, 50));
          inFlight--;
          return reg.void().parse(undefined);
        });
      },
      maxInFlight: () => max,
      totalCalls: () => total,
      reset: () => { inFlight = 0; max = 0; total = 0; },
    };
  }

  test('sequential loop never overlaps — max in-flight = 1', async () => {
    const r = createRegistry();
    const e = new Engine(r);
    const probe = setupProbe();
    probe.register(e);

    const program = {
      kind: 'block',
      lines: [
        {
          kind: 'loop',
          over: { kind: 'new', type: { name: 'list', generic: { V: { name: 'num' } } }, value: [1, 2, 3, 4] },
          // No `parallel` field → sequential path. Each body awaits
          // before the next yield — so test.busy never overlaps.
          body: { kind: 'native', id: 'test.busy' },
        },
      ],
    } as const;
    const start = Date.now();
    await e.run(program);
    const elapsed = Date.now() - start;

    expect(probe.totalCalls()).toBe(4);
    expect(probe.maxInFlight()).toBe(1);
    // 4 × 50ms = 200ms minimum. Lower bound generous to absorb timer slop.
    expect(elapsed).toBeGreaterThanOrEqual(180);
  });

  test('parallel concurrent=4 over 4 items — all 4 in-flight simultaneously', async () => {
    const r = createRegistry();
    const e = new Engine(r);
    const probe = setupProbe();
    probe.register(e);

    const program = {
      kind: 'block',
      lines: [
        {
          kind: 'loop',
          over: { kind: 'new', type: { name: 'list', generic: { V: { name: 'num' } } }, value: [1, 2, 3, 4] },
          parallel: { concurrent: { kind: 'new', type: { name: 'num' }, value: 4 } },
          body: { kind: 'native', id: 'test.busy' },
        },
      ],
    } as const;
    const start = Date.now();
    await e.run(program);
    const elapsed = Date.now() - start;

    expect(probe.totalCalls()).toBe(4);
    // Concurrency upper bound = 4 — the actual peak should reach 4.
    expect(probe.maxInFlight()).toBe(4);
    // 4 bodies of 50ms running fully in parallel = ~50ms total. Allow
    // up to 150ms before flagging — anything close to 200ms means the
    // pool serialised them.
    expect(elapsed).toBeLessThan(150);
  });

  test('parallel concurrent=2 over 6 items — peak in-flight clamps at 2', async () => {
    const r = createRegistry();
    const e = new Engine(r);
    const probe = setupProbe();
    probe.register(e);

    const program = {
      kind: 'block',
      lines: [
        {
          kind: 'loop',
          over: { kind: 'new', type: { name: 'list', generic: { V: { name: 'num' } } }, value: [1, 2, 3, 4, 5, 6] },
          parallel: { concurrent: { kind: 'new', type: { name: 'num' }, value: 2 } },
          body: { kind: 'native', id: 'test.busy' },
        },
      ],
    } as const;
    const start = Date.now();
    await e.run(program);
    const elapsed = Date.now() - start;

    expect(probe.totalCalls()).toBe(6);
    // The pool caps active tasks at 2 — should never exceed that.
    expect(probe.maxInFlight()).toBe(2);
    // 6 bodies of 50ms with concurrency 2 = 3 batches × 50ms = ~150ms.
    // Lower bound 130ms (allow timer slop), upper bound 250ms (catch
    // accidental serialisation = 300ms).
    expect(elapsed).toBeGreaterThanOrEqual(130);
    expect(elapsed).toBeLessThan(250);
  });

  test('parallel rate=80ms paces iteration starts even at high concurrency', async () => {
    const r = createRegistry();
    const e = new Engine(r);
    const probe = setupProbe();
    probe.register(e);

    const program = {
      kind: 'block',
      lines: [
        {
          kind: 'loop',
          over: { kind: 'new', type: { name: 'list', generic: { V: { name: 'num' } } }, value: [1, 2, 3] },
          // Concurrency unbounded, but every start is at least 80ms
          // after the previous. Three iterations → ~160ms wall time
          // (start gaps) + 50ms body for the last one ≈ 210ms+.
          parallel: { rate: { kind: 'new', type: { name: 'duration' }, value: { ms: 80 } } },
          body: { kind: 'native', id: 'test.busy' },
        },
      ],
    } as const;
    const start = Date.now();
    await e.run(program);
    const elapsed = Date.now() - start;

    expect(probe.totalCalls()).toBe(3);
    // First start: ~0ms. Second: ~80ms. Third: ~160ms. Last body
    // finishes ~50ms after that → ≥ 210ms.
    expect(elapsed).toBeGreaterThanOrEqual(180);
  });
});
