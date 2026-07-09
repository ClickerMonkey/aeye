/**
 * OpenRouter Provider Unit Tests
 *
 * Tests for OpenRouter-specific request augmentation with mocked HTTP calls.
 * No real API calls are made in these tests.
 */

import { OpenRouterProvider } from '../openrouter';
import type { OpenRouterConfig } from '../openrouter';
import { type Request, type AIContextAny, type ModelInfo, AI } from '@aeye/ai';
import { z } from 'zod';

// Mock the OpenAI SDK
let mockOpenAI: any;
jest.mock('openai', () => {
  return jest.fn().mockImplementation(() => mockOpenAI);
});

// A ModelInfo whose id resolves to the 'openai' strict family (via the slash
// prefix) and that advertises `structured` capability, so the parent provider
// actually emits a strict json_schema response_format for our detection to see.
const gpt4o: ModelInfo = {
  provider: 'openrouter',
  id: 'openai/gpt-4o',
  name: 'GPT-4o',
  capabilities: new Set(['chat', 'structured', 'streaming']),
  tier: 'flagship',
  pricing: {},
  contextWindow: 128000,
  metadata: {},
};

// pickModelInfo reads ctx.metadata.model when it is a full ModelInfo whose id
// matches the requested model id.
const ctxDefault: AIContextAny = {
  ai: AI.with().providers({}).create({}),
  metadata: { model: gpt4o },
};

const strictRequest: Request = {
  messages: [{ role: 'user', content: 'Return the query' }],
  responseFormat: { type: z.object({ query: z.string() }), strict: true },
};

const nonStrictRequest: Request = {
  messages: [{ role: 'user', content: 'Return the query' }],
  responseFormat: { type: z.object({ query: z.string() }), strict: false },
};

/** Build a request through the provider and return the body sent to the SDK. */
async function buildBody(provider: OpenRouterProvider, request: Request): Promise<any> {
  const executor = provider.createExecutor();
  await executor(request, ctxDefault, { model: 'openai/gpt-4o' });
  const calls = mockOpenAI.chat.completions.create.mock.calls;
  return calls[calls.length - 1][0];
}

describe('OpenRouterProvider strict structured output enforcement', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockOpenAI = {
      chat: {
        completions: {
          create: jest.fn().mockResolvedValue({
            id: 'test-id',
            choices: [{ message: { role: 'assistant', content: '{"query":"hi"}' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }),
        },
      },
      models: { list: jest.fn() },
    };
  });

  it('forces provider.require_parameters=true for a strict json_schema request', async () => {
    const provider = new OpenRouterProvider({ apiKey: 'test-key' });
    const body = await buildBody(provider, strictRequest);

    expect(body.response_format?.type).toBe('json_schema');
    expect(body.response_format?.json_schema?.strict).toBe(true);
    expect(body.provider?.require_parameters).toBe(true);
    // structured_outputs is expressed via response_format; not a separate body flag.
    expect(body.structured_outputs).toBeUndefined();
  });

  it('does NOT force require_parameters for a non-strict request', async () => {
    const provider = new OpenRouterProvider({ apiKey: 'test-key' });
    const body = await buildBody(provider, nonStrictRequest);

    expect(body.response_format?.json_schema?.strict).not.toBe(true);
    // No config and no strict schema => provider block stays untouched.
    expect(body.provider?.require_parameters).toBeUndefined();
  });

  it('respects the opt-out (requireParameters=false) even for a strict request', async () => {
    const config: OpenRouterConfig = {
      apiKey: 'test-key',
      defaultParams: { providers: { requireParameters: false } },
    };
    const provider = new OpenRouterProvider(config);
    const body = await buildBody(provider, strictRequest);

    expect(body.response_format?.json_schema?.strict).toBe(true);
    expect(body.provider?.require_parameters).toBe(false);
  });

  it('honors an explicit requireParameters=true from config', async () => {
    const config: OpenRouterConfig = {
      apiKey: 'test-key',
      defaultParams: { providers: { requireParameters: true } },
    };
    const provider = new OpenRouterProvider(config);
    const body = await buildBody(provider, nonStrictRequest);

    // Explicitly requested even though the schema is non-strict.
    expect(body.provider?.require_parameters).toBe(true);
  });

  it('merges auto-enforcement with an existing provider config (preserves allowFallbacks)', async () => {
    const config: OpenRouterConfig = {
      apiKey: 'test-key',
      defaultParams: { providers: { allowFallbacks: false, order: ['openai'] } },
    };
    const provider = new OpenRouterProvider(config);
    const body = await buildBody(provider, strictRequest);

    expect(body.provider?.require_parameters).toBe(true);
    expect(body.provider?.allow_fallbacks).toBe(false);
    expect(body.provider?.order).toEqual(['openai']);
  });

  it('leaves require_parameters undefined for a non-strict request with unrelated provider config', async () => {
    const config: OpenRouterConfig = {
      apiKey: 'test-key',
      defaultParams: { providers: { allowFallbacks: true } },
    };
    const provider = new OpenRouterProvider(config);
    const body = await buildBody(provider, nonStrictRequest);

    expect(body.provider?.require_parameters).toBeUndefined();
    expect(body.provider?.allow_fallbacks).toBe(true);
  });
});
