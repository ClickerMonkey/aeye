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
import type { FieldType } from '../field-type';

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

  it('the CAPABILITY is answered by the field TYPE, not by its class', () => {
    // Step 5: `isSearchable` / `isSemantic` / `itemType` are declared on
    // `FieldType`, so `Type.isFieldSearchable`, `Field.allowsExpr` and
    // `exprs/semantic.ts` read ONE definition instead of three `instanceof
    // TextFieldType` reads of `options.search` from outside that class.
    const type = engineOf().type('article')!;
    const ft = (name: string): FieldType => type.field(name)!.fieldType;
    expect(ft('title').isSearchable()).toBe(true);
    expect(ft('body').isSemantic()).toBe(true);
    expect(ft('slug').isSearchable()).toBe(false);
    // The default is the conservative answer for every type that has not
    // declared the capability — including a RELATION, which a `semantic` expr
    // may still TARGET (the two are different questions; see `Field.allowsExpr`).
    expect(ft('id').isSearchable()).toBe(false);
    expect(ft('id').isSemantic()).toBe(false);
    expect(ft('author').isSemantic()).toBe(false);
    expect(type.field('author')!.allowsExpr('semantic')).toBe(true);
    // `itemType()` is the ELEMENT accessor, and it is NOT the container test:
    // an array with no declared item is still an array and still takes an
    // `array-op`.
    const registry = createRegistry();
    const typed = registry.parseFieldType({ kind: 'array', item: { kind: 'text' } });
    const bare = registry.parseFieldType({ kind: 'array' });
    expect(typed.itemType()?.kind).toBe('text');
    expect(bare.itemType()).toBeUndefined();
    expect(ft('slug').itemType()).toBeUndefined();
    // …and the gate that reads it is `Field.allowsExpr`, which is the fact the
    // comment above only DESCRIBED: writing its `array-op` arm as
    // `itemType() !== undefined` left the whole suite green, while the sibling
    // check in `exprs/array-op.ts` was pinned. A bare array still takes one.
    const bag = registry.parseType({
      name: 'bag',
      fields: [
        { name: 'typed', type: { kind: 'array', item: { kind: 'text' } } },
        { name: 'bare', type: { kind: 'array' } },
        { name: 'name', type: { kind: 'text' } },
      ],
      count: 10,
      bytes: 32,
    });
    expect(bag.field('bare')!.allowsExpr('array-op')).toBe(true);
    expect(bag.field('typed')!.allowsExpr('array-op')).toBe(true);
    // The container test both ways: a non-array field never takes one.
    expect(bag.field('name')!.allowsExpr('array-op')).toBe(false);
  });

  it('a REFINEMENT inherits the capability through its `options` — no second declaration surface', () => {
    // The design question step 5 asks: can a registered type declare itself
    // searchable? It already can, and through the ONE vocabulary that owns the
    // fact — `search` / `semantic` are `text`'s own options, and a refinement's
    // `options` narrow the base's through the ordinary meet. A `searchable` key
    // on the DECLARATION would be a second source for one fact, meeting through
    // a different lattice (`meetExact`, where two values conflict) than the
    // option it duplicates (`meetFlag`, where they OR).
    const registry = createRegistry();
    registry.registerFieldType({
      name: 'Prose',
      base: 'text',
      instructions: 'Free prose, indexed for search and embedded for semantic scoring.',
      options: { search: true, semantic: true },
    });
    registry.registerFieldType({
      name: 'Slug',
      base: 'text',
      instructions: 'A URL slug — never searched.',
      options: { casing: 'exact' },
    });
    const type = registry.parseType({
      name: 'doc',
      count: 100,
      fields: [
        { name: 'body', type: { kind: 'text', as: 'Prose' } },
        { name: 'slug', type: { kind: 'text', as: 'Slug' } },
        // A SITE adding the flag to a refinement that declares neither.
        { name: 'note', type: { kind: 'text', as: 'Slug', search: true } },
      ],
    });
    registry.registerType(type);
    registry.finalize();
    expect(type.isFieldSearchable(type.field('body')!)).toBe(true);
    expect(type.isFieldSemantic(type.field('body')!)).toBe(true);
    expect(type.field('body')!.allowsExpr('semantic')).toBe(true);
    expect(type.isFieldSearchable(type.field('slug')!)).toBe(false);
    expect(type.field('slug')!.allowsExpr('semantic')).toBe(false);
    // The declaration is a FLOOR: a site may ADD the flag, and (the flags OR
    // through `meetFlag`) cannot take one the declaration set away again.
    expect(type.isFieldSearchable(type.field('note')!)).toBe(true);
    const noOptOut = registry.parseFieldType({ kind: 'text', as: 'Prose', search: false });
    expect(noOptOut.isSearchable()).toBe(true);
    expect(type.isSearchable()).toBe(true);
    expect(type.semanticFields().map((f) => f.name)).toEqual(['body', 'note']);
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
