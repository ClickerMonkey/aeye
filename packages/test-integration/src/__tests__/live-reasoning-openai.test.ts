/**
 * Live reasoning: OpenAI models directly, through Chat Completions (which
 * returns no reasoning, only takes the effort) and Responses (encrypted
 * reasoning items and summaries, replayed with `store: false`).
 */

import { describeReasoning, type ReasoningTarget } from '../reasoning';

const TARGETS: ReasoningTarget[] = [
  // gpt-5 generation: minimal is the lowest effort, none is unsupported
  { provider: 'openai', model: 'gpt-5-nano', api: 'chat', reason: { effort: 'low' }, efforts: ['minimal', 'low', 'none'], carries: [] },
  { provider: 'openai', model: 'gpt-5-nano', api: 'responses', reason: { effort: 'low', summary: 'auto' }, summaries: ['concise', 'detailed'], carries: ['content', 'summary', 'data'], verified: true },
  // gpt-5.4 generation: none is the lowest effort and the only one Chat
  // Completions takes with tools, so reasoning with tools goes to Responses
  { provider: 'openai', model: 'gpt-5.4-nano', api: 'chat', reason: { effort: 'none' }, efforts: ['none', 'minimal', 'low', 'high', 'max'], carries: [] },
  { provider: 'openai', model: 'gpt-5.4-nano', api: 'auto', reason: { effort: 'low' }, carries: [] },
  { provider: 'openai', model: 'gpt-5.4-nano', api: 'responses', reason: { effort: 'low', summary: 'auto' }, efforts: ['none', 'xhigh'], carries: ['content', 'summary', 'data'], verified: true },
  // o-series: low to high only, and summaries only sometimes
  { provider: 'openai', model: 'o3', api: 'responses', reason: { effort: 'medium', summary: 'auto' }, efforts: ['low', 'none'], carries: ['data'], verified: true },
  // The current generation, reasoning off and at its most
  { provider: 'openai', model: 'gpt-5.6-luna', api: 'responses', reason: { effort: 'none' }, efforts: ['none', 'max'], carries: [] },
];

describeReasoning('live reasoning openai', TARGETS);
