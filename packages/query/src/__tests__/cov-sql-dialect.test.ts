/**
 * Coverage: the SQL dialects (base + postgres), the abstract `Dialect`
 * contract, and the `SqlText` / `SqlContext` emit combinators.
 */
import { describe, it, expect } from 'vitest';
import { BaseDialect, PostgresDialect } from '../sql/index';
import { SqlText, SqlContext, raw, param, concat, join } from '../sql/emit';
import { JoinCtePlanner } from '../sql/planner';
import { QueryScope } from '../scope';
import {
  NumberFieldType,
  TextFieldType,
  MoneyFieldType,
  BoolFieldType,
  DateFieldType,
  TimestampFieldType,
  JsonFieldType,
  RelationFieldType,
  ArrayFieldType,
} from '../field-types/index';
import { fixture } from './_utils';

const base = new BaseDialect();
const pg = new PostgresDialect();

/** Render a fragment against a dialect → flat SQL string. */
const s = (t: SqlText, d = base): string => t.render(d).sql;

describe('cov base dialect', () => {
  it('name + ANSI placeholder', () => {
    expect(base.name).toBe('base');
    expect(base.NAME).toBe('base');
    expect(base.bindPlaceholder(0)).toBe('?');
    expect(base.bindPlaceholder(3)).toBe('?');
  });

  it('textSearch case-insensitive (default) and sensitive', () => {
    const col = base.field('u', 'email');
    expect(s(base.textSearch(col, 'hi'))).toBe('LOWER("u"."email") LIKE LOWER(?)');
    expect(base.textSearch(col, 'hi').render(base).params).toEqual(['%hi%']);
    expect(s(base.textSearch(col, 'hi', true))).toBe('"u"."email" LIKE ?');
    expect(base.textSearch(col, 'hi', true).render(base).params).toEqual(['%hi%']);
  });

  it('similarity degrades to constant 0', () => {
    expect(s(base.similarity(base.ident('a'), base.ident('b')))).toBe('0');
  });

  it('tsvectorSearch degrades to a case-insensitive LIKE (language ignored)', () => {
    const col = base.field('u', 'search_tsv');
    const out = base.tsvectorSearch(col, SqlText.param('hi'), 'english');
    expect(s(out)).toBe("LOWER(\"u\".\"search_tsv\") LIKE ('%' || LOWER(?) || '%')");
    expect(out.render(base).params).toEqual(['hi']);
  });

  it('queryVectorParam passes the param through unchanged (no vector type)', () => {
    expect(s(base.queryVectorParam(SqlText.param('[1,2]')))).toBe('?');
  });

  it('sqlTypeFor across every scalar kind', () => {
    expect(base.sqlTypeFor(new NumberFieldType({ whole: true }))).toBe('integer');
    expect(base.sqlTypeFor(new NumberFieldType())).toBe('numeric');
    expect(base.sqlTypeFor(new MoneyFieldType())).toBe('numeric');
    expect(base.sqlTypeFor(new TextFieldType({ maxLength: 5 }))).toBe('varchar(5)');
    expect(base.sqlTypeFor(new TextFieldType())).toBe('varchar');
    expect(base.sqlTypeFor(new BoolFieldType())).toBe('boolean');
    expect(base.sqlTypeFor(new DateFieldType())).toBe('date');
    expect(base.sqlTypeFor(new TimestampFieldType(false))).toBe('timestamp');
    expect(base.sqlTypeFor(new TimestampFieldType(true))).toBe('timestamp with time zone');
    expect(base.sqlTypeFor(new TimestampFieldType())).toBe('timestamp with time zone');
    expect(base.sqlTypeFor(new RelationFieldType('X', 1))).toBe('varchar');
    expect(base.sqlTypeFor(new JsonFieldType())).toBe('json');
    expect(base.sqlTypeFor(new ArrayFieldType(new TextFieldType()))).toBe('json');
  });

  it('arrayLength via json_array_length; containment ops throw', () => {
    expect(s(base.arrayLength(base.field('u', 'tags')))).toBe('COALESCE(json_array_length("u"."tags"), 0)');
    const col = base.field('u', 'tags');
    const el = SqlText.param('x');
    expect(() => base.arrayHas(col, el)).toThrow(/contains/);
    expect(() => base.arrayContains(col, [el])).toThrow(/containsAll/);
    expect(() => base.arrayOverlaps(col, [el])).toThrow(/containsAny/);
  });
});

describe('cov postgres dialect', () => {
  it('numbered placeholders (1-based)', () => {
    expect(pg.bindPlaceholder(0)).toBe('$1');
    expect(pg.bindPlaceholder(4)).toBe('$5');
  });

  it('native ilike', () => {
    expect(s(pg.ilike(pg.field('u', 'name'), SqlText.param('a%')), pg)).toBe('"u"."name" ILIKE $1');
  });

  it('textSearch tsvector (default) + sensitive LIKE', () => {
    const col = pg.field('u', 'email');
    expect(s(pg.textSearch(col, 'q'), pg)).toBe('to_tsvector("u"."email") @@ plainto_tsquery($1)');
    expect(pg.textSearch(col, 'q').render(pg).params).toEqual(['q']);
    expect(s(pg.textSearch(col, 'q', true), pg)).toBe('"u"."email" LIKE $1');
  });

  it('cosine similarity', () => {
    expect(s(pg.similarity(pg.ident('a'), pg.ident('b')), pg)).toBe('(1 - ("a" <=> "b"))');
  });

  it('tsvectorSearch matches a precomputed tsvector field (default + custom language)', () => {
    const col = pg.field('acct', 'search_tsv');
    const def = pg.tsvectorSearch(col, SqlText.param('cat'));
    expect(s(def, pg)).toBe(`"acct"."search_tsv" @@ plainto_tsquery('english', $1)`);
    expect(def.render(pg).params).toEqual(['cat']);
    // A custom language is emitted as a quoted regconfig literal (quotes doubled).
    const sp = pg.tsvectorSearch(col, SqlText.param('perro'), "span'ish");
    expect(s(sp, pg)).toBe(`"acct"."search_tsv" @@ plainto_tsquery('span''ish', $1)`);
  });

  it('queryVectorParam casts the param to the pgvector type', () => {
    expect(s(pg.queryVectorParam(SqlText.param('[1,2,3]')), pg)).toBe('$1::vector');
  });

  it('native lateral join (left + inner) ON true', () => {
    const sub = SqlText.raw('SELECT 1');
    expect(s(pg.lateralJoin(sub, 'x', 'left'), pg)).toBe('LEFT JOIN LATERAL (SELECT 1) AS "x" ON true');
    expect(s(pg.lateralJoin(sub, 'x', 'inner'), pg)).toBe('JOIN LATERAL (SELECT 1) AS "x" ON true');
  });

  it('sqlTypeFor pg specifics incl typed + heterogeneous arrays', () => {
    expect(pg.sqlTypeFor(new NumberFieldType({ whole: true }))).toBe('integer');
    expect(pg.sqlTypeFor(new NumberFieldType())).toBe('numeric');
    expect(pg.sqlTypeFor(new MoneyFieldType())).toBe('numeric(19,4)');
    expect(pg.sqlTypeFor(new TextFieldType())).toBe('text');
    expect(pg.sqlTypeFor(new TextFieldType({ maxLength: 8 }))).toBe('varchar(8)');
    expect(pg.sqlTypeFor(new BoolFieldType())).toBe('boolean');
    expect(pg.sqlTypeFor(new DateFieldType())).toBe('date');
    expect(pg.sqlTypeFor(new TimestampFieldType(false))).toBe('timestamp');
    expect(pg.sqlTypeFor(new TimestampFieldType(true))).toBe('timestamptz');
    expect(pg.sqlTypeFor(new RelationFieldType('X', 1))).toBe('text');
    expect(pg.sqlTypeFor(new JsonFieldType())).toBe('jsonb');
    // typed array → element[] ; nested arrays recurse
    expect(pg.sqlTypeFor(new ArrayFieldType(new TextFieldType()))).toBe('text[]');
    expect(pg.sqlTypeFor(new ArrayFieldType(new NumberFieldType({ whole: true })))).toBe('integer[]');
    expect(pg.sqlTypeFor(new ArrayFieldType(new ArrayFieldType(new TextFieldType())))).toBe('text[][]');
    // heterogeneous / unknown element → jsonb
    expect(pg.sqlTypeFor(new ArrayFieldType())).toBe('jsonb');
  });

  it('native array operators', () => {
    const col = pg.field('u', 'tags');
    expect(s(pg.arrayLength(col), pg)).toBe('cardinality("u"."tags")');
    expect(s(pg.arrayHas(col, SqlText.param('a')), pg)).toBe('$1 = ANY("u"."tags")');
    expect(s(pg.arrayContains(col, [SqlText.param('a'), SqlText.param('b')]), pg)).toBe('"u"."tags" @> ARRAY[$1, $2]');
    expect(s(pg.arrayOverlaps(col, [SqlText.param('a')]), pg)).toBe('"u"."tags" && ARRAY[$1]');
  });
});

describe('cov Dialect base contract', () => {
  it('quoteIdent escapes embedded quotes', () => {
    expect(base.quoteIdent('plain')).toBe('"plain"');
    expect(base.quoteIdent('we"ird')).toBe('"we""ird"');
    expect(s(base.ident('a'))).toBe('"a"');
    expect(s(base.field('a', 'b'))).toBe('"a"."b"');
  });

  it('supportsDmlJoins default true', () => {
    expect(base.supportsDmlJoins).toBe(true);
  });

  it('limitOffset: both / limit-only / offset-only / neither', () => {
    const ten = SqlText.raw('10');
    const five = SqlText.raw('5');
    expect(s(base.limitOffset(ten, five))).toBe('LIMIT 10 OFFSET 5');
    expect(s(base.limitOffset(ten, undefined))).toBe('LIMIT 10');
    expect(s(base.limitOffset(undefined, five))).toBe('OFFSET 5');
    expect(base.limitOffset(undefined, undefined).isEmpty()).toBe(true);
  });

  it('base ilike lowers both sides', () => {
    expect(s(base.ilike(base.field('u', 'name'), SqlText.param('a')))).toBe('LOWER("u"."name") LIKE LOWER(?)');
  });

  it('base lateralJoin portable ON 1 = 1 (left + inner branch)', () => {
    const sub = SqlText.raw('SELECT 1');
    expect(s(base.lateralJoin(sub, 'x', 'left'))).toBe('LEFT JOIN LATERAL (SELECT 1) AS "x" ON 1 = 1');
    expect(s(base.lateralJoin(sub, 'x', 'inner'))).toBe('JOIN LATERAL (SELECT 1) AS "x" ON 1 = 1');
  });

  it('emitBuiltinCall routes arrayLength, else undefined', () => {
    const got = base.emitBuiltinCall('arrayLength', [base.field('u', 'tags')]);
    expect(got).toBeDefined();
    expect(s(got!)).toBe('COALESCE(json_array_length("u"."tags"), 0)');
    expect(base.emitBuiltinCall('arrayLength', [])).toBeUndefined();
    expect(base.emitBuiltinCall('unknownFn', [base.ident('a')])).toBeUndefined();
  });

  it('emitBuiltinCall routes currentDate to the bare CURRENT_DATE form', () => {
    const got = base.emitBuiltinCall('currentDate', []);
    expect(got).toBeDefined();
    expect(s(got!)).toBe('CURRENT_DATE');
    expect(s(pg.emitBuiltinCall('currentDate', [])!, pg)).toBe('CURRENT_DATE');
    // The arg-count guard: a stray arg falls through to the generic path.
    expect(base.emitBuiltinCall('currentDate', [base.ident('x')])).toBeUndefined();
  });
});

describe('cov SqlText combinators', () => {
  it('raw / param / empty / concat / join / isEmpty / appendRaw / parens', () => {
    expect(s(SqlText.raw('abc'))).toBe('abc');
    expect(SqlText.empty().isEmpty()).toBe(true);
    expect(SqlText.raw('x').isEmpty()).toBe(false);
    expect(s(SqlText.concat([SqlText.raw('a'), SqlText.raw('b')]))).toBe('ab');
    expect(s(SqlText.join([SqlText.raw('a'), SqlText.raw('b')], ', '))).toBe('a, b');
    // join with empty separator keeps parts contiguous
    expect(s(SqlText.join([SqlText.raw('a'), SqlText.raw('b')], ''))).toBe('ab');
    expect(s(SqlText.raw('a').appendRaw('b'))).toBe('ab');
    expect(s(SqlText.raw('x').parens())).toBe('(x)');
    const r = SqlText.param('v').render(base);
    expect(r.sql).toBe('?');
    expect(r.params).toEqual(['v']);
  });

  it('free-function combinators mirror the statics', () => {
    expect(s(raw('a'))).toBe('a');
    expect(s(param('v'))).toBe('?');
    expect(s(concat([raw('a'), raw('b')]))).toBe('ab');
    expect(s(join([raw('a'), raw('b')], '-'))).toBe('a-b');
  });
});

describe('cov SqlContext derivations', () => {
  it('withScope / withPlanner / asAggregate / filtersFor', () => {
    const fx = fixture();
    const planner = new JoinCtePlanner(base, fx.engine, undefined);
    const scope = new QueryScope();
    const ctx = new SqlContext(base, fx.engine, scope, planner, undefined);
    expect(ctx.inAggregate).toBe(false);
    expect(ctx.filtersFor('user')).toBeUndefined();

    const scope2 = new QueryScope();
    const ctx2 = ctx.withScope(scope2);
    expect(ctx2.scope).toBe(scope2);
    expect(ctx2.planner).toBe(planner);

    const planner2 = new JoinCtePlanner(base, fx.engine, undefined);
    const ctx3 = ctx.withPlanner(scope2, planner2);
    expect(ctx3.planner).toBe(planner2);
    expect(ctx3.includeTotal).toBe(false);

    const agg = ctx.asAggregate(true);
    expect(agg.inAggregate).toBe(true);
    expect(agg.asAggregate(false).inAggregate).toBe(false);
  });
});
