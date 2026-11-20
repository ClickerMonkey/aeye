/**
 * The Ollama provider over a fake server: the model list from the native
 * API, chat and embeddings through `/v1`, and System One decisions.
 */

import { AI, type AIContextAny, DecisionLimitError } from '@aeye/ai';
import { capabilitiesOf, OLLAMA_SYSTEM_ONE_LIMITS, OllamaProvider } from '../ollama';
import { numCtxOf, OllamaApi, type OllamaShow, reasons, servedDefault, servedWindow, takesTools, trainedLengthOf, unsetWindow } from '../api';

const QWEN: OllamaShow = { parameters: 'num_ctx 8192\nstop "<|im_end|>"', template: '{{ if .Tools }}tools{{ end }}', model_info: { 'qwen2.context_length': 32_768 }, details: { family: 'qwen2', parameter_size: '3B' } };
const R1: OllamaShow = { parameters: 'stop "<｜User｜>"', template: '<｜User｜>{{ .Content }}', model_info: { 'qwen2.context_length': 131_072 } };
const NIMBLE: OllamaShow = { capabilities: ['decision', 'vision'], model_info: { 'nimble.context_length': 65_536 } };
const EMBED: OllamaShow = { capabilities: ['embedding'], model_info: { 'bert.context_length': 2_048 } };
const LEGACY_DECIDER: OllamaShow = { model_info: { 'tev.context_length': 8_192 } };

interface Call { url: string; method: string; body: unknown; headers: Record<string, string> }

/** A fake Ollama: the native API, `/v1/systemone`, `/v1/chat/completions` and `/v1/embeddings`. */
function fakeOllama(shows: Record<string, OllamaShow>, version = '0.36.0') {
  const calls: Call[] = [];
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    calls.push({ url, method: init?.method ?? 'GET', body, headers });
    const path = new URL(url).pathname;
    switch (path) {
      case '/api/tags': return json({ models: Object.keys(shows).map((name) => ({ name, model: name })) });
      case '/api/version': return json({ version });
      case '/api/show': return shows[body.model] ? json(shows[body.model]) : json({ error: 'not found' }, 404);
      case '/v1/systemone': return json({
        model: body.model,
        answers: {
          cat: { type: 'noul', noul: 0.92 },
          mood: { type: 'score', score: 0.4, legend: { 0: 'calm', 1: 'angry' }, probabilities: { 1: 0.4, 0: 0.6 }, confidence: 0.1 },
        },
        usage: { input_tokens: 120, output_tokens: 2 },
      });
      case '/v1/chat/completions': return json({ id: 'c', object: 'chat.completion', created: 0, model: body.model, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'hi' } }], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } });
      case '/v1/embeddings': return json({ object: 'list', model: body.model, data: body.input.map((_: string, index: number) => ({ object: 'embedding', index, embedding: [index, 1] })), usage: { prompt_tokens: 4, total_tokens: 4 } });
      default: return json({ error: path }, 404);
    }
  }) as typeof fetch;
  return { fetcher, calls };
}

const ctx: AIContextAny = { ai: AI.with().providers({}).create({}), metadata: {} };

describe('Ollama native API', () => {
  it('reads served windows, tools and thinking from /api/show', () => {
    expect(numCtxOf(QWEN)).toBe(8_192);
    expect(numCtxOf(R1)).toBeUndefined();
    expect(trainedLengthOf(R1)).toBe(131_072);
    expect(servedDefault('0.5.7')).toBe(2_048);
    expect(servedDefault('0.6.0')).toBe(4_096);
    expect(unsetWindow('0.6.0', undefined, 3_000)).toBe(3_000);
    expect(unsetWindow('0.6.0', 16_384, 3_000)).toBe(16_384);
    expect(servedWindow(QWEN, 2_048)).toBe(8_192);
    expect(servedWindow({ parameters: 'num_ctx 99999', model_info: { 'x.context_length': 4_000 } }, 2_048)).toBe(4_000);
    expect(takesTools(QWEN)).toBe(true);
    expect(takesTools(R1)).toBe(false);
    expect(reasons('deepseek-r1:7b', R1)).toBe(true);
    expect(reasons('qwen2.5:3b', QWEN)).toBe(false);
    expect(new OllamaApi('http://x:1/').baseURL).toBe('http://x:1');
  });

  it('sends a cloud key and reports a failed call', async () => {
    const { fetcher, calls } = fakeOllama({});
    const api = new OllamaApi('https://ollama.com', fetcher, 'secret');
    await api.tags();
    expect(calls[0]!.headers.authorization).toBe('Bearer secret');
    await expect(api.show('missing')).rejects.toThrow('Ollama /api/show answered 404');
  });

  it('knows decision models from capabilities, else from the decisionModels flag', () => {
    expect([...capabilitiesOf('nimble', NIMBLE)]).toEqual(['decision', 'vision']);
    expect([...capabilitiesOf('embed', EMBED)]).toEqual(['embedding']);
    expect([...capabilitiesOf('tev', LEGACY_DECIDER)]).toEqual(['chat', 'streaming', 'json']);
    expect([...capabilitiesOf('tev:latest', LEGACY_DECIDER, ['tev'])]).toEqual(['decision']);
    // a server that lists capabilities is believed over the flag
    expect(capabilitiesOf('nimble', { capabilities: ['completion'] }, ['nimble']).has('decision')).toBe(false);
  });
});

describe('OllamaProvider', () => {
  it('lists models with abilities, served windows, and System One limits on decision models', async () => {
    const { fetcher } = fakeOllama({ 'qwen2.5:3b': QWEN, 'deepseek-r1:7b': R1, nimble: NIMBLE, 'nomic-embed': EMBED, tev: LEGACY_DECIDER }, '0.5.7');
    const models = await new OllamaProvider({ baseURL: 'http://ollama.test:11434/', fetch: fetcher, maxContextWindow: 4_096, decisionModels: ['tev'] }).listModels();
    const byId = Object.fromEntries(models.map((m) => [m.id, m]));

    expect(byId['qwen2.5:3b']).toMatchObject({ provider: 'ollama', contextWindow: 8_192, metadata: { family: 'qwen2', size: '3B' } });
    expect([...byId['qwen2.5:3b']!.capabilities]).toEqual(['chat', 'streaming', 'json', 'tools']);
    expect(byId['deepseek-r1:7b']).toMatchObject({ contextWindow: 2_048 });
    expect(byId['deepseek-r1:7b']!.capabilities.has('reasoning')).toBe(true);
    expect(byId['nimble']).toMatchObject({ maxQuestions: 64, maxRequestBytes: 65_536, contextWindow: 2_048 });
    expect(byId['tev']).toMatchObject(OLLAMA_SYSTEM_ONE_LIMITS);
    expect(byId['qwen2.5:3b']).not.toHaveProperty('maxQuestions');
    expect([...byId['nomic-embed']!.capabilities]).toEqual(['embedding']);
  });

  it('chats over /v1 with system messages as system', async () => {
    const { fetcher, calls } = fakeOllama({});
    const provider = new OllamaProvider({ fetch: fetcher });
    const response = await provider.createExecutor()({ messages: [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'Hi' }] }, ctx, { model: 'qwen2.5:3b' });

    expect(response.content).toBe('hi');
    const chat = calls.find((c) => c.url.endsWith('/v1/chat/completions'))!;
    expect(chat.url).toBe('http://127.0.0.1:11434/v1/chat/completions');
    expect((chat.body as { messages: Array<{ role: string }> }).messages.map((m) => m.role)).toEqual(['system', 'user']);
  });

  it('embeds over /v1', async () => {
    const { fetcher } = fakeOllama({});
    const response = await new OllamaProvider({ fetch: fetcher }).embed!({ texts: ['a', 'b'], model: 'nomic-embed' }, ctx);
    expect(response.embeddings).toEqual([{ embedding: [0, 1], index: 0 }, { embedding: [1, 1], index: 1 }]);
  });

  it('embeds text inputs, and refuses images, which its endpoints do not take', async () => {
    const { fetcher, calls } = fakeOllama({});
    const provider = new OllamaProvider({ fetch: fetcher });
    const response = await provider.embed!({ inputs: ['a', 'b'], model: 'nomic-embed' }, ctx);
    expect(response.embeddings).toHaveLength(2);

    const sent = calls.length;
    await expect(provider.embed!({ inputs: [{ image: Buffer.from([1]) }], model: 'nomic-embed' }, ctx)).rejects.toThrow('embeds text only');
    expect(calls.length).toBe(sent);
    expect(capabilitiesOf('vl-embed', { capabilities: ['embedding', 'vision'] }).has('imageEmbedding')).toBe(false);
  });

  it('decides at /v1/systemone with images and keep_alive, and reads the answers', async () => {
    const { fetcher, calls } = fakeOllama({});
    const provider = new OllamaProvider({ fetch: fetcher, keepAlive: '10m' });
    const png = Buffer.from([1, 2, 3]);

    const response = await provider.decide!({
      model: 'nimble',
      input: [{ role: 'system', content: 'You see a photo.' }, { role: 'user', content: 'What is this?' }],
      images: [png],
      questions: {
        cat: { type: 'predicate', instructions: 'Is there a cat?' },
        mood: { type: 'score', instructions: 'How angry is it?', levels: ['calm', 'angry'] },
      },
    }, ctx);

    const call = calls.find((c) => c.url.endsWith('/v1/systemone'))!;
    expect(call.url).toBe('http://127.0.0.1:11434/v1/systemone');
    expect(call.body).toEqual({
      model: 'nimble',
      state: [{ role: 'system', content: [{ type: 'text', text: 'You see a photo.' }] }, { role: 'user', content: [{ type: 'text', text: 'What is this?' }] }],
      questions: {
        cat: { type: 'noul', instructions: 'Is there a cat?' },
        mood: { type: 'score', instructions: 'How angry is it?', criteria: ['calm', 'angry'] },
      },
      images: [png.toString('base64')],
      keep_alive: '10m',
    });
    expect(response.answers).toEqual({
      cat: { type: 'predicate', probability: 0.92 },
      mood: { type: 'score', score: 0.4, probabilities: [0.6, 0.4], confidence: 0.1 },
    });
    expect(response.usage).toEqual({ text: { input: 120, output: 2 } });
  });

  it('lets the request override keep_alive and leaves it out when unset', async () => {
    const { fetcher, calls } = fakeOllama({});
    const questions = { cat: { type: 'predicate' as const, instructions: 'A cat?' } };
    await new OllamaProvider({ fetch: fetcher, keepAlive: '10m' }).decide!({ model: 'nimble', input: 'text', questions, extra: { keep_alive: 0 } }, ctx);
    await new OllamaProvider({ fetch: fetcher }).decide!({ model: 'nimble', input: 'text', questions }, ctx);

    const [overridden, unset] = calls.filter((c) => c.url.endsWith('/v1/systemone')).map((c) => c.body as Record<string, unknown>);
    expect(overridden!.keep_alive).toBe(0);
    expect(overridden!.state).toBe('text');
    expect(unset).not.toHaveProperty('keep_alive');
    expect(unset).not.toHaveProperty('images');
  });

  it('refuses more than 64 questions or 64 KiB without calling the server', async () => {
    const { fetcher, calls } = fakeOllama({});
    const provider = new OllamaProvider({ fetch: fetcher });
    const questions = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, i) => [`q${i}`, { type: 'predicate' as const, instructions: `Question ${i}?` }]));

    await expect(provider.decide!({ model: 'nimble', input: 'text', questions: questions(65) }, ctx)).rejects.toThrow(DecisionLimitError);
    await expect(provider.decide!({ model: 'nimble', input: 'text', questions: questions(65) }, ctx)).rejects.toThrow('nimble takes at most 64 questions per decision call, and this one asks 65');
    await expect(provider.decide!({ model: 'nimble', input: 'x'.repeat(70_000), questions: questions(1) }, ctx)).rejects.toMatchObject({ limit: 'maxRequestBytes', max: 65_536 });
    // images don't count against the 64 KiB
    await provider.decide!({ model: 'nimble', input: 'text', images: [Buffer.alloc(100_000)], questions: questions(64) }, ctx);
    expect(calls.filter((c) => c.url.endsWith('/v1/systemone'))).toHaveLength(1);
  });

  it('decides through ai.decide on a listed decision model', async () => {
    const { fetcher, calls } = fakeOllama({ nimble: NIMBLE, 'qwen2.5:3b': QWEN });
    const ai = AI.with().providers({ ollama: new OllamaProvider({ fetch: fetcher }) }).create({});
    await ai.models.refresh();

    const response = await ai.decide.get({ input: 'text', images: [Buffer.from([1])], questions: { cat: { type: 'predicate', instructions: 'A cat?' } } });
    expect(response.answers.cat).toEqual({ type: 'predicate', probability: 0.92 });
    expect((calls.find((c) => c.url.endsWith('/v1/systemone'))!.body as { model: string }).model).toBe('nimble');
  });
});
