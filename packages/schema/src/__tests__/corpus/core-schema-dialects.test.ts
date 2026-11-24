/**
 * @aeye/core's dialect matrix (packages/core/src/schema/dialects/*,
 * __tests__/schema-formats.test.ts, schema-any.test.ts, schema-no-defs.test.ts,
 * schema-enum-cap.test.ts, descriptor-consistency.test.ts) reproduced with
 * @aeye/schema profiles: object/record/tuple/intersection encodings, "any",
 * string formats, constraints, propertyOrdering, recursion (core's cycle
 * breaker), no-$defs dialects, enum caps, and profile lookups.
 *
 * Deliberate differences from core are marked DELIBERATE; gaps are
 * `it.fails('GAP: ...')`.
 */
import { describe, expect, it } from 'vitest';
import {
  a, ANTHROPIC_NON_STRICT, ANTHROPIC_STRICT, familyProfile, getProfile, GOOGLE_NON_STRICT, GOOGLE_OPENAPI, GOOGLE_STRICT, LENIENT,
  MINIMAL, ModelProfile, OLLAMA, OPENAI_NON_STRICT, OPENAI_STRICT, registerProfile, XAI_NON_STRICT, XAI_STRICT,
  type JsonSchema, type Profile,
} from '../../index';
import { asTool, dialectProblems, MODEL_PROFILES, profileProblems, validate } from './_check';
import * as S from './core-schema';
import { lines } from '../_lines';

type J = Record<string, any>;
const props = (j: JsonSchema): J => j.properties as J;
const render = (s: { render(p: Profile): { jsonSchema: JsonSchema } }, p: Profile) => s.render(p).jsonSchema as J;
const NO_COPIES = { objects: 0, arrays: 0, edits: 0, parsed: 0, repaired: 0 };
const NOT_XAI = MODEL_PROFILES.filter((p) => p.family !== 'xai');
/** An enum as a field (tool roots are objects). */
const field = (values: [string, ...string[]], p: Profile): J => props(render(a.object({ v: a.enum(values) }), p)).v;

/** Every keyword used anywhere in a schema (core:schema-any.test.ts:161). */
const keywordsIn = (node: unknown, into = new Set<string>()): Set<string> => {
  if (Array.isArray(node)) for (const x of node) keywordsIn(x, into);
  else if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) { into.add(k); keywordsIn(v, into); }
  return into;
};
/** Every `$ref` value (core:schema-formats.test.ts:625). */
const refsIn = (node: unknown): string[] => {
  const out: string[] = [];
  JSON.stringify(node, (k, v) => { if (k === '$ref') out.push(v); return v; });
  return out;
};
/** `$defs` entries nothing points at. */
const unusedDefs = (js: J): string[] => {
  const used = new Set(refsIn(js).map((r) => r.replace('#/$defs/', '')));
  return Object.keys(js.$defs ?? {}).filter((n) => !used.has(n));
};

// ============================================================================
// schema-formats.test.ts — the descriptor matrix
// ============================================================================

describe('profile lookups (core:schema-formats.test.ts:31-76)', () => {
  it('strict and loose profile per family; unknown families are LENIENT', () => {
    expect(familyProfile('openai', true)).toBe(OPENAI_STRICT);
    expect(familyProfile('anthropic', true)).toBe(ANTHROPIC_STRICT);
    expect(familyProfile('google', true)).toBe(GOOGLE_STRICT);
    expect(familyProfile('xai', true)).toBe(XAI_STRICT);
    expect(familyProfile('openai', false)).toBe(OPENAI_NON_STRICT);
    expect(familyProfile('anthropic', false)).toBe(ANTHROPIC_NON_STRICT);
    expect(familyProfile('google', false)).toBe(GOOGLE_NON_STRICT);
    expect(familyProfile('xai', false)).toBe(XAI_NON_STRICT);
    expect(familyProfile('unregistered-family', true)).toBe(LENIENT);
    expect(familyProfile('unregistered-family', false)).toBe(LENIENT);
  });

  it('by id round-trips; DELIBERATE: an unknown id is undefined, not LENIENT', () => {
    for (const p of [OPENAI_STRICT, ANTHROPIC_STRICT, GOOGLE_STRICT, LENIENT, XAI_STRICT]) expect(getProfile(p.id)).toBe(p);
    expect(getProfile('unknown-id')).toBeUndefined();
  });

  it('a custom profile is reachable by id and family, and renders (core:schema-formats.test.ts:456-545)', () => {
    const MINE: Profile = Object.freeze({ ...OPENAI_STRICT, id: 'my-provider-strict', family: 'my-provider', records: 'open', tuples: 'prefixItems', closedObjects: false });
    registerProfile(MINE);
    expect(getProfile('my-provider-strict')).toBe(MINE);
    expect(familyProfile('my-provider', true)).toBe(MINE);
    const js = render(S.TagsPair, MINE);
    expect(props(js).tags).toEqual({ type: 'object', additionalProperties: { type: 'string' } });
    expect(props(js).pair.prefixItems).toHaveLength(2);
    expect(S.TagsPair.render(MINE).parse({ tags: { a: 'b' }, pair: ['x', 1] })).toMatchObject({ ok: true, stats: NO_COPIES });
  });
});

describe('object encoding (core:schema-formats.test.ts:78-111)', () => {
  it('OpenAI strict: every field required, closed', () => {
    const js = render(S.NameAge, OPENAI_STRICT);
    expect(js.required).toEqual(['name', 'age']);
    expect(js.additionalProperties).toBe(false);
    expect(props(js).age.anyOf).toEqual([{ type: 'number' }, { type: 'null' }]);
  });
  it('Anthropic strict: optional left out of required, closed', () => {
    const js = render(S.NameAge, ANTHROPIC_STRICT);
    expect(js.required).toEqual(['name']);
    expect(js.additionalProperties).toBe(false);
  });
  it('Gemini strict and LENIENT: optional left out of required, open', () => {
    for (const p of [GOOGLE_STRICT, LENIENT]) {
      const js = render(S.NameAge, p);
      expect(js.required).toEqual(['name']);
      expect(js.additionalProperties).toBeUndefined();
    }
  });
  it('xAI strict: optional stays optional, objects closed (dialects/xai.ts)', () => {
    const js = render(S.NameAge, XAI_STRICT);
    expect(js.required).toEqual(['name']);
    expect(js.additionalProperties).toBe(false);
  });
});

describe('record encoding (core:schema-formats.test.ts:113-147)', () => {
  it('OpenAI strict and Anthropic strict: pairs', () => {
    for (const p of [OPENAI_STRICT, ANTHROPIC_STRICT]) {
      const tags = props(render(S.Tags, p)).tags;
      expect(tags.type).toBe('array');
      expect(tags.items).toEqual({ type: 'object', properties: { key: { type: 'string' }, value: { type: 'string' } }, required: ['key', 'value'], additionalProperties: false });
      expect(tags.description).toBe('A map written as a list of {key, value} entries; each key at most once.');
    }
  });
  it('Gemini strict, xAI strict and LENIENT: open records', () => {
    for (const p of [GOOGLE_STRICT, XAI_STRICT, LENIENT]) expect(props(render(S.Tags, p)).tags).toEqual({ type: 'object', additionalProperties: { type: 'string' } });
  });
  it('Gemini OpenAPI (responseSchema has no additionalProperties): pairs', () => {
    expect(props(render(S.Tags, GOOGLE_OPENAPI)).tags.type).toBe('array');
  });
  it('a record decodes from each shape (pairs: one new object; open: none)', () => {
    const pairs = S.Tags.render(OPENAI_STRICT).parse({ tags: [{ key: 'kind', value: 'note' }] });
    expect(pairs).toMatchObject({ ok: true, value: { tags: { kind: 'note' } }, stats: { objects: 1, edits: 1 } });
    const open = { tags: { kind: 'note' } };
    const g = S.Tags.render(GOOGLE_STRICT).parse(open);
    expect(g.ok && g.value).toBe(open);
  });
});

describe('tuple encoding (core:schema-formats.test.ts:149-181)', () => {
  it('OpenAI strict: an object with numeric keys', () => {
    const pair = props(render(S.Pair, OPENAI_STRICT)).pair;
    expect(pair.type).toBe('object');
    expect(Object.keys(pair.properties).sort()).toEqual(['0', '1', '2']);
    expect(pair.additionalProperties).toBe(false);
    expect(pair.description).toBe('Positions are written as keys "0".."2".');
  });
  it('Anthropic strict: items anyOf, positions said in words and checked on decode', () => {
    const pair = props(render(S.Pair, ANTHROPIC_STRICT)).pair;
    expect(pair.type).toBe('array');
    expect(pair.prefixItems).toBeUndefined();
    expect(pair.items.anyOf).toHaveLength(3);
    expect(pair.description).toBe('Exactly 3 items, in order: string, number, boolean.');
    const bad = S.Pair.render(ANTHROPIC_STRICT).parse({ pair: [1, 'x', true] });
    expect(!bad.ok && bad.issues.map((i) => i.path)).toEqual([['pair', 0], ['pair', 1]]);
  });
  it('Gemini strict, xAI strict, LENIENT: prefixItems', () => {
    for (const p of [GOOGLE_STRICT, XAI_STRICT, LENIENT]) {
      const pair = props(render(S.Pair, p)).pair;
      expect(pair.type).toBe('array');
      expect(pair.prefixItems).toHaveLength(3);
    }
  });
  it('decoding: numeric keys → one new array; arrays as they are', () => {
    const o = S.Pair.render(OPENAI_STRICT).parse({ pair: { 0: 'a', 1: 1, 2: true } });
    expect(o).toMatchObject({ ok: true, value: { pair: ['a', 1, true] }, stats: { arrays: 1 } });
    expect(S.Pair.render(GOOGLE_STRICT).parse({ pair: ['a', 1, true] })).toMatchObject({ ok: true, stats: NO_COPIES });
  });
  it.fails('GAP: a homogeneous tuple on Anthropic strict repeats the same branch in items.anyOf (spends the 16-union budget)', () => {
    // core:wire-decode.test.ts:378 coord: z.tuple([z.number(), z.number()]).
    const coord = props(render(S.Symmetry, ANTHROPIC_STRICT)).coord;
    expect(coord.items).toEqual({ type: 'number' });
    expect(S.Symmetry.render(ANTHROPIC_STRICT).measure.unions).toBe(0);
  });
});

describe('intersections (core:schema-formats.test.ts:183-213)', () => {
  // DELIBERATE: core collapsed allOf to anyOf on OpenAI/Gemini strict and kept allOf on Anthropic/LENIENT;
  // `a` merges an intersection of objects into ONE object everywhere — exact, and no combinator needed.
  for (const p of [OPENAI_STRICT, ANTHROPIC_STRICT, GOOGLE_STRICT, LENIENT, XAI_STRICT, MINIMAL]) {
    it(`${p.id}: merged into one object`, () => {
      const js = render(S.AandB, p);
      expect(js.allOf).toBeUndefined();
      expect(js.anyOf).toBeUndefined();
      expect(props(js)).toEqual({ a: { type: 'string' }, b: { type: 'number' } });
      expect(js.required).toEqual(['a', 'b']);
    });
  }
  it('every profile family', () => {
    expect(profileProblems(S.AandB, [{ a: 'x', b: 1 }])).toEqual([]);
  });
});

describe('"any" (core:schema-formats.test.ts:215-275, :632-687, schema-any.test.ts)', () => {
  it('DELIBERATE: OpenAI strict and Anthropic strict take any value as JSON text (core: a recursive $defs/Any of pairs on OpenAI, not sendable on Anthropic)', () => {
    for (const p of [OPENAI_STRICT, ANTHROPIC_STRICT]) {
      expect(props(render(S.AnyData, p)).data).toEqual({ type: 'string', description: 'Write the value as JSON text.' });
    }
    // Why: a $defs/Any with a [{key,value}] branch can't be told apart from a real list of pairs;
    // JSON text is exact, and decoding parses it in place.
    const res = S.ManyAny.render(OPENAI_STRICT).parse({ a: '1', b: '"x"', c: ['true', 'null'], d: { nested: '{"k":[1]}' } });
    expect(res.ok && res.value).toEqual({ a: 1, b: 'x', c: [true, null], d: { nested: { k: [1] } } });
    expect(res.stats).toEqual({ ...NO_COPIES, edits: 5, parsed: 5 });
  });

  it('a value sent directly where JSON text was asked for is taken as is (repair)', () => {
    const res = S.AnyData.render(OPENAI_STRICT).parse({ data: { k: [1] } });
    expect(res.ok && res.value).toEqual({ data: { k: [1] } });
    expect(res.stats.repaired).toBe(1);
  });

  it('bad JSON text is an issue at the model path', () => {
    const res = S.ManyAny.render(OPENAI_STRICT).parse({ a: 1, b: 'not json', c: [], d: { nested: '{' } });
    expect(!res.ok && res.issues.map((i) => i.path)).toEqual([['b'], ['d', 'nested']]);
  });

  it('encoding writes JSON text', () => {
    expect(S.ManyAny.render(OPENAI_STRICT).encode({ a: 1, b: 'x', c: [true], d: { nested: { k: [1] } } }))
      .toEqual({ a: '1', b: '"x"', c: ['true'], d: { nested: '{"k":[1]}' } });
  });

  it('xAI strict: a flat, non-recursive anyOf over every JSON type (core:schema-formats.test.ts:633-674)', () => {
    const data = props(render(S.AnyData, XAI_STRICT)).data;
    expect(data.anyOf.map((b: J) => b.type).sort()).toEqual(['array', 'boolean', 'null', 'number', 'object', 'string']);
    expect(data.anyOf.find((b: J) => b.type === 'object').additionalProperties).toBe(true);
    expect(data.anyOf.find((b: J) => b.type === 'array').items).toBeUndefined();
    expect(refsIn(data)).toEqual([]);
    expect(render(S.AnyData, XAI_STRICT).$defs).toBeUndefined();
    // a.json() (z.unknown()) is the same encoding.
    expect(props(render(S.JsonData, XAI_STRICT)).data).toEqual(data);
    const many = render(S.ThreeAny, XAI_STRICT);
    expect(refsIn(many)).toEqual([]);
    expect(props(many).c.items.anyOf).toBeDefined();
    // The answer IS the code value: nothing to decode.
    const wire = { a: 1, b: 'x', c: [true, null], d: { nested: { k: [1] } } };
    expect(S.ManyAny.render(XAI_STRICT).parse(wire)).toMatchObject({ ok: true, value: wire, stats: NO_COPIES });
  });

  it('Gemini strict AND non-strict: the empty schema, no anyOf, no $defs (core:schema-formats.test.ts:249-267, schema-any.test.ts:172-200)', () => {
    for (const p of [GOOGLE_STRICT, GOOGLE_NON_STRICT]) {
      const js = render(S.ThreeAny, p);
      expect(js.$defs).toBeUndefined();
      expect(props(js).a).toEqual({});
      expect(props(js).b).toEqual({});
      expect(props(js).c.items).toEqual({});
    }
    // A described any keeps its description — the model still gets the prose.
    expect(props(render(S.DescribedAny, asTool(GOOGLE_STRICT))).input).toEqual({ description: 'Arbitrary JSON value' });
    expect(props(render(S.DescribedAny, asTool(OPENAI_STRICT))).input.description).toBe('Arbitrary JSON value\nWrite the value as JSON text.');
  });

  it('REGRESSION api_signature: compiles Gemini-safely, keeps name required and the open tail (schema-any.test.ts:207)', () => {
    const js = render(S.ApiSignature, GOOGLE_STRICT);
    const kw = keywordsIn(js);
    for (const forbidden of ['anyOf', 'oneOf', 'allOf', '$defs', '$ref']) expect([forbidden, kw.has(forbidden)]).toEqual([forbidden, false]);
    const sig = props(js).signature;
    expect(sig.type).toBe('object');
    expect(sig.properties.name).toEqual({ type: 'string' });
    expect(sig.required).toEqual(['name']);
    expect(sig.additionalProperties).toEqual({});
    expect(sig.description).toBe('The signature of the API function being declared.');
    // DELIBERATE: core's LENIENT showed `anyOf` + `$defs/Any` here (the shape Gemini rejected); `a`'s LENIENT is `{}` too.
    expect(keywordsIn(render(S.ApiSignature, LENIENT)).has('$defs')).toBe(false);
  });

  it('api_signature on OpenAI strict: the open tail goes as pairs of JSON text', () => {
    const r = S.ApiSignature.render(OPENAI_STRICT);
    const sig = props(r.jsonSchema).signature;
    expect(sig.required).toEqual(['name', 'extra']);
    expect(sig.properties.extra.items.properties.value).toEqual({ type: 'string', description: 'Write the value as JSON text.' });
    const res = r.parse({ signature: { name: 'get_user', extra: [{ key: 'returns', value: '{"type":"User"}' }, { key: 'async', value: 'true' }] } });
    expect(res.ok && res.value).toEqual({ signature: { name: 'get_user', returns: { type: 'User' }, async: true } });
    // The pairs are moved into the object itself: no new object, one edit per key + the dropped `extra`.
    expect(res.stats).toEqual({ ...NO_COPIES, edits: 3, parsed: 2 });
  });

  it('every profile family', () => {
    expect(profileProblems(S.ManyAny, [{ a: 1, b: 'x', c: [true, null, { k: 1 }], d: { nested: [1, [2]] } }])).toEqual([]);
    // xAI: an object with properties AND a schema-valued additionalProperties is legal there (open records),
    // but _check's closed-objects rule flags it; xAI is checked below by hand.
    expect(profileProblems(S.ApiSignature, [{ signature: { name: 'f' } }, { signature: { name: 'f', returns: { type: 'User' }, tags: ['a'] } }], { profiles: NOT_XAI })).toEqual([]);
    expect(props(render(S.ApiSignature, XAI_STRICT)).signature.additionalProperties.anyOf).toHaveLength(6);
  });
});

describe('string formats (core:schema-formats.test.ts:277-310, :448)', () => {
  it('a format the dialect accepts is emitted', () => {
    for (const p of [OPENAI_STRICT, ANTHROPIC_STRICT, XAI_STRICT, LENIENT]) {
      expect(props(render(S.Contact, p))).toEqual({ contact: { type: 'string', format: 'email' }, unique: { type: 'string', format: 'uuid' } });
    }
  });
  it('DELIBERATE: a format the dialect lacks is said in words (core dropped it), and still checked', () => {
    for (const p of [GOOGLE_STRICT, GOOGLE_OPENAPI, MINIMAL]) {
      expect(props(render(S.Contact, p)).contact).toEqual({ type: 'string', description: 'Format: email.' });
    }
    const res = S.Contact.render(GOOGLE_STRICT).parse({ contact: 'not-an-email', unique: 'x' });
    expect(!res.ok && res.issues).toEqual([
      { path: ['contact'], codePath: ['contact'], message: 'Must be a valid email.' },
      { path: ['unique'], codePath: ['unique'], message: 'Must be a valid uuid.' },
    ]);
  });
  it('a pattern is emitted as `pattern`, never as a format name (core:schema-formats.test.ts:296)', () => {
    expect(props(render(S.Code, LENIENT)).code).toEqual({ type: 'string', pattern: '^[a-z]+$' });
    // Gemini strict has no `pattern`: said in words.
    expect(props(render(S.Code, GOOGLE_STRICT)).code).toEqual({ type: 'string', description: 'Must match /^[a-z]+$/.' });
  });
  it('date format on Gemini strict (only date-time/date/time)', () => {
    expect(props(render(S.UserFields, GOOGLE_STRICT)).createdAt).toEqual({ type: 'string', format: 'date' });
  });
});

describe('constraints per dialect (core:schema-formats.test.ts:394-454)', () => {
  it('Anthropic strict: no range/length; minItems 0/1 only — DELIBERATE: the rest said in words and validated', () => {
    expect(props(render(S.Age, ANTHROPIC_STRICT)).age).toEqual({ type: 'number', description: 'At least 0. At most 120.' });
    expect(props(render(S.Name, ANTHROPIC_STRICT)).name).toEqual({ type: 'string', description: 'At least 2 characters. At most 50 characters.' });
    // core dropped minItems too; `a` keeps minItems: 1 (Anthropic accepts 0 or 1).
    expect(props(render(S.BoundedTags, ANTHROPIC_STRICT)).tags).toEqual({ type: 'array', items: { type: 'string' }, minItems: 1, description: 'At most 10 items.' });
    const res = S.Age.render(ANTHROPIC_STRICT).parse({ age: 130 });
    expect(lines(res)).toBe('- at age: Must be at most 120.');
  });
  it('Gemini strict: range kept, string length said in words', () => {
    expect(props(render(S.Age, GOOGLE_STRICT)).age).toEqual({ type: 'number', minimum: 0, maximum: 120 });
    expect(props(render(S.Name, GOOGLE_STRICT)).name.minLength).toBeUndefined();
    expect(S.Name.render(GOOGLE_STRICT).parse({ name: 'x' }).ok).toBe(false);
  });
  it('OpenAI strict and xAI keep every constraint', () => {
    for (const p of [OPENAI_STRICT, XAI_STRICT]) {
      expect(props(render(S.Age, p)).age).toEqual({ type: 'number', minimum: 0, maximum: 120 });
      expect(props(render(S.BoundedTags, p)).tags).toMatchObject({ minItems: 1, maxItems: 10 });
    }
  });
  it('every profile family', () => {
    expect(profileProblems(a.object({ ...S.Age.shape, ...S.Name.shape, ...S.BoundedTags.shape, ...S.Contact.shape, ...S.Code.shape }), [
      { age: 30, name: 'Ann', tags: ['a'], contact: 'a@b.co', unique: '123e4567-e89b-12d3-a456-426614174000', code: 'abc' },
    ])).toEqual([]);
  });
});

describe('propertyOrdering (core:schema-formats.test.ts:417-432)', () => {
  it('Gemini OpenAPI lists properties in declaration order; DELIBERATE: not on Gemini JSON-Schema strict', () => {
    expect(render(S.Ordered, GOOGLE_OPENAPI).propertyOrdering).toEqual(['zebra', 'apple', 'mango']);
    expect(render(S.Ordered, GOOGLE_STRICT).propertyOrdering).toBeUndefined();
    expect(render(S.Ordered, OPENAI_STRICT).propertyOrdering).toBeUndefined();
  });
});

describe('non-strict profiles behave as LENIENT (core:schema-formats.test.ts:547-629)', () => {
  it('OpenAI, Anthropic, Ollama non-strict tools: LENIENT with an object root', () => {
    const lenient = JSON.stringify(render(S.NameTags, LENIENT));
    for (const p of [OPENAI_NON_STRICT, ANTHROPIC_NON_STRICT, OLLAMA]) expect(JSON.stringify(render(S.NameTags, p))).toBe(lenient);
  });
  it('Gemini non-strict diverges on the measured axes: guarded recursion and the 40-value enum cap', () => {
    expect(GOOGLE_NON_STRICT.maxEnumValues).toBe(40);
    expect(LENIENT.maxEnumValues).toBeUndefined();
    expect(GOOGLE_NON_STRICT.recursion).toBe('guarded');
    // "any" is the empty schema in both (core: Gemini needed its own 'unconstrained' encoding).
    expect(props(render(S.AnyData, GOOGLE_NON_STRICT)).data).toEqual(props(render(S.AnyData, LENIENT)).data);
    const { id, family, maxEnumValues, recursion, rootObject, jsonInstruction, ...rest } = GOOGLE_NON_STRICT;
    const { id: _i, family: _f, maxEnumValues: _m, recursion: _r, rootObject: _o, jsonInstruction: _j, ...lrest } = LENIENT;
    void [id, family, maxEnumValues, recursion, rootObject, jsonInstruction, _i, _f, _m, _r, _o, _j];
    expect(rest).toEqual(lrest);
  });
});

// ============================================================================
// Recursion: core's cycle breaker (schema-formats.test.ts:689-1032)
// ============================================================================

describe('recursion on a dialect that has none (core: cycle breaker; `a`: JSON text)', () => {
  // DELIBERATE: core replaced each back-edge with a "Would recursively reference #/$defs/X" open-object
  // placeholder (shape-aware, bounded, lossy). `a` writes the back-edge as JSON TEXT of the exact
  // TypeScript type: the model is told the whole shape, and decoding checks the recursion all the way down.
  const recursive = {
    ValueNode: S.ValueNode, MutualAB: S.MutualAB, LabelTree: S.LabelTree, Wrap: S.Wrap, Arr: S.Arr, SelfArray: S.SelfArray,
    ChildrenNode: S.ChildrenNode, KindAB: S.KindAB, NumOrRest: S.NumOrRest, StrNumList: S.StrNumList, LeafOrKid: S.LeafOrKid,
    DeepABC: S.DeepABC, ListOfLists: S.ListOfLists,
  };
  for (const [name, s] of Object.entries(recursive)) {
    it(`${name}: no $ref cycle on Anthropic strict, xAI strict, Gemini OpenAPI, MINIMAL`, () => {
      for (const p of [ANTHROPIC_STRICT, XAI_STRICT, GOOGLE_OPENAPI, MINIMAL]) {
        const js = render(s, asTool(p));
        expect(dialectProblems(js, asTool(p))).toEqual([]);
        expect(JSON.stringify(js)).toContain('contains itself, which this model cannot describe directly. Write it as JSON text of this TypeScript type:');
      }
    });
  }

  it('the back-edge text names the type exactly (core:schema-formats.test.ts:906)', () => {
    const js = render(S.ChildrenNode, ANTHROPIC_STRICT);
    const items = props(js).children.items;
    expect(items.type).toBe('string');
    expect(items.description).toMatch(/^"Node" contains itself, which this model cannot describe directly\. Write it as JSON text of this TypeScript type: Node\b/);
    // The named types are spelled once, in the description of the whole schema.
    expect(js.description).toContain('type Node = { value: string; children: Node[] }');
  });

  it('OpenAI strict and LENIENT keep the $ref (core:schema-formats.test.ts:727, :817)', () => {
    for (const p of [OPENAI_STRICT, LENIENT]) {
      const js = render(S.ValueNode, p);
      const refs = refsIn(js);
      expect(refs.length).toBeGreaterThan(0);
      for (const r of refs) expect(js.$defs[r.replace('#/$defs/', '')]).toBeDefined();
    }
  });

  it('Gemini strict: recursion through an optional/emptiable position is kept as $ref (guarded)', () => {
    expect(refsIn(render(S.ValueNode, GOOGLE_STRICT))).toEqual(['#/$defs/Node', '#/$defs/Node']);
    // A required, non-emptiable back-edge (Inner.next) becomes JSON text.
    const inner = render(S.InnerNext, GOOGLE_STRICT);
    expect(JSON.stringify(inner)).toContain('contains itself');
  });

  it('a shared, non-cyclic named type stays one $ref on Anthropic strict (core:schema-formats.test.ts:790)', () => {
    const js = render(S.Reviewed, ANTHROPIC_STRICT);
    expect(js.$defs.Person).toBeDefined();
    expect(refsIn(js)).toEqual(['#/$defs/Person', '#/$defs/Person']);
    expect(JSON.stringify(js)).not.toContain('contains itself');
  });

  it('decodes the JSON-text back-edges, checked all the way down', () => {
    const r = S.MutualAB.render(ANTHROPIC_STRICT);
    const res = r.parse({ name: 'a1', b: { tag: 1, a: '{"name":"a2","b":{"tag":2}}' } });
    expect(res.ok && res.value).toEqual({ name: 'a1', b: { tag: 1, a: { name: 'a2', b: { tag: 2 } } } });
    expect(res.stats).toMatchObject({ parsed: 1 });
    const bad = r.parse({ name: 'a1', b: { tag: 1, a: '{"name":"a2","b":{"tag":"two"}}' } });
    expect(!bad.ok && bad.issues[0]).toEqual({ path: ['b', 'a', '(json)', 'b', 'tag'], codePath: ['b', 'a', 'b', 'tag'], message: 'Expected a number, got string.' });
    const self = S.SelfArray.render(asTool(ANTHROPIC_STRICT)).parse({ input: ['[]', '[[],[[]]]'] });
    expect(self.ok && self.value).toEqual([[], [[], [[]]]]);
    const union = S.NumOrRest.render(asTool(ANTHROPIC_STRICT)).parse({ input: { rest: '{"rest":3}' } });
    expect(union.ok && union.value).toEqual({ rest: { rest: 3 } });
  });

  it('terminates and serializes (core:schema-formats.test.ts:835, :1000)', () => {
    for (const s of Object.values(recursive)) for (const p of [ANTHROPIC_STRICT, OPENAI_STRICT, MINIMAL]) expect(() => JSON.stringify(render(s, asTool(p)))).not.toThrow();
  });

  it('every profile family', () => {
    expect(profileProblems(S.ValueNode, [{ value: 'r' }, { value: 'r', children: [{ value: 'c', children: [] }] }])).toEqual([]);
    expect(profileProblems(S.MutualAB, [{ name: 'a', b: { tag: 1, a: { name: 'b' } } }])).toEqual([]);
    expect(profileProblems(S.LabelTree, [{ label: 'x', left: { label: 'l' }, right: { label: 'r', left: { label: 'rl' } } }])).toEqual([]);
    expect(profileProblems(S.Wrap, [{}, { inner: { inner: {} } }])).toEqual([]);
    expect(profileProblems(S.Arr, [{ items: [] }, { items: [{ items: [] }] }])).toEqual([]);
    expect(profileProblems(S.SelfArray, [[], [[], [[]]]])).toEqual([]);
    expect(profileProblems(S.ChildrenNode, [{ value: 'v', children: [{ value: 'c', children: [] }] }])).toEqual([]);
    expect(profileProblems(S.KindAB, [{ kind: 'a', b: { kind: 'b', a: { kind: 'a' } } }])).toEqual([]);
    expect(profileProblems(S.NumOrRest, [1, { rest: { rest: 2 } }])).toEqual([]);
    expect(profileProblems(S.StrNumList, ['s', 1, ['a', [2, []]]])).toEqual([]);
    expect(profileProblems(S.LeafOrKid, ['leaf', { kid: { kid: 'leaf' } }])).toEqual([]);
    expect(profileProblems(S.DeepABC, [{ a: { b: { c: [{ a: { b: { c: [] } } }] } } }])).toEqual([]);
    expect(profileProblems(S.ListOfLists, [[], [[[]], []]])).toEqual([]);
    expect(profileProblems(S.InnerNext, [])).toEqual([]); // no finite value exists; renders everywhere
    expect(profileProblems(S.Reviewed, [{ author: { name: 'a', age: 1 }, reviewer: { name: 'b', age: 2 } }])).toEqual([]);
  });

  it.fails('GAP: unused $defs — when the recursive root is inlined and its back-edges are JSON text, $defs still carries the root', () => {
    // ANTHROPIC_STRICT ValueNode: `$defs.Node` is emitted but nothing points at it (dead weight on every request).
    expect(unusedDefs(render(S.ValueNode, ANTHROPIC_STRICT))).toEqual([]);
    expect(unusedDefs(render(S.MutualAB, ANTHROPIC_STRICT))).toEqual([]);
  });
});

// ============================================================================
// schema-no-defs.test.ts — dialects with no $defs
// ============================================================================

describe('no $defs (core:schema-no-defs.test.ts) — MINIMAL and Gemini OpenAPI', () => {
  for (const p of [MINIMAL, GOOGLE_OPENAPI]) {
    it(`${p.id}: a root cycle, a non-root cycle, a named type used twice, a shared leaf — no $defs, no $ref`, () => {
      for (const s of [S.NamedChildren, S.LabelledTree, S.NamedTwice, S.SharedLeaf]) {
        const text = JSON.stringify(render(s, asTool(p)));
        expect(text).not.toContain('"$defs"');
        expect(text).not.toContain('"$ref"');
      }
      // The back-edge still NAMES what it stands for, without pointing at a $defs section.
      expect(JSON.stringify(render(S.LabelledTree, p))).toContain('type Node = { name: string; children: Node[] }');
      // A named type used twice is inlined at both sites.
      expect(JSON.stringify(render(S.NamedTwice, p)).match(/"properties":\{"a":\{"type":"string"\}\}/g)).toHaveLength(2);
    });
  }

  it('dialects WITH $defs share the named type (core:schema-no-defs.test.ts:79)', () => {
    for (const p of [OPENAI_STRICT, GOOGLE_STRICT, LENIENT]) {
      const text = JSON.stringify(render(S.NamedTwice, p));
      expect(text).toContain('"$defs"');
      expect(text).toContain('#/$defs/GoogleNamed');
    }
    // An UNNAMED shared leaf is never promoted.
    expect(JSON.stringify(render(S.SharedLeaf, OPENAI_STRICT))).not.toContain('$defs');
  });

  it('decodes a non-root cycle written as JSON text under MINIMAL', () => {
    const res = S.LabelledTree.render(MINIMAL).parse({ label: 'L', tree: { name: 'root', children: ['{"name":"c","children":[]}'] } });
    expect(res.ok && res.value).toEqual({ label: 'L', tree: { name: 'root', children: [{ name: 'c', children: [] }] } });
  });
});

// ============================================================================
// schema-enum-cap.test.ts
// ============================================================================

describe('enum caps WIDEN, never truncate (core:schema-enum-cap.test.ts)', () => {
  const CAPPED: Profile = Object.freeze({ ...LENIENT, id: 'test-capped', family: 'test-capped', maxEnumValues: 8 });

  it('over the cap: the enum keyword goes, the type stays, every value is listed', () => {
    const js = render(a.enum(S.MANY), CAPPED);
    expect(js.enum).toBeUndefined();
    expect(js.type).toBe('string');
    for (const v of S.MANY) expect(js.description).toContain(v);
    expect(js.description).toBe(`One of: ${S.MANY.join(', ')}.`);
  });

  it('AT the cap it is still an enum', () => {
    expect(render(a.enum(S.FEW), CAPPED)).toEqual({ type: 'string', enum: S.FEW });
  });

  it('nested enums widen wherever they sit; the own description is kept', () => {
    const js = render(S.PickTags, CAPPED);
    expect(props(js).pick.enum).toBeUndefined();
    expect(props(js).tags.items.description).toContain(S.MANY[19]);
    const d = render(S.Capability, CAPPED).description as string;
    expect(d.startsWith('Which capability to attach.\nOne of: name_0')).toBe(true);
    expect(d).toContain('name_19');
  });

  it('a widened enum is still enforced on decode', () => {
    const r = a.enum(S.MANY).render(CAPPED);
    expect(r.parse('name_19')).toMatchObject({ ok: true, value: 'name_19' });
    const bad = r.parse('nope');
    expect(lines(bad).startsWith('- at (root): Expected one of: name_0, name_1')).toBe(true);
  });

  it('a single literal is never widened', () => {
    expect(render(S.Only, CAPPED)).toEqual({ type: 'string', enum: ['only'] }); // DELIBERATE: `enum` of one, not `const`
  });

  it('no cap on OpenAI, Anthropic, xAI, LENIENT (measured, not assumed)', () => {
    for (const p of [LENIENT, OPENAI_STRICT, OPENAI_NON_STRICT, ANTHROPIC_STRICT, ANTHROPIC_NON_STRICT, XAI_STRICT]) {
      expect(p.maxEnumValues).toBeUndefined();
      expect(field(S.MANY, p)).toEqual({ type: 'string', enum: S.MANY });
    }
  });

  it('Gemini caps at 40 and widens past it', () => {
    for (const p of [GOOGLE_STRICT, GOOGLE_NON_STRICT, GOOGLE_OPENAPI]) {
      expect(p.maxEnumValues).toBe(40);
      const at = Array.from({ length: 40 }, (_, i) => `name_${i}`) as [string, ...string[]];
      const over = Array.from({ length: 41 }, (_, i) => `name_${i}`) as [string, ...string[]];
      expect(field(at, p).enum).toEqual(at);
      const w = field(over, p);
      expect(w.enum).toBeUndefined();
      expect(w.type).toBe('string');
      for (const v of over) expect(w.description).toContain(v);
    }
  });

  it('every profile family', () => {
    expect(profileProblems(S.PickTags, [{ pick: 'name_3', tags: ['name_19', 'name_0'] }])).toEqual([]);
  });

  it.fails('GAP: numeric enums — a union of number literals is 20 single-value anyOf branches, never one `enum`, and never widened', () => {
    // core:schema-enum-cap.test.ts:105 — z.nativeEnum({ n0: 0, …, n19: 19 }) emitted `enum: [0..19]` and widened to `number`.
    expect(render(S.NumericEnum, LENIENT)).toEqual({ type: 'number', enum: Array.from({ length: 20 }, (_, i) => i) });
    expect(render(S.NumericEnum, CAPPED).type).toBe('number');
  });
});

// ============================================================================
// descriptor-consistency.test.ts — the contradiction it guarded against
// ============================================================================

describe('profile self-consistency (core:descriptor-consistency.test.ts)', () => {
  // Core's FormatDescriptor could ask for an "any" encoding its own flags forbade (the GOOGLE_STRICT
  // 400). A Profile has ONE `any` field read by one place, so the contradiction can't be declared;
  // what is left to check is that what each built-in EMITS obeys its own rules.
  const BUILT_INS = [LENIENT, OPENAI_STRICT, OPENAI_NON_STRICT, ANTHROPIC_STRICT, ANTHROPIC_NON_STRICT, GOOGLE_STRICT, GOOGLE_NON_STRICT, GOOGLE_OPENAPI, XAI_STRICT, XAI_NON_STRICT, OLLAMA, MINIMAL];
  for (const p of BUILT_INS) {
    it(`${p.id}: "any", recursion and every core shape render inside the dialect`, () => {
      for (const s of [S.ManyAny, ...(p.family === 'xai' ? [] : [S.ApiSignature]), S.ValueNode, S.Symmetry, S.TestTypeWhere, S.KindMaps, S.PickTags]) {
        expect(dialectProblems(render(s, asTool(p)), asTool(p))).toEqual([]);
      }
    });
  }

  it.fails('GAP: no consistency check for custom profiles — a cap of 0 or a recursive "any" without $defs is accepted silently', () => {
    // core:descriptor-consistency.test.ts:73-91 + registerDescriptor warned on each; `registerProfile` takes anything.
    const broken: Profile = Object.freeze({ ...MINIMAL, id: 'consistency-test-broken', family: 'consistency-test-broken', maxEnumValues: 0 });
    expect(() => registerProfile(broken)).toThrow();
  });
});

describe('a Gemini request (core:schema-rebuilt-lazy.test.ts:121-154)', () => {
  it('an intersection plus any stays strict on Gemini, with no $defs/Any on the wire', () => {
    // DELIBERATE: core degraded this tool to GOOGLE_NON_STRICT (allOf); `a` merges the objects and stays strict.
    const schema = a.object({ value: S.AandB, payload: a.unknown() });
    const e = ModelProfile.of(GOOGLE_STRICT).request([{ kind: 'tool', name: 'i', schema, strict: true }]).get('i');
    expect(e.strict).toBe(true);
    expect(e.adjustments).toEqual([]);
    const text = JSON.stringify(e.jsonSchema);
    expect(text).not.toContain('$defs');
    expect(text).not.toContain('$ref');
    expect(text).not.toContain('allOf');
    expect(validate(e.jsonSchema!, { value: { a: 'x', b: 1 }, payload: [1, { k: 'v' }] })).toEqual([]);
  });
});
