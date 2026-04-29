import type { Registry, Engine, Type, Value, ObjType } from '@aeye/gin';
import type { Store } from './store';
import type { RunState } from './run-state';

export interface Ctx {
  registry: Registry;
  engine: Engine;
  store: Store;
  runState: RunState;
  loadedTypes: Set<string>;
  loadedFns: Set<string>;
  loadedVars: Map<string, { type: Type; parsed: Value; docs?: string }>;
  features: { webSearch: boolean };
  /**
   * Pose a question to the human user and resolve with their typed
   * answer. Wired in by the entry point (REPL or one-shot CLI) —
   * sub-prompts inherit it through the standard ctx pass-through. May
   * be undefined when no interactive frontend is attached (background
   * runs, tests). The optional `signal` lets callers abort a hung
   * prompt (Ctrl+C in the parent run); the implementation should
   * reject the returned promise when it fires.
   */
  ask?: (question: string, signal?: AbortSignal) => Promise<string>;
  /**
   * How many programmer invocations deep we are. Top-level (REPL) is 0;
   * each `engineer.create_new_fn` increments by 1 before invoking
   * programmer recursively. The `find_or_create_functions` tool gates
   * its `applicable` on this so a recursive programmer at the cap
   * can't keep delegating function creation back to itself — it has to
   * write the function inline.
   */
  programmerDepth?: number;
  /**
   * Set by `engineer.create_new_fn` before invoking the inner programmer.
   * Tells `test()` how to wrap raw scope args into typed `Value`s and
   * tells `finish()` what signature to use when persisting the draft —
   * so the saved fn matches what the engineer designed instead of being
   * `(): or<bool, bool>` (an inference of the body's static type).
   *
   * `argsType` is intentionally `ObjType`, not the generic `Type`: a
   * gin function's arguments are always an obj whose props ARE the
   * parameter list. Typing it concretely lets downstream tools read
   * `argsType.fields` and call `argsType.parse(rawArgs)` without
   * narrowing checks, and forces `engineer.create_new_fn` to validate
   * the input up front.
   */
  targetFn?: { name: string; argsType: ObjType; returnsType: Type };
}

/** Hard cap on programmer recursion. With 0-indexed depth, programmers
 *  at depth < MAX_PROGRAMMER_DEPTH - 1 can delegate to the engineer to
 *  create more programmers; the deepest one cannot. Set to 3 → max 3
 *  programmers in the stack. */
export const MAX_PROGRAMMER_DEPTH = 3;

export interface Meta {}
