/**
 * Which JSON Schema dialect each registry model resolves to, for tools and for
 * structured output, through the provider that serves it. Offline: the model
 * data and the curated strict table only.
 */

import { describe, expect, it } from '@jest/globals';
import { AI, buildSchemaBudget } from '@aeye/ai';
import { OpenAIProvider } from '@aeye/openai';
import { OpenRouterProvider } from '@aeye/openrouter';
import { models, strictSupport } from '@aeye/models';
import z from 'zod';

// Exposes the families each provider speaks, so the table runs through the real ones
class OpenAIProbe extends OpenAIProvider {
  families() {
    return this.supportedStrictFamilies;
  }
}
class OpenRouterProbe extends OpenRouterProvider {
  families() {
    return this.supportedStrictFamilies;
  }
}

const providers = { openai: new OpenAIProbe({ apiKey: 'offline' }), openrouter: new OpenRouterProbe({ apiKey: 'offline' }) };
const ai = AI.with().providers(providers).create({ models, modelOverrides: strictSupport });
const schema = z.object({ answer: z.string() });

/**
 * The descriptor ids a model's tool and output schemas are sent with when
 * strict is preferred.
 */
function dialects(provider: keyof typeof providers, id: string): [string, string] {
  const model = ai.models.list().find(m => m.provider === provider && m.id === id);
  if (!model) {
    throw new Error(`${provider} ${id} is not in the registry`);
  }
  const families = providers[provider].families();
  return [
    buildSchemaBudget(model, families).allocateTool(schema, 1).id,
    buildSchemaBudget(model, families).allocateOutput(schema, 1).id,
  ];
}

// Provider, model id, tool descriptor, output descriptor
const table: [keyof typeof providers, string, string, string][] = [
  // OpenAI direct
  ['openai', 'gpt-5.4-nano', 'openai-strict', 'openai-strict'],
  ['openai', 'gpt-5.4-mini', 'openai-strict', 'openai-strict'],
  ['openai', 'gpt-4.1-nano', 'openai-strict', 'openai-strict'],
  ['openai', 'gpt-4o-mini', 'openai-strict', 'openai-strict'],
  ['openai', 'o4-mini', 'openai-strict', 'openai-strict'],
  ['openai', 'gpt-4-turbo', 'openai-non-strict', 'openai-non-strict'],
  // OpenRouter, vendor families
  ['openrouter', 'openai/gpt-5.4-nano', 'openai-strict', 'openai-strict'],
  ['openrouter', '~openai/gpt-mini-latest', 'openai-strict', 'openai-strict'],
  ['openrouter', 'anthropic/claude-haiku-4.5', 'anthropic-strict', 'anthropic-strict'],
  ['openrouter', 'google/gemini-2.5-flash-lite', 'google-strict', 'google-strict'],
  ['openrouter', 'google/gemini-3-flash-preview', 'google-strict', 'google-strict'],
  ['openrouter', 'x-ai/grok-4.3', 'xai-strict', 'xai-strict'],
  // OpenRouter, open weights under a vendor prefix
  ['openrouter', 'openai/gpt-oss-20b', 'lenient', 'lenient'],
  ['openrouter', 'google/gemma-3-27b-it', 'lenient', 'lenient'],
  // OpenRouter, open weights
  ['openrouter', 'deepseek/deepseek-v3.2', 'lenient', 'lenient'],
  ['openrouter', 'qwen/qwen3-32b', 'lenient', 'lenient'],
  ['openrouter', 'mistralai/mistral-small-3.2-24b-instruct', 'lenient', 'lenient'],
  ['openrouter', 'meta-llama/llama-4-scout', 'lenient', 'lenient'],
  ['openrouter', 'moonshotai/kimi-k2-0905', 'lenient', 'lenient'],
  ['openrouter', 'z-ai/glm-4.6', 'lenient', 'lenient'],
];

describe('schema dialect per model', () => {
  it.each(table)('%s %s → tools %s, output %s', (provider, id, tools, output) => {
    expect(dialects(provider, id)).toEqual([tools, output]);
  });

  it('never sends a strict tool to a model without strict tools', () => {
    for (const model of ai.models.list()) {
      if (model.capabilities.has('toolsStrict') || !(model.provider in providers)) {
        continue;
      }
      const provider = model.provider === 'openai' ? 'openai' : 'openrouter';
      expect([model.id, buildSchemaBudget(model, providers[provider].families()).allocateTool(schema, 1).strict]).toEqual([model.id, false]);
    }
  });
});
