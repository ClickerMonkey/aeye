/**
 * Live reasoning across models: a conversation whose tool call (and its
 * reasoning) came from one model continues on another, which must not be
 * sent that reasoning in a form it rejects.
 */

import { describeCrossReplay, type ReasoningTarget } from '../reasoning';

const CLAUDE: ReasoningTarget = { provider: 'openrouter', model: 'anthropic/claude-haiku-4.5', reason: { maxTokens: 1024 }, carries: ['signature'] };
const GEMINI: ReasoningTarget = { provider: 'openrouter', model: 'google/gemini-3-flash-preview', reason: { effort: 'low' }, carries: ['data'] };
const DEEPSEEK: ReasoningTarget = { provider: 'openrouter', model: 'deepseek/deepseek-v4-flash', reason: { effort: 'high' }, carries: ['text'] };
const RELAYED_GPT: ReasoningTarget = { provider: 'openrouter', model: 'openai/gpt-5.4-mini', reason: { effort: 'low' }, carries: ['data'] };
const GPT: ReasoningTarget = { provider: 'openai', model: 'gpt-5.4-nano', api: 'responses', reason: { effort: 'low' }, carries: ['data'] };
const GPT_5: ReasoningTarget = { provider: 'openai', model: 'gpt-5-nano', api: 'responses', reason: { effort: 'low' }, carries: ['data'] };

describeCrossReplay('live reasoning cross-model', [
  [CLAUDE, GEMINI],
  [GEMINI, CLAUDE],
  [DEEPSEEK, CLAUDE],
  [CLAUDE, GPT],
  [GPT, CLAUDE],
  [GPT, RELAYED_GPT],
  [RELAYED_GPT, GPT],
  [GPT_5, GPT],
]);
