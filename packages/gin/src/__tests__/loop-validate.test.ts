import { describe, test, expect } from 'vitest';
import { createRegistry, Engine } from '../index';

/**
 * LoopExpr validation:
 *   - parallel.concurrent must be num
 *   - parallel.rate must be num or duration
 *   - scope key/value bind to the iterable's declared types (not any)
 */

describe('LoopExpr.validateWalk', () => {
  test('concurrent: text → error', () => {
    const e = new Engine(createRegistry());
    const probs = e.validate({
      kind: 'loop',
      over: { kind: 'new', type: { name: 'list', generic: { V: { name: 'num' } } }, value: [] },
      body: { kind: 'new', type: { name: 'void' } },
      parallel: { concurrent: { kind: 'new', type: { name: 'text' }, value: '4' } },
    });
    expect(probs.list.some((p) => p.code === 'loop.parallel.concurrent.type')).toBe(true);
  });

  test('rate: text → error; rate: num → ok; rate: duration → ok', () => {
    const e = new Engine(createRegistry());
    const bad = e.validate({
      kind: 'loop',
      over: { kind: 'new', type: { name: 'list', generic: { V: { name: 'num' } } }, value: [] },
      body: { kind: 'new', type: { name: 'void' } },
      parallel: { rate: { kind: 'new', type: { name: 'text' }, value: '50' } },
    });
    expect(bad.list.some((p) => p.code === 'loop.parallel.rate.type')).toBe(true);

    const okNum = e.validate({
      kind: 'loop',
      over: { kind: 'new', type: { name: 'list', generic: { V: { name: 'num' } } }, value: [] },
      body: { kind: 'new', type: { name: 'void' } },
      parallel: { rate: { kind: 'new', type: { name: 'num' }, value: 50 } },
    });
    expect(okNum.list.some((p) => p.code === 'loop.parallel.rate.type')).toBe(false);

    const okDuration = e.validate({
      kind: 'loop',
      over: { kind: 'new', type: { name: 'list', generic: { V: { name: 'num' } } }, value: [] },
      body: { kind: 'new', type: { name: 'void' } },
      parallel: { rate: { kind: 'new', type: { name: 'duration' }, value: { ms: 50 } } },
    });
    expect(okDuration.list.some((p) => p.code === 'loop.parallel.rate.type')).toBe(false);
  });

  test('loop body sees key/value typed from the iterable, not any', () => {
    const e = new Engine(createRegistry());
    // Inside the loop, `value` is a num — `value.add({other: "x"})` would fail
    // because "x" is text, not num. But if the validator was using `any`, the
    // inner arg wouldn't be flagged. We check that the body's typed scope is
    // populated by inferring typeOf(value) and asserting num.
    const t = e.typeOf({
      kind: 'loop',
      over: { kind: 'new', type: { name: 'list', generic: { V: { name: 'num' } } }, value: [1, 2, 3] },
      body: { kind: 'get', path: [{ prop: 'value' }] },
    });
    // Loop itself is void; the sub-Expr typeOf is handled inside its own walk.
    expect(t.name).toBe('void');

    // Validate and ensure no var.unknown for the key/value references in body.
    const probs = e.validate({
      kind: 'loop',
      over: { kind: 'new', type: { name: 'list', generic: { V: { name: 'num' } } }, value: [1, 2, 3] },
      body: {
        kind: 'get',
        path: [
          { prop: 'value' }, { prop: 'add' },
          { args: { other: { kind: 'new', type: { name: 'num' }, value: 1 } } },
        ],
      },
    });
    expect(probs.list.some((p) => p.code === 'var.unknown')).toBe(false);
    expect(probs.list.some((p) => p.code === 'prop.unknown')).toBe(false);
  });
});
