import { Chunk, ComponentOutput, Events, Instance, Model, ModelInput, Reasoning, Resource, Response, Runner, Usage } from "./types";

/**
 * A flexible function type that can be:
 * - A direct value of type R
 * - A function that takes arguments A and returns R or Promise<R>
 * - A Promise that resolves to R
 */
export type Fn<R, A extends [any?, ...any[]] = []> = R | ((...args: A) => (R | Promise<R>)) | Promise<R>;

/**
 * Computes the resulting type R from a flexible function type Fn.
 */
export type FnResult<R> = R extends Promise<infer U> 
  ? U 
  : R extends (...args: any[]) => infer V
    ? V extends Promise<infer W>
      ? W
      : V
    : R;

/**
 * Retrieves the argument types A from a flexible function type Fn.
 */
export type FnArgs<F, Assumed = never> = F extends (...args: infer A) => any ? A : Assumed;

/**
 * Resolves a flexible function type into its standardized async function form.
 */
export type FnResolved<F extends Fn<any, any> | undefined> = 
  F extends undefined
    ? () => Promise<undefined>
    : F extends Fn<infer R, infer A>
      ? (...args: A) => Promise<R>
      : never
;

/**
 * Converts a flexible function type into a standardized async function.
 * Handles values, functions, and promises uniformly by wrapping them in async functions.
 *
 * @param fn - The flexible function type to convert.
 * @param reprocess - Optional function to transform the resolved value.
 * @returns An async function that takes the same arguments and returns a Promise of the resolved type.
 * @example
 * const fn1 = resolveFn(42); // () => Promise<42>
 * const fn2 = resolveFn(() => 'hello'); // () => Promise<'hello'>
 * const fn3 = resolveFn(Promise.resolve(10)); // () => Promise<10>
 */
export function resolveFn<R, A extends [any?, ...any[]] = []>(fn: undefined): ((...args: A) => Promise<undefined>)
export function resolveFn<R, A extends [any?, ...any[]] = []>(fn: Fn<R, A>): ((...args: A) => Promise<R>)
export function resolveFn<R, A extends [any?, ...any[]] = [], R2 = R>(fn: Fn<R, A>, reprocess: (r: R) => R2): ((...args: A) => Promise<R2>)
export function resolveFn<R, A extends [any?, ...any[]] = []>(fn?: Fn<R, A>, reprocess?: (r: R) => R): ((...args: A) => Promise<R | undefined>) {
  if (!fn) {
    return async () => undefined;
  }

  const isFunc = (x: any): x is ((...args: A) => (R | Promise<R>)) => typeof x === 'function';

  if (reprocess) {
    return fn instanceof Promise
      ? async () => reprocess(await fn)
      : isFunc(fn)
        ? async (...args: A) => reprocess(await fn(...args))
        : (() => {
            const cached = reprocess(fn);
            return async () => cached;
          })();
  } else {
    return fn instanceof Promise
      ? () => fn
      : isFunc(fn)
        ? async (...args: A) => await fn(...args)
        : async () => fn;
  }
}


/**
 * Checks if a promise has settled (either fulfilled or rejected).
 *
 * @param p - The promise to check.
 * @returns A promise that resolves to true if settled, false otherwise.
 */
export async function isSettled(p: Promise<any>): Promise<boolean> {
  return Promise.race([p.then(() => true), Promise.resolve(false)])
}

/**
 * Type guard to check if a value is a Promise.
 *
 * @param value - The value to check.
 * @returns True if the value is a Promise, false otherwise.
 */
export function isPromise<T = any>(value: any): value is Promise<T> {
  return value !== null && typeof value === 'object' && typeof value.then === 'function';
}

/**
 * Type guard to check if a value is an AsyncGenerator.
 *
 * @param value - The value to check.
 * @returns True if the value is an AsyncGenerator, false otherwise.
 */
export function isAsyncGenerator(value: any): value is AsyncGenerator<any, any, any> {
  return (
    value != null &&
    typeof value === "object" &&
    typeof (value as any)[Symbol.asyncIterator] === "function" &&
    typeof (value as any).next === "function" &&
    typeof (value as any).throw === "function" &&
    typeof (value as any).return === "function"
  );
}

/**
 * Yields promises as they settle (either fulfill or reject), maintaining their original indices.
 * Useful for processing multiple async operations as soon as each one completes.
 *
 * @param promises - Array of promises to yield as they settle.
 * @returns An async generator yielding objects with the settled promise and its index.
 * @example
 * const promises = [delay(100), delay(50), delay(200)];
 * for await (const { result, index } of yieldAll(promises)) {
 *   console.log(`Promise ${index} settled`);
 *   const value = await result;
 * }
 */
export async function* yieldAll<T>(
  promises: Promise<T>[]
): AsyncGenerator<{ result: Promise<T>, index: number }> {
  // Create index-tracking promises that resolve with their index
  const indexPromises = promises.map((p, i) =>
    // both fulfillment and rejection resolve to the index so the race
    // tells us when a promise *settles* (either way)
    p.then(() => i, () => i)
  );

  // Keep a Set of pending indices (stable ids that never shift)
  const pending = new Set<number>(promises.map((_, i) => i));

  while (pending.size > 0) {
    // Race only the still-pending index-promises
    const racers = Array.from(pending).map(i => indexPromises[i]);
    const idx = await Promise.race(racers);

    // Yield the original Promise<T> so the caller decides how to await/handle it
    yield { result: promises[idx], index: idx };

    // Remove by stable index (no shifting problems)
    pending.delete(idx);
  }
}

/**
 * Resolves an output value from various input types.
 * Handles promises, raw values, and AsyncGenerators uniformly.
 * These are all common return types of AI components.
 *
 * @param input - The value to resolve (can be a value, Promise, or AsyncGenerator).
 * @returns A promise that resolves to the final value.
 * @example
 * await resolve(42); // 42
 * await resolve(Promise.resolve('hello')); // 'hello'
 * await resolve(asyncGenerator()); // final return value
 */
export async function resolve(input: any): Promise<any> {
  if (isPromise(input)) {
    return resolve(await input);
  } else if (isAsyncGenerator(input)) {
    let result = await input.next();
    while (!result.done) {
      result = await input.next();
    }
    return resolve(result.value);
  } else if (typeof input === 'function') {  
    return resolve(input());
  } else {
    return input;
  }
}

/**
 * Consumes all values from an AsyncGenerator and returns them as an array.
 * 
 * @param gen - The AsyncGenerator to consume.
 * @returns An array of all values yielded by the generator.
 */
export async function consumeAll<E>(gen: AsyncGenerator<E, any, any>): Promise<E[]> {
  const results: E[] = [];
  for await (const item of gen) {
    results.push(item);
  }
  return results;
}

/**
 * Resolves the type R from a value passed to `resolve`.
 */
export type Resolved<T> = T extends Promise<infer U> 
  ? Resolved<U>
  : T extends AsyncGenerator<any, infer U, any> 
    ? Resolved<U>
    : T
;

/**
 * Accumulates usage statistics by adding values from one Usage object to another.
 * Handles the nested structure matching ModelPricing.
 * 
 * @param target - The target Usage object to accumulate into.
 * @param add - The Usage object to add from.
 * @returns 
 */
export function accumulateUsage(target: Usage, add?: Usage) {
  if (!add) {
    return;
  }

  // Accumulate text usage
  if (add.text) {
    if (!target.text) {
      target.text = {};
    }
    if (add.text.input !== undefined) {
      target.text.input = (target.text.input || 0) + add.text.input;
    }
    if (add.text.output !== undefined) {
      target.text.output = (target.text.output || 0) + add.text.output;
    }
    if (add.text.cached !== undefined) {
      target.text.cached = (target.text.cached || 0) + add.text.cached;
    }
  }

  // Accumulate audio usage
  if (add.audio) {
    if (!target.audio) {
      target.audio = {};
    }
    if (add.audio.input !== undefined) {
      target.audio.input = (target.audio.input || 0) + add.audio.input;
    }
    if (add.audio.output !== undefined) {
      target.audio.output = (target.audio.output || 0) + add.audio.output;
    }
    if (add.audio.seconds !== undefined) {
      target.audio.seconds = (target.audio.seconds || 0) + add.audio.seconds;
    }
  }

  // Accumulate image usage
  if (add.image) {
    if (!target.image) {
      target.image = { output: [] };
    }
    if (add.image.input !== undefined) {
      target.image.input = (target.image.input || 0) + add.image.input;
    }
    if (add.image.output) {
      if (!target.image.output) {
        target.image.output = [];
      }
      // Merge image outputs by quality and size
      for (const addOutput of add.image.output) {
        const existing = target.image.output.find(
          o => o.quality === addOutput.quality && 
               o.size.width === addOutput.size.width && 
               o.size.height === addOutput.size.height
        );
        if (existing) {
          existing.count += addOutput.count;
        } else {
          target.image.output.push({ ...addOutput });
        }
      }
    }
  }

  // Accumulate reasoning usage
  if (add.reasoning) {
    if (!target.reasoning) {
      target.reasoning = {};
    }
    if (add.reasoning.input !== undefined) {
      target.reasoning.input = (target.reasoning.input || 0) + add.reasoning.input;
    }
    if (add.reasoning.output !== undefined) {
      target.reasoning.output = (target.reasoning.output || 0) + add.reasoning.output;
    }
    if (add.reasoning.cached !== undefined) {
      target.reasoning.cached = (target.reasoning.cached || 0) + add.reasoning.cached;
    }
  }

  // Accumulate embeddings usage
  if (add.embeddings) {
    if (!target.embeddings) {
      target.embeddings = {};
    }
    if (add.embeddings.count !== undefined) {
      target.embeddings.count = (target.embeddings.count || 0) + add.embeddings.count;
    }
    if (add.embeddings.tokens !== undefined) {
      target.embeddings.tokens = (target.embeddings.tokens || 0) + add.embeddings.tokens;
    }
  }

  // Accumulate cost
  if (add.cost !== undefined) {
    target.cost = (target.cost || 0) + add.cost;
  }
}

/**
 * Calculate total input tokens from a Usage object.
 * Includes tokens from text, audio, image, reasoning input, and embeddings.
 * 
 * @param usage - The Usage object to calculate input tokens from
 * @returns Total input tokens
 */
export function getInputTokens(usage?: Usage): number {
  if (!usage) return 0;
  return (usage.text?.input || 0) + 
         (usage.audio?.input || 0) + 
         (usage.image?.input || 0) +
         (usage.reasoning?.input || 0) +
         (usage.embeddings?.tokens || 0);
}

/**
 * Calculate total output tokens from a Usage object.
 * Includes tokens from text, audio, and reasoning output.
 * Note: image.output represents generated images (not tokens), so it's excluded.
 * 
 * @param usage - The Usage object to calculate output tokens from
 * @returns Total output tokens
 */
export function getOutputTokens(usage?: Usage): number {
  if (!usage) return 0;
  return (usage.text?.output || 0) + 
         (usage.audio?.output || 0) + 
         (usage.reasoning?.output || 0);
}

/**
 * Calculate total tokens from a Usage object.
 * Includes all tokens: input, output, cached from all modalities.
 * Note: image.output represents generated images (not tokens), so it's excluded.
 * 
 * @param usage - The Usage object to calculate total tokens from
 * @returns Total tokens
 */
export function getTotalTokens(usage?: Usage): number {
  if (!usage) return 0;
  return (usage.text?.input || 0) + 
         (usage.text?.output || 0) + 
         (usage.text?.cached || 0) +
         (usage.audio?.input || 0) + 
         (usage.audio?.output || 0) +
         (usage.image?.input || 0) +
         (usage.reasoning?.input || 0) + 
         (usage.reasoning?.output || 0) + 
         (usage.reasoning?.cached || 0) +
         (usage.embeddings?.tokens || 0);
}

/**
 * Gets a Model object from either a string ID or a ModelInput object.
 * 
 * @param input - The model identifier or ModelInput object.
 * @returns 
 */
export function getModel(input: ModelInput): Model;
export function getModel(input: ModelInput | undefined): Model | undefined;
export function getModel(input: ModelInput | undefined): Model | undefined {
  return typeof input === 'string' ? { id: input } : input;
}

/**
 * Converts a series of chunks into a Response object.
 * 
 * @param chunks - The array of Chunk objects to convert.
 * @returns The aggregated Response object.
 */
export function getResponseFromChunks(chunks: Chunk[], model: ModelInput = 'unknown'): Response {
  const resp: Response = { 
    content: '',
    finishReason: 'stop', 
    model,
  };
  for (const chunk of chunks) {
    if (chunk.content) {
      resp.content += chunk.content;
    }
    if (chunk.finishReason) {
      resp.finishReason = chunk.finishReason;
    }
    if (chunk.reasoning) {
      resp.reasoning = accumulateReasoning(resp.reasoning, chunk.reasoning);
    }
    if (chunk.model) {
      resp.model = chunk.model;
    }
    if (chunk.refusal) {
      resp.refusal = chunk.refusal;
    }
    if (chunk.toolCall) {
      resp.toolCalls = resp.toolCalls || [];
      resp.toolCalls.push(chunk.toolCall);
    }
    if (chunk.usage) {
      resp.usage = resp.usage || {};
      accumulateUsage(resp.usage, chunk.usage);
    }
  }

  return resp;
}

/**
 * Generates a plain text representation of reasoning data.
 * 
 * @param reasoning - The reasoning data to convert.
 * @returns A plain text string representing the reasoning.
 */
export function getReasoningText(reasoning: Reasoning | undefined): string {
  if (!reasoning) {
    return '';
  }

  const parts: string[] = [];
  if (reasoning.content) {
    parts.push(reasoning.content);
  } else if (reasoning?.details) {
    for (const detail of reasoning.details) {
      if (detail.summary) {
        parts.push(detail.summary);
      }
      if (detail.text) {
        parts.push(detail.text);
      }
    }
  }

  return parts.join('\n\n');
}

// Only appends y to x if neither contains the other
function appendMaybe(x: string | undefined, y: string | undefined): string | undefined {
  if (!x) {
    return y;
  }
  if (!y) {
    return x;
  }
  if (!x.includes(y) && !y.includes(x)) {
    return x + y;
  }
  return x;
}

/**
 * Accumulates reasoning data by merging an additional Reasoning object into a target Reasoning object.
 * 
 * @param target - The target Reasoning object to accumulate into.
 * @param add - The Reasoning object to add from.
 * @returns - The updated Reasoning object.
 */
export function accumulateReasoning(target: Reasoning | undefined, add?: Reasoning): Reasoning | undefined {
  if (!target) {
    return add;
  }
  if (!add) {
    return target;
  }

  if (add.content) {
    target.content = appendMaybe(target.content || undefined, add.content);
  }
  if (add.details?.length) {
    target.details = target.details || [];

    for (const detail of add.details) {
      let existing = target.details.find(d => 
        (detail.id && d.id && detail.id === d.id) ||
        (detail.index !== undefined && d.index !== undefined && detail.index === d.index)
      );

      const missingIdentifiers = 
        add.details.every(d => !d.id && d.index === undefined) && 
        target.details.every(d => !d.id && d.index === undefined);

      if (missingIdentifiers) {
        existing = target.details.find(d => d.type === detail.type);
      }

      if (existing) {
        if (detail.data) {
          existing.data = appendMaybe(existing.data, detail.data);
        }
        if (detail.text) {
          existing.text = appendMaybe(existing.text, detail.text);
          if (detail.signature) {
            existing.signature = detail.signature;
          }
        }
        if (detail.summary) {
          existing.summary = appendMaybe(existing.summary, detail.summary);
        }
      } else {
        target.details.push(detail);
      }
    }
  }
  
  return target;
}

/**
 * Converts a Response object into an array of Chunk objects.
 * 
 * @param response - The response to convert.
 * @returns The built chunks from the response.
 */
export function getChunksFromResponse(response: Response): Chunk[] {
  const chunks: Chunk[] = [];

  if (response.reasoning || response.refusal) {
    chunks.push({
      refusal: response.refusal,
      reasoning: response.reasoning,
    });
  }

  for (const toolCall of response.toolCalls || []) {
    chunks.push({ toolCall, toolCallNamed: toolCall, toolCallArguments: toolCall });
  }

  chunks.push({
    content: response.content,
    finishReason: response.finishReason,
    usage: response.usage,
    model: response.model,
  });

  return chunks;
}

/**
 * Creates a runner that emits events during component execution.
 * 
 * @param events 
 * @returns 
 */ // @ts-ignore
export function withEvents<TRoot extends AnyComponent>(events: Events<TRoot>): Runner {
  let instanceIndex = 0;
  const runner: Runner = (component, input, context, getOutput) => {
    type C = typeof component;

    const instanceContext = { ...context };

    const instance: Instance<C> = {
      id: `${component.kind}:${component.name}:${instanceIndex++}`,
      parent: context.instance,
      component,
      context: instanceContext,
      input,
      status: 'pending',
    };

    if (instanceContext.instance) {
      instanceContext.instance.children = instanceContext.instance.children || [];
      instanceContext.instance.children.push(instance);
    }

    instanceContext.instance = instance;

    if (instance.parent) {
      // @ts-ignore
      events.onChild?.(instance.parent, instance);
    }

    // @ts-ignore
    events.onStatus?.(instance);

    instance.status = 'running';
    instance.started = Date.now();

    const output = getOutput(instanceContext, events);

    // Helper to update instance status on completion
    const markCompleted = (result: any) => {
      instance.status = 'completed';
      instance.completed = Date.now();
      instance.output = result;
      // @ts-ignore
      events.onStatus?.(instance);
    };

    // Helper to update instance status on error
    const markFailed = (error: any) => {
      if (instanceContext.signal?.aborted) {
        instance.status = 'interrupted';
      } else {
        instance.status = 'failed';
      }
      instance.completed = Date.now();
      instance.error = error;
      // @ts-ignore
      events.onStatus?.(instance);
    };

    // Helper to wrap an async generator with status tracking
    const wrapGenerator = async function*(generator: AsyncGenerator<any, any, any>) {
      try {
        // Yield all events from the original generator
        for await (const event of generator) {
          yield event;
        }
        // Capture the return value (generator is now exhausted)
        const lastResult = await generator.next();
        const finalResult = lastResult.value;

        markCompleted(finalResult);
        return finalResult;
      } catch (error) {
        markFailed(error);
        throw error;
      }
    };

    // Handle async generators differently - wrap them instead of consuming
    if (isAsyncGenerator(output)) {
      return wrapGenerator(output as AsyncGenerator<any, any, any>) as ComponentOutput<C>;
    } else if (isPromise(output)) {
      // Check if the promise resolves to an async generator
      const wrappedGenerator = async function*() {
        try {
          const resolved = await output;

          if (isAsyncGenerator(resolved)) {
            // It's a Promise<AsyncGenerator>, wrap and forward
            return yield* wrapGenerator(resolved as AsyncGenerator<any, any, any>);
          } else {
            // It's a Promise<value>, just complete
            markCompleted(resolved);
            return resolved;
          }
        } catch (error) {
          markFailed(error);
          throw error;
        }
      }();

      return wrappedGenerator as ComponentOutput<C>;
    } else {
      // Original logic for non-generators, non-promises (raw values)
      const resolved = resolve(output);

      resolved.then(markCompleted, markFailed);

      return output;
    }
  };

  return runner;
}

// ════════════════════════════════════════════════════════════════════════════
// JSON extraction / repair — shared model-output utilities used by both the
// Prompt (structured output-parse + prompt-text schema-delivery fallback) and
// the Tool (tool-call argument validation). Kept here so there is one home for
// the "turn a model's messy reply into parseable JSON" logic.
// ════════════════════════════════════════════════════════════════════════════

/**
 * Extract the outermost balanced JSON object (`{…}`) from arbitrary model
 * text. Robust to markdown code fences (```json … ```), surrounding prose,
 * and braces that appear inside string literals — it scans from the first
 * `{`, tracks string-literal state (respecting backslash escapes), and returns
 * the slice up to the matching close brace at depth 0.
 *
 * Behavior is IDENTICAL to a clean `JSON.stringify`-d object (returns it
 * verbatim). Falls back to the slice from the first `{` to end when the braces
 * never balance, and to `''` when there is no `{` at all (so `JSON.parse('')`
 * surfaces the same error downstream).
 *
 * Exported for direct unit testing.
 */
export function extractJSONObject(text: string): string {
  const start = text.indexOf('{');
  if (start === -1) return '';

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }

  // Unbalanced — return best-effort from the first brace so JSON.parse can
  // report a precise error.
  return text.slice(start);
}

/**
 * Best-effort repair for a provider that JSON-encodes a top-level object/array
 * field as a STRING (Claude / Anthropic tool args have been observed doing this,
 * sometimes double-encoding AND corrupting the inner content mid-stream). Walks
 * the top-level entries of `raw`; any string value that starts with `{`/`[` is
 * `JSON.parse`-d back into place.
 *
 * Returns the repaired object, the list of fields that parsed cleanly
 * (`fields`), and the list of fields that LOOKED string-encoded whether or not
 * their inner JSON parsed (`attempted`) — so the caller can distinguish "no
 * encoded fields at all" (`undefined`) from "encoded but malformed inner JSON"
 * (`attempted.length > 0`, `fields.length === 0`).
 *
 * Intentionally top-level only — descending deeper risks "repairing" legitimate
 * JSON-shaped strings inside content fields.
 */
export function repairStringEncodedFields(
  raw: unknown,
):
  | { value: Record<string, unknown>; fields: string[]; attempted: string[] }
  | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const src = raw as Record<string, unknown>;
  const repaired: Record<string, unknown> = { ...src };
  const fields: string[] = [];
  const attempted: string[] = [];
  for (const [key, value] of Object.entries(src)) {
    if (typeof value !== 'string') continue;
    const head = value.trimStart()[0];
    if (head !== '{' && head !== '[') continue;
    // Field LOOKS string-encoded — track it whether parse succeeds or not.
    // Failed inner-parse is its own diagnostic signal (model double-encoded AND
    // the inner content is malformed), distinct from "no encoded fields seen".
    attempted.push(key);
    try {
      repaired[key] = JSON.parse(value);
      fields.push(key);
    } catch { /* malformed inner JSON — keep tracking the attempt */ }
  }
  if (attempted.length === 0) return undefined;
  return { value: repaired, fields, attempted };
}