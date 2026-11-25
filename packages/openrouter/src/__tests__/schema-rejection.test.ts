/**
 * OpenRouter reports an upstream schema rejection as "Provider returned
 * error", with the upstream's message in `metadata.raw`.
 */

import { a } from '@aeye/schema';
import { AI, type AIContextAny, type ModelInfo } from '@aeye/ai';
import { SchemaRejectedError, type Request } from '@aeye/core';
import { OpenRouterProvider } from '../openrouter';

const mockCreate = jest.fn();
jest.mock('openai', () => jest.fn().mockImplementation(() => ({ chat: { completions: { create: mockCreate } } })));

const ctx: AIContextAny = { ai: AI.with().providers({}).create({}), metadata: {} };

/** Gemini as the registry knows it: structured output, so the schema goes as response_format. */
const flash: ModelInfo = {
  id: 'google/gemini-2.5-flash', provider: 'openrouter', name: 'Gemini 2.5 Flash', tier: 'efficient',
  capabilities: new Set(['chat', 'structured', 'json']), pricing: {}, contextWindow: 1_000_000,
};

/** An error shaped like the SDK's APIError for an upstream failure. */
function upstreamError(raw: string) {
  return Object.assign(new Error('400 Provider returned error'), {
    status: 400,
    error: { message: 'Provider returned error', code: 400, metadata: { raw, provider_name: 'Google' } },
  });
}

async function rejection(error: Error) {
  mockCreate.mockRejectedValue(error);
  const request: Request = {
    messages: [{ role: 'user', content: 'Answer' }],
    responseFormat: { type: a.object({ value: a.number() }).bind(), strict: 1 },
  };
  return new OpenRouterProvider({ apiKey: 'test' }).createExecutor()(request, ctx, { model: flash })
    .then(() => undefined, (e: unknown) => e);
}

describe('OpenRouter schema rejections', () => {
  it('reads the upstream message', async () => {
    const error = await rejection(upstreamError('{"error":{"message":"Invalid JSON payload received. Unknown name \\"additionalProperties\\" at \'generation_config.response_schema\'"}}'));
    expect(error).toBeInstanceOf(SchemaRejectedError);
    expect(error).toMatchObject({ target: { kind: 'output' } });
  });

  it('leaves other upstream errors alone', async () => {
    const original = upstreamError('{"error":{"message":"Model is overloaded"}}');
    expect(await rejection(original)).toBe(original);
  });
});
