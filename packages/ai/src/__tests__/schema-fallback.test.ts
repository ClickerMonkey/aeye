/**
 * Schema delivery as a provider prepares a request for the selected model
 * (`prepareRequest` in `@aeye/core`, which replaced the ai layer's
 * `applySchemaDeliveryFallback`).
 *
 * `@aeye/schema` always renders something the model's dialect can take (an
 * intersection is merged, recursion becomes JSON text, ...), so there is no
 * "inexpressible schema → prompt" switch any more. An output goes into the
 * system prompt when delivery says so (`'json'` / `'prompt'`) or when the
 * model can't take it as structured output (Claude without `'structured'`,
 * a model with neither `'structured'` nor `'json'`).
 */

import { a } from '@aeye/schema';
import type { Bound, Message, Request, ResponseFormat, SchemaDelivery } from '@aeye/core';
import { prepareRequest, sentOutput } from '@aeye/core';
import type { ModelCapability, ModelInfo } from '../types';

function makeModel(provider: string, id: string, capabilities: ModelCapability[] = ['chat', 'streaming', 'structured']): ModelInfo {
  return {
    id,
    provider,
    name: id,
    capabilities: new Set(capabilities),
    tier: 'flagship',
    pricing: { text: { input: 1, output: 1 } },
    contextWindow: 8192,
    maxOutputTokens: 4096,
  };
}

const unionSchema = a.object({
  id: a.string(),
  value: a.union([a.string(), a.number()]),
});

const allOfSchema = a.object({
  id: a.string(),
  value: a.intersection([a.object({ a: a.string() }), a.object({ b: a.number() })]),
});

const plainSchema = a.object({ id: a.string(), name: a.string() });

function makeRequest(schema: Bound<any>, schemaDelivery: SchemaDelivery, strict: boolean | number = false): Request {
  const responseFormat: ResponseFormat = { type: schema, strict, schemaDelivery };
  const messages: Message[] = [{ role: 'system', content: 'You are a helpful assistant.' }];
  return { messages, responseFormat };
}

function systemContent(request: Request): string {
  const sys = request.messages.find((m) => m.role === 'system');
  return typeof sys?.content === 'string' ? sys.content : '';
}

const PROMPT_HEADER = 'The response must be JSON of this type:';

describe('prepareRequest schema delivery', () => {
  describe("Google-family model + intersection + 'auto'", () => {
    it('keeps the intersection structured (merged into one object)', async () => {
      const request = await prepareRequest(makeRequest(allOfSchema.bind(), 'auto'), makeModel('openrouter', 'google/gemini-2.5-pro'));
      expect(typeof request.responseFormat).toBe('object');
      expect(systemContent(request)).toBe('You are a helpful assistant.');
      const output = sentOutput(request)!;
      expect(output).toBeDefined();
      const value = (output.schema as any).properties.value;
      expect(value.allOf).toBeUndefined();
      expect(Object.keys(value.properties).sort()).toEqual(['a', 'b']);
    });

    it('keeps a union structured', async () => {
      const request = await prepareRequest(makeRequest(unionSchema.bind(), 'auto'), makeModel('openrouter', 'google/gemini-3.5-flash'));
      expect(sentOutput(request)).toBeDefined();
    });
  });

  describe("schemaDelivery: 'prompt'", () => {
    it('always drops response_format, even for OpenAI + a plain schema', async () => {
      const original = makeRequest(plainSchema.bind(), 'prompt');
      const request = await prepareRequest(original, makeModel('openai', 'gpt-4o'));
      expect(request.responseFormat).toBeUndefined();
      expect(sentOutput(request)).toBeUndefined();
      expect(systemContent(request)).toContain('You are a helpful assistant.');
      expect(systemContent(request)).toContain(PROMPT_HEADER);
      expect(systemContent(request)).toMatch(/id: string/);
      expect(request.plan!.output!.delivery).toBe('prompt');
    });

    it('leaves the original request unchanged, so a prompt can resend it', async () => {
      const original = makeRequest(plainSchema.bind(), 'prompt');
      const sent = await prepareRequest(original, makeModel('openai', 'gpt-4o'));
      expect(sent).not.toBe(original);
      expect(typeof original.responseFormat).toBe('object');
      expect(systemContent(original)).toBe('You are a helpful assistant.');
      expect(systemContent(sent)).toContain(PROMPT_HEADER);
    });
  });

  describe("schemaDelivery: 'json'", () => {
    it('asks for JSON mode with the schema in the prompt', async () => {
      const request = await prepareRequest(makeRequest(plainSchema.bind(), 'json'), makeModel('openai', 'gpt-4o'));
      expect(request.responseFormat).toBe('json');
      expect(systemContent(request)).toContain(PROMPT_HEADER);
    });
  });

  describe("schemaDelivery: 'structured'", () => {
    it('keeps response_format', async () => {
      const request = await prepareRequest(makeRequest(plainSchema.bind(), 'structured'), makeModel('openrouter', 'google/gemini-2.5-pro'));
      expect(typeof request.responseFormat).toBe('object');
      expect(systemContent(request)).toBe('You are a helpful assistant.');
    });
  });

  describe("OpenAI + union schema + 'auto'", () => {
    it('keeps structured output (strict when asked and the model has structured)', async () => {
      const request = await prepareRequest(makeRequest(unionSchema.bind(), 'auto', 1), makeModel('openai', 'gpt-4o'));
      const output = sentOutput(request)!;
      expect(output).toBeDefined();
      expect(output.strict).toBe(true);
      expect(systemContent(request)).toBe('You are a helpful assistant.');
    });
  });

  describe('a model that cannot take the output structured', () => {
    it("Claude without 'structured' gets the output as prompt text", async () => {
      const request = await prepareRequest(makeRequest(plainSchema.bind(), 'auto', 1), makeModel('anthropic', 'claude-sonnet-4', ['chat', 'tools']));
      expect(request.responseFormat).toBeUndefined();
      expect(systemContent(request)).toContain(PROMPT_HEADER);
    });
  });

  describe('non-structured response formats', () => {
    it('is a no-op for text', async () => {
      const request = await prepareRequest({ messages: [{ role: 'user', content: 'hi' }], responseFormat: 'text' }, makeModel('openrouter', 'google/gemini-2.5-pro'));
      expect(request.responseFormat).toBe('text');
      expect(request.messages).toHaveLength(1);
    });

    it('is a no-op when there is no responseFormat', async () => {
      const request = await prepareRequest({ messages: [{ role: 'user', content: 'hi' }] }, makeModel('openrouter', 'google/gemini-2.5-pro'));
      expect(request.responseFormat).toBeUndefined();
      expect(request.messages).toHaveLength(1);
    });
  });

  describe('the answer is decoded through the plan after prompt delivery', () => {
    it('parses a conforming reply', async () => {
      const request = await prepareRequest(makeRequest(unionSchema.bind(), 'prompt'), makeModel('openrouter', 'google/gemini-2.5-pro'));
      const parsed = request.plan!.output!.parseText(JSON.stringify({ id: 'x', value: 5 }));
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.value).toEqual({ id: 'x', value: 5 });
    });
  });
});
