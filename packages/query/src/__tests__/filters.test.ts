/**
 * Phase 4 — per-FieldType filter-operator catalog + `FiltersExpr` compilation.
 */
import { describe, it, expect } from 'vitest';
import { fixture, typeScope, runtimeFixture } from './_utils';
import { catalogForFieldType, compileFilters } from '../filters';
import { FiltersExpr } from '../exprs/index';
import {
  NumberFieldType,
  MoneyFieldType,
  BoolFieldType,
  DateFieldType,
  TimestampFieldType,
  JsonFieldType,
  RelationFieldType,
  TextFieldType,
  ArrayFieldType,
} from '../field-types/index';
import type { FieldType } from '../field-type';
import type { ExprDef, QueryDef } from '../schema';

/** Op names of a field type's catalog, in catalog order. */
const opNames = (ft: FieldType): string[] => catalogForFieldType(ft).map((o) => o.op);

describe('filters: per-FieldType operator catalog', () => {
  it('number / money / date / timestamp share the comparable op set', () => {
    const expected = ['eq', 'neq', 'lt', 'lte', 'gt', 'gte', 'in', 'notIn', 'between', 'isNull', 'notNull'];
    expect(opNames(new NumberFieldType())).toEqual(expected);
    expect(opNames(new MoneyFieldType())).toEqual(expected);
    expect(opNames(new DateFieldType())).toEqual(expected);
    expect(opNames(new TimestampFieldType())).toEqual(expected);
  });

  it('text has the string op set; search/similar only when flagged', () => {
    const base = ['eq', 'neq', 'contains', 'startsWith', 'endsWith', 'like', 'ilike', 'in', 'notIn', 'isNull', 'notNull'];
    expect(opNames(new TextFieldType())).toEqual(base);
    expect(opNames(new TextFieldType({ search: true }))).toEqual([...base, 'search']);
    expect(opNames(new TextFieldType({ semantic: true }))).toEqual([...base, 'similar']);
    expect(opNames(new TextFieldType({ search: true, semantic: true }))).toEqual([...base, 'search', 'similar']);
  });

  it('bool / relation / json have their narrow op sets', () => {
    expect(opNames(new BoolFieldType())).toEqual(['eq', 'neq', 'isNull', 'notNull']);
    expect(opNames(new RelationFieldType('order', 5))).toEqual(['exists', 'notExists', 'anyMatch']);
    expect(opNames(new JsonFieldType())).toEqual(['eq', 'isNull', 'notNull', 'hasKey', 'pathEq']);
  });

  it('array has the containment / length / null op set', () => {
    expect(opNames(new ArrayFieldType(new TextFieldType()))).toEqual([
      'contains', 'containsAny', 'containsAll', 'isEmpty', 'notEmpty',
      'lengthEq', 'lengthGt', 'lengthGte', 'lengthLt', 'lengthLte',
      'isNull', 'notNull',
    ]);
  });

  it('FieldType.filterOps() delegates to the catalog', () => {
    expect(new NumberFieldType().filterOps().map((o) => o.op)).toEqual(opNames(new NumberFieldType()));
  });

  it('each op exposes an arity and a value schema', () => {
    const num = new NumberFieldType();
    const ops = catalogForFieldType(num);
    const eq = ops.find((o) => o.op === 'eq');
    const between = ops.find((o) => o.op === 'between');
    const isNull = ops.find((o) => o.op === 'isNull');
    const inOp = ops.find((o) => o.op === 'in');
    expect(eq?.arity).toBe('binary');
    expect(between?.arity).toBe('range');
    expect(isNull?.arity).toBe('unary');
    expect(inOp?.arity).toBe('list');
    // value schemas accept / reject correctly
    expect(eq?.valueSchema(num).safeParse(5).success).toBe(true);
    expect(inOp?.valueSchema(num).safeParse([1, 2]).success).toBe(true);
    expect(between?.valueSchema(num).safeParse([1, 2]).success).toBe(true);
    expect(between?.valueSchema(num).safeParse([1]).success).toBe(false);
  });
});

describe('filters: expand (builder menu)', () => {
  it('lists each field with its allowed ops', () => {
    const fx = fixture();
    const scope = typeScope(fx);
    const expr = FiltersExpr.from({ kind: 'filters', source: 'u' }, fx.registry);
    const menu = expr.expand(fx.engine, scope);
    const byField = new Map(menu.map((m) => [m.field.name, m.ops.map((o) => o.op)]));
    expect(byField.get('age')).toContain('between');
    expect(byField.get('email')).toContain('search'); // email is search-flagged
    expect(byField.get('orders')).toEqual(['exists', 'notExists', 'anyMatch']);
  });

  it('honors the `fields` allowlist (menu restricted to listed fields)', () => {
    const fx = fixture();
    const scope = typeScope(fx);
    const expr = FiltersExpr.from({ kind: 'filters', source: 'u', fields: ['age', 'email'] }, fx.registry);
    const menu = expr.expand(fx.engine, scope);
    expect(menu.map((m) => m.field.name).sort()).toEqual(['age', 'email']);
  });
});

describe('filters: validation problems', () => {
  const fx = fixture();
  const scope = typeScope(fx);
  const validate = (filters: ExprDef) => fx.engine.validateExpr(filters, scope);

  it('reports an unknown source', () => {
    const p = validate({ kind: 'filters', source: 'nope' });
    expect(p.list.some((x) => x.code === 'filters.unknown-source')).toBe(true);
  });

  it('reports an unknown field in the `fields` allowlist at fields[i]', () => {
    const p = validate({ kind: 'filters', source: 'u', fields: ['nope'] });
    const prob = p.list.find((x) => x.code === 'filters.unknown-field');
    expect(prob).toBeDefined();
    expect(prob?.path).toEqual(['fields', 0]);
  });

  it('a bare source (no allowlist) validates clean', () => {
    expect(validate({ kind: 'filters', source: 'u' }).hasErrors).toBe(false);
  });
});

describe('filters: compileFilters builds the bool Expr', () => {
  it('compiles a single clause to the op\'s boolean expr (comparison)', () => {
    const fx = fixture();
    const expr = compileFilters('u', [{ field: 'age', op: 'gte', value: 40 }], fx.registry);
    expect(expr.toJSON()).toEqual({
      kind: 'comparison',
      op: '>=',
      left: { kind: 'field-ref', source: 'u', field: 'age' },
      right: { kind: 'literal', value: 40 },
    });
  });

  it('AND-combines multiple clauses into a logical `and`', () => {
    const fx = fixture();
    const expr = compileFilters(
      'u',
      [
        { field: 'age', op: 'gte', value: 18 },
        { field: 'name', op: 'contains', value: 'o' },
      ],
      fx.registry,
    );
    const def = expr.toJSON();
    expect(def.kind).toBe('logical');
    if (def.kind === 'logical') {
      expect(def.op).toBe('and');
      expect(def.operands.length).toBe(2);
      expect(def.operands[0]!.kind).toBe('comparison');
      // `contains` lowers to a LIKE comparison with `%o%`.
      expect(def.operands[1]!.kind).toBe('comparison');
    }
  });

  it('zero clauses ⇒ a constant TRUE literal', () => {
    const fx = fixture();
    expect(compileFilters('u', [], fx.registry).toJSON()).toEqual({ kind: 'literal', value: true });
  });

  it('an unknown op throws', () => {
    const fx = fixture();
    expect(() => compileFilters('u', [{ field: 'age', op: 'nope', value: 1 }], fx.registry)).toThrow(/unknown filter op/);
  });
});

describe('filters: execution-time bool expr over the in-memory dataset', () => {
  /** SELECT name FROM user WHERE <filters placeholder over `user`>. */
  const usersDef = (fields?: string[]): QueryDef => ({
    kind: 'select',
    fields: [{ expr: { kind: 'field-ref', source: 'user', field: 'name' } }],
    from: { kind: 'type', type: 'user' },
    where: [fields ? { kind: 'filters', source: 'user', fields } : { kind: 'filters', source: 'user' }],
  });

  it('no filter ⇒ a vacuous TRUE (all rows)', async () => {
    const fx = runtimeFixture();
    const result = await fx.engine.run(usersDef());
    expect(result.rows.length).toBe(3);
  });

  it('filters users by age >= 40 (bool expr supplied at run time)', async () => {
    const fx = runtimeFixture();
    const filter = compileFilters('user', [{ field: 'age', op: 'gte', value: 40 }], fx.registry);
    const result = await fx.engine.run(usersDef(), { filters: { user: filter } });
    expect(result.rows.map((r) => r['name'])).toEqual(['Bob']);
  });

  it('filters users by a name substring (contains)', async () => {
    const fx = runtimeFixture();
    const filter = compileFilters('user', [{ field: 'name', op: 'contains', value: 'o' }], fx.registry);
    const result = await fx.engine.run(usersDef(), { filters: { user: filter } });
    expect(result.rows.map((r) => r['name']).sort()).toEqual(['Bob', 'Cleo']);
  });

  it('the `search` op compiles to text-search (email is search-flagged)', async () => {
    const fx = runtimeFixture();
    const filter = compileFilters('user', [{ field: 'email', op: 'search', value: 'ada' }], fx.registry);
    const result = await fx.engine.run(usersDef(), { filters: { user: filter } });
    expect(result.rows.map((r) => r['name'])).toEqual(['Ada']);
  });
});
