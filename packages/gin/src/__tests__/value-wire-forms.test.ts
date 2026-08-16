import { describe, test, expect } from 'vitest';
import { createRegistry } from '../index';
import { Value } from '../value';
import type { Type } from '../type';

/**
 * The four JSON forms a `Value` can take, and what each costs.
 *
 * There used to be TWO ways to hold a typed value — the live `Value`, or the
 * full `{type, value}` envelope — and no third, envelope-free,
 * type-preserving form. `Value.encode()` drops only the OUTER layer, so a
 * `list<num>` still encoded as `[{type,value}]`, and nothing could be added
 * from outside because the composite/leaf split lives on `Type.encode`. So
 * consumers that had to hand a bare value across a boundary reimplemented
 * gin's own walk.
 *
 * And the envelope was expensive for a reason that has nothing to do with
 * carrying a type: a registered named type's `toJSON()` inlines its WHOLE
 * DEFINITION at every element. gin already draws the reference-vs-definition
 * distinction on the TYPE side — `Registry.scope()` binds a name that
 * round-trips as `{name}` where `register()` binds an instance that
 * round-trips inlined — it just never applied it to the value envelope.
 *
 * Measured here, in the test, so the numbers cannot rot.
 */

const projectRegistry = () => {
  const r = createRegistry();
  const project = r.extend(r.obj({
    id: { type: r.text() }, name: { type: r.text() },
    budget: { type: r.num() }, active: { type: r.bool() },
  }), { name: 'project' });
  r.register(project);
  const flagship = r.extend(project, { name: 'flagship' });
  r.register(flagship);
  return { r, project, flagship };
};

const rows = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `N${i}`, budget: i, active: true }));

describe('encodeLogical — the envelope-free form', () => {
  const r = createRegistry();

  test('no `{type,value}` pair survives at ANY depth', () => {
    const nested = r.obj({
      tags: { type: r.list(r.text()) },
      scores: { type: r.map(r.text(), r.num()) },
      pair: { type: r.tuple([r.text(), r.num()]) },
      when: { type: r.timestamp() },
      maybe: { type: r.optional(r.list(r.num())) },
    });
    const v = nested.parse({
      tags: ['a', 'b'],
      scores: [{ key: 'x', value: 1 }],
      pair: ['p', 2],
      when: '2026-08-16T00:00:00.000Z',
      maybe: [1, 2],
    });
    expect(v.encodeLogical()).toEqual({
      tags: ['a', 'b'],
      // `[{key, value}]` IS the map's logical JSON form, not an envelope —
      // each half is now the bare value rather than a nested `{type,value}`.
      scores: [{ key: 'x', value: 1 }],
      pair: ['p', 2],
      when: '2026-08-16T00:00:00.000Z',
      maybe: [1, 2],
    });
  });

  test('it re-parses against the declared type — the type is recovered, not carried', () => {
    const t = r.obj({ tags: { type: r.list(r.text()) } });
    const v = t.parse({ tags: ['a', 'b'] });
    expect(t.parse(v.encodeLogical()).encodeLogical()).toEqual(v.encodeLogical());
  });

  test('an absent optional is null, as everywhere else in gin', () => {
    const t = r.obj({ maybe: { type: r.optional(r.text()) } });
    expect(t.parse({}).encodeLogical()).toEqual({ maybe: null });
  });

  test('it costs exactly the logical JSON — that is the whole point', () => {
    const { r: reg, project } = projectRegistry();
    const data = rows(1000);
    const v = reg.list(project).parse(data);
    expect(JSON.stringify(v.encodeLogical()).length).toBe(JSON.stringify(data).length);
  });
});

describe('typeRefs:"name" — a reference where a definition would do', () => {
  test('a registered type is written as `{name}`, at every element', () => {
    const { r, project } = projectRegistry();
    const v = r.list(project).parse(rows(2));
    const env = v.toJSONRefs();
    expect(env.type).toEqual({ name: 'list', generic: { V: { name: 'project' } } });
    for (const cell of env.value as Array<{ type: unknown }>) {
      expect(cell.type).toEqual({ name: 'project' });
    }
  });

  test('`Registry.parseValue` already accepted this form — only the producer inlined', () => {
    const { r, project } = projectRegistry();
    const v = r.list(project).parse(rows(3));
    const back = r.parseValue(v.toJSONRefs());
    expect(back.encodeLogical()).toEqual(v.encodeLogical());
  });

  test('a per-element SUBTYPE survives it', () => {
    const { r, project, flagship } = projectRegistry();
    const raw = r.list(project).parse(rows(1)).raw as Value[];
    raw.push(flagship.parse({ id: 'b', name: 'B', budget: 2, active: false }));
    const v = r.list(project).parse(raw);

    expect((v.raw as Value[]).map((x) => x.type.name)).toEqual(['project', 'flagship']);
    const back = r.parseValue(v.toJSONRefs());
    expect((back.raw as Value[]).map((x) => x.type.name)).toEqual(['project', 'flagship']);
  });

  test('an ANONYMOUS type still writes its definition — there is no name to reference', () => {
    const r = createRegistry();
    const v = r.list(r.text()).parse(['a']);
    expect(v.toJSONRefs().type).toEqual({ name: 'list', generic: { V: { name: 'text' } } });
  });

  test('a name is matched by IDENTITY, not by string', () => {
    // A type that merely SHARES a name with a registered one would come back
    // as the registered one — a different type wearing the same label.
    const { r } = projectRegistry();
    const impostor = r.extend(r.obj({ totally: { type: r.text() } }), { name: 'project' });
    expect(impostor.toJSONRef({ typeRefs: 'name' })).not.toEqual({ name: 'project' });
  });
});

describe('toJSONLogical — the declared type ONCE, over a bare value', () => {
  test('the type is at the top and nowhere else', () => {
    const { r, project } = projectRegistry();
    const v = r.list(project).parse(rows(2));
    const env = v.toJSONLogical();
    expect(env.type).toEqual({ name: 'list', generic: { V: { name: 'project' } } });
    expect(env.value).toEqual(rows(2));
  });

  test('it round-trips through parseValue', () => {
    const { r, project } = projectRegistry();
    const v = r.list(project).parse(rows(3));
    expect(r.parseValue(v.toJSONLogical()).encodeLogical()).toEqual(v.encodeLogical());
  });

  test('the trade is stated: a per-element subtype is DEMOTED to the declared one', () => {
    const { r, project, flagship } = projectRegistry();
    const raw = r.list(project).parse(rows(1)).raw as Value[];
    raw.push(flagship.parse({ id: 'b', name: 'B', budget: 2, active: false }));
    const v = r.list(project).parse(raw);
    const back = r.parseValue(v.toJSONLogical());
    // Pay the per-element envelope (`toJSONRefs`) when this matters.
    expect((back.raw as Value[]).map((x) => x.type.name)).toEqual(['project', 'project']);
  });
});

describe('the measured cost, so "carrying the type is unaffordable" stays false', () => {
  test('at 1000 rows: logical 1.0x · toJSONLogical ~1.0x · toJSONRefs ~4x · toJSON ~7x', () => {
    const { r, project } = projectRegistry();
    const data = rows(1000);
    const v = r.list(project).parse(data);
    const logical = JSON.stringify(data).length;
    const ratio = (x: unknown) => JSON.stringify(x).length / logical;

    expect(ratio(v.encodeLogical())).toBe(1);
    // The type costs a flat ~70 bytes here, not a multiple of the payload.
    expect(ratio(v.toJSONLogical())).toBeLessThan(1.01);
    // Per-element envelopes cost, but the DEFINITION inlining is gone.
    expect(ratio(v.toJSONRefs())).toBeLessThan(5);
    expect(ratio(v.toJSONRefs())).toBeLessThan(ratio(v.toJSON()) * 0.7);
    // The default is unchanged, and this is what it costs.
    expect(ratio(v.toJSON())).toBeGreaterThan(6);
  });

  test('the definition-inlining ratio does NOT amortize, which is why it is a defect', () => {
    const { r, project } = projectRegistry();
    const ratioAt = (n: number) => {
      const data = rows(n);
      const v = r.list(project).parse(data);
      return JSON.stringify(v.toJSON()).length / JSON.stringify(data).length;
    };
    // Flat, because the cost is per ELEMENT: every element re-inlines
    // `project`'s entire definition.
    expect(ratioAt(1000)).toBeGreaterThan(ratioAt(100) * 0.8);
  });
});

describe('the DEFAULT forms are byte-identical to what gin always emitted', () => {
  const r = createRegistry();

  /** Every composite / wrapper whose `encode` now delegates to `encodeAs`.
   *  A drift here would be a silent wire-format change. */
  const cases: ReadonlyArray<readonly [string, Type, unknown]> = [
    ['list<num>', r.list(r.num()), [1, 2, 3]],
    ['list<list<text>>', r.list(r.list(r.text())), [['a'], ['b', 'c']]],
    ['obj', r.obj({ a: { type: r.text() }, b: { type: r.num() } }), { a: 'x', b: 1 }],
    ['map<text,num>', r.map(r.text(), r.num()), [{ key: 'k', value: 1 }]],
    ['tuple<text,num>', r.tuple([r.text(), r.num()]), ['a', 1]],
    ['optional<list<num>>', r.optional(r.list(r.num())), [1, 2]],
    ['nullable<obj>', r.nullable(r.obj({ a: { type: r.text() } })), { a: 'x' }],
    ['enum', r.enum({ A: 'a', B: 'b' }, r.text()), 'a'],
    ['literal', r.literal(r.text(), 'x'), 'x'],
    ['or<num,text>', r.or([r.num(), r.text()]), 'x'],
    ['and<obj,obj>', r.and([r.obj({ a: { type: r.text() } }), r.obj({ b: { type: r.num() } })]), { a: 'x', b: 1 }],
  ];

  for (const [label, type, input] of cases) {
    test(`${label}: encode() === encodeAs(envelope, definition)`, () => {
      const v = type.parse(input);
      expect(v.encode()).toEqual(
        type.encodeAs(v.raw, { form: 'envelope', typeRefs: 'definition' }),
      );
    });

    test(`${label}: toJSON() still re-parses to an equal value`, () => {
      const v = type.parse(input);
      expect(r.parseValue(v.toJSON()).encodeLogical()).toEqual(v.encodeLogical());
    });
  }

  test('an Extension carries its stored props through every form', () => {
    const W = r.extend(r.obj({ base: { type: r.text() } }), {
      name: 'W', props: { added: { type: r.num() } },
    });
    r.register(W);
    const v = W.parse({ base: 'b', added: 7 });
    expect(v.encodeLogical()).toEqual({ base: 'b', added: 7 });
    expect(r.parseValue(v.toJSON()).encodeLogical()).toEqual({ base: 'b', added: 7 });
    expect(r.parseValue(v.toJSONRefs()).encodeLogical()).toEqual({ base: 'b', added: 7 });
    expect(r.parseValue(v.toJSONLogical()).encodeLogical()).toEqual({ base: 'b', added: 7 });
  });
});
