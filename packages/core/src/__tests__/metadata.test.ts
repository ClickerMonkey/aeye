/**
 * Metadata Tests
 *
 * Tests for metadata support in Prompt, Agent, and Tool components.
 */

import { z } from 'zod';
import { Agent } from '../agent';
import { Prompt } from '../prompt';
import { Tool } from '../tool';
import type { Context } from '../types';

interface TestMetadata {
  model?: string;
  temperature?: number;
  tags?: string[];
}

describe('Metadata', () => {
  describe('Agent', () => {
    it('should support static metadata', async () => {
      const agent = new Agent<{}, TestMetadata>({
        name: 'test-agent',
        description: 'Test agent',
        refs: [],
        metadata: { model: 'gpt-4', temperature: 0.7 },
        call: () => 'result'
      });

      const ctx = {} as Context<{}, TestMetadata>;
      const metadata = await agent.metadata({}, ctx);

      expect(metadata).toEqual({ model: 'gpt-4', temperature: 0.7 });
    });

    it('should support dynamic metadata via metadataFn', async () => {
      const agent = new Agent<{}, TestMetadata, string, { userId: string }>({
        name: 'dynamic-agent',
        description: 'Agent with dynamic metadata',
        refs: [],
        metadataFn: (input, ctx) => ({ model: 'gpt-4', tags: [`user-${input.userId}`] }),
        call: () => 'result'
      });

      const ctx = {} as Context<{}, TestMetadata>;
      const metadata = await agent.metadata({ userId: 'user123' }, ctx);

      expect(metadata).toEqual({ model: 'gpt-4', tags: ['user-user123'] });
    });

    it('should combine static and dynamic metadata', async () => {
      const agent = new Agent<{}, TestMetadata, string, { userId: string }>({
        name: 'combined-agent',
        description: 'Agent with combined metadata',
        refs: [],
        metadata: { model: 'gpt-4', temperature: 0.5 },
        metadataFn: (input, ctx) => ({ tags: [`user-${input.userId}`] }),
        call: () => 'result'
      });

      const ctx = {} as Context<{}, TestMetadata>;
      const metadata = await agent.metadata({ userId: 'user456' }, ctx);

      expect(metadata).toEqual({ 
        model: 'gpt-4', 
        temperature: 0.5, 
        tags: ['user-user456'] 
      });
    });

    it('should return empty object when no metadata is provided', async () => {
      const agent = new Agent({
        name: 'no-metadata-agent',
        description: 'Agent without metadata',
        refs: [],
        call: () => 'result'
      });

      const ctx = {} as Context<{}, {}>;
      const metadata = await agent.metadata({}, ctx);

      expect(metadata).toEqual({});
    });
  });

  describe('Tool', () => {
    it('should support static metadata', async () => {
      const tool = new Tool<{}, TestMetadata>({
        name: 'test-tool',
        description: 'Test tool',
        instructions: 'Test instructions',
        schema: z.object({ value: z.number() }),
        metadata: { model: 'gpt-3.5-turbo', temperature: 0.8 },
        call: (input) => input.value * 2
      });

      const ctx = {} as Context<{}, TestMetadata>;
      const metadata = await tool.metadata({ value: 5 }, ctx);

      expect(metadata).toEqual({ model: 'gpt-3.5-turbo', temperature: 0.8 });
    });

    it('should support dynamic metadata via metadataFn', async () => {
      const tool = new Tool<{}, TestMetadata, string, { operation: string }>({
        name: 'dynamic-tool',
        description: 'Tool with dynamic metadata',
        instructions: 'Tool instructions',
        schema: z.object({ operation: z.string() }),
        metadataFn: (input, ctx) => ({ tags: [input.operation] }),
        call: (input) => `Performed ${input.operation}`
      });

      const ctx = {} as Context<{}, TestMetadata>;
      const metadata = await tool.metadata({ operation: 'calculate' }, ctx);

      expect(metadata).toEqual({ tags: ['calculate'] });
    });

    it('should combine static and dynamic metadata', async () => {
      const tool = new Tool<{}, TestMetadata, string, { mode: string }>({
        name: 'combined-tool',
        description: 'Tool with combined metadata',
        instructions: 'Tool instructions',
        schema: z.object({ mode: z.string() }),
        metadata: { model: 'claude-3', temperature: 0.3 },
        metadataFn: (input, ctx) => ({ tags: [`mode-${input.mode}`] }),
        call: (input) => `Mode: ${input.mode}`
      });

      const ctx = {} as Context<{}, TestMetadata>;
      const metadata = await tool.metadata({ mode: 'fast' }, ctx);

      expect(metadata).toEqual({ 
        model: 'claude-3', 
        temperature: 0.3, 
        tags: ['mode-fast'] 
      });
    });

    it('should return empty object when no metadata is provided', async () => {
      const tool = new Tool({
        name: 'no-metadata-tool',
        description: 'Tool without metadata',
        instructions: 'Instructions',
        schema: z.object({ x: z.number() }),
        call: (input) => input.x
      });

      const ctx = {} as Context<{}, {}>;
      const metadata = await tool.metadata({ x: 10 }, ctx);

      expect(metadata).toEqual({});
    });
  });

  describe('Prompt', () => {
    it('should support static metadata', async () => {
      const prompt = new Prompt<{}, TestMetadata>({
        name: 'test-prompt',
        description: 'Test prompt',
        content: 'Hello {{name}}',
        metadata: { model: 'gpt-4o', temperature: 0.9 }
      });

      const ctx = {} as Context<{}, TestMetadata>;
      const metadata = await prompt.metadata({}, ctx);

      expect(metadata).toEqual({ model: 'gpt-4o', temperature: 0.9 });
    });

    it('should support dynamic metadata via metadataFn', async () => {
      const prompt = new Prompt<{}, TestMetadata, string, { priority: string }>({
        name: 'dynamic-prompt',
        description: 'Prompt with dynamic metadata',
        content: 'Priority: {{priority}}',
        metadataFn: (input, ctx) => ({ tags: [`priority-${input.priority}`] })
      });

      const ctx = {} as Context<{}, TestMetadata>;
      const metadata = await prompt.metadata({ priority: 'high' }, ctx);

      expect(metadata).toEqual({ tags: ['priority-high'] });
    });

    it('should combine static and dynamic metadata', async () => {
      const prompt = new Prompt<{}, TestMetadata, string, { category: string }>({
        name: 'combined-prompt',
        description: 'Prompt with combined metadata',
        content: 'Category: {{category}}',
        metadata: { model: 'claude-opus', temperature: 0.6 },
        metadataFn: (input, ctx) => ({ tags: [`category-${input.category}`] })
      });

      const ctx = {} as Context<{}, TestMetadata>;
      const metadata = await prompt.metadata({ category: 'research' }, ctx);

      expect(metadata).toEqual({ 
        model: 'claude-opus', 
        temperature: 0.6, 
        tags: ['category-research'] 
      });
    });

    it('should return empty object when no metadata is provided', async () => {
      const prompt = new Prompt({
        name: 'no-metadata-prompt',
        description: 'Prompt without metadata',
        content: 'Hello world'
      });

      const ctx = {} as Context<{}, {}>;
      const metadata = await prompt.metadata({}, ctx);

      expect(metadata).toEqual({});
    });
  });

  describe('Component Interface Consistency', () => {
    it('should expose metadata() method on all component types', () => {
      const agent = new Agent({
        name: 'test',
        description: 'Test',
        refs: [],
        call: () => 'result'
      });

      const tool = new Tool({
        name: 'test',
        description: 'Test',
        instructions: 'Test',
        schema: z.object({}),
        call: () => 'result'
      });

      const prompt = new Prompt({
        name: 'test',
        description: 'Test',
        content: 'Test'
      });

      expect(typeof agent.metadata).toBe('function');
      expect(typeof tool.metadata).toBe('function');
      expect(typeof prompt.metadata).toBe('function');
    });
  });
});
