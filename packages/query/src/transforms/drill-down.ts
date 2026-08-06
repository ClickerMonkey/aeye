/**
 * `drillDown` — aggregate UN-RAVELLING, PARAMETERIZED (plan algorithm "(d)").
 *
 * Given an aggregating SELECT, produce a logically-identical SELECT that
 * returns the UNDERLYING, non-aggregated rows behind ONE result row — but
 * instead of baking each group key to a literal from a specific row, it pins
 * each group key to a NAMED BIND PARAMETER (`key = param(name)`). The rebuilt
 * query is therefore REUSABLE: a caller supplies the group-key values at run
 * time (`engine.run(query, { params })`), exactly the way pagination supplies
 * `limit` / `offset` (see `autoPaginate`). This unifies drill-down + pagination
 * around the single execution contract "run a query, optionally with param
 * values, get back rows / fields / total".
 *
 * The transform (per the plan):
 *  1. Require GROUP BY or bare aggregates — else `drill.no-aggregation`.
 *  2. For each group key, pin `key = param(name)` (one NEW param per key) and
 *     record a `DrillParam { name, key, field }` mapping the param name to the
 *     AGGREGATED query's OUTPUT field that carries that key's value per row.
 *     No `groupRow`, no literals.
 *  3. Replace each aggregate SELECT item with its underlying non-aggregated
 *     expr: `sum(o.total)` → `o.total`, `count(*)` → every FROM field the SELECT
 *     does not already project itself (so a group key is not duplicated). An
 *     aggregate over a non-field argument (a literal / param) is
 *     `drill.non-invertible` (names the offending alias).
 *  4. Drop GROUP BY / HAVING. A HAVING clause that references group keys (no
 *     aggregate) is MOVED into WHERE; an aggregate-referencing HAVING ⇒
 *     `drill.having-aggregate`.
 *  5. Keep LIMIT; DROP aggregate-based ORDER BY terms (recorded as warnings).
 *  6. Any window function present ⇒ `drill.window-unsupported`.
 *
 * On success returns the rebuilt `query`, the `params` (the `DrillParam[]`
 * mapping), and any non-fatal `warnings`. On failure returns the accumulated
 * LLM-friendly `Problems`. Every failure names the offending alias / path.
 *
 * `drillDownInto(select, groupRow, engine)` is the convenience wrapper that
 * reads each `DrillParam`'s value out of a supplied group row, so the classic
 * "drill into THIS row" call is still one step.
 */
import type {
  ExprDef,
  JsonValue,
  ScalarValue,
  SelectFieldDef,
  SelectDef,
  OrderDef,
  SorterDef,
} from '../schema';
import type { SourceRecord } from '../runtime/row';
import type { QueryEngine } from '../engine';
import type { Expr } from '../expr';
import { canonicalize } from '../expr';
import { exprDigest } from '../index-spec';
import { ParamSet } from '../param';
import { Problems } from '../problem';
import {
  SelectQuery,
  fieldNameOf,
  type OrderItem,
} from '../queries/index';
import {
  AggregateExpr,
  FieldRefExpr,
  OutputRefExpr,
  WindowExpr,
  SorterExpr,
} from '../exprs/index';

/**
 * One pinned group key in a drilled query: the bind-param `name` used in the
 * rebuilt query, the group-by `key` expr def it pins (`key = param(name)`),
 * and the aggregated query's OUTPUT `field` carrying that key's value per row.
 * A caller maps `field → value` from an aggregated result row, then runs the
 * drilled query with `{ params: { [name]: value } }`.
 */
export interface DrillParam {
  /** The bind-param name used for this key in the rebuilt query. */
  name: string;
  /** The group-by key expr def this param pins (`key = param(name)`). */
  key: ExprDef;
  /** Aggregated query OUTPUT field name carrying this key's value per row. */
  field: string;
}

/** A successful drill-down: the rebuilt query + its drill params + warnings. */
export interface DrillDownSuccess {
  /** The un-ravelled SELECT returning the underlying rows. */
  query: SelectQuery;
  /** The pinned group keys, as `field → param` mappings (one per group key). */
  params: DrillParam[];
  /** Non-fatal notes (e.g. aggregate-based ORDER BY terms that were dropped). */
  warnings: Problems;
}

/** A failed drill-down: the accumulated, LLM-friendly problems. */
export interface DrillDownFailure {
  /** The accumulated problems explaining why the drill-down failed. */
  error: Problems;
}

/** The result of `drillDown`: a success bundle or a failure carrying problems. */
export type DrillDownResult = DrillDownSuccess | DrillDownFailure;

/**
 * A successful `drillDownInto`: the rebuilt query plus the EXTRACTED param
 * VALUE map (each drill param's name → the value pulled from the group row),
 * ready for `engine.run(query, { params })`.
 */
export interface DrillDownIntoSuccess {
  /** The un-ravelled SELECT returning the underlying rows. */
  query: SelectQuery;
  /**
   * Bind-param values pulled from the group row (param name → value). Usually a
   * scalar; a group key that is a RELATION carries that relation's IDENTITY
   * object (`{ id: 5 }`), which is exactly the shape the rebuilt query's
   * relation comparison binds.
   */
  params: Record<string, DrillValue>;
  /** Non-fatal notes carried over from `drillDown`. */
  warnings: Problems;
}

/**
 * A value a drill param can carry: a scalar, or the IDENTITY OBJECT of a
 * relation group key (keyed by the target's identity field names — see the
 * relation comparison lowering, which accepts exactly this shape).
 */
export type DrillValue = ScalarValue | { [key: string]: ScalarValue };

/** Coerce the input to a parsed `SelectQuery` (parsing a def when needed). */
function asSelectQuery(select: SelectQuery | SelectDef, engine: QueryEngine): SelectQuery {
  if (select instanceof SelectQuery) return select;
  return SelectQuery.from(select, engine.registry);
}

/** Whether an expr tree contains an `output` reference anywhere. */
function containsOutputRef(expr: Expr): boolean {
  let found = false;
  expr.walk((e) => {
    if (e instanceof OutputRefExpr) found = true;
  });
  return found;
}

/** The exprs one `order` entry contributes: a term's `expr`, or a sorter's catalog. */
function orderItemExprs(o: OrderItem): Expr[] {
  return o instanceof SorterExpr ? [...o.sorts.values()] : [o.expr];
}

/**
 * Un-aggregate one drilled ORDER / sort expr to its row-level form:
 *  - a non-aggregate expr is kept as-is (it already reads the row);
 *  - an expr containing aggregate(s) is UN-aggregated (`sum(total)` → `total`,
 *    `max(a)-min(b)` → `a-b`), and kept when the result still references a field;
 *  - it is DROPPED (`null`) when it cannot be un-aggregated, or un-aggregates to
 *    something field-less (`count(*)` → `1`) — a sort with no row-level value.
 */
function unaggregateSort(e: Expr, engine: QueryEngine): ExprDef | null {
  const un = unaggregateDef(e.toJSON(), engine);
  if (un === null) return null; // a window / template-less aggregate cannot be drilled
  // A sort that HELD an aggregate/window but un-aggregates to a field-less value
  // (`count(*)` → `1`) carries no row-level information → drop it.
  if ((e.containsAggregate() || containsWindow(e)) && !defReferencesField(un, engine)) return null;
  return un;
}

/**
 * Un-aggregate a `sorter` for a drilled query: run each catalog sort through
 * {@link unaggregateSort}, keeping the survivors and DROPPING (with a warning) any
 * that can't be un-aggregated, plus every `defaultSort` naming a dropped sort.
 * Returns the rebuilt `SorterDef`, or `null` when none of its sorts survive.
 */
function unaggregateSorterForDrill(
  sorter: SorterExpr,
  i: number,
  engine: QueryEngine,
  warnings: Problems,
): SorterDef | null {
  const sorts: Record<string, ExprDef> = {};
  const dropped = new Set<string>();
  for (const [name, expr] of sorter.sorts) {
    const un = unaggregateSort(expr, engine);
    if (un) {
      sorts[name] = un;
    } else {
      dropped.add(name);
      warnings.at(['order', i, 'sorts', name], () =>
        warnings.warn(
          'drill.order-dropped',
          `Dropped sort '${name}' (${expr.toCode()}) from the sorter — it has no row-level value over the un-ravelled rows.`,
        ),
      );
    }
  }
  if (Object.keys(sorts).length === 0) {
    warnings.at(['order', i], () =>
      warnings.warn('drill.order-dropped', 'Dropped the entire sorter — none of its sorts survive the un-ravelling.'),
    );
    return null;
  }
  const def: SorterDef = { kind: 'sorter', sorts };
  if (sorter.defaultSort) {
    const kept = sorter.defaultSort.filter((d) => !dropped.has(d.sort));
    if (kept.length) def.defaultSort = kept.map((d) => ({ ...d }));
  }
  return def;
}

/** Expand every `output` ref inside a sorter's catalog (keeps the `SorterDef` type). */
function expandSorterDef(def: SorterDef, outputs: ReadonlyMap<string, ExprDef>): SorterDef {
  const sorts: Record<string, ExprDef> = {};
  for (const name of Object.keys(def.sorts)) sorts[name] = expandOutputDef(def.sorts[name]!, outputs);
  return { ...def, sorts };
}

/** Expand output refs in one `order` entry (a sorter's catalog, or a term's `expr`). */
function expandOrderEntry(o: OrderDef | SorterDef, outputs: ReadonlyMap<string, ExprDef>): OrderDef | SorterDef {
  return 'kind' in o ? expandSorterDef(o, outputs) : { ...o, expr: expandOutputDef(o.expr, outputs) };
}

/** Map every value of a named-args record through `expandOutputDef`. */
function expandArgs(
  args: Record<string, ExprDef>,
  outputs: ReadonlyMap<string, ExprDef>,
): Record<string, ExprDef> {
  const out: Record<string, ExprDef> = {};
  for (const [k, v] of Object.entries(args)) out[k] = expandOutputDef(v, outputs);
  return out;
}

/**
 * Replace every `output` reference in `def` with the referenced select item's
 * expression (`outputs`, name → the original select's projection def), so the
 * rebuilt drill-down query never DANGLES a reference to an output that the
 * un-ravelling removed. Recurses through every expr child position but STOPS at
 * an embedded subquery (`exists` / `subquery` / an `in` sub-select), which
 * carries its OWN outputs. Exhaustive over `ExprKind` so a new kind can't slip
 * an output reference past the expansion.
 */
function expandOutputDef(def: ExprDef, outputs: ReadonlyMap<string, ExprDef>): ExprDef {
  switch (def.kind) {
    case 'output':
      // The target is a plain select item (it cannot itself hold an output ref).
      return outputs.get(def.name) ?? def;
    case 'binary':
    case 'comparison':
      return { ...def, left: expandOutputDef(def.left, outputs), right: expandOutputDef(def.right, outputs) };
    case 'unary':
      return { ...def, operand: expandOutputDef(def.operand, outputs) };
    case 'logical':
      return { ...def, operands: def.operands.map((o) => expandOutputDef(o, outputs)) };
    case 'in':
      return {
        ...def,
        value: expandOutputDef(def.value, outputs),
        // A value LIST is expanded; a sub-SELECT (`in` as a QueryDef) is opaque.
        in: Array.isArray(def.in) ? def.in.map((e) => expandOutputDef(e, outputs)) : def.in,
      };
    case 'between':
      return {
        ...def,
        value: expandOutputDef(def.value, outputs),
        lower: expandOutputDef(def.lower, outputs),
        upper: expandOutputDef(def.upper, outputs),
      };
    case 'is-null':
      return { ...def, value: expandOutputDef(def.value, outputs) };
    case 'array-op':
      return {
        ...def,
        target: expandOutputDef(def.target, outputs),
        value: Array.isArray(def.value)
          ? def.value.map((e) => expandOutputDef(e, outputs))
          : def.value !== undefined
            ? expandOutputDef(def.value, outputs)
            : def.value,
      };
    case 'case':
      return {
        ...def,
        branches: def.branches.map((b) => ({
          when: expandOutputDef(b.when, outputs),
          then: expandOutputDef(b.then, outputs),
        })),
        else: def.else !== undefined ? expandOutputDef(def.else, outputs) : def.else,
      };
    case 'aggregate':
    case 'function-call':
    case 'tabular-function-call':
      return { ...def, args: expandArgs(def.args, outputs) };
    case 'window':
      return {
        ...def,
        args: expandArgs(def.args, outputs),
        partitionBy: def.partitionBy?.map((e) => expandOutputDef(e, outputs)),
        orderBy: def.orderBy?.map((o) => ({ ...o, expr: expandOutputDef(o.expr, outputs) })),
      };
    // Leaves + subquery-holders (their embedded QueryDef carries its own
    // outputs, so it is left untouched): return unchanged.
    case 'sorter':
      // A sorter only appears as an ORDER entry (routed via `expandSorterDef`),
      // never nested in a value — but ExprKind exhaustiveness requires the case;
      // expand its catalog so a stray nested sorter still can't dangle a ref.
      return expandSorterDef(def, outputs);
    case 'literal':
    case 'field-ref':
    case 'param':
    case 'arg':
    case 'exists':
    case 'subquery':
    case 'semantic':
    case 'text-search':
    case 'text-score':
    case 'filters':
    case 'excluded':
      return def;
    /* v8 ignore next 2 -- unreachable: `def.kind` exhaustively covers ExprKind (compile-time guard) */
    default:
      return assertNeverExprKind(def);
  }
}

/**
 * Expand every `output` reference in a SELECT's `groupBy` / `orderBy` / `having`
 * against its ORIGINAL projection items, returning an equivalent `SelectQuery`
 * whose those clauses reference the underlying expressions directly. A no-op
 * (returns the input) when no clause uses an `output` reference.
 */
function expandSelectOutputs(sq: SelectQuery, engine: QueryEngine): SelectQuery {
  const usesOutput =
    sq.groupBy.some(containsOutputRef) ||
    sq.having.some(containsOutputRef) ||
    sq.order.some((o) => orderItemExprs(o).some(containsOutputRef));
  if (!usesOutput) return sq;

  const outputs = new Map<string, ExprDef>();
  sq.fields.forEach((c, i) => outputs.set(fieldNameOf(c.expr, c.as, i), c.expr.toJSON()));

  const def = sq.toJSON();
  if (def.groupBy) def.groupBy = def.groupBy.map((d) => expandOutputDef(d, outputs));
  if (def.having) def.having = def.having.map((d) => expandOutputDef(d, outputs));
  if (def.order) def.order = def.order.map((o) => expandOrderEntry(o, outputs));
  return SelectQuery.from(def, engine.registry);
}

/**
 * UN-AGGREGATE an expr for a drilled query: replace EVERY aggregate node with its
 * row-level form (`AggregateExpr.unaggregate` — the aggregate's serializable
 * template with the call's args substituted), recursing through every wrapper so
 * `max(a) - min(b)` → `a - b`. STOPS at an embedded subquery (its aggregates
 * belong to its own scope). Returns `null` when ANY aggregate cannot be
 * un-aggregated (no template) or a window function is present (a window has no
 * row-level un-ravelling); the caller then drops / rejects the containing expr.
 */
function unaggregateDef(def: ExprDef, engine: QueryEngine): ExprDef | null {
  const one = (d: ExprDef): ExprDef | null => unaggregateDef(d, engine);
  const many = (ds: readonly ExprDef[]): ExprDef[] | null => {
    const out: ExprDef[] = [];
    for (const d of ds) {
      const u = one(d);
      if (u === null) return null;
      out.push(u);
    }
    return out;
  };
  switch (def.kind) {
    case 'aggregate': {
      const agg = engine.registry.parseExpr(def);
      /* v8 ignore next -- a 'aggregate'-kinded def always parses to an AggregateExpr */
      if (!(agg instanceof AggregateExpr)) return def;
      const un = agg.unaggregate(engine);
      return un ? un.toJSON() : null;
    }
    case 'window':
      return null; // a window function cannot be un-aggregated to a row value
    case 'binary':
    case 'comparison': {
      const l = one(def.left);
      const r = one(def.right);
      return l && r ? { ...def, left: l, right: r } : null;
    }
    case 'unary': {
      const o = one(def.operand);
      return o ? { ...def, operand: o } : null;
    }
    case 'logical': {
      const os = many(def.operands);
      return os ? { ...def, operands: os } : null;
    }
    case 'in': {
      const v = one(def.value);
      if (!v) return null;
      if (Array.isArray(def.in)) {
        const inl = many(def.in);
        return inl ? { ...def, value: v, in: inl } : null;
      }
      return { ...def, value: v }; // a sub-SELECT `in` is opaque
    }
    case 'between': {
      const v = one(def.value);
      const lo = one(def.lower);
      const hi = one(def.upper);
      return v && lo && hi ? { ...def, value: v, lower: lo, upper: hi } : null;
    }
    case 'is-null': {
      const v = one(def.value);
      return v ? { ...def, value: v } : null;
    }
    case 'array-op': {
      const target = one(def.target);
      if (!target) return null;
      if (Array.isArray(def.value)) {
        const vs = many(def.value);
        return vs ? { ...def, target, value: vs } : null;
      }
      if (def.value !== undefined) {
        const v = one(def.value);
        return v ? { ...def, target, value: v } : null;
      }
      return { ...def, target };
    }
    case 'case': {
      const branches: { when: ExprDef; then: ExprDef }[] = [];
      for (const b of def.branches) {
        const when = one(b.when);
        const then = one(b.then);
        if (!when || !then) return null;
        branches.push({ when, then });
      }
      if (def.else === undefined) return { ...def, branches };
      const els = one(def.else);
      return els ? { ...def, branches, else: els } : null;
    }
    case 'function-call':
    case 'tabular-function-call': {
      const args = unaggregateArgs(def.args, engine);
      return args ? { ...def, args } : null;
    }
    // Leaves + subquery-holders (opaque — their aggregates are their own scope's):
    case 'literal':
    case 'field-ref':
    case 'param':
    case 'arg':
    case 'output':
    case 'sorter':
    case 'exists':
    case 'subquery':
    case 'semantic':
    case 'text-search':
    case 'text-score':
    case 'filters':
    case 'excluded':
      return def;
    /* v8 ignore next 2 -- unreachable: `def.kind` exhaustively covers ExprKind */
    default:
      return assertNeverExprKind(def);
  }
}

/** Un-aggregate every value of a named-args record; `null` if any value can't. */
function unaggregateArgs(
  args: Record<string, ExprDef>,
  engine: QueryEngine,
): Record<string, ExprDef> | null {
  const out: Record<string, ExprDef> = {};
  for (const [k, v] of Object.entries(args)) {
    const u = unaggregateDef(v, engine);
    if (u === null) return null;
    out[k] = u;
  }
  return out;
}

/** Whether an expr DEF references at least one field once parsed. */
function defReferencesField(def: ExprDef, engine: QueryEngine): boolean {
  return referencesField(engine.registry.parseExpr(def));
}

/* v8 ignore next 3 -- compile-time exhaustiveness guard over ExprKind; never invoked at runtime */
function assertNeverExprKind(value: never): never {
  throw new Error(`drill-down: unhandled expr kind ${JSON.stringify(value)}`);
}

/** Whether `value` is a scalar a `literal` / param value can carry. */
function isScalar(value: JsonValue | undefined): value is ScalarValue {
  return value === null || (value !== undefined && typeof value !== 'object');
}

/**
 * Whether `value` can be bound as a drill param: a scalar, or a flat object of
 * scalars — a relation group key's IDENTITY. An array (or a nested object) is
 * not a key and is refused.
 */
function isDrillValue(value: JsonValue | undefined): value is DrillValue {
  if (isScalar(value)) return true;
  if (value === undefined || Array.isArray(value)) return false;
  return Object.values(value).every((v) => isScalar(v));
}

/** Whether an expr references at least one field (a `field-ref`). */
function referencesField(expr: Expr): boolean {
  let found = false;
  expr.walk((e) => {
    if (e instanceof FieldRefExpr) found = true;
  });
  return found;
}

/** Whether an expr tree contains a window function anywhere. */
function containsWindow(expr: Expr): boolean {
  let found = false;
  expr.walk((e) => {
    if (e instanceof WindowExpr) found = true;
  });
  return found;
}

/** The output field name an aggregate-or-group select field projects under. */
function nameOf(expr: Expr, as: string | undefined, i: number): string {
  return fieldNameOf(expr, as, i);
}

/**
 * Every bind-param NAME the select already references (across fields / where /
 * group-by / having / order, plus a `limit` / `offset` param). Used so a drill
 * param's derived name can be made UNIQUE — it must not collide with a param
 * the query (or an earlier drill key) already uses.
 */
function referencedParamNames(sq: SelectQuery): Set<string> {
  const ps = new ParamSet();
  const collect = (e: Expr): void => e.collectParams(ps);
  sq.fields.forEach((c) => collect(c.expr));
  sq.where.forEach(collect);
  sq.groupBy.forEach(collect);
  sq.having.forEach(collect);
  sq.order.forEach((o) => orderItemExprs(o).forEach(collect));
  const names = new Set<string>(ps.names());
  if (sq.limit !== undefined && typeof sq.limit !== 'number') names.add(sq.limit.name);
  if (sq.offset !== undefined && typeof sq.offset !== 'number') names.add(sq.offset.name);
  return names;
}

/**
 * Derive a deterministic, valid, UNIQUE bind-param identifier for a drill key
 * carried by output field `field`. Rule:
 *  - SANITIZE `field` to `[A-Za-z0-9_]` (any other char → `_`); an empty or
 *    leading-digit result gets a `_` prefix, so the name is always a valid
 *    identifier;
 *  - if the sanitized name is already TAKEN (by a param the query references,
 *    or by an earlier drill param), suffix `_2`, `_3`, … until unique.
 * `taken` is mutated to RESERVE the chosen name, so successive keys can't
 * collide with each other either.
 */
function uniqueParamName(field: string, taken: Set<string>): string {
  let base = field.replace(/[^A-Za-z0-9_]/g, '_');
  if (base.length === 0 || /^[0-9]/.test(base)) base = `_${base}`;
  let name = base;
  let n = 2;
  while (taken.has(name)) {
    name = `${base}_${n}`;
    n += 1;
  }
  taken.add(name);
  return name;
}

/**
 * Expand `count(*)` into a field-ref per field of the FROM type, SKIPPING every
 * field the SELECT already projects itself (`projected`, canonical forms —
 * built by the caller from the items that survive un-ravelling unchanged).
 * Returns `undefined` when the FROM source isn't a plain type (so its fields
 * can't be enumerated) — the caller treats that as non-invertible.
 *
 * WHY THE SKIP. `count(*)` un-ravels to "the underlying rows", i.e. the FROM
 * type's fields — but a group key is BOTH a surviving select item and one of
 * those fields, so `SELECT status, count(*) … GROUP BY status` drilled to
 * `[status, …every column…]` with `status` projected TWICE. That is the single
 * most common shape a drill-down is generated from, and the duplicate column is
 * visible in every consumer that renders the result.
 *
 * Keyed on the CANONICAL form ({@link canonicalize} / `exprDigest`, the same
 * digest the caller's `colInfo` carries), never on the output NAME: two
 * different expressions may legitimately project under one name, and the same
 * expression may carry an alias.
 */
function expandStar(
  select: SelectQuery,
  engine: QueryEngine,
  projected: ReadonlySet<string>,
): SelectFieldDef[] | undefined {
  const from = select.from;
  if (from.sourceKind !== 'type' || from.typeName === undefined) return undefined;
  const type = engine.type(from.typeName);
  if (!type) return undefined;
  const fields: SelectFieldDef[] = [];
  for (const f of type.fields) {
    const expr: ExprDef = { kind: 'field-ref', source: from.alias, field: f.name };
    if (projected.has(exprDigest(expr))) continue;
    fields.push({ expr });
  }
  return fields;
}

/**
 * Un-ravel an aggregating SELECT into a reusable query over the underlying
 * rows: pin each group key to a fresh bind param, replace each aggregate with
 * its underlying expression, and drop GROUP BY / HAVING (per the algorithm in
 * this module's header). Returns the rebuilt query + drill params on success,
 * or the accumulated problems on failure.
 */
export function drillDown(
  select: SelectQuery | SelectDef,
  engine: QueryEngine,
): DrillDownResult {
  // Expand any `output` references in GROUP BY / ORDER BY / HAVING against the
  // ORIGINAL projection FIRST, so the un-ravelling (which rewrites the SELECT
  // items) never leaves a reference dangling at a removed aggregate output.
  const sq = expandSelectOutputs(asSelectQuery(select, engine), engine);
  const errors = new Problems();
  const warnings = new Problems();

  // (6) Window functions cannot be drilled — they don't collapse rows but a
  //     drilled query removes the grouping context they were computed in.
  errors.at('fields', () => {
    sq.fields.forEach((c, i) => {
      if (containsWindow(c.expr)) {
        const alias = nameOf(c.expr, c.as, i);
        errors.at([i, 'expr'], () =>
          errors.error(
            'drill.window-unsupported',
            `Cannot drill down through window function in field '${alias}'.`,
          ),
        );
      }
    });
  });
  if (errors.hasErrors) return { error: errors };

  // (1) Require an aggregation to un-ravel.
  const hasAggregateField = sq.fields.some((c) => c.expr.containsAggregate());
  if (sq.groupBy.length === 0 && !hasAggregateField) {
    errors.error(
      'drill.no-aggregation',
      'Drill-down requires a GROUP BY or a bare aggregate; this SELECT has neither.',
    );
    return { error: errors };
  }

  // Pre-compute each select field's canonical form + output name, so a group
  // key can be matched to the field that CARRIES its value in a result row.
  const colInfo = sq.fields.map((c, i) => ({
    canon: canonicalize(c.expr),
    name: nameOf(c.expr, c.as, i),
  }));

  // The canonical form of every item that SURVIVES step (3) UNCHANGED (a group
  // key / plain ref). A `count(*)` in the same SELECT expands to the FROM type's
  // fields, which OVERLAP these — so the expansion skips them and each column is
  // projected once. Only the survivors go in: an aggregate that un-ravels to a
  // field is re-aliased to the aggregate's own output name (`sum(total)` →
  // `total AS "revenue"`), so the star's own `total` column is not the same
  // column, and dropping it would delete a name the caller can read.
  const projected = new Set<string>();
  sq.fields.forEach((c, i) => {
    if (!c.expr.containsAggregate()) projected.add(colInfo[i]!.canon);
  });

  // (2) Pin each group key to a fresh bind PARAM (`key = param(name)`), and
  //     record the `field → param` mapping so a caller can supply the value.
  const taken = referencedParamNames(sq);
  const params: DrillParam[] = [];
  const pinned: ExprDef[] = [];
  sq.groupBy.forEach((key, i) => {
    const canon = canonicalize(key);
    const match = colInfo.find((ci) => ci.canon === canon);
    const field = match ? match.name : nameOf(key, undefined, i);
    const name = uniqueParamName(field, taken);
    const keyDef = key.toJSON();
    pinned.push({ kind: 'comparison', op: '=', left: keyDef, right: { kind: 'param', name } });
    params.push({ name, key: keyDef, field });
  });

  // (3) UN-AGGREGATE each SELECT item to its underlying row-level expression
  //     (`sum(o.total)` → `o.total`, `max(a)-min(b)` → `a-b`, `count(v)` → its 0/1
  //     case). `count(*)` is special — it has no single value, so it EXPANDS to
  //     the source's fields (showing the underlying rows), MINUS the ones this
  //     SELECT already projects itself. An aggregate field that cannot be
  //     un-aggregated, or un-aggregates to something FIELD-LESS (a literal /
  //     param), is `drill.non-invertible`.
  const newFields: SelectFieldDef[] = [];
  sq.fields.forEach((c, i) => {
    const e = c.expr;
    // count(*) (an arg-less aggregate): expand to the source's not-yet-projected fields.
    if (e instanceof AggregateExpr && e.valueArg() === undefined) {
      const expanded = expandStar(sq, engine, projected);
      if (!expanded) {
        errors.at(['fields', i], () =>
          errors.error(
            'drill.non-invertible',
            `Cannot un-ravel '${nameOf(e, c.as, i)}': count(*) over a non-type source has no enumerable underlying fields.`,
          ),
        );
        return;
      }
      newFields.push(...expanded);
      return;
    }
    // A plain (non-aggregate) field — a group key / ref — survives unchanged.
    if (!e.containsAggregate()) {
      newFields.push(c.as ? { expr: e.toJSON(), as: c.as } : { expr: e.toJSON() });
      return;
    }
    // A field holding aggregate(s): un-aggregate them; a field-less / un-invertible
    // result cannot be drilled to the underlying rows.
    const un = unaggregateDef(e.toJSON(), engine);
    if (un === null || !defReferencesField(un, engine)) {
      errors.at(['fields', i], () =>
        errors.error(
          'drill.non-invertible',
          `Cannot un-ravel aggregate field '${nameOf(e, c.as, i)}': it has no underlying field-level expression to expand.`,
        ),
      );
      return;
    }
    // Carry an explicit alias (the field's alias, else the aggregate's name) so
    // the un-ravelled column keeps a STABLE output name.
    newFields.push({ expr: un, as: nameOf(e, c.as, i) });
  });

  // (4) Drop GROUP BY / HAVING; move group-key-only HAVING into WHERE.
  const movedHaving: ExprDef[] = [];
  sq.having.forEach((h, i) => {
    if (h.containsAggregate()) {
      errors.at(['having', i], () =>
        errors.error(
          'drill.having-aggregate',
          'A HAVING clause that references an aggregate cannot be drilled into; it has no row-level meaning.',
        ),
      );
      return;
    }
    movedHaving.push(h.toJSON());
  });

  // (5) Keep LIMIT. UN-AGGREGATE each ORDER BY term to its row-level form
  //     (`sum(total)` → `total`); a term / sorter sort that cannot be
  //     un-aggregated or has no field-level value (`count(*)` → `1`) is dropped
  //     (per-sort for a sorter, trimming its `defaultSort`). All drops are warns.
  const keptOrder: (OrderDef | SorterDef)[] = [];
  sq.order.forEach((o, i) => {
    if (o instanceof SorterExpr) {
      const converted = unaggregateSorterForDrill(o, i, engine, warnings);
      if (converted) keptOrder.push(converted);
      return;
    }
    const un = unaggregateSort(o.expr, engine);
    if (un) {
      keptOrder.push({ ...o.toJSON(), expr: un });
    } else {
      warnings.at(['order', i], () =>
        warnings.warn(
          'drill.order-dropped',
          `Dropped ORDER BY term '${o.expr.toCode()}' — it has no row-level value over the un-ravelled rows.`,
        ),
      );
    }
  });

  if (errors.hasErrors) return { error: errors };

  // Assemble the rebuilt SELECT def. The new param predicates AND into WHERE
  // (a SELECT's `where` array is AND-combined), alongside any moved HAVING.
  const baseWhere = sq.where.map((w) => w.toJSON());
  const where = [...baseWhere, ...pinned, ...movedHaving];

  const def: SelectDef = {
    kind: 'select',
    fields: newFields,
    from: sq.from.toJSON(),
  };
  if (sq.distinct) def.distinct = true;
  if (sq.joins.length) def.joins = sq.joins.map((j) => j.toJSON());
  if (where.length) def.where = where;
  if (keptOrder.length) def.order = keptOrder;
  if (sq.limit !== undefined) def.limit = sq.limit;
  if (sq.offset !== undefined) def.offset = sq.offset;

  return { query: SelectQuery.from(def, engine.registry), params, warnings };
}

/**
 * `drillDownInto` — the convenience over `drillDown` for the classic "drill
 * into THIS aggregated row" call. It runs `drillDown(select, engine)`; on
 * success it reads each `DrillParam`'s value out of `groupRow` (under the
 * param's `field`), building the `{ name → value }` map the rebuilt query
 * expects. A key whose value is missing or non-scalar ⇒
 * `drill.missing-group-value` (naming the offending key).
 *
 *   const d = drillDownInto(sel, row, engine);
 *   if ('query' in d) await engine.run(d.query, { params: d.params });
 */
export function drillDownInto(
  select: SelectQuery | SelectDef,
  groupRow: SourceRecord,
  engine: QueryEngine,
): DrillDownIntoSuccess | DrillDownFailure {
  const drilled = drillDown(select, engine);
  if ('error' in drilled) return drilled;

  const errors = new Problems();
  const values: Record<string, DrillValue> = {};
  drilled.params.forEach((dp, i) => {
    const present = Object.prototype.hasOwnProperty.call(groupRow, dp.field);
    const value = present ? groupRow[dp.field] : undefined;
    if (!present || !isDrillValue(value)) {
      errors.at(['groupBy', i], () =>
        errors.error(
          'drill.missing-group-value',
          `Group key '${engine.parse(dp.key).toCode()}' has no bindable value under field '${dp.field}' in the supplied group row.`,
        ),
      );
      return;
    }
    values[dp.name] = value;
  });
  if (errors.hasErrors) return { error: errors };

  return { query: drilled.query, params: values, warnings: drilled.warnings };
}
