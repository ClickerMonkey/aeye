import { describe, test, expect } from 'vitest';
import { createRegistry, Engine } from '../index';

describe('PathCall.generic — explicit generic bindings', () => {
  test('bind specializes a call-return type at the call site', async () => {
    // Declare: identity<T>({x: T}): T — with T as a Generic placeholder.
    // Invoke with generic: {T: num} and verify the inferred return type.
    const r = createRegistry();
    const e = new Engine(r);

    // Build identity as a standalone fn typed against T.
    const identity = r.fn({ args: r.obj({ x: { type: r.alias('T') } }), returns: r.alias('T') });

    // Run typeOf on a call with explicit generic binding; the returns
    // type should be specialized to num.
    const expr = {
      kind: 'get',
      path: [
        { prop: 'f' },
        { args: { x: { kind: 'new', type: { name: 'num' }, value: 42 } }, generic: { T: { name: 'num' } } },
      ],
    } as const;

    const scope = new Map([['f', identity]]);
    const returnT = e.typeOf(expr, scope);
    expect(returnT.name).toBe('num');
  });
});
