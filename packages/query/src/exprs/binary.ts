/**
 * BinaryExpr — arithmetic `left <op> right` (`+ - * / %`). Resolves to a
 * numeric (or money, when either side is money) value, except `+` over text
 * operands which is string concatenation (→ text). NULL literals and bind
 * params skip the numeric-operand check (NULL is universally compatible;
 * params are inferred numeric here).
 */
import { z } from 'zod';
import type { BinaryExprDef, BinaryOp, ExprDef } from '../schema';
import type { SchemaOptions } from '../node';
import type { Registry } from '../registry';
import type { QueryEngine } from '../engine';
import type { QueryScope } from '../scope';
import type { ResolvedType } from '../resolved-type';
import { asFieldType } from '../resolved-type';
import type { Problems } from '../problem';
import { Expr, type ExprClass, type ValidateContext } from '../expr';
import { MoneyFieldType, NumberFieldType } from '../field-types/index';
import {
  computed,
  textResult,
  gatherSources,
  anyNullable,
  anyAggregate,
  categoryOf,
  childExprSchema,
  relationAsValueMessage,
  RELATION_VS_VALUE,
} from './_shared';
import { relationOf } from '../resolved-type';
import { withAid } from '../aids';
import { obj, lit, enumOf, exprRef } from '../shape';
import { LiteralExpr } from './literal';
import { ParamExpr } from './param';
import { Value } from '../runtime/value';
import type { RuntimeContext } from '../runtime/context';
import type { SourceRow } from '../runtime/row';
import type { Cost } from '../cost';
import type { Dialect } from '../sql/dialect';
import { type SqlContext, SqlText } from '../sql/emit';

const NUMERIC = new Set(['number', 'money']);

/** The arithmetic operators, as an array (drives the owned `SHAPE`'s `enumOf`). */
const BINARY_OPS = ['+', '-', '*', '/', '%'] as const satisfies readonly BinaryOp[];

/** Whether an operand is exempt from the numeric-type check. */
function exempt(e: Expr): boolean {
  return (e instanceof LiteralExpr && e.isNullLiteral()) || e instanceof ParamExpr;
}

/** An arithmetic binary expression `left <op> right` (`+ - * / %`). */
export class BinaryExpr extends Expr {
  static readonly KIND = 'binary' as const;
  /** Concise LLM-facing summary of this expr kind (see `ExprClass.INSTRUCTIONS`). */
  static readonly INSTRUCTIONS = "Arithmetic `left <op> right` (`+ - * / %`)." as const;
  readonly kind = BinaryExpr.KIND;

  /** Wrap an arithmetic operation over its operator and left/right operand exprs. */
  constructor(
    readonly op: BinaryOp,
    readonly left: Expr,
    readonly right: Expr,
  ) {
    super();
  }

  /** Reconstruct a BinaryExpr from its JSON def (validates the `kind` discriminant). */
  static from(json: ExprDef, registry: Registry): BinaryExpr {
    if (json.kind !== 'binary') {
      throw new Error(`BinaryExpr.from: expected 'binary', got '${json.kind}'`);
    }
    return new BinaryExpr(
      json.op,
      registry.parseExpr(json.left),
      registry.parseExpr(json.right),
    );
  }

  /**
   * Owned structural {@link Shape} — the zod-free parallel parser. Builds a
   * `BinaryExpr` equal to `from`'s output on a valid def; accumulates problems
   * on a bad def (never throws). See `shape/`.
   */
  static readonly SHAPE = obj(
    {
      kind: lit('binary'),
      op: enumOf(BINARY_OPS, 'BinaryOp'),
      left: exprRef(),
      right: exprRef(),
    },
    (v) => new BinaryExpr(v.op, v.left, v.right),
    { aid: 'Expr_binary' },
  );

  /** Zod schema for this expr kind's JSON shape (operands use the shared child Expr schema). */
  static toSchema(opts: SchemaOptions): z.ZodTypeAny {
    const child = childExprSchema(opts.Expr);
    return withAid(
      z.object({
        kind: z.literal('binary'),
        op: withAid(z.enum(['+', '-', '*', '/', '%']), 'BinaryOp'),
        left: child,
        right: child,
      }),
      'Expr_binary',
    ).describe('Arithmetic binary operation.');
  }

  override forEachChild(visit: (child: Expr) => void): void {
    visit(this.left);
    visit(this.right);
  }

  /** Resolve to numeric/money (or text for `+` over text), propagating sources/nullability/aggregate. */
  resolve(engine: QueryEngine, scope: QueryScope): ResolvedType {
    const l = this.left.resolve(engine, scope);
    const r = this.right.resolve(engine, scope);
    const sources = gatherSources([l, r]);
    const nullable = anyNullable([l, r]);
    const aggregate = anyAggregate([l, r]);
    const lc = categoryOf(l);
    const rc = categoryOf(r);
    // `+` over any text operand is string concatenation → text.
    if (this.op === '+' && (lc === 'text' || rc === 'text')) {
      return textResult(sources, nullable, aggregate);
    }
    const fieldType = lc === 'money' || rc === 'money' ? new MoneyFieldType() : new NumberFieldType();
    return computed(fieldType, sources, nullable, aggregate);
  }

  /** Validate both operands are numeric (text ok for `+`), infer param types, then resolve. */
  validateWalk(
    engine: QueryEngine,
    scope: QueryScope,
    p: Problems,
    ctx: ValidateContext,
  ): ResolvedType {
    const here = p.here;
    // `relationValueOk`: binary runs its own relation-operand check below (a
    // relation is never a number → the join-it hint), so suppress the generic
    // field-ref `ref.relation-not-value` to avoid a duplicate report.
    const opCtx: ValidateContext = { ...ctx, relationValueOk: true };
    const l = p.at('left', () => this.left.validateWalk(engine, scope, p, opCtx));
    const r = p.at('right', () => this.right.validateWalk(engine, scope, p, opCtx));

    const checkNumeric = (operand: Expr, rt: ResolvedType, key: 'left' | 'right'): void => {
      if (exempt(operand)) return;
      // A RELATION field-ref is a whole related row, never a number — reject it
      // as an arithmetic operand with the join-it hint (not the generic type msg).
      const rel = relationOf(rt);
      if (rel) {
        p.at(key, () => p.error(RELATION_VS_VALUE, relationAsValueMessage(rel)));
        return;
      }
      const cat = categoryOf(rt);
      // `+` over text is allowed (concatenation).
      if (this.op === '+' && cat === 'text') return;
      if (cat === undefined || !NUMERIC.has(cat)) {
        p.at(key, () => {
          p.error(
            'binary.type',
            `Operator '${this.op}' requires numeric operands; '${key}' is ${cat ?? 'a type'}.`,
          );
        });
      }
    };
    checkNumeric(this.left, l, 'left');
    checkNumeric(this.right, r, 'right');

    // Infer params numeric against the other operand's type when known.
    if (this.left instanceof ParamExpr) {
      const ft = asFieldType(r);
      if (ft) scope.params.observe(this.left.name, ft, [...here, 'left']);
    }
    if (this.right instanceof ParamExpr) {
      const ft = asFieldType(l);
      if (ft) scope.params.observe(this.right.name, ft, [...here, 'right']);
    }

    return this.resolve(engine, scope);
  }

  /** Cost is the sum of the child operands' costs. */
  cost(engine: QueryEngine, scope: QueryScope): Cost {
    return this.childCost(engine, scope);
  }

  /** Evaluate both operands and apply the op (NULL-propagating; `+` concatenates non-numbers). */
  async evaluate(
    ctx: RuntimeContext,
    row: SourceRow | null,
    group?: readonly SourceRow[],
  ): Promise<Value> {
    const l = await this.left.evaluate(ctx, row, group);
    const r = await this.right.evaluate(ctx, row, group);
    if (l.isNull() || r.isNull()) return Value.null();
    const ln = l.toNumber();
    const rn = r.toNumber();
    // Non-numeric `+` is string concatenation; other ops over non-numbers → NULL.
    if (Number.isNaN(ln) || Number.isNaN(rn)) {
      return this.op === '+' ? Value.of(l.toText() + r.toText()) : Value.null();
    }
    switch (this.op) {
      case '+':
        return Value.of(ln + rn);
      case '-':
        return Value.of(ln - rn);
      case '*':
        return Value.of(ln * rn);
      case '/':
        return rn === 0 ? Value.null() : Value.of(ln / rn);
      case '%':
        return rn === 0 ? Value.null() : Value.of(ln % rn);
      default:
        return assertNeverOp(this.op);
    }
  }

  /** Emit as a parenthesized `(left op right)` SqlText fragment. */
  toSQL(dialect: Dialect, ctx: SqlContext): SqlText {
    return SqlText.join(
      [this.left.toSQL(dialect, ctx), SqlText.raw(this.op), this.right.toSQL(dialect, ctx)],
      ' ',
    ).parens();
  }

  /** Serialize back to its JSON ExprDef. */
  toJSON(): BinaryExprDef {
    return {
      kind: 'binary',
      op: this.op,
      left: this.left.toJSON(),
      right: this.right.toJSON(),
    };
  }

  /** Deep-copy this expr and its operands. */
  clone(): BinaryExpr {
    return new BinaryExpr(this.op, this.left.clone(), this.right.clone());
  }

  /** Render as source-like code (`(left op right)`). */
  override toCode(): string {
    return `(${this.left.toCode()} ${this.op} ${this.right.toCode()})`;
  }
}

function assertNeverOp(op: never): never {
  throw new Error(`BinaryExpr: unhandled op ${JSON.stringify(op)}`);
}

const _check: ExprClass = BinaryExpr;
void _check;
