import { describe, test, expect } from 'vitest';
import { createRegistry, Engine } from '../index';
import type { ExprDef } from '../schema';

/**
 * The `new <T>{value}` payload walk — ONE type-driven recursive traversal
 * shared by the evaluator, the validator and the two static analyses.
 *
 * WHAT WAS BROKEN. `NewExpr.evaluate` filled embedded Exprs at an obj's OWN
 * fields, one level, and nowhere else. `Type.newEffects` / `newComplexity`
 * already descended composite element slots, so gin's static analysis and its
 * evaluator disagreed about what a `new` payload contains. Everything that
 * reached a list element, a map key or value, a tuple position or a NESTED
 * obj was handed to `Type.parse` as data, and met one of two fates:
 *
 *   - a strict element type threw at run (`text.parse: expected string, got
 *     object`) — loud, but only after every static gate had said GO;
 *   - a PERMISSIVE element type (`any`, or anything extending it) ACCEPTED
 *     the raw `{kind:'get',…}` node AS THE VALUE. That is the dangerous one:
 *     a program reading a credential into a `list<any>` param shipped the
 *     expression instead of what it evaluates to — a wrong value on the wire,
 *     not a failure.
 *
 * And `validate` never looked inside a `new` at all: `NewExpr.validateWalk`
 * returned after one "missing value" warning without walking `this.value`, so
 * an unresolvable variable in `new obj{a: <get missing>}` produced no problem
 * whatsoever. Every read an authoring agent writes lives inside some `new`.
 *
 * The table below is the measured before/after, one row per program shape.
 */

const GET_V: ExprDef = { kind: 'get', path: [{ prop: 'v' }] } as ExprDef;

describe('a `new` payload evaluates embedded Exprs at EVERY slot', () => {
  const r = createRegistry();
  const e = new Engine(r);
  const extras = { v: r.text().parse('FILLED') };

  /** Each row: the payload shape, and the logical value it must produce.
   *  Only the FIRST used to work; every other row threw at run while
   *  `validate` reported nothing. */
  const shapes: ReadonlyArray<readonly [string, ExprDef, unknown]> = [
    ['obj{a:text} <- {a: <get>}',
      { kind: 'new', type: { name: 'obj', props: { a: { type: { name: 'text' } } } }, value: { a: GET_V } } as ExprDef,
      { a: 'FILLED' }],
    ['obj{a: obj{b:text}} <- {a: {b: <get>}}   (nested obj, no explicit `new`)',
      { kind: 'new', type: { name: 'obj', props: { a: { type: { name: 'obj', props: { b: { type: { name: 'text' } } } } } } }, value: { a: { b: GET_V } } } as ExprDef,
      { a: { b: 'FILLED' } }],
    ['list<text> <- [ <get> ]',
      { kind: 'new', type: { name: 'list', generic: { V: { name: 'text' } } }, value: [GET_V] } as ExprDef,
      ['FILLED']],
    ['obj{xs: list<text>} <- {xs: [ <get> ]}',
      { kind: 'new', type: { name: 'obj', props: { xs: { type: { name: 'list', generic: { V: { name: 'text' } } } } } }, value: { xs: [GET_V] } } as ExprDef,
      { xs: ['FILLED'] }],
    ['map<text,text> <- [ {key:<get>, value:<get>} ]',
      { kind: 'new', type: { name: 'map', generic: { K: { name: 'text' }, V: { name: 'text' } } }, value: [{ key: GET_V, value: GET_V }] } as ExprDef,
      [{ key: 'FILLED', value: 'FILLED' }]],
    ['tuple<text,text> <- [ <get>, "lit" ]',
      { kind: 'new', type: { name: 'tuple', options: { elements: [{ name: 'text' }, { name: 'text' }] } }, value: [GET_V, 'lit'] } as ExprDef,
      ['FILLED', 'lit']],
    ['optional<list<text>> <- [ <get> ]',
      { kind: 'new', type: { name: 'optional', generic: { T: { name: 'list', generic: { V: { name: 'text' } } } } }, value: [GET_V] } as ExprDef,
      ['FILLED']],
  ];

  for (const [label, def, expected] of shapes) {
    test(`runs: ${label}`, async () => {
      const v = await e.run(def, extras);
      expect(v.encodeLogical()).toEqual(expected);
    });

    test(`validate is silent (nothing to report): ${label}`, () => {
      expect(e.validate(def, new Map([['v', r.text()]])).list).toEqual([]);
    });
  }

  test('a list element deeper than one composite still fills', async () => {
    // `new list<obj{k}>[ {k: <get>} ]` — the element is an obj literal with
    // no explicit `{kind:'new'}` node, which is exactly the spelling the
    // canonical `list<HttpHeader>` shape teaches.
    const v = await e.run({
      kind: 'new',
      type: { name: 'list', generic: { V: { name: 'obj', props: { k: { type: { name: 'text' } } } } } },
      value: [{ k: GET_V }, { k: 'literal' }],
    } as ExprDef, extras);
    expect(v.encodeLogical()).toEqual([{ k: 'FILLED' }, { k: 'literal' }]);
  });

  test('slots evaluate SEQUENTIALLY, in authored order', async () => {
    // Element 0 WRITES `x`; element 1 READS it. Under `Promise.all` the read
    // would race the write and see the pre-existing value, so the payload's
    // meaning would depend on scheduling. A slot Expr may carry STATE
    // effects, which is why the walk awaits one slot before starting the next.
    const v = await e.run({
      kind: 'new',
      type: { name: 'list', generic: { V: { name: 'any' } } },
      value: [
        { kind: 'set', path: [{ prop: 'x' }], value: { kind: 'new', type: { name: 'text' }, value: 'written' } },
        { kind: 'get', path: [{ prop: 'x' }] },
      ],
    } as ExprDef, { x: r.text().parse('before') });
    expect((v.encodeLogical() as unknown[])[1]).toBe('written');
  });
});

describe('a PERMISSIVE element type no longer swallows the ExprDef as data', () => {
  const r = createRegistry();
  const e = new Engine(r);

  test('list<any> element evaluates instead of storing the raw `{kind:get}` node', async () => {
    // MEASURED BEFORE: emitted `{"kind":"get","path":[{"prop":"secret"}]}` as
    // the element's value — the expression on the wire in place of what it
    // evaluates to. A strict element type threw here; a permissive one turned
    // a loud error into a silent wrong value.
    const v = await e.run({
      kind: 'new',
      type: { name: 'list', generic: { V: { name: 'any' } } },
      value: [{ kind: 'get', path: [{ prop: 'secret' }] }],
    } as ExprDef, { secret: r.text().parse('sk-live-123') });
    expect(v.encodeLogical()).toEqual(['sk-live-123']);
  });

  test('an obj field typed `any` behaves the same', async () => {
    const v = await e.run({
      kind: 'new',
      type: { name: 'obj', props: { payload: { type: { name: 'any' } } } },
      value: { payload: { kind: 'get', path: [{ prop: 'secret' }] } },
    } as ExprDef, { secret: r.text().parse('sk-live-123') });
    expect(v.encodeLogical()).toEqual({ payload: 'sk-live-123' });
  });

  test('a map VALUE typed `any` behaves the same', async () => {
    const v = await e.run({
      kind: 'new',
      type: { name: 'map', generic: { K: { name: 'text' }, V: { name: 'any' } } },
      value: [{ key: 'tag', value: { kind: 'get', path: [{ prop: 'secret' }] } }],
    } as ExprDef, { secret: r.text().parse('sk-live-123') });
    expect(v.encodeLogical()).toEqual([{ key: 'tag', value: 'sk-live-123' }]);
  });
});

describe('validate WALKS the payload — it used to not look at all', () => {
  const r = createRegistry();
  const e = new Engine(r);

  test('an unresolvable variable inside a `new` obj field is reported', () => {
    // MEASURED BEFORE: `hasErrors` was false. The claim that an unbound name
    // "dies to gin's unknown variable" was simply untrue inside a `new`.
    const probs = e.validate({
      kind: 'new',
      type: { name: 'obj', props: { a: { type: { name: 'text' } } } },
      value: { a: { kind: 'get', path: [{ prop: 'nope' }] } },
    } as ExprDef, new Map());
    expect(probs.list.some((p) => p.code === 'var.unknown')).toBe(true);
    expect(probs.hasErrors).toBe(true);
  });

  test('...and inside a LIST element, which never had any walk at all', () => {
    const probs = e.validate({
      kind: 'new',
      type: { name: 'list', generic: { V: { name: 'text' } } },
      value: [{ kind: 'get', path: [{ prop: 'nope' }] }],
    } as ExprDef, new Map());
    expect(probs.list.some((p) => p.code === 'var.unknown')).toBe(true);
  });

  test('the problem PATH points at the offending slot', () => {
    const probs = e.validate({
      kind: 'new',
      type: { name: 'obj', props: { a: { type: { name: 'text' } } } },
      value: { a: { kind: 'get', path: [{ prop: 'nope' }] } },
    } as ExprDef, new Map());
    const unknown = probs.list.find((p) => p.code === 'var.unknown')!;
    expect(unknown.path.slice(0, 2)).toEqual(['value', 'a']);
  });

  test('an Expr whose result the slot cannot accept is an ERROR, not a run-time surprise', () => {
    // The whole contract an authoring agent iterates against: validate must
    // refuse what run would throw.
    const probs = e.validate({
      kind: 'new',
      type: { name: 'list', generic: { V: { name: 'text' } } },
      value: [{ kind: 'get', path: [{ prop: 'n' }] }],
    } as ExprDef, new Map([['n', r.num()]]));
    const mismatch = probs.list.find((p) => p.code === 'new.slot.type');
    expect(mismatch).toBeDefined();
    expect(mismatch!.message).toContain('declared `text`');
    expect(mismatch!.message).toContain('produces `num`');
  });

  test('...and run does throw for that same program, so the two agree', async () => {
    await expect(e.run({
      kind: 'new',
      type: { name: 'list', generic: { V: { name: 'text' } } },
      value: [{ kind: 'get', path: [{ prop: 'n' }] }],
    } as ExprDef, { n: r.num().parse(5) })).rejects.toThrow();
  });

  test('an unknown variable is reported ONCE, not also as a bogus type error', () => {
    // `typeOf` returns `any` for everything it cannot infer, so an
    // unresolvable name produced BOTH `var.unknown` and "this slot is
    // declared `text` but the expression here produces `any`" — two problems
    // for one mistake, the second pointing at the slot instead of at the name
    // the author got wrong. `any` as a RESULT means "not known", never
    // "known to be wrong".
    const probs = e.validate({
      kind: 'new',
      type: { name: 'obj', props: { a: { type: { name: 'text' } } } },
      value: { a: { kind: 'get', path: [{ prop: 'nope' }] } },
    } as ExprDef, new Map());
    expect(probs.list.filter((p) => p.code === 'var.unknown')).toHaveLength(1);
    expect(probs.list.some((p) => p.code === 'new.slot.type')).toBe(false);
  });

  test('...and a KNOWN wrong type is still reported', () => {
    // The suppression is for `any` only — it must not swallow a real mismatch.
    const probs = e.validate({
      kind: 'new',
      type: { name: 'obj', props: { a: { type: { name: 'text' } } } },
      value: { a: { kind: 'get', path: [{ prop: 'n' }] } },
    } as ExprDef, new Map([['n', r.num()]]));
    expect(probs.list.some((p) => p.code === 'new.slot.type')).toBe(true);
  });

  test('a permissive slot stays quiet — nothing is known there to contradict', () => {
    const probs = e.validate({
      kind: 'new',
      type: { name: 'list', generic: { V: { name: 'any' } } },
      value: [{ kind: 'get', path: [{ prop: 'n' }] }],
    } as ExprDef, new Map([['n', r.num()]]));
    expect(probs.list.some((p) => p.code === 'new.slot.type')).toBe(false);
  });

  test('a subtype in a slot declared as its base is accepted', () => {
    const reg = createRegistry();
    const eng = new Engine(reg);
    const animal = reg.extend(reg.obj({ name: { type: reg.text() } }), { name: 'Animal' });
    reg.register(animal);
    const dog = reg.extend(animal, { name: 'Dog' });
    reg.register(dog);
    const probs = eng.validate({
      kind: 'new',
      type: { name: 'list', generic: { V: { name: 'Animal' } } },
      value: [{ kind: 'get', path: [{ prop: 'd' }] }],
    } as ExprDef, new Map([['d', dog]]));
    expect(probs.list.some((p) => p.code === 'new.slot.type')).toBe(false);
  });
});

describe('a `default` on an Extension prop survives a NESTED `new` (0.4.2)', () => {
  /**
   * A `Value` is not a payload, and treating one as a bag of keys corrupted
   * it. When a nested `{kind:'new', …}` slot was evaluated, `newFill` handed
   * back the finished `Value` — and `Extension.newFill`, seeing something
   * object-shaped, spread it into a fresh object to add a defaulted stored
   * local prop. That destroyed the `(type, raw)` pair, and the failure
   * surfaced three frames later as `text.parse: expected string, got
   * undefined`, blaming a field that was never missing.
   *
   * It needed all three conditions at once — a NESTED `new`, an Extension
   * with a STORED local prop, and a `default` on it — which is why the shape
   * looked like "defaults are broken" from outside. The `default` is what
   * made the loop write anything at all; without one the `Value` came back
   * untouched by luck.
   */
  const build = (where: 'base' | 'local') => {
    const r = createRegistry();
    const e = new Engine(r);
    const dflt = r.parseExpr({ kind: 'new', type: { name: 'text' }, value: 'query' });
    const P = where === 'base'
      ? r.extend(r.obj({ name: { type: r.text() }, mode: { type: r.text(), default: dflt } }), { name: 'HttpParam' })
      : r.extend(r.obj({ name: { type: r.text() } }), { name: 'HttpParam', props: { mode: { type: r.text(), default: dflt } } });
    r.register(P);
    return { r, e };
  };

  for (const where of ['base', 'local'] as const) {
    test(`default on the ${where}: a nested \`new\` inside a list fills it`, async () => {
      const { e } = build(where);
      const v = await e.run({
        kind: 'new',
        type: { name: 'list', generic: { V: { name: 'HttpParam' } } },
        value: [{ kind: 'new', type: { name: 'HttpParam' }, value: { name: 'x' } }],
      } as ExprDef);
      expect(v.encodeLogical()).toEqual([{ name: 'x', mode: 'query' }]);
    });

    test(`default on the ${where}: nested inside an obj field`, async () => {
      const { e } = build(where);
      const v = await e.run({
        kind: 'new',
        type: { name: 'obj', props: { p: { type: { name: 'HttpParam' } } } },
        value: { p: { kind: 'new', type: { name: 'HttpParam' }, value: { name: 'x' } } },
      } as ExprDef);
      expect(v.encodeLogical()).toEqual({ p: { name: 'x', mode: 'query' } });
    });

    test(`default on the ${where}: at the top level, and with no inner \`new\``, async () => {
      const { e } = build(where);
      const top = await e.run({ kind: 'new', type: { name: 'HttpParam' }, value: { name: 'x' } } as ExprDef);
      expect(top.encodeLogical()).toEqual({ name: 'x', mode: 'query' });
      const bare = await e.run({
        kind: 'new',
        type: { name: 'list', generic: { V: { name: 'HttpParam' } } },
        value: [{ name: 'x' }],
      } as ExprDef);
      expect(bare.encodeLogical()).toEqual([{ name: 'x', mode: 'query' }]);
    });
  }

  test('a supplied value still wins over the default', async () => {
    const { e } = build('local');
    const v = await e.run({
      kind: 'new',
      type: { name: 'list', generic: { V: { name: 'HttpParam' } } },
      value: [{ kind: 'new', type: { name: 'HttpParam' }, value: { name: 'x', mode: 'header' } }],
    } as ExprDef);
    expect(v.encodeLogical()).toEqual([{ name: 'x', mode: 'header' }]);
  });
});

describe('the analyses walk the SAME slots the evaluator does', () => {
  const r = createRegistry();

  test('a list element Expr contributes its effects, as it always did', () => {
    // `newEffects` already descended element slots before 0.4.1 — this pins
    // that the shared traversal did not lose that, which is the direction the
    // rewrite could have broken.
    const listText = r.parse({ name: 'list', generic: { V: { name: 'text' } } });
    const bare = listText.newEffects([{ kind: 'template', parts: ['x'] }]);
    const stateful = listText.newEffects([{ kind: 'set', path: [{ prop: 'x' }], value: { kind: 'new', type: { name: 'text' }, value: 'a' } }]);
    expect(stateful).not.toBe(bare);
  });

  test('effects recurse into a NESTED obj field, which the evaluator now fills', () => {
    const nested = r.parse({
      name: 'obj',
      props: { a: { type: { name: 'obj', props: { b: { type: { name: 'text' } } } } } },
    });
    const setB = { kind: 'set', path: [{ prop: 'x' }], value: { kind: 'new', type: { name: 'text' }, value: 'a' } };
    expect(nested.newEffects({ a: { b: setB } }))
      .not.toBe(nested.newEffects({ a: { b: 'literal' } }));
  });

  test('a payload that is itself an Expr defers to the whole-value reading', () => {
    // `{kind:'get', …}` written where an obj literal would go is ONE Expr, not
    // a field map with fields called `kind` and `path`. Every consumer of the
    // shared traversal reads it the same way.
    const t = r.parse({ name: 'obj', props: { a: { type: { name: 'text' } } } });
    const asExpr = { kind: 'get', path: [{ prop: 'src' }] };
    const seen: Array<string | number> = [];
    const visit = { slot: (_t: unknown, _v: unknown, at: string | number) => { seen.push(at); } };

    // `false` — this type did NOT decompose the payload, so the caller must
    // judge `value` as one opaque thing.
    expect(t.forEachNewSlot(asExpr, visit)).toBe(false);
    expect(seen).toEqual([]);

    // ...whereas a real field map decomposes into its declared fields.
    expect(t.forEachNewSlot({ a: 'literal' }, visit)).toBe(true);
    expect(seen).toEqual(['a']);
  });
});
