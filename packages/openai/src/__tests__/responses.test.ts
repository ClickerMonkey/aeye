/**
 * Responses API routing and mapping.
 */

import { AI, type AIContextAny, type Request } from '@aeye/ai';
import { getResponseFromChunks, type Chunk } from '@aeye/core';
import { z } from 'zod';
import { OpenAIProvider } from '../openai';

const mockChatCreate = jest.fn();
const mockResponsesCreate = jest.fn();
jest.mock('openai', () => jest.fn().mockImplementation(() => ({
  chat: { completions: { create: mockChatCreate } },
  responses: { create: mockResponsesCreate },
})));

const ctx: AIContextAny = { ai: AI.with().providers({}).create({}), metadata: {} };
const provider = new OpenAIProvider({ apiKey: 'test' });
const hi: Request = { messages: [{ role: 'user', content: 'Hi' }] };

/** A finished Responses API result with the given output items. */
const result = (output: object[], extra: object = {}) => ({
  output,
  status: 'completed',
  incomplete_details: null,
  usage: {
    input_tokens: 100,
    input_tokens_details: { cached_tokens: 20, cache_write_tokens: 0 },
    output_tokens: 60,
    output_tokens_details: { reasoning_tokens: 40 },
    total_tokens: 160,
  },
  ...extra,
});

const message = (text: string, annotations: object[] = []) => ({
  type: 'message', role: 'assistant', status: 'completed', id: 'msg_1',
  content: [{ type: 'output_text', text, annotations }],
});

async function* events(...list: object[]) {
  yield* list;
}

const sentParams = () => mockResponsesCreate.mock.calls[mockResponsesCreate.mock.calls.length - 1][0];

beforeEach(() => {
  mockChatCreate.mockReset();
  mockResponsesCreate.mockReset();
});

describe('routing', () => {
  it('uses Responses for hosted tools, reasoning summaries, and Responses-only models', async () => {
    mockResponsesCreate.mockResolvedValue(result([message('ok')]));
    const executor = provider.createExecutor();

    await executor({ ...hi, hostedTools: [{ type: 'web_search' }] }, ctx, { model: 'gpt-5.4' });
    await executor({ ...hi, reason: { summary: 'concise' } }, ctx, { model: 'gpt-5.4' });
    await executor(hi, ctx, { model: 'gpt-5.3-codex' });

    expect(mockResponsesCreate).toHaveBeenCalledTimes(3);
    expect(mockChatCreate).not.toHaveBeenCalled();
  });

  it('uses Chat Completions otherwise, or when configured', async () => {
    mockChatCreate.mockResolvedValue({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] });

    await provider.createExecutor()(hi, ctx, { model: 'gpt-5.4' });
    await new OpenAIProvider({ apiKey: 'test', api: 'chat' }).createExecutor()(hi, ctx, { model: 'gpt-5.3-codex' });

    expect(mockChatCreate).toHaveBeenCalledTimes(2);
    expect(mockResponsesCreate).not.toHaveBeenCalled();
  });
});

describe('request', () => {
  const responses = new OpenAIProvider({ apiKey: 'test', api: 'responses' });

  it('maps messages, tools, format, and reasoning', async () => {
    mockResponsesCreate.mockResolvedValue(result([message('{}')]));

    await responses.createExecutor()({
      messages: [
        { role: 'system', content: 'Be brief' },
        { role: 'user', content: 'Weather?' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'call_1', name: 'weather', arguments: '{"city":"SF"}' }],
          reasoning: { details: [{ id: 'rs_1', type: 'reasoning.encrypted', format: 'openai-responses-v1', summary: 'Look it up', data: 'ENC' }] },
        },
        { role: 'tool', toolCallId: 'call_1', content: [{ type: 'text', content: 'Sunny' }, { type: 'image', content: 'https://example.com/map.png' }] },
      ],
      tools: [{ name: 'weather', description: 'Weather lookup', parameters: z.object({ city: z.string() }) }],
      toolChoice: { tool: 'weather' },
      hostedTools: [{ type: 'web_search', allowedDomains: ['weather.gov'] }],
      responseFormat: 'json',
      reason: { effort: 'high', summary: 'auto' },
      verbosity: 'low',
    }, ctx, { model: 'gpt-5.4' });

    const params = sentParams();
    expect(params.input).toEqual([
      { role: 'developer', content: [{ type: 'input_text', text: 'Be brief' }] },
      { role: 'user', content: [{ type: 'input_text', text: 'Weather?' }] },
      { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: 'Look it up' }], encrypted_content: 'ENC' },
      { type: 'function_call', call_id: 'call_1', name: 'weather', arguments: '{"city":"SF"}' },
      {
        type: 'function_call_output',
        call_id: 'call_1',
        output: [
          { type: 'input_text', text: 'Sunny' },
          { type: 'input_image', image_url: 'https://example.com/map.png', detail: 'auto' },
        ],
      },
    ]);
    expect(params.tools).toEqual([
      expect.objectContaining({ type: 'function', name: 'weather', description: 'Weather lookup', strict: false }),
      { type: 'web_search', filters: { allowed_domains: ['weather.gov'] } },
    ]);
    expect(params).toMatchObject({
      tool_choice: { type: 'function', name: 'weather' },
      text: { format: { type: 'json_object' }, verbosity: 'low' },
      reasoning: { effort: 'high', summary: 'auto' },
      include: ['reasoning.encrypted_content'],
      store: false,
      stream: false,
    });
  });

  it('rejects hosted tools OpenAI has no equivalent for', async () => {
    await expect(responses.createExecutor()({ ...hi, hostedTools: [{ type: 'web_fetch' }] }, ctx, { model: 'gpt-5.4' }))
      .rejects.toThrow(/web_fetch/);
  });
});

describe('response', () => {
  it('folds output items into the response', async () => {
    mockResponsesCreate.mockResolvedValue(result([
      { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: 'Checked sources' }], encrypted_content: 'ENC' },
      { type: 'web_search_call', id: 'ws_1', status: 'completed', action: { type: 'search', query: 'q' } },
      message('It is sunny', [{ type: 'url_citation', url: 'https://weather.gov', title: 'NWS', start_index: 6, end_index: 11 }]),
      { type: 'function_call', call_id: 'call_2', name: 'save', arguments: '{}', id: 'fc_1', status: 'completed' },
    ], { service_tier: 'flex' }));

    const response = await provider.createExecutor()({ ...hi, hostedTools: [{ type: 'web_search' }] }, ctx, { model: 'gpt-5.4' });

    expect(response).toMatchObject({
      content: 'It is sunny',
      finishReason: 'tool_calls',
      toolCalls: [{ id: 'call_2', name: 'save', arguments: '{}' }],
      citations: [{ url: 'https://weather.gov', title: 'NWS', start: 6, end: 11 }],
      serviceTier: 'flex',
      reasoning: {
        content: 'Checked sources',
        details: [{ id: 'rs_1', type: 'reasoning.encrypted', format: 'openai-responses-v1', summary: 'Checked sources', data: 'ENC' }],
      },
      usage: {
        text: { input: 80, output: 20, cached: 20 },
        reasoning: { output: 40 },
        tools: { web_search: 1 },
      },
    });
  });

  it('reports a truncated response as length', async () => {
    mockResponsesCreate.mockResolvedValue(result([message('Cut')], { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }));

    const response = await provider.createExecutor()({ ...hi, reason: { mode: 'pro' } }, ctx, { model: 'gpt-5.6' });

    expect(response.finishReason).toBe('length');
  });

  it('streams deltas and finishes each item once', async () => {
    const call = { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'save', arguments: '' };
    mockResponsesCreate.mockResolvedValue(events(
      { type: 'response.reasoning_summary_text.delta', delta: 'Thinking' },
      { type: 'response.output_text.delta', delta: 'Hello' },
      { type: 'response.output_text.delta', delta: ' there' },
      { type: 'response.output_item.done', item: message('Hello there', [{ type: 'url_citation', url: 'https://a.example', title: 'A', start_index: 0, end_index: 5 }]) },
      { type: 'response.output_item.added', item: call },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"a":' },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '1}' },
      { type: 'response.output_item.done', item: { ...call, arguments: '{"a":1}' } },
      { type: 'response.completed', response: result([message('Hello there'), { ...call, arguments: '{"a":1}' }]) },
    ));

    const chunks: Chunk[] = [];
    for await (const chunk of provider.createStreamer()({ ...hi, hostedTools: [{ type: 'web_search' }] }, ctx, { model: 'gpt-5.4' })) {
      chunks.push(chunk);
    }

    expect(chunks.find(c => c.toolCallNamed)?.toolCallNamed?.name).toBe('save');
    const response = getResponseFromChunks(chunks);
    expect(response.content).toBe('Hello there');
    expect(response.reasoning?.content).toBe('Thinking');
    expect(response.toolCalls).toEqual([{ id: 'call_1', name: 'save', arguments: '{"a":1}' }]);
    expect(response.citations).toHaveLength(1);
    expect(response.finishReason).toBe('tool_calls');
  });

  it('streams every reasoning delta and joins summary parts as the finished item does', async () => {
    const item = { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: '**Plan**\n\nCheck the root.' }, { type: 'summary_text', text: '**Check**\n\nCheck the root.' }], encrypted_content: 'ENC' };
    const summary = (summary_index: number, ...deltas: string[]) => [
      { type: 'response.reasoning_summary_part.added', item_id: 'rs_1', summary_index },
      ...deltas.map(delta => ({ type: 'response.reasoning_summary_text.delta', item_id: 'rs_1', summary_index, delta })),
    ];
    mockResponsesCreate.mockResolvedValue(events(
      ...summary(0, '**Plan**', '\n\n', 'Check', ' the', ' root', '.'),
      ...summary(1, '**Check**', '\n\n', 'Check', ' the', ' root', '.'),
      { type: 'response.output_item.done', item },
      { type: 'response.completed', response: result([item]) },
    ));

    const chunks: Chunk[] = [];
    for await (const chunk of provider.createStreamer()({ ...hi, reason: { summary: 'detailed' } }, ctx, { model: 'gpt-5.4' })) {
      chunks.push(chunk);
    }

    const { reasoning } = getResponseFromChunks(chunks);
    expect(reasoning?.content).toBe('**Plan**\n\nCheck the root.\n\n**Check**\n\nCheck the root.');
    expect(reasoning?.details).toEqual([{ id: 'rs_1', type: 'reasoning.encrypted', format: 'openai-responses-v1', summary: reasoning?.content, data: 'ENC' }]);
  });

  it('fails the stream when the response fails', async () => {
    mockResponsesCreate.mockResolvedValue(events(
      { type: 'response.failed', response: { error: { code: 'server_error', message: 'Upstream broke' } } },
    ));

    const drain = async () => {
      for await (const _ of provider.createStreamer()({ ...hi, hostedTools: [{ type: 'web_search' }] }, ctx, { model: 'gpt-5.4' })) { /* drain */ }
    };
    await expect(drain()).rejects.toThrow(/Upstream broke/);
  });
});
