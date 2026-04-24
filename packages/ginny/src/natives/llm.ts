import type { Registry, Value, Type } from '@aeye/gin';
import { val } from '@aeye/gin';
import type { AI } from '@aeye/ai';

export function createLlmImpl(registry: Registry, ai: AI<any>) {
  return async (argsValue: Value): Promise<Value> => {
    const args = argsValue.raw as Record<string, Value>;
    const promptText = (args['prompt']?.raw ?? '') as string;
    const outputType = args['output']?.raw as Type | undefined;

    const schema = outputType ? outputType.toValueSchema() : undefined;

    const llmPrompt = ai.prompt({
      name: 'gin_llm_call',
      description: 'LLM invocation from gin program',
      content: '{{userPrompt}}',
      input: (input: { prompt: string }) => ({ userPrompt: input.prompt }),
      schema: schema as any,
    });

    const result = await llmPrompt.get('result', { prompt: promptText }, {} as any);

    if (outputType && result !== undefined) {
      try {
        return outputType.parse(result);
      } catch {
        return val(registry.text(), JSON.stringify(result));
      }
    }

    return val(registry.text(), (result as string) ?? '');
  };
}

export function registerLlmType(registry: Registry) {
  return registry.fn(
    registry.obj({
      prompt: { type: registry.text() },
      tools:  { type: registry.optional(registry.list(registry.any())) },
      output: {
        type: registry.optional(registry.typ(registry.generic('R'))),
        docs: 'gin Type to parse the LLM response through — unifies R in the return type.',
      },
    }),
    registry.generic('R'),
    undefined,
    { R: registry.text() },
  );
}
