/**
 * FLEXIBLE ASSERTIONS for the `@aeye/query` eval.
 *
 * A case declares a LIST of `Assertion`s, each with a `severity`. The eval is
 * CORRECTNESS-primary: a case PASSES iff every `'error'`-severity assertion
 * passes. `'warn'` assertions are still evaluated + LOGGED (so a differing shape
 * stays visible) but never fail the case — a query that returns the RIGHT rows
 * via a different construct passes. RESULT checks default to `'error'`; STRUCTURAL
 * checks default to `'warn'`; `a.require` / `a.warn` flip the default and
 * `a.anyOf(...)` expresses "any of these valid approaches". Every case must carry
 * ≥1 `'error'` assertion (enforced by `--check`). The two dimensions:
 *
 *  - STRUCTURE — did the model build the right SHAPE? These read the model's
 *    emitted `queryDef` (its `.toJSON()`) and walk it: did it GROUP BY, ORDER BY
 *    DESC, LIMIT 5, filter on `total`, join to `customer`, aggregate a `sum`, …?
 *    They never run the query, so they isolate "the model understood the request"
 *    from "the numbers happen to line up".
 *  - RESULT — do the rows match a hand-written, obviously-correct ORACLE? This is
 *    the classic golden-rule check: the expected values are `engine.run(oracle)`,
 *    always DERIVED from the fixture data, never hand-guessed.
 *
 * Every builder returns an `Assertion` with a human `describe` and a `check` that
 * returns a FAILURE reason string, or `null` on pass. Structural builders read
 * the def; result builders set `needsResult` and lazily run the model's query via
 * `ctx.run()` (cached). Two builders (`resultOf`, `refused`) also carry a
 * `--check` hook (`oracle` / `refusalSample`) the no-key fixture gate validates.
 *
 * DOCUMENTED EDGE CASES:
 *  - `limit(n)` / `offset(n)` require a LITERAL count. A `param` limit satisfies
 *    the bare `limit()` (a cap is present) but NOT `limit(5)` (the value is
 *    unknown until bound).
 *  - `joins(to)` counts an explicit `JoinDef` whose resolved TARGET Type is `to`
 *    — a `relation` crossing to Type `to`, or a source-def join adding Type `to`
 *    (relations are crossed ONLY via `e.relJoin(...)`, never a synthesized path).
 *  - `filtersOn(field)` matches a `field-ref` to `field` in a WHERE / HAVING /
 *    join-`and` position (it does NOT descend into nested subqueries — that is a
 *    different scope).
 */
import type {
  QueryEngine,
  Query,
  QueryDef,
  QueryResult,
  QueryKind,
  SourceRecord,
  ExprDef,
  WriteValueDef,
  OrderDef,
  SorterDef,
  JoinDef,
  SourceDef,
  SelectDef,
  SetOperationDef,
  ParamExprDef,
} from '../../src/index';
import { RelationFieldType } from '../../src/index';

// ════════════════════════════════════════════════════════════════════════════
// Comparator (shared with run.ts's --check + LLM eval)
// ════════════════════════════════════════════════════════════════════════════

/** A result normalized to its output field names + positional value tuples. */
export interface NormResult {
  fields: string[];
  rows: unknown[][];
}

/** How to compare rows: order-insensitive `set` (default) or order-sensitive. */
export type MatchMode = 'set' | 'ordered';

/** Project a `QueryResult` into positional tuples aligned to its field order. */
export function normalize(result: QueryResult): NormResult {
  const fields = result.fields.map((f) => f.name);
  const rows = result.rows.map((r: SourceRecord) => result.fields.map((f) => r[f.name]));
  return { fields, rows };
}

/** Numeric-aware equality with an absolute tolerance for money / averages. */
export function valueEqual(a: unknown, b: unknown, tol: number): boolean {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= tol;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** A stable canonical sort key for a row tuple (numbers rounded for stability). */
export function rowKey(tuple: unknown[]): string {
  return JSON.stringify(tuple.map((v) => (typeof v === 'number' ? Math.round(v * 1e6) / 1e6 : v)));
}

/** Compare two normalized results; return `{ ok, diff }` (diff set on mismatch). */
export function compareResults(
  expected: NormResult,
  actual: NormResult,
  match: MatchMode,
  tol: number,
): { ok: boolean; diff: string | null } {
  if (expected.rows.length !== actual.rows.length) {
    return { ok: false, diff: `row count ${expected.rows.length} (expected) vs ${actual.rows.length} (actual)` };
  }
  if (expected.fields.length !== actual.fields.length) {
    return {
      ok: false,
      diff: `column count ${expected.fields.length} (expected: ${expected.fields.join(', ')}) vs ${actual.fields.length} (actual: ${actual.fields.join(', ')})`,
    };
  }
  const exp = match === 'ordered' ? expected.rows : [...expected.rows].sort((x, y) => rowKey(x).localeCompare(rowKey(y)));
  const act = match === 'ordered' ? actual.rows : [...actual.rows].sort((x, y) => rowKey(x).localeCompare(rowKey(y)));
  for (let i = 0; i < exp.length; i++) {
    const er = exp[i]!;
    const ar = act[i]!;
    for (let c = 0; c < er.length; c++) {
      if (!valueEqual(er[c], ar[c], tol)) {
        return { ok: false, diff: `row ${i} col ${c}: expected ${JSON.stringify(er[c])}, got ${JSON.stringify(ar[c])}` };
      }
    }
  }
  return { ok: true, diff: null };
}

/** A short one-line summary of a normalized result for the logs. */
export function summarize(n: NormResult): string {
  const preview = n.rows.slice(0, 4).map((r) => `[${r.map((v) => JSON.stringify(v)).join(', ')}]`).join(' ');
  const more = n.rows.length > 4 ? ` …(+${n.rows.length - 4})` : '';
  return `${n.rows.length} row(s) {${n.fields.join(', ')}}: ${preview}${more}`;
}

// ════════════════════════════════════════════════════════════════════════════
// Assertion contract
// ════════════════════════════════════════════════════════════════════════════

/** A hand-written correct query (or the illegal one, for refusals). */
export type OracleFn = (engine: QueryEngine) => QueryDef | Query;

/**
 * The context an assertion checks against. `query` is the model's built Query (or
 * `null` if parse/validation failed); `queryDef` is `query.toJSON()`; `run()`
 * lazily runs the MODEL's query once (cached) and returns its normalized result.
 */
export interface AssertCtx {
  query: Query | null;
  queryDef: QueryDef | null;
  parseError: string | null;
  engine: QueryEngine;
  run(): Promise<NormResult>;
}

/**
 * How much a failing assertion counts:
 *  - `'error'` — a CORRECTNESS gate. The case FAILS if this assertion fails.
 *    Result checks (`resultOf` / `rowCount` / `rows`) and `refused` default here:
 *    the rows (or the refusal) are what actually matter.
 *  - `'warn'` — ADVISORY shape. Evaluated + LOGGED (so a differing construct is
 *    still visible) but never fails the case. Structural builders (`groupBy`,
 *    `joins`, `cte`, `setOp`, `orderBy`, `aggregate`, …) default here — a query
 *    that returns the CORRECT rows via a different construct still PASSES.
 * Promote/demote with `a.require(...)` / `a.warn(...)`. Every case MUST carry ≥1
 * `'error'` assertion (enforced by `--check`), else it would pass vacuously.
 */
export type Severity = 'error' | 'warn';

/** One check in a case. `check` returns a FAILURE reason, or `null` on pass. */
export interface Assertion {
  /** Human-readable description (e.g. "ORDER BY … DESC", "result matches oracle"). */
  describe: string;
  /** Correctness gate (`'error'`) vs advisory shape (`'warn'`). See `Severity`. */
  severity: Severity;
  /** Whether `check` needs to RUN the model's query (calls `ctx.run()`). */
  needsResult: boolean;
  check(ctx: AssertCtx): Promise<string | null>;
  /** `--check` hook: a RESULT oracle to validate / run / prove deterministic + non-degenerate. */
  oracle?: OracleFn;
  /** `--check` hook: the comparison mode the oracle uses (informational). */
  oracleMatch?: MatchMode;
  /** `--check` hook: an illegal sample that MUST fail validation. */
  refusalSample?: OracleFn;
  /**
   * For `a.anyOf(...)`: a mutable holder the OR-group's `check` writes the matched
   * child's `describe` into (or `null` when none matched), so the runner can log
   * WHICH valid approach the model took. Ignored for every other assertion.
   */
  matchInfo?: { matched: string | null };
}

// ════════════════════════════════════════════════════════════════════════════
// Query-def walk (structure inspection)
// ════════════════════════════════════════════════════════════════════════════

/** Everything a structural assertion needs, collected in one pass over the def. */
interface QueryShape {
  queryKinds: Set<QueryKind>;
  selects: SelectDef[];
  setOps: SetOperationDef[];
  /** All exprs anywhere in the tree (incl. subqueries). */
  exprs: ExprDef[];
  /** WHERE / HAVING / join-`and` root predicates. */
  conditionRoots: ExprDef[];
  /** Field names referenced in a CONDITION position (no subquery descent). */
  conditionFields: Set<string>;
  /** QUERY-LEVEL order terms (select + set-op ORDER BY; NOT window internals). */
  orderTerms: OrderDef[];
  limits: (number | ParamExprDef)[];
  offsets: (number | ParamExprDef)[];
  /** Every `from` source across selects. */
  froms: SourceDef[];
  joins: JoinDef[];
  /** Alias → Type name, from explicit `aliased` sources. */
  aliasToType: Map<string, string>;
}

function emptyShape(): QueryShape {
  return {
    queryKinds: new Set(),
    selects: [],
    setOps: [],
    exprs: [],
    conditionRoots: [],
    conditionFields: new Set(),
    orderTerms: [],
    limits: [],
    offsets: [],
    froms: [],
    joins: [],
    aliasToType: new Map(),
  };
}

/**
 * Walk a keyed WRITE value (an INSERT row / UPDATE SET entry): descend only when
 * it is an `ExprDef` (a non-null object with a string `kind`); a raw typed value
 * carries no sub-exprs.
 */
function walkWriteValue(v: WriteValueDef, s: QueryShape): void {
  if (v !== null && typeof v === 'object' && !Array.isArray(v) && typeof (v as { kind?: unknown }).kind === 'string') {
    walkExpr(v as ExprDef, s);
  }
}

/** Recursively collect every sub-expr (descends into nested queries). */
function walkExpr(x: ExprDef, s: QueryShape): void {
  s.exprs.push(x);
  switch (x.kind) {
    case 'binary':
    case 'comparison':
      walkExpr(x.left, s);
      walkExpr(x.right, s);
      break;
    case 'unary':
      walkExpr(x.operand, s);
      break;
    case 'logical':
      for (const o of x.operands) walkExpr(o, s);
      break;
    case 'in':
      walkExpr(x.value, s);
      if (Array.isArray(x.in)) for (const e of x.in) walkExpr(e, s);
      else walkQuery(x.in, s);
      break;
    case 'between':
      walkExpr(x.value, s);
      walkExpr(x.lower, s);
      walkExpr(x.upper, s);
      break;
    case 'is-null':
      walkExpr(x.value, s);
      break;
    case 'exists':
      walkQuery(x.query, s);
      break;
    case 'array-op':
      walkExpr(x.target, s);
      if (x.value !== undefined) {
        if (Array.isArray(x.value)) for (const e of x.value) walkExpr(e, s);
        else walkExpr(x.value, s);
      }
      break;
    case 'case':
      for (const b of x.branches) {
        walkExpr(b.when, s);
        walkExpr(b.then, s);
      }
      if (x.else) walkExpr(x.else, s);
      break;
    case 'aggregate':
    case 'function-call':
    case 'tabular-function-call':
      for (const v of Object.values(x.args)) walkExpr(v, s);
      break;
    case 'window':
      for (const v of Object.values(x.args)) walkExpr(v, s);
      if (x.partitionBy) for (const p of x.partitionBy) walkExpr(p, s);
      // A window's OWN orderBy is walked (for aggregate/window detection) but is
      // NOT a query-level ORDER BY, so it is not added to `orderTerms`.
      if (x.orderBy) for (const o of x.orderBy) walkExpr(o.expr, s);
      break;
    case 'subquery':
      walkQuery(x.query, s);
      break;
    // leaves: literal, output, field-ref, param, semantic,
    // text-search, text-score, filters, excluded
    default:
      break;
  }
}

/** Collect field names used in a CONDITION predicate (does NOT enter subqueries). */
function collectCondFields(x: ExprDef, out: Set<string>): void {
  switch (x.kind) {
    case 'field-ref':
      out.add(x.field);
      return;
    case 'binary':
    case 'comparison':
      collectCondFields(x.left, out);
      collectCondFields(x.right, out);
      return;
    case 'unary':
      collectCondFields(x.operand, out);
      return;
    case 'logical':
      for (const o of x.operands) collectCondFields(o, out);
      return;
    case 'in':
      collectCondFields(x.value, out);
      if (Array.isArray(x.in)) for (const e of x.in) collectCondFields(e, out);
      return;
    case 'between':
      collectCondFields(x.value, out);
      collectCondFields(x.lower, out);
      collectCondFields(x.upper, out);
      return;
    case 'is-null':
      collectCondFields(x.value, out);
      return;
    case 'array-op':
      collectCondFields(x.target, out);
      if (x.value !== undefined) {
        if (Array.isArray(x.value)) for (const e of x.value) collectCondFields(e, out);
        else collectCondFields(x.value, out);
      }
      return;
    case 'case':
      for (const b of x.branches) {
        collectCondFields(b.when, out);
        collectCondFields(b.then, out);
      }
      if (x.else) collectCondFields(x.else, out);
      return;
    case 'aggregate':
    case 'function-call':
    case 'window':
      for (const v of Object.values(x.args)) collectCondFields(v, out);
      return;
    case 'text-search':
    case 'text-score':
    case 'semantic':
      // A narrowed text/semantic predicate targets a specific field.
      if (x.field !== undefined) out.add(x.field);
      return;
    default:
      // exists / subquery / leaves: stop (subqueries are a different scope).
      return;
  }
}

function walkSource(src: SourceDef, s: QueryShape): void {
  s.froms.push(src);
  if (src.kind === 'aliased') s.aliasToType.set(src.as, src.type);
  else if (src.kind === 'subquery') walkQuery(src.query, s);
  else if (src.kind === 'function') for (const v of Object.values(src.args)) walkExpr(v, s);
}

function walkJoin(j: JoinDef, s: QueryShape): void {
  s.joins.push(j);
  if (j.and) {
    s.conditionRoots.push(j.and);
    collectCondFields(j.and, s.conditionFields);
    walkExpr(j.and, s);
  }
}

function pushCondition(x: ExprDef, s: QueryShape): void {
  s.conditionRoots.push(x);
  collectCondFields(x, s.conditionFields);
  walkExpr(x, s);
}

/**
 * Walk one `order` entry: a dynamic `sorter` (collected as an expr, its catalog
 * `sorts` walked) or a normal `{ expr, dir }` term (added to `orderTerms` + its
 * expr walked). Distinguished by the `kind` discriminant only a sorter carries.
 */
function walkOrderEntry(o: OrderDef | SorterDef, s: QueryShape): void {
  if ('kind' in o && o.kind === 'sorter') {
    s.exprs.push(o);
    for (const name of Object.keys(o.sorts)) walkExpr(o.sorts[name]!, s);
  } else {
    const term = o as OrderDef;
    s.orderTerms.push(term);
    walkExpr(term.expr, s);
  }
}

function walkQuery(def: QueryDef, s: QueryShape): void {
  s.queryKinds.add(def.kind);
  switch (def.kind) {
    case 'select':
      s.selects.push(def);
      for (const f of def.fields) walkExpr(f.expr, s);
      walkSource(def.from, s);
      if (def.joins) for (const j of def.joins) walkJoin(j, s);
      if (def.where) for (const w of def.where) pushCondition(w, s);
      if (def.groupBy) for (const g of def.groupBy) walkExpr(g, s);
      if (def.having) for (const h of def.having) pushCondition(h, s);
      if (def.order) for (const o of def.order) walkOrderEntry(o, s);
      if (def.limit !== undefined) s.limits.push(def.limit);
      if (def.offset !== undefined) s.offsets.push(def.offset);
      break;
    case 'insert':
      if (def.rows) for (const row of def.rows) for (const v of Object.values(row)) walkWriteValue(v, s);
      if (def.select) walkQuery(def.select, s);
      if (def.returning) for (const r of def.returning) walkExpr(r.expr, s);
      if (def.onConflict?.update) for (const v of Object.values(def.onConflict.update)) walkWriteValue(v, s);
      break;
    case 'update':
      for (const v of Object.values(def.set)) walkWriteValue(v, s);
      if (def.joins) for (const j of def.joins) walkJoin(j, s);
      if (def.where) for (const w of def.where) pushCondition(w, s);
      if (def.returning) for (const r of def.returning) walkExpr(r.expr, s);
      break;
    case 'delete':
      if (def.joins) for (const j of def.joins) walkJoin(j, s);
      if (def.where) for (const w of def.where) pushCondition(w, s);
      if (def.returning) for (const r of def.returning) walkExpr(r.expr, s);
      break;
    case 'union':
    case 'intersect':
    case 'except':
      s.setOps.push(def);
      walkQuery(def.left, s);
      walkQuery(def.right, s);
      if (def.order) for (const o of def.order) walkOrderEntry(o, s);
      if (def.limit !== undefined) s.limits.push(def.limit);
      if (def.offset !== undefined) s.offsets.push(def.offset);
      break;
    case 'cte':
      for (const c of def.ctes) {
        if ('query' in c) walkQuery(c.query, s);
        else {
          walkQuery(c.base, s);
          walkQuery(c.recursive, s);
        }
      }
      walkQuery(def.final, s);
      break;
    case 'expr':
      walkExpr(def.expr, s);
      break;
    default:
      break;
  }
}

function shapeOf(def: QueryDef): QueryShape {
  const s = emptyShape();
  walkQuery(def, s);
  return s;
}

/** The set of every EXPR kind that appears anywhere in the query tree. */
export function exprKindsIn(def: QueryDef): Set<ExprDef['kind']> {
  return new Set(shapeOf(def).exprs.map((x) => x.kind));
}

/** The set of every QUERY kind that appears anywhere in the query tree. */
export function queryKindsIn(def: QueryDef): Set<QueryKind> {
  return shapeOf(def).queryKinds;
}

// ─── type resolution for join/from targets ──────────────────────────────────

/** Resolve a bound source NAME to a registered Type name (Type or `aliased`). */
function startTypeOf(engine: QueryEngine, shape: QueryShape, source: string): string | null {
  if (engine.registry.type(source)) return source;
  return shape.aliasToType.get(source) ?? null;
}

/** The TARGET Type a single `JoinDef` adds — a relation crossing's target, or a
 *  source-def join's Type — or `null` when it can't be resolved to a Type. */
function joinTarget(engine: QueryEngine, shape: QueryShape, j: JoinDef): string | null {
  const on = j.on;
  if (on.kind === 'relation') {
    const start = startTypeOf(engine, shape, on.source);
    if (!start) return null;
    const field = engine.registry.type(start)?.field(on.field);
    return field && field.fieldType instanceof RelationFieldType ? field.fieldType.to : null;
  }
  // A manual source-def join: `type` / `aliased` add a Type directly.
  if (on.kind === 'type' || on.kind === 'aliased') return on.type;
  return null; // subquery / function sources have no single Type target
}

/** Every TARGET Type reached by an explicit join (relation crossing or source-def). */
function joinTargets(engine: QueryEngine, shape: QueryShape): string[] {
  const targets: string[] = [];
  for (const j of shape.joins) {
    const t = joinTarget(engine, shape, j);
    if (t) targets.push(t);
  }
  return targets;
}

/** Whether the query traverses at least one relation (an explicit join). */
function hasAnyJoin(shape: QueryShape): boolean {
  return shape.joins.length > 0;
}

// ════════════════════════════════════════════════════════════════════════════
// Assertion builders
// ════════════════════════════════════════════════════════════════════════════

/**
 * Build a STRUCTURAL assertion (fails cleanly if the model produced no query).
 * Structure is ADVISORY — it defaults to `'warn'`, so a query that returns the
 * CORRECT rows via a different construct still passes. Promote with `a.require`.
 */
function struct(describe: string, fn: (shape: QueryShape, engine: QueryEngine) => string | null): Assertion {
  return {
    describe,
    severity: 'warn',
    needsResult: false,
    check: (ctx) =>
      Promise.resolve(
        ctx.queryDef === null ? `${describe}: model produced no valid query` : fn(shapeOf(ctx.queryDef), ctx.engine),
      ),
  };
}

/** Does an order term reference an output/field named `by`? */
function orderRefersTo(term: OrderDef, by: string): boolean {
  const e = term.expr;
  if (e.kind === 'output') return e.name === by;
  if (e.kind === 'field-ref') return e.field === by;
  return false;
}

/** Does a select item project `field` (as an alias or a direct/last-segment ref)? */
function selectsField(select: SelectDef, field: string): boolean {
  for (const item of select.fields) {
    if (item.as === field) return true;
    const e = item.expr;
    if (e.kind === 'field-ref' && e.field === field) return true;
  }
  return false;
}

const SET_OP_KINDS = new Set<QueryKind>(['union', 'intersect', 'except']);

/**
 * The `a` namespace of assertion builders. Each returns an `Assertion` whose
 * `check` inspects the model's `queryDef` (structure) or runs it (result).
 */
export const a = {
  /** Top-level query kind is `k` (e.g. `'select'`, `'cte'`, `'insert'`). */
  kind(k: QueryKind): Assertion {
    return {
      describe: `kind ${k}`,
      severity: 'warn',
      needsResult: false,
      check: (ctx) =>
        Promise.resolve(
          ctx.queryDef === null
            ? `kind ${k}: model produced no valid query`
            : ctx.queryDef.kind === k
              ? null
              : `expected top-level kind ${k}, got ${ctx.queryDef.kind}`,
        ),
    };
  },

  /** The SELECT's `from` binds Type `type` (or a join lands on it). */
  from(type: string): Assertion {
    return struct(`FROM ${type}`, (shape, engine) => {
      const fromMatch = shape.froms.some(
        (src) => (src.kind === 'type' || src.kind === 'aliased') && src.type === type,
      );
      if (fromMatch) return null;
      if (joinTargets(engine, shape).includes(type)) return null;
      return `no source or join binds Type '${type}'`;
    });
  },

  /** ≥1 relation traversal; if `to`, a hop whose resolved TARGET Type is `to`. */
  joins(to?: string): Assertion {
    return struct(to ? `joins → ${to}` : 'joins (relation traversal)', (shape, engine) => {
      if (!hasAnyJoin(shape)) return 'no join / relation-path traversal present';
      if (to === undefined) return null;
      return joinTargets(engine, shape).includes(to) ? null : `no relation hop targets Type '${to}'`;
    });
  },

  /** A `field-ref`/`relation-path` to `field` appears in a condition (WHERE/HAVING/join). */
  filtersOn(field: string): Assertion {
    return struct(`filters on ${field}`, (shape) =>
      shape.conditionFields.has(field) ? null : `no condition references field '${field}'`,
    );
  },

  /** Non-empty `groupBy` on some select. */
  groupBy(): Assertion {
    return struct('GROUP BY present', (shape) =>
      shape.selects.some((sel) => (sel.groupBy?.length ?? 0) > 0) ? null : 'no GROUP BY',
    );
  },

  /** Non-empty `having` on some select. */
  having(): Assertion {
    return struct('HAVING present', (shape) =>
      shape.selects.some((sel) => (sel.having?.length ?? 0) > 0) ? null : 'no HAVING',
    );
  },

  /** An `aggregate` expr appears (optionally with `function === fn`, e.g. `'sum'`). */
  aggregate(fn?: string): Assertion {
    return struct(fn ? `aggregate ${fn}` : 'aggregate present', (shape) => {
      const aggs = shape.exprs.filter((x) => x.kind === 'aggregate');
      if (aggs.length === 0) return 'no aggregate expression';
      if (fn === undefined) return null;
      return aggs.some((x) => x.kind === 'aggregate' && x.function === fn)
        ? null
        : `no aggregate with function '${fn}' (saw ${aggs.map((x) => (x.kind === 'aggregate' ? x.function : '')).join(', ')})`;
    });
  },

  /** Non-empty query-level `order`; optionally a term matching `by` / `dir`. */
  orderBy(opts?: { by?: string; dir?: 'asc' | 'desc' }): Assertion {
    const bits = [opts?.by ? `by ${opts.by}` : '', opts?.dir ? opts.dir.toUpperCase() : ''].filter(Boolean).join(' ');
    return struct(`ORDER BY${bits ? ` ${bits}` : ''}`, (shape) => {
      if (shape.orderTerms.length === 0) return 'no ORDER BY';
      let terms = shape.orderTerms;
      if (opts?.dir) terms = terms.filter((t) => t.dir === opts.dir);
      if (opts?.dir && terms.length === 0) return `no ORDER BY term with direction ${opts.dir}`;
      if (opts?.by) {
        const hit = terms.some((t) => orderRefersTo(t, opts.by!));
        if (!hit) return `no ORDER BY term references '${opts.by}'${opts.dir ? ` with ${opts.dir}` : ''}`;
      }
      return null;
    });
  },

  /** A `limit` is present; if `n`, a LITERAL limit `=== n` (a param satisfies only `limit()`). */
  limit(n?: number): Assertion {
    return struct(n === undefined ? 'LIMIT present' : `LIMIT ${n}`, (shape) => {
      if (shape.limits.length === 0) return 'no LIMIT';
      if (n === undefined) return null;
      return shape.limits.some((l) => typeof l === 'number' && l === n) ? null : `no literal LIMIT ${n}`;
    });
  },

  /** An `offset` is present; if `n`, a LITERAL offset `=== n`. */
  offset(n?: number): Assertion {
    return struct(n === undefined ? 'OFFSET present' : `OFFSET ${n}`, (shape) => {
      if (shape.offsets.length === 0) return 'no OFFSET';
      if (n === undefined) return null;
      return shape.offsets.some((o) => typeof o === 'number' && o === n) ? null : `no literal OFFSET ${n}`;
    });
  },

  /** Some select has `distinct === true`. */
  distinct(): Assertion {
    return struct('DISTINCT', (shape) =>
      shape.selects.some((sel) => sel.distinct === true) ? null : 'no DISTINCT',
    );
  },

  /** A `window` expr appears (optionally with `function === fn`). */
  window(fn?: string): Assertion {
    return struct(fn ? `window ${fn}` : 'window present', (shape) => {
      const wins = shape.exprs.filter((x) => x.kind === 'window');
      if (wins.length === 0) return 'no window expression';
      if (fn === undefined) return null;
      return wins.some((x) => x.kind === 'window' && x.function === fn) ? null : `no window with function '${fn}'`;
    });
  },

  /** The query is (or contains) a set operation; optionally exactly `op`. */
  setOp(op?: 'union' | 'intersect' | 'except'): Assertion {
    return struct(op ? `set-op ${op}` : 'set-op present', (shape) => {
      const kinds = [...shape.queryKinds].filter((k) => SET_OP_KINDS.has(k));
      if (kinds.length === 0) return 'no set operation';
      if (op === undefined) return null;
      return kinds.includes(op) ? null : `no ${op} (saw ${kinds.join(', ')})`;
    });
  },

  /** The query is (or contains) a CTE / WITH statement. */
  cte(): Assertion {
    return struct('CTE (WITH)', (shape) => (shape.queryKinds.has('cte') ? null : 'no CTE'));
  },

  /** The query authors an execution-time `filters` placeholder (anywhere in the tree). */
  hasFilters(): Assertion {
    return struct('filters placeholder', (shape) => (shape.exprs.some((x) => x.kind === 'filters') ? null : 'no filters placeholder'));
  },

  /** The query authors a `param` (an execution-time bind value) somewhere. */
  hasParam(): Assertion {
    return struct('param', (shape) => (shape.exprs.some((x) => x.kind === 'param') ? null : 'no param'));
  },

  /** The query authors a dynamic `sorter` catalog (a caller-selectable ORDER BY). */
  hasSorter(): Assertion {
    return struct('sorter', (shape) => (shape.exprs.some((x) => x.kind === 'sorter') ? null : 'no sorter'));
  },

  /**
   * The query nests a SUB-SELECT — a derived-table `from` (`subquery` source), an
   * `in` / `exists` / scalar-`subquery` expr, OR a CTE. Useful as an `a.anyOf`
   * arm expressing "a CTE _or_ an equivalent subquery" when either is correct.
   */
  subquery(): Assertion {
    return struct('nested sub-select', (shape) => {
      const hasFromSub = shape.froms.some((src) => src.kind === 'subquery');
      const exprKinds = new Set(shape.exprs.map((x) => x.kind));
      const hasExprSub = exprKinds.has('in') || exprKinds.has('exists') || exprKinds.has('subquery');
      return hasFromSub || hasExprSub || shape.queryKinds.has('cte') ? null : 'no nested sub-select';
    });
  },

  /** A select item projects `field` (a `field-ref` to it OR `as: field`). */
  selects(field: string): Assertion {
    return struct(`selects ${field}`, (shape) =>
      shape.selects.some((sel) => selectsField(sel, field)) ? null : `no select item projects '${field}'`,
    );
  },

  /**
   * REFUSAL: in LLM mode the model's query FAILED to parse/validate (a correct
   * refusal). In `--check`, if `sample` is given it is run and asserted to FAIL
   * validation (the fixture proves the illegal statement really is rejected).
   */
  refused(sample?: OracleFn): Assertion {
    return {
      describe: 'refused (validation error)',
      // A refusal case's correctness IS the refusal (it carries no result oracle),
      // so this is the case's error-severity gate.
      severity: 'error',
      needsResult: false,
      refusalSample: sample,
      check: (ctx) =>
        Promise.resolve(
          ctx.query === null || ctx.parseError !== null
            ? null
            : 'expected a refusal, but the model built a valid query',
        ),
    };
  },

  /** Arbitrary structural predicate over the def (`fn` returns a reason or null). */
  custom(describe: string, fn: (queryDef: QueryDef, engine: QueryEngine) => string | null): Assertion {
    return {
      describe,
      severity: 'warn',
      needsResult: false,
      check: (ctx) =>
        Promise.resolve(
          ctx.queryDef === null ? `${describe}: model produced no valid query` : fn(ctx.queryDef, ctx.engine),
        ),
    };
  },

  /**
   * RESULT: the model's rows match `engine.run(oracle)`. `opts.match` is `'set'`
   * (default) or `'ordered'`; `opts.tolerance` is the numeric tolerance (1e-6).
   */
  resultOf(oracle: OracleFn, opts?: { match?: MatchMode; tolerance?: number }): Assertion {
    const match = opts?.match ?? 'set';
    const tol = opts?.tolerance ?? 1e-6;
    return {
      describe: `result matches oracle${match === 'ordered' ? ' (ordered)' : ''}`,
      severity: 'error',
      needsResult: true,
      oracle,
      oracleMatch: match,
      check: async (ctx) => {
        if (ctx.query === null) return `result: model produced no valid query (${ctx.parseError ?? 'unknown'})`;
        const expected = normalize(await ctx.engine.run(oracle(ctx.engine)));
        const actual = await ctx.run();
        const cmp = compareResults(expected, actual, match, tol);
        return cmp.ok ? null : cmp.diff;
      },
    };
  },

  /** RESULT: the model's query returns exactly `n` rows. */
  rowCount(n: number): Assertion {
    return {
      describe: `row count ${n}`,
      severity: 'error',
      needsResult: true,
      check: async (ctx) => {
        if (ctx.query === null) return `row count: model produced no valid query`;
        const actual = await ctx.run();
        return actual.rows.length === n ? null : `expected ${n} row(s), got ${actual.rows.length}`;
      },
    };
  },

  /** RESULT: the model's rows satisfy `pred` (returns a reason or null). */
  rows(pred: (rows: unknown[][]) => string | null): Assertion {
    return {
      describe: 'rows predicate',
      severity: 'error',
      needsResult: true,
      check: async (ctx) => {
        if (ctx.query === null) return `rows: model produced no valid query`;
        const actual = await ctx.run();
        return pred(actual.rows);
      },
    };
  },

  /**
   * OR-GROUP: a single assertion that PASSES if ANY `child` passes — for a request
   * with several equally-valid constructs (e.g. `a.anyOf(a.cte(), a.subquery())`).
   * Defaults to `'warn'` (wrap in `a.require(...)` to make it a correctness gate);
   * `needsResult` is true iff any child needs a result. The matched child's
   * `describe` is recorded in `matchInfo` for the log trail (or `null` on failure).
   */
  anyOf(...children: Assertion[]): Assertion {
    if (children.length === 0) throw new Error('a.anyOf requires ≥1 child assertion');
    const matchInfo: { matched: string | null } = { matched: null };
    return {
      describe: `any of: ${children.map((c) => c.describe).join(' | ')}`,
      severity: 'warn',
      needsResult: children.some((c) => c.needsResult),
      matchInfo,
      check: async (ctx) => {
        matchInfo.matched = null;
        const reasons: string[] = [];
        for (const child of children) {
          const reason = await child.check(ctx);
          if (reason === null) {
            matchInfo.matched = child.describe;
            return null;
          }
          reasons.push(`${child.describe} (${reason})`);
        }
        return `none matched — ${reasons.join('; ')}`;
      },
    };
  },

  /** Promote an assertion to a CORRECTNESS gate (`'error'`) — when the SHAPE
   *  genuinely matters (a structural-only case, or an OR-group that must hold). */
  require(assertion: Assertion): Assertion {
    return { ...assertion, severity: 'error' };
  },

  /** Demote an assertion to ADVISORY (`'warn'`) — evaluated + logged, never fails. */
  warn(assertion: Assertion): Assertion {
    return { ...assertion, severity: 'warn' };
  },
};

export type { QueryShape };
