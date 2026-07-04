/**
 * Abstract `Expr` base + `BoolExpr` marker + `ExprClass` static contract +
 * the module-level `canonicalize(expr)` digest.
 *
 * This merges the relevant halves of gin's `Expr` (parse / resolve /
 * validate / clone / Code rendering, one class per kind, Registry dispatch)
 * with cletus's relational expression semantics — but DROPS gin's
 * effects / complexity / loop / lambda machinery, which has no analogue in a
 * relational query language.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * STAGED ABSTRACT SURFACE — read before extending.
 *
 * This phase (Phase 2) the base declares ONLY resolution + validation +
 * serialization. Three further abstract methods are intentionally NOT here
 * yet; each lands with the phase that builds its supporting infrastructure:
 *
 *   - `evaluate(rt, row, group?): Promise<Value>`  → Phase 3 (in-memory run)
 *   - `cost(engine, scope): Cost`                  → Phase 4 (cost estimation) ✓
 *   - `toSQL(dialect, ctx): SqlText`               → Phase 5 (SQL converter)
 *
 * Phase 4 has now landed `cost`: it is declared `abstract` below and
 * implemented by every concrete expr class. `BoolExpr` supplies a shared
 * children-summing default so its predicate subclasses only override when
 * they add a cost of their own (text-search penalty, subquery scans, …).
 * `toSQL` still waits for Phase 5.
 * ─────────────────────────────────────────────────────────────────────────
 */
import type { z } from 'zod';
import type { ExprDef, ExprKind } from './schema';
import type { CodeOptions, Node, SchemaOptions } from './node';
import type { Registry } from './registry';
import type { ResolvedType, ComputedResolved, FieldResolved } from './resolved-type';
import { isScalar, sourcesOf } from './resolved-type';
import type { QueryEngine } from './engine';
import type { QueryScope } from './scope';
import type { ParamSet } from './param';
import type { RuntimeContext } from './runtime/context';
import type { SourceRow } from './runtime/row';
import type { Cost } from './cost';
import { ZERO_COST, addCost } from './cost';
import type { Dialect } from './sql/dialect';
import type { SqlContext, SqlText } from './sql/emit';
import { Problems } from './problem';
import { Code, span } from './code';
import { exprDigest } from './index-spec';
import { BoolFieldType } from './field-types/index';
import { Value } from './runtime/value';

/**
 * Context threaded through a validate walk so aggregate / window placement
 * rules can be enforced structurally:
 *  - `inAggregate`   — currently inside an aggregate's argument.
 *  - `inWindow`      — currently inside a window function's clauses.
 *  - `allowAggregate`— aggregates are legal at this position (e.g. select /
 *                      having), illegal otherwise (e.g. where / inside another
 *                      aggregate).
 *  - `groupKeys`     — the GROUP BY key expressions in scope (reserved for
 *                      Phase 3's grouped-select validation).
 *  - `inGroupBy`     — currently inside a GROUP BY key position. Lets an
 *                      `output` reference reject a target that is an aggregate
 *                      (`output.aggregate` — you cannot group BY an aggregate).
 */
export interface ValidateContext {
  readonly inAggregate: boolean;
  readonly inWindow: boolean;
  readonly allowAggregate: boolean;
  readonly groupKeys: readonly Expr[];
  readonly inGroupBy: boolean;
  /**
   * The expr KIND a DIRECT field-ref operand is being gated as. A gating
   * operator (`comparison` / `between` / `in` / `is-null` / `array-op`) sets this
   * when validating a direct field-ref operand, so the field-ref checks its
   * `exprs` restriction against the OPERATOR's kind rather than `'field-ref'`.
   * Undefined (the default) means a standalone field-ref, gated as `'field-ref'`.
   */
  readonly fieldExprKind?: ExprKind;
}

/** The default top-level context: a bare expression may aggregate freely. */
export const ROOT_VALIDATE_CONTEXT: ValidateContext = {
  inAggregate: false,
  inWindow: false,
  allowAggregate: true,
  groupKeys: [],
  inGroupBy: false,
};

/**
 * Per-kind expression class — the static contract every concrete Expr class
 * satisfies, so `Registry.parseExpr(ExprDef)` can dispatch by `kind`.
 * `from` recurses into child defs via `registry.parseExpr`; resolution-time
 * scope is supplied later by `resolve` / `validateWalk`, not at parse time.
 */
export interface ExprClass {
  /** The `kind` discriminant this class handles (e.g. `'comparison'`). */
  readonly KIND: ExprKind;
  /**
   * A concise, LLM-facing one-line description of this expression kind (what it
   * is / when to use it) — the canonical terse doc, enumerable from the registry
   * (`registry.exprClassList()`) to build a self-describing expr catalog.
   */
  readonly INSTRUCTIONS: string;
  /** Build an instance from its JSON branch, recursing into child defs via `registry.parseExpr`. */
  from(json: ExprDef, registry: Registry): Expr;
  /** Zod schema for this expr kind's JSON `ExprDef` branch. */
  toSchema(opts: SchemaOptions): z.ZodTypeAny;
}

/**
 * Abstract base for all expression kinds. Concrete subclasses (one per `kind`,
 * under `src/exprs/`) implement resolution, validation, evaluation, cost, SQL
 * emission, and the serialization surface; the base supplies shared traversal,
 * param collection, aggregate/window detection, and Code rendering helpers.
 */
export abstract class Expr implements Node {
  /** The `kind` discriminant (matches the subclass's `static KIND`). */
  abstract readonly kind: ExprKind;

  // ─── Resolution / validation ───────────────────────────────────────────

  /** Infer this expr's `ResolvedType` against `scope` (gin's `typeOf`, richer). */
  abstract resolve(engine: QueryEngine, scope: QueryScope): ResolvedType;

  /**
   * Recursive validation walk — accumulates Problems into `p` and returns
   * the resolved type. Child exprs are validated under `p.at(key, …)` so the
   * accumulated path stays accurate. Use `validate` for the clean entry.
   */
  abstract validateWalk(
    engine: QueryEngine,
    scope: QueryScope,
    p: Problems,
    ctx: ValidateContext,
  ): ResolvedType;

  // ─── Evaluation (in-memory runtime, Phase 3) ─────────────────────────────

  /**
   * Evaluate this expression to a `Value` against the in-memory runtime.
   *  - `ctx`   — the per-run state (data / params / ctes / embedder).
   *  - `row`   — the current evaluation row (source name → record), or `null`
   *              for a constant context with no row.
   *  - `group` — the rows of the current aggregate group (for aggregate /
   *              window functions); defaults to `[row]` when omitted.
   */
  abstract evaluate(
    ctx: RuntimeContext,
    row: SourceRow | null,
    group?: readonly SourceRow[],
  ): Promise<Value>;

  // ─── Cost estimation (Phase 4) ───────────────────────────────────────────

  /**
   * Estimate the cost of evaluating this expression. The `rows` component is
   * a (usually zero) per-row work contribution — non-zero only for exprs that
   * fan out at runtime (a subquery scan) — and `bytes` is the estimated size
   * of the produced value (plus any scan penalty). Query-level row/byte
   * estimation lives on `Query.cost`; this surface lets the planner reach an
   * expr's intrinsic cost (e.g. a correlated subquery's scan, a semantic
   * predicate's penalty).
   */
  abstract cost(engine: QueryEngine, scope: QueryScope): Cost;

  // ─── SQL emission (Phase 5) ──────────────────────────────────────────────

  /**
   * Emit this expression as a `SqlText` fragment for `dialect`, threading the
   * per-emit `ctx` (active scope, the join/CTE planner, RLS provider, bound
   * params). Relation references register the joins they need via
   * `ctx.planner`; literals / params emit bind parameters (never interpolated).
   */
  abstract toSQL(dialect: Dialect, ctx: SqlContext): SqlText;

  /** Sum the costs of this expr's immediate children (a cost building block). */
  protected childCost(engine: QueryEngine, scope: QueryScope): Cost {
    let c: Cost = ZERO_COST;
    this.forEachChild((child) => {
      c = addCost(c, child.cost(engine, scope));
    });
    return c;
  }

  /** Top-level entry: walk collecting Problems (mirrors gin's `Expr.validate`). */
  validate(engine: QueryEngine, scope?: QueryScope): Problems {
    const p = new Problems();
    const s = scope ?? engine.globalScope();
    this.validateWalk(engine, s, p, ROOT_VALIDATE_CONTEXT);
    // After the structural walk, surface accumulated param diagnostics.
    s.params.problems(p);
    return p;
  }

  // ─── Serialization ─────────────────────────────────────────────────────

  /** Serialize back to the JSON `ExprDef` shape (inverse of `from`). */
  abstract toJSON(): ExprDef;

  /** Deep-copy this expr tree. */
  abstract clone(): Expr;

  // ─── Traversal ─────────────────────────────────────────────────────────

  /** Visit immediate child exprs. Default: leaf (no children). */
  forEachChild(_visit: (child: Expr) => void): void {
    /* default: leaf */
  }

  /** Pre-order walk over this expr and all descendants. */
  walk(visit: (expr: Expr) => void): void {
    visit(this);
    this.forEachChild((c) => c.walk(visit));
  }

  /**
   * Whether THIS node is itself an aggregate. Overridden to `true` by
   * `AggregateExpr`. Used by `containsAggregate` without an `instanceof`
   * (which would couple this base module to the concrete subclass).
   */
  protected aggregateHere(): boolean {
    return false;
  }

  /** Whether this expr tree contains an aggregate anywhere. */
  containsAggregate(): boolean {
    let found = false;
    this.walk((e) => {
      if (e.aggregateHere()) found = true;
    });
    return found;
  }

  /**
   * Whether THIS node is itself a window function. Overridden to `true` by
   * `WindowExpr`. Used by `containsWindow` so the SELECT runtime can feed a
   * window its full frame (all sibling rows) instead of just its own row.
   */
  protected windowHere(): boolean {
    return false;
  }

  /** Whether this expr tree contains a window function anywhere. */
  containsWindow(): boolean {
    let found = false;
    this.walk((e) => {
      if (e.windowHere()) found = true;
    });
    return found;
  }

  /**
   * Per-node param contribution. Overridden by `ParamExpr` to `reference`
   * itself into the set. Default: nothing.
   */
  protected contributeParams(_params: ParamSet): void {
    /* default: no params */
  }

  /** Gather every `param` referenced in this tree into `params`. */
  collectParams(params: ParamSet): void {
    this.walk((e) => e.contributeParams(params));
  }

  // ─── Code rendering ─────────────────────────────────────────────────────

  /**
   * Render the JSON form of this expr as a `Code` carrying a span over the
   * whole node at `path`, so `formatProblem` can underline the offending
   * region of the LLM-authored JSON. This base implementation produces ONE
   * coarse span over the node; concrete classes MAY override to thread child
   * paths for finer underlines (gin does this for composite kinds). Because
   * `Code.spanFor` uses longest-prefix matching, a problem at a deeper path
   * still resolves to this node's span when no finer span exists.
   */
  toJSONCode(
    path: ReadonlyArray<string | number> = [],
    indent: number = 2,
    level: number = 0,
  ): Code {
    let text = JSON.stringify(this.toJSON(), null, indent);
    if (level > 0) {
      const lead = ' '.repeat(level * indent);
      text = text.replace(/\n/g, '\n' + lead);
    }
    return span(text, { path, node: this });
  }

  /**
   * Render as a short pseudo-SQL string. Intentionally simple this phase —
   * concrete classes override for readable output; the default falls back to
   * the JSON form. (A full SQL emitter is Phase 5's `toSQL`.)
   */
  /* v8 ignore next 3 -- every concrete Expr subclass overrides toCode; this abstract-base default is unreachable */
  toCode(_registry?: Registry, _options?: CodeOptions): string {
    return JSON.stringify(this.toJSON());
  }
}

/**
 * `BoolExpr` — marker base for predicate expressions (comparison / logical /
 * in / between / is-null / exists / text-search / filters). Every boolean
 * expr resolves to a `bool` `ComputedResolved`, so this base supplies a
 * default `resolve` that gathers nullability / aggregate / source info from
 * its children. Subclasses still implement `validateWalk` (the interesting
 * per-kind type checks) and the serialization surface.
 */
export abstract class BoolExpr extends Expr {
  /**
   * Evaluate this predicate under SQL three-valued logic (3VL): `true` /
   * `false` / `undefined` (UNKNOWN). Implemented by every concrete boolean
   * expr; the inherited `evaluate` wraps the result in a `Value` (UNKNOWN ⇒
   * NULL). Predicates whose result is strictly two-valued (`exists`,
   * `is-null`, `text-search`, …) simply never return `undefined`.
   */
  abstract evaluateBool(
    ctx: RuntimeContext,
    row: SourceRow,
    group?: readonly SourceRow[],
  ): Promise<boolean | undefined>;

  /**
   * Default: wrap `evaluateBool` in a `Value`. A null row evaluates to `false`
   * (the constant context); an UNKNOWN (3VL) result becomes SQL NULL, so a
   * row-filter site reading `Value.toBoolean()` excludes it — matching SQL,
   * where WHERE/HAVING/ON keep a row only when the predicate is TRUE.
   */
  async evaluate(
    ctx: RuntimeContext,
    row: SourceRow | null,
    group?: readonly SourceRow[],
  ): Promise<Value> {
    if (!row) return Value.of(false);
    const t = await this.evaluateBool(ctx, row, group);
    return t === undefined ? Value.null() : Value.of(t);
  }

  /**
   * Default predicate cost: the sum of its operands' costs. A predicate
   * produces a single boolean (no rows of its own), so subclasses only
   * override this when they imply extra work — `text-search` adds a scan
   * penalty, `in` / `exists` add their subquery's scan cost.
   */
  cost(engine: QueryEngine, scope: QueryScope): Cost {
    return this.childCost(engine, scope);
  }

  /**
   * Default boolean resolution: always a `bool` `ComputedResolved`, with
   * nullability / aggregate / source info gathered from this predicate's
   * immediate children.
   */
  resolve(engine: QueryEngine, scope: QueryScope): ComputedResolved {
    const sources: FieldResolved[] = [];
    let nullable = false;
    let aggregate = false;
    this.forEachChild((child) => {
      const rt = child.resolve(engine, scope);
      sources.push(...sourcesOf(rt));
      if (isScalar(rt) && rt.nullable) nullable = true;
      if (rt.kind === 'computed' && rt.aggregate) aggregate = true;
    });
    return {
      kind: 'computed',
      fieldType: new BoolFieldType(),
      sources,
      nullable,
      aggregate,
    };
  }
}

/**
 * `canonicalize(expr)` — a stable, normalized digest of an expression's JSON
 * form: key-sorted so structurally-equal trees (regardless of key order)
 * produce the same string. Shared by `Index.matchesExpr` (this phase), and
 * later by cost estimation (Phase 4) and the SQL planner (Phase 5) to dedupe
 * equivalent expressions.
 *
 * It is defined as `exprDigest(expr.toJSON())` so it is BY CONSTRUCTION
 * identical to the digest `Index` computes from its stored `ExprDef`. That
 * shared normalization is what lets an index built from one expr match a
 * usage expressed as another, equivalent expr.
 */
export function canonicalize(expr: Expr): string {
  return exprDigest(expr.toJSON());
}
