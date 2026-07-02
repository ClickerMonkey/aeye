/**
 * Coverage: selectTypes — embedder ranking, empty/sparse vectors, and the
 * substring-match degrade (with the all-Types fallback).
 */
import { describe, it, expect } from 'vitest';
import { createRegistry } from '../registry';
import { QueryEngine } from '../engine';
import { selectTypes } from '../llm/select-types';
import type { Embedder } from '../engine';
import type { TypeDef } from '../schema';

function engineWith(defs: TypeDef[], embedder?: Embedder) {
  const registry = createRegistry();
  for (const d of defs) registry.registerType(registry.parseType(d));
  registry.finalize();
  return new QueryEngine(registry, embedder ? { embedder } : {});
}

const userDef: TypeDef = { name: 'user', description: 'people accounts', fields: [{ name: 'id', type: { kind: 'number', whole: true } }], count: 1, bytes: 1 };
const orderDef: TypeDef = { name: 'order', description: 'purchases', fields: [{ name: 'id', type: { kind: 'number', whole: true } }], count: 1, bytes: 1 };

describe('selectTypes', () => {
  it('returns [] for an empty registry', async () => {
    const engine = new QueryEngine(createRegistry());
    expect(await selectTypes(engine, 'anything')).toEqual([]);
  });

  it('ranks by cosine when an embedder is present', async () => {
    const vecs: Record<string, number[]> = {
      'find users': [1, 0],
      'user people accounts': [1, 0],
      'order purchases': [0, 1],
    };
    const embedder: Embedder = { embed: async (t) => vecs[t] ?? [0, 0] };
    const engine = engineWith([userDef, orderDef], embedder);
    const ranked = await selectTypes(engine, 'find users', { topN: 1 });
    expect(ranked.map((t) => t.name)).toEqual(['user']);
  });

  it('handles empty + sparse vectors without throwing', async () => {
    const sparse: number[] = [0.1, 0.2, 0.3];
    delete sparse[1]; // hole → a[i]/b[i] undefined path
    const embedEmpty: Embedder = { embed: async () => [] }; // n === 0 → score 0
    expect((await selectTypes(engineWith([userDef, orderDef], embedEmpty), 'x')).length).toBe(2);
    const embedSparse: Embedder = { embed: async () => sparse };
    expect((await selectTypes(engineWith([userDef, orderDef], embedSparse), 'x')).length).toBe(2);
  });

  it('degrades to substring match (and to all Types when nothing matches)', async () => {
    const engine = engineWith([userDef, orderDef]); // no embedder
    const matched = await selectTypes(engine, 'purchases');
    expect(matched.map((t) => t.name)).toEqual(['order']);
    const noMatch = await selectTypes(engine, 'zzz-nonexistent', { topN: 5 });
    expect(noMatch.map((t) => t.name)).toEqual(['user', 'order']); // fallback = all
  });
});
