/**
 * Mock Provider for AI Package Tests
 *
 * Provides a complete mock implementation of the Provider interface
 * for testing model selection, registry, and AI orchestration.
 */

import type {
  AIMetadataAny,
  AIContextAny,
  Chunk,
  Executor,
  ModelInfo,
  Provider,
  Response,
  Streamer
} from '../../types';

export interface MockProviderOptions {
  name?: string;
  models?: ModelInfo[];
  healthCheck?: boolean;
  generateImageDelay?: number;
  generateImageError?: Error;
}

/**
 * Creates a mock provider with configurable behavior
 */
export const createMockProvider = (options?: MockProviderOptions): Provider => {
  const providerName = options?.name || 'mock';

  return {
    name: providerName,
    config: { apiKey: 'test-key-' + providerName },
    priority: 10,

    async listModels() {
      return options?.models || createMockModels(providerName);
    },

    async checkHealth() {
      return options?.healthCheck ?? true;
    },

    createExecutor(): Executor<AIContextAny, AIMetadataAny> {
      return async (request, ctx, metadata, signal) => {
        if (signal?.aborted) {
          throw new Error('Request aborted');
        }

        return {
          content: `Mock response from ${providerName}`,
          finishReason: 'stop',
          usage: {
            text: { input: 10, output: 20 },
          }
        } as Response;
      };
    },

    createStreamer(): Streamer<AIContextAny, AIMetadataAny> {
      return async function* (request, ctx, metadata, signal) {
        const chunks = [
          { content: 'Hello', finishReason: null },
          { content: ' from ', finishReason: null },
          { content: providerName, finishReason: 'stop', usage: { text: { input: 10, output: 15 } } }
        ];

        for (const chunk of chunks) {
          if (signal?.aborted) {
            throw new Error('Request aborted');
          }
          yield chunk as Chunk;
        }

        return {
          content: chunks.map(c => c.content).join(','),
          finishReason: 'stop',
          model: '',
        }
      };
    },

    async generateImage(request, ctx, config) {
      if (options?.generateImageDelay) {
        await new Promise(resolve => setTimeout(resolve, options.generateImageDelay));
      }

      if (options?.generateImageError) {
        throw options.generateImageError;
      }

      return {
        images: [{
          url: `https://example.com/${providerName}/image-${Date.now()}.png`
        }],
        model: request.model || `${providerName}-image-1`,
        usage: {
          text: { input: 0, output: 0 },
        }
      };
    },

    async *generateImageStream(request, ctx, config) {
      yield { status: 'Generating...', progress: 0.5, done: false };
      yield {
        image: {
          url: `https://example.com/${providerName}/stream-image.png`
        },
        done: true
      };
    },

    async editImage(request, ctx, config) {
      return {
        images: [{
          url: `https://example.com/${providerName}/edited-image.png`
        }],
        model: request.model || `${providerName}-edit-1`,
        usage: {
          text: { input: 0, output: 0 },
        }
      };
    },

    async *editImageStream(request, ctx, config) {
      yield { status: 'Editing...', progress: 0.5, done: false };
      yield {
        image: {
          url: `https://example.com/${providerName}/edited-stream-image.png`
        },
        done: true
      };
    },

    async transcribe(request, ctx, config) {
      return {
        text: `Mock transcription from ${providerName}`,
        model: request.model || `${providerName}-whisper`,
        usage: {
          text: { input: 0, output: 0 },
        }
      };
    },

    async *transcribeStream(request, ctx, config) {
      yield { status: 'Transcribing...', done: false };
      yield {
        text: `Mock transcription from ${providerName}`,
        done: true
      };
    },

    async speech(request, ctx, config) {
      return {
        audio: new ReadableStream(),
        model: request.model || `${providerName}-tts`,
        responseFormat: 'mp3'
      };
    },

    async embed(request, ctx, config) {
      return {
        embeddings: request.texts.map((text, index) => ({
          embedding: Array(1536).fill(0.1),
          index
        })),
        model: request.model || `${providerName}-embed`,
        usage: {
          // Embedding endpoints report usage under `embeddings` rather than
          // `text` — the embed API expects this shape (count + tokens).
          embeddings: {
            count: request.texts.length,
            tokens: request.texts.length * 5,
          },
        }
      };
    }
  };
};

/**
 * Creates a set of mock models for a provider
 */
export function createMockModels(providerName: string): ModelInfo[] {
  return [
    {
      id: `${providerName}-chat-flagship`,
      provider: providerName,
      name: `${providerName} Chat Flagship`,
      capabilities: new Set(['chat', 'streaming', 'vision']),
      tier: 'flagship',
      pricing: {
        text: { input: 10, output: 30 },
      },
      contextWindow: 128000,
      maxOutputTokens: 4096
    },
    {
      id: `${providerName}-chat-efficient`,
      provider: providerName,
      name: `${providerName} Chat Efficient`,
      capabilities: new Set(['chat', 'streaming']),
      tier: 'efficient',
      pricing: {
        text: { input: 0.5, output: 1.5 },
      },
      contextWindow: 32000,
      maxOutputTokens: 4096
    },
    {
      id: `${providerName}-image-1`,
      provider: providerName,
      name: `${providerName} Image Model`,
      capabilities: new Set(['image']),
      tier: 'flagship',
      pricing: {
        text: { input: 20, output: 20 },
      },
      contextWindow: 4096
    },
    {
      id: `${providerName}-embed-1`,
      provider: providerName,
      name: `${providerName} Embedding Model`,
      capabilities: new Set(['embedding']),
      tier: 'efficient',
      pricing: {
        text: { input: 0.2, output: 0 },
      },
      contextWindow: 8192
    }
  ];
}

/**
 * Creates a failing provider for error testing
 */
export const createFailingProvider = (errorMessage: string = 'Provider failed'): Provider => {
  const baseProvider = createMockProvider({ name: 'failing' });

  return {
    ...baseProvider,

    async checkHealth() {
      return false;
    },

    createExecutor() {
      return async () => {
        throw new Error(errorMessage);
      };
    },

    createStreamer() {
      return async function* () {
        throw new Error(errorMessage);
      };
    },

    async generateImage() {
      throw new Error(errorMessage);
    }
  };
};

/**
 * Creates a provider that simulates rate limiting
 */
export const createRateLimitedProvider = (): Provider => {
  let callCount = 0;
  const maxCalls = 3;

  const baseProvider = createMockProvider({ name: 'rate-limited' });

  return {
    ...baseProvider,

    createExecutor() {
      return async (request, ctx, metadata, signal) => {
        callCount++;
        if (callCount > maxCalls) {
          const error: any = new Error('Rate limit exceeded');
          error.status = 429;
          throw error;
        }

        return {
          content: `Call ${callCount} succeeded`,
          finishReason: 'stop',
          usage: { text: { input: 10, output: 20 } }
        } as Response;
      };
    }
  };
};
