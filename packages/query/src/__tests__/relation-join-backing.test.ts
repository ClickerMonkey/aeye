/**
 * RELATION-JOIN BACKING: a relation field's join `ON` driven by explicit,
 * LLM-HIDDEN physical FK columns (`FieldBacking.relation.keys`) and/or a custom
 * predicate (`FieldBacking.relation.on`), instead of the name convention.
 *
 * Mirrors the user's ERP: `comment_rating.user` (belongs-to `user`) carries a
 * hidden physical FK `user_id`, and `user.ratings` is its materialized inverse
 * has-many. The backing lives on the OWNING belongs-to relation; the inverse
 * REUSES the same FK (orientation swapped). Covered: both dialects, both join
 * directions, composite FKs, a `foreign` default, custom `on` (expr/sql/run),
 * aliased/self-joins, `JoinDef.and`, relation-join value (SQL + runtime),
 * named-join relation specs, fan-out aggregate joins, and byte-identical
 * convention.
 */
import { describe, it, expect } from 'vitest';
import { createRegistry } from '../registry';
import type { Registry } from '../registry';
import { QueryEngine } from '../engine';
import { arrayExecutor } from '../runtime/executor';
import { joinAlias } from '../backing';
import type { TypeBacking, RelationBacking } from '../backing';
import { SqlText } from '../sql/emit';
import type { TypeDef, SelectDef, UpdateDef, DeleteDef, ExprDef } from '../schema';
import type { SourceRecord } from '../runtime/row';

const ref = (source: string, field: string): ExprDef => ({ kind: 'field-ref', source, field });

/** Build an engine over the given types/backings/data (inverse relations materialized). */
function build(
  types: TypeDef[],
  backings: Record<string, TypeBacking>,
  data: Record<string, SourceRecord[]> = {},
): QueryEngine {
  const registry = createRegistry();
  for (const t of types) registry.registerType(registry.parseType(t));
  registry.finalize();
  const executors: Record<string, ReturnType<typeof arrayExecutor>> = {};
  for (const k of Object.keys(data)) executors[k] = arrayExecutor(data[k]!);
  return new QueryEngine(registry, { backings, executors });
}

// ─── ERP fixture: comment_rating.user (belongs-to) + user.ratings (inverse) ──

const userDef: TypeDef = {
  name: 'user',
  fields: [
    { name: 'id', type: { kind: 'number', whole: true } },
    { name: 'name', type: { kind: 'text' } },
  ],
  indexes: [{ exprs: [{ expr: { kind: 'field-ref', source: 'user', field: 'id' }, count: 1 }] }],
  count: 100,
  bytes: 32,
};

const commentRatingDef: TypeDef = {
  name: 'comment_rating',
  fields: [
    { name: 'id', type: { kind: 'number', whole: true } },
    // belongs-to user; hidden physical FK is `user_id` (NOT the field name).
    { name: 'user', type: { kind: 'relation', to: 'user', count: 1, inverseRelation: 'ratings' } },
    { name: 'stars', type: { kind: 'number', whole: true } },
  ],
  indexes: [{ exprs: [{ expr: { kind: 'field-ref', source: 'comment_rating', field: 'id' }, count: 1 }] }],
  count: 500,
  bytes: 24,
};

/** Backing: `comment_rating.user`'s ON is the physical `user_id` → `id`. */
const erpBacking: Record<string, TypeBacking> = {
  comment_rating: { fields: { user: { relation: { keys: [{ local: 'user_id', foreign: 'id' }] } } } },
};

const users: SourceRecord[] = [
  { id: 1, name: 'Ada' },
  { id: 2, name: 'Bob' },
];
const ratings: SourceRecord[] = [
  { id: 100, user_id: 1, stars: 5 },
  { id: 101, user_id: 1, stars: 3 },
  { id: 102, user_id: 2, stars: 4 },
];

describe('relation-join backing: FK keys', () => {
  it("inverse has-many: a user's ratings joins ON user.id = comment_rating.user_id (both dialects)", () => {
    const engine = build([userDef, commentRatingDef], erpBacking);
    const def: SelectDef = {
      kind: 'select',
      from: { kind: 'type', type: 'user' },
      joins: [{ on: { kind: 'relation', source: 'user', field: 'ratings', as: 'comment_rating' }, joinType: 'left' }],
      fields: [{ expr: ref('user', 'name'), as: 'name' }, { expr: ref('comment_rating', 'stars'), as: 'stars' }],
    };
    expect(engine.toSQL(def, 'base').sql).toContain('ON "user"."id" = "comment_rating"."user_id"');
    expect(engine.toSQL(def, 'postgres').sql).toContain('ON "user"."id" = "comment_rating"."user_id"');
  });

  it('belongs-to: comment_rating.user joins ON comment_rating.user_id = user.id', () => {
    const engine = build([userDef, commentRatingDef], erpBacking);
    const def: SelectDef = {
      kind: 'select',
      from: { kind: 'type', type: 'comment_rating' },
      joins: [{ on: { kind: 'relation', source: 'comment_rating', field: 'user', as: 'user' }, joinType: 'inner' }],
      fields: [{ expr: ref('user', 'name'), as: 'name' }],
    };
    expect(engine.toSQL(def, 'base').sql).toContain('ON "comment_rating"."user_id" = "user"."id"');
  });

  it('runtime: the inverse has-many matches on user_id', async () => {
    const engine = build([userDef, commentRatingDef], erpBacking, { user: users, comment_rating: ratings });
    const def: SelectDef = {
      kind: 'select',
      from: { kind: 'type', type: 'user' },
      joins: [{ on: { kind: 'relation', source: 'user', field: 'ratings', as: 'comment_rating' }, joinType: 'left' }],
      fields: [{ expr: ref('user', 'name'), as: 'name' }, { expr: ref('comment_rating', 'stars'), as: 'stars' }],
      order: [
        { expr: ref('user', 'id'), dir: 'asc' },
        { expr: ref('comment_rating', 'stars'), dir: 'asc' },
      ],
    };
    const { rows } = await engine.run(def);
    expect(rows).toEqual([
      { name: 'Ada', stars: 3 },
      { name: 'Ada', stars: 5 },
      { name: 'Bob', stars: 4 },
    ]);
  });

  it('LEFT-JOIN anti-join (WHERE joined IS NULL) returns only unmatched rows with the correct FK', async () => {
    // Cleo (id 3) has NO ratings. The has-many ON is the physical `user_id`, so
    // the LEFT join correctly leaves Cleo unmatched; `comment_rating.id IS NULL`
    // then selects ONLY Cleo. (A wrong convention FK would match nothing and
    // return ALL users — the integration-eval anti-join regression.)
    const usersPlusCleo: SourceRecord[] = [...users, { id: 3, name: 'Cleo' }];
    const engine = build([userDef, commentRatingDef], erpBacking, { user: usersPlusCleo, comment_rating: ratings });
    const def: SelectDef = {
      kind: 'select',
      from: { kind: 'type', type: 'user' },
      joins: [{ on: { kind: 'relation', source: 'user', field: 'ratings', as: 'comment_rating' }, joinType: 'left' }],
      fields: [{ expr: ref('user', 'name'), as: 'name' }],
      where: [{ kind: 'is-null', value: ref('comment_rating', 'id') }],
    };
    const { rows } = await engine.run(def);
    expect(rows).toEqual([{ name: 'Cleo' }]);
  });

  it('runtime belongs-to: matches on user_id (from comment_rating)', async () => {
    const engine = build([userDef, commentRatingDef], erpBacking, { user: users, comment_rating: ratings });
    const def: SelectDef = {
      kind: 'select',
      from: { kind: 'type', type: 'comment_rating' },
      joins: [{ on: { kind: 'relation', source: 'comment_rating', field: 'user', as: 'user' }, joinType: 'inner' }],
      fields: [{ expr: ref('user', 'name'), as: 'name' }, { expr: ref('comment_rating', 'id'), as: 'rid' }],
      order: [{ expr: ref('comment_rating', 'id'), dir: 'asc' }],
    };
    const { rows } = await engine.run(def);
    expect(rows).toEqual([
      { name: 'Ada', rid: 100 },
      { name: 'Ada', rid: 101 },
      { name: 'Bob', rid: 102 },
    ]);
  });

  it('a `foreign` omitted from a key pair defaults to the target identity', () => {
    const backing: Record<string, TypeBacking> = {
      comment_rating: { fields: { user: { relation: { keys: [{ local: 'user_id' }] } } } },
    };
    const engine = build([userDef, commentRatingDef], backing);
    const def: SelectDef = {
      kind: 'select',
      from: { kind: 'type', type: 'comment_rating' },
      joins: [{ on: { kind: 'relation', source: 'comment_rating', field: 'user', as: 'user' }, joinType: 'inner' }],
      fields: [{ expr: ref('user', 'name'), as: 'name' }],
    };
    expect(engine.toSQL(def, 'base').sql).toContain('ON "comment_rating"."user_id" = "user"."id"');
  });

  it('no backing ⇒ the convention ON is byte-identical', () => {
    const backed = build([userDef, commentRatingDef], erpBacking);
    const plain = build([userDef, commentRatingDef], {});
    const def: SelectDef = {
      kind: 'select',
      from: { kind: 'type', type: 'comment_rating' },
      joins: [{ on: { kind: 'relation', source: 'comment_rating', field: 'user', as: 'user' }, joinType: 'inner' }],
      fields: [{ expr: ref('comment_rating', 'id'), as: 'rid' }],
    };
    // Convention uses the field NAME `user` as the local column.
    expect(plain.toSQL(def, 'base').sql).toContain('ON "comment_rating"."user" = "user"."id"');
    // Backed swaps in the physical column — proving the backing is what changed.
    expect(backed.toSQL(def, 'base').sql).toContain('ON "comment_rating"."user_id" = "user"."id"');
  });

  it('JoinDef.and is still ANDed onto the backed ON', () => {
    const engine = build([userDef, commentRatingDef], erpBacking);
    const def: SelectDef = {
      kind: 'select',
      from: { kind: 'type', type: 'user' },
      joins: [
        {
          on: { kind: 'relation', source: 'user', field: 'ratings', as: 'comment_rating' },
          joinType: 'left',
          and: { kind: 'comparison', op: '>=', left: ref('comment_rating', 'stars'), right: { kind: 'literal', value: 4 } },
        },
      ],
      fields: [{ expr: ref('user', 'name'), as: 'name' }],
    };
    const sql = engine.toSQL(def, 'base').sql;
    expect(sql).toContain('ON "user"."id" = "comment_rating"."user_id"');
    expect(sql).toContain('AND "comment_rating"."stars" >= ');
  });
});

// ─── Composite FK ────────────────────────────────────────────────────────────

const sectionDef: TypeDef = {
  name: 'section',
  fields: [
    { name: 'id', type: { kind: 'number', whole: true } },
    { name: 'a', type: { kind: 'number', whole: true } },
    { name: 'b', type: { kind: 'number', whole: true } },
    { name: 'title', type: { kind: 'text' } },
  ],
  indexes: [{ exprs: [{ expr: { kind: 'field-ref', source: 'section', field: 'id' }, count: 1 }] }],
  count: 50,
  bytes: 32,
};

const enrollmentDef: TypeDef = {
  name: 'enrollment',
  fields: [
    { name: 'id', type: { kind: 'number', whole: true } },
    { name: 'section', type: { kind: 'relation', to: 'section', count: 1 } },
    { name: 'grade', type: { kind: 'text' } },
  ],
  indexes: [{ exprs: [{ expr: { kind: 'field-ref', source: 'enrollment', field: 'id' }, count: 1 }] }],
  count: 200,
  bytes: 24,
};

const compositeBacking: Record<string, TypeBacking> = {
  enrollment: {
    fields: { section: { relation: { keys: [{ local: 'sec_a', foreign: 'a' }, { local: 'sec_b', foreign: 'b' }] } } },
  },
};

describe('relation-join backing: composite FK', () => {
  it('a composite key ANDs both pairs in the ON', () => {
    const engine = build([sectionDef, enrollmentDef], compositeBacking);
    const def: SelectDef = {
      kind: 'select',
      from: { kind: 'type', type: 'enrollment' },
      joins: [{ on: { kind: 'relation', source: 'enrollment', field: 'section', as: 'section' }, joinType: 'inner' }],
      fields: [{ expr: ref('section', 'title'), as: 'title' }],
    };
    expect(engine.toSQL(def, 'base').sql).toContain(
      'ON "enrollment"."sec_a" = "section"."a" AND "enrollment"."sec_b" = "section"."b"',
    );
  });

  it('runtime matches only when ALL composite pairs agree', async () => {
    const sections: SourceRecord[] = [
      { id: 1, a: 1, b: 1, title: 'Match' },
      { id: 2, a: 1, b: 2, title: 'PartialA' },
    ];
    const enrollments: SourceRecord[] = [{ id: 9, sec_a: 1, sec_b: 1, grade: 'A' }];
    const engine = build([sectionDef, enrollmentDef], compositeBacking, { section: sections, enrollment: enrollments });
    const def: SelectDef = {
      kind: 'select',
      from: { kind: 'type', type: 'enrollment' },
      joins: [{ on: { kind: 'relation', source: 'enrollment', field: 'section', as: 'section' }, joinType: 'inner' }],
      fields: [{ expr: ref('section', 'title'), as: 'title' }],
    };
    const { rows } = await engine.run(def);
    expect(rows).toEqual([{ title: 'Match' }]);
  });
});

// ─── Custom ON (expr / sql / run) ───────────────────────────────────────────

/** Build the ERP engine but with the given custom relation backing on `comment_rating.user`. */
function customEngine(makeRelation: (r: Registry) => RelationBacking): QueryEngine {
  const registry = createRegistry();
  registry.registerType(registry.parseType(userDef));
  registry.registerType(registry.parseType(commentRatingDef));
  registry.finalize();
  const backings: Record<string, TypeBacking> = {
    comment_rating: { fields: { user: { relation: makeRelation(registry) } } },
  };
  return new QueryEngine(registry, {
    backings,
    executors: { user: arrayExecutor(users), comment_rating: arrayExecutor(ratings) },
  });
}

/** `on.expr`: the dual physical predicate `<local>.user_id = <joined>.id`. */
const onExpr = (r: Registry): RelationBacking => ({
  on: { expr: (l, j) => r.parseExpr({ kind: 'comparison', op: '=', left: ref(l, 'user_id'), right: ref(j, 'id') }) },
});

describe('relation-join backing: custom ON', () => {
  it('on.expr overrides the ON in SQL (both dialects)', () => {
    const engine = customEngine(onExpr);
    const belongs: SelectDef = {
      kind: 'select',
      from: { kind: 'type', type: 'comment_rating' },
      joins: [{ on: { kind: 'relation', source: 'comment_rating', field: 'user', as: 'user' }, joinType: 'inner' }],
      fields: [{ expr: ref('user', 'name'), as: 'name' }],
    };
    expect(engine.toSQL(belongs, 'base').sql).toContain('ON "comment_rating"."user_id" = "user"."id"');
    expect(engine.toSQL(belongs, 'postgres').sql).toContain('ON "comment_rating"."user_id" = "user"."id"');
    // Inverse direction: the SAME predicate, aliases mapped to the bound sides.
    const inverse: SelectDef = {
      kind: 'select',
      from: { kind: 'type', type: 'user' },
      joins: [{ on: { kind: 'relation', source: 'user', field: 'ratings', as: 'comment_rating' }, joinType: 'left' }],
      fields: [{ expr: ref('user', 'name'), as: 'name' }],
    };
    expect(engine.toSQL(inverse, 'base').sql).toContain('ON "comment_rating"."user_id" = "user"."id"');
  });

  it('on.expr overrides the match at runtime', async () => {
    const engine = customEngine(onExpr);
    const def: SelectDef = {
      kind: 'select',
      from: { kind: 'type', type: 'comment_rating' },
      joins: [{ on: { kind: 'relation', source: 'comment_rating', field: 'user', as: 'user' }, joinType: 'inner' }],
      fields: [{ expr: ref('user', 'name'), as: 'name' }, { expr: ref('comment_rating', 'id'), as: 'rid' }],
      order: [{ expr: ref('comment_rating', 'id'), dir: 'asc' }],
    };
    const { rows } = await engine.run(def);
    expect(rows).toEqual([
      { name: 'Ada', rid: 100 },
      { name: 'Ada', rid: 101 },
      { name: 'Bob', rid: 102 },
    ]);
  });

  it('on.sql overrides the SQL; the runtime falls back to `keys`', async () => {
    // `on.sql` adds a distinctive marker; `keys` drives the runtime match.
    const engine = customEngine(() => ({
      keys: [{ local: 'user_id', foreign: 'id' }],
      on: {
        sql: (l, j, ctx) =>
          SqlText.join(
            [ctx.dialect.field(l, 'user_id'), SqlText.raw('='), ctx.dialect.field(j, 'id'), SqlText.raw('AND'), ctx.dialect.field(j, 'id'), SqlText.raw('> 0')],
            ' ',
          ),
      },
    }));
    const def: SelectDef = {
      kind: 'select',
      from: { kind: 'type', type: 'comment_rating' },
      joins: [{ on: { kind: 'relation', source: 'comment_rating', field: 'user', as: 'user' }, joinType: 'inner' }],
      fields: [{ expr: ref('user', 'name'), as: 'name' }, { expr: ref('comment_rating', 'id'), as: 'rid' }],
      order: [{ expr: ref('comment_rating', 'id'), dir: 'asc' }],
    };
    // SQL used the custom `on.sql` (the `> 0` marker).
    expect(engine.toSQL(def, 'base').sql).toContain('"user"."id" > 0');
    // Runtime fell back to `keys` (matched on user_id).
    const { rows } = await engine.run(def);
    expect(rows).toEqual([
      { name: 'Ada', rid: 100 },
      { name: 'Ada', rid: 101 },
      { name: 'Bob', rid: 102 },
    ]);
  });

  it('on.run overrides the runtime; the SQL falls back to `keys`', async () => {
    // `on.run` additionally requires the user be Ada; `keys` drives the SQL.
    const engine = customEngine(() => ({
      keys: [{ local: 'user_id', foreign: 'id' }],
      on: { run: () => (lr, jr) => lr['user_id'] === jr['id'] && jr['name'] === 'Ada' },
    }));
    const sqlDef: SelectDef = {
      kind: 'select',
      from: { kind: 'type', type: 'comment_rating' },
      joins: [{ on: { kind: 'relation', source: 'comment_rating', field: 'user', as: 'user' }, joinType: 'inner' }],
      fields: [{ expr: ref('comment_rating', 'id'), as: 'rid' }],
    };
    // SQL used `keys` (a run-only custom ON has no SQL form).
    expect(engine.toSQL(sqlDef, 'base').sql).toContain('ON "comment_rating"."user_id" = "user"."id"');
    // Runtime used `on.run`: only Ada's ratings match; Bob's are dropped by the LEFT null.
    const runDef: SelectDef = {
      kind: 'select',
      from: { kind: 'type', type: 'user' },
      joins: [{ on: { kind: 'relation', source: 'user', field: 'ratings', as: 'comment_rating' }, joinType: 'left' }],
      fields: [{ expr: ref('user', 'name'), as: 'name' }, { expr: ref('comment_rating', 'stars'), as: 'stars' }],
      order: [
        { expr: ref('user', 'id'), dir: 'asc' },
        { expr: ref('comment_rating', 'stars'), dir: 'asc' },
      ],
    };
    const { rows } = await engine.run(runDef);
    expect(rows).toEqual([
      { name: 'Ada', stars: 3 },
      { name: 'Ada', stars: 5 },
      { name: 'Bob', stars: null },
    ]);
  });
});

// ─── Aliased / self-join ─────────────────────────────────────────────────────

const employeeDef: TypeDef = {
  name: 'employee',
  fields: [
    { name: 'id', type: { kind: 'number', whole: true } },
    { name: 'name', type: { kind: 'text' } },
    { name: 'manager', type: { kind: 'relation', to: 'employee', count: 1 } },
  ],
  indexes: [{ exprs: [{ expr: { kind: 'field-ref', source: 'employee', field: 'id' }, count: 1 }] }],
  count: 100,
  bytes: 32,
};

describe('relation-join backing: aliased / self-join', () => {
  it('a self-join references the AUTHORED alias, not the type name', async () => {
    const backing: Record<string, TypeBacking> = {
      employee: { fields: { manager: { relation: { keys: [{ local: 'manager_id', foreign: 'id' }] } } } },
    };
    const employees: SourceRecord[] = [
      { id: 1, name: 'Root', manager_id: null },
      { id: 2, name: 'Mid', manager_id: 1 },
    ];
    const engine = build([employeeDef], backing, { employee: employees });
    const def: SelectDef = {
      kind: 'select',
      from: { kind: 'type', type: 'employee' },
      joins: [{ on: { kind: 'relation', source: 'employee', field: 'manager', as: 'boss' }, joinType: 'inner' }],
      fields: [{ expr: ref('employee', 'name'), as: 'name' }, { expr: ref('boss', 'name'), as: 'bossName' }],
    };
    expect(engine.toSQL(def, 'base').sql).toContain('ON "employee"."manager_id" = "boss"."id"');
    const { rows } = await engine.run(def);
    expect(rows).toEqual([{ name: 'Mid', bossName: 'Root' }]);
  });
});

// ─── Direct has-many (no inverseVia) ⇒ convention ────────────────────────────

const postDef: TypeDef = {
  name: 'post',
  fields: [
    { name: 'id', type: { kind: 'number', whole: true } },
    { name: 'blog', type: { kind: 'number', whole: true } },
  ],
  indexes: [{ exprs: [{ expr: { kind: 'field-ref', source: 'post', field: 'id' }, count: 1 }] }],
  count: 100,
  bytes: 16,
};

const blogDef: TypeDef = {
  name: 'blog',
  fields: [
    { name: 'id', type: { kind: 'number', whole: true } },
    { name: 'posts', type: { kind: 'relation', to: 'post', count: 5 } },
  ],
  indexes: [{ exprs: [{ expr: { kind: 'field-ref', source: 'blog', field: 'id' }, count: 1 }] }],
  count: 10,
  bytes: 16,
};

describe('relation-join backing: direct has-many falls back to convention', () => {
  it('a has-many with no inverseVia + no backing uses the camelHead FK', () => {
    const engine = build([blogDef, postDef], {});
    const def: SelectDef = {
      kind: 'select',
      from: { kind: 'type', type: 'blog' },
      joins: [{ on: { kind: 'relation', source: 'blog', field: 'posts', as: 'post' }, joinType: 'left' }],
      fields: [{ expr: ref('post', 'id'), as: 'pid' }],
    };
    expect(engine.toSQL(def, 'base').sql).toContain('ON "blog"."id" = "post"."blog"');
  });
});

// ─── Relation-join value (SQL emit) + runtime ────────────────────────────────

describe('relation-join backing: relation-join value', () => {
  it('a relation-join value honors the backing FK in SQL', () => {
    const engine = build([userDef, commentRatingDef], erpBacking);
    const def: SelectDef = {
      kind: 'select',
      from: { kind: 'type', type: 'comment_rating' },
      joins: [{ on: { kind: 'relation', source: 'comment_rating', field: 'user', as: 'comment_rating_user' } }],
      fields: [{ expr: { kind: 'field-ref', source: 'comment_rating_user', field: 'name' }, as: 'un' }],
    };
    expect(engine.toSQL(def, 'base').sql).toContain('ON "comment_rating"."user_id" = "comment_rating_user"."id"');
  });

  it('a relation-join value honors a custom on in SQL', () => {
    const engine = customEngine(onExpr);
    const def: SelectDef = {
      kind: 'select',
      from: { kind: 'type', type: 'comment_rating' },
      joins: [{ on: { kind: 'relation', source: 'comment_rating', field: 'user', as: 'comment_rating_user' } }],
      fields: [{ expr: { kind: 'field-ref', source: 'comment_rating_user', field: 'name' }, as: 'un' }],
    };
    // The custom `on.expr` drives the join ON (its columns appear in the ON).
    const sql = engine.toSQL(def, 'base').sql;
    expect(sql).toContain('"comment_rating"."user_id"');
    expect(sql).toContain('"comment_rating_user"."id"');
  });

  it('a relation-join value reads through the backing FK at runtime (keys)', async () => {
    const engine = build([userDef, commentRatingDef], erpBacking, { user: users, comment_rating: ratings });
    const def: SelectDef = {
      kind: 'select',
      from: { kind: 'type', type: 'comment_rating' },
      joins: [{ on: { kind: 'relation', source: 'comment_rating', field: 'user', as: 'comment_rating_user' } }],
      fields: [{ expr: { kind: 'field-ref', source: 'comment_rating_user', field: 'name' }, as: 'un' }],
      order: [{ expr: ref('comment_rating', 'id'), dir: 'asc' }],
    };
    const { rows } = await engine.run(def);
    expect(rows).toEqual([{ un: 'Ada' }, { un: 'Ada' }, { un: 'Bob' }]);
  });

  it('a relation-join value reads through a custom on at runtime', async () => {
    const engine = customEngine(onExpr);
    const def: SelectDef = {
      kind: 'select',
      from: { kind: 'type', type: 'comment_rating' },
      joins: [{ on: { kind: 'relation', source: 'comment_rating', field: 'user', as: 'comment_rating_user' } }],
      fields: [{ expr: { kind: 'field-ref', source: 'comment_rating_user', field: 'name' }, as: 'un' }],
      order: [{ expr: ref('comment_rating', 'id'), dir: 'asc' }],
    };
    const { rows } = await engine.run(def);
    expect(rows).toEqual([{ un: 'Ada' }, { un: 'Ada' }, { un: 'Bob' }]);
  });
});

// ─── Named-join relation spec (TypeBacking.joins) ────────────────────────────

const commentRatingNamedDef: TypeDef = {
  name: 'comment_rating',
  fields: [
    { name: 'id', type: { kind: 'number', whole: true } },
    { name: 'user', type: { kind: 'relation', to: 'user', count: 1, inverseRelation: 'ratings' } },
    { name: 'stars', type: { kind: 'number', whole: true } },
    { name: 'ownerName', type: { kind: 'text' }, nullable: true },
  ],
  indexes: [{ exprs: [{ expr: { kind: 'field-ref', source: 'comment_rating', field: 'id' }, count: 1 }] }],
  count: 500,
  bytes: 24,
};

/** A named relation join `owner` following `comment_rating.user`, whose ON obeys the backing. */
function namedJoinEngine(relation: (r: Registry) => RelationBacking, data: SourceRecord[] = ratings): QueryEngine {
  const registry = createRegistry();
  registry.registerType(registry.parseType(userDef));
  registry.registerType(registry.parseType(commentRatingNamedDef));
  registry.finalize();
  const backings: Record<string, TypeBacking> = {
    comment_rating: {
      joins: { owner: { expr: (alias) => ({ kind: 'relation', source: alias, relation: 'user' }) } },
      fields: {
        user: { relation: relation(registry) },
        ownerName: { joins: ['owner'], compute: { expr: () => registry.parseExpr(ref(joinAlias('comment_rating', 'owner'), 'name')) } },
      },
    },
  };
  return new QueryEngine(registry, {
    backings,
    executors: { user: arrayExecutor(users), comment_rating: arrayExecutor(data) },
  });
}

describe('relation-join backing: named-join relation spec', () => {
  it('the named relation join uses the backing FK in SQL and at runtime (keys)', async () => {
    // Include a NULL-FK row: a null local key never joins (⇒ null owner).
    const data: SourceRecord[] = [...ratings, { id: 103, user_id: null, stars: 1 }];
    const engine = namedJoinEngine(() => ({ keys: [{ local: 'user_id', foreign: 'id' }] }), data);
    const def: SelectDef = {
      kind: 'select',
      from: { kind: 'type', type: 'comment_rating' },
      fields: [{ expr: ref('comment_rating', 'ownerName'), as: 'ownerName' }],
      order: [{ expr: ref('comment_rating', 'id'), dir: 'asc' }],
    };
    expect(engine.toSQL(def, 'base').sql).toContain('ON "comment_rating"."user_id" = "comment_rating__owner"."id"');
    const { rows } = await engine.run(def);
    expect(rows).toEqual([{ ownerName: 'Ada' }, { ownerName: 'Ada' }, { ownerName: 'Bob' }, { ownerName: null }]);
  });

  it('the named relation join honors a custom on in SQL and at runtime', async () => {
    const engine = namedJoinEngine(onExpr);
    const def: SelectDef = {
      kind: 'select',
      from: { kind: 'type', type: 'comment_rating' },
      fields: [{ expr: ref('comment_rating', 'ownerName'), as: 'ownerName' }],
      order: [{ expr: ref('comment_rating', 'id'), dir: 'asc' }],
    };
    // The custom `on.expr` drives the named join's ON.
    const sql = engine.toSQL(def, 'base').sql;
    expect(sql).toContain('"comment_rating"."user_id"');
    expect(sql).toContain('"comment_rating__owner"."id"');
    const { rows } = await engine.run(def);
    expect(rows).toEqual([{ ownerName: 'Ada' }, { ownerName: 'Ada' }, { ownerName: 'Bob' }]);
  });
});

// ─── Fan-out aggregate grouping ──────────────────────────────────────────────

describe('relation-join backing: fan-out aggregate', () => {
  it('a fan-out aggregate joins the target on the backing FK column', () => {
    const engine = build([userDef, commentRatingDef], erpBacking);
    const def: SelectDef = {
      kind: 'select',
      from: { kind: 'type', type: 'user' },
      joins: [{ on: { kind: 'relation', source: 'user', field: 'ratings', as: 'ratings' } }],
      fields: [
        { expr: ref('user', 'name'), as: 'name' },
        { expr: { kind: 'aggregate', function: 'count', args: { value: { kind: 'field-ref', source: 'ratings', field: 'stars' } } }, as: 'n' },
      ],
    };
    const sql = engine.toSQL(def, 'base').sql;
    // The relation join keys on the physical FK `user_id`, not the convention
    // column `user`; the aggregate runs over the joined rows.
    expect(sql).toContain('ON "user"."id" = "ratings"."user_id"');
    expect(sql).not.toContain('"ratings"."user"');
    expect(sql).toContain('count("ratings"."stars") AS "n"');
  });
});

// ─── Joined DML (UPDATE…FROM / DELETE…USING) with a custom ON ────────────────

describe('relation-join backing: joined DML', () => {
  it('UPDATE…FROM lowers a custom-on relation join into the WHERE key', () => {
    const engine = customEngine(onExpr);
    const def: UpdateDef = {
      kind: 'update',
      type: 'comment_rating',
      set: [{ field: 'stars', value: { kind: 'literal', value: 1 } }],
      joins: [{ on: { kind: 'relation', source: 'comment_rating', field: 'user', as: 'user' } }],
      where: [{ kind: 'comparison', op: '=', left: ref('user', 'name'), right: { kind: 'literal', value: 'Ada' } }],
    };
    const sql = engine.toSQL(def, 'base').sql;
    expect(sql).toContain('"comment_rating"."user_id"');
    expect(sql).toContain('"user"."id"');
  });

  it('DELETE…USING lowers a custom-on relation join into the WHERE key', () => {
    const engine = customEngine(onExpr);
    const def: DeleteDef = {
      kind: 'delete',
      from: 'comment_rating',
      joins: [{ on: { kind: 'relation', source: 'comment_rating', field: 'user', as: 'user' } }],
      where: [{ kind: 'comparison', op: '=', left: ref('user', 'name'), right: { kind: 'literal', value: 'Ada' } }],
    };
    const sql = engine.toSQL(def, 'base').sql;
    expect(sql).toContain('"comment_rating"."user_id"');
    expect(sql).toContain('"user"."id"');
  });
});
