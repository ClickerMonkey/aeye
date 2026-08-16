import { describe, test, expect } from 'vitest';
import { createRegistry } from '../index';
import { Value } from '../value';
import type { Type } from '../type';

/**
 * A `fn`-declared slot holds an ExprDef, and that is its ORDINARY value —
 * not an expression smuggled where data goes.
 *
 * THE DEFECT (0.4.1, found by the first real consumer of the new refusals).
 * `Registry.parseValue` tested a node's SHAPE before it consulted the
 * DECLARED type, so the same value got a different verdict depending on how
 * deep it sat:
 *
 *   fn.parse({kind:'new', type:{name:'bool'}, value:false})   → OK
 *   obj{probe: fn}.parse({probe: <that same node>})           → THREW
 *   obj{probe: fn}.parse({probe: {kind:'get', path:[…]}})     → OK
 *   list<fn>.parse([<the new node>])                          → THREW
 *
 * `new` is the only expr kind carrying BOTH a `type` and a `value` key, which
 * is why it alone tripped the value-envelope branch — and why `get` in the
 * identical slot was fine. **A value that parses standalone and throws one
 * level in is the shape of a dispatch-order bug**, which is why this file
 * asserts the four measurements together rather than only the fixed one: the
 * asymmetry is the thing that must not come back.
 *
 * WHAT 0.4.1 REPLACED. Under 0.4.0 the nested call did not throw — it
 * silently returned `{probe: Value(bool, false)}`, reading `{name:'bool'}` as
 * a type and `false` as its value. **The lambda was replaced by the literal
 * its body constructs**, and the form built from it submitted happily. That is
 * exactly the corruption the slot-type reconciliation was written to kill, so
 * 0.4.1's refusal was a strict improvement — it was just still the wrong
 * answer for a slot whose declared type says an ExprDef IS its value.
 *
 * THE RULE. `Type.parsesExprValue()` — declared on the type, not tested by
 * class, so it travels with an `Extension` over `fn`, an `optional<fn>`, an
 * `or<fn, text>`. `any` answers false deliberately: it accepts every value but
 * does not DECLARE that an ExprDef is one of its values.
 */

const registry = () => {
  const r = createRegistry();
  return { r, fnT: r.fn({ args: r.obj({}), returns: r.bool() }) };
};

/** The node the consumer actually hit: a fn body that constructs a literal.
 *  It carries `kind` AND `type` AND `value`, so it is shaped like BOTH an
 *  ExprDef and a value envelope. */
const NEW_NODE = { kind: 'new', type: { name: 'bool' }, value: false };
/** The control: an expr kind with no `type`/`value` keys, which never tripped
 *  the envelope branch and so worked throughout. */
const GET_NODE = { kind: 'get', path: [{ prop: 'x' }] };

/** The ExprDef a parsed fn slot ended up holding. */
const bodyOf = (v: Value, ...path: string[]): unknown => {
  let cur: Value = v;
  for (const key of path) cur = (cur.raw as Record<string, Value>)[key]!;
  return cur.raw;
};

describe('the same fn body parses the same at EVERY nesting depth', () => {
  const { r, fnT } = registry();

  test('standalone — the baseline that always worked', () => {
    const v = fnT.parse(NEW_NODE);
    expect(v.type.name).toBe('fn');
    expect(v.raw).toEqual(NEW_NODE);
  });

  test('an obj FIELD declared fn — used to throw', () => {
    const v = r.obj({ probe: { type: fnT } }).parse({ probe: NEW_NODE });
    expect(bodyOf(v, 'probe')).toEqual(NEW_NODE);
    expect((v.raw as Record<string, Value>).probe!.type.name).toBe('fn');
  });

  test('a list ELEMENT declared fn — used to throw', () => {
    const v = r.list(fnT).parse([NEW_NODE]);
    expect((v.raw as Value[])[0]!.raw).toEqual(NEW_NODE);
    expect((v.raw as Value[])[0]!.type.name).toBe('fn');
  });

  test('a map VALUE declared fn — used to throw', () => {
    const v = r.map(r.text(), fnT).parse([{ key: 'k', value: NEW_NODE }]);
    const entry = (v.raw as Map<unknown, [Value, Value]>).get('k')!;
    expect(entry[1].raw).toEqual(NEW_NODE);
    expect(entry[1].type.name).toBe('fn');
  });

  test('a tuple POSITION declared fn — used to throw', () => {
    const v = r.tuple([fnT]).parse([NEW_NODE]);
    expect((v.raw as Value[])[0]!.raw).toEqual(NEW_NODE);
  });

  test('two levels down', () => {
    const v = r.obj({ p: { type: r.obj({ q: { type: fnT } }) } }).parse({ p: { q: NEW_NODE } });
    expect(bodyOf(v, 'p', 'q')).toEqual(NEW_NODE);
  });

  test('the `get` CONTROL behaves identically — it always did', () => {
    // The asymmetry between these two nodes in the same slot is what named
    // the defect: `get` carries no `type`/`value`, so it never reached the
    // envelope branch.
    const v = r.obj({ probe: { type: fnT } }).parse({ probe: GET_NODE });
    expect(bodyOf(v, 'probe')).toEqual(GET_NODE);
  });

  test('a string native ref still works in a nested slot', () => {
    const v = r.obj({ probe: { type: fnT } }).parse({ probe: 'bool.true' });
    expect(bodyOf(v, 'probe')).toBe('bool.true');
  });
});

describe('the rule travels with any type that IS a fn', () => {
  const { r, fnT } = registry();

  test('an Extension over fn', () => {
    const handler = r.extend(fnT, { name: 'Handler' });
    r.register(handler);
    expect(handler.parsesExprValue()).toBe(true);
    const v = r.list(handler).parse([NEW_NODE]);
    expect((v.raw as Value[])[0]!.raw).toEqual(NEW_NODE);
  });

  test('optional<fn> and nullable<fn>', () => {
    expect(r.optional(fnT).parsesExprValue()).toBe(true);
    expect(r.nullable(fnT).parsesExprValue()).toBe(true);
    const v = r.obj({ probe: { type: r.optional(fnT) } }).parse({ probe: NEW_NODE });
    expect(bodyOf(v, 'probe')).toEqual(NEW_NODE);
  });

  test('or<fn, text> — any variant taking an Expr is enough', () => {
    const u = r.or([fnT, r.text()]);
    expect(u.parsesExprValue()).toBe(true);
    const v = r.obj({ probe: { type: u } }).parse({ probe: NEW_NODE });
    expect(bodyOf(v, 'probe')).toEqual(NEW_NODE);
  });

  test('a bound alias resolves to the target\'s answer', () => {
    const session = r.scope({ Handler: fnT });
    expect(session.parse({ name: 'Handler' }).parsesExprValue(session)).toBe(true);
  });

  test('an UNRESOLVED alias answers false — it knows nothing to claim', () => {
    expect(r.alias('NoSuchType').parsesExprValue()).toBe(false);
  });
});

describe('nothing else gained the exemption', () => {
  const { r } = registry();

  /** Every type that must still refuse an Expr node in a value slot. `any` is
   *  the one to watch: it accepts every value, but accepting everything is not
   *  the same as DECLARING that an ExprDef is one of your values. */
  const refusers: ReadonlyArray<readonly [string, Type]> = [
    ['any', r.any()],
    ['text', r.text()],
    ['num', r.num()],
    ['bool', r.bool()],
    ['obj', r.obj({ a: { type: r.text() } })],
    ['list<any>', r.list(r.any())],
    ['optional<any>', r.optional(r.any())],
  ];

  for (const [label, t] of refusers) {
    test(`${label} does not claim Expr values`, () => {
      expect(t.parsesExprValue()).toBe(false);
    });
  }

  test('an Expr in a list<any> slot is still refused', () => {
    expect(() => r.list(r.any()).parse([NEW_NODE]))
      .toThrow(/is an EXPRESSION \(kind:'new'\), not a value envelope/);
  });

  test('...and the refusal now names the slot that refused it', () => {
    try {
      r.list(r.text()).parse([NEW_NODE]);
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toContain('This slot is declared `text`');
    }
  });

  test('the slot-type reconciliation is untouched', () => {
    expect(() => r.list(r.text()).parse([{ type: { name: 'num' }, value: 5 }]))
      .toThrow(/declared `text`.*carries `num`/);
  });
});

describe('a real value ENVELOPE landing in a fn slot still round-trips', () => {
  const { r, fnT } = registry();

  test('the exemption is narrow — it needs an expr `kind`, not just a fn slot', () => {
    // `{type:{name:'fn',…}, value:{kind:'new',…}}` has no TOP-LEVEL `kind`,
    // so it is an envelope and must be read as one. Step 2 must not swallow it.
    const v = new Value(fnT, NEW_NODE);
    const back = r.parseValue(v.toJSON(), fnT);
    expect(back.type.name).toBe('fn');
    expect(back.raw).toEqual(NEW_NODE);
  });

  test('a fn slot inside a composite survives a full toJSON round trip', () => {
    const t = r.obj({ probe: { type: fnT } });
    const v = t.parse({ probe: NEW_NODE });
    expect(bodyOf(r.parseValue(v.toJSON()) as Value, 'probe')).toEqual(NEW_NODE);
  });
});
