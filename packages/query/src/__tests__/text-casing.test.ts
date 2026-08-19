/**
 * TEXT CASING — the per-field / per-engine case-comparison policy.
 *
 * The one thing worth stating up front: `LOWER(col) = LOWER($1)` is not slow, it
 * is UNUSABLE. It is not sargable, so a plain B-tree on the column cannot be
 * probed; and on Postgres the column may not even be `text` — a uuid-valued
 * identifier is honestly modelled here as `text`, and `LOWER(uuid)` is
 * `function lower(uuid) does not exist`. So the assertion that matters most in
 * this file is the plain, boring one: **the emitted predicate is a bare
 * comparison over the raw column, not a function call on it.**
 *
 * Covered here, deliberately in one place so a road cannot be added without
 * being cased:
 *  - each of the three casings, at the ENGINE, on every road that folds:
 *    scalar comparison SQL + runtime, `like` / `notLike`, `array-op` element
 *    containment, `text-search` and `text-score` in both roads;
 *  - a FIELD's declaration beating a non-default engine default IN BOTH
 *    DIRECTIONS (the direction that is easy to get wrong is an `'exact'` engine
 *    with a `'fold'` column, because the literal on the other side of the
 *    comparison declares nothing);
 *  - the roads that have never folded, asserted to STILL not fold (`in`,
 *    `between`, `order by`, relation identity / join keys) — a control honoured
 *    by some sites and not others reads as fixed when it is not;
 *  - the retired `sensitive` key, refused rather than ignored;
 *  - runtime ↔ SQL agreement for `'collated'`, whose whole point is that the two
 *    roads must agree while only one of them emits a fold.
 */
import { describe, it, expect } from 'vitest';
import { createRegistry } from '../registry';
import { QueryEngine } from '../engine';
import { QueryTypeError } from '../problem';
import { arrayExecutor } from '../runtime/executor';
import { TextFieldType } from '../field-types/index';
import {
  DEFAULT_TEXT_CASING,
  effectiveCasing,
  foldsAtRuntime,
  foldsInSql,
  strictestCasing,
  type TextCasing,
} from '../text-casing';
import type { ExprDef, SelectDef, SourceRecord, TypeDef } from '../schema';
import type { SourceRecord as RuntimeRecord } from '../runtime/row';

// ─── Fixture ─────────────────────────────────────────────────────────────────

/**
 * `doc` carries one column per casing plus two that declare NONE, so a single
 * fixture can show the declaration beating the default and the default filling
 * the gap. `title` is also `search: true` so the full-text roads have a column.
 */
const docTypeDef: TypeDef = {
  name: 'doc',
  fields: [
    { name: 'id', type: { kind: 'number', whole: true } },
    // Declares nothing ⇒ inherits the engine default. This is the shape the
    // reported defect was about: a uuid rendered as text.
    { name: 'ref', type: { kind: 'text' } },
    { name: 'title', type: { kind: 'text', search: true } },
    { name: 'code', type: { kind: 'text', casing: 'exact' } },
    { name: 'slug', type: { kind: 'text', casing: 'fold' } },
    { name: 'label', type: { kind: 'text', casing: 'collated' } },
    { name: 'tags', type: { kind: 'array', item: { kind: 'text' } }, nullable: true },
    { name: 'exactTags', type: { kind: 'array', item: { kind: 'text', casing: 'exact' } }, nullable: true },
  ],
  count: 100,
  bytes: 64,
};

const docRows: RuntimeRecord[] = [
  { id: 1, ref: 'ABC', title: 'Ada Lovelace', code: 'ABC', slug: 'ABC', label: 'ABC', tags: ['Beta'], exactTags: ['Beta'] },
  { id: 2, ref: 'abc', title: 'ada lovelace', code: 'abc', slug: 'abc', label: 'abc', tags: ['beta'], exactTags: ['beta'] },
  { id: 3, ref: 'zzz', title: 'Something Else', code: 'zzz', slug: 'zzz', label: 'zzz', tags: ['gamma'], exactTags: ['gamma'] },
];

/** An engine over `doc` with the given engine-wide casing (omitted ⇒ the package default). */
function docEngine(textCasing?: TextCasing): QueryEngine {
  const registry = createRegistry();
  registry.registerType(registry.parseType(docTypeDef));
  registry.finalize();
  return new QueryEngine(registry, {
    ...(textCasing === undefined ? {} : { textCasing }),
    executors: { doc: arrayExecutor(docRows) },
  });
}

const ref = (field: string): ExprDef => ({ kind: 'field-ref', source: 'doc', field });
const lit = (value: string | number | null): ExprDef => ({ kind: 'literal', value });
const cmp = (op: '=' | '<' | 'like' | 'notLike' | 'ilike', left: ExprDef, right: ExprDef): ExprDef =>
  ({ kind: 'comparison', op, left, right });

/** A SELECT of `doc.id` (ordered) under `where`. */
function whereDocs(...where: ExprDef[]): SelectDef {
  return {
    kind: 'select',
    fields: [{ expr: ref('id'), as: 'id' }],
    from: { kind: 'type', type: 'doc' },
    where,
    order: [{ expr: ref('id'), dir: 'asc' }],
  };
}

const sqlOf = (engine: QueryEngine, def: SelectDef): string => engine.toSQL(def, 'base').sql;
const idsOf = async (engine: QueryEngine, def: SelectDef): Promise<number[]> =>
  (await engine.run(def)).rows.map((r: SourceRecord) => r['id'] as number);

// ─── The casing algebra ──────────────────────────────────────────────────────

describe('the casing algebra', () => {
  it('ranks exact ≻ fold ≻ collated, and the max is commutative + idempotent', () => {
    const all: TextCasing[] = ['fold', 'collated', 'exact'];
    for (const a of all) {
      expect(strictestCasing(a, a)).toBe(a); // idempotent
      for (const b of all) expect(strictestCasing(a, b)).toBe(strictestCasing(b, a)); // commutative
    }
    expect(strictestCasing('fold', 'collated')).toBe('fold');
    expect(strictestCasing('exact', 'fold')).toBe('exact');
    expect(strictestCasing('exact', 'collated')).toBe('exact');
  });

  it('consults the fallback ONLY when neither side declares — the authoritative-declaration rule', () => {
    expect(effectiveCasing(undefined, undefined, 'exact')).toBe('exact');
    // One declaration is enough to shut the default out entirely. This is the
    // case that breaks if the default is folded in per-operand: `slug = 'x'`
    // has a declaring column on the left and a bare literal on the right.
    expect(effectiveCasing('fold', undefined, 'exact')).toBe('fold');
    expect(effectiveCasing(undefined, 'fold', 'exact')).toBe('fold');
    // Two declarations reconcile between themselves; the default never enters.
    expect(effectiveCasing('fold', 'exact', 'collated')).toBe('exact');
  });

  it('splits the three casings across the two roads — no two are the same behaviour', () => {
    expect([foldsInSql('fold'), foldsAtRuntime('fold')]).toEqual([true, true]);
    expect([foldsInSql('collated'), foldsAtRuntime('collated')]).toEqual([false, true]);
    expect([foldsInSql('exact'), foldsAtRuntime('exact')]).toEqual([false, false]);
  });

  it('ships defaulted to the pre-existing behaviour', () => {
    expect(DEFAULT_TEXT_CASING).toBe('fold');
    expect(docEngine().textCasing).toBe('fold');
    expect(docEngine('exact').textCasing).toBe('exact');
  });
});

// ─── The index shape — the assertion this whole feature exists for ───────────

describe('the emitted predicate over an id-shaped text column', () => {
  it('an `exact` engine emits a BARE comparison — sargable, and legal over a physical uuid', () => {
    const sql = sqlOf(docEngine('exact'), whereDocs(cmp('=', ref('ref'), lit('ABC'))));
    expect(sql).toContain('"doc"."ref" = ?');
    // The point of the release: no function call wrapping the COLUMN.
    expect(sql).not.toContain('LOWER(');
  });

  it('a `collated` engine also emits a bare comparison (the column collation folds)', () => {
    const sql = sqlOf(docEngine('collated'), whereDocs(cmp('=', ref('ref'), lit('ABC'))));
    expect(sql).toContain('"doc"."ref" = ?');
    expect(sql).not.toContain('LOWER(');
  });

  it('the DEFAULT engine still wraps both operands — the behaviour did not flip', () => {
    const sql = sqlOf(docEngine(), whereDocs(cmp('=', ref('ref'), lit('ABC'))));
    expect(sql).toContain('LOWER("doc"."ref") = LOWER(?)');
  });
});

// ─── A field declaration beats the engine default, in BOTH directions ────────

describe('a field declaration is authoritative over the engine default', () => {
  it('an `exact` column stays bare under a `fold` engine', () => {
    const sql = sqlOf(docEngine('fold'), whereDocs(cmp('=', ref('code'), lit('ABC'))));
    expect(sql).toContain('"doc"."code" = ?');
    expect(sql).not.toContain('LOWER(');
  });

  it('a `fold` column KEEPS its LOWER under an `exact` engine (the easy direction to break)', () => {
    // The literal on the right declares nothing. If the default were resolved
    // per-operand and then reconciled, `exact` would arrive via the literal and
    // out-rank the column's own explicit `'fold'` — silently making a column
    // case-sensitive that says in its own definition that it is not.
    const sql = sqlOf(docEngine('exact'), whereDocs(cmp('=', ref('slug'), lit('ABC'))));
    expect(sql).toContain('LOWER("doc"."slug") = LOWER(?)');
  });

  it('a `collated` column emits no LOWER under a `fold` engine, and still folds at runtime', async () => {
    const engine = docEngine('fold');
    expect(sqlOf(engine, whereDocs(cmp('=', ref('label'), lit('ABC'))))).not.toContain('LOWER(');
    // Both rows: the runtime folds because the deployment declared the STORE does.
    expect(await idsOf(engine, whereDocs(cmp('=', ref('label'), lit('ABC'))))).toEqual([1, 2]);
  });

  it('two differently-cased columns compared to each other take the STRICTER casing', () => {
    // `slug` says fold, `code` says exact ⇒ exact wins, preserving the old rule
    // that a case-sensitive field on either side forces an exact match.
    const sql = sqlOf(docEngine(), whereDocs(cmp('=', ref('slug'), ref('code'))));
    expect(sql).toContain('"doc"."slug" = "doc"."code"');
    expect(sql).not.toContain('LOWER(');
  });
});

// ─── Every road that folds, under each casing ────────────────────────────────

describe('every folding road honours the casing', () => {
  it('scalar comparison: run + SQL agree under each engine casing', async () => {
    const def = whereDocs(cmp('=', ref('ref'), lit('ABC')));
    // fold: both rows match, and the SQL a database would evaluate to that.
    expect(await idsOf(docEngine('fold'), def)).toEqual([1, 2]);
    expect(sqlOf(docEngine('fold'), def)).toContain('LOWER("doc"."ref") = LOWER(?)');
    // collated: the runtime folds; the SQL leaves it to the (declared CI) column.
    expect(await idsOf(docEngine('collated'), def)).toEqual([1, 2]);
    expect(sqlOf(docEngine('collated'), def)).toContain('"doc"."ref" = ?');
    // exact: only the exact-case row, in both roads.
    expect(await idsOf(docEngine('exact'), def)).toEqual([1]);
    expect(sqlOf(docEngine('exact'), def)).toContain('"doc"."ref" = ?');
  });

  it('ordering comparisons fold too (`<` over text), and stop under `exact`', () => {
    expect(sqlOf(docEngine(), whereDocs(cmp('<', ref('ref'), lit('m'))))).toContain('LOWER("doc"."ref") < LOWER(?)');
    expect(sqlOf(docEngine('exact'), whereDocs(cmp('<', ref('ref'), lit('m'))))).toContain('"doc"."ref" < ?');
  });

  it('like / notLike honour the casing in both roads', async () => {
    const like = whereDocs(cmp('like', ref('ref'), lit('AB%')));
    expect(await idsOf(docEngine('fold'), like)).toEqual([1, 2]);
    expect(sqlOf(docEngine('fold'), like)).toContain('LOWER("doc"."ref") LIKE LOWER(?)');
    expect(await idsOf(docEngine('exact'), like)).toEqual([1]);
    expect(sqlOf(docEngine('exact'), like)).toContain('"doc"."ref" LIKE ?');

    const notLike = whereDocs(cmp('notLike', ref('ref'), lit('AB%')));
    expect(await idsOf(docEngine('exact'), notLike)).toEqual([2, 3]);
    expect(sqlOf(docEngine('exact'), notLike)).toContain('"doc"."ref" NOT LIKE ?');
  });

  it('ilike is case-insensitive by DEFINITION and consults no casing', async () => {
    const def = whereDocs(cmp('ilike', ref('code'), lit('ab%')));
    // `code` declares `exact` and the engine is `exact` — ilike still matches both.
    expect(await idsOf(docEngine('exact'), def)).toEqual([1, 2]);
    // The base dialect has no ILIKE operator, so it lowers as the OP's own
    // semantics — not as a casing decision.
    expect(sqlOf(docEngine('exact'), def)).toContain('LOWER("doc"."code") LIKE LOWER(?)');
  });

  it('array-op element containment honours the element casing, else the engine default', async () => {
    const anyTag = (field: string, value: string): SelectDef =>
      whereDocs({ kind: 'array-op', op: 'contains', target: ref(field), value: lit(value) });
    // Undeclared element type ⇒ the engine default.
    expect(await idsOf(docEngine('fold'), anyTag('tags', 'BETA'))).toEqual([1, 2]);
    expect(await idsOf(docEngine('exact'), anyTag('tags', 'BETA'))).toEqual([]);
    expect(await idsOf(docEngine('exact'), anyTag('tags', 'Beta'))).toEqual([1]);
    // A declared `exact` element stays exact under a folding engine.
    expect(await idsOf(docEngine('fold'), anyTag('exactTags', 'BETA'))).toEqual([]);
    expect(await idsOf(docEngine('fold'), anyTag('exactTags', 'Beta'))).toEqual([1]);
  });

  it('text-search degrades to an exact-case LIKE under `exact`, and folds otherwise', async () => {
    const search = whereDocs({ kind: 'text-search', source: 'doc', field: 'title', query: 'ADA' });
    expect(await idsOf(docEngine('fold'), search)).toEqual([1, 2]);
    expect(sqlOf(docEngine('fold'), search)).toContain('LOWER("doc"."title") LIKE LOWER(?)');
    // `collated` picks the same emission as `fold`: a folded search runs through
    // the dialect's text-search machinery, which is indexed and has no LOWER(col)
    // predicate for a collation to spare.
    expect(sqlOf(docEngine('collated'), search)).toContain('LOWER("doc"."title") LIKE LOWER(?)');
    expect(await idsOf(docEngine('exact'), search)).toEqual([]);
    expect(sqlOf(docEngine('exact'), search)).toContain('"doc"."title" LIKE ?');
  });

  it('text-score honours the casing in both roads', async () => {
    const scored: SelectDef = {
      kind: 'select',
      fields: [
        { expr: ref('id'), as: 'id' },
        { expr: { kind: 'text-score', source: 'doc', field: 'title', query: 'ADA' }, as: 'score' },
      ],
      from: { kind: 'type', type: 'doc' },
      order: [{ expr: ref('id'), dir: 'asc' }],
    };
    const folded = (await docEngine('fold').run(scored)).rows.map((r: SourceRecord) => r['score']);
    expect(folded[0]).toBeGreaterThan(0);
    const exact = (await docEngine('exact').run(scored)).rows.map((r: SourceRecord) => r['score']);
    expect(exact[0]).toBe(0);
    expect(docEngine('exact').toSQL(scored, 'base').sql).not.toContain('LOWER(');
  });
});

// ─── The roads that have never folded, asserted to still not ─────────────────

describe('roads that do not fold, and did not start', () => {
  it('`in` compares exactly under EVERY casing, in both roads', async () => {
    const def = whereDocs({ kind: 'in', value: ref('ref'), in: [lit('ABC')] });
    for (const casing of ['fold', 'collated', 'exact'] as const) {
      expect(await idsOf(docEngine(casing), def)).toEqual([1]);
      expect(sqlOf(docEngine(casing), def)).not.toContain('LOWER(');
    }
  });

  it('`between` compares exactly under EVERY casing', () => {
    const def = whereDocs({ kind: 'between', value: ref('ref'), lower: lit('A'), upper: lit('Z') });
    for (const casing of ['fold', 'collated', 'exact'] as const) {
      expect(sqlOf(docEngine(casing), def)).not.toContain('LOWER(');
    }
  });

  it('a relation JOIN over a TEXT key emits a bare ON — under the folding default too', () => {
    // The join predicate is the road where a `LOWER()` would hurt most (it runs
    // per row of the driving side), and it has never folded: `_relation-compare`
    // emits a bare `=` per key column and compares with `compareTo` at runtime.
    // Pinned here because "the control governs comparisons" reads as if it
    // governed this one, and it does not — the key comparison is an IDENTITY
    // comparison, not a text match.
    const registry = createRegistry();
    registry.registerType(registry.parseType({
      name: 'owner',
      fields: [{ name: 'id', type: { kind: 'text' } }, { name: 'name', type: { kind: 'text' } }],
      indexes: [{ exprs: [{ expr: { kind: 'field-ref', source: 'owner', field: 'id' }, count: 1 }] }],
      count: 100,
      bytes: 32,
    }));
    registry.registerType(registry.parseType({
      name: 'item',
      fields: [
        { name: 'id', type: { kind: 'number', whole: true } },
        { name: 'ownerId', type: { kind: 'relation', to: 'owner', count: 1 } },
      ],
      count: 1000,
      bytes: 32,
    }));
    registry.finalize();
    const engine = new QueryEngine(registry); // the FOLDING default
    const sql = engine.toSQL({
      kind: 'select',
      fields: [{ expr: { kind: 'field-ref', source: 'item', field: 'id' }, as: 'id' }],
      from: { kind: 'type', type: 'item' },
      joins: [{ on: { kind: 'relation', source: 'item', field: 'ownerId', as: 'o' } }],
    }, 'base').sql;
    expect(sql).toContain('"item"."ownerId" = "o"."id"');
    expect(sql).not.toContain('LOWER(');
  });

  it('ORDER BY over a text column is never wrapped', () => {
    const def: SelectDef = {
      kind: 'select',
      fields: [{ expr: ref('id'), as: 'id' }],
      from: { kind: 'type', type: 'doc' },
      order: [{ expr: ref('ref'), dir: 'asc' }],
    };
    for (const casing of ['fold', 'collated', 'exact'] as const) {
      const sql = sqlOf(docEngine(casing), def);
      expect(sql).toContain('ORDER BY "doc"."ref" ASC');
      expect(sql).not.toContain('LOWER(');
    }
  });
});

// ─── The retired option ──────────────────────────────────────────────────────

describe('the retired `sensitive` option', () => {
  it('is REFUSED at declaration time, not silently dropped', () => {
    const registry = createRegistry();
    // A def carried over from 0.6.5. Ignoring it would revert the column to
    // case-FOLDED matching with nothing to notice, which is the one outcome
    // worse than a thrown error.
    // Not a cast: an object read from a VARIABLE is not "fresh", so TypeScript
    // admits the extra property — which is exactly the shape a def loaded from
    // storage arrives in, and the reason the check has to exist at runtime.
    const legacy = { kind: 'text' as const, sensitive: true };
    expect(() => registry.parseFieldType(legacy)).toThrow(QueryTypeError);
    try {
      registry.parseFieldType(legacy);
      expect.unreachable('a legacy `sensitive` key must throw');
    } catch (err) {
      expect(err).toBeInstanceOf(QueryTypeError);
      const problem = (err as QueryTypeError).problem;
      expect(problem.code).toBe('field-type.retired-option');
      // The message names the replacement, and the right one for the value.
      expect(problem.message).toContain("casing: 'exact'");
    }
  });

  it("names `casing: 'fold'` for the `sensitive: false` spelling", () => {
    const registry = createRegistry();
    try {
      const legacyFalse = { kind: 'text' as const, sensitive: false };
      registry.parseFieldType(legacyFalse);
      expect.unreachable('a legacy `sensitive` key must throw');
    } catch (err) {
      expect((err as QueryTypeError).problem.message).toContain("casing: 'fold'");
    }
  });
});

// ─── Serialization + the param meet ──────────────────────────────────────────

describe('casing through the def round-trip and the param meet', () => {
  it('round-trips every casing through from/toJSON', () => {
    for (const casing of ['fold', 'collated', 'exact'] as const) {
      const ft = TextFieldType.from({ kind: 'text', casing });
      expect(ft.textCasing()).toBe(casing);
      expect(ft.toJSON()).toEqual({ kind: 'text', casing });
    }
    expect(TextFieldType.from({ kind: 'text' }).toJSON()).toEqual({ kind: 'text' });
  });

  it('meets to the STRICTER casing, commutatively, with absent as TOP', () => {
    const meet = (a: TextCasing | undefined, b: TextCasing | undefined): TextCasing | undefined => {
      const merged = new TextFieldType(a === undefined ? {} : { casing: a })
        .meet(new TextFieldType(b === undefined ? {} : { casing: b }));
      return merged instanceof TextFieldType ? merged.options.casing : undefined;
    };
    expect(meet('fold', 'exact')).toBe('exact');
    expect(meet('exact', 'fold')).toBe('exact');
    expect(meet('collated', 'fold')).toBe('fold');
    expect(meet(undefined, 'collated')).toBe('collated');
    expect(meet('exact', undefined)).toBe('exact');
    expect(meet(undefined, undefined)).toBeUndefined();
  });

  it("a param inferred from an `exact` column carries that casing into its type", () => {
    const engine = docEngine();
    const def = whereDocs(cmp('=', ref('code'), { kind: 'param', name: 'p' }));
    const info = engine.parameters(def).find((p) => p.name === 'p');
    expect(info?.type?.toJSON()).toEqual({ kind: 'text', casing: 'exact' });
  });
});
