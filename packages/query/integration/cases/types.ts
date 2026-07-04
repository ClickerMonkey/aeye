/**
 * The EVAL CASE contract every seed case follows.
 *
 * The golden rule: the EXPECTED result of a case is NEVER hand-guessed — it is
 * `engine.run(oracle)`, where `oracle` is a hand-written, minimal, obviously
 * CORRECT query. So the expected values are always DERIVED from the fixture
 * data. A case author's job is only to (a) write the natural-language `request`
 * a model will see, (b) write the correct `oracle`, and (c) explain in `note`
 * which TRAP / discriminator the case exercises (why a wrong query gets a wrong
 * answer).
 */
import type { QueryEngine, QueryDef, Query } from '../../src/index';

/**
 * Whether the case expects ROWS (a runnable oracle whose result is the answer)
 * or a REFUSAL (the request should be rejected — e.g. it writes a read-only /
 * append-only Type — so the correct outcome is a validation error, and the
 * `oracle` is the illegal query that MUST fail to validate).
 */
export type ExpectKind = 'rows' | 'refusal';

/** One natural-language → query evaluation case. */
export interface EvalCase {
  /** Stable unique id (used as the log key). */
  id: string;
  /** Grouping bucket for the summary (e.g. `filter`, `aggregate`, `join`). */
  category: string;
  /** The natural-language request shown to the model. */
  request: string;
  /**
   * The hand-written CORRECT query. For `expect: 'rows'` its result IS the
   * expected answer (`engine.run(oracle)`); for `expect: 'refusal'` it is the
   * ILLEGAL query that must FAIL validation (the refusal the model should make).
   * Receives the engine so an oracle may build a subquery / inspect the schema.
   */
  oracle: (engine: QueryEngine) => QueryDef | Query;
  /**
   * `'rows'` (default) — compare the model's rows to the oracle's rows.
   * `'refusal'` — the request must be REFUSED (read-only / append-only write).
   */
  expect?: ExpectKind;
  /**
   * How to compare rows: `'set'` (default, order-insensitive) or `'ordered'`
   * (row order is significant — top-N / ORDER BY cases).
   */
  match?: 'set' | 'ordered';
  /** Absolute tolerance for numeric (money / avg) comparisons. Default 1e-6. */
  floatTolerance?: number;
  /** Which trap / discriminator this case exercises, and why a wrong query fails. */
  note: string;
}
