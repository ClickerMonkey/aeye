/**
 * The Decisions API's wire shapes, which the SDK does not type yet, and
 * their conversion to and from @aeye decisions.
 */

import type { DecisionAnswer, DecisionQuestion } from '@aeye/ai';
import OpenAI from 'openai';

/**
 * A question as the Decisions API takes it.
 */
export type OpenAIDecisionQuestion = { name: string; instructions: string } & (
  | { type: 'predicate' }
  | { type: 'choice'; choices: Array<{ value: string; description?: string }> }
  | { type: 'score'; levels: Array<{ label: string; description?: string }> }
);

/**
 * Parameters of a decision request.
 */
export interface OpenAIDecisionParams {
  model: string;
  input: string | OpenAI.Responses.ResponseInputItem[];
  questions: OpenAIDecisionQuestion[];
}

/**
 * An answer as the Decisions API returns it.
 */
export type OpenAIDecisionAnswer = { name: string } & (
  | { type: 'predicate'; probability: number }
  | { type: 'choice'; choice: string; probabilities: Array<{ value: string; probability: number }>; confidence: number }
  | { type: 'score'; score: number; probabilities: Array<{ value: number; label: string; probability: number }>; confidence: number }
  | { type: 'refusal' }
);

/**
 * A decision as the Decisions API returns it.
 */
export interface OpenAIDecision {
  model: string;
  answers: OpenAIDecisionAnswer[];
  usage: OpenAI.Responses.ResponseUsage;
}

/**
 * A named question in the Decisions API's shape.
 */
export function toDecisionQuestion(name: string, question: DecisionQuestion): OpenAIDecisionQuestion {
  const { instructions } = question;
  switch (question.type) {
    case 'predicate':
      return { name, type: 'predicate', instructions };
    case 'choice':
      return { name, type: 'choice', instructions, choices: Object.entries(question.choices).map(([value, description]) => ({ value, description: description || undefined })) };
    case 'score':
      return { name, type: 'score', instructions, levels: question.levels.map(label => ({ label })) };
  }
}

/**
 * An answer in @aeye's shape. Score probabilities come back in level order.
 */
export function toDecisionAnswer(answer: OpenAIDecisionAnswer): DecisionAnswer {
  switch (answer.type) {
    case 'predicate':
      return { type: 'predicate', probability: answer.probability };
    case 'choice':
      return { type: 'choice', choice: answer.choice, probabilities: Object.fromEntries(answer.probabilities.map(p => [p.value, p.probability])), confidence: answer.confidence };
    case 'score':
      return { type: 'score', score: answer.score, probabilities: answer.probabilities.map(p => p.probability), confidence: answer.confidence };
    case 'refusal':
      return { type: 'refusal' };
  }
}
