/**
 * UpdateQuery — UPDATE … SET … [JOIN] [WHERE] [RETURNING]. Matching rows in
 * the target Type's transactional `TypeState` are mutated in place; optional
 * relation joins (rooted at the target alias) widen the row so SET / WHERE may
 * read joined fields.
 */
import type { FieldValueDef, QueryDef, SelectFieldDef, UpdateDef } from '../schema';
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
import { updateRecord } from './_type';
import type { Cost } from '../cost';
import { scanCost, applyWhere } from './_cost';
import type { Dialect } from '../sql/dialect';
import { type SqlContext, SqlText } from '../sql/emit';
import { JoinCtePlanner } from '../sql/planner';
import { resolveRelationOnSql } from '../backing';
import { rlsPredicate } from '../sql/rls';
import { dmlJoinsUnsupported, typeReadonly, fieldReadonly } from './_sql';
import {
  conditionClauses,
  conditionFieldRefs,
  activeDefaultConditions,
  defaultConditionPredicatesSql,
  rowPassesDefaultConditions,
  type ActiveDefaultCondition,
  type BoundTypeSource,
} from './_default-conditions';

interface SetClause {
  field: string;
  expr: Expr;
}
interface ReturningField {
  expr: Expr;
  as: string | undefined;
}

/** An `UPDATE … SET [JOIN] [WHERE] [RETURNING]` statement over a target Type's rows. */
export class UpdateQuery extends Query {
  /** The Registry dispatch discriminant for this query kind. */
  static readonly KIND = 'update' as const;
  /** This query's `kind` discriminant. */
  readonly kind = UpdateQuery.KIND;

  constructor(
    /** The target Type name whose rows are updated. */
    readonly type: string,
    /** The SET assignments (field + value expr). */
    readonly set: SetClause[],
    /** Relation joins rooted at the target, widening rows for SET / WHERE. */
    readonly joins: QueryJoin[],
    /** WHERE predicates (ANDed) selecting the rows to update. */
    readonly where: Expr[],
    /** RETURNING projection (expr + optional alias). */
    readonly returning: ReturningField[],
  ) {
    super();
  }

  /** Parse an `update` `QueryDef` into an `UpdateQuery`. */
  static from(json: QueryDef, registry: Registry): UpdateQuery {
    if (json.kind !== 'update') throw new Error(`UpdateQuery.from: expected 'update', got '${json.kind}'`);
    return new UpdateQuery(
      json.type,
      json.set.map((s) => ({ field: s.field, expr: registry.parseExpr(s.value) })),
      (json.joins ?? []).map((j) => QueryJoin.from(j, registry)),
      (json.where ?? []).map((w) => registry.parseExpr(w)),
      (json.returning ?? []).map((c) => ({ expr: registry.parseExpr(c.expr), as: c.as })),
    );
  }

  /** The target is referenced by its TYPE NAME (no aliasing on DML targets). */
  private get alias(): string {
    return this.type;
  }

  private bind(engine: QueryEngine, scope: QueryScope): { scope: QueryScope; aliasTypes: Map<string, Type> } {
    const child = scope.child();
    const aliasTypes = new Map<string, Type>();
    const type = engine.type(this.type);
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
   * Every source this UPDATE binds, in document order and KEEPING duplicates:
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
    const type = engine.type(this.type);
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

  /** Validate the target type, duplicate sources, SET fields/values, WHERE, and RETURNING. */
  validateWalk(engine: QueryEngine, scope: QueryScope, p: Problems, _ctx: ValidateContext): void {
    const type = engine.type(this.type);
    if (!type) {
      p.error('update.unknown-type', `Unknown target type '${this.type}'.${didYouMean(this.type, engine.registry.typeList().map((t) => t.name))}`);
      return;
    }
    // WRITE-MODEL: the Type as a whole must be updatable.
    if (!type.updatable) {
      p.error('update.type-readonly', `Type '${this.type}' is not updatable.`);
      return;
    }
    // A join hop that rebinds the target type name (or two hops on one type)
    // collides with the DML target → reported as `source.duplicate`.
    reportDuplicateSources(p, this.boundSources(engine));
    const { scope: inner } = this.bind(engine, scope);
    const ctx: ValidateContext = { inAggregate: false, inWindow: false, allowAggregate: false, groupKeys: [], inGroupBy: false };
    p.at('set', () => {
      this.set.forEach((s, i) => {
        const field = type.field(s.field);
        if (!field) {
          p.at([i, 'field'], () => p.error('update.unknown-field', `Type '${this.type}' has no field '${s.field}'.${didYouMean(s.field, type.fields.map((f) => f.name))}`));
        } else if (!field.updatableFor(engine.fieldBacking(this.type, s.field))) {
          // WRITE-MODEL: a non-updatable (read-only / computed) field can't be assigned.
          p.at([i, 'field'], () => p.error('update.field-readonly', `Field '${s.field}' of '${this.type}' is not updatable.`));
        }
        p.at([i, 'value'], () => s.expr.validateWalk(engine, inner, p, ctx));
      });
    });
    p.at('where', () => this.where.forEach((w, i) => p.at(i, () => {
      const rt = w.validateWalk(engine, inner, p, ctx);
      checkBoolCondition(w, rt, p);
    })));
    const colCtx: ValidateContext = { ...ctx, allowAggregate: true };
    p.at('returning', () => this.returning.forEach((c, i) => p.at([i, 'expr'], () => c.expr.validateWalk(engine, inner, p, colCtx))));
  }

  /** The single target Type name this update writes. */
  referencedTypes(): readonly string[] {
    return [this.type];
  }

  /** Estimate `{ rows, bytes }`: the target scan × join fan-out, reduced by WHERE. */
  cost(engine: QueryEngine, scope: QueryScope): Cost {
    const type = engine.type(this.type);
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

  /** Expand joins, filter by WHERE, apply SET to each matched target row, then project RETURNING. */
  async execute(ctx: RuntimeContext): Promise<QueryResult> {
    const engine = ctx.engine;
    const type = engine.type(this.type);
    const fields = this.outputFields(engine, engine.globalScope());
    if (!type) return makeResult('update', [], fields, 0);
    // WRITE-MODEL (belt-and-suspenders): never write a read-only Type / field.
    if (!type.updatable) throw typeReadonly('update', this.type);
    for (const s of this.set) {
      const field = type.field(s.field);
      if (field && !field.updatableFor(engine.fieldBacking(this.type, s.field))) {
        throw fieldReadonly('update', this.type, s.field);
      }
    }
    const state = await ctx.typeState(type);

    // Build rows {alias: record} over the current rows, then apply joins.
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

    // Default conditions (soft scope) scope which rows are updated, per `ops`.
    const defaults = this.activeDefaults(engine, aliasTypes);

    // Filter by WHERE, then apply SET to each matched target record.
    const updated: SourceRecord[] = [];
    const seen = new Set<SourceRecord>();
    for (const row of rows) {
      if (defaults.length && !(await rowPassesDefaultConditions(defaults, row, ctx))) continue;
      if (this.where.length && !(await this.allTrue(ctx, row))) continue;
      const target = row[this.alias];
      if (!target || seen.has(target)) continue;
      seen.add(target);
      const fields: SourceRecord = {};
      for (const s of this.set) fields[s.field] = (await s.expr.evaluate(ctx, row)).raw;
      updateRecord(state, target, fields);
      updated.push(target);
    }

    const outRows = await this.projectReturning(ctx, updated);
    return makeResult('update', outRows, fields, updated.length);
  }

  private async allTrue(ctx: RuntimeContext, row: SourceRow): Promise<boolean> {
    for (const w of this.where) if (!(await w.evaluate(ctx, row)).toBoolean()) return false;
    return true;
  }

  /**
   * The default conditions ACTIVE for the UPDATE op across every bound source
   * (the target + join hop aliases), each decided from the CONDITION-clause
   * references (this UPDATE's WHERE + each join's `and`) on ITS alias.
   */
  private activeDefaults(
    engine: QueryEngine,
    aliasTypes: ReadonlyMap<string, Type>,
  ): ActiveDefaultCondition[] {
    const clauses = conditionClauses(this.where, [], this.joins);
    const sources: BoundTypeSource[] = [...aliasTypes].map(([alias, t]) => ({ alias, typeName: t.name }));
    return activeDefaultConditions(engine, sources, conditionFieldRefs(clauses), 'update');
  }

  private async projectReturning(ctx: RuntimeContext, recs: readonly SourceRecord[]): Promise<SourceRecord[]> {
    if (this.returning.length === 0) return [];
    const out: SourceRecord[] = [];
    for (const rec of recs) {
      const row: SourceRecord = {};
      for (let i = 0; i < this.returning.length; i++) {
        const c = this.returning[i]!;
        row[fieldNameOf(c.expr, c.as, i)] = (await c.expr.evaluate(ctx, { [this.alias]: rec })).raw;
      }
      out.push(row);
    }
    return out;
  }

  /**
   * Emit `[WITH …] UPDATE "t" SET … [FROM <sources>] WHERE … [RETURNING …]`.
   *
   * Mirrors `SelectQuery.toSQL`: authored joins are registered FIRST, then SET /
   * WHERE / RETURNING are emitted through the SAME planner so a `relation-path`
   * or fan-out aggregate over the target shares those joins / CTEs. Because the
   * UPDATE target is NOT a FROM item, the planner runs in IMPLICIT-JOIN mode —
   * each required join lowers to a `FROM` source item plus a key predicate ANDed
   * into WHERE — and any planner CTE is hoisted into a leading `WITH`. A dialect
   * that cannot express `UPDATE … FROM` raises a clear `QueryTypeError`.
   */
  toSQL(dialect: Dialect, ctx: SqlContext): SqlText {
    const engine = ctx.engine;
    const { scope: inner, aliasTypes } = this.bind(engine, ctx.scope);
    const planner = new JoinCtePlanner(dialect, engine, ctx.rls, ctx.params, true);
    const selCtx = ctx.withPlanner(inner, planner);

    // 1. Register authored joins (lowered to FROM items + key predicates).
    this.registerJoins(dialect, engine, selCtx, planner, aliasTypes);

    // 2. SET / WHERE / RETURNING — may register hidden relation joins / CTEs.
    const sets = this.set.map((s) =>
      SqlText.concat([dialect.ident(s.field), SqlText.raw(' = '), s.expr.toSQL(dialect, selCtx)]),
    );
    const wherePreds: SqlText[] = this.where.map((w) => w.toSQL(dialect, selCtx));
    const rls = rlsPredicate(ctx.rls, dialect, engine, planner, this.type, this.alias);
    if (rls) wherePreds.push(rls);
    // Default conditions (soft scope) scope which rows are updated, per `ops`.
    wherePreds.push(...defaultConditionPredicatesSql(this.activeDefaults(engine, aliasTypes), selCtx));
    const returningCols = this.returning.map((c, i) =>
      SqlText.concat([c.expr.toSQL(dialect, selCtx), SqlText.raw(' AS '), dialect.ident(fieldNameOf(c.expr, c.as, i))]),
    );

    // 3. Assemble (planner now holds every FROM item / key predicate / CTE).
    const parts: SqlText[] = [];
    if (planner.hasCtes()) {
      parts.push(SqlText.raw('WITH '), SqlText.join(planner.emittedCtes(), ', '), SqlText.raw(' '));
    }
    parts.push(SqlText.raw('UPDATE '), dialect.ident(this.type), SqlText.raw(' SET '), SqlText.join(sets, ', '));
    if (planner.hasFromItems()) {
      if (!dialect.supportsDmlJoins) throw dmlJoinsUnsupported(dialect, 'UPDATE');
      parts.push(SqlText.raw(' FROM '), SqlText.join(planner.emittedFromItems(), ', '));
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

  /** Serialize back to an `UpdateDef`, omitting empty optional clauses. */
  toJSON(): UpdateDef {
    const def: UpdateDef = {
      kind: 'update',
      type: this.type,
      set: this.set.map((s): FieldValueDef => ({ field: s.field, value: s.expr.toJSON() })),
    };
    if (this.joins.length) def.joins = this.joins.map((j) => j.toJSON());
    if (this.where.length) def.where = this.where.map((w) => w.toJSON());
    if (this.returning.length) {
      def.returning = this.returning.map((c): SelectFieldDef => (c.as ? { expr: c.expr.toJSON(), as: c.as } : { expr: c.expr.toJSON() }));
    }
    return def;
  }

  /** Deep-clone this update (cloning SET / join / WHERE / RETURNING exprs). */
  clone(): UpdateQuery {
    return new UpdateQuery(
      this.type,
      this.set.map((s) => ({ field: s.field, expr: s.expr.clone() })),
      this.joins.map((j) => j.clone()),
      this.where.map((w) => w.clone()),
      this.returning.map((c) => ({ expr: c.expr.clone(), as: c.as })),
    );
  }
}

const _check: QueryClass = UpdateQuery;
void _check;
