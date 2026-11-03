/**
 * Get API
 *
 * Base for APIs that answer with one response and never stream.
 */

import type { BaseRequest, BaseResponse } from '@aeye/core';
import type { AIBaseTypes, ModelParameter } from '../types';
import { BaseAPI } from './base';

export abstract class GetAPI<
  T extends AIBaseTypes,
  TRequest extends BaseRequest,
  TResponse extends BaseResponse
> extends BaseAPI<T, TRequest, TResponse, never> {
  protected getRequiredParameters(provided: ModelParameter[], request: TRequest): ModelParameter[] {
    return provided;
  }

  protected async *executeStreamRequest(): AsyncIterable<never> {
    this.noStreaming();
  }

  protected responseToChunks(): never {
    return this.noStreaming();
  }

  protected chunksToResponse(): never {
    return this.noStreaming();
  }

  protected getHandlerStreamMethod(): undefined {
    return undefined;
  }

  protected hasProviderStreamer(): boolean {
    return false;
  }

  private noStreaming(): never {
    throw new Error(`${this.getErrorMessage('request')}: streaming is not supported`);
  }
}
