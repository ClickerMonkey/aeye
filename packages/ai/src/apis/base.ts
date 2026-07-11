/**
 * Base API
 *
 * Abstract base class for all AI API implementations.
 * Implements the template method pattern to eliminate code duplication.
 */

import { accumulateUsage, BaseChunk, BaseRequest, BaseResponse, getModel } from '@aeye/core';
import type { AI } from '../ai';
import { isModelInfo } from '../common';
import type {
  AIBaseTypes,
  AIContext,
  AIContextRequired,
  AIMetadataRequired,
  AIProviderNames,
  ModelCapability,
  ModelHandlerFor,
  ModelParameter,
  OptionalParams,
  SelectedModelFor,
  Usage
} from '../types';

/**
 * Abstract base class for all API implementations
 *
 * Provides the complete lifecycle for AI operations with variation points
 * for subclass-specific behavior.
 *
 * @template T - AIBaseTypes container with all type information
 * @template TRequest - Request type for this API
 * @template TResponse - Response type for this API
 * @template TChunk - Chunk type for streaming (use never if no streaming)
 */
export abstract class BaseAPI<
  T extends AIBaseTypes,
  TRequest extends BaseRequest = BaseRequest,
  TResponse extends BaseResponse = BaseResponse,
  TChunk extends BaseChunk = BaseChunk
> {
  constructor(protected ai: AI<T>) {}

  /**
   * Gets the selected model for a given request and context.
   * 
   * @param request - The request to get the model for
   * @param ctx - The AI context
   * @returns 
   */
  async getModelFor<TRuntimeContext extends AIContext<T>>(request: TRequest, ctx: TRuntimeContext, forStreaming: boolean): Promise<SelectedModelFor<T> | null> {
    const { hooks, registry } = this.ai;

    // Check if model is already specified
    const model = getModel(request.model || ctx.metadata?.model);
    if (model) {
      const modelInfo = isModelInfo<AIProviderNames<T>>(model)
        ? model
        : registry.getModel(model.id);

      if (modelInfo) {
        const provider = registry.getProvider(modelInfo.provider)
          ?? registry.getProviderFor(model.id)[1];
          
        if (!provider) {
          return null;
        }

        return {
          model: modelInfo,
          provider: provider,
          score: 1.0,
        };
      } else {
        const { contextWindow = 0, maxOutputTokens = 0 } = model;
        const [providerKey, provider] = this.ai.registry.getProviderFor(model.id);
        if (!provider || !providerKey) {
          return null;
        }

        return {
          model: {
            id: model.id,
            provider: providerKey,
            name: model.id,
            capabilities: new Set<ModelCapability>(),
            tier:'flagship',
            pricing: {},
            contextWindow,
            maxOutputTokens,
          },
          provider,
          score: 1.0,
        };
      }
    } else {
      // No model specified - use selection system
      // Build metadata with required + optional capabilities and parameters.
      // Optional entries are *preferences* (registry scores them with up to
      // 2x for capabilities, 1.5x for parameters) — they bias selection
      // toward capable models without filtering anyone out. Required entries
      // are hard filters. ChatAPI promotes per-tool/per-prompt `strict`
      // requests into the right tier here (true → required, number →
      // optional preference); see `getRequiredCapabilities` and
      // `getOptionalCapabilities` in chat.ts.
      const metadataRequired: AIMetadataRequired<T> = {
        ...ctx.metadata,
        required: this.getRequiredCapabilities(ctx.metadata?.required || [], request, forStreaming),
        optional: this.getOptionalCapabilities(ctx.metadata?.optional || [], request, forStreaming),
        requiredParameters: this.getRequiredParameters(ctx.metadata?.requiredParameters || [], request, forStreaming),
        optionalParameters: this.getOptionalParameters(ctx.metadata?.optionalParameters || [], request, forStreaming),
      } as AIMetadataRequired<T>;

      // Build metadata from what used passed in context
      const metadata = await this.ai.buildMetadata(metadataRequired);

      // Run beforeModelSelection hook to affect which model might be selected (like restricting providers, zdr, etc)
      const enrichedMetadata = hooks.beforeModelSelection
        ? await hooks.beforeModelSelection(ctx, request, metadata)
        : metadata;

      // Select model
      const dynamicSelection = registry.selectModel(enrichedMetadata);
      if (!dynamicSelection) {
        return null;
      }

      return dynamicSelection;
    }
  }

  /**
   * Execute a non-streaming request
   *
   * Single optional context parameter pattern
   */
  async get<TRuntimeContext extends AIContextRequired<T>>(
    request: TRequest,
    ...[ctx]: OptionalParams<[TRuntimeContext]>
  ): Promise<TResponse> {
    const { hooks, registry } = this.ai;
    let latestCtx: TRuntimeContext | AIContext<T> | undefined = ctx;

    try {
      // Build full context
      const fullCtx = await this.ai.buildContext(ctx || {} as AIContextRequired<T>);
      latestCtx = fullCtx;

      // Get model for request
      const selected = await this.getModelFor(request, fullCtx, false);
      if (!selected) {
        throw new Error(this.getNoModelFoundError());
      }
    
      // Inject selected model into context for provider access
      fullCtx.metadata = {
        ...fullCtx.metadata,
        model: selected.model,
      } as typeof fullCtx.metadata;

      // Run onModelSelected hook
      const finalSelected = (await hooks.onModelSelected?.(fullCtx, request, selected)) || selected;

      // Estimate usage
      const estimatedUsage = this.estimateRequestUsage(request, finalSelected);
      const estimatedCost = this.estimateRequestCost(estimatedUsage, finalSelected);

      // Run beforeRequest hook (hook can override provider config)
      await hooks.beforeRequest?.(fullCtx, request, finalSelected, estimatedUsage, estimatedCost);

      // Get handler if available
      const handler = registry.getHandler(finalSelected.model.provider, finalSelected.model.id);

      // Execute request with fallback logic
      const response = await this.executeRequestWithFallback(
        request,
        finalSelected,
        fullCtx,
        handler
      );

      // Calculate cost and extract usage
      const usage = this.extractUsage(response, estimatedUsage);
      const cost = this.calculateResponseCost(response, finalSelected, estimatedUsage);

      // Run afterRequest hook
      await hooks.afterRequest?.(fullCtx, request, response, true, finalSelected, usage, cost);

      return response;
    } catch (error) {
      hooks.onError?.(
        this.getErrorType('request'),
        this.getErrorMessage('request'),
        error instanceof Error ? error : undefined,
        latestCtx,
        request,
      );
      throw error;
    }
  }

  /**
   * Execute a streaming request
   *
   * Single optional context parameter pattern
   */
  async *stream<TRuntimeContext extends AIContextRequired<T>>(
    request: TRequest,
    ...[ctx]: OptionalParams<[TRuntimeContext]>
  ): AsyncIterable<TChunk> {
    const { hooks, registry } = this.ai;
    let latestCtx: TRuntimeContext | AIContext<T> | undefined = ctx;

    try {
      // Build full context
      const fullCtx = await this.ai.buildContext(ctx || {} as AIContextRequired<T>);
      latestCtx = fullCtx;

      // Get model for request
      const selected = await this.getModelFor(request, fullCtx, true);
      if (!selected) {
        throw new Error(this.getNoModelFoundErrorForStreaming());
      }

      // Inject the FULL selected ModelInfo (symmetric with the non-streaming
      // get() path ~line 158). Previously streaming passed only `.id`, so
      // `pickModelInfo` couldn't resolve capabilities and structured-output
      // strict mode was silently dropped for streaming. Opt out of strict per
      // request via the component's `strict` policy, not by starving this.
      fullCtx.metadata = {
        ...fullCtx.metadata,
        model: selected.model,
      } as typeof fullCtx.metadata;

      // Run onModelSelected hook
      const finalSelected = hooks.onModelSelected
        ? (await hooks.onModelSelected(fullCtx, request, selected)) || selected
        : selected;

      // Estimate usage
      const estimatedUsage = this.estimateRequestUsage(request, finalSelected);
      const estimatedCost = this.estimateRequestCost(estimatedUsage, finalSelected);

      // Run beforeRequest hook
      await hooks.beforeRequest?.(fullCtx, request, finalSelected, estimatedUsage, estimatedCost);

      // Get handler if available
      const handler = registry.getHandler(finalSelected.model.provider, finalSelected.model.id);

      // Stream request and accumulate usage
      const accumulatedUsage: Usage = {};
      const chunks: TChunk[] = [];
      let finished = false;

      try {
        for await (const chunk of this.streamRequestWithFallback(request, finalSelected, fullCtx, handler)) {
          const usage = chunk.usage;
          if (usage) {
            accumulateUsage(accumulatedUsage, usage);
          }
          chunks.push(chunk);
          yield chunk;
        }
        
        finished = true
      } finally {
          // Calculate cost
        const cost = this.calculateStreamCost(accumulatedUsage, finalSelected);

        // Build response from chunks
        const response = this.chunksToResponse(chunks, finalSelected);

        // Run afterRequest hook
        await hooks.afterRequest?.(fullCtx, request, response, finished, finalSelected, accumulatedUsage, cost);
      }
    } catch (error) {
      hooks.onError?.(
        this.getErrorType('stream'),
        this.getErrorMessage('stream'),
        error instanceof Error ? error : undefined,
        latestCtx,
        request,
      );
      throw error;
    }
  }

  // ============================================================================
  // ABSTRACT METHODS (must be implemented by subclasses)
  // ============================================================================

  /**
   * Get required capabilities for model selection
   * @param provided - Additional capabilities provided by caller
   * @param request - Optional request to analyze for additional capability needs
   */
  protected abstract getRequiredCapabilities(provided: ModelCapability[], request: TRequest, forStreaming: boolean): ModelCapability[];

  /**
   * Get required parameters for model selection based on the request
   * @param request - The request to analyze
   * @returns Set of parameters required by this request
   */
  protected abstract getRequiredParameters(provided: ModelParameter[], request: TRequest, forStreaming: boolean): ModelParameter[];

  /**
   * Get error message when no compatible model is found
   */
  protected abstract getNoModelFoundError(): string;

  /**
   * Get error type string for error handling
   * @param operation - Whether this is a request or stream operation
   */
  protected abstract getErrorType(operation: 'request' | 'stream'): string;

  /**
   * Get error message for error handling
   * @param operation - Whether this is a request or stream operation
   */
  protected abstract getErrorMessage(operation: 'request' | 'stream'): string;

  /**
   * Execute the request with the selected provider
   * Called by executeRequestWithFallback when handler doesn't provide get method
   * @param request - The request to execute
   * @param selected - The selected model and provider
   * @param ctx - The execution context
   */
  protected abstract executeRequest<TRuntimeContext extends AIContext<T>>(
    request: TRequest,
    selected: SelectedModelFor<T>,
    ctx: TRuntimeContext
  ): Promise<TResponse>;

  /**
   * Stream the request with the selected provider
   * Called by streamRequestWithFallback when handler doesn't provide stream method
   * @param request - The request to stream
   * @param selected - The selected model and provider
   * @param ctx - The execution context
   */
  protected abstract executeStreamRequest<TRuntimeContext extends AIContext<T>>(
    request: TRequest,
    selected: SelectedModelFor<T>,
    ctx: TRuntimeContext
  ): AsyncIterable<TChunk>;

  /**
   * Convert a response to a single chunk (for executor-to-streamer fallback)
   * @param response - The response to convert
   */
  protected abstract responseToChunks(response: TResponse, model: SelectedModelFor<T>): TChunk[];

  /**
   * Convert accumulated chunks to a response (for streamer-to-executor fallback)
   * @param chunks - Array of chunks to convert
   */
  protected abstract chunksToResponse(chunks: TChunk[], model: SelectedModelFor<T>): TResponse;

  /**
   * Check if the provider supports non-streaming execution for this operation
   * @param selected - The selected model and provider
   */
  protected abstract hasProviderExecutor(selected: SelectedModelFor<T>): boolean;

  /**
   * Check if the provider supports streaming execution for this operation
   * @param selected - The selected model and provider
   */
  protected abstract hasProviderStreamer(selected: SelectedModelFor<T>): boolean;

  /**
   * Get the appropriate handler get method for this API
   * Subclasses can override to specify which handler method to use
   */
  protected abstract getHandlerGetMethod<TRuntimeContext extends AIContext<T>>(
    handler?: ModelHandlerFor<T>
  ): ((request: TRequest, ctx: TRuntimeContext) => Promise<TResponse>) | undefined;

  /**
   * Get the appropriate handler stream method for this API
   * Subclasses can override to specify which handler method to use
   */
  protected abstract getHandlerStreamMethod<TRuntimeContext extends AIContext<T>>(
    handler?: ModelHandlerFor<T>
  ): ((request: TRequest, ctx: TRuntimeContext) => AsyncIterable<TChunk>) | undefined;

  // ============================================================================
  // OPTIONAL OVERRIDES (default implementations provided)
  // ============================================================================

  /**
   * Get optional (preferred) capabilities for model selection.
   *
   * Default implementation returns just what the caller provided. Subclasses
   * override to auto-derive preferences from request shape — e.g. ChatAPI
   * adds `'toolsStrict'` when any tool has `strict: true`. Optional entries
   * never filter models out; they bias selection scoring toward capable models.
   */
  protected getOptionalCapabilities(provided: ModelCapability[], request: TRequest, forStreaming: boolean): ModelCapability[] {
    return [...provided];
  }

  /**
   * Get optional (preferred) parameters for model selection. Same role as
   * `getOptionalCapabilities` but for parameter-level matching.
   */
  protected getOptionalParameters(provided: ModelParameter[], request: TRequest, forStreaming: boolean): ModelParameter[] {
    return [...provided];
  }

  /**
   * Get required capabilities for streaming (default: adds 'streaming')
   * @param provided - Additional capabilities provided by caller
   * @param request - Optional request to analyze for additional capability needs
   */
  protected getRequiredCapabilitiesForStreaming(provided: ModelCapability[], request: TRequest): ModelCapability[] {
    return [...this.getRequiredCapabilities(provided, request, true), 'streaming'];
  }

  /**
   * Get error message for streaming when no compatible model is found
   * (default: modifies base error to mention streaming)
   */
  protected getNoModelFoundErrorForStreaming(): string {
    return this.getNoModelFoundError().replace('criteria', 'streaming criteria');
  }

  /**
   * Estimate usage for the request
   * (default: returns empty usage, subclasses should override)
   * @param request - The request to estimate
   * @param selected - The selected model and provider
   */
  protected estimateRequestUsage(request: TRequest, selected: SelectedModelFor<T>): Usage {
    return {};
  }

  /**
   * Estimate cost for a request before execution
   * 
   * @param estimatedUsage - Estimated usage statistics
   * @param selected - The selected model and provider
   * @returns Estimated cost
   */
  protected estimateRequestCost(
    estimatedUsage: Usage,
    selected: SelectedModelFor<T>
  ): number {
    // If no cost provided, calculate it
    return this.ai.calculateCost(selected.model, estimatedUsage);
  }

  /**
   * Calculate cost for a completed response
   * (default: extracts from response.cost or calculates from usage)
   * @param response - The response
   * @param selected - The selected model and provider
   * @param estimatedUsage - Estimated usage statistics
   */
  protected calculateResponseCost(
    response: TResponse,
    selected: SelectedModelFor<T>,
    estimatedUsage: Usage
  ): number {
    // Otherwise extract usage and check if cost is included
    const usage = this.extractUsage(response, estimatedUsage);
    if (usage.cost !== undefined) {
      return usage.cost;
    }

    // If no cost provided, calculate it
    return this.ai.calculateCost(selected.model, usage);
  }

  /**
   * Calculate cost for a completed stream
   * (default: calculates from accumulated usage)
   * @param usage - Accumulated token usage
   * @param selected - The selected model and provider
   */
  protected calculateStreamCost(
    usage: Usage,
    selected: SelectedModelFor<T>
  ): number {
    // If cost is already included in usage, return it
    if (usage.cost !== undefined) {
      return usage.cost;
    }

    return this.ai.calculateCost(selected.model, usage);
  }

  /**
   * Extract usage from response
   * (default: extracts from response.usage or uses estimate)
   * @param response - The response
   * @param estimatedUsage - Estimated usage statistics
   */
  protected extractUsage(response: TResponse, estimatedUsage: Usage): Usage {
    // Try to extract from response
    const usage = response.usage;
    if (usage) return usage;

    // Otherwise use estimate
    return estimatedUsage;
  }

  /**
   * Execute request with fallback logic:
   * 1. Try handler.get() if available
   * 2. Try handler-specific method (e.g., handler.chat.get)
   * 3. Try executeRequest() (provider method)
   * 4. Try streamer-to-executor conversion if provider has streamer
   */
  protected async executeRequestWithFallback<TRuntimeContext extends AIContext<T>>(
    request: TRequest,
    selected: SelectedModelFor<T>,
    ctx: TRuntimeContext,
    handler?: ModelHandlerFor<T>
  ): Promise<TResponse> {
    // Try handler first
    const handlerMethod = this.getHandlerGetMethod(handler);
    if (handlerMethod) {
      return await handlerMethod(request, ctx);
    }

    // Try provider executor
    if (this.hasProviderExecutor(selected)) {
      return await this.executeRequest(request, selected, ctx);
    }

    // Fallback: try converting streamer to executor
    const streamerMethod = this.getHandlerStreamMethod(handler);
    if (streamerMethod) {
      const chunks: TChunk[] = [];
      for await (const chunk of streamerMethod(request, ctx)) {
        chunks.push(chunk);
      }
      return this.chunksToResponse(chunks, selected);
    }

    // Try provider streamer as fallback
    if (this.hasProviderStreamer(selected)) {
      const chunks: TChunk[] = [];
      for await (const chunk of this.executeStreamRequest(request, selected, ctx)) {
        chunks.push(chunk);
      }
      return this.chunksToResponse(chunks, selected);
    }

    throw new Error(
      `Provider "${selected.model.provider}" does not support non-streaming requests for this operation and no fallback is available`
    );
  }

  /**
   * Stream request with fallback logic:
   * 1. Try handler.stream() if available
   * 2. Try handler-specific method (e.g., handler.chat.stream)
   * 3. Try executeStreamRequest() (provider streaming method)
   * 4. Try executor-to-streamer conversion if provider has executor
   */
  protected async *streamRequestWithFallback<TRuntimeContext extends AIContext<T>>(
    request: TRequest,
    selected: SelectedModelFor<T>,
    ctx: TRuntimeContext,
    handler?: ModelHandlerFor<T>
  ): AsyncIterable<TChunk> {
    // Try handler first
    const handlerMethod = this.getHandlerStreamMethod(handler);
    if (handlerMethod) {
      return yield* handlerMethod(request, ctx);
    }

    // Try provider streamer
    if (this.hasProviderStreamer(selected)) {
      return yield* this.executeStreamRequest(request, selected, ctx);
    }

    // Fallback: try converting executor to streamer
    const getMethod = this.getHandlerGetMethod(handler);
    if (getMethod) {
      const response = await getMethod(request, ctx);
      for (const chunk of this.responseToChunks(response, selected)) {
        yield chunk;
      }
      return;
    }

    // Try provider executor as fallback
    if (this.hasProviderExecutor(selected)) {
      const response = await this.executeRequest(request, selected, ctx);
      for (const chunk of this.responseToChunks(response, selected)) {
        yield chunk;
      }
      return;
    }

    throw new Error(
      `Provider "${selected.model.provider}" does not support streaming requests for this operation and no fallback is available`
    );
  }
}
