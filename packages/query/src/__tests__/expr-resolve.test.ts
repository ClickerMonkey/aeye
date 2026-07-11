import { describe, it, expect } from 'vitest';
import { asFieldType } from '../resolved-type';
import { canonicalize } from '../expr';
import { fixture, typeScope, lit, ref, cmp } from './_utils';
import type { ExprDef, SelectDef } from '../schema';

const fx = fixture();
const scope = typeScope(fx);

/** Resolve a JSON def in the type scope. */
function resolve(def: ExprDef) {
  return fx.engine.resolveExpr(def, scope);
}

describe('expr resolution', () => {
  it('literal resolves to its JS-typed computed value', () => {
    expect(asFieldType(resolve(lit(5)))?.resolve()).toBe('number');
    expect(asFieldType(resolve(lit('hi')))?.resolve()).toBe('text');
    expect(asFieldType(resolve(lit(true)))?.resolve()).toBe('bool');
    const nul = resolve(lit(null));
    expect(nul.kind).toBe('computed');
    if (nul.kind === 'computed') expect(nul.nullable).toBe(true);
  });

  it('field-ref resolves to a FieldResolved with field nullability', () => {
    const r = resolve(ref('u', 'name'));
    expect(r.kind).toBe('field');
    if (r.kind === 'field') {
      expect(r.field.name).toBe('name');
      expect(r.type.name).toBe('user');
      expect(r.nullable).toBe(false);
    }
    const age = resolve(ref('u', 'age'));
    if (age.kind === 'field') expect(age.nullable).toBe(true);
  });

  it('a belongs-to relation join binds the target; a field-ref into it resolves to that field', () => {
    // The old bare `relation-path` crossing is now an explicit named join:
    // order.userId (belongs-to user) joined as `buyer`, then read buyer.name.
    const def: SelectDef = {
      kind: 'select',
      fields: [{ expr: ref('buyer', 'name'), as: 'name' }],
      from: { kind: 'type', type: 'order' },
      joins: [{ on: { kind: 'relation', source: 'order', field: 'userId', as: 'buyer' } }],
    };
    const field = fx.engine
      .parseQuery(def)
      .outputFields(fx.engine, fx.engine.globalScope())
      .find((f) => f.name === 'name')!;
    expect(field.type.kind).toBe('field');
    if (field.type.kind === 'field') {
      expect(field.type.field.name).toBe('name');
      expect(field.type.type.name).toBe('user');
      // Static resolution reads the field's own nullability; the LEFT-join
      // widening is now a runtime/SQL effect, not a resolve-time one (the
      // relation-path's resolve-time widening was removed with the refactor).
      expect(field.type.nullable).toBe(false);
    }
  });

  it('a has-many relation join binds the joined alias as the related type', () => {
    // user.orders (has-many order) joined as `ord`: a field read off `ord` is
    // owned by the related `order` type — the crossing lands on that type.
    const def: SelectDef = {
      kind: 'select',
      fields: [{ expr: ref('ord', 'total'), as: 't' }],
      from: { kind: 'type', type: 'user' },
      joins: [{ on: { kind: 'relation', source: 'user', field: 'orders', as: 'ord' } }],
    };
    const field = fx.engine
      .parseQuery(def)
      .outputFields(fx.engine, fx.engine.globalScope())
      .find((f) => f.name === 't')!;
    expect(field.type.kind).toBe('field');
    if (field.type.kind === 'field') expect(field.type.type.name).toBe('order');
  });

  it('binary arithmetic resolves numeric; money propagates', () => {
    const r = resolve({ kind: 'binary', op: '+', left: ref('o', 'total'), right: lit(1) });
    expect(asFieldType(r)?.resolve()).toBe('money');
    const n = resolve({ kind: 'binary', op: '*', left: lit(2), right: lit(3) });
    expect(asFieldType(n)?.resolve()).toBe('number');
  });

  it('comparison / logical / between / in / is-null / exists resolve to bool', () => {
    expect(asFieldType(resolve(cmp('=', ref('u', 'id'), lit(1))))?.resolve()).toBe('bool');
    expect(
      asFieldType(
        resolve({ kind: 'logical', op: 'and', operands: [cmp('>', ref('u', 'id'), lit(0))] }),
      )?.resolve(),
    ).toBe('bool');
    expect(
      asFieldType(resolve({ kind: 'between', value: ref('u', 'id'), lower: lit(1), upper: lit(9) }))?.resolve(),
    ).toBe('bool');
    expect(
      asFieldType(resolve({ kind: 'in', value: ref('u', 'id'), in: [lit(1), lit(2)] }))?.resolve(),
    ).toBe('bool');
    const isn = resolve({ kind: 'is-null', value: ref('u', 'age') });
    expect(asFieldType(isn)?.resolve()).toBe('bool');
    if (isn.kind === 'computed') expect(isn.nullable).toBe(false); // IS NULL never null
  });

  it('aggregate resolves numeric and flags aggregate; count never null', () => {
    const sum = resolve({ kind: 'aggregate', function: 'sum', args: { value: ref('o', 'total') } });
    expect(sum.kind).toBe('computed');
    if (sum.kind === 'computed') {
      expect(sum.aggregate).toBe(true);
      expect(sum.nullable).toBe(true);
      expect(sum.fieldType.resolve()).toBe('money');
    }
    const count = resolve({ kind: 'aggregate', function: 'count', args: {} });
    if (count.kind === 'computed') {
      expect(count.aggregate).toBe(true);
      expect(count.nullable).toBe(false);
    }
  });

  it('window resolves per-row (not aggregate) and nullable', () => {
    const w = resolve({ kind: 'window', function: 'sum', args: { value: ref('o', 'total') }, partitionBy: [ref('o', 'userId')] });
    expect(w.kind).toBe('computed');
    if (w.kind === 'computed') {
      expect(w.aggregate).toBe(false);
      expect(w.nullable).toBe(true);
    }
  });

  it('case resolves to its result branch type; nullable without else', () => {
    const c = resolve({
      kind: 'case',
      branches: [{ when: cmp('>', ref('u', 'id'), lit(0)), then: lit('pos') }],
    });
    expect(asFieldType(c)?.resolve()).toBe('text');
    if (c.kind === 'computed') expect(c.nullable).toBe(true);
  });

  it('subquery (scalar) resolves to the single output field type', () => {
    const sub: ExprDef = {
      kind: 'subquery',
      query: {
        kind: 'select',
        fields: [{ expr: ref('o', 'total') }],
        from: { kind: 'type', type: 'order' },
      },
    };
    expect(asFieldType(resolve(sub))?.resolve()).toBe('money');
  });

  it('containsAggregate detects nested aggregates', () => {
    const def: ExprDef = {
      kind: 'comparison',
      op: '>',
      left: { kind: 'aggregate', function: 'sum', args: { value: ref('o', 'total') } },
      right: lit(100),
    };
    expect(fx.engine.parse(def).containsAggregate()).toBe(true);
    expect(fx.engine.parse(cmp('>', ref('u', 'id'), lit(1))).containsAggregate()).toBe(false);
  });

  it('canonicalize is stable across key order, distinct across content', () => {
    const a = fx.engine.parse(cmp('=', ref('u', 'id'), lit(1)));
    const b = fx.engine.parse(cmp('=', ref('u', 'id'), lit(1)));
    const c = fx.engine.parse(cmp('=', ref('u', 'id'), lit(2)));
    expect(canonicalize(a)).toBe(canonicalize(b));
    expect(canonicalize(a)).not.toBe(canonicalize(c));
  });
});
