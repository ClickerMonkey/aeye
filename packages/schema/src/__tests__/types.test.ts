/**
 * The types added for full coverage — intersections, `not`, if/then/else,
 * sibling-typed values, extra keys — plus root wrapping, optional+nullable
 * under strict profiles, and auto-repair. Each per profile, with both paths
 * on errors.
 */
import { describe, expect, it } from 'vitest';
import {
  a, ANTHROPIC_STRICT, fromGin, GOOGLE_STRICT, LENIENT, MINIMAL, OPENAI_STRICT, PEOPLE, SchemaDefinitionError, SchemaParseError,
  Rejection, XAI_STRICT, type AnySchema, type GinTypeDef,
} from '../index';
import { lines } from './_lines';

describe('intersection (allOf, gin and)', () => {
  const Named = a.object({ name: a.string() });
  const Dated = a.object({ at: a.string().format('date'), note: a.string().optional() }).refine((v) => v.at > '2000', 'Dates after 2000.');
  const Both = a.intersection([Named, Dated]);

  it('objects merge into one object every dialect can say; member rules still run', () => {
    for (const p of [OPENAI_STRICT, ANTHROPIC_STRICT, MINIMAL, LENIENT]) {
      const js = Both.render(p).jsonSchema as any;
      expect(js.allOf).toBeUndefined();
      expect(Object.keys(js.properties)).toEqual(['name', 'at', 'note']);
    }
    const r = Both.render(OPENAI_STRICT);
    expect(r.parse({ name: 'a', at: '2024-01-02', note: null })).toMatchObject({ ok: true, value: { name: 'a', at: '2024-01-02' } });
    const bad = r.parse({ name: 'a', at: '1999-01-02', note: null });
    expect(lines(bad)).toBe('- at (root): Dates after 2000.');
  });

  it('merges through refs to named objects', () => {
    const B = a.define({ N: Named, D: Dated }).result(a.object({ both: a.intersection([a.ref('N'), a.ref('D')]) }));
    expect(Object.keys((B.render(LENIENT).jsonSchema as any).properties.both.properties)).toEqual(['name', 'at', 'note']);
  });

  it('non-objects: allOf where the dialect has it, else the first member plus words; always validated', () => {
    const S = a.object({ code: a.intersection([a.string().pattern('^[A-Z]+$'), a.string().max(3)]) });
    expect((S.render(LENIENT).jsonSchema.properties as any).code.allOf).toHaveLength(2);
    const o = (S.render(OPENAI_STRICT).jsonSchema.properties as any).code;
    expect(o.allOf).toBeUndefined();
    expect(o.pattern).toBe('^[A-Z]+$');
    expect(o.description).toBe('Must also be: string.');
    expect(S.render(OPENAI_STRICT).parse({ code: 'ABCD' })).toMatchObject({ ok: false, issues: [{ path: ['code'], message: 'Must be at most 3 characters.' }] });
    expect(S.render(OPENAI_STRICT).parse({ code: 'ABC' }).ok).toBe(true);
  });

  it('gin and<A, B> becomes the merged object', () => {
    const def = { name: 'and', options: { types: [
      { name: 'obj', props: { a: { type: { name: 'num' } } } },
      { name: 'obj', props: { b: { type: { name: 'text' } } } },
    ] } } as const satisfies GinTypeDef;
    const s = fromGin(def);
    expect(Object.keys((s.render(OPENAI_STRICT).jsonSchema as any).properties)).toEqual(['a', 'b']);
  });
});

describe('not and if/then/else', () => {
  it('not: words on strict dialects, the keyword on lenient, validated on the decoded value', () => {
    const S = a.object({ v: a.not(a.literal('forbidden'), a.string()) });
    expect((S.render(OPENAI_STRICT).jsonSchema.properties as any).v).toEqual({ type: 'string', description: 'Must not be: "forbidden".' });
    expect((S.render(LENIENT).jsonSchema.properties as any).v).toEqual({ type: 'string', not: { type: 'string', enum: ['forbidden'] } });
    expect(lines(S.render(OPENAI_STRICT).parse({ v: 'forbidden' }))).toBe('- at v: Must not be: "forbidden".');
    expect(S.render(OPENAI_STRICT).parse({ v: 'fine' }).ok).toBe(true);
  });

  it('gin not<num> accepts anything but a number', () => {
    const s = a.object({ x: fromGin({ name: 'not', options: { excluded: { name: 'num' } } }) });
    expect(s.render(LENIENT).parse({ x: 'a' }).ok).toBe(true);
    expect(s.render(LENIENT).parse({ x: 3 }).ok).toBe(false);
  });

  it('if/then/else: words where unsupported, keywords on lenient, enforced either way', () => {
    const Ship = a.conditional(a.object({ country: a.string(), postcode: a.string() }), {
      if: a.object({ country: a.literal('US') }),
      then: a.object({ postcode: a.string().pattern('^\\d{5}$') }),
      else: a.object({ postcode: a.string().min(3) }),
    });
    const words = Ship.render(ANTHROPIC_STRICT).jsonSchema.description;
    expect(words).toBe('If it is { country: "US" }, it must also be { postcode: string }. Otherwise, it must be { postcode: string }.');
    const l = Ship.render(LENIENT).jsonSchema as any;
    expect(l.if.properties.country.enum).toEqual(['US']);
    expect(l.then.properties.postcode.pattern).toBe('^\\d{5}$');
    expect(Ship.render(ANTHROPIC_STRICT).parse({ country: 'US', postcode: 'abc' }).ok).toBe(false);
    expect(Ship.render(ANTHROPIC_STRICT).parse({ country: 'US', postcode: '12345' }).ok).toBe(true);
    expect(Ship.render(ANTHROPIC_STRICT).parse({ country: 'FR', postcode: 'ab' }).ok).toBe(false);
  });
});

describe('a value typed by a sibling field (create_var {type, value})', () => {
  const kinds: Record<string, AnySchema> = {
    num: a.number(),
    text: a.string(),
    map: a.record(a.number()),
  };
  const CreateVar = a.object({ name: a.string(), type: a.enum(['num', 'text', 'map']) })
    .dependent('value', 'type', (t) => kinds[t]);

  it('the model sees any JSON (JSON text on strict), told where its type comes from', () => {
    const o = (CreateVar.render(OPENAI_STRICT).jsonSchema.properties as any).value;
    expect(o.type).toBe('string');
    expect(o.description).toBe('Write the value as JSON text.\nIts type is given by "type".');
    expect((CreateVar.render(LENIENT).jsonSchema.properties as any).value).toEqual({ description: 'Its type is given by "type".' });
  });

  it('decodes in the code shape and checks against the type the model just wrote', () => {
    const r = CreateVar.render(OPENAI_STRICT);
    expect(r.parse({ name: 'n', type: 'num', value: '5' })).toMatchObject({ ok: true, value: { name: 'n', type: 'num', value: 5 } });
    // The value is in the CODE shape (a record is an object even on a pairs dialect).
    expect(r.parse({ name: 'm', type: 'map', value: '{"a":1}' })).toMatchObject({ ok: true, value: { value: { a: 1 } } });
    const bad = r.parse({ name: 'n', type: 'num', value: '"five"' });
    expect(!bad.ok && bad.issues).toEqual([{ path: ['value'], codePath: ['value'], message: 'Expected a number, got string.' }]);
    const lenient = CreateVar.render(LENIENT).parse({ name: 'm', type: 'map', value: { a: 'x' } });
    expect(!lenient.ok && lenient.issues[0]).toMatchObject({ path: ['value', 'a'], codePath: ['value', 'a'] });
  });

  it('the sibling may name a type of the current bind (a registry\'s named types), never a stale one', () => {
    const Var = a.define({ Var: a.object({ type: a.string() }).dependent('value', 'type', (t) => a.ref(t)) })
      .dynamic((version: number) => ({ Amount: version === 1 ? a.number() : a.string() }) as { readonly [name: string]: AnySchema })
      .result('Var');
    expect(Var.bind(1).render(LENIENT).parse({ type: 'Amount', value: 5 }).ok).toBe(true);
    expect(Var.bind(2).render(LENIENT).parse({ type: 'Amount', value: 5 }).ok).toBe(false);
    expect(Var.bind(2).render(LENIENT).parse({ type: 'Amount', value: '5' }).ok).toBe(true);
  });

  it('a.dependent also works inside a plain shape', () => {
    const S = a.object({ kind: a.enum(['n']), v: a.dependent('kind', () => a.int()) });
    expect(S.render(LENIENT).parse({ kind: 'n', v: 1.5 }).ok).toBe(false);
  });
});

describe('extra keys (rest / patternProperties)', () => {
  const Headers = a.object({ id: a.string() }).rest(a.number());
  const Ext = a.object({ id: a.string() }).patterns({ '^x-': a.string() });

  it('open dialects: additionalProperties / patternProperties', () => {
    expect((Headers.render(LENIENT).jsonSchema as any).additionalProperties).toEqual({ type: 'number' });
    expect((Headers.render(XAI_STRICT).jsonSchema as any).additionalProperties).toEqual({ type: 'number' });
    expect((Ext.render(LENIENT).jsonSchema as any).patternProperties).toEqual({ '^x-': { type: 'string' } });
    expect(Headers.render(LENIENT).parse({ id: 'a', n: 1 }).ok).toBe(true);
    expect(Headers.render(LENIENT).parse({ id: 'a', n: 'x' })).toMatchObject({ ok: false, issues: [{ path: ['n'] }] });
    expect(Ext.render(LENIENT).parse({ id: 'a', 'x-y': 'z' }).ok).toBe(true);
    // Other keys are left alone (as on any object) unless the object is strict.
    expect(Ext.render(LENIENT).parse({ id: 'a', other: 1 }).ok).toBe(true);
    expect(lines(Ext.strict().render(LENIENT).parse({ id: 'a', other: 1 }))).toBe('- at other: Unknown field "other".');
    expect((Ext.strict().render(LENIENT).jsonSchema as any).additionalProperties).toBe(false);
  });

  it('Gemini (open, no patternProperties): one additionalProperties, the patterns said in words, enforced by key', () => {
    const js = Ext.render(GOOGLE_STRICT).jsonSchema as any;
    expect(js.patternProperties).toBeUndefined();
    expect(js.additionalProperties).toEqual({ type: 'string' });
    expect(js.description).toContain('keys matching /^x-/');
  });

  it('pairs dialects: extra keys go in an "extra" list and are moved back onto the object', () => {
    const r = Headers.render(OPENAI_STRICT);
    const js = r.jsonSchema as any;
    expect(Object.keys(js.properties)).toEqual(['id', 'extra']);
    expect(js.additionalProperties).toBe(false);
    const wire = { id: 'a', extra: [{ key: 'n', value: 1 }, { key: 'm', value: 2 }] };
    const res = r.parse(wire);
    expect(res.ok && res.value).toBe(wire);
    expect(res.ok && res.value).toEqual({ id: 'a', n: 1, m: 2 });
    expect(r.encode({ id: 'a', n: 1 } as never)).toEqual({ id: 'a', extra: [{ key: 'n', value: 1 }] });
    const dup = r.parse({ id: 'a', extra: [{ key: 'id', value: 1 }] });
    expect(!dup.ok && dup.issues[0]).toMatchObject({ path: ['extra', 0, 'key'], message: 'Duplicate key "id".' });
    const badv = r.parse({ id: 'a', extra: [{ key: 'n', value: 'x' }] });
    expect(!badv.ok && badv.issues[0]).toMatchObject({ path: ['extra', 0, 'value'], codePath: ['n'] });
  });

  it('gin iface is an open object with its declared props', () => {
    const s = fromGin({ name: 'iface', props: { title: { type: { name: 'text' } } } });
    expect(s.render(LENIENT).parse({ title: 't', more: 1 }).ok).toBe(true);
    expect(s.render(LENIENT).parse({ more: 1 }).ok).toBe(false);
  });
});

describe('roots that are not objects', () => {
  const List = a.array(a.string());

  it('are wrapped as {input} where the profile needs an object root, unwrapped on decode without a copy', () => {
    const r = List.render(OPENAI_STRICT);
    expect(r.wrapped).toBe(true);
    expect(r.jsonSchema).toEqual({ type: 'object', properties: { input: { type: 'array', items: { type: 'string' } } }, required: ['input'], additionalProperties: false });
    const inner = ['a', 'b'];
    const res = r.parse({ input: inner });
    expect(res.ok && res.value).toBe(inner);
    expect(r.encode(['x'])).toEqual({ input: ['x'] });
    const bad = r.parse({ input: [1] });
    expect(!bad.ok && bad.issues[0]).toMatchObject({ path: ['input', 0], codePath: [0] });
    expect(lines(r.parse(['a']))).toBe('- at (root): Expected an object with an "input" field.');
  });

  it('stay as they are where any root is fine', () => {
    expect(List.render(LENIENT).wrapped).toBe(false);
    expect(List.render(LENIENT).jsonSchema).toEqual({ type: 'array', items: { type: 'string' } });
    expect(a.object({ x: a.string() }).render(OPENAI_STRICT).wrapped).toBe(false);
  });
});

describe('optional + nullable under strict (null-for-absent) profiles', () => {
  const S = a.object({ maybe: a.string().optional(), either: a.string().nullable().optional(), always: a.string().nullable() });

  it('an optional is written null for absent; an optional nullable keeps null as null (absent is never produced)', () => {
    const r = S.render(OPENAI_STRICT);
    const props = r.jsonSchema.properties as any;
    expect(props.maybe.description).toBe('Write null to leave it out.');
    expect(r.jsonSchema.required).toEqual(['maybe', 'either', 'always']);
    const res = r.parse({ maybe: null, either: null, always: null });
    expect(res.ok && res.value).toEqual({ either: null, always: null });
    expect(res.ok && 'maybe' in res.value).toBe(false);
  });

  it('a profile that can omit keeps both meanings apart', () => {
    const res = S.render(ANTHROPIC_STRICT).parse({ either: null, always: null });
    expect(res.ok && res.value).toEqual({ either: null, always: null });
    expect(S.render(ANTHROPIC_STRICT).parse({ always: null }).ok).toBe(true);
  });

  it('a standalone optional (not in an object) decodes null to undefined, nullable inner keeps null', () => {
    const r = a.object({ xs: a.array(a.number().optional()), ys: a.array(a.number().nullable().optional()) }).render(OPENAI_STRICT);
    expect(r.parse({ xs: [1, null], ys: [null] })).toMatchObject({ ok: true, value: { xs: [1, undefined], ys: [null] } });
  });
});

describe('auto-repair', () => {
  const S = a.object({ tags: a.record(a.number()), list: a.array(a.string()), meta: a.object({ k: a.string() }), raw: a.json() });

  it('a container sent as a JSON string (or double-encoded) is parsed and counted', () => {
    const wire = { tags: '{"a":1}', list: '"[\\"x\\"]"', meta: '{"k":"v"}', raw: 3 };
    const res = S.render(LENIENT).parse(wire);
    expect(res.ok && res.value).toEqual({ tags: { a: 1 }, list: ['x'], meta: { k: 'v' }, raw: 3 });
    expect(res.stats.repaired).toBe(3);
  });

  it('pairs sent as a string, and a value sent where JSON text was asked for', () => {
    const res = S.render(OPENAI_STRICT).parse({ tags: '[{"key":"a","value":1}]', list: [], meta: { k: 'v' }, raw: { direct: true } });
    expect(res.ok && res.value).toEqual({ tags: { a: 1 }, list: [], meta: { k: 'v' }, raw: { direct: true } });
    expect(res.stats).toMatchObject({ repaired: 2, objects: 1 });
  });

  it('can be turned off; a string that is not the expected container is left for the normal error', () => {
    const off = S.render(LENIENT).parse({ tags: '{"a":1}', list: [], meta: { k: 'v' }, raw: 1 }, { repair: false });
    expect(!off.ok && off.issues[0]).toMatchObject({ path: ['tags'], message: 'Expected an object, got string.' });
    const wrong = S.render(LENIENT).parse({ tags: '[1]', list: [], meta: { k: 'v' }, raw: 1 });
    expect(!wrong.ok && wrong.issues[0]).toMatchObject({ path: ['tags'] });
  });
});

describe('errors', () => {
  it('parseOrThrow throws a SchemaParseError carrying both paths', () => {
    const r = a.object({ limits: a.record(a.number().min(0)) }).render(OPENAI_STRICT);
    try {
      r.parseOrThrow({ limits: [{ key: 'food', value: -1 }] });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(SchemaParseError);
      expect((e as SchemaParseError).issues).toEqual([{ path: ['limits', 0, 'value'], codePath: ['limits', 'food'], message: 'Must be at least 0.' }]);
      // The error's message is the model's message (the default format: markers at the pair the model wrote).
      expect((e as Error).message).toContain('limits[0].value: Must be at least 0.');
      expect((e as Error).message).toContain('^');
    }
    expect(r.parseOrThrow({ limits: [] })).toEqual({ limits: {} });
  });

  it('definition mistakes are SchemaDefinitionErrors', () => {
    const Loose = a.define({ A: a.object({ x: a.number() }) });
    expect(() => Loose.define({ A: a.string() } as never)).toThrow(SchemaDefinitionError);
    const Dyn = a.define({ A: a.object({ b: a.ref('B') }) }).dynamic(() => ({ B: a.string(), A: a.number() } as never)).result('A');
    expect(() => Dyn.bind()).toThrow('the dynamic step redefined "A"');
    const Bad = a.object({ n: a.number().example('nope' as never) });
    expect(() => Bad.render(LENIENT).jsonSchema).toThrow(SchemaDefinitionError);
    expect(() => Bad.render(OPENAI_STRICT).jsonSchema).toThrow(/example "nope" does not fit/);
  });

  it('people see every field and every enum member', () => {
    const S = a.object({ who: a.enum(['me', 'admin']).forModels(a.enum(['me'])), secret: a.string().optional().forPeople() });
    expect(S.render(PEOPLE).parse({ who: 'admin', secret: 's' }).ok).toBe(true);
    expect(S.render(OPENAI_STRICT).parse({ who: 'admin' }).ok).toBe(false);
  });
});

describe('problems below a value (refine / codec Rejection)', () => {
  const Row = a.object({ name: a.string(), tags: a.array(a.string()) });
  const Rows = a.object({ rows: a.array(Row) });

  it('a refinement reports at paths below the value it checks', () => {
    const Checked = Rows.refine((v) => v.rows.flatMap((r, i) => (r.name === 'x' ? [{ path: ['rows', i, 'name'], message: 'No x.' }] : [])));
    const r = Checked.render(OPENAI_STRICT);
    const bad = r.parse({ rows: [{ name: 'a', tags: [] }, { name: 'x', tags: [] }] });
    expect(bad.ok).toBe(false);
    expect(lines(bad)).toBe('- at rows[1].name: No x.');
    if (!bad.ok) {
      expect(bad.issues[0]!.codePath).toEqual(['rows', 1, 'name']);
      expect(bad.message).toContain('^');
    }
  });

  it('a codec rejects with problems at paths; an empty Rejection still fails; a valid value decodes', () => {
    const Parsed = a.codec(Rows, {
      decode: (v) => {
        const issues = v.rows.flatMap((r, i) => r.tags.flatMap((t, j) => (t === '' ? [{ path: ['rows', i, 'tags', j], message: 'Empty tag.' }] : [])));
        return issues.length ? new Rejection(issues) : { count: v.rows.length };
      },
      encode: () => ({ rows: [] }),
    });
    for (const p of [OPENAI_STRICT, LENIENT, ANTHROPIC_STRICT]) {
      const r = Parsed.render(p);
      expect(r.parse({ rows: [{ name: 'a', tags: ['b'] }] })).toMatchObject({ ok: true, value: { count: 1 } });
      const bad = r.parse({ rows: [{ name: 'a', tags: ['b', ''] }, { name: 'c', tags: [''] }] });
      expect(lines(bad)).toBe('- at rows[0].tags[1]: Empty tag.\n- at rows[1].tags[0]: Empty tag.');
    }
    const Never = a.codec(a.string(), { decode: () => new Rejection([]), encode: (v: string) => v });
    expect(Never.render(LENIENT).parse('a').ok).toBe(false);
  });
});
