import { describe, test, expect } from 'vitest';
import { createRegistry, Engine, ListType } from '../index';
import type { DefineExprDef } from '../index';

/**
 * `DefineExpr` lets callers omit `type` per-var; the type is inferred
 * from the value's static type (`new` carries its type, `get` walks
 * the path to a target type, `if`/`block` infers from the branches,
 * etc.). These tests pin that behavior down end-to-end:
 *
 *  - Inference: `typeOf` of a typeless var matches the value's typeOf.
 *  - Chaining: `vars[i].value` may reference any earlier var by name —
 *    runtime, typeOf, AND validateWalk all see the updated scope.
 *  - Round-trip: omitting `type` survives `toJSON()` (no spurious
 *    `type: undefined` in the serialized form).
 *  - Mismatch is an error severity, not a warning, when an explicit
 *    type contradicts the value's inferred type.
 */

const e = new Engine(createRegistry());
const r = e.registry;

const numLit = (n: number) => ({ kind: 'new', type: { name: 'num' }, value: n }) as const;
const txtLit = (s: string) => ({ kind: 'new', type: { name: 'text' }, value: s }) as const;

describe('Define — type is optional and inferred from the value', () => {
  test('runtime: typeless var binds the value just fine', async () => {
    const v = await e.run({
      kind: 'define',
      vars: [{ name: 'x', value: numLit(42) }],
      body: { kind: 'get', path: [{ prop: 'x' }] },
    });
    expect(v.raw).toBe(42);
  });

  test('typeOf: omitted type is inferred from the value', () => {
    const t = e.typeOf({
      kind: 'define',
      vars: [{ name: 'x', value: numLit(7) }],
      body: { kind: 'get', path: [{ prop: 'x' }] },
    });
    expect(t.name).toBe('num');
  });

  test('typeOf: list value yields a list type with the right element', () => {
    const t = e.typeOf({
      kind: 'define',
      vars: [{
        name: 'xs',
        value: {
          kind: 'new',
          type: { name: 'list', generic: { V: { name: 'num' } } },
          value: [numLit(1), numLit(2)],
        },
      }],
      body: { kind: 'get', path: [{ prop: 'xs' }] },
    });
    expect(t.name).toBe('list');
    expect(t).toBeInstanceOf(ListType);
    expect((t as ListType).item.name).toBe('num');
  });

  test('validate: typeless var produces no problems on a clean program', () => {
    const probs = e.validate({
      kind: 'define',
      vars: [{ name: 'x', value: numLit(1) }],
      body: { kind: 'get', path: [{ prop: 'x' }] },
    });
    expect(probs.list).toHaveLength(0);
  });
});

describe('Define — chaining: each var sees previous vars', () => {
  test('runtime: var2 reads var1 by name', async () => {
    const v = await e.run({
      kind: 'define',
      vars: [
        { name: 'x', value: numLit(10) },
        { name: 'y', value: { kind: 'get', path: [{ prop: 'x' }] } },
      ],
      body: { kind: 'get', path: [{ prop: 'y' }] },
    });
    expect(v.raw).toBe(10);
  });

  test('runtime: var3 can chain through var2 → var1', async () => {
    const v = await e.run({
      kind: 'define',
      vars: [
        { name: 'a', value: numLit(2) },
        {
          name: 'b',
          value: {
            kind: 'get',
            path: [
              { prop: 'a' }, { prop: 'add' },
              { args: { other: numLit(3) } },
            ],
          },
        },
        {
          name: 'c',
          value: {
            kind: 'get',
            path: [
              { prop: 'b' }, { prop: 'mul' },
              { args: { other: numLit(2) } },
            ],
          },
        },
      ],
      body: { kind: 'get', path: [{ prop: 'c' }] },
    });
    expect(v.raw).toBe(10); // (2 + 3) * 2
  });

  test('typeOf: later var inherits the type of the earlier it references', () => {
    const t = e.typeOf({
      kind: 'define',
      vars: [
        { name: 'x', value: numLit(1) },
        { name: 'y', value: { kind: 'get', path: [{ prop: 'x' }] } },
      ],
      body: { kind: 'get', path: [{ prop: 'y' }] },
    });
    expect(t.name).toBe('num');
  });

  test('validate: walking var2.value uses the updated scope so var1 is known', () => {
    const probs = e.validate({
      kind: 'define',
      vars: [
        { name: 'x', value: numLit(1) },
        // If validateWalk used the parent scope, this `get` would
        // produce a `var.unknown` problem for `x`. It mustn't.
        { name: 'y', value: { kind: 'get', path: [{ prop: 'x' }] } },
      ],
      body: { kind: 'get', path: [{ prop: 'y' }] },
    });
    expect(probs.list.some((p) => p.code === 'var.unknown')).toBe(false);
    expect(probs.list).toHaveLength(0);
  });

  test('validate: var3 referencing var1 through var2 path still resolves', () => {
    const probs = e.validate({
      kind: 'define',
      vars: [
        { name: 'a', value: numLit(2) },
        { name: 'b', value: { kind: 'get', path: [{ prop: 'a' }] } },
        { name: 'c', value: { kind: 'get', path: [{ prop: 'b' }] } },
      ],
      body: { kind: 'get', path: [{ prop: 'c' }] },
    });
    expect(probs.list).toHaveLength(0);
  });
});

describe('Define — explicit type still works alongside inference', () => {
  test('explicit type matching value → ok', () => {
    const probs = e.validate({
      kind: 'define',
      vars: [{ name: 'x', type: { name: 'num' }, value: numLit(1) }],
      body: { kind: 'get', path: [{ prop: 'x' }] },
    });
    expect(probs.list).toHaveLength(0);
  });

  test('explicit type mismatching value → error severity', () => {
    const probs = e.validate({
      kind: 'define',
      vars: [{ name: 'x', type: { name: 'num' }, value: txtLit('nope') }],
      body: { kind: 'get', path: [{ prop: 'x' }] },
    });
    const mm = probs.list.find((p) => p.code === 'define.var.type-mismatch');
    expect(mm).toBeDefined();
    expect(mm!.severity).toBe('error');
    expect(mm!.path).toEqual(['vars', 0, 'value']);
  });

  test('chained vars: explicit type on var2 mismatching var1.type → error', () => {
    const probs = e.validate({
      kind: 'define',
      vars: [
        { name: 'x', value: numLit(5) },
        // var2 declares text but the value reads var1 (num). Should
        // be a type-mismatch error, not a silently-passing program.
        { name: 'y', type: { name: 'text' }, value: { kind: 'get', path: [{ prop: 'x' }] } },
      ],
      body: { kind: 'get', path: [{ prop: 'y' }] },
    });
    expect(probs.list.some((p) => p.code === 'define.var.type-mismatch' && p.severity === 'error')).toBe(true);
  });
});

describe('Define — JSON round-trip preserves omitted type', () => {
  test('toJSON does not emit a type field when none was set', () => {
    const def: DefineExprDef = {
      kind: 'define',
      vars: [{ name: 'x', value: numLit(1) }],
      body: { kind: 'get', path: [{ prop: 'x' }] },
    };
    const expr = r.parseExpr(def);
    const back = expr.toJSON() as DefineExprDef;
    expect(back.vars[0]).toEqual({ name: 'x', value: numLit(1) });
    expect('type' in back.vars[0]!).toBe(false);
  });

  test('toJSON preserves a type field when it was set', () => {
    const def: DefineExprDef = {
      kind: 'define',
      vars: [{ name: 'x', type: { name: 'num' }, value: numLit(1) }],
      body: { kind: 'get', path: [{ prop: 'x' }] },
    };
    const expr = r.parseExpr(def);
    const back = expr.toJSON() as DefineExprDef;
    expect(back.vars[0]!.type).toEqual({ name: 'num' });
  });
});
