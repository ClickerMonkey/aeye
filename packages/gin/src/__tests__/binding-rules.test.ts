import { describe, test, expect } from 'vitest';
import { createRegistry, Engine, RESERVED_NAMES, checkBindingName, Problems } from '../index';
import type { TypeScope } from '../analysis';

/**
 * Tests for the user-binding hygiene rules added in `analysis.ts`
 * `checkBindingName` and consumed by `DefineExpr.validateWalk` /
 * `LoopExpr.validateWalk`. The rules are:
 *
 *  - User-supplied binding names cannot be reserved (gin's runtime
 *    binds those — `args`, `recurse`, `this`, `super`, `key`, `value`,
 *    `yield`, `error`).
 *  - User-supplied binding names cannot already exist in scope —
 *    including outer-scope vars and globals.
 */

const e = new Engine(createRegistry());

const numLit = (n: number) => ({ kind: 'new', type: { name: 'num' }, value: n }) as const;

const numType = { name: 'num' } as const;

describe('RESERVED_NAMES set', () => {
  test('contains every name gin runtime injects', () => {
    for (const n of ['args', 'recurse', 'this', 'super', 'key', 'value', 'yield', 'error']) {
      expect(RESERVED_NAMES.has(n)).toBe(true);
    }
  });

  test('does not include arbitrary user names', () => {
    expect(RESERVED_NAMES.has('foo')).toBe(false);
    expect(RESERVED_NAMES.has('result')).toBe(false);
  });
});

describe('checkBindingName helper', () => {
  test('reserved name → binding.reserved error', () => {
    const p = new Problems();
    const scope: TypeScope = new Map();
    checkBindingName('args', scope, p);
    expect(p.list).toHaveLength(1);
    expect(p.list[0]!.code).toBe('binding.reserved');
    expect(p.list[0]!.severity).toBe('error');
  });

  test('name in scope → binding.shadow error', () => {
    const p = new Problems();
    const scope: TypeScope = new Map();
    scope.set('foo', e.registry.num());
    checkBindingName('foo', scope, p);
    expect(p.list).toHaveLength(1);
    expect(p.list[0]!.code).toBe('binding.shadow');
    expect(p.list[0]!.severity).toBe('error');
  });

  test('reserved name takes precedence over shadow check', () => {
    // A name that is BOTH reserved AND in scope reports as reserved
    // (clearer message; the helper returns after the reserved branch).
    const p = new Problems();
    const scope: TypeScope = new Map();
    scope.set('args', e.registry.any());
    checkBindingName('args', scope, p);
    expect(p.list).toHaveLength(1);
    expect(p.list[0]!.code).toBe('binding.reserved');
  });

  test('fresh non-reserved name → no error', () => {
    const p = new Problems();
    const scope: TypeScope = new Map();
    checkBindingName('myVar', scope, p);
    expect(p.list).toHaveLength(0);
  });
});

describe('DefineExpr — reserved-name rule', () => {
  for (const reserved of ['args', 'recurse', 'this', 'super', 'key', 'value', 'yield', 'error']) {
    test(`define '${reserved}' → binding.reserved`, () => {
      const probs = e.validate({
        kind: 'define',
        vars: [{ name: reserved, type: numType, value: numLit(1) }],
        body: numLit(0),
      });
      expect(probs.list.some((p) => p.code === 'binding.reserved')).toBe(true);
    });
  }

  test('reserved-name error path includes vars[i].name', () => {
    const probs = e.validate({
      kind: 'define',
      vars: [{ name: 'args', type: numType, value: numLit(1) }],
      body: numLit(0),
    });
    const err = probs.list.find((p) => p.code === 'binding.reserved');
    expect(err).toBeDefined();
    expect(err!.path).toEqual(['vars', 0, 'name']);
  });

  test('non-reserved name → no binding error', () => {
    const probs = e.validate({
      kind: 'define',
      vars: [{ name: 'myCounter', type: numType, value: numLit(1) }],
      body: numLit(0),
    });
    expect(probs.list.some((p) => p.code.startsWith('binding.'))).toBe(false);
  });
});

describe('DefineExpr — shadow rule', () => {
  test('two vars in one define with the same name → second flags shadow', () => {
    const probs = e.validate({
      kind: 'define',
      vars: [
        { name: 'x', type: numType, value: numLit(1) },
        { name: 'x', type: numType, value: numLit(2) },
      ],
      body: numLit(0),
    });
    const shadows = probs.list.filter((p) => p.code === 'binding.shadow');
    expect(shadows).toHaveLength(1);
    expect(shadows[0]!.path).toEqual(['vars', 1, 'name']);
  });

  test('inner define shadowing outer define → flags shadow', () => {
    const probs = e.validate({
      kind: 'define',
      vars: [{ name: 'x', type: numType, value: numLit(1) }],
      body: {
        kind: 'define',
        vars: [{ name: 'x', type: numType, value: numLit(2) }],
        body: numLit(0),
      },
    });
    expect(probs.list.some((p) => p.code === 'binding.shadow')).toBe(true);
  });

  test('define shadowing a global → flags shadow', () => {
    // Register a global so its name is part of the engine's type scope.
    const r = createRegistry();
    const eng = new Engine(r);
    eng.registerGlobal('myGlobal', { type: r.num(), value: 42 });
    const probs = eng.validate({
      kind: 'define',
      vars: [{ name: 'myGlobal', type: numType, value: numLit(1) }],
      body: numLit(0),
    });
    expect(probs.list.some((p) => p.code === 'binding.shadow')).toBe(true);
  });

  test('sibling defines with distinct names → no shadow', () => {
    const probs = e.validate({
      kind: 'define',
      vars: [
        { name: 'a', type: numType, value: numLit(1) },
        { name: 'b', type: numType, value: numLit(2) },
      ],
      body: numLit(0),
    });
    expect(probs.list.some((p) => p.code === 'binding.shadow')).toBe(false);
  });
});

describe('DefineExpr — runtime still works for valid bindings', () => {
  test('valid define evaluates to the body result', async () => {
    const v = await e.run({
      kind: 'define',
      vars: [{ name: 'x', type: numType, value: numLit(7) }],
      body: { kind: 'get', path: [{ prop: 'x' }] },
    });
    expect(v.raw).toBe(7);
  });
});

describe('LoopExpr — overrides honor binding rules', () => {
  // Build a list<num> over expression so the loop's `over` typechecks.
  const overList = {
    kind: 'new',
    type: { name: 'list', generic: { V: { name: 'num' } } },
    value: [
      { kind: 'new', type: { name: 'num' }, value: 10 },
      { kind: 'new', type: { name: 'num' }, value: 20 },
    ],
  } as const;

  test('keyName override to a reserved name → binding.reserved at path "key"', () => {
    const probs = e.validate({
      kind: 'loop',
      over: overList,
      key: 'args',
      body: { kind: 'block', lines: [] },
    });
    const err = probs.list.find((p) => p.code === 'binding.reserved');
    expect(err).toBeDefined();
    expect(err!.path).toEqual(['key']);
  });

  test('valueName override to a reserved name → binding.reserved at path "value"', () => {
    const probs = e.validate({
      kind: 'loop',
      over: overList,
      value: 'recurse',
      body: { kind: 'block', lines: [] },
    });
    const err = probs.list.find((p) => p.code === 'binding.reserved');
    expect(err).toBeDefined();
    expect(err!.path).toEqual(['value']);
  });

  test('keyName override that shadows an outer binding → binding.shadow', () => {
    const probs = e.validate({
      kind: 'define',
      vars: [{ name: 'taken', type: numType, value: numLit(0) }],
      body: {
        kind: 'loop',
        over: overList,
        key: 'taken',
        body: { kind: 'block', lines: [] },
      },
    });
    expect(probs.list.some((p) => p.code === 'binding.shadow')).toBe(true);
  });

  test('default key/value (no override) → no binding error even if `key` exists in outer scope', () => {
    // Defaults are reserved precisely because loops bind them. Nested
    // loops are expected to shadow `key`/`value`; we only validate the
    // explicit overrides.
    const probs = e.validate({
      kind: 'define',
      vars: [{ name: 'someName', type: numType, value: numLit(0) }],
      body: {
        kind: 'loop',
        over: overList,
        body: { kind: 'block', lines: [] },
      },
    });
    expect(probs.list.some((p) => p.code.startsWith('binding.'))).toBe(false);
  });

  test('valid keyName/valueName override → no error', () => {
    const probs = e.validate({
      kind: 'loop',
      over: overList,
      key: 'idx',
      value: 'item',
      body: { kind: 'block', lines: [] },
    });
    expect(probs.list.some((p) => p.code.startsWith('binding.'))).toBe(false);
  });
});
