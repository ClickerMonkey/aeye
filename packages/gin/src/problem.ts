/**
 * Problem: a validation/parse error used by both Type construction and
 * Expression construction/validation. Types and expressions are married —
 * they share this error shape so callers handle one stream.
 *
 * Paths are structural — (string | number)[] pointing into the JSON tree.
 * For example: ['props', 'age', 'type', 'options', 'min'] points to the
 * min option on the age prop's type.
 */
export interface Problem {
  path: (string | number)[];
  code: string;
  message: string;
  severity: 'error' | 'warning' | 'info';
  source?: unknown;
}

/**
 * Accumulator for Problems encountered while walking a tree. Tracks the
 * current path as callers enter/leave nested structures.
 *
 *   const p = new Problems();
 *   p.enter('props').enter('age').enter('type');
 *   p.error('invalid-option', 'min cannot be negative');
 *   p.leave(3);
 */
export class Problems {
  readonly list: Problem[] = [];
  private stack: (string | number)[] = [];

  enter(segment: string | number | (string | number)[]): this {
    if (Array.isArray(segment)) this.stack.push(...segment);
    else this.stack.push(segment);
    return this;
  }

  leave(count = 1): this {
    this.stack.length = Math.max(0, this.stack.length - count);
    return this;
  }

  at<T>(segment: string | number | (string | number)[], fn: () => T): T {
    const n = Array.isArray(segment) ? segment.length : 1;
    this.enter(segment);
    try {
      return fn();
    } finally {
      this.leave(n);
    }
  }

  push(code: string, message: string, severity: Problem['severity'] = 'error', source?: unknown): void {
    this.list.push({ path: this.stack.slice(), code, message, severity, source });
  }

  error(code: string, message: string, source?: unknown): void {
    this.push(code, message, 'error', source);
  }

  warn(code: string, message: string, source?: unknown): void {
    this.push(code, message, 'warning', source);
  }

  info(code: string, message: string, source?: unknown): void {
    this.push(code, message, 'info', source);
  }

  get hasErrors(): boolean {
    return this.list.some((p) => p.severity === 'error');
  }
}

/**
 * Thrown when a Type operation fails in a context that can't accumulate —
 * e.g. options widening during Extension construction.
 */
export class TypeError extends Error {
  constructor(readonly problem: Problem) {
    super(`${problem.code}: ${problem.message} at ${problem.path.join('.')}`);
    this.name = 'TypeError';
  }
}
