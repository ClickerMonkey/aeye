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
  OrderDef,
  SorterDef,
  SortSelectionDef,
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
import { FieldRefExpr, AggregateExpr, OutputRefExpr, WindowExpr, SorterExpr } from '../exprs/index';
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
import { QueryOrder, sortEntries, sortByKeys, type OrderEntry } from './order';
import { obj, lit, bool, list, exprRef, sourceRef, isRecord, type Shape } from '../shape';
import { selectFieldShape, boundShape } from './_shape';
import { type Cost, type CostContext, addCost, bytesOfResolved } from '../cost';
import { scanCost, applyWhere, distinctEstimate, fanOutCost, backingCost, coveredScanBytes, type SourceBinding } from './_cost';
import { identityValueCtx } from '../exprs/_field-guard';
import { relationKeySqls } from '../exprs/_relation-value';
import type { Dialect } from '../sql/dialect';
import { type SqlContext, SqlText } from '../sql/emit';
import { JoinCtePlanner } from '../sql/planner';
import {
  resolveDefaultOrderSql,
  resolveDefaultOrderRun,
  type DefaultOrder,
} from '../backing';
import { rlsPredicate } from '../sql/rls';
import { boundSQL } from './_sql';
import { checkBoolCondition } from './_condition';
import {
  conditionClauses,
  conditionFieldRefs,
  activeDefaultConditions,
  defaultConditionPredicatesSql,
  rowPassesDefaultConditions,
  type ActiveDefaultCondition,
  type BoundTypeSource,
} from './_default-conditions';

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

/**
 * One `order` entry: EITHER a concrete ORDER BY term (`QueryOrder`) OR a dynamic
 * `sorter` placeholder that EXPANDS into concrete terms against the execution-time
 * sort spec (see {@link SorterExpr}).
 */
export type OrderItem = QueryOrder | SorterExpr;

/**
 * Structural shape for one `order` entry — a `sorter` (discriminated by its
 * `kind`) or a normal `{ expr, dir, nulls? }` term. Dispatches to the owning
 * class's `SHAPE`; never throws (accumulates), mirroring the other combinators.
 */
const orderItemShape: Shape<OrderItem> = {
  check(json, ctx) {
    return isRecord(json) && json['kind'] === 'sorter'
      ? SorterExpr.SHAPE.check(json, ctx)
      : QueryOrder.SHAPE.check(json, ctx);
  },
};

/** Parse one authored `order` entry into its `OrderItem` (sorter, else a term). */
function parseOrderItem(def: OrderDef | SorterDef, registry: Registry): OrderItem {
  // Only a `SorterDef` carries a `kind` discriminant; a plain term never does.
  return 'kind' in def ? SorterExpr.from(def, registry) : QueryOrder.from(def, registry);
}

/** A `SELECT` statement plus its in-memory execution pipeline (FROM → JOIN → WHERE → GROUP → HAVING → DISTINCT → ORDER → LIMIT). */
export class SelectQuery extends Query {
  /** The Registry dispatch discriminant for this query kind. */
  static readonly KIND = 'select' as const;
  /** Concise LLM-facing summary of this query kind (see `QueryClass.INSTRUCTIONS`). */
  static readonly INSTRUCTIONS = "A SELECT: `fields` (each `{expr, as?}`), `from` a source, optional `joins` / `where` / `groupBy` / `having` / `order` / `limit` / `offset`. Reference a source BY ITS TYPE NAME (`from:{kind:'type', type:'user'}`, then `field-ref.source:'user'`)." as const;
  /**
   * Worked examples (see `QueryClass.EXAMPLES`) — a filtered + ordered + limited
   * projection, and a single-relation JOIN with an execution-time `filters`
   * placeholder (the join crosses ONE relation field; joined rows bind under the
   * target Type name).
   */
  static readonly EXAMPLES: readonly string[] = [
    JSON.stringify({
      kind: 'select',
      fields: [{ expr: { kind: 'field-ref', source: 'user', field: 'name' } }],
      from: { kind: 'type', type: 'user' },
      where: [
        {
          kind: 'comparison',
          op: '>',
          left: { kind: 'field-ref', source: 'user', field: 'age' },
          right: { kind: 'literal', value: 30 },
        },
      ],
      order: [{ expr: { kind: 'field-ref', source: 'user', field: 'age' }, dir: 'desc' }],
      limit: 10,
    } satisfies SelectDef),
    JSON.stringify({
      kind: 'select',
      fields: [
        { expr: { kind: 'field-ref', source: 'user', field: 'name' } },
        { expr: { kind: 'field-ref', source: 'order', field: 'total' } },
      ],
      from: { kind: 'type', type: 'user' },
      joins: [{ on: { kind: 'relation', source: 'user', field: 'orders', as: 'order' } }],
      where: [{ kind: 'filters', source: 'order', fields: ['total'] }],
    } satisfies SelectDef),
    // A DYNAMIC-SORT catalog: the `order` holds ONE `sorter` declaring the named,
    // caller-selectable sorts (`name`, `age`) plus a `defaultSort`. The end-user's
    // live re-sort is passed at EXECUTION time (`run(query, { sort:[{sort:'age',
    // dir:'desc'}] })`), never authored here; with no selection the default applies.
    JSON.stringify({
      kind: 'select',
      fields: [
        { expr: { kind: 'field-ref', source: 'user', field: 'name' } },
        { expr: { kind: 'field-ref', source: 'user', field: 'age' } },
      ],
      from: { kind: 'type', type: 'user' },
      order: [
        {
          kind: 'sorter',
          sorts: {
            name: { kind: 'field-ref', source: 'user', field: 'name' },
            age: { kind: 'field-ref', source: 'user', field: 'age' },
          },
          defaultSort: [{ sort: 'name', dir: 'asc' }],
        },
      ],
    } satisfies SelectDef),
    // The BIGGEST order per customer — CORRELATE a subquery to the outer row by
    // JOINING the relation and comparing the JOINED KEY, never a relation
    // field-ref to an id. The outer query joins `salesOrder.customer` as `c`; a
    // scalar subquery re-scans `salesOrder` (aliased `o2`), joins ITS customer as
    // `c2`, and correlates `c2.id = c.id` (the OUTER join alias) to get that
    // customer's max total.
    JSON.stringify({
      kind: 'select',
      fields: [{ expr: { kind: 'field-ref', source: 'salesOrder', field: 'id' } }],
      from: { kind: 'type', type: 'salesOrder' },
      joins: [{ on: { kind: 'relation', source: 'salesOrder', field: 'customer', as: 'c' } }],
      where: [
        {
          kind: 'comparison',
          op: '=',
          left: { kind: 'field-ref', source: 'salesOrder', field: 'total' },
          right: {
            kind: 'subquery',
            query: {
              kind: 'select',
              fields: [
                {
                  expr: {
                    kind: 'aggregate',
                    function: 'max',
                    args: { value: { kind: 'field-ref', source: 'o2', field: 'total' } },
                  },
                },
              ],
              from: { kind: 'aliased', type: 'salesOrder', as: 'o2' },
              joins: [{ on: { kind: 'relation', source: 'o2', field: 'customer', as: 'c2' } }],
              where: [
                {
                  kind: 'comparison',
                  op: '=',
                  left: { kind: 'field-ref', source: 'c2', field: 'id' },
                  right: { kind: 'field-ref', source: 'c', field: 'id' },
                },
              ],
            },
          },
        },
      ],
    } satisfies SelectDef),
  ];
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
    /** ORDER BY entries — concrete terms and/or dynamic `sorter` placeholders. */
    readonly order: OrderItem[],
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
      (json.order ?? []).map((o) => parseOrderItem(o, registry)),
      json.limit,
      json.offset,
    );
  }

  /**
   * Owned structural {@link Shape} — the zod-free parallel parser. Builds a
   * `SelectQuery` equal to `from`'s output on a valid def; on a bad def it
   * accumulates every clause's problems in one pass (never throws). Cross-clause
   * SEMANTIC rules (source duplicates, aggregate placement, …) remain in
   * `validateWalk`; this shape covers STRUCTURE only. See `shape/`.
   */
  static readonly SHAPE = obj(
    {
      kind: lit('select'),
      distinct: bool('Distinct'),
      fields: list(selectFieldShape()),
      from: sourceRef(),
      joins: list(QueryJoin.SHAPE),
      where: list(exprRef()),
      groupBy: list(exprRef()),
      having: list(exprRef()),
      order: list(orderItemShape),
      limit: boundShape(),
      offset: boundShape(),
    },
    (v) =>
      new SelectQuery(
        v.distinct ?? false,
        v.fields,
        v.from,
        v.joins ?? [],
        v.where ?? [],
        v.groupBy ?? [],
        v.having ?? [],
        v.order ?? [],
        v.limit,
        v.offset,
      ),
    {
      optional: ['distinct', 'joins', 'where', 'groupBy', 'having', 'order', 'limit', 'offset'],
      aid: 'Query_select',
    },
  );

  // ─── Naming / resolution ─────────────────────────────────────────────────

  /** Output field name for field `i` (alias, else a natural name). */
  private fieldName(col: SelectField, i: number): string {
    if (col.as) return col.as;
    const e = col.expr;
    if (e instanceof FieldRefExpr) return e.field;
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
    const colCtx: ValidateContext = { inAggregate: false, inWindow: false, allowAggregate: true, groupKeys: [], inGroupBy: false };
    const predCtx: ValidateContext = { ...colCtx, allowAggregate: false };
    p.at('joins', () => {
      this.joins.forEach((j, i) => {
        const plan = j.buildPlan(engine, aliasTypes);
        if (!plan || plan.length === 0) {
          p.at(i, () => p.error('join.unresolved', `Join '${j.label}' does not resolve to a relation.`));
        } else {
          // The join's `and` predicate (when present) must resolve to a boolean.
          p.at(i, () => j.validateWalk(engine, inner, p, predCtx));
        }
      });
    });
    // GROUP BY keys may not aggregate, and an `output` ref there rejects an
    // aggregate target (`output.aggregate`) — flagged via `inGroupBy`.
    const groupCtx: ValidateContext = { ...predCtx, inGroupBy: true };
    // GROUP BY / HAVING / ORDER BY resolve against a child scope exposing this
    // SELECT's outputs, so an `output` reference can delegate to its target.
    // WHERE / fields do NOT (an `output` ref there ⇒ `output.not-available`).
    const outScope = this.outputScope(inner);
    // A select FIELD may project a relation's identity (`identityValueCtx`), so
    // an audit column like `createdBy` reads as a value instead of forcing an
    // RLS-scoped join that nulls the id along with the hidden row.
    p.at('fields', () => {
      this.fields.forEach((c, i) =>
        p.at([i, 'expr'], () => c.expr.validateWalk(engine, inner, p, identityValueCtx(c.expr, colCtx))),
      );
    });
    p.at('where', () => {
      this.where.forEach((w, i) => p.at(i, () => {
        const rt = w.validateWalk(engine, inner, p, predCtx);
        checkBoolCondition(w, rt, p);
      }));
    });
    // GROUP BY over an identity is structural (over the key columns), so a
    // relation key is a legal grouping key.
    p.at('groupBy', () => {
      this.groupBy.forEach((g, i) => p.at(i, () => g.validateWalk(engine, outScope, p, identityValueCtx(g, groupCtx))));
    });
    p.at('having', () => {
      this.having.forEach((h, i) => p.at(i, () => {
        const rt = h.validateWalk(engine, outScope, p, colCtx);
        checkBoolCondition(h, rt, p);
      }));
    });
    // ORDER BY: a normal term validates its `expr` exactly like before; a
    // `sorter` validates its CATALOG exprs the same way (same outScope + colCtx),
    // so an `output` ref resolves and a non-orderable / relation-as-value sort is
    // rejected — see `SorterExpr.validateInOrder`.
    p.at('order', () => {
      this.order.forEach((o, i) =>
        o instanceof SorterExpr
          ? p.at(i, () => o.validateInOrder(engine, outScope, p, colCtx))
          // ORDER BY over an identity is lexicographic over the declared key
          // order, so a relation term is a legal sort key.
          : p.at([i, 'expr'], () => o.expr.validateWalk(engine, outScope, p, identityValueCtx(o.expr, colCtx))),
      );
    });
    // SQL-92 GROUP BY rule: once the SELECT groups, every column referenced in a
    // select field / order-by / having must be a GROUP BY key (matched as a whole
    // subtree) or sit inside an aggregate — otherwise it is neither grouped nor
    // aggregated, which SQL rejects and the in-memory runtime would resolve to an
    // ARBITRARY row's value.
    if (this.groupBy.length > 0) {
      const groupCodes = this.groupKeyCodes();
      p.at('fields', () => this.fields.forEach((c, i) => p.at([i, 'expr'], () => this.checkGrouped(c.expr, groupCodes, p))));
      p.at('having', () => this.having.forEach((h, i) => p.at(i, () => this.checkGrouped(h, groupCodes, p))));
      // A sorter's catalog exprs face the SAME SQL-92 rule as any order term.
      p.at('order', () => this.order.forEach((o, i) =>
        o instanceof SorterExpr
          ? p.at(i, () => o.sorts.forEach((e, name) => p.at(['sorts', name], () => this.checkGrouped(e, groupCodes, p))))
          : p.at([i, 'expr'], () => this.checkGrouped(o.expr, groupCodes, p)),
      ));
    }
  }

  /**
   * The GROUP BY keys as `toCode()` strings, with an `output` key EXPANDED to the
   * select field it names — so grouping by `output('x')` also covers a bare
   * reference to that field's underlying expression. Drives {@link checkGrouped}.
   */
  private groupKeyCodes(): Set<string> {
    const outputs = this.outputExprs();
    const codes = new Set<string>();
    for (const g of this.groupBy) {
      const key = g instanceof OutputRefExpr ? outputs.get(g.name) ?? g : g;
      codes.add(key.toCode());
    }
    return codes;
  }

  /**
   * Enforce the SQL-92 GROUP BY rule on one select / order-by / having expr
   * (top-down, pruning): a subtree that IS a group key — or an aggregate / window
   * — is covered, so stop; a bare column reference reached any other way is
   * neither grouped nor aggregated and is reported. Composite exprs recurse, so
   * `region || tier` needs BOTH columns grouped, while a grouped `dateTrunc(...)`
   * selected verbatim is covered as a whole.
   */
  private checkGrouped(expr: Expr, groupCodes: ReadonlySet<string>, p: Problems): void {
    if (groupCodes.has(expr.toCode())) return;
    if (expr instanceof AggregateExpr || expr instanceof WindowExpr) return;
    if (expr instanceof FieldRefExpr) {
      const code = expr.toCode();
      p.error(
        'group.ungrouped-column',
        `Column '${code}' is neither in GROUP BY nor inside an aggregate. Add it to groupBy, or aggregate it (e.g. max(${code})).`,
      );
      return;
    }
    expr.forEachChild((c) => this.checkGrouped(c, groupCodes, p));
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
    // A sorter is itself an `Expr` (so `sorters()` can find it) whose catalog
    // exprs are its children; a normal term walks just its `expr`.
    for (const o of this.order) (o instanceof SorterExpr ? o : o.expr).walk(visit);
    for (const j of this.joins) if (j.and) j.and.walk(visit);
  }

  /** Bind FROM + joins so a `filters` placeholder's `source` resolves for `filters()`. */
  protected override filterScope(engine: QueryEngine, scope: QueryScope): QueryScope {
    return this.bind(engine, scope).scope;
  }

  /** Resolve `references` field-refs against FROM + joins + this SELECT's outputs. */
  protected override referenceScope(engine: QueryEngine, scope: QueryScope): QueryScope {
    return this.sorterScope(engine, scope);
  }

  /**
   * Visit the nodes `references` inspects: every field / WHERE / GROUP BY /
   * HAVING / join-`and` expr, plus — for each `order` entry — only the exprs its
   * `ctx.sort` SELECTION reads (a `sorter` expands to its selected / default /
   * whole catalog, never blindly all of it).
   */
  protected override forEachReferenceNode(ctx: CostContext, visit: (n: Expr) => void): void {
    for (const c of this.fields) c.expr.walk(visit);
    for (const w of this.where) w.walk(visit);
    for (const g of this.groupBy) g.walk(visit);
    for (const h of this.having) h.walk(visit);
    for (const o of this.order) for (const e of o.referenceExprs(ctx.sort)) e.walk(visit);
    for (const j of this.joins) if (j.and) j.and.walk(visit);
  }

  /**
   * The scope a `sorter`'s catalog exprs resolve in for `sorters()` introspection:
   * FROM + joins PLUS this SELECT's outputs (so an `output`-ref sort resolves),
   * mirroring the order-by validation scope.
   */
  protected override sorterScope(engine: QueryEngine, scope: QueryScope): QueryScope {
    return this.outputScope(this.bind(engine, scope).scope);
  }

  /**
   * Expand this SELECT's `order` entries into concrete {@link QueryOrder} terms
   * against the execution-time `spec`: a normal term passes through; a `sorter`
   * EXPANDS (its selected / default terms), so both the runtime sort and the SQL
   * ORDER BY emission proceed through the SAME order-by machinery. A sorter with
   * neither a selection nor a `defaultSort` contributes no terms.
   */
  private expandOrder(spec: readonly SortSelectionDef[] | undefined): QueryOrder[] {
    const out: QueryOrder[] = [];
    for (const item of this.order) {
      if (item instanceof SorterExpr) out.push(...item.expand(spec));
      else out.push(item);
    }
    return out;
  }

  /**
   * The default conditions ACTIVE across every bound source of this SELECT (FROM
   * alias + join hop aliases), each decided independently from the SELECT's
   * condition-clause references (WHERE / HAVING / join `and`) on ITS alias.
   */
  private activeDefaults(
    engine: QueryEngine,
    aliasTypes: ReadonlyMap<string, Type>,
  ): ActiveDefaultCondition[] {
    const clauses = conditionClauses(this.where, this.having, this.joins);
    const sources: BoundTypeSource[] = [...aliasTypes].map(([alias, t]) => ({ alias, typeName: t.name }));
    return activeDefaultConditions(engine, sources, conditionFieldRefs(clauses), 'select');
  }

  /**
   * The FROM Type's `defaultOrder` to synthesize this SELECT's `ORDER BY` from,
   * or `undefined` when none applies. It applies ONLY when every guard holds:
   *  1. the FROM binds a backed Type that declares a non-empty `defaultOrder`
   *     (joins never contribute their own default order);
   *  2. the query specifies NO explicit `order` (an author's order owns the sort);
   *  3. the query is NOT aggregated — no `groupBy`, no bare aggregate select item
   *     (a base-field order is meaningless post-aggregation) — and NOT `DISTINCT`
   *     (a non-selected order key would be illegal SQL); AND
   *  4. the SELECT is in scope for the order's `applyTo` (default `'result'`):
   *     `'result'` ⇒ the root query (`isRoot`) OR any LIMIT/OFFSET select;
   *     `'paginated'` ⇒ only a LIMIT/OFFSET select; `'all'` ⇒ every eligible one.
   * `isRoot` marks the entry query being run/emitted (threaded on the context).
   */
  private effectiveDefaultOrder(engine: QueryEngine, isRoot: boolean): DefaultOrder | undefined {
    if (this.order.length) return undefined; // (2) an explicit order owns the sort
    // (3) aggregation / DISTINCT make a base-field default order invalid.
    if (this.groupBy.length) return undefined;
    if (this.fields.some((c) => c.expr.containsAggregate())) return undefined;
    if (this.distinct) return undefined;
    // (1) only the FROM Type's declared default order drives ordering.
    if (this.from.sourceKind !== 'type' || this.from.typeName === undefined) return undefined;
    const order = engine.defaultOrder(this.from.typeName);
    if (!order || order.by.length === 0) return undefined;
    // (4) `applyTo` scope: 'result' (root or paged), 'paginated', or 'all'.
    const scope = order.applyTo ?? 'result';
    const paginated = this.limit !== undefined || this.offset !== undefined;
    const inScope = scope === 'all' || (scope === 'paginated' ? paginated : isRoot || paginated);
    return inScope ? order : undefined;
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
   *    row).
   *  - ORDER BY evaluates each order term (a concrete term or an EXPANDED
   *    `sorter`) once per row reaching the sort — the PRE-LIMIT output count — so
   *    a subquery inside a sort key (or a runtime-selected sorter entry) is real
   *    per-row work; a plain-column sort adds nothing. We do not model an ORDER
   *    BY forcing a larger upstream scan.
   *  - INDEX-ONLY (covered) scan: with no joins / grouping / distinct / aggregate,
   *    when every column referenced in SELECT + WHERE is a part of one index the
   *    WHERE probes, the scan is sized by the index ENTRY bytes, not full rows.
   *  - PER-OUTER-ROW work: a subquery / EXISTS / IN-subquery in a SELECT item
   *    runs ONCE PER OUTPUT ROW, so its cost is multiplied by the output row
   *    count; the same expr in WHERE / HAVING is treated as uncorrelated and
   *    counted ONCE. Hidden joins a computed field / RLS inject are added via
   *    `backingCost` (a LATERAL multiplies per outer row; a shared relation join
   *    is counted once).
   */
  cost(ctx: CostContext, scope: QueryScope): Cost {
    const { inner, fromType, perRowBytes, matchedRows } = this.matchedEstimate(ctx, scope);

    // Rows reaching the ORDER BY (before any LIMIT cap): an ORDER BY sorts the
    // whole result, so a per-row sort-key cost is paid this many times.
    const preLimitRows = matchedRows;
    // LIMIT caps the OUTPUT rows (a literal, or a param resolved from ctx.params).
    const limit = this.boundValue(this.limit, ctx);
    const outputRows = limit !== undefined ? Math.min(matchedRows, limit) : matchedRows;
    let cost: Cost = { rows: outputRows, bytes: outputRows * perRowBytes };

    // Per-outer-row expr work: a SELECT-position subquery / EXISTS runs once per
    // OUTPUT row; a WHERE / HAVING subquery is uncorrelated and runs once.
    for (const c of this.fields) cost = addCost(cost, fanOutCost(c.expr.cost(ctx, inner), outputRows));
    for (const w of this.where) cost = addCost(cost, fanOutCost(w.cost(ctx, inner), 1));
    for (const h of this.having) cost = addCost(cost, fanOutCost(h.cost(ctx, inner), 1));

    // ORDER BY: each order term (a concrete term or an EXPANDED sorter) is
    // evaluated once per row reaching the sort — the pre-LIMIT output count — so
    // a subquery inside a sort key (or a runtime-selected sorter entry) is real
    // per-row work. A scalar sort key (`rows === 0`) adds nothing.
    for (const o of this.order) cost = addCost(cost, fanOutCost(o.cost(ctx, inner), preLimitRows));

    // Hidden joins / LATERALs / RLS the planner injects for computed & secured
    // fields (shared joins counted once; a LATERAL multiplies per outer row).
    cost = addCost(cost, backingCost(ctx, inner, this.fields.map((c) => c.expr), fromType, outputRows));
    return cost;
  }

  /**
   * Estimate the RESULT SIZE this SELECT returns: the delivered row count (after
   * WHERE / GROUP / DISTINCT, then OFFSET dropped and LIMIT capped — each a
   * literal or a `ctx.params`-resolved value) sized by the PROJECTION width — the
   * sum of the selected columns' byte widths, NOT the whole scanned row. Contrast
   * {@link cost}, which totals the WORK (fan-out, subquery scans, penalties).
   */
  override outputCost(ctx: CostContext, scope: QueryScope): Cost {
    const { inner, matchedRows } = this.matchedEstimate(ctx, scope);
    const available = Math.max(0, matchedRows - (this.boundValue(this.offset, ctx) ?? 0));
    const limit = this.boundValue(this.limit, ctx);
    const rows = limit !== undefined ? Math.min(available, limit) : available;
    const width = this.fields.reduce((w, c) => w + bytesOfResolved(c.expr.resolve(ctx.engine, inner)), 0);
    return { rows, bytes: rows * width };
  }

  /**
   * The shared row estimate both {@link cost} and {@link outputCost} build on:
   * base scan × join fan-out, reduced by WHERE (index / selectivity), then
   * collapsed by GROUP BY / a bare aggregate / DISTINCT — the PRE-LIMIT matched
   * row count — plus the (possibly index-only) per-row scan byte width and the
   * bound inner scope.
   */
  private matchedEstimate(ctx: CostContext, scope: QueryScope): { inner: QueryScope; fromType: Type; perRowBytes: number; matchedRows: number } {
    const engine = ctx.engine;
    const { scope: inner, aliasTypes } = this.bind(engine, scope);
    const fromType = this.from.resolvedType(engine, inner).type;
    // The FROM Type is reachable under its BOUND source name, which is the alias
    // for `{kind:'aliased'}` (and either side of a self-join) — index parts are
    // written against the Type name, so every probe normalizes through this.
    const at: SourceBinding = { source: this.from.alias, type: fromType };

    // Base scan, then fan out MULTIPLICATIVELY by each relation join's
    // cardinality (compounding down the join chain).
    let rows = fromType.count;
    let perRowBytes = fromType.bytes;
    for (const join of this.joins) {
      rows *= join.expansionFactor(engine, aliasTypes);
      const plan = join.buildPlan(engine, aliasTypes);
      if (plan) for (const hop of plan) perRowBytes += hop.targetType.bytes;
    }

    // INDEX-ONLY (covered) scan: with no joins / grouping / distinct / aggregate,
    // if every column referenced in SELECT + WHERE lives in one index the WHERE
    // probes, the engine reads index ENTRIES, not whole rows — so size the scan
    // by the index's per-entry bytes instead of the full-row width.
    if (
      !this.joins.length &&
      !this.groupBy.length &&
      !this.distinct &&
      !this.fields.some((c) => c.expr.containsAggregate())
    ) {
      const covered = coveredScanBytes(ctx, inner, at, this.fields.map((c) => c.expr), this.where);
      if (covered !== undefined) perRowBytes = covered;
    }

    // WHERE row reduction (index / selectivity) + scan penalties.
    const baseScan = scanCost(fromType);
    baseScan.rows = rows;
    baseScan.bytes = rows * perRowBytes;
    let cost = applyWhere(ctx, inner, baseScan, at, this.where, perRowBytes);

    // GROUP BY ⇒ distinct(keys); a bare aggregate ⇒ one row; else DISTINCT ⇒ the
    // estimated distinct projection. Each reduces OUTPUT rows, not scan work.
    if (this.groupBy.length) {
      const distinct = distinctEstimate(at, this.groupBy, cost.rows);
      cost = { rows: distinct, bytes: distinct * perRowBytes };
    } else if (this.fields.some((c) => c.expr.containsAggregate())) {
      cost = { rows: 1, bytes: perRowBytes };
    } else if (this.distinct) {
      const distinct = distinctEstimate(at, this.fields.map((c) => c.expr), cost.rows);
      cost = { rows: distinct, bytes: distinct * perRowBytes };
    }

    return { inner, fromType, perRowBytes, matchedRows: cost.rows };
  }

  /** Resolve a LIMIT / OFFSET bound to a number: a literal, else a `ctx.params` value, else undefined. */
  private boundValue(v: number | ParamExprDef | undefined, ctx: CostContext): number | undefined {
    if (v === undefined) return undefined;
    if (typeof v === 'number') return v;
    const raw = ctx.params?.[v.name];
    return typeof raw === 'number' ? raw : undefined;
  }

  // ─── Execution ─────────────────────────────────────────────────────────

  /** Root Type for join planning (FROM source's type). */
  private rootType(engine: QueryEngine): Type {
    return this.from.resolvedType(engine, engine.globalScope()).type;
  }

  /** Run the in-memory pipeline: FROM → JOIN → WHERE → GROUP BY → HAVING → DISTINCT → ORDER BY → OFFSET/LIMIT. */
  async execute(ctx: RuntimeContext): Promise<QueryResult> {
    const engine = ctx.engine;
    // Whether THIS select is the root (entry) query — captured up front (nested
    // subquery executions clear + restore it). Drives a `defaultOrder` with
    // `applyTo: 'result'` at ORDER BY (§7).
    const isRoot = ctx.isRoot;

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

    // 2b. Default conditions (soft scope): drop rows an ACTIVE condition denies,
    //     per bound source (mirrors the SQL WHERE injection). RLS was already
    //     applied on load; these compose alongside it.
    const defaults = this.activeDefaults(engine, aliasTypes);
    if (defaults.length) {
      const kept: SourceRow[] = [];
      for (const r of rows) if (await rowPassesDefaultConditions(defaults, r, ctx)) kept.push(r);
      rows = kept;
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

    // 7. ORDER BY: the authored terms — with any `sorter` EXPANDED against the
    //    execution-time sort spec — else the FROM Type's `defaultOrder` when it
    //    applies (same guards + `applyTo` scope as SQL emission). The keys resolve
    //    per row and sort with the SAME comparator (dir + nulls) an explicit
    //    ORDER BY uses. When an `order` is present but a sorter expands to nothing
    //    (no selection, no default), the rows stay unsorted (no default fallback).
    let outRows: SourceRecord[];
    const orderTerms = this.expandOrder(ctx.sortSpec);
    if (orderTerms.length) {
      const entries: OrderEntry<SourceRecord>[] = projected.map((pr) => ({
        item: pr.record,
        row: pr.row,
        group: pr.group,
      }));
      outRows = await ctx.withOutputs(outputs, () => sortEntries(entries, orderTerms, ctx));
    } else if (this.order.length === 0) {
      outRows = await this.applyDefaultOrder(engine, ctx, isRoot, projected);
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
    // A NESTED select (a CTE body, a set-op branch, a FROM subquery) sets it on
    // a result its parent DISCARDS — every such parent builds a fresh result —
    // so only the ENTRY query's total is ever observable, which is exactly what
    // SQL emits (`SqlContext.nonRoot` / `withPlanner` clear the flag). An
    // enclosing set operation therefore reports NO total in either engine.
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

  /**
   * Sort the projected rows by the FROM Type's `defaultOrder` when it applies
   * (unsorted select + the `effectiveDefaultOrder` guards + scope), else return
   * them unsorted. Each term's `Computed` key is evaluated against the FROM
   * alias per row; a key with no runtime path (only `sql`) is skipped.
   */
  private async applyDefaultOrder(
    engine: QueryEngine,
    ctx: RuntimeContext,
    isRoot: boolean,
    projected: readonly ProjectedRow[],
  ): Promise<SourceRecord[]> {
    const def = this.effectiveDefaultOrder(engine, isRoot);
    if (!def) return projected.map((pr) => pr.record);
    const { terms, keys } = await resolveDefaultOrderRun(
      def,
      this.from.alias,
      projected.map((pr) => pr.row),
      ctx,
    );
    if (terms.length === 0) return projected.map((pr) => pr.record);
    const entries = projected.map((pr, i) => ({ item: pr.record, keys: keys[i]! }));
    return sortByKeys(entries, terms);
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

  /** One ORDER BY clause `<key> ASC|DESC [NULLS FIRST|LAST]` from a resolved key + dir/nulls. */
  private orderClauseSQL(
    key: SqlText,
    dir: 'asc' | 'desc',
    nulls: 'first' | 'last' | undefined,
  ): SqlText {
    return SqlText.concat([
      key,
      SqlText.raw(` ${dir.toUpperCase()}`),
      nulls ? SqlText.raw(` NULLS ${nulls.toUpperCase()}`) : SqlText.empty(),
    ]);
  }

  /**
   * One ORDER BY term: `<expr> ASC|DESC [NULLS FIRST|LAST]`. A RELATION term
   * expands to ONE clause per key column (each inheriting the term's direction
   * and NULLs placement) — lexicographic over the declared key order, and
   * index-usable, where sorting the assembled JSON object would be neither.
   */
  private orderTermSQL(dialect: Dialect, ctx: SqlContext, o: QueryOrder): SqlText[] {
    const keys = relationKeySqls(o.expr, dialect, ctx);
    const sqls = keys ?? [o.expr.toSQL(dialect, ctx)];
    return sqls.map((s) => this.orderClauseSQL(s, o.dir, o.nulls));
  }

  /**
   * Emit the SELECT. A SELECT never prepends its own `WITH` (relation crossings
   * lower to plain JOINs, not CTEs), so the body IS the whole statement; an
   * enclosing `CTEStatementQuery` reads it via the base `emitWith` (which wraps
   * this `toSQL` as its WITH-free body).
   */
  toSQL(dialect: Dialect, ctx: SqlContext): SqlText {
    const engine = ctx.engine;
    // Whether THIS select is the root (entry) query — read from the incoming
    // context BEFORE `withPlanner` clears it for nested emission. Drives a
    // `defaultOrder` with `applyTo: 'result'` (see `effectiveDefaultOrder`).
    const isRoot = ctx.isRoot;
    const { scope: inner, aliasTypes } = this.bind(engine, ctx.scope);
    const planner = new JoinCtePlanner(dialect, engine, ctx.rls, ctx.params);
    const selCtx = ctx.withPlanner(inner, planner);

    // 1. Register authored joins through the planner FIRST (they lead, and a
    //    hidden backing join over the same relation then reuses the alias).
    for (const join of this.joins) {
      const plan = join.buildPlan(engine, aliasTypes);
      if (plan) join.emitInto(dialect, selCtx, planner, plan);
    }

    // 2. Fields (computed / secured fields may register hidden backing joins).
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

    // 3b. Default conditions (soft scope): AND each ACTIVE condition's predicate
    //     into WHERE, per bound source. RLS above STILL applies; these compose.
    wherePreds.push(...defaultConditionPredicatesSql(this.activeDefaults(engine, aliasTypes), selCtx));

    // 4. GROUP BY / HAVING / ORDER BY (may also register joins). These resolve
    //    against a child scope exposing this SELECT's outputs (same planner), so
    //    an `output` reference EXPANDS to its target's SQL.
    const outCtx = selCtx.withScope(this.outputScope(inner));
    // A relation GROUP BY key expands to its key COLUMNS: grouping the assembled
    // identity object would group by a constructed JSON value, which most
    // dialects have no equality operator for at all.
    const groupSqls = this.groupBy.flatMap((g) => relationKeySqls(g, dialect, outCtx) ?? [g.toSQL(dialect, outCtx)]);
    const havingSqls = this.having.map((h) => h.toSQL(dialect, outCtx));
    // ORDER BY: the authored terms, else the FROM Type's `defaultOrder` when it
    // applies (unsorted + non-aggregated + non-DISTINCT + in `applyTo` scope),
    // resolved against the FROM alias. An aggregated / DISTINCT / already-ordered
    // select keeps no default (documented in `effectiveDefaultOrder`).
    let orderSqls = this.expandOrder(ctx.sortSpec).flatMap((o) => this.orderTermSQL(dialect, outCtx, o));
    // `effectiveDefaultOrder` returns `undefined` when an explicit order is
    // present, so it is the single authority for whether the default applies.
    const def = this.effectiveDefaultOrder(engine, isRoot);
    if (def) {
      orderSqls = resolveDefaultOrderSql(def, this.from.alias, outCtx).map((t) =>
        this.orderClauseSQL(t.sql, t.dir, t.nulls),
      );
    }

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

    // 7. Assemble the statement (the planner now holds every join, in document
    //    order).
    const parts: SqlText[] = [SqlText.raw('SELECT ')];
    if (this.distinct) parts.push(SqlText.raw('DISTINCT '));
    parts.push(SqlText.join(colSqls, ', '), SqlText.concat(scan));
    if (orderSqls.length) parts.push(SqlText.raw(' ORDER BY '), SqlText.join(orderSqls, ', '));
    if (!lo.isEmpty()) parts.push(SqlText.raw(' '), lo);
    return SqlText.concat(parts);
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
