/**
 * buildSchemas strict mode — Type-name positions are enum-locked, field refs
 * are TYPE+FIELD pairs (each branch pins one Type's name in `source` and an
 * enum of ONLY that Type's fields), relation paths are rooted at a known Type
 * with a valid first hop, and the per-Type filters schema only accepts valid
 * `(field, op)` pairs.
 *
 * Strict mode pins `source` to the Type NAME — the source an unaliased
 * `FROM <Type>` binds — so the fixtures use type-named sources.
 */
import { describe, it, expect } from 'vitest';
import { buildSchemas } from '../llm/schemas';
import type { SelectDef } from '../schema';
import { fixture } from './_utils';

/** A valid select over the `user` Type (source named after the Type). */
function validSelect(): SelectDef {
  return {
    kind: 'select',
    fields: [{ expr: { kind: 'field-ref', source: 'user', field: 'name' } }],
    from: { kind: 'type', type: 'user' },
  };
}

describe('buildSchemas — strict', () => {
  it('accepts a select with a Type+field-paired field-ref', () => {
    const fx = fixture();
    const schemas = buildSchemas(fx.engine, { strict: true });
    expect(schemas.Select.safeParse(validSelect()).success).toBe(true);
  });

  it('accepts a field-ref into a different Type with one of ITS fields', () => {
    const fx = fixture();
    const schemas = buildSchemas(fx.engine, { strict: true });
    const orderSelect: SelectDef = {
      kind: 'select',
      fields: [{ expr: { kind: 'field-ref', source: 'order', field: 'total' } }],
      from: { kind: 'type', type: 'order' },
    };
    expect(schemas.Select.safeParse(orderSelect).success).toBe(true);
  });

  it('REJECTS a field-ref pairing a Type with another Type\'s field', () => {
    const fx = fixture();
    const schemas = buildSchemas(fx.engine, { strict: true });
    // `total` is an `order` field — it must NOT validate under a `user` source.
    const crossed: SelectDef = {
      ...validSelect(),
      fields: [{ expr: { kind: 'field-ref', source: 'user', field: 'total' } }],
    };
    expect(schemas.Select.safeParse(crossed).success).toBe(false);
  });

  it('rejects a select whose FROM names an unknown Type', () => {
    const fx = fixture();
    const schemas = buildSchemas(fx.engine, { strict: true });
    const bad: SelectDef = { ...validSelect(), from: { kind: 'type', type: 'ghost' } };
    expect(schemas.Select.safeParse(bad).success).toBe(false);
  });

  it('rejects a field-ref naming a field that exists on the Type', () => {
    const fx = fixture();
    const schemas = buildSchemas(fx.engine, { strict: true });
    const bad: SelectDef = {
      ...validSelect(),
      fields: [{ expr: { kind: 'field-ref', source: 'user', field: 'nonexistent' } }],
    };
    expect(schemas.Select.safeParse(bad).success).toBe(false);
  });

  it('roots a relation-path at a known Type with a valid first hop', () => {
    const fx = fixture();
    const schemas = buildSchemas(fx.engine, { strict: true });
    const ok: SelectDef = {
      kind: 'select',
      fields: [{ expr: { kind: 'relation-path', source: 'user', path: ['orders', 'total'] }, as: 'orderTotal' }],
      from: { kind: 'type', type: 'user' },
    };
    expect(schemas.Select.safeParse(ok).success).toBe(true);
    // `name` is a field, NOT a relation — invalid first hop.
    const badHop: SelectDef = {
      ...ok,
      fields: [{ expr: { kind: 'relation-path', source: 'user', path: ['name'] }, as: 'x' }],
    };
    expect(schemas.Select.safeParse(badHop).success).toBe(false);
  });

  it('pairs a semantic score with a Type + one of ITS semantic fields', () => {
    const fx = fixture();
    const { Expr } = buildSchemas(fx.engine, { strict: true });
    // `email` is a search-flagged text field ⇒ semantic-eligible.
    expect(Expr.safeParse({ kind: 'semantic', source: 'user', field: 'email', query: 'ada' }).success).toBe(true);
    // The query may be another semantic Type+field.
    expect(
      Expr.safeParse({
        kind: 'semantic',
        source: 'user',
        query: { type: 'user', field: 'email' },
      }).success,
    ).toBe(true);
    // `name` is plain (non-semantic) text ⇒ rejected as a semantic field.
    expect(Expr.safeParse({ kind: 'semantic', source: 'user', field: 'name', query: 'x' }).success).toBe(false);
    // A cross-Type field (`total` is an `order` field) is rejected for `user`.
    expect(Expr.safeParse({ kind: 'semantic', source: 'user', field: 'total', query: 'x' }).success).toBe(false);
  });

  it('pairs a text-search with a Type + one of ITS text fields', () => {
    const fx = fixture();
    const { Expr } = buildSchemas(fx.engine, { strict: true });
    // `email` / `name` are text fields ⇒ valid narrowed-search targets.
    expect(Expr.safeParse({ kind: 'text-search', source: 'user', field: 'email', query: 'ada' }).success).toBe(true);
    // `id` is a number ⇒ not a text field, rejected.
    expect(Expr.safeParse({ kind: 'text-search', source: 'user', field: 'id', query: 'x' }).success).toBe(false);
  });

  it('locks a `filters` placeholder to a known source + its field-name allowlist', () => {
    const fx = fixture();
    const { Expr } = buildSchemas(fx.engine, { strict: true });
    // A bare placeholder over a known source is valid.
    expect(Expr.safeParse({ kind: 'filters', source: 'user' }).success).toBe(true);
    // The `fields` allowlist may only name that Type's fields.
    expect(Expr.safeParse({ kind: 'filters', source: 'user', fields: ['email', 'age'] }).success).toBe(true);
    // An unknown field in the allowlist is rejected.
    expect(Expr.safeParse({ kind: 'filters', source: 'user', fields: ['nope'] }).success).toBe(false);
  });

  it('accepts a field-ref into a JOINED source keyed by the target TYPE name', () => {
    const fx = fixture();
    const schemas = buildSchemas(fx.engine, { strict: true });
    // `user.orders` binds the joined source under its target type name `order`,
    // so a strict field-ref into it is `{ source:'order', field:'total' }` —
    // the SAME type+field pairing as a FROM order, which strict mode accepts.
    const joined: SelectDef = {
      kind: 'select',
      fields: [
        { expr: { kind: 'field-ref', source: 'user', field: 'name' } },
        { expr: { kind: 'field-ref', source: 'order', field: 'total' } },
      ],
      from: { kind: 'type', type: 'user' },
      joins: [{ on: { source: 'user', field: 'orders' } }],
    };
    expect(schemas.Select.safeParse(joined).success).toBe(true);
  });

  it('non-strict mode accepts a free-string Type name and aliased source', () => {
    const fx = fixture();
    const schemas = buildSchemas(fx.engine, { strict: false });
    const anything: SelectDef = {
      kind: 'select',
      fields: [{ expr: { kind: 'field-ref', source: 'w', field: 'whatever' } }],
      from: { kind: 'aliased', type: 'whatever', as: 'w' },
    };
    expect(schemas.Select.safeParse(anything).success).toBe(true);
  });
});
