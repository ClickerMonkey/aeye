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

/**
 * Per-family TOOL schema dialects.
 *
 * OpenRouter is a router: the wire dialect that matters is the UPSTREAM
 * model's, which `resolveStrictFormat` derives from the `[family]/…` id
 * prefix. The inherited `supportedStrictFamilies` was `['openai']` — correct
 * for api.openai.com, wrong here — so every non-OpenAI model's tool schemas
 * were compiled with LENIENT no matter what the curated `strictSupport` table
 * said. Structured output looked family-aware only because
 * `applySchemaDeliveryFallback` resolves the family itself, on a path that
 * covers `response_format` and not tools.
 *
 * The concrete symptom: LENIENT encodes `z.any()` as a self-referencing
 * `$defs/Any` built from `anyOf`, and Gemini answers `400 INVALID_ARGUMENT`
 * to that as soon as a tool call is forced (`toolChoice: 'required'` →
 * Google's function-calling mode `ANY`, which compiles the tool schemas into
 * a decoding grammar). Under `'auto'` no grammar is built and the same
 * request succeeds — which is why this looked like a tool-choice bug.
 */
describe('OpenRouterProvider tool schema dialects', () => {
  /**
   * Mirrors the real `ModelInfo` captured from a failing run: the curated
   * `strictSupport` table matches `^google/gemini-(2\.0|2\.5|3|3\.1)` and
   * pins `strictFormat: 'google'`, which auto-derives `'toolsStrict'`.
   */
  const model = (id: string, family: 'openai' | 'anthropic' | 'google'): ModelInfo => ({
    provider: 'openrouter',
    id,
    name: id,
    capabilities: new Set(['chat', 'tools', 'toolsStrict', 'structured', 'streaming']),
    tier: 'flagship',
    pricing: {},
    contextWindow: 1_000_000,
    strictFormat: family,
    metadata: {},
  });

  const gemini3 = model('google/gemini-3-flash-preview', 'google');

  /**
   * The `[kind]_signature` tool every kind-authoring agent carries: a named
   * object that also accepts arbitrary extra JSON — an open TypeDef. `strict`
   * is `1` because that is what `Tool.toRequestTool` assigns when the author
   * leaves it unset.
   */
  const signatureTool = {
    name: 'api_signature',
    description: 'Declare the signature of the API function.',
    parameters: z.object({
      signature: z.object({ name: z.string() })
        .catchall(z.any())
        .describe('The signature of the API function being declared.'),
    }),
    strict: 1,
  };

  /** Every keyword appearing anywhere in a JSON-Schema tree. */
  const keywordsIn = (node: unknown, into = new Set<string>()): Set<string> => {
    if (Array.isArray(node)) {
      for (const item of node) keywordsIn(item, into);
    } else if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        into.add(k);
        keywordsIn(v, into);
      }
    }
    return into;
  };

  /** Run a tool request through the provider and return the body sent to the SDK. */
  async function buildToolBody(m: ModelInfo, request: Request): Promise<any> {
    const provider = new OpenRouterProvider({ apiKey: 'test-key' });
    const ctx: AIContextAny = { ai: AI.with().providers({}).create({}), metadata: { model: m } };
    await provider.createExecutor()(request, ctx, { model: m.id });
    const calls = mockOpenAI.chat.completions.create.mock.calls;
    return calls[calls.length - 1][0];
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockOpenAI = {
      chat: {
        completions: {
          create: jest.fn().mockResolvedValue({
            id: 'test-id',
            choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }),
        },
      },
      models: { list: jest.fn() },
    };
  });

  it('resolves the GOOGLE dialect for a google/* model instead of falling back to LENIENT', async () => {
    const request: Request = {
      messages: [{ role: 'user', content: 'Declare it' }],
      tools: [{ ...signatureTool }],
    };
    await buildToolBody(gemini3, request);

    // The descriptor the provider pinned for the validation roundtrip is the
    // observable proof of which dialect was chosen.
    expect(request.tools![0].descriptor).toBe('google-strict');
  });

  it('REGRESSION: the emitted google tool schema carries no anyOf / oneOf / allOf / $defs / $ref', async () => {
    const request: Request = {
      messages: [{ role: 'user', content: 'Declare it' }],
      tools: [{ ...signatureTool }],
      // The exact trigger: forcing a tool call is what makes Gemini compile a
      // grammar from these schemas. Asserted at the wire level, not changed.
      toolChoice: 'required',
    };
    const body = await buildToolBody(gemini3, request);

    expect(body.tool_choice).toBe('required');
    const parameters = body.tools[0].function.parameters;
    const keywords = keywordsIn(parameters);
    for (const forbidden of ['anyOf', 'oneOf', 'allOf', '$defs', '$ref']) {
      expect([forbidden, keywords.has(forbidden)]).toEqual([forbidden, false]);
    }

    // The open-value tail is still open, and the named field survives.
    expect(parameters.properties.signature.additionalProperties).toEqual({});
    expect(parameters.properties.signature.properties.name.type).toBe('string');
  });

  it('still resolves the OpenAI dialect for an openai/* model', async () => {
    const request: Request = {
      messages: [{ role: 'user', content: 'Declare it' }],
      tools: [{ ...signatureTool }],
    };
    await buildToolBody(model('openai/gpt-4o', 'openai'), request);
    expect(request.tools![0].descriptor).toBe('openai-strict');
  });

  it('resolves the Anthropic dialect for an anthropic/* model', async () => {
    const request: Request = {
      messages: [{ role: 'user', content: 'Declare it' }],
      tools: [{ ...signatureTool }],
    };
    await buildToolBody(model('anthropic/claude-sonnet-4-5', 'anthropic'), request);
    expect(request.tools![0].descriptor).toBe('anthropic-strict');
  });

  it('leaves an unknown family on LENIENT', async () => {
    const unknown: ModelInfo = {
      ...model('mistralai/mistral-large', 'openai'),
      strictFormat: undefined,
    };
    const request: Request = {
      messages: [{ role: 'user', content: 'Declare it' }],
      tools: [{ ...signatureTool }],
    };
    await buildToolBody(unknown, request);
    expect(request.tools![0].descriptor).toBe('lenient');
  });
});
