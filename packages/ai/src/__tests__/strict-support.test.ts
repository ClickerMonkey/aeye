/**
 * Strict-mode support tests.
 *
 * Verifies that:
 * - `'toolsStrict'` capability is auto-derived when `resolveStrictFormat`
 *   returns a family — explicit `strictFormat`, provider name, or id prefix.
 * - `getStrictFormat` returns the right descriptor for each (model, requested) combo
 * - Optional capability scoring biases selection toward strict-capable models without filtering
 * - `strictFormat: 'none'` opts a model out even when provider/id would auto-resolve
 */

import {
  ANTHROPIC_STRICT,
  GOOGLE_STRICT,
  LENIENT,
  OPENAI_STRICT,
  registerDescriptor,
} from '@aeye/core';
import { ModelRegistry, resolveStrictFormat } from '../registry';
import type { ModelInfo, ModelOverride } from '../types';
import { createMockProvider } from './mocks/provider.mock';

function makeMockModel(provider: string, id: string, overrides: Partial<ModelInfo> = {}): ModelInfo {
  return {
    id,
    provider,
    name: id,
    capabilities: new Set(['chat', 'tools']),
    tier: 'flagship',
    pricing: { text: { input: 1, output: 1 } },
    contextWindow: 8192,
    maxOutputTokens: 4096,
    ...overrides,
  };
}

describe('resolveStrictFormat', () => {
  it('returns explicit strictFormat when set to a family', () => {
    expect(resolveStrictFormat({ id: 'foo', provider: 'aws', strictFormat: 'anthropic' })).toBe('anthropic');
  });

  it("returns undefined for explicit 'none' even when provider/id would auto-resolve", () => {
    expect(resolveStrictFormat({ id: 'gpt-3.5-turbo', provider: 'openai', strictFormat: 'none' })).toBeUndefined();
  });

  it('falls back to provider name when it matches a family', () => {
    expect(resolveStrictFormat({ id: 'gpt-4o', provider: 'openai' })).toBe('openai');
    expect(resolveStrictFormat({ id: 'claude-opus-4', provider: 'anthropic' })).toBe('anthropic');
    expect(resolveStrictFormat({ id: 'gemini-2.5-pro', provider: 'google' })).toBe('google');
  });

  it('falls back to id prefix before / when provider does not match', () => {
    expect(resolveStrictFormat({ id: 'openai/gpt-4o', provider: 'openrouter' })).toBe('openai');
    expect(resolveStrictFormat({ id: 'anthropic/claude-opus-4', provider: 'openrouter' })).toBe('anthropic');
    expect(resolveStrictFormat({ id: 'google/gemini-2.5', provider: 'openrouter' })).toBe('google');
  });

  it("strips a leading '~' from OpenRouter '-latest' alias ids before matching the prefix", () => {
    expect(resolveStrictFormat({ id: '~anthropic/claude-sonnet-latest', provider: 'openrouter' })).toBe('anthropic');
    expect(resolveStrictFormat({ id: '~google/gemini-flash-latest', provider: 'openrouter' })).toBe('google');
    expect(resolveStrictFormat({ id: '~openai/gpt-latest', provider: 'openrouter' })).toBe('openai');
  });

  it('returns undefined when neither provider nor id prefix matches', () => {
    expect(resolveStrictFormat({ id: 'anthropic.claude-opus-4', provider: 'aws' })).toBeUndefined();
    expect(resolveStrictFormat({ id: 'gpt-4o', provider: 'replicate' })).toBeUndefined();
  });
});

describe('Strict-mode capability handling', () => {
  describe('applyOverrides auto-derivation', () => {
    it("derives 'toolsStrict' capability when explicit strictFormat is set via overrides", async () => {
      const provider = createMockProvider({
        name: 'p',
        models: [makeMockModel('p', 'capable-model')],
      });

      const overrides: ModelOverride[] = [{
        provider: 'p',
        modelId: 'capable-model',
        overrides: { strictFormat: 'openai' },
      }];

      const registry = new ModelRegistry({ p: provider }, overrides);
      await registry.refresh();

      const model = registry.getModel('capable-model');
      expect(model).toBeDefined();
      expect(model!.strictFormat).toBe('openai');
      expect(model!.capabilities.has('toolsStrict')).toBe(true);
    });

    it("does NOT derive 'toolsStrict' just because provider is a family name", async () => {
      // Capability is opt-IN: a provider name that auto-resolves to a family
      // (via resolveStrictFormat's fallback chain) is NOT enough to mark
      // the model strict-capable. The curated table or scraper must set
      // `strictFormat` explicitly. This protects legacy models like
      // gpt-3.5-turbo from being silently treated as strict.
      const provider = createMockProvider({
        name: 'openai',
        models: [makeMockModel('openai', 'gpt-3.5-turbo')],
      });
      const registry = new ModelRegistry({ openai: provider });
      await registry.refresh();

      const model = registry.getModel('gpt-3.5-turbo')!;
      expect(model.capabilities.has('toolsStrict')).toBe(false);
    });

    it("does NOT derive 'toolsStrict' from id prefix alone", async () => {
      // Same principle for OpenRouter-style ids — the prefix lets the
      // dialect resolve at runtime, but doesn't itself opt the model in.
      const provider = createMockProvider({
        name: 'openrouter',
        models: [makeMockModel('openrouter', 'openai/some-future-legacy-model')],
      });
      const registry = new ModelRegistry({ openrouter: provider });
      await registry.refresh();

      const model = registry.getModel('openai/some-future-legacy-model')!;
      expect(model.capabilities.has('toolsStrict')).toBe(false);
    });

    it("does NOT derive 'toolsStrict' when provider isn't a family and id has no family prefix", async () => {
      const provider = createMockProvider({
        name: 'aws',
        models: [makeMockModel('aws', 'anthropic.claude-3-5-sonnet')],
      });
      const registry = new ModelRegistry({ aws: provider });
      await registry.refresh();

      const model = registry.getModel('anthropic.claude-3-5-sonnet')!;
      expect(model.capabilities.has('toolsStrict')).toBe(false);
    });

    it("'strictFormat: none' removes 'toolsStrict' that an upstream source had set", async () => {
      // Belt-and-suspenders opt-out: if a future scraper incorrectly added
      // 'toolsStrict' to a model that doesn't support strict, the curated
      // table can clear it.
      const provider = createMockProvider({
        name: 'p',
        models: [makeMockModel('p', 'wrongly-cap', {
          capabilities: new Set(['chat', 'tools', 'toolsStrict']),
        })],
      });
      const overrides: ModelOverride[] = [{
        provider: 'p',
        modelId: 'wrongly-cap',
        overrides: { strictFormat: 'none' },
      }];
      const registry = new ModelRegistry({ p: provider }, overrides);
      await registry.refresh();

      const model = registry.getModel('wrongly-cap')!;
      expect(model.strictFormat).toBe('none');
      expect(model.capabilities.has('toolsStrict')).toBe(false);
    });
  });

  describe('getStrictFormat', () => {
    it('returns LENIENT when requested is false', async () => {
      const provider = createMockProvider({
        name: 'p',
        models: [makeMockModel('p', 'm', { strictFormat: 'openai' })],
      });
      const registry = new ModelRegistry({ p: provider });
      await registry.refresh();
      const model = registry.getModel('m')!;
      expect(registry.getStrictFormat(model, false)).toBe(LENIENT);
    });

    it('returns LENIENT when the model has no resolvable family', async () => {
      const provider = createMockProvider({
        name: 'aws',
        models: [makeMockModel('aws', 'plain-model')],
      });
      const registry = new ModelRegistry({ aws: provider });
      await registry.refresh();
      const model = registry.getModel('plain-model')!;
      expect(registry.getStrictFormat(model, true)).toBe(LENIENT);
    });

    it('returns the right strict descriptor per resolved family', async () => {
      const provider = createMockProvider({
        name: 'p',
        models: [
          makeMockModel('p', 'oai', { strictFormat: 'openai' }),
          makeMockModel('p', 'ant', { strictFormat: 'anthropic' }),
          makeMockModel('p', 'gog', { strictFormat: 'google' }),
        ],
      });
      const registry = new ModelRegistry({ p: provider });
      await registry.refresh();

      expect(registry.getStrictFormat(registry.getModel('oai')!, true)).toBe(OPENAI_STRICT);
      expect(registry.getStrictFormat(registry.getModel('ant')!, true)).toBe(ANTHROPIC_STRICT);
      expect(registry.getStrictFormat(registry.getModel('gog')!, true)).toBe(GOOGLE_STRICT);
    });
  });

  describe('custom descriptor families', () => {
    it('resolveStrictFormat finds a custom family registered in @aeye/core', () => {
      registerDescriptor({
        ...OPENAI_STRICT,
        id: 'cohere-strict',
        family: 'cohere',
      });

      // Direct provider name match.
      expect(resolveStrictFormat({ id: 'command-r', provider: 'cohere' })).toBe('cohere');
      // ID prefix match.
      expect(resolveStrictFormat({ id: 'cohere/command-r', provider: 'openrouter' })).toBe('cohere');
    });

    it("auto-derives 'toolsStrict' from explicit custom strictFormat", async () => {
      registerDescriptor({
        ...OPENAI_STRICT,
        id: 'mistral-strict',
        family: 'mistral',
      });

      const provider = createMockProvider({
        name: 'p',
        models: [makeMockModel('p', 'mistral-large', { strictFormat: 'mistral' })],
      });
      const registry = new ModelRegistry({ p: provider });
      await registry.refresh();

      const model = registry.getModel('mistral-large')!;
      expect(model.strictFormat).toBe('mistral');
      expect(model.capabilities.has('toolsStrict')).toBe(true);
      // getStrictFormat resolves to the registered descriptor.
      const desc = registry.getStrictFormat(model, true);
      expect(desc.id).toBe('mistral-strict');
    });
  });

  describe("'toolsStrict' as an optional preference", () => {
    it('does NOT filter out non-strict models when set as optional', async () => {
      const provider = createMockProvider({
        name: 'p',
        models: [
          makeMockModel('p', 'strict-capable', { strictFormat: 'openai' }),
          makeMockModel('p', 'plain'),
        ],
      });
      const registry = new ModelRegistry({ p: provider });
      await registry.refresh();

      const selection = registry.selectModel({
        required: ['chat'],
        optional: ['toolsStrict'],
      });

      expect(selection).toBeDefined();
    });

    it('filters out non-strict models when toolsStrict is REQUIRED', async () => {
      const provider = createMockProvider({
        name: 'aws',
        models: [
          makeMockModel('aws', 'plain'),
        ],
      });
      const registry = new ModelRegistry({ aws: provider });
      await registry.refresh();

      const selection = registry.selectModel({
        required: ['chat', 'toolsStrict'],
      });

      expect(selection).toBeUndefined();
    });
  });
});
