/**
 * Relation-VALUE comparison — HAS-MANY membership (Phase 2). `user.orders = { pk }`
 * lowers to a correlated `[NOT] EXISTS` over the target: the value's PK ∈ the
 * related set. Two-valued (EXISTS is never UNKNOWN). Covers `= <> in notIn`,
 * object / scalar values, the relation on either side, composite keys, and the
 * set-vs-set validation reject.
 */
import { describe, it, expect } from 'vitest';
import { runtimeFixture } from './_utils';
import { createRegistry } from '../registry';
import { QueryEngine } from '../engine';
import { arrayExecutor } from '../runtime/executor';
import type { QueryDef, JsonValue, TypeDef } from '../schema';
import type { SqlParamValue } from '../sql/emit';

/** SELECT user.id WHERE user.orders <op> value, returning the matched user ids sorted. */
async function has(op: '=' | '<>', value: JsonValue): Promise<number[]> {
  const def: QueryDef = {
    kind: 'select',
    fields: [{ expr: { kind: 'field-ref', source: 'user', field: 'id' } }],
    from: { kind: 'type', type: 'user' },
    where: [{ kind: 'comparison', op, left: { kind: 'field-ref', source: 'user', field: 'orders' }, right: { kind: 'param', name: 'o' } }],
  } as QueryDef;
  const res = await runtimeFixture().engine.run(def, { params: { o: value } });
  return res.rows.map((r) => r.id as number).sort((a, b) => a - b);
}

/** SELECT user.id WHERE user.orders [NOT] IN (:params...), returning the matched user ids sorted. */
async function hasIn(not: boolean, names: string[], params: Record<string, JsonValue>): Promise<number[]> {
  const def: QueryDef = {
    kind: 'select',
    fields: [{ expr: { kind: 'field-ref', source: 'user', field: 'id' } }],
    from: { kind: 'type', type: 'user' },
    where: [{ kind: 'in', not, value: { kind: 'field-ref', source: 'user', field: 'orders' }, in: names.map((n) => ({ kind: 'param', name: n })) }],
  } as QueryDef;
  const res = await runtimeFixture().engine.run(def, { params });
  return res.rows.map((r) => r.id as number).sort((a, b) => a - b);
}

describe('relation-hasmany-compare: membership (runtime)', () => {
  // orders 10,11 → user 1; orders 12,13 → user 2; user 3 (Cleo) has none.
  it('= { pk } is EXISTS a related row with that PK', async () => {
    expect(await has('=', { id: 10 })).toEqual([1]);
    expect(await has('=', { id: 12 })).toEqual([2]);
    expect(await has('=', { id: 99 })).toEqual([]); // no such order
  });

  it('a bare scalar value works too (single-key)', async () => {
    expect(await has('=', 11)).toEqual([1]);
  });

  it('<> is NOT EXISTS (the users WITHOUT that order)', async () => {
    expect(await has('<>', { id: 10 })).toEqual([2, 3]);
    expect(await has('<>', 12)).toEqual([1, 3]);
  });

  it('a null PK matches nothing (= none, <> all)', async () => {
    expect(await has('=', { id: null })).toEqual([]);
    expect(await has('<>', { id: null })).toEqual([1, 2, 3]);
  });

  it('a wholly-null value matches nothing (= none, <> all)', async () => {
    expect(await has('=', null)).toEqual([]);
    expect(await has('<>', null)).toEqual([1, 2, 3]);
  });

  it('IN a list is membership of ANY (NOT IN negates)', async () => {
    expect(await hasIn(false, ['a', 'b'], { a: { id: 10 }, b: { id: 12 } })).toEqual([1, 2]);
    expect(await hasIn(false, ['a'], { a: 11 })).toEqual([1]);
    expect(await hasIn(true, ['a', 'b'], { a: { id: 10 }, b: { id: 12 } })).toEqual([3]);
  });

  it('reads the has-many owner from the CORRELATION row inside a subquery', async () => {
    // The inner `user.orders = { id: 10 }` refers to the OUTER `user` (correlated),
    // so evaluating the has-many owner's key falls back to the correlation row.
    const def: QueryDef = {
      kind: 'select',
      fields: [{ expr: { kind: 'field-ref', source: 'user', field: 'id' } }],
      from: { kind: 'type', type: 'user' },
      where: [
        {
          kind: 'exists',
          query: {
            kind: 'select',
            fields: [{ expr: { kind: 'field-ref', source: 'order', field: 'id' } }],
            from: { kind: 'type', type: 'order' },
            where: [{ kind: 'comparison', op: '=', left: { kind: 'field-ref', source: 'user', field: 'orders' }, right: { kind: 'param', name: 'o' } }],
          },
        },
      ],
    } as QueryDef;
    const res = await runtimeFixture().engine.run(def, { params: { o: { id: 10 } } });
    expect(res.rows.map((r) => r.id)).toEqual([1]); // only user 1 owns order 10
  });

  it('works with the has-many relation on the RIGHT of the comparison', async () => {
    const def: QueryDef = {
      kind: 'select',
      fields: [{ expr: { kind: 'field-ref', source: 'user', field: 'id' } }],
      from: { kind: 'type', type: 'user' },
      where: [{ kind: 'comparison', op: '=', left: { kind: 'param', name: 'o' }, right: { kind: 'field-ref', source: 'user', field: 'orders' } }],
    } as QueryDef;
    const res = await runtimeFixture().engine.run(def, { params: { o: { id: 13 } } });
    expect(res.rows.map((r) => r.id)).toEqual([2]);
  });
});

describe('relation-hasmany-compare: membership (SQL)', () => {
  const sqlOf = (op: '=' | '<>', value: SqlParamValue): { sql: string; params: unknown[] } => {
    const def: QueryDef = {
      kind: 'select',
      fields: [{ expr: { kind: 'field-ref', source: 'user', field: 'id' } }],
      from: { kind: 'type', type: 'user' },
      where: [{ kind: 'comparison', op, left: { kind: 'field-ref', source: 'user', field: 'orders' }, right: { kind: 'param', name: 'o' } }],
    } as QueryDef;
    return runtimeFixture().engine.toSQL(def, 'postgres', { params: { o: value } });
  };

  it('emits a correlated EXISTS with the PK bound as a parameter', () => {
    const { sql, params } = sqlOf('=', { id: 10 });
    expect(params).toEqual([10]);
    expect(sql).toMatch(/EXISTS\s*\(/i);
    expect(sql).toMatch(/"__rel"\."userId"\s*=\s*"user"\."id"/i); // correlation join
    expect(sql).toMatch(/"__rel"\."id"\s*=\s*\$1/i); // membership
  });

  it('<> emits NOT EXISTS', () => {
    expect(sqlOf('<>', 10).sql).toMatch(/NOT\s+EXISTS\s*\(/i);
  });

  it('emits the EXISTS with the has-many relation on the RIGHT too', () => {
    const def: QueryDef = {
      kind: 'select',
      fields: [{ expr: { kind: 'field-ref', source: 'user', field: 'id' } }],
      from: { kind: 'type', type: 'user' },
      where: [{ kind: 'comparison', op: '=', left: { kind: 'param', name: 'o' }, right: { kind: 'field-ref', source: 'user', field: 'orders' } }],
    } as QueryDef;
    const { sql, params } = runtimeFixture().engine.toSQL(def, 'postgres', { params: { o: { id: 11 } } });
    expect(params).toEqual([11]);
    expect(sql).toMatch(/EXISTS\s*\(/i);
    expect(sql).toMatch(/"__rel"\."id"\s*=\s*\$1/i);
  });

  it('a { pk } object MISSING the key part binds NULL (matches nothing)', () => {
    const { sql, params } = sqlOf('=', {}); // no `id` → membership `__rel.id = NULL`
    expect(params).toEqual([]); // NULL is a keyword, not a bound param
    expect(sql).toMatch(/"__rel"\."id"\s*=\s*NULL/i);
  });

  it('an explicitly-null has-many param binds NULL (matches nothing)', () => {
    const { sql, params } = sqlOf('=', null);
    expect(params).toEqual([]);
    expect(sql).toMatch(/"__rel"\."id"\s*=\s*NULL/i);
  });

  it('an unsupplied has-many param binds NULL (matches nothing)', () => {
    const def: QueryDef = {
      kind: 'select',
      fields: [{ expr: { kind: 'field-ref', source: 'user', field: 'id' } }],
      from: { kind: 'type', type: 'user' },
      where: [{ kind: 'comparison', op: '=', left: { kind: 'field-ref', source: 'user', field: 'orders' }, right: { kind: 'param', name: 'o' } }],
    } as QueryDef;
    const { sql, params } = runtimeFixture().engine.toSQL(def, 'postgres', {}); // no params
    expect(params).toEqual([]);
    expect(sql).toMatch(/"__rel"\."id"\s*=\s*NULL/i);
  });

  it('IN a list emits an OR of EXISTS (NOT IN wraps in NOT)', () => {
    const def = (not: boolean): QueryDef => ({
      kind: 'select',
      fields: [{ expr: { kind: 'field-ref', source: 'user', field: 'id' } }],
      from: { kind: 'type', type: 'user' },
      where: [{ kind: 'in', not, value: { kind: 'field-ref', source: 'user', field: 'orders' }, in: [{ kind: 'param', name: 'a' }, { kind: 'param', name: 'b' }] }],
    } as QueryDef);
    const plain = runtimeFixture().engine.toSQL(def(false), 'postgres', { params: { a: { id: 10 }, b: 12 } });
    expect(plain.params).toEqual([10, 12]);
    expect(plain.sql).toMatch(/EXISTS.*OR.*EXISTS/is);
    expect(plain.sql).not.toMatch(/^\s*SELECT[^]*\bNOT\s*\(/i);
    const negated = runtimeFixture().engine.toSQL(def(true), 'postgres', { params: { a: { id: 10 }, b: 12 } });
    expect(negated.sql).toMatch(/NOT\s*\(/i);
  });
});

/** A composite-key has-many: `region` (country, code) has many `store`s (regionCountry, regionCode). */
function compositeHasManyEngine(): QueryEngine {
  const registry = createRegistry();
  const region: TypeDef = {
    name: 'region',
    fields: [{ name: 'country', type: { kind: 'text' } }, { name: 'code', type: { kind: 'text' } }],
    indexes: [{ exprs: [{ expr: { kind: 'field-ref', source: 'region', field: 'country' }, count: 5 }, { expr: { kind: 'field-ref', source: 'region', field: 'code' }, count: 1 }] }],
    count: 10,
    bytes: 20,
  };
  const store: TypeDef = {
    name: 'store',
    fields: [
      { name: 'id', type: { kind: 'number', whole: true } },
      { name: 'regionCountry', type: { kind: 'text' } },
      { name: 'regionCode', type: { kind: 'text' } },
      // Belongs-to region on the composite FK; `inverseRelation` materializes region.stores.
      { name: 'region', type: { kind: 'relation', to: 'region', count: 1, inverseRelation: 'stores' } },
    ],
    indexes: [{ exprs: [{ expr: { kind: 'field-ref', source: 'store', field: 'id' }, count: 1 }] }],
    count: 100,
    bytes: 40,
  };
  registry.registerType(registry.parseType(region));
  registry.registerType(registry.parseType(store), {
    fields: { region: { relation: { keys: [{ local: 'regionCountry', foreign: 'country' }, { local: 'regionCode', foreign: 'code' }] } } },
  });
  registry.finalize();
  const regionRows = [{ country: 'US', code: 'CA' }, { country: 'US', code: 'NY' }, { country: 'CA', code: 'ON' }];
  const storeRows = [
    { id: 1, regionCountry: 'US', regionCode: 'CA' },
    { id: 2, regionCountry: 'US', regionCode: 'NY' },
    { id: 3, regionCountry: 'CA', regionCode: 'ON' },
  ];
  return new QueryEngine(registry, { executors: { region: arrayExecutor(regionRows), store: arrayExecutor(storeRows) } });
}

describe('relation-hasmany-compare: composite key', () => {
  // SELECT region.country WHERE region.stores = { id } (does a store with that id join this region?).
  const def = (op: '=' | '<>'): QueryDef => ({
    kind: 'select',
    fields: [{ expr: { kind: 'field-ref', source: 'region', field: 'country' } }, { expr: { kind: 'field-ref', source: 'region', field: 'code' } }],
    from: { kind: 'type', type: 'region' },
    where: [{ kind: 'comparison', op, left: { kind: 'field-ref', source: 'region', field: 'stores' }, right: { kind: 'param', name: 's' } }],
  } as QueryDef);

  it('membership joins on ALL composite key columns (runtime)', async () => {
    const engine = compositeHasManyEngine();
    // store 1 is in US/CA → only that region has store 1 as a member.
    const res = await engine.run(def('='), { params: { s: { id: 1 } } });
    expect(res.rows.map((r) => `${r.country}/${r.code}`)).toEqual(['US/CA']);
  });

  it('emits a multi-column correlated EXISTS (SQL)', () => {
    const { sql, params } = compositeHasManyEngine().toSQL(def('='), 'postgres', { params: { s: { id: 1 } } });
    expect(params).toEqual([1]);
    // both composite correlation columns present, ANDed with the membership
    // (text keys compare case-insensitively, so they wrap in LOWER(...)).
    expect(sql).toMatch(/"__rel"\."regionCountry"\).*=.*"region"\."country"/i);
    expect(sql).toMatch(/"__rel"\."regionCode"\).*=.*"region"\."code"/i);
    expect(sql).toMatch(/"__rel"\."id"\s*=\s*\$1/i);
  });
});

/** A DIRECTLY-declared has-many (no `inverseRelation`): `team.players` joins by name convention (player.team = team.id). */
function conventionHasManyEngine(): QueryEngine {
  const registry = createRegistry();
  const team: TypeDef = {
    name: 'team',
    fields: [
      { name: 'id', type: { kind: 'number', whole: true } },
      // Directly declared has-many — the FK on the target is the convention name `team`.
      { name: 'players', type: { kind: 'relation', to: 'player', count: 2 } },
    ],
    indexes: [{ exprs: [{ expr: { kind: 'field-ref', source: 'team', field: 'id' }, count: 1 }] }],
    count: 10,
    bytes: 8,
  };
  const player: TypeDef = {
    name: 'player',
    fields: [
      { name: 'id', type: { kind: 'number', whole: true } },
      { name: 'team', type: { kind: 'number', whole: true } },
    ],
    indexes: [{ exprs: [{ expr: { kind: 'field-ref', source: 'player', field: 'id' }, count: 1 }] }],
    count: 50,
    bytes: 8,
  };
  registry.registerType(registry.parseType(team));
  registry.registerType(registry.parseType(player));
  registry.finalize();
  const teamRows = [{ id: 1 }, { id: 2 }];
  const playerRows = [{ id: 100, team: 1 }, { id: 101, team: 1 }, { id: 102, team: 2 }];
  return new QueryEngine(registry, { executors: { team: arrayExecutor(teamRows), player: arrayExecutor(playerRows) } });
}

describe('relation-hasmany-compare: directly-declared (convention) has-many', () => {
  it('resolves the FK by name convention and tests membership', async () => {
    const engine = conventionHasManyEngine();
    const def = (op: '=' | '<>'): QueryDef => ({
      kind: 'select',
      fields: [{ expr: { kind: 'field-ref', source: 'team', field: 'id' } }],
      from: { kind: 'type', type: 'team' },
      where: [{ kind: 'comparison', op, left: { kind: 'field-ref', source: 'team', field: 'players' }, right: { kind: 'param', name: 'p' } }],
    } as QueryDef);
    const res = await engine.run(def('='), { params: { p: { id: 100 } } });
    expect(res.rows.map((r) => r.id)).toEqual([1]); // team 1 has player 100
    const { sql, params } = engine.toSQL(def('='), 'postgres', { params: { p: { id: 100 } } });
    expect(params).toEqual([100]);
    expect(sql).toMatch(/"__rel"\."team"\s*=\s*"team"\."id"/i); // convention FK join
  });
});

describe('relation-hasmany-compare: validation', () => {
  it('rejects a has-many vs has-many comparison (set-vs-set)', () => {
    const def: QueryDef = {
      kind: 'select',
      fields: [{ expr: { kind: 'field-ref', source: 'user', field: 'id' } }],
      from: { kind: 'type', type: 'user' },
      where: [{ kind: 'comparison', op: '=', left: { kind: 'field-ref', source: 'user', field: 'orders' }, right: { kind: 'field-ref', source: 'user', field: 'orders' } }],
    } as QueryDef;
    const p = runtimeFixture().engine.validateQuery(def);
    expect(p.list.some((x) => x.code === 'comparison.relation-set')).toBe(true);
  });

  it('rejects a belongs-to vs has-many comparison (set-vs-identity relation)', () => {
    // order.userId (belongs-to) on the LEFT, u.orders (has-many) on the RIGHT.
    const def: QueryDef = {
      kind: 'select',
      fields: [{ expr: { kind: 'field-ref', source: 'order', field: 'id' } }],
      from: { kind: 'type', type: 'order' },
      joins: [{ on: { kind: 'relation', source: 'order', field: 'userId', as: 'u' } }],
      where: [{ kind: 'comparison', op: '=', left: { kind: 'field-ref', source: 'order', field: 'userId' }, right: { kind: 'field-ref', source: 'u', field: 'orders' } }],
    } as QueryDef;
    const p = runtimeFixture().engine.validateQuery(def);
    expect(p.list.some((x) => x.code === 'comparison.relation-set')).toBe(true);
  });
});
