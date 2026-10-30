/**
 * Embed API
 *
 * Provides text embedding functionality.
 */

import type { Usage } from '@aeye/core';
import type {
  AIBaseTypes,
  AIContext,
  EmbeddingRequest,
  EmbeddingResponse,
  ModelCapability,
  ModelParameter,
  ModelHandlerFor,
  SelectedModelFor
} from '../types';
import { GetAPI } from './get';

export class EmbedAPI<T extends AIBaseTypes> extends GetAPI<T, EmbeddingRequest, EmbeddingResponse> {
  protected getRequiredCapabilities(provided: ModelCapability[]): ModelCapability[] {
    return ['embedding', ...provided];
  }

  protected getRequiredParameters(provided: ModelParameter[], request: EmbeddingRequest): ModelParameter[] {
    return request.dimensions !== undefined ? [...new Set<ModelParameter>([...provided, 'embeddingDimensions'])] : provided;
  }

  protected getNoModelFoundError(): string {
    return 'No compatible model found for embeddings';
  }

  protected getErrorType(): string {
    return 'embedding-generation-failed';
  }

  protected getErrorMessage(): string {
    return 'Embedding generation failed';
  }

  protected async executeRequest(
    request: EmbeddingRequest,
    selected: SelectedModelFor<T>,
    ctx: AIContext<T>
  ): Promise<EmbeddingResponse> {
    return await selected.provider.embed!(
      request,
      ctx,
      selected.providerConfig
    );
  }

  protected estimateRequestUsage(request: EmbeddingRequest): Usage {
    const totalTextLength = request.texts.reduce((sum, text) => sum + text.length, 0);
    const tokens = Math.ceil(totalTextLength / 4);
    return {
      embeddings: {
        count: request.texts.length,
        tokens
      }
    };
  }

  protected getHandlerGetMethod(
    handler?: ModelHandlerFor<T>
  ): ((request: EmbeddingRequest, ctx: AIContext<T>) => Promise<EmbeddingResponse>) | undefined {
    return handler?.embed?.get;
  }

  protected hasProviderExecutor(selected: SelectedModelFor<T>): boolean {
    return !!selected.provider.embed;
  }
}
