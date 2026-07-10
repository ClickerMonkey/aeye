/**
 * Coverage: the remaining error / degrade / fan-out branches across the DML +
 * source + join + cte query classes — joined DML runtime (execute + dedup),
 * RLS in DML toSQL, unresolvable joins, INSERT…SELECT field-mismatch,
 * ON CONFLICT on a null key, the shared `fieldNameOf` natural names, a CTE's
 * referenced-type collection, an orphan-row right/full join, and a source over
 * a type with no executor.
 *
 * Builds small LOCAL fixtures (it does not edit `_utils`).
 */
import { describe, it, expect } from 'vitest';
import { createRegistry } from '../registry';
import { QueryEngine } from '../engine';
import { arrayExecutor } from '../runtime/executor';
import { runtimeFixture, fixture } from './_utils';
import type { RlsProvider } from '../sql/index';
import type { TypeDef, InsertDef, UpdateDef, DeleteDef, SelectDef, CTEStatementDef } from '../schema';

// ─── An orphan-aware join fixture (a user with no orders, an order with no user) ─

const uDef: TypeDef = {
  name: 'u',
  fields: [
    { name: 'id', type: { kind: 'number', whole: true } },
    { name: 'name', type: { kind: 'text' } },
  ],
  indexes: [{ exprs: [{ expr: { kind: 'field-ref', source: 'u', field: 'id' }, count: 1 }] }],
  count: 10,
  bytes: 32,
};
const oDef: TypeDef = {
  name: 'o',
  fields: [
    { name: 'id', type: { kind: 'number', whole: true } },
    { name: 'uId', type: { kind: 'relation', to: 'u', count: 1, inverseRelation: 'os' } },
  ],
  count: 10,
  bytes: 24,
};

function orphanFixture() {
  const registry = createRegistry();
  const u = registry.parseType(uDef);
  const o = registry.parseType(oDef);
  registry.registerType(u);
  registry.registerType(o);
  registry.finalize();
  const engine = new QueryEngine(registry, {
    executors: {
      // user 1 has an order; user 2 (Solo) has none.
      u: arrayExecutor([{ id: 1, name: 'Has' }, { id: 2, name: 'Solo' }]),
      // order 10 → user 1; order 11 → user 999 (orphan).
      o: arrayExecutor([{ id: 10, uId: 1 }, { id: 11, uId: 999 }]),
    },
  });
  return { registry, engine };
}

describe('QueryJoin — orphan rows exercise unmatched right/full padding', () => {
  function joinSel(joinType: 'right' | 'full'): SelectDef {
    return {
      kind: 'select',
      fields: [
        { expr: { kind: 'field-ref', source: 'u', field: 'id' }, as: 'uid' },
        { expr: { kind: 'field-ref', source: 'o', field: 'id' }, as: 'oid' },
      ],
      from: { kind: 'type', type: 'u' },
      joins: [{ on: { kind: 'relation', source: 'u', field: 'os', as: 'o' }, joinType }],
    };
  }

  it('RIGHT join pads an orphan target (order 11 with no user)', async () => {
    const { engine } = orphanFixture();
    const res = await engine.run(joinSel('right'));
    // order 11 has no matching user ⇒ appears with a null uid.
    expect(res.rows.some((r) => r['oid'] === 11 && r['uid'] === null)).toBe(true);
  });

  it('FULL join pads both an unmatched user (Solo) and an orphan order', async () => {
    const { engine } = orphanFixture();
    const res = await engine.run(joinSel('full'));
    expect(res.rows.some((r) => r['uid'] === 2 && r['oid'] === null)).toBe(true);
    expect(res.rows.some((r) => r['oid'] === 11 && r['uid'] === null)).toBe(true);
  });
});

describe('QuerySource — a type with no executor produces zero rows', () => {
  it('FROM a type whose executor is unregistered ⇒ empty rows', async () => {
    // `fixture()` registers types but wires NO executors.
    const fx = fixture();
    const def: SelectDef = {
      kind: 'select',
      fields: [{ expr: { kind: 'field-ref', source: 'user', field: 'id' }, as: 'id' }],
      from: { kind: 'type', type: 'user' },
    };
    const res = await fx.engine.run(def);
    expect(res.rows).toEqual([]);
  });
});

describe('DML — joined runtime, fan-out dedup, unresolvable joins, RLS in SQL', () => {
  it('DELETE with a join removes the matched target rows (execute path)', async () => {
    const fx = runtimeFixture();
    const def: DeleteDef = {
      kind: 'delete',
      from: 'order',
      joins: [{ on: { kind: 'relation', source: 'order', field: 'userId', as: 'user' } }],
      where: [{ kind: 'comparison', op: '>', left: { kind: 'field-ref', source: 'user', field: 'age' }, right: { kind: 'literal', value: 40 } }],
    };
    const res = await fx.engine.run(def);
    // Only Bob (age 42); his orders 12 & 13.
    expect(res.affected).toBe(2);
  });

  it('DELETE over a FAN-OUT join dedups the target before deleting', async () => {
    const fx = runtimeFixture();
    const def: DeleteDef = {
      kind: 'delete',
      from: 'user',
      joins: [{ on: { kind: 'relation', source: 'user', field: 'orders', as: 'order' } }],
      where: [{ kind: 'comparison', op: '>', left: { kind: 'field-ref', source: 'order', field: 'total' }, right: { kind: 'literal', value: 150 } }],
    };
    const res = await fx.engine.run(def);
    // order 12 (200) belongs to user 2 ⇒ exactly one distinct user deleted.
    expect(res.affected).toBe(1);
  });

  it('UPDATE over a FAN-OUT join dedups the target; an unresolvable join is a no-op expansion', async () => {
    const fx = runtimeFixture();
    const fanOut: UpdateDef = {
      kind: 'update',
      type: 'user',
      set: { age: { kind: 'literal', value: 1 } },
      joins: [{ on: { kind: 'relation', source: 'user', field: 'orders', as: 'order' } }],
      where: [{ kind: 'comparison', op: '>', left: { kind: 'field-ref', source: 'order', field: 'total' }, right: { kind: 'literal', value: 0 } }],
    };
    expect((await fx.engine.run(fanOut)).affected).toBe(2);

    // A relation join whose `field` is NOT a relation doesn't resolve ⇒ expand
    // with an empty plan.
    const fx2 = runtimeFixture();
    const badJoin: UpdateDef = {
      kind: 'update',
      type: 'user',
      set: { age: { kind: 'literal', value: 5 } },
      joins: [{ on: { kind: 'relation', source: 'user', field: 'name', as: 'j' } }],
    };
    expect((await fx2.engine.run(badJoin)).affected).toBe(3);
  });

  it('UPDATE without RETURNING returns no rows', async () => {
    const fx = runtimeFixture();
    const def: UpdateDef = {
      kind: 'update',
      type: 'user',
      set: { age: { kind: 'literal', value: 9 } },
      where: [{ kind: 'comparison', op: '=', left: { kind: 'field-ref', source: 'user', field: 'id' }, right: { kind: 'literal', value: 1 } }],
    };
    const res = await fx.engine.run(def);
    expect(res.rows).toEqual([]);
    expect(res.affected).toBe(1);
  });

  const rls: RlsProvider = {
    predicateFor(typeName, alias) {
      if (typeName === 'order') {
        return { kind: 'comparison', op: '=', left: { kind: 'field-ref', source: alias, field: 'note' }, right: { kind: 'literal', value: 'x' } };
      }
      return undefined;
    },
  };

  it('UPDATE / DELETE toSQL inject an RLS predicate; an unresolvable authored join is skipped', () => {
    const fx = fixture();
    const upd: UpdateDef = {
      kind: 'update',
      type: 'order',
      set: { total: { kind: 'literal', value: 0 } },
      // a relation join whose `field` is NOT a relation never resolves ⇒ registerJoins skips it.
      joins: [{ on: { kind: 'relation', source: 'order', field: 'note', as: 'j' } }],
    };
    expect(fx.engine.toSQL(upd, 'base', { rls }).sql).toContain('"order"."note"');

    const del: DeleteDef = {
      kind: 'delete',
      from: 'order',
      joins: [{ on: { kind: 'relation', source: 'order', field: 'note', as: 'j' } }],
    };
    expect(fx.engine.toSQL(del, 'base', { rls }).sql).toContain('"order"."note"');
  });

  it('DELETE / UPDATE toJSON keep an un-aliased RETURNING expr', () => {
    const fx = runtimeFixture();
    const del: DeleteDef = {
      kind: 'delete',
      from: 'order',
      returning: [{ expr: { kind: 'field-ref', source: 'order', field: 'id' } }],
    };
    expect(fx.engine.parseQuery(del).toJSON()).toEqual(del);
    const upd: UpdateDef = {
      kind: 'update',
      type: 'order',
      set: { note: { kind: 'literal', value: 'x' } },
      returning: [{ expr: { kind: 'field-ref', source: 'order', field: 'id' } }],
    };
    expect(fx.engine.parseQuery(upd).toJSON()).toEqual(upd);
  });
});

describe('InsertQuery — gatherTuples edge cases + serialization', () => {
  it('an INSERT with neither VALUES nor SELECT inserts nothing', async () => {
    const fx = runtimeFixture();
    const def: InsertDef = { kind: 'insert', into: 'user' };
    expect((await fx.engine.run(def)).affected).toBe(0);
  });

  it('INSERT … SELECT fills absent columns with null when the source has fewer fields', async () => {
    const fx = runtimeFixture();
    const def: InsertDef = {
      kind: 'insert',
      into: 'user',
      select: {
        kind: 'select',
        // SELECT yields only `name` ⇒ `email` has no source column ⇒ null.
        fields: [{ expr: { kind: 'field-ref', source: 'user', field: 'name' }, as: 'name' }],
        from: { kind: 'type', type: 'user' },
        where: [{ kind: 'comparison', op: '=', left: { kind: 'field-ref', source: 'user', field: 'id' }, right: { kind: 'literal', value: 1 } }],
      },
      returning: [{ expr: { kind: 'field-ref', source: 'user', field: 'email' } }],
    };
    const res = await fx.engine.run(def);
    expect(res.rows).toEqual([{ email: null }]);
  });

  it('ON CONFLICT on a NULL key matches an existing null-keyed row (DO NOTHING)', async () => {
    const fx = runtimeFixture();
    const def: InsertDef = {
      kind: 'insert',
      into: 'order',
      rows: [{ id: { kind: 'literal', value: 99 }, note: { kind: 'literal', value: null } }],
      onConflict: { fields: ['note'], doNothing: true },
    };
    // order 11 / 13 already have a null `note` ⇒ conflict ⇒ skipped.
    expect((await fx.engine.run(def)).affected).toBe(0);
  });

  it('INSERT … SELECT round-trips through toJSON / clone; an insert without ON CONFLICT clones too', () => {
    const fx = runtimeFixture();
    const withSelect: InsertDef = {
      kind: 'insert',
      into: 'user',
      select: {
        kind: 'select',
        fields: [{ expr: { kind: 'field-ref', source: 'user', field: 'name' }, as: 'name' }],
        from: { kind: 'type', type: 'user' },
      },
    };
    const q = fx.engine.parseQuery(withSelect);
    expect(q.toJSON()).toEqual(withSelect);
    expect(q.clone().toJSON()).toEqual(withSelect);
  });
});

describe('shared fieldNameOf — natural names in DML RETURNING', () => {
  it('derives names for field-ref / joined field-ref / aggregate / other (no alias)', () => {
    const fx = runtimeFixture();
    // A relation crossing is now a named JOIN + a plain field-ref into it; its
    // natural name is the joined field (`name`), exactly as the old relation-path
    // derived its last segment.
    const del: DeleteDef = {
      kind: 'delete',
      from: 'order',
      joins: [{ on: { kind: 'relation', source: 'order', field: 'userId', as: 'user' } }],
      returning: [
        { expr: { kind: 'field-ref', source: 'order', field: 'id' } },
        { expr: { kind: 'field-ref', source: 'user', field: 'name' } },
        { expr: { kind: 'aggregate', function: 'count', args: {} } },
        { expr: { kind: 'literal', value: 1 } },
      ],
    };
    const names = fx.engine.parseQuery(del).outputFields(fx.engine, fx.engine.globalScope()).map((f) => f.name);
    expect(names).toEqual(['id', 'name', 'count', 'col3']);
  });
});

describe('SelectQuery — filterSources skips an unresolvable join', () => {
  it('only the FROM alias is exposed when the sole join does not resolve', () => {
    const fx = runtimeFixture();
    const def: SelectDef = {
      kind: 'select',
      fields: [{ expr: { kind: 'field-ref', source: 'user', field: 'id' }, as: 'id' }],
      from: { kind: 'type', type: 'user' },
      joins: [{ on: { kind: 'relation', source: 'user', field: 'name', as: 'j' } }],
    };
    expect(fx.engine.parseQuery(def).filterSources(fx.engine)).toEqual(['user']);
  });
});

describe('CTEStatementQuery — recursive entry referenced types', () => {
  it('collects real types from a recursive CTE\'s base + recursive arms, excluding CTE names', () => {
    const fx = fixture();
    const def: CTEStatementDef = {
      kind: 'cte',
      ctes: [
        {
          name: 'walk',
          // base reads a REAL type (user); recursive arm reads the CTE name only.
          base: {
            kind: 'select',
            fields: [{ expr: { kind: 'field-ref', source: 'user', field: 'id' }, as: 'value' }],
            from: { kind: 'type', type: 'user' },
          },
          recursive: {
            kind: 'select',
            fields: [{ expr: { kind: 'binary', op: '+', left: { kind: 'field-ref', source: 'walk', field: 'value' }, right: { kind: 'literal', value: 1 } }, as: 'value' }],
            from: { kind: 'type', type: 'walk' },
            where: [{ kind: 'comparison', op: '<', left: { kind: 'field-ref', source: 'walk', field: 'value' }, right: { kind: 'literal', value: 5 } }],
          },
        },
      ],
      // final reads a REAL type (user) ⇒ exercises the final-type collection too.
      final: {
        kind: 'select',
        fields: [{ expr: { kind: 'field-ref', source: 'user', field: 'name' }, as: 'name' }],
        from: { kind: 'type', type: 'user' },
      },
    };
    const refs = fx.engine.parseQuery(def).referencedTypes();
    expect(refs).toContain('user');
    expect(refs).not.toContain('walk');
  });
});

describe('_cost — equality on a non-indexed field finds no usable index prefix', () => {
  it('costs a WHERE whose only equality is on an un-indexed column', () => {
    const fx = fixture();
    const def: SelectDef = {
      kind: 'select',
      fields: [{ expr: { kind: 'field-ref', source: 'user', field: 'id' }, as: 'id' }],
      from: { kind: 'type', type: 'user' },
      where: [{ kind: 'comparison', op: '=', left: { kind: 'field-ref', source: 'user', field: 'name' }, right: { kind: 'literal', value: 'Ada' } }],
    };
    expect(fx.engine.cost(def).rows).toBeGreaterThanOrEqual(1);
  });
});