/**
 * Tests for the automatic schema-delivery fallback wiring
 * (`applySchemaDeliveryFallback`).
 *
 * Verifies that a structured schema the selected model's dialect can't express
 * (e.g. a union under a Google-family model) transparently drops the wire
 * schema and delivers it as prompt text, while models that CAN express it (and
 * `schemaDelivery: 'structured'`) keep `response_format`.
 */

import { z } from 'zod';
import type { Message, Request, ResponseFormat, SchemaDelivery } from '@aeye/core';
import { GOOGLE_STRICT, getJsonFallbackInstruction } from '@aeye/core';
import { applySchemaDeliveryFallback } from '../apis/schema-fallback';
import type { ModelInfo } from '../types';

function makeModel(provider: string, id: string): ModelInfo {
  return {
    id,
    provider,
    name: id,
    capabilities: new Set(['chat', 'streaming', 'structured']),
    tier: 'flagship',
    pricing: { text: { input: 1, output: 1 } },
    contextWindow: 8192,
    maxOutputTokens: 4096,
  };
}

const unionSchema = z.object({
  id: z.string(),
  value: z.union([z.string(), z.number()]),
});

const plainSchema = z.object({ id: z.string(), name: z.string() });

function makeRequest(schema: z.ZodType<object, object>, schemaDelivery: SchemaDelivery): Request {
  const responseFormat: ResponseFormat = { type: schema, strict: false, schemaDelivery };
  const messages: Message[] = [{ role: 'system', content: 'You are a helpful assistant.' }];
  return { messages, responseFormat };
}

function systemContent(request: Request): string {
  const sys = request.messages.find((m) => m.role === 'system');
  return typeof sys?.content === 'string' ? sys.content : '';
}

describe('applySchemaDeliveryFallback', () => {
  describe("Google-family model + union schema + 'auto'", () => {
    it('drops response_format and appends schema text + the Google instruction', () => {
      const request = makeRequest(unionSchema, 'auto');
      applySchemaDeliveryFallback(request, makeModel('openrouter', 'google/gemini-2.5-pro'));

      // Wire schema dropped — no provider will emit response_format.
      expect(request.responseFormat).toBeUndefined();

      // Schema delivered as prompt text + the Google-family fallback hint.
      const content = systemContent(request);
      expect(content).toContain('You are a helpful assistant.');
      expect(content).toContain('JSON object conforming to this schema');
      expect(content).toContain('"anyOf"');
      expect(content).toContain(getJsonFallbackInstruction(GOOGLE_STRICT));
    });

    it('resolves the google dialect from the id prefix when provider is openrouter', () => {
      const request = makeRequest(unionSchema, 'auto');
      applySchemaDeliveryFallback(request, makeModel('openrouter', 'google/gemini-2.5-flash'));
      expect(request.responseFormat).toBeUndefined();
    });

    it('is idempotent — re-applying does not duplicate the schema text', () => {
      const request = makeRequest(unionSchema, 'auto');
      const model = makeModel('openrouter', 'google/gemini-2.5-pro');
      applySchemaDeliveryFallback(request, model);
      const afterFirst = systemContent(request);

      // Simulate a later iteration re-setting a structured responseFormat
      // (as a dynamic prompt would) and re-running the fallback.
      request.responseFormat = { type: unionSchema, strict: false, schemaDelivery: 'auto' };
      applySchemaDeliveryFallback(request, model);

      expect(request.responseFormat).toBeUndefined();
      expect(systemContent(request)).toBe(afterFirst);
    });
  });

  describe("schemaDelivery: 'structured'", () => {
    it('keeps response_format even for a Google model that cannot express the schema', () => {
      const request = makeRequest(unionSchema, 'structured');
      applySchemaDeliveryFallback(request, makeModel('openrouter', 'google/gemini-2.5-pro'));
      expect(request.responseFormat).toBeDefined();
      expect(typeof request.responseFormat).toBe('object');
      expect(systemContent(request)).toBe('You are a helpful assistant.');
    });
  });

  describe("schemaDelivery: 'prompt'", () => {
    it('always drops response_format, even for OpenAI + a plain schema', () => {
      const request = makeRequest(plainSchema, 'prompt');
      applySchemaDeliveryFallback(request, makeModel('openai', 'gpt-4o'));
      expect(request.responseFormat).toBeUndefined();
      expect(systemContent(request)).toContain('conforming to this schema');
    });
  });

  describe("OpenAI + union schema + 'auto' (no regression)", () => {
    it('keeps structured output (response_format present)', () => {
      const request = makeRequest(unionSchema, 'auto');
      applySchemaDeliveryFallback(request, makeModel('openai', 'gpt-4o'));
      expect(request.responseFormat).toBeDefined();
      expect(typeof request.responseFormat).toBe('object');
      expect(systemContent(request)).toBe('You are a helpful assistant.');
    });
  });

  describe('non-structured response formats', () => {
    it('is a no-op for text', () => {
      const request: Request = { messages: [{ role: 'user', content: 'hi' }], responseFormat: 'text' };
      applySchemaDeliveryFallback(request, makeModel('openrouter', 'google/gemini-2.5-pro'));
      expect(request.responseFormat).toBe('text');
    });

    it('is a no-op when there is no responseFormat', () => {
      const request: Request = { messages: [{ role: 'user', content: 'hi' }] };
      applySchemaDeliveryFallback(request, makeModel('openrouter', 'google/gemini-2.5-pro'));
      expect(request.responseFormat).toBeUndefined();
    });
  });

  describe('parse hook can validate the model text JSON after fallback', () => {
    it('the dropped schema still validates a conforming instance', () => {
      const request = makeRequest(unionSchema, 'auto');
      applySchemaDeliveryFallback(request, makeModel('openrouter', 'google/gemini-2.5-pro'));

      // A model reply (fenced) → the Prompt extracts + parses it; the schema
      // (kept by the Prompt) still validates the conceptual value.
      const reply = '```json\n' + JSON.stringify({ id: 'x', value: 5 }) + '\n```';
      const start = reply.indexOf('{');
      const json = reply.slice(start, reply.lastIndexOf('}') + 1);
      const parsed = unionSchema.safeParse(JSON.parse(json));
      expect(parsed.success).toBe(true);
    });
  });
});
