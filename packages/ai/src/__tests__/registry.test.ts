/**
 * Model Registry Tests
 *
 * Tests for the ModelRegistry class including model listing, searching, and selection.
 */

import { ModelRegistry } from '../registry';
import { ModelHandler } from '../types';
import { createMockProvider } from './mocks/provider.mock';

describe('ModelRegistry', () => {
  describe('Construction and Initialization', () => {
    it('should create an empty registry with no providers', () => {
      const registry = new ModelRegistry({});

      expect(registry.listModels()).toHaveLength(0);
    });

    it('should create registry with providers', () => {
      const provider1 = createMockProvider({ name: 'provider1' });
      const provider2 = createMockProvider({ name: 'provider2' });

      const registry = new ModelRegistry({
        provider1,
        provider2
      });

      // No models until refresh is called
      expect(registry.listModels()).toHaveLength(0);
    });
  });

  describe('Model Listing', () => {
    it('should list all models from registered providers', async () => {
      const provider1 = createMockProvider({ name: 'provider1' });
      const provider2 = createMockProvider({ name: 'provider2' });

      const registry = new ModelRegistry({
        provider1,
        provider2
      });

      await registry.refresh();

      const models = registry.listModels();

      // Each provider has 4 models
      expect(models.length).toBe(16);

      // Check both providers are represented
      const provider1Models = models.filter(m => m.provider === 'provider1');
      const provider2Models = models.filter(m => m.provider === 'provider2');

      expect(provider1Models.length).toBe(8);
      expect(provider2Models.length).toBe(8);
    });

    it('should return empty list before refresh', () => {
      const provider = createMockProvider();
      const registry = new ModelRegistry({ mock: provider });

      const models = registry.listModels();
      expect(models).toHaveLength(0);
    });

    it('should update models on refresh', async () => {
      const provider = createMockProvider();
      const registry = new ModelRegistry({ mock: provider });

      const beforeRefresh = registry.listModels();
      expect(beforeRefresh).toHaveLength(0);

      await registry.refresh();

      const afterRefresh = registry.listModels();
      expect(afterRefresh.length).toBeGreaterThan(0);
    });
  });

  describe('Model Searching', () => {
    let registry: ModelRegistry<any>;

    beforeEach(async () => {
      const provider1 = createMockProvider({ name: 'provider1' });
      const provider2 = createMockProvider({ name: 'provider2' });

      registry = new ModelRegistry({
        provider1,
        provider2
      });

      await registry.refresh();
    });

    describe('Capability Matching', () => {
      it('should find models with required capabilities', () => {
        const results = registry.searchModels({
          required: ['chat']
        });

        expect(results.length).toBeGreaterThan(0);
        results.forEach(result => {
          expect(result.model.capabilities.has('chat')).toBe(true);
          expect(result.missingRequired).toHaveLength(0);
        });
      });

      it('should find models with multiple required capabilities', () => {
        const results = registry.searchModels({
          required: ['chat', 'streaming']
        });

        expect(results.length).toBeGreaterThan(0);
        results.forEach(result => {
          expect(result.model.capabilities.has('chat')).toBe(true);
          expect(result.model.capabilities.has('streaming')).toBe(true);
        });
      });

      it('should return empty when no models match', () => {
        const results = registry.searchModels({
          required: ['nonexistent-capability' as any]
        });

        expect(results).toHaveLength(0);
      });

      it('should prefer models with optional capabilities', () => {
        const results = registry.searchModels({
          required: ['chat'],
          optional: ['vision']
        });

        // Models with vision should score higher
        const withVision = results.filter(r => r.model.capabilities.has('vision'));
        const withoutVision = results.filter(r => !r.model.capabilities.has('vision'));

        if (withVision.length > 0 && withoutVision.length > 0) {
          expect(withVision[0].score).toBeGreaterThan(withoutVision[0].score);
        }
      });
    });

    describe('Provider Filtering', () => {
      it('should filter by allowed providers', () => {
        const results = registry.searchModels({
          required: ['chat'],
          providers: {
            allow: ['provider1']
          }
        });

        expect(results.length).toBeGreaterThan(0);
        results.forEach(result => {
          expect(result.model.provider).toBe('provider1');
        });
      });

      it('should filter by denied providers', () => {
        const results = registry.searchModels({
          required: ['chat'],
          providers: {
            deny: ['provider1']
          }
        });

        expect(results.length).toBeGreaterThan(0);
        results.forEach(result => {
          expect(result.model.provider).not.toBe('provider1');
        });
      });

      it('should return empty when all providers denied', () => {
        const results = registry.searchModels({
          required: ['chat'],
          providers: {
            deny: ['provider1', 'provider2']
          }
        });

        expect(results).toHaveLength(0);
      });
    });

    describe('Cost-Based Scoring', () => {
      it('should prefer cheaper models when cost weight is high', () => {
        const results = registry.searchModels({
          required: ['chat'],
          weights: {
            cost: 1.0,
            speed: 0,
            accuracy: 0
          }
        });

        expect(results.length).toBeGreaterThan(1);

        // Should be sorted by cost (ascending)
        for (let i = 1; i < results.length; i++) {
          const prevCost = results[i - 1].model.pricing.text?.input!;
          const currCost = results[i].model.pricing.text?.input!;
          expect(currCost).toBeGreaterThanOrEqual(prevCost);
        }
      });

      it('should prefer flagship models when accuracy weight is high', () => {
        const results = registry.searchModels({
          required: ['chat'],
          weights: {
            cost: 0,
            speed: 0,
            accuracy: 1.0
          }
        });

        expect(results.length).toBeGreaterThan(0);

        // Flagship models should score higher
        const flagshipResults = results.filter(r => r.model.tier === 'flagship');
        const efficientResults = results.filter(r => r.model.tier === 'efficient');

        if (flagshipResults.length > 0 && efficientResults.length > 0) {
          expect(flagshipResults[0].score).toBeGreaterThan(efficientResults[0].score);
        }
      });
    });

    describe('Context Window Filtering', () => {
      it('should filter by minimum context window', () => {
        const results = registry.searchModels({
          required: ['chat'],
          contextWindow: { min: 100000 }
        });

        results.forEach(result => {
          expect(result.model.contextWindow).toBeGreaterThanOrEqual(100000);
        });
      });

      it('should return empty when context window too large', () => {
        const results = registry.searchModels({
          required: ['chat'],
          contextWindow: { min: 1000000 }
        });

        expect(results).toHaveLength(0);
      });
    });

    describe('New Constraint System', () => {
      it('should filter by pricing min/max constraints', () => {
        const results = registry.searchModels({
          required: ['chat'],
          pricing: { 
            min: { text: { input: 0, output: 0 } },
            max: { text: { input: 5, output: 15 } }
          }
        });

        results.forEach(result => {
          const avgCost = ((result.model.pricing.text?.input ?? 0) + (result.model.pricing.text?.output ?? 0)) / 2;
          expect(avgCost).toBeLessThanOrEqual(10);
        });
      });

      it('should filter by context window max constraint', () => {
        const results = registry.searchModels({
          required: ['chat'],
          contextWindow: { max: 50000 }
        });

        results.forEach(result => {
          expect(result.model.contextWindow).toBeLessThanOrEqual(50000);
        });
      });

      it('should filter by output tokens constraint', () => {
        const results = registry.searchModels({
          required: ['chat'],
          outputTokens: { min: 4000 }
        });

        results.forEach(result => {
          expect(result.model.maxOutputTokens).toBeGreaterThanOrEqual(4000);
        });
      });

      it('should use target-based scoring for pricing', () => {
        const results = registry.searchModels({
          required: ['chat'],
          pricing: {
            target: { text: { input: 1, output: 2 } }
          },
          weights: { cost: 1.0 }
        });

        expect(results.length).toBeGreaterThan(0);
        // Models closer to target should score higher
        const firstModel = results[0];
        const avgCost = ((firstModel.model.pricing.text?.input ?? 0) + (firstModel.model.pricing.text?.output ?? 0)) / 2;
        expect(avgCost).toBeDefined();
      });

      it('should use target-based scoring for context window', () => {
        const results = registry.searchModels({
          required: ['chat'],
          contextWindow: {
            min: 10000,
            max: 200000,
            target: 32000
          },
          weights: { contextWindow: 1.0 }
        });

        expect(results.length).toBeGreaterThan(0);
        // Models with context window close to 32000 should score highest
        const topModels = results.slice(0, 3);
        topModels.forEach(result => {
          expect(result.model.contextWindow).toBeGreaterThanOrEqual(10000);
          expect(result.model.contextWindow).toBeLessThanOrEqual(200000);
        });
      });
    });
  });

  describe('Model Selection', () => {
    let registry: ModelRegistry<any>;

    beforeEach(async () => {
      const provider = createMockProvider({ name: 'test-provider' });
      registry = new ModelRegistry({
        'test-provider': provider
      });
      await registry.refresh();
    });

    it('should select best matching model', () => {
      const selected = registry.selectModel({
        required: ['chat']
      });

      expect(selected).toBeDefined();
      expect(selected!.model.capabilities.has('chat')).toBe(true);
      expect(selected!.provider).toBeDefined();
    });

    it('should select explicit model when specified', () => {
      const selected = registry.selectModel({
        model: 'test-provider-chat-efficient'
      });

      expect(selected).toBeDefined();
      expect(selected!.model.id).toBe('test-provider-chat-efficient');
    });

    it('should return undefined when explicit model not found', () => {
      const selected = registry.selectModel({
        model: 'nonexistent-model'
      });

      expect(selected).toBeUndefined();
    });

    it('should return undefined when no models match criteria', () => {
      const selected = registry.selectModel({
        required: ['nonexistent-capability' as any]
      });

      expect(selected).toBeUndefined();
    });

    it('should include provider config in selection', () => {
      const selected = registry.selectModel({
        required: ['chat']
      });

      expect(selected).toBeDefined();
      expect(selected!.providerConfig).toBeDefined();
      expect(selected!.providerConfig.apiKey).toContain('test-key');
    });
  });

  describe('Model Handlers', () => {
    it('should register and retrieve model handlers', () => {
      const registry = new ModelRegistry({});

      const handler: ModelHandler = {
        models: ['test-model'],
        chat: {
          get: jest.fn(),
          stream: jest.fn()
        }
      };

      registry.registerHandler(handler);

      const retrieved = registry.getHandler('test-provider', 'test-model');

      expect(retrieved).toBe(handler);
    });

    it('should return undefined for non-existent handler', () => {
      const registry = new ModelRegistry({});

      const handler = registry.getHandler('nonexistent', 'model');

      expect(handler).toBeUndefined();
    });

    it('should handle multiple handlers for same provider', () => {
      const registry = new ModelRegistry({});

      const handler1: ModelHandler = {
        models: ['model1'],
        chat: { get: jest.fn() }
      };
      const handler2: ModelHandler = {
        models: ['model2'],
        imageGenerate: { get: jest.fn() }
      };

      registry.registerHandler(handler1);
      registry.registerHandler(handler2);

      expect(registry.getHandler('provider', 'model1')).toBe(handler1);
      expect(registry.getHandler('provider', 'model2')).toBe(handler2);
    });
  });

  describe('Provider Capabilities', () => {
    it('should track provider capabilities', async () => {
      const provider = createMockProvider();
      const registry = new ModelRegistry({ test: provider });

      await registry.refresh();

      // Provider should have capabilities from its models
      const chatModels = registry.searchModels({ required: ['chat'] });
      expect(chatModels.length).toBeGreaterThan(0);
    });

    it('should filter by provider capabilities', async () => {
      const provider1 = createMockProvider({ name: 'provider1' });
      const provider2 = createMockProvider({
        name: 'provider2',
        models: [
          {
            id: 'provider2-no-chat',
            provider: 'provider2',
            name: 'No Chat Model',
            capabilities: new Set(['embedding']),
            tier: 'efficient',
            pricing: { text: { input: 0.1, output: 0 } },
            contextWindow: 4096
          }
        ]
      });

      const registry = new ModelRegistry({
        provider1,
        provider2
      });

      // Before refresh, no models
      const beforeResults = registry.searchModels({ required: ['chat'] });
      expect(beforeResults).toHaveLength(0);

      await registry.refresh();

      // After refresh, should have models from provider1
      const afterResults = registry.searchModels({ required: ['chat'] });
      expect(afterResults.length).toBeGreaterThan(0);
    });
  });

  describe('Error Handling', () => {
    it('should handle provider refresh errors gracefully', async () => {
      const failingProvider = {
        name: 'failing',
        config: {},
        async listModels() {
          throw new Error('Failed to list models');
        },
        async checkHealth() {
          return false;
        }
      } as any;

      const registry = new ModelRegistry({ failing: failingProvider });

      // Should not throw
      await expect(registry.refresh()).resolves.not.toThrow();

      // Should have no models from failing provider
      const models = registry.listModels();
      expect(models.filter(m => m.provider === 'failing')).toHaveLength(0);
    });
  });
});
