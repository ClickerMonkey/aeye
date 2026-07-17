/**
 * ComparisonExpr — scalar comparison `left <op> right` (`= <> < <= > >=` and
 * the text predicates `like` / `notLike` / `ilike`). A `BoolExpr`: resolves
 * to bool. Validation checks operand comparability and observes any bind
 * param against the other operand's field type.
 */
import { z } from 'zod';
import type { ComparisonExprDef, ComparisonOp, ExprDef } from '../schema';
import type { SchemaOptions } from '../node';
import type { Registry } from '../registry';
import type { QueryEngine } from '../engine';
import type { QueryScope } from '../scope';
import type { ResolvedType } from '../resolved-type';
import { asFieldType, valueFieldType, relationOf } from '../resolved-type';
import type { Problems } from '../problem';
import { BoolExpr, Expr, type ExprClass, type ValidateContext } from '../expr';
import type { IndexProbe } from '../cost';
import { EQ_SELECTIVITY, RANGE_SELECTIVITY } from '../cost';
import { categoryOf, childExprSchema, relationValueProblem, RELATION_VS_VALUE } from './_shared';
import { relationCompare, evaluateRelationCompare, emitRelationCompare, evaluateHasMany, emitHasMany, runtimeTypeOf, sqlTypeOf } from './_relation-compare';
import { withAid } from '../aids';
import { obj, lit, enumOf, exprRef } from '../shape';
import { operandCtx } from './_field-guard';
import { LiteralExpr } from './literal';
import { ParamExpr } from './param';
import { Value } from '../runtime/value';
import type { RuntimeContext } from '../runtime/context';
import type { SourceRow } from '../runtime/row';
import type { Dialect } from '../sql/dialect';
import { type SqlContext, SqlText } from '../sql/emit';

const LIKE_OPS = new Set<ComparisonOp>(['like', 'notLike', 'ilike']);

/** The comparison operators, as an array (drives the owned `SHAPE`'s `enumOf`). */
const COMPARISON_OPS = [
  '=', '<>', '<', '<=', '>', '>=', 'like', 'notLike', 'ilike',
] as const satisfies readonly ComparisonOp[];

/** SQL operator text for the non-ILIKE comparison ops. */
function sqlOp(op: ComparisonOp): string {
  switch (op) {
    case '=':
    case '<>':
    case '<':
    case '<=':
    case '>':
    case '>=':
      return op;
    case 'like':
      return 'LIKE';
    case 'notLike':
      return 'NOT LIKE';
    /* v8 ignore next 2 -- unreachable: toSQL handles 'ilike' via dialect.ilike before calling sqlOp */
    case 'ilike':
      return 'ILIKE';
    default:
      return assertNeverOp(op);
  }
}

function assertNeverOp(op: never): never {
  throw new Error(`ComparisonExpr: unhandled op ${JSON.stringify(op)}`);
}

/** Whether an operand is exempt from the comparability check. */
function exempt(e: Expr): boolean {
  return (e instanceof LiteralExpr && e.isNullLiteral()) || e instanceof ParamExpr;
}

/**
 * Whether a comparison between the two resolved operands is a CASE-INSENSITIVE
 * text comparison: BOTH operands resolve to text and neither side is a
 * `sensitive` text field. Drives the SQL `LOWER(...)` wrapping and mirrors the
 * runtime fold (`Value.compareToCase`, which folds whenever both raw values are
 * strings and no `sensitive` metadata is present). Non-text comparisons are
 * never case-folded.
 *
 * The package's product default for text is case-INSENSITIVE, so a plain text
 * comparison — including two string LITERALS (`'abc' = 'ABC'`) or a
 * metadata-less computed / subquery text column vs a literal — folds case in
 * BOTH the runtime and SQL. Only a `sensitive:true` text field forces a
 * case-sensitive match. A mixed text-vs-number comparison (which validation
 * forbids anyway) never folds.
 */
function isTextInsensitive(lrt: ResolvedType, rrt: ResolvedType): boolean {
  const textual = categoryOf(lrt) === 'text' && categoryOf(rrt) === 'text';
  if (!textual) return false;
  // A `sensitive` text FIELD on either side forces case-sensitive matching;
  // bare params / literals / computed text carry no sensitivity (default off).
  const lField = lrt.kind === 'field' ? lrt.field.fieldType : undefined;
  const rField = rrt.kind === 'field' ? rrt.field.fieldType : undefined;
  const sensitive = (lField?.textCaseSensitive() ?? false) || (rField?.textCaseSensitive() ?? false);
  return !sensitive;
}

/** Wrap a fragment in `LOWER(...)` for case-insensitive textual SQL. */
function lower(operand: SqlText): SqlText {
  return SqlText.concat([SqlText.raw('LOWER('), operand, SqlText.raw(')')]);
}

/** A scalar comparison `left <op> right` (`=`, `<>`, `<`, `like`, …). A `BoolExpr`. */
export class ComparisonExpr extends BoolExpr {
  static readonly KIND = 'comparison' as const;
  /** Concise LLM-facing summary of this expr kind (see `ExprClass.INSTRUCTIONS`). */
  static readonly INSTRUCTIONS = "`left <op> right` → boolean (`= <> < <= > >=`, `like`, `notLike`, `ilike`). A RELATION field-ref compares by IDENTITY with `=`/`<>` ONLY (ordering / LIKE on a relation is rejected). Its RHS may be (a) another relation of the SAME target — compared by FK key (`order.customer = invoice.customer`); or (b) a `{ pk }` VALUE param keyed by the target's primary-key fields (`assignedUser = :u` with `:u = {id:5}`); a single-key relation also accepts a bare scalar param. A BELONGS-TO compares the FK columns; a HAS-MANY compares by MEMBERSHIP — `= value` is TRUE when the value's key is in the related set (correlated EXISTS), `<>` is NOT EXISTS; a has-many may not be compared to another relation. Do NOT compare a relation to a scalar id COLUMN/field-ref (the correlation bug) — JOIN the relation (`joins:[{on:{kind:'relation',source,field,as}}]`) and compare the joined key." as const;
  readonly kind = ComparisonExpr.KIND;

  /** Wrap `left <op> right` as a scalar comparison predicate. */
  constructor(
    readonly op: ComparisonOp,
    readonly left: Expr,
    readonly right: Expr,
  ) {
    super();
  }

  /** Reconstruct a ComparisonExpr from its JSON def (validates `kind`, recurses into operands via `registry.parseExpr`). */
  static from(json: ExprDef, registry: Registry): ComparisonExpr {
    if (json.kind !== 'comparison') {
      throw new Error(`ComparisonExpr.from: expected 'comparison', got '${json.kind}'`);
    }
    return new ComparisonExpr(
      json.op,
      registry.parseExpr(json.left),
      registry.parseExpr(json.right),
    );
  }

  /**
   * Owned structural {@link Shape} — the zod-free parallel parser. Builds a
   * `ComparisonExpr` equal to `from`'s output on a valid def; on a bad def it
   * accumulates problems (never throws). See `shape/`.
   */
  static readonly SHAPE = obj(
    {
      kind: lit('comparison'),
      op: enumOf(COMPARISON_OPS, 'ComparisonOp'),
      left: exprRef(),
      right: exprRef(),
    },
    (v) => new ComparisonExpr(v.op, v.left, v.right),
    { aid: 'Expr_comparison' },
  );

  /** Zod schema for this expr kind's JSON shape (left/right are child Expr slots). */
  static toSchema(opts: SchemaOptions): z.ZodTypeAny {
    const child = childExprSchema(opts.Expr);
    return withAid(
      z.object({
        kind: z.literal('comparison'),
        op: withAid(z.enum(['=', '<>', '<', '<=', '>', '>=', 'like', 'notLike', 'ilike']), 'ComparisonOp'),
        left: child,
        right: child,
      }),
      'Expr_comparison',
    ).describe('Scalar comparison predicate.');
  }

  override forEachChild(visit: (child: Expr) => void): void {
    visit(this.left);
    visit(this.right);
  }

  /** Validate operands (comparability, or text for the LIKE family), infer any bind param from the other operand, and resolve to bool. */
  validateWalk(
    engine: QueryEngine,
    scope: QueryScope,
    p: Problems,
    ctx: ValidateContext,
  ): ResolvedType {
    const here = p.here;
    const l = p.at('left', () => this.left.validateWalk(engine, scope, p, operandCtx(this.left, 'comparison', ctx, true)));
    const r = p.at('right', () => this.right.validateWalk(engine, scope, p, operandCtx(this.right, 'comparison', ctx, true)));

    const lft = asFieldType(l);
    const rft = asFieldType(r);

    // A relation compares BY IDENTITY only — `=` / `<>`. Ordering (`< <= > >=`)
    // or a LIKE against a relation is meaningless (and would silently misread the
    // key), so reject it even though a bind-param operand is otherwise exempt.
    if (this.op !== '=' && this.op !== '<>' && (relationOf(l) || relationOf(r))) {
      p.error('comparison.relation-order', `A relation compares by identity — use '=' or '<>', not '${this.op}'.`);
    }

    // A HAS-MANY relation (a SET) compares only against a VALUE (its members'
    // key: a `{ pk }` object / scalar) — never against ANOTHER relation. Set-vs-set
    // and set-vs-identity relation comparisons are ill-defined here.
    const lRel = relationOf(l);
    const rRel = relationOf(r);
    if (lRel && rRel && (lRel.count > 1 || rRel.count > 1)) {
      const set = lRel.count > 1 ? lRel : rRel;
      p.error(
        'comparison.relation-set',
        `Has-many relation '${set.source}.${set.field}' compares against a value (its members' key), not another relation ('${(set === lRel ? rRel : lRel).source}.${(set === lRel ? rRel : lRel).field}').`,
      );
    }

    if (LIKE_OPS.has(this.op)) {
      // LIKE family requires text operands (params exempt — inferred text).
      if (!exempt(this.left) && categoryOf(l) !== 'text') {
        p.at('left', () =>
          p.error('comparison.like', `Operator '${this.op}' requires a text left operand.`),
        );
      }
      if (!exempt(this.right) && categoryOf(r) !== 'text') {
        p.at('right', () =>
          p.error('comparison.like', `Operator '${this.op}' requires a text right operand.`),
        );
      }
    } else if (!exempt(this.left) && !exempt(this.right)) {
      // A RELATION field-ref is a whole related row, not a scalar: reject it as a
      // value (the correlation bug) unless compared to another same-target
      // relation (then it compares by FK key). Checked before the scalar
      // comparability check (a relation resolves to a Type, so `lft`/`rft` would
      // otherwise be undefined and the mismatch would pass silently).
      const relProblem = relationValueProblem(l, r);
      if (relProblem) {
        p.error(RELATION_VS_VALUE, relProblem);
      } else if (lft && rft && !lft.comparableWith(rft)) {
        p.error(
          'comparison.type',
          `Cannot compare ${lft.resolve()} with ${rft.resolve()} using '${this.op}'.`,
        );
      }
    }

    // Param inference: a param takes the OTHER operand's VALUE type (a relation
    // sibling contributes its FK key type, so `relation = :param` types `:param`).
    const lvt = valueFieldType(l);
    const rvt = valueFieldType(r);
    if (this.left instanceof ParamExpr && rvt) {
      scope.params.observe(this.left.name, rvt, [...here, 'left']);
    }
    if (this.right instanceof ParamExpr && lvt) {
      scope.params.observe(this.right.name, lvt, [...here, 'right']);
    }

    return this.resolve(engine, scope);
  }

  /**
   * WHERE selectivity by operator: a range (`< <= > >=`) keeps ~half the rows;
   * equality and the equality-like ops (`= <> like notLike ilike`) keep ~a third.
   * An index-covered `=` is discounted separately by the cost model (via
   * {@link indexProbe}); this is the non-indexed fallback.
   */
  override selectivity(): number {
    switch (this.op) {
      case '<':
      case '<=':
      case '>':
      case '>=':
        return RANGE_SELECTIVITY;
      default:
        return EQ_SELECTIVITY;
    }
  }

  /** An `=` against a column is an index point-probe (arity 1); other ops are not. */
  override indexProbe(): IndexProbe | undefined {
    if (this.op !== '=') return undefined;
    const ref = this.left.fieldRef() ?? this.right.fieldRef();
    return ref ? { ref, arity: 1 } : undefined;
  }

  /** Evaluate under 3VL: a NULL operand yields UNKNOWN; text compares case-insensitively unless a `sensitive` field is involved. */
  async evaluateBool(
    ctx: RuntimeContext,
    row: SourceRow,
    group?: readonly SourceRow[],
  ): Promise<boolean | undefined> {
    // A belongs-to relation operand (`assignedUser = { id }` / `= createdUser`)
    // lowers to a per-key-column tuple comparison. Only `=` / `<>` compare a
    // relation; other ops are rejected in `validateWalk`.
    if (this.op === '=' || this.op === '<>') {
      const typeOf = runtimeTypeOf(ctx);
      const leftRel = relationCompare(this.left, ctx.engine, typeOf);
      const rightRel = relationCompare(this.right, ctx.engine, typeOf);
      // A HAS-MANY operand (a SET) compares by membership → EXISTS over its target.
      if (leftRel && leftRel.count > 1) return evaluateHasMany(this.op, leftRel, this.right, row, ctx, group);
      if (rightRel && rightRel.count > 1) return evaluateHasMany(this.op, rightRel, this.left, row, ctx, group);
      // A belongs-to operand compares by identity (per-key columns).
      if (leftRel || rightRel) {
        return evaluateRelationCompare(this.op, this.left, this.right, leftRel, rightRel, row, ctx, group);
      }
    }
    const l = await this.left.evaluate(ctx, row, group);
    const r = await this.right.evaluate(ctx, row, group);
    // SQL three-valued logic: a comparison with a NULL operand is UNKNOWN.
    if (l.isNull() || r.isNull()) return undefined;
    // Text comparison is case-insensitive unless a `sensitive` text field is
    // involved (carried as Value type metadata; default insensitive).
    const sensitive = l.caseSensitive() || r.caseSensitive();
    if (LIKE_OPS.has(this.op)) return this.evalLike(l, r, sensitive);
    const cmp = l.compareToCase(r, sensitive);
    switch (this.op) {
      case '=':
        return cmp === 0;
      case '<>':
        return cmp !== 0;
      case '<':
        return cmp < 0;
      case '<=':
        return cmp <= 0;
      case '>':
        return cmp > 0;
      case '>=':
        return cmp >= 0;
      default:
        return false;
    }
  }

  /**
   * LIKE / notLike / ilike via SQL wildcard → regex translation. `ilike` is
   * always case-insensitive; `like` / `notLike` are case-insensitive UNLESS a
   * `sensitive` text field governs the match (`sensitive === true`).
   */
  private evalLike(left: Value, right: Value, sensitive: boolean): boolean {
    const pattern = right
      .toText()
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replace(/%/g, '.*')
      .replace(/_/g, '.');
    const insensitive = this.op === 'ilike' || !sensitive;
    const flags = insensitive ? 'i' : '';
    const matched = new RegExp(`^${pattern}$`, flags).test(left.toText());
    return this.op === 'notLike' ? !matched : matched;
  }

  /** Emit as a SqlText fragment (ILIKE delegates to the dialect; case-insensitive text wraps both operands in `LOWER(...)`). */
  toSQL(dialect: Dialect, ctx: SqlContext): SqlText {
    // A belongs-to relation operand lowers to ANDed per-key-column comparisons.
    if (this.op === '=' || this.op === '<>') {
      const typeOf = sqlTypeOf(ctx);
      const leftRel = relationCompare(this.left, ctx.engine, typeOf);
      const rightRel = relationCompare(this.right, ctx.engine, typeOf);
      // A HAS-MANY operand (a SET) compares by membership → a correlated EXISTS.
      if (leftRel && leftRel.count > 1) return emitHasMany(this.op, leftRel, this.right, dialect, ctx);
      if (rightRel && rightRel.count > 1) return emitHasMany(this.op, rightRel, this.left, dialect, ctx);
      if (leftRel || rightRel) {
        return emitRelationCompare(this.op, this.left, this.right, leftRel, rightRel, dialect, ctx);
      }
    }
    let left = this.left.toSQL(dialect, ctx);
    let right = this.right.toSQL(dialect, ctx);
    // ILIKE is dialect-specific (native on Postgres, lowered on ANSI).
    if (this.op === 'ilike') return dialect.ilike(left, right);
    // Case-insensitive text comparison lowers both operands; sensitive text
    // and non-text comparisons emit plain operators.
    const insensitive = isTextInsensitive(
      this.left.resolve(ctx.engine, ctx.scope),
      this.right.resolve(ctx.engine, ctx.scope),
    );
    if (insensitive) {
      left = lower(left);
      right = lower(right);
    }
    return SqlText.join([left, SqlText.raw(sqlOp(this.op)), right], ' ');
  }

  /** Serialize back to its JSON ExprDef. */
  toJSON(): ComparisonExprDef {
    return {
      kind: 'comparison',
      op: this.op,
      left: this.left.toJSON(),
      right: this.right.toJSON(),
    };
  }

  /** Deep-copy this expr (and its operands). */
  clone(): ComparisonExpr {
    return new ComparisonExpr(this.op, this.left.clone(), this.right.clone());
  }

  /** Render as readable pseudo-code. */
  override toCode(): string {
    return `(${this.left.toCode()} ${this.op} ${this.right.toCode()})`;
  }
}

const _check: ExprClass = ComparisonExpr;
void _check;
