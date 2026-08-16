import { describe, test, expect } from 'vitest';
import { createRegistry, Engine } from '../index';
import { Value } from '../value';
import type { ExprDef } from '../schema';

/**
 * Wherever a value meets a DECLARING context there are two type opinions in
 * the room — the one the container declares, and the one the `Value` carries
 * — and gin used to keep exactly one of them, varying by seam.
 *
 * At a composite slot it kept the VALUE's, silently:
 *
 *   list<text>.parse([{type:{name:'num'}, value:5}])
 *     → OK, a `num` sitting inside a `list<text>`
 *     listText.valid(raw)        → true   (`ListType.valid` asked each cell
 *                                          whether it was valid BY ITS OWN
 *                                          LIGHTS, never against the DECLARED
 *                                          element type)
 *     engine.validateValue(v)    → []
 *     toValueSchema().safeParse  → FAILS  ← the only surface that saw it,
 *                                          and a generated schema is not a
 *                                          validator
 *
 * `{kind:'new', type, value}` and a `JSONValue` envelope are the SAME JSON
 * shape once the expression names a type and a value, so an expression
 * written into a value slot was installed as a literal of whatever type it
 * named, `kind` simply ignored.
 *
 * Reconciled through ONE rule (`accepts`) so `parse`, `valid` and the
 * validator cannot answer it differently — and a genuine SUBTYPE still lands,
 * which is the entire point of per-slot types.
 */

describe('a composite slot enforces its DECLARED element type', () => {
  const r = createRegistry();

  test('a `num` envelope in a list<text> is refused at parse', () => {
    const listText = r.list(r.text());
    expect(() => listText.parse([{ type: { name: 'num' }, value: 5 }]))
      .toThrow(/declared `text`.*carries `num`/);
  });

  test('...and `valid` agrees, so a hand-built raw cannot smuggle one in', () => {
    const listText = r.list(r.text());
    const smuggled = [new Value(r.num(), 5)];
    // MEASURED BEFORE: true.
    expect(listText.valid(smuggled)).toBe(false);
  });

  test('an obj FIELD is enforced the same way', () => {
    const t = r.obj({ a: { type: r.text() } });
    expect(() => t.parse({ a: { type: { name: 'num' }, value: 5 } }))
      .toThrow(/declared `text`.*carries `num`/);
    expect(t.valid({ a: new Value(r.num(), 5) })).toBe(false);
  });

  test('a map KEY and VALUE are each enforced', () => {
    const m = r.map(r.text(), r.text());
    expect(() => m.parse([{ key: 'k', value: { type: { name: 'num' }, value: 5 } }]))
      .toThrow(/declared `text`.*carries `num`/);
    expect(() => m.parse([{ key: { type: { name: 'num' }, value: 5 }, value: 'v' }]))
      .toThrow(/declared `text`.*carries `num`/);
  });

  test('a tuple POSITION is enforced', () => {
    const t = r.tuple([r.text(), r.num()]);
    expect(() => t.parse(['a', { type: { name: 'text' }, value: 'b' }]))
      .toThrow(/declared `num`.*carries `text`/);
  });

  test('the message names BOTH opinions, so the fix is readable off it', () => {
    try {
      r.list(r.text()).parse([{ type: { name: 'num' }, value: 5 }]);
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toContain('declared `text`');
      expect((err as Error).message).toContain('carries `num`');
    }
  });
});

describe('a genuine SUBTYPE still lands — the rule is `accepts`, not equality', () => {
  const r = createRegistry();
  const animal = r.extend(r.obj({ name: { type: r.text() } }), { name: 'Animal' });
  r.register(animal);
  const dog = r.extend(animal, { name: 'Dog' });
  r.register(dog);

  test('a Dog envelope in a list<Animal> parses and KEEPS its concrete type', () => {
    const v = r.list(animal).parse([{ type: { name: 'Dog' }, value: { name: 'rex' } }]);
    expect((v.raw as Value[])[0]!.type.name).toBe('Dog');
  });

  test('...and `valid` accepts it', () => {
    const v = r.list(animal).parse([{ type: { name: 'Dog' }, value: { name: 'rex' } }]);
    expect(r.list(animal).valid(v.raw)).toBe(true);
  });

  test('an Extension over a BUILT-IN counts as a subtype of that built-in', () => {
    // `compatible` matches on the LEFT's class and never opens the right, so
    // `num.compatible(<Extension over num>)` is false even though every
    // Extension value is a valid base value. `accepts` walks the chain; a
    // `positive` in a `map<num, text>` key slot is the measured case.
    const reg = createRegistry();
    const positive = reg.extend('num', { name: 'positive', options: { min: 0 } });
    reg.define('positive', positive);
    const m = reg.map(reg.num(), reg.text());
    const raw = new Map<unknown, [Value, Value]>([[5, [new Value(positive, 5), new Value(reg.text(), 'five')]]]);
    expect(m.valid(raw)).toBe(true);
    expect(reg.parseValue(new Value(m, raw).toJSON()).raw).toBeInstanceOf(Map);
  });

  test('a permissive declared type accepts anything, as it must', () => {
    expect(r.list(r.any()).valid([new Value(r.num(), 5), new Value(r.text(), 'x')])).toBe(true);
  });
});

describe('an EXPRESSION written into a value slot is diagnosed, not reinterpreted', () => {
  const r = createRegistry();

  test('`{kind:new, type, value}` reaching a bare parse says what it is', () => {
    // MEASURED BEFORE: read as a `JSONValue` envelope, `kind` ignored, so the
    // node installed a `num` inside a `list<text>` with no complaint.
    expect(() => r.list(r.text()).parse([{ kind: 'new', type: { name: 'num' }, value: 5 }]))
      .toThrow(/is an EXPRESSION \(kind:'new'\), not a value envelope/);
  });

  test('the message says where an Expr DOES belong', () => {
    try {
      r.list(r.text()).parse([{ kind: 'new', type: { name: 'text' }, value: 'x' }]);
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toMatch(/only evaluates inside a program/);
      expect((err as Error).message).toMatch(/Drop the `kind`/);
    }
  });

  test('a node WITHOUT `kind` is still an envelope — the two are told apart', () => {
    const v = r.list(r.text()).parse([{ type: { name: 'text' }, value: 'lit' }]);
    expect(v.encodeLogical()).toEqual(['lit']);
  });

  test('inside a program the SAME node evaluates, and then meets the slot check', async () => {
    const e = new Engine(r);
    await expect(e.run({
      kind: 'new',
      type: { name: 'list', generic: { V: { name: 'text' } } },
      value: [{ kind: 'new', type: { name: 'num' }, value: 5 }],
    } as ExprDef)).rejects.toThrow(/declared `text`.*carries `num`/);

    const ok = await e.run({
      kind: 'new',
      type: { name: 'list', generic: { V: { name: 'text' } } },
      value: [{ kind: 'new', type: { name: 'text' }, value: 'x' }],
    } as ExprDef);
    expect(ok.encodeLogical()).toEqual(['x']);
  });
});

describe('parseValue without a declared type is unchanged', () => {
  const r = createRegistry();

  test('no declared type means no second opinion to reconcile against', () => {
    const env = new Value(r.num(), 5).toJSON();
    expect(r.parseValue(env).type.name).toBe('num');
  });

  test('a live Value passes through when nothing declares otherwise', () => {
    const v = new Value(r.num(), 5);
    expect(r.parseValue(v)).toBe(v);
  });
});
