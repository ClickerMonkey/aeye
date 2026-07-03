/**
 * Coverage: every builtin scalar / aggregate / window implementation, exercised
 * through the uniform runtime dispatch helpers.
 */
import { describe, it, expect } from 'vitest';
import { runtimeFixture } from './_utils';
import { Value } from '../runtime/value';
import { RuntimeContext } from '../runtime/context';
import {
  runScalarFunction,
  runAggregateFunction,
  runWindowFunction,
  WINDOW_ORDER_ARG,
} from '../runtime/functions';
import type { NamedArgs } from '../runtime/functions';

function ctxOf() {
  const fx = runtimeFixture();
  return { engine: fx.engine, ctx: new RuntimeContext(fx.engine) };
}
const scalar = async (name: string, args: NamedArgs) => {
  const { engine, ctx } = ctxOf();
  return (await runScalarFunction(engine, name, args, ctx)).raw;
};
const agg = async (name: string, rows: NamedArgs[]) => {
  const { engine, ctx } = ctxOf();
  return (await runAggregateFunction(engine, name, rows, ctx)).raw;
};
const win = async (name: string, partition: NamedArgs[], index: number) => {
  const { engine, ctx } = ctxOf();
  return (await runWindowFunction(engine, name, partition, index, ctx)).raw;
};

describe('builtin scalars', () => {
  it('text functions', async () => {
    expect(await scalar('concat', { values: Value.of(['a', 1, true]) })).toBe('a1true');
    expect(await scalar('concat', { values: Value.of('not-array') })).toBe(''); // non-array elements
    expect(await scalar('lower', { value: Value.of('AbC') })).toBe('abc');
    expect(await scalar('lower', {})).toBe(''); // absent arg -> NULL -> ''
    expect(await scalar('upper', { value: Value.of('AbC') })).toBe('ABC');
    expect(await scalar('trim', { value: Value.of('  x  ') })).toBe('x');
    expect(await scalar('length', { value: Value.of('hello') })).toBe(5);
    expect(await scalar('replace', { value: Value.of('a.b.c'), search: Value.of('.'), replacement: Value.of('-') })).toBe('a-b-c');
  });

  it('substring with and without length', async () => {
    expect(await scalar('substring', { value: Value.of('hello'), start: Value.of(1), length: Value.of(3) })).toBe('ell');
    expect(await scalar('substring', { value: Value.of('hello'), start: Value.of(2) })).toBe('llo');
  });

  it('math functions including null/NaN paths', async () => {
    expect(await scalar('abs', { value: Value.of(-3) })).toBe(3);
    expect(await scalar('abs', { value: Value.null() })).toBe(null); // numeric null path
    expect(await scalar('abs', { value: Value.of('xyz') })).toBe(null); // numeric NaN path
    expect(await scalar('ceil', { value: Value.of(1.2) })).toBe(2);
    expect(await scalar('floor', { value: Value.of(1.8) })).toBe(1);
    expect(await scalar('round', { value: Value.of(1.5) })).toBe(2);
    expect(await scalar('sqrt', { value: Value.of(9) })).toBe(3);
    expect(await scalar('power', { base: Value.of(2), exponent: Value.of(10) })).toBe(1024);
    expect(await scalar('power', { base: Value.of('x'), exponent: Value.of(2) })).toBe(null); // NaN base
  });

  it('coalesce / nullif', async () => {
    expect(await scalar('coalesce', { values: Value.of([null, null, 'first', 'second']) })).toBe('first');
    expect(await scalar('coalesce', { values: Value.of([null, null]) })).toBe(null);
    expect(await scalar('nullif', { value: Value.of(5), other: Value.of(5) })).toBe(null);
    expect(await scalar('nullif', { value: Value.of(5), other: Value.of(6) })).toBe(5);
  });

  it('greatest / least over non-null values', async () => {
    expect(await scalar('greatest', { values: Value.of([1, null, 9, 3]) })).toBe(9);
    expect(await scalar('least', { values: Value.of([5, null, 2, 8]) })).toBe(2);
    expect(await scalar('greatest', { values: Value.of([null, null]) })).toBe(null); // all-null -> NULL
    expect(await scalar('least', { values: Value.of([]) })).toBe(null);
  });

  it('arrayLength + temporal builtins', async () => {
    expect(await scalar('arrayLength', { arr: Value.of([1, 2, 3]) })).toBe(3);
    expect(await scalar('arrayLength', { arr: Value.of('not-array') })).toBe(0);
    const now = await scalar('now', {});
    expect(typeof now).toBe('string');
    expect(String(now)).toContain('T');
    const today = await scalar('currentDate', {});
    expect(String(today)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('builtin aggregates', () => {
  it('count(*) counts rows; count(value) counts non-null values', async () => {
    expect(await agg('count', [{}, {}, {}])).toBe(3); // count(*)
    expect(await agg('count', [{ value: Value.of(1) }, { value: Value.null() }, { value: Value.of(2) }])).toBe(2);
  });

  it('sum / avg over present and empty groups', async () => {
    expect(await agg('sum', [{ value: Value.of(2) }, { value: Value.of(3) }])).toBe(5);
    expect(await agg('sum', [{ value: Value.null() }])).toBe(null);
    expect(await agg('avg', [{ value: Value.of(2) }, { value: Value.of(4) }])).toBe(3);
    expect(await agg('avg', [])).toBe(null);
  });

  it('min / max over present and empty groups', async () => {
    expect(await agg('min', [{ value: Value.of(5) }, { value: Value.of(2) }, { value: Value.of(9) }])).toBe(2);
    expect(await agg('max', [{ value: Value.of(5) }, { value: Value.of(2) }, { value: Value.of(9) }])).toBe(9);
    expect(await agg('min', [])).toBe(null);
    expect(await agg('max', [])).toBe(null);
  });
});

describe('builtin windows', () => {
  const ord = (k: unknown): NamedArgs => ({ [WINDOW_ORDER_ARG]: Value.of(JSON.parse(JSON.stringify([k]))) });

  it('rowNumber is 1-based position', async () => {
    expect(await win('rowNumber', [{}, {}], 0)).toBe(1);
    expect(await win('rowNumber', [{}, {}], 1)).toBe(2);
  });

  it('rank handles ties, partition edges, and missing $order', async () => {
    const part = [ord('a'), ord('a'), ord('b')];
    expect(await win('rank', part, 2)).toBe(3); // distinct from prior
    expect(await win('rank', part, 1)).toBe(1); // tie with index 0 -> walks back
    expect(await win('rank', [{}], 0)).toBe(1); // row without $order
    expect(await win('rank', [], 0)).toBe(1); // index out of range -> {}
    expect(await win('rank', [ord('a')], 3)).toBe(2); // index beyond length -> walk over `?? {}`
  });

  it('denseRank counts distinct order signatures up to index', async () => {
    expect(await win('denseRank', [ord('a'), ord('b'), ord('b')], 2)).toBe(2);
    expect(await win('denseRank', [ord('a')], 2)).toBe(2); // out-of-range rows -> {} sig
  });

  it('lag / lead honor offset, default, and null targets', async () => {
    const part = [{ value: Value.of(10) }, { value: Value.of(20) }, { value: Value.of(30) }];
    expect(await win('lag', part, 1)).toBe(10); // default offset 1
    expect(await win('lag', part, 0)).toBe(null); // out of range -> no default -> NULL
    expect(await win('lag', part, 5)).toBe(null); // index beyond length -> cur `?? {}`
    expect(await win('lead', part, 1)).toBe(30);

    const withOpts = [
      { value: Value.of(10), offset: Value.of(2), default: Value.of(-1) },
      { value: Value.of(20) },
      { value: Value.of(30) },
    ];
    expect(await win('lag', withOpts, 0)).toBe(-1); // offset 2 out of range -> default

    const nullTarget = [
      { value: Value.of(1), default: Value.of(99) },
      { value: Value.null() },
    ];
    expect(await win('lead', nullTarget, 0)).toBe(99); // target value is NULL -> default
  });
});
