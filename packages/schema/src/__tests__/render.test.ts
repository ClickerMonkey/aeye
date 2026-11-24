/**
 * Rendering + decoding per profile. The record example end to end, for a
 * strict model (pairs, nulls) and a non-strict one (open object), with the
 * copies counted.
 */
import { describe, expect, it } from 'vitest';
import { a, ANTHROPIC_STRICT, GOOGLE_STRICT, LENIENT, MINIMAL, OPENAI_STRICT, PEOPLE } from '../index';

// One schema; the prose about the record comes from the same place as its wire shape.
const Budget = a.object({
  owner: a.string().describe('Who owns the budget.'),
  limits: a
    .record(a.number().min(0))
    .describe((v) => `Spending limit per category, as ${v.recordWord}.`)
    .example({ food: 200, travel: 50 }),
  note: a.string().optional().describe('Anything else.'),
});

describe('the record example', () => {
  it('strict (OpenAI): pairs on the wire, nulls for absent; prose and examples say pairs', () => {
    const r = Budget.render(OPENAI_STRICT);
    expect(r.jsonSchema).toEqual({
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Who owns the budget.' },
        limits: {
          type: 'array',
          items: {
            type: 'object',
            properties: { key: { type: 'string' }, value: { type: 'number', minimum: 0 } },
            required: ['key', 'value'],
            additionalProperties: false,
          },
          description:
            'Spending limit per category, as a list of {key, value} entries.\n' +
            'A map written as a list of {key, value} entries; each key at most once.\n' +
            'Example: [{"key":"food","value":200},{"key":"travel","value":50}]',
        },
        // OpenAI strict spells nullable as anyOf (o3 rejects type arrays in strict tools).
        note: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'Anything else.\nWrite null to leave it out.' },
      },
      required: ['owner', 'limits', 'note'],
      additionalProperties: false,
    });

    const wire = { owner: 'ann', limits: [{ key: 'food', value: 200 }, { key: 'fun', value: 10 }], note: null };
    const res = r.parse(wire);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // Decoded IN PLACE: same top object, the pairs became one new record, the null key is GONE.
    expect(res.value).toBe(wire);
    expect(res.value).toEqual({ owner: 'ann', limits: { food: 200, fun: 10 } });
    expect('note' in res.value).toBe(false);
    expect(res.stats).toEqual({ objects: 1, arrays: 0, edits: 2, parsed: 0, repaired: 0 });
  });

  it('non-strict (lenient/Google): open object on the wire, zero copies, same reference', () => {
    for (const profile of [LENIENT, GOOGLE_STRICT]) {
      const r = Budget.render(profile);
      const limits = r.jsonSchema.properties as Record<string, Record<string, unknown>>;
      expect(limits.limits!.type).toBe('object');
      expect(limits.limits!.additionalProperties).toEqual({ type: 'number', minimum: 0 });
      expect(String(limits.limits!.description)).toContain('Spending limit per category, as an object.');
      expect(r.jsonSchema.required).toEqual(['owner', 'limits']);

      const wire = { owner: 'ann', limits: { food: 200 } };
      const res = r.parse(wire);
      expect(res.ok && res.value).toBe(wire);
      expect(res.stats).toEqual({ objects: 0, arrays: 0, edits: 0, parsed: 0, repaired: 0 });
    }
  });

  it('errors are reported where the MODEL wrote them, plus the code path', () => {
    const strict = Budget.render(OPENAI_STRICT).parse({ owner: 'ann', limits: [{ key: 'food', value: -5 }, { key: 'food', value: 1 }], note: null });
    expect(strict.ok).toBe(false);
    if (strict.ok) return;
    expect(strict.issues.map((i) => [i.path, i.codePath, i.message])).toEqual([
      [['limits', 0, 'value'], ['limits', 'food'], 'Must be at least 0.'],
      [['limits', 1, 'key'], ['limits'], 'Duplicate key "food".'],
    ]);
    expect(strict.message).toBe('- at limits[0].value: Must be at least 0.\n- at limits[1].key: Duplicate key "food".');

    const lenient = Budget.render(LENIENT).parse({ owner: 'ann', limits: { food: -5 } });
    expect(!lenient.ok && lenient.issues[0]!.path).toEqual(['limits', 'food']);
  });

  it('copy-on-write mode leaves the input untouched and clones only the changed spine', () => {
    const wire = { owner: 'ann', limits: [{ key: 'food', value: 1 }], note: null, untouched: { deep: [1, 2, 3] } };
    const res = Budget.render(OPENAI_STRICT).parse(wire, { inPlace: false });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(wire.limits).toEqual([{ key: 'food', value: 1 }]); // input not mutated
    expect(wire.note).toBeNull();
    expect(res.value).not.toBe(wire);
    expect((res.value as unknown as typeof wire).untouched).toBe(wire.untouched); // shared, not copied
    expect(res.stats).toEqual({ objects: 2, arrays: 0, edits: 0, parsed: 0, repaired: 0 }); // 1 record + 1 clone of the top object
  });

  it('encode turns code values into each model shape (few-shot / echo)', () => {
    const v = { owner: 'ann', limits: { food: 1 } };
    expect(Budget.render(OPENAI_STRICT).encode(v)).toEqual({ owner: 'ann', limits: [{ key: 'food', value: 1 }], note: null });
    expect(Budget.render(LENIENT).encode(v)).toEqual(v);
  });

  it('is memoized per (schema, profile) and the parse path allocates nothing for untouched subtrees', () => {
    expect(Budget.render(OPENAI_STRICT)).toBe(Budget.render(OPENAI_STRICT));
    expect(Budget.render(OPENAI_STRICT).jsonSchema).toBe(Budget.render(OPENAI_STRICT).jsonSchema);
    const Big = a.object({ rows: a.array(a.object({ id: a.int(), name: a.string(), tags: a.array(a.string()) })) });
    const wire = { rows: Array.from({ length: 1000 }, (_, i) => ({ id: i, name: `n${i}`, tags: ['x'] })) };
    const res = Big.render(OPENAI_STRICT).parse(wire);
    expect(res.ok && res.value).toBe(wire);
    expect(res.stats).toEqual({ objects: 0, arrays: 0, edits: 0, parsed: 0, repaired: 0 });
  });
});

describe('profiles', () => {
  const Shape = a.discriminatedUnion('kind', [
    a.object({ kind: a.literal('circle'), r: a.number() }),
    a.object({ kind: a.literal('rect'), w: a.number(), h: a.number() }),
  ]);

  it('anyOf where supported; tagged object where not (MINIMAL)', () => {
    expect(Shape.render(LENIENT).jsonSchema.anyOf).toHaveLength(2);
    const m = Shape.render(MINIMAL);
    expect(m.jsonSchema.type).toBe('object');
    expect(Object.keys(m.jsonSchema.properties as object)).toEqual(['circle', 'rect']);
    const res = m.parse({ circle: { kind: 'circle', r: 2 }, rect: null });
    expect(res.ok && res.value).toEqual({ kind: 'circle', r: 2 });
    expect(m.encode({ kind: 'rect', w: 1, h: 2 })).toEqual({ circle: null, rect: { kind: 'rect', w: 1, h: 2 } });
    const bad = m.parse({ circle: null, rect: null });
    expect(!bad.ok && bad.message).toContain('Fill exactly one of: circle, rect');
  });

  it('discriminated union errors point at the tag (a union root is wrapped as {input} where the root must be an object)', () => {
    const res = Shape.render(OPENAI_STRICT).parse({ input: { kind: 'hex', r: 1 } });
    expect(!res.ok && res.issues[0]).toMatchObject({ path: ['input', 'kind'], codePath: ['kind'] });
    expect(!Shape.render(LENIENT).parse({ kind: 'hex', r: 1 }).ok).toBe(true);
  });

  it('recursion: $ref where allowed, JSON-text escape where not (Anthropic), inline+escape with no $defs (MINIMAL)', () => {
    const Tree = a
      .define({ Node: a.object({ value: a.number(), tags: a.record(a.string()), children: a.array(a.ref('Node')) }) })
      .result('Node');

    const o = Tree.render(OPENAI_STRICT).jsonSchema;
    expect((o.properties as any).children.items).toEqual({ $ref: '#/$defs/Node' });
    expect(Object.keys(o.$defs as object)).toEqual(['Node']);

    // Anthropic strict: no cycles. The back-edge is a string of JSON text in the CODE shape,
    // described with a TypeScript type, validated by the same schema.
    const an = Tree.render(ANTHROPIC_STRICT);
    const child = (an.jsonSchema.$defs as any).Node.properties.children.items;
    expect(child.type).toBe('string');
    expect(child.description).toContain('Write it as JSON text of this TypeScript type: Node');
    // The TypeScript definitions are written ONCE, in the whole schema's description.
    expect(an.jsonSchema.description).toContain('type Node = { value: number; tags: { [key: string]: string }; children: Node[] }');
    const res = an.parse({ value: 1, tags: [{ key: 'a', value: 'b' }], children: ['{"value":2,"tags":{"x":"y"},"children":[]}'] });
    expect(res.ok && res.value).toEqual({ value: 1, tags: { a: 'b' }, children: [{ value: 2, tags: { x: 'y' }, children: [] }] });
    expect(res.stats).toEqual({ objects: 1, arrays: 0, edits: 2, parsed: 1, repaired: 0 });
    const bad = an.parse({ value: 1, tags: [], children: ['{"value":"two","tags":{},"children":[]}'] });
    expect(!bad.ok && bad.issues[0]).toMatchObject({ path: ['children', 0, '(json)', 'value'], codePath: ['children', 0, 'value'] });

    const m = Tree.render(MINIMAL).jsonSchema;
    expect(m.$defs).toBeUndefined();
    expect((m.properties as any).children.items.type).toBe('string');
  });

  it('enum over the dialect cap is widened, never truncated, and still enforced', () => {
    const Pick = a.object({ fn: a.enum(Array.from({ length: 50 }, (_, i) => `fn_${i}`) as [string, ...string[]]) });
    const g = Pick.render(GOOGLE_STRICT);
    const fn = (g.jsonSchema.properties as any).fn;
    expect(fn.enum).toBeUndefined();
    expect(fn.description).toContain('fn_49');
    expect(g.parse({ fn: 'nope' }).ok).toBe(false);
    expect(g.parse({ fn: 'fn_49' }).ok).toBe(true);
  });

  it('constraints the dialect lacks become words; refinements are shown and enforced', () => {
    const Range = a
      .object({ start: a.int(), end: a.int().max(100) })
      .refine((v) => v.start <= v.end, 'start must not be after end.');
    const an = Range.render(ANTHROPIC_STRICT).jsonSchema;
    expect((an.properties as any).end).toEqual({ type: 'integer', description: 'At most 100.' });
    expect(an.description).toBe('Rules: start must not be after end.');
    const bad = Range.render(ANTHROPIC_STRICT).parse({ start: 5, end: 1 });
    expect(!bad.ok && bad.message).toBe('- at (root): start must not be after end.');
  });

  it('people-only fields are invisible to and refused from models; people see everything', () => {
    const Args = a.object({
      text: a.string(),
      inject: a.boolean().optional().forPeople(),
      clear: a.enum(['all', 'notes', 'secrets']).forModels(a.enum(['all', 'notes'])),
    });
    const m = Args.render(OPENAI_STRICT).jsonSchema;
    expect(Object.keys(m.properties as object)).toEqual(['text', 'clear']);
    expect((m.properties as any).clear.enum).toEqual(['all', 'notes']);
    expect(Args.render(OPENAI_STRICT).parse({ text: 'x', clear: 'notes', inject: true }).ok).toBe(false);
    expect(Args.render(OPENAI_STRICT).parse({ text: 'x', clear: 'secrets' }).ok).toBe(false);
    const p = Args.render(PEOPLE);
    expect(Object.keys(p.jsonSchema.properties as object)).toEqual(['text', 'inject', 'clear']);
    expect(p.parse({ text: 'x', clear: 'secrets', inject: true }).ok).toBe(true);
  });

  it('tuples: numeric-key object for OpenAI strict, prefixItems elsewhere', () => {
    const P = a.object({ at: a.tuple([a.number(), a.number()]) });
    const o = P.render(OPENAI_STRICT);
    expect((o.jsonSchema.properties as any).at.properties).toEqual({ 0: { type: 'number' }, 1: { type: 'number' } });
    const res = o.parse({ at: { 0: 1, 1: 2 } });
    expect(res.ok && res.value).toEqual({ at: [1, 2] });
    expect(res.stats.arrays).toBe(1);
    expect((P.render(LENIENT).jsonSchema.properties as any).at.prefixItems).toHaveLength(2);
  });

  it('any JSON: {} where allowed, JSON text where not', () => {
    const P = a.object({ value: a.json() });
    expect((P.render(LENIENT).jsonSchema.properties as any).value).toEqual({});
    const o = P.render(OPENAI_STRICT);
    expect((o.jsonSchema.properties as any).value.type).toBe('string');
    const res = o.parse({ value: '{"a":[1]}' });
    expect(res.ok && res.value).toEqual({ value: { a: [1] } });
  });

  it('codecs map model spellings to code values both ways', () => {
    const FnName = a.codec(a.string().pattern(/^[a-z]\S*$/), {
      decode: (w) => (w.includes('__') ? w.replace(/__/g, '/') : new Error(`Unknown fn "${w}".`)),
      encode: (q: string) => q.replace(/\//g, '__'),
    });
    const P = a.object({ fn: FnName });
    const r = P.render(OPENAI_STRICT);
    expect(r.parse({ fn: 'sys__notes' })).toMatchObject({ ok: true, value: { fn: 'sys/notes' } });
    expect(r.parse({ fn: 'bogus' })).toMatchObject({ ok: false, message: '- at fn: Unknown fn "bogus".' });
    expect(r.encode({ fn: 'sys/notes' })).toEqual({ fn: 'sys__notes' });
  });
});
