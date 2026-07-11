/**
 * selectTypes — semantic Type pre-selection. A deterministic stub embedder
 * ranks the relevant Type first; without an embedder it degrades to substring
 * matching.
 */
import { describe, it, expect } from 'vitest';
import { selectTypes } from '../llm/select-types';
import type { Embedder } from '../engine';
import { fixture } from './_utils';

/**
 * A 2-D stub embedder: dimension 0 fires on "user", dimension 1 on "order".
 * The fixture's Type texts are just their names (`user` / `order`), so a
 * request mentioning orders embeds near the `order` Type.
 */
const stubEmbedder: Embedder = {
  embed: async (text: string) => {
    const t = text.toLowerCase();
    return [t.includes('user') ? 1 : 0, t.includes('order') ? 1 : 0];
  },
};

describe('selectTypes', () => {
  it('ranks the semantically relevant Type first (stub embedder)', async () => {
    const fx = fixture();
    const ranked = await selectTypes(fx.engine, 'show me recent orders', {
      embedder: stubEmbedder,
      topN: 1,
    });
    expect(ranked.map((t) => t.name)).toEqual(['order']);
  });

  it('ranks user first when the request is about users', async () => {
    const fx = fixture();
    const ranked = await selectTypes(fx.engine, 'list every user account', {
      embedder: stubEmbedder,
      topN: 1,
    });
    expect(ranked.map((t) => t.name)).toEqual(['user']);
  });

  it('degrades to substring matching when there is no embedder', async () => {
    const fx = fixture();
    const ranked = await selectTypes(fx.engine, 'order');
    expect(ranked.map((t) => t.name)).toContain('order');
  });

  it('returns all Types (capped) when nothing matches and no embedder', async () => {
    const fx = fixture();
    const ranked = await selectTypes(fx.engine, 'zzz-nomatch', { topN: 10 });
    expect(ranked.length).toBe(fx.registry.typeList().length);
  });
});
