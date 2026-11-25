/**
 * OpenRouter routes schemas to the upstream family named by the model id
 * prefix: a request with a dynamic tool and a strict output, planned for
 * Anthropic, Google and xAI models, goes out in each family's dialect with
 * the right strict flags.
 */

import { AI, type AIContextAny, type ModelCapability, type ModelInfo, type Request } from '@aeye/ai';
import { a } from '@aeye/schema';
import { OpenRouterProvider } from '../openrouter';

let mockOpenAI: any;
jest.mock('openai', () => jest.fn().mockImplementation(() => mockOpenAI));

const model = (id: string, capabilities: ModelCapability[], strictFormat?: string): ModelInfo => ({
  provider: 'openrouter', id, name: id, tier: 'flagship', pricing: {}, contextWindow: 200_000,
  capabilities: new Set(capabilities),
  ...(strictFormat ? { strictFormat } : {}),
});

const STRICT: ModelCapability[] = ['chat', 'tools', 'toolsStrict', 'structured', 'json'];
const claude = model('anthropic/claude-sonnet-4.5', STRICT, 'anthropic');
const gemini = model('google/gemini-3-flash-preview', STRICT, 'google');
// No 'toolsStrict' in the registry: xAI tools are strict anyway
const grok = model('x-ai/grok-4.3', ['chat', 'tools', 'structured', 'json'], 'xai');

interface Catalog { fields: string[] }
const Lookup = a
  .define({ Filter: a.object({ field: a.ref('Field'), equals: a.string() }) })
  .dynamic((catalog: Catalog) => ({ Field: a.enum(catalog.fields) }), { key: (catalog) => catalog.fields.join() })
  .result(a.object({ where: a.ref('Filter'), labels: a.record(a.string()), note: a.string().optional() }));

const Answer = a.object({ rows: a.int(), tags: a.record(a.number()) });

function request(): Request {
  return {
    messages: [{ role: 'user', content: 'Find them as JSON' }],
    tools: [{ name: 'lookup', description: 'Look up', parameters: Lookup.bind({ fields: ['name', 'email'] }), strict: 1 }],
    responseFormat: { type: Answer.bind(), strict: true },
  };
}

/** The body the provider sent for `m`. */
async function send(m: ModelInfo): Promise<any> {
  const ctx: AIContextAny = { ai: AI.with().providers({}).create({}), metadata: { model: m } };
  await new OpenRouterProvider({ apiKey: 'test' }).createExecutor()(request(), ctx, { model: m.id });
  const calls = mockOpenAI.chat.completions.create.mock.calls;
  return calls[calls.length - 1][0];
}

/** Every keyword anywhere in a JSON Schema tree. */
function keywords(node: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(node)) node.forEach(item => keywords(item, into));
  else if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      into.add(key);
      keywords(value, into);
    }
  }
  return into;
}

beforeEach(() => {
  mockOpenAI = {
    chat: { completions: { create: jest.fn().mockResolvedValue({ choices: [{ message: { content: '{"rows":1,"tags":{}}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }) } },
    models: { list: jest.fn() },
  };
});

describe('OpenRouter schema plan per upstream family', () => {
  it('anthropic/*: strict tool and output in the Anthropic strict dialect (records as pairs)', async () => {
    const body = await send(claude);
    const tool = body.tools[0].function;
    expect(tool.strict).toBe(true);
    expect(tool.parameters.additionalProperties).toBe(false);
    expect(tool.parameters.properties.labels.type).toBe('array');
    // Optionals are left out of `required` on Anthropic strict
    expect(tool.parameters.required).not.toContain('note');
    expect(body.response_format).toMatchObject({ type: 'json_schema', json_schema: { strict: true } });
    expect(body.response_format.json_schema.schema.properties.tags.type).toBe('array');
    expect(body.provider?.require_parameters).toBe(true);
  });

  it('google/*: strict, open records, no OpenAPI-only propertyOrdering', async () => {
    const body = await send(gemini);
    const tool = body.tools[0].function;
    expect(tool.strict).toBe(true);
    expect(tool.parameters.properties.labels).toMatchObject({ type: 'object', additionalProperties: { type: 'string' } });
    expect(keywords(tool.parameters).has('propertyOrdering')).toBe(false);
    expect(body.response_format.json_schema.strict).toBe(true);
    expect(body.response_format.json_schema.schema.properties.tags).toMatchObject({ type: 'object', additionalProperties: { type: 'number' } });
  });

  it('x-ai/*: tools strict without toolsStrict, open records', async () => {
    const body = await send(grok);
    const tool = body.tools[0].function;
    expect(tool.strict).toBe(true);
    expect(tool.parameters.properties.labels).toMatchObject({ type: 'object', additionalProperties: { type: 'string' } });
    expect(body.response_format.json_schema.strict).toBe(true);
  });

  it('pins the plan, so the call decodes in the dialect it was sent in', async () => {
    const sent = request();
    const ctx: AIContextAny = { ai: AI.with().providers({}).create({}), metadata: { model: claude } };
    await new OpenRouterProvider({ apiKey: 'test' }).createExecutor()(sent, ctx, { model: claude.id });

    const entry = sent.tools![0].plan!.get('lookup');
    expect(entry.profile.family).toBe('anthropic');
    const decoded = entry.parseText(JSON.stringify({ where: { field: 'email', equals: 'x' }, labels: [{ key: 'k', value: 'v' }] }));
    expect(decoded).toMatchObject({ ok: true, value: { where: { field: 'email', equals: 'x' }, labels: { k: 'v' } } });
    // A field outside the ctx's catalog is an error for the model
    expect(entry.parseText(JSON.stringify({ where: { field: 'phone', equals: 'x' }, labels: [] })).ok).toBe(false);
  });
});
