/**
 * PostgreSQL-dialect specifics: `$n` placeholders, native ILIKE,
 * `to_tsvector @@ plainto_tsquery` text search, cosine similarity over an
 * embedding field, and pg field types.
 */
import { describe, it, expect } from 'vitest';
import type { QueryDef, SelectDef } from '../schema';
import { fixture } from './_utils';
import { PostgresDialect, BaseDialect } from '../sql/index';
import { NumberFieldType, TextFieldType, MoneyFieldType, JsonFieldType, TimestampFieldType } from '../field-types/index';

describe('SQL — postgres dialect', () => {
  const fx = fixture();
  const pg = (q: QueryDef) => fx.engine.toSQL(q, 'postgres');

  it('uses $n placeholders numbered in document order', () => {
    const def: SelectDef = {
      kind: 'select',
      fields: [{ expr: { kind: 'field-ref', source: 'user', field: 'name' }, as: 'name' }],
      from: { kind: 'type', type: 'user' },
      where: [
        { kind: 'comparison', op: '>', left: { kind: 'field-ref', source: 'user', field: 'age' }, right: { kind: 'param', name: 'min' } },
        { kind: 'comparison', op: '<', left: { kind: 'field-ref', source: 'user', field: 'age' }, right: { kind: 'param', name: 'max' } },
      ],
    };
    const out = fx.engine.toSQL(def, 'postgres', { params: { min: 18, max: 65 } });
    expect(out.sql).toBe('SELECT "user"."name" AS "name" FROM "user" AS "user" WHERE "user"."age" > $1 AND "user"."age" < $2');
    expect(out.params).toEqual([18, 65]);
  });

  it('native ILIKE', () => {
    const def: SelectDef = {
      kind: 'select',
      fields: [{ expr: { kind: 'field-ref', source: 'user', field: 'name' }, as: 'name' }],
      from: { kind: 'type', type: 'user' },
      where: [{ kind: 'comparison', op: 'ilike', left: { kind: 'field-ref', source: 'user', field: 'name' }, right: { kind: 'literal', value: 'a%' } }],
    };
    expect(pg(def).sql).toBe('SELECT "user"."name" AS "name" FROM "user" AS "user" WHERE "user"."name" ILIKE $1');
  });

  it('to_tsvector full-text search', () => {
    const def: SelectDef = {
      kind: 'select',
      fields: [{ expr: { kind: 'field-ref', source: 'u', field: 'name' }, as: 'name' }],
      from: { kind: 'aliased', type: 'user', as: 'u' },
      where: [{ kind: 'text-search', source: 'u', field: 'email', query: 'hello world' }],
    };
    const out = pg(def);
    expect(out.sql).toContain('to_tsvector("u"."email") @@ plainto_tsquery($1)');
    expect(out.params).toEqual(['hello world']);
  });

  it('cosine similarity over an embedding field', () => {
    const def: SelectDef = {
      kind: 'select',
      fields: [{ expr: { kind: 'semantic', source: 'u', query: 'curious people' }, as: 'score' }],
      from: { kind: 'aliased', type: 'user', as: 'u' },
    };
    // The TEXT term is embedded to a pgvector literal via `convertSemanticText`
    // before it is bound (Postgres cannot cast '<text>'::vector).
    const out = fx.engine.toSQL(def, 'postgres', { convertSemanticText: () => '[0.1,0.2]' });
    expect(out.sql).toContain('(1 - ("u"."embedding" <=> $1))');
    expect(out.params).toEqual(['[0.1,0.2]']);
  });

  it('semantic Type+field query resolves to the single bound source and pairs both vectors', () => {
    const def: SelectDef = {
      kind: 'select',
      fields: [{ expr: { kind: 'semantic', source: 'user', query: { type: 'user', field: 'email' } }, as: 'score' }],
      from: { kind: 'type', type: 'user' },
    };
    // `user` is bound exactly once, so the `{ type }` query resolves to it: a
    // valid self-pairing (no cross-entity error).
    const problems = fx.engine.validateQuery(def);
    expect(problems.list.some((p) => p.code.startsWith('semantic.'))).toBe(false);
    // SQL pairs both bound sides' vectors (no unbound alias, no `email` column).
    const out = pg(def);
    expect(out.sql).toBe('SELECT (1 - ("user"."embedding" <=> "user"."embedding")) AS "score" FROM "user" AS "user"');
    expect(out.sql).not.toContain('"user"."email"');
  });

  it('base dialect degrades text search to LIKE and similarity to 0', () => {
    const def: SelectDef = {
      kind: 'select',
      fields: [{ expr: { kind: 'semantic', source: 'u', query: 'x' }, as: 'score' }],
      from: { kind: 'aliased', type: 'user', as: 'u' },
      where: [{ kind: 'text-search', source: 'u', field: 'email', query: 'q' }],
    };
    const out = fx.engine.toSQL(def, 'base', { convertSemanticText: () => '[0]' });
    expect(out.sql).toContain('0 AS "score"');
    expect(out.sql).toContain('LOWER("u"."email") LIKE LOWER(?)');
  });

  it('per-dialect field types', () => {
    const base = new BaseDialect();
    const post = new PostgresDialect();
    expect(base.sqlTypeFor(new NumberFieldType({ whole: true }))).toBe('integer');
    expect(base.sqlTypeFor(new NumberFieldType())).toBe('numeric');
    expect(base.sqlTypeFor(new TextFieldType())).toBe('varchar');
    expect(post.sqlTypeFor(new TextFieldType())).toBe('text');
    expect(post.sqlTypeFor(new TextFieldType({ maxLength: 20 }))).toBe('varchar(20)');
    expect(post.sqlTypeFor(new JsonFieldType())).toBe('jsonb');
    expect(base.sqlTypeFor(new JsonFieldType())).toBe('json');
    expect(post.sqlTypeFor(new MoneyFieldType())).toBe('numeric(19,4)');
    expect(post.sqlTypeFor(new TimestampFieldType(true))).toBe('timestamptz');
    expect(post.sqlTypeFor(new TimestampFieldType(false))).toBe('timestamp');
  });
});
