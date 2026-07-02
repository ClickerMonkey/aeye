/**
 * Expr barrel — re-exports every concrete `Expr` class plus the
 * `BUILTIN_EXPRS` array the Registry bootstraps from, and a folded
 * `exprDefSchema()` over every kind's `toSchema`.
 */
import { z } from 'zod';
import type { ExprClass } from '../expr';
import type { SchemaOptions } from '../node';
import { LiteralExpr } from './literal';
import { OutputRefExpr } from './output-ref';
import { FieldRefExpr } from './field-ref';
import { RelationPathExpr } from './relation-path';
import { ParamExpr } from './param';
import { BinaryExpr } from './binary';
import { UnaryExpr } from './unary';
import { ComparisonExpr } from './comparison';
import { LogicalExpr } from './logical';
import { InExpr } from './in';
import { BetweenExpr } from './between';
import { IsNullExpr } from './is-null';
import { ExistsExpr } from './exists';
import { ArrayOpExpr } from './array-op';
import { CaseExpr } from './case';
import { AggregateExpr } from './aggregate';
import { WindowExpr } from './window';
import { FunctionCallExpr } from './function-call';
import { TabularFunctionCallExpr } from './tabular-function-call';
import { SemanticExpr } from './semantic';
import { TextSearchExpr } from './text-search';
import { FiltersExpr } from './filters';
import { SubqueryExpr } from './subquery';
import { ExcludedExpr } from './excluded';

export {
  LiteralExpr,
  OutputRefExpr,
  FieldRefExpr,
  RelationPathExpr,
  ParamExpr,
  BinaryExpr,
  UnaryExpr,
  ComparisonExpr,
  LogicalExpr,
  InExpr,
  BetweenExpr,
  IsNullExpr,
  ExistsExpr,
  ArrayOpExpr,
  CaseExpr,
  AggregateExpr,
  WindowExpr,
  FunctionCallExpr,
  TabularFunctionCallExpr,
  SemanticExpr,
  TextSearchExpr,
  FiltersExpr,
  SubqueryExpr,
  ExcludedExpr,
};

export type { FilterFieldOps } from './filters';

/** All built-in Expr classes, in a stable order for registry / docs. */
export const BUILTIN_EXPRS: readonly ExprClass[] = [
  LiteralExpr,
  OutputRefExpr,
  FieldRefExpr,
  RelationPathExpr,
  ParamExpr,
  BinaryExpr,
  UnaryExpr,
  ComparisonExpr,
  LogicalExpr,
  InExpr,
  BetweenExpr,
  IsNullExpr,
  ExistsExpr,
  ArrayOpExpr,
  CaseExpr,
  AggregateExpr,
  WindowExpr,
  FunctionCallExpr,
  TabularFunctionCallExpr,
  SemanticExpr,
  TextSearchExpr,
  FiltersExpr,
  SubqueryExpr,
  ExcludedExpr,
];

/**
 * Zod schema for the full `ExprDef` union — the `.or`-fold of every built-in
 * expr's `toSchema(opts)` (mirrors `fieldTypeDefSchema`). Pass `opts.Expr` /
 * `opts.Query` to supply the recursive child slots; otherwise child exprs use
 * a loose placeholder.
 */
export function exprDefSchema(opts: SchemaOptions = {}): z.ZodTypeAny {
  const branches = BUILTIN_EXPRS.map((c) => c.toSchema(opts));
  const first = branches[0];
  /* v8 ignore next -- unreachable: BUILTIN_EXPRS is a non-empty constant, so branches[0] is always defined */
  if (!first) return z.never();
  return branches
    .slice(1)
    .reduce<z.ZodTypeAny>((acc, s) => acc.or(s), first)
    .describe('Expression definition (one of the built-in expression kinds).');
}
