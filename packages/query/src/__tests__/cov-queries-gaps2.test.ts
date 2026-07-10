/**
 * Coverage: the last reachable loop-`continue` / nullish / degrade branches —
 * a two-index cost reduction, an INSERT…SELECT null column, no-alias RETURNING
 * toJSON, a non-numeric LIMIT/OFFSET param (SELECT + set-op), an unresolvable
 * join in SQL/runtime, a relation to an unknown target type, a missing foreign
 * key, a FROM over an unregistered name, and a recursive CTE arm reading a real
 * type.
 */
import { describe, it, expect } from 'vitest';
import { createRegistry } from '../registry';
import { QueryEngine } from '../engine';
import { arrayExecutor } from '../runtime/executor';
import { runtimeFixture, fixture } from './_utils';
import type { TypeDef, SelectDef, InsertDef, DeleteDef, SetOperationDef, CTEStatementDef } from '../schema';

describe('_cost — two matching indexes take the MIN prefix reduction', () => {
  it('reduces by the tighter of two indexes that both cover the equality', () => {
    const registry = createRegistry();
    const twoIdx: TypeDef = {
      name: 'twoIdx',
      fields: [
        { name: 'id', type: { kind: 'number', whole: true } },
        { name: 'age', type: { kind: 'number', whole: true } },
      ],
      // BOTH indexes lead with `id`, so an id-equality matches each ⇒ the second
      // match folds via `Math.min(best, r)` (the tighter, unique, reduction).
      indexes: [
        { exprs: [{ expr: { kind: 'field-ref', source: 'twoIdx', field: 'id' }, count: 5 }] },
        { exprs: [{ expr: { kind: 'field-ref', source: 'twoIdx', field: 'id' }, count: 1 }] },
      ],
      count: 1000,
      bytes: 16,
    };
    const t = registry.parseType(twoIdx);
    registry.registerType(t);
    registry.finalize();
    const engine = new QueryEngine(registry);
    const def: SelectDef = {
      kind: 'select',
      fields: [{ expr: { kind: 'field-ref', source: 'twoIdx', field: 'id' }, as: 'id' }],
      from: { kind: 'type', type: 'twoIdx' },
      where: [{ kind: 'comparison', op: '=', left: { kind: 'field-ref', source: 'twoIdx', field: 'id' }, right: { kind: 'literal', value: 1 } }],
    };
    // Unique id index ⇒ collapses to 1 row.
    expect(engine.cost(def).rows).toBe(1);
  });
});

describe('InsertQuery — INSERT…SELECT with a null-valued source column', () => {
  it('carries a null selected value into the inserted column', async () => {
    const fx = runtimeFixture();
    const def: InsertDef = {
      kind: 'insert',
      into: 'order',
      select: {
        kind: 'select',
        // order 11 has a null `note`.
        fields: [{ expr: { kind: 'field-ref', source: 'order', field: 'note' }, as: 'note' }],
        from: { kind: 'type', type: 'order' },
        where: [{ kind: 'comparison', op: '=', left: { kind: 'field-ref', source: 'order', field: 'id' }, right: { kind: 'literal', value: 11 } }],
      },
      returning: [{ expr: { kind: 'field-ref', source: 'order', field: 'note' } }],
    };
    const res = await fx.engine.run(def);
    expect(res.rows).toEqual([{ note: null }]);
  });

  it('toJSON keeps an un-aliased RETURNING expr (and serializes an INSERT…SELECT)', () => {
    const fx = runtimeFixture();
    const def: InsertDef = {
      kind: 'insert',
      into: 'user',
      rows: [{ name: { kind: 'literal', value: 'Q' } }],
      returning: [{ expr: { kind: 'field-ref', source: 'user', field: 'id' } }],
    };
    expect(fx.engine.parseQuery(def).toJSON()).toEqual(def);
  });
});

describe('numericBound — a non-numeric LIMIT/OFFSET param resolves to "unbounded"', () => {
  it('SELECT ignores a non-numeric limit param', async () => {
    const fx = runtimeFixture();
    const def: SelectDef = {
      kind: 'select',
      fields: [{ expr: { kind: 'field-ref', source: 'user', field: 'id' }, as: 'id' }],
      from: { kind: 'type', type: 'user' },
      limit: { kind: 'param', name: 'lim' },
    };
    // 'abc' ⇒ NaN ⇒ undefined bound ⇒ no slicing.
    const res = await fx.engine.run(def, { params: { lim: 'abc' } });
    expect(res.rows.length).toBe(3);
  });

  it('set-op ignores a non-numeric offset param', async () => {
    const fx = runtimeFixture();
    const left: SelectDef = {
      kind: 'select',
      fields: [{ expr: { kind: 'field-ref', source: 'user', field: 'id' }, as: 'id' }],
      from: { kind: 'type', type: 'user' },
    };
    const def: SetOperationDef = { kind: 'union', left, right: left, offset: { kind: 'param', name: 'off' }, limit: { kind: 'param', name: 'lim' } };
    const res = await fx.engine.run(def, { params: { off: 'xyz', lim: 'pqr' } });
    expect(res.rows.length).toBe(3);
  });
});

describe('unresolvable joins — skipped in SQL emission and runtime expansion', () => {
  it('a non-relation join is skipped when emitting SELECT SQL', () => {
    const fx = fixture();
    const def: SelectDef = {
      kind: 'select',
      fields: [{ expr: { kind: 'field-ref', source: 'user', field: 'id' }, as: 'id' }],
      from: { kind: 'type', type: 'user' },
      joins: [{ on: { kind: 'relation', source: 'user', field: 'name', as: 'j' } }],
    };
    const { sql } = fx.engine.toSQL(def, 'base');
    expect(sql).toBe('SELECT "user"."id" AS "id" FROM "user" AS "user"');
  });

  it('a non-relation DELETE join expands to nothing at runtime', async () => {
    const fx = runtimeFixture();
    const def: DeleteDef = {
      kind: 'delete',
      from: 'order',
      joins: [{ on: { kind: 'relation', source: 'order', field: 'note', as: 'j' } }],
      where: [{ kind: 'comparison', op: '=', left: { kind: 'field-ref', source: 'order', field: 'id' }, right: { kind: 'literal', value: 10 } }],
    };
    expect((await fx.engine.run(def)).affected).toBe(1);
  });

  it('a RIGHT-join DELETE skips a passing row that has no target record', async () => {
    const fx = runtimeFixture();
    const def: DeleteDef = {
      kind: 'delete',
      from: 'order',
      // RIGHT join over users: Cleo (user 3, no orders) yields a row with no
      // `order` target. The WHERE selects exactly Cleo, so a passing row reaches
      // the `!target` guard and is skipped ⇒ nothing deleted.
      joins: [{ on: { kind: 'relation', source: 'order', field: 'userId', as: 'user' }, joinType: 'right' }],
      where: [{ kind: 'comparison', op: '=', left: { kind: 'field-ref', source: 'user', field: 'id' }, right: { kind: 'literal', value: 3 } }],
    };
    const res = await fx.engine.run(def);
    expect(res.affected).toBe(0);
  });
});

describe('QueryJoin — relation to an unknown target type + a missing foreign key', () => {
  it('a relation whose target type is unregistered expands to no rows (buildPlan undefined)', async () => {
    const registry = createRegistry();
    const g: TypeDef = {
      name: 'g',
      fields: [
        { name: 'id', type: { kind: 'number', whole: true } },
        { name: 'owner', type: { kind: 'relation', to: 'ghostType', count: 1 } },
      ],
      count: 5,
      bytes: 8,
    };
    const t = registry.parseType(g);
    registry.registerType(t);
    registry.finalize();
    const engine = new QueryEngine(registry, { executors: { g: arrayExecutor([{ id: 1, owner: 1 }]) } });
    const def: SelectDef = {
      kind: 'select',
      fields: [{ expr: { kind: 'field-ref', source: 'g', field: 'id' }, as: 'id' }],
      from: { kind: 'type', type: 'g' },
      joins: [{ on: { kind: 'relation', source: 'g', field: 'owner', as: 'owner' } }],
    };
    expect((await engine.run(def)).rows).toEqual([{ id: 1 }]);
  });

  it('a target record missing the foreign key never matches (left join keeps the left row)', async () => {
    const registry = createRegistry();
    const u: TypeDef = {
      name: 'u',
      fields: [{ name: 'id', type: { kind: 'number', whole: true } }],
      indexes: [{ exprs: [{ expr: { kind: 'field-ref', source: 'u', field: 'id' }, count: 1 }] }],
      count: 10,
      bytes: 8,
    };
    const o: TypeDef = {
      name: 'o',
      fields: [
        { name: 'id', type: { kind: 'number', whole: true } },
        { name: 'uId', type: { kind: 'relation', to: 'u', count: 1, inverseRelation: 'os' } },
      ],
      count: 10,
      bytes: 16,
    };
    registry.registerType(registry.parseType(u));
    registry.registerType(registry.parseType(o));
    registry.finalize();
    const engine = new QueryEngine(registry, {
      executors: {
        u: arrayExecutor([{ id: 1 }]),
        // The order record is MISSING its key field ⇒ the target foreign value
        // reads as null ⇒ no match.
        o: arrayExecutor([{ uId: 999 }]),
      },
    });
    const def: SelectDef = {
      kind: 'select',
      fields: [{ expr: { kind: 'field-ref', source: 'u', field: 'id' }, as: 'uid' }],
      from: { kind: 'type', type: 'u' },
      joins: [{ on: { kind: 'relation', source: 'u', field: 'os', as: 'o' }, joinType: 'left' }],
    };
    const res = await engine.run(def);
    // user 1 keeps its row (no order matched on the missing key).
    expect(res.rows).toEqual([{ uid: 1 }]);
  });
});

describe('QuerySource — FROM an unregistered (CTE-shaped) name yields no rows', () => {
  it('recordsFor returns undefined for an unknown name ⇒ empty rows', async () => {
    const fx = runtimeFixture();
    const def: SelectDef = {
      kind: 'select',
      fields: [{ expr: { kind: 'literal', value: 1 }, as: 'x' }],
      // `ghostCte` is neither a registered type nor a populated CTE.
      from: { kind: 'type', type: 'ghostCte' },
    };
    expect((await fx.engine.run(def)).rows).toEqual([]);
  });
});

describe('CTEStatementQuery — recursive arm reading a real type', () => {
  it('collects a real type referenced by the recursive arm (not just the base)', () => {
    const fx = fixture();
    const def: CTEStatementDef = {
      kind: 'cte',
      ctes: [
        {
          name: 'walk',
          base: { kind: 'expr', expr: { kind: 'literal', value: 1 } },
          // The recursive arm is a UNION whose right side reads a REAL type
          // (`user`), so the recursive-arm type collection adds it.
          recursive: {
            kind: 'union',
            left: {
              kind: 'select',
              fields: [{ expr: { kind: 'binary', op: '+', left: { kind: 'field-ref', source: 'walk', field: 'value' }, right: { kind: 'literal', value: 1 } }, as: 'value' }],
              from: { kind: 'type', type: 'walk' },
              where: [{ kind: 'comparison', op: '<', left: { kind: 'field-ref', source: 'walk', field: 'value' }, right: { kind: 'literal', value: 3 } }],
            },
            right: {
              kind: 'select',
              fields: [{ expr: { kind: 'field-ref', source: 'user', field: 'id' }, as: 'value' }],
              from: { kind: 'type', type: 'user' },
              where: [{ kind: 'comparison', op: '<', left: { kind: 'field-ref', source: 'user', field: 'id' }, right: { kind: 'literal', value: 0 } }],
            },
          },
        },
      ],
      final: {
        kind: 'select',
        fields: [{ expr: { kind: 'field-ref', source: 'walk', field: 'value' }, as: 'value' }],
        from: { kind: 'type', type: 'walk' },
      },
    };
    const refs = fx.engine.parseQuery(def).referencedTypes();
    expect(refs).toContain('user');
    expect(refs).not.toContain('walk');
  });
});
