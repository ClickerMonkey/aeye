/**
 * Multi-Provider Integration Tests
 *
 * Tests that verify multiple providers work together correctly through the AI class.
 * These tests make REAL API calls and require OpenAI and OpenRouter API keys in environment.
 */

import { describe, beforeAll, it, expect } from '@jest/globals';
import { AI } from '@aeye/ai';
import { models } from '@aeye/models';
import { OpenAIProvider } from '@aeye/openai';
import { OpenRouterProvider } from '@aeye/openrouter';
import { getAPIKey, hasAPIKey } from '../setup';

type ProviderName = 'openai' | 'openrouter';

const PROVIDERS: ProviderName[] = ['openai', 'openrouter'];

/**
 * A cheap, plain chat model from each provider, for the requests that run;
 * selection on capability alone can land on specialized models.
 */
const CHAT_MODELS: Record<ProviderName, string> = {
  openai: 'gpt-5.4-nano',
  openrouter: 'google/gemini-2.5-flash-lite',
};

/**
 * An AI over every provider under test, with the registry's model data.
 */
function createAI() {
  return AI.with()
    .providers({
      openai: new OpenAIProvider({ apiKey: getAPIKey('openai') }),
      openrouter: new OpenRouterProvider({ apiKey: getAPIKey('openrouter') }),
    })
    .create({ models });
}

const describeMultiProvider = PROVIDERS.every(hasAPIKey) ? describe : describe.skip;

describeMultiProvider('Multi-Provider Integration', () => {
  let ai: ReturnType<typeof createAI>;

  beforeAll(async () => {
    ai = createAI();
    await ai.models.refresh();
  });

  describe('Model Discovery', () => {
    it('should have models from all configured providers', () => {
      const models = ai.models.list();

      expect(models.length).toBeGreaterThan(0);

      for (const provider of PROVIDERS) {
        const providerModels = models.filter(m => m.provider === provider);
        expect(providerModels.length).toBeGreaterThan(0);
        console.log(`  ${provider}: ${providerModels.length} models`);
      }
    });

    it('should list models with chat capability', () => {
      const chatModels = ai.models.search({ required: ['chat'] });

      expect(chatModels.length).toBeGreaterThan(0);
      console.log(`  Found ${chatModels.length} chat models across all providers`);

      // Verify models from multiple providers
      const providers = new Set(chatModels.map(m => m.model.provider));
      expect(providers.size).toBeGreaterThan(1);
    });
  });

  describe('Model Selection', () => {
    it('should select cheapest model across all providers', () => {
      const selected = ai.models.select({
        required: ['chat'],
        weights: { cost: 1, speed: 0, accuracy: 0 },
      });

      expect(selected?.model.capabilities.has('chat')).toBe(true);

      console.log(`  Cheapest: ${selected?.model.id} from ${selected?.model.provider}`);
      console.log(`  Cost: $${selected?.model.pricing.text?.input}/M input, $${selected?.model.pricing.text?.output}/M output`);
    });

    it('should select a flagship model when accuracy weighted', () => {
      const selected = ai.models.select({
        required: ['chat'],
        weights: { cost: 0, speed: 0, accuracy: 1 },
      });

      expect(selected?.model.tier).toBe('flagship');

      console.log(`  Most accurate: ${selected?.model.id} from ${selected?.model.provider}`);
    });

    it('should respect provider allowlist', () => {
      for (const provider of PROVIDERS) {
        const selected = ai.models.select({ required: ['chat'], providers: { allow: [provider] } });

        expect(selected?.model.provider).toBe(provider);
        console.log(`  Selected from ${provider}: ${selected?.model.id}`);
      }
    });

    it('should respect provider denylist', () => {
      const [denied] = PROVIDERS;
      const selected = ai.models.select({ required: ['chat'], providers: { deny: [denied] } });

      expect(selected).toBeDefined();
      expect(selected?.model.provider).not.toBe(denied);

      console.log(`  Selected (excluding ${denied}): ${selected?.model.id} from ${selected?.model.provider}`);
    });
  });

  describe('Cross-Provider Chat Execution', () => {
    it('should execute chat on all available providers', async () => {
      for (const provider of PROVIDERS) {
        const response = await ai.chat.get(
          { messages: [{ role: 'user', content: 'Reply with exactly: "Hello from AI"' }] },
          { metadata: { model: CHAT_MODELS[provider], providers: { allow: [provider] } } },
        );

        expect(response.content).toBeTruthy();
        console.log(`  ${provider}: ${response.content}`);
      }
    }, 120000); // 2 minute timeout for multiple API calls

    it('should execute streaming chat on all available providers', async () => {
      for (const provider of PROVIDERS) {
        const chunks: string[] = [];

        const stream = ai.chat.stream(
          { messages: [{ role: 'user', content: 'Count from 1 to 3' }] },
          { metadata: { model: CHAT_MODELS[provider], providers: { allow: [provider] } } },
        );

        for await (const chunk of stream) {
          if (chunk.content) {
            chunks.push(chunk.content);
          }
        }

        const fullResponse = chunks.join('');
        expect(fullResponse).toBeTruthy();

        console.log(`  ${provider}: ${chunks.length} chunks, "${fullResponse.substring(0, 50)}..."`);
      }
    }, 120000); // 2 minute timeout
  });

  describe('Cost Comparison', () => {
    it('should show cost differences between providers for same task', () => {
      const chatModels = ai.models.search({ required: ['chat'] });

      // The cheapest priced chat model from each provider
      const cheapestByProvider = new Map<string, (typeof chatModels)[number]['model']>();
      for (const { model } of chatModels) {
        const input = model.pricing.text?.input;
        const cheapest = cheapestByProvider.get(model.provider);
        if (input !== undefined && (!cheapest || (cheapest.pricing.text?.input ?? Infinity) > input)) {
          cheapestByProvider.set(model.provider, model);
        }
      }

      console.log('\n  Cheapest chat model by provider:');
      for (const [provider, model] of cheapestByProvider) {
        console.log(`    ${provider}: ${model.id}`);
        console.log(`      Input: $${model.pricing.text?.input}/M`);
        console.log(`      Output: $${model.pricing.text?.output}/M`);
      }

      expect(cheapestByProvider.size).toBeGreaterThan(1);
    });
  });

  describe('Provider Health', () => {
    it('should check health of all providers', async () => {
      for (const provider of PROVIDERS) {
        const healthy = await ai.providers[provider].checkHealth();
        console.log(`  ${provider}: ${healthy ? '✓' : '✗'}`);
        expect(healthy).toBe(true);
      }
    }, 60000);
  });
});
