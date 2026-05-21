/**
 * AWS Bedrock Provider Tests
 *
 * Note: These tests verify the provider structure without making actual AWS API calls.
 * For integration tests with real AWS credentials, see __integration__ tests.
 */

import z from 'zod';
import type { Chunk, ModelInfo } from '@aeye/core';
import { AWSBedrockProvider, type AWSBedrockConfig } from '../aws';
import { AWSError, AWSAuthError, AWSRateLimitError } from '../types';
import { detectAWSCapabilities, detectAWSFamily, detectAWSTier } from '../common';
import { FoundationModelSummary } from '@aws-sdk/client-bedrock';

describe('AWSBedrockProvider Types', () => {
  describe('Error classes', () => {
    it('should create AWSError', () => {
      const error = new AWSError('Test error');
      expect(error).toBeDefined();
      expect(error.message).toContain('[aws-bedrock] Test error');
      expect(error.name).toBe('AWSError');
    });

    it('should create AWSAuthError', () => {
      const error = new AWSAuthError();
      expect(error).toBeDefined();
      expect(error.message).toContain('Authentication failed');
      expect(error.name).toBe('AWSAuthError');
    });

    it('should create AWSRateLimitError', () => {
      const error = new AWSRateLimitError('Rate limited', 60);
      expect(error).toBeDefined();
      expect(error.message).toContain('Rate limited');
      expect(error.retryAfter).toBe(60);
      expect(error.name).toBe('AWSRateLimitError');
    });
  });
});

describe('AWSBedrockProvider', () => {
  const config: AWSBedrockConfig = {
    region: 'us-east-1',
    credentials: {
      accessKeyId: 'test-key',
      secretAccessKey: 'test-secret',
    },
  };

  it('should instantiate with config', () => {
    const provider = new AWSBedrockProvider(config);
    expect(provider).toBeDefined();
    expect(provider.name).toBe('aws-bedrock');
    expect(provider.config).toEqual(config);
  });

  it('should create an executor function', () => {
    const provider = new AWSBedrockProvider(config);
    const executor = provider.createExecutor();
    expect(typeof executor).toBe('function');
  });

  it('should create a streamer function', () => {
    const provider = new AWSBedrockProvider(config);
    const streamer = provider.createStreamer();
    expect(typeof streamer).toBe('function');
  });

  it('executor should throw when no model is provided', async () => {
    const provider = new AWSBedrockProvider(config);
    const executor = provider.createExecutor();
    await expect(
      executor({ messages: [{ role: 'user', content: 'Hello' }] }, {})
    ).rejects.toThrow('Model is required');
  });

  it('streamer should throw when no model is provided', async () => {
    const provider = new AWSBedrockProvider(config);
    const streamer = provider.createStreamer();
    const gen = streamer({ messages: [{ role: 'user', content: 'Hello' }] }, {});
    await expect(gen.next()).rejects.toThrow('Model is required');
  });
});

describe('detectAWSFamily', () => {
  it('should detect anthropic family', () => {
    expect(detectAWSFamily('anthropic.claude-3-sonnet-20240229-v1:0')).toBe('anthropic');
  });

  it('should detect meta family', () => {
    expect(detectAWSFamily('meta.llama3-8b-instruct-v1:0')).toBe('meta');
  });

  it('should detect mistral family', () => {
    expect(detectAWSFamily('mistral.mistral-7b-instruct-v0:2')).toBe('mistral');
  });

  it('should detect cohere family', () => {
    expect(detectAWSFamily('cohere.command-r-v1:0')).toBe('cohere');
  });

  it('should detect amazon family', () => {
    expect(detectAWSFamily('amazon.titan-embed-text-v2:0')).toBe('amazon');
  });

  it('should return unknown for unrecognized models', () => {
    expect(detectAWSFamily('unknown.model-v1:0')).toBe('unknown');
  });
});

describe('detectAWSCapabilities', () => {
  const makeModel = (modelId: string, overrides: Partial<FoundationModelSummary> = {}): FoundationModelSummary => ({
    modelId,
    modelName: modelId,
    providerName: modelId.split('.')[0],
    inputModalities: ['TEXT'],
    outputModalities: ['TEXT'],
    responseStreamingSupported: true,
    ...overrides,
  });

  it('should detect chat and streaming for Claude', () => {
    const caps = detectAWSCapabilities(makeModel('anthropic.claude-3-sonnet-20240229-v1:0'));
    expect(caps.has('chat')).toBe(true);
    expect(caps.has('streaming')).toBe(true);
  });

  it('should detect tools for Claude', () => {
    const caps = detectAWSCapabilities(makeModel('anthropic.claude-3-sonnet-20240229-v1:0'));
    expect(caps.has('tools')).toBe(true);
  });

  it('should detect tools for Llama 3.1', () => {
    const caps = detectAWSCapabilities(makeModel('meta.llama3-1-70b-instruct-v1:0'));
    expect(caps.has('tools')).toBe(true);
  });

  it('should detect tools for Llama 3.2', () => {
    const caps = detectAWSCapabilities(makeModel('meta.llama3-2-11b-instruct-v1:0'));
    expect(caps.has('tools')).toBe(true);
  });

  it('should detect tools for Mistral Large', () => {
    const caps = detectAWSCapabilities(makeModel('mistral.mistral-large-2407-v1:0'));
    expect(caps.has('tools')).toBe(true);
  });

  it('should detect tools for Cohere Command R', () => {
    const caps = detectAWSCapabilities(makeModel('cohere.command-r-v1:0'));
    expect(caps.has('tools')).toBe(true);
  });

  it('should detect embedding for Amazon Titan', () => {
    const caps = detectAWSCapabilities(makeModel('amazon.titan-embed-text-v2:0'));
    expect(caps.has('embedding')).toBe(true);
  });

  it('should detect vision for multimodal models', () => {
    const caps = detectAWSCapabilities(makeModel('anthropic.claude-3-sonnet-20240229-v1:0', {
      inputModalities: ['TEXT', 'IMAGE'],
      outputModalities: ['TEXT'],
    }));
    expect(caps.has('vision')).toBe(true);
  });
});

describe('detectAWSTier', () => {
  it('should return flagship for Claude Opus', () => {
    expect(detectAWSTier('anthropic', 'anthropic.claude-3-opus-20240229-v1:0')).toBe('flagship');
  });

  it('should return efficient for Claude Sonnet', () => {
    expect(detectAWSTier('anthropic', 'anthropic.claude-3-sonnet-20240229-v1:0')).toBe('efficient');
  });

  it('should return flagship for Mistral Large', () => {
    expect(detectAWSTier('mistral', 'mistral.mistral-large-2402-v1:0')).toBe('flagship');
  });

  it('should return flagship for Cohere Command R Plus', () => {
    expect(detectAWSTier('cohere', 'cohere.command-r-plus-v1:0')).toBe('flagship');
  });
});

/**
 * Streaming tool-call assembly tests.
 *
 * The Converse stream uses Bedrock's native content-block events. Unlike the
 * OpenAI Chat Completions delta stream — where a chunk with no `tool_calls`
 * update could (until the recent fix) be mistaken for "tool call done" — the
 * Bedrock stream signals completion explicitly via `contentBlockStop`. These
 * tests pin that behavior so a future refactor can't reintroduce the
 * premature-finalization regression that bit the OpenAI provider.
 */
describe('AWSBedrockProvider — streaming tool-call assembly', () => {
  const config: AWSBedrockConfig = {
    region: 'us-east-1',
    credentials: { accessKeyId: 'test-key', secretAccessKey: 'test-secret' },
  };

  /** Build a fake Bedrock client whose `send()` returns the given event sequence. */
  function makeFakeClient(events: any[]) {
    return {
      send: jest.fn().mockResolvedValue({
        stream: (async function* () {
          for (const ev of events) yield ev;
        })(),
      }),
    };
  }

  async function collectChunks(streamer: any, request: any, ctx: any = {}): Promise<Chunk[]> {
    const chunks: Chunk[] = [];
    for await (const chunk of streamer(request, ctx)) {
      chunks.push(chunk);
    }
    return chunks;
  }

  it('chunk.toolCall fires exactly once, AFTER contentBlockStop, with fully-accumulated arguments', async () => {
    const provider = new AWSBedrockProvider(config);
    // Build a synthetic event stream: start tool, three partial-arg deltas,
    // contentBlockStop, messageStop, then a usage metadata event.
    const events = [
      { contentBlockStart: { contentBlockIndex: 0, start: { toolUse: { toolUseId: 'toolu_1', name: 'sentiment' } } } },
      { contentBlockDelta: { contentBlockIndex: 0, delta: { toolUse: { input: '{"text":"' } } } },
      { contentBlockDelta: { contentBlockIndex: 0, delta: { toolUse: { input: 'I like ' } } } },
      { contentBlockDelta: { contentBlockIndex: 0, delta: { toolUse: { input: 'pancakes"}' } } } },
      { contentBlockStop: { contentBlockIndex: 0 } },
      { messageStop: { stopReason: 'tool_use' } },
      { metadata: { usage: { inputTokens: 100, outputTokens: 20 } } },
    ];
    (provider as any).bedrockRuntimeClient = makeFakeClient(events);

    const streamer = provider.createStreamer();
    const chunks = await collectChunks(streamer, {
      model: 'anthropic.claude-3-sonnet-20240229-v1:0',
      messages: [{ role: 'user', content: 'go' }],
    });

    // The terminal `toolCall` chunk fires exactly once with the full args.
    const toolCallChunks = chunks.filter((c) => c.toolCall);
    expect(toolCallChunks).toHaveLength(1);
    expect(toolCallChunks[0].toolCall).toEqual({
      id: 'toolu_1',
      name: 'sentiment',
      arguments: '{"text":"I like pancakes"}',
    });

    // toolCallNamed fires once with empty args (Bedrock sends name before any input).
    const namedChunks = chunks.filter((c) => c.toolCallNamed);
    expect(namedChunks).toHaveLength(1);
    expect(namedChunks[0].toolCallNamed!.arguments).toBe('');

    // Three toolCallArguments chunks track the accumulating args — strictly
    // monotonic, never resetting or pulling backwards.
    const argChunks = chunks.filter((c) => c.toolCallArguments).map((c) => c.toolCallArguments!.arguments);
    expect(argChunks).toEqual([
      '{"text":"',
      '{"text":"I like ',
      '{"text":"I like pancakes"}',
    ]);

    // chunk.toolCall arrives AFTER all toolCallArguments (no premature finalize).
    const toolCallIdx = chunks.findIndex((c) => c.toolCall);
    const lastArgIdx = chunks.map((c, i) => (c.toolCallArguments ? i : -1)).filter((i) => i >= 0).pop()!;
    expect(toolCallIdx).toBeGreaterThan(lastArgIdx);
  });

  it('multiple parallel tool calls each finalize on their own contentBlockStop', async () => {
    const provider = new AWSBedrockProvider(config);
    // Two parallel tool calls — Bedrock interleaves them by contentBlockIndex.
    // Each gets its own start/delta/stop sequence.
    const events = [
      { contentBlockStart: { contentBlockIndex: 0, start: { toolUse: { toolUseId: 'toolu_A', name: 'getWeather' } } } },
      { contentBlockStart: { contentBlockIndex: 1, start: { toolUse: { toolUseId: 'toolu_B', name: 'getStock' } } } },
      { contentBlockDelta: { contentBlockIndex: 0, delta: { toolUse: { input: '{"city":"NYC"}' } } } },
      { contentBlockDelta: { contentBlockIndex: 1, delta: { toolUse: { input: '{"sym":"' } } } },
      { contentBlockStop: { contentBlockIndex: 0 } },
      { contentBlockDelta: { contentBlockIndex: 1, delta: { toolUse: { input: 'AAPL"}' } } } },
      { contentBlockStop: { contentBlockIndex: 1 } },
      { messageStop: { stopReason: 'tool_use' } },
    ];
    (provider as any).bedrockRuntimeClient = makeFakeClient(events);

    const streamer = provider.createStreamer();
    const chunks = await collectChunks(streamer, {
      model: 'anthropic.claude-3-sonnet-20240229-v1:0',
      messages: [{ role: 'user', content: 'go' }],
    });

    const finals = chunks.filter((c) => c.toolCall).map((c) => c.toolCall!);
    expect(finals).toHaveLength(2);
    // Order: tool A finishes first (its contentBlockStop comes first), then B.
    expect(finals[0]).toEqual({ id: 'toolu_A', name: 'getWeather', arguments: '{"city":"NYC"}' });
    expect(finals[1]).toEqual({ id: 'toolu_B', name: 'getStock', arguments: '{"sym":"AAPL"}' });

    // Tool B's args continue streaming AFTER tool A's finalization — assert
    // tool A's `toolCall` chunk doesn't accidentally pull in B's data.
    const aFinalIdx = chunks.findIndex((c) => c.toolCall?.id === 'toolu_A');
    const bSecondDeltaIdx = chunks
      .map((c, i) => (c.toolCallArguments?.id === 'toolu_B' && c.toolCallArguments.arguments.includes('AAPL') ? i : -1))
      .find((i) => i >= 0);
    expect(bSecondDeltaIdx).toBeGreaterThan(aFinalIdx);
  });

  it('intermediate text + usage events do NOT prematurely finalize an in-flight tool call', async () => {
    // Equivalent of the OpenAI bug: a chunk that isn't a tool-call update
    // arriving between deltas. Bedrock's contentBlockStop is the only
    // signal that finalizes — text deltas and usage events do not.
    const provider = new AWSBedrockProvider(config);
    const events = [
      { contentBlockStart: { contentBlockIndex: 0, start: { toolUse: { toolUseId: 'toolu_X', name: 'foo' } } } },
      { contentBlockDelta: { contentBlockIndex: 0, delta: { toolUse: { input: '{"a":' } } } },
      // Interleaved noise: text content and a usage update — neither should
      // trigger chunk.toolCall.
      { contentBlockDelta: { contentBlockIndex: 1, delta: { text: 'thinking…' } } },
      { metadata: { usage: { inputTokens: 50, outputTokens: 5 } } },
      { contentBlockDelta: { contentBlockIndex: 0, delta: { toolUse: { input: '1}' } } } },
      { contentBlockStop: { contentBlockIndex: 0 } },
      { messageStop: { stopReason: 'tool_use' } },
    ];
    (provider as any).bedrockRuntimeClient = makeFakeClient(events);

    const streamer = provider.createStreamer();
    const chunks = await collectChunks(streamer, {
      model: 'anthropic.claude-3-sonnet-20240229-v1:0',
      messages: [{ role: 'user', content: 'go' }],
    });

    const finals = chunks.filter((c) => c.toolCall).map((c) => c.toolCall!);
    expect(finals).toHaveLength(1);
    expect(finals[0]).toEqual({ id: 'toolu_X', name: 'foo', arguments: '{"a":1}' });
  });
});

/**
 * Tool-schema emission tests.
 *
 * The AWS provider feeds tool schemas through the same
 * `strictify` + `toJSONSchema` pipeline that OpenAI does, with the
 * descriptor picked by `resolveStrictFormat(model)` against
 * `supportedStrictFamilies` and gated by the model's `toolsStrict` capability.
 * These tests verify:
 *
 * 1. A recursive schema sent to a Claude model uses `ANTHROPIC_STRICT` and is
 *    cycle-broken inline (no `$ref` back-edges that would trigger Anthropic's
 *    "Circular reference detected" rejection).
 * 2. The same recursive schema emitted for a model WITHOUT `toolsStrict`
 *    capability degrades to LENIENT (which preserves the recursive `$ref` —
 *    not strict-shape-bound).
 * 3. Each emitted tool has its `descriptor` pinned for the Prompt loop's
 *    parse-time strictify roundtrip.
 */
describe('AWSBedrockProvider — tool schema emission', () => {
  const config: AWSBedrockConfig = {
    region: 'us-east-1',
    credentials: { accessKeyId: 'test-key', secretAccessKey: 'test-secret' },
  };

  /** Build a minimal Anthropic-family ModelInfo with the right capabilities. */
  function anthropicModel(toolsStrict: boolean): ModelInfo {
    return {
      provider: 'anthropic',
      id: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
      name: 'Claude 3.5 Sonnet',
      tier: 'efficient',
      capabilities: new Set(toolsStrict ? ['chat', 'tools', 'toolsStrict'] : ['chat', 'tools']),
      pricing: {},
      contextWindow: 200_000,
      metadata: {},
    };
  }

  /** Walk a JSON Schema and collect every `$ref` string. */
  function collectRefs(schema: any): string[] {
    const refs: string[] = [];
    const seen = new Set<any>();
    function walk(s: any) {
      if (s === null || typeof s !== 'object' || seen.has(s)) return;
      seen.add(s);
      if (typeof s.$ref === 'string') refs.push(s.$ref);
      for (const k of ['items', 'additionalProperties', 'not', 'propertyNames']) {
        if (s[k] && typeof s[k] === 'object') walk(s[k]);
      }
      for (const k of ['anyOf', 'allOf', 'oneOf', 'prefixItems']) {
        if (Array.isArray(s[k])) for (const sub of s[k]) walk(sub);
      }
      if (s.properties) for (const k in s.properties) walk(s.properties[k]);
      if (s.$defs) for (const k in s.$defs) walk(s.$defs[k]);
    }
    walk(schema);
    return refs;
  }

  it('emits a cycle-broken inputSchema for a recursive tool when targeting a Claude model with toolsStrict', () => {
    type Node = { value: string; children?: Node[] };
    const NodeSchema: z.ZodType<Node> = z.lazy(() =>
      z.object({ value: z.string(), children: z.array(NodeSchema).optional() }),
    );

    const provider = new AWSBedrockProvider(config);
    const tool = {
      name: 'walkTree',
      description: 'Walk a tree',
      parameters: NodeSchema,
      strict: true as const,
      run: () => '',
    };
    const request = { messages: [], tools: [tool] };
    const toolConfig = (provider as any).convertToolsToConverse(request, anthropicModel(true));

    expect(toolConfig).toBeDefined();
    expect(toolConfig.tools).toHaveLength(1);
    const inputSchema = toolConfig.tools[0].toolSpec.inputSchema.json;

    // No $ref anywhere — the cycle-breaker replaced the back-edge with a
    // shape-aware placeholder, so Anthropic's "Circular reference detected"
    // validator can't fire.
    expect(collectRefs(inputSchema)).toEqual([]);

    // The placeholder INSIDE the children array's items mirrors Node (a
    // ZodObject), so it's an open object — not an array, not a flat-any.
    // This is what the LLM sees as the "what to send for a child node" hint.
    const childrenItems = (inputSchema as any).properties.children.items;
    expect(childrenItems.type).toBe('object');
    expect(childrenItems.additionalProperties).toBe(true);
    expect(childrenItems.description).toMatch(/^Would recursively reference #\/\$defs\//);

    // Descriptor was pinned on the tool for the parse-time roundtrip.
    expect((tool as any).descriptor).toBe('anthropic-strict');
  });

  it('falls back to LENIENT (keeps $ref) when the Claude model lacks toolsStrict capability', () => {
    type Node = { value: string; children?: Node[] };
    const NodeSchema: z.ZodType<Node> = z.lazy(() =>
      z.object({ value: z.string(), children: z.array(NodeSchema).optional() }),
    );

    const provider = new AWSBedrockProvider(config);
    const tool = {
      name: 'walkTree',
      description: 'Walk a tree',
      parameters: NodeSchema,
      strict: true as const,
      run: () => '',
    };
    const request = { messages: [], tools: [tool] };
    const toolConfig = (provider as any).convertToolsToConverse(request, anthropicModel(false));

    // No toolsStrict → LENIENT, which is recursion-supporting. We expect a
    // $ref (Lenient retains recursive shapes) and the descriptor pinned to
    // 'lenient' for the parse roundtrip.
    expect(toolConfig.tools).toHaveLength(1);
    const inputSchema = toolConfig.tools[0].toolSpec.inputSchema.json;
    expect(collectRefs(inputSchema).length).toBeGreaterThan(0);
    expect((tool as any).descriptor).toBe('lenient');
  });

  it('non-recursive shared refs survive under ANTHROPIC_STRICT (only cycles are broken)', () => {
    // Use `aid` rather than `id` for the shared-schema marker. Both promote
    // the schema to a `$defs` entry of the same name in `toJSONSchema`, but
    // `aid` skips zod's globalRegistry uniqueness check — important because
    // `strictify` re-applies the meta on its rebuilt clones, which would
    // otherwise trigger "ID Person already exists in the registry".
    const Person = z.object({ name: z.string(), age: z.number() }).meta({ aid: 'Person' });
    const schema = z.object({ author: Person, reviewer: Person });

    const provider = new AWSBedrockProvider(config);
    const tool = {
      name: 'attribute',
      description: 'Attribute a document',
      parameters: schema,
      strict: true as const,
      run: () => '',
    };
    const request = { messages: [], tools: [tool] };
    const toolConfig = (provider as any).convertToolsToConverse(request, anthropicModel(true));

    const inputSchema = toolConfig.tools[0].toolSpec.inputSchema.json;
    // Shared Person is promoted to $defs and referenced — non-cyclic, so the
    // cycle-breaker leaves it alone. Anthropic accepts non-cyclic $refs.
    expect(inputSchema.$defs?.Person).toBeDefined();
    expect(collectRefs(inputSchema)).toContain('#/$defs/Person');
  });
});
