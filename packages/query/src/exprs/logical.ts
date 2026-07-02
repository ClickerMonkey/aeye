/**
 * LogicalExpr — boolean connective `and` / `or` / `not`. A `BoolExpr`. Each
 * operand must itself resolve to a boolean; `not` takes exactly one operand.
 */
import { z } from 'zod';
import type { ExprDef, LogicalExprDef, LogicalOp } from '../schema';
import type { SchemaOptions } from '../node';
import type { Registry } from '../registry';
import type { QueryEngine } from '../engine';
import type { QueryScope } from '../scope';
import type { ResolvedType } from '../resolved-type';
import type { Problems } from '../problem';
import { BoolExpr, Expr, type ExprClass, type ValidateContext } from '../expr';
import { categoryOf, childExprSchema } from './_shared';
import { ParamExpr } from './param';
import type { RuntimeContext } from '../runtime/context';
import type { SourceRow } from '../runtime/row';
import { and3, or3, not3, triOf, type Tri } from '../runtime/tri';
import type { Dialect } from '../sql/dialect';
import { type SqlContext, SqlText } from '../sql/emit';

/** A boolean connective `and` / `or` / `not`. A `BoolExpr`. */
export class LogicalExpr extends BoolExpr {
  static readonly KIND = 'logical' as const;
  readonly kind = LogicalExpr.KIND;

  /** Wrap a boolean connective (`and` / `or` / `not`) over its operands. */
  constructor(
    readonly op: LogicalOp,
    readonly operands: Expr[],
  ) {
    super();
  }

  /** Reconstruct a LogicalExpr from its JSON def (validates `kind`, recurses into operands via `registry.parseExpr`). */
  static from(json: ExprDef, registry: Registry): LogicalExpr {
    if (json.kind !== 'logical') {
      throw new Error(`LogicalExpr.from: expected 'logical', got '${json.kind}'`);
    }
    return new LogicalExpr(
      json.op,
      json.operands.map((o) => registry.parseExpr(o)),
    );
  }

  /** Zod schema for this expr kind's JSON shape (operands are child Expr slots). */
  static toSchema(opts: SchemaOptions): z.ZodTypeAny {
    return z
      .object({
        kind: z.literal('logical'),
        op: z.enum(['and', 'or', 'not']),
        operands: z.array(childExprSchema(opts.Expr)),
      })
      .meta({ aid: 'Expr_logical' })
      .describe('Boolean connective (and / or / not).');
  }

  override forEachChild(visit: (child: Expr) => void): void {
    for (const o of this.operands) visit(o);
  }

  /** Validate that each operand is boolean (and that `not` has exactly one operand); resolves to bool. */
  validateWalk(
    engine: QueryEngine,
    scope: QueryScope,
    p: Problems,
    ctx: ValidateContext,
  ): ResolvedType {
    if (this.op === 'not' && this.operands.length !== 1) {
      p.error('logical.arity', `'not' takes exactly one operand, got ${this.operands.length}.`);
    }
    p.at('operands', () => {
      this.operands.forEach((operand, i) => {
        const rt = p.at(i, () => operand.validateWalk(engine, scope, p, ctx));
        // Bind params used as standalone predicates to bool.
        if (operand instanceof ParamExpr) {
          // (left intentionally untyped here: a bare param as a boolean is
          // uncommon; comparison/in/between observe the precise type.)
          return;
        }
        if (categoryOf(rt) !== 'bool') {
          p.at(i, () =>
            p.error(
              'logical.non-bool',
              `Operand ${i} of '${this.op}' must be a boolean expression; got ${categoryOf(rt) ?? 'a type'}.`,
            ),
          );
        }
      });
    });
    return this.resolve(engine, scope);
  }

  /** Evaluate one operand under 3VL (a NULL boolean ⇒ UNKNOWN). */
  private async operandTri(
    operand: Expr,
    ctx: RuntimeContext,
    row: SourceRow,
    group?: readonly SourceRow[],
  ): Promise<Tri> {
    return triOf(await operand.evaluate(ctx, row, group));
  }

  /** Evaluate under 3VL: `and` (FALSE dominates), `or` (TRUE dominates), `not` (NOT UNKNOWN = UNKNOWN). */
  async evaluateBool(
    ctx: RuntimeContext,
    row: SourceRow,
    group?: readonly SourceRow[],
  ): Promise<Tri> {
    switch (this.op) {
      case 'and': {
        // FALSE dominates; else UNKNOWN if any operand is UNKNOWN; else TRUE.
        let acc: Tri = true;
        for (const o of this.operands) acc = and3(acc, await this.operandTri(o, ctx, row, group));
        return acc;
      }
      case 'or': {
        // TRUE dominates; else UNKNOWN if any operand is UNKNOWN; else FALSE.
        let acc: Tri = false;
        for (const o of this.operands) acc = or3(acc, await this.operandTri(o, ctx, row, group));
        return acc;
      }
      case 'not':
        // NOT UNKNOWN = UNKNOWN; an arity-checked `not` always has one operand.
        return this.operands[0]
          ? not3(await this.operandTri(this.operands[0], ctx, row, group))
          : true;
      default:
        return assertNeverOp(this.op);
    }
  }

  /** Emit as a parenthesized SqlText fragment (`NOT (...)`, or operands joined by `AND` / `OR`). */
  toSQL(dialect: Dialect, ctx: SqlContext): SqlText {
    if (this.op === 'not') {
      const inner = this.operands[0]?.toSQL(dialect, ctx) ?? SqlText.raw('TRUE');
      return SqlText.concat([SqlText.raw('NOT '), inner.parens()]);
    }
    const sep = this.op === 'and' ? ' AND ' : ' OR ';
    return SqlText.join(this.operands.map((o) => o.toSQL(dialect, ctx)), sep).parens();
  }

  /** Serialize back to its JSON ExprDef. */
  toJSON(): LogicalExprDef {
    return {
      kind: 'logical',
      op: this.op,
      operands: this.operands.map((o) => o.toJSON()),
    };
  }

  /** Deep-copy this expr (and its operands). */
  clone(): LogicalExpr {
    return new LogicalExpr(
      this.op,
      this.operands.map((o) => o.clone()),
    );
  }

  /** Render as readable pseudo-code. */
  override toCode(): string {
    if (this.op === 'not') return `NOT ${this.operands[0]?.toCode() ?? ''}`;
    return `(${this.operands.map((o) => o.toCode()).join(` ${this.op.toUpperCase()} `)})`;
  }
}

/** Compile-time exhaustiveness guard over the `LogicalOp` union. */
function assertNeverOp(op: never): never {
  throw new Error(`LogicalExpr: unhandled op ${JSON.stringify(op)}`);
}

const _check: ExprClass = LogicalExpr;
void _check;
