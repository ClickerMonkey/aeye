/**
 * @aeye/test-integration's fixtures (test-integration.ts) on every profile, the strictness each
 * one gets per family (core's live-bedrock.test.ts:244 table), model-shaped answers and errors.
 */
import Handlebars from 'handlebars';
import { describe, expect, it } from 'vitest';
import { ANTHROPIC_STRICT, GOOGLE_STRICT, LENIENT, ModelProfile, OPENAI_STRICT, XAI_STRICT, schemaHelpers } from '../../index';
import { asTool, profileProblems, unexplained, validate } from './_check';
import * as T from './test-integration';

type J = any;
const address = { street: '1 Main St', city: 'Springfield', postcode: '12345', country: 'US' as const };
const order = {
  id: '4c0f6f0e-6a4c-4b7e-9f3e-2b1a2d3c4e5f',
  createdAt: '2026-11-24T10:00:00Z',
  contact: 'ann@example.com',
  status: 'placed' as const,
  sku: 'sku_alpha_0',
  quantity: 2,
  discount: null,
  tags: ['gift'],
  shipping: address,
  billing: null,
  lines: [{ sku: 'sku_alpha_0', price: 9.5, options: [{ key: 'color', value: 'red' }, { key: 'size', value: 10 }, { key: 'wrap', value: true }] }],
  payment: { kind: 'card' as const, last4: '4242' },
  attributes: { channel: 'web' },
  category: { name: 'Toys', children: [{ name: 'Puzzles' }] },
  deep: { a: { b: { c: { d: { e: 'x' } } } } },
};
const { category: _c, ...flatOrder } = order;

describe('every fixture on every profile', () => {
  it.each([
    ['complex', T.Complex, [order, { ...order, note: 'leave at door', billing: address, payment: { kind: 'invoice', dueDays: 30 }, discount: 0.1 }]],
    ['complex-flat', T.ComplexFlat, [flatOrder]],
    ['large-enum', T.LargeEnum, [{ pick: 'component_foxtrot_299' }]],
    ['too-deep', T.TooDeep, [{ a: { b: { c: { d: { e: { f: { g: { h: { i: { j: { k: 'deep' } } } } } } } } } } }]],
    ['many-optional', T.ManyOptional, [{}, { field_alpha_0: 'x', field_foxtrot_29: 'y' }]],
    ['any-tuple', T.AnyTuple, [{ payload: { any: ['json', 1, null] }, extra: { k: [1, 2] }, point: [1, 2, 'p'] }, { payload: null, extra: {}, point: [0, 0, ''] }]],
    ['many-unions', T.ManyUnions, [Object.fromEntries(T.identifiers('choice', 20).map((n, i) => [n, i % 2 ? i : `v${i}`]))]],
    ['dice count', T.DiceCount, [{ count: 3 }]],
    ['city', T.City, [{ city: 'Paris', code: 'FR' }]],
    ['not black', T.NotBlack, [{ color: 'red' }]],
    ['answer', T.Answer, [{ answer: '42' }]],
  ] as const)('%s', (_name, schema, samples) => {
    expect(profileProblems(schema as Parameters<typeof profileProblems>[0], samples)).toEqual([]);
  });
});

describe('strictness per family (core live-bedrock.test.ts:244: [fixture, Claude strict?])', () => {
  const fixtures = {
    complex: T.Complex.bind(), 'complex-flat': T.ComplexFlat, 'large-enum': T.LargeEnum, 'too-deep': T.TooDeep,
    'many-optional': T.ManyOptional, 'any-tuple': T.AnyTuple, 'many-unions': T.ManyUnions,
  } as const;
  // core: complex false (recursion), complex-flat true, large-enum true, too-deep true, many-optional false,
  // any-tuple false (any + tuple), many-unions false.
  const claude: Record<keyof typeof fixtures, boolean> = {
    complex: true, // DELIBERATE: the recursive Category is JSON text on Anthropic strict, so the tool stays strict.
    'complex-flat': true,
    'large-enum': true,
    'too-deep': true,
    'many-optional': false,
    'any-tuple': true, // DELIBERATE: any → JSON text, the tuple → items anyOf: both expressible strict.
    'many-unions': false,
  };
  for (const [name, schema] of Object.entries(fixtures) as [keyof typeof fixtures, (typeof fixtures)[keyof typeof fixtures]][]) {
    it(`${name}: Claude tool ${claude[name]}, output ${claude[name] ? 'structured' : 'prompt text'}; GPT and Gemini strict`, () => {
      const tool = ModelProfile.of(ANTHROPIC_STRICT).request([{ kind: 'tool', name: 'record', schema }]);
      expect(tool.get('record').strict).toBe(claude[name]);
      expect(unexplained(tool)).toEqual([]);
      const out = ModelProfile.of(ANTHROPIC_STRICT).request([{ kind: 'output', schema }]).get('output');
      expect(out.delivery).toBe(claude[name] ? 'structured' : 'prompt');
      for (const p of [OPENAI_STRICT, GOOGLE_STRICT, XAI_STRICT]) {
        expect(ModelProfile.of(p).request([{ kind: 'tool', name: 'record', schema }]).get('record').strict).toBe(true);
      }
    });
  }

  it('the reasons name the Anthropic limits', () => {
    expect(ModelProfile.of(ANTHROPIC_STRICT).request([{ kind: 'tool', name: 'record', schema: T.ManyOptional }]).get('record').adjustments)
      .toEqual([{ kind: 'not-strict', reason: '"record" alone: 30 optional properties (limit 24)' }]);
    expect(ModelProfile.of(ANTHROPIC_STRICT).request([{ kind: 'output', schema: T.ManyUnions }]).get('output').adjustments)
      .toEqual([{ kind: 'prompt-text', reason: '"output" alone: 20 union-typed properties (limit 16)' }]);
  });

  it('too-deep: @aeye/schema measures 10 levels below the root (OpenAI\'s limit is 10), so it fits as is', () => {
    expect(T.TooDeep.render(OPENAI_STRICT).measure.depth).toBe(10);
  });

  it('large-enum: 300 values fit OpenAI (over 250 only caps the characters); Gemini\'s cap of 40 widens it to a described string', () => {
    expect((ModelProfile.of(OPENAI_STRICT).request([{ kind: 'tool', name: 'r', schema: T.LargeEnum }]).get('r').jsonSchema as J).properties.pick.enum).toHaveLength(300);
    const gem = T.LargeEnum.render(asTool(GOOGLE_STRICT)).jsonSchema as J;
    expect(gem.properties.pick.enum).toBeUndefined();
    expect(gem.properties.pick.description).toContain('component_foxtrot_299');
    // Still enforced on decode.
    expect(T.LargeEnum.render(asTool(GOOGLE_STRICT)).parse({ pick: 'nope' }).ok).toBe(false);
  });
});

describe('emitted JSON and model answers', () => {
  it('complex on OpenAI strict: formats, pairs, nullable, the recursive Category as $defs', () => {
    const js = T.Complex.render(asTool(OPENAI_STRICT)).jsonSchema as J;
    expect(js.properties.id).toEqual({ type: 'string', format: 'uuid', description: 'Order id' });
    expect(js.properties.attributes.type).toBe('array');
    expect(js.properties.billing.anyOf.map((b: J) => b.type)).toEqual(['object', 'null']);
    expect(js.$defs.Category.properties.children.anyOf[0]).toEqual({ type: 'array', items: { $ref: '#/$defs/Category' } });
    expect(js.required).toEqual(Object.keys(js.properties));
  });

  it('complex on Anthropic strict: the Category back-edge (children items) is JSON text; the answer decodes in place', () => {
    const r = T.Complex.render(asTool(ANTHROPIC_STRICT));
    const js = r.jsonSchema as J;
    expect(js.properties.category).toEqual({ $ref: '#/$defs/Category' });
    expect(js.$defs.Category.properties.children.items.type).toBe('string');
    expect(js.$defs.Category.properties.children.items.description).toContain('JSON text of this TypeScript type: Category');
    const wire = { ...structuredClone(order), attributes: [{ key: 'channel', value: 'web' }], category: { name: 'Toys', children: ['{"name":"Puzzles"}'] } };
    const res = r.parse(wire);
    expect(res.ok && res.value).toEqual(order);
    expect(res.ok && res.value).toBe(wire);
    expect(res.stats).toEqual({ objects: 1, arrays: 0, edits: 2, parsed: 1, repaired: 0 });
    // The whole category sent as JSON text is a repair.
    const rep = r.parse({ ...structuredClone(order), attributes: [{ key: 'channel', value: 'web' }], category: JSON.stringify(order.category) });
    expect(rep.ok && rep.value).toEqual(order);
    expect(rep.stats.repaired).toBeGreaterThan(0);
  });

  it('complex on OpenAI strict: an absent note is null; pairs; errors at the wire and code paths', () => {
    const r = T.Complex.render(asTool(OPENAI_STRICT));
    const wire = { ...structuredClone(order), note: null, attributes: [{ key: 'channel', value: 'web' }], category: { name: 'Toys', children: [{ name: 'Puzzles', children: null }] } };
    const res = r.parse(wire);
    expect(res.ok && res.value).toEqual(order);
    const bad = r.parse({ ...wire, quantity: 100, attributes: [{ key: 'channel', value: 1 }], payment: { kind: 'card', last4: '42' } });
    const got = !bad.ok ? bad.issues.map((x) => JSON.stringify([x.path, x.codePath])).sort() : [];
    expect(got).toEqual([
      [['quantity'], ['quantity']],
      [['payment', 'last4'], ['payment', 'last4']],
      [['attributes', 0, 'value'], ['attributes', 'channel']],
    ].map((x) => JSON.stringify(x)).sort());
  });

  it('any-tuple: OpenAI strict writes the tuple as {"0":…} and the any as JSON text', () => {
    const r = T.AnyTuple.render(asTool(OPENAI_STRICT));
    const res = r.parse({ payload: '{"any":[1]}', extra: [{ key: 'k', value: '[1,2]' }], point: { 0: 1, 1: 2, 2: 'p' } });
    expect(res.ok && res.value).toEqual({ payload: { any: [1] }, extra: { k: [1, 2] }, point: [1, 2, 'p'] });
    expect(res.ok && res.stats).toMatchObject({ objects: 1, arrays: 1, parsed: 2 });
  });

  it('not black: said in words where `not` is unsupported, always enforced', () => {
    expect((T.NotBlack.render(asTool(OPENAI_STRICT)).jsonSchema as J).properties.color).toEqual({ type: 'string', description: 'Must not be: "black".' });
    expect((T.NotBlack.render(asTool(LENIENT)).jsonSchema as J).properties.color.not).toBeDefined();
    const res = T.NotBlack.render(asTool(OPENAI_STRICT)).parse({ color: 'black' });
    expect(!res.ok && res.message).toBe('- at color: Must not be: "black".');
  });

  it('city: a bad code at its path; encoded into a prompt in the model\'s shape', () => {
    const r = T.City.render(OPENAI_STRICT);
    expect(r.parse({ city: 'Paris', code: 'XX' })).toMatchObject({ ok: false, message: '- at code: Expected one of: FR, DE, ES.' });
    const t = Handlebars.compile('Like {{encode v}}', { noEscape: true });
    expect(t({ v: { city: 'Paris', code: 'FR' } }, { helpers: schemaHelpers(r) })).toBe('Like {"city":"Paris","code":"FR"}');
    expect(validate(r.jsonSchema, r.encode({ city: 'Paris', code: 'FR' }))).toEqual([]);
  });

  it('many fixtures in one Claude request: the ladder degrades and explains each step', () => {
    const req = ModelProfile.of(ANTHROPIC_STRICT).request([
      { kind: 'tool', name: 'complex', schema: T.ComplexFlat, strict: 3 },
      { kind: 'tool', name: 'optional', schema: T.ManyOptional, strict: 2 },
      { kind: 'tool', name: 'unions', schema: T.ManyUnions },
      { kind: 'output', schema: T.Answer },
    ]);
    expect(req.get('complex').strict).toBe(true);
    expect(req.get('optional').strict).toBe(false);
    expect(req.get('unions').strict).toBe(false);
    expect(req.get('output').delivery).toBe('structured');
    expect(unexplained(req)).toEqual([]);
    expect(req.degradations.length).toBeGreaterThanOrEqual(2);
  });
});
