/**
 * DeleteQuery — DELETE FROM … [JOIN] [WHERE] [RETURNING]. Matched rows are
 * removed from the target Type's transactional `TypeState`; RETURNING is
 * evaluated BEFORE the delete so it can read the about-to-be-removed rows.
 */
import type { QueryDef, SelectFieldDef, DeleteDef } from '../schema';
import type { Registry } from '../registry';
import type { QueryEngine } from '../engine';
import type { QueryScope } from '../scope';
import type { Problems } from '../problem';
import { canonicalize, type Expr, type ValidateContext } from '../expr';
import type { RuntimeContext } from '../runtime/context';
import type { SourceRecord, SourceRow } from '../runtime/row';
import { Type } from '../type';
import { didYouMean } from '../aids';
import {
  Query,
  type QueryClass,
  type QueryField,
  type QueryResult,
  fieldNameOf,
  makeField,
  makeResult,
} from './query';
import { QueryJoin } from './join';
import { checkBoolCondition } from './_condition';
import { reportDuplicateSources, type BoundSource } from './_sources';
import { deleteRecord } from './_type';
import type { Cost } from '../cost';
import { scanCost, applyWhere } from './_cost';
import type { Dialect } from '../sql/dialect';
import { type SqlContext, SqlText } from '../sql/emit';
import { JoinCtePlanner } from '../sql/planner';
import { resolveRelationOnSql } from '../backing';
import { rlsPredicate } from '../sql/rls';
import { dmlJoinsUnsupported, typeReadonly } from './_sql';
import {
  conditionClauses,
  conditionFieldRefs,
  activeDefaultConditions,
  defaultConditionPredicatesSql,
  rowPassesDefaultConditions,
  type ActiveDefaultCondition,
  type BoundTypeSource,
} from './_default-conditions';

interface ReturningField {
  expr: Expr;
  as: string | undefined;
}

/** A `DELETE FROM … [JOIN] [WHERE] [RETURNING]` statement over a target Type's rows. */
export class DeleteQuery extends Query {
  /** The Registry dispatch discriminant for this query kind. */
  static readonly KIND = 'delete' as const;
  /** This query's `kind` discriminant. */
  readonly kind = DeleteQuery.KIND;

  constructor(
    /** The target Type name rows are deleted from. */
    readonly from: string,
    /** Relation joins rooted at the target, widening rows for WHERE. */
    readonly joins: QueryJoin[],
    /** WHERE predicates (ANDed) selecting the rows to delete. */
    readonly where: Expr[],
    /** RETURNING projection (expr + optional alias), evaluated before removal. */
    readonly returning: ReturningField[],
  ) {
    super();
  }

  /** Parse a `delete` `QueryDef` into a `DeleteQuery`. */
  static from(json: QueryDef, registry: Registry): DeleteQuery {
    if (json.kind !== 'delete') throw new Error(`DeleteQuery.from: expected 'delete', got '${json.kind}'`);
    return new DeleteQuery(
      json.from,
      (json.joins ?? []).map((j) => QueryJoin.from(j, registry)),
      (json.where ?? []).map((w) => registry.parseExpr(w)),
      (json.returning ?? []).map((c) => ({ expr: registry.parseExpr(c.expr), as: c.as })),
    );
  }

  /** The target is referenced by its TYPE NAME (no aliasing on DML targets). */
  private get alias(): string {
    return this.from;
  }

  private bind(engine: QueryEngine, scope: QueryScope): { scope: QueryScope; aliasTypes: Map<string, Type> } {
    const child = scope.child();
    const aliasTypes = new Map<string, Type>();
    const type = engine.type(this.from);
    if (type) {
      child.bind(this.alias, { kind: 'type', type, source: this.alias, synthetic: false });
      aliasTypes.set(this.alias, type);
    }
    for (const join of this.joins) {
      const plan = join.buildPlan(engine, aliasTypes);
      if (plan) {
        for (const hop of plan) {
          aliasTypes.set(hop.targetAlias, hop.targetType);
          child.bind(hop.targetAlias, { kind: 'type', type: hop.targetType, source: hop.targetAlias, synthetic: false });
        }
      }
    }
    return { scope: child, aliasTypes };
  }

  /** Resolve the output fields from the RETURNING projection against the bound (target + joins) scope. */
  outputFields(engine: QueryEngine, scope: QueryScope): QueryField[] {
    const { scope: inner } = this.bind(engine, scope);
    return this.returning.map((c, i) => makeField(fieldNameOf(c.expr, c.as, i), c.expr.resolve(engine, inner)));
  }

  /**
   * Every source this DELETE binds, in document order and KEEPING duplicates:
   * the target Type (referenced by its TYPE NAME) plus each join hop (bound under
   * its target type name unless aliased). Drives `source.duplicate` collision
   * detection — a join hop landing back on the target type, or two hops on one
   * target type, collide here, telling the author to add a join `as`.
   *
   * The alias→Type map is rebuilt INCREMENTALLY (mirroring `bind`'s order) so a
   * self-collision does not overwrite an earlier binding and hide the later hop.
   */
  private boundSources(engine: QueryEngine): BoundSource[] {
    const sources: BoundSource[] = [];
    const type = engine.type(this.from);
    /* v8 ignore next -- boundSources runs only after validateWalk's unknown-type guard, so `type` is always present */
    if (!type) return sources;
    const aliasTypes = new Map<string, Type>([[this.alias, type]]);
    sources.push({ name: this.alias, type: type.name });
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

  /** Validate the target type, duplicate sources, WHERE, and RETURNING. */
  validateWalk(engine: QueryEngine, scope: QueryScope, p: Problems, _ctx: ValidateContext): void {
    const type = engine.type(this.from);
    if (!type) {
      p.error('delete.unknown-type', `Unknown target type '${this.from}'.${didYouMean(this.from, engine.registry.typeList().map((t) => t.name))}`);
      return;
    }
    // WRITE-MODEL: the Type as a whole must be deletable.
    if (!type.deletable) {
      p.error('delete.type-readonly', `Type '${this.from}' is not deletable.`);
      return;
    }
    // A join hop that rebinds the target type name (or two hops on one type)
    // collides with the DML target → reported as `source.duplicate`.
    reportDuplicateSources(p, this.boundSources(engine));
    const { scope: inner } = this.bind(engine, scope);
    const ctx: ValidateContext = { inAggregate: false, inWindow: false, allowAggregate: false, groupKeys: [], inGroupBy: false };
    p.at('where', () => this.where.forEach((w, i) => p.at(i, () => {
      const rt = w.validateWalk(engine, inner, p, ctx);
      checkBoolCondition(w, rt, p);
    })));
    const colCtx: ValidateContext = { ...ctx, allowAggregate: true };
    p.at('returning', () => this.returning.forEach((c, i) => p.at([i, 'expr'], () => c.expr.validateWalk(engine, inner, p, colCtx))));
  }

  /** The single target Type name this delete writes. */
  referencedTypes(): readonly string[] {
    return [this.from];
  }

  /** Estimate `{ rows, bytes }`: the target scan × join fan-out, reduced by WHERE. */
  cost(engine: QueryEngine, scope: QueryScope): Cost {
    const type = engine.type(this.from);
    if (!type) return { rows: 0, bytes: 0 };
    const { aliasTypes } = this.bind(engine, scope);
    let rows = type.count;
    let perRowBytes = type.bytes;
    for (const join of this.joins) {
      rows *= join.expansionFactor(engine, aliasTypes);
      const plan = join.buildPlan(engine, aliasTypes);
      if (plan) for (const hop of plan) perRowBytes += hop.targetType.bytes;
    }
    const baseScan = scanCost(type);
    baseScan.rows = rows;
    baseScan.bytes = rows * perRowBytes;
    return applyWhere(baseScan, type, this.where, perRowBytes);
  }

  /** Expand joins, filter by WHERE, project RETURNING (pre-removal), then delete the matched rows. */
  async execute(ctx: RuntimeContext): Promise<QueryResult> {
    const engine = ctx.engine;
    const type = engine.type(this.from);
    const fields = this.outputFields(engine, engine.globalScope());
    if (!type) return makeResult('delete', [], fields, 0);
    // WRITE-MODEL (belt-and-suspenders): never delete from a non-deletable Type.
    if (!type.deletable) throw typeReadonly('delete', this.from);
    const state = await ctx.typeState(type);

    let rows: SourceRow[] = state.current.map((rec) => ({ [this.alias]: rec }));
    // Register the target alias → its Type so field-refs recover metadata.
    ctx.bindSourceType(this.alias, type);
    const aliasTypes = new Map<string, Type>([[this.alias, type]]);
    for (const join of this.joins) {
      const plan = join.buildPlan(engine, aliasTypes);
      if (plan) {
        for (const hop of plan) {
          aliasTypes.set(hop.targetAlias, hop.targetType);
          ctx.bindSourceType(hop.targetAlias, hop.targetType);
        }
      }
      rows = await join.expand(ctx, rows, plan ?? []);
    }

    // Default conditions (soft scope) scope which rows are deleted, per `ops`.
    const defaults = this.activeDefaults(engine, aliasTypes);

    const targets: SourceRecord[] = [];
    const matchedRows: SourceRow[] = [];
    const seen = new Set<SourceRecord>();
    for (const row of rows) {
      if (defaults.length && !(await rowPassesDefaultConditions(defaults, row, ctx))) continue;
      if (this.where.length && !(await this.allTrue(ctx, row))) continue;
      const target = row[this.alias];
      if (!target || seen.has(target)) continue;
      seen.add(target);
      targets.push(target);
      matchedRows.push(row);
    }

    // RETURNING is evaluated before removal.
    const outRows = await this.projectReturning(ctx, matchedRows);
    for (const target of targets) deleteRecord(state, target);
    return makeResult('delete', outRows, fields, targets.length);
  }

  private async allTrue(ctx: RuntimeContext, row: SourceRow): Promise<boolean> {
    for (const w of this.where) if (!(await w.evaluate(ctx, row)).toBoolean()) return false;
    return true;
  }

  /**
   * The default conditions ACTIVE for the DELETE op across every bound source
   * (the target + join hop aliases), each decided from the CONDITION-clause
   * references (this DELETE's WHERE + each join's `and`) on ITS alias.
   */
  private activeDefaults(
    engine: QueryEngine,
    aliasTypes: ReadonlyMap<string, Type>,
  ): ActiveDefaultCondition[] {
    const clauses = conditionClauses(this.where, [], this.joins);
    const sources: BoundTypeSource[] = [...aliasTypes].map(([alias, t]) => ({ alias, typeName: t.name }));
    return activeDefaultConditions(engine, sources, conditionFieldRefs(clauses), 'delete');
  }

  private async projectReturning(ctx: RuntimeContext, rows: readonly SourceRow[]): Promise<SourceRecord[]> {
    if (this.returning.length === 0) return [];
    const out: SourceRecord[] = [];
    for (const row of rows) {
      const rec: SourceRecord = {};
      for (let i = 0; i < this.returning.length; i++) {
        const c = this.returning[i]!;
        rec[fieldNameOf(c.expr, c.as, i)] = (await c.expr.evaluate(ctx, row)).raw;
      }
      out.push(rec);
    }
    return out;
  }

  /**
   * Emit `[WITH …] DELETE FROM "t" [USING <sources>] WHERE … [RETURNING …]`.
   *
   * Mirrors `SelectQuery.toSQL`: authored joins are registered FIRST, then WHERE
   * / RETURNING are emitted through the SAME planner so a `relation-path` or
   * fan-out aggregate over the target shares those joins / CTEs. Because the
   * DELETE target is NOT a USING item, the planner runs in IMPLICIT-JOIN mode —
   * each required join lowers to a `USING` source item plus a key predicate
   * ANDed into WHERE — and any planner CTE is hoisted into a leading `WITH`. A
   * dialect that cannot express `DELETE … USING` raises a clear `QueryTypeError`.
   */
  toSQL(dialect: Dialect, ctx: SqlContext): SqlText {
    const engine = ctx.engine;
    const { scope: inner, aliasTypes } = this.bind(engine, ctx.scope);
    const planner = new JoinCtePlanner(dialect, engine, ctx.rls, ctx.params, true);
    const selCtx = ctx.withPlanner(inner, planner);

    // 1. Register authored joins (lowered to USING items + key predicates).
    this.registerJoins(dialect, engine, selCtx, planner, aliasTypes);

    // 2. WHERE / RETURNING — may register hidden relation joins / CTEs.
    const wherePreds: SqlText[] = this.where.map((w) => w.toSQL(dialect, selCtx));
    const rls = rlsPredicate(ctx.rls, dialect, engine, planner, this.from, this.alias);
    if (rls) wherePreds.push(rls);
    // Default conditions (soft scope) scope which rows are deleted, per `ops`.
    wherePreds.push(...defaultConditionPredicatesSql(this.activeDefaults(engine, aliasTypes), selCtx));
    const returningCols = this.returning.map((c, i) =>
      SqlText.concat([c.expr.toSQL(dialect, selCtx), SqlText.raw(' AS '), dialect.ident(fieldNameOf(c.expr, c.as, i))]),
    );

    // 3. Assemble (planner now holds every USING item / key predicate / CTE).
    const parts: SqlText[] = [];
    if (planner.hasCtes()) {
      parts.push(SqlText.raw('WITH '), SqlText.join(planner.emittedCtes(), ', '), SqlText.raw(' '));
    }
    parts.push(SqlText.raw('DELETE FROM '), dialect.ident(this.from));
    if (planner.hasFromItems()) {
      if (!dialect.supportsDmlJoins) throw dmlJoinsUnsupported(dialect, 'DELETE');
      parts.push(SqlText.raw(' USING '), SqlText.join(planner.emittedFromItems(), ', '));
    }
    const allWhere = [...planner.emittedJoinPredicates(), ...wherePreds];
    if (allWhere.length) parts.push(SqlText.raw(' WHERE '), SqlText.join(allWhere, ' AND '));
    if (returningCols.length) parts.push(SqlText.raw(' RETURNING '), SqlText.join(returningCols, ', '));
    return SqlText.concat(parts);
  }

  /** Register each authored join hop through the (implicit) planner. */
  private registerJoins(
    dialect: Dialect,
    engine: QueryEngine,
    selCtx: SqlContext,
    planner: JoinCtePlanner,
    aliasTypes: Map<string, Type>,
  ): void {
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
  }

  /** Serialize back to a `DeleteDef`, omitting empty optional clauses. */
  toJSON(): DeleteDef {
    const def: DeleteDef = { kind: 'delete', from: this.from };
    if (this.joins.length) def.joins = this.joins.map((j) => j.toJSON());
    if (this.where.length) def.where = this.where.map((w) => w.toJSON());
    if (this.returning.length) {
      def.returning = this.returning.map((c): SelectFieldDef => (c.as ? { expr: c.expr.toJSON(), as: c.as } : { expr: c.expr.toJSON() }));
    }
    return def;
  }

  /** Deep-clone this delete (cloning join / WHERE / RETURNING exprs). */
  clone(): DeleteQuery {
    return new DeleteQuery(
      this.from,
      this.joins.map((j) => j.clone()),
      this.where.map((w) => w.clone()),
      this.returning.map((c) => ({ expr: c.expr.clone(), as: c.as })),
    );
  }
}

const _check: QueryClass = DeleteQuery;
void _check;
