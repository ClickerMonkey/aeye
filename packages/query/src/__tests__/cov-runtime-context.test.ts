/**
 * Coverage: RuntimeContext (typeStates, correlation nesting, embed cache) and
 * the runtime RLS row-filter branches in applyRls.
 */
import { describe, it, expect } from 'vitest';
import { createRegistry } from '../registry';
import { QueryEngine } from '../engine';
import { arrayExecutor } from '../runtime/executor';
import { RuntimeContext } from '../runtime/context';
import { runtimeFixture, userTypeDef, orderTypeDef, ref } from './_utils';
import type { RlsProvider } from '../sql/rls';
import type { SelectDef, ExprDef } from '../schema';
import type { Embedder } from '../engine';

describe('RuntimeContext basics', () => {
  it('typeStates is empty until a type is touched, then yields loaded state', async () => {
    const fx = runtimeFixture();
    const ctx = new RuntimeContext(fx.engine);
    expect([...ctx.typeStates()]).toEqual([]);
    await ctx.typeState(fx.user);
    const states = [...ctx.typeStates()];
    expect(states.map((s) => s.type.name)).toEqual(['user']);
  });

  it('recordsFor returns undefined for an unknown source name', async () => {
    const fx = runtimeFixture();
    const ctx = new RuntimeContext(fx.engine);
    expect(await ctx.recordsFor('nope')).toBeUndefined();
  });

  it('withCorrelation nests (inner row merges over the outer)', async () => {
    const fx = runtimeFixture();
    const ctx = new RuntimeContext(fx.engine);
    const seen: unknown[] = [];
    await ctx.withCorrelation({ user: { id: 1 } }, async () => {
      await ctx.withCorrelation({ order: { id: 9 } }, async () => {
        seen.push({ ...ctx.correlation });
      });
      seen.push({ ...ctx.correlation });
    });
    expect(seen[0]).toEqual({ user: { id: 1 }, order: { id: 9 } }); // merged
    expect(seen[1]).toEqual({ user: { id: 1 } }); // restored
    expect(ctx.correlation).toBeNull();
  });

  it('embed caches the vector and short-circuits without an embedder', async () => {
    let calls = 0;
    const embedder: Embedder = {
      embed: async (t: string) => {
        calls++;
        return [t.length];
      },
    };
    const registry = createRegistry();
    const user = registry.parseType(userTypeDef);
    registry.registerType(user);
    registry.finalize();
    const engine = new QueryEngine(registry, { embedder });
    const ctx = new RuntimeContext(engine);
    expect(ctx.hasEmbedder()).toBe(true);
    expect(await ctx.embed('abc')).toEqual([3]);
    expect(await ctx.embed('abc')).toEqual([3]); // cached
    expect(calls).toBe(1);

    const noEmbed = new RuntimeContext(runtimeFixture().engine);
    expect(noEmbed.hasEmbedder()).toBe(false);
    expect(await noEmbed.embed('x')).toBeNull();
    expect(await noEmbed.embeddingOf('user', 1)).toBeNull();
  });
});

describe('runtime RLS provider row-filter', () => {
  it('applies a provider predicate (no backing) keeping only matching rows', async () => {
    const fx = runtimeFixture();
    const rls: RlsProvider = {
      predicateFor: (typeName, alias) =>
        typeName === 'user'
          ? ({ kind: 'comparison', op: '>=', left: ref(alias, 'age'), right: { kind: 'literal', value: 36 } } as ExprDef)
          : undefined,
    };
    const def: SelectDef = {
      kind: 'select',
      fields: [{ expr: ref('user', 'id'), as: 'id' }],
      from: { kind: 'type', type: 'user' },
      order: [{ expr: ref('user', 'id'), dir: 'asc' }],
    };
    const result = await fx.engine.run(def, { rls });
    expect(result.rows.map((r) => r['id'])).toEqual([1, 2]); // Cleo (29) filtered out
  });

  it('breaks self-referential RLS recursion (re-entrant load short-circuits)', async () => {
    // The provider predicate itself runs a subquery over the SAME type; the
    // re-entrant load hits the in-progress guard and returns rows unfiltered.
    const registry = createRegistry();
    const user = registry.parseType(userTypeDef);
    const order = registry.parseType(orderTypeDef);
    registry.registerType(user);
    registry.registerType(order);
    registry.finalize();
    const engine = new QueryEngine(registry, {
      executors: {
        user: arrayExecutor([
          { id: 1, name: 'Ada', age: 36, email: 'a@x.com', tags: null },
          { id: 2, name: 'Bob', age: 42, email: 'b@x.com', tags: null },
        ]),
      },
    });
    const rls: RlsProvider = {
      predicateFor: (typeName) =>
        typeName === 'user'
          ? ({
              kind: 'comparison',
              op: '>',
              left: {
                kind: 'subquery',
                query: { kind: 'select', fields: [{ expr: ref('user', 'id') }], from: { kind: 'type', type: 'user' }, limit: 1 },
              },
              right: { kind: 'literal', value: -1 },
            } as ExprDef)
          : undefined,
    };
    const def: SelectDef = {
      kind: 'select',
      fields: [{ expr: ref('user', 'id'), as: 'id' }],
      from: { kind: 'type', type: 'user' },
      order: [{ expr: ref('user', 'id'), dir: 'asc' }],
    };
    const result = await engine.run(def, { rls });
    expect(result.rows.map((r) => r['id'])).toEqual([1, 2]); // predicate always true
  });
});
