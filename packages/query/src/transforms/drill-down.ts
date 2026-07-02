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
 *     expr: `sum(o.total)` → `o.total`, `count(*)` → all FROM fields. An
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
} from '../schema';
import type { SourceRecord } from '../runtime/row';
import type { QueryEngine } from '../engine';
import type { Expr } from '../expr';
import { canonicalize } from '../expr';
import { ParamSet } from '../param';
import { Problems } from '../problem';
import {
  SelectQuery,
  fieldNameOf,
} from '../queries/index';
import {
  AggregateExpr,
  FieldRefExpr,
  RelationPathExpr,
  WindowExpr,
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
 * VALUE map (each drill param's name → the scalar pulled from the group row),
 * ready for `engine.run(query, { params })`.
 */
export interface DrillDownIntoSuccess {
  /** The un-ravelled SELECT returning the underlying rows. */
  query: SelectQuery;
  /** Bind-param values pulled from the group row (param name → scalar). */
  params: Record<string, ScalarValue>;
  /** Non-fatal notes carried over from `drillDown`. */
  warnings: Problems;
}

/** Coerce the input to a parsed `SelectQuery` (parsing a def when needed). */
function asSelectQuery(select: SelectQuery | SelectDef, engine: QueryEngine): SelectQuery {
  if (select instanceof SelectQuery) return select;
  return SelectQuery.from(select, engine.registry);
}

/** Whether `value` is a scalar a `literal` / param value can carry. */
function isScalar(value: JsonValue | undefined): value is ScalarValue {
  return value === null || (value !== undefined && typeof value !== 'object');
}

/** Whether an expr references at least one field (field-ref / relation-path). */
function referencesField(expr: Expr): boolean {
  let found = false;
  expr.walk((e) => {
    if (e instanceof FieldRefExpr || e instanceof RelationPathExpr) found = true;
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
  sq.order.forEach((o) => collect(o.expr));
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
 * Expand `count(*)` into a field-ref per field of the FROM type. Returns
 * `undefined` when the FROM source isn't a plain type (so its fields can't
 * be enumerated) — the caller treats that as non-invertible.
 */
function expandStar(select: SelectQuery, engine: QueryEngine): SelectFieldDef[] | undefined {
  const from = select.from;
  if (from.sourceKind !== 'type' || from.typeName === undefined) return undefined;
  const type = engine.type(from.typeName);
  if (!type) return undefined;
  return type.fields.map((f): SelectFieldDef => ({
    expr: { kind: 'field-ref', source: from.alias, field: f.name },
  }));
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
  const sq = asSelectQuery(select, engine);
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

  // (3) Replace aggregate SELECT items with their underlying expression.
  const newFields: SelectFieldDef[] = [];
  sq.fields.forEach((c, i) => {
    const e = c.expr;
    if (e instanceof AggregateExpr) {
      const valueArg = e.valueArg();
      if (!valueArg) {
        // count(*) (no args): un-ravel by expanding the source's fields.
        const expanded = expandStar(sq, engine);
        if (!expanded) {
          const alias = nameOf(e, c.as, i);
          errors.at(['fields', i], () =>
            errors.error(
              'drill.non-invertible',
              `Cannot un-ravel '${alias}': count(*) over a non-type source has no enumerable underlying fields.`,
            ),
          );
          return;
        }
        newFields.push(...expanded);
        return;
      }
      // sum/avg/min/max/count(value): the underlying expr is the argument, but
      // only if it actually reads a field (a literal / param can't be drilled).
      if (!referencesField(valueArg)) {
        const alias = nameOf(e, c.as, i);
        errors.at(['fields', i], () =>
          errors.error(
            'drill.non-invertible',
            `Cannot un-ravel aggregate '${alias}': its argument references no field to expand.`,
          ),
        );
        return;
      }
      const def: SelectFieldDef = c.as ? { expr: valueArg.toJSON(), as: c.as } : { expr: valueArg.toJSON() };
      newFields.push(def);
      return;
    }
    // A non-aggregate field (a group key / plain ref) survives unchanged.
    const def: SelectFieldDef = c.as ? { expr: e.toJSON(), as: c.as } : { expr: e.toJSON() };
    newFields.push(def);
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

  // (5) Keep LIMIT; drop aggregate-referencing ORDER BY terms (warn).
  const keptOrder = sq.order
    .filter((o, i) => {
      if (o.expr.containsAggregate()) {
        warnings.at(['order', i], () =>
          warnings.warn(
            'drill.order-dropped',
            `Dropped aggregate-based ORDER BY term '${o.expr.toCode()}' — it has no meaning over the un-ravelled rows.`,
          ),
        );
        return false;
      }
      return true;
    })
    .map((o) => o.toJSON());

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
  const values: Record<string, ScalarValue> = {};
  drilled.params.forEach((dp, i) => {
    const present = Object.prototype.hasOwnProperty.call(groupRow, dp.field);
    const value = present ? groupRow[dp.field] : undefined;
    if (!present || !isScalar(value)) {
      errors.at(['groupBy', i], () =>
        errors.error(
          'drill.missing-group-value',
          `Group key '${engine.parse(dp.key).toCode()}' has no scalar value under field '${dp.field}' in the supplied group row.`,
        ),
      );
      return;
    }
    values[dp.name] = value;
  });
  if (errors.hasErrors) return { error: errors };

  return { query: drilled.query, params: values, warnings: drilled.warnings };
}
