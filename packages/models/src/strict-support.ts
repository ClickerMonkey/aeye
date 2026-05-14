/**
 * Curated strict-mode support table.
 *
 * HUMAN-CURATED. NOT auto-generated. Edit by hand as new models ship or
 * provider docs change. The auto-generated model files (`openai.ts`,
 * `aws.ts`, etc.) are scraped from provider listings and don't track
 * strict-mode capability on their own — strict support is a separate axis
 * sourced here.
 *
 * Splat into your `AI` config:
 *
 * ```ts
 * import { models, strictSupport } from '@aeye/models';
 *
 * const ai = new AI({
 *   providers: { ... },
 *   models,
 *   modelOverrides: [...strictSupport, ...myOwnOverrides],
 * });
 * ```
 *
 * Setting `strictFormat: '<family>'` does two things:
 * 1. Auto-derives the `'toolsStrict'` capability for selection.
 * 2. Pins the JSON-Schema dialect that providers will emit.
 *
 * The dialect could often be left implicit and resolved via
 * `resolveStrictFormat(model)`'s fallback chain (provider name → `[family]/`
 * id prefix), but we set it explicitly here so the curated table is
 * self-documenting and so the provider doesn't have to recompute it for
 * every request.
 *
 * `strictFormat: 'none'` is a hard opt-out — used when an upstream source
 * (a scraper, a future provider plug-in) has incorrectly marked a model
 * strict-capable.
 *
 * References:
 * - https://platform.openai.com/docs/guides/structured-outputs
 * - https://platform.claude.com/docs/en/agents-and-tools/tool-use/strict-tool-use
 * - https://platform.claude.com/docs/en/build-with-claude/structured-outputs
 * - https://ai.google.dev/gemini-api/docs/structured-output
 */

import type { ModelOverride } from '@aeye/ai';

export const strictSupport: ModelOverride[] = [
  // ---------------------------------------------------------------------------
  // OpenAI direct — gpt-4o, gpt-4.1, gpt-5, o-series support strict tools +
  // outputs. gpt-realtime supports function calling (no documented support
  // for structured output, gated by the `'structured'` capability — which
  // the scraper doesn't add for realtime models). Legacy gpt-4 / gpt-3.5
  // are not listed: they don't get the cap, so they stay lenient.
  // ---------------------------------------------------------------------------
  {
    provider: 'openai',
    modelPattern: /^gpt-4o(\b|[-_])/,
    overrides: { strictFormat: 'openai' },
  },
  {
    provider: 'openai',
    modelPattern: /^gpt-4\.1(\b|[-_])/,
    overrides: { strictFormat: 'openai' },
  },
  {
    provider: 'openai',
    modelPattern: /^gpt-5(\b|[-_])/,
    overrides: { strictFormat: 'openai' },
  },
  {
    provider: 'openai',
    modelPattern: /^o[1-9](-mini|-preview|-pro)?(\b|[-_])/,
    overrides: { strictFormat: 'openai' },
  },
  {
    provider: 'openai',
    modelPattern: /^gpt-realtime/,
    overrides: { strictFormat: 'openai' },
  },

  // ---------------------------------------------------------------------------
  // AWS Bedrock — Anthropic-family Claude 4.5+ only. provider='aws' doesn't
  // resolve and the id uses '.' separators rather than '/', so the dialect
  // must be set explicitly here. Earlier Claude versions (3.5/3.7) don't
  // support strict per Anthropic docs and are deliberately not listed.
  // ---------------------------------------------------------------------------
  {
    provider: 'aws',
    modelPattern: /anthropic\.claude-(opus-4|sonnet-4|haiku-4)/,
    overrides: { strictFormat: 'anthropic' },
  },

  // ---------------------------------------------------------------------------
  // OpenRouter — keyed off the `[family]/...` id prefix. Listed here both
  // to add the `'toolsStrict'` capability (which the OpenRouter scraper
  // doesn't currently set) and to pin the dialect explicitly.
  // ---------------------------------------------------------------------------
  {
    provider: 'openrouter',
    modelPattern: /^openai\/(gpt-4o|gpt-4\.1|gpt-5|o[1-9])/,
    overrides: { strictFormat: 'openai' },
  },
  {
    provider: 'openrouter',
    modelPattern: /^anthropic\/claude-(opus-4|sonnet-4|haiku-4|4)/,
    overrides: { strictFormat: 'anthropic' },
  },
  {
    provider: 'openrouter',
    modelPattern: /^google\/gemini-(2\.0|2\.5|3|3\.1)/,
    overrides: { strictFormat: 'google' },
  },
];
