/**
 * AWS Bedrock Provider
 *
 * Provider for AWS Bedrock models including Claude, Llama, Titan, Mistral, and more.
 * Uses AWS SDK v3 to automatically pick up credentials from environment, IAM roles, or credential files.
 * All chat LLM calls use the Bedrock Converse API for a unified request/response format across models.
 */

import type {
  AIContextAny,
  AIMetadataAny,
  EmbeddingRequest,
  EmbeddingResponse,
  ImageGenerationRequest,
  ImageGenerationResponse,
  ModelInfo,
  Provider
} from '@aeye/ai';
import { allocateToolDescriptors, buildSchemaBudget, isModelInfo } from '@aeye/ai';
import {
  Chunk,
  type DescriptorFamily,
  describeTool,
  Executor,
  getModel,
  getResponseFromChunks,
  type Model,
  ModelInput,
  type Reasoning,
  forcesTool,
  Request,
  Response,
  type SchemaBudget,
  strictify,
  Streamer,
  toJSONSchema,
  ToolCall,
  withAllowedTools,
} from '@aeye/core';
import {
  BedrockClient,
  BedrockClientConfig,
  ListFoundationModelsCommand
} from '@aws-sdk/client-bedrock';
import {
  BedrockRuntimeClient,
  ConverseCommand,
  ConverseCommandInput,
  ConverseStreamCommand,
  type GuardrailStreamConfiguration,
  InvokeModelCommand,
  Message as BedrockMessage,
  type OutputFormat,
  type PerformanceConfigLatency,
  Tool as BedrockTool,
  ToolChoice as BedrockToolChoice,
} from '@aws-sdk/client-bedrock-runtime';
import { convertAWSModel } from './common';
import {
  contentBlockChunk,
  endChunk,
  streamChunk,
  toAssistantBlocks,
  toBedrockServiceTier,
  toContentBlocks,
  toDocument,
  toReasoningRequest,
  toSystemBlocks,
  toToolResultBlocks,
} from './converse';
import { AWSAuthError, AWSContextWindowError, AWSError, AWSQuotaError, AWSRateLimitError, type ModelFamilyConfig } from './types';

// ============================================================================
// AWS Bedrock Provider Configuration
// ============================================================================

/**
 * Resolve the full ModelInfo for the request when available.
 *
 * BaseAPI injects `selected.model` into `ctx.metadata.model` after model
 * selection; on the standard execution path we read strict-format and
 * reasoning declarations from there. Returns undefined when no ModelInfo is
 * available (the convert call then falls back to LENIENT — silent best-effort).
 */
function pickAwsModelInfo(model: Model, ctx: AIContextAny | undefined): ModelInfo | undefined {
  if (isModelInfo(model)) {
    return model;
  }
  const selected = ctx?.metadata?.model;
  // An inference profile id (e.g. us.anthropic...) ends with the model id
  return selected && isModelInfo(selected) && (selected.id === model.id || model.id.endsWith(`.${selected.id}`))
    ? selected
    : undefined;
}

/**
 * Bedrock errors that mean the credentials aren't accepted.
 */
const AUTH_ERRORS = new Set(['UnrecognizedClientException', 'InvalidSignatureException', 'AccessDeniedException', 'ExpiredTokenException']);

/**
 * Bedrock errors that clear up when retried later.
 */
const RATE_LIMIT_ERRORS = new Set(['ThrottlingException', 'TooManyRequestsException', 'ServiceUnavailableException']);

/**
 * Messages Bedrock models reject an over-long prompt with, such as "Input is
 * too long for requested model" or "prompt is too long: 210000 tokens > 200000
 * maximum".
 */
const CONTEXT_WINDOW_ERROR = /context (length|window)|token limit|too long|too many (input )?tokens/i;

/**
 * The inference profile geography for a region, as profile ids prefix it.
 */
function regionGeography(region: string): string {
  return region.startsWith('us-gov') ? 'us-gov' : region.startsWith('ap-') ? 'apac' : region.split('-')[0];
}

/**
 * Hook called before a request is made to the provider.
 *
 * @template TRequest - The request type
 * @template TCommand - The AWS command type
 * @param request - The request object
 * @param command - The AWS SDK command being sent
 * @param ctx - The context object
 */
export type PreRequestHook<TRequest = any, TCommand = any> = (
  request: TRequest,
  command: TCommand,
  ctx: AIContextAny
) => void | Promise<void>;

/**
 * Hook called after a response is received from the provider.
 *
 * @template TRequest - The request type
 * @template TCommand - The AWS command type
 * @template TResponse - The response type
 * @param request - The request object
 * @param command - The AWS SDK command that was sent
 * @param response - The response object
 * @param ctx - The context object
 */
export type PostRequestHook<TRequest = any, TCommand = any, TResponse = any> = (
  request: TRequest,
  command: TCommand,
  response: TResponse,
  ctx: AIContextAny
) => void | Promise<void>;

/**
 * Hooks for different operation types.
 */
export interface AWSBedrockHooks {
  // Chat completion hooks (using Converse API)
  chat?: {
    beforeRequest?: PreRequestHook<Request, ConverseCommand | ConverseStreamCommand>;
    afterRequest?: PostRequestHook<Request, ConverseCommand | ConverseStreamCommand, Response>;
  };
  // Image generation hooks
  imageGenerate?: {
    beforeRequest?: PreRequestHook<ImageGenerationRequest, InvokeModelCommand>;
    afterRequest?: PostRequestHook<ImageGenerationRequest, InvokeModelCommand, ImageGenerationResponse>;
  };
  // Embedding hooks
  embed?: {
    beforeRequest?: PreRequestHook<EmbeddingRequest, InvokeModelCommand>;
    afterRequest?: PostRequestHook<EmbeddingRequest, InvokeModelCommand, EmbeddingResponse>;
  };
}

/**
 * Configuration options for the AWS Bedrock provider.
 *
 * Credentials are automatically discovered using the AWS SDK credential chain:
 * 1. Environment variables (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY)
 * 2. Shared credentials file (~/.aws/credentials)
 * 3. IAM roles (when running on EC2, ECS, Lambda, etc.)
 *
 * @example
 * ```typescript
 * const config: AWSBedrockConfig = {
 *   region: 'us-east-1', // Optional, defaults to AWS_REGION env var
 *   // Credentials are picked up automatically from environment
 * };
 * ```
 *
 * @example With explicit credentials
 * ```typescript
 * const config: AWSBedrockConfig = {
 *   region: 'us-west-2',
 *   credentials: {
 *     accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
 *     secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
 *   },
 * };
 * ```
 */
export interface AWSBedrockConfig {
  // AWS region (e.g., 'us-east-1', 'us-west-2')
  region?: string;
  // Optional explicit credentials (if not using default credential chain)
  credentials?: {
    accessKeyId?: string;
    secretAccessKey?: string;
    sessionToken?: string;
  };
  // Optional prefix for cross-region inference (e.g., 'us.', 'eu.', 'global.').
  // Without one, models Bedrock serves only through inference profiles use
  // the profile for the region's geography, or the global one.
  modelPrefix?: string;
  // Latency-optimized inference, for models that offer it
  latency?: PerformanceConfigLatency;
  // Guardrail applied to every chat request
  guardrail?: GuardrailStreamConfiguration;
  // Model family configurations
  modelFamilies?: Record<string, ModelFamilyConfig>;
  // Default models for different capabilities
  defaultModels?: {
    chat?: ModelInput;
    imageGenerate?: ModelInput;
    embedding?: ModelInput;
  };
  // Hooks for intercepting requests and responses
  hooks?: AWSBedrockHooks;
}

// ============================================================================
// AWS Bedrock Provider Class
// ============================================================================

/**
 * AWS Bedrock provider implementation for the @aeye framework.
 *
 * Supports the full range of AWS Bedrock capabilities including:
 * - Chat completions with Claude, Llama, Mistral, Cohere, and more
 * - Image generation with Stability AI models
 * - Text embeddings with Amazon Titan
 * - Streaming responses
 *
 * Uses AWS SDK v3 for automatic credential discovery and management.
 *
 * @example Basic usage
 * ```typescript
 * import { AWSBedrockProvider } from '@aeye/aws';
 *
 * const provider = new AWSBedrockProvider({
 *   region: 'us-east-1',
 * });
 *
 * const executor = provider.createExecutor();
 * const response = await executor(
 *   {
 *     messages: [
 *       { role: 'user', content: 'Hello!' }
 *     ]
 *   },
 *   {},
 *   { model: 'anthropic.claude-3-sonnet-20240229-v1:0' }
 * );
 * ```
 */
export class AWSBedrockProvider implements Provider<AWSBedrockConfig> {
  readonly name: string = 'aws-bedrock';
  readonly config: AWSBedrockConfig;
  defaultMetadata?: Provider['defaultMetadata'];

  private bedrockClient: BedrockClient;
  private bedrockRuntimeClient: BedrockRuntimeClient;

  constructor(config: AWSBedrockConfig) {
    this.config = config;
    
    const clientConfig = AWSBedrockProvider.convertConfig(config);

    this.bedrockClient = new BedrockClient(clientConfig);
    this.bedrockRuntimeClient = new BedrockRuntimeClient(clientConfig);
  }

  /**
   * Convert AWSBedrockConfig to BedrockClientConfig
   * 
   * @param config 
   * @returns 
   */
  private static convertConfig(config: AWSBedrockConfig): BedrockClientConfig {
    const clientConfig: BedrockClientConfig = {
      region: config.region || process.env.AWS_REGION || 'us-east-1',
    };
    if (config.credentials && config.credentials.accessKeyId && config.credentials.secretAccessKey) {
      clientConfig.credentials = {
        accessKeyId: config.credentials.accessKeyId,
        secretAccessKey: config.credentials.secretAccessKey,
        sessionToken: config.credentials.sessionToken,
      };
    }
    return clientConfig;
  }

  /**
   * Prepend model prefix if configured
   * 
   * @param modelId - The base model ID
   * @returns Model ID with prefix prepended if configured
   */
  private applyModelPrefix(modelId: string): string {
    if (this.config.modelPrefix) {
      return `${this.config.modelPrefix}${modelId}`;
    }
    return modelId;
  }

  // ============================================================================
  // Provider Interface Implementation
  // ============================================================================

  /**
   * List available models from AWS Bedrock
   */
  async listModels(config?: AWSBedrockConfig): Promise<ModelInfo[]> {
    try {
      const client = config && JSON.stringify(config) !== JSON.stringify(this.config)
        ? new BedrockClient(AWSBedrockProvider.convertConfig(config)) 
        : this.bedrockClient;
      const command = new ListFoundationModelsCommand({});
      const response = await client.send(command);
      
      if (!response.modelSummaries) {
        return [];
      }

      return response.modelSummaries
        .filter(m => m.modelId) // Filter out models without IDs
        .map(m => convertAWSModel(m))
        .filter(m => !!m);
    } catch (error) {
      throw new AWSError('Failed to list models', error as Error);
    }
  }

  /**
   * Check if AWS Bedrock is accessible
   */
  async checkHealth(config?: AWSBedrockConfig): Promise<boolean> {
    
    try {
      const client = config && JSON.stringify(config) !== JSON.stringify(this.config)
        ? new BedrockClient(AWSBedrockProvider.convertConfig(config)) 
        : this.bedrockClient;

      const command = new ListFoundationModelsCommand({});
      await client.send(command);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Create an executor for chat completion requests
   */
  createExecutor(config?: AWSBedrockConfig): Executor<AIContextAny, AIMetadataAny> {
    const effectiveConfig = { ...this.config, ...config };
    const self = this;

    return async (request: Request, ctx: AIContextAny, metadata?: AIMetadataAny): Promise<Response> => {
      const modelInput = request.model || ctx.metadata?.model || metadata?.model || effectiveConfig.defaultModels?.chat;
      if (!modelInput) {
        throw new AWSError('Model is required for AWS Bedrock requests');
      }
      return self.executeWithConverse(modelInput, request, ctx);
    };
  }

  /**
   * Create a streamer for streaming chat completion requests
   */
  createStreamer(config?: AWSBedrockConfig): Streamer<AIContextAny, AIMetadataAny> {
    const effectiveConfig = { ...this.config, ...config };
    const self = this;

    return async function* (
      request: Request,
      ctx: AIContextAny,
      metadata?: AIMetadataAny
    ): AsyncGenerator<Chunk> {
      const modelInput = request.model || ctx.metadata?.model || metadata?.model || effectiveConfig.defaultModels?.chat;
      if (!modelInput) {
        throw new AWSError('Model is required for AWS Bedrock requests');
      }
      yield* self.streamWithConverse(modelInput, request, ctx);
    };
  }

  // ============================================================================
  // Unified Converse API Implementation
  // ============================================================================

  /**
   * The id to call a chat model by. A configured `modelPrefix` picks a
   * cross-region inference profile; otherwise a model Bedrock serves only
   * through inference profiles (per the registry) uses the profile for the
   * client region's geography, or the global one.
   */
  private async resolveModelId(id: string, info: ModelInfo | undefined): Promise<string> {
    const prefix = this.config.modelPrefix;
    if (prefix) {
      return id.startsWith(prefix) ? id : `${prefix}${id}`;
    }
    const listed = info?.metadata?.inRegion === false ? info.metadata.inferenceIds : undefined;
    const profiles = Array.isArray(listed) ? listed.filter((p): p is string => typeof p === 'string') : [];
    if (!profiles.length) {
      return id;
    }
    const geography = regionGeography(await this.bedrockRuntimeClient.config.region());
    return [geography, 'global'].map(g => `${g}.${id}`).find(profile => profiles.includes(profile)) ?? id;
  }

  /**
   * Build the Converse input from a generic @aeye/core Request, without the
   * guardrail, whose shape differs between Converse and ConverseStream.
   */
  private async convertRequestToConverse(model: Model, request: Request, ctx?: AIContextAny): Promise<Omit<ConverseCommandInput, 'guardrailConfig'>> {
    const info = pickAwsModelInfo(model, ctx);
    const modelId = await this.resolveModelId(model.id, info);
    // Built the same way as the OpenAI provider's so strictness selection
    // stays consistent across tools and structured output.
    const budget = buildSchemaBudget(info ?? { id: model.id, provider: this.name }, this.supportedStrictFamilies);
    // Bedrock can't limit which tools a model calls, so only the allowed ones are sent
    const toolConfig = this.convertToolsToConverse(withAllowedTools(request), budget);
    const textFormat = this.convertResponseFormat(request, budget);
    const maxTokens = request.maxTokens ?? (info ?? model).maxOutputTokens;
    const reasoning = toReasoningRequest(modelId, request.reason, info?.reasoningEfforts, maxTokens, forcesTool(request.toolChoice));
    const fields = reasoning.fields || request.extra ? { ...reasoning.fields, ...request.extra } : undefined;

    return {
      modelId,
      messages: await this.convertMessagesToConverse(request),
      system: await toSystemBlocks(request.messages),
      inferenceConfig: {
        maxTokens,
        temperature: request.temperature,
        topP: request.topP,
        stopSequences: request.stop
          ? Array.isArray(request.stop) ? request.stop : [request.stop]
          : undefined,
        ...reasoning.cleared,
      },
      toolConfig,
      outputConfig: textFormat || reasoning.effort ? { textFormat, effort: reasoning.effort } : undefined,
      serviceTier: toBedrockServiceTier(request.serviceTier),
      performanceConfig: this.config.latency && { latency: this.config.latency },
      requestMetadata: request.metadata,
      additionalModelRequestFields: fields,
    };
  }

  /**
   * Execute a non-streaming chat completion using the Converse API.
   */
  private async executeWithConverse(modelInput: ModelInput, request: Request, ctx: AIContextAny): Promise<Response> {
    const params = await this.convertRequestToConverse(getModel(modelInput), request, ctx);
    const guardrail = this.config.guardrail;

    try {
      const command = new ConverseCommand({
        ...params,
        guardrailConfig: guardrail && { guardrailIdentifier: guardrail.guardrailIdentifier, guardrailVersion: guardrail.guardrailVersion, trace: guardrail.trace },
      });

      await this.config.hooks?.chat?.beforeRequest?.(request, command, ctx);

      const response = await this.bedrockRuntimeClient.send(command);
      const result = getResponseFromChunks([
        ...(response.output?.message?.content ?? []).map(contentBlockChunk),
        endChunk(response.stopReason, response.usage, response.serviceTier),
      ], modelInput);

      await this.config.hooks?.chat?.afterRequest?.(request, command, result, ctx);

      return result;
    } catch (error: any) {
      this.handleAWSError(error);
      throw error;
    }
  }

  /**
   * Execute a streaming chat completion using the Converse Stream API.
   */
  private async* streamWithConverse(modelInput: ModelInput, request: Request, ctx: AIContextAny): AsyncGenerator<Chunk> {
    const params = await this.convertRequestToConverse(getModel(modelInput), request, ctx);

    try {
      const command = new ConverseStreamCommand({ ...params, guardrailConfig: this.config.guardrail });

      await this.config.hooks?.chat?.beforeRequest?.(request, command, ctx);

      const response = await this.bedrockRuntimeClient.send(command);

      if (!response.stream) {
        throw new AWSError('No stream in streaming response');
      }

      // Tool calls in progress, by content block index
      const calls = new Map<number, ToolCall>();
      const chunks: Chunk[] = [];
      try {
        for await (const event of response.stream) {
          const chunk = streamChunk(event, calls);
          if (chunk) {
            chunks.push(chunk);
            yield chunk;
          }
        }
      } finally {
        await this.config.hooks?.chat?.afterRequest?.(request, command, getResponseFromChunks(chunks, modelInput), ctx);
      }
    } catch (error: any) {
      this.handleAWSError(error);
      throw error;
    }
  }

  /**
   * Convert @aeye/core messages to AWS Bedrock Converse API message format.
   * Filters out system messages (handled via toSystemBlocks).
   * Merges consecutive messages with the same role as required by the API.
   */
  private async convertMessagesToConverse(request: Request): Promise<BedrockMessage[]> {
    // An assistant turn split across messages replays its reasoning once
    const replayed = new Set<Reasoning>();
    const rawMessages = await Promise.all(request.messages.map(async (msg): Promise<BedrockMessage | undefined> => {
      switch (msg.role) {
        case 'system':
          return undefined;
        case 'user':
          return { role: 'user', content: await toContentBlocks(msg.content) };
        case 'assistant':
          return { role: 'assistant', content: await toAssistantBlocks(msg, replayed) };
        case 'tool':
          return { role: 'user', content: await toToolResultBlocks(msg) };
      }
    }));

    // Merge consecutive messages with the same role (required by Converse API)
    const merged: BedrockMessage[] = [];
    for (const msg of rawMessages) {
      if (!msg?.content?.length) {
        continue;
      }
      const last = merged[merged.length - 1];
      if (last && last.role === msg.role) {
        last.content = [...(last.content ?? []), ...msg.content];
      } else {
        merged.push(msg);
      }
    }

    // Ensure there is at least one user message
    if (merged.length === 0) {
      merged.push({ role: 'user', content: [{ text: 'Perform the requested operation.' }] });
    }

    return merged;
  }

  /**
   * Convert @aeye/core tool definitions to AWS Bedrock Converse API tool format.
   *
   * Strict-tool support is best-effort and per-model: the budget's
   * descriptor comes from `buildSchemaBudget` (see `@aeye/ai`). Bedrock
   * surfaces both Anthropic-family Claude models and (in some regions)
   * OpenAI-shaped tools. Models without strict support use their family's
   * non-strict descriptor, and models without a family Bedrock speaks fall
   * back to LENIENT — silent degradation. Tools with a strict descriptor are
   * sent with Converse's `strict` flag, which constrains the model's calls to
   * the schema. The chosen descriptor is pinned on each
   * `ToolDefinition.descriptor` so the Prompt loop can apply the matching
   * strictify when validating tool arguments.
   *
   * Anthropic enforces per-request limits (20 strict tools, 24 optional
   * params, 16 union types across the whole request) — those are tracked
   * by the shared `SchemaBudget` so over-budget tools degrade to LENIENT
   * silently rather than failing the API call.
   *
   * Converse has no free-text tools, so those go as their one-field function
   * with any grammar in the description. It has no `none` choice either, so
   * tools are left out then, unless the conversation already used them
   * (Converse rejects tool blocks without a tool config).
   */
  private convertToolsToConverse(
    request: Request,
    budget: SchemaBudget,
  ): ConverseCommandInput['toolConfig'] {
    if (!request.tools || request.tools.length === 0) return undefined;
    const choice = request.toolChoice;
    if (choice === 'none' && !request.messages.some(m => m.role === 'tool' || m.toolCalls?.length)) return undefined;

    const descriptors = allocateToolDescriptors(request.tools, budget);

    const tools = request.tools.map((tool, i): BedrockTool => {
      const descriptor = descriptors[i];
      const strictifiedSchema = strictify(tool.parameters, descriptor);
      return {
        toolSpec: {
          name: tool.name,
          description: describeTool(tool),
          inputSchema: {
            json: toDocument(JSON.stringify(toJSONSchema(strictifiedSchema, descriptor))),
          },
          strict: descriptor.strict || undefined,
        },
      };
    });

    const toolChoice: BedrockToolChoice | undefined =
      choice === 'auto' ? { auto: {} }
      : choice === 'required' ? { any: {} }
      : typeof choice === 'object' && 'tool' in choice ? { tool: { name: choice.tool } }
      : undefined;

    return { tools, toolChoice };
  }

  /**
   * Convert a schema response format to Converse structured output. Converse
   * rejects schemas outside its strict subset, so a schema goes only when the
   * model's strict descriptor can shape it; the descriptor is pinned on the
   * format so the Prompt validator can apply the matching strictify. Plain
   * JSON has no Converse mode.
   */
  private convertResponseFormat(request: Request, budget: SchemaBudget): OutputFormat | undefined {
    const format = request.responseFormat;
    if (typeof format !== 'object') return undefined;

    const descriptor = budget.allocateOutput(format.type, format.strict ?? 1);
    if (!descriptor.strict) return undefined;
    format.descriptor = descriptor.id;

    return {
      type: 'json_schema',
      structure: {
        jsonSchema: { name: 'response', schema: JSON.stringify(toJSONSchema(strictify(format.type, descriptor), descriptor)) },
      },
    };
  }

  /**
   * The set of strict descriptor families this provider can speak through
   * Bedrock. Defaults to `['openai', 'anthropic', 'google']` — Bedrock
   * surfaces all three. Subclasses can extend to accept custom registered
   * families.
   */
  protected supportedStrictFamilies: ReadonlySet<DescriptorFamily> = new Set<DescriptorFamily>(['openai', 'anthropic', 'google']);

  // ============================================================================
  // Image Generation (Stability AI)
  // ============================================================================

  generateImage: Provider['generateImage'] = async (request, ctx, config: AWSBedrockConfig) => {
    const effectiveConfig = { ...this.config, ...config };
    const model = getModel(request.model || effectiveConfig.defaultModels?.imageGenerate);
    
    if (!model) {
      throw new AWSError('Model is required for image generation');
    }

    // Parse size string (e.g., "1024x1024")
    let width = 1024;
    let height = 1024;
    if (request.size) {
      const sizeMatch = request.size.match(/^(\d+)x(\d+)$/);
      if (sizeMatch) {
        width = parseInt(sizeMatch[1], 10);
        height = parseInt(sizeMatch[2], 10);
      }
    }

    const body = {
      text_prompts: [
        {
          text: request.prompt,
          weight: 1,
        },
      ],
      cfg_scale: 7,
      steps: 30,
      seed: request.seed,
      width,
      height,
    };

    try {
      const command = new InvokeModelCommand({
        modelId: this.applyModelPrefix(model.id),
        contentType: 'application/json',
        accept: 'application/json',
        body: JSON.stringify(body),
      });

      // Call pre-request hook with command
      await effectiveConfig.hooks?.imageGenerate?.beforeRequest?.(request, command, ctx);

      const response = await this.bedrockRuntimeClient.send(command);
      const responseBody = JSON.parse(new TextDecoder().decode(response.body));

      const images = responseBody.artifacts?.map((artifact: any) => ({
        url: `data:image/png;base64,${artifact.base64}`,
        base64: artifact.base64,
        revisedPrompt: undefined,
      })) || [];

      const result = {
        images,
        model,
      };

      // Call post-request hook with command
      await effectiveConfig.hooks?.imageGenerate?.afterRequest?.(request, command, result, ctx);

      return result;
    } catch (error: any) {
      this.handleAWSError(error);
      throw error;
    }
  };

  // ============================================================================
  // Embeddings (Amazon Titan)
  // ============================================================================

  embed: Provider['embed'] = async (request, ctx, config: AWSBedrockConfig) => {
    const effectiveConfig = { ...this.config, ...config };
    const model = getModel(request.model || effectiveConfig.defaultModels?.embedding);
    
    if (!model) {
      throw new AWSError('Model is required for embeddings');
    }

    // AWS Titan embeddings expect a single text input
    const body = {
      inputText: request.texts[0] || '',
    };

    try {
      const command = new InvokeModelCommand({
        modelId: this.applyModelPrefix(model.id),
        contentType: 'application/json',
        accept: 'application/json',
        body: JSON.stringify(body),
      });

      // Call pre-request hook with command
      await effectiveConfig.hooks?.embed?.beforeRequest?.(request, command, ctx);

      const response = await this.bedrockRuntimeClient.send(command);
      const responseBody = JSON.parse(new TextDecoder().decode(response.body));

      // Handle multiple texts if provided
      const embeddings = request.texts.map(() => responseBody.embedding);

      const result = {
        embeddings,
        model,
        usage: {
          embeddings: {
            tokens: responseBody.inputTextTokenCount ?? -1,
          },
        },
      };

      // Call post-request hook with command
      await effectiveConfig.hooks?.embed?.afterRequest?.(request, command, result, ctx);

      return result;
    } catch (error: any) {
      this.handleAWSError(error);
      throw error;
    }
  };

  // ============================================================================
  // Error Handling
  // ============================================================================

  private handleAWSError(error: any): void {
    const errorName = error.name || '';
    const errorMessage = error.message || '';

    // Authentication errors
    if (AUTH_ERRORS.has(errorName)) {
      throw new AWSAuthError(error);
    }

    // Rate limiting, and capacity that's busy for now
    if (RATE_LIMIT_ERRORS.has(errorName)) {
      throw new AWSRateLimitError('Rate limit exceeded', undefined, error);
    }

    // Quota errors
    if (errorName === 'ServiceQuotaExceededException') {
      throw new AWSQuotaError(error);
    }

    // Context window errors
    if (CONTEXT_WINDOW_ERROR.test(errorMessage)) {
      throw new AWSContextWindowError('Context window exceeded', undefined, error);
    }

    // Re-throw as generic AWS error
    throw new AWSError(errorMessage || 'Unknown AWS Bedrock error', error);
  }
}
