/**
 * ExprQuery — a query that is a single expression (e.g. a scalar computation
 * or a constant). It produces exactly one output row with one field `value`.
 */
import type { ExprQueryDef, QueryDef } from '../schema';
import type { Registry } from '../registry';
import type { QueryEngine } from '../engine';
import type { QueryScope } from '../scope';
import type { Problems } from '../problem';
import type { Expr, ValidateContext } from '../expr';
import type { RuntimeContext } from '../runtime/context';
import { Query, type QueryClass, type QueryField, type QueryResult, makeField, makeResult } from './query';
import { type Cost, bytesOfResolved } from '../cost';
import type { Dialect } from '../sql/dialect';
import { type SqlContext, SqlText } from '../sql/emit';

/** A query that is a single expression, producing exactly one row with one `value` field. */
export class ExprQuery extends Query {
  /** The Registry dispatch discriminant for this query kind. */
  static readonly KIND = 'expr' as const;
  /** This query's `kind` discriminant. */
  readonly kind = ExprQuery.KIND;

  /** Construct from the single expression this query evaluates. */
  constructor(/** The expression producing the lone `value` output. */ readonly expr: Expr) {
    super();
  }

  /** Parse an `expr` `QueryDef` into an `ExprQuery`. */
  static from(json: QueryDef, registry: Registry): ExprQuery {
    if (json.kind !== 'expr') throw new Error(`ExprQuery.from: expected 'expr', got '${json.kind}'`);
    return new ExprQuery(registry.parseExpr(json.expr));
  }

  /** The single output field `value` (the expression's resolved type). */
  outputFields(engine: QueryEngine, scope: QueryScope): QueryField[] {
    return [makeField('value', this.expr.resolve(engine, scope))];
  }

  /** Validate the wrapped expression. */
  validateWalk(engine: QueryEngine, scope: QueryScope, p: Problems, ctx: ValidateContext): void {
    p.at('expr', () => this.expr.validateWalk(engine, scope, p, ctx));
  }

  /** None — an expression query reads no Type. */
  referencedTypes(): readonly string[] {
    return [];
  }

  /** Estimate `{ rows, bytes }` — exactly one row sized by the expression's resolved type. */
  cost(engine: QueryEngine, scope: QueryScope): Cost {
    // A single-expression query yields exactly one row.
    return { rows: 1, bytes: bytesOfResolved(this.expr.resolve(engine, scope)) };
  }

  /** Evaluate the expression into a single `{ value }` output row. */
  async execute(ctx: RuntimeContext): Promise<QueryResult> {
    const value = await this.expr.evaluate(ctx, null);
    const fields = this.outputFields(ctx.engine, ctx.engine.globalScope());
    return makeResult('expr', [{ value: value.raw }], fields);
  }

  /** Emit `SELECT <expr> AS "value"`. */
  toSQL(dialect: Dialect, ctx: SqlContext): SqlText {
    return SqlText.concat([
      SqlText.raw('SELECT '),
      this.expr.toSQL(dialect, ctx),
      SqlText.raw(' AS '),
      dialect.ident('value'),
    ]);
  }

  /** Serialize back to an `ExprQueryDef`. */
  toJSON(): ExprQueryDef {
    return { kind: 'expr', expr: this.expr.toJSON() };
  }

  /** Deep-clone this query (cloning its expression). */
  clone(): ExprQuery {
    return new ExprQuery(this.expr.clone());
  }
}

const _check: QueryClass = ExprQuery;
void _check;
