/**
 * Type-named sources + the `aliased` escape hatch (Phase A).
 *
 * Covers:
 *  - the non-strict `Source` schema accepts a plain `{ kind:'type' }` and the
 *    `{ kind:'aliased', type, as }` escape hatch;
 *  - the plain `type` branch carries NO alias — an `as` key is ignored (the
 *    union matches the `type` branch and strips it), so the source name always
 *    equals the type name on the common path;
 *  - an `aliased` source binds under its `as` and round-trips through toJSON;
 *  - a `source.duplicate` collision is reported when two sources bind the same
 *    name (here: a join whose `as` collides with the FROM type name), and the
 *    `aliased` form is the documented way out.
 */
import { describe, it, expect } from 'vitest';
import { buildSchemas } from '../llm/schemas';
import type { SelectDef, SourceDef } from '../schema';
import { fixture } from './_utils';

describe('source aliasing — non-strict Source schema', () => {
  it('accepts a plain type source and the aliased escape hatch', () => {
    const fx = fixture();
    const { Source } = buildSchemas(fx.engine);
    expect(Source.safeParse({ kind: 'type', type: 'user' }).success).toBe(true);
    expect(Source.safeParse({ kind: 'aliased', type: 'user', as: 'u' }).success).toBe(true);
  });

  it('the type branch carries no alias — an `as` key is ignored, not bound', () => {
    const fx = fixture();
    const { Source } = buildSchemas(fx.engine);
    const parsed = Source.safeParse({ kind: 'type', type: 'user', as: 'u' });
    expect(parsed.success).toBe(true);
    // The `type` branch has no `as` field, so the extra key is stripped — the
    // common path cannot express an inconsistent alias.
    expect(parsed.success && 'as' in parsed.data).toBe(false);
  });

  it('the aliased branch requires an `as`', () => {
    const fx = fixture();
    const { Source } = buildSchemas(fx.engine);
    expect(Source.safeParse({ kind: 'aliased', type: 'user' }).success).toBe(false);
  });
});

describe('source aliasing — binding + round-trip', () => {
  it('a plain type source is bound under its type name and validates clean', () => {
    const fx = fixture();
    const def: SelectDef = {
      kind: 'select',
      fields: [{ expr: { kind: 'field-ref', source: 'user', field: 'name' } }],
      from: { kind: 'type', type: 'user' },
    };
    expect(fx.engine.validateQuery(def).hasErrors).toBe(false);
  });

  it('an aliased source binds under `as` and round-trips through toJSON', () => {
    const fx = fixture();
    const def: SelectDef = {
      kind: 'select',
      fields: [{ expr: { kind: 'field-ref', source: 'u', field: 'name' } }],
      from: { kind: 'aliased', type: 'user', as: 'u' },
    };
    // Referencing the source by its alias `u` validates clean.
    expect(fx.engine.validateQuery(def).hasErrors).toBe(false);
    // …and the parsed query serializes the source back to the aliased form.
    const round = fx.engine.parseQuery(def).toJSON();
    expect(round.kind).toBe('select');
    const from: SourceDef | undefined = round.kind === 'select' ? round.from : undefined;
    expect(from).toEqual({ kind: 'aliased', type: 'user', as: 'u' });
  });
});

describe('source aliasing — collision detection', () => {
  it('reports source.duplicate when a join `as` collides with the FROM name', () => {
    const fx = fixture();
    const def: SelectDef = {
      kind: 'select',
      fields: [{ expr: { kind: 'field-ref', source: 'user', field: 'name' } }],
      from: { kind: 'type', type: 'user' },
      // The join binds its target under `as: 'user'` — colliding with the FROM
      // source also named `user`.
      joins: [{ on: { source: 'user', field: 'orders' }, as: 'user', joinType: 'inner' }],
    };
    const problems = fx.engine.validateQuery(def);
    expect(problems.list.some((p) => p.code === 'source.duplicate')).toBe(true);
  });

  it('the aliased escape hatch resolves a same-type collision cleanly', () => {
    const fx = fixture();
    // Two instances of `order` would collide as plain type sources; aliasing
    // the join target disambiguates.
    const def: SelectDef = {
      kind: 'select',
      fields: [{ expr: { kind: 'field-ref', source: 'order', field: 'total' } }],
      from: { kind: 'type', type: 'order' },
      joins: [{ on: { source: 'order', field: 'userId' }, as: 'buyer', joinType: 'inner' }],
    };
    const problems = fx.engine.validateQuery(def);
    expect(problems.list.some((p) => p.code === 'source.duplicate')).toBe(false);
  });
});
