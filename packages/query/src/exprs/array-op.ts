/**
 * ArrayOpExpr — a predicate over an ARRAY-valued target. A `BoolExpr`.
 *
 *  - `contains`     — the array contains the single element `value`.
 *  - `containsAny`  — the array overlaps any element of the `value` list.
 *  - `containsAll`  — the array contains every element of the `value` list.
 *  - `isEmpty`      — the array has no elements (no `value`).
 *  - `notEmpty`     — the array has at least one element (no `value`).
 *
 * Validation requires `target` to resolve to an ARRAY field (`array-op.not-array`),
 * the value/element types to be compatible with the array's `item` type when
 * known (`array-op.type-mismatch`), and the operand arity to match the op
 * (`array-op.value-arity`).
 *
 * SQL is Postgres-native (`@>` / `&&` / `= ANY` / `cardinality`). The base ANSI
 * dialect has no array operators, so containment degrades to a clearly-documented
 * `QueryTypeError` thrown from the dialect; emptiness (which only needs the array
 * length) still works via `Dialect.arrayLength`.
 */
import { z } from 'zod';
import type { ArrayOp, ArrayOpExprDef, ExprDef } from '../schema';
import type { SchemaOptions } from '../node';
import type { Registry } from '../registry';
import type { QueryEngine } from '../engine';
import type { QueryScope } from '../scope';
import type { ResolvedType } from '../resolved-type';
import type { FieldType } from '../field-type';
import { asFieldType } from '../resolved-type';
import type { Problems } from '../problem';
import { BoolExpr, Expr, type ExprClass, type ValidateContext } from '../expr';
import { categoryOf, childExprSchema, declaredArmRefusal } from './_shared';
import { effectiveCasing, foldsAtRuntime, type TextCasing } from '../text-casing';
import { withAid } from '../aids';
import { obj, lit, enumOf, list, exprRef, INVALID, type Shape } from '../shape';
import { operandCtx } from './_field-guard';
import { ArrayFieldType } from '../field-types/index';
import { ParamExpr } from './param';
import { Value } from '../runtime/value';
import type { JsonValue } from '../schema';
import type { RuntimeContext } from '../runtime/context';
import type { SourceRow } from '../runtime/row';
import type { Dialect } from '../sql/dialect';
import { type SqlContext, SqlText } from '../sql/emit';

/** Ops that take no operand value. */
const NO_VALUE_OPS: ReadonlySet<ArrayOp> = new Set<ArrayOp>(['isEmpty', 'notEmpty']);
/** Ops that take a single element operand. */
const SINGLE_VALUE_OPS: ReadonlySet<ArrayOp> = new Set<ArrayOp>(['contains']);
/** Ops that take a list of element operands. */
const LIST_VALUE_OPS: ReadonlySet<ArrayOp> = new Set<ArrayOp>(['containsAny', 'containsAll']);

/** The array operators, as an array (drives the owned `SHAPE`'s `enumOf`). */
const ARRAY_OPS = [
  'contains', 'containsAny', 'containsAll', 'isEmpty', 'notEmpty',
] as const satisfies readonly ArrayOp[];

/**
 * Structural shape for the polymorphic `value` slot: a single element expr, a
 * LIST of element exprs, or omitted — always NORMALIZED to an `Expr[]` (matching
 * `from`), so `toJSON` re-serializes per the op's arity. Never throws.
 */
const ARRAY_VALUE_SHAPE: Shape<Expr[]> = {
  check(json, ctx) {
    if (Array.isArray(json)) return list(exprRef()).check(json, ctx);
    const built = exprRef().check(json, ctx);
    return built === INVALID ? INVALID : [built];
  },
};

/** A predicate over an array-valued target (`contains` / `containsAny` / `isEmpty` / …). A `BoolExpr`. */
export class ArrayOpExpr extends BoolExpr {
  static readonly KIND = 'array-op' as const;
  /** Concise LLM-facing summary of this expr kind (see `ExprClass.INSTRUCTIONS`). */
  static readonly INSTRUCTIONS = "Predicate over an array field: `contains` / `containsAny` / `containsAll` / `isEmpty` / `notEmpty`." as const;
  readonly kind = ArrayOpExpr.KIND;

  /** Wrap an array predicate `op` over `target` with its element operand(s). */
  constructor(
    readonly op: ArrayOp,
    readonly target: Expr,
    /** Element operand(s): empty for `isEmpty`/`notEmpty`, one for `contains`,
     *  a list for `containsAny`/`containsAll`. Normalized to an array. */
    readonly values: Expr[],
  ) {
    super();
  }

  /** Reconstruct an ArrayOpExpr from its JSON def, recursing into target/values via the registry. */
  static from(json: ExprDef, registry: Registry): ArrayOpExpr {
    if (json.kind !== 'array-op') {
      throw new Error(`ArrayOpExpr.from: expected 'array-op', got '${json.kind}'`);
    }
    const target = registry.parseExpr(json.target);
    const values =
      json.value === undefined
        ? []
        : Array.isArray(json.value)
          ? json.value.map((v) => registry.parseExpr(v))
          : [registry.parseExpr(json.value)];
    return new ArrayOpExpr(json.op, target, values);
  }

  /**
   * Owned structural {@link Shape} — the zod-free parallel parser. Builds an
   * `ArrayOpExpr` equal to `from`'s output on a valid def (the `value` slot is
   * normalized to `Expr[]` — single, list, or empty). Accumulates problems in
   * one pass (never throws). The array-type / arity checks remain in
   * `validateWalk`. See `shape/`.
   */
  static readonly SHAPE = obj(
    {
      kind: lit('array-op'),
      op: enumOf(ARRAY_OPS, 'ArrayOp'),
      target: exprRef(),
      value: ARRAY_VALUE_SHAPE,
    },
    (v) => new ArrayOpExpr(v.op, v.target, v.value ?? []),
    { optional: ['value'], aid: 'Expr_array-op' },
  );

  /** Zod schema for this expr kind's JSON shape (target plus a single/list/omitted value child). */
  static toSchema(opts: SchemaOptions): z.ZodTypeAny {
    const child = childExprSchema(opts.Expr);
    return withAid(
      z.object({
        kind: z.literal('array-op'),
        op: withAid(z.enum(['contains', 'containsAny', 'containsAll', 'isEmpty', 'notEmpty']), 'ArrayOp').describe(
          'Array predicate: element membership / overlap / emptiness.',
        ),
        // The target is the recursive `Expr` union (`opts.Expr` is a shared
        // `z.lazy`). Use it DIRECTLY — never `.describe()` it here. `.describe()`
        // CLONES the lazy into a fresh, aid-less wrapper whose new identity
        // defeats BOTH of the converter's recursion cache keys (instance identity
        // AND the lazy's `aid`), so `toJSONSchema` re-evaluates the getter on every
        // encounter and recurses until the stack overflows. (The description is
        // dropped at a recursive `$ref` position anyway, which is why every other
        // expr class threads `childExprSchema(opts.Expr)` in bare — see #array-op
        // overflow.) The wrapping object's own `.describe` still documents the kind.
        target: child,
        value: z
          .union([child, z.array(child)])
          .optional()
          .describe('Single element (contains), element list (containsAny/All), or omitted (isEmpty/notEmpty).'),
      }),
      'Expr_array-op',
    ).describe('Array containment / emptiness predicate.');
  }

  override forEachChild(visit: (child: Expr) => void): void {
    visit(this.target);
    for (const v of this.values) visit(v);
  }

  // ─── Validation ────────────────────────────────────────────────────────────

  /** Whether `count` operand values is valid for `op`; an arity message if not. */
  private static arityMessage(op: ArrayOp, count: number): string | undefined {
    if (NO_VALUE_OPS.has(op)) return count === 0 ? undefined : `Array op '${op}' takes no value.`;
    if (SINGLE_VALUE_OPS.has(op)) return count === 1 ? undefined : `Array op '${op}' requires exactly one element value.`;
    // list ops
    return count >= 1 ? undefined : `Array op '${op}' requires a non-empty list of element values.`;
  }

  /** Validate the target is an array field and the element operands match its arity and item type. */
  validateWalk(
    engine: QueryEngine,
    scope: QueryScope,
    p: Problems,
    ctx: ValidateContext,
  ): ResolvedType {
    const here = p.here;
    const t = p.at('target', () => this.target.validateWalk(engine, scope, p, operandCtx(this.target, 'array-op', ctx)));
    const tft = asFieldType(t);
    const targetArray = tft instanceof ArrayFieldType ? tft : undefined;
    if (!targetArray) {
      p.at('target', () =>
        p.error(
          'array-op.not-array',
          `Array op '${this.op}' requires an array field; got ${categoryOf(t) ?? 'a value'}.`,
        ),
      );
    }
    const item = targetArray?.item;

    // Arity.
    const arityMsg = ArrayOpExpr.arityMessage(this.op, this.values.length);
    if (arityMsg) p.at('value', () => p.error('array-op.value-arity', arityMsg));

    // CONTAINMENT IS EQUALITY WITH A DIFFERENT KEYWORD, so a type declaring no
    // equality refuses it for the reason it refuses `=` and `IN`. `contains`
    // emits a literal `$1 = ANY("doc"."list")`; `containsAll` emits
    // `@> ARRAY[$1, $2]`. `isEmpty` / `notEmpty` are deliberately NOT gated —
    // they emit `cardinality(…) = 0`, which compares a COUNT and never an
    // element, so a type that cannot be compared can still be asked whether
    // there is one.
    //
    // BOTH REFINEMENTS ARE CONSULTED, and that is the part a single check at the
    // top would have got wrong: `declaredArmRefusal` reads `ft.refinement`, which
    // on an `ArrayFieldType` is the ARRAY's own tag — so a
    // `{kind:'array', as:'BlobList'}` target and an
    // `array<json as Blob>` target are two different shapes, and only the first
    // has a tag where a top-level check would look. The element operands go in
    // too, for the same reason `IN` collects them: a declared comparability edge
    // lets the refusing side be any of them.
    const operandTypes: (FieldType | undefined)[] = [tft, item];

    // Validate each element operand + element-type compatibility with `item`.
    this.values.forEach((el, i) => {
      const rt = p.at(['value', i], () => el.validateWalk(engine, scope, p, ctx));
      if (el instanceof ParamExpr) {
        // `t` is the ARRAY column, and the param's requirement is derived from
        // it (its ITEM type), so the use is attributed to it — every other
        // `observe` site with a column in hand does the same, and a `ParamUse`
        // that could not say where its type came from only for array ops would
        // be an inconsistency in the reported surface, not a smaller answer.
        if (item) scope.params.observe(el.name, item, [...here, 'value', i], t);
        return;
      }
      const eft = asFieldType(rt);
      operandTypes.push(eft);
      if (item && eft && !item.comparableWith(eft)) {
        p.at(['value', i], () =>
          p.error(
            'array-op.type-mismatch',
            `Element ${i} (${eft.resolve()}) is not compatible with the array item type (${item.resolve()}).`,
          ),
        );
      }
    });

    if (!NO_VALUE_OPS.has(this.op)) {
      const armRefusal = declaredArmRefusal('equality', `'${this.op}'`, operandTypes);
      if (armRefusal) p.error('array-op.type-mismatch', armRefusal);
    }

    return this.resolve(engine, scope);
  }

  // ─── Evaluation ────────────────────────────────────────────────────────────

  /**
   * Whether textual element comparison is case-sensitive: the ELEMENT type's
   * declared {@link TextCasing} when the target Value carries one, else the
   * engine's default — the same resolution `ComparisonExpr` applies to a
   * scalar, so `tags contains 'BETA'` and `tag = 'BETA'` cannot answer
   * differently for one deployment.
   *
   * A non-text element folds nothing regardless, because `compareToCase` only
   * folds when BOTH raw values are strings.
   */
  private elementCaseSensitive(target: Value, engineDefault: TextCasing): boolean {
    const t = target.type;
    const declared = t instanceof ArrayFieldType ? t.item?.textCasing() : undefined;
    return !foldsAtRuntime(effectiveCasing(declared, undefined, engineDefault));
  }

  /** Evaluate the predicate: containment / overlap / emptiness over the target array. */
  async evaluateBool(
    ctx: RuntimeContext,
    row: SourceRow,
    group?: readonly SourceRow[],
  ): Promise<boolean> {
    const tv = await this.target.evaluate(ctx, row, group);
    const arr: readonly JsonValue[] | null = Array.isArray(tv.raw) ? tv.raw : null;
    const sensitive = this.elementCaseSensitive(tv, ctx.engine.textCasing);

    switch (this.op) {
      case 'isEmpty':
        return arr === null || arr.length === 0;
      case 'notEmpty':
        return arr !== null && arr.length > 0;
      case 'contains': {
        if (!arr) return false;
        const needle = await this.values[0]!.evaluate(ctx, row, group);
        return arrayHas(arr, needle, sensitive);
      }
      case 'containsAny': {
        if (!arr) return false;
        const needles = await this.evalValues(ctx, row, group);
        return needles.some((n) => arrayHas(arr, n, sensitive));
      }
      case 'containsAll': {
        if (!arr) return false;
        const needles = await this.evalValues(ctx, row, group);
        return needles.every((n) => arrayHas(arr, n, sensitive));
      }
      /* v8 ignore next 2 -- unreachable: `op` is exhaustively handled above (compile-time guard) */
      default:
        return assertNever(this.op);
    }
  }

  /** Evaluate every element operand to a `Value`. */
  private async evalValues(
    ctx: RuntimeContext,
    row: SourceRow,
    group?: readonly SourceRow[],
  ): Promise<Value[]> {
    const out: Value[] = [];
    for (const v of this.values) out.push(await v.evaluate(ctx, row, group));
    return out;
  }

  // ─── SQL ───────────────────────────────────────────────────────────────────

  /** Emit the array predicate via the dialect's array operators. */
  toSQL(dialect: Dialect, ctx: SqlContext): SqlText {
    const col = this.target.toSQL(dialect, ctx);
    switch (this.op) {
      case 'isEmpty':
        return SqlText.concat([dialect.arrayLength(col), SqlText.raw(' = 0')]);
      case 'notEmpty':
        return SqlText.concat([dialect.arrayLength(col), SqlText.raw(' <> 0')]);
      case 'contains':
        return dialect.arrayHas(col, this.values[0]!.toSQL(dialect, ctx));
      case 'containsAny':
        return dialect.arrayOverlaps(col, this.values.map((v) => v.toSQL(dialect, ctx)));
      case 'containsAll':
        return dialect.arrayContains(col, this.values.map((v) => v.toSQL(dialect, ctx)));
      /* v8 ignore next 2 -- unreachable: `op` is exhaustively handled above (compile-time guard) */
      default:
        return assertNever(this.op);
    }
  }

  // ─── Serialization ──────────────────────────────────────────────────────────

  /** Serialize back to its JSON ExprDef. */
  toJSON(): ArrayOpExprDef {
    const def: ArrayOpExprDef = { kind: 'array-op', op: this.op, target: this.target.toJSON() };
    if (SINGLE_VALUE_OPS.has(this.op)) {
      const first = this.values[0];
      if (first) def.value = first.toJSON();
    } else if (LIST_VALUE_OPS.has(this.op)) {
      def.value = this.values.map((v) => v.toJSON());
    }
    return def;
  }

  /** Deep-copy this expr (and its target/value children). */
  clone(): ArrayOpExpr {
    return new ArrayOpExpr(this.op, this.target.clone(), this.values.map((v) => v.clone()));
  }

  /** Render a human-readable source form of this predicate. */
  override toCode(): string {
    if (NO_VALUE_OPS.has(this.op)) return `${this.op}(${this.target.toCode()})`;
    const rhs = LIST_VALUE_OPS.has(this.op)
      ? `[${this.values.map((v) => v.toCode()).join(', ')}]`
      : (this.values[0]?.toCode() ?? 'NULL');
    return `${this.target.toCode()} ${this.op} ${rhs}`;
  }
}

/** Whether `needle` is a member of `arr` (NULLs never match; text folds case
 *  unless the effective casing is `'exact'`). */
function arrayHas(arr: readonly JsonValue[], needle: Value, sensitive: boolean): boolean {
  if (needle.isNull()) return false;
  for (const el of arr) {
    if (el === null) continue;
    if (Value.of(el).compareToCase(needle, sensitive) === 0) return true;
  }
  return false;
}

/* v8 ignore next 4 -- unreachable: compile-time exhaustiveness guard; never called at runtime */
/** Compile-time exhaustiveness guard over `ArrayOp`. */
function assertNever(value: never): never {
  throw new Error(`ArrayOpExpr: unhandled op ${JSON.stringify(value)}`);
}

const _check: ExprClass = ArrayOpExpr;
void _check;
