/**
 * Live reasoning cases
 *
 * Each target names a reasoning model and what its reasoning carries; the
 * cases check that reasoning is captured the same streamed and not, that
 * effort, budget and summary options reach the API (clamped to what the
 * model accepts), and that reasoning replays across a tool call through the
 * Prompt loop and through hand-built messages, including to another model.
 */

import { describe, expect } from '@jest/globals';
import { AI } from '@aeye/ai';
import { getResponseFromChunks, type Chunk, type Message, type Reason, type Reasoning, type ReasoningDetail, type ReasoningEffort, type Request, type Response } from '@aeye/core';
import { models } from '@aeye/models';
import { OpenAIProvider } from '@aeye/openai';
import { OpenRouterProvider } from '@aeye/openrouter';
import { z } from 'zod';
import { firstChunk, liveCase, type LiveSource } from './live';
import { getAPIKey, hasAPIKey } from './setup';

/**
 * What a target's reasoning carries on the response.
 */
export type Carry = 'content' | 'text' | 'summary' | 'signature' | 'data';

/**
 * A reasoning model under test.
 */
export interface ReasoningTarget {
  provider: 'openai' | 'openrouter';
  model: string;
  // The API OpenAI chat requests use
  api?: 'auto' | 'chat' | 'responses';
  // The reasoning capture and replay ask for
  reason: Reason;
  // Efforts sent on their own, accepted or not
  efforts?: ReasoningEffort[];
  // A reasoning token budget to send
  budget?: number;
  // Summary modes to send (OpenAI Responses)
  summaries?: Array<NonNullable<Reason['summary']>>;
  // What the captured reasoning must carry; capture is skipped when empty
  carries: Carry[];
  // Whether a garbled replay is rejected, proving the replay is checked
  verified?: boolean;
}

/**
 * The reasoning parts of a request body as sent.
 */
interface SentBody {
  reasoning_effort?: ReasoningEffort;
  reasoning?: { enabled?: boolean; effort?: ReasoningEffort; max_tokens?: number; summary?: string };
  messages?: Array<{ role: string; tool_calls?: object[]; reasoning?: string; reasoning_details?: ReasoningDetail[] }>;
  input?: Array<{ type?: string; encrypted_content?: string }>;
}

// Every request body sent, in order; cases run one at a time per file
const sent: SentBody[] = [];

/**
 * The last request body sent.
 */
function lastSent(): SentBody {
  return sent[sent.length - 1];
}

/**
 * Records each request body as sent, copied so later changes to the
 * conversation don't show.
 */
function record(request: Request, params: object): void {
  sent.push(JSON.parse(JSON.stringify(params)));
}

/**
 * An AI over OpenAI (through the given API) and OpenRouter, with the
 * registry's model data and every request body recorded.
 */
function createAI(api: ReasoningTarget['api'] = 'auto') {
  const hooks = { chat: { beforeRequest: record }, responses: { beforeRequest: record } };
  return AI.with()
    .providers({
      openai: new OpenAIProvider({ apiKey: getAPIKey('openai'), api, hooks }),
      openrouter: new OpenRouterProvider({ apiKey: getAPIKey('openrouter'), hooks }),
    })
    .create({ models });
}

/**
 * A target's model and the AI that reaches it. The model goes by its
 * registry key, since OpenRouter ids such as `openai/gpt-5.4-mini` are also
 * the keys of OpenAI's own models.
 */
function connect(target: ReasoningTarget) {
  return { ai: createAI(target.api), metadata: { model: `${target.provider}/${target.model}` } };
}

/**
 * The packages a target's cases exercise.
 */
function sourcesOf(...targets: ReasoningTarget[]): LiveSource[] {
  return targets.some(target => target.provider === 'openrouter') ? ['core', 'ai', 'openai', 'openrouter', 'models'] : ['core', 'ai', 'openai', 'models'];
}

/**
 * How a target is named in cases.
 */
function label(target: ReasoningTarget): string {
  return `${target.provider} ${target.model}${target.provider === 'openai' ? ` ${target.api ?? 'auto'}` : ''}`;
}

/**
 * Each reasoning detail's kind and which of the given parts it carries, to
 * compare reasoning whose text differs between runs. Parts a model only
 * sometimes sends (OpenAI summaries) are left out.
 */
function shapeOf(reasoning: Reasoning | undefined, parts: Carry[]) {
  return (reasoning?.details ?? []).map(detail => ({
    type: detail.type,
    format: detail.format,
    id: !!detail.id,
    parts: parts.filter(part => part !== 'content' && detail[part]),
  }));
}

/**
 * Whether reasoning carries a part.
 */
function carries(reasoning: Reasoning | undefined, carry: Carry): boolean {
  return carry === 'content' ? !!reasoning?.content : !!reasoning?.details?.some(detail => detail[carry]);
}

const QUESTION: Message = { role: 'user', content: 'What is the sum of the digits of 2^20? Reply with only the number.' };

const DICE_ROLL = '7';

// A tool whose answer the model can't guess, so it has to call it
const DICE_TOOL = { name: 'roll_dice', description: 'Rolls the house dice and returns the total.' };

// Worked out from the task, so the model reasons before the call
const DICE_COUNT = z.object({ count: z.number().describe('How many dice to roll') });

const DICE: Request['tools'] = [{ ...DICE_TOOL, parameters: DICE_COUNT }];

const DICE_TASK: Message = { role: 'user', content: 'Roll as many dice as there are vowels in the word "reasoning" with the roll_dice tool, then reply with only the total plus 10.' };

/**
 * The first turn of a dice exchange: the model reasons and calls the tool.
 * The tool isn't forced, since Anthropic doesn't think on a forced call.
 */
async function diceCall(target: ReasoningTarget): Promise<Response> {
  const { ai, metadata } = connect(target);
  const response = await ai.chat.get({ messages: [DICE_TASK], tools: DICE, reason: target.reason }, { metadata });
  expect(response.toolCalls?.length).toBeGreaterThan(0);
  if (target.carries.length) {
    expect(response.reasoning).toBeDefined();
  }
  return response;
}

/**
 * A dice exchange continued after the tool call, with the call's turn as
 * given, so the replay of its reasoning is what's tested.
 */
function diceReply(call: Response, reasoning: Reasoning | undefined, reason: Reason): Request {
  return {
    messages: [
      DICE_TASK,
      { role: 'assistant', content: call.content, toolCalls: call.toolCalls, reasoning },
      ...(call.toolCalls ?? []).map((tc): Message => ({ role: 'tool', toolCallId: tc.id, content: DICE_ROLL })),
    ],
    tools: DICE,
    reason,
  };
}

/**
 * Reasoning with every signature and encrypted payload corrupted.
 */
function garbled(reasoning: Reasoning | undefined): Reasoning | undefined {
  const garble = (value: string | undefined) => value && `x${value.slice(1, -8)}AAAAAAAA`;
  return reasoning && {
    ...reasoning,
    details: reasoning.details?.map(detail => ({ ...detail, signature: garble(detail.signature), data: garble(detail.data) })),
  };
}

/**
 * Expects the last body sent to replay the reasoning in the form its API
 * takes: encrypted items before the calls on Responses, and the details on
 * the tool call's own message on OpenRouter.
 */
function expectReplayed(reasoning: Reasoning): void {
  const body = lastSent();
  if (body.input) {
    const items = body.input.flatMap(item => item.type === 'reasoning' ? [item.encrypted_content] : []);
    expect(items).toEqual(expect.arrayContaining(reasoning.details?.flatMap(detail => detail.data ? [detail.data] : []) ?? []));
  } else {
    const call = body.messages?.find(message => message.role === 'assistant' && message.tool_calls?.length);
    expect(call?.reasoning_details).toEqual(reasoning.details);
    expect(call?.reasoning).toEqual(reasoning.content ?? undefined);
  }
}

/**
 * Registers the live cases for one reasoning model.
 */
function reasoningCases(target: ReasoningTarget): void {
  const { reason } = target;
  const { ai, metadata } = connect(target);
  const name = (scenario: string) => `reasoning ${label(target)} ${scenario}`;
  const key = (inputs: object) => ({ sources: sourcesOf(target), inputs: { target, ...inputs } });
  const accepted = models.find(model => model.provider === target.provider && model.id === target.model)?.reasoningEfforts;

  if (target.carries.length) {
    liveCase(name('capture'), key({ scenario: 'capture' }), async () => {
      const request: Request = { messages: [QUESTION], reason };
      const whole = await ai.chat.get(request, { metadata });
      const chunks: Chunk[] = [];
      for await (const chunk of ai.chat.stream(request, { metadata })) {
        chunks.push(chunk);
      }
      const stream = getResponseFromChunks(chunks);
      for (const carry of target.carries) {
        expect({ carry, whole: carries(whole.reasoning, carry), streamed: carries(stream.reasoning, carry) }).toEqual({ carry, whole: true, streamed: true });
      }
      expect(shapeOf(stream.reasoning, target.carries)).toEqual(shapeOf(whole.reasoning, target.carries));
      expect(whole.content).toContain('31');
      expect(stream.content).toContain('31');
    }, 120_000);
  }

  for (const effort of target.efforts ?? []) {
    liveCase(name(`effort ${effort}`), key({ effort, accepted }), async () => {
      const chunk = await firstChunk((signal) => ai.chat.stream({ messages: [QUESTION], reason: { effort } }, { signal, metadata }));
      expect(chunk).toBeDefined();
      const body = lastSent();
      const sentEffort = body.reasoning_effort ?? body.reasoning?.effort;
      expect(accepted ?? [effort]).toContain(sentEffort);
      // Reasoning asked for is never turned off, and reasoning turned off
      // doesn't come back
      if (effort !== 'none') {
        expect(sentEffort).not.toBe('none');
      } else if (sentEffort === 'none') {
        expect(chunk?.reasoning).toBeUndefined();
      }
      if (target.provider === 'openrouter') {
        expect(body).toMatchObject({ reasoning: { enabled: true, effort: sentEffort } });
        expect(body.reasoning?.max_tokens).toBeUndefined();
        expect(body.reasoning_effort).toBeUndefined();
      }
    });
  }

  if (target.budget) {
    const budget = target.budget;
    liveCase(name(`budget ${budget}`), key({ budget }), async () => {
      const chunk = await firstChunk((signal) => ai.chat.stream({ messages: [QUESTION], reason: { maxTokens: budget } }, { signal, metadata }));
      expect(chunk).toBeDefined();
      expect(lastSent().reasoning).toEqual({ enabled: true, max_tokens: budget });
    });
  }

  for (const summary of target.summaries ?? []) {
    liveCase(name(`summary ${summary}`), key({ summary }), async () => {
      const chunk = await firstChunk((signal) => ai.chat.stream({ messages: [QUESTION], reason: { effort: 'low', summary } }, { signal, metadata }));
      expect(chunk?.reasoning?.content).toBeTruthy();
      expect(lastSent().reasoning?.summary).toBe(summary);
    });
  }

  liveCase(name('replay chat'), key({ scenario: 'replay chat' }), async () => {
    const call = await diceCall(target);
    const reply = await ai.chat.get(diceReply(call, call.reasoning, reason), { metadata });
    if (call.reasoning) {
      expectReplayed(call.reasoning);
    }
    expect(reply.content).toContain('17');
  }, 120_000);

  liveCase(name('replay prompt'), key({ scenario: 'replay prompt' }), async () => {
    const roll = ai.tool({ ...DICE_TOOL, instructions: 'Use roll_dice to roll the house dice.', schema: DICE_COUNT, call: () => DICE_ROLL });
    const prompt = ai.prompt({ name: 'dice', description: 'Rolls dice', content: 'You roll dice for the user.', tools: [roll], config: { reason }, metadata });
    const messages: Message[] = [];
    let output: string | undefined;
    for await (const event of prompt.get('stream', {}, { messages: [DICE_TASK] })) {
      if (event.type === 'message') {
        messages.push(event.message);
      }
      if (event.type === 'complete') {
        output = event.output;
      }
    }
    const call = messages.find(message => message.toolCalls?.length);
    expect(call).toBeDefined();
    if (target.carries.length) {
      expect(call?.reasoning).toBeDefined();
    }
    if (call?.reasoning) {
      expectReplayed(call.reasoning);
    }
    expect(output).toContain('17');
  }, 120_000);

  if (target.verified) {
    liveCase(name('replay garbled rejected'), key({ scenario: 'replay garbled' }), async () => {
      const call = await diceCall(target);
      await expect(ai.chat.get(diceReply(call, garbled(call.reasoning), reason), { metadata })).rejects.toThrow();
    }, 120_000);
  }
}

const describeLive = hasAPIKey('openai') && hasAPIKey('openrouter') ? describe : describe.skip;

/**
 * Describes the live cases of reasoning models, when both API keys are present.
 */
export function describeReasoning(name: string, targets: ReasoningTarget[]): void {
  describeLive(name, () => targets.forEach(reasoningCases));
}

/**
 * Describes conversations a model continues after another model's tool
 * call, its reasoning included as it came.
 */
export function describeCrossReplay(name: string, pairs: Array<[ReasoningTarget, ReasoningTarget]>): void {
  describeLive(name, () => {
    for (const [from, to] of pairs) {
      liveCase(`reasoning cross ${label(from)} to ${label(to)}`, { sources: sourcesOf(from, to), inputs: { from, to } }, async () => {
        const call = await diceCall(from);
        const { ai, metadata } = connect(to);
        const reply = await ai.chat.get(diceReply(call, call.reasoning, to.reason), { metadata });
        expect(reply.content).toContain('17');
      }, 120_000);
    }
  });
}
