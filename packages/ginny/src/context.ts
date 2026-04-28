import type { Registry, Engine, Type, Value } from '@aeye/gin';
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
}

export interface Meta {}
