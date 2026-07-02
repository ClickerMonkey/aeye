import { describe, it, expect } from 'vitest';
import { fixture, typeScope, lit, ref, cmp } from './_utils';
import type { Problems } from '../problem';
import type { ExprDef } from '../schema';

const fx = fixture();
const scope = typeScope(fx);

function codes(p: Problems): string[] {
  return p.list.map((x) => x.code);
}
function find(p: Problems, code: string) {
  return p.list.find((x) => x.code === code);
}

describe('expr validation', () => {
  it('reports an unknown source', () => {
    const p = fx.engine.validateExpr(ref('zzz', 'id'), scope);
    expect(codes(p)).toContain('ref.unknown-source');
  });

  it('reports an unknown field with a path into the ref', () => {
    const p = fx.engine.validateExpr(ref('u', 'nope'), scope);
    const prob = find(p, 'ref.unknown-field');
    expect(prob).toBeDefined();
    expect(prob?.path).toEqual([]); // top-level expr
  });

  it('reports a type-incompatible comparison', () => {
    // comparing a text field with a number literal
    const p = fx.engine.validateExpr(cmp('=', ref('u', 'name'), lit(5)), scope);
    expect(codes(p)).toContain('comparison.type');
  });

  it('LIKE on a non-text operand is rejected at the operand path', () => {
    const p = fx.engine.validateExpr(cmp('like', ref('u', 'id'), lit('x')), scope);
    const prob = find(p, 'comparison.like');
    expect(prob).toBeDefined();
    expect(prob?.path).toEqual(['left']);
  });

  it('aggregate outside an allowed context is rejected', () => {
    const agg: ExprDef = { kind: 'aggregate', function: 'sum', args: { value: ref('o', 'total') } };
    const p = fx.engine.validateExpr(agg, scope, { allowAggregate: false });
    expect(codes(p)).toContain('aggregate.not-allowed');
  });

  it('nested aggregate is rejected', () => {
    const nested: ExprDef = {
      kind: 'aggregate',
      function: 'sum', args: { value: { kind: 'aggregate', function: 'sum', args: { value: ref('o', 'total') } } },
    };
    const p = fx.engine.validateExpr(nested, scope);
    expect(codes(p)).toContain('aggregate.nested');
  });

  it('count(*) is fine but sum() (no value) is a missing-arg error', () => {
    expect(fx.engine.validateExpr({ kind: 'aggregate', function: 'count', args: {} }, scope).hasErrors).toBe(false);
    const bad = fx.engine.validateExpr({ kind: 'aggregate', function: 'sum', args: {} }, scope);
    expect(codes(bad)).toContain('function.missing-arg');
  });

  it('sum of a non-numeric arg is rejected at the named arg path', () => {
    const p = fx.engine.validateExpr({ kind: 'aggregate', function: 'sum', args: { value: ref('u', 'name') } }, scope);
    const prob = find(p, 'function.arg-type');
    expect(prob).toBeDefined();
    expect(prob?.path).toEqual(['args', 'value']);
  });

  it('window cannot appear inside an aggregate', () => {
    const def: ExprDef = {
      kind: 'aggregate',
      function: 'sum', args: { value: { kind: 'window', function: 'row_number', args: {}, orderBy: [{ expr: ref('o', 'id'), dir: 'asc' }] } },
    };
    const p = fx.engine.validateExpr(def, scope);
    expect(codes(p)).toContain('window.in-aggregate');
  });

  it('a valid comparison produces no errors', () => {
    const p = fx.engine.validateExpr(cmp('>', ref('u', 'id'), lit(10)), scope);
    expect(p.hasErrors).toBe(false);
  });

  it('filters validates the source + each listed field exists', () => {
    // No allowlist ⇒ the bare source placeholder validates clean.
    const ok: ExprDef = { kind: 'filters', source: 'u' };
    expect(fx.engine.validateExpr(ok, scope).hasErrors).toBe(false);
    // A `fields` allowlist with a known field validates.
    const okFields: ExprDef = { kind: 'filters', source: 'u', fields: ['id'] };
    expect(fx.engine.validateExpr(okFields, scope).hasErrors).toBe(false);
    // An unknown field in the allowlist is reported.
    const badField: ExprDef = { kind: 'filters', source: 'u', fields: ['nope'] };
    expect(codes(fx.engine.validateExpr(badField, scope))).toContain('filters.unknown-field');
    // An unknown source is reported.
    const badSource: ExprDef = { kind: 'filters', source: 'nope' };
    expect(codes(fx.engine.validateExpr(badSource, scope))).toContain('filters.unknown-source');
  });
});
