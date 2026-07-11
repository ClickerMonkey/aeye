/**
 * Coverage: Field clone/toCode, Type toSchema/clone/toCode/identityField edges,
 * QueryFunction resolveOutput + validateCall edge paths, Expr base
 * validate/toJSONCode + BoolExpr aggregate resolution.
 */
import { describe, it, expect } from 'vitest';
import { fixture } from './_utils';
import { createRegistry } from '../registry';
import { Type } from '../type';
import { Field } from '../field';
import { Index, IndexPart } from '../index-spec';
import { QueryFunction } from '../function';
import { Problems } from '../problem';
import type { ExprDef } from '../schema';
import type { ResolvedType, TypeResolved } from '../resolved-type';

describe('Field clone + toCode', () => {
  it('clones deeply and renders a short description', () => {
    const fx = fixture();
    const name = fx.user.field('name')!;
    const age = fx.user.field('age')!; // nullable
    const clone = name.clone();
    expect(clone).not.toBe(name);
    expect(clone.fieldType).not.toBe(name.fieldType);
    expect(clone.toJSON()).toEqual(name.toJSON());
    expect(name.toCode()).toBe('name: text');
    expect(age.toCode()).toBe('age?: number');
  });
});

describe('Type toSchema / clone / toCode / identityField edges', () => {
  it('toSchema builds a zod object (with + without an Expr override)', () => {
    const bare = Type.toSchema();
    expect(bare.safeParse({ name: 't', fields: [], count: 1, bytes: 1 }).success).toBe(true);
    const withExpr = Type.toSchema({ Expr: Type.toSchema() });
    expect(withExpr).toBeTruthy();
  });

  it('clone + toCode', () => {
    const fx = fixture();
    const clone = fx.user.clone();
    expect(clone).not.toBe(fx.user);
    expect(clone.toJSON()).toEqual(fx.user.toJSON());
    expect(fx.user.toCode()).toContain('type user {');
    expect(fx.user.toCode()).toContain('name: text');
  });

  it('identityField skips multi-part / non-unique / non-field-ref / missing-field indexes, then id', () => {
    const registry = createRegistry();
    const ref = (field: string): ExprDef => ({ kind: 'field-ref', source: 't', field });
    const num = registry.parseFieldType({ kind: 'number', whole: true });
    const type = new Type({
      name: 't',
      fields: [new Field({ name: 'id', fieldType: num }), new Field({ name: 'a', fieldType: num })],
      indexes: [
        new Index([new IndexPart(ref('a'), 1), new IndexPart(ref('id'), 1)]), // 2 parts → skip
        new Index([new IndexPart(ref('a'), 5)]), // non-unique → skip
        new Index([new IndexPart({ kind: 'literal', value: 1 }, 1)]), // not field-ref → skip
        new Index([new IndexPart(ref('ghost'), 1)]), // field-ref to missing field → skip
      ],
      count: 10,
      bytes: 8,
    });
    expect(type.identityField().name).toBe('id');
  });
});

describe('QueryFunction resolveOutput + validateCall edges', () => {
  const fx = fixture();
  const typeArg: TypeResolved = { kind: 'type', type: fx.user, source: 'user', synthetic: false };

  it('from throws for a tabular output referencing an unknown Type', () => {
    expect(() =>
      QueryFunction.from({ name: 'bad', shape: 'tabular', params: [], output: { type: 'nope' } }, fx.registry),
    ).toThrow(/unknown Type/);
  });

  it('inferred output with only a Type-kind arg returns that arg unchanged', () => {
    const fn = QueryFunction.from(
      { name: 'f', shape: 'scalar', params: [{ name: 'x', type: 'any' }], output: 'inferred' },
      fx.registry,
    );
    const out = fn.resolveOutput(new Map<string, ResolvedType>([['x', typeArg]]));
    expect(out).toBe(typeArg);
  });

  it('inferred output with no args + no typed params throws', () => {
    const fn = QueryFunction.from({ name: 'g', shape: 'scalar', params: [], output: 'inferred' }, fx.registry);
    expect(() => fn.resolveOutput(new Map())).toThrow(/cannot infer output type/);
  });

  it('validateCall rejects a Type passed where a scalar is expected', () => {
    const fn = QueryFunction.from(
      { name: 'h', shape: 'scalar', params: [{ name: 'x', type: { kind: 'number' } }], output: { kind: 'number' } },
      fx.registry,
    );
    const p = new Problems();
    fn.validateCall(new Map<string, ResolvedType>([['x', typeArg]]), p);
    expect(p.list.some((pr) => pr.code === 'function.arg-type')).toBe(true);
  });
});

describe('Expr base validate / toJSONCode + BoolExpr aggregate resolution', () => {
  const fx = fixture();
  const scope = fx.engine.globalScope();
  scope.bind('order', { kind: 'type', type: fx.order, source: 'order', synthetic: false });

  it('validate entry works with and without an explicit scope', () => {
    const litExpr = fx.registry.parseExpr({ kind: 'literal', value: 1 });
    expect(litExpr.validate(fx.engine).hasErrors).toBe(false);
    expect(litExpr.validate(fx.engine, scope).hasErrors).toBe(false);
  });

  it('toJSONCode renders JSON with a span, honoring level indentation', () => {
    const litExpr = fx.registry.parseExpr({ kind: 'literal', value: 1 });
    const base = litExpr.toJSONCode();
    expect(base.toString()).toContain('literal');
    expect(base.spanFor([])).toBeDefined();
    const nested = litExpr.toJSONCode(['a'], 2, 1);
    expect(nested.toString()).toContain('literal');
  });

  it('a boolean predicate over an aggregate resolves as aggregate-flavored', () => {
    const cmpAgg: ExprDef = {
      kind: 'comparison',
      op: '>',
      left: { kind: 'aggregate', function: 'sum', args: { value: { kind: 'field-ref', source: 'order', field: 'total' } } },
      right: { kind: 'literal', value: 0 },
    };
    const rt = fx.registry.parseExpr(cmpAgg).resolve(fx.engine, scope);
    expect(rt.kind).toBe('computed');
    if (rt.kind === 'computed') expect(rt.aggregate).toBe(true);
  });
});
