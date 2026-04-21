import { describe, test, expect } from 'vitest';
import { createRegistry, Engine } from '../index';
import { val } from '../value';

describe('evalNative', () => {
  test('invokes a registered native impl by id', async () => {
    const r = createRegistry();
    r.setNative('test.hello', async (_scope) => val(r.text(), 'world'));
    const e = new Engine(r);
    const v = await e.run({ kind: 'native', id: 'test.hello', type: { name: 'text' } });
    expect(v.raw).toBe('world');
  });

  test('throws for unregistered id', async () => {
    const e = new Engine(createRegistry());
    await expect(e.run({ kind: 'native', id: 'does.not.exist' })).rejects.toThrow();
  });

  test('native return-type wrapping when impl returns raw', async () => {
    const r = createRegistry();
    r.setNative('test.raw42', async () => 42 as any);
    const e = new Engine(r);
    const v = await e.run({ kind: 'native', id: 'test.raw42', type: { name: 'num' } });
    expect(v.raw).toBe(42);
    expect(v.type.name).toBe('num');
  });

  test('user override beats default', async () => {
    const r = createRegistry();
    r.setNative('num.add', async () => val(r.num(), 999));
    const e = new Engine(r);
    const v = await e.run({
      kind: 'define',
      vars: [{ name: 'x', value: { kind: 'new', type: { name: 'num' }, value: 10 } }],
      body: {
        kind: 'get',
        path: [
          { prop: 'x' }, { prop: 'add' },
          { args: { other: { kind: 'new', type: { name: 'num' }, value: 5 } } },
        ],
      },
    });
    expect(v.raw).toBe(999);
  });
});
