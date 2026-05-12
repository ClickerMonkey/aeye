/**
 * Prompt Tool Result Pairing Tests
 *
 * Verifies the `toolsComplete` flag (default true) guarantees that every
 * `tool_calls[i]` on an emitted assistant message ends up with a matching
 * `role: 'tool'` reply in `request.messages` — even when the abort signal
 * fires mid-batch or a `ToolInterrupt` is thrown by one of several
 * parallel tools. Without that guarantee the next round-trip 400s
 * (OpenAI / Anthropic both reject unpaired `tool_calls`).
 *
 * Also verifies the abort-aware dispatch added alongside the synthesis
 * pass: once `signal.aborted` is observed at the top of the sequential
 * or parallel dispatch loop, subsequent tools are NOT started. The
 * synthesis pass fills their unpaired slots with `[aborted: …]`
 * placeholders.
 *
 * Suspend semantics are intentionally preserved — `PromptSuspend` still
 * leaves its tool_call without a paired result so the caller can supply
 * one on resume.
 */

import { z } from 'zod';
import { Prompt, PromptEvent } from '../prompt';
import { AnyTool, Tool, PromptSuspend, ToolInterrupt } from '../tool';
import { Context, Message } from '../types';
import { createMockExecutor } from './mocks/executor.mock';

describe('Prompt tool_call ↔ tool result pairing', () => {
  describe('toolsComplete: true (default) — synthesis pass', () => {
    it('pairs every parallel tool_call when the signal aborts mid-batch', async () => {
      // Fast tool returns normally; slow tool aborts the parent
      // controller and then takes much longer than the dispatch loop
      // will wait. Once `controller.abort()` fires from inside the
      // fast tool, the signal-check at the top of the parallel-mode
      // for-await loop breaks — the slow tool's promise is orphaned,
      // and the synthesis pass below pairs its tool_call with an
      // `[aborted: …]` placeholder.
      const controller = new AbortController();
      let slowFinished = false;
      const fastTool = new Tool({
        name: 'fast',
        description: 'Fast tool',
        instructions: 'Returns quickly',
        schema: z.object({ id: z.number() }),
        call: () => {
          controller.abort();
          return 'fast-done';
        },
      });
      const slowTool = new Tool({
        name: 'slow',
        description: 'Slow tool',
        instructions: 'Returns slowly',
        schema: z.object({ id: z.number() }),
        call: async () => {
          await new Promise((r) => setTimeout(r, 500));
          slowFinished = true;
          return 'slow-done';
        },
      });

      const prompt = new Prompt({
        name: 'two-tool-parallel',
        description: 'Two tools in parallel',
        content: 'Run both',
        tools: [fastTool, slowTool],
        toolExecution: 'parallel',
      });

      const executor = createMockExecutor({
        responses: [
          {
            content: '',
            finishReason: 'tool_calls',
            toolCalls: [
              { id: 'call_fast', name: 'fast', arguments: '{"id":1}' },
              { id: 'call_slow', name: 'slow', arguments: '{"id":2}' },
            ],
          },
        ],
      });

      const ctx: Context<{}, {}> = {
        execute: executor,
        messages: [],
        signal: controller.signal,
      };

      const events: PromptEvent<string, [AnyTool, AnyTool]>[] = [];
      for await (const event of prompt.run({}, ctx)) {
        events.push(event);
      }

      const messageEvents = events.filter((e) => e.type === 'message') as Array<{
        type: 'message';
        message: Message;
        request: { messages: Message[] };
      }>;
      const finalMessages = messageEvents[messageEvents.length - 1]!.request.messages;
      const assistantWithCalls = finalMessages.find(
        (m) => m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0,
      );
      expect(assistantWithCalls).toBeDefined();
      expect(assistantWithCalls!.toolCalls).toHaveLength(2);

      const toolResults = finalMessages.filter((m) => m.role === 'tool');
      // Every tool_call should have a matching role:'tool' message — that's the whole point.
      expect(toolResults).toHaveLength(2);
      const byCallId = new Map(toolResults.map((m) => [m.toolCallId, m.content as string]));
      expect(byCallId.get('call_fast')).toBe('fast-done');
      expect(byCallId.get('call_slow')).toMatch(/^\[aborted:/);
    });

    it('pairs every sequential tool_call when the signal aborts after the first tool', async () => {
      // Sequential mode: tool A fires `controller.abort()` from inside
      // its body. The signal-check at the top of the sequential
      // for-loop trips on the next iteration so tools B and C never
      // have their `.run()` invoked. Synthesis pairs both with placeholders.
      const controller = new AbortController();
      const bRun = jest.fn();
      const cRun = jest.fn();
      const aborter = new Tool({
        name: 'aborter',
        description: 'Aborts after running',
        instructions: 'Calls abort and returns',
        schema: z.object({}),
        call: () => {
          controller.abort();
          return 'A-result';
        },
      });
      const toolB = new Tool({
        name: 'B',
        description: 'Tool B',
        instructions: 'Tool B body',
        schema: z.object({}),
        call: () => {
          bRun();
          return 'B-result';
        },
      });
      const toolC = new Tool({
        name: 'C',
        description: 'Tool C',
        instructions: 'Tool C body',
        schema: z.object({}),
        call: () => {
          cRun();
          return 'C-result';
        },
      });

      const prompt = new Prompt({
        name: 'three-tools-sequential',
        description: 'Three tools sequential',
        content: 'Run all three',
        tools: [aborter, toolB, toolC],
        toolExecution: 'sequential',
      });

      const executor = createMockExecutor({
        responses: [
          {
            content: '',
            finishReason: 'tool_calls',
            toolCalls: [
              { id: 'call_A', name: 'aborter', arguments: '{}' },
              { id: 'call_B', name: 'B', arguments: '{}' },
              { id: 'call_C', name: 'C', arguments: '{}' },
            ],
          },
        ],
      });

      const ctx: Context<{}, {}> = {
        execute: executor,
        messages: [],
        signal: controller.signal,
      };

      const events: PromptEvent<string, [AnyTool, AnyTool, AnyTool]>[] = [];
      for await (const event of prompt.run({}, ctx)) {
        events.push(event);
      }

      // Tools B and C must never run — the abort-aware dispatch
      // short-circuits the loop before their .run() is reached.
      expect(bRun).not.toHaveBeenCalled();
      expect(cRun).not.toHaveBeenCalled();

      const messageEvents = events.filter((e) => e.type === 'message') as Array<{
        type: 'message';
        message: Message;
        request: { messages: Message[] };
      }>;
      const finalMessages = messageEvents[messageEvents.length - 1]!.request.messages;
      const toolResults = finalMessages.filter((m) => m.role === 'tool');
      expect(toolResults).toHaveLength(3);
      const byCallId = new Map(toolResults.map((m) => [m.toolCallId, m.content as string]));
      expect(byCallId.get('call_A')).toBe('A-result');
      expect(byCallId.get('call_B')).toMatch(/^\[aborted:/);
      expect(byCallId.get('call_C')).toMatch(/^\[aborted:/);
    });

    it('synthesizes placeholder when ToolInterrupt cuts a parallel batch short', async () => {
      // First tool throws ToolInterrupt; second tool aborts so the
      // loop short-circuits and never accumulates its result. Both
      // tool_calls must end up paired in request.messages.
      const controller = new AbortController();
      const interrupter = new Tool({
        name: 'interrupter',
        description: 'Throws ToolInterrupt',
        instructions: 'Throws an interrupt',
        schema: z.object({}),
        call: () => {
          // Abort the controller too so the second tool's eventual
          // yield gets skipped by the signal-check inside the loop.
          controller.abort();
          throw new ToolInterrupt('user cancelled');
        },
      });
      const other = new Tool({
        name: 'other',
        description: 'Other tool',
        instructions: 'Other tool body',
        schema: z.object({}),
        call: async () => {
          await new Promise((r) => setTimeout(r, 200));
          return 'other-done';
        },
      });

      const prompt = new Prompt({
        name: 'interrupt-pair',
        description: 'Interrupt in parallel',
        content: 'Run both',
        tools: [interrupter, other],
        toolExecution: 'parallel',
      });

      const executor = createMockExecutor({
        responses: [
          {
            content: '',
            finishReason: 'tool_calls',
            toolCalls: [
              { id: 'call_int', name: 'interrupter', arguments: '{}' },
              { id: 'call_other', name: 'other', arguments: '{}' },
            ],
          },
        ],
      });

      const ctx: Context<{}, {}> = {
        execute: executor,
        messages: [],
        signal: controller.signal,
      };

      const events: PromptEvent<string, [AnyTool, AnyTool]>[] = [];
      for await (const event of prompt.run({}, ctx)) {
        events.push(event);
      }

      const messageEvents = events.filter((e) => e.type === 'message') as Array<{
        type: 'message';
        message: Message;
        request: { messages: Message[] };
      }>;
      const finalMessages = messageEvents[messageEvents.length - 1]!.request.messages;
      const toolResults = finalMessages.filter((m) => m.role === 'tool');
      // Both tool_calls paired — no broken history.
      expect(toolResults).toHaveLength(2);
      // The interrupter's result content carries the interrupt marker;
      // the other tool's slot is filled by synthesis.
      const byCallId = new Map(toolResults.map((m) => [m.toolCallId, m.content as string]));
      expect(byCallId.get('call_int')).toMatch(/cancelled|interrupted/i);
      expect(byCallId.get('call_other')).toMatch(/^\[aborted:|^\[no result\]/);
    });
  });

  describe('toolsComplete: false — opt-out preserves legacy behavior', () => {
    it('leaves unfinished tool_calls unpaired when opted out', async () => {
      const controller = new AbortController();
      const fastTool = new Tool({
        name: 'fast',
        description: 'Fast',
        instructions: 'Returns quickly',
        schema: z.object({}),
        call: () => {
          controller.abort();
          return 'fast-done';
        },
      });
      const slowTool = new Tool({
        name: 'slow',
        description: 'Slow',
        instructions: 'Returns slowly',
        schema: z.object({}),
        call: async () => {
          await new Promise((r) => setTimeout(r, 500));
          return 'slow-done';
        },
      });

      const prompt = new Prompt({
        name: 'opt-out',
        description: 'opt-out of synthesis',
        content: 'Run both',
        tools: [fastTool, slowTool],
        toolExecution: 'parallel',
        toolsComplete: false,
      });

      const executor = createMockExecutor({
        responses: [
          {
            content: '',
            finishReason: 'tool_calls',
            toolCalls: [
              { id: 'call_fast', name: 'fast', arguments: '{}' },
              { id: 'call_slow', name: 'slow', arguments: '{}' },
            ],
          },
        ],
      });

      const ctx: Context<{}, {}> = {
        execute: executor,
        messages: [],
        signal: controller.signal,
      };

      const events: PromptEvent<string, [AnyTool, AnyTool]>[] = [];
      for await (const event of prompt.run({}, ctx)) {
        events.push(event);
      }

      const messageEvents = events.filter((e) => e.type === 'message') as Array<{
        type: 'message';
        message: Message;
        request: { messages: Message[] };
      }>;
      const finalMessages = messageEvents[messageEvents.length - 1]!.request.messages;
      const toolResults = finalMessages.filter((m) => m.role === 'tool');
      // Legacy behavior: only the fast tool's result lands. The slow
      // tool's `tool_call` is left unpaired (the broken state the
      // default `toolsComplete: true` is designed to prevent).
      expect(toolResults).toHaveLength(1);
      expect(toolResults[0]!.toolCallId).toBe('call_fast');
    });
  });

  describe('suspend semantics — unchanged by toolsComplete', () => {
    it('does NOT synthesize a placeholder for a PromptSuspend-throwing tool', async () => {
      // Suspend/resume relies on the missing result slot. The
      // synthesis pass must skip `status === 'suspended'`.
      const suspendingTool = new Tool({
        name: 'suspender',
        description: 'Suspends execution',
        instructions: 'Throws PromptSuspend',
        schema: z.object({}),
        call: () => {
          throw new PromptSuspend('Waiting for approval');
        },
      });

      const prompt = new Prompt({
        name: 'suspend-no-synth',
        description: 'Suspend test',
        content: 'Run',
        tools: [suspendingTool],
        // explicit-true to prove the suspend short-circuit holds
        toolsComplete: true,
      });

      const executor = createMockExecutor({
        responses: [
          {
            content: '',
            finishReason: 'tool_calls',
            toolCalls: [{ id: 'call_susp', name: 'suspender', arguments: '{}' }],
          },
        ],
      });

      const ctx: Context<{}, {}> = {
        execute: executor,
        messages: [],
      };

      const events: PromptEvent<string, [AnyTool]>[] = [];
      for await (const event of prompt.run({}, ctx)) {
        events.push(event);
      }

      const suspendEvent = events.find((e) => e.type === 'suspend') as
        | { type: 'suspend'; request: { messages: Message[] } }
        | undefined;
      expect(suspendEvent).toBeDefined();

      const finalMessages = suspendEvent!.request.messages;
      const toolResults = finalMessages.filter((m) => m.role === 'tool');
      // No tool result — synthesis correctly skipped the suspended tool.
      expect(toolResults).toHaveLength(0);
      // Assistant message with the tool_call is present, as before.
      const assistant = finalMessages.find(
        (m) => m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0,
      );
      expect(assistant).toBeDefined();
      expect(assistant!.toolCalls![0]!.id).toBe('call_susp');
    });
  });
});
