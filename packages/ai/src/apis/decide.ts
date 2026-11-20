/**
 * Decide API
 *
 * Typed answers about an input from a decision model: the probability a
 * condition holds, one choice from a set, or a score on ordered levels.
 * Far faster and cheaper than asking a chat model for structured output.
 *
 * A decision model may cap how many questions one call asks
 * (`ModelInfo.maxQuestions`) and how large the call is
 * (`ModelInfo.maxRequestBytes`). Calls over a cap are refused with a
 * `DecisionLimitError`, never split: the caller splits its questions.
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
  ModelInfo,
  SelectedModelFor
} from '../types';
import { GetAPI } from './get';

/**
 * A decision call larger than its model takes (`ModelInfo.maxQuestions` or
 * `ModelInfo.maxRequestBytes`). Decisions are never split: the caller splits
 * its questions into calls the model takes.
 */
export class DecisionLimitError extends Error {
  override readonly name = 'DecisionLimitError';

  constructor(
    // The model that refused
    public readonly model: string,
    // Which limit the call is over
    public readonly limit: 'maxQuestions' | 'maxRequestBytes',
    // The model's limit
    public readonly max: number,
    // What the call had
    public readonly actual: number,
  ) {
    super(limit === 'maxQuestions'
      ? `${model} takes at most ${max} questions per decision call, and this one asks ${actual}: split the questions into calls of ${max} or fewer`
      : `${model} takes at most ${max} bytes of input and questions per decision call, and this one has ${actual}: send less input or fewer questions per call`);
  }
}

/**
 * Refuse a decision call larger than its model takes.
 *
 * @param model The model's limits (an unset limit is no limit)
 * @param questions How many questions the call asks
 * @param bytes How many bytes the model counts against `maxRequestBytes`, when known
 * @throws {DecisionLimitError} When the call is over a limit
 */
export function checkDecisionLimits(model: Pick<ModelInfo, 'id' | 'maxQuestions' | 'maxRequestBytes'>, questions: number, bytes?: number): void {
  if (model.maxQuestions !== undefined && questions > model.maxQuestions) {
    throw new DecisionLimitError(model.id, 'maxQuestions', model.maxQuestions, questions);
  }
  if (model.maxRequestBytes !== undefined && bytes !== undefined && bytes > model.maxRequestBytes) {
    throw new DecisionLimitError(model.id, 'maxRequestBytes', model.maxRequestBytes, bytes);
  }
}

export class DecideAPI<T extends AIBaseTypes> extends GetAPI<T, DecisionRequest, DecisionResponse> {
  protected getRequiredCapabilities(provided: ModelCapability[], request: DecisionRequest): ModelCapability[] {
    return ['decision', ...(request.images?.length ? ['vision' as const] : []), ...provided];
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
    checkDecisionLimits(selected.model, Object.keys(request.questions).length);
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
