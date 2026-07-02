/**
 * Coverage: runtime value / row / record helpers + function dispatch.
 */
import { describe, it, expect } from 'vitest';
import { runtimeFixture } from './_utils';
import { Value, isScalarValue } from '../runtime/value';
import { singleRow, mergeRows, cloneRecord } from '../runtime/row';
import { firstField, recordSignature } from '../runtime/record';
import { recordKey, RuntimeContext } from '../runtime/context';
import {
  runScalarFunction,
  runTabularFunction,
  runAggregateFunction,
  runWindowFunction,
} from '../runtime/functions';

describe('Value coercions', () => {
  it('toNumber across categories', () => {
    expect(Value.of(5).toNumber()).toBe(5);
    expect(Value.of(true).toNumber()).toBe(1);
    expect(Value.of(false).toNumber()).toBe(0);
    expect(Value.of('7').toNumber()).toBe(7);
    expect(Number.isNaN(Value.of(['a']).toNumber())).toBe(true);
  });

  it('toBoolean across categories', () => {
    expect(Value.of(true).toBoolean()).toBe(true);
    expect(Value.null().toBoolean()).toBe(false);
    expect(Value.of(0).toBoolean()).toBe(false);
    expect(Value.of(3).toBoolean()).toBe(true);
    expect(Value.of('').toBoolean()).toBe(false);
    expect(Value.of('x').toBoolean()).toBe(true);
    expect(Value.of({ a: 1 }).toBoolean()).toBe(true);
  });

  it('toText across categories', () => {
    expect(Value.null().toText()).toBe('');
    expect(Value.of({ a: 1 }).toText()).toBe('{"a":1}');
    expect(Value.of(42).toText()).toBe('42');
  });

  it('category reports the JS shape', () => {
    expect(Value.null().category()).toBe('null');
    expect(Value.of(1).category()).toBe('number');
    expect(Value.of('s').category()).toBe('string');
    expect(Value.of(true).category()).toBe('boolean');
    expect(Value.of([1]).category()).toBe('object');
  });

  it('compareTo: nulls sort first, numbers numeric, booleans, strings', () => {
    expect(Value.null().compareTo(Value.null())).toBe(0);
    expect(Value.null().compareTo(Value.of(1))).toBe(-1);
    expect(Value.of(1).compareTo(Value.null())).toBe(1);
    expect(Value.of(1).compareTo(Value.of(1))).toBe(0);
    expect(Value.of(1).compareTo(Value.of(2))).toBe(-1);
    expect(Value.of(2).compareTo(Value.of(1))).toBe(1);
    expect(Value.of(true).compareTo(Value.of(true))).toBe(0);
    expect(Value.of(true).compareTo(Value.of(false))).toBe(1);
    expect(Value.of(false).compareTo(Value.of(true))).toBe(-1);
    expect(Value.of('a').compareTo(Value.of('a'))).toBe(0);
    expect(Value.of('a').compareTo(Value.of('b'))).toBe(-1);
    expect(Value.of('b').compareTo(Value.of('a'))).toBe(1);
  });

  it('compareToCase folds case only when insensitive + both strings', () => {
    expect(Value.of('A').compareToCase(Value.of('a'), false)).toBe(0);
    expect(Value.of('A').compareToCase(Value.of('b'), false)).toBe(-1);
    expect(Value.of('b').compareToCase(Value.of('A'), false)).toBe(1);
    // sensitive → defers to compareTo (uppercase < lowercase)
    expect(Value.of('A').compareToCase(Value.of('a'), true)).toBe(-1);
    // non-string operand → defers to compareTo
    expect(Value.of(1).compareToCase(Value.of(2), false)).toBe(-1);
  });

  it('caseSensitive reflects the originating field type, default false', () => {
    const fx = runtimeFixture();
    const sensitive = fx.registry.parseFieldType({ kind: 'text', sensitive: true });
    const insensitive = fx.registry.parseFieldType({ kind: 'text' });
    expect(Value.of('x', undefined, sensitive).caseSensitive()).toBe(true);
    expect(Value.of('x', undefined, insensitive).caseSensitive()).toBe(false);
    expect(Value.of('x').caseSensitive()).toBe(false);
  });

  it('equals is SQL-equality (null never equal); identical treats nulls equal', () => {
    expect(Value.null().equals(Value.null())).toBe(false);
    expect(Value.of(1).equals(Value.null())).toBe(false);
    expect(Value.of(1).equals(Value.of(1))).toBe(true);
    expect(Value.null().identical(Value.null())).toBe(true);
    expect(Value.of(1).identical(Value.null())).toBe(false);
    expect(Value.null().identical(Value.of(1))).toBe(false);
    expect(Value.of(1).identical(Value.of(1))).toBe(true);
  });

  it('isScalarValue distinguishes scalars from objects', () => {
    expect(isScalarValue(null)).toBe(true);
    expect(isScalarValue(1)).toBe(true);
    expect(isScalarValue('s')).toBe(true);
    expect(isScalarValue(true)).toBe(true);
    expect(isScalarValue([1])).toBe(false);
    expect(isScalarValue({ a: 1 })).toBe(false);
  });
});

describe('row + record helpers', () => {
  it('singleRow / mergeRows / cloneRecord', () => {
    const r = singleRow('u', { id: 1 });
    expect(r).toEqual({ u: { id: 1 } });
    expect(mergeRows({ u: { id: 1 } }, { o: { id: 9 } })).toEqual({ u: { id: 1 }, o: { id: 9 } });
    const clone = cloneRecord({ id: 1, name: 'Ada' });
    expect(clone).toEqual({ id: 1, name: 'Ada' });
  });

  it('firstField returns first value or null for empty record', () => {
    expect(firstField({ a: 5, b: 6 })).toBe(5);
    expect(firstField({})).toBe(null);
  });

  it('recordSignature is stable + key-sorted', () => {
    expect(recordSignature({ b: 2, a: 1 })).toBe(recordSignature({ a: 1, b: 2 }));
  });

  it('recordKey uses id when present, else JSON form', () => {
    expect(recordKey({ id: 7 })).toBe('id:7');
    expect(recordKey({ name: 'x' })).toBe('row:{"name":"x"}');
  });
});

describe('function dispatch fallbacks', () => {
  it('absent / wrong-shape runs degrade to NULL or empty rows', async () => {
    const fx = runtimeFixture();
    const ctx = new RuntimeContext(fx.engine);
    // unknown name → fallbacks
    expect((await runScalarFunction(fx.engine, 'nope', {}, ctx)).isNull()).toBe(true);
    expect((await runTabularFunction(fx.engine, 'nope', {}, ctx)).raw).toEqual([]);
    expect((await runAggregateFunction(fx.engine, 'nope', [], ctx)).isNull()).toBe(true);
    expect((await runWindowFunction(fx.engine, 'nope', [], 0, ctx)).isNull()).toBe(true);
    // wrong-shape: 'sum' is aggregate, not scalar/tabular/window
    expect((await runScalarFunction(fx.engine, 'sum', {}, ctx)).isNull()).toBe(true);
    expect((await runTabularFunction(fx.engine, 'sum', {}, ctx)).raw).toEqual([]);
    expect((await runWindowFunction(fx.engine, 'sum', [], 0, ctx)).isNull()).toBe(true);
    // 'concat' is scalar, not aggregate
    expect((await runAggregateFunction(fx.engine, 'concat', [], ctx)).isNull()).toBe(true);
    // and the happy path dispatches
    expect((await runScalarFunction(fx.engine, 'concat', { values: Value.of(['a', 'b']) }, ctx)).raw).toBe('ab');
  });
});
