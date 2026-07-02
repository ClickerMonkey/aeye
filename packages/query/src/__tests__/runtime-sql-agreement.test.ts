/**
 * Runtime ↔ SQL agreement for the three predicate/divergence fixes:
 *
 *  - P0-3: three-valued logic (NULL ⇒ UNKNOWN) in comparison / NOT / AND / OR /
 *    IN / NOT IN, so `engine.run` keeps a row only when the predicate is TRUE —
 *    exactly as the emitted SQL would under a real database's 3VL.
 *  - P0-4: text comparisons case-fold by default (the package's insensitive text
 *    default) in BOTH the runtime and SQL, even for two string literals; a
 *    `sensitive:true` field stays case-sensitive in both.
 *  - P0-5: a `relation-path` crossing a relation that is NOT an authored join
 *    resolves the joined value at runtime, matching the join `toSQL` synthesizes.
 *
 * Since these tests run with no live SQL database, "agreement" is shown by (a)
 * the runtime result rows being the SQL-correct ones and (b) the emitted SQL
 * being the canonical form a database evaluates to that same result.
 */
import { describe, it, expect } from 'vitest';
import { createRegistry } from '../registry';
import { QueryEngine } from '../engine';
import { arrayExecutor } from '../runtime/executor';
import { runtimeFixture, lit, ref, cmp, userTypeDef, orderTypeDef } from './_utils';
import type { ExprDef, SelectDef, TypeDef } from '../schema';
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
    { name: 'code', type: { kind: 'text', sensitive: true } }, // case-sensitive
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

  it('a `sensitive:true` field stays case-sensitive in BOTH run and SQL', async () => {
    const def = whereDocs(cmp('=', ref('doc', 'code'), lit('ABC')));
    // Only the row whose `code` is exactly 'ABC' matches (id=1).
    expect((await docEngine().run(def)).rows).toEqual([{ id: 1 }]);
    const sql = docEngine().toSQL(def, 'base').sql;
    expect(sql).toContain('"doc"."code" = ?');
    expect(sql).not.toContain('LOWER("doc"."code")');
  });
});

// ─── P0-5: relation-path joins synthesized at runtime ────────────────────────

describe('runtime ↔ SQL agreement — P0-5 relation-path runtime joins', () => {
  it('a relation-path over a NON-authored join resolves the joined value (run + SQL)', async () => {
    const fx = runtimeFixture();
    // FROM order, reading `order.userId.name` WITHOUT an authored join. Previously
    // the runtime returned NULL (no materialized join); now it synthesizes the
    // same LEFT JOIN the planner emits and resolves the user's name.
    const def: SelectDef = {
      kind: 'select',
      fields: [{ expr: { kind: 'relation-path', source: 'order', path: ['userId', 'name'] }, as: 'cust' }],
      from: { kind: 'type', type: 'order' },
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

  it('a relation-path with a missing related record reads NULL (LEFT-join miss)', async () => {
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
      fields: [{ expr: { kind: 'relation-path', source: 'order', path: ['userId', 'name'] }, as: 'cust' }],
      from: { kind: 'type', type: 'order' },
      order: [{ expr: ref('order', 'id'), dir: 'asc' }],
    };
    expect((await engine.run(def)).rows).toEqual([{ cust: 'Ada' }, { cust: null }]);
  });
});
