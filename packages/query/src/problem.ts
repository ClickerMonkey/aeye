/**
 * Problem — a validation / parse diagnostic used across the whole
 * `@aeye/query` package: by Type construction, FieldType parsing, and
 * (in later phases) Expr / Query resolution and validation.
 *
 * This module is an *owned copy* of gin's `problem.ts`. It is deliberately
 * generic — it carries no query-specific concerns — so it can serve as the
 * single diagnostic stream every layer shares. Keeping one shape means
 * callers handle one list, regardless of which subsystem produced the
 * problem.
 *
 * Paths are STRUCTURAL — `(string | number)[]` pointing into the JSON tree
 * an LLM (or developer) authored. For example:
 *   `['fields', 2, 'type', 'min']`
 * points at the `min` option of the type of the 3rd field. These paths are
 * the same shape `Code` spans carry, which is what lets `formatProblem`
 * resolve a problem to its rendered `^^^` underline.
 */
export interface Problem {
  /** Structural path into the authored JSON. */
  path: (string | number)[];
  /** Stable machine code, e.g. `field-type.unknown`, `cost.rows-exceeded`. */
  code: string;
  /** Human / LLM readable explanation. */
  message: string;
  /** Severity bucket — only `error` blocks acceptance. */
  severity: 'error' | 'warning' | 'info';
  /**
   * Optional back-reference to the offending source value. Typed `unknown`
   * INTERNALLY only — it is never read for control flow, just surfaced for
   * debugging. (Kept off the structural contract callers rely on.)
   */
  source?: unknown;
}

/**
 * Accumulator for Problems encountered while walking a tree. Tracks the
 * current structural path as callers enter / leave nested structures, so
 * a deeply nested check can simply call `p.error(...)` and have the right
 * path attached automatically.
 *
 *   const p = new Problems();
 *   p.enter('fields').enter(2).enter('type');
 *   p.error('field-type.bad-min', 'min cannot be negative');
 *   p.leave(3);
 *
 * The `at(segment, fn)` helper is the ergonomic form — it enters, runs the
 * callback, and always leaves (even on throw).
 */
export class Problems {
  /** Every problem collected, in insertion order. */
  readonly list: Problem[] = [];
  /** Mutable path stack mirroring the caller's current position. */
  private stack: (string | number)[] = [];

  /** Push one segment (or several) onto the path stack. */
  enter(segment: string | number | (string | number)[]): this {
    if (Array.isArray(segment)) this.stack.push(...segment);
    else this.stack.push(segment);
    return this;
  }

  /** Pop `count` segments off the path stack (never below empty). */
  leave(count = 1): this {
    this.stack.length = Math.max(0, this.stack.length - count);
    return this;
  }

  /**
   * Scoped enter/leave: push `segment`, run `fn`, then pop exactly the
   * number of segments pushed — even if `fn` throws.
   */
  at<T>(segment: string | number | (string | number)[], fn: () => T): T {
    const n = Array.isArray(segment) ? segment.length : 1;
    this.enter(segment);
    try {
      return fn();
    } finally {
      this.leave(n);
    }
  }

  /** Low-level append — snapshots the current path. */
  push(code: string, message: string, severity: Problem['severity'] = 'error', source?: unknown): void {
    this.list.push({ path: this.stack.slice(), code, message, severity, source });
  }

  /** Record an `error`-severity problem at the current path. */
  error(code: string, message: string, source?: unknown): void {
    this.push(code, message, 'error', source);
  }

  /** Record a `warning`-severity problem at the current path. */
  warn(code: string, message: string, source?: unknown): void {
    this.push(code, message, 'warning', source);
  }

  /** Record an `info`-severity problem at the current path. */
  info(code: string, message: string, source?: unknown): void {
    this.push(code, message, 'info', source);
  }

  /**
   * Snapshot of the current structural path. Additive read-only accessor
   * (Phase 2) used by expression validation to record WHERE a bind param
   * was observed, so `ParamSet` can name each conflicting use site. Returns
   * a copy so callers can retain it without it mutating as the walk
   * continues.
   */
  get here(): (string | number)[] {
    return this.stack.slice();
  }

  /** True when at least one collected problem is an error. */
  get hasErrors(): boolean {
    return this.list.some((p) => p.severity === 'error');
  }
}

/**
 * Thrown when an operation fails in a context that cannot accumulate
 * Problems — e.g. a FieldType `from(json)` factory rejecting a malformed
 * definition where there is no `Problems` bag to push into. Carries the
 * full `Problem` so a catching layer can re-home it into a bag with the
 * right path prefix.
 */
export class QueryTypeError extends Error {
  constructor(readonly problem: Problem) {
    super(`${problem.code}: ${problem.message} at ${problem.path.join('.')}`);
    this.name = 'QueryTypeError';
  }
}
