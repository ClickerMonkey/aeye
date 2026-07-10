/**
 * Phase C — type-named sources, the `aliased` escape hatch, DML collision
 * detection, and the field-ref alias→Type metadata fix.
 *
 * Covers the net-new capability and the bug fix this phase delivers:
 *  - a DML target colliding with a join hop reports `source.duplicate`;
 *  - an `{ kind:'aliased' }` SELF-JOIN binds two instances of one Type, round-
 *    trips through `toJSON`, and runs in-memory returning the correct paired
 *    rows (two instances of a single Type joined together);
 *  - a `field-ref` recovers its field's case-sensitivity metadata even when the
 *    source is an `aliased` source whose name differs from the Type name.
 */
import { describe, it, expect } from 'vitest';
import { createRegistry } from '../registry';
import { QueryEngine } from '../engine';
import { arrayExecutor } from '../runtime/executor';
import type { TypeDef, SelectDef, UpdateDef, SourceDef, JoinDef } from '../schema';
import type { SourceRecord } from '../runtime/row';
import { runtimeFixture, ref, lit, cmp } from './_utils';

// ─── 1. DML target ↔ join `source.duplicate` ────────────────────────────────

describe('phase C — DML target / join collision', () => {
  it('reports source.duplicate when a join hop rebinds the UPDATE target type', () => {
    const fx = runtimeFixture();
    // Chaining user.orders (binds `order`) then order.userId hops user → order
    // → user; the second hop is aliased back to `user`, colliding with the
    // UPDATE target `user`.
    const def: UpdateDef = {
      kind: 'update',
      type: 'user',
      set: { name: lit('x') },
      joins: [
        { on: { kind: 'relation', source: 'user', field: 'orders', as: 'order' } },
        { on: { kind: 'relation', source: 'order', field: 'userId', as: 'user' } },
      ],
    };
    const problems = fx.engine.validateQuery(def);
    expect(problems.list.some((p) => p.code === 'source.duplicate')).toBe(true);
  });

  it('the aliased join `as` resolves the same collision cleanly', () => {
    const fx = runtimeFixture();
    const def: UpdateDef = {
      kind: 'update',
      type: 'user',
      set: { name: lit('x') },
      // Aliasing the second hop to `buyer` breaks the collision with `user`.
      joins: [
        { on: { kind: 'relation', source: 'user', field: 'orders', as: 'order' } },
        { on: { kind: 'relation', source: 'order', field: 'userId', as: 'buyer' } },
      ],
    };
    const problems = fx.engine.validateQuery(def);
    expect(problems.list.some((p) => p.code === 'source.duplicate')).toBe(false);
  });
});

// ─── 2. Aliased SELF-JOIN SELECT (two instances of one Type) ────────────────

describe('phase C — aliased self-join SELECT (net-new capability)', () => {
  /** `user u1` ⋈ (u1.orders.userId AS u2) — two instances of `user` joined. */
  const selfJoin = (): SelectDef => ({
    kind: 'select',
    fields: [
      { expr: ref('u1', 'name'), as: 'a' },
      { expr: ref('u2', 'name'), as: 'b' },
    ],
    from: { kind: 'aliased', type: 'user', as: 'u1' },
    joins: [
      { on: { kind: 'relation', source: 'u1', field: 'orders', as: 'order' }, joinType: 'inner' },
      { on: { kind: 'relation', source: 'order', field: 'userId', as: 'u2' }, joinType: 'inner' },
    ],
  });

  it('validates clean — two instances of one Type bound under distinct aliases', () => {
    const fx = runtimeFixture();
    expect(fx.engine.validateQuery(selfJoin()).hasErrors).toBe(false);
  });

  it('round-trips the aliased FROM + join `as` through toJSON', () => {
    const fx = runtimeFixture();
    const round = fx.engine.parseQuery(selfJoin()).toJSON();
    expect(round.kind).toBe('select');
    const from: SourceDef | undefined = round.kind === 'select' ? round.from : undefined;
    expect(from).toEqual({ kind: 'aliased', type: 'user', as: 'u1' });
    const joins: JoinDef[] | undefined = round.kind === 'select' ? round.joins : undefined;
    expect(joins).toEqual([
      { on: { kind: 'relation', source: 'u1', field: 'orders', as: 'order' }, joinType: 'inner' },
      { on: { kind: 'relation', source: 'order', field: 'userId', as: 'u2' }, joinType: 'inner' },
    ]);
  });

  it('runs in-memory returning the correct paired rows', async () => {
    const fx = runtimeFixture();
    const result = await fx.engine.run(selfJoin());
    // Each order's userId points back to its own user, so u2 === u1 always.
    // Ada (2 orders) and Bob (2 orders) each yield two self-paired rows; Cleo
    // has no orders and is dropped by the inner join.
    expect(result.rows).toEqual([
      { a: 'Ada', b: 'Ada' },
      { a: 'Ada', b: 'Ada' },
      { a: 'Bob', b: 'Bob' },
      { a: 'Bob', b: 'Bob' },
    ]);
  });
});

// ─── 3. field-ref alias→Type metadata (case-sensitivity under an alias) ─────

describe('phase C — field-ref metadata under an aliased source', () => {
  const widgetDef: TypeDef = {
    name: 'widget',
    fields: [
      { name: 'id', type: { kind: 'number', whole: true } },
      // `sensitive: true` ⇒ text comparison is CASE-SENSITIVE.
      { name: 'code', type: { kind: 'text', sensitive: true } },
    ],
    count: 10,
    bytes: 32,
  };
  const widgetRows: SourceRecord[] = [
    { id: 1, code: 'ABC' },
    { id: 2, code: 'abc' },
  ];

  function widgetEngine(): QueryEngine {
    const registry = createRegistry();
    registry.registerType(registry.parseType(widgetDef));
    registry.finalize();
    return new QueryEngine(registry, { executors: { widget: arrayExecutor(widgetRows) } });
  }

  it('a sensitive field compares CASE-SENSITIVELY through an aliased source', async () => {
    const engine = widgetEngine();
    // The source is named `w`, NOT `widget`; only the alias→Type map threaded
    // through `evaluate` recovers the `sensitive` metadata. Without the fix,
    // `code = 'ABC'` would fall back to case-insensitive and wrongly match
    // `'abc'` (id 2) as well.
    const def: SelectDef = {
      kind: 'select',
      fields: [{ expr: ref('w', 'id'), as: 'id' }],
      from: { kind: 'aliased', type: 'widget', as: 'w' },
      where: [cmp('=', ref('w', 'code'), lit('ABC'))],
    };
    const result = await engine.run(def);
    expect(result.rows).toEqual([{ id: 1 }]);
  });
});
