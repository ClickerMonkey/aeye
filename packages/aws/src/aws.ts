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
import { isModelInfo, resolveStrictFormat } from '@aeye/ai';
import {
  Chunk,
  type DescriptorFamily,
  Executor,
  FinishReason,
  type FormatDescriptor,
  getDescriptor,
  getModel,
  LENIENT,
  ModelInput,
  Request,
  Response,
  SchemaBudget,
  strictestOf,
  strictify,
  strictPriority,
  Streamer,
  toJSONSchema,
  ToolCall,
} from '@aeye/core';
import {
  BedrockClient,
  BedrockClientConfig,
  ListFoundationModelsCommand
} from '@aws-sdk/client-bedrock';
import {
  BedrockRuntimeClient,
  ContentBlock,
  ConverseCommand,
  ConverseCommandInput,
  ConverseStreamCommand,
  ConverseStreamCommandInput,
  ImageFormat,
  InvokeModelCommand,
  Message as BedrockMessage,
  SystemContentBlock,
  Tool as BedrockTool,
  ToolChoice as BedrockToolChoice,
} from '@aws-sdk/client-bedrock-runtime';
import { convertAWSModel } from './common';
import { AWSAuthError, AWSContextWindowError, AWSError, AWSQuotaError, AWSRateLimitError, type ModelFamilyConfig } from './types';

// ============================================================================
// AWS Bedrock Provider Configuration
// ============================================================================

/**
 * Resolve the full ModelInfo for the request when available.
 *
 * BaseAPI injects `selected.model` into `ctx.metadata.model` after model
 * selection; on the standard execution path we read strict-format
 * declarations from there. Returns undefined when no ModelInfo is available
 * (the convert call then falls back to LENIENT — silent best-effort).
 */
function pickAwsModelInfo(ctx: AIContextAny | undefined, modelId: string): ModelInfo | undefined {
  const candidates = [ctx?.metadata?.model];
  for (const c of candidates) {
    if (c && typeof c === 'object' && isModelInfo(c)) {
      // The Bedrock provider applies a model prefix at request build time
      // (e.g. arn:aws:...) so the modelId we see here may not match the
      // ModelInfo.id verbatim. Accept by suffix match for safety.
      if (c.id === modelId || modelId.endsWith(c.id)) {
        return c as ModelInfo;
      }
    }
  }
  return undefined;
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
  // Optional prefix for cross-region inference (e.g., 'us.', 'eu.')
  modelPrefix?: string;
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

/**
 * A recursive JSON-compatible value type matching AWS SDK's internal DocumentType.
 * Used for tool inputs and additional model request fields.
 */
type JsonDocument = null | boolean | number | string | JsonDocument[] | { [key: string]: JsonDocument };

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
   * Build a ConverseCommandInput from a generic @aeye/core Request.
   */
  private convertRequestToConverse(modelId: string, request: Request, ctx?: AIContextAny): ConverseCommandInput {
    const messages = this.convertMessagesToConverse(request);
    const system = this.convertSystemToConverse(request);
    const modelInfo = pickAwsModelInfo(ctx, modelId);
    // Bedrock's Converse API has no separate structured-output endpoint, so
    // the budget only needs to cover tool schemas. We still build it through
    // the same helper so the strictness selection stays consistent with the
    // OpenAI provider and any future structured-output extension.
    const budget = this.buildSchemaBudget(modelInfo);
    const toolConfig = this.convertToolsToConverse(request, modelInfo, budget);
    const model = getModel(request.model);
    const maxTokens = request.maxTokens ?? (typeof model !== 'string' && model?.maxOutputTokens ? model.maxOutputTokens : undefined);

    return {
      modelId,
      messages,
      system,
      inferenceConfig: {
        maxTokens,
        temperature: request.temperature,
        topP: request.topP,
        stopSequences: request.stop
          ? Array.isArray(request.stop) ? request.stop : [request.stop]
          : undefined,
      },
      toolConfig,
      additionalModelRequestFields: request.extra,
    };
  }

  /**
   * Execute a non-streaming chat completion using the Converse API.
   */
  private async executeWithConverse(modelInput: ModelInput, request: Request, ctx: AIContextAny): Promise<Response> {
    const model = getModel(modelInput);
    const modelId = this.applyModelPrefix(model.id);
    const params = this.convertRequestToConverse(modelId, request, ctx);

    try {
      const command = new ConverseCommand(params);

      await this.config.hooks?.chat?.beforeRequest?.(request, command, ctx);

      const response = await this.bedrockRuntimeClient.send(command);

      let content = '';
      let reasoning: string | undefined;
      const toolCalls: ToolCall[] = [];

      const outputMessage = response.output?.message;
      if (outputMessage?.content) {
        for (const block of outputMessage.content) {
          if ('text' in block && block.text !== undefined) {
            content += block.text;
          } else if ('toolUse' in block && block.toolUse) {
            toolCalls.push({
              id: block.toolUse.toolUseId!,
              name: block.toolUse.name!,
              arguments: JSON.stringify(block.toolUse.input ?? {}),
            });
          } else if ('reasoningContent' in block && block.reasoningContent) {
            const rc = block.reasoningContent;
            if ('reasoningText' in rc && rc.reasoningText) {
              reasoning = (reasoning ?? '') + rc.reasoningText.text;
            }
          }
        }
      }

      const result: Response = {
        content,
        reasoning: reasoning !== undefined ? { content: reasoning } : undefined,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        finishReason: this.mapStopReason(response.stopReason),
        model: modelInput,
        usage: {
          text: {
            input: response.usage?.inputTokens ?? -1,
            output: response.usage?.outputTokens ?? -1,
          },
        },
      };

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
    const model = getModel(modelInput);
    const modelId = this.applyModelPrefix(model.id);
    const params = this.convertRequestToConverse(modelId, request, ctx) as ConverseStreamCommandInput;

    try {
      const command = new ConverseStreamCommand(params);

      await this.config.hooks?.chat?.beforeRequest?.(request, command, ctx);

      const response = await this.bedrockRuntimeClient.send(command);

      if (!response.stream) {
        throw new AWSError('No stream in streaming response');
      }

      let inputTokens = 0;
      let outputTokens = 0;
      let accumulatedContent = '';
      let finishReason: FinishReason = 'stop';

      type ToolCallItem = { id: string; name: string; arguments: string; finished: boolean };
      const toolCallsMap = new Map<number, ToolCallItem>();

      try {
        for await (const event of response.stream) {
          if (event.contentBlockDelta?.delta) {
            const delta = event.contentBlockDelta.delta;
            const index = event.contentBlockDelta.contentBlockIndex ?? 0;

            if ('text' in delta && delta.text !== undefined) {
              accumulatedContent += delta.text;
              yield { content: delta.text };
            } else if ('toolUse' in delta && delta.toolUse?.input !== undefined) {
              const toolCall = toolCallsMap.get(index);
              if (toolCall) {
                toolCall.arguments += delta.toolUse.input;
                yield {
                  toolCallArguments: {
                    id: toolCall.id,
                    name: toolCall.name,
                    arguments: toolCall.arguments,
                  },
                };
              }
            } else if ('reasoningContent' in delta && delta.reasoningContent) {
              const rc = delta.reasoningContent;
              if ('text' in rc && rc.text !== undefined) {
                yield { reasoning: { content: rc.text } };
              }
            }
          } else if (event.contentBlockStart?.start) {
            const start = event.contentBlockStart.start;
            const index = event.contentBlockStart.contentBlockIndex ?? 0;

            if ('toolUse' in start && start.toolUse) {
              const toolCall: ToolCallItem = {
                id: start.toolUse.toolUseId!,
                name: start.toolUse.name!,
                arguments: '',
                finished: false,
              };
              toolCallsMap.set(index, toolCall);
              yield {
                toolCallNamed: {
                  id: toolCall.id,
                  name: toolCall.name,
                  arguments: '',
                },
              };
            }
          } else if (event.contentBlockStop) {
            const index = event.contentBlockStop.contentBlockIndex ?? 0;
            const toolCall = toolCallsMap.get(index);
            if (toolCall && !toolCall.finished) {
              toolCall.finished = true;
              yield {
                toolCall: {
                  id: toolCall.id,
                  name: toolCall.name,
                  arguments: toolCall.arguments,
                },
              };
            }
          } else if (event.messageStop) {
            finishReason = this.mapStopReason(event.messageStop.stopReason);
            yield { finishReason };
          } else if (event.metadata?.usage) {
            inputTokens = event.metadata.usage.inputTokens ?? 0;
            outputTokens = event.metadata.usage.outputTokens ?? 0;
            yield {
              usage: {
                text: {
                  input: inputTokens,
                  output: outputTokens,
                },
              },
            };
          }
        }
      } finally {
        const toolCalls = Array.from(toolCallsMap.values()).map(tc => ({
          id: tc.id,
          name: tc.name,
          arguments: tc.arguments,
        }));

        const accumulatedResponse: Response = {
          content: accumulatedContent,
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
          finishReason,
          model: modelInput,
          usage: {
            text: {
              input: inputTokens,
              output: outputTokens,
            },
          },
        };

        await this.config.hooks?.chat?.afterRequest?.(request, command, accumulatedResponse, ctx);
      }
    } catch (error: any) {
      this.handleAWSError(error);
      throw error;
    }
  }

  /**
   * Convert system messages to the Converse API system format.
   */
  private convertSystemToConverse(request: Request): SystemContentBlock[] | undefined {
    const systemMessages = request.messages.filter(m => m.role === 'system');
    if (systemMessages.length === 0) return undefined;

    return systemMessages.map((m): SystemContentBlock => ({
      text: typeof m.content === 'string'
        ? m.content
        : m.content.map(c => String(c.content)).join('\n'),
    }));
  }

  /**
   * Convert @aeye/core messages to AWS Bedrock Converse API message format.
   * Filters out system messages (handled via convertSystemToConverse).
   * Merges consecutive messages with the same role as required by the API.
   */
  private convertMessagesToConverse(request: Request): BedrockMessage[] {
    const rawMessages: BedrockMessage[] = [];

    for (const msg of request.messages) {
      if (msg.role === 'system') continue;

      if (msg.role === 'user') {
        const content: ContentBlock[] = [];
        if (typeof msg.content === 'string') {
          if (msg.content.trim()) {
            content.push({ text: msg.content });
          }
        } else {
          for (const part of msg.content) {
            if (part.type === 'text') {
              if (String(part.content).trim()) {
                content.push({ text: String(part.content) });
              }
            } else if (part.type === 'image') {
              const imageBlock = this.convertImageContent(part.content);
              if (imageBlock) {
                content.push(imageBlock);
              }
            }
          }
        }
        if (content.length > 0) {
          rawMessages.push({ role: 'user', content });
        }
      } else if (msg.role === 'assistant') {
        const content: ContentBlock[] = [];
        if (msg.content && typeof msg.content === 'string' && msg.content.trim()) {
          content.push({ text: msg.content });
        }
        if (msg.toolCalls && msg.toolCalls.length > 0) {
          for (const tc of msg.toolCalls) {
            let input: Record<string, unknown> = {};
            try {
              input = JSON.parse(tc.arguments);
            } catch {
              input = { _raw: tc.arguments };
            }
            content.push({
              toolUse: {
                toolUseId: tc.id,
                name: tc.name,
                input: input as unknown as JsonDocument,
              },
            });
          }
        }
        if (content.length > 0) {
          rawMessages.push({ role: 'assistant', content });
        }
      } else if (msg.role === 'tool') {
        rawMessages.push({
          role: 'user',
          content: [
            {
              toolResult: {
                toolUseId: msg.toolCallId!,
                content: [
                  {
                    text: typeof msg.content === 'string'
                      ? msg.content
                      : JSON.stringify(msg.content),
                  },
                ],
              },
            },
          ],
        });
      }
    }

    // Merge consecutive messages with the same role (required by Converse API)
    const merged: BedrockMessage[] = [];
    for (const msg of rawMessages) {
      const last = merged[merged.length - 1];
      if (last && last.role === msg.role) {
        last.content = [...(last.content ?? []), ...(msg.content ?? [])];
      } else {
        merged.push({ role: msg.role, content: [...(msg.content ?? [])] });
      }
    }

    // Ensure there is at least one user message
    if (merged.length === 0) {
      merged.push({ role: 'user', content: [{ text: 'Perform the requested operation.' }] });
    }

    return merged;
  }

  /**
   * Convert an image content value to a Converse API ContentBlock.
   * Only base64 data URIs are natively supported; URL images are not supported
   * by the Converse API without fetching the bytes first.
   */
  private convertImageContent(content: string | URL | unknown): ContentBlock | null {
    const src = content instanceof URL ? content.href : typeof content === 'string' ? content : null;
    if (!src) return null;

    // data URI: data:<mediaType>;base64,<data>
    const match = src.match(/^data:([^;]+);base64,(.+)$/);
    if (match) {
      const mediaType = match[1].toLowerCase();
      const format = (
        mediaType.includes('png') ? 'png' :
        mediaType.includes('jpeg') || mediaType.includes('jpg') ? 'jpeg' :
        mediaType.includes('gif') ? 'gif' :
        mediaType.includes('webp') ? 'webp' : null
      ) as ImageFormat | null;

      if (format) {
        const bytes = Buffer.from(match[2], 'base64');
        return { image: { format, source: { bytes } } };
      }
    }

    // URL images are not natively supported by the Converse API
    return null;
  }

  /**
   * Convert @aeye/core tool definitions to AWS Bedrock Converse API tool format.
   *
   * Strict-tool support is best-effort and per-model: the descriptor is
   * picked via `resolveStrictFormat(model)`, which falls back through
   * `model.strictFormat` → `model.provider` → `id` prefix. Bedrock
   * surfaces both Anthropic-family Claude models and (in some regions)
   * OpenAI-shaped tools. Models without a declared family fall back to
   * LENIENT — silent degradation. The chosen descriptor is pinned on each
   * `ToolDefinition.descriptor` so the Prompt loop can apply the matching
   * strictify when validating tool arguments.
   *
   * Anthropic enforces per-request limits (20 strict tools, 24 optional
   * params, 16 union types across the whole request) — those are tracked
   * by the shared `SchemaBudget` so over-budget tools degrade to LENIENT
   * silently rather than failing the API call.
   */
  private convertToolsToConverse(
    request: Request,
    model?: ModelInfo,
    budget?: SchemaBudget,
  ): ConverseCommandInput['toolConfig'] {
    if (!request.tools || request.tools.length === 0) return undefined;

    const localBudget = budget ?? this.buildSchemaBudget(model);

    // Allocate descriptors in descending-priority order so the most-wanted
    // strict tools consume budget first, then emit in original order.
    const order = request.tools
      .map((t, i) => ({ i, p: strictPriority(t.strict) }))
      .sort((a, b) => b.p - a.p);
    const descriptors: FormatDescriptor[] = new Array(request.tools.length);
    for (const { i } of order) {
      const tool = request.tools[i];
      descriptors[i] = localBudget.allocateTool(tool.parameters, tool.strict);
      tool.descriptor = descriptors[i].id;
    }

    const tools = request.tools.map((tool, i) => {
      const descriptor = descriptors[i];
      const strictifiedSchema = strictify(tool.parameters, descriptor);
      return {
        toolSpec: {
          name: tool.name,
          description: tool.description,
          inputSchema: {
            json: toJSONSchema(strictifiedSchema, descriptor) as unknown as JsonDocument,
          },
        },
      };
    }) as BedrockTool[];

    let toolChoice: BedrockToolChoice | undefined;
    if (request.toolChoice === 'auto') {
      toolChoice = { auto: {} };
    } else if (request.toolChoice === 'required') {
      toolChoice = { any: {} };
    } else if (typeof request.toolChoice === 'object' && request.toolChoice !== null) {
      toolChoice = { tool: { name: request.toolChoice.tool } };
    }

    return { tools, toolChoice };
  }

  /**
   * The set of strict descriptor families this provider can speak through
   * Bedrock. Defaults to `['openai', 'anthropic', 'google']` — Bedrock
   * surfaces all three. Subclasses can extend to accept custom registered
   * families.
   */
  protected supportedStrictFamilies: ReadonlySet<DescriptorFamily> = new Set<DescriptorFamily>(['openai', 'anthropic', 'google']);

  /**
   * Build a SchemaBudget tuned to the resolved strict-format family.
   * Bedrock surfaces multiple model families; the descriptor pick handles
   * any in `supportedStrictFamilies`. Mismatched families fall back to
   * LENIENT silently.
   */
  private buildSchemaBudget(model?: ModelInfo): SchemaBudget {
    const family = model ? resolveStrictFormat(model) : undefined;
    const familySupported = family !== undefined && this.supportedStrictFamilies.has(family);
    const tools = familySupported && model!.capabilities.has('toolsStrict')
      ? getDescriptor(family, true)
      : LENIENT;
    const out = familySupported && model!.capabilities.has('structured')
      ? getDescriptor(family, true)
      : LENIENT;
    return new SchemaBudget(strictestOf(tools, out));
  }

  /**
   * Map a Bedrock Converse API stop reason to the @aeye/core FinishReason type.
   */
  private mapStopReason(stopReason: string | undefined): FinishReason {
    switch (stopReason) {
      case 'end_turn':
        return 'stop';
      case 'max_tokens':
      case 'model_context_window_exceeded':
        return 'length';
      case 'stop_sequence':
        return 'stop';
      case 'tool_use':
        return 'tool_calls';
      case 'content_filtered':
        return 'content_filter';
      default:
        return 'stop';
    }
  }

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
    if (errorName === 'UnrecognizedClientException' || errorName === 'InvalidSignatureException') {
      throw new AWSAuthError(error);
    }

    // Rate limiting
    if (errorName === 'ThrottlingException' || errorName === 'TooManyRequestsException') {
      throw new AWSRateLimitError('Rate limit exceeded', undefined, error);
    }

    // Quota errors
    if (errorName === 'ServiceQuotaExceededException') {
      throw new AWSQuotaError(error);
    }

    // Context window errors
    if (errorMessage.includes('context length') || errorMessage.includes('token limit')) {
      throw new AWSContextWindowError('Context window exceeded', undefined, error);
    }

    // Re-throw as generic AWS error
    throw new AWSError(errorMessage || 'Unknown AWS Bedrock error', error);
  }
}
