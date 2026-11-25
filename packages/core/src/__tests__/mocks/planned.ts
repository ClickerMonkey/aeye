/**
 * A fake provider for schema tests: it plans each request for a model the
 * way a real provider does (`prepareRequest`), records what it would send,
 * and answers with scripted turns written the way THAT model writes them
 * (`plan.encodeCall`: records as pairs on OpenAI strict, absent as `null`,
 * a dispatched tool through `run_tool`, ...).
 */
import { prepareRequest, sentOutput, sentTools, type ModelLike, type SentTool } from '../../schema';
import type { Executor, Request, Response, ToolCall } from '../../types';

/** One reply of the fake model. */
export interface PlannedTurn {
  content?: string;
  /** Calls by their CODE-shape args, written as this model writes them. */
  calls?: { tool: string; args: unknown }[];
  /** Calls exactly as on the wire. */
  raw?: { name: string; arguments: string; invalid?: string }[];
}

/** What the fake provider sent for one request. */
export interface Sent {
  request: Request;
  tools: SentTool[];
  output: ReturnType<typeof sentOutput>;
  system: string;
}

export const MODELS = {
  gpt: { id: 'gpt-4o', provider: 'openai', capabilities: ['toolsStrict', 'structured', 'json'] },
  gptLoose: { id: 'gpt-4o-mini', provider: 'openai', capabilities: ['json'] },
  claude: { id: 'claude-sonnet-4-5', provider: 'anthropic', capabilities: ['toolsStrict', 'structured'] },
  claudeOld: { id: 'claude-3-haiku', provider: 'anthropic', capabilities: [] },
  gemini: { id: 'gemini-2.5-pro', provider: 'google', capabilities: ['toolsStrict', 'structured', 'json'] },
  grok: { id: 'grok-4', provider: 'xai', capabilities: ['structured', 'json'] },
  ollama: { id: 'llama3.1', provider: 'ollama', capabilities: ['json'] },
  routedClaude: { id: 'anthropic/claude-sonnet-4.5', provider: 'openrouter', capabilities: ['toolsStrict', 'structured'] },
} satisfies Record<string, ModelLike>;

/**
 * An executor that plans for `model` (lenient without one) and replies with
 * `turns` in order (the last one repeats).
 */
export function plannedExecutor(
  model: ModelLike | undefined,
  turns: ReadonlyArray<PlannedTurn | ((sent: Sent) => PlannedTurn)>,
  opts: { speaks?: ReadonlySet<string> } = {},
): { execute: Executor<any, any>; sent: Sent[] } {
  const sent: Sent[] = [];
  let index = 0;
  const execute: Executor<any, any> = async (request) => {
    const prepared = await prepareRequest(request, model, opts);
    const record: Sent = {
      request: prepared,
      tools: sentTools(prepared),
      output: sentOutput(prepared),
      system: String(prepared.messages.find(message => message.role === 'system')?.content ?? ''),
    };
    sent.push(record);
    const at = index++;
    const scripted = turns[Math.min(at, turns.length - 1)]!;
    const turn = typeof scripted === 'function' ? scripted(record) : scripted;
    const toolCalls: ToolCall[] = [
      ...(turn.calls ?? []).map((call, k) => {
        const wire = prepared.plan!.encodeCall(call.tool, call.args);
        return { id: `call_${at}_${k}`, name: wire.name, arguments: JSON.stringify(wire.args) };
      }),
      ...(turn.raw ?? []).map((call, k) => ({ id: `raw_${at}_${k}`, ...call })),
    ];
    const response: Response = {
      content: turn.content ?? '',
      finishReason: toolCalls.length ? 'tool_calls' : 'stop',
      model: model?.id ?? 'lenient',
      ...(toolCalls.length ? { toolCalls } : {}),
    };
    return response;
  };
  return { execute, sent };
}
