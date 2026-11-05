/**
 * Model mistakes vs tool failures: every tool error, tool result message, and
 * error thrown out of a prompt says who caused it.
 */

import { z } from 'zod';
import { OutputValidationError, PromptError, ToolExecutionError, ToolInputError } from '../errors';
import { Prompt, PromptEvent } from '../prompt';
import { AnyTool, Tool } from '../tool';
import type { Message, Response } from '../types';
import { createMockExecutor } from './mocks/executor.mock';

type Ev = PromptEvent<string, [AnyTool]>;

const boom = new Error('database down');
const lookup = new Tool({
  name: 'lookup',
  description: 'Looks up',
  instructions: 'Look up',
  schema: z.object({ q: z.string() }),
  call: ({ q }) => {
    if (q === 'fail') {
      throw boom;
    }
    return 'found';
  },
});

async function run(responses: Partial<Response>[], toolRetries = 2) {
  const prompt = new Prompt({ name: 'kinds', description: 'Kinds', content: 'Use tools.', tools: [lookup], toolRetries });
  const events: Ev[] = [];
  let error: unknown;
  try {
    for await (const event of prompt.get('stream', {}, { execute: createMockExecutor({ responses }) })) {
      events.push(event);
    }
  } catch (e) {
    error = e;
  }
  const failures = events.flatMap(e => e.type === 'toolError' ? [e.failure] : []);
  const toolMessages = events.flatMap((e): Message[] => e.type === 'message' && e.message.role === 'tool' ? [e.message] : []);
  return { events, failures, toolMessages, error };
}

const callWith = (name: string, args: string): Partial<Response> => ({
  content: '',
  finishReason: 'tool_calls',
  toolCalls: [{ id: '1', name, arguments: args }],
});

describe('error kinds', () => {
  it('an unknown tool is a model mistake', async () => {
    const { failures, toolMessages } = await run([callWith('missing', '{}'), { content: 'ok' }]);
    expect(failures[0]).toBeInstanceOf(ToolInputError);
    expect(failures[0]).toMatchObject({ kind: 'model', tool: 'missing' });
    expect(toolMessages[0].failure).toBe('model');
  });

  it('arguments that fail the schema are a model mistake, keeping the raw arguments', async () => {
    const { failures, toolMessages, events } = await run([callWith('lookup', '{"q":5}'), { content: 'ok' }]);
    expect(failures[0]).toBeInstanceOf(ToolInputError);
    expect(failures[0]).toMatchObject({ kind: 'model', rawArgs: '{"q":5}' });
    expect(events.find(e => e.type === 'toolError')).toMatchObject({ rawArgs: '{"q":5}' });
    expect(toolMessages[0].failure).toBe('model');
  });

  it("a tool's own throw is a tool failure, with the thrown error as cause", async () => {
    const { failures, toolMessages } = await run([callWith('lookup', '{"q":"fail"}'), { content: 'ok' }]);
    expect(failures[0]).toBeInstanceOf(ToolExecutionError);
    expect(failures[0]).toMatchObject({ kind: 'tool', tool: 'lookup', cause: boom });
    expect(toolMessages[0].failure).toBe('tool');
  });

  it('a success carries no failure', async () => {
    const { toolMessages } = await run([callWith('lookup', '{"q":"a"}'), { content: 'ok' }]);
    expect(toolMessages[0].failure).toBeUndefined();
  });

  it('running out of iterations after tool failures throws a tool-kind PromptError', async () => {
    const { error } = await run([callWith('lookup', '{"q":"fail"}')], 0);
    expect(error).toBeInstanceOf(PromptError);
    expect(error).toMatchObject({ kind: 'tool' });
    expect(error instanceof PromptError && error.cause).toBeInstanceOf(ToolExecutionError);
  });

  it('invalid output is a model mistake: retried with the error on textReset, then thrown', async () => {
    const prompt = new Prompt({
      name: 'output',
      description: 'Output',
      content: 'Answer.',
      schema: z.object({ value: z.number() }),
      outputRetries: 1,
    });
    const events: PromptEvent<{ value: number }, []>[] = [];
    const execute = createMockExecutor({ responses: [{ content: '{"value":"x"}' }, { content: 'not json' }] });
    const run = async () => {
      for await (const event of prompt.get('stream', {}, { execute })) {
        events.push(event);
      }
    };

    const error = await run().then(() => undefined, (e: unknown) => e);

    const reset = events.find(e => e.type === 'textReset');
    expect(reset?.type === 'textReset' && reset.error).toMatchObject({ kind: 'model', reason: 'schema-parsing' });
    expect(error).toBeInstanceOf(PromptError);
    expect(error).toMatchObject({ kind: 'model', message: expect.stringContaining('Prompt output failed: The output was not valid JSON') });
    expect(error instanceof PromptError && error.cause).toBeInstanceOf(OutputValidationError);
    expect(error instanceof PromptError && error.cause).toMatchObject({ reason: 'json-parsing', output: 'not json' });
  });

  it('a validate failure is not returned once retries run out', async () => {
    const prompt = new Prompt({
      name: 'validated',
      description: 'Validated',
      content: 'Answer.',
      schema: z.object({ value: z.number() }),
      outputRetries: 0,
      validate: ({ value }) => {
        if (value < 0) {
          throw new Error('must be positive');
        }
      },
    });
    const execute = createMockExecutor({ responses: [{ content: '{"value":-1}' }] });

    await expect(prompt.get('result', {}, { execute })).rejects.toMatchObject({ kind: 'model', cause: { reason: 'validation' } });
  });
});
