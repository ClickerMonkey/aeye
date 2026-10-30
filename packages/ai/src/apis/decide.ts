/**
 * Decide API
 *
 * Typed answers about an input from a decision model: the probability a
 * condition holds, one choice from a set, or a score on ordered levels.
 * Far faster and cheaper than asking a chat model for structured output.
 *
 * @example
 * ```typescript
 * const { answers } = await ai.decide.get({
 *   input: 'I was charged twice for my order.',
 *   questions: {
 *     billing: { type: 'predicate', instructions: 'Is this a billing problem?' },
 *     team: { type: 'choice', instructions: 'Which team handles it?', choices: { payments: 'Charges and refunds', web: 'Website bugs' } },
 *     urgency: { type: 'score', instructions: 'How urgent is it?', levels: ['Can wait', 'This week', 'Now'] },
 *   },
 * });
 * ```
 */

import type { Message, Usage } from '@aeye/core';
import type {
  AIBaseTypes,
  AIContext,
  DecisionRequest,
  DecisionResponse,
  ModelCapability,
  ModelHandlerFor,
  SelectedModelFor
} from '../types';
import { GetAPI } from './get';

export class DecideAPI<T extends AIBaseTypes> extends GetAPI<T, DecisionRequest, DecisionResponse> {
  protected getRequiredCapabilities(provided: ModelCapability[]): ModelCapability[] {
    return ['decision', ...provided];
  }

  protected getNoModelFoundError(): string {
    return 'No compatible model found for decisions';
  }

  protected getErrorType(): string {
    return 'decision-failed';
  }

  protected getErrorMessage(): string {
    return 'Decision failed';
  }

  protected executeRequest(request: DecisionRequest, selected: SelectedModelFor<T>, ctx: AIContext<T>): Promise<DecisionResponse> {
    if (!selected.provider.decide) {
      throw new Error(`Provider ${selected.provider.name} does not support decisions`);
    }
    return selected.provider.decide(request, ctx, selected.providerConfig);
  }

  protected estimateRequestUsage(request: DecisionRequest): Usage {
    const questions: Message = { role: 'user', content: JSON.stringify(request.questions) };
    const input: Message[] = typeof request.input === 'string' ? [{ role: 'user', content: request.input }] : request.input;
    return this.ai.estimateRequestUsage({ messages: [...input, questions] });
  }

  protected getHandlerGetMethod(handler?: ModelHandlerFor<T>): ((request: DecisionRequest, ctx: AIContext<T>) => Promise<DecisionResponse>) | undefined {
    return handler?.decide?.get;
  }

  protected hasProviderExecutor(selected: SelectedModelFor<T>): boolean {
    return !!selected.provider.decide;
  }
}
