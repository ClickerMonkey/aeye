/**
 * The profile table: what each provider's schemas look like, and which
 * profile a model gets from its capabilities.
 */
import { describe, expect, it } from 'vitest';
import {
  a, ANTHROPIC_NON_STRICT, ANTHROPIC_STRICT, familyOf, getProfile, GOOGLE_NON_STRICT, GOOGLE_OPENAPI, GOOGLE_STRICT, LENIENT,
  ModelProfile, OLLAMA, OPENAI_FINETUNED_STRICT, OPENAI_NON_STRICT, OPENAI_STRICT, profileFor, registerProfile, variant,
  XAI_STRICT, type Profile,
} from '../index';

const Budget = a.object({
  owner: a.string(),
  limits: a.record(a.number()),
  note: a.string().optional(),
  at: a.tuple([a.number(), a.number()]),
});

const field = (p: Profile, key: string) => (Budget.render(p).jsonSchema.properties as any)[key];

describe('"strict models see pairs" is a dialect rule, not a strictness rule', () => {
  it.each([
    [OPENAI_STRICT, 'pairs'],
    [OPENAI_FINETUNED_STRICT, 'pairs'],
    [ANTHROPIC_STRICT, 'pairs'],
    [GOOGLE_OPENAPI, 'pairs'],
    [GOOGLE_STRICT, 'open'],
    [XAI_STRICT, 'open'],
    [OPENAI_NON_STRICT, 'open'],
    [ANTHROPIC_NON_STRICT, 'open'],
    [OLLAMA, 'open'],
    [LENIENT, 'open'],
  ] as const)('%s writes records as %s', (p, want) => {
    const limits = field(p, 'limits');
    if (want === 'pairs') {
      expect(limits.type).toBe('array');
      expect(limits.items.properties).toMatchObject({ key: { type: 'string' }, value: { type: 'number' } });
    } else {
      expect(limits.type).toBe('object');
      expect(limits.additionalProperties).toEqual({ type: 'number' });
    }
  });

  it('xAI strict is strict, closes objects, and still takes an open record', () => {
    expect(XAI_STRICT.strict).toBe(true);
    const js = Budget.render(XAI_STRICT).jsonSchema as any;
    expect(js.additionalProperties).toBe(false);
    expect(js.properties.limits.additionalProperties).toEqual({ type: 'number' });
  });
});

/** Every `$ref` in a schema that has other keywords beside it. */
function refsWithSiblings(json: unknown, at = '#'): string[] {
  if (json === null || typeof json !== 'object') return [];
  const here = !Array.isArray(json) && typeof (json as any).$ref === 'string' && Object.keys(json).length > 1 ? [at] : [];
  return [...here, ...Object.entries(json).flatMap(([k, v]) => refsWithSiblings(v, `${at}/${k}`))];
}

describe('a described $ref', () => {
  const Picked = a.define({ FnName: a.string().describe('A fn name.') }).result(a.object({
    name: a.ref('FnName').describe('Which fn.'),
    also: a.ref('FnName').describe('Another fn.').optional(),
    many: a.array(a.ref('FnName').describe('One of several.')),
  })).bind();

  it('OpenAI strict refuses keywords beside $ref, so the ref is wrapped and keeps its description', () => {
    const json = Picked.render(OPENAI_STRICT).jsonSchema as any;
    expect(refsWithSiblings(json)).toEqual([]);
    expect(json.properties.name).toEqual({ anyOf: [{ $ref: '#/$defs/FnName' }], description: 'Which fn.' });
    expect(Picked.render(OPENAI_STRICT).parse({ name: 'a', also: null, many: ['b'] })).toMatchObject({ ok: true, value: { name: 'a', many: ['b'] } });
  });

  it('other dialects keep the description beside the $ref', () => {
    expect((Picked.render(LENIENT).jsonSchema as any).properties.name).toEqual({ $ref: '#/$defs/FnName', description: 'Which fn.' });
  });
});

describe('each profile spells the rest of the shape its own way', () => {
  it('optional: null on OpenAI strict only; omitted everywhere else', () => {
    expect(Budget.render(OPENAI_STRICT).jsonSchema.required).toEqual(['owner', 'limits', 'note', 'at']);
    for (const p of [ANTHROPIC_STRICT, GOOGLE_STRICT, XAI_STRICT, LENIENT]) {
      expect(Budget.render(p).jsonSchema.required).toEqual(['owner', 'limits', 'at']);
    }
  });

  it('tuples: numeric keys (OpenAI), items anyOf (Anthropic, Gemini OpenAPI), prefixItems (xAI, Gemini, lenient)', () => {
    expect(Object.keys(field(OPENAI_STRICT, 'at').properties)).toEqual(['0', '1']);
    expect(field(ANTHROPIC_STRICT, 'at').items.anyOf).toHaveLength(2);
    expect(field(GOOGLE_OPENAPI, 'at').items.anyOf).toHaveLength(2);
    for (const p of [XAI_STRICT, GOOGLE_STRICT, LENIENT]) expect(field(p, 'at').prefixItems).toHaveLength(2);
  });

  it('nullable: anyOf (OpenAI strict), type array (Anthropic, xAI, Gemini), nullable keyword (Gemini OpenAPI)', () => {
    const N = a.object({ x: a.string().nullable() });
    const x = (p: Profile) => (N.render(p).jsonSchema.properties as any).x;
    expect(x(OPENAI_STRICT)).toEqual({ anyOf: [{ type: 'string' }, { type: 'null' }] });
    expect(x(ANTHROPIC_STRICT)).toEqual({ type: ['string', 'null'] });
    expect(x(XAI_STRICT)).toEqual({ type: ['string', 'null'] });
    expect(x(GOOGLE_STRICT)).toEqual({ type: ['string', 'null'] });
    expect(x(GOOGLE_OPENAPI)).toEqual({ type: 'string', nullable: true });
  });

  it('any JSON: {} (lenient, Gemini), flat anyOf (xAI), JSON text (OpenAI strict, Anthropic strict, Gemini OpenAPI)', () => {
    const V = a.object({ v: a.json() });
    const v = (p: Profile) => (V.render(p).jsonSchema.properties as any).v;
    expect(v(LENIENT)).toEqual({});
    expect(v(GOOGLE_STRICT)).toEqual({});
    expect(v(XAI_STRICT).anyOf.map((b: any) => b.type)).toEqual(['string', 'number', 'boolean', 'null', 'array', 'object']);
    expect(v(XAI_STRICT).anyOf[5].additionalProperties).toBe(true);
    for (const p of [OPENAI_STRICT, ANTHROPIC_STRICT, GOOGLE_OPENAPI]) expect(v(p).type).toBe('string');
    // xAI's flat any accepts any value as is.
    const r = V.render(XAI_STRICT).parse({ v: { deep: [1, { x: null }] } });
    expect(r.ok && r.value).toEqual({ v: { deep: [1, { x: null }] } });
  });

  it('constraints: keywords where supported, words where not, always validated', () => {
    const C = a.object({
      name: a.string().min(2).max(5).pattern(/^[a-z]+$/).format('email'),
      n: a.int().min(1).max(9),
      list: a.array(a.string()).min(1).max(3),
      list2: a.array(a.string()).min(2),
    });
    const props = (p: Profile) => C.render(p).jsonSchema.properties as any;
    // Anthropic: no length or range, minItems only 0/1, email is a listed format.
    const an = props(ANTHROPIC_STRICT);
    expect(an.name).toMatchObject({ type: 'string', pattern: '^[a-z]+$', format: 'email' });
    expect(an.name.minLength).toBeUndefined();
    expect(an.name.description).toBe('At least 2 characters. At most 5 characters.');
    expect(an.n).toEqual({ type: 'integer', description: 'At least 1. At most 9.' });
    expect(an.list).toMatchObject({ minItems: 1, description: 'At most 3 items.' });
    expect(an.list2.minItems).toBeUndefined();
    expect(an.list2.description).toBe('At least 2 items.');
    // Gemini: no pattern, no length, only date/time formats.
    const g = props(GOOGLE_STRICT);
    expect(g.name.pattern).toBeUndefined();
    expect(g.name.format).toBeUndefined();
    expect(g.name.description).toContain('Format: email.');
    expect(g.n).toMatchObject({ minimum: 1, maximum: 9 });
    // Fine-tuned OpenAI: nothing at all.
    const ft = props(OPENAI_FINETUNED_STRICT);
    expect(Object.keys(ft.name).sort()).toEqual(['description', 'type']);
    // OpenAI strict: everything.
    expect(props(OPENAI_STRICT).name).toMatchObject({ minLength: 2, maxLength: 5, pattern: '^[a-z]+$', format: 'email' });
    // Validated whatever was emitted.
    const bad = C.render(GOOGLE_STRICT).parse({ name: 'A', n: 0, list: [], list2: ['x'] });
    expect(!bad.ok && bad.issues.map((i) => [i.path.join('.'), i.message])).toEqual([
      ['name', 'Must be at least 2 characters.'],
      ['name', 'Must match /^[a-z]+$/.'],
      ['name', 'Must be a valid email.'],
      ['n', 'Must be at least 1.'],
      ['list', 'Must have at least 1 items.'],
      ['list2', 'Must have at least 2 items.'],
    ]);
  });

  it('a pattern outside the basic regex subset is said in words on strict providers', () => {
    const P = a.object({ w: a.string().pattern('^(?!x)\\w+$') });
    expect((P.render(OPENAI_STRICT).jsonSchema.properties as any).w.description).toBe('Must match /^(?!x)\\w+$/.');
    expect((P.render(LENIENT).jsonSchema.properties as any).w.pattern).toBe('^(?!x)\\w+$');
  });

  it('Gemini recursion: $ref through optional/nullable/maybe-empty values, JSON text through required ones', () => {
    const Ok = a.define({ Node: a.object({ v: a.number(), kids: a.array(a.ref('Node')), next: a.ref('Node').optional() }) }).result('Node');
    const g = Ok.render(GOOGLE_STRICT).jsonSchema as any;
    expect(g.properties.kids.items).toEqual({ $ref: '#/$defs/Node' });
    expect(g.properties.next).toEqual({ $ref: '#/$defs/Node' });
    const Bad = a.define({ Node: a.object({ v: a.number(), must: a.ref('Node') }) }).result('Node');
    const b = Bad.render(GOOGLE_STRICT).jsonSchema as any;
    expect(b.properties.must.type).toBe('string');
    expect(b.properties.must.description).toContain('contains itself');
    // Lenient takes it either way.
    expect((Bad.render(LENIENT).jsonSchema as any).properties.must).toEqual({ $ref: '#/$defs/Node' });
  });

  it('Gemini OpenAPI: no $defs (inlined), propertyOrdering on every object', () => {
    const S = a.define({ P: a.object({ name: a.string() }) }).result(a.object({ a: a.ref('P'), b: a.ref('P') }));
    const js = S.render(GOOGLE_OPENAPI).jsonSchema as any;
    expect(js.$defs).toBeUndefined();
    expect(js.properties.a).toEqual({ type: 'object', properties: { name: { type: 'string' } }, required: ['name'], propertyOrdering: ['name'] });
    expect(js.propertyOrdering).toEqual(['a', 'b']);
  });
});

describe('profileFor: from the model\'s capabilities', () => {
  const caps = (...c: string[]) => new Set(c);

  it.each([
    [{ id: 'gpt-5.4', provider: 'openai', capabilities: caps('tools', 'toolsStrict', 'structured', 'json') }, 'openai-strict', 'openai-strict', 'structured'],
    [{ id: 'gpt-4-turbo', provider: 'openai', capabilities: caps('tools', 'json') }, 'openai', 'openai', 'structured'],
    [{ id: 'ft:gpt-4.1-mini:acme::x', provider: 'openai', capabilities: caps('toolsStrict', 'structured') }, 'openai-finetuned-strict', 'openai-finetuned-strict', 'structured'],
    [{ id: 'claude-opus-5-5', provider: 'anthropic', capabilities: caps('toolsStrict', 'structured') }, 'anthropic-strict', 'anthropic-strict', 'structured'],
    [{ id: 'claude-3-5-haiku', provider: 'anthropic', capabilities: caps('tools') }, 'anthropic', 'anthropic', 'prompt'],
    [{ id: 'anthropic/claude-sonnet-5', provider: 'openrouter', strictFormat: 'anthropic', capabilities: caps('toolsStrict', 'structured') }, 'anthropic-strict', 'anthropic-strict', 'structured'],
    [{ id: '~anthropic/claude-sonnet-latest', provider: 'openrouter', capabilities: caps('toolsStrict', 'structured') }, 'anthropic-strict', 'anthropic-strict', 'structured'],
    [{ id: 'google/gemini-3-flash-preview', provider: 'openrouter', capabilities: caps('toolsStrict', 'structured') }, 'google-strict', 'google-strict', 'structured'],
    [{ id: 'x-ai/grok-4.3', provider: 'openrouter', capabilities: caps('tools', 'json') }, 'xai-strict', 'xai', 'structured'],
    [{ id: 'openai/gpt-oss-120b', provider: 'openrouter', capabilities: caps('tools', 'structured') }, 'lenient', 'lenient', 'structured'],
    [{ id: 'meta-llama/llama-4-scout', provider: 'openrouter', capabilities: caps('tools', 'json') }, 'lenient', 'lenient', 'structured'],
    [{ id: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0', provider: 'aws', capabilities: caps('toolsStrict', 'structured') }, 'anthropic-strict', 'anthropic-strict', 'structured'],
    [{ id: 'meta.llama3-70b-instruct-v1:0', provider: 'aws', capabilities: caps('tools') }, 'lenient', 'lenient', 'prompt'],
    [{ id: 'llama3.2', provider: 'ollama', capabilities: caps('tools', 'json') }, 'ollama', 'ollama', 'structured'],
    [{ id: 'gpt-5.4', provider: 'openai', strictFormat: 'none', capabilities: caps('toolsStrict', 'structured', 'json') }, 'lenient', 'lenient', 'structured'],
  ])('%o → tools %s, output %s (%s)', (model, tool, output, delivery) => {
    const p = profileFor(model);
    expect([p.tool.id, p.output.id, p.outputDelivery]).toEqual([tool, output, delivery]);
  });

  it('families: strictFormat, then provider, then the vendor/ prefix', () => {
    expect(familyOf({ id: 'whatever', provider: 'openrouter', strictFormat: 'google' })).toBe('google');
    expect(familyOf({ id: 'gemini-3-pro', provider: 'google' })).toBe('google');
    expect(familyOf({ id: 'google/gemma-3', provider: 'openrouter' })).toBe('lenient');
  });

  it('speaks: a provider that cannot send a family gets LENIENT', () => {
    const p = profileFor({ id: 'anthropic/claude-sonnet-5', provider: 'openrouter', capabilities: ['toolsStrict', 'structured'] }, { speaks: new Set(['openai']) });
    expect(p.tool).toBe(LENIENT);
  });

  it('accepts capability arrays as well as sets', () => {
    expect(profileFor({ id: 'gpt-5', provider: 'openai', capabilities: ['toolsStrict'] }).tool).toBe(OPENAI_STRICT);
  });
});

describe('registry and variants', () => {
  it('looks profiles up by id; registers custom ones', () => {
    expect(getProfile('google-strict')).toBe(GOOGLE_STRICT);
    const custom: Profile = Object.freeze({ ...OPENAI_STRICT, id: 'acme-strict', family: 'acme', loose: GOOGLE_NON_STRICT });
    registerProfile(custom);
    expect(getProfile('acme-strict')).toBe(custom);
    expect(profileFor({ id: 'm', provider: 'x', strictFormat: 'acme', capabilities: ['toolsStrict'] }).tool).toBe(custom);
  });

  it('a variant is memoized by its adjustments, so renderings stay memoized too', () => {
    const v1 = variant(ANTHROPIC_STRICT, { maxEnumValues: 40, optionalAsNull: true });
    const v2 = variant(ANTHROPIC_STRICT, { optionalAsNull: true, maxEnumValues: 40 });
    expect(v1).toBe(v2);
    expect(v1.id).toBe('anthropic-strict[enum<=40,optional=null]');
    expect(getProfile(v1.id)).toBe(v1);
    expect(variant(ANTHROPIC_STRICT, {})).toBe(ANTHROPIC_STRICT);
    // An adjustment that changes nothing is no variant.
    expect(variant(GOOGLE_STRICT, { maxEnumValues: 100 })).toBe(GOOGLE_STRICT);
    expect(Budget.render(v1)).toBe(Budget.render(v1));
  });

  it('ModelProfile.of uses one profile for both kinds', () => {
    const m = ModelProfile.of(XAI_STRICT);
    expect(m.tool).toBe(XAI_STRICT);
    expect(m.output).toBe(XAI_STRICT);
    expect(m.outputDelivery).toBe('structured');
  });
});
