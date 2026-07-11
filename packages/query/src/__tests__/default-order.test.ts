/**
 * Default ordering — a Type's NATURAL sort (`TypeBacking.defaultOrder`). A
 * SELECT whose FROM binds the backed Type, that specifies NO explicit `order`
 * and is neither aggregated nor DISTINCT, synthesizes its `ORDER BY` from the
 * Type's declared terms — emitted to SQL AND applied in memory identically. The
 * `applyTo` scope (`'result'` / `'paginated'` / `'all'`) decides WHICH such
 * SELECTs (the root query, any paged one, or every eligible one) receive it.
 *
 * The `post` fixture sorts newest-first by `createdAt` (a nullable timestamp, so
 * NULLs-placement is exercised too).
 */
import { describe, it, expect } from 'vitest';
import { createRegistry } from '../registry';
import { QueryEngine } from '../engine';
import { arrayExecutor } from '../runtime/executor';
import { describeType } from '../llm/describe';
import { autoPaginate } from '../transforms/index';
import { ref } from '../builder';
import { Value } from '../runtime/value';
import type { TypeBacking, DefaultOrder } from '../backing';
import type { TypeDef, SelectDef } from '../schema';
import type { SourceRecord } from '../runtime/row';

/** Conceptual `post` Type: id + title + a nullable `createdAt` timestamp + score. */
const postDef: TypeDef = {
  name: 'post',
  fields: [
    { name: 'id', type: { kind: 'number', whole: true } },
    { name: 'title', type: { kind: 'text' } },
    { name: 'createdAt', type: { kind: 'timestamp' }, nullable: true },
    { name: 'score', type: { kind: 'number' } },
  ],
  indexes: [{ exprs: [{ expr: { kind: 'field-ref', source: 'post', field: 'id' }, count: 1 }] }],
  count: 100,
  bytes: 64,
};

/** Insertion order 1..4; createdAt descending is [2, 3, 1] then the NULL id 4. */
const postRows: SourceRecord[] = [
  { id: 1, title: 'a', createdAt: '2020-01-01T00:00:00', score: 5 },
  { id: 2, title: 'b', createdAt: '2022-01-01T00:00:00', score: 3 },
  { id: 3, title: 'c', createdAt: '2021-01-01T00:00:00', score: 9 },
  { id: 4, title: 'd', createdAt: null, score: 1 },
];

/** Build a registry + engine over `post` with the given backing. */
function postFixture(backing: TypeBacking) {
  const registry = createRegistry();
  const post = registry.parseType(postDef);
  registry.registerType(post, backing);
  registry.finalize();
  const engine = new QueryEngine(registry, { executors: { post: arrayExecutor(postRows) } });
  return { registry, engine, post };
}

/** The canonical newest-first natural order (createdAt DESC, `applyTo` default 'result'). */
const descByCreated: TypeBacking = {
  defaultOrder: { by: [{ by: { expr: (a) => ref(a, 'createdAt') }, dir: 'desc' }] },
};

/** SELECT id FROM post (optionally aliased / limited / etc.). */
function selectIds(extra: Partial<SelectDef> = {}): SelectDef {
  return {
    kind: 'select',
    fields: [{ expr: { kind: 'field-ref', source: 'post', field: 'id' }, as: 'id' }],
    from: { kind: 'type', type: 'post' },
    ...extra,
  };
}

/** The `id` values a run returns, IN RESULT ORDER (not re-sorted). */
async function runIds(engine: QueryEngine, def: SelectDef): Promise<number[]> {
  const res = await engine.run(def);
  return res.rows.map((r) => Number(r['id']));
}

describe('default order — basic application (SQL + runtime)', () => {
  it('an unsorted select emits the default ORDER BY in BOTH dialects', () => {
    const { engine } = postFixture(descByCreated);
    for (const dialect of ['base', 'postgres'] as const) {
      expect(engine.toSQL(selectIds(), dialect).sql).toContain('ORDER BY "post"."createdAt" DESC');
    }
  });

  it('an unsorted select sorts rows by the default order at runtime', async () => {
    const { engine } = postFixture(descByCreated);
    // createdAt DESC ⇒ 2022, 2021, 2020, then NULL last (desc default).
    expect(await runIds(engine, selectIds())).toEqual([2, 3, 1, 4]);
  });

  it('an EXPLICIT order owns the sort — the default is NOT applied', async () => {
    const { engine } = postFixture(descByCreated);
    const def = selectIds({ order: [{ expr: { kind: 'field-ref', source: 'post', field: 'id' }, dir: 'asc' }] });
    const sql = engine.toSQL(def, 'base').sql;
    expect(sql).toContain('ORDER BY "post"."id" ASC');
    expect(sql).not.toContain('createdAt');
    expect(await runIds(engine, def)).toEqual([1, 2, 3, 4]);
  });
});

describe('default order — skipped when ordering is meaningless', () => {
  it('a GROUP BY query is NOT reordered', async () => {
    const { engine } = postFixture(descByCreated);
    const def: SelectDef = {
      kind: 'select',
      fields: [
        { expr: { kind: 'field-ref', source: 'post', field: 'score' }, as: 'score' },
        { expr: { kind: 'aggregate', function: 'count', args: {} }, as: 'n' },
      ],
      from: { kind: 'type', type: 'post' },
      groupBy: [{ kind: 'field-ref', source: 'post', field: 'score' }],
    };
    expect(engine.toSQL(def, 'base').sql).not.toContain('createdAt');
  });

  it('a bare-aggregate query is NOT reordered', () => {
    const { engine } = postFixture(descByCreated);
    const def: SelectDef = {
      kind: 'select',
      fields: [{ expr: { kind: 'aggregate', function: 'count', args: {} }, as: 'n' }],
      from: { kind: 'type', type: 'post' },
    };
    expect(engine.toSQL(def, 'base').sql).not.toContain('ORDER BY');
  });

  it('a DISTINCT query is NOT reordered (a non-selected key would be illegal SQL)', async () => {
    const { engine } = postFixture(descByCreated);
    const def: SelectDef = {
      kind: 'select',
      distinct: true,
      fields: [{ expr: { kind: 'field-ref', source: 'post', field: 'title' }, as: 'title' }],
      from: { kind: 'type', type: 'post' },
    };
    expect(engine.toSQL(def, 'base').sql).not.toContain('ORDER BY');
    // Runtime keeps first-seen (insertion) order — unsorted.
    const res = await engine.run(def);
    expect(res.rows.map((r) => r['title'])).toEqual(['a', 'b', 'c', 'd']);
  });

  it('an empty `by` list applies nothing', () => {
    const { engine } = postFixture({ defaultOrder: { by: [] } });
    expect(engine.toSQL(selectIds(), 'base').sql).not.toContain('ORDER BY');
  });

  it('a FROM subquery (no backed Type) gets no default order on the OUTER select', () => {
    const { engine } = postFixture(descByCreated);
    const outer: SelectDef = {
      kind: 'select',
      fields: [{ expr: { kind: 'field-ref', source: 'p', field: 'id' }, as: 'id' }],
      from: { kind: 'subquery', as: 'p', query: selectIds() },
    };
    const sql = engine.toSQL(outer, 'base').sql;
    // The inner (root-derived? no — non-root, but paged? no) does NOT order; the
    // outer's FROM is a subquery so it has no backed default order either.
    expect(sql.match(/ORDER BY/g)).toBeNull();
  });
});

describe('default order — applyTo scopes', () => {
  /** A limited / unlimited FROM subquery over post, wrapped by a passthrough outer. */
  function nestedSubquery(innerLimited: boolean): SelectDef {
    const inner = selectIds(innerLimited ? { limit: 10 } : {});
    return {
      kind: 'select',
      fields: [{ expr: { kind: 'field-ref', source: 'p', field: 'id' }, as: 'id' }],
      from: { kind: 'subquery', as: 'p', query: inner },
    };
  }

  it("'result' (default): applies to the ROOT and to a LIMITED subquery, not an unlimited one", () => {
    const { engine } = postFixture(descByCreated);
    // Root.
    expect(engine.toSQL(selectIds(), 'base').sql).toContain('ORDER BY "post"."createdAt" DESC');
    // Limited inner subquery ⇒ ordered.
    expect(engine.toSQL(nestedSubquery(true), 'base').sql).toContain('ORDER BY "post"."createdAt" DESC');
    // Unlimited inner subquery ⇒ NOT ordered.
    expect(engine.toSQL(nestedSubquery(false), 'base').sql).not.toContain('createdAt');
  });

  it("'result': applies to a root select WITH a limit (paged root)", () => {
    const { engine } = postFixture(descByCreated);
    expect(engine.toSQL(selectIds({ limit: 2 }), 'base').sql).toContain('ORDER BY "post"."createdAt" DESC');
  });

  it("'paginated': only a LIMIT/OFFSET select is ordered (root without one is NOT)", () => {
    const paginated: TypeBacking = {
      defaultOrder: { by: [{ by: { expr: (a) => ref(a, 'createdAt') }, dir: 'desc' }], applyTo: 'paginated' },
    };
    const { engine } = postFixture(paginated);
    expect(engine.toSQL(selectIds(), 'base').sql).not.toContain('createdAt'); // root, unpaged
    expect(engine.toSQL(selectIds({ offset: 1 }), 'base').sql).toContain('ORDER BY "post"."createdAt" DESC');
  });

  it("'all': every eligible select is ordered, incl. an UNLIMITED inner subquery", () => {
    const all: TypeBacking = {
      defaultOrder: { by: [{ by: { expr: (a) => ref(a, 'createdAt') }, dir: 'desc' }], applyTo: 'all' },
    };
    const { engine } = postFixture(all);
    expect(engine.toSQL(nestedSubquery(false), 'base').sql).toContain('ORDER BY "post"."createdAt" DESC');
  });

  it('a non-root LIMITED subquery is ordered at RUNTIME too (result scope)', async () => {
    const { engine } = postFixture(descByCreated);
    const res = await engine.run(nestedSubquery(true));
    expect(res.rows.map((r) => Number(r['id']))).toEqual([2, 3, 1, 4]);
  });

  it('a non-root UNLIMITED subquery is NOT ordered at runtime (result scope)', async () => {
    const { engine } = postFixture(descByCreated);
    const res = await engine.run(nestedSubquery(false));
    expect(res.rows.map((r) => Number(r['id']))).toEqual([1, 2, 3, 4]); // insertion order
  });
});

describe('default order — the Computed key: expr / sql / run variants', () => {
  it('a `sql`-only key emits in SQL but no-ops at runtime', async () => {
    const sqlOnly: TypeBacking = {
      defaultOrder: { by: [{ by: { sql: (a, ctx) => ctx.dialect.field(a, 'createdAt') }, dir: 'desc' }] },
    };
    const { engine } = postFixture(sqlOnly);
    expect(engine.toSQL(selectIds(), 'base').sql).toContain('ORDER BY "post"."createdAt" DESC');
    // No `run`/`expr` ⇒ the runtime cannot resolve the key ⇒ unsorted.
    expect(await runIds(engine, selectIds())).toEqual([1, 2, 3, 4]);
  });

  it('a `run`-only key sorts at runtime but no-ops in SQL', async () => {
    const runOnly: TypeBacking = {
      defaultOrder: {
        by: [{ by: { run: (a, row) => Value.of(row[a]?.['createdAt'] ?? null) }, dir: 'desc' }],
      },
    };
    const { engine } = postFixture(runOnly);
    expect(await runIds(engine, selectIds())).toEqual([2, 3, 1, 4]);
    // No `sql`/`expr` ⇒ nothing to emit into the ORDER BY.
    expect(engine.toSQL(selectIds(), 'base').sql).not.toContain('ORDER BY');
  });
});

describe('default order — dir / nulls placement', () => {
  it('ascending default (nulls first) — SQL + runtime', async () => {
    const asc: TypeBacking = {
      defaultOrder: { by: [{ by: { expr: (a) => ref(a, 'createdAt') } }] }, // dir defaults to asc
    };
    const { engine } = postFixture(asc);
    expect(engine.toSQL(selectIds(), 'base').sql).toContain('ORDER BY "post"."createdAt" ASC');
    // asc ⇒ NULL (id 4) sorts first by default.
    expect(await runIds(engine, selectIds())).toEqual([4, 1, 3, 2]);
  });

  it('explicit `nulls` placement is emitted and honored', async () => {
    const descNullsFirst: TypeBacking = {
      defaultOrder: { by: [{ by: { expr: (a) => ref(a, 'createdAt') }, dir: 'desc', nulls: 'first' }] },
    };
    const { engine } = postFixture(descNullsFirst);
    expect(engine.toSQL(selectIds(), 'base').sql).toContain('ORDER BY "post"."createdAt" DESC NULLS FIRST');
    // desc, but NULL forced first ⇒ id 4 leads.
    expect(await runIds(engine, selectIds())).toEqual([4, 2, 3, 1]);
  });
});

describe('default order — alias correctness', () => {
  it('resolves against an ALIASED FROM (self-join escape hatch)', () => {
    const { engine } = postFixture(descByCreated);
    const def: SelectDef = {
      kind: 'select',
      fields: [{ expr: { kind: 'field-ref', source: 'p', field: 'id' }, as: 'id' }],
      from: { kind: 'aliased', type: 'post', as: 'p' },
    };
    expect(engine.toSQL(def, 'base').sql).toContain('ORDER BY "p"."createdAt" DESC');
  });
});

describe('default order — autoPaginate', () => {
  it('a paged query over a defaulted Type orders deterministically', async () => {
    const { engine } = postFixture(descByCreated);
    const paged = autoPaginate(selectIds());
    // The added `limit`/`offset` params make it paginated ⇒ default order applies.
    expect(engine.toSQL(paged, 'base').sql).toContain('ORDER BY "post"."createdAt" DESC');
    const res = await engine.run(paged, { params: { limit: 2, offset: 1 } });
    // Sorted desc [2,3,1,4] then offset 1 + limit 2 ⇒ [3, 1].
    expect(res.rows.map((r) => Number(r['id']))).toEqual([3, 1]);
  });
});

describe('default order — describeType', () => {
  it('adds a terse note for a defaulted Type', () => {
    const { post } = postFixture(descByCreated);
    expect(describeType(post, descByCreated)).toContain('Default order: post.createdAt DESC (applied when unsorted)');
  });

  it('shows the scope when it is not the default `result`', () => {
    const backing: TypeBacking = {
      defaultOrder: { by: [{ by: { expr: (a) => ref(a, 'createdAt') }, dir: 'desc' }], applyTo: 'all' },
    };
    const { post } = postFixture(backing);
    expect(describeType(post, backing)).toContain('(applied when unsorted; all)');
  });

  it('renders a non-`expr` key as `custom`', () => {
    const backing: TypeBacking = {
      defaultOrder: { by: [{ by: { run: (a, row) => Value.of(row[a]?.['createdAt'] ?? null) } }] },
    };
    const { post } = postFixture(backing);
    expect(describeType(post, backing)).toContain('Default order: custom ASC');
  });

  it('omits the note when the Type declares no default order', () => {
    const { post } = postFixture({});
    expect(describeType(post, {})).not.toContain('Default order');
  });
});

// A `DefaultOrder` value is a plain data shape — assert its inferred type stays
// structural (no `any`) by constructing one explicitly.
const _sample: DefaultOrder = { by: [{ by: { expr: (a) => ref(a, 'createdAt') } }], applyTo: 'result' };
void _sample;
