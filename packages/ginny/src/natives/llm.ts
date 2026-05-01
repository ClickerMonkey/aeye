import { z } from 'zod';
import type { Registry, Value, Type } from '@aeye/gin';
import { val } from '@aeye/gin';
import type { AI } from '@aeye/ai';
import { modelFor } from '../model-selection';
import { getRuntimeSignal } from '../runtime-signal';

export function createLlmImpl(registry: Registry, ai: AI<any>) {
  return async (argsValue: Value): Promise<Value> => {
    const args = argsValue.raw as Record<string, Value>;
    const promptText = (args['prompt']?.raw ?? '') as string;
    const outputType = args['output']?.raw as Type | undefined;

    // Two shapes pass straight through to the AI layer:
    //   - `z.ZodObject` — uses OpenAI's structured-output channel
    //     (`response_format: json_schema`, which requires `type:
    //     "object"` at the root).
    //   - `z.ZodString` — the AI library skips structured output for
    //     plain-string schemas and returns the model's text directly.
    //     That's what some models prefer (cheaper, no JSON wrapping
    //     overhead) and matches what callers expect when `output: text`.
    // Anything else (enum, num, bool, list, tuple) is wrapped in a
    // `{ value: <inner> }` shell so the structured-output channel
    // accepts it; we unwrap before parsing so callers see the inner
    // value.
    const innerSchema = outputType ? outputType.toValueSchema() : undefined;
    let promptSchema: z.ZodType<string | object> | undefined;
    let unwrap = false;
    if (innerSchema) {
      if (innerSchema instanceof z.ZodObject || innerSchema instanceof z.ZodString) {
        promptSchema = innerSchema;
      } else {
        promptSchema = z.object({ value: innerSchema });
        unwrap = true;
      }
    }

    const llmPrompt = ai.prompt({
      name: 'gin_llm_call',
      description: 'LLM invocation from gin program',
      content: '{{userPrompt}}',
      input: (input: { prompt: string }) => ({ userPrompt: input.prompt }),
      metadata: modelFor('llm') as any,
      schema: promptSchema,
    });

    // Plumb the entry-point's interrupt signal through so an ESC during
    // a long llm call cancels the HTTP request rather than hanging.
    const signal = getRuntimeSignal();
    const result = await llmPrompt.get(
      'result',
      { prompt: promptText },
      ({ signal } as any),
    );

    const finalResult = unwrap && result && typeof result === 'object'
      ? (result as { value: unknown }).value
      : result;

    if (outputType && finalResult !== undefined) {
      try {
        return outputType.parse(finalResult);
      } catch {
        return val(registry.text(), JSON.stringify(finalResult));
      }
    }

    return val(registry.text(), (finalResult as string) ?? '');
  };
}

export function registerLlmType(registry: Registry) {
  return registry.fn(
    registry.obj({
      prompt: { type: registry.text() },
      tools:  { type: registry.optional(registry.list(registry.any())) },
      output: {
        type: registry.optional(registry.typ(registry.alias('R'))),
        docs: 'gin Type to parse the LLM response through — unifies R in the return type. `text` and `obj` types pass straight through (text uses plain-completion mode, obj uses structured-output mode). Other types (enum/num/bool/list/tuple) are auto-wrapped as { value } over the wire and unwrapped before parse, so callers see the inner value.',
      },
    }),
    registry.alias('R'),
    undefined,
    // Constraint on R, not a default. Anything `output:` resolves to is
    // wrappable into the LLM's structured-output channel — primitives,
    // enums, lists, objs all work. `any` keeps the surface permissive.
    { R: registry.any() },
  );
}
