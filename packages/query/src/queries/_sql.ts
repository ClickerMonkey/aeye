/**
 * Shared SQL-emission helpers for the Query classes.
 */
import type { ParamExprDef } from '../schema';
import type { SqlContext } from '../sql/emit';
import { SqlText } from '../sql/emit';
import type { SqlValue } from '../sql/emit';
import type { Dialect } from '../sql/dialect';
import { QueryTypeError } from '../problem';

/**
 * A clear error for a joined `UPDATE` / `DELETE` on a dialect that cannot
 * express `UPDATE … FROM` / `DELETE … USING` (`dialect.supportsDmlJoins ===
 * false`). Raised instead of emitting SQL with a dangling join alias.
 */
export function dmlJoinsUnsupported(dialect: Dialect, statement: 'UPDATE' | 'DELETE'): QueryTypeError {
  const form = statement === 'UPDATE' ? 'UPDATE … FROM' : 'DELETE … USING';
  return new QueryTypeError({
    path: [],
    code: 'dml-join.unsupported-dialect',
    severity: 'error',
    message: `Joined ${statement} (${form}) is unsupported in the '${dialect.name}' dialect; rewrite the join as a WHERE predicate or use a dialect that supports it.`,
  });
}

/**
 * A runtime write-model guard error: a DML statement targets a Type that is not
 * insertable / updatable / deletable. Belt-and-suspenders for `execute` (engine
 * validation reports the same code up front, so a validated query never trips it).
 */
export function typeReadonly(op: 'insert' | 'update' | 'delete', typeName: string): QueryTypeError {
  const verb = op === 'insert' ? 'insertable' : op === 'update' ? 'updatable' : 'deletable';
  return new QueryTypeError({
    path: [], code: `${op}.type-readonly`, severity: 'error',
    message: `Type '${typeName}' is not ${verb}.`,
  });
}

/** A runtime write-model guard error: a DML statement writes a non-writable field. */
export function fieldReadonly(op: 'insert' | 'update', typeName: string, field: string): QueryTypeError {
  const verb = op === 'insert' ? 'insertable' : 'updatable';
  return new QueryTypeError({
    path: [], code: `${op}.field-readonly`, severity: 'error',
    message: `Field '${field}' of '${typeName}' is not ${verb}.`,
  });
}

/**
 * Emit a limit / offset bound: a literal count is raw text; a named param
 * binds its supplied value (null until provided). Returns `undefined` when the
 * bound is absent.
 */
export function boundSQL(v: number | ParamExprDef | undefined, ctx: SqlContext): SqlText | undefined {
  if (v === undefined) return undefined;
  if (typeof v === 'number') return SqlText.raw(String(v));
  const raw = Object.prototype.hasOwnProperty.call(ctx.params, v.name) ? ctx.params[v.name]! : null;
  /* v8 ignore next -- a relation { pk } object is never a valid LIMIT/OFFSET; guard to a scalar */
  const value: SqlValue = raw !== null && typeof raw === 'object' ? null : raw;
  return SqlText.param(value);
}
