import { loadConfig } from './config';
import { AI } from '@aeye/ai';
import { OpenAIProvider } from '@aeye/openai';
import { OpenRouterProvider } from '@aeye/openrouter';
import { AWSBedrockProvider } from '@aeye/aws';
import { models } from '@aeye/models';
import type { Ctx, Meta } from './context';
import { bootstrap } from './registry';
import { createStore } from './store';
import { createRunState } from './run-state';
import { createFetchImpl, registerFetchType } from './natives/fetch';
import { createLlmImpl, registerLlmType } from './natives/llm';

// Hydrate process.env from config.json before anything reads env vars.
// Safe: imported modules above just declare classes; no env-var reads run yet.
loadConfig(process.cwd());

function buildProviders() {
  const providers = {
    ...(process.env['OPENAI_API_KEY']
      ? { openai: new OpenAIProvider({ apiKey: process.env['OPENAI_API_KEY']! }) }
      : {}),
    ...(process.env['OPENROUTER_API_KEY']
      ? { openrouter: new OpenRouterProvider({ apiKey: process.env['OPENROUTER_API_KEY']! }) }
      : {}),
    ...(process.env['AWS_ACCESS_KEY_ID']
      ? { aws: new AWSBedrockProvider({ region: process.env['AWS_REGION'] ?? 'us-east-1' }) }
      : {}),
  };

  if (Object.keys(providers).length === 0) {
    throw new Error(
      'No AI provider configured. Set OPENAI_API_KEY, OPENROUTER_API_KEY, or AWS_ACCESS_KEY_ID.',
    );
  }

  return providers;
}

export const { registry, engine } = bootstrap();
export const store = createStore(process.cwd());
export const features = { webSearch: !!process.env['TAVILY_API_KEY'] };

const sessionLoadedTypes = new Set<string>();
const sessionLoadedFns = new Set<string>();
const sessionLoadedVars = new Map<string, { type: any; parsed: any; docs?: string }>();

const modelIdOverride = process.env['GIN_MODEL'];
const providerOverride = process.env['GIN_PROVIDER'];

export const ai = AI.with<Ctx, Meta>()
  .providers(buildProviders())
  .create({
    defaultContext: {
      registry,
      engine,
      store,
      features,
      loadedTypes: sessionLoadedTypes,
      loadedFns: sessionLoadedFns,
      loadedVars: sessionLoadedVars,
      runState: createRunState(),
    },
    providedContext: async (ctx) => ({
      ...ctx,
      runState: createRunState(),
    }),
    defaultMetadata: {
      ...(modelIdOverride ? { model: { id: modelIdOverride } as any } : {}),
      ...(providerOverride ? { providers: { preferred: [providerOverride] } as any } : {}),
    } as any,
    models,
  });

// Wire global natives after AI instance is created.
const fetchFnType = registerFetchType(registry);
const llmFnType = registerLlmType(registry);

const fnsType = registry.obj({
  fetch: { type: fetchFnType },
  llm: { type: llmFnType },
});

engine.registerGlobal('fns', {
  type: fnsType,
  value: {
    fetch: createFetchImpl(registry),
    llm: createLlmImpl(registry, ai),
  },
});
