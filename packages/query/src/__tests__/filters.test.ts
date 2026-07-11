/**
 * `filters` placeholders — validation, execution-time bool-expr binding, and the
 * `query.filters(engine)` / `walkExprs` introspection surface.
 *
 * A `filters` placeholder authors just `{ source, fields? }`; the actual bool
 * predicate is supplied per source at EXECUTION time (`engine.run({ filters })`),
 * and `query.filters(engine)` reports which sources a query exposes + the fields
 * each offers.
 */
import { describe, it, expect } from 'vitest';
import { fixture, runtimeFixture, ref, lit, cmp } from './_utils';
import type { Expr } from '../expr';
import type { ExprDef, QueryDef } from '../schema';

describe('filters: validation problems', () => {
  const fx = fixture();
  const scope = fx.engine.globalScope();
  scope.bind('u', { kind: 'type', type: fx.user, source: 'u', synthetic: false });
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

  it('filters users by age >= 40 (bool ExprDef supplied at run time)', async () => {
    const fx = runtimeFixture();
    const filter: ExprDef = cmp('>=', ref('user', 'age'), lit(40));
    const result = await fx.engine.run(usersDef(), { filters: { user: filter } });
    expect(result.rows.map((r) => r['name'])).toEqual(['Bob']);
  });

  it('filters users by a name substring (LIKE)', async () => {
    const fx = runtimeFixture();
    const filter: ExprDef = cmp('like', ref('user', 'name'), lit('%o%'));
    const result = await fx.engine.run(usersDef(), { filters: { user: filter } });
    expect(result.rows.map((r) => r['name']).sort()).toEqual(['Bob', 'Cleo']);
  });

  it('a text-search bool expr binds (email is search-flagged)', async () => {
    const fx = runtimeFixture();
    const filter: ExprDef = { kind: 'text-search', source: 'user', field: 'email', query: 'ada' };
    const result = await fx.engine.run(usersDef(), { filters: { user: filter } });
    expect(result.rows.map((r) => r['name'])).toEqual(['Ada']);
  });
});

describe('query.filters(engine) introspection', () => {
  /** A SELECT whose WHERE carries a `filters` placeholder over `user`. */
  const withFilters = (fields?: string[]): QueryDef => ({
    kind: 'select',
    fields: [{ expr: ref('user', 'name') }],
    from: { kind: 'type', type: 'user' },
    where: [fields ? { kind: 'filters', source: 'user', fields } : { kind: 'filters', source: 'user' }],
  });

  it('reports the source → its bound Type fields (no allowlist ⇒ every field)', () => {
    const fx = fixture();
    const q = fx.registry.parseQuery(withFilters());
    const exposed = q.filters(fx.engine);
    expect(Object.keys(exposed)).toEqual(['user']);
    const names = exposed['user']!.fields.map((f) => f.name).sort();
    // `orders` is the materialized inverse relation, so it appears too.
    expect(names).toEqual(['age', 'email', 'id', 'name', 'orders', 'tags'].sort());
    const byName = new Map(exposed['user']!.fields.map((f) => [f.name, f]));
    expect(byName.get('age')!.fieldType).toBe('number');
    expect(byName.get('age')!.nullable).toBe(true);
    expect(byName.get('orders')!.fieldType).toBe('relation');
  });

  it('honors the `fields` allowlist (restricted to listed fields)', () => {
    const fx = fixture();
    const q = fx.registry.parseQuery(withFilters(['age', 'email']));
    // Pass an explicit scope (exercises the non-default scope path too).
    const exposed = q.filters(fx.engine, fx.engine.globalScope());
    expect(exposed['user']!.fields.map((f) => f.name).sort()).toEqual(['age', 'email']);
  });

  it('a query with no `filters` placeholder returns {}', () => {
    const fx = fixture();
    const q = fx.registry.parseQuery({
      kind: 'select',
      fields: [{ expr: ref('user', 'name') }],
      from: { kind: 'type', type: 'user' },
      where: [cmp('>', ref('user', 'age'), lit(0))],
    });
    expect(q.filters(fx.engine)).toEqual({});
  });

  it('skips a placeholder whose source does not resolve to a bound Type', () => {
    const fx = fixture();
    const q = fx.registry.parseQuery({
      kind: 'select',
      fields: [{ expr: ref('user', 'name') }],
      from: { kind: 'type', type: 'user' },
      where: [{ kind: 'filters', source: 'nope' }],
    });
    expect(q.filters(fx.engine)).toEqual({});
  });

  it('last-wins when one source appears in two placeholders', () => {
    const fx = fixture();
    const q = fx.registry.parseQuery({
      kind: 'select',
      fields: [{ expr: ref('user', 'name') }],
      from: { kind: 'type', type: 'user' },
      where: [
        { kind: 'filters', source: 'user', fields: ['age'] },
        { kind: 'filters', source: 'user', fields: ['email'] },
      ],
    });
    expect(q.filters(fx.engine)['user']!.fields.map((f) => f.name)).toEqual(['email']);
  });

  it('a non-SELECT query (base walkExprs / filterScope) exposes no filters', () => {
    const fx = fixture();
    const q = fx.registry.parseQuery({ kind: 'expr', expr: lit(true) });
    expect(q.filters(fx.engine)).toEqual({});
  });
});

describe('Query.walkExprs', () => {
  it('visits every clause expr (fields / where / groupBy / having / order / join.and)', () => {
    const fx = fixture();
    const def: QueryDef = {
      kind: 'select',
      fields: [{ expr: ref('user', 'name') }],
      from: { kind: 'type', type: 'user' },
      joins: [{ on: { kind: 'relation', source: 'user', field: 'orders', as: 'order' }, and: cmp('>', ref('order', 'total'), lit(0)) }],
      where: [{ kind: 'filters', source: 'user' }],
      groupBy: [ref('user', 'name')],
      having: [cmp('>', ref('user', 'age'), lit(0))],
      order: [{ expr: ref('user', 'name'), dir: 'asc' }],
    };
    const kinds: string[] = [];
    fx.registry.parseQuery(def).walkExprs((e: Expr) => kinds.push(e.kind));
    // A `filters` placeholder in WHERE, plus exprs from every other clause.
    expect(kinds).toContain('filters');
    expect(kinds).toContain('comparison'); // having / join.and
    expect(kinds.filter((k) => k === 'field-ref').length).toBeGreaterThan(0);
  });

  it('handles a join without an `and` predicate', () => {
    const fx = fixture();
    const q = fx.registry.parseQuery({
      kind: 'select',
      fields: [{ expr: ref('user', 'name') }],
      from: { kind: 'type', type: 'user' },
      joins: [{ on: { kind: 'relation', source: 'user', field: 'orders', as: 'order' } }],
    });
    const kinds: string[] = [];
    q.walkExprs((e: Expr) => kinds.push(e.kind));
    expect(kinds).toEqual(['field-ref']);
  });
});
