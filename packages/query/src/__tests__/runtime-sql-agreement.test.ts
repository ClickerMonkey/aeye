/**
 * Runtime ↔ SQL agreement for the three predicate/divergence fixes:
 *
 *  - P0-3: three-valued logic (NULL ⇒ UNKNOWN) in comparison / NOT / AND / OR /
 *    IN / NOT IN, so `engine.run` keeps a row only when the predicate is TRUE —
 *    exactly as the emitted SQL would under a real database's 3VL.
 *  - P0-4: text comparisons case-fold by default (the package's insensitive text
 *    default) in BOTH the runtime and SQL, even for two string literals; a
 *    an `exact`-cased field stays case-sensitive in both.
 *  - P0-5: a relation JOIN crossing a belongs-to relation resolves the joined
 *    value at runtime, matching the LEFT JOIN `toSQL` synthesizes.
 *  - P0-6: a REGISTERED TYPE's two halves — the `sql` type the database orders
 *    and the `compareValues` the runtime orders by — answer the same way, and
 *    the declared type reaches a COMPUTED value as well as a column's.
 *
 * Since these tests run with no live SQL database, "agreement" is shown by (a)
 * the runtime result rows being the SQL-correct ones and (b) the emitted SQL
 * being the canonical form a database evaluates to that same result.
 */
import { describe, it, expect } from 'vitest';
import { createRegistry } from '../registry';
import { QueryEngine } from '../engine';
import { arrayExecutor } from '../runtime/executor';
import { Value } from '../runtime/value';
import { BaseDialect, PostgresDialect } from '../sql/index';
import { runtimeFixture, lit, ref, cmp, userTypeDef, orderTypeDef } from './_utils';
import type { FieldTypeRefinementDef, ValueComparator } from '../refinement';
import type { ExprDef, JsonValue, SelectDef, TypeDef } from '../schema';
import type { SourceRecord } from '../runtime/row';

/** A SELECT of `user.id` (ordered) under the given WHERE predicate. */
function whereUsers(...where: ExprDef[]): SelectDef {
  return {
    kind: 'select',
    fields: [{ expr: ref('user', 'id'), as: 'id' }],
    from: { kind: 'type', type: 'user' },
    where,
    order: [{ expr: ref('user', 'id'), dir: 'asc' }],
  };
}

const not = (operand: ExprDef): ExprDef => ({ kind: 'logical', op: 'not', operands: [operand] });
const and = (...operands: ExprDef[]): ExprDef => ({ kind: 'logical', op: 'and', operands });
const or = (...operands: ExprDef[]): ExprDef => ({ kind: 'logical', op: 'or', operands });

describe('runtime ↔ SQL agreement — P0-3 three-valued logic', () => {
  it('`x = NULL` is UNKNOWN ⇒ excludes every row (run + SQL)', async () => {
    const fx = runtimeFixture();
    const def = whereUsers(cmp('=', ref('user', 'id'), lit(null)));
    expect((await fx.engine.run(def)).rows).toEqual([]);
    expect(fx.engine.toSQL(def, 'base').sql).toContain('"user"."id" = NULL');
  });

  it('`NOT (x = NULL)` is UNKNOWN ⇒ still excludes every row (run + SQL)', async () => {
    // The key 3VL fix: previously the runtime collapsed `x = NULL` to FALSE, so
    // `NOT` flipped it to TRUE and (wrongly) kept every row. Under 3VL it stays
    // UNKNOWN and excludes — matching `NOT ("user"."id" = NULL)` in SQL.
    const fx = runtimeFixture();
    const def = whereUsers(not(cmp('=', ref('user', 'id'), lit(null))));
    expect((await fx.engine.run(def)).rows).toEqual([]);
    expect(fx.engine.toSQL(def, 'base').sql).toContain('NOT ("user"."id" = NULL)');
  });

  it('`x IN (1, NULL)` matches the equal element; the NULL adds no rows', async () => {
    const fx = runtimeFixture();
    const def = whereUsers({ kind: 'in', value: ref('user', 'id'), in: [lit(1), lit(null)] });
    expect((await fx.engine.run(def)).rows).toEqual([{ id: 1 }]);
    expect(fx.engine.toSQL(def, 'base').sql).toContain('"user"."id" IN (?, NULL)');
  });

  it('`x NOT IN (1, NULL)` is UNKNOWN for non-matches ⇒ excludes every row', async () => {
    // id=1 ⇒ NOT IN FALSE; id∉{1} ⇒ the NULL makes it UNKNOWN (not TRUE). So no
    // row survives — matching `"user"."id" NOT IN (?, NULL)` in SQL.
    const fx = runtimeFixture();
    const def = whereUsers({ kind: 'in', value: ref('user', 'id'), in: [lit(1), lit(null)], not: true });
    expect((await fx.engine.run(def)).rows).toEqual([]);
    expect(fx.engine.toSQL(def, 'base').sql).toContain('"user"."id" NOT IN (?, NULL)');
  });

  it('`a AND null`: TRUE AND UNKNOWN = UNKNOWN, FALSE AND UNKNOWN = FALSE', async () => {
    const fx = runtimeFixture();
    const def = whereUsers(and(cmp('=', ref('user', 'id'), lit(1)), cmp('=', ref('user', 'age'), lit(null))));
    // id=1: TRUE AND UNKNOWN ⇒ UNKNOWN (excluded); others: FALSE AND UNKNOWN ⇒
    // FALSE (excluded). No rows — matching SQL's 3VL AND.
    expect((await fx.engine.run(def)).rows).toEqual([]);
    expect(fx.engine.toSQL(def, 'base').sql).toContain('("user"."id" = ? AND "user"."age" = NULL)');
  });

  it('`a OR null`: TRUE OR UNKNOWN = TRUE, FALSE OR UNKNOWN = UNKNOWN', async () => {
    const fx = runtimeFixture();
    const def = whereUsers(or(cmp('=', ref('user', 'id'), lit(1)), cmp('=', ref('user', 'age'), lit(null))));
    // id=1: TRUE OR UNKNOWN ⇒ TRUE (kept); others: FALSE OR UNKNOWN ⇒ UNKNOWN
    // (excluded). Only id=1 — matching SQL's 3VL OR.
    expect((await fx.engine.run(def)).rows).toEqual([{ id: 1 }]);
    expect(fx.engine.toSQL(def, 'base').sql).toContain('("user"."id" = ? OR "user"."age" = NULL)');
  });
});

// ─── P0-4: text case-sensitivity default ─────────────────────────────────────

const docDef: TypeDef = {
  name: 'doc',
  fields: [
    { name: 'id', type: { kind: 'number', whole: true } },
    { name: 'title', type: { kind: 'text' } }, // case-insensitive (default)
    { name: 'code', type: { kind: 'text', casing: 'exact' } }, // case-sensitive
  ],
  indexes: [{ exprs: [{ expr: ref('doc', 'id'), count: 1 }] }],
  count: 100,
  bytes: 40,
};
const docRows: SourceRecord[] = [
  { id: 1, title: 'Hello', code: 'ABC' },
  { id: 2, title: 'WORLD', code: 'abc' },
];
function docEngine(): QueryEngine {
  const registry = createRegistry();
  registry.registerType(registry.parseType(docDef));
  registry.finalize();
  return new QueryEngine(registry, { executors: { doc: arrayExecutor(docRows) } });
}
function whereDocs(where: ExprDef): SelectDef {
  return {
    kind: 'select',
    fields: [{ expr: ref('doc', 'id'), as: 'id' }],
    from: { kind: 'type', type: 'doc' },
    where: [where],
    order: [{ expr: ref('doc', 'id'), dir: 'asc' }],
  };
}

describe('runtime ↔ SQL agreement — P0-4 text case-sensitivity', () => {
  it("two string literals `'abc' = 'ABC'` fold case in BOTH run and SQL", async () => {
    const def = whereDocs(cmp('=', lit('abc'), lit('ABC')));
    // The comparison is constantly TRUE (case-folded), so every doc row is kept.
    expect((await docEngine().run(def)).rows).toEqual([{ id: 1 }, { id: 2 }]);
    // SQL folds both literals with LOWER, so a database evaluates it TRUE too.
    expect(docEngine().toSQL(def, 'base').sql).toContain('LOWER(?) = LOWER(?)');
  });

  it('an `exact`-cased field stays case-sensitive in BOTH run and SQL', async () => {
    const def = whereDocs(cmp('=', ref('doc', 'code'), lit('ABC')));
    // Only the row whose `code` is exactly 'ABC' matches (id=1).
    expect((await docEngine().run(def)).rows).toEqual([{ id: 1 }]);
    const sql = docEngine().toSQL(def, 'base').sql;
    expect(sql).toContain('"doc"."code" = ?');
    expect(sql).not.toContain('LOWER("doc"."code")');
  });
});

// ─── P0-5: relation joins resolved at runtime ────────────────────────────────

describe('runtime ↔ SQL agreement — P0-5 relation join runtime resolution', () => {
  it('a relation join crossing order → user resolves the joined value (run + SQL)', async () => {
    const fx = runtimeFixture();
    // FROM order, crossing `order.userId` into `user` via a relation join and
    // reading `name`. The runtime synthesizes the same LEFT JOIN the planner
    // emits and resolves the user's name.
    const def: SelectDef = {
      kind: 'select',
      fields: [{ expr: { kind: 'field-ref', source: 'order_userId', field: 'name' }, as: 'cust' }],
      from: { kind: 'type', type: 'order' },
      joins: [{ on: { kind: 'relation', source: 'order', field: 'userId', as: 'order_userId' } }],
      order: [{ expr: ref('order', 'id'), dir: 'asc' }],
    };
    // orders 10,11 ⇒ user 1 (Ada); 12,13 ⇒ user 2 (Bob).
    expect((await fx.engine.run(def)).rows).toEqual([
      { cust: 'Ada' },
      { cust: 'Ada' },
      { cust: 'Bob' },
      { cust: 'Bob' },
    ]);
    const sql = fx.engine.toSQL(def, 'base').sql;
    expect(sql).toContain('"order_userId"."name" AS "cust"');
    expect(sql).toContain('"order"."userId" = "order_userId"."id"');
  });

  it('a relation join with a missing related record reads NULL (LEFT-join miss)', async () => {
    // An order whose userId points at no user resolves to NULL — matching a LEFT
    // JOIN that finds no match. Uses an isolated dataset so the shared fixture is
    // untouched.
    const registry = createRegistry();
    registry.registerType(registry.parseType(userTypeDef));
    registry.registerType(registry.parseType(orderTypeDef));
    registry.finalize();
    const engine = new QueryEngine(registry, {
      executors: {
        user: arrayExecutor([{ id: 1, name: 'Ada', age: 36, email: 'a@x.com', tags: [] }]),
        order: arrayExecutor([{ id: 10, userId: 1, total: 1, note: null }, { id: 11, userId: 999, total: 2, note: null }]),
      },
    });
    const def: SelectDef = {
      kind: 'select',
      fields: [{ expr: { kind: 'field-ref', source: 'order_userId', field: 'name' }, as: 'cust' }],
      from: { kind: 'type', type: 'order' },
      joins: [{ on: { kind: 'relation', source: 'order', field: 'userId', as: 'order_userId' } }],
      order: [{ expr: ref('order', 'id'), dir: 'asc' }],
    };
    expect((await engine.run(def)).rows).toEqual([{ cust: 'Ada' }, { cust: null }]);
  });
});

// ─── P0-6: a REGISTERED TYPE's two halves agree ──────────────────────────────
//
// The step-4 property, and the one this file did not previously cover at all.
// A refinement declares a SQL half (`sql` — the stored column type, whose
// ordering the DATABASE performs) and an in-memory half (`compareValues`), and
// the two have to answer the same question the same way.
//
// `inet` is the example because the disagreement is a documented fact about
// PostgreSQL rather than an invention: an `inet` column orders by ADDRESS
// (`10.0.0.2` before `10.0.0.10`), while `Value.compareTo`'s fallback orders the
// same strings LEXICOGRAPHICALLY (`'10.0.0.10' < '10.0.0.2'`). No live database
// runs here, so what is asserted is (a) the declared SQL type the emitted
// statement's column carries, and (b) which of the two orderings the runtime
// produces — the pair a `differentialCheck` would compare against a real server.

/** `10.0.0.2` → `[10, 0, 0, 2]`, or `undefined` for anything that is not one. */
function octets(v: JsonValue): number[] | undefined {
  if (typeof v !== 'string') return undefined;
  const parts = v.split('.');
  if (parts.length !== 4) return undefined;
  const nums = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : Number.NaN));
  return nums.some((n) => Number.isNaN(n) || n > 255) ? undefined : nums;
}

/**
 * Order two IPv4 strings by ADDRESS, as `inet` does. Total over every value a
 * cell can hold — a non-address sorts after every address, and two of them sort
 * by their text — because `Value.compareTo` reaches a comparator with whatever
 * the row held.
 */
const compareAddresses: ValueComparator = (a, b) => {
  const x = octets(a);
  const y = octets(b);
  if (!x || !y) return !x && !y ? String(a).localeCompare(String(b)) : x ? -1 : 1;
  for (let i = 0; i < 4; i += 1) {
    if (x[i] !== y[i]) return x[i]! - y[i]!;
  }
  return 0;
};

const IP_ADDRESS: FieldTypeRefinementDef = {
  name: 'IpAddress',
  base: 'text',
  instructions: 'An IPv4 address, stored as `inet` and ordered by address rather than by spelling.',
  options: { casing: 'exact', maxLength: 15 },
  sql: { postgres: 'inet', base: 'varchar(15)' },
};

/** Ascending by ADDRESS. */
const BY_ADDRESS = ['10.0.0.2', '10.0.0.10', '10.0.1.1'];
/** Ascending by STRING — a different permutation, which is the whole point. */
const BY_STRING = ['10.0.0.10', '10.0.0.2', '10.0.1.1'];

const hostRows: SourceRecord[] = BY_STRING.map((addr, i) => ({ id: i + 1, addr }));

/** An engine over one `host` type whose `addr` is an `IpAddress`, with or without the comparator. */
function hostEngine(opts: { comparator: boolean } = { comparator: true }): QueryEngine {
  const registry = createRegistry();
  registry.registerFieldType(IP_ADDRESS);
  if (opts.comparator) registry.registerFieldTypeImpl('IpAddress', { compareValues: compareAddresses });
  registry.registerType(
    registry.parseType({
      name: 'host',
      fields: [
        { name: 'id', type: { kind: 'number', whole: true } },
        { name: 'addr', type: { kind: 'text', as: 'IpAddress' } },
      ],
      count: 100,
      bytes: 32,
    }),
  );
  registry.finalize();
  return new QueryEngine(registry, { executors: { host: arrayExecutor(hostRows) } });
}

/** `SELECT addr FROM host ORDER BY addr ASC`. */
const ORDER_HOSTS: SelectDef = {
  kind: 'select',
  fields: [{ expr: ref('host', 'addr'), as: 'addr' }],
  from: { kind: 'type', type: 'host' },
  order: [{ expr: ref('host', 'addr'), dir: 'asc' }],
};

describe('runtime ↔ SQL agreement — P0-6 a registered type orders the same way in both roads', () => {
  it('the column is emitted as `inet`, whose ordering is by address — the fact the runtime has to match', () => {
    const engine = hostEngine();
    const addr = engine.registry.type('host')!.field('addr')!.fieldType;
    // What the DATABASE will be ordering: the refinement's declared `sql`, per
    // dialect. This is the SQL half of the agreement, and it is a declaration
    // rather than a claim about a server.
    expect(new PostgresDialect().sqlTypeFor(addr)).toBe('inet');
    expect(new BaseDialect().sqlTypeFor(addr)).toBe('varchar(15)');
    // The emitted ORDER BY names the column and nothing else — there is no cast,
    // no `LOWER`, nothing that could change the ordering the store performs.
    expect(engine.toSQL(ORDER_HOSTS, 'postgres').sql).toContain('ORDER BY "host"."addr" ASC');
  });

  it('WITHOUT a declared comparator the runtime stringifies — the divergence step 4 exists to close', async () => {
    // Not an aspiration: this is what an `inet` column answered through
    // `engine.run` on every release before the hook existed, while the same
    // query at the database answered `BY_ADDRESS`.
    const rows = (await hostEngine({ comparator: false }).run(ORDER_HOSTS)).rows;
    expect(rows.map((r) => r['addr'])).toEqual(BY_STRING);
    expect(BY_STRING).not.toEqual(BY_ADDRESS);
  });

  it('WITH `compareValues` the runtime orders by address, matching what `inet` does', async () => {
    const rows = (await hostEngine().run(ORDER_HOSTS)).rows;
    expect(rows.map((r) => r['addr'])).toEqual(BY_ADDRESS);
  });

  it('the comparator governs DESC and the comparison arms too, not only the sort', async () => {
    const engine = hostEngine();
    const desc: SelectDef = { ...ORDER_HOSTS, order: [{ expr: ref('host', 'addr'), dir: 'desc' }] };
    expect((await engine.run(desc)).rows.map((r) => r['addr'])).toEqual([...BY_ADDRESS].reverse());
    // `< '10.0.0.10'` keeps ONLY `10.0.0.2` by address; by string it would keep
    // nothing at all, since `'10.0.0.10'` is the smallest of the three.
    const under: SelectDef = { ...ORDER_HOSTS, where: [cmp('<', ref('host', 'addr'), lit('10.0.0.10'))] };
    expect((await engine.run(under)).rows.map((r) => r['addr'])).toEqual(['10.0.0.2']);
    expect(engine.toSQL(under, 'postgres').sql).toContain('"host"."addr" < $1');
  });

  it("a COMPUTED value carries the callable's declared output type, so the same comparator applies", async () => {
    // The second half of step 4. A function's result `Value` used to carry no
    // type at all, so ordering by `netmask(addr)` stringified even where
    // ordering by `addr` did not — one type, two answers, decided by whether the
    // value came from a column.
    const engine = hostEngine();
    const registry = engine.registry;
    for (const [name, output] of [
      ['sameAddr', { kind: 'text', as: 'IpAddress' }],
      ['sameText', { kind: 'text' }],
    ] as const) {
      registry.registerFunction({
        name,
        shape: 'scalar',
        params: [{ name: 'value', type: { kind: 'text' } }],
        output,
        instructions: 'Identity, so the ordering under test is the OUTPUT TYPE and not the values.',
      });
      registry.registerFunctionRun(name, { shape: 'scalar', run: (args) => Value.of(args['value']!.raw) });
    }
    const orderBy = (fn: string): SelectDef => ({
      kind: 'select',
      fields: [{ expr: ref('host', 'addr'), as: 'addr' }],
      from: { kind: 'type', type: 'host' },
      order: [{ expr: { kind: 'function-call', function: fn, args: { value: ref('host', 'addr') } }, dir: 'asc' }],
    });
    // Identical values, identical run, identical SQL shape — the ONLY difference
    // is what the two declarations say their output is.
    expect((await engine.run(orderBy('sameAddr'))).rows.map((r) => r['addr'])).toEqual(BY_ADDRESS);
    expect((await engine.run(orderBy('sameText'))).rows.map((r) => r['addr'])).toEqual(BY_STRING);
    expect(engine.toSQL(orderBy('sameAddr'), 'postgres').sql).toContain('ORDER BY sameAddr("host"."addr") ASC');
  });
});

// ─── P0-4 (cont.): a DECLARED OUTPUT's casing governs both roads ─────────────

describe('runtime ↔ SQL agreement — a declared output casing governs both roads', () => {
  /** An engine over `doc` plus two identity functions differing only in declared output casing. */
  function casedEngine(): QueryEngine {
    const registry = createRegistry();
    registry.registerType(registry.parseType(docDef));
    for (const [name, output] of [
      ['exactly', { kind: 'text', casing: 'exact' }],
      ['loosely', { kind: 'text' }],
    ] as const) {
      registry.registerFunction({
        name,
        shape: 'scalar',
        params: [{ name: 'value', type: { kind: 'text' } }],
        output,
        instructions: 'Identity, so the casing under test is the declared OUTPUT and not the values.',
      });
      registry.registerFunctionRun(name, { shape: 'scalar', run: (args) => Value.of(args['value']!.raw) });
    }
    registry.finalize();
    return new QueryEngine(registry, { executors: { doc: arrayExecutor(docRows) } });
  }
  const call = (fn: string, field: string): ExprDef => ({
    kind: 'function-call',
    function: fn,
    args: { value: ref('doc', field) },
  });
  const whereCall = (fn: string): SelectDef => ({
    kind: 'select',
    fields: [{ expr: ref('doc', 'id'), as: 'id' }],
    from: { kind: 'type', type: 'doc' },
    where: [cmp('=', call(fn, 'title'), lit('hello'))],
    order: [{ expr: ref('doc', 'id'), dir: 'asc' }],
  });

  it("an `exact`-cased declared output is case-SENSITIVE in run and in SQL", async () => {
    const def = whereCall('exactly');
    // `doc` holds 'Hello' and 'WORLD'; neither is exactly 'hello'.
    expect((await casedEngine().run(def)).rows).toEqual([]);
    expect(casedEngine().toSQL(def, 'base').sql).not.toContain('LOWER(');
  });

  it('an output declaring NO casing follows the engine default, in run and in SQL', async () => {
    const def = whereCall('loosely');
    // The package default is `'fold'`, so 'Hello' matches.
    expect((await casedEngine().run(def)).rows).toEqual([{ id: 1 }]);
    expect(casedEngine().toSQL(def, 'base').sql).toContain('LOWER(loosely("doc"."title")) = LOWER(?)');
  });
});
