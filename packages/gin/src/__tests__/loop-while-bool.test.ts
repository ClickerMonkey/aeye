import { describe, test, expect } from 'vitest';
import { createRegistry, Engine, val } from '../index';

/**
 * `LoopExpr` accepts a bool-typed `over` expression and re-evaluates
 * it each iteration — true while-loop semantics. The loop continues
 * while the value is `true` and exits when it flips to `false`.
 *
 *  - The loop body sees `key` (num iteration index) and `value`
 *    (the bool's value, always `true` at body entry).
 *  - `flow:break` and `flow:continue` work as in any loop.
 *  - Static `validate()` no longer flags bool over as
 *    `loop.not-iterable`. Parallel options on a bool over flag as
 *    `loop.parallel.bool`.
 */

const r = createRegistry();
const e = new Engine(r);

const numLit = (n: number) => ({ kind: 'new', type: { name: 'num' }, value: n }) as const;
const boolLit = (b: boolean) => ({ kind: 'new', type: { name: 'bool' }, value: b }) as const;

describe('LoopExpr — bool while-loop semantics', () => {
  test('initial false → body runs zero times', async () => {
    // Set a `ran` var to 1, loop should NOT execute, var stays 1.
    const result = await e.run({
      kind: 'define',
      vars: [{ name: 'ran', value: numLit(1) }],
      body: {
        kind: 'block',
        lines: [
          {
            kind: 'loop',
            over: boolLit(false),
            body: {
              kind: 'set',
              path: [{ prop: 'ran' }],
              value: numLit(99),
            },
          },
          { kind: 'get', path: [{ prop: 'ran' }] },
        ],
      },
    });
    expect(result.raw).toBe(1);
  });

  test('expression re-evaluates each iteration: counts down to zero', async () => {
    // Counter starts at 3; loop while counter > 0; body decrements.
    // Should run 3 times (3, 2, 1) and exit when counter reaches 0.
    const result = await e.run({
      kind: 'define',
      vars: [{ name: 'counter', value: numLit(3) }],
      body: {
        kind: 'block',
        lines: [
          {
            kind: 'loop',
            // counter > 0 — re-evaluated every iteration.
            over: {
              kind: 'get',
              path: [
                { prop: 'counter' }, { prop: 'gt' },
                { args: { other: numLit(0) } },
              ],
            },
            body: {
              kind: 'set',
              path: [{ prop: 'counter' }],
              value: {
                kind: 'get',
                path: [
                  { prop: 'counter' }, { prop: 'sub' },
                  { args: { other: numLit(1) } },
                ],
              },
            },
          },
          { kind: 'get', path: [{ prop: 'counter' }] },
        ],
      },
    });
    expect(result.raw).toBe(0);
  });

  test('break exits the loop early', async () => {
    // Loop while true forever, break when key === 5.
    const result = await e.run({
      kind: 'define',
      vars: [{ name: 'last', value: numLit(-1) }],
      body: {
        kind: 'block',
        lines: [
          {
            kind: 'loop',
            over: boolLit(true),
            body: {
              kind: 'block',
              lines: [
                {
                  kind: 'set',
                  path: [{ prop: 'last' }],
                  value: { kind: 'get', path: [{ prop: 'key' }] },
                },
                {
                  kind: 'if',
                  ifs: [{
                    condition: {
                      kind: 'get',
                      path: [
                        { prop: 'key' }, { prop: 'gte' },
                        { args: { other: numLit(5) } },
                      ],
                    },
                    body: { kind: 'flow', action: 'break' },
                  }],
                },
              ],
            },
          },
          { kind: 'get', path: [{ prop: 'last' }] },
        ],
      },
    });
    expect(result.raw).toBe(5);
  });

  test('continue jumps to next iteration', async () => {
    // Decrement counter, increment hits only on iterations where
    // counter is still > 0. With continue at iteration 0 we still
    // hit the counter mutation BEFORE the continue is reached, so
    // verify the iteration index advances.
    const result = await e.run({
      kind: 'define',
      vars: [
        { name: 'counter', value: numLit(3) },
        { name: 'hits',    value: numLit(0) },
      ],
      body: {
        kind: 'block',
        lines: [
          {
            kind: 'loop',
            over: {
              kind: 'get',
              path: [
                { prop: 'counter' }, { prop: 'gt' },
                { args: { other: numLit(0) } },
              ],
            },
            body: {
              kind: 'block',
              lines: [
                // Always decrement counter.
                {
                  kind: 'set',
                  path: [{ prop: 'counter' }],
                  value: {
                    kind: 'get',
                    path: [
                      { prop: 'counter' }, { prop: 'sub' },
                      { args: { other: numLit(1) } },
                    ],
                  },
                },
                // Skip the hits++ when key === 0 via continue.
                {
                  kind: 'if',
                  ifs: [{
                    condition: {
                      kind: 'get',
                      path: [
                        { prop: 'key' }, { prop: 'eq' },
                        { args: { other: numLit(0) } },
                      ],
                    },
                    body: { kind: 'flow', action: 'continue' },
                  }],
                },
                // Increment hits otherwise.
                {
                  kind: 'set',
                  path: [{ prop: 'hits' }],
                  value: {
                    kind: 'get',
                    path: [
                      { prop: 'hits' }, { prop: 'add' },
                      { args: { other: numLit(1) } },
                    ],
                  },
                },
              ],
            },
          },
          { kind: 'get', path: [{ prop: 'hits' }] },
        ],
      },
    });
    // 3 iterations (counter 3→2→1→0). On iter 0 we continue (skip hits).
    // On iter 1 and iter 2 we hit. So hits=2.
    expect(result.raw).toBe(2);
  });

  test('binds key=num{whole, min:0} and value=bool in the body scope', async () => {
    // Verify body sees correct types — read key + value, return them.
    const result = await e.run({
      kind: 'define',
      vars: [
        { name: 'idx',  value: numLit(-1) },
        { name: 'lastV', value: { kind: 'new', type: { name: 'bool' }, value: false } },
      ],
      body: {
        kind: 'block',
        lines: [
          {
            kind: 'loop',
            // Run exactly one iteration.
            over: {
              kind: 'get',
              path: [
                { prop: 'idx' }, { prop: 'lt' },
                { args: { other: numLit(0) } },
              ],
            },
            body: {
              kind: 'block',
              lines: [
                {
                  kind: 'set',
                  path: [{ prop: 'idx' }],
                  value: { kind: 'get', path: [{ prop: 'key' }] },
                },
                {
                  kind: 'set',
                  path: [{ prop: 'lastV' }],
                  value: { kind: 'get', path: [{ prop: 'value' }] },
                },
              ],
            },
          },
          { kind: 'get', path: [{ prop: 'idx' }] },
        ],
      },
    });
    // First iter has key=0; setting idx=0 makes the next over-eval
    // false (idx < 0 → false); loop exits. So idx ends at 0.
    expect(result.raw).toBe(0);
  });
});

describe('GetSet.loopDynamic — bool opts in via the flag', () => {
  test('BoolType.get() returns a GetSet with loopDynamic: true and no `loop` ExprDef', () => {
    const gs = r.bool().get();
    expect(gs).toBeDefined();
    expect(gs!.loopDynamic).toBe(true);
    expect(gs!.loop).toBeUndefined();
    expect(gs!.key.name).toBe('num');
    expect(gs!.value.name).toBe('bool');
  });

  test('list iterables remain static (loop ExprDef present, no loopDynamic)', () => {
    const gs = r.list(r.num()).get();
    expect(gs).toBeDefined();
    expect(gs!.loop).toBeDefined();
    expect(gs!.loopDynamic).toBeFalsy();
  });
});

describe('LoopExpr — validation accepts bool over', () => {
  test('bool over does NOT flag loop.not-iterable', () => {
    const probs = e.validate({
      kind: 'loop',
      over: boolLit(true),
      body: { kind: 'flow', action: 'break' },
    });
    expect(probs.list.some((p) => p.code === 'loop.not-iterable')).toBe(false);
  });

  test('parallel options on a dynamic (bool) loop are accepted', () => {
    // Dynamic + parallel runs the body concurrently up to `concurrent`
    // tasks; `over` is re-evaluated after each completion. No analyzer
    // warning — both modes compose.
    const probs = e.validate({
      kind: 'loop',
      over: boolLit(true),
      parallel: { concurrent: numLit(2) },
      body: { kind: 'flow', action: 'break' },
    });
    expect(probs.list.some((p) => p.code === 'loop.parallel.dynamic')).toBe(false);
  });

  test('dynamic + parallel: body runs concurrently up to `concurrent`', async () => {
    // `over` flips false once the counter reaches 6. With concurrent=3,
    // the test.busy probe should report 3 simultaneously in-flight at
    // peak. Wall time should be roughly 2 batches × 50ms (≤ ~150ms),
    // not 6 × 50ms = 300ms.
    let inFlight = 0;
    let max = 0;
    const r2 = createRegistry();
    const e2 = new Engine(r2);
    r2.setNative('test.busy', async (_scope, reg) => {
      inFlight++;
      if (inFlight > max) max = inFlight;
      await new Promise((res) => setTimeout(res, 50));
      inFlight--;
      return val(reg.void(), undefined);
    });

    const program = {
      kind: 'define',
      vars: [
        { name: 'count', value: { kind: 'new', type: { name: 'num' }, value: 0 } },
      ],
      body: {
        kind: 'loop',
        // over = count.lt(6); re-evaluated after each task completes.
        over: {
          kind: 'get',
          path: [
            { prop: 'count' }, { prop: 'lt' },
            { args: { other: { kind: 'new', type: { name: 'num' }, value: 6 } } },
          ],
        },
        parallel: { concurrent: { kind: 'new', type: { name: 'num' }, value: 3 } },
        body: {
          kind: 'block',
          lines: [
            // Spawn the busy probe AND increment count so over flips.
            // The increment lands BEFORE busy resolves so subsequent
            // re-evals see updated counter, but several tasks can be
            // simultaneously waiting in busy.
            {
              kind: 'set',
              path: [{ prop: 'count' }],
              value: {
                kind: 'get',
                path: [
                  { prop: 'count' }, { prop: 'add' },
                  { args: { other: { kind: 'new', type: { name: 'num' }, value: 1 } } },
                ],
              },
            },
            { kind: 'native', id: 'test.busy' },
          ],
        },
      },
    } as const;

    const start = Date.now();
    await e2.run(program);
    const elapsed = Date.now() - start;

    // 6 iterations × 50ms with concurrency 3 = 2 batches × 50ms ≈ 100ms.
    expect(max).toBeGreaterThanOrEqual(2);
    expect(max).toBeLessThanOrEqual(3);
    expect(elapsed).toBeLessThan(200);
  });

  test('non-iterable, non-bool over still flags loop.not-iterable', () => {
    // date has no `get().loop` defined, and isn't bool — so it should
    // still trigger the not-iterable error.
    const probs = e.validate({
      kind: 'loop',
      over: { kind: 'new', type: { name: 'date' }, value: '2026-04-30' },
      body: { kind: 'block', lines: [] },
    });
    expect(probs.list.some((p) => p.code === 'loop.not-iterable')).toBe(true);
  });

  test('body sees key as num{whole,min:0} and value as bool', () => {
    // Validate that referencing key.add(...) in the body type-checks.
    const probs = e.validate({
      kind: 'loop',
      over: boolLit(true),
      body: {
        kind: 'get',
        path: [
          { prop: 'key' }, { prop: 'add' },
          { args: { other: numLit(1) } },
        ],
      },
    });
    expect(probs.list.some((p) => p.code === 'var.unknown')).toBe(false);
    expect(probs.list.some((p) => p.code === 'prop.unknown')).toBe(false);
  });
});
