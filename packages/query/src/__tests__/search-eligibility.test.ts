/**
 * A6 — the whole-type question and the per-field question are separate, and the
 * library stops GUESSING which column an unnarrowed search means.
 *
 * `searchColumn` used to try three fallbacks in order — the first
 * `search`-flagged text field, then the first text field of any kind, then a
 * column literally named `search`. So a query asking for a multi-field DOCUMENT
 * silently searched one column, and WHICH column depended on field order. There
 * was no way to notice.
 *
 * A `SearchBacking` IS the "this document exists, here is how to search it"
 * declaration; with none, refusing is the only honest answer. Adding a third
 * "declared but not backed" state would just give a consumer a second thing to
 * keep in sync.
 */
import { describe, it, expect } from 'vitest';
import { createRegistry } from '../registry';
import { QueryEngine } from '../engine';
import type { TypeDef } from '../schema';
import type { TypeBacking } from '../backing';

const articleDef: TypeDef = {
  name: 'article',
  fields: [
    { name: 'id', type: { kind: 'number', whole: true } },
    // NOT flagged, but FIRST — the old "first text field" fallback would have
    // picked this one for a type with no flagged field.
    { name: 'slug', type: { kind: 'text' } },
    { name: 'title', type: { kind: 'text', search: true } },
    { name: 'body', type: { kind: 'text', search: true, semantic: true } },
    { name: 'author', type: { kind: 'relation', to: 'article', count: 1 }, nullable: true },
  ],
  count: 100,
  bytes: 64,
};

function engineOf(backing?: TypeBacking): QueryEngine {
  const registry = createRegistry();
  registry.registerType(registry.parseType(articleDef), backing);
  registry.finalize();
  return new QueryEngine(registry);
}

const wholeSearch = {
  kind: 'select',
  fields: [{ expr: { kind: 'field-ref', source: 'article', field: 'id' }, as: 'id' }],
  from: { kind: 'type', type: 'article' },
  where: [{ kind: 'text-search', source: 'article', query: 'cat' }],
} as const;

describe('A6 — search eligibility vs. a searchable document', () => {
  it('splits the WHOLE-TYPE question from the PER-FIELD one', () => {
    const type = engineOf().type('article')!;
    // Eligibility (used for schema gating / the capability line) is the union.
    expect(type.isSearchable()).toBe(true);
    expect(type.isSemantic()).toBe(true);
    // The per-field question is now askable on its own.
    expect(type.isFieldSearchable(type.field('title')!)).toBe(true);
    expect(type.isFieldSearchable(type.field('slug')!)).toBe(false);
    expect(type.isFieldSemantic(type.field('body')!)).toBe(true);
    expect(type.isFieldSemantic(type.field('title')!)).toBe(true); // `search` implies embeddable
    expect(type.isFieldSemantic(type.field('slug')!)).toBe(false);
  });

  it('a RELATION field is no longer treated as semantic-eligible', () => {
    const type = engineOf().type('article')!;
    // `semanticFields()` used to include EVERY relation field, which made almost
    // any type with a foreign key report itself semantic. A relation is a join,
    // not an embedding.
    expect(type.semanticFields().map((f) => f.name)).toEqual(['title', 'body']);
    expect(type.isFieldSemantic(type.field('author')!)).toBe(false);

    // A type whose ONLY "evidence" was a relation is now correctly not eligible.
    const registry = createRegistry();
    registry.registerType(
      registry.parseType({
        name: 'link',
        fields: [
          { name: 'id', type: { kind: 'number', whole: true } },
          { name: 'target', type: { kind: 'relation', to: 'link', count: 1 } },
        ],
        count: 10,
        bytes: 16,
      }),
    );
    registry.finalize();
    expect(new QueryEngine(registry).type('link')!.isSemantic()).toBe(false);
  });

  it('an UNBACKED whole-source search is refused rather than resolved to a guess', () => {
    const engine = engineOf();
    const problem = engine.validateQuery(wholeSearch).list.find((p) => p.code === 'text-search.unbacked');
    expect(problem).toBeDefined();
    // The message names BOTH remedies, since either is a correct fix.
    expect(problem!.message).toContain('no whole-record document to search');
    expect(problem!.message).toContain('Narrow the search to a text field');
    expect(problem!.message).toContain('declare a SearchBacking');
    // Emission refuses too, so a caller that skipped validation cannot get
    // silently-wrong SQL out the other side.
    expect(() => engine.toSQL(wholeSearch, 'postgres')).toThrow(/text-search\.unbacked/);
  });

  it('a BACKED whole-source search is clean and emits the backing form', () => {
    const engine = engineOf({ search: { vectorField: 'search_tsv', language: 'english' } });
    expect(engine.validateQuery(wholeSearch).list.map((p) => p.code)).toEqual([]);
    expect(engine.toSQL(wholeSearch, 'postgres').sql).toContain('"article"."search_tsv" @@ plainto_tsquery(');
  });

  it('a FIELD-NARROWED search needs no backing and is unaffected', () => {
    const engine = engineOf();
    const narrowed = {
      ...wholeSearch,
      where: [{ kind: 'text-search', source: 'article', field: 'title', query: 'cat' }],
    };
    expect(engine.validateQuery(narrowed).list.map((p) => p.code)).toEqual([]);
    expect(engine.toSQL(narrowed, 'postgres').sql).toContain('to_tsvector("article"."title")');
  });

  it('narrowing is ORDER-INDEPENDENT: the unflagged first text field is never picked', () => {
    const engine = engineOf();
    // `slug` precedes `title`, and the deleted "first text field" fallback would
    // have chosen it for a type with no flagged field. The refusal makes the
    // outcome independent of declaration order entirely.
    expect(() => engine.toSQL(wholeSearch, 'base')).toThrow(/text-search\.unbacked/);
    expect(engine.toSQL({ ...wholeSearch, where: [{ kind: 'text-search', source: 'article', field: 'slug', query: 'cat' }] }, 'base').sql)
      .toContain('"article"."slug"');
  });
});
