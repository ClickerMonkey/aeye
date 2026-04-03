/**
 * Prompt Suspend/Resume Tests
 *
 * Tests for the PromptSuspend mechanism that allows a tool to pause prompt
 * execution so the caller can save state and resume later.
 */

import { z } from 'zod';
import { Prompt, PromptEvent } from '../prompt';
import { AnyTool, Tool, PromptSuspend, ToolInterrupt } from '../tool';
import { Context, Message } from '../types';
import { createMockExecutor } from './mocks/executor.mock';

describe('Prompt Suspend/Resume', () => {
  describe('PromptSuspend class', () => {
    it('should create a PromptSuspend error with default message', () => {
      const err = new PromptSuspend();
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(PromptSuspend);
      expect(err.name).toBe('PromptSuspend');
      expect(err.message).toBe('Prompt execution suspended');
    });

    it('should create a PromptSuspend error with custom message', () => {
      const err = new PromptSuspend('Waiting for approval');
      expect(err.message).toBe('Waiting for approval');
    });

    it('should be distinguishable from ToolInterrupt', () => {
      const suspend = new PromptSuspend();
      const interrupt = new ToolInterrupt();
      expect(suspend instanceof PromptSuspend).toBe(true);
      expect(suspend instanceof ToolInterrupt).toBe(false);
      expect(interrupt instanceof ToolInterrupt).toBe(true);
      expect(interrupt instanceof PromptSuspend).toBe(false);
    });
  });

  describe('Prompt suspension when tool throws PromptSuspend', () => {
    it('should emit suspend event instead of complete when a tool suspends', async () => {
      const suspendingTool = new Tool({
        name: 'approval-required',
        description: 'Requires approval',
        instructions: 'Use when approval is needed',
        schema: z.object({ action: z.string() }),
        call: () => {
          throw new PromptSuspend('Waiting for user approval');
        }
      });

      const prompt = new Prompt({
        name: 'approval-prompt',
        description: 'Prompt that may suspend',
        content: 'Perform action',
        tools: [suspendingTool],
      });

      const executor = createMockExecutor({
        responses: [
          {
            content: '',
            finishReason: 'tool_calls',
            toolCalls: [{ id: 'call_1', name: 'approval-required', arguments: '{"action":"delete"}' }]
          }
        ]
      });

      const ctx: Context<{}, {}> = {
        execute: executor,
        messages: []
      };

      const events: PromptEvent<string, [AnyTool]>[] = [];
      let threw = false;

      try {
        for await (const event of prompt.run({}, ctx)) {
          events.push(event);
        }
      } catch (e) {
        threw = true;
      }

      expect(threw).toBe(false);

      const suspendEvent = events.find(e => e.type === 'suspend');
      expect(suspendEvent).toBeDefined();
      expect(suspendEvent!.type).toBe('suspend');

      // No complete event should be emitted
      const completeEvent = events.find(e => e.type === 'complete');
      expect(completeEvent).toBeUndefined();
    });

    it('should emit toolSuspend event for the suspended tool', async () => {
      const suspendingTool = new Tool({
        name: 'needs-approval',
        description: 'Needs approval',
        instructions: 'Approval tool',
        schema: z.object({ value: z.string() }),
        call: () => {
          throw new PromptSuspend();
        }
      });

      const prompt = new Prompt({
        name: 'suspend-events-prompt',
        description: 'Test toolSuspend event',
        content: 'Do something',
        tools: [suspendingTool],
      });

      const executor = createMockExecutor({
        responses: [
          {
            content: '',
            finishReason: 'tool_calls',
            toolCalls: [{ id: 'call_1', name: 'needs-approval', arguments: '{"value":"test"}' }]
          }
        ]
      });

      const ctx: Context<{}, {}> = {
        execute: executor,
        messages: []
      };

      const events: PromptEvent<string, [AnyTool]>[] = [];
      for await (const event of prompt.run({}, ctx)) {
        events.push(event);
      }

      const toolSuspendEvent = events.find(e => e.type === 'toolSuspend');
      expect(toolSuspendEvent).toBeDefined();
      expect(toolSuspendEvent!.type).toBe('toolSuspend');
    });

    it('suspend event messages should end with assistant tool-call message (no tool results)', async () => {
      const suspendingTool = new Tool({
        name: 'pausing-tool',
        description: 'Pauses execution',
        instructions: 'Pausing tool',
        schema: z.object({ id: z.number() }),
        call: () => {
          throw new PromptSuspend('Needs processing');
        }
      });

      const prompt = new Prompt({
        name: 'state-check-prompt',
        description: 'Check suspend state',
        content: 'Run action',
        tools: [suspendingTool],
      });

      const executor = createMockExecutor({
        responses: [
          {
            content: 'I will run the action.',
            finishReason: 'tool_calls',
            toolCalls: [{ id: 'call_99', name: 'pausing-tool', arguments: '{"id":42}' }]
          }
        ]
      });

      const ctx: Context<{}, {}> = {
        execute: executor,
        messages: []
      };

      const events: PromptEvent<string, [AnyTool]>[] = [];
      for await (const event of prompt.run({}, ctx)) {
        events.push(event);
      }

      const suspendEvent = events.find(e => e.type === 'suspend');
      expect(suspendEvent).toBeDefined();

      const { request: suspendRequest } = suspendEvent as { type: 'suspend'; request: any };

      // The last message should be the assistant message with tool calls
      const lastMsg = suspendRequest.messages[suspendRequest.messages.length - 1];
      expect(lastMsg.role).toBe('assistant');
      expect(lastMsg.toolCalls).toBeDefined();
      expect(lastMsg.toolCalls!.some((tc: any) => tc.id === 'call_99')).toBe(true);

      // No 'tool' role messages should be present (no results added for the suspended tool)
      const toolResultMessages = suspendRequest.messages.filter((m: any) => m.role === 'tool');
      expect(toolResultMessages).toHaveLength(0);
    });

    it('should not suspend when tool completes normally', async () => {
      const normalTool = new Tool({
        name: 'normal-tool',
        description: 'Normal tool',
        instructions: 'Normal execution',
        schema: z.object({ x: z.number() }),
        call: (input) => `result: ${input.x}`
      });

      const prompt = new Prompt({
        name: 'no-suspend-prompt',
        description: 'No suspension',
        content: 'Do something',
        tools: [normalTool],
      });

      const executor = createMockExecutor({
        responses: [
          {
            content: '',
            finishReason: 'tool_calls',
            toolCalls: [{ id: 'call_1', name: 'normal-tool', arguments: '{"x":5}' }]
          },
          {
            content: 'Done',
            finishReason: 'stop'
          }
        ]
      });

      const ctx: Context<{}, {}> = {
        execute: executor,
        messages: []
      };

      const events: PromptEvent<string, [AnyTool]>[] = [];
      for await (const event of prompt.run({}, ctx)) {
        events.push(event);
      }

      // Should complete, not suspend
      const completeEvent = events.find(e => e.type === 'complete');
      expect(completeEvent).toBeDefined();

      const suspendEvent = events.find(e => e.type === 'suspend');
      expect(suspendEvent).toBeUndefined();
    });
  });

  describe('Mixed tool completion: non-suspended results preserved', () => {
    it('should add completed tool results to request.messages before suspending', async () => {
      const completingTool = new Tool({
        name: 'completing-tool',
        description: 'Completes successfully',
        instructions: 'Completes',
        schema: z.object({ value: z.string() }),
        call: (input) => `done: ${input.value}`,
      });

      const suspendingTool = new Tool({
        name: 'suspend-tool',
        description: 'Needs approval',
        instructions: 'Approval',
        schema: z.object({ id: z.number() }),
        call: () => { throw new PromptSuspend('Awaiting approval'); },
      });

      const prompt = new Prompt({
        name: 'mixed-prompt',
        description: 'Mixed tools',
        content: 'Do both',
        tools: [completingTool, suspendingTool],
        toolExecution: 'sequential',
      });

      const executor = createMockExecutor({
        responses: [
          {
            content: '',
            finishReason: 'tool_calls',
            toolCalls: [
              { id: 'call_a', name: 'completing-tool', arguments: '{"value":"hello"}' },
              { id: 'call_b', name: 'suspend-tool', arguments: '{"id":7}' },
            ]
          }
        ]
      });

      const ctx: Context<{}, {}> = {
        execute: executor,
        messages: []
      };

      const events: PromptEvent<string, [AnyTool, AnyTool]>[] = [];
      for await (const event of prompt.run({}, ctx)) {
        events.push(event);
      }

      const suspendEvent = events.find(e => e.type === 'suspend') as { type: 'suspend'; request: any } | undefined;
      expect(suspendEvent).toBeDefined();

      const msgs: Message[] = suspendEvent!.request.messages;

      // The completed tool result should be present
      const toolResults = msgs.filter((m: any) => m.role === 'tool');
      expect(toolResults).toHaveLength(1);
      expect(toolResults[0].toolCallId).toBe('call_a');
      expect(toolResults[0].content).toContain('done: hello');

      // The suspended tool (call_b) should have NO result message
      const suspendedResult = msgs.find((m: any) => m.role === 'tool' && m.toolCallId === 'call_b');
      expect(suspendedResult).toBeUndefined();
    });
  });

  describe('Resume behavior after suspension', () => {
    it('should allow resuming by providing saved messages with tool results', async () => {
      const suspendingTool = new Tool({
        name: 'resumable-tool',
        description: 'Resumable tool',
        instructions: 'Resumable',
        schema: z.object({ task: z.string() }),
        call: () => {
          throw new PromptSuspend('Needs external processing');
        }
      });

      const prompt = new Prompt({
        name: 'resumable-prompt',
        description: 'Can be resumed',
        content: 'Do task',
        tools: [suspendingTool],
      });

      // First run — should suspend
      const firstExecutor = createMockExecutor({
        responses: [
          {
            content: 'Starting task.',
            finishReason: 'tool_calls',
            toolCalls: [{ id: 'tool_call_1', name: 'resumable-tool', arguments: '{"task":"process"}' }]
          }
        ]
      });

      const firstCtx: Context<{}, {}> = {
        execute: firstExecutor,
        messages: []
      };

      let savedMessages: Message[] = [];
      for await (const event of prompt.run({}, firstCtx)) {
        if (event.type === 'suspend') {
          savedMessages = event.request.messages;
        }
      }

      expect(savedMessages.length).toBeGreaterThan(0);

      // Simulate external processing: append tool result to saved messages
      const resumeMessages: Message[] = [
        ...savedMessages,
        {
          role: 'tool',
          content: 'External processing complete',
          toolCallId: 'tool_call_1',
        }
      ];

      // Second run — resume using saved messages + tool result
      const resumeExecutor = createMockExecutor({
        responses: [
          {
            content: 'Task completed successfully.',
            finishReason: 'stop'
          }
        ]
      });

      const resumeCtx: Context<{}, {}> = {
        execute: resumeExecutor,
        messages: resumeMessages
      };

      const resumeEvents: PromptEvent<string, [AnyTool]>[] = [];
      for await (const event of prompt.run({}, resumeCtx)) {
        resumeEvents.push(event);
      }

      // The resumed prompt should complete (not suspend again)
      const completeEvent = resumeEvents.find(e => e.type === 'complete');
      expect(completeEvent).toBeDefined();

      const suspendEvent = resumeEvents.find(e => e.type === 'suspend');
      expect(suspendEvent).toBeUndefined();
    });
  });

  describe('PromptSuspend vs ToolInterrupt distinction', () => {
    it('should emit toolInterrupt (not toolSuspend) when ToolInterrupt is thrown', async () => {
      const interruptingTool = new Tool({
        name: 'interrupting-tool',
        description: 'Interrupts execution',
        instructions: 'Interrupt tool',
        schema: z.object({}),
        call: () => {
          throw new ToolInterrupt('Stop now');
        }
      });

      const prompt = new Prompt({
        name: 'interrupt-test-prompt',
        description: 'Interrupt test',
        content: 'Do something',
        tools: [interruptingTool],
      });

      const executor = createMockExecutor({
        responses: [
          {
            content: '',
            finishReason: 'tool_calls',
            toolCalls: [{ id: 'call_1', name: 'interrupting-tool', arguments: '{}' }]
          }
        ]
      });

      const ctx: Context<{}, {}> = {
        execute: executor,
        messages: []
      };

      const events: PromptEvent<string, [AnyTool]>[] = [];
      let threw = false;
      try {
        for await (const event of prompt.run({}, ctx)) {
          events.push(event);
        }
      } catch (e) {
        threw = true;
      }

      // ToolInterrupt should cause a toolInterrupt event
      const toolInterruptEvent = events.find(e => e.type === 'toolInterrupt');
      expect(toolInterruptEvent).toBeDefined();

      // Should NOT emit toolSuspend or suspend
      const toolSuspendEvent = events.find(e => e.type === 'toolSuspend');
      expect(toolSuspendEvent).toBeUndefined();

      const suspendEvent = events.find(e => e.type === 'suspend');
      expect(suspendEvent).toBeUndefined();
    });

    it('ToolInterrupt adds tool results to messages but PromptSuspend does not', async () => {
      const makeTool = (name: string, callFn: () => never) => new Tool({
        name,
        description: name,
        instructions: name,
        schema: z.object({}),
        call: callFn
      });

      const suspendTool = makeTool('suspend-tool', () => { throw new PromptSuspend(); });
      const interruptTool = makeTool('interrupt-tool', () => { throw new ToolInterrupt(); });

      const runPrompt = async (tool: AnyTool) => {
        const prompt = new Prompt({
          name: 'comparison-prompt',
          description: 'Compare tools',
          content: 'Test',
          tools: [tool],
        });

        const executor = createMockExecutor({
          responses: [
            {
              content: '',
              finishReason: 'tool_calls',
              toolCalls: [{ id: 'the_call', name: tool.name, arguments: '{}' }]
            }
          ]
        });

        const events: PromptEvent<string, [AnyTool]>[] = [];
        try {
          for await (const event of prompt.run({}, { execute: executor, messages: [] })) {
            events.push(event);
          }
        } catch (e) {
          // may throw for interrupt path
        }
        return events;
      };

      const suspendEvents = await runPrompt(suspendTool);
      const interruptEvents = await runPrompt(interruptTool);

      // Suspend: no tool result messages in request.messages for the suspended tool
      const suspendEvent = suspendEvents.find(e => e.type === 'suspend') as { type: 'suspend'; request: any } | undefined;
      expect(suspendEvent).toBeDefined();
      const suspendToolResults = suspendEvent!.request.messages.filter((m: any) => m.role === 'tool');
      expect(suspendToolResults).toHaveLength(0);

      // Interrupt: tool result messages ARE added (with empty content)
      const interruptMessageEvents = interruptEvents.filter(e => e.type === 'message') as { type: 'message'; message: Message; request: any }[];
      const interruptToolResults = interruptMessageEvents.map(e => e.message).filter(m => m.role === 'tool');
      expect(interruptToolResults.length).toBeGreaterThan(0);
    });
  });
});
