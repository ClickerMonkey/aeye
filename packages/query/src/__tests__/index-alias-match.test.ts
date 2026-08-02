/**
 * A2 — an index part must match an ALIASED usage of the same column.
 *
 * An index is a TYPE-level fact, so its parts are necessarily written against
 * the Type NAME (`IndexPartDef.expr` is an `ExprDef`, and a `field-ref` carries
 * a `source`). A query may bind that Type under an alias — `FROM user AS u`, or
 * either side of a self-join — and the raw digests then never line up, so a
 * declared unique index bought nothing at all: the estimate came out identical
 * to having no index.
 *
 * The matching is also SOURCE-SCOPED, which closes a latent bug in the other
 * direction: a JOIN alias that happens to equal another Type's name used to
 * match the scanned Type's index parts.
 */
import { describe, it, expect } from 'vitest';
import { createRegistry } from '../registry';
import { QueryEngine } from '../engine';
import { Index, IndexPart, exprDigest, renameSource, aliasedDigest } from '../index-spec';
import { cctx } from './_utils';
import type { TypeDef, SelectDef, ExprDef } from '../schema';

/** 10M people, unique index on `email`. */
const personDef: TypeDef = {
  name: 'person',
  fields: [
    { name: 'id', type: { kind: 'number', whole: true } },
    { name: 'email', type: { kind: 'text' } },
    { name: 'managerEmail', type: { kind: 'text' }, nullable: true },
  ],
  indexes: [
    { exprs: [{ expr: { kind: 'field-ref', source: 'person', field: 'id' }, count: 1 }] },
    { exprs: [{ expr: { kind: 'field-ref', source: 'person', field: 'email' }, count: 1 }] },
  ],
  count: 10_000_000,
  bytes: 96,
};

/** A second Type whose NAME collides with a join alias used below. */
const noteDef: TypeDef = {
  name: 'email',
  fields: [
    { name: 'id', type: { kind: 'number', whole: true } },
    { name: 'body', type: { kind: 'text' } },
  ],
  indexes: [{ exprs: [{ expr: { kind: 'field-ref', source: 'email', field: 'id' }, count: 1 }] }],
  count: 100,
  bytes: 32,
};

function engineOf(): QueryEngine {
  const registry = createRegistry();
  registry.registerType(registry.parseType(personDef));
  registry.registerType(registry.parseType(noteDef));
  registry.finalize();
  return new QueryEngine(registry);
}

/** `SELECT id FROM person [AS alias] WHERE <alias>.email = 'a@b.c'`. */
function emailLookup(alias: string | undefined): SelectDef {
  const source = alias ?? 'person';
  return {
    kind: 'select',
    fields: [{ expr: { kind: 'field-ref', source, field: 'id' }, as: 'id' }],
    from: alias ? { kind: 'aliased', type: 'person', as: alias } : { kind: 'type', type: 'person' },
    where: [
      {
        kind: 'comparison',
        op: '=',
        left: { kind: 'field-ref', source, field: 'email' },
        right: { kind: 'literal', value: 'a@b.c' },
      },
    ],
  };
}

describe('A2 — index matching is alias-normalized and source-scoped', () => {
  it('renameSource rewrites only the matching source, leaving other nodes intact', () => {
    const expr: ExprDef = {
      kind: 'comparison',
      op: '=',
      left: { kind: 'field-ref', source: 'u', field: 'email' },
      right: { kind: 'field-ref', source: 'other', field: 'email' },
    };
    expect(renameSource(expr, 'u', 'person')).toEqual({
      kind: 'comparison',
      op: '=',
      left: { kind: 'field-ref', source: 'person', field: 'email' },
      right: { kind: 'field-ref', source: 'other', field: 'email' },
    });
    // A pure function over a fresh tree — the input is untouched.
    expect(expr.kind === 'comparison' && expr.left).toEqual({ kind: 'field-ref', source: 'u', field: 'email' });
  });

  it('aliasedDigest equals the type-named digest, and is a no-op when they match', () => {
    const aliased: ExprDef = { kind: 'field-ref', source: 'u', field: 'email' };
    const named: ExprDef = { kind: 'field-ref', source: 'person', field: 'email' };
    expect(aliasedDigest(aliased, 'u', 'person')).toBe(exprDigest(named));
    expect(aliasedDigest(named, 'person', 'person')).toBe(exprDigest(named));
    // A ref bound to a DIFFERENT source is not rewritten, so it still misses.
    expect(aliasedDigest({ kind: 'field-ref', source: 'v', field: 'email' }, 'u', 'person')).not.toBe(exprDigest(named));
  });

  it('Index.prefixReduction matches an aliased usage only when given the binding', () => {
    const idx = new Index([new IndexPart({ kind: 'field-ref', source: 'person', field: 'email' }, 1)]);
    const usage = { toJSON: (): ExprDef => ({ kind: 'field-ref', source: 'u', field: 'email' }) };
    // Without the binding the digests are literal — the historical behaviour.
    expect(idx.prefixReduction([usage])).toBeUndefined();
    expect(idx.prefixReduction([usage], { source: 'u', typeName: 'person' })).toBe(1);
  });

  it('an ALIASED equality on a unique index costs the same as the unaliased one', () => {
    const engine = engineOf();
    const unaliased = engine.parseQuery(emailLookup(undefined)).cost(cctx(engine), engine.globalScope());
    const aliased = engine.parseQuery(emailLookup('u')).cost(cctx(engine), engine.globalScope());
    // Previously the aliased form fell back to the fixed EQ selectivity over 10M
    // rows (3.3M) — six orders of magnitude off, in the direction that makes a
    // cheap query look catastrophic.
    expect(unaliased.rows).toBe(1);
    expect(aliased.rows).toBe(1);
    expect(aliased.bytes).toBe(unaliased.bytes);
  });

  it('a SELF-JOIN lets each alias probe the same index independently', () => {
    const engine = engineOf();
    const def: SelectDef = {
      kind: 'select',
      fields: [{ expr: { kind: 'field-ref', source: 'a', field: 'id' }, as: 'id' }],
      from: { kind: 'aliased', type: 'person', as: 'a' },
      where: [
        { kind: 'comparison', op: '=', left: { kind: 'field-ref', source: 'a', field: 'email' }, right: { kind: 'literal', value: 'a@b.c' } },
      ],
    };
    expect(engine.parseQuery(def).cost(cctx(engine), engine.globalScope()).rows).toBe(1);
  });

  it('a join alias equal to ANOTHER Type name does not match the scanned Type index parts', () => {
    const engine = engineOf();
    // `email` is a registered Type AND the name of `person`'s indexed column.
    // The predicate binds the JOINED source, so it must not reduce `person`.
    const def: SelectDef = {
      kind: 'select',
      fields: [{ expr: { kind: 'field-ref', source: 'person', field: 'id' }, as: 'id' }],
      from: { kind: 'type', type: 'person' },
      where: [
        { kind: 'comparison', op: '=', left: { kind: 'field-ref', source: 'email', field: 'id' }, right: { kind: 'literal', value: 1 } },
      ],
    };
    const rows = engine.parseQuery(def).cost(cctx(engine), engine.globalScope()).rows;
    // Not collapsed to the unique-index bound of 1 — `email.id` is not a part of
    // any index ON `person`.
    expect(rows).toBeGreaterThan(1);
  });

  it('an aliased GROUP BY key uses the index count instead of the sqrt(rows) fallback', () => {
    const engine = engineOf();
    const def: SelectDef = {
      kind: 'select',
      fields: [
        { expr: { kind: 'field-ref', source: 'u', field: 'email' }, as: 'email' },
        { expr: { kind: 'aggregate', function: 'count', args: {} }, as: 'n' },
      ],
      from: { kind: 'aliased', type: 'person', as: 'u' },
      groupBy: [{ kind: 'field-ref', source: 'u', field: 'email' }],
    };
    // The index says every `email` is distinct-1, so the grouped output is the
    // index's own count — not `ceil(sqrt(10_000_000))` = 3163.
    expect(engine.parseQuery(def).cost(cctx(engine), engine.globalScope()).rows).toBe(1);
  });
});
