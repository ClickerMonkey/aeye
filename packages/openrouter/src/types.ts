import type { BatchStatus, ModelTokenizer } from '@aeye/ai';
import type { BatchOutputLine } from '@aeye/openai';
import type { ReasoningDetail, ReasoningEffort } from '@aeye/core';
import OpenAI from "openai";

/**
* OpenRouter input modalities
*/
export type OpenRouterInput = 'audio' | 'file' | 'image' | 'text' | 'video';

/**
* OpenRouter output modalities
*/
export type OpenRouterOutput = 'audio' | 'decisions' | 'embeddings' | 'image' | 'rerank' | 'speech' | 'text' | 'transcription' | 'video';

/**
* OpenRouter tokenizer types
*/
export type OpenRouterTokenize = ModelTokenizer;

/**
* OpenRouter supported parameters
*/
export type OpenRouterSupportedParameter =
  'frequency_penalty' |
  'include_reasoning' |
  'logit_bias' |
  'logprobs' |
  'max_completion_tokens' |
  'max_tokens' |
  'min_p' |
  'parallel_tool_calls' |
  'prediction' |
  'presence_penalty' |
  'reasoning' |
  'reasoning_effort' |
  'repetition_penalty' |
  'response_format' |
  'seed' |
  'stop' |
  'structured_outputs' |
  'temperature' |
  'tool_choice' |
  'tools' |
  'top_a' |
  'top_k' |
  'top_logprobs' |
  'top_p' |
  'verbosity' |
  'web_search_options';

/**
* OpenRouter model response from API. Prices are dollar strings per token,
* except `request` (per request), `image` (per input image), and
* `web_search` (per search).
*/
export interface OpenRouterModel {
  id: string;
  canonical_slug: string;
  hugging_face_id: string | null;
  name: string;
  created: number;
  description?: string;
  context_length: number;
  architecture: {
    modality: string;
    input_modalities: OpenRouterInput[];
    output_modalities: OpenRouterOutput[];
    tokenizer: OpenRouterTokenize;
    instruct_type: string | null;
  };
  pricing: {
    prompt?: string;
    completion?: string;
    request?: string;
    image?: string;
    image_token?: string;
    image_output?: string;
    audio?: string;
    audio_output?: string;
    web_search?: string;
    internal_reasoning?: string;
    input_cache_read?: string;
    input_cache_write?: string;
    input_cache_write_1h?: string;
  };
  top_provider: {
    context_length: number | null;
    max_completion_tokens: number | null;
    is_moderated: boolean;
  };
  supported_parameters: OpenRouterSupportedParameter[];
  default_parameters: {
    frequency_penalty?: number | null;
    temperature?: number | null;
    top_p?: number | null;
  } | null;
  // Reasoning controls the model accepts
  reasoning?: {
    mandatory?: boolean;
    default_enabled?: boolean;
    supported_efforts?: ReasoningEffort[];
    default_effort?: ReasoningEffort;
  } | null;
  // Voices for speech models
  supported_voices?: string[] | null;
  // ISO date the model stops being served
  expiration_date?: string | null;
  knowledge_cutoff?: string | null;
}

/**
 * Percentiles of a performance measure.
 */
export interface OpenRouterPercentiles {
  p50: number;
  p75: number;
  p90: number;
  p99: number;
}

/**
* One provider's endpoint for a model, as `/models/{id}/endpoints` and
* `/endpoints/zdr` report it.
*/
export interface OpenRouterEndpoint {
  name: string;
  model_name: string;
  context_length: number;
  pricing: {
    prompt?: string;
    completion?: string;
    request?: string;
    image?: string;
  };
  provider_name: string;
  tag: string;
  quantization: string | null;
  max_completion_tokens: number | null;
  max_prompt_tokens: number | null;
  supported_parameters: OpenRouterSupportedParameter[];
  status: number;
  uptime_last_30m: number | null;
  // Latency to first token in milliseconds, and throughput in tokens per second
  latency_last_30m?: OpenRouterPercentiles | null;
  throughput_last_30m?: OpenRouterPercentiles | null;
  supports_implicit_caching: boolean;
}

/**
 * @deprecated Use OpenRouterEndpoint.
 */
export type ZDRModel = OpenRouterEndpoint;

/**
 * Live performance of a model across the providers serving it.
 */
export interface OpenRouterMetrics {
  // Best median latency to first token, in milliseconds
  latency?: number;
  // Best median throughput, in tokens per second
  throughput?: number;
  // Best uptime over the last 30 minutes, as a percentage
  uptime?: number;
}

/**
 * Model quantizations OpenRouter can route by.
 */
export type OpenRouterQuantization = 'int4' | 'int8' | 'fp4' | 'mxfp4' | 'nvfp4' | 'fp6' | 'fp8' | 'mxfp8' | 'fp16' | 'bf16' | 'fp32' | 'unknown';

/**
 * What OpenRouter sorts providers by. `exacto` prefers providers with the
 * best tool-calling accuracy.
 */
export type OpenRouterSort = 'price' | 'throughput' | 'latency' | 'exacto';

/**
 * Provider routing preferences, as sent on the wire.
 */
export interface OpenRouterProviderPreferences {
  order?: string[];
  allow_fallbacks?: boolean;
  require_parameters?: boolean;
  data_collection?: 'deny' | 'allow';
  zdr?: boolean;
  enforce_distillable_text?: boolean;
  only?: string[];
  ignore?: string[];
  quantizations?: OpenRouterQuantization[];
  // `partition: 'none'` sorts endpoints across all fallback models together
  sort?: OpenRouterSort | { by: OpenRouterSort; partition?: 'model' | 'none' };
  // Preferred floor on throughput (tokens/second) and ceiling on latency (seconds), at the median
  preferred_min_throughput?: number;
  preferred_max_latency?: number;
  max_price?: {
    prompt?: number; // dollars per million tokens
    completion?: number; // dollars per million tokens
    image?: number; // dollars per image
    audio?: number; // dollars per million audio tokens
    request?: number; // dollars per request
  };
}

/**
 * Plugins that change how OpenRouter handles a request.
 *
 * - `file-parser`: how PDFs are read, for models without native PDF input
 * - `response-healing`: repairs malformed JSON in non-streamed responses
 * - `context-compression`: drops the middle of prompts that overflow the
 *   context window (replaces the `middle-out` transform)
 */
export type OpenRouterPlugin =
  | { id: 'file-parser'; pdf?: { engine?: string } }
  | { id: 'response-healing' }
  | { id: 'context-compression'; engine?: 'middle-out' };

/**
 * A tool OpenRouter runs itself, between model turns.
 */
export interface OpenRouterServerTool {
  type: `openrouter:${string}`;
  parameters?: {
    max_results?: number;
    allowed_domains?: string[];
    excluded_domains?: string[];
  };
}

/**
* OpenRouter reasoning information
*/
export type OpenRouterReasoning = {
  reasoning?: string;
  reasoning_details?: ReasoningDetail[];
};

/**
 * A content part with an Anthropic-style cache marker, which OpenRouter
 * translates for every provider with explicit prompt caching.
 */
export type OpenRouterContentPart = OpenAI.Chat.Completions.ChatCompletionContentPart & {
  cache_control?: { type: 'ephemeral' };
};

/**
* OpenRouter chat request with extensions
*/
export type OpenRouterChatRequest = Omit<OpenAI.Chat.ChatCompletionCreateParams, 'tools' | 'modalities'> & {
  stream?: boolean | null;
  tools?: Array<OpenAI.Chat.ChatCompletionTool | OpenRouterServerTool>;
  modalities?: Array<'text' | 'image' | 'audio'> | null;
  reasoning?: {
    enabled?: boolean;
    effort?: ReasoningEffort;
    max_tokens?: number;
    exclude?: boolean;
    summary?: 'auto' | 'concise' | 'detailed';
    mode?: 'pro';
    context?: 'auto' | 'all_turns' | 'current_turn';
  };
  provider?: OpenRouterProviderPreferences;
  plugins?: OpenRouterPlugin[];
  // Image output settings for image-generating chat models
  image_config?: {
    aspect_ratio?: string;
  };
  user?: string;
  // Models to fall back to, in order, when the first fails
  models?: string[];
};

/**
 * An image a chat model produced, as a data URL.
 */
export interface OpenRouterImage {
  type: 'image_url';
  image_url: { url: string };
}

/**
* OpenRouter's extended usage information. With BYOK, `cost` is only
* OpenRouter's fee and the provider bills `upstream_inference_cost`.
*/
export type OpenRouterUsage = OpenAI.CompletionUsage & {
  cost?: number;
  is_byok?: boolean;
  cost_details?: {
    upstream_inference_cost?: number | null;
  };
  // Server tool calls made, e.g. `web_search_requests`
  server_tool_use_details?: Record<string, number>;
}

/**
* OpenRouter chunk with extended usage info
*/
export type OpenRouterChatChunk =
  OpenAI.Chat.Completions.ChatCompletionChunk &
  {
    usage?: OpenRouterUsage | null;
    choices: Array<OpenAI.Chat.Completions.ChatCompletionChunk.Choice & {
      delta: OpenAI.Chat.Completions.ChatCompletionChunk.Choice.Delta & OpenRouterReasoning & { images?: OpenRouterImage[] };
    }>
  };

/**
 * OpenRouter message parameter with reasoning info
 */
export type OpenRouterRequestMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam & OpenRouterReasoning;

/**
 * OpenRouter message with reasoning info and generated images
 */
export type OpenRouterMessage = OpenAI.Chat.Completions.ChatCompletionMessage & OpenRouterReasoning & {
  images?: OpenRouterImage[];
};

/**
 * OpenRouter choice with reasoning info
 */
export type OpenRouterChoice = OpenAI.ChatCompletion.Choice & {
  native_finish_reason?: string;
  message: OpenRouterMessage;
};

/**
* OpenRouter response with extended usage info
*/
export type OpenRouterChatResponse = OpenAI.Chat.ChatCompletion & {
  choices: OpenRouterChoice[];
  usage?: OpenRouterUsage;
};

/**
 * A batch as OpenRouter reports it. Results arrive inline once it completes.
 */
export interface OpenRouterBatch {
  id: string;
  status: BatchStatus;
  request_counts: { total: number; completed: number; failed: number };
  error: { message: string } | null;
  // Totals for the batch; results carry token counts but no cost
  usage: OpenRouterUsage | null;
  results: BatchOutputLine[] | null;
}

/**
 * Documents by relevance, as OpenRouter's rerank endpoint returns them.
 */
export interface OpenRouterRerank {
  model: string;
  results: Array<{ index: number; relevance_score: number }>;
  usage?: { search_units?: number; cost?: number };
}

/**
 * A question as OpenRouter's decisions endpoint takes it.
 */
export type OpenRouterDecisionQuestion =
  | { type: 'noul'; instructions: string }
  | { type: 'choice'; instructions: string; criteria: Record<string, string> }
  | { type: 'score'; instructions: string; criteria: string[] };

/**
 * An answer as OpenRouter's decisions endpoint returns it. Score
 * probabilities are keyed by level index.
 */
export type OpenRouterDecisionAnswer =
  | { type: 'noul'; noul: number }
  | { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: 'score'; score: number; probabilities: Record<string, number>; confidence: number };

/**
 * A decision as OpenRouter's decisions endpoint returns it.
 */
export interface OpenRouterDecision {
  model: string;
  answers: Record<string, OpenRouterDecisionAnswer>;
  usage: { input_tokens: number; output_tokens: number; cost?: number };
}
