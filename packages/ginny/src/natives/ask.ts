import type { Registry, Type, Value } from '@aeye/gin';
import { val } from '@aeye/gin';
import { consume, textAdapter } from '../consumer';

/**
 * Per-process current ask handler. The natives are registered ONCE at
 * startup, but the user-prompt function is per-conversation. Tools
 * that drive program execution (`test`, `finish`, anything calling
 * `engine.run`/lambda evaluation) install the current handler via
 * `withAskHandler` for the duration of the run.
 *
 * Single-threaded by design: ginny processes one request at a time,
 * so a module-level slot is reentrancy-safe enough.
 */
type AskFn = (question: string, signal?: AbortSignal) => Promise<string>;
let currentAsk: AskFn | null = null;
let currentSignal: AbortSignal | undefined;

export function setAskHandler(fn: AskFn | null, signal?: AbortSignal): void {
  currentAsk = fn;
  currentSignal = signal;
}

export async function withAskHandler<T>(
  fn: AskFn | null | undefined,
  signal: AbortSignal | undefined,
  body: () => Promise<T>,
): Promise<T> {
  const prevFn = currentAsk;
  const prevSig = currentSignal;
  currentAsk = fn ?? null;
  currentSignal = signal;
  try {
    return await body();
  } finally {
    currentAsk = prevFn;
    currentSignal = prevSig;
  }
}

/**
 * `fns.ask<T = text>({ title, details, output? }): optional<T>` — pause
 * the program and walk the user through entering a value of `output`'s
 * type. When `output` is omitted, returns plain text. Returns `null`
 * when the user cancels.
 *
 * The walker (`consume` in `../consumer.ts`) honors each (sub)type's
 * `docs` field as the user-facing label — programs that want
 * meaningful prompts should put short descriptions on their type
 * fields. For complex shapes (list of objects, etc.) the user is
 * walked through item-by-item / field-by-field.
 */
export function createAskImpl(registry: Registry) {
  return async (argsValue: Value): Promise<Value> => {
    const args = argsValue.raw as Record<string, Value>;
    const title = (args['title']?.raw ?? '') as string;
    const details = (args['details']?.raw ?? '') as string;
    const outputType = args['output']?.raw as Type | undefined;

    if (!currentAsk) {
      throw new Error(
        'fns.ask: no ask handler installed — this native is only available '
        + 'inside a ginny conversation (test/finish/run). Direct programmatic '
        + 'use must wrap engine.run in `withAskHandler(askFn, signal, () => …)`.',
      );
    }

    const adapter = textAdapter(currentAsk, currentSignal);

    // No output type — fall back to a single text prompt. Mirrors the
    // `text` default on the schema's R generic.
    if (!outputType) {
      const raw = await adapter.text({ title, details });
      if (raw === null) {
        return val(registry.optional(registry.text()), undefined);
      }
      return val(registry.optional(registry.text()), raw);
    }

    const result = await consume(
      outputType,
      { title, details },
      adapter,
      registry,
    );
    if (result === null) {
      return val(registry.optional(outputType), undefined);
    }
    // Re-wrap: the consumer returned a Value of the inner type. We
    // need to surface it as `optional<T>`-typed so the program reads
    // it as such (the declared return type of `fns.ask`).
    return val(registry.optional(outputType), result.raw);
  };
}

export function registerAskType(registry: Registry) {
  return registry.fn({
    args: registry.obj({
      title: {
        type: registry.text(),
        docs: 'Short headline shown to the user before any prompts. Describes WHAT you\'re asking for.',
      },
      details: {
        type: registry.text(),
        docs: 'Supplemental context — why you\'re asking, what the answer will be used for, formatting hints.',
      },
      output: {
        type: registry.optional(registry.typ(registry.alias('R'))),
        docs: 'Optional gin Type the answer must conform to. Use rich shapes (obj / list<obj> / enum / optional) and put `docs` on every field — those docs become the user-facing label for each sub-prompt. Omit to read plain text.',
      },
    }),
    returns: registry.optional(registry.alias('R')),
    // Constraint on R, not a default. `consume()` walks any gin Type —
    // primitives, lists, objs, enums, optionals — and prompts the user
    // accordingly. `any` reflects that any shape the caller asks for
    // is acceptable. Without an `output:` arg the impl returns
    // `optional<text>`; with one, the impl coerces R to whatever the
    // caller's Type was.
    generic: { R: registry.any() },
    call: registry.nativeExpr('fns.ask'),
  });
}
