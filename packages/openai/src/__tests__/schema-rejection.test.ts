/**
 * Schema rejections and schema delivery in the OpenAI provider.
 */

import { z } from 'zod';
import { AI, type AIContextAny } from '@aeye/ai';
import { SchemaRejectedError, type Request } from '@aeye/core';
import { OpenAIProvider } from '../openai';

const mockCreate = jest.fn();
jest.mock('openai', () => jest.fn().mockImplementation(() => ({ chat: { completions: { create: mockCreate } } })));

const ctx: AIContextAny = { ai: AI.with().providers({}).create({}), metadata: {} };

/** An error shaped like the SDK's APIError. */
function apiError(status: number, message: string) {
  return Object.assign(new Error(`${status} ${message}`), { status });
}

const lookup = { name: 'lookup', parameters: z.object({ q: z.string() }) };

function request(extra: Partial<Request>): Request {
  return { messages: [{ role: 'system', content: 'Answer.' }], ...extra };
}

async function rejection(sent: Request, error: Error) {
  mockCreate.mockRejectedValue(error);
  const executor = new OpenAIProvider({ apiKey: 'test' }).createExecutor();
  return executor(sent, ctx, { model: 'gpt-4o-mini' }).then(() => undefined, (e: unknown) => e);
}

describe('OpenAI schema rejections', () => {
  beforeEach(() => mockCreate.mockReset());

  it('classifies a rejected tool schema', async () => {
    const error = await rejection(request({ tools: [lookup] }), apiError(400, "Invalid schema for function 'lookup': In context=(), 'additionalProperties' is required"));
    expect(error).toBeInstanceOf(SchemaRejectedError);
    expect(error).toMatchObject({ target: { kind: 'tool', name: 'lookup' } });
  });

  it('classifies a rejected output schema', async () => {
    const sent = request({ responseFormat: { type: z.object({ value: z.number() }), strict: 1 } });
    const error = await rejection(sent, apiError(400, "Invalid schema for response_format 'response': ..."));
    expect(error).toMatchObject({ target: { kind: 'output' } });
  });

  it('leaves other errors alone', async () => {
    const original = apiError(400, "Unsupported parameter: 'temperature'");
    expect(await rejection(request({}), original)).toBe(original);
  });

  it('sends a json-delivered schema as JSON mode with the schema in the prompt', async () => {
    mockCreate.mockResolvedValue({ choices: [{ message: { content: '{"value":1}' }, finish_reason: 'stop' }] });
    const sent = request({ responseFormat: { type: z.object({ value: z.number() }), strict: 1, schemaDelivery: 'json' } });

    await new OpenAIProvider({ apiKey: 'test' }).createExecutor()(sent, ctx, { model: 'gpt-4o-mini' });

    const params = mockCreate.mock.calls[0][0];
    expect(params.response_format).toEqual({ type: 'json_object' });
    expect(JSON.stringify(params.messages)).toContain('conforming to this schema');
  });
});
