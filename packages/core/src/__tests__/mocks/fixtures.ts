/**
 * Test Fixtures
 *
 * Common test data used across multiple test files.
 */

import { a } from '@aeye/schema';
import type { Message, Request, Response, Chunk, ToolCall } from '../../types';

// ============================================================================
// Messages
// ============================================================================

export const mockUserMessage: Message = {
  role: 'user',
  content: 'Hello, how are you?'
};

export const mockAssistantMessage: Message = {
  role: 'assistant',
  content: 'I am doing well, thank you!'
};

export const mockSystemMessage: Message = {
  role: 'system',
  content: 'You are a helpful assistant.'
};

export const mockMessages: Message[] = [
  mockSystemMessage,
  mockUserMessage,
  mockAssistantMessage
];

export const mockMultimodalMessage: Message = {
  role: 'user',
  content: [
    { type: 'text', content: 'What is in this image?' },
    { type: 'image', content: 'https://example.com/image.jpg' }
  ]
};

// ============================================================================
// Requests
// ============================================================================

export const mockRequest: Request = {
  messages: [mockUserMessage],
  maxTokens: 100,
  temperature: 0.7
};

export const mockRequestWithSystem: Request = {
  messages: [mockSystemMessage, mockUserMessage],
  maxTokens: 100
};

export const mockRequestWithTools: Request = {
  messages: [mockUserMessage],
  tools: [
    {
      name: 'calculator',
      description: 'Performs calculations',
      parameters: a.object({
        operation: a.enum(['add', 'subtract', 'multiply', 'divide']),
        a: a.number(),
        b: a.number()
      }).bind(),
    }
  ]
};

// ============================================================================
// Responses
// ============================================================================

export const mockResponse: Response = {
  content: 'This is a mock response',
  finishReason: 'stop',
  usage: {
    text: { input: 10, output: 20 },
  },
  model: 'mock-model',
};

export const mockResponseWithToolCalls: Response = {
  content: '',
  finishReason: 'tool_calls',
  toolCalls: [
    {
      id: 'call_123',
      name: 'calculator',
      arguments: '{ "operation": "add", "a": 5, "b": 3 }',
    }
  ],
  usage: {
    text: { input: 15, output: 5 },
  },
  model: 'mock-model',
};

export const mockResponseWithRefusal: Response = {
  content: '',
  finishReason: 'stop',
  refusal: 'I cannot help with that request',
  usage: {
    text: { input: 8, output: 12 },
  },
  model: 'mock-model',
};

// ============================================================================
// Chunks
// ============================================================================

export const mockChunks: Chunk[] = [
  { content: 'Hello' },
  { content: ' there' },
  { content: '!', finishReason: 'stop', usage: { text: { input: 5, output: 10 } } }
];

export const mockChunksWithToolCalls: Chunk[] = [
  { content: '' },
  {
    content: '',
    finishReason: 'tool_calls',
    toolCall: {
      id: 'call_456',
      name: 'get_weather',
      arguments: '{ "location": "San Francisco" }'
    },
    usage: { text: { input: 12, output: 8 } }
  }
];

// ============================================================================
// Tool Calls
// ============================================================================

export const mockToolCall: ToolCall = {
  id: 'call_789',
  name: 'search',
  arguments: '{ "query": "typescript testing" }'
};

export const mockToolCalls: ToolCall[] = [
  {
    id: 'call_001',
    name: 'calculator',
    arguments: '{ "operation": "multiply", "a": 6, "b": 7 }'
  },
  {
    id: 'call_002',
    name: 'get_time',
    arguments: '{}'
  }
];

// ============================================================================
// Context
// ============================================================================

export const mockContext = {
  userId: 'user-123',
  sessionId: 'session-456',
  timestamp: new Date('2024-01-01T00:00:00Z')
};

export const mockContextWithExecutor = {
  ...mockContext,
  execute: async () => mockResponse,
  stream: async function* () {
    for (const chunk of mockChunks) {
      yield chunk;
    }
  }
};

// ============================================================================
// Metadata
// ============================================================================

export const mockMetadata = {
  model: 'gpt-4',
  maxTokens: 100,
  temperature: 0.7
};
