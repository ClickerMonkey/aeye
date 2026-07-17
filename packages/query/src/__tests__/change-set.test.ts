/**
 * Tests for the four semantic changes:
 *  1. Simplified relations (name-is-the-key) + inverse materialization + identity.
 *  2. Composite indexes (prefix reduction in cost + round-trip).
 *  3. `sensitive` = case-sensitivity on text (runtime + SQL golden).
 *  4. Type-level `semantic` / `search` eligibility (+ round-trip).
 */
import { describe, it, expect } from 'vitest';
import { createRegistry } from '../registry';
import { QueryEngine } from '../engine';
import { arrayExecutor } from '../runtime/executor';
import type { TypeDef, SelectDef, ExprDef } from '../schema';
import type { SourceRecord } from '../runtime/row';

// ════════════════════════════════════════════════════════════════════════
// CHANGE 1 — relations: inverse materialization, identity, name-is-key
// ════════════════════════════════════════════════════════════════════════

const postDef: TypeDef = {
  name: 'post',
  fields: [
    { name: 'id', type: { kind: 'number', whole: true } },
    { name: 'title', type: { kind: 'text' } },
  ],
  indexes: [{ exprs: [{ expr: { kind: 'field-ref', source: 'post', field: 'id' }, count: 1 }] }],
  count: 100,
  bytes: 40,
};

const commentDef: TypeDef = {
  name: 'comment',
  fields: [
    { name: 'id', type: { kind: 'number', whole: true } },
    { name: 'body', type: { kind: 'text' } },
    // Belongs-to post; materializes `post.comments` (has-many) back via `post`.
    { name: 'post', type: { kind: 'relation', to: 'post', count: 1, inverseRelation: 'comments' } },
  ],
  indexes: [{ exprs: [{ expr: { kind: 'field-ref', source: 'comment', field: 'id' }, count: 1 }] }],
  count: 500,
  bytes: 60,
};

const postRows: SourceRecord[] = [
  { id: 1, title: 'First' },
  { id: 2, title: 'Second' },
];
const commentRows: SourceRecord[] = [
  { id: 10, body: 'a', post: 1 },
  { id: 11, body: 'b', post: 1 },
  { id: 12, body: 'c', post: 2 },
];

function blogEngine(): QueryEngine {
  const registry = createRegistry();
  registry.registerType(registry.parseType(postDef));
  registry.registerType(registry.parseType(commentDef));
  registry.finalize();
  return new QueryEngine(registry, {
    executors: { post: arrayExecutor(postRows), comment: arrayExecutor(commentRows) },
  });
}

describe('change 1 — relations + inverse + identity', () => {
  it('materializes a synthetic inverse has-many on the target', () => {
    const engine = blogEngine();
    engine.cost({ kind: 'select', fields: [{ expr: { kind: 'field-ref', source: 'post', field: 'id' } }], from: { kind: 'type', type: 'post' } });
    const post = engine.type('post')!;
    const comments = post.field('comments');
    expect(comments).toBeDefined();
    const ft = comments!.fieldType;
    if (ft.kind !== 'relation') throw new Error('expected relation');
    expect(ft.to).toBe('comment');
    expect(ft.count).toBeGreaterThan(1); // has-many (round(500/100) = 5)
    expect(comments!.synthetic).toBe(true);
    expect(comments!.nullable).toBe(true);
    // Synthetic fields are OMITTED from toJSON (round-trip stays clean).
    expect(post.toJSON().fields.some((f) => f.name === 'comments')).toBe(false);
  });

  it('queries the inverse relation via a join (correct rows)', async () => {
    const engine = blogEngine();
    const def: SelectDef = {
      kind: 'select',
      fields: [
        { expr: { kind: 'field-ref', source: 'post', field: 'title' }, as: 'post' },
        { expr: { kind: 'field-ref', source: 'c', field: 'id' }, as: 'commentId' },
      ],
      from: { kind: 'type', type: 'post' },
      joins: [{ on: { kind: 'relation', source: 'post', field: 'comments', as: 'c' }, joinType: 'inner' }],
      order: [
        { expr: { kind: 'field-ref', source: 'post', field: 'id' }, dir: 'asc' },
        { expr: { kind: 'field-ref', source: 'c', field: 'id' }, dir: 'asc' },
      ],
    };
    const result = await engine.run(def);
    expect(result.rows).toEqual([
      { post: 'First', commentId: 10 },
      { post: 'First', commentId: 11 },
      { post: 'Second', commentId: 12 },
    ]);
  });

  it('emits the inverse join key in SQL via a named relation join', () => {
    const engine = blogEngine();
    const def: SelectDef = {
      kind: 'select',
      joins: [{ on: { kind: 'relation', source: 'post', field: 'comments', as: 'post_comments' } }],
      fields: [{ expr: { kind: 'field-ref', source: 'post_comments', field: 'body' }, as: 'body' }],
      from: { kind: 'type', type: 'post' },
    };
    const { sql } = engine.toSQL(def, 'base');
    // has-many inverse: post.id = comment.post (FK reused from `comment.post`).
    expect(sql).toContain('LEFT JOIN "comment" AS "post_comments" ON "post"."id" = "post_comments"."post"');
  });

  it('identityField: a unique single-field index wins over the "id" fallback', () => {
    const registry = createRegistry();
    const t = registry.parseType({
      name: 'thing',
      fields: [
        { name: 'id', type: { kind: 'number', whole: true } },
        { name: 'sku', type: { kind: 'text' } },
      ],
      indexes: [{ exprs: [{ expr: { kind: 'field-ref', source: 'thing', field: 'sku' }, count: 1 }] }],
      count: 10,
      bytes: 10,
    });
    expect(t.identityField().name).toBe('sku');
  });

  it('identityField: falls back to the field named "id"', () => {
    const registry = createRegistry();
    const t = registry.parseType({
      name: 'plain',
      fields: [
        { name: 'id', type: { kind: 'number', whole: true } },
        { name: 'x', type: { kind: 'number' } },
      ],
      count: 10,
      bytes: 10,
    });
    expect(t.identityField().name).toBe('id');
  });

  it('identityField: throws a clear error when there is no identity', () => {
    const registry = createRegistry();
    const t = registry.parseType({
      name: 'orphan',
      fields: [{ name: 'label', type: { kind: 'text' } }],
      count: 10,
      bytes: 10,
    });
    expect(() => t.identityField()).toThrow(/needs a primary key/);
  });
});

// ════════════════════════════════════════════════════════════════════════
// CHANGE 2 — composite indexes
// ════════════════════════════════════════════════════════════════════════

const widgetDef: TypeDef = {
  name: 'widget',
  fields: [
    { name: 'a', type: { kind: 'number', whole: true } },
    { name: 'b', type: { kind: 'number', whole: true } },
    { name: 'c', type: { kind: 'number', whole: true } },
  ],
  // composite index (a, b): prefix-100, then unique on the full key.
  indexes: [
    {
      exprs: [
        { expr: { kind: 'field-ref', source: 'widget', field: 'a' }, count: 100 },
        { expr: { kind: 'field-ref', source: 'widget', field: 'b' }, count: 1 },
      ],
    },
  ],
  count: 1000,
  bytes: 10,
};

function widgetEngine(): QueryEngine {
  const registry = createRegistry();
  registry.registerType(registry.parseType(widgetDef));
  return new QueryEngine(registry);
}

function eqWidget(field: string, value: number): ExprDef {
  return { kind: 'comparison', op: '=', left: { kind: 'field-ref', source: 'widget', field }, right: { kind: 'literal', value } };
}

describe('change 2 — composite index prefix reduction', () => {
  const engine = widgetEngine();
  const select = (where: ExprDef[]): SelectDef => ({
    kind: 'select',
    fields: [{ expr: { kind: 'field-ref', source: 'widget', field: 'c' } }],
    from: { kind: 'type', type: 'widget' },
    where,
  });

  it('a partial leading prefix reduces to that part count', () => {
    expect(engine.cost(select([eqWidget('a', 1)])).rows).toBe(100);
  });

  it('the full prefix (unique last part) collapses to a single row', () => {
    expect(engine.cost(select([eqWidget('a', 1), eqWidget('b', 2)])).rows).toBe(1);
  });

  it('a non-leading part alone does not use the index (selectivity instead)', () => {
    // 1000 × 0.33 equality selectivity, floored — no matched prefix.
    expect(engine.cost(select([eqWidget('b', 2)])).rows).toBe(Math.max(1, Math.floor(1000 * 0.33)));
  });

  it('round-trips the new IndexDef shape', () => {
    const registry = createRegistry();
    const t = registry.parseType(widgetDef);
    expect(t.toJSON().indexes).toEqual(widgetDef.indexes);
  });
});

// ════════════════════════════════════════════════════════════════════════
// CHANGE 3 — `sensitive` = case-sensitivity on text
// ════════════════════════════════════════════════════════════════════════

const docDef: TypeDef = {
  name: 'doc',
  fields: [
    { name: 'id', type: { kind: 'number', whole: true } },
    { name: 'title', type: { kind: 'text' } }, // case-insensitive (default)
    { name: 'code', type: { kind: 'text', sensitive: true } }, // case-sensitive
  ],
  indexes: [{ exprs: [{ expr: { kind: 'field-ref', source: 'doc', field: 'id' }, count: 1 }] }],
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

function eqDoc(field: string, value: string): SelectDef {
  return {
    kind: 'select',
    fields: [{ expr: { kind: 'field-ref', source: 'doc', field: 'id' }, as: 'id' }],
    from: { kind: 'type', type: 'doc' },
    where: [{ kind: 'comparison', op: '=', left: { kind: 'field-ref', source: 'doc', field }, right: { kind: 'literal', value } }],
  };
}

describe('change 3 — text case-sensitivity', () => {
  it('default text equality is CASE-INSENSITIVE at runtime', async () => {
    const result = await docEngine().run(eqDoc('title', 'hello'));
    expect(result.rows).toEqual([{ id: 1 }]); // 'Hello' matches 'hello'
  });

  it('a sensitive field equality is CASE-SENSITIVE at runtime', async () => {
    const engine = docEngine();
    expect((await engine.run(eqDoc('code', 'abc'))).rows).toEqual([{ id: 2 }]);
    expect((await engine.run(eqDoc('code', 'ABC'))).rows).toEqual([{ id: 1 }]);
  });

  it('SQL golden: insensitive text wraps LOWER, sensitive text is plain', () => {
    const engine = docEngine();
    const insensitive = engine.toSQL(eqDoc('title', 'x'), 'base').sql;
    expect(insensitive).toContain('LOWER("doc"."title") = LOWER(?)');
    const sensitive = engine.toSQL(eqDoc('code', 'x'), 'base').sql;
    expect(sensitive).toContain('"doc"."code" = ?');
    expect(sensitive).not.toContain('LOWER("doc"."code")');
  });
});

// ════════════════════════════════════════════════════════════════════════
// CHANGE 4 — Type-level semantic / search
// ════════════════════════════════════════════════════════════════════════

describe('change 4 — type-level semantic / search', () => {
  it('a Type-level `semantic` flag makes SemanticExpr eligible (no field flagged)', () => {
    const registry = createRegistry();
    const metric = registry.parseType({
      name: 'metric',
      fields: [
        { name: 'id', type: { kind: 'number', whole: true } },
        { name: 'value', type: { kind: 'number' } },
      ],
      semantic: true,
      count: 10,
      bytes: 8,
    });
    expect(metric.isSemantic()).toBe(true);
    const engine = new QueryEngine(registry);
    const scope = engine.globalScope();
    scope.bind('m', { kind: 'type', type: metric, source: 'm', synthetic: false });
    const p = engine.validateExpr({ kind: 'semantic', source: 'm', query: 'hi' }, scope);
    expect(p.list.some((x) => x.code === 'semantic.not-eligible')).toBe(false);
  });

  it('a plain Type (no flag, no eligible field) is NOT semantic-eligible', () => {
    const registry = createRegistry();
    const plain = registry.parseType({
      name: 'plain',
      fields: [{ name: 'value', type: { kind: 'number' } }],
      count: 10,
      bytes: 8,
    });
    expect(plain.isSemantic()).toBe(false);
    const engine = new QueryEngine(registry);
    const scope = engine.globalScope();
    scope.bind('m', { kind: 'type', type: plain, source: 'm', synthetic: false });
    const p = engine.validateExpr({ kind: 'semantic', source: 'm', query: 'hi' }, scope);
    expect(p.list.some((x) => x.code === 'semantic.not-eligible')).toBe(true);
  });

  it('a Type-level `search` flag makes a whole-Type TextSearchExpr eligible', () => {
    const registry = createRegistry();
    registry.registerType(
      registry.parseType({
        name: 'searchable',
        // No `search` field — only the type-level flag qualifies it.
        fields: [{ name: 'id', type: { kind: 'number', whole: true } }, { name: 'note', type: { kind: 'text' } }],
        search: true,
        count: 10,
        bytes: 20,
      }),
    );
    registry.registerType(
      registry.parseType({
        name: 'host',
        fields: [
          { name: 'id', type: { kind: 'number', whole: true } },
          { name: 'thing', type: { kind: 'relation', to: 'searchable', count: 1 } },
        ],
        count: 10,
        bytes: 20,
      }),
    );
    const engine = new QueryEngine(registry);
    expect(engine.type('searchable')!.isSearchable()).toBe(true);
    const scope = engine.globalScope();
    scope.bind('s', { kind: 'type', type: engine.type('searchable')!, source: 's', synthetic: false });
    // Whole-source search over a search-flagged Type (no field).
    const p = engine.validateExpr({ kind: 'text-search', source: 's', query: 'hi' }, scope);
    expect(p.list.some((x) => x.code === 'text-search.not-searchable')).toBe(false);
  });

  it('an un-flagged whole Type is NOT searchable', () => {
    const registry = createRegistry();
    registry.registerType(
      registry.parseType({
        name: 'bare',
        fields: [{ name: 'id', type: { kind: 'number', whole: true } }, { name: 'note', type: { kind: 'text' } }],
        count: 10,
        bytes: 20,
      }),
    );
    registry.registerType(
      registry.parseType({
        name: 'host2',
        fields: [
          { name: 'id', type: { kind: 'number', whole: true } },
          { name: 'thing', type: { kind: 'relation', to: 'bare', count: 1 } },
        ],
        count: 10,
        bytes: 20,
      }),
    );
    const engine = new QueryEngine(registry);
    expect(engine.type('bare')!.isSearchable()).toBe(false);
    const scope = engine.globalScope();
    scope.bind('b', { kind: 'type', type: engine.type('bare')!, source: 'b', synthetic: false });
    const p = engine.validateExpr({ kind: 'text-search', source: 'b', query: 'hi' }, scope);
    expect(p.list.some((x) => x.code === 'text-search.not-searchable')).toBe(true);
  });

  it('round-trips the Type-level semantic / search flags', () => {
    const registry = createRegistry();
    const def: TypeDef = {
      name: 'flagged',
      fields: [{ name: 'id', type: { kind: 'number', whole: true } }],
      semantic: true,
      search: true,
      count: 10,
      bytes: 8,
    };
    const t = registry.parseType(def);
    const json = t.toJSON();
    expect(json.semantic).toBe(true);
    expect(json.search).toBe(true);
  });
});
