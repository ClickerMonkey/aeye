/**
 * SelectQuery — the SELECT statement and its in-memory execution pipeline,
 * mirroring cletus's `SelectExpr.execute` phases adapted to relation joins:
 *
 *   FROM → JOIN → WHERE → GROUP BY (+ projection) → HAVING → DISTINCT →
 *   ORDER BY → OFFSET/LIMIT
 *
 * Projection happens at the grouping phase so each output row keeps a handle
 * to the originating evaluation row + group, letting ORDER BY / HAVING
 * reference aggregates of the group.
 */
import type {
  JsonValue,
  ParamExprDef,
  QueryDef,
  SelectFieldDef,
  SelectDef,
} from '../schema';
import type { Registry } from '../registry';
import type { QueryEngine } from '../engine';
import type { QueryScope } from '../scope';
import type { Problems } from '../problem';
import type { Expr, ValidateContext } from '../expr';
import type { RuntimeContext } from '../runtime/context';
import type { SourceRecord, SourceRow } from '../runtime/row';
import { Value } from '../runtime/value';
import { recordSignature } from '../runtime/record';
import { Type } from '../type';
import type { ParamSet } from '../param';
import { NumberFieldType } from '../field-types/index';
import { FieldRefExpr, RelationPathExpr, AggregateExpr } from '../exprs/index';
import {
  Query,
  type QueryClass,
  type QueryField,
  type QueryResult,
  makeField,
  makeResult,
} from './query';
import { QuerySource } from './source';
import { QueryJoin } from './join';
import { reportDuplicateSources, type BoundSource } from './_sources';
import { QueryOrder, sortEntries, type OrderEntry } from './order';
import { type Cost, addCost } from '../cost';
import { scanCost, applyWhere, distinctEstimate, fanOutCost, backingCost } from './_cost';
import { canonicalize } from '../expr';
import type { Dialect } from '../sql/dialect';
import { type SqlContext, SqlText } from '../sql/emit';
import { JoinCtePlanner } from '../sql/planner';
import { resolveRelationOnSql } from '../backing';
import { rlsPredicate } from '../sql/rls';
import { boundSQL } from './_sql';

/** A parsed select field: its output expr + optional alias. */
interface SelectField {
  expr: Expr;
  as: string | undefined;
}

/** A projected output row plus the row/group it was computed from. */
interface ProjectedRow {
  record: SourceRecord;
  row: SourceRow;
  group: readonly SourceRow[];
}

/** A `SELECT` statement plus its in-memory execution pipeline (FROM → JOIN → WHERE → GROUP → HAVING → DISTINCT → ORDER → LIMIT). */
export class SelectQuery extends Query {
  /** The Registry dispatch discriminant for this query kind. */
  static readonly KIND = 'select' as const;
  /** This query's `kind` discriminant. */
  readonly kind = SelectQuery.KIND;

  constructor(
    /** Whether duplicate output rows are removed (`SELECT DISTINCT`). */
    readonly distinct: boolean,
    /** The projected output fields (expr + optional alias). */
    readonly fields: SelectField[],
    /** The FROM source. */
    readonly from: QuerySource,
    /** The relation joins, in document order. */
    readonly joins: QueryJoin[],
    /** WHERE predicates (ANDed). */
    readonly where: Expr[],
    /** GROUP BY key expressions. */
    readonly groupBy: Expr[],
    /** HAVING predicates (ANDed), evaluated over each group. */
    readonly having: Expr[],
    /** ORDER BY terms. */
    readonly order: QueryOrder[],
    /** Row cap: a literal count or a bound `param` (`undefined` when unset). */
    readonly limit: number | ParamExprDef | undefined,
    /** Row offset: a literal count or a bound `param` (`undefined` when unset). */
    readonly offset: number | ParamExprDef | undefined,
  ) {
    super();
  }

  /** Parse a `select` `QueryDef` into a `SelectQuery`. */
  static from(json: QueryDef, registry: Registry): SelectQuery {
    if (json.kind !== 'select') throw new Error(`SelectQuery.from: expected 'select', got '${json.kind}'`);
    return new SelectQuery(
      json.distinct ?? false,
      json.fields.map((c) => ({ expr: registry.parseExpr(c.expr), as: c.as })),
      QuerySource.from(json.from, registry),
      (json.joins ?? []).map((j) => QueryJoin.from(j, registry)),
      (json.where ?? []).map((w) => registry.parseExpr(w)),
      (json.groupBy ?? []).map((g) => registry.parseExpr(g)),
      (json.having ?? []).map((h) => registry.parseExpr(h)),
      (json.order ?? []).map((o) => QueryOrder.from(o, registry)),
      json.limit,
      json.offset,
    );
  }

  // ─── Naming / resolution ─────────────────────────────────────────────────

  /** Output field name for field `i` (alias, else a natural name). */
  private fieldName(col: SelectField, i: number): string {
    if (col.as) return col.as;
    const e = col.expr;
    if (e instanceof FieldRefExpr) return e.field;
    /* v8 ignore next -- a relation-path always has at least one segment, so the `?? col` fallback is unreachable */
    if (e instanceof RelationPathExpr) return e.path[e.path.length - 1] ?? `col${i}`;
    if (e instanceof AggregateExpr) return e.fn;
    return `col${i}`;
  }

  /**
   * The enclosing SELECT's output projections keyed by OUTPUT NAME (each field's
   * `as`, else its natural name). This is the map an `output` reference in
   * `groupBy` / `orderBy` / `having` delegates through — bound onto the scope
   * (`bindOutputs`) at validate / SQL time and onto the runtime context
   * (`withOutputs`) at execute time.
   */
  private outputExprs(): Map<string, Expr> {
    const m = new Map<string, Expr>();
    this.fields.forEach((c, i) => m.set(this.fieldName(c, i), c.expr));
    return m;
  }

  /** A child of `inner` exposing this SELECT's outputs to `output` references. */
  private outputScope(inner: QueryScope): QueryScope {
    return inner.child().bindOutputs(this.outputExprs());
  }

  /** Bind FROM + joins into a fresh child scope; also collect alias → Type. */
  private bind(engine: QueryEngine, scope: QueryScope): {
    scope: QueryScope;
    aliasTypes: Map<string, Type>;
  } {
    const child = scope.child();
    this.from.bindInto(engine, child);
    const aliasTypes = new Map<string, Type>();
    aliasTypes.set(this.from.alias, this.from.resolvedType(engine, child).type);
    for (const join of this.joins) {
      const plan = join.buildPlan(engine, aliasTypes);
      if (plan) {
        for (const hop of plan) {
          aliasTypes.set(hop.targetAlias, hop.targetType);
          child.bind(hop.targetAlias, {
            kind: 'type',
            type: hop.targetType,
            source: hop.targetAlias,
            synthetic: false,
          });
        }
      }
    }
    return { scope: child, aliasTypes };
  }

  /** Resolve the output fields by binding FROM + joins and resolving each select expr. */
  outputFields(engine: QueryEngine, scope: QueryScope): QueryField[] {
    const bound = this.bind(engine, scope);
    return this.fields.map((c, i) =>
      makeField(this.fieldName(c, i), c.expr.resolve(engine, bound.scope)),
    );
  }

  // ─── Validation ────────────────────────────────────────────────────────

  /**
   * Every source this query binds, in document order and KEEPING duplicates:
   * the FROM source plus each join hop. Drives `source.duplicate` collision
   * detection. Since Phase B binds each hop under its TARGET TYPE name (via
   * `hop.targetAlias`), two hops landing on the same target type — or a join
   * whose target type equals the FROM type — now collide here and are reported,
   * instructing the author to add a join `as`.
   *
   * The alias→Type map is rebuilt INCREMENTALLY here (rather than reusing the
   * fully-bound map): a self-collision would otherwise overwrite an earlier
   * binding and hide the second hop. Mirroring `bind`'s order means each
   * join's `buildPlan` sees the correct root Type before its own hop overwrites
   * the colliding name.
   */
  private boundSources(engine: QueryEngine, scope: QueryScope): BoundSource[] {
    const aliasTypes = new Map<string, Type>();
    const sources: BoundSource[] = [];
    aliasTypes.set(this.from.alias, this.from.resolvedType(engine, scope).type);
    sources.push({ name: this.from.alias, type: this.from.typeName ?? this.from.alias });
    for (const join of this.joins) {
      const plan = join.buildPlan(engine, aliasTypes);
      if (plan) {
        for (const hop of plan) {
          sources.push({ name: hop.targetAlias, type: hop.targetType.name });
          aliasTypes.set(hop.targetAlias, hop.targetType);
        }
      }
    }
    return sources;
  }

  /** Validate sources (incl. duplicate detection), joins, and every clause's exprs. */
  validateWalk(engine: QueryEngine, scope: QueryScope, p: Problems, _ctx: ValidateContext): void {
    const { scope: inner, aliasTypes } = this.bind(engine, scope);
    reportDuplicateSources(p, this.boundSources(engine, inner));
    p.at('from', () => this.from.validateWalk(engine, inner, p));
    p.at('joins', () => {
      this.joins.forEach((j, i) => {
        const plan = j.buildPlan(engine, aliasTypes);
        if (!plan || plan.length === 0) {
          p.at(i, () => p.error('join.unresolved', `Join '${j.label}' does not resolve to a relation.`));
        }
      });
    });
    const colCtx: ValidateContext = { inAggregate: false, inWindow: false, allowAggregate: true, groupKeys: [], inGroupBy: false };
    const predCtx: ValidateContext = { ...colCtx, allowAggregate: false };
    // GROUP BY keys may not aggregate, and an `output` ref there rejects an
    // aggregate target (`output.aggregate`) — flagged via `inGroupBy`.
    const groupCtx: ValidateContext = { ...predCtx, inGroupBy: true };
    // GROUP BY / HAVING / ORDER BY resolve against a child scope exposing this
    // SELECT's outputs, so an `output` reference can delegate to its target.
    // WHERE / fields do NOT (an `output` ref there ⇒ `output.not-available`).
    const outScope = this.outputScope(inner);
    p.at('fields', () => {
      this.fields.forEach((c, i) => p.at([i, 'expr'], () => c.expr.validateWalk(engine, inner, p, colCtx)));
    });
    p.at('where', () => {
      this.where.forEach((w, i) => p.at(i, () => w.validateWalk(engine, inner, p, predCtx)));
    });
    p.at('groupBy', () => {
      this.groupBy.forEach((g, i) => p.at(i, () => g.validateWalk(engine, outScope, p, groupCtx)));
    });
    p.at('having', () => {
      this.having.forEach((h, i) => p.at(i, () => h.validateWalk(engine, outScope, p, colCtx)));
    });
    p.at('order', () => {
      this.order.forEach((o, i) => p.at([i, 'expr'], () => o.expr.validateWalk(engine, outScope, p, colCtx)));
    });
  }

  /** The Type names read by this select (its FROM source's referenced types). */
  referencedTypes(): readonly string[] {
    const out = new Set<string>(this.from.referencedTypes());
    return [...out];
  }

  /**
   * The sources execution-time `filters` may target: the FROM alias plus each
   * join's (final) alias. These are the aliases a `filters` clause can bind to;
   * a filter ANDs into this select's WHERE against the named alias. (Intermediate
   * aliases of a multi-hop join are not surfaced — only its final target alias.)
   */
  override filterSources(engine: QueryEngine): string[] {
    // Each join's exposed name is its FINAL hop's bound alias (the target type
    // name by default, or the authored `as`). Resolving that requires the
    // alias→Type map, rebuilt incrementally exactly as `bind`/`boundSources` do
    // so each join's `buildPlan` sees the correct root Type.
    const scope = engine.globalScope();
    const aliasTypes = new Map<string, Type>();
    aliasTypes.set(this.from.alias, this.from.resolvedType(engine, scope).type);
    const out: string[] = [this.from.alias];
    for (const join of this.joins) {
      const plan = join.buildPlan(engine, aliasTypes);
      if (!plan || plan.length === 0) continue;
      for (const hop of plan) aliasTypes.set(hop.targetAlias, hop.targetType);
      out.push(plan[plan.length - 1]!.targetAlias);
    }
    return out;
  }

  /**
   * Walk every clause expr — select fields, WHERE, GROUP BY, HAVING, ORDER BY,
   * and each join's `and` predicate — recursing into descendants via `Expr.walk`.
   * Powers `filters()`'s search for `filters` placeholders across the whole query.
   */
  override walkExprs(visit: (e: Expr) => void): void {
    for (const c of this.fields) c.expr.walk(visit);
    for (const w of this.where) w.walk(visit);
    for (const g of this.groupBy) g.walk(visit);
    for (const h of this.having) h.walk(visit);
    for (const o of this.order) o.expr.walk(visit);
    for (const j of this.joins) if (j.and) j.and.walk(visit);
  }

  /** Bind FROM + joins so a `filters` placeholder's `source` resolves for `filters()`. */
  protected override filterScope(engine: QueryEngine, scope: QueryScope): QueryScope {
    return this.bind(engine, scope).scope;
  }

  /**
   * `limit` / `offset` may be bound to a `param` (see `autoPaginate`), but they
   * live outside the walked expr tree, so `params()` never observes them. They
   * are always integer row counts, so observe each against a number field type
   * — making them surface in `params()` with the right inferred type.
   */
  protected override observeBoundParams(params: ParamSet): void {
    const numeric = new NumberFieldType();
    if (this.limit !== undefined && typeof this.limit !== 'number') {
      params.observe(this.limit.name, numeric, ['limit']);
    }
    if (this.offset !== undefined && typeof this.offset !== 'number') {
      params.observe(this.offset.name, numeric, ['offset']);
    }
  }

  // ─── Cost estimation ─────────────────────────────────────────────────────

  /**
   * Estimate result `{ rows, bytes }` the way a SQL engine PROCESSES the query.
   *
   * Structure (documented assumptions — this is an explainable guard-rail, not a
   * real planner):
   *  - BASE SCAN reads `Type.count` rows at the Type's per-row byte size.
   *  - JOINS MULTIPLY: each relation join fans the running row count out by its
   *    relation cardinality (`expansionFactor`: belongs-to / has-one ⇒ ×1,
   *    has-many ⇒ ×N). Chained joins therefore COMPOUND multiplicatively, and
   *    each hop's target adds to the per-row byte width. (INNER vs LEFT is not
   *    distinguished — both are approximated by the fan-out, floored at ×1 so a
   *    LEFT join never drops below the outer row count.)
   *  - WHERE reduces rows via an index-prefix bound or a fixed selectivity.
   *  - GROUP BY / a bare aggregate / DISTINCT reduce OUTPUT rows to the estimated
   *    distinct groups (the upstream scan work is unchanged).
   *  - LIMIT caps OUTPUT rows. ASSUMPTION: a literal LIMIT also caps how many
   *    times a select-position subquery runs (it is evaluated once per RETURNED
   *    row); we do not model an ORDER BY forcing a larger upstream scan.
   *  - PER-OUTER-ROW work: a subquery / EXISTS / IN-subquery in a SELECT item
   *    runs ONCE PER OUTPUT ROW, so its cost is multiplied by the output row
   *    count; the same expr in WHERE / HAVING is treated as uncorrelated and
   *    counted ONCE. Hidden joins a computed field / RLS inject are added via
   *    `backingCost` (a LATERAL multiplies per outer row; a shared relation join
   *    is counted once).
   */
  cost(engine: QueryEngine, scope: QueryScope): Cost {
    const { scope: inner, aliasTypes } = this.bind(engine, scope);
    const fromType = this.from.resolvedType(engine, inner).type;

    // Base scan, then fan out MULTIPLICATIVELY by each relation join's
    // cardinality (compounding down the join chain).
    let rows = fromType.count;
    let perRowBytes = fromType.bytes;
    for (const join of this.joins) {
      rows *= join.expansionFactor(engine, aliasTypes);
      const plan = join.buildPlan(engine, aliasTypes);
      if (plan) for (const hop of plan) perRowBytes += hop.targetType.bytes;
    }

    // WHERE row reduction (index / selectivity) + scan penalties.
    const baseScan = scanCost(fromType);
    baseScan.rows = rows;
    baseScan.bytes = rows * perRowBytes;
    let cost = applyWhere(baseScan, fromType, this.where, perRowBytes);

    // GROUP BY ⇒ distinct(keys); a bare aggregate ⇒ one row; else DISTINCT ⇒ the
    // estimated distinct projection. Each reduces OUTPUT rows, not scan work.
    if (this.groupBy.length) {
      const distinct = distinctEstimate(fromType, this.groupBy, cost.rows);
      cost = { rows: distinct, bytes: distinct * perRowBytes };
    } else if (this.fields.some((c) => c.expr.containsAggregate())) {
      cost = { rows: 1, bytes: perRowBytes };
    } else if (this.distinct) {
      const distinct = distinctEstimate(fromType, this.fields.map((c) => c.expr), cost.rows);
      cost = { rows: distinct, bytes: distinct * perRowBytes };
    }

    // LIMIT caps the OUTPUT rows (only a literal cap is known statically).
    if (typeof this.limit === 'number') {
      const capped = Math.min(cost.rows, this.limit);
      cost = { rows: capped, bytes: capped * perRowBytes };
    }

    // Per-outer-row expr work: a SELECT-position subquery / EXISTS runs once per
    // OUTPUT row; a WHERE / HAVING subquery is uncorrelated and runs once.
    const outputRows = cost.rows;
    for (const c of this.fields) cost = addCost(cost, fanOutCost(c.expr.cost(engine, inner), outputRows));
    for (const w of this.where) cost = addCost(cost, fanOutCost(w.cost(engine, inner), 1));
    for (const h of this.having) cost = addCost(cost, fanOutCost(h.cost(engine, inner), 1));

    // Hidden joins / LATERALs / RLS the planner injects for computed & secured
    // fields (shared joins counted once; a LATERAL multiplies per outer row).
    cost = addCost(cost, backingCost(engine, inner, this.fields.map((c) => c.expr), fromType, outputRows));
    return cost;
  }

  // ─── Execution ─────────────────────────────────────────────────────────

  /** Root Type for join planning (FROM source's type). */
  private rootType(engine: QueryEngine): Type {
    return this.from.resolvedType(engine, engine.globalScope()).type;
  }

  /** Run the in-memory pipeline: FROM → JOIN → WHERE → GROUP BY → HAVING → DISTINCT → ORDER BY → OFFSET/LIMIT. */
  async execute(ctx: RuntimeContext): Promise<QueryResult> {
    const engine = ctx.engine;

    // 1. FROM.
    let rows = await this.from.rows(ctx);
    // Register the FROM alias → its Type so field-refs into it recover field
    // metadata (case-sensitivity) even when the alias ≠ the type name.
    ctx.bindSourceType(this.from.alias, this.rootType(engine));

    // 2. JOINs (relation-key expansion).
    const aliasTypes = new Map<string, Type>();
    aliasTypes.set(this.from.alias, this.rootType(engine));
    for (const join of this.joins) {
      const plan = join.buildPlan(engine, aliasTypes);
      if (plan) {
        for (const hop of plan) {
          aliasTypes.set(hop.targetAlias, hop.targetType);
          // Each hop binds under its target type name (or the join `as`); record
          // that alias → Type so field-refs into the joined source see metadata.
          ctx.bindSourceType(hop.targetAlias, hop.targetType);
        }
      }
      rows = await join.expand(ctx, rows, plan ?? []);
    }

    // 3. WHERE.
    if (this.where.length) {
      const kept: SourceRow[] = [];
      for (const r of rows) {
        if (await this.allTrue(this.where, ctx, r, [r])) kept.push(r);
      }
      rows = kept;
    }

    // The output projections `output` references delegate through — installed
    // on the context for the duration of GROUP BY / HAVING / ORDER BY below.
    const outputs = this.outputExprs();

    // 4. GROUP BY + projection.
    let projected: ProjectedRow[];
    if (this.groupBy.length) {
      const groups = await ctx.withOutputs(outputs, () => this.groupRows(rows, ctx));
      projected = [];
      for (const g of groups) {
        projected.push({ record: await this.project(ctx, g[0]!, g), row: g[0]!, group: g });
      }
    } else if (this.fields.some((c) => c.expr.containsAggregate())) {
      // Bare aggregates collapse all rows into one output row.
      const row = rows[0] ?? null;
      projected = [{ record: await this.project(ctx, row, rows), row: row ?? {}, group: rows }];
    } else if (this.fields.some((c) => c.expr.containsWindow())) {
      // Window functions keep every row, but each row sees the WHOLE frame (all
      // sibling rows) so PARTITION BY / ORDER BY can be computed per-row.
      projected = [];
      for (const r of rows) {
        projected.push({ record: await this.project(ctx, r, rows), row: r, group: rows });
      }
    } else {
      projected = [];
      for (const r of rows) {
        projected.push({ record: await this.project(ctx, r, [r]), row: r, group: [r] });
      }
    }

    // 5. HAVING (over the group rows).
    if (this.having.length) {
      const kept: ProjectedRow[] = [];
      await ctx.withOutputs(outputs, async () => {
        for (const pr of projected) {
          if (await this.allTrue(this.having, ctx, pr.row, pr.group)) kept.push(pr);
        }
      });
      projected = kept;
    }

    // 6. DISTINCT (on the projected record).
    if (this.distinct) {
      const seen = new Set<string>();
      projected = projected.filter((pr) => {
        const key = recordSignature(pr.record);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }

    // 7. ORDER BY.
    let outRows: SourceRecord[];
    if (this.order.length) {
      const entries: OrderEntry<SourceRecord>[] = projected.map((pr) => ({
        item: pr.record,
        row: pr.row,
        group: pr.group,
      }));
      outRows = await ctx.withOutputs(outputs, () => sortEntries(entries, this.order, ctx));
    } else {
      outRows = projected.map((pr) => pr.record);
    }

    // The full result count BEFORE pagination — the row set after every
    // filtering/grouping/having/distinct phase, captured here so a paginated
    // caller can report the pre-limit total (Feature 2). ORDER BY never changes
    // the count, so `outRows.length` at this point is exactly the total.
    const total = outRows.length;

    // 8. OFFSET / LIMIT.
    const offset = this.numericBound(this.offset, ctx);
    const limit = this.numericBound(this.limit, ctx);
    if (offset !== undefined) outRows = outRows.slice(offset);
    if (limit !== undefined) outRows = outRows.slice(0, limit);

    const fields = this.outputFields(engine, engine.globalScope());
    const result = makeResult('select', outRows, fields);
    // `$total` is surfaced as `result.total`, NOT as a declared output field.
    // `includeTotal` is an EXECUTION-time option, read off the RuntimeContext.
    if (ctx.includeTotal) result.total = total;
    return result;
  }

  /** Whether all `preds` evaluate truthy against `row` / `group`. */
  private async allTrue(
    preds: readonly Expr[],
    ctx: RuntimeContext,
    row: SourceRow,
    group: readonly SourceRow[],
  ): Promise<boolean> {
    for (const pred of preds) {
      if (!(await pred.evaluate(ctx, row, group)).toBoolean()) return false;
    }
    return true;
  }

  /** Project the select fields over a row + group into an output record. */
  private async project(
    ctx: RuntimeContext,
    row: SourceRow | null,
    group: readonly SourceRow[],
  ): Promise<SourceRecord> {
    const rec: SourceRecord = {};
    for (let i = 0; i < this.fields.length; i++) {
      const col = this.fields[i]!;
      rec[this.fieldName(col, i)] = (await col.expr.evaluate(ctx, row, group)).raw;
    }
    return rec;
  }

  /** Group rows by the GROUP BY key tuple, preserving first-seen order. */
  private async groupRows(rows: readonly SourceRow[], ctx: RuntimeContext): Promise<SourceRow[][]> {
    const groups = new Map<string, SourceRow[]>();
    const order: string[] = [];
    for (const r of rows) {
      const keyVals: JsonValue[] = [];
      for (const g of this.groupBy) keyVals.push((await g.evaluate(ctx, r)).raw);
      const key = JSON.stringify(keyVals);
      let arr = groups.get(key);
      if (!arr) {
        arr = [];
        groups.set(key, arr);
        order.push(key);
      }
      arr.push(r);
    }
    return order.map((k) => groups.get(k)!);
  }

  /** Resolve a literal / param row bound to a number (undefined when unset). */
  private numericBound(v: number | ParamExprDef | undefined, ctx: RuntimeContext): number | undefined {
    if (v === undefined) return undefined;
    if (typeof v === 'number') return v;
    const n = ctx.param(v.name).toNumber();
    return Number.isNaN(n) ? undefined : n;
  }

  // ─── SQL emission ─────────────────────────────────────────────────────────

  /** Emit the FROM source: `"type" AS "alias"`, `(subquery) AS "alias"`, or a
   *  table-valued `fn(args) AS "alias"` — delegated to the source itself. */
  private fromSQL(dialect: Dialect, ctx: SqlContext): SqlText {
    return this.from.fromSQL(dialect, ctx);
  }

  /** One ORDER BY term: `<expr> ASC|DESC [NULLS FIRST|LAST]`. */
  private orderTermSQL(dialect: Dialect, ctx: SqlContext, o: QueryOrder): SqlText {
    return SqlText.concat([
      o.expr.toSQL(dialect, ctx),
      SqlText.raw(` ${o.dir.toUpperCase()}`),
      o.nulls ? SqlText.raw(` NULLS ${o.nulls.toUpperCase()}`) : SqlText.empty(),
    ]);
  }

  /** Emit the SELECT, re-attaching any planner CTEs as a leading `WITH` when top-level. */
  toSQL(dialect: Dialect, ctx: SqlContext): SqlText {
    const { ctes, body } = this.emitWith(dialect, ctx);
    if (ctes.length === 0) return body;
    return SqlText.concat([SqlText.raw('WITH '), SqlText.join(ctes, ', '), SqlText.raw(' '), body]);
  }

  /**
   * Emit the SELECT BODY (no leading `WITH`) plus the planner-generated CTE
   * definitions separately, so an enclosing `CTEStatementQuery` can hoist them
   * into ONE combined `WITH` (BUG P0-2). `toSQL` re-attaches them as a leading
   * `WITH` when this SELECT is the top-level statement.
   */
  override emitWith(dialect: Dialect, ctx: SqlContext): { ctes: ReadonlyArray<SqlText>; body: SqlText } {
    const engine = ctx.engine;
    const { scope: inner, aliasTypes } = this.bind(engine, ctx.scope);
    const planner = new JoinCtePlanner(dialect, engine, ctx.rls, ctx.params);
    const selCtx = ctx.withPlanner(inner, planner);

    // 1. Register authored joins through the planner FIRST (they lead, and a
    //    relation-path over the same relation then reuses the alias).
    for (const join of this.joins) {
      const plan = join.buildPlan(engine, aliasTypes);
      if (!plan) continue;
      plan.forEach((hop, hi) => {
        const last = hi === plan.length - 1;
        let extraOn: SqlText | undefined;
        let andKey: string | undefined;
        if (last && join.and) {
          extraOn = join.and.toSQL(dialect, selCtx);
          andKey = canonicalize(join.and);
        }
        const customOn = hop.custom
          ? resolveRelationOnSql(hop.custom.on, hop.custom.localAlias, hop.custom.joinedAlias, selCtx)
          : undefined;
        planner.requireJoin({
          leftAlias: hop.leftAlias,
          alias: hop.targetAlias,
          targetType: hop.targetType,
          keys: hop.keys,
          customOn,
          joinType: join.joinType,
          andKey,
          extraOn,
        });
      });
    }

    // 2. Fields (relation-paths / fan-out aggregates register hidden joins/CTEs).
    //    The `$total` column is built LAST (§6) — under DISTINCT it must count
    //    the POST-distinct rows, which needs the assembled FROM / WHERE first.
    const baseColSqls = this.fields.map((c, i) =>
      SqlText.concat([c.expr.toSQL(dialect, selCtx), SqlText.raw(' AS '), dialect.ident(this.fieldName(c, i))]),
    );

    // 3. WHERE: authored predicates + RLS for the FROM type.
    const wherePreds: SqlText[] = this.where.map((w) => w.toSQL(dialect, selCtx));
    if (this.from.sourceKind === 'type' && this.from.typeName !== undefined) {
      const fromRls = rlsPredicate(ctx.rls, dialect, engine, planner, this.from.typeName, this.from.alias);
      if (fromRls) wherePreds.push(fromRls);
    }

    // 4. GROUP BY / HAVING / ORDER BY (may also register joins). These resolve
    //    against a child scope exposing this SELECT's outputs (same planner), so
    //    an `output` reference EXPANDS to its target's SQL.
    const outCtx = selCtx.withScope(this.outputScope(inner));
    const groupSqls = this.groupBy.map((g) => g.toSQL(dialect, outCtx));
    const havingSqls = this.having.map((h) => h.toSQL(dialect, outCtx));
    const orderSqls = this.order.map((o) => this.orderTermSQL(dialect, outCtx, o));

    // 5. FROM + LIMIT/OFFSET.
    const fromSql = this.fromSQL(dialect, selCtx);
    const lo = dialect.limitOffset(boundSQL(this.limit, selCtx), boundSQL(this.offset, selCtx));

    // The core scan (FROM + planned JOINs + WHERE + GROUP BY + HAVING), shared by
    // the body and — under DISTINCT — the `$total` counting subquery.
    const scan: SqlText[] = [SqlText.raw(' FROM '), fromSql];
    for (const j of planner.emittedJoins()) scan.push(SqlText.raw(' '), j);
    if (wherePreds.length) scan.push(SqlText.raw(' WHERE '), SqlText.join(wherePreds, ' AND '));
    if (groupSqls.length) scan.push(SqlText.raw(' GROUP BY '), SqlText.join(groupSqls, ', '));
    if (havingSqls.length) scan.push(SqlText.raw(' HAVING '), SqlText.join(havingSqls, ' AND '));

    // 6. `$total` column (BUG P0-6). `COUNT(*) OVER ()` counts the PRE-DISTINCT
    //    rows, but the runtime reports the POST-DISTINCT total — so under
    //    DISTINCT the total is a scalar subquery over the distinct projection
    //    (`SELECT COUNT(*) FROM (SELECT DISTINCT … <scan>) AS "$dt"`), matching
    //    the runtime. Without DISTINCT the plain window count is the pre-LIMIT
    //    total. `includeTotal` is an EXECUTION-time option, read off the context.
    const colSqls = [...baseColSqls];
    if (ctx.includeTotal) colSqls.push(this.totalColumnSQL(dialect, baseColSqls, scan));

    // 7. Assemble the BODY (planner now holds every CTE + join, in document
    //    order). The planner CTEs are returned SEPARATELY so an enclosing CTE
    //    statement can hoist them into one combined `WITH`.
    const parts: SqlText[] = [SqlText.raw('SELECT ')];
    if (this.distinct) parts.push(SqlText.raw('DISTINCT '));
    parts.push(SqlText.join(colSqls, ', '), SqlText.concat(scan));
    if (orderSqls.length) parts.push(SqlText.raw(' ORDER BY '), SqlText.join(orderSqls, ', '));
    if (!lo.isEmpty()) parts.push(SqlText.raw(' '), lo);
    return { ctes: planner.emittedCtes(), body: SqlText.concat(parts) };
  }

  /**
   * The `$total` projection column. Under DISTINCT a `COUNT(*) OVER ()` would
   * count PRE-distinct rows (the runtime reports POST-distinct), so emit a
   * scalar subquery that counts the distinct projection over the same scan
   * (`(SELECT COUNT(*) FROM (SELECT DISTINCT … <scan>) AS "$dt") AS "$total"`).
   * Without DISTINCT the plain window count is already the pre-LIMIT total.
   */
  private totalColumnSQL(dialect: Dialect, baseColSqls: readonly SqlText[], scan: readonly SqlText[]): SqlText {
    if (!this.distinct) {
      return SqlText.concat([SqlText.raw('COUNT(*) OVER ()'), SqlText.raw(' AS '), dialect.ident('$total')]);
    }
    const distinctProjection = SqlText.concat([
      SqlText.raw('SELECT DISTINCT '),
      SqlText.join(baseColSqls, ', '),
      ...scan,
    ]);
    return SqlText.concat([
      SqlText.raw('(SELECT COUNT(*) FROM '),
      distinctProjection.parens(),
      SqlText.raw(' AS '),
      dialect.ident('$dt'),
      SqlText.raw(') AS '),
      dialect.ident('$total'),
    ]);
  }

  // ─── Serialization ───────────────────────────────────────────────────────

  /** Serialize back to a `SelectDef`, omitting empty / default clauses. */
  toJSON(): SelectDef {
    const def: SelectDef = {
      kind: 'select',
      fields: this.fields.map((c): SelectFieldDef => (c.as ? { expr: c.expr.toJSON(), as: c.as } : { expr: c.expr.toJSON() })),
      from: this.from.toJSON(),
    };
    if (this.distinct) def.distinct = true;
    if (this.joins.length) def.joins = this.joins.map((j) => j.toJSON());
    if (this.where.length) def.where = this.where.map((w) => w.toJSON());
    if (this.groupBy.length) def.groupBy = this.groupBy.map((g) => g.toJSON());
    if (this.having.length) def.having = this.having.map((h) => h.toJSON());
    if (this.order.length) def.order = this.order.map((o) => o.toJSON());
    if (this.limit !== undefined) def.limit = cloneBound(this.limit);
    if (this.offset !== undefined) def.offset = cloneBound(this.offset);
    return def;
  }

  /** Deep-clone this select (cloning every nested source / join / expr / order term). */
  clone(): SelectQuery {
    return new SelectQuery(
      this.distinct,
      this.fields.map((c) => ({ expr: c.expr.clone(), as: c.as })),
      this.from.clone(),
      this.joins.map((j) => j.clone()),
      this.where.map((w) => w.clone()),
      this.groupBy.map((g) => g.clone()),
      this.having.map((h) => h.clone()),
      this.order.map((o) => o.clone()),
      cloneBound(this.limit),
      cloneBound(this.offset),
    );
  }
}

/** Clone a limit/offset bound (number stays, param def is copied). */
function cloneBound(v: number | ParamExprDef | undefined): number | ParamExprDef | undefined {
  if (v === undefined || typeof v === 'number') return v;
  return { ...v };
}

const _check: QueryClass = SelectQuery;
void _check;
