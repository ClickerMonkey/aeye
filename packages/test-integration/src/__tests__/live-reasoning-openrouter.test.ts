/**
 * Live reasoning: models through OpenRouter, which relays each upstream's
 * reasoning as `reasoning` text and `reasoning_details` (thinking signatures,
 * Gemini thought signatures, encrypted OpenAI items) and takes them back on
 * assistant messages.
 */

import { describeReasoning, type ReasoningTarget } from '../reasoning';

const TARGETS: ReasoningTarget[] = [
  // Anthropic: a thinking budget, then adaptive thinking by effort; both
  // check thinking signatures
  { provider: 'openrouter', model: 'anthropic/claude-haiku-4.5', reason: { maxTokens: 1024 }, budget: 1024, efforts: ['low'], carries: ['content', 'text', 'signature'], verified: true },
  { provider: 'openrouter', model: 'anthropic/claude-haiku-5.5', reason: { effort: 'high' }, efforts: ['none', 'minimal', 'max'], carries: ['content', 'text', 'signature'], verified: true },
  // Gemini: a thinking budget (readable thoughts), then thinking levels
  // (thought signatures, which OpenRouter doesn't hold Gemini to)
  { provider: 'openrouter', model: 'google/gemini-2.5-flash', reason: { maxTokens: 512 }, budget: 512, carries: ['content', 'text'] },
  { provider: 'openrouter', model: 'google/gemini-3-flash-preview', reason: { effort: 'low' }, efforts: ['minimal', 'none', 'xhigh'], carries: ['data'] },
  { provider: 'openrouter', model: 'x-ai/grok-4.3', reason: { effort: 'low' }, efforts: ['none', 'minimal'], carries: ['content'] },
  // DeepSeek V4 takes none, high and xhigh: low stays on as high
  { provider: 'openrouter', model: 'deepseek/deepseek-v4-flash', reason: { effort: 'high' }, efforts: ['low', 'none'], carries: ['content', 'text'] },
  { provider: 'openrouter', model: 'qwen/qwen3-235b-a22b-thinking-2507', reason: { effort: 'low' }, carries: ['content', 'text'] },
  { provider: 'openrouter', model: 'openai/gpt-oss-20b', reason: { effort: 'low' }, efforts: ['none', 'xhigh'], carries: ['content', 'text'] },
  // OpenAI relayed: encrypted reasoning items
  { provider: 'openrouter', model: 'openai/gpt-5.4-mini', reason: { effort: 'low', summary: 'auto' }, efforts: ['minimal'], carries: ['data'] },
  { provider: 'openrouter', model: 'moonshotai/kimi-k2.6', reason: { effort: 'low' }, carries: ['content', 'text'] },
  { provider: 'openrouter', model: 'z-ai/glm-4.7-flash', reason: { effort: 'low' }, carries: ['content', 'text'] },
  { provider: 'openrouter', model: 'minimax/minimax-m2.5', reason: { effort: 'low' }, carries: ['content', 'text'] },
];

describeReasoning('live reasoning openrouter', TARGETS);
