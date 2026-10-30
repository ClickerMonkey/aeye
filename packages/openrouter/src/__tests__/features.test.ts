/**
 * OpenRouter request features, response extras, and model conversion.
 */

import { AI, type AIContextAny, type Request } from '@aeye/ai';
import { accumulateReasoning, type Reasoning } from '@aeye/core';
import { convertOpenRouterModel, OpenRouterProvider } from '../openrouter';
import type { OpenRouterModel } from '../types';

const mockCreate = jest.fn();
jest.mock('openai', () => jest.fn().mockImplementation(() => ({
  chat: { completions: { create: mockCreate } },
})));

const ctx: AIContextAny = { ai: AI.with().providers({}).create({}), metadata: {} };
const hi: Request = { messages: [{ role: 'user', content: 'Hi' }] };

const completion = (message: object, usage?: object) => ({
  id: 'gen-1',
  choices: [{ message: { role: 'assistant', content: 'ok', ...message }, finish_reason: 'stop' }],
  usage,
});

const sentParams = () => mockCreate.mock.calls[mockCreate.mock.calls.length - 1][0];

beforeEach(() => mockCreate.mockReset().mockResolvedValue(completion({})));

describe('request', () => {
  it('sends reasoning as one object with a budget or an effort, never both', async () => {
    await new OpenRouterProvider({ apiKey: 'k' }).createExecutor()({ ...hi, reason: { effort: 'high', exclude: true, maxTokens: 2000 } }, ctx, { model: 'openai/gpt-5.4' });

    expect(sentParams().reasoning).toEqual({ enabled: true, max_tokens: 2000, exclude: true });
    expect(sentParams()).not.toHaveProperty('reasoning_effort');

    await new OpenRouterProvider({ apiKey: 'k' }).createExecutor()({ ...hi, reason: { effort: 'high' } }, ctx, { model: 'openai/gpt-5.4' });
    expect(sentParams().reasoning).toEqual({ enabled: true, effort: 'high' });
  });

  it('maps routing, fallbacks, plugins, and the deprecated middle-out transform', async () => {
    const provider = new OpenRouterProvider({
      apiKey: 'k',
      defaultParams: {
        providers: { sort: { by: 'throughput', partition: 'none' }, preferredMaxLatency: 2, enforceDistillableText: true },
        fallbackModels: ['anthropic/claude-sonnet-5'],
        plugins: [{ id: 'response-healing' }],
        transforms: ['middle-out'],
      },
    });

    await provider.createExecutor()({ ...hi, userKey: 'user-1' }, ctx, { model: 'openai/gpt-5.4' });

    expect(sentParams()).toMatchObject({
      provider: { sort: { by: 'throughput', partition: 'none' }, preferred_max_latency: 2, enforce_distillable_text: true },
      models: ['anthropic/claude-sonnet-5'],
      plugins: [{ id: 'response-healing' }, { id: 'context-compression', engine: 'middle-out' }],
      user: 'user-1',
    });
    expect(sentParams()).not.toHaveProperty('transforms');
  });

  it('runs hosted tools as OpenRouter server tools through chat', async () => {
    await new OpenRouterProvider({ apiKey: 'k' }).createExecutor()({
      ...hi,
      hostedTools: [{ type: 'web_search', maxResults: 3, allowedDomains: ['github.com'] }, { type: 'web_fetch' }],
    }, ctx, { model: 'openai/gpt-5.4' });

    expect(sentParams().tools).toEqual([
      { type: 'openrouter:web_search', parameters: { max_results: 3, allowed_domains: ['github.com'], excluded_domains: undefined } },
      { type: 'openrouter:web_fetch' },
    ]);
  });

  it('marks cache breakpoints with cache_control', async () => {
    await new OpenRouterProvider({ apiKey: 'k' }).createExecutor()({
      messages: [{ role: 'user', content: [{ type: 'text', content: 'Shared prefix', cacheBreakpoint: true }] }],
    }, ctx, { model: 'anthropic/claude-sonnet-5' });

    expect(sentParams().messages[0].content[0]).toEqual({ type: 'text', text: 'Shared prefix', cache_control: { type: 'ephemeral' } });
  });

  it('replays reasoning in its own message before assistant content', async () => {
    const details = [{ id: 'r1', type: 'reasoning.text', format: 'anthropic-claude-v1', text: 'Thinking', signature: 'sig' }];

    await new OpenRouterProvider({ apiKey: 'k' }).createExecutor()({
      messages: [
        { role: 'user', content: 'Q' },
        { role: 'assistant', content: 'A', reasoning: { content: 'Thinking', details } },
        { role: 'user', content: 'Q2' },
      ],
    }, ctx, { model: 'anthropic/claude-sonnet-5' });

    const [, reasoning, answer] = sentParams().messages;
    expect(reasoning).toEqual({ role: 'assistant', name: undefined, reasoning: 'Thinking', reasoning_details: details });
    expect(answer).toMatchObject({ role: 'assistant', content: [{ type: 'text', text: 'A' }] });
    expect(answer).not.toHaveProperty('reasoning');
  });
});

describe('response', () => {
  it('counts tokens once, adds the BYOK upstream bill, and counts server tools', async () => {
    mockCreate.mockResolvedValue(completion({}, {
      prompt_tokens: 100,
      completion_tokens: 40,
      total_tokens: 140,
      prompt_tokens_details: { cached_tokens: 30 },
      completion_tokens_details: { reasoning_tokens: 25 },
      cost: 0.001,
      is_byok: true,
      cost_details: { upstream_inference_cost: 0.02 },
      server_tool_use_details: { web_search_requests: 2 },
    }));

    const response = await new OpenRouterProvider({ apiKey: 'k' }).createExecutor()(hi, ctx, { model: 'openai/gpt-5.4' });

    expect(response.usage).toEqual({
      text: { input: 70, output: 15, cached: 30 },
      reasoning: { output: 25 },
      tools: { web_search: 2 },
      cost: 0.021,
    });
  });

  it('streams reasoning deltas from both reasoning and reasoning_details', async () => {
    // As measured from anthropic/claude-haiku-4.5 and google/gemini-3.5-flash:
    // each delta once in both fields, the signature or encrypted payload last
    const format = 'anthropic-claude-v1';
    const deltas = ['Is 391', ' prime', '?', ' Try', ' the', ' primes', '.', '\n', '\n', ' 17', ' times', ' the', ' 23', '.'];
    const chunk = (delta: object, finish_reason: string | null = null) => ({ id: 'gen-1', choices: [{ index: 0, delta, finish_reason }] });
    mockCreate.mockResolvedValue((async function* () {
      for (const text of deltas) {
        yield chunk({ reasoning: text, reasoning_details: [{ type: 'reasoning.text', text, format, index: 0 }] });
      }
      yield chunk({ reasoning_details: [{ type: 'reasoning.text', signature: 'sig', format, index: 0 }] });
      yield chunk({ reasoning: null, reasoning_details: [{ type: 'reasoning.encrypted', data: 'ENC', format, index: 0 }] });
      yield chunk({ content: 'No.' }, 'stop');
    })());

    const stream = new OpenRouterProvider({ apiKey: 'k' }).createStreamer()(hi, ctx, { model: 'anthropic/claude-haiku-4.5' });
    let partial: Reasoning | undefined;
    let next = await stream.next();
    for (; !next.done; next = await stream.next()) {
      partial = accumulateReasoning(partial, next.value.reasoning);
    }

    const text = deltas.join('');
    const reasoning = {
      content: text,
      details: [{ type: 'reasoning.text', text, signature: 'sig', format, index: 0 }, { type: 'reasoning.encrypted', data: 'ENC', format, index: 0 }],
    };
    expect(partial).toEqual(reasoning);
    expect(next.value.reasoning).toEqual(reasoning);
  });

  it('generates images through chat', async () => {
    mockCreate.mockResolvedValue(completion({ images: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } }] }));

    const response = await new OpenRouterProvider({ apiKey: 'k' }).generateImage!({ prompt: 'A dot', size: '1600x900' }, ctx);

    expect(sentParams()).toMatchObject({
      model: 'google/gemini-2.5-flash-image',
      modalities: ['image', 'text'],
      image_config: { aspect_ratio: '16:9' },
    });
    expect(response.images).toEqual([{ url: 'data:image/png;base64,AAA' }]);
  });
});

describe('convertOpenRouterModel', () => {
  const model: OpenRouterModel = {
    id: 'openai/gpt-5.4-mini',
    canonical_slug: 'openai/gpt-5.4-mini-20260317',
    hugging_face_id: null,
    name: 'OpenAI: GPT-5.4 Mini',
    created: 1,
    context_length: 400000,
    architecture: { modality: 'text+image+file->text', input_modalities: ['text', 'image', 'file'], output_modalities: ['text'], tokenizer: 'GPT', instruct_type: null },
    pricing: { prompt: '0.00000075', completion: '0.0000045', input_cache_read: '0.000000075', web_search: '0.01', internal_reasoning: '0' },
    top_provider: { context_length: 400000, max_completion_tokens: 128000, is_moderated: true },
    supported_parameters: ['tools', 'reasoning', 'response_format', 'structured_outputs', 'verbosity', 'seed'],
    default_parameters: null,
    reasoning: { supported_efforts: ['xhigh', 'high', 'medium', 'low', 'none'], default_effort: 'medium' },
    expiration_date: '2027-03-01T00:00:00Z',
    knowledge_cutoff: '2025-08-31',
  };

  it('maps capabilities, prices, efforts, and retirement', () => {
    const info = convertOpenRouterModel(model, new Set([model.id]));

    expect([...info.capabilities].sort()).toEqual(['chat', 'files', 'json', 'reasoning', 'streaming', 'structured', 'tools', 'vision', 'zdr']);
    expect(info.pricing.text).toEqual({ input: 0.75, output: 4.5, cached: 0.075, cacheWrite: undefined });
    expect(info.pricing.tools).toEqual({ web_search: 0.01 });
    expect(info.pricing.reasoning).toBeUndefined();
    expect(info.reasoningEfforts).toEqual(['none', 'low', 'medium', 'high', 'xhigh']);
    expect(info.retiresAt).toBe('2027-03-01');
    expect([...info.supportedParameters ?? []]).toEqual(expect.arrayContaining(['verbosity', 'seed']));
  });

  it('recognizes speech, transcription, and embedding models', () => {
    const as = (modality: OpenRouterModel['architecture']) => convertOpenRouterModel({ ...model, architecture: modality, supported_parameters: [] }, new Set()).capabilities;

    expect([...as({ ...model.architecture, input_modalities: ['text'], output_modalities: ['speech'] })]).toEqual(['audio']);
    expect([...as({ ...model.architecture, input_modalities: ['audio'], output_modalities: ['transcription'] })]).toEqual(['hearing']);
    expect([...as({ ...model.architecture, input_modalities: ['text'], output_modalities: ['embeddings'] })]).toEqual(['embedding']);
  });
});
