/**
 * Capability-gated Expr availability — `buildSchemas(...).Expr` OMITS any expr
 * kind the available Types / functions can't make use of, so the model is never
 * offered an unusable construct. The gate is INDEPENDENT of depth.
 *
 *  - `semantic`              ⇒ some Type is semantic-eligible;
 *  - `text-search`           ⇒ some Type is searchable;
 *  - `array-op`              ⇒ some Type has an `array` field;
 *  - relation `join` `on`    ⇒ some Type has a relation field;
 *  - `tabular-function-call` ⇒ ≥1 selected `tabular` function;
 *  - `filters`               ⇒ some Type has filterable fields (≈always).
 */
import { describe, it, expect } from 'vitest';
import { buildSchemas } from '../llm/schemas';
import { createRegistry } from '../registry';
import { QueryEngine } from '../engine';
import type { TypeDef, ExprDef, SelectDef, FunctionDef } from '../schema';
import { fixture } from './_utils';

/** A deliberately "flat" Type: no relations, no array, no searchable/semantic
 *  text, so every gated kind that depends on a Type capability is omitted. */
const plainTypeDef: TypeDef = {
  name: 'widget',
  fields: [
    { name: 'id', type: { kind: 'number', whole: true } },
    { name: 'label', type: { kind: 'text' } }, // plain text — NOT search/semantic
  ],
  count: 100,
  bytes: 32,
};

/** An engine over a single capability-free Type. */
function plainEngine(): QueryEngine {
  const registry = createRegistry();
  const widget = registry.parseType(plainTypeDef);
  registry.registerType(widget);
  registry.finalize();
  return new QueryEngine(registry);
}

/** A FROM-`widget` select wrapping one expr (so we can probe `Expr` via Select). */
function widgetSelect(expr: ExprDef): SelectDef {
  return { kind: 'select', fields: [{ expr }], from: { kind: 'type', type: 'widget' } };
}

describe('capability gating — a capability-free Type set', () => {
  it('omits semantic / text-search / array-op / relation join; filters + core stay', () => {
    const { Expr, Join } = buildSchemas(plainEngine());

    // Gated OUT — no branch matches these kinds.
    expect(Expr.safeParse({ kind: 'semantic', source: 'widget', query: 'hi' }).success).toBe(false);
    expect(Expr.safeParse({ kind: 'text-search', source: 'widget', query: 'hi' }).success).toBe(false);
    expect(
      Expr.safeParse({
        kind: 'array-op',
        op: 'isEmpty',
        target: { kind: 'field-ref', source: 'widget', field: 'id' },
      }).success,
    ).toBe(false);
    // `relation-path` is gone; a `relation` join `on` is unavailable when no
    // Type has a relation field (the JoinOn union omits the relation branch).
    expect(Join.safeParse({ on: { kind: 'relation', source: 'widget', field: 'x', as: 'x' } }).success).toBe(false);

    // Still available — core field-ref + the (always-applicable) filters.
    expect(Expr.safeParse({ kind: 'field-ref', source: 'widget', field: 'id' }).success).toBe(true);
    expect(Expr.safeParse({ kind: 'filters', source: 'widget' }).success).toBe(true);
  });

  it('gates the `joins` array out of Select when no Type has relations', () => {
    const { Select } = buildSchemas(plainEngine());
    // An absent / empty joins list is fine…
    expect(Select.safeParse(widgetSelect({ kind: 'field-ref', source: 'widget', field: 'id' })).success).toBe(true);
    // …but any join hop is rejected (joins is gated to an empty/absent list).
    const withJoin: SelectDef = {
      ...widgetSelect({ kind: 'field-ref', source: 'widget', field: 'id' }),
      joins: [{ on: { source: 'widget', field: 'nope' } }],
    };
    expect(Select.safeParse(withJoin).success).toBe(false);
  });

  it('omits tabular-function-call when no tabular function is selected', () => {
    const { Expr } = buildSchemas(plainEngine());
    expect(Expr.safeParse({ kind: 'tabular-function-call', function: 'gen', args: {} }).success).toBe(false);
  });
});

describe('capability gating — a fully-capable Type set', () => {
  /** A tabular function so `tabular-function-call` is applicable. */
  const genRows: FunctionDef = {
    name: 'genRows',
    shape: 'tabular',
    params: [],
    output: { type: 'order' },
  };

  it('keeps every gated kind present', () => {
    const fx = fixture(); // `user` (email=search, tags=array, orders relation) + `order`
    fx.registry.registerFunction(genRows);
    const { Expr, Select, Join } = buildSchemas(fx.engine);

    // `user` is searchable + semantic (email), has an array field (tags) and a
    // relation (orders); the registry has scalar/aggregate/window + our tabular.
    expect(Expr.safeParse({ kind: 'semantic', source: 'user', field: 'email', query: 'ada' }).success).toBe(true);
    expect(Expr.safeParse({ kind: 'text-search', source: 'user', field: 'email', query: 'ada' }).success).toBe(true);
    expect(
      Expr.safeParse({
        kind: 'array-op',
        op: 'isEmpty',
        target: { kind: 'field-ref', source: 'user', field: 'tags' },
      }).success,
    ).toBe(true);
    // `relation-path` is gone; the relation crossing is now a `relation` join
    // `on`, gated IN because `user` has the `orders` relation.
    expect(Join.safeParse({ on: { kind: 'relation', source: 'user', field: 'orders', as: 'o' } }).success).toBe(true);
    expect(Expr.safeParse({ kind: 'tabular-function-call', function: 'genRows', args: {} }).success).toBe(true);

    // …and a join is expressible.
    const joined: SelectDef = {
      kind: 'select',
      fields: [{ expr: { kind: 'field-ref', source: 'user', field: 'name' } }],
      from: { kind: 'type', type: 'user' },
      joins: [{ on: { kind: 'relation', source: 'user', field: 'orders', as: 'o' } }],
    };
    expect(Select.safeParse(joined).success).toBe(true);
  });
});
