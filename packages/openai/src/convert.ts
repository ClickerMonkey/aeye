/**
 * Conversions from OpenAI wire shapes to @aeye shapes, shared by the Chat
 * Completions, Responses, and media endpoints.
 */

import type { AudioFormat, Citation, Moderation, ModerationResult, ServiceTier, Usage } from '@aeye/core';
import OpenAI from 'openai';

/**
 * Token totals as an endpoint reports them, before splitting into Usage
 * categories. Detail counts are subsets of their total.
 */
export interface TokenCounts {
  input?: number;
  output?: number;
  cached?: number;
  cacheWrite?: number;
  audioInput?: number;
  imageInput?: number;
  reasoning?: number;
  audioOutput?: number;
}

/**
 * Splits token totals into Usage categories so each token is counted once:
 * cache reads and writes, audio, and image input come out of the input
 * total; reasoning and audio output come out of the output total.
 */
export function toUsage(counts: TokenCounts): Usage {
  const nonZero = (n = 0) => n > 0 ? n : undefined;
  const usage: Usage = {};

  const text = {
    input: nonZero((counts.input ?? 0) - (counts.cached ?? 0) - (counts.cacheWrite ?? 0) - (counts.audioInput ?? 0) - (counts.imageInput ?? 0)),
    output: nonZero((counts.output ?? 0) - (counts.reasoning ?? 0) - (counts.audioOutput ?? 0)),
    cached: nonZero(counts.cached),
    cacheWrite: nonZero(counts.cacheWrite),
  };
  if (text.input || text.output || text.cached || text.cacheWrite) {
    usage.text = text;
  }
  if (counts.reasoning) {
    usage.reasoning = { output: counts.reasoning };
  }
  if (counts.audioInput || counts.audioOutput) {
    usage.audio = { input: nonZero(counts.audioInput), output: nonZero(counts.audioOutput) };
  }
  if (counts.imageInput) {
    usage.image = { input: counts.imageInput };
  }
  return usage;
}

/**
 * Usage reported by Chat Completions (and OpenAI-compatible endpoints).
 */
export function chatUsage(usage: OpenAI.CompletionUsage): Usage {
  return toUsage({
    input: usage.prompt_tokens,
    output: usage.completion_tokens,
    cached: usage.prompt_tokens_details?.cached_tokens,
    cacheWrite: usage.prompt_tokens_details?.cache_write_tokens,
    audioInput: usage.prompt_tokens_details?.audio_tokens,
    reasoning: usage.completion_tokens_details?.reasoning_tokens,
    audioOutput: usage.completion_tokens_details?.audio_tokens,
  });
}

/**
 * Usage reported by the Responses API.
 */
export function responsesUsage(usage: OpenAI.Responses.ResponseUsage): Usage {
  return toUsage({
    input: usage.input_tokens,
    output: usage.output_tokens,
    cached: usage.input_tokens_details.cached_tokens,
    cacheWrite: usage.input_tokens_details.cache_write_tokens,
    reasoning: usage.output_tokens_details.reasoning_tokens,
  });
}

/**
 * Usage reported by transcription: tokens for token-billed models, seconds
 * for duration-billed ones (OpenAI-compatible routers may omit `type`).
 */
export function transcriptionUsage(usage: OpenAI.Audio.Transcription.Tokens | OpenAI.Audio.Transcription.Duration): Usage {
  return 'seconds' in usage
    ? { audio: { seconds: usage.seconds } }
    : toUsage({ input: usage.input_tokens, output: usage.output_tokens, audioInput: usage.input_token_details?.audio_tokens });
}

/**
 * Wire tiers to @aeye tiers. `priority` is the older name for `fast`.
 */
const SERVICE_TIERS: Record<string, ServiceTier> = {
  auto: 'auto',
  default: 'default',
  flex: 'flex',
  fast: 'fast',
  priority: 'fast',
  scale: 'scale',
};

/**
 * The tier a response reports it ran on.
 */
export function toServiceTier(tier: string | null | undefined): ServiceTier | undefined {
  return tier ? SERVICE_TIERS[tier] : undefined;
}

/**
 * A URL citation, as both Chat Completions and Responses report them.
 */
export function toCitation(citation: { url: string; title?: string; start_index?: number; end_index?: number }): Citation {
  return { url: citation.url, title: citation.title, start: citation.start_index, end: citation.end_index };
}

/**
 * One side of a moderation verdict, as both Chat Completions and Responses
 * report it: results, or an error when moderation itself failed.
 */
interface WireModerationSide {
  type: string;
  results?: Array<{ flagged: boolean; categories: { [category: string]: boolean } }>;
}

/**
 * Moderation verdicts for the input and the output.
 */
export function toModeration(moderation: { input: WireModerationSide; output: WireModerationSide }): Moderation {
  const side = ({ results }: WireModerationSide): ModerationResult | undefined => results && {
    flagged: results.some(result => result.flagged),
    categories: [...new Set(results.flatMap(result => Object.keys(result.categories).filter(category => result.categories[category])))],
  };
  return { input: side(moderation.input), output: side(moderation.output) };
}

/**
 * The model OpenAI runs moderation with when a request asks for it.
 */
export const MODERATION_MODEL = 'omni-moderation-latest';

/**
 * Chat Completions names 16-bit PCM `pcm16`.
 */
export function toChatAudioFormat(format: AudioFormat): OpenAI.Chat.ChatCompletionAudioParam['format'] {
  return format === 'pcm' ? 'pcm16' : format;
}
