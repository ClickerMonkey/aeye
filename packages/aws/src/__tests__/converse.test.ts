/**
 * Offline tests of the Converse mapping: requests the provider sends and
 * responses it reads, with the Bedrock runtime client mocked.
 */

import type { ModelInfo } from '@aeye/ai';
import { type Chunk, type FinishReason, type Message, type Reason, type Request, type Response, TEXT_TOOL_SCHEMA, type ToolTextFormat } from '@aeye/core';
import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ConverseCommandOutput,
  ConverseStreamCommand,
  type ConverseStreamOutput,
  type StopReason,
  ThrottlingException,
  ValidationException,
} from '@aws-sdk/client-bedrock-runtime';
import z from 'zod';
import { AWSBedrockProvider, type AWSBedrockConfig } from '../aws';
import { BEDROCK_REASONING_FORMAT } from '../converse';
import { AWSContextWindowError, AWSRateLimitError } from '../types';

const config: AWSBedrockConfig = {
  region: 'us-east-1',
  credentials: { accessKeyId: 'test-key', secretAccessKey: 'test-secret' },
};

/** A Bedrock model as the registry describes it. */
function model(id: string, overrides: Partial<ModelInfo> = {}): ModelInfo {
  return {
    provider: 'aws',
    id,
    name: id,
    tier: 'efficient',
    capabilities: new Set(['chat', 'tools']),
    pricing: {},
    contextWindow: 200_000,
    maxOutputTokens: 32_000,
    ...overrides,
  };
}

const CLAUDE = model('anthropic.claude-opus-4-7', {
  capabilities: new Set(['chat', 'tools', 'toolsStrict', 'structured', 'reasoning']),
  strictFormat: 'anthropic',
  metadata: { inRegion: false, inferenceIds: ['us.anthropic.claude-opus-4-7', 'global.anthropic.claude-opus-4-7'] },
});

/** What the fake client was sent. */
interface Sent {
  converse: ConverseCommand[];
  stream: ConverseStreamCommand[];
}

/**
 * Answer Converse with `output` and ConverseStream with `events`, recording
 * the commands sent.
 */
function fakeBedrock(output: Partial<ConverseCommandOutput> = {}, events: ConverseStreamOutput[] = []): Sent {
  const sent: Sent = { converse: [], stream: [] };
  jest.spyOn(BedrockRuntimeClient.prototype, 'send').mockImplementation(async (command: object) => {
    if (command instanceof ConverseStreamCommand) {
      sent.stream.push(command);
      return { stream: (async function* () { yield* events; })(), $metadata: {} };
    }
    if (command instanceof ConverseCommand) {
      sent.converse.push(command);
    }
    return { $metadata: {}, ...output };
  });
  return sent;
}

/** Run a request through the executor. */
function execute(request: Request, provider = new AWSBedrockProvider(config)): Promise<Response> {
  return provider.createExecutor()(request, {});
}

/** Run a request through the streamer, collecting its chunks. */
async function stream(request: Request, provider = new AWSBedrockProvider(config)): Promise<Chunk[]> {
  const chunks: Chunk[] = [];
  for await (const chunk of provider.createStreamer()(request, {})) {
    chunks.push(chunk);
  }
  return chunks;
}

const PNG = `data:image/png;base64,${Buffer.from('png-bytes').toString('base64')}`;

afterEach(() => jest.restoreAllMocks());

describe('Converse request mapping', () => {
  it('maps messages, media, tool results, and cache breakpoints', async () => {
    const sent = fakeBedrock({ output: { message: { role: 'assistant', content: [{ text: 'ok' }] } } });

    await execute({
      model: 'meta.llama3-1-70b-instruct-v1:0',
      messages: [
        { role: 'system', content: [{ type: 'text', content: 'Be brief.', cacheBreakpoint: true }] },
        { role: 'user', content: [
          { type: 'text', content: 'Look' },
          { type: 'image', content: PNG },
          { type: 'file', content: 's3://bucket/report.pdf', name: 'Q3 report.pdf' },
          { type: 'video', content: 's3://bucket/clip.mp4', cacheBreakpoint: true },
        ] },
        { role: 'assistant', content: '', toolCalls: [{ id: 't1', name: 'lookup', arguments: '{"q":"x"}' }] },
        { role: 'tool', toolCallId: 't1', content: [{ type: 'text', content: 'found' }, { type: 'image', content: PNG }] },
      ],
    });

    const input = sent.converse[0].input;
    expect(input.modelId).toBe('meta.llama3-1-70b-instruct-v1:0');
    expect(input.system).toEqual([{ text: 'Be brief.' }, { cachePoint: { type: 'default' } }]);
    expect(input.messages).toEqual([
      { role: 'user', content: [
        { text: 'Look' },
        { image: { format: 'png', source: { bytes: Buffer.from('png-bytes') } } },
        { document: { format: 'pdf', name: 'Q3 report', source: { s3Location: { uri: 's3://bucket/report.pdf' } } } },
        { video: { format: 'mp4', source: { s3Location: { uri: 's3://bucket/clip.mp4' } } } },
        { cachePoint: { type: 'default' } },
      ] },
      { role: 'assistant', content: [{ toolUse: { toolUseId: 't1', name: 'lookup', input: { q: 'x' } } }] },
      { role: 'user', content: [{ toolResult: { toolUseId: 't1', content: [
        { text: 'found' },
        { image: { format: 'png', source: { bytes: Buffer.from('png-bytes') } } },
      ] } }] },
    ]);
  });

  it('sends settings: inference, service tier, metadata, latency, guardrails, and extra fields', async () => {
    const guardrail: NonNullable<AWSBedrockConfig['guardrail']> = { guardrailIdentifier: 'gr-1', guardrailVersion: '2', streamProcessingMode: 'async' };
    const provider = new AWSBedrockProvider({ ...config, latency: 'optimized', guardrail });
    const sent = fakeBedrock();
    const request: Request = {
      model: 'meta.llama3-1-70b-instruct-v1:0',
      messages: [{ role: 'user', content: 'Hi' }],
      maxTokens: 100,
      temperature: 0.2,
      stop: 'END',
      serviceTier: 'fast',
      metadata: { team: 'search' },
      extra: { top_k: 5 },
    };

    await execute(request, provider);
    await stream(request, provider);

    expect(sent.converse[0].input).toMatchObject({
      inferenceConfig: { maxTokens: 100, temperature: 0.2, stopSequences: ['END'] },
      serviceTier: { type: 'priority' },
      requestMetadata: { team: 'search' },
      performanceConfig: { latency: 'optimized' },
      additionalModelRequestFields: { top_k: 5 },
      guardrailConfig: { guardrailIdentifier: 'gr-1', guardrailVersion: '2' },
    });
    expect(sent.converse[0].input.guardrailConfig).not.toHaveProperty('streamProcessingMode', 'async');
    expect(sent.stream[0].input.guardrailConfig).toEqual(guardrail);
  });

  it('uses an inference profile for models Bedrock serves only through one', async () => {
    const sent = fakeBedrock();
    await execute({ model: CLAUDE, messages: [{ role: 'user', content: 'Hi' }] });
    await execute({ model: CLAUDE, messages: [{ role: 'user', content: 'Hi' }] }, new AWSBedrockProvider({ ...config, region: 'eu-west-1' }));
    await execute({ model: CLAUDE, messages: [{ role: 'user', content: 'Hi' }] }, new AWSBedrockProvider({ ...config, modelPrefix: 'eu.' }));

    expect(sent.converse.map(command => command.input.modelId)).toEqual([
      'us.anthropic.claude-opus-4-7',
      'global.anthropic.claude-opus-4-7',
      'eu.anthropic.claude-opus-4-7',
    ]);
  });

  it('sends tools with grammar hints, strict flags, and the tool choice', async () => {
    const sent = fakeBedrock();
    const grammar: ToolTextFormat = { type: 'grammar', syntax: 'lark', definition: 'start: "a"+' };
    const tools = [
      { name: 'search', description: 'Search', parameters: z.object({ q: z.string() }), strict: true },
      { name: 'emit', description: 'Emit', parameters: TEXT_TOOL_SCHEMA, format: grammar },
      { name: 'hidden', parameters: z.object({}) },
    ];

    await execute({ model: CLAUDE, messages: [{ role: 'user', content: 'Go' }], tools, toolChoice: { allowed: ['search', 'emit'], required: true } });
    await execute({ model: CLAUDE, messages: [{ role: 'user', content: 'Go' }], tools, toolChoice: { tool: 'emit' } });
    await execute({ model: CLAUDE, messages: [{ role: 'user', content: 'Go' }], tools, toolChoice: 'none' });

    const [allowed, forced, none] = sent.converse.map(command => command.input.toolConfig);
    expect(allowed?.tools?.map(tool => tool.toolSpec?.name)).toEqual(['search', 'emit']);
    expect(allowed?.toolChoice).toEqual({ any: {} });
    expect(allowed?.tools?.[0].toolSpec).toMatchObject({ strict: true, inputSchema: { json: { type: 'object', additionalProperties: false } } });
    expect(allowed?.tools?.[1].toolSpec?.description).toBe('Emit\n\nThe input must match this lark grammar:\nstart: "a"+');
    expect(forced?.toolChoice).toEqual({ tool: { name: 'emit' } });
    expect(none).toBeUndefined();
  });

  it('sends a structured output schema the model can be held to, else puts it in the prompt', async () => {
    const sent = fakeBedrock();
    const responseFormat = { type: z.object({ title: z.string(), tags: z.array(z.string()).optional() }), strict: true };

    await execute({ model: CLAUDE, messages: [{ role: 'user', content: 'Extract' }], responseFormat });
    await execute({ model: model('meta.llama3-1-70b-instruct-v1:0'), messages: [{ role: 'user', content: 'Extract' }], responseFormat: { ...responseFormat } });

    const textFormat = sent.converse[0].input.outputConfig?.textFormat;
    expect(textFormat?.type).toBe('json_schema');
    expect(textFormat?.structure?.jsonSchema?.name).toBe('response');
    expect(JSON.parse(textFormat?.structure?.jsonSchema?.schema ?? '{}')).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['title'],
    });
    expect(responseFormat).toHaveProperty('descriptor', 'anthropic-strict');
    expect(sent.converse[0].input.system).toBeUndefined();
    // Llama has no strict dialect, so its schema goes in the prompt instead
    expect(sent.converse[1].input.outputConfig).toBeUndefined();
    expect(JSON.stringify(sent.converse[1].input.system)).toContain('conforming to this schema');
  });

  it.each<[string, ModelInfo, Reason, object]>([
    ['adaptive Claude', model('anthropic.claude-opus-4-7'), { effort: 'high' }, {
      additionalModelRequestFields: { thinking: { type: 'adaptive', display: 'summarized' } },
      outputConfig: { effort: 'high' },
      inferenceConfig: { temperature: undefined },
    }],
    ['adaptive Claude without visible reasoning', model('anthropic.claude-sonnet-5'), { effort: 'minimal', exclude: true }, {
      additionalModelRequestFields: { thinking: { type: 'adaptive', display: 'omitted' } },
      outputConfig: { effort: 'low' },
    }],
    ['budget Claude', model('anthropic.claude-sonnet-4-5-20250929-v1:0'), { effort: 'low' }, {
      additionalModelRequestFields: { thinking: { type: 'enabled', budget_tokens: 2048 } },
    }],
    ['budget Claude under the output limit', model('anthropic.claude-sonnet-4-5-20250929-v1:0', { maxOutputTokens: 4000 }), { maxTokens: 10_000 }, {
      additionalModelRequestFields: { thinking: { type: 'enabled', budget_tokens: 3999 } },
    }],
    ['Claude without thinking', model('anthropic.claude-opus-4-7'), { effort: 'none' }, {
      additionalModelRequestFields: { thinking: { type: 'disabled' } },
    }],
    ['Nova at high effort', model('amazon.nova-2-lite-v1:0', { reasoningEfforts: ['low', 'medium', 'high'] }), { effort: 'max' }, {
      additionalModelRequestFields: { reasoningConfig: { type: 'enabled', maxReasoningEffort: 'high' } },
      inferenceConfig: { maxTokens: undefined, temperature: undefined },
    }],
    ['gpt-oss', model('openai.gpt-oss-120b-1:0', { reasoningEfforts: ['low', 'medium', 'high'] }), { effort: 'xhigh' }, {
      additionalModelRequestFields: { reasoning_effort: 'high' },
    }],
  ])('maps reasoning for %s', async (_, info, reason, expected) => {
    const sent = fakeBedrock();
    await execute({ model: info, messages: [{ role: 'user', content: 'Think' }], temperature: 0.5, reason });
    expect(sent.converse[0].input).toMatchObject(expected);
  });

  it('turns Claude thinking off on a turn that forces a tool', async () => {
    const sent = fakeBedrock();
    await execute({
      model: model('anthropic.claude-sonnet-4-5-20250929-v1:0'),
      messages: [{ role: 'user', content: 'Look it up' }],
      tools: [{ name: 'lookup', description: 'Look up', parameters: z.object({ q: z.string() }) }],
      toolChoice: 'required',
      reason: { effort: 'high' },
    });
    expect(sent.converse[0].input.additionalModelRequestFields).toEqual({ thinking: { type: 'disabled' } });
  });
});

describe('Converse responses', () => {
  const signature = 'sig-abc';
  const redacted = Uint8Array.from([1, 2, 3, 250]);

  it('reads text, reasoning, tool calls, citations, usage, and tier', async () => {
    fakeBedrock({
      output: { message: { role: 'assistant', content: [
        { reasoningContent: { reasoningText: { text: 'Let me think.', signature } } },
        { reasoningContent: { redactedContent: redacted } },
        { text: 'The answer ' },
        { citationsContent: { content: [{ text: 'is 4.' }], citations: [{ title: 'Math', location: { web: { url: 'https://math.example', domain: 'math.example' } } }] } },
        { toolUse: { toolUseId: 'g1', name: 'nova_grounding', input: {}, type: 'server_tool_use' } },
        { toolUse: { toolUseId: 't1', name: 'lookup', input: { q: 'x' } } },
      ] } },
      stopReason: 'tool_use',
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 90, cacheReadInputTokens: 50, cacheWriteInputTokens: 10 },
      serviceTier: { type: 'flex' },
    });

    const response = await execute({ model: 'anthropic.claude-sonnet-4-5-20250929-v1:0', messages: [{ role: 'user', content: 'Q' }] });

    expect(response.content).toBe('The answer is 4.');
    expect(response.citations).toEqual([{ url: 'https://math.example', title: 'Math' }]);
    expect(response.toolCalls).toEqual([{ id: 't1', name: 'lookup', arguments: '{"q":"x"}' }]);
    expect(response.finishReason).toBe('tool_calls');
    expect(response.usage).toEqual({ text: { input: 10, output: 20, cached: 50, cacheWrite: 10 } });
    expect(response.serviceTier).toBe('flex');
    expect(response.reasoning).toEqual({
      content: 'Let me think.',
      provider: 'aws-bedrock',
      details: [
        { type: 'reasoning.text', format: BEDROCK_REASONING_FORMAT, index: 0, text: 'Let me think.', signature, data: undefined },
        { type: 'reasoning.encrypted', format: BEDROCK_REASONING_FORMAT, index: 1, text: undefined, signature: undefined, data: Buffer.from(redacted).toString('base64') },
      ],
    });
  });

  it.each<[StopReason, FinishReason]>([
    ['guardrail_intervened', 'content_filter'],
    ['model_context_window_exceeded', 'length'],
    ['malformed_tool_use', 'stop'],
  ])('maps the %s stop reason', async (stopReason, finishReason) => {
    fakeBedrock({ stopReason });
    const response = await execute({ model: 'amazon.nova-pro-v1:0', messages: [{ role: 'user', content: 'Q' }] });
    expect(response.finishReason).toBe(finishReason);
  });

  it('streams text, reasoning with its signature, citations, tool calls, and usage', async () => {
    fakeBedrock({}, [
      { messageStart: { role: 'assistant' } },
      { contentBlockDelta: { contentBlockIndex: 0, delta: { reasoningContent: { text: 'Step 1. ' } } } },
      { contentBlockDelta: { contentBlockIndex: 0, delta: { reasoningContent: { text: 'Step 2.' } } } },
      { contentBlockDelta: { contentBlockIndex: 0, delta: { reasoningContent: { signature } } } },
      { contentBlockStop: { contentBlockIndex: 0 } },
      { contentBlockDelta: { contentBlockIndex: 1, delta: { reasoningContent: { redactedContent: redacted } } } },
      { contentBlockDelta: { contentBlockIndex: 2, delta: { text: 'Done' } } },
      { contentBlockDelta: { contentBlockIndex: 2, delta: { citation: { title: 'Src', location: { web: { url: 'https://src.example' } } } } } },
      { contentBlockStart: { contentBlockIndex: 3, start: { toolUse: { toolUseId: 't1', name: 'lookup' } } } },
      { contentBlockDelta: { contentBlockIndex: 3, delta: { toolUse: { input: '{"q":' } } } },
      { contentBlockDelta: { contentBlockIndex: 3, delta: { toolUse: { input: '"x"}' } } } },
      { contentBlockStop: { contentBlockIndex: 3 } },
      { messageStop: { stopReason: 'tool_use' } },
      { metadata: { usage: { inputTokens: 5, outputTokens: 7, totalTokens: 32, cacheReadInputTokens: 20 }, metrics: { latencyMs: 1 }, serviceTier: { type: 'priority' } } },
    ]);
    const afterRequest = jest.fn();
    const provider = new AWSBedrockProvider({ ...config, hooks: { chat: { afterRequest } } });

    const chunks = await stream({ model: 'anthropic.claude-sonnet-4-5-20250929-v1:0', messages: [{ role: 'user', content: 'Q' }] }, provider);

    expect(chunks.filter(c => c.reasoning?.content).map(c => c.reasoning?.content)).toEqual(['Step 1. ', 'Step 2.']);
    const response: Response = afterRequest.mock.calls[0][2];
    expect(response.content).toBe('Done');
    expect(response.citations).toEqual([{ url: 'https://src.example', title: 'Src' }]);
    expect(response.toolCalls).toEqual([{ id: 't1', name: 'lookup', arguments: '{"q":"x"}' }]);
    expect(response.finishReason).toBe('tool_calls');
    expect(response.usage).toEqual({ text: { input: 5, output: 7, cached: 20 } });
    expect(response.serviceTier).toBe('fast');
    expect(response.reasoning?.content).toBe('Step 1. Step 2.');
    expect(response.reasoning?.details).toEqual([
      expect.objectContaining({ type: 'reasoning.text', index: 0, text: 'Step 1. Step 2.', signature }),
      expect.objectContaining({ type: 'reasoning.encrypted', index: 1, data: Buffer.from(redacted).toString('base64') }),
    ]);
  });

  it('replays reasoning in later turns, once per assistant turn, signed blocks only', async () => {
    fakeBedrock({
      output: { message: { role: 'assistant', content: [
        { reasoningContent: { reasoningText: { text: '', signature } } },
        { reasoningContent: { redactedContent: redacted } },
        { toolUse: { toolUseId: 't1', name: 'lookup', input: {} } },
      ] } },
      stopReason: 'tool_use',
    });
    const first = await execute({ model: CLAUDE, messages: [{ role: 'user', content: 'Q' }] });
    const sent = fakeBedrock();

    const reasoning = first.reasoning;
    const foreign = { content: 'other', details: [{ type: 'reasoning.text', format: 'anthropic-claude-v1', text: 'other', signature: 's' }] };
    const unsigned = { content: 'Nova', details: [{ type: 'reasoning.text', format: BEDROCK_REASONING_FORMAT, index: 0, text: '[REDACTED]' }] };
    const history: Message[] = [
      { role: 'user', content: 'Q' },
      { role: 'assistant', content: 'Checking.', reasoning },
      { role: 'assistant', content: '', toolCalls: first.toolCalls, reasoning },
      { role: 'tool', toolCallId: 't1', content: 'result' },
      { role: 'assistant', content: 'Earlier', reasoning: foreign },
      { role: 'assistant', content: 'Again', reasoning: unsigned },
      { role: 'user', content: 'More' },
    ];
    await execute({ model: CLAUDE, messages: history });

    expect(sent.converse[0].input.messages?.[1]).toEqual({ role: 'assistant', content: [
      { reasoningContent: { reasoningText: { text: '', signature } } },
      { reasoningContent: { redactedContent: Buffer.from(redacted) } },
      { text: 'Checking.' },
      { toolUse: { toolUseId: 't1', name: 'lookup', input: {} } },
    ] });
    expect(sent.converse[0].input.messages?.[3]).toEqual({ role: 'assistant', content: [{ text: 'Earlier' }, { text: 'Again' }] });
  });
});

describe('Converse errors', () => {
  it('classifies throttling and context window errors', async () => {
    const errors = [
      new ThrottlingException({ message: 'Too many requests', $metadata: {} }),
      new ValidationException({ message: 'Input is too long for requested model.', $metadata: {} }),
    ];
    jest.spyOn(BedrockRuntimeClient.prototype, 'send').mockImplementation(async () => {
      throw errors.shift();
    });

    const request: Request = { model: 'amazon.nova-pro-v1:0', messages: [{ role: 'user', content: 'Q' }] };
    await expect(execute(request)).rejects.toBeInstanceOf(AWSRateLimitError);
    await expect(execute(request)).rejects.toBeInstanceOf(AWSContextWindowError);
  });

  it('throws errors the stream reports', async () => {
    fakeBedrock({}, [
      { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'Partial' } } },
      { throttlingException: new ThrottlingException({ message: 'slow down', $metadata: {} }) },
    ]);
    await expect(stream({ model: 'amazon.nova-pro-v1:0', messages: [{ role: 'user', content: 'Q' }] })).rejects.toBeInstanceOf(AWSRateLimitError);
  });
});
