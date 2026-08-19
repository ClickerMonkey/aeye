/**
 * Coverage: composite field types (array), relation key resolution, the
 * abstract `FieldType` base defaults, and the `fieldTypeDefSchema` barrel.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { createRegistry } from '../registry';
import {
  ArrayFieldType,
  NumberFieldType,
  TextFieldType,
  RelationFieldType,
  fieldTypeDefSchema,
} from '../field-types/index';
import { FieldType, type ScalarKind } from '../field-type';
import type { FieldTypeDef } from '../schema';
import type { ValueSchemaOptions } from '../node';
import { fixture } from './_utils';

describe('cov array field type', () => {
  it('from valid: item parsed only with a registry, dropped without', () => {
    const reg = createRegistry();
    const withReg = ArrayFieldType.from({ kind: 'array', item: { kind: 'text' }, minItems: 1, maxItems: 3 }, reg);
    expect(withReg.item).toBeInstanceOf(TextFieldType);
    expect(withReg.minItems).toBe(1);
    expect(withReg.maxItems).toBe(3);
    // bare Cls.from(def) with no registry cannot reconstruct the element type
    const noReg = ArrayFieldType.from({ kind: 'array', item: { kind: 'text' } });
    expect(noReg.item).toBeUndefined();
    // no item present at all
    expect(ArrayFieldType.from({ kind: 'array' }, reg).item).toBeUndefined();
  });

  it('from kind mismatch throw', () => {
    expect(() => ArrayFieldType.from({ kind: 'text' })).toThrow(/expected kind 'array'/);
  });

  it('toSchema safeParse (recursive item)', () => {
    const s = ArrayFieldType.toSchema();
    expect(s.safeParse({ kind: 'array', item: { kind: 'number' } }).success).toBe(true);
    expect(s.safeParse({ kind: 'array' }).success).toBe(true);
    expect(s.safeParse({ kind: 'text' }).success).toBe(false);
  });

  it('resolve / toSQLType neutral', () => {
    const ft = new ArrayFieldType();
    expect(ft.resolve()).toBe('array');
    expect(ft.toSQLType()).toBe('json');
  });

  it('avgBytes across bound permutations', () => {
    // unbounded, unknown element ⇒ midpoint count(2) * UNKNOWN(16) = 32, floored at 8
    expect(new ArrayFieldType().avgBytes()).toBe(32);
    // typed element uses item.avgBytes
    expect(new ArrayFieldType(new NumberFieldType()).avgBytes()).toBe(Math.max(8, 2 * 8));
    // bounded both ⇒ midpoint of [min,max]
    expect(new ArrayFieldType(new NumberFieldType(), 2, 4).avgBytes()).toBe(Math.max(8, 3 * 8));
    // min only ⇒ hi = lo + DEFAULT(4)
    expect(new ArrayFieldType(undefined, 10).avgBytes()).toBe(Math.max(8, 12 * 16));
    // unbounded unknown element ⇒ midpoint count(1) * UNKNOWN(16) = 16
    expect(new ArrayFieldType(undefined, 0, 0).avgBytes()).toBe(16);
    // floor of 8 enforced for a tiny typed array (1 item * 1 byte → floored to 8)
    expect(new ArrayFieldType(new TextFieldType({ maxLength: 1 }), 0, 0).avgBytes()).toBe(8);
  });

  it('comparableWith arrays only, element-aware', () => {
    const txt = new ArrayFieldType(new TextFieldType());
    const txt2 = new ArrayFieldType(new TextFieldType());
    const num = new ArrayFieldType(new NumberFieldType());
    const untyped = new ArrayFieldType();
    expect(txt.comparableWith(txt2)).toBe(true);
    expect(txt.comparableWith(num)).toBe(false);
    // an unknown element on either side is unconstrained
    expect(txt.comparableWith(untyped)).toBe(true);
    expect(untyped.comparableWith(txt)).toBe(true);
    // not comparable with a non-array
    expect(txt.comparableWith(new TextFieldType())).toBe(false);
  });

  it('toValueSchema with element type + bounds, and heterogeneous', () => {
    const typed = new ArrayFieldType(new NumberFieldType({ whole: true }), 1, 2);
    expect(typed.toValueSchema().safeParse([1]).success).toBe(true);
    expect(typed.toValueSchema().safeParse([]).success).toBe(false); // min 1
    expect(typed.toValueSchema().safeParse([1, 2, 3]).success).toBe(false); // max 2
    expect(typed.toValueSchema().safeParse([1.5]).success).toBe(false); // element not whole
    const hetero = new ArrayFieldType();
    expect(hetero.toValueSchema().safeParse([1, 'x', true, null]).success).toBe(true);
  });

  it('toJSON / clone with each optional present/absent', () => {
    expect(new ArrayFieldType().toJSON()).toEqual({ kind: 'array' });
    const full = new ArrayFieldType(new TextFieldType({ maxLength: 4 }), 1, 5);
    expect(full.toJSON()).toEqual({ kind: 'array', minItems: 1, maxItems: 5, item: { kind: 'text', maxLength: 4 } });
    const clone = full.clone();
    expect(clone.toJSON()).toEqual(full.toJSON());
    expect(clone.item).not.toBe(full.item);
    // minItems only
    expect(new ArrayFieldType(undefined, 2).toJSON()).toEqual({ kind: 'array', minItems: 2 });
    // maxItems only
    expect(new ArrayFieldType(undefined, undefined, 9).toJSON()).toEqual({ kind: 'array', maxItems: 9 });
  });

  it('toCode renders element type or bare array', () => {
    expect(new ArrayFieldType(new TextFieldType()).toCode()).toBe('array<text>');
    expect(new ArrayFieldType().toCode()).toBe('array');
  });
});

describe('cov relation resolveKey', () => {
  it('belongs-to (count 1) → local = relName, foreign = target identity', () => {
    const fx = fixture();
    const rel = new RelationFieldType('user', 1);
    const key = rel.resolveKey('userId', fx.order, fx.user);
    expect(key).toEqual({ localField: 'userId', foreignField: 'id' });
  });

  it('has-many (count > 1) → local = this identity, foreign = camelHead(thisType)', () => {
    const fx = fixture();
    const rel = new RelationFieldType('order', 5);
    const key = rel.resolveKey('orders', fx.user, fx.order);
    // no inverseVia ⇒ fk defaults to camelHead('user') = 'user'
    expect(key).toEqual({ localField: 'id', foreignField: 'user' });
  });

  it('has-many with inverseVia uses that FK', () => {
    const fx = fixture();
    const rel = new RelationFieldType('order', 5, undefined, 'userId');
    const key = rel.resolveKey('orders', fx.user, fx.order);
    expect(key).toEqual({ localField: 'id', foreignField: 'userId' });
  });
});

/** A minimal concrete FieldType that overrides NOTHING optional — exercises the
 *  abstract base defaults (`comparableWith`, `validValue`, `textCasing`). */
class PlainFieldType extends FieldType {
  readonly kind = 'number' as const;
  toJSON(): FieldTypeDef {
    return { kind: 'number' };
  }
  clone(): PlainFieldType {
    return new PlainFieldType();
  }
  resolve(): ScalarKind {
    return 'number';
  }
  toValueSchema(_opts?: ValueSchemaOptions): z.ZodTypeAny {
    return z.number();
  }
  avgBytes(): number {
    return 8;
  }
  toSQLType(): string {
    return 'numeric';
  }
}

describe('cov FieldType base defaults', () => {
  it('base comparableWith / validValue / textCasing / toCode', () => {
    const ft = new PlainFieldType();
    expect(ft.comparableWith(new NumberFieldType())).toBe(true);
    expect(ft.comparableWith(new TextFieldType())).toBe(false);
    expect(ft.validValue(5)).toBe(true);
    expect(ft.validValue('x')).toBe(false);
    // A non-text type DECLARES no casing — distinct from declaring an
    // insensitive one, so it inherits the engine default rather than out-voting
    // a field that did declare.
    expect(ft.textCasing()).toBeUndefined();
    expect(ft.toCode()).toBe('number');
  });
});

describe('cov fieldTypeDefSchema barrel', () => {
  it('parses each builtin kind via the folded union', () => {
    const s = fieldTypeDefSchema();
    expect(s.safeParse({ kind: 'number' }).success).toBe(true);
    expect(s.safeParse({ kind: 'array', item: { kind: 'text' } }).success).toBe(true);
    expect(s.safeParse({ kind: 'relation', to: 'X', count: 1 }).success).toBe(true);
    expect(s.safeParse({ kind: 'bogus' }).success).toBe(false);
  });
});
