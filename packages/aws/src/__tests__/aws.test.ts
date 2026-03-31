/**
 * AWS Bedrock Provider Tests
 * 
 * Note: These tests verify the provider structure without making actual AWS API calls.
 * For integration tests with real AWS credentials, see __integration__ tests.
 */

import { AWSBedrockProvider, type AWSBedrockConfig } from '../aws';
import { AWSError, AWSAuthError, AWSRateLimitError } from '../types';
import { detectAWSCapabilities, detectAWSFamily, detectAWSTier } from '../common';
import { FoundationModelSummary } from '@aws-sdk/client-bedrock';

describe('AWSBedrockProvider Types', () => {
  describe('Error classes', () => {
    it('should create AWSError', () => {
      const error = new AWSError('Test error');
      expect(error).toBeDefined();
      expect(error.message).toContain('[aws-bedrock] Test error');
      expect(error.name).toBe('AWSError');
    });

    it('should create AWSAuthError', () => {
      const error = new AWSAuthError();
      expect(error).toBeDefined();
      expect(error.message).toContain('Authentication failed');
      expect(error.name).toBe('AWSAuthError');
    });

    it('should create AWSRateLimitError', () => {
      const error = new AWSRateLimitError('Rate limited', 60);
      expect(error).toBeDefined();
      expect(error.message).toContain('Rate limited');
      expect(error.retryAfter).toBe(60);
      expect(error.name).toBe('AWSRateLimitError');
    });
  });
});

describe('AWSBedrockProvider', () => {
  const config: AWSBedrockConfig = {
    region: 'us-east-1',
    credentials: {
      accessKeyId: 'test-key',
      secretAccessKey: 'test-secret',
    },
  };

  it('should instantiate with config', () => {
    const provider = new AWSBedrockProvider(config);
    expect(provider).toBeDefined();
    expect(provider.name).toBe('aws-bedrock');
    expect(provider.config).toEqual(config);
  });

  it('should create an executor function', () => {
    const provider = new AWSBedrockProvider(config);
    const executor = provider.createExecutor();
    expect(typeof executor).toBe('function');
  });

  it('should create a streamer function', () => {
    const provider = new AWSBedrockProvider(config);
    const streamer = provider.createStreamer();
    expect(typeof streamer).toBe('function');
  });

  it('executor should throw when no model is provided', async () => {
    const provider = new AWSBedrockProvider(config);
    const executor = provider.createExecutor();
    await expect(
      executor({ messages: [{ role: 'user', content: 'Hello' }] }, {})
    ).rejects.toThrow('Model is required');
  });

  it('streamer should throw when no model is provided', async () => {
    const provider = new AWSBedrockProvider(config);
    const streamer = provider.createStreamer();
    const gen = streamer({ messages: [{ role: 'user', content: 'Hello' }] }, {});
    await expect(gen.next()).rejects.toThrow('Model is required');
  });
});

describe('detectAWSFamily', () => {
  it('should detect anthropic family', () => {
    expect(detectAWSFamily('anthropic.claude-3-sonnet-20240229-v1:0')).toBe('anthropic');
  });

  it('should detect meta family', () => {
    expect(detectAWSFamily('meta.llama3-8b-instruct-v1:0')).toBe('meta');
  });

  it('should detect mistral family', () => {
    expect(detectAWSFamily('mistral.mistral-7b-instruct-v0:2')).toBe('mistral');
  });

  it('should detect cohere family', () => {
    expect(detectAWSFamily('cohere.command-r-v1:0')).toBe('cohere');
  });

  it('should detect amazon family', () => {
    expect(detectAWSFamily('amazon.titan-embed-text-v2:0')).toBe('amazon');
  });

  it('should return unknown for unrecognized models', () => {
    expect(detectAWSFamily('unknown.model-v1:0')).toBe('unknown');
  });
});

describe('detectAWSCapabilities', () => {
  const makeModel = (modelId: string, overrides: Partial<FoundationModelSummary> = {}): FoundationModelSummary => ({
    modelId,
    modelName: modelId,
    providerName: modelId.split('.')[0],
    inputModalities: ['TEXT'],
    outputModalities: ['TEXT'],
    responseStreamingSupported: true,
    ...overrides,
  });

  it('should detect chat and streaming for Claude', () => {
    const caps = detectAWSCapabilities(makeModel('anthropic.claude-3-sonnet-20240229-v1:0'));
    expect(caps.has('chat')).toBe(true);
    expect(caps.has('streaming')).toBe(true);
  });

  it('should detect tools for Claude', () => {
    const caps = detectAWSCapabilities(makeModel('anthropic.claude-3-sonnet-20240229-v1:0'));
    expect(caps.has('tools')).toBe(true);
  });

  it('should detect tools for Llama 3.1', () => {
    const caps = detectAWSCapabilities(makeModel('meta.llama3-1-70b-instruct-v1:0'));
    expect(caps.has('tools')).toBe(true);
  });

  it('should detect tools for Llama 3.2', () => {
    const caps = detectAWSCapabilities(makeModel('meta.llama3-2-11b-instruct-v1:0'));
    expect(caps.has('tools')).toBe(true);
  });

  it('should detect tools for Mistral Large', () => {
    const caps = detectAWSCapabilities(makeModel('mistral.mistral-large-2407-v1:0'));
    expect(caps.has('tools')).toBe(true);
  });

  it('should detect tools for Cohere Command R', () => {
    const caps = detectAWSCapabilities(makeModel('cohere.command-r-v1:0'));
    expect(caps.has('tools')).toBe(true);
  });

  it('should detect embedding for Amazon Titan', () => {
    const caps = detectAWSCapabilities(makeModel('amazon.titan-embed-text-v2:0'));
    expect(caps.has('embedding')).toBe(true);
  });

  it('should detect vision for multimodal models', () => {
    const caps = detectAWSCapabilities(makeModel('anthropic.claude-3-sonnet-20240229-v1:0', {
      inputModalities: ['TEXT', 'IMAGE'],
      outputModalities: ['TEXT'],
    }));
    expect(caps.has('vision')).toBe(true);
  });
});

describe('detectAWSTier', () => {
  it('should return flagship for Claude Opus', () => {
    expect(detectAWSTier('anthropic', 'anthropic.claude-3-opus-20240229-v1:0')).toBe('flagship');
  });

  it('should return efficient for Claude Sonnet', () => {
    expect(detectAWSTier('anthropic', 'anthropic.claude-3-sonnet-20240229-v1:0')).toBe('efficient');
  });

  it('should return flagship for Mistral Large', () => {
    expect(detectAWSTier('mistral', 'mistral.mistral-large-2402-v1:0')).toBe('flagship');
  });

  it('should return flagship for Cohere Command R Plus', () => {
    expect(detectAWSTier('cohere', 'cohere.command-r-plus-v1:0')).toBe('flagship');
  });
});
