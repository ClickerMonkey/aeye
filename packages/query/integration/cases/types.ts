/**
 * The EVAL CASE contract every seed case follows.
 *
 * A case declares a natural-language `request` and a LIST of `Assertion`s that
 * ALL must hold for the case to PASS. The assertions mix two dimensions (see
 * `assert.ts`):
 *
 *  - STRUCTURE — did the model build the right SHAPE? (`a.groupBy()`,
 *    `a.orderBy({ dir: 'desc' })`, `a.limit(5)`, `a.filtersOn('total')`,
 *    `a.joins('customer')`, `a.aggregate('sum')`, …). These read the model's
 *    emitted query def and never run it.
 *  - RESULT — do the rows match a hand-written, obviously-correct ORACLE?
 *    (`a.resultOf(oracle, { match, tolerance })`).
 *
 * The golden rule still holds for every `a.resultOf` oracle: the EXPECTED result
 * is NEVER hand-guessed — it is `engine.run(oracle)`, where `oracle` is a minimal,
 * obviously CORRECT query, so the expected values are always DERIVED from the
 * fixture data. A case author's job is to (a) write the `request` a model sees,
 * (b) pick the STRUCTURAL assertions that reflect what the request should
 * produce, (c) write the correct `oracle` for the result check (or an illegal
 * sample for `a.refused`), and (d) explain in `note` which TRAP / discriminator
 * the case exercises.
 */
import type { Assertion } from './assert';

/** One natural-language → query evaluation case. */
export interface EvalCase {
  /** Stable unique id (used as the log key). */
  id: string;
  /** Grouping bucket for the summary (e.g. `filter`, `aggregate`, `join`). */
  category: string;
  /** The natural-language request shown to the model. */
  request: string;
  /** Which trap / discriminator this case exercises, and why a wrong query fails. */
  note: string;
  /** The checks that ALL must hold (structure + result). Must be non-empty. */
  assert: Assertion[];
}

export type { Assertion } from './assert';
