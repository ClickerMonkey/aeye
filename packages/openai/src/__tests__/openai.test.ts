/**
 * OpenAI Provider Unit Tests
 *
 * Tests for the OpenAI provider with mocked HTTP calls.
 * No real API calls are made in these tests.
 */

import { OpenAIProvider } from '../openai';
import { type Request, type ImageGenerationRequest, type TranscriptionRequest, type SpeechRequest, type EmbeddingRequest, type AIContextAny, AI } from '@aeye/ai';
import { z } from 'zod';

// Mock the OpenAI SDK
let mockOpenAI: any;
jest.mock('openai', () => {
  return jest.fn().mockImplementation(() => mockOpenAI);
});

const ctxDefault: AIContextAny = { ai: AI.with().providers({}).create({}), metadata: {} };

describe('OpenAIProvider', () => {
  let provider: OpenAIProvider;

  beforeEach(() => {
    // Reset mocks
    jest.clearAllMocks();

    // Create mock OpenAI instance
    mockOpenAI = {
      chat: {
        completions: {
          create: jest.fn()
        }
      },
      images: {
        generate: jest.fn(),
        edit: jest.fn()
      },
      audio: {
        transcriptions: {
          create: jest.fn()
        },
        speech: {
          create: jest.fn()
        }
      },
      embeddings: {
        create: jest.fn()
      },
      models: {
        list: jest.fn()
      }
    };

    provider = new OpenAIProvider({
      apiKey: 'test-api-key'
    });
  });

  describe('Construction and Configuration', () => {
    it('should create provider with config', () => {
      expect(provider).toBeDefined();
      expect(provider.name).toBe('openai');
      expect(provider.config.apiKey).toBe('test-api-key');
    });

    it('should create client with custom base URL', () => {
      const customProvider = new OpenAIProvider({
        apiKey: 'test-key',
        baseURL: 'https://custom.openai.com'
      });

      expect(customProvider).toBeDefined();
    });
  });

  describe('Model Listing', () => {
    it('should list models', async () => {
      mockOpenAI.models.list.mockResolvedValue({
        data: [
          { id: 'gpt-4', created: 1234567890, owned_by: 'openai' },
          { id: 'gpt-3.5-turbo', created: 1234567890, owned_by: 'openai' }
        ]
      });

      const models = await provider.listModels!();

      expect(models).toBeDefined();
      expect(Array.isArray(models)).toBe(true);
      expect(mockOpenAI.models.list).toHaveBeenCalled();
    });

    it('should handle model listing errors', async () => {
      mockOpenAI.models.list.mockRejectedValue(new Error('API Error'));

      await expect(provider.listModels!()).rejects.toThrow('Failed to list models');
    });
  });

  describe('Health Check', () => {
    it('should pass health check when API is available', async () => {
      mockOpenAI.models.list.mockResolvedValue({ data: [] });

      const healthy = await provider.checkHealth();

      expect(healthy).toBe(true);
    });

    it('should fail health check when API is unavailable', async () => {
      mockOpenAI.models.list.mockRejectedValue(new Error('Connection failed'));

      const healthy = await provider.checkHealth();

      expect(healthy).toBe(false);
    });
  });

  describe('Chat Completion', () => {
    describe('Executor', () => {
      it('should create executor', () => {
        const executor = provider.createExecutor();

        expect(executor).toBeDefined();
        expect(typeof executor).toBe('function');
      });

      it('should execute chat completion', async () => {
        mockOpenAI.chat.completions.create.mockResolvedValue({
          id: 'chatcmpl-123',
          choices: [{
            message: {
              role: 'assistant',
              content: 'Hello, world!'
            },
            finish_reason: 'stop'
          }],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 5,
            total_tokens: 15
          }
        });

        const executor = provider.createExecutor();
        const request: Request = {
          messages: [{ role: 'user', content: 'Hello' }],
          maxTokens: 100
        };

        const response = await executor(request, ctxDefault, { model: 'gpt-4' });

        expect(response).toBeDefined();
        expect(response.content).toBe('Hello, world!');
        expect(response.finishReason).toBe('stop');
        expect(response.usage?.text?.input).toBe(10);
        expect(response.usage?.text?.output).toBe(5);
        expect(mockOpenAI.chat.completions.create).toHaveBeenCalled();
      });

      it('should handle tool calls', async () => {
        mockOpenAI.chat.completions.create.mockResolvedValue({
          id: 'chatcmpl-456',
          choices: [{
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [{
                id: 'call_1',
                type: 'function',
                function: {
                  name: 'get_weather',
                  arguments: '{"location":"SF"}'
                }
              }]
            },
            finish_reason: 'tool_calls'
          }],
          usage: {
            prompt_tokens: 20,
            completion_tokens: 10,
            total_tokens: 30
          }
        });

        const executor = provider.createExecutor();
        const request: Request = {
          messages: [{ role: 'user', content: 'What is the weather?' }],
          tools: [{
            name: 'get_weather',
            description: 'Get weather',
            parameters: z.object({
              location: z.string()
            })
          }]
        };

        const response = await executor(request, ctxDefault, { model: 'gpt-4' });

        expect(response.finishReason).toBe('tool_calls');
        expect(response.toolCalls).toBeDefined();
        expect(response.toolCalls).toHaveLength(1);
        expect(response.toolCalls![0].name).toBe('get_weather');
        // ToolCall.arguments is the raw JSON string — the prompt loop parses
        // it with Zod when dispatching to the tool's `call`. The provider
        // doesn't pre-parse.
        expect(response.toolCalls![0].arguments).toBe('{"location":"SF"}');
        expect(JSON.parse(response.toolCalls![0].arguments)).toEqual({ location: 'SF' });
      });

      it('should handle API errors', async () => {
        mockOpenAI.chat.completions.create.mockRejectedValue(new Error('API Error'));

        const executor = provider.createExecutor();
        const request: Request = {
          messages: [{ role: 'user', content: 'Hello' }]
        };

        await expect(executor(request, ctxDefault, { model: 'gpt-4' })).rejects.toThrow();
      });

      it('should handle rate limit errors', async () => {
        const rateLimitError: any = new Error('Rate limit exceeded');
        rateLimitError.status = 429;
        mockOpenAI.chat.completions.create.mockRejectedValue(rateLimitError);

        const executor = provider.createExecutor();
        const request: Request = {
          messages: [{ role: 'user', content: 'Hello' }]
        };

        await expect(executor(request, ctxDefault, { model: 'gpt-4' })).rejects.toThrow();
      });
    });

    describe('Streamer', () => {
      it('should create streamer', () => {
        const streamer = provider.createStreamer();

        expect(streamer).toBeDefined();
        expect(typeof streamer).toBe('function');
      });

      it('should stream chat completion', async () => {
        // Streaming path uses `.create(...).withResponse()` to get both the
        // HTTP response (for ok-check) and the async-iterable stream. Mock
        // both layers.
        const mockStream = {
          [Symbol.asyncIterator]: async function* () {
            yield {
              id: 'chatcmpl-stream',
              choices: [{
                delta: { content: 'Hello' },
                finish_reason: null
              }]
            };
            yield {
              id: 'chatcmpl-stream',
              choices: [{
                delta: { content: ' world' },
                finish_reason: null
              }]
            };
            yield {
              id: 'chatcmpl-stream',
              choices: [{
                delta: {},
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

        mockOpenAI.chat.completions.create.mockReturnValue({
          withResponse: jest.fn().mockResolvedValue({
            response: { ok: true, headers: new Map(), status: 200, statusText: 'OK' },
            data: mockStream,
          }),
        });

        const streamer = provider.createStreamer();
        const request: Request = {
          messages: [{ role: 'user', content: 'Hello' }]
        };

        const chunks = [];
        for await (const chunk of streamer(request, ctxDefault, { model: 'gpt-4' })) {
          chunks.push(chunk);
        }

        expect(chunks.length).toBeGreaterThan(0);
        const callArgs = mockOpenAI.chat.completions.create.mock.calls[0];
        expect(callArgs[0]).toMatchObject({ stream: true });
      });
    });
  });

  describe('Image Generation', () => {
    it('should generate image', async () => {
      mockOpenAI.images.generate.mockResolvedValue({
        data: [{
          url: 'https://example.com/image.png'
        }]
      });

      const request: ImageGenerationRequest = {
        prompt: 'A beautiful sunset'
      };

      const response = await provider.generateImage!(request, ctxDefault);

      expect(response).toBeDefined();
      expect(response.images).toHaveLength(1);
      expect(response.images[0].url).toBe('https://example.com/image.png');
      expect(mockOpenAI.images.generate).toHaveBeenCalled();
    });

    it('should use model from context metadata', async () => {
      mockOpenAI.images.generate.mockResolvedValue({
        data: [{ url: 'https://example.com/image.png' }]
      });

      const request: ImageGenerationRequest = {
        prompt: 'Test'
      };

      const ctx = { metadata: { model: 'dall-e-2' } };

      await provider.generateImage!(request, ctx as any);

      const callArgs1 = mockOpenAI.images.generate.mock.calls[0];
      expect(callArgs1[0]).toMatchObject({ model: 'dall-e-2' });
    });

    it('should prioritize request.model over context', async () => {
      mockOpenAI.images.generate.mockResolvedValue({
        data: [{ url: 'https://example.com/image.png' }]
      });

      const request: ImageGenerationRequest = {
        prompt: 'Test',
        model: 'dall-e-3'
      };

      const ctx = { metadata: { model: 'dall-e-2' } };

      await provider.generateImage!(request, ctx as any);

      const callArgs = mockOpenAI.images.generate.mock.calls[0];
      expect(callArgs[0]).toMatchObject({ model: 'dall-e-3' });
    });

    it('should handle image generation errors', async () => {
      mockOpenAI.images.generate.mockRejectedValue(new Error('Generation failed'));

      const request: ImageGenerationRequest = {
        prompt: 'Test'
      };

      await expect(provider.generateImage!(request, ctxDefault)).rejects.toThrow();
    });

    it('should stream image generation with progress', async () => {
      // generateImageStream awaits `images.generate(...)` and iterates the
      // returned `Stream<ImageGenStreamEvent>` — the mock must be an
      // async-iterable.
      const mockImageStream = {
        [Symbol.asyncIterator]: async function* () {
          yield { type: 'image_generation.partial', b64_json: 'partial-1' };
          yield { type: 'image_generation.partial', b64_json: 'partial-2' };
          yield { type: 'image_generation.completed', b64_json: 'final' };
        }
      };
      mockOpenAI.images.generate.mockResolvedValue(mockImageStream);

      const request: ImageGenerationRequest = {
        prompt: 'Test'
      };

      const chunks = [];
      for await (const chunk of provider.generateImageStream!(request, ctxDefault, provider.config)) {
        chunks.push(chunk);
      }

      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks[chunks.length - 1].done).toBe(true);
    });
  });

  describe('Image Editing', () => {
    it('should edit image', async () => {
      mockOpenAI.images.edit.mockResolvedValue({
        data: [{
          url: 'https://example.com/edited.png'
        }]
      });

      const request = {
        prompt: 'Make it blue',
        image: Buffer.from('fake-image')
      };

      const response = await provider.editImage!(request, ctxDefault);

      expect(response).toBeDefined();
      expect(response.images).toHaveLength(1);
      expect(mockOpenAI.images.edit).toHaveBeenCalled();
    });

    it('should use model from context for editing', async () => {
      mockOpenAI.images.edit.mockResolvedValue({
        data: [{ url: 'https://example.com/edited.png' }]
      });

      const request = {
        prompt: 'Edit',
        image: Buffer.from('fake')
      };

      const ctx = { metadata: { model: 'dall-e-2' } };

      await provider.editImage!(request, ctx as any);

      const callArgs = mockOpenAI.images.edit.mock.calls[0];
      expect(callArgs[0]).toMatchObject({ model: 'dall-e-2' });
    });
  });

  describe('Audio Transcription', () => {
    it('should transcribe audio', async () => {
      mockOpenAI.audio.transcriptions.create.mockResolvedValue({
        text: 'Hello, this is a test transcription'
      });

      const request: TranscriptionRequest = {
        audio: Buffer.from('fake-audio')
      };

      const response = await provider.transcribe!(request, ctxDefault);

      expect(response).toBeDefined();
      expect(response.text).toBe('Hello, this is a test transcription');
      expect(mockOpenAI.audio.transcriptions.create).toHaveBeenCalled();
    });

    it('should use model from context for transcription', async () => {
      mockOpenAI.audio.transcriptions.create.mockResolvedValue({
        text: 'Test'
      });

      const request: TranscriptionRequest = {
        audio: Buffer.from('fake')
      };

      const ctx = { metadata: { model: 'whisper-1' } };

      await provider.transcribe!(request, ctx as any);

      const callArgs = mockOpenAI.audio.transcriptions.create.mock.calls[0];
      expect(callArgs[0]).toMatchObject({ model: 'whisper-1' });
    });
  });

  describe('Text-to-Speech', () => {
    it('should generate speech', async () => {
      const mockStream = new ReadableStream();
      mockOpenAI.audio.speech.create.mockResolvedValue({
        body: mockStream
      });

      const request: SpeechRequest = {
        text: 'Hello, world!'
      };

      const response = await provider.speech!(request, ctxDefault);

      expect(response).toBeDefined();
      expect(response.audio).toBe(mockStream);
      expect(mockOpenAI.audio.speech.create).toHaveBeenCalled();
    });

    it('should use model from context for speech', async () => {
      mockOpenAI.audio.speech.create.mockResolvedValue({
        body: new ReadableStream()
      });

      const request: SpeechRequest = {
        text: 'Test'
      };

      const ctx = { metadata: { model: 'tts-1-hd' } };

      await provider.speech!(request, ctx as any);

      const callArgs = mockOpenAI.audio.speech.create.mock.calls[0];
      expect(callArgs[0]).toMatchObject({ model: 'tts-1-hd' });
    });
  });

  describe('Embeddings', () => {
    it('should generate embeddings', async () => {
      mockOpenAI.embeddings.create.mockResolvedValue({
        data: [
          { embedding: Array(1536).fill(0.1), index: 0 },
          { embedding: Array(1536).fill(0.2), index: 1 }
        ],
        usage: {
          prompt_tokens: 20,
          total_tokens: 20
        }
      });

      const request: EmbeddingRequest = {
        texts: ['Hello', 'World']
      };

      const response = await provider.embed!(request, ctxDefault);

      expect(response).toBeDefined();
      expect(response.embeddings).toHaveLength(2);
      expect(response.embeddings[0].embedding).toHaveLength(1536);
      expect(mockOpenAI.embeddings.create).toHaveBeenCalled();
    });

    it('should use model from context for embeddings', async () => {
      mockOpenAI.embeddings.create.mockResolvedValue({
        data: [{ embedding: Array(1536).fill(0), index: 0 }],
        usage: { prompt_tokens: 10, total_tokens: 10 }
      });

      const request: EmbeddingRequest = {
        texts: ['Test']
      };

      const ctx = { metadata: { model: 'text-embedding-3-large' } };

      await provider.embed!(request, ctx as any);

      const callArgs = mockOpenAI.embeddings.create.mock.calls[0];
      expect(callArgs[0]).toMatchObject({ model: 'text-embedding-3-large' });
    });
  });

  describe('Provider Customization', () => {
    it('should support custom image params', async () => {
      mockOpenAI.images.generate.mockResolvedValue({
        data: [{ url: 'https://example.com/image.png' }]
      });

      class CustomProvider extends OpenAIProvider {
        // augmentImageGenerateRequest mutates params in place — its return
        // value is ignored. The previous version of this test returned a
        // new object, which silently did nothing.
        override augmentImageGenerateRequest(params: any): void {
          params.user = 'test-user';
        }
      }

      const customProvider = new CustomProvider({ apiKey: 'test-key' });

      const request: ImageGenerationRequest = {
        prompt: 'Test'
      };

      await customProvider.generateImage!(request, ctxDefault);

      // Check that customization was applied
      const callArgs = mockOpenAI.images.generate.mock.calls;
      const lastCall = callArgs[callArgs.length - 1];
      expect(lastCall[0]).toHaveProperty('user', 'test-user');
    });
  });

  describe('Message Conversion', () => {
    it('should handle tool messages', async () => {
      mockOpenAI.chat.completions.create.mockResolvedValue({
        id: 'test-id',
        choices: [{
          message: {
            role: 'assistant',
            content: 'Tool result processed'
          },
          finish_reason: 'stop'
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
      });

      const executor = provider.createExecutor();
      const request: Request = {
        messages: [
          { role: 'user', content: 'Call tool' },
          { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'get_weather', arguments: '{"location":"SF"}' }] },
          { role: 'tool', toolCallId: 'call_1', content: '{"temp": 72}' }
        ]
      };

      const response = await executor(request, ctxDefault, { model: 'gpt-4' });

      expect(response).toBeDefined();
      expect(mockOpenAI.chat.completions.create).toHaveBeenCalled();
    });

    it('should handle system messages', async () => {
      mockOpenAI.chat.completions.create.mockResolvedValue({
        id: 'test-id',
        choices: [{
          message: { role: 'assistant', content: 'Response' },
          finish_reason: 'stop'
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
      });

      const executor = provider.createExecutor();
      const request: Request = {
        messages: [
          { role: 'system', content: 'You are helpful' },
          { role: 'user', content: 'Hello' }
        ]
      };

      const response = await executor(request, ctxDefault, { model: 'gpt-4' });

      expect(response).toBeDefined();
    });

    it('should handle multi-part content', async () => {
      mockOpenAI.chat.completions.create.mockResolvedValue({
        id: 'test-id',
        choices: [{
          message: { role: 'assistant', content: 'I see the image' },
          finish_reason: 'stop'
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
      });

      const executor = provider.createExecutor();
      const request: Request = {
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', content: 'What is in this image?' },
              { type: 'image', content: 'https://example.com/image.png' }
            ]
          }
        ]
      };

      const response = await executor(request, ctxDefault, { model: 'gpt-4-vision-preview' });

      expect(response).toBeDefined();
    });

    it('should handle assistant messages with tool calls', async () => {
      mockOpenAI.chat.completions.create.mockResolvedValue({
        id: 'test-id',
        choices: [{
          message: { role: 'assistant', content: 'Using tools' },
          finish_reason: 'stop'
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
      });

      const executor = provider.createExecutor();
      const request: Request = {
        messages: [
          {
            role: 'assistant',
            content: '',
            toolCalls: [
              { id: 'call_1', name: 'search', arguments: '{"query":"test"}' }
            ]
          }
        ]
      };

      const response = await executor(request, ctxDefault, { model: 'gpt-4' });

      expect(response).toBeDefined();
    });
  });

  describe('Tool Handling', () => {
    it('should convert tools with parameters', async () => {
      mockOpenAI.chat.completions.create.mockResolvedValue({
        id: 'test-id',
        choices: [{
          message: { role: 'assistant', content: 'Done' },
          finish_reason: 'stop'
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
      });

      const executor = provider.createExecutor();
      const request: Request = {
        messages: [{ role: 'user', content: 'Use tool' }],
        tools: [{
          name: 'get_weather',
          description: 'Get weather',
          parameters: z.object({
            location: z.string(),
            unit: z.enum(['celsius', 'fahrenheit'])
          })
        }]
      };

      const response = await executor(request, ctxDefault, { model: 'gpt-4' });

      expect(response).toBeDefined();
      const callArgs = mockOpenAI.chat.completions.create.mock.calls;
      const lastCall = callArgs[callArgs.length - 1][0];
      expect(lastCall.tools).toBeDefined();
      expect(lastCall.tools).toHaveLength(1);
    });

    it('should handle toolChoice parameter', async () => {
      mockOpenAI.chat.completions.create.mockResolvedValue({
        id: 'test-id',
        choices: [{
          message: { role: 'assistant', content: 'Done' },
          finish_reason: 'stop'
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
      });

      const executor = provider.createExecutor();
      const request: Request = {
        messages: [{ role: 'user', content: 'Use tool' }],
        tools: [{
          name: 'get_weather',
          description: 'Get weather',
          parameters: z.object({ location: z.string() })
        }],
        toolChoice: 'required'
      };

      const response = await executor(request, ctxDefault, { model: 'gpt-4' });

      expect(response).toBeDefined();
      const callArgs = mockOpenAI.chat.completions.create.mock.calls;
      const lastCall = callArgs[callArgs.length - 1][0];
      expect(lastCall.tool_choice).toBe('required');
    });

    it('should handle specific tool choice', async () => {
      mockOpenAI.chat.completions.create.mockResolvedValue({
        id: 'test-id',
        choices: [{
          message: { role: 'assistant', content: 'Done' },
          finish_reason: 'stop'
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
      });

      const executor = provider.createExecutor();
      const request: Request = {
        messages: [{ role: 'user', content: 'Use specific tool' }],
        tools: [{
          name: 'get_weather',
          description: 'Get weather',
          parameters: z.object({ location: z.string() })
        }],
        toolChoice: { tool: 'get_weather' }
      };

      const response = await executor(request, ctxDefault, { model: 'gpt-4' });

      expect(response).toBeDefined();
    });
  });

  describe('Response Format', () => {
    it('should handle JSON response format', async () => {
      mockOpenAI.chat.completions.create.mockResolvedValue({
        id: 'test-id',
        choices: [{
          message: { role: 'assistant', content: '{"result": "data"}' },
          finish_reason: 'stop'
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
      });

      const executor = provider.createExecutor();
      const request: Request = {
        messages: [{ role: 'user', content: 'Return JSON' }],
        responseFormat: { type: z.object({ result: z.string() }), strict: true }
      };

      const response = await executor(request, ctxDefault, { model: 'gpt-4' });

      expect(response).toBeDefined();
      const callArgs = mockOpenAI.chat.completions.create.mock.calls;
      const lastCall = callArgs[callArgs.length - 1][0];
      expect(lastCall.response_format).toBeDefined();
    });

    it('should handle text response format', async () => {
      mockOpenAI.chat.completions.create.mockResolvedValue({
        id: 'test-id',
        choices: [{
          message: { role: 'assistant', content: 'Plain text' },
          finish_reason: 'stop'
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
      });

      const executor = provider.createExecutor();
      const request: Request = {
        messages: [{ role: 'user', content: 'Hello' }],
        responseFormat: 'text'
      };

      const response = await executor(request, ctxDefault, { model: 'gpt-4' });

      expect(response).toBeDefined();
    });
  });

  describe('Streaming with Tools', () => {
    it('should stream tool calls', async () => {
      const mockStream = {
        [Symbol.asyncIterator]: async function* () {
          yield {
            id: 'chatcmpl-stream',
            choices: [{
              delta: {
                tool_calls: [{
                  index: 0,
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'get_weather', arguments: '' }
                }]
              },
              finish_reason: null
            }]
          };
          yield {
            id: 'chatcmpl-stream',
            choices: [{
              delta: {
                tool_calls: [{
                  index: 0,
                  function: { arguments: '{"location"' }
                }]
              },
              finish_reason: null
            }]
          };
          yield {
            id: 'chatcmpl-stream',
            choices: [{
              delta: {
                tool_calls: [{
                  index: 0,
                  function: { arguments: ':"SF"}' }
                }]
              },
              finish_reason: 'tool_calls'
            }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
          };
        }
      };

      // Streaming uses `.create(...).withResponse()` to get the HTTP
      // response + the iterable stream.
      mockOpenAI.chat.completions.create.mockReturnValue({
        withResponse: jest.fn().mockResolvedValue({
          response: { ok: true, headers: new Map(), status: 200, statusText: 'OK' },
          data: mockStream,
        }),
      });

      const streamer = provider.createStreamer();
      const request: Request = {
        messages: [{ role: 'user', content: 'Get weather' }],
        tools: [{
          name: 'get_weather',
          description: 'Get weather',
          parameters: z.object({ location: z.string() })
        }]
      };

      const chunks = [];
      for await (const chunk of streamer(request, {}, { model: 'gpt-4' })) {
        chunks.push(chunk);
      }

      expect(chunks.length).toBeGreaterThan(0);
      const hasToolCall = chunks.some(c => c.toolCall);
      expect(hasToolCall).toBe(true);
    });
  });

  describe('Additional Parameters', () => {
    it('should handle temperature parameter', async () => {
      mockOpenAI.chat.completions.create.mockResolvedValue({
        id: 'test-id',
        choices: [{
          message: { role: 'assistant', content: 'Response' },
          finish_reason: 'stop'
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
      });

      const executor = provider.createExecutor();
      const request: Request = {
        messages: [{ role: 'user', content: 'Hello' }],
        temperature: 0.7
      };

      const response = await executor(request, ctxDefault, { model: 'gpt-4' });

      expect(response).toBeDefined();
      const callArgs = mockOpenAI.chat.completions.create.mock.calls;
      const lastCall = callArgs[callArgs.length - 1][0];
      expect(lastCall.temperature).toBe(0.7);
    });

    it('should handle maxTokens parameter', async () => {
      mockOpenAI.chat.completions.create.mockResolvedValue({
        id: 'test-id',
        choices: [{
          message: { role: 'assistant', content: 'Response' },
          finish_reason: 'stop'
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
      });

      const executor = provider.createExecutor();
      const request: Request = {
        messages: [{ role: 'user', content: 'Hello' }],
        maxTokens: 100
      };

      const response = await executor(request, ctxDefault, { model: 'gpt-4' });

      expect(response).toBeDefined();
      const callArgs = mockOpenAI.chat.completions.create.mock.calls;
      const lastCall = callArgs[callArgs.length - 1][0];
      // The OpenAI SDK uses `max_completion_tokens` (not legacy `max_tokens`)
      // since the o-series models added support for it; the provider sends
      // request.maxTokens through that field.
      expect(lastCall.max_completion_tokens).toBe(100);
    });

    it('should handle topP parameter', async () => {
      mockOpenAI.chat.completions.create.mockResolvedValue({
        id: 'test-id',
        choices: [{
          message: { role: 'assistant', content: 'Response' },
          finish_reason: 'stop'
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
      });

      const executor = provider.createExecutor();
      const request: Request = {
        messages: [{ role: 'user', content: 'Hello' }],
        topP: 0.9
      };

      const response = await executor(request, ctxDefault, { model: 'gpt-4' });

      expect(response).toBeDefined();
      const callArgs = mockOpenAI.chat.completions.create.mock.calls;
      const lastCall = callArgs[callArgs.length - 1][0];
      expect(lastCall.top_p).toBe(0.9);
    });
  });
});
