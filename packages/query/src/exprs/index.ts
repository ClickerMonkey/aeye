/**
 * Expr barrel — re-exports every concrete `Expr` class plus the
 * `BUILTIN_EXPRS` array the Registry bootstraps from.
 */
import type { ExprClass } from '../expr';
import { LiteralExpr } from './literal';
import { OutputRefExpr } from './output-ref';
import { SorterExpr } from './sorter';
import { FieldRefExpr } from './field-ref';
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
import { OperatorExpr } from './operator';
import { SemanticExpr } from './semantic';
import { TextSearchExpr } from './text-search';
import { TextScoreExpr } from './text-score';
import { FiltersExpr } from './filters';
import { SubqueryExpr } from './subquery';
import { ExcludedExpr } from './excluded';

export {
  LiteralExpr,
  OutputRefExpr,
  SorterExpr,
  FieldRefExpr,
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
  OperatorExpr,
  SemanticExpr,
  TextSearchExpr,
  TextScoreExpr,
  FiltersExpr,
  SubqueryExpr,
  ExcludedExpr,
};

/** All built-in Expr classes, in a stable order for registry / docs. */
export const BUILTIN_EXPRS: readonly ExprClass[] = [
  LiteralExpr,
  OutputRefExpr,
  SorterExpr,
  FieldRefExpr,
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
  OperatorExpr,
  SemanticExpr,
  TextSearchExpr,
  TextScoreExpr,
  FiltersExpr,
  SubqueryExpr,
  ExcludedExpr,
];
