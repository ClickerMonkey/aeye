/**
 * OpenAI Provider Hooks Unit Tests
 *
 * Tests for the provider hook functionality.
 */

import { OpenAIProvider } from '../openai';
import type { Request, Response, ImageGenerationRequest, ImageGenerationResponse, AIContextAny } from '@aeye/ai';
import { AI } from '@aeye/ai';

// Mock the OpenAI SDK
let mockOpenAI: any;
jest.mock('openai', () => {
  return jest.fn().mockImplementation(() => mockOpenAI);
});

const ctxDefault: AIContextAny = { ai: AI.with().providers({}).create({}), metadata: {} };

describe('OpenAIProvider Hooks', () => {
  let provider: OpenAIProvider;
  let beforeRequestHook: jest.Mock;
  let afterRequestHook: jest.Mock;

  beforeEach(() => {
    // Reset mocks
    jest.clearAllMocks();

    // Create mock hooks
    beforeRequestHook = jest.fn();
    afterRequestHook = jest.fn();

    // Create mock OpenAI instance
    mockOpenAI = {
      chat: {
        completions: {
          create: jest.fn()
        }
      },
      images: {
        generate: jest.fn()
      },
      embeddings: {
        create: jest.fn()
      },
      models: {
        list: jest.fn()
      }
    };
  });

  describe('Chat Hooks', () => {
    it('should call pre and post hooks for chat executor', async () => {
      provider = new OpenAIProvider({
        apiKey: 'test-api-key',
        hooks: {
          chat: {
            beforeRequest: beforeRequestHook,
            afterRequest: afterRequestHook
          }
        }
      });

      const request: Request = {
        messages: [{ role: 'user', content: 'Hello' }]
      };

      // Non-streaming executor awaits `create(...)` directly — no
      // `.withResponse()` chain (that's only used by the streaming path).
      mockOpenAI.chat.completions.create.mockResolvedValue({
        choices: [{
          message: { content: 'Hi there!' },
          finish_reason: 'stop'
        }],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15
        }
      });

      const executor = provider.createExecutor();
      const response = await executor(request, ctxDefault, { model: 'gpt-4' });

      // Check that pre-request hook was called with params
      expect(beforeRequestHook).toHaveBeenCalledTimes(1);
      expect(beforeRequestHook).toHaveBeenCalledWith(
        request,
        expect.objectContaining({
          model: 'gpt-4',
          messages: expect.any(Array)
        }),
        ctxDefault,
        { model: 'gpt-4' }
      );

      // Check that post-request hook was called with params
      expect(afterRequestHook).toHaveBeenCalledTimes(1);
      expect(afterRequestHook).toHaveBeenCalledWith(
        request,
        expect.objectContaining({
          model: 'gpt-4',
          messages: expect.any(Array)
        }),
        expect.objectContaining({
          content: 'Hi there!',
          finishReason: 'stop'
        }),
        ctxDefault,
        { model: 'gpt-4' }
      );

      expect(response.content).toBe('Hi there!');
    });

    it('should call pre hook for chat streamer', async () => {
      provider = new OpenAIProvider({
        apiKey: 'test-api-key',
        hooks: {
          chat: {
            beforeRequest: beforeRequestHook,
            afterRequest: afterRequestHook
          }
        }
      });

      const request: Request = {
        messages: [{ role: 'user', content: 'Hello' }]
      };

      // Mock the streaming chat completion response
      const mockStream = {
        [Symbol.asyncIterator]: async function* () {
          yield {
            choices: [{
              delta: { content: 'Hi ' },
              finish_reason: null
            }],
            usage: null
          };
          yield {
            choices: [{
              delta: { content: 'there!' },
              finish_reason: 'stop'
            }],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 5,
              total_tokens: 15
            }
          };
        }
      };

      const mockStreamResponse = {
        withResponse: jest.fn().mockResolvedValue({
          response: { ok: true, headers: new Map() },
          data: mockStream
        })
      };
      mockOpenAI.chat.completions.create.mockReturnValue(mockStreamResponse);

      const streamer = provider.createStreamer();
      const chunks: any[] = [];
      for await (const chunk of streamer(request, ctxDefault, { model: 'gpt-4' })) {
        chunks.push(chunk);
      }

      // Check that pre-request hook was called with params
      expect(beforeRequestHook).toHaveBeenCalledTimes(1);
      expect(beforeRequestHook).toHaveBeenCalledWith(
        request,
        expect.objectContaining({
          model: 'gpt-4',
          messages: expect.any(Array),
          stream: true
        }),
        ctxDefault,
        { model: 'gpt-4' }
      );

      // Check that post-request hook was called after streaming completed with params
      expect(afterRequestHook).toHaveBeenCalledTimes(1);
      expect(afterRequestHook).toHaveBeenCalledWith(
        request,
        expect.objectContaining({
          model: 'gpt-4',
          messages: expect.any(Array),
          stream: true
        }),
        expect.objectContaining({
          content: 'Hi there!',
          finishReason: 'stop'
        }),
        ctxDefault,
        { model: 'gpt-4' }
      );
    });
  });

  describe('Image Generation Hooks', () => {
    it('should call pre and post hooks for image generation', async () => {
      provider = new OpenAIProvider({
        apiKey: 'test-api-key',
        hooks: {
          imageGenerate: {
            beforeRequest: beforeRequestHook,
            afterRequest: afterRequestHook
          }
        }
      });

      const request: ImageGenerationRequest = {
        prompt: 'A beautiful landscape'
      };

      // Mock the image generation response
      mockOpenAI.images.generate.mockResolvedValue({
        data: [{
          url: 'https://example.com/image.png'
        }]
      });

      const response = await provider.generateImage!(request, ctxDefault);

      // Check that pre-request hook was called with params
      expect(beforeRequestHook).toHaveBeenCalledTimes(1);
      expect(beforeRequestHook).toHaveBeenCalledWith(
        request,
        expect.objectContaining({
          model: expect.any(String),
          prompt: 'A beautiful landscape'
        }),
        ctxDefault
      );

      // Check that post-request hook was called with params
      expect(afterRequestHook).toHaveBeenCalledTimes(1);
      expect(afterRequestHook).toHaveBeenCalledWith(
        request,
        expect.objectContaining({
          model: expect.any(String),
          prompt: 'A beautiful landscape'
        }),
        expect.objectContaining({
          images: expect.arrayContaining([
            expect.objectContaining({
              url: 'https://example.com/image.png'
            })
          ])
        }),
        ctxDefault
      );

      expect(response.images[0].url).toBe('https://example.com/image.png');
    });
  });

  describe('Hook Error Handling', () => {
    it('should propagate errors from pre-request hooks', async () => {
      const errorMessage = 'Pre-request hook failed';
      beforeRequestHook.mockRejectedValue(new Error(errorMessage));

      provider = new OpenAIProvider({
        apiKey: 'test-api-key',
        hooks: {
          chat: {
            beforeRequest: beforeRequestHook
          }
        }
      });

      const request: Request = {
        messages: [{ role: 'user', content: 'Hello' }]
      };

      const executor = provider.createExecutor();
      await expect(executor(request, ctxDefault, { model: 'gpt-4' }))
        .rejects.toThrow(errorMessage);

      expect(beforeRequestHook).toHaveBeenCalledTimes(1);
    });
  });

  describe('Hook Omission', () => {
    it('should work without hooks configured', async () => {
      provider = new OpenAIProvider({
        apiKey: 'test-api-key'
      });

      const request: Request = {
        messages: [{ role: 'user', content: 'Hello' }]
      };

      // Non-streaming executor awaits `create(...)` directly — no
      // `.withResponse()` chain (only used by the streaming path).
      mockOpenAI.chat.completions.create.mockResolvedValue({
        choices: [{
          message: { content: 'Hi there!' },
          finish_reason: 'stop'
        }],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15
        }
      });

      const executor = provider.createExecutor();
      const response = await executor(request, ctxDefault, { model: 'gpt-4' });

      expect(response.content).toBe('Hi there!');
    });
  });
});
