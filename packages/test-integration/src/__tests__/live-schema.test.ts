/**
 * Live schema acceptance: every model class takes each fixture as a strict
 * tool, a non-strict tool and structured output without an error. Where a
 * model has no strict support, the library must send the shape non-strict
 * rather than fail.
 */

import { describe, expect } from '@jest/globals';
import { AI } from '@aeye/ai';
import { getDescriptorById, type Request, type ToolDefinition } from '@aeye/core';
import { models, strictSupport } from '@aeye/models';
import { OpenAIProvider } from '@aeye/openai';
import { OpenRouterProvider } from '@aeye/openrouter';
import z from 'zod';
import { firstChunk, type LiveSource, liveCase } from '../live';
import { getAPIKey, hasAPIKey } from '../setup';

const describeLive = hasAPIKey('openai') && hasAPIKey('openrouter') ? describe : describe.skip;

// ============================================================================
// Fixtures
// ============================================================================

const identifiers = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, i) => `${prefix}_${['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot'][i % 6]}_${i}`);

interface Category {
  name: string;
  children?: Category[];
}
const category: z.ZodType<Category> = z.lazy(() => z.object({
  name: z.string().describe('Category name'),
  children: z.array(category).optional().describe('Sub-categories'),
})).meta({ id: 'Category' });

const address = z.object({
  street: z.string().min(1).max(200),
  city: z.string(),
  postcode: z.string().regex(/^[0-9]{5}$/).describe('Five digit postcode'),
  country: z.enum(['US', 'CA', 'MX', 'GB', 'DE', 'FR']),
});

/**
 * Everything the dialects disagree on, in one schema.
 */
const complex = z.object({
  id: z.uuid().describe('Order id'),
  createdAt: z.iso.datetime(),
  contact: z.email(),
  status: z.enum(['draft', 'placed', 'shipped', 'delivered', 'cancelled']),
  sku: z.enum(identifiers('sku', 120)).describe('Product code'),
  quantity: z.int().min(1).max(99),
  discount: z.number().min(0).max(1).nullable(),
  note: z.string().max(500).optional(),
  tags: z.array(z.string()).min(1).max(5),
  shipping: address,
  billing: address.nullable(),
  lines: z.array(z.object({
    sku: z.string(),
    price: z.number().positive(),
    options: z.array(z.object({
      key: z.string(),
      value: z.union([z.string(), z.number(), z.boolean()]),
    })),
  })).max(20),
  payment: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('card'), last4: z.string().regex(/^\d{4}$/) }),
    z.object({ kind: z.literal('invoice'), dueDays: z.int().min(0).max(90) }),
  ]),
  attributes: z.record(z.string(), z.string()).describe('Free-form attributes'),
  category,
  deep: z.object({ a: z.object({ b: z.object({ c: z.object({ d: z.object({ e: z.string() }) }) }) }) }),
});

const fixtures = {
  complex,
  // Over 250 values: OpenAI's large-enum rule and Gemini's enum cap
  'large-enum': z.object({ pick: z.enum(identifiers('component', 300)) }),
  // Over OpenAI's 10 levels of nesting
  'too-deep': z.object({ a: z.object({ b: z.object({ c: z.object({ d: z.object({ e: z.object({ f: z.object({
    g: z.object({ h: z.object({ i: z.object({ j: z.object({ k: z.string() }) }) }) }),
  }) }) }) }) }) }) }),
  // Over Anthropic's 24 optional parameters
  'many-optional': z.object(Object.fromEntries(identifiers('field', 30).map(name => [name, z.string().optional()]))),
  // Any values, tuples and open records
  'any-tuple': z.object({
    payload: z.any(),
    extra: z.record(z.string(), z.unknown()),
    point: z.tuple([z.number(), z.number(), z.string()]),
  }),
};

type Shape = 'strict-tool' | 'tool' | 'output';

// ============================================================================
// Model classes
// ============================================================================

const ROUTED = ['core', 'ai', 'openai', 'openrouter', 'models'] satisfies LiveSource[];
const DIRECT = ['core', 'ai', 'openai', 'models'] satisfies LiveSource[];

/**
 * An AI whose OpenAI provider goes through one API; the model id picks the provider.
 */
function create(api: 'chat' | 'responses') {
  return AI.with().providers({
    openai: new OpenAIProvider({ apiKey: getAPIKeyOrEmpty('openai'), api }),
    openrouter: new OpenRouterProvider({ apiKey: getAPIKeyOrEmpty('openrouter') }),
  }).create({ models, modelOverrides: strictSupport });
}

const paths = { openai: create('chat'), 'openai-responses': create('responses'), openrouter: create('chat') };

const classes: { provider: keyof typeof paths; model: string; sources: LiveSource[] }[] = [
  { provider: 'openai', model: 'gpt-5.4-nano', sources: DIRECT },
  { provider: 'openai', model: 'gpt-5.4-mini', sources: DIRECT },
  { provider: 'openai', model: 'gpt-4.1-mini', sources: DIRECT },
  { provider: 'openai', model: 'o3', sources: DIRECT },
  { provider: 'openai-responses', model: 'gpt-5.4-nano', sources: DIRECT },
  { provider: 'openrouter', model: 'anthropic/claude-haiku-5.5', sources: ROUTED },
  { provider: 'openrouter', model: 'google/gemini-2.5-flash-lite', sources: ROUTED },
  { provider: 'openrouter', model: 'google/gemini-3-flash-preview', sources: ROUTED },
  { provider: 'openrouter', model: 'x-ai/grok-4.3', sources: ROUTED },
  { provider: 'openrouter', model: 'deepseek/deepseek-v4.1-flash', sources: ROUTED },
  { provider: 'openrouter', model: 'qwen/qwen3.5-flash-02-23', sources: ROUTED },
  { provider: 'openrouter', model: 'mistralai/mistral-small-3.2-24b-instruct', sources: ROUTED },
  { provider: 'openrouter', model: 'meta-llama/llama-4-scout', sources: ROUTED },
  { provider: 'openrouter', model: 'openai/gpt-oss-20b', sources: ROUTED },
  { provider: 'openrouter', model: 'moonshotai/kimi-k2.5', sources: ROUTED },
  { provider: 'openrouter', model: 'z-ai/glm-4.7-flash', sources: ROUTED },
];

function getAPIKeyOrEmpty(provider: string): string {
  return hasAPIKey(provider) ? getAPIKey(provider) : '';
}

// ============================================================================
// Cases
// ============================================================================

describeLive('live schema acceptance', () => {
  for (const { provider, model, sources } of classes) {
    const ai = paths[provider];
    const info = ai.models.get(model);
    const strictTools = info?.capabilities.has('toolsStrict') ?? false;
    const shapes: Shape[] = info?.capabilities.has('structured') ? ['strict-tool', 'tool', 'output'] : ['strict-tool', 'tool'];

    for (const shape of shapes) {
      for (const [fixture, schema] of Object.entries(fixtures)) {
        liveCase(`schema ${provider} ${model} ${shape} ${fixture}`, { sources, inputs: { model, shape, fixture, strictTools } }, async () => {
          expect(info).toBeDefined();
          const tool: ToolDefinition = {
            name: 'record',
            description: 'Record the result.',
            parameters: schema,
            // A model without strict tools gets a preference, which must fall back
            strict: shape === 'tool' ? false : strictTools || 1,
          };
          const request: Request = shape === 'output'
            ? { messages: [{ role: 'user', content: 'Reply.' }], responseFormat: { type: schema, strict: 1 } }
            : { messages: [{ role: 'user', content: 'Reply.' }], tools: [tool], toolChoice: 'required' };

          // Accepted when the stream starts without an error; a model may
          // occasionally end its turn without a token
          await firstChunk((signal) => ai.chat.stream(request, { signal, metadata: { model } }));
          if (shape === 'strict-tool' && !strictTools) {
            expect(tool.descriptor).toBeDefined();
            expect(getDescriptorById(tool.descriptor).strict).toBe(false);
          }
        }, 120_000);
      }
    }
  }
});
