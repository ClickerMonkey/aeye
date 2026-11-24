/**
 * Encoding code values into each model's wire shape: never mutating, sharing
 * what doesn't change, and counting what is allocated.
 */
import { describe, expect, it } from 'vitest';
import { a, ANTHROPIC_STRICT, GOOGLE_STRICT, LENIENT, MINIMAL, newStats, OPENAI_STRICT, SchemaDefinitionError, XAI_STRICT } from '../index';

const Doc = a.object({
  title: a.string(),
  rows: a.array(a.object({ id: a.int(), tags: a.array(a.string()) })),
  limits: a.record(a.number()),
  at: a.tuple([a.number(), a.number()]),
  note: a.string().optional(),
  secret: a.string().optional().forPeople(),
});
type Doc = a.infer<typeof Doc>;

const value = (): Doc => ({
  title: 't',
  rows: [{ id: 1, tags: ['x'] }, { id: 2, tags: [] }],
  limits: { food: 1, fun: 2 },
  at: [1, 2],
});

describe('encode', () => {
  it('where the wire shape is the code shape, returns the value itself (zero allocations)', () => {
    const Plain = a.object({ title: a.string(), rows: a.array(a.object({ id: a.int() })), limits: a.record(a.number()) });
    const v = { title: 't', rows: [{ id: 1 }], limits: { a: 1 } };
    for (const p of [LENIENT, GOOGLE_STRICT, XAI_STRICT]) {
      const stats = newStats();
      expect(Plain.render(p).encode(v, stats)).toBe(v);
      expect(stats).toEqual(newStats());
    }
  });

  it('allocates only on the path to a change, and shares untouched subtrees', () => {
    const v = value();
    const stats = newStats();
    const wire = Doc.render(OPENAI_STRICT).encode(v, stats) as any;
    expect(wire).toEqual({
      title: 't',
      rows: [{ id: 1, tags: ['x'] }, { id: 2, tags: [] }],
      limits: [{ key: 'food', value: 1 }, { key: 'fun', value: 2 }],
      at: { 0: 1, 1: 2 },
      note: null,
    });
    // rows have no shape change on this profile: the same array is shared.
    expect(wire.rows).toBe(v.rows);
    // 1 top object + the pairs list (1 array, 2 entry objects) + the tuple object.
    expect(stats).toEqual({ objects: 4, arrays: 1, edits: 0, parsed: 0, repaired: 0 });
    // The code value is untouched.
    expect(v).toEqual(value());
  });

  it('drops people-only fields (a model never sees them)', () => {
    const v = { ...value(), secret: 's' };
    expect('secret' in (Doc.render(LENIENT).encode(v) as object)).toBe(false);
    expect('secret' in (Doc.render(OPENAI_STRICT).encode(v) as object)).toBe(false);
  });

  it('each profile gets its own wire shape', () => {
    const v = value();
    const an = Doc.render(ANTHROPIC_STRICT).encode(v) as any;
    expect(an.limits).toEqual([{ key: 'food', value: 1 }, { key: 'fun', value: 2 }]);
    expect(an.at).toBe(v.at); // items-anyOf tuples are plain arrays
    expect('note' in an).toBe(false); // Anthropic omits
    const x = Doc.render(XAI_STRICT).encode(v) as any;
    expect(x.limits).toBe(v.limits);
  });

  it('tagged unions, JSON text and codecs', () => {
    const S = a.object({
      shape: a.discriminatedUnion('kind', [a.object({ kind: a.literal('c'), r: a.number() }), a.object({ kind: a.literal('s'), w: a.number() })]),
      any: a.json(),
      fn: a.codec(a.string(), { decode: (w) => w.replace(/__/g, '/'), encode: (q: string) => q.replace(/\//g, '__') }),
    });
    const v = { shape: { kind: 's' as const, w: 2 }, any: { a: [1] }, fn: 'sys/notes' };
    expect(S.render(MINIMAL).encode(v)).toEqual({ shape: { c: null, s: { kind: 's', w: 2 } }, any: '{"a":[1]}', fn: 'sys__notes' });
    expect(S.render(LENIENT).encode(v)).toEqual({ shape: { kind: 's', w: 2 }, any: { a: [1] }, fn: 'sys__notes' });
  });

  it('round-trips: parse(encode(v)) is v, on every profile', () => {
    for (const p of [LENIENT, OPENAI_STRICT, ANTHROPIC_STRICT, GOOGLE_STRICT, XAI_STRICT, MINIMAL]) {
      const r = Doc.render(p);
      const wire = JSON.parse(JSON.stringify(r.encode(value())));
      const back = r.parse(wire);
      expect(back.ok && back.value).toEqual(value());
    }
  });

  it('encodeAt encodes a part by code path; encodeText writes JSON text', () => {
    const r = Doc.render(OPENAI_STRICT);
    expect(r.encodeAt({ food: 3 }, 'limits')).toEqual([{ key: 'food', value: 3 }]);
    expect(r.encodeAt([4, 5], ['at'])).toEqual({ 0: 4, 1: 5 });
    expect(r.encodeAt(['a'], 'rows.*.tags')).toEqual(['a']);
    expect(r.encodeText(value().limits as never, { path: 'limits' })).toBe('[{"key":"food","value":1},{"key":"fun","value":2}]');
    expect(r.encodeText([1, 2] as never, { path: 'at', pretty: true })).toBe('{\n  "0": 1,\n  "1": 2\n}');
    expect(() => r.encodeAt(1, 'nope')).toThrow(SchemaDefinitionError);
  });

  it('the encoder needs only the value (for instruction functions, examples, injected values)', () => {
    const enc = Doc.render(ANTHROPIC_STRICT).encoder;
    expect(enc).toBe(Doc.render(ANTHROPIC_STRICT).encoder);
    expect(enc(value())).toBe('{"title":"t","rows":[{"id":1,"tags":["x"]},{"id":2,"tags":[]}],"limits":[{"key":"food","value":1},{"key":"fun","value":2}],"at":[1,2]}');
    expect(enc({ food: 1 } as never, { path: 'limits' })).toBe('[{"key":"food","value":1}]');
    expect(enc.wire([1, 2] as never, 'at')).toEqual([1, 2]);
  });

  it('examples are typed in the code shape and rendered in each model\'s shape', () => {
    const S = a.object({ limits: a.record(a.number()).example({ food: 200 }) });
    expect((S.render(OPENAI_STRICT).jsonSchema.properties as any).limits.description).toContain('Example: [{"key":"food","value":200}]');
    expect((S.render(LENIENT).jsonSchema.properties as any).limits.examples).toEqual([{ food: 200 }]);
  });
});
