import type { Registry, Engine, Type, TypeDef, Value, ObjType } from '@aeye/gin';
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
   * each `designer.create_new_fn` increments by 1 before invoking
   * programmer recursively. The `find_or_create_functions` tool gates
   * its `applicable` on this so a recursive programmer at the cap
   * can't keep delegating function creation back to itself — it has to
   * write the function inline.
   */
  programmerDepth?: number;
  /**
   * The user's original top-level request, captured by the entry point
   * before launching the depth-0 programmer. Plumbed through every
   * recursive designer/programmer pair so a deep programmer can render
   * "what is this work ultimately for" alongside its own immediate
   * task. Empty for non-interactive entry points that didn't bother to
   * set it.
   */
  originalRequest?: string;
  /**
   * Call-chain ancestry for recursive programmers, oldest → newest.
   * Each entry is a function the designer was asked to create at one
   * level of nesting. Empty at depth 0; appended once per
   * `designer.create_new_fn` before spawning the inner programmer. A
   * programmer at depth N reads the chain to understand which caller
   * needs its function and why — so it can stay scoped to that need.
   */
  programmerChain?: ProgrammerChainEntry[];
  /**
   * Set by `designer.create_new_fn` before invoking the inner programmer.
   * Tells `test()` how to wrap raw scope args into typed `Value`s and
   * tells `finish()` what signature to use when persisting the draft —
   * so the saved fn matches what the designer designed instead of being
   * `(): or<bool, bool>` (an inference of the body's static type).
   *
   * `argsType` is intentionally `ObjType`, not the generic `Type`: a
   * gin function's arguments are always an obj whose props ARE the
   * parameter list. Typing it concretely lets downstream tools read
   * `argsType.fields` and call `argsType.parse(rawArgs)` without
   * narrowing checks, and forces `designer.create_new_fn` to validate
   * the input up front.
   */
  targetFn?: {
    name: string;
    /** Parsed (and alias-inlined) args type — used by `test()` to wrap
     *  raw scope args via `argsType.parse(rawArgs)` and by `write()`
     *  to bind `args` in the validate scope. */
    argsType: ObjType;
    /** Parsed (and alias-inlined) returns type — used by validate /
     *  static analysis. */
    returnsType: Type;
    /**
     * Optional source forms for round-trip preservation when the
     * designer declared `call.types` aliases. `finish()` writes these
     * back verbatim so the saved fn keeps its compact shape; without
     * them, `argsType.toJSON()` would emit the verbose inlined form.
     */
    callTypes?: Record<string, TypeDef>;
    sourceArgs?: TypeDef;
    sourceReturns?: TypeDef;
  };
}

/** Hard cap on programmer recursion. With 0-indexed depth, programmers
 *  at depth < MAX_PROGRAMMER_DEPTH - 1 can delegate to the designer to
 *  create more programmers; the deepest one cannot. Set to 3 → max 3
 *  programmers in the stack. */
export const MAX_PROGRAMMER_DEPTH = 3;

/**
 * One step in the programmer call-chain — recorded by the designer at
 * each `create_new_fn`. The chain lets a deep programmer reason about
 * which parent function depends on its output and what the original
 * user request was, instead of seeing only its own isolated signature.
 */
export interface ProgrammerChainEntry {
  /** Function name (matches what `finish({ saveAs })` will use). */
  name: string;
  /** `argsType.toCode()` — human-readable parameter shape. */
  argsCode: string;
  /** `returnsType.toCode()` — human-readable return shape. */
  returnsCode: string;
  /** The designer's `description` input — what this function should do. */
  description: string;
}

export interface Meta {}
