/**
 * Live smoke test: each provider streams a first token through the AI class.
 */

import { describe, expect } from '@jest/globals';
import { AI } from '@aeye/ai';
import { OpenAIProvider } from '@aeye/openai';
import { OpenRouterProvider } from '@aeye/openrouter';
import { firstChunk, liveCase } from '../live';
import { getAPIKey, hasAPIKey } from '../setup';

const describeLive = hasAPIKey('openai') && hasAPIKey('openrouter') ? describe : describe.skip;

describeLive('live smoke', () => {
  const openai = AI.with().providers({ openai: new OpenAIProvider({ apiKey: getAPIKey('openai') }) }).create();
  const openrouter = AI.with().providers({ openrouter: new OpenRouterProvider({ apiKey: getAPIKey('openrouter') }) }).create();
  const request = { messages: [{ role: 'user' as const, content: 'Say hi.' }] };

  liveCase('smoke openai gpt-5.4-nano', { sources: ['core', 'ai', 'openai'], inputs: { model: 'gpt-5.4-nano' } }, async () => {
    const chunk = await firstChunk((signal) => openai.chat.stream(request, { signal, metadata: { model: 'gpt-5.4-nano' } }));
    expect(chunk).toBeDefined();
  });

  liveCase('smoke openrouter gemini-2.5-flash-lite', { sources: ['core', 'ai', 'openai', 'openrouter'], inputs: { model: 'google/gemini-2.5-flash-lite' } }, async () => {
    const chunk = await firstChunk((signal) => openrouter.chat.stream(request, { signal, metadata: { model: 'google/gemini-2.5-flash-lite' } }));
    expect(chunk).toBeDefined();
  });
});
