/**
 * Schema fallbacks: a provider's classified schema rejection steps the prompt
 * down `SCHEMA_FALLBACKS` (or its own list) and the request goes again.
 */

import { z } from 'zod';
import { deliverSchema, SCHEMA_FALLBACKS, schemaRejection } from '../delivery';
import { SchemaRejectedError } from '../errors';
import { Prompt, PromptEvent } from '../prompt';
import { Tool } from '../tool';
import type { Context, Request, Response, SchemaFallback, SchemaTarget } from '../types';

/** What the provider saw on each call: the output's strict and delivery, and each tool's strict. */
interface Sent {
  strict?: boolean | number;
  delivery?: string;
  tools: Record<string, boolean | number | undefined>;
}

function snapshot(request: Request): Sent {
  const format = request.responseFormat;
  return {
    strict: typeof format === 'object' ? format.strict : undefined,
    delivery: typeof format === 'object' ? format.schemaDelivery : undefined,
    tools: Object.fromEntries((request.tools ?? []).map(tool => [tool.name, tool.strict])),
  };
}

/**
 * An executor that rejects `target` while `rejects(request)` holds, then
 * returns the replies in turn.
 */
function rejectingExecutor(target: SchemaTarget, rejects: (request: Request) => boolean, replies: Partial<Response>[], sent: Sent[]) {
  let reply = 0;
  return async (request: Request): Promise<Response> => {
    sent.push(snapshot(request));
    if (rejects(request)) {
      throw new SchemaRejectedError(target, '400 Invalid schema');
    }
    return { content: '', finishReason: 'stop', model: 'mock', ...replies[Math.min(reply++, replies.length - 1)] };
  };
}

const deliveredAs = (delivery: string) => (request: Request) =>
  typeof request.responseFormat === 'object' && request.responseFormat.schemaDelivery !== delivery;

function outputPrompt(extra?: { schemaFallbacks?: readonly SchemaFallback[]; runtimeSchemaFallback?: boolean; schemaDelivery?: 'structured' }) {
  return new Prompt({
    name: 'fallbacks',
    description: 'Schema fallbacks',
    content: 'Answer.',
    schema: z.object({ value: z.number() }),
    outputRetries: 0,
    ...extra,
  });
}

async function collect(prompt: Prompt<{}, {}, string, {}, { value: number }>, ctx: Context<{}, {}>) {
  const events: PromptEvent<{ value: number }, []>[] = [];
  for await (const event of prompt.get('stream', {}, ctx)) {
    events.push(event);
  }
  return events;
}

describe('schema fallbacks', () => {
  it('steps the output down strict → non-strict → JSON → text without spending output retries', async () => {
    const sent: Sent[] = [];
    const execute = rejectingExecutor({ kind: 'output' }, deliveredAs('prompt'), [{ content: '{"value":3}' }], sent);
    const events = await collect(outputPrompt(), { execute });

    expect(sent.map(({ strict, delivery }) => [strict, delivery])).toEqual([
      [1, 'auto'],
      [false, 'auto'],
      [false, 'json'],
      [false, 'prompt'],
    ]);
    expect(events.flatMap(e => e.type === 'schemaFallback' ? [e.fallback] : [])).toEqual(['non-strict', 'json', 'text']);
    expect(events.find(e => e.type === 'complete')).toMatchObject({ output: { value: 3 } });
  });

  it('remembers the step for the rest of the run', async () => {
    const sent: Sent[] = [];
    const lookup = new Tool({
      name: 'lookup',
      description: 'Looks up',
      instructions: 'Look up',
      schema: z.object({ q: z.string() }),
      call: () => 'found',
    });
    const other = new Tool({
      name: 'other',
      description: 'Other',
      instructions: 'Other',
      schema: z.object({ q: z.string() }),
      call: () => 'other',
    });
    const execute = rejectingExecutor(
      { kind: 'tool', name: 'lookup' },
      request => request.tools?.find(tool => tool.name === 'lookup')?.strict !== false,
      [
        { finishReason: 'tool_calls', toolCalls: [{ id: '1', name: 'lookup', arguments: '{"q":"a"}' }] },
        { content: 'done' },
      ],
      sent,
    );
    const prompt = new Prompt({ name: 'tools', description: 'Tools', content: 'Use tools.', tools: [lookup, other] });

    expect(await prompt.get('result', {}, { execute })).toBe('done');
    // Rejected once, then the relaxed tool stays relaxed; the other keeps its strict preference.
    expect(sent.map(s => s.tools)).toEqual([
      { lookup: 1, other: 1 },
      { lookup: false, other: 1 },
      { lookup: false, other: 1 },
    ]);
  });

  it('re-applies the step after a dynamic prompt re-resolves its request', async () => {
    const sent: Sent[] = [];
    const ping = new Tool({ name: 'ping', description: 'Ping', instructions: 'Ping', schema: z.object({}), call: () => 'pong' });
    const execute = rejectingExecutor(
      { kind: 'output' },
      request => typeof request.responseFormat === 'object' && request.responseFormat.strict !== false,
      [
        { finishReason: 'tool_calls', toolCalls: [{ id: '1', name: 'ping', arguments: '{}' }] },
        { content: '{"value":2}' },
      ],
      sent,
    );
    const prompt = new Prompt({
      name: 'dynamic',
      description: 'Dynamic',
      content: 'Answer.',
      schema: z.object({ value: z.number() }),
      tools: [ping],
      dynamic: true,
    });

    expect(await prompt.get('result', {}, { execute })).toEqual({ value: 2 });
    expect(sent.map(({ strict }) => strict)).toEqual([1, false, false]);
  });

  it('throws the rejection once no fallback applies', async () => {
    const sent: Sent[] = [];
    const execute = rejectingExecutor({ kind: 'output' }, () => true, [{}], sent);

    await expect(outputPrompt({ schemaDelivery: 'structured' }).get('result', {}, { execute })).rejects.toBeInstanceOf(SchemaRejectedError);
    // 'structured' only allows the non-strict step.
    expect(sent.map(({ strict }) => strict)).toEqual([1, false]);
  });

  it('takes a step at most once per schema, even when it always applies', async () => {
    const sent: Sent[] = [];
    const always: SchemaFallback = { name: 'always', apply: () => true };
    const execute = rejectingExecutor({ kind: 'output' }, () => true, [{}], sent);

    await expect(outputPrompt({ schemaFallbacks: [always] }).get('result', {}, { execute })).rejects.toBeInstanceOf(SchemaRejectedError);
    expect(sent).toHaveLength(2);
  });

  it('uses the context fallbacks AI-wide, and the prompt overrides them', async () => {
    const straightToText: SchemaFallback = SCHEMA_FALLBACKS.find(step => step.name === 'text')!;
    const sent: Sent[] = [];
    const execute = rejectingExecutor({ kind: 'output' }, deliveredAs('prompt'), [{ content: '{"value":1}' }], sent);

    expect(await outputPrompt().get('result', {}, { execute, schemaFallbacks: [straightToText] })).toEqual({ value: 1 });
    expect(sent.map(({ delivery }) => delivery)).toEqual(['auto', 'prompt']);

    await expect(outputPrompt({ schemaFallbacks: [] }).get('result', {}, { execute, schemaFallbacks: [straightToText] })).rejects.toBeInstanceOf(SchemaRejectedError);
  });

  it('is off with runtimeSchemaFallback: false', async () => {
    const sent: Sent[] = [];
    const execute = rejectingExecutor({ kind: 'output' }, () => true, [{}], sent);

    await expect(outputPrompt({ runtimeSchemaFallback: false }).get('result', {}, { execute })).rejects.toBeInstanceOf(SchemaRejectedError);
    expect(sent).toHaveLength(1);
  });
});

describe('schemaRejection', () => {
  const tool = (name: string) => ({ name, parameters: z.object({}) });
  const withOutput: Request = { messages: [], tools: [tool('a'), tool('b')], responseFormat: { type: z.object({}), strict: 1 } };
  const toolsOnly: Request = { messages: [], tools: [tool('a'), tool('b')] };

  it.each([
    ["400 Invalid schema for response_format 'response': ...", withOutput, { kind: 'output' }],
    ["400 Invalid schema for function 'b': ...", withOutput, { kind: 'tool', name: 'b' }],
    ['400 Invalid schema for tools[1].function.parameters', toolsOnly, { kind: 'tool', name: 'b' }],
    ['ValidationException: tools.0.custom.input_schema: JSON schema is invalid', toolsOnly, { kind: 'tool', name: 'a' }],
    ['400 The schema is too complex', withOutput, { kind: 'output' }],
    ['400 The schema is too complex', toolsOnly, { kind: 'tools' }],
  ])('classifies %s', (message, request, target) => {
    expect(schemaRejection(request, new Error(message))?.target).toEqual(target);
  });

  it('ignores errors that are not about a schema', () => {
    expect(schemaRejection(withOutput, new Error("400 Unsupported parameter: 'temperature'"))).toBeUndefined();
  });
});

describe('deliverSchema', () => {
  const request = (schemaDelivery: 'auto' | 'json' | 'prompt'): Request => ({
    messages: [{ role: 'system', content: 'Answer.' }],
    responseFormat: { type: z.object({ value: z.number() }), strict: 1, schemaDelivery },
  });

  it('sends a structured schema as is', () => {
    const original = request('auto');
    expect(deliverSchema(original)).toBe(original);
  });

  it.each([['json', 'json'], ['prompt', undefined]] as const)("moves a '%s' schema into the prompt", (delivery, format) => {
    const original = request(delivery);
    const sent = deliverSchema(original);
    expect(sent.responseFormat).toBe(format);
    expect(sent.messages[0].content).toContain('"value"');
    expect(original.messages[0].content).toBe('Answer.');
  });

  it('can force a delivery, for providers without structured output', () => {
    expect(deliverSchema(request('auto'), undefined, 'prompt').responseFormat).toBeUndefined();
  });
});
