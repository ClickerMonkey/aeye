/**
 * Chat Completions parameter and response mapping.
 */

import { AI, type AIContextAny, type Request } from '@aeye/ai';
import { OpenAIProvider } from '../openai';

const mockCreate = jest.fn();
jest.mock('openai', () => jest.fn().mockImplementation(() => ({
  chat: { completions: { create: mockCreate } },
})));

const ctx: AIContextAny = { ai: AI.with().providers({}).create({}), metadata: {} };
const provider = new OpenAIProvider({ apiKey: 'test' });

const completion = (message: object, extra: object = {}) => ({
  choices: [{ message: { content: 'ok', ...message }, finish_reason: 'stop' }],
  ...extra,
});

async function* streamOf(...chunks: object[]) {
  yield* chunks;
}

/** The params of the most recent API call. */
const sentParams = () => mockCreate.mock.calls[mockCreate.mock.calls.length - 1][0];

beforeEach(() => mockCreate.mockReset());

describe('chat params', () => {
  it('sends reasoning effort when streaming too', async () => {
    mockCreate.mockResolvedValue(streamOf({ choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }] }));
    const request: Request = { messages: [{ role: 'user', content: 'Hi' }], reason: { effort: 'xhigh' } };

    for await (const _ of provider.createStreamer()(request, ctx, { model: 'gpt-5.4' })) { /* drain */ }

    expect(sentParams()).toMatchObject({ stream: true, reasoning_effort: 'xhigh' });
  });

  it('clamps reasoning effort to what the model accepts', async () => {
    mockCreate.mockResolvedValue(completion({}));
    const model = {
      id: 'gpt-6-astra', provider: 'openai', name: 'Astra', capabilities: new Set(['chat' as const]),
      tier: 'flagship' as const, pricing: {}, contextWindow: 1, reasoningEfforts: ['low' as const, 'medium' as const, 'high' as const, 'xhigh' as const, 'max' as const],
    };

    await provider.createExecutor()({ messages: [{ role: 'user', content: 'Hi' }], reason: { effort: 'none' } }, ctx, { model });

    expect(sentParams().reasoning_effort).toBe('low');
  });

  it('maps the newer request fields', async () => {
    mockCreate.mockResolvedValue(completion({}));

    await provider.createExecutor()({
      messages: [{ role: 'user', content: 'Hi' }],
      seed: 7,
      verbosity: 'low',
      serviceTier: 'flex',
      metadata: { run: 'a' },
      moderate: true,
      modalities: ['text', 'audio'],
      audio: { voice: 'marin', format: 'pcm' },
    }, ctx, { model: 'gpt-audio-1.5' });

    expect(sentParams()).toMatchObject({
      seed: 7,
      verbosity: 'low',
      service_tier: 'flex',
      metadata: { run: 'a' },
      moderation: { model: 'omni-moderation-latest' },
      modalities: ['text', 'audio'],
      audio: { voice: 'marin', format: 'pcm16' },
    });
  });

  it('marks cache breakpoints, image detail, and file names on content', async () => {
    mockCreate.mockResolvedValue(completion({}));

    await provider.createExecutor()({
      messages: [{
        role: 'user',
        content: [
          { type: 'text', content: 'Long shared prefix', cacheBreakpoint: true },
          { type: 'image', content: 'https://example.com/a.png', detail: 'original' },
          { type: 'file', content: 'data:application/pdf;base64,JVBERg==', name: 'report.pdf' },
        ],
      }],
    }, ctx, { model: 'gpt-5.4' });

    const [message] = sentParams().messages;
    expect(message.content[0]).toMatchObject({ type: 'text', prompt_cache_breakpoint: {} });
    expect(message.content[1]).toMatchObject({ image_url: { url: 'https://example.com/a.png', detail: 'original' } });
    expect(message.content[1].prompt_cache_breakpoint).toBeUndefined();
    expect(message.content[2].file.filename).toBe('report.pdf');
  });
});

describe('chat response', () => {
  it('reads refusals, citations, audio, moderation, and tier', async () => {
    mockCreate.mockResolvedValue(completion({
      refusal: 'Cannot help with that',
      annotations: [{ type: 'url_citation', url_citation: { url: 'https://a.example', title: 'A', start_index: 0, end_index: 2 } }],
      audio: { id: 'au_1', data: 'QUJD', transcript: 'ok', expires_at: 0 },
    }, {
      service_tier: 'priority',
      moderation: {
        input: { type: 'moderation_results', model: 'm', results: [{ flagged: true, categories: { hate: true, violence: false } }] },
        output: { type: 'error', message: 'failed' },
      },
    }));

    const response = await provider.createExecutor()({ messages: [{ role: 'user', content: 'Hi' }], audio: { voice: 'marin', format: 'wav' } }, ctx, { model: 'gpt-5.4' });

    expect(response.refusal).toBe('Cannot help with that');
    expect(response.citations).toEqual([{ url: 'https://a.example', title: 'A', start: 0, end: 2 }]);
    expect(response.audio).toEqual({ id: 'au_1', data: 'QUJD', transcript: 'ok', format: 'wav' });
    expect(response.moderation).toEqual({ input: { flagged: true, categories: ['hate'] }, output: undefined });
    expect(response.serviceTier).toBe('fast');
  });

  it('splits usage so each token counts once', async () => {
    mockCreate.mockResolvedValue(completion({}, {
      usage: {
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
        prompt_tokens_details: { cached_tokens: 30, cache_write_tokens: 20 },
        completion_tokens_details: { reasoning_tokens: 40 },
      },
    }));

    const response = await provider.createExecutor()({ messages: [{ role: 'user', content: 'Hi' }] }, ctx, { model: 'gpt-5.4' });

    expect(response.usage).toEqual({
      text: { input: 50, output: 10, cached: 30, cacheWrite: 20 },
      reasoning: { output: 40 },
    });
  });
});
