/**
 * Coverage driver for the DYNAMIC-SORT feature:
 *   exprs/sorter.ts (SorterExpr), the `order` union in schema.ts / select.ts, the
 *   RuntimeContext `sortSpec` + SqlContext `sortSpec` threading, the
 *   `engine.toSQL({ sort })` / `run({ sort })` plumbing, the `Query.sorters`
 *   introspection, the validation codes, the LLM order-schema wiring, and the
 *   drill-down sorter paths.
 *
 * Exercises: the catalog round-trip (toJSON / clone / toCode / forEachChild /
 * canonicalize / SHAPE), runtime re-sorting under several specs (incl. an
 * `output`-ref sort + a `defaultSort` fallback + a no-selection no-default
 * unsorted case), `toSQL` ORDER BY emission (base + postgres) for a spec / the
 * default, the `sort.unknown-name` runtime error, the `sorter.misplaced` /
 * `sorter.empty` / `sorter.unknown-default` / `group.ungrouped-column` validation
 * codes, `Query.sorters`, the LLM schema offering a sorter in `order` while
 * rejecting it in the general Expr union, and the drill-down expansion / drop.
 */
import { describe, it, expect } from 'vitest';
import { fixture, runtimeFixture, typeScope, ref, lit, cmp } from './_utils';
import { createRegistry } from '../registry';
import { RuntimeContext } from '../runtime/context';
import { SorterExpr } from '../exprs/sorter';
import { canonicalize } from '../expr';
import { Problems } from '../problem';
import { isRecord } from '../shape';
import { buildSchemas } from '../llm/schemas';
import { exprKindApplicable, selectFunctions, sorterSchema } from '../schema-build';
import { describeEngine } from '../llm/describe';
import { drillDown } from '../transforms/drill-down';
import { JoinCtePlanner } from '../sql/planner';
import { SqlContext } from '../sql/emit';
import type { SelectDef, ExprDef, SorterDef, SortSelectionDef } from '../schema';

const outRef = (name: string): ExprDef => ({ kind: 'output', name });

/** A `sorter` order entry over `user.name` / `user.age`, optionally with a default. */
const nameAgeSorter = (defaultSort?: SorterDef['defaultSort']): SorterDef => ({
  kind: 'sorter',
  sorts: { name: ref('user', 'name'), age: ref('user', 'age') },
  ...(defaultSort ? { defaultSort } : {}),
});

/** A SELECT of user name+age whose `order` is a single sorter. */
const userSelect = (order: SelectDef['order']): SelectDef => ({
  kind: 'select',
  fields: [
    { expr: ref('user', 'name'), as: 'name' },
    { expr: ref('user', 'age'), as: 'age' },
  ],
  from: { kind: 'type', type: 'user' },
  order,
});

// ─── sorter.ts — serialization / schema / static from ─────────────────────────

describe('sorter: serialization, schema, static from', () => {
  const fx = fixture();

  it('round-trips toJSON / clone / toCode / forEachChild / canonicalize', () => {
    const def = nameAgeSorter([{ sort: 'name', dir: 'asc' }]);
    const e = fx.engine.parse(def);
    expect(e.toJSON()).toEqual(def);
    expect(e.clone().toJSON()).toEqual(def);
    expect(e.toCode()).toBe('sorter(name, age)');
    let n = 0;
    e.forEachChild(() => n++);
    expect(n).toBe(2); // its two catalog exprs
    expect(canonicalize(e)).toBe(canonicalize(fx.engine.parse(nameAgeSorter([{ sort: 'name', dir: 'asc' }]))));
    expect(canonicalize(e)).not.toBe(canonicalize(fx.engine.parse(nameAgeSorter())));
  });

  it('toJSON / clone drop an absent defaultSort', () => {
    const e = fx.engine.parse(nameAgeSorter());
    expect(e.toJSON()).toEqual({ kind: 'sorter', sorts: { name: ref('user', 'name'), age: ref('user', 'age') } });
    expect((e.clone() as SorterExpr).defaultSort).toBeUndefined();
  });

  it('static `from` rejects a mismatched kind', () => {
    expect(() => SorterExpr.from(lit(1), fx.registry)).toThrow(/expected 'sorter'/);
  });

  it('toSchema accepts a well-formed sorter and rejects a bad one', () => {
    const schema = SorterExpr.toSchema({});
    expect(schema.safeParse(nameAgeSorter([{ sort: 'name', dir: 'asc' }])).success).toBe(true);
    expect(schema.safeParse({ kind: 'sorter' }).success).toBe(false); // missing `sorts`
    expect(schema.safeParse({ kind: 'sorter', sorts: { a: ref('user', 'name') }, defaultSort: [{ sort: 'a' }] }).success).toBe(false); // entry missing `dir`
  });

  it('sorterSchema builds the same shape from a child-expr slot', () => {
    const s = sorterSchema(buildSchemas(fx.engine).Expr);
    expect(s.safeParse(nameAgeSorter()).success).toBe(true);
  });
});

// ─── sorter.ts — resolve / cost / evaluate / toSQL value fallbacks ─────────────

describe('sorter: value-position fallbacks (never reached after validation)', () => {
  const fx = fixture();

  it('resolve ⇒ nullable text; cost ⇒ zero; evaluate ⇒ NULL; toSQL ⇒ NULL', async () => {
    const scope = typeScope(fx);
    const e = fx.engine.parse(nameAgeSorter());
    expect(fx.engine.resolveExpr(nameAgeSorter(), scope).kind).toBe('computed');
    expect(e.cost(fx.engine, scope)).toEqual({ rows: 0, bytes: 0 });

    const ctx = new RuntimeContext(fx.engine);
    expect((await e.evaluate(ctx, null)).isNull()).toBe(true);

    const dialect = fx.registry.dialect('base');
    if (!dialect) throw new Error('base dialect missing');
    const planner = new JoinCtePlanner(dialect, fx.engine, undefined);
    const sctx = new SqlContext(dialect, fx.engine, fx.engine.globalScope(), planner, undefined);
    expect(e.toSQL(dialect, sctx).render(dialect).sql).toBe('NULL');
  });
});

// ─── sorter.ts — expand() term generation ─────────────────────────────────────

describe('sorter: expand() into concrete terms', () => {
  const fx = fixture();
  const sorter = (): SorterExpr => fx.engine.parse(nameAgeSorter([{ sort: 'name', dir: 'asc' }])) as SorterExpr;

  it('spec drives the terms (dir defaults to asc); order preserved (multi-key)', () => {
    const terms = sorter().expand([{ sort: 'age', dir: 'desc' }, { sort: 'name' }]);
    expect(terms.map((t) => [t.expr.toCode(), t.dir])).toEqual([
      ['user.age', 'desc'],
      ['user.name', 'asc'], // `dir` omitted ⇒ asc
    ]);
  });

  it('no spec ⇒ falls back to defaultSort; neither ⇒ zero terms', () => {
    expect(sorter().expand(undefined).map((t) => [t.expr.toCode(), t.dir])).toEqual([['user.name', 'asc']]);
    expect(sorter().expand([]).map((t) => t.dir)).toEqual(['asc']); // empty spec ⇒ default
    const noDefault = fx.engine.parse(nameAgeSorter()) as SorterExpr;
    expect(noDefault.expand(undefined)).toEqual([]);
  });

  it('a selected name absent from `sorts` is a loud sort.unknown-name error', () => {
    expect(() => sorter().expand([{ sort: 'nope' }])).toThrow(/sort\.unknown-name/);
  });
});

// ─── sorter.ts — validation codes ─────────────────────────────────────────────

describe('sorter: validation codes', () => {
  const fx = fixture();
  const codes = (def: SelectDef): string[] => fx.engine.validateQuery(def).list.map((x) => x.code);

  it('a well-placed sorter (incl. an output-ref sort + default) validates clean', () => {
    const def: SelectDef = {
      kind: 'select',
      fields: [{ expr: ref('user', 'name'), as: 'name' }, { expr: ref('user', 'age'), as: 'age' }],
      from: { kind: 'type', type: 'user' },
      order: [
        {
          kind: 'sorter',
          sorts: { name: ref('user', 'name'), byOut: outRef('age') },
          defaultSort: [{ sort: 'name', dir: 'asc' }],
        },
      ],
    };
    expect(fx.engine.validateQuery(def).hasErrors).toBe(false);
  });

  it('sorter.misplaced when a sorter is used outside an order list (WHERE)', () => {
    const def: SelectDef = { ...userSelect(undefined), where: [nameAgeSorter()] };
    expect(codes(def)).toContain('sorter.misplaced');
  });

  it('sorter.empty when `sorts` is empty', () => {
    expect(codes(userSelect([{ kind: 'sorter', sorts: {} }]))).toContain('sorter.empty');
  });

  it('sorter.unknown-default when defaultSort names a non-declared sort', () => {
    expect(codes(userSelect([nameAgeSorter([{ sort: 'missing', dir: 'asc' }])]))).toContain('sorter.unknown-default');
  });

  it('a bad catalog expr surfaces the underlying order-term error', () => {
    // `order.userId` is a relation → a relation-as-value error, exactly as an
    // ordinary ORDER BY term would raise.
    const def: SelectDef = {
      kind: 'select',
      fields: [{ expr: ref('order', 'id'), as: 'id' }],
      from: { kind: 'type', type: 'order' },
      order: [{ kind: 'sorter', sorts: { u: ref('order', 'userId') } }],
    };
    expect(fx.engine.validateQuery(def).hasErrors).toBe(true);
  });

  it('group.ungrouped-column fires on a sorter catalog expr under GROUP BY', () => {
    const def: SelectDef = {
      kind: 'select',
      fields: [{ expr: ref('order', 'id'), as: 'id' }],
      from: { kind: 'type', type: 'order' },
      groupBy: [ref('order', 'id')],
      order: [{ kind: 'sorter', sorts: { t: ref('order', 'total') } }],
    };
    expect(codes(def)).toContain('group.ungrouped-column');
  });
});

// ─── SHAPE dispatch (owned structural parser) ─────────────────────────────────

describe('sorter: owned SHAPE dispatch (parseCheckedQuery)', () => {
  const registry = createRegistry();

  it('parses an order with BOTH a normal term and a sorter, no structural problems', () => {
    const def = {
      kind: 'select',
      fields: [{ expr: ref('user', 'name'), as: 'name' }],
      from: { kind: 'type', type: 'user' },
      order: [
        { expr: ref('user', 'name'), dir: 'asc' },
        { kind: 'sorter', sorts: { age: ref('user', 'age') }, defaultSort: [{ sort: 'age', dir: 'desc' }] },
      ],
    };
    const p = new Problems();
    const built = registry.parseCheckedQuery(def, p);
    expect(p.hasErrors).toBe(false);
    expect(built).toBeDefined();
  });

  it('records a structural problem for a malformed sorter entry', () => {
    const def = {
      kind: 'select',
      fields: [{ expr: ref('user', 'name'), as: 'name' }],
      from: { kind: 'type', type: 'user' },
      order: [{ kind: 'sorter', sorts: { age: ref('user', 'age') }, defaultSort: [{ sort: 'age' }] }], // entry missing dir
    };
    const p = new Problems();
    registry.parseCheckedQuery(def, p);
    expect(p.hasErrors).toBe(true);
  });
});

// ─── Runtime re-sorting ───────────────────────────────────────────────────────

describe('sorter: runtime re-sorting', () => {
  const names = async (order: SelectDef['order'], sort?: SortSelectionDef[]): Promise<string[]> => {
    const rfx = runtimeFixture();
    const rows = (await rfx.engine.run(userSelect(order), sort ? { sort } : undefined)).rows;
    return rows.map((r) => String(r['name']));
  };

  it('re-sorts live: different specs change the row order', async () => {
    const sorter = [nameAgeSorter([{ sort: 'name', dir: 'asc' }])];
    // ages: Ada 36, Bob 42, Cleo 29.
    expect(await names(sorter, [{ sort: 'age', dir: 'asc' }])).toEqual(['Cleo', 'Ada', 'Bob']);
    expect(await names(sorter, [{ sort: 'age', dir: 'desc' }])).toEqual(['Bob', 'Ada', 'Cleo']);
    expect(await names(sorter, [{ sort: 'name' }])).toEqual(['Ada', 'Bob', 'Cleo']); // dir ⇒ asc
  });

  it('no spec ⇒ the defaultSort applies', async () => {
    expect(await names([nameAgeSorter([{ sort: 'age', dir: 'desc' }])])).toEqual(['Bob', 'Ada', 'Cleo']);
  });

  it('a sorter with neither a spec nor a default leaves rows unsorted', async () => {
    // Insertion order (Ada, Bob, Cleo) survives — the order clause is present but
    // expands to nothing, so no default-order fallback runs either.
    expect(await names([nameAgeSorter()])).toEqual(['Ada', 'Bob', 'Cleo']);
  });

  it('an output-ref sort re-computes over the projected field', async () => {
    const order: SelectDef['order'] = [
      { kind: 'sorter', sorts: { byAge: outRef('age') }, defaultSort: [{ sort: 'byAge', dir: 'asc' }] },
    ];
    expect(await names(order, [{ sort: 'byAge', dir: 'desc' }])).toEqual(['Bob', 'Ada', 'Cleo']);
  });

  it('the unknown-name error surfaces at run time', async () => {
    await expect(names([nameAgeSorter()], [{ sort: 'nope' }])).rejects.toThrow(/sort\.unknown-name/);
  });
});

// ─── SQL ORDER BY emission ────────────────────────────────────────────────────

describe('sorter: SQL ORDER BY emission (base + postgres)', () => {
  const fx = fixture();

  it('emits the selected terms in both dialects', () => {
    for (const dialect of ['base', 'postgres'] as const) {
      const { sql } = fx.engine.toSQL(userSelect([nameAgeSorter()]), dialect, {
        sort: [{ sort: 'age', dir: 'desc' }, { sort: 'name' }],
      });
      expect(sql).not.toContain('sorter');
      expect(sql).toContain('ORDER BY "user"."age" DESC, "user"."name" ASC');
    }
  });

  it('expands an output-ref sort to the underlying column', () => {
    const order: SelectDef['order'] = [{ kind: 'sorter', sorts: { byAge: outRef('age') } }];
    const { sql } = fx.engine.toSQL(userSelect(order), 'postgres', { sort: [{ sort: 'byAge', dir: 'asc' }] });
    expect(sql).toContain('ORDER BY "user"."age" ASC');
    expect(sql).not.toContain('output');
  });

  it('no spec ⇒ emits the defaultSort', () => {
    const { sql } = fx.engine.toSQL(userSelect([nameAgeSorter([{ sort: 'name', dir: 'asc' }])]), 'base');
    expect(sql).toContain('ORDER BY "user"."name" ASC');
  });

  it('a sorter with neither spec nor default emits NO ORDER BY', () => {
    const { sql } = fx.engine.toSQL(userSelect([nameAgeSorter()]), 'base');
    expect(sql).not.toContain('ORDER BY');
  });
});

// ─── Query.sorters introspection ──────────────────────────────────────────────

describe('sorter: Query.sorters introspection', () => {
  const fx = fixture();

  it('lists each exposed sort name with its resolved orderable type', () => {
    const q = fx.engine.parseQuery(
      userSelect([{ kind: 'sorter', sorts: { name: ref('user', 'name'), byAge: outRef('age') } }]),
    );
    const sorters = q.sorters(fx.engine);
    expect(Object.keys(sorters).sort()).toEqual(['byAge', 'name']);
    expect(sorters['name']!.fieldType).toBe('text');
    // `byAge` resolves through the output ref to `user.age` (a number, nullable).
    expect(sorters['byAge']!.fieldType).toBe('number');
    expect(sorters['byAge']!.nullable).toBe(true);
  });

  it('a query with no sorter (or a non-select query) yields {}', () => {
    expect(fx.engine.parseQuery(userSelect(undefined)).sorters(fx.engine)).toEqual({});
    // A non-SELECT query uses the base `sorterScope` (no outputs) and finds none.
    const insert = fx.engine.parseQuery({ kind: 'insert', into: 'user', rows: [{ id: 9, name: 'Zed', email: 'z@x' }] });
    expect(insert.sorters(fx.engine)).toEqual({});
  });
});

// ─── LLM schema: order-position offering ──────────────────────────────────────

describe('sorter: LLM schema position gating', () => {
  const fx = fixture();
  const schemas = buildSchemas(fx.engine);

  it('offers a sorter inside a SELECT order, alongside normal terms', () => {
    const def = {
      kind: 'select',
      fields: [{ expr: ref('user', 'name'), as: 'name' }],
      from: { kind: 'type', type: 'user' },
      order: [
        { expr: ref('user', 'name'), dir: 'asc' },
        { kind: 'sorter', sorts: { age: ref('user', 'age') }, defaultSort: [{ sort: 'age', dir: 'desc' }] },
      ],
    };
    expect(schemas.Select.safeParse(def).success).toBe(true);
  });

  it('does NOT offer a sorter in the general Expr union / WHERE', () => {
    expect(schemas.Expr.safeParse(nameAgeSorter()).success).toBe(false);
    const badWhere = { ...userSelect(undefined), where: [nameAgeSorter()] };
    expect(schemas.Select.safeParse(badWhere).success).toBe(false);
  });

  it('exprKindApplicable gates `sorter` out of the general union', () => {
    expect(exprKindApplicable('sorter', fx.registry.typeList(), selectFunctions(fx.registry))).toBe(false);
  });

  it('describeEngine renders the worked sorter example', () => {
    const de = describeEngine(fx.engine, { maxExamples: 5 });
    expect(de).toContain('"kind":"sorter"');
  });
});

// ─── drill-down: sorter handling ──────────────────────────────────────────────

describe('sorter: drill-down handling', () => {
  const fx = fixture();

  it('keeps a non-aggregate sorter through an un-ravelling drill', () => {
    const def: SelectDef = {
      kind: 'select',
      fields: [{ expr: ref('order', 'userId'), as: 'userId' }, { expr: { kind: 'aggregate', function: 'sum', args: { value: ref('order', 'total') } }, as: 'revenue' }],
      from: { kind: 'type', type: 'order' },
      groupBy: [ref('order', 'userId')],
      order: [{ kind: 'sorter', sorts: { byUser: ref('order', 'userId') } }],
    };
    const d = drillDown(def, fx.engine);
    expect('query' in d).toBe(true);
    if ('query' in d) expect(JSON.stringify(d.query.toJSON())).toContain('"kind":"sorter"');
  });

  it('expands an output-ref sorter, then drops it as aggregate (warns)', () => {
    const def: SelectDef = {
      kind: 'select',
      fields: [{ expr: ref('order', 'userId'), as: 'userId' }, { expr: { kind: 'aggregate', function: 'sum', args: { value: ref('order', 'total') } }, as: 'revenue' }],
      from: { kind: 'type', type: 'order' },
      groupBy: [outRef('userId')],
      order: [{ kind: 'sorter', sorts: { byRev: outRef('revenue') } }],
    };
    const d = drillDown(def, fx.engine);
    expect('query' in d).toBe(true);
    if ('query' in d) {
      expect(JSON.stringify(d.query.toJSON())).not.toContain('"kind":"sorter"'); // dropped
      expect(d.warnings.list.some((p) => p.code === 'drill.order-dropped')).toBe(true);
    }
  });
});
