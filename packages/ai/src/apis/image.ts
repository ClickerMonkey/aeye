/**
 * Image API
 *
 * Provides image generation, editing, and analysis functionality.
 */

import { getChunksFromResponse, getResponseFromChunks, ModelInput } from '@aeye/core';
import type { AI } from '../ai';
import type {
  AIBaseTypes,
  AIContext,
  Chunk,
  ImageAnalyzeRequest,
  ImageEditRequest,
  ImageGenerationChunk,
  ImageGenerationRequest,
  ImageGenerationResponse,
  ImageOutputOptions,
  ModelCapability,
  ModelInfo,
  ModelHandlerFor,
  ModelParameter,
  Request,
  Response,
  SelectedModelFor,
  Usage
} from '../types';
import { BaseAPI } from './base';

/**
 * Estimates the usage of producing images: prompt tokens, a rough count per
 * input image, and one priced output per image. Without a requested quality
 * the model's first priced quality stands in, so the estimate hits a real
 * price entry.
 *
 * @param request - The generation or edit request.
 * @param model - The model producing the images.
 * @param inputImages - How many images the request sends.
 */
function estimateImageUsage(request: ImageOutputOptions, model: ModelInfo, inputImages: number): Usage {
  const [width, height] = (request.size || '1024x1024').split('x').map(Number);
  return {
    text: { input: Math.ceil(request.prompt.length / 4) },
    image: {
      input: inputImages ? inputImages * 1000 : undefined,
      output: [{
        quality: request.quality ?? model.pricing.image?.output?.[0]?.quality ?? 'medium',
        size: { width, height },
        count: request.n || 1,
      }],
    },
  };
}

// ============================================================================
// Image Generate API
// ============================================================================

class ImageGenerateAPI<T extends AIBaseTypes> extends BaseAPI<
  T,
  ImageGenerationRequest,
  ImageGenerationResponse,
  ImageGenerationChunk
> {
  constructor(ai: AI<T>) {
    super(ai);
  }

  protected getRequiredCapabilities(provided: ModelCapability[], request?: ImageGenerationRequest): ModelCapability[] {
    return ['image', ...provided];
  }

  protected getRequiredParameters(provided: ModelParameter[], request: ImageGenerationRequest, forStreaming: boolean): ModelParameter[] {
    const params = new Set<ModelParameter>(provided);

    if (request.n !== undefined && request.n !== 1) {
      params.add('imageMultiple');
    }
    if (request.background !== undefined) {
      params.add('imageBackground');
    }
    if (request.responseFormat !== undefined) {
      params.add('imageFormat');
    }
    if (request.style !== undefined) {
      params.add('imageStyle');
    }
    if (forStreaming && request.streamCount !== 0) {
      params.add('imageStream');
    }

    return Array.from(params);
  }

  protected getNoModelFoundError(): string {
    return 'No compatible model found for image generation';
  }

  protected getErrorType(operation: 'request' | 'stream'): string {
    return operation === 'request'
      ? 'image-generation-failed'
      : 'image-generation-stream-failed';
  }

  protected getErrorMessage(operation: 'request' | 'stream'): string {
    return operation === 'request'
      ? 'Image generation failed'
      : 'Image generation streaming failed';
  }

  protected estimateRequestUsage(request: ImageGenerationRequest, selected: SelectedModelFor<T>): Usage {
    return estimateImageUsage(request, selected.model, 0);
  }

  protected async executeRequest(
    request: ImageGenerationRequest,
    selected: SelectedModelFor<T>,
    ctx: AIContext<T>
  ): Promise<ImageGenerationResponse> {
    return await selected.provider.generateImage!(
      request,
      ctx,
      selected.providerConfig
    );
  }

  protected async *executeStreamRequest(
    request: ImageGenerationRequest,
    selected: SelectedModelFor<T>,
    ctx: AIContext<T>
  ): AsyncIterable<ImageGenerationChunk> {
    return yield* selected.provider.generateImageStream!(
      request,
      ctx,
      selected.providerConfig
    );
  }

  protected responseToChunks(response: ImageGenerationResponse): ImageGenerationChunk[] {
    return response.images.map((img) => ({
      progress: 1,
      done: true,
      image: img,
      model: response.model,
      usage: response.usage,
    }));
  }

  protected chunksToResponse(chunks: ImageGenerationChunk[], model: SelectedModelFor<T>): ImageGenerationResponse {
    const images = chunks
      .filter(c => c.image)
      .map(c => c.image!);

    return {
      images: images,
      model: chunks.find(c => c.model)?.model || model?.model,
      usage: chunks.find(c => c.usage)?.usage,
    };
  }

  protected getHandlerGetMethod(
    handler?: ModelHandlerFor<T>
  ): ((request: ImageGenerationRequest, ctx: AIContext<T>) => Promise<ImageGenerationResponse>) | undefined {
    return handler?.imageGenerate?.get;
  }

  protected getHandlerStreamMethod(
    handler?: ModelHandlerFor<T>
  ): ((request: ImageGenerationRequest, ctx: AIContext<T>) => AsyncIterable<ImageGenerationChunk>) | undefined {
    return handler?.imageGenerate?.stream;
  }

  protected hasProviderExecutor(selected: SelectedModelFor<T>): boolean {
    return !!selected.provider.generateImage;
  }

  protected hasProviderStreamer(selected: SelectedModelFor<T>): boolean {
    return !!selected.provider.generateImageStream;
  }
}

// ============================================================================
// Image Edit API
// ============================================================================

class ImageEditAPI<T extends AIBaseTypes> extends BaseAPI<
  T,
  ImageEditRequest,
  ImageGenerationResponse,
  ImageGenerationChunk
> {
  constructor(ai: AI<T>) {
    super(ai);
  }

  protected getModel(request: ImageEditRequest): ModelInput | undefined {
    return request.model;
  }

  protected getRequiredCapabilities(provided: ModelCapability[], request: ImageEditRequest, forStreaming: boolean): ModelCapability[] {
    return ['image', ...provided];
  }

  protected getRequiredParameters(provided: ModelParameter[], request: ImageEditRequest, forStreaming: boolean): ModelParameter[] {
    const params = new Set<ModelParameter>(provided);

    if (request.n !== undefined && request.n !== 1) {
      params.add('imageMultiple');
    }
    if (request.responseFormat !== undefined) {
      params.add('imageFormat');
    }
    if (forStreaming && request.streamCount !== 0) {
      params.add('imageStream');
    }

    return Array.from(params);
  }

  protected getNoModelFoundError(): string {
    return 'No compatible model found for image editing';
  }

  protected getErrorType(operation: 'request' | 'stream'): string {
    return operation === 'request'
      ? 'image-edit-failed'
      : 'image-edit-stream-failed';
  }

  protected getErrorMessage(operation: 'request' | 'stream'): string {
    return operation === 'request'
      ? 'Image editing failed'
      : 'Image editing streaming failed';
  }

  protected estimateRequestUsage(request: ImageEditRequest, selected: SelectedModelFor<T>): Usage {
    return estimateImageUsage(request, selected.model, 1 + (request.references?.length ?? 0));
  }

  protected async executeRequest(
    request: ImageEditRequest,
    selected: SelectedModelFor<T>,
    ctx: AIContext<T>
  ): Promise<ImageGenerationResponse> {
    return await selected.provider.editImage!(
      request,
      ctx,
      selected.providerConfig
    );
  }

  protected async *executeStreamRequest(
    request: ImageEditRequest,
    selected: SelectedModelFor<T>,
    ctx: AIContext<T>
  ): AsyncIterable<ImageGenerationChunk> {
    return yield* selected.provider.editImageStream!(
      request,
      ctx,
      selected.providerConfig
    );
  }

  protected responseToChunks(response: ImageGenerationResponse): ImageGenerationChunk[] {
    return response.images.map((img) => ({
      progress: 1,
      done: true,
      image: img,
      model: response.model,
      usage: response.usage,
    }));
  }

  protected chunksToResponse(chunks: ImageGenerationChunk[], model: SelectedModelFor<T>): ImageGenerationResponse {
    const images = chunks
      .filter(c => c.image)
      .map(c => c.image!);

    return {
      images: images,
      model: chunks.find(c => c.model)?.model || model?.model,
      usage: chunks.find(c => c.usage)?.usage,
    };
  }

  protected getHandlerGetMethod(
    handler?: ModelHandlerFor<T>
  ): ((request: ImageEditRequest, ctx: AIContext<T>) => Promise<ImageGenerationResponse>) | undefined {
    return handler?.imageEdit?.get;
  }

  protected getHandlerStreamMethod(
    handler?: ModelHandlerFor<T>
  ): ((request: ImageEditRequest, ctx: AIContext<T>) => AsyncIterable<ImageGenerationChunk>) | undefined {
    return handler?.imageEdit?.stream;
  }

  protected hasProviderExecutor(selected: SelectedModelFor<T>): boolean {
    return !!selected.provider.editImage;
  }

  protected hasProviderStreamer(selected: SelectedModelFor<T>): boolean {
    return !!selected.provider.editImageStream;
  }
}

// ============================================================================
// Image Analyze API
// ============================================================================

class ImageAnalyzeAPI<T extends AIBaseTypes = AIBaseTypes> extends BaseAPI<
  T,
  ImageAnalyzeRequest,
  Response,
  Chunk
> {
  constructor(ai: AI<T>) {
    super(ai);
  }

  protected getRequiredCapabilities(provided: ModelCapability[], request: ImageAnalyzeRequest, forStreaming: boolean): ModelCapability[] {
    return ['chat', 'vision', ...provided];
  }

  protected getRequiredParameters(provided: ModelParameter[], request: ImageAnalyzeRequest, forStreaming: boolean): ModelParameter[] {
    const params = new Set<ModelParameter>(provided);

    if (request.maxTokens !== undefined) {
      params.add('maxTokens');
    }
    if (request.temperature !== undefined) {
      params.add('temperature');
    }

    return Array.from(params);
  }

  protected getNoModelFoundError(): string {
    return 'No compatible vision model found for image analysis';
  }

  protected getErrorType(operation: 'request' | 'stream'): string {
    return operation === 'request'
      ? 'image-analyze-failed'
      : 'image-analyze-stream-failed';
  }

  protected getErrorMessage(operation: 'request' | 'stream'): string {
    return operation === 'request'
      ? 'Image analysis failed'
      : 'Image analysis streaming failed';
  }

  protected getNoModelFoundErrorForStreaming(): string {
    return 'No compatible vision model found for streaming image analysis';
  }

  /**
   * Convert ImageAnalyzeRequest to chat Request with multimodal content
   */
  private convertToChatRequest(request: ImageAnalyzeRequest): Request {
    return {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', content: request.prompt },
            ...request.images.map((img) => ({
              type: 'image' as const,
              content: img,
            })),
          ],
        },
      ],
      maxTokens: request.maxTokens,
      temperature: request.temperature,
    };
  }

  protected estimateRequestUsage(request: ImageAnalyzeRequest, selected: SelectedModelFor<T>): Usage {
    const chatRequest = this.convertToChatRequest(request);
    return this.ai.estimateRequestUsage(chatRequest);
  }

  protected async executeRequest(
    request: ImageAnalyzeRequest,
    selected: SelectedModelFor<T>,
    ctx: AIContext<T>
  ): Promise<Response> {
    const chatRequest = this.convertToChatRequest(request);
    const executor = selected.provider.createExecutor!(selected.providerConfig);
    return await executor(chatRequest, ctx, ctx.metadata);
  }

  protected async *executeStreamRequest(
    request: ImageAnalyzeRequest,
    selected: SelectedModelFor<T>,
    ctx: AIContext<T>
  ): AsyncIterable<Chunk> {
    const chatRequest = this.convertToChatRequest(request);
    const streamer = selected.provider.createStreamer!(selected.providerConfig);
    return yield* streamer(chatRequest, ctx, ctx.metadata);
  }

  protected responseToChunks(response: Response): Chunk[] {
    return getChunksFromResponse(response);
  }

  protected chunksToResponse(chunks: Chunk[], model: SelectedModelFor<T>): Response {
    return getResponseFromChunks(chunks, model?.model);
  }

  protected getHandlerGetMethod(
    handler?: ModelHandlerFor<T>
  ): ((request: ImageAnalyzeRequest, ctx: AIContext<T>) => Promise<Response>) | undefined {
    return handler?.imageAnalyze?.get;
  }

  protected getHandlerStreamMethod(
    handler?: ModelHandlerFor<T>
  ): ((request: ImageAnalyzeRequest, ctx: AIContext<T>) => AsyncIterable<Chunk>) | undefined {
    return undefined; // Image analyze doesn't have streaming handler
  }

  protected hasProviderExecutor(selected: SelectedModelFor<T>): boolean {
    return !!selected.provider.createExecutor;
  }

  protected hasProviderStreamer(selected: SelectedModelFor<T>): boolean {
    return !!selected.provider.createStreamer;
  }
}

// ============================================================================
// Image API Facade
// ============================================================================

/**
 * Image API - Facade providing access to generate, edit, and analyze sub-APIs
 */
export class ImageAPI<T extends AIBaseTypes> {
  public readonly generate: ImageGenerateAPI<T>;
  public readonly edit: ImageEditAPI<T>;
  public readonly analyze: ImageAnalyzeAPI<T>;

  constructor(ai: AI<T>) {
    this.generate = new ImageGenerateAPI(ai);
    this.edit = new ImageEditAPI(ai);
    this.analyze = new ImageAnalyzeAPI(ai);
  }
}
