import { a, type Bindable, type Bound } from '@aeye/schema';
import type { Registry, Value, Type } from '@aeye/gin';
import { ginValue, val } from '@aeye/gin';
import type { AI } from '@aeye/ai';
import { modelFor } from '../model-selection';
import { getRuntimeSignal } from '../runtime-signal';
import { logger, genId } from '../logger';

/** Input shape passed to the shared `gin_llm_call` prompt — carries both
 *  the user prompt and the per-call output schema, so the prompt itself
 *  is constructed exactly once (at module load) instead of per call. */
type LlmInput = { prompt: string; output?: Type };

/** A plain-text answer (no `output` type). */
const TEXT = a.string();

/**
 * The answer's schema, per call: the `output` type's value schema
 * (`ginValue`, memoized per type; a non-object root is wrapped as
 * `{input}` by the request where the provider needs an object), or plain
 * text. A `text` output is the model's text itself.
 */
export const llmOutput = {
  bind: (_ctx: unknown, input?: LlmInput): Bound<string | object> => (input?.output ? ginValue<string | object>(input.output) : TEXT.bind() as unknown as Bound<string | object>),
} as unknown as Bindable<string | object, [ctx: unknown, input: LlmInput]>;

export function createLlmImpl(registry: Registry, ai: AI<any>) {
  // Build the prompt ONCE here. Previously this lived inside the
  // returned closure and ran per `fns.llm` invocation — every call
  // pushed a fresh Prompt into `ai.components` (see ai.ts:861), which
  // grew unbounded and OOMed V8. Hoisting it out means we register
  // exactly one Prompt for the lifetime of the AI instance, and the
  // per-call data (prompt text + output schema) flows through input.
  const llmPrompt = ai.prompt({
    name: 'gin_llm_call',
    description: 'LLM invocation from gin program',
    content: '{{userPrompt}}',
    input: (input: LlmInput) => ({ userPrompt: input.prompt }),
    // One schema, bound per call with the current `input`: each call gets
    // the output type it asks for (or plain text) without a fresh Prompt.
    schema: llmOutput,
    metadata: modelFor('llm'),
  });

  return async (argsValue: Value): Promise<Value> => {
    const args = argsValue.raw as Record<string, Value>;
    const promptText = (args['prompt']?.raw ?? '') as string;
    const outputType = args['output']?.raw as Type | undefined;

    // The output type's value schema is the answer's schema (`llmOutput`):
    // a `text` output is the model's text, anything else structured output
    // (wrapped as `{input}` by the request where the provider needs an
    // object root, and unwrapped on decode).
    // Plumb the entry-point's interrupt signal through so an ESC during
    // a long llm call cancels the HTTP request rather than hanging.
    const signal = getRuntimeSignal();
    const result = await llmPrompt.get(
      'result',
      { prompt: promptText, ...(outputType ? { output: outputType } : {}) },
      ({ signal }),
    );

    const finalResult = result;

    if (outputType) {
      // Surface a clear error (with a 6-char id pointing at the full
      // raw response in ginny.log) when the LLM gave us nothing
      // parseable. The previous behaviour fell back to an empty text
      // Value, which then surfaced downstream as the cryptic
      // "text.parse: expected string, got undefined" against the
      // caller's typed slot — much harder to diagnose.
      if (finalResult === undefined || finalResult === null) {
        const id = genId();
        logger.log(`[${id}] fns.llm returned ${finalResult === null ? 'null' : 'undefined'}; outputType=${outputType.toCode()} prompt=${JSON.stringify(promptText.slice(0, 200))}`);
        throw new Error(`fns.llm produced no usable response for output ${outputType.toCode()} [${id}]`);
      }
      try {
        return outputType.parse(finalResult);
      } catch (e: unknown) {
        const id = genId();
        const raw = typeof finalResult === 'string'
          ? finalResult
          : (() => { try { return JSON.stringify(finalResult); } catch { return String(finalResult); } })();
        logger.log(`[${id}] fns.llm parse-failure outputType=${outputType.toCode()} raw=${raw}`);
        throw new Error(`fns.llm output didn't parse against ${outputType.toCode()} [${id}]: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    return val(registry.text(), (finalResult as string) ?? '');
  };
}

export function registerLlmType(registry: Registry) {
  return registry.fn({
    args: registry.obj({
      prompt: { type: registry.text() },
      tools:  { type: registry.optional(registry.list(registry.any())) },
      output: {
        type: registry.optional(registry.typ(registry.alias('R'))),
        docs: 'gin Type to parse the LLM response through — unifies R in the return type. `text` and `obj` types pass straight through (text uses plain-completion mode, obj uses structured-output mode). Other types (enum/num/bool/list/tuple) are wrapped as { input } over the wire where the provider needs an object, and unwrapped before parse, so callers see the inner value.',
      },
    }),
    returns: registry.alias('R'),
    // Constraint on R, not a default. Anything `output:` resolves to is
    // wrappable into the LLM's structured-output channel — primitives,
    // enums, lists, objs all work. `any` keeps the surface permissive.
    generic: { R: registry.any() },
    call: registry.nativeExpr('fns.llm'),
  });
}
