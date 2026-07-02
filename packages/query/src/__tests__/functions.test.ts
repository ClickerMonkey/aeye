import { describe, it, expect } from 'vitest';
import { fixture, typeScope, lit, ref } from './_utils';
import type { ExprDef, FunctionDef } from '../schema';

const fx = fixture();

const upper: FunctionDef = {
  name: 'upper',
  shape: 'scalar',
  params: [{ name: 's', type: { kind: 'text' } }],
  output: { kind: 'text' },
};
const totalSum: FunctionDef = {
  name: 'total_sum',
  shape: 'aggregate',
  params: [{ name: 'x', type: { kind: 'number' } }],
  output: { kind: 'number' },
};
const recentOrders: FunctionDef = {
  name: 'recent_orders',
  shape: 'tabular',
  params: [],
  output: { type: 'order' },
};
const coalesce: FunctionDef = {
  name: 'coalesce',
  shape: 'scalar',
  params: [
    { name: 'a', type: 'any' },
    { name: 'b', type: 'any', optional: true },
  ],
  output: 'inferred',
};

fx.registry.registerFunction(upper);
fx.registry.registerFunction(totalSum);
fx.registry.registerFunction(recentOrders);
fx.registry.registerFunction(coalesce);

const scope = typeScope(fx);
const call = (fn: string, args: Record<string, ExprDef> = {}): ExprDef => ({
  kind: 'function-call',
  function: fn,
  args,
});

describe('function output resolution', () => {
  it('scalar function returns its declared field type', () => {
    const r = fx.engine.resolveExpr(call('upper', { s: ref('u', 'name') }), scope);
    expect(r.kind).toBe('computed');
    if (r.kind === 'computed') {
      expect(r.fieldType.resolve()).toBe('text');
      expect(r.aggregate).toBe(false);
    }
  });

  it('aggregate function flags aggregate', () => {
    const r = fx.engine.resolveExpr(call('total_sum', { x: ref('o', 'total') }), scope);
    if (r.kind === 'computed') {
      expect(r.fieldType.resolve()).toBe('number');
      expect(r.aggregate).toBe(true);
    }
  });

  it('tabular function resolves to its Type as a type', () => {
    const r = fx.engine.resolveExpr({ kind: 'tabular-function-call', function: 'recent_orders', args: {} }, scope);
    expect(r.kind).toBe('type');
    if (r.kind === 'type') expect(r.type.name).toBe('order');
  });

  it("'inferred' output mirrors the first argument's type", () => {
    const r = fx.engine.resolveExpr(call('coalesce', { a: ref('u', 'id'), b: lit(0) }), scope);
    expect(r.kind === 'computed' && r.fieldType.resolve()).toBe('number');
  });
});

describe('function call validation (named args)', () => {
  it('rejects a missing required arg', () => {
    const p = fx.engine.validateExpr(call('upper'), scope);
    expect(p.list.some((x) => x.code === 'function.missing-arg')).toBe(true);
  });

  it('rejects an unknown arg name at its path', () => {
    const p = fx.engine.validateExpr(call('upper', { s: ref('u', 'name'), extra: lit(1) }), scope);
    const prob = p.list.find((x) => x.code === 'function.unknown-arg');
    expect(prob).toBeDefined();
    expect(prob?.path).toEqual(['args', 'extra']);
  });

  it('rejects a type-incompatible argument at its named path', () => {
    const p = fx.engine.validateExpr(call('upper', { s: ref('u', 'id') }), scope);
    const prob = p.list.find((x) => x.code === 'function.arg-type');
    expect(prob).toBeDefined();
    expect(prob?.path).toEqual(['args', 's']);
  });

  it('rejects an unknown function', () => {
    const p = fx.engine.validateExpr(call('nope', { a: lit(1) }), scope);
    expect(p.list.some((x) => x.code === 'function.unknown')).toBe(true);
  });

  it('accepts a valid call', () => {
    expect(fx.engine.validateExpr(call('upper', { s: ref('u', 'name') }), scope).hasErrors).toBe(false);
  });

  it('rejects a non-tabular function used as a type function', () => {
    const p = fx.engine.validateExpr(
      { kind: 'tabular-function-call', function: 'upper', args: { s: ref('u', 'name') } },
      scope,
    );
    expect(p.list.some((x) => x.code === 'tabular-function.not-tabular')).toBe(true);
  });
});
