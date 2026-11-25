/**
 * Which JSON Schema dialect each registry model resolves to, for tools and for
 * structured output, through the provider that serves it. Offline: the model
 * data and the curated strict table only.
 */

import { describe, expect, it } from '@jest/globals';
import { AI, type ModelInfo } from '@aeye/ai';
import { familyOf, planRequest, type RequestPlan } from '@aeye/core';
import { OpenAIProvider } from '@aeye/openai';
import { OpenRouterProvider } from '@aeye/openrouter';
import { models, strictSupport } from '@aeye/models';
import { a } from '@aeye/schema';

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
const schema = a.object({ answer: a.string() });

/** A request with one tool and a structured output, planned for `model` as its provider plans it. */
function plan(provider: keyof typeof providers, model: ModelInfo): RequestPlan {
  return planRequest({
    tools: [{ name: 'record', parameters: schema.bind(), strict: 1 }],
    responseFormat: { type: schema.bind(), strict: 1 },
  }, model, { speaks: providers[provider].families() });
}

/** A rendering's dialect: its family, `-strict` when sent strict, `(prompt)` when sent as prompt text. */
const dialect = (entry: { profile: { family: string }; strict: boolean; delivery: string }) =>
  entry.profile.family + (entry.strict ? '-strict' : '') + (entry.delivery === 'prompt' ? ' (prompt)' : '');

/**
 * The dialects a model's tool and output schemas are sent in when strict is
 * preferred.
 */
function dialects(provider: keyof typeof providers, id: string): [string, string] {
  const model = ai.models.list().find(m => m.provider === provider && m.id === id);
  if (!model) {
    throw new Error(`${provider} ${id} is not in the registry`);
  }
  const planned = plan(provider, model);
  return [dialect(planned.get('record')), dialect(planned.output!)];
}

// Provider, model id, tool dialect, output dialect
const table: [keyof typeof providers, string, string, string][] = [
  // OpenAI direct
  ['openai', 'gpt-5.4-nano', 'openai-strict', 'openai-strict'],
  ['openai', 'gpt-5.4-mini', 'openai-strict', 'openai-strict'],
  ['openai', 'gpt-4.1-nano', 'openai-strict', 'openai-strict'],
  ['openai', 'gpt-4o-mini', 'openai-strict', 'openai-strict'],
  ['openai', 'o4-mini', 'openai-strict', 'openai-strict'],
  // No 'structured' or 'json' in the registry: the output goes as prompt text
  ['openai', 'gpt-4-turbo', 'openai', 'openai (prompt)'],
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

  it('never sends a strict tool to a model without strict tools (but xAI, whose tools always are)', () => {
    for (const model of ai.models.list()) {
      if (model.capabilities.has('toolsStrict') || !(model.provider in providers) || familyOf(model) === 'xai') {
        continue;
      }
      const provider = model.provider === 'openai' ? 'openai' : 'openrouter';
      expect([model.id, plan(provider, model).get('record').strict]).toEqual([model.id, false]);
    }
  });
});
