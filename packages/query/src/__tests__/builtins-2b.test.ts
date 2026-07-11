/**
 * Coverage: group 2b array builtins — runtime (over JS arrays) AND both-dialect
 * SQL emission. Postgres emits native array operators; the base (ANSI) dialect
 * DEGRADES gracefully (a constant, or the first argument unchanged) and never
 * throws.
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

describe('2b array — runtime', () => {
  it('arrayContains membership', async () => {
    expect(await call('arrayContains', { arr: V([1, 2, 3]), value: V(2) })).toBe(true);
    expect(await call('arrayContains', { arr: V([1, 2]), value: V(5) })).toBe(false);
  });

  it('arrayAppend / arrayPrepend / arrayConcat', async () => {
    expect(await call('arrayAppend', { arr: V([1, 2]), value: V(3) })).toEqual([1, 2, 3]);
    expect(await call('arrayPrepend', { arr: V([2, 3]), value: V(1) })).toEqual([1, 2, 3]);
    expect(await call('arrayConcat', { a: V([1]), b: V([2, 3]) })).toEqual([1, 2, 3]);
  });

  it('arrayIndexOf (1-based, null when absent)', async () => {
    expect(await call('arrayIndexOf', { arr: V([10, 20, 30]), value: V(20) })).toBe(2);
    expect(await call('arrayIndexOf', { arr: V([1]), value: V(9) })).toBe(null);
  });

  it('arraySlice (1-based inclusive; defaulted bounds)', async () => {
    expect(await call('arraySlice', { arr: V([1, 2, 3, 4, 5]), lo: V(2), hi: V(4) })).toEqual([2, 3, 4]);
    // Absent lo/hi ⇒ whole array (intArg defaults).
    expect(await call('arraySlice', { arr: V([1, 2, 3]) })).toEqual([1, 2, 3]);
  });

  it('arrayRemove / arrayDistinct', async () => {
    expect(await call('arrayRemove', { arr: V([1, 2, 1, 3]), value: V(1) })).toEqual([2, 3]);
    expect(await call('arrayDistinct', { arr: V([1, 1, 2, 3, 3]) })).toEqual([1, 2, 3]);
  });

  it('arrayToString (drops nulls) / stringToArray', async () => {
    expect(await call('arrayToString', { arr: V([1, null, 2]), sep: V('-') })).toBe('1-2');
    expect(await call('stringToArray', { str: V('a,b,c'), sep: V(',') })).toEqual(['a', 'b', 'c']);
  });
});

describe('2b array — SQL base degrades (never throw)', () => {
  const arr = () => e.param('arr');
  it('scalar-returning ops degrade to a constant', () => {
    expect(baseSql(e.arrayContains(arr(), e.value(2)))).toBe('(1 = 0)');
    expect(baseSql(e.arrayIndexOf(arr(), e.value(2)))).toBe('0');
    expect(baseSql(e.arrayToString(arr(), e.value('-')))).toBe("''");
  });

  it('array/string-returning ops degrade to the first argument unchanged', () => {
    // The array/string arg is a bare param ⇒ the base emit is just its placeholder.
    expect(baseSql(e.arrayAppend(arr(), e.value(3)))).toBe('?');
    expect(baseSql(e.arrayPrepend(arr(), e.value(3)))).toBe('?');
    expect(baseSql(e.arrayConcat(arr(), e.param('b')))).toBe('?');
    expect(baseSql(e.arrayRemove(arr(), e.value(3)))).toBe('?');
    expect(baseSql(e.arraySlice(arr(), e.value(1), e.value(2)))).toBe('?');
    expect(baseSql(e.arrayDistinct(arr()))).toBe('?');
    expect(baseSql(e.stringToArray(e.param('s'), e.value(',')))).toBe('?');
  });
});

describe('2b array — SQL postgres native', () => {
  const arr = () => e.param('arr');
  it('emits the native array operators', () => {
    expect(pgSql(e.arrayContains(arr(), e.value(2)))).toContain(' = ANY(');
    expect(pgSql(e.arrayAppend(arr(), e.value(3)))).toContain('array_append(');
    expect(pgSql(e.arrayPrepend(arr(), e.value(3)))).toContain('array_prepend(');
    expect(pgSql(e.arrayConcat(arr(), e.param('b')))).toContain(' || ');
    expect(pgSql(e.arrayIndexOf(arr(), e.value(2)))).toContain('array_position(');
    const slice = pgSql(e.arraySlice(arr(), e.value(1), e.value(2)));
    expect(slice).toContain('[');
    expect(slice).toContain(':');
    expect(pgSql(e.arrayRemove(arr(), e.value(3)))).toContain('array_remove(');
    expect(pgSql(e.arrayDistinct(arr()))).toContain('ARRAY(SELECT DISTINCT unnest(');
    expect(pgSql(e.arrayToString(arr(), e.value('-')))).toContain('array_to_string(');
    expect(pgSql(e.stringToArray(e.param('s'), e.value(',')))).toContain('string_to_array(');
  });

  it('arrayPrepend puts the element first (pg arg order)', () => {
    // array_prepend(value, arr): the element renders first, so it binds $1.
    const rendered = fx.engine.exprToSQL(e.arrayPrepend(arr(), e.value(9)), 'postgres');
    expect(rendered.sql).toBe('array_prepend($1, $2)');
    expect(rendered.params[0]).toBe(9); // $1 is the element
  });
});
