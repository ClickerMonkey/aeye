import { describe, test, expect } from 'vitest';
import { createRegistry, Engine, Effects, combineEffects, formatEffects } from '../index';
import type { ExprDef } from '../index';

/**
 * Effects bitmask + per-Expr `effects()` + new no-effect warnings.
 *
 * Mirrors the behavior the gin-1 / gin-2 / gin-3 LLM cases would have
 * surfaced: loop bodies, if branches, switch cases that compute pure
 * values and discard them now produce structured warnings.
 */

function parse(reg: ReturnType<typeof createRegistry>, def: ExprDef) {
  return reg.parseExpr(def);
}

describe('Effects helpers', () => {
  test('combineEffects bitwise-or', () => {
    expect(combineEffects(Effects.STATE, Effects.EXTERNAL))
      .toBe(Effects.STATE | Effects.EXTERNAL);
    expect(combineEffects()).toBe(Effects.NONE);
  });

  test('formatEffects renders categories', () => {
    expect(formatEffects(Effects.NONE)).toBe('NONE');
    expect(formatEffects(Effects.STATE)).toBe('STATE');
    expect(formatEffects(Effects.STATE | Effects.EXTERNAL)).toBe('STATE|EXTERNAL');
  });
});

describe('Expr.effects() by kind', () => {
  const reg = createRegistry();

  test('NewExpr primitive → NONE', () => {
    expect(parse(reg, { kind: 'new', type: { name: 'num' }, value: 5 }).effects())
      .toBe(Effects.NONE);
  });

  test('GetExpr local read → NONE', () => {
    expect(parse(reg, { kind: 'get', path: [{ prop: 'x' }] }).effects())
      .toBe(Effects.NONE);
  });

  test('SetExpr → STATE', () => {
    const e = parse(reg, {
      kind: 'set',
      path: [{ prop: 'x' }],
      value: { kind: 'new', type: { name: 'num' }, value: 5 },
    });
    expect(e.effects() & Effects.STATE).toBe(Effects.STATE);
  });

  test('FlowExpr (break/return/throw/exit/continue) → STATE', () => {
    for (const action of ['break', 'continue', 'return', 'throw', 'exit'] as const) {
      const e = parse(reg, { kind: 'flow', action });
      expect(e.effects() & Effects.STATE).toBe(Effects.STATE);
    }
  });

  test('LambdaExpr constructing → NONE (even when body has STATE)', () => {
    const e = parse(reg, {
      kind: 'lambda',
      type: { name: 'fn', call: { args: { name: 'obj' }, returns: { name: 'void' } } },
      body: {
        kind: 'set',
        path: [{ prop: 'someVar' }],
        value: { kind: 'new', type: { name: 'num' }, value: 1 },
      },
    });
    expect(e.effects()).toBe(Effects.NONE);
  });

  test('BlockExpr ORs lines', () => {
    const e = parse(reg, {
      kind: 'block',
      lines: [
        { kind: 'new', type: { name: 'num' }, value: 1 },
        {
          kind: 'set', path: [{ prop: 'x' }],
          value: { kind: 'new', type: { name: 'num' }, value: 2 },
        },
      ],
    });
    expect(e.effects() & Effects.STATE).toBe(Effects.STATE);
  });

  test('IfExpr ORs branches + else', () => {
    const e = parse(reg, {
      kind: 'if',
      ifs: [{
        condition: { kind: 'new', type: { name: 'bool' }, value: true },
        body: {
          kind: 'set', path: [{ prop: 'x' }],
          value: { kind: 'new', type: { name: 'num' }, value: 0 },
        },
      }],
    });
    expect(e.effects() & Effects.STATE).toBe(Effects.STATE);
  });

  test('NewExpr list of pure literals → NONE', () => {
    const e = parse(reg, {
      kind: 'new',
      type: { name: 'list', generic: { V: { name: 'num' } } },
      value: [
        { kind: 'new', type: { name: 'num' }, value: 1 },
        { kind: 'new', type: { name: 'num' }, value: 2 },
      ],
    });
    expect(e.effects()).toBe(Effects.NONE);
  });
});

describe('Native effects registration', () => {
  test('setNative carries declared effects', () => {
    const reg = createRegistry();
    reg.setNative('test.pure', () => undefined, Effects.NONE);
    reg.setNative('test.touchy', () => undefined, Effects.SYSTEM | Effects.EXTERNAL);
    expect(reg.nativeEffects('test.pure')).toBe(Effects.NONE);
    expect(reg.nativeEffects('test.touchy')).toBe(Effects.SYSTEM | Effects.EXTERNAL);
  });

  test('Unregistered native id falls back to conservative max', () => {
    const reg = createRegistry();
    expect(reg.nativeEffects('not.registered'))
      .toBe(Effects.STATE | Effects.SYSTEM | Effects.EXTERNAL);
  });

  test('NativeExpr.effects() resolves at parse time', () => {
    const reg = createRegistry();
    reg.setNative('test.pure', () => undefined, Effects.NONE);
    const e = parse(reg, { kind: 'native', id: 'test.pure' });
    expect(e.effects()).toBe(Effects.NONE);
  });

  test('Pure built-in natives are NONE', () => {
    const e = new Engine(createRegistry());
    for (const id of [
      'num.add', 'num.mul', 'num.toText',
      'bool.eq', 'bool.and',
      'list.length', 'list.slice', 'list.map', 'list.filter',
      'map.size', 'map.has', 'map.keys',
      'tuple.length', 'tuple.at',
      'object.keys', 'object.has', 'object.eq',
      'text.length',
    ]) {
      expect(e.registry.nativeEffects(id)).toBe(Effects.NONE);
    }
  });

  test('Mutating built-in natives carry STATE', () => {
    const e = new Engine(createRegistry());
    for (const id of [
      'list.push', 'list.pop', 'list.shift', 'list.unshift',
      'list.insert', 'list.remove', 'list.clear', 'list.indexSet',
      'map.indexSet', 'map.delete', 'map.clear',
      'object.indexSet',
      'tuple.setAt',
    ]) {
      expect(e.registry.nativeEffects(id) & Effects.STATE).toBe(Effects.STATE);
    }
  });
});

describe('No-effect warnings', () => {
  test('loop.body.no-effect — body computes value and discards it', () => {
    const e = new Engine(createRegistry());
    const probs = e.validate({
      kind: 'loop',
      over: { kind: 'new', type: { name: 'list', generic: { V: { name: 'num' } } }, value: [] },
      body: {
        kind: 'get',
        path: [{ prop: 'value' }, { prop: 'neq' }, {
          args: { other: { kind: 'new', type: { name: 'num' }, value: 0 } },
        }],
      },
    });
    expect(probs.list.some((p) => p.code === 'loop.body.no-effect')).toBe(true);
  });

  test('loop.body.no-effect — silent when body has a set', () => {
    const e = new Engine(createRegistry());
    const probs = e.validate({
      kind: 'define',
      vars: [{ name: 'acc', value: { kind: 'new', type: { name: 'num' }, value: 0 } }],
      body: {
        kind: 'loop',
        over: { kind: 'new', type: { name: 'list', generic: { V: { name: 'num' } } }, value: [] },
        body: {
          kind: 'set', path: [{ prop: 'acc' }],
          value: { kind: 'new', type: { name: 'num' }, value: 1 },
        },
      },
    });
    expect(probs.list.some((p) => p.code === 'loop.body.no-effect')).toBe(false);
  });

  test('if.branch.no-effect — pure body warns', () => {
    const e = new Engine(createRegistry());
    const probs = e.validate({
      kind: 'if',
      ifs: [{
        condition: { kind: 'new', type: { name: 'bool' }, value: true },
        body: { kind: 'new', type: { name: 'num' }, value: 5 },
      }],
    });
    expect(probs.list.some((p) => p.code === 'if.branch.no-effect')).toBe(true);
  });

  test('if.else.no-effect — pure else warns', () => {
    const e = new Engine(createRegistry());
    const probs = e.validate({
      kind: 'if',
      ifs: [{
        condition: { kind: 'new', type: { name: 'bool' }, value: true },
        body: {
          kind: 'set', path: [{ prop: 'x' }],
          value: { kind: 'new', type: { name: 'num' }, value: 1 },
        },
      }],
      else: { kind: 'new', type: { name: 'bool' }, value: false },
    });
    expect(probs.list.some((p) => p.code === 'if.else.no-effect')).toBe(true);
  });

  test('switch.case.no-effect — pure case body warns', () => {
    const e = new Engine(createRegistry());
    const probs = e.validate({
      kind: 'switch',
      value: { kind: 'new', type: { name: 'num' }, value: 1 },
      cases: [{
        equals: [{ kind: 'new', type: { name: 'num' }, value: 1 }],
        body: { kind: 'new', type: { name: 'text' }, value: 'one' },
      }],
    });
    expect(probs.list.some((p) => p.code === 'switch.case.no-effect')).toBe(true);
  });

  test('switch.else.no-effect — pure default warns', () => {
    const e = new Engine(createRegistry());
    const probs = e.validate({
      kind: 'switch',
      value: { kind: 'new', type: { name: 'num' }, value: 0 },
      cases: [{
        equals: [{ kind: 'new', type: { name: 'num' }, value: 1 }],
        body: {
          kind: 'set', path: [{ prop: 'x' }],
          value: { kind: 'new', type: { name: 'num' }, value: 1 },
        },
      }],
      else: { kind: 'new', type: { name: 'void' } },
    });
    expect(probs.list.some((p) => p.code === 'switch.else.no-effect')).toBe(true);
  });
});

describe('Call.effects() from parsed call.get / call.set', () => {
  test('fn with call.get NativeExpr propagates EXTERNAL', () => {
    const r = createRegistry();
    r.setNative('test.external', () => undefined, Effects.EXTERNAL);
    const fnType = r.fn({ args: r.obj({}), returns: r.void(), call: r.parseExpr({ kind: 'native', id: 'test.external' }) });
    expect(fnType.call()?.effects()).toBe(Effects.EXTERNAL);
  });

  test('GetExpr.effects() picks up resolved call effects after validate', () => {
    // Set up: a scope variable `external` of fn type whose call.get
    // is a native with EXTERNAL effects. Calling external() should
    // surface EXTERNAL through GetExpr.effects() once validateWalk
    // has resolved the path.
    const r = createRegistry();
    r.setNative('test.external', () => undefined, Effects.EXTERNAL);
    const fnType = r.fn({ args: r.obj({}), returns: r.void(), call: r.parseExpr({ kind: 'native', id: 'test.external' }) });
    const e = new Engine(r);
    const scope = new Map(e.globalTypeScope());
    scope.set('external', fnType);

    const expr = r.parseExpr({
      kind: 'get',
      path: [{ prop: 'external' }, { args: {} }],
    });
    // Effects pre-validate: only inner-expr effects, NONE.
    expect(expr.effects()).toBe(Effects.NONE);
    // After validateWalk caches resolved effects on CallStep.
    e.validate(expr, scope);
    expect(expr.effects() & Effects.EXTERNAL).toBe(Effects.EXTERNAL);
  });

  test('Loop body with call to external fn does NOT trigger no-effect', () => {
    // Regression: `for i in 1..10 { external() }` — even though the
    // body has no `set` or `flow`, the external call carries EXTERNAL
    // effects and so the loop is observably doing something.
    const r = createRegistry();
    r.setNative('test.external', () => undefined, Effects.EXTERNAL);
    const fnType = r.fn({ args: r.obj({}), returns: r.void(), call: r.parseExpr({ kind: 'native', id: 'test.external' }) });
    const e = new Engine(r);
    const scope = new Map(e.globalTypeScope());
    scope.set('external', fnType);

    const probs = e.validate({
      kind: 'loop',
      over: { kind: 'new', type: { name: 'list', generic: { V: { name: 'num' } } }, value: [] },
      body: { kind: 'get', path: [{ prop: 'external' }, { args: {} }] },
    }, scope);
    expect(probs.list.some((p) => p.code === 'loop.body.no-effect')).toBe(false);
  });
});

describe('Call/Prop/GetSet/Init round-trip parse → toJSON', () => {
  test('TypeDef with call.get ExprDef round-trips through toJSON', () => {
    const r = createRegistry();
    r.setNative('test.x', () => undefined, Effects.NONE);
    const def = {
      name: 'fn',
      call: {
        args: { name: 'obj' },
        returns: { name: 'void' },
        get: { kind: 'native', id: 'test.x' },
      },
    } as const;
    const t = r.parse(def);
    expect(t.toJSON()).toMatchObject({
      name: 'fn',
      call: {
        get: { kind: 'native', id: 'test.x' },
      },
    });
  });
});
