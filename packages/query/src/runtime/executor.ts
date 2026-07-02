/**
 * TypeExecutor — the USER-supplied bridge between a declared `Type` and its
 * actual data, plus optional per-Type query validation.
 *
 * The engine maps a Type NAME → its `TypeExecutor`. When the runtime needs a
 * type's rows (in FROM / JOIN / a DML target) it calls the matching
 * executor's `load`. When the engine VALIDATES a query, every Type the query
 * references contributes its executor's optional `validate` hook, so a Type
 * can enforce domain rules (row-level constraints, forbidden fields, …) and
 * surface them as `Problems` in the same LLM-friendly stream.
 *
 * Executors are plain interfaces the user implements; the simplest one just
 * returns a fixed array of records (see the tests' in-memory dataset).
 */
import type { Type } from '../type';
import type { Problems } from '../problem';
import type { SourceRecord } from './row';
import type { RuntimeContext } from './context';
import type { Query } from '../queries/query';

/** Context handed to a `TypeExecutor.load` call. */
export interface ExecutorContext {
  /** The Type whose rows are being loaded. */
  readonly type: Type;
  /** The active runtime context (params / ctes / embedder live here). */
  readonly runtime: RuntimeContext;
}

/** A user-implemented data + validation provider for one Type. */
export interface TypeExecutor {
  /** Load the current rows for this Type. */
  load(ctx: ExecutorContext): Promise<readonly SourceRecord[]>;
  /**
   * Optional per-Type validation run during `engine.validateQuery`. Receives
   * the whole parsed query plus the shared `Problems` accumulator.
   */
  validate?(query: Query, problems: Problems): void;
}

/** A standalone per-Type query validator (alternative to `executor.validate`). */
export type QueryValidator = (query: Query, problems: Problems) => void;

/**
 * A trivial executor backed by an in-memory array — handy for tests, fixtures
 * and examples. Returns a fresh shallow copy each load so the runtime's
 * transactional `TypeState` can mutate without corrupting the source array.
 */
export function arrayExecutor(rows: readonly SourceRecord[]): TypeExecutor {
  return {
    load: async () => rows.map((r) => ({ ...r })),
  };
}
