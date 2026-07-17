/**
 * Relation-vs-relation comparison (Part 2 of the correlation fix).
 *
 * A field-ref to a RELATION field resolves to the whole related row, so:
 *  - comparing it to a SCALAR / to a DIFFERENT-target relation is a
 *    `compare.relation-vs-value` error;
 *  - comparing it to ANOTHER relation of the SAME target Type is ALLOWED and
 *    compares by the FK KEY at runtime and in SQL (`post.creator = comment.creator`
 *    is true iff the two rows share a creator).
 */
import { describe, it, expect } from 'vitest';
import { createRegistry } from '../registry';
import { QueryEngine } from '../engine';
import { arrayExecutor } from '../runtime/executor';
import { e } from '../builder';
import type { TypeDef, SelectDef } from '../schema';
import type { SourceRecord } from '../runtime/row';

const userDef: TypeDef = {
  name: 'user',
  fields: [
    { name: 'id', type: { kind: 'number', whole: true } },
    { name: 'name', type: { kind: 'text' } },
  ],
  count: 10,
  bytes: 32,
};

/** `post` and `comment` both belong-to `user` via a `creator` relation. */
const postDef: TypeDef = {
  name: 'post',
  fields: [
    { name: 'id', type: { kind: 'number', whole: true } },
    { name: 'creator', type: { kind: 'relation', to: 'user', count: 1 } },
    { name: 'title', type: { kind: 'text' } },
  ],
  count: 20,
  bytes: 48,
};

const commentDef: TypeDef = {
  name: 'comment',
  fields: [
    { name: 'id', type: { kind: 'number', whole: true } },
    { name: 'creator', type: { kind: 'relation', to: 'user', count: 1 } },
    { name: 'body', type: { kind: 'text' } },
  ],
  count: 40,
  bytes: 48,
};

const userRows: SourceRecord[] = [
  { id: 1, name: 'Ada' },
  { id: 2, name: 'Bob' },
];
const postRows: SourceRecord[] = [
  { id: 100, creator: 1, title: 'p-ada' },
  { id: 101, creator: 2, title: 'p-bob' },
];
const commentRows: SourceRecord[] = [
  { id: 200, creator: 1, body: 'c-ada' },
  { id: 201, creator: 2, body: 'c-bob' },
];

function engineFixture(): QueryEngine {
  const registry = createRegistry();
  for (const def of [userDef, postDef, commentDef]) registry.registerType(registry.parseType(def));
  registry.finalize();
  return new QueryEngine(registry, {
    executors: {
      user: arrayExecutor(userRows),
      post: arrayExecutor(postRows),
      comment: arrayExecutor(commentRows),
    },
  });
}

/** Cross `post` × `comment`, filtered by an ON predicate over the two. */
function postXComment(and: SelectDef['where']): SelectDef {
  return {
    kind: 'select',
    fields: [
      { expr: e.ref('post', 'id').toJSON(), as: 'postId' },
      { expr: e.ref('comment', 'id').toJSON(), as: 'commentId' },
    ],
    from: { kind: 'type', type: 'post' },
    joins: [{ on: { kind: 'type', type: 'comment' }, joinType: 'inner' }],
    where: and,
    order: [
      { expr: e.ref('post', 'id').toJSON(), dir: 'asc' },
      { expr: e.ref('comment', 'id').toJSON(), dir: 'asc' },
    ],
  };
}

describe('relation-vs-relation comparison', () => {
  it('validates `post.creator = comment.creator` (same target — allowed)', () => {
    const engine = engineFixture();
    const def = postXComment([e.eq(e.ref('post', 'creator'), e.ref('comment', 'creator')).toJSON()]);
    const problems = engine.validateQuery(def);
    expect(problems.hasErrors).toBe(false);
  });

  it('returns only the SAME-creator rows at runtime (compared by FK key)', async () => {
    const engine = engineFixture();
    const def = postXComment([e.eq(e.ref('post', 'creator'), e.ref('comment', 'creator')).toJSON()]);
    const result = await engine.run(def);
    // Only pairs whose post + comment share a creator: (100,200) Ada, (101,201) Bob.
    expect(result.rows).toEqual([
      { postId: 100, commentId: 200 },
      { postId: 101, commentId: 201 },
    ]);
  });

  it('emits a KEY comparison in SQL (the two FK columns)', () => {
    const engine = engineFixture();
    const def = postXComment([e.eq(e.ref('post', 'creator'), e.ref('comment', 'creator')).toJSON()]);
    const sql = engine.toSQL(def, 'base').sql;
    expect(sql).toContain('"post"."creator" = "comment"."creator"');
  });

  it('rejects a relation compared to a DIFFERENT-target relation', () => {
    // `article` has TWO belongs-to relations of DIFFERENT targets.
    const articleDef: TypeDef = {
      name: 'article',
      fields: [
        { name: 'id', type: { kind: 'number', whole: true } },
        { name: 'creator', type: { kind: 'relation', to: 'user', count: 1 } },
        { name: 'topComment', type: { kind: 'relation', to: 'comment', count: 1 } },
      ],
      count: 5,
      bytes: 32,
    };
    const registry = createRegistry();
    for (const def of [userDef, commentDef, articleDef]) registry.registerType(registry.parseType(def));
    registry.finalize();
    const eng = new QueryEngine(registry);
    const def: SelectDef = {
      kind: 'select',
      fields: [{ expr: e.ref('article', 'id').toJSON() }],
      from: { kind: 'type', type: 'article' },
      // `article.creator` (→ user) vs `article.topComment` (→ comment): different targets.
      where: [e.eq(e.ref('article', 'creator'), e.ref('article', 'topComment')).toJSON()],
    };
    const problems = eng.validateQuery(def);
    const rel = problems.list.find((p) => p.code === 'compare.relation-vs-value');
    expect(rel).toBeDefined();
    expect(rel!.message).toContain('same target');
  });
});

describe('a relation used as a value in the other scalar operators', () => {
  /** Does validating `def` produce a `compare.relation-vs-value` problem? */
  function flagged(def: SelectDef): boolean {
    const engine = engineFixture();
    return engine.validateQuery(def).list.some((p) => p.code === 'compare.relation-vs-value');
  }

  it('arithmetic (binary) over a relation is rejected', () => {
    const def: SelectDef = {
      kind: 'select',
      fields: [
        {
          expr: {
            kind: 'binary',
            op: '+',
            left: e.ref('post', 'creator').toJSON(),
            right: e.ref('post', 'id').toJSON(),
          },
          as: 'x',
        },
      ],
      from: { kind: 'type', type: 'post' },
    };
    expect(flagged(def)).toBe(true);
  });

  it('BETWEEN with a relation value is rejected', () => {
    const def: SelectDef = {
      kind: 'select',
      fields: [{ expr: e.ref('post', 'id').toJSON() }],
      from: { kind: 'type', type: 'post' },
      where: [
        {
          kind: 'between',
          value: e.ref('post', 'creator').toJSON(),
          lower: e.ref('post', 'id').toJSON(),
          upper: e.ref('post', 'id').toJSON(),
        },
      ],
    };
    expect(flagged(def)).toBe(true);
  });

  it('IN (list) with a relation value is rejected', () => {
    const def: SelectDef = {
      kind: 'select',
      fields: [{ expr: e.ref('post', 'id').toJSON() }],
      from: { kind: 'type', type: 'post' },
      where: [
        {
          kind: 'in',
          value: e.ref('post', 'creator').toJSON(),
          in: [e.ref('post', 'id').toJSON(), e.ref('post', 'title').toJSON()],
        },
      ],
    };
    expect(flagged(def)).toBe(true);
  });

  it('comparing a SCALAR to a relation (relation on the RIGHT) is rejected', () => {
    const def: SelectDef = {
      kind: 'select',
      fields: [{ expr: e.ref('post', 'id').toJSON() }],
      from: { kind: 'type', type: 'post' },
      where: [e.eq(e.ref('post', 'id'), e.ref('post', 'creator')).toJSON()],
    };
    expect(flagged(def)).toBe(true);
  });

  it('IN (subquery) with a relation value is rejected', () => {
    const def: SelectDef = {
      kind: 'select',
      fields: [{ expr: e.ref('post', 'id').toJSON() }],
      from: { kind: 'type', type: 'post' },
      where: [
        {
          kind: 'in',
          value: e.ref('post', 'creator').toJSON(),
          in: {
            kind: 'select',
            fields: [{ expr: e.ref('comment', 'id').toJSON() }],
            from: { kind: 'type', type: 'comment' },
          },
        },
      ],
    };
    expect(flagged(def)).toBe(true);
  });
});

describe('a relation pointing at an UNREGISTERED target', () => {
  /** A `holder` Type whose `ghost` relation targets the unregistered `phantom`. */
  function ghostEngine(): QueryEngine {
    const registry = createRegistry();
    registry.registerType(
      registry.parseType({
        name: 'holder',
        fields: [
          { name: 'id', type: { kind: 'number', whole: true } },
          { name: 'ghost', type: { kind: 'relation', to: 'phantom', count: 1 } },
        ],
        count: 1,
        bytes: 8,
      }),
    );
    registry.finalize();
    return new QueryEngine(registry);
  }

  const def: SelectDef = {
    kind: 'select',
    fields: [{ expr: e.ref('holder', 'ghost').toJSON(), as: 'g' }],
    from: { kind: 'type', type: 'holder' },
  };

  it('validateWalk reports ref.relation-target', () => {
    const problems = ghostEngine().validateQuery(def);
    expect(problems.list.some((p) => p.code === 'ref.relation-target')).toBe(true);
  });

  it('resolve stays total (a nullable text placeholder)', () => {
    const engine = ghostEngine();
    const fields = engine.parseQuery(def).outputFields(engine, engine.globalScope());
    // `!target` ⇒ a text placeholder, not a whole-Type field.
    expect(fields[0]!.fieldType).toBe('text');
  });

  it('a comparison over the dangling relation emits without lowering (relationCompare bails on !target)', () => {
    const cmpDef: SelectDef = {
      kind: 'select',
      fields: [{ expr: e.ref('holder', 'id').toJSON() }],
      from: { kind: 'type', type: 'holder' },
      where: [e.eq(e.ref('holder', 'ghost'), e.param('g')).toJSON()],
    };
    // The target `phantom` is unregistered ⇒ relationCompare returns undefined, so
    // the comparison falls back to a plain scalar emit (no per-key lowering).
    const { sql } = ghostEngine().toSQL(cmpDef, 'base', { params: { g: 1 } });
    expect(sql).toContain('"holder"."ghost"');
  });
});
