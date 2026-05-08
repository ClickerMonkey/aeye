/**
 * Chat API
 *
 * Provides chat completion functionality with automatic model selection, streaming support,
 * and lifecycle hooks. The Chat API is the primary interface for conversational AI.
 *
 * @example
 * ```typescript
 * // Simple chat completion
 * const response = await ai.chat.get([
 *   { role: 'user', content: 'What is TypeScript?' }
 * ]);
 * console.log(response.content);
 *
 * // Streaming chat
 * for await (const chunk of ai.chat.stream([
 *   { role: 'user', content: 'Write a poem about TypeScript' }
 * ])) {
 *   if (chunk.content) {
 *     process.stdout.write(chunk.content);
 *   }
 * }
 *
 * // With context and metadata
 * const response = await ai.chat.get(
 *   [{ role: 'user', content: 'Hello' }],
 *   {
 *     userId: '123',
 *     metadata: {
 *       model: 'gpt-4',
 *       required: ['chat', 'streaming']
 *     }
 *   }
 * );
 * ```
 */

import { getChunksFromResponse, getResponseFromChunks, type Executor, type Streamer, type Usage } from '@aeye/core';
import type { AI } from '../ai';
import type {
  AIBaseTypes,
  AIContext,
  AIContextRequired,
  AIMetadataRequired,
  Chunk,
  ModelCapability,
  ModelHandlerFor,
  ModelParameter,
  Request,
  Response,
  SelectedModelFor
} from '../types';
import { BaseAPI } from './base';

/**
 * Returns true when a `strict` field expresses a numeric (best-effort)
 * preference rather than a hard `true` / `false`. Default-omitted (undefined)
 * is treated as `1` per the v2 default policy in tool/prompt JSDoc, so it
 * also counts as numeric preference here.
 */
function isNumericStrictPreference(strict: boolean | number | undefined): boolean {
  if (strict === undefined) return true; // default 1
  if (typeof strict === 'number') return strict > 0;
  return false; // true and false are non-preferences for this purpose
}

/**
 * ChatAPI provides methods for chat completions with automatic model selection.
 * Inherits get() and stream() methods from BaseAPI.
 *
 * @template T - AIBaseTypes container with all type information
 */
export class ChatAPI<T extends AIBaseTypes> extends BaseAPI<
  T,
  Request,
  Response,
  Chunk
> {
  constructor(ai: AI<T>) {
    super(ai);
  }

  // ============================================================================
  // REQUIRED ABSTRACT METHOD IMPLEMENTATIONS
  // ============================================================================

  protected getRequiredCapabilities(provided: ModelCapability[], request: Request, forStreaming: boolean): ModelCapability[] {
    const capabilities = new Set<ModelCapability>(['chat', ...provided]);

    // Check if request contains images - requires vision capability
    if (request) {
      const hasImages = request.messages.some(message => {
        if (Array.isArray(message.content)) {
          return message.content.some(part => part.type === 'image');
        }
        return false;
      });

      if (hasImages) {
        capabilities.add('vision');
      }

      const hasAudio = request.messages.some(message => {
        if (Array.isArray(message.content)) {
          return message.content.some(part => part.type === 'audio');
        }
        return false;
      });

      if (hasAudio) {
        capabilities.add('hearing');
      }

      // Check if request uses reasoning
      if (request.reason !== undefined) {
        capabilities.add('reasoning');
      }

      // Check if request expects JSON output
      if (request.responseFormat) {
        if (request.responseFormat === 'json') {
          capabilities.add('json');
        } else if (typeof request.responseFormat === 'object') {
          capabilities.add('structured');
        }
      }

      // Check if request uses tools
      if (request.tools && request.tools.length > 0) {
        capabilities.add('tools');

        // Tri-state strict: any tool with `strict === true` is a HARD
        // requirement that the chosen model support strict tools. Numeric
        // priority is handled in `getOptionalCapabilities` (preference, not
        // filter). Default-omitted strict (treated as `1` downstream) is
        // *not* a hard requirement — selection still succeeds against
        // models without strict-family declarations.
        if (request.tools.some(t => t.strict === true)) {
          capabilities.add('toolsStrict');
        }
      }
    }

    return Array.from(capabilities);
  }

  protected getRequiredParameters(provided: ModelParameter[], request: Request, forStreaming: boolean): ModelParameter[] {
    const params = new Set<ModelParameter>([...provided]);

    if (request.maxTokens !== undefined) {
      params.add('maxTokens');
    }
    if (request.temperature !== undefined) {
      params.add('temperature');
    }
    if (request.topP !== undefined) {
      params.add('topP');
    }
    if (request.frequencyPenalty !== undefined) {
      params.add('frequencyPenalty');
    }
    if (request.presencePenalty !== undefined) {
      params.add('presencePenalty');
    }
    if (request.stop !== undefined) {
      params.add('stop');
    }
    if (request.logProbabilities !== undefined) {
      params.add('logProbabilities');
    }
    if (request.logitBias !== undefined) {
      params.add('logitBias');
    }
    if (request.responseFormat !== undefined) {
      params.add('responseFormat');
      if (typeof request.responseFormat === 'object') {
        params.add('structuredOutput');
      }
    }
    if (request.reason !== undefined) {
      params.add('reason');
    }
    if (request.tools !== undefined || request.toolChoice !== undefined) {
      params.add('tools');
      if (request.toolChoice !== undefined) {
        params.add('toolChoice');
      }
    }

    return Array.from(params);
  }

  /**
   * Optional (preferred) capabilities. Adds `'toolsStrict'` when any tool
   * is requesting strict at numeric priority (or default-omitted, which is
   * treated as priority `1`). Hard `strict: true` is handled in the
   * required path; `strict: false` adds nothing.
   *
   * Optional preferences score strict-tool-capable models higher without
   * filtering anyone out, matching the best-effort philosophy.
   */
  protected getOptionalCapabilities(provided: ModelCapability[], request: Request, forStreaming: boolean): ModelCapability[] {
    const optional = new Set<ModelCapability>(provided);

    if ((request.tools?.length ?? 0) > 0) {
      const wantsStrictPreference = request.tools!.some(t => isNumericStrictPreference(t.strict));
      if (wantsStrictPreference) {
        optional.add('toolsStrict');
      }
    }

    return Array.from(optional);
  }

  /**
   * Optional (preferred) parameters. Same logic as
   * `getOptionalCapabilities` but at the parameter level.
   */
  protected getOptionalParameters(provided: ModelParameter[], request: Request, forStreaming: boolean): ModelParameter[] {
    const params = new Set<ModelParameter>(provided);

    if (request.tools?.some(t => isNumericStrictPreference(t.strict))) {
      params.add('toolsStrict');
    }

    return Array.from(params);
  }

  protected getNoModelFoundError(): string {
    return 'No compatible model found for criteria';
  }

  protected getErrorType(operation: 'request' | 'stream'): string {
    return operation === 'request' ? 'chat-request-failed' : 'chat-stream-failed';
  }

  protected getErrorMessage(operation: 'request' | 'stream'): string {
    return operation === 'request' ? 'Chat request failed' : 'Chat streaming failed';
  }

  protected estimateRequestUsage(request: Request, selected: SelectedModelFor<T>): Usage {
    return this.ai.estimateRequestUsage(request);
  }

  protected async executeRequest<TRuntimeContext extends AIContext<T>>(
    request: Request,
    selected: SelectedModelFor<T>,
    ctx: TRuntimeContext
  ): Promise<Response> {
    if (!selected.provider.createExecutor) {
      throw new Error(`Provider ${selected.provider.name} does not support chat requests`);
    }

    const executor = selected.provider.createExecutor(selected.providerConfig);
    return await executor(request, ctx, ctx.metadata);
  }

  protected async *executeStreamRequest<TRuntimeContext extends AIContext<T>>(
    request: Request,
    selected: SelectedModelFor<T>,
    ctx: TRuntimeContext
  ): AsyncIterable<Chunk> {
    if (!selected.provider.createStreamer) {
      throw new Error(`Provider ${selected.provider.name} does not support chat streaming`);
    }

    const streamer = selected.provider.createStreamer(selected.providerConfig);
    return yield* streamer(request, ctx, ctx.metadata);
  }

  protected responseToChunks(response: Response, model?: SelectedModelFor<T>): Chunk[] {
    return getChunksFromResponse(response);
  }

  protected chunksToResponse(chunks: Chunk[], model?: SelectedModelFor<T>): Response {
    return getResponseFromChunks(chunks, model?.model);
  }

  protected getHandlerGetMethod(
    handler?: ModelHandlerFor<T>
  ): (<TRuntimeContext extends AIContext<T>>(request: Request, ctx: TRuntimeContext) => Promise<Response>) | undefined {
    return handler?.chat?.get;
  }

  protected getHandlerStreamMethod(
    handler?: ModelHandlerFor<T>
  ): (<TRuntimeContext extends AIContext<T>>(request: Request, ctx: TRuntimeContext) => AsyncIterable<Chunk>) | undefined {
    return handler?.chat?.stream;
  }

  protected hasProviderExecutor(selected: SelectedModelFor<T>): boolean {
    return !!selected.provider.createExecutor;
  }

  protected hasProviderStreamer(selected: SelectedModelFor<T>): boolean {
    return !!selected.provider.createStreamer;
  }

  /**
   * Create an executor function for use in core Context.
   * This executor routes through ChatAPI's get method, allowing Prompts
   * to execute chat completions through the context.
   *
   * @returns Executor function
   * @internal
   */
  createExecutor<
    TRuntimeContext extends AIContextRequired<T>,
    TRuntimeMetadata extends AIMetadataRequired<T>
  >(): Executor<TRuntimeContext, TRuntimeMetadata> {
    return async (
      request: Request,
      ctx: TRuntimeContext,
      metadata?: TRuntimeMetadata,
      signal?: AbortSignal
    ): Promise<Response> => {
      return await this.get(request, { ...ctx, metadata, signal });
    };
  }

  /**
   * Create a streamer function for use in core Context.
   * This streamer routes through ChatAPI's stream method, allowing Prompts
   * to execute streaming chat completions through the context.
   *
   * @returns Streamer function
   * @internal
   */
  createStreamer<
    TRuntimeContext extends AIContextRequired<T>,
    TRuntimeMetadata extends AIMetadataRequired<T>
  >(): Streamer<TRuntimeContext, TRuntimeMetadata> {
    const chatAPI = this;
    return async function* (
      request: Request,
      ctx: TRuntimeContext,
      metadata?: TRuntimeMetadata,
      signal?: AbortSignal
    ): AsyncGenerator<Chunk, Response> {
      const chunks: Chunk[] = [];
      for await (const chunk of chatAPI.stream(request, { ...ctx, metadata, signal })) {
        yield chunk;
        chunks.push(chunk);
      }

      return chatAPI.chunksToResponse(chunks);
    };
  }
}
