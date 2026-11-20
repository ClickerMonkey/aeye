/**
 * The System One decision protocol (TypeSafe's): its wire shapes and their
 * conversion to and from @aeye decisions, shared by every provider that
 * speaks it (OpenRouter's decisions endpoint, Ollama's `/v1/systemone`).
 *
 * A predicate is a `noul` question, whose answer is the probability it is
 * true; choices and levels are a question's criteria. Score probabilities
 * come back keyed by level index.
 */

import type { DecisionAnswer, DecisionQuestion, DecisionRequest } from '@aeye/ai';
import { type Resource, toBase64 } from '@aeye/core';
import OpenAI from 'openai';

/**
 * A question in System One's shape.
 */
export type SystemOneQuestion =
  | { type: 'noul'; instructions: string }
  | { type: 'choice'; instructions: string; criteria: Record<string, string> }
  | { type: 'score'; instructions: string; criteria: string[] };

/**
 * Parameters of a System One decision request: the evidence as `state`,
 * and questions by name.
 */
export interface SystemOneDecisionParams {
  model: string;
  // Text, or a conversation (sent as JSON)
  state: string | OpenAI.Chat.ChatCompletionMessageParam[];
  questions: Record<string, SystemOneQuestion>;
  // Images shared by every question, as plain base64 (no data URL prefix), in order
  images?: string[];
  // How long the server keeps the model loaded after the call: a duration
  // such as '5m', or seconds (0 unloads it at once, below 0 keeps it loaded)
  keep_alive?: string | number;
}

/**
 * An answer in System One's shape. Score probabilities (and the legend
 * naming each level) are keyed by level index.
 */
export type SystemOneAnswer =
  | { type: 'noul'; noul: number }
  | { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: 'score'; score: number; legend?: Record<string, string>; probabilities: Record<string, number>; confidence: number };

/**
 * A decision in System One's shape.
 */
export interface SystemOneDecision {
  model: string;
  answers: Record<string, SystemOneAnswer>;
  usage: { input_tokens: number; output_tokens: number };
}

/**
 * A question in System One's shape.
 */
export function toSystemOneQuestion(question: DecisionQuestion): SystemOneQuestion {
  const { instructions } = question;
  switch (question.type) {
    case 'predicate':
      return { type: 'noul', instructions };
    case 'choice':
      return { type: 'choice', instructions, criteria: question.choices };
    case 'score':
      return { type: 'score', instructions, criteria: question.levels };
  }
}

/**
 * Questions by name in System One's shape.
 */
export function toSystemOneQuestions(questions: Record<string, DecisionQuestion>): Record<string, SystemOneQuestion> {
  return Object.fromEntries(Object.entries(questions).map(([name, question]) => [name, toSystemOneQuestion(question)]));
}

/**
 * An answer in @aeye's shape, with score probabilities in level order. An
 * answer of a type System One doesn't define counts as a refusal.
 */
export function fromSystemOneAnswer(answer: SystemOneAnswer): DecisionAnswer {
  switch (answer.type) {
    case 'noul':
      return { type: 'predicate', probability: answer.noul };
    case 'choice':
      return { type: 'choice', choice: answer.choice, probabilities: answer.probabilities, confidence: answer.confidence };
    case 'score':
      return {
        type: 'score',
        score: answer.score,
        probabilities: Object.entries(answer.probabilities).sort(([a], [b]) => Number(a) - Number(b)).map(([, probability]) => probability),
        confidence: answer.confidence,
      };
    default:
      return { type: 'refusal' };
  }
}

/**
 * Answers by name in @aeye's shape.
 */
export function fromSystemOneAnswers(answers: Record<string, SystemOneAnswer>): Record<string, DecisionAnswer> {
  return Object.fromEntries(Object.entries(answers).map(([name, answer]) => [name, fromSystemOneAnswer(answer)]));
}

/**
 * Images as System One takes them: plain base64, without a data URL's
 * prefix. A string is read as a data URL, an http(s) or file URL, or text.
 */
export async function toSystemOneImages(images: Resource[]): Promise<string[]> {
  return Promise.all(images.map(async (image) => {
    const url = await toBase64(image, 'image/png');
    return url.slice(url.indexOf(',') + 1);
  }));
}

/**
 * The parameters of a System One decision request: the questions and
 * images of `request`, then `defaults` (such as a provider's `keep_alive`),
 * then the request's `extra`, which overrides both.
 *
 * @param model The model's id
 * @param state The evidence, a conversation already in chat messages
 * @param request The decision request
 * @param defaults Parameters a provider sends unless the request overrides them
 */
export async function toSystemOneParams(
  model: string,
  state: SystemOneDecisionParams['state'],
  request: DecisionRequest,
  defaults: Partial<Pick<SystemOneDecisionParams, 'keep_alive'>> = {},
): Promise<SystemOneDecisionParams> {
  return {
    model,
    state,
    questions: toSystemOneQuestions(request.questions),
    ...(request.images?.length ? { images: await toSystemOneImages(request.images) } : {}),
    ...defaults,
    ...request.extra,
  };
}

/**
 * The bytes of a request that count against a System One server's input
 * limit: its JSON without the images.
 */
export function systemOneTextBytes(params: SystemOneDecisionParams): number {
  const { images: _images, ...text } = params;
  return Buffer.byteLength(JSON.stringify(text), 'utf8');
}
