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
}

export interface Meta {}

/** Full runtime context passed to tool.call and prompt schema/input functions.
 *  `metadata`/`ai` fields come from @aeye/ai's AIContext — widened to `any`
 *  here so this type can flow through sub-prompt `.get(...)` calls without
 *  fighting the generic gymnastics in AIContext<T>. */
export type FullCtx = Ctx & { ai?: any; metadata?: any; signal?: AbortSignal };
