/**
 * Rerank API
 *
 * Orders documents by relevance to a query, typically the candidates a
 * search or embedding lookup found.
 *
 * @example
 * ```typescript
 * const { results } = await ai.rerank.get({ query: 'capital of France', documents });
 * const best = documents[results[0].index];
 * ```
 */

import type {
  AIBaseTypes,
  AIContext,
  ModelCapability,
  ModelHandlerFor,
  RerankRequest,
  RerankResponse,
  SelectedModelFor
} from '../types';
import { GetAPI } from './get';

export class RerankAPI<T extends AIBaseTypes> extends GetAPI<T, RerankRequest, RerankResponse> {
  protected getRequiredCapabilities(provided: ModelCapability[]): ModelCapability[] {
    return ['rerank', ...provided];
  }

  protected getNoModelFoundError(): string {
    return 'No compatible model found for reranking';
  }

  protected getErrorType(): string {
    return 'rerank-failed';
  }

  protected getErrorMessage(): string {
    return 'Reranking failed';
  }

  protected executeRequest(request: RerankRequest, selected: SelectedModelFor<T>, ctx: AIContext<T>): Promise<RerankResponse> {
    if (!selected.provider.rerank) {
      throw new Error(`Provider ${selected.provider.name} does not support reranking`);
    }
    return selected.provider.rerank(request, ctx, selected.providerConfig);
  }

  protected getHandlerGetMethod(handler?: ModelHandlerFor<T>): ((request: RerankRequest, ctx: AIContext<T>) => Promise<RerankResponse>) | undefined {
    return handler?.rerank?.get;
  }

  protected hasProviderExecutor(selected: SelectedModelFor<T>): boolean {
    return !!selected.provider.rerank;
  }
}
