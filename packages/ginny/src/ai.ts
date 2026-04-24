import { loadConfig } from './config';
import { logger } from './logger';
import { AI, type Provider } from '@aeye/ai';
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

/**
 * Provider-level hooks that log the actual wire payload — the params
 * object the provider hands to the SDK's API call. This is what OpenAI
 * / OpenRouter / AWS actually sees (JSON Schema tools, flattened message
 * content, etc.) — drastically more useful for debugging 400s like
 * "Invalid schema for function 'write'" than logging the pre-serialized
 * internal `Request`.
 */
const openaiChatHooks = {
  beforeRequest: (_req: unknown, params: unknown) => {
    logger.log('── OPENAI chat beforeRequest ──');
    logger.logObject('params', params);
  },
  afterRequest: (_req: unknown, _params: unknown, _response: unknown, responseComplete: unknown) => {
    logger.log('── OPENAI chat afterRequest ──');
    logger.logObject('response', responseComplete);
  },
  onError: (_req: unknown, params: unknown, error: unknown) => {
    logger.log('── OPENAI chat onError ──');
    logger.logObject('params', params);
    logger.logObject('error', error);
  },
};

const openrouterChatHooks = {
  beforeRequest: (_req: unknown, params: unknown) => {
    logger.log('── OPENROUTER chat beforeRequest ──');
    logger.logObject('params', params);
  },
  afterRequest: (_req: unknown, _params: unknown, _response: unknown, responseComplete: unknown) => {
    logger.log('── OPENROUTER chat afterRequest ──');
    logger.logObject('response', responseComplete);
  },
  onError: (_req: unknown, params: unknown, error: unknown) => {
    logger.log('── OPENROUTER chat onError ──');
    logger.logObject('params', params);
    logger.logObject('error', error);
  },
};

const awsChatHooks = {
  beforeRequest: (_req: unknown, params: unknown) => {
    logger.log('── AWS chat beforeRequest ──');
    logger.logObject('params', params);
  },
  afterRequest: (_req: unknown, _params: unknown, _response: unknown, responseComplete: unknown) => {
    logger.log('── AWS chat afterRequest ──');
    logger.logObject('response', responseComplete);
  },
};

async function buildProviders(): Promise<{ providers: Record<string, Provider>; enabled: string[] }> {
  const enabled: string[] = [];
  const skipped: string[] = [];
  const providers: Record<string, Provider> = {};

  if (process.env['OPENAI_API_KEY']) {
    providers.openai = new OpenAIProvider({
      apiKey: process.env['OPENAI_API_KEY']!,
      hooks: { chat: openaiChatHooks },
    });
    enabled.push('openai');
  } else {
    skipped.push('openai (OPENAI_API_KEY unset)');
  }

  if (process.env['OPENROUTER_API_KEY']) {
    providers.openrouter = new OpenRouterProvider({
      apiKey: process.env['OPENROUTER_API_KEY']!,
      hooks: { chat: openrouterChatHooks },
    });
    enabled.push('openrouter');
  } else {
    skipped.push('openrouter (OPENROUTER_API_KEY unset)');
  }

  // AWS Bedrock: credentials can come from env vars, `aws sso login`, IAM
  // roles, shared credentials file, container metadata, etc. Rather than
  // checking a single env var, we probe via `checkHealth` which issues a
  // harmless `ListFoundationModels` call — if that succeeds the SDK's
  // credential chain resolved something valid.
  const awsProvider = new AWSBedrockProvider({
    region: process.env['AWS_REGION'] ?? 'us-east-1',
    hooks: { chat: awsChatHooks },
  });
  try {
    const ok = await awsProvider.checkHealth();
    if (ok) {
      providers.aws = awsProvider;
      enabled.push('aws');
    } else {
      skipped.push('aws (credential chain yielded no access — try `aws sso login`)');
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    skipped.push(`aws (health check threw: ${msg})`);
  }

  if (enabled.length === 0) {
    throw new Error(
      'No AI provider available. Set OPENAI_API_KEY, OPENROUTER_API_KEY, or configure ' +
      'AWS credentials (env vars, `aws sso login`, IAM role, ~/.aws/credentials, etc.).',
    );
  }

  const tavily = process.env['TAVILY_API_KEY'] ? ' + web_search (tavily)' : '';
  console.error(`ginny: providers enabled → ${enabled.join(', ')}${tavily}`);
  for (const s of skipped) console.error(`       skipped → ${s}`);

  return { providers, enabled };
}

export const { registry, engine } = bootstrap();
export const store = createStore(process.cwd());
export const features = { webSearch: !!process.env['TAVILY_API_KEY'] };

const sessionLoadedTypes = new Set<string>();
const sessionLoadedFns = new Set<string>();
const sessionLoadedVars = new Map<string, { type: any; parsed: any; docs?: string }>();

const modelIdOverride = process.env['GIN_MODEL'];
const providerOverride = process.env['GIN_PROVIDER'];

const { providers: enabledProviders, enabled: enabledProviderNames } = await buildProviders();

// Model selection picks the top-scored model across every entry in `models`.
// If we don't restrict `providers.allow` to the set of providers we actually
// have registered, the selector can pick a top-scored openrouter/replicate/etc.
// model we can't dispatch to — and bail with "No compatible model found".
// Allowlist the enabled providers so scoring stays inside what we can serve.
const providersMeta: Record<string, unknown> = { allow: enabledProviderNames };
if (providerOverride) providersMeta.preferred = [providerOverride];

export const ai = AI.with<Ctx, Meta>()
  .providers(enabledProviders)
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
      providers: providersMeta,
    } as any,
    models,
  })
  .withHooks({
    // AI-level selection hook — captures which model was picked for each
    // request. The actual wire payload is logged by provider-level hooks
    // above (where `params` is the real OpenAI / AWS body — not the
    // pre-serialized internal Request with Zod class instances in it).
    onModelSelected: async (_ctx, _request, selected) => {
      logger.log(`── model selected: ${selected?.model?.id ?? 'unknown'} (provider=${selected?.model?.provider ?? '?'}) ──`);
      return selected;
    },
  });

// Graceful close on exit so tail of the log isn't truncated.
process.on('beforeExit', () => logger.close());
process.on('SIGINT', () => { logger.close(); process.exit(0); });
process.on('SIGTERM', () => { logger.close(); process.exit(0); });

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
