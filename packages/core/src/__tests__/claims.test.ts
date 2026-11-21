/**
 * Parallel claims: the pure conflict rule (claims.ts) and how a Tool
 * resolves its declared claims (Tool.claims / Tool.hasParallelClaims).
 */

import { z } from 'zod';
import { ALL_CLAIMS, claimsConflict, claimWaits, NO_CLAIMS } from '../claims';
import { Tool } from '../tool';
import { Context } from '../types';

describe('claimsConflict', () => {
  it('conflicts when the claims share a string', () => {
    expect(claimsConflict(['file:a', 'file:b'], ['file:b'])).toBe(true);
  });

  it('does not conflict when the claims share nothing', () => {
    expect(claimsConflict(['file:a'], ['file:b'])).toBe(false);
  });

  it('compares by exact string equality', () => {
    expect(claimsConflict(['file:a'], ['file:A'])).toBe(false);
    expect(claimsConflict(['file:a'], ['file:a/'])).toBe(false);
  });

  it('never conflicts when neither side claims anything', () => {
    expect(claimsConflict(NO_CLAIMS, NO_CLAIMS)).toBe(false);
    expect(claimsConflict(NO_CLAIMS, ['file:a'])).toBe(false);
  });

  it('conflicts with everything, claims or not, when either side claims *', () => {
    expect(ALL_CLAIMS).toBe('*');
    expect(claimsConflict([ALL_CLAIMS], NO_CLAIMS)).toBe(true);
    expect(claimsConflict(NO_CLAIMS, [ALL_CLAIMS])).toBe(true);
    expect(claimsConflict(['file:a', ALL_CLAIMS], ['file:b'])).toBe(true);
    expect(claimsConflict([ALL_CLAIMS], [ALL_CLAIMS])).toBe(true);
  });
});

describe('claimWaits', () => {
  it('lists, for each call, the earlier calls it conflicts with', () => {
    expect(claimWaits([['file:a'], ['file:b'], ['file:a'], NO_CLAIMS, [ALL_CLAIMS], ['file:b']])).toEqual([
      [],
      [],
      [0],
      [],
      [0, 1, 2, 3],
      [1, 4],
    ]);
  });

  it('only ever waits on earlier calls', () => {
    const waits = claimWaits([['x'], ['x'], ['x']]);
    waits.forEach((list, index) => list.forEach((earlier) => expect(earlier).toBeLessThan(index)));
    expect(waits).toEqual([[], [0], [0, 1]]);
  });

  it('handles an empty batch', () => {
    expect(claimWaits([])).toEqual([]);
  });
});

describe('Tool.claims', () => {
  type Ctx = Context<{ workspace: string }, {}>;
  const schema = z.object({ path: z.string() });
  const ctx: Ctx = { workspace: 'ws', toolCallId: 'call_1' };

  it('claims nothing when the tool declares no claims', async () => {
    const tool = new Tool({ name: 'plain', description: 'Plain', schema, call: () => 'ok' });
    expect(tool.hasParallelClaims).toBe(false);
    expect(await tool.claims({ path: 'a' }, ctx)).toEqual([]);
  });

  it('returns a static list', async () => {
    const tool = new Tool({ name: 'db', description: 'Db', schema, parallelClaims: ['db:users'], call: () => 'ok' });
    expect(tool.hasParallelClaims).toBe(true);
    expect(await tool.claims({ path: 'a' }, ctx)).toEqual(['db:users']);
  });

  it('works the claims out from the input and context', async () => {
    const tool = new Tool<{ workspace: string }, {}, 'edit', { path: string }>({
      name: 'edit',
      description: 'Edit',
      schema,
      parallelClaims: (input, c) => [`${c.workspace}:${input.path}`, `call:${c.toolCallId}`],
      call: () => 'ok',
    });
    expect(await tool.claims({ path: 'src/a.ts' }, ctx)).toEqual(['ws:src/a.ts', 'call:call_1']);
  });

  it('awaits an async claims function, and undefined claims nothing', async () => {
    const tool = new Tool({
      name: 'maybe',
      description: 'Maybe',
      schema,
      parallelClaims: async (input: { path: string }) => input.path === 'none' ? undefined : [input.path],
      call: () => 'ok',
    });
    expect(await tool.claims({ path: 'x' }, ctx)).toEqual(['x']);
    expect(await tool.claims({ path: 'none' }, ctx)).toEqual([]);
  });

  it('passes a throw from the claims function on', async () => {
    const tool = new Tool({
      name: 'broken',
      description: 'Broken',
      schema,
      parallelClaims: () => { throw new Error('no claims for you'); },
      call: () => 'ok',
    });
    await expect(tool.claims({ path: 'x' }, ctx)).rejects.toThrow('no claims for you');
  });
});
