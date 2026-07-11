/**
 * Coverage: group 2c common scalar builtins — runtime (via the uniform scalar
 * dispatch) AND both-dialect SQL emission (base + postgres). Every new function
 * exercises its runtime value paths and its emitted SQL form.
 */
import { describe, it, expect } from 'vitest';
import { runtimeFixture } from './_utils';
import { RuntimeContext } from '../runtime/context';
import { runScalarFunction } from '../runtime/functions';
import type { NamedArgs } from '../runtime/functions';
import { Value } from '../runtime/value';
import type { JsonValue } from '../schema';
import { e } from '../builder';
import type { Expr } from '../expr';

const fx = runtimeFixture();
const ctx = new RuntimeContext(fx.engine);

const call = async (name: string, args: NamedArgs): Promise<JsonValue> =>
  (await runScalarFunction(fx.engine, name, args, ctx)).raw;
const V = (x: JsonValue): Value => Value.of(x);
const baseSql = (expr: Expr): string => fx.engine.exprToSQL(expr, 'base').sql;
const pgSql = (expr: Expr): string => fx.engine.exprToSQL(expr, 'postgres').sql;

describe('2c string scalars — runtime', () => {
  it('trimLeft / trimRight', async () => {
    expect(await call('trimLeft', { value: V('  hi ') })).toBe('hi ');
    expect(await call('trimRight', { value: V(' hi  ') })).toBe(' hi');
  });

  it('left / right incl. negative + zero + absent count', async () => {
    expect(await call('left', { value: V('hello'), count: V(3) })).toBe('hel');
    expect(await call('left', { value: V('hello'), count: V(-2) })).toBe('hel'); // drop last 2
    expect(await call('left', { value: V('hello') })).toBe(''); // absent count → 0
    expect(await call('right', { value: V('hello'), count: V(2) })).toBe('lo');
    expect(await call('right', { value: V('hello'), count: V(0) })).toBe(''); // n===0 branch
    expect(await call('right', { value: V('hello'), count: V(-2) })).toBe('llo'); // drop first 2
  });

  it('padLeft / padRight truncate-or-pad with/without fill', async () => {
    expect(await call('padLeft', { value: V('ab'), length: V(5), fill: V('*') })).toBe('***ab');
    expect(await call('padLeft', { value: V('abcdef'), length: V(3) })).toBe('abc'); // truncate, default fill
    expect(await call('padRight', { value: V('ab'), length: V(5), fill: V('*') })).toBe('ab***');
    expect(await call('padRight', { value: V('abcdef'), length: V(3) })).toBe('abc');
  });

  it('repeat (incl. NaN count → 0) and reverse', async () => {
    expect(await call('repeat', { value: V('ab'), count: V(3) })).toBe('ababab');
    expect(await call('repeat', { value: V('ab'), count: V('x') })).toBe(''); // intArg NaN → 0
    expect(await call('reverse', { value: V('abc') })).toBe('cba');
  });

  it('indexOf (1-based, 0 absent) / startsWith', async () => {
    expect(await call('indexOf', { value: V('hello'), search: V('ll') })).toBe(3);
    expect(await call('indexOf', { value: V('hi'), search: V('z') })).toBe(0);
    expect(await call('startsWith', { value: V('hello'), search: V('he') })).toBe(true);
    expect(await call('startsWith', { value: V('hello'), search: V('xx') })).toBe(false);
  });

  it('splitPart (in / out of range) and concatWs (drops nulls)', async () => {
    expect(await call('splitPart', { value: V('a,b,c'), delimiter: V(','), index: V(2) })).toBe('b');
    expect(await call('splitPart', { value: V('a,b'), delimiter: V(','), index: V(9) })).toBe(''); // ?? branch
    expect(await call('concatWs', { separator: V('-'), values: V(['a', null, 'b']) })).toBe('a-b');
  });
});

describe('2c math scalars — runtime', () => {
  it('mod incl. divide-by-zero and NaN → null', async () => {
    expect(await call('mod', { value: V(10), divisor: V(3) })).toBe(1);
    expect(await call('mod', { value: V(10), divisor: V(0) })).toBe(null); // non-finite → null
    expect(await call('mod', { value: V('x'), divisor: V(3) })).toBe(null); // NaN input → null
    expect(await call('mod', { value: Value.null(), divisor: V(3) })).toBe(null); // null a
    expect(await call('mod', { value: V(10), divisor: Value.null() })).toBe(null); // null b
  });

  it('sign / exp / trunc / log / log10 / ln (finite guard)', async () => {
    expect(await call('sign', { value: V(-5) })).toBe(-1);
    expect(await call('exp', { value: V(0) })).toBe(1);
    expect(await call('trunc', { value: V(1.9) })).toBe(1);
    expect(await call('log', { base: V(2), value: V(8) })).toBe(3);
    expect(await call('log10', { value: V(1000) })).toBe(3);
    expect(await call('ln', { value: V(0) })).toBe(null); // ln(0) = -∞ → null
  });

  it('pi / degrees / radians / random', async () => {
    expect(await call('pi', {})).toBe(Math.PI);
    expect(await call('degrees', { value: V(Math.PI) })).toBe(180);
    expect(await call('radians', { value: V(180) })).toBeCloseTo(Math.PI, 10);
    const r = await call('random', {});
    expect(typeof r).toBe('number');
    expect(r).toBeGreaterThanOrEqual(0);
    expect(r).toBeLessThan(1);
  });

  it('trig incl. null / NaN-input / NaN-output → null', async () => {
    expect(await call('sin', { value: V(0) })).toBe(0);
    expect(await call('cos', { value: V(0) })).toBe(1);
    expect(await call('tan', { value: V(0) })).toBe(0);
    expect(await call('asin', { value: V(0) })).toBe(0);
    expect(await call('acos', { value: V(1) })).toBe(0);
    expect(await call('atan', { value: V(0) })).toBe(0);
    expect(await call('atan2', { y: V(1), x: V(1) })).toBeCloseTo(Math.PI / 4, 10);
    expect(await call('sin', { value: Value.null() })).toBe(null); // null input
    expect(await call('cos', { value: V('x') })).toBe(null); // NaN input
    expect(await call('asin', { value: V(2) })).toBe(null); // asin(2) = NaN output
  });

  it('iif picks the matching branch', async () => {
    expect(await call('iif', { condition: V(true), then: V('Y'), else: V('N') })).toBe('Y');
    expect(await call('iif', { condition: V(false), then: V('Y'), else: V('N') })).toBe('N');
  });
});

describe('2c scalars — SQL (both dialects)', () => {
  const cases: ReadonlyArray<readonly [Expr, string]> = [
    [e.fn('trimLeft', { value: e.value('x') }), 'ltrim('],
    [e.fn('trimRight', { value: e.value('x') }), 'rtrim('],
    [e.fn('left', { value: e.value('x'), count: e.value(2) }), 'left('],
    [e.fn('right', { value: e.value('x'), count: e.value(2) }), 'right('],
    [e.fn('padLeft', { value: e.value('x'), length: e.value(5), fill: e.value('*') }), 'lpad('],
    [e.fn('padRight', { value: e.value('x'), length: e.value(5) }), 'rpad('],
    [e.fn('repeat', { value: e.value('x'), count: e.value(2) }), 'repeat('],
    [e.fn('reverse', { value: e.value('x') }), 'reverse('],
    [e.fn('indexOf', { value: e.value('x'), search: e.value('y') }), 'strpos('],
    [e.fn('startsWith', { value: e.value('x'), search: e.value('y') }), 'starts_with('],
    [e.fn('splitPart', { value: e.value('a,b'), delimiter: e.value(','), index: e.value(1) }), 'split_part('],
    [e.fn('concatWs', { separator: e.value('-'), values: e.param('vals') }), 'concat_ws('],
    [e.fn('mod', { value: e.value(10), divisor: e.value(3) }), 'mod('],
    [e.fn('sign', { value: e.value(-1) }), 'sign('],
    [e.fn('exp', { value: e.value(1) }), 'exp('],
    [e.fn('ln', { value: e.value(1) }), 'ln('],
    [e.fn('log', { base: e.value(2), value: e.value(8) }), 'log('],
    [e.fn('log10', { value: e.value(100) }), 'log('],
    [e.fn('trunc', { value: e.value(1.5) }), 'trunc('],
    [e.fn('pi', {}), 'pi()'],
    [e.fn('degrees', { value: e.value(1) }), 'degrees('],
    [e.fn('radians', { value: e.value(1) }), 'radians('],
    [e.fn('random', {}), 'random()'],
    [e.fn('sin', { value: e.value(0) }), 'sin('],
    [e.fn('cos', { value: e.value(0) }), 'cos('],
    [e.fn('tan', { value: e.value(0) }), 'tan('],
    [e.fn('asin', { value: e.value(0) }), 'asin('],
    [e.fn('acos', { value: e.value(1) }), 'acos('],
    [e.fn('atan', { value: e.value(0) }), 'atan('],
    [e.fn('atan2', { y: e.value(1), x: e.value(1) }), 'atan2('],
    [e.fn('iif', { condition: e.value(true), then: e.value(1), else: e.value(2) }), '(CASE WHEN '],
  ];

  it('emits the expected function form on base and postgres', () => {
    for (const [expr, frag] of cases) {
      expect(baseSql(expr)).toContain(frag);
      expect(pgSql(expr)).toContain(frag);
    }
  });

  it('placeholders differ by dialect (base ? vs postgres $1)', () => {
    expect(baseSql(e.fn('sin', { value: e.value(0) }))).toBe('sin(?)');
    expect(pgSql(e.fn('sin', { value: e.value(0) }))).toBe('sin($1)');
    expect(baseSql(e.fn('iif', { condition: e.value(true), then: e.value(1), else: e.value(2) }))).toBe(
      '(CASE WHEN ? THEN ? ELSE ? END)',
    );
  });
});
