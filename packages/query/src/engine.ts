/**
 * QueryEngine — the minimal engine surface needed by resolution + validation
 * THIS PHASE (Phase 2).
 *
 * It holds the `Registry`, exposes type / function lookup, carries an
 * optional `embedder` slot (used by semantic exprs in Phase 4), builds the
 * root `QueryScope`, and offers top-level `resolveExpr` / `validateExpr`
 * entry points.
 *
 * Phase 4 added `cost(query)` + `checkCost(query, constraints)` and the
 * optional `constraints` arg on `validateQuery`. Still deliberately absent:
 *   - `toSQL(query, …)`   → Phase 5 (SQL converter)
 * Do not add a stub for it here; introduce it with its phase so the signature
 * can reference the real Dialect types.
 */
import type { ExprDef, QueryDef } from './schema';
import type { Registry } from './registry';
import type { Type } from './type';
import {
  Backing,
  hasFieldDefault,
  resolveFieldDefault,
  type TypeBacking,
  type FieldBacking,
  type JoinBacking,
  type SearchBacking,
  type SemanticBacking,
  type DefaultCondition,
  type DefaultOrder,
} from './backing';
import type { ResolvedType } from './resolved-type';
import type { ValidateContext } from './expr';
import type { Cost, CostConstraints } from './cost';
import { reportCostProblems } from './cost';
import type { Query, QueryResult, QueryResultArray } from './queries/query';
import { toArrayRows } from './queries/query';
import type { TypeExecutor } from './runtime/executor';
import type { FunctionRun } from './runtime/functions';
import { Expr, ROOT_VALIDATE_CONTEXT } from './expr';
import { QueryScope } from './scope';
import { Problems } from './problem';
import { QueryFunction } from './function';
import { RuntimeContext, type RuntimeOptions } from './runtime/context';
import type { SourceRow } from './runtime/row';
import type { Value } from './runtime/value';
import type { Dialect } from './sql/dialect';
import type { RlsProvider } from './sql/rls';
import type { SqlValue, RenderedSql } from './sql/emit';
import { SqlContext } from './sql/emit';
import { JoinCtePlanner } from './sql/planner';

/**
 * Pluggable text-embedding provider. Semantic similarity exprs (Phase 4) use
 * it to embed natural-language queries. Optional — only semantic features
 * require one.
 */
export interface Embedder {
  /** Embed `text` into a dense vector. */
  embed(text: string): Promise<number[]>;
}

/** Options for constructing a {@link QueryEngine} (embedder, executors, backings). */
export interface QueryEngineOptions {
  /** Optional embedder for semantic features. */
  embedder?: Embedder;
  /** Per-Type data + validation providers, keyed by Type name. */
  executors?: Record<string, TypeExecutor>;
  /**
   * Convenience dev-side `TypeBacking`s keyed by Type name. Equivalent to
   * `registry.registerType(type, backing)`, but handy when an engine wires its
   * backings separately from registration. A backing here takes precedence over
   * one stored on the registry for the same Type.
   */
  backings?: Record<string, TypeBacking>;
}

/**
 * The query engine: holds the {@link Registry}, exposes type / function lookup,
 * and is the entry point for resolve / validate / cost / run / toSQL.
 */
export class QueryEngine {
  /** The registry of types, field types, exprs, queries, dialects, and functions. */
  readonly registry: Registry;
  /** Optional embedding provider (semantic features, Phase 4). */
  readonly embedder?: Embedder;

  /** Cache of parsed runtime functions, keyed by name. */
  private readonly functionCache = new Map<string, QueryFunction>();
  /** Per-Type executors (data + validation hooks). */
  private readonly executors = new Map<string, TypeExecutor>();
  /** Convenience dev-side backings (precede the registry's), keyed by Type name. */
  private readonly configBackings = new Map<string, TypeBacking>();

  constructor(registry: Registry, options: QueryEngineOptions = {}) {
    this.registry = registry;
    this.embedder = options.embedder;
    if (options.executors) {
      for (const name of Object.keys(options.executors)) {
        this.executors.set(name, options.executors[name]!);
      }
    }
    if (options.backings) {
      for (const name of Object.keys(options.backings)) {
        this.configBackings.set(name, options.backings[name]!);
      }
    }
  }

  /** Register (or replace) the executor for a Type. Chainable. */
  registerExecutor(typeName: string, executor: TypeExecutor): this {
    this.executors.set(typeName, executor);
    return this;
  }

  /** The executor for a Type name, if one is registered. */
  executor(typeName: string): TypeExecutor | undefined {
    return this.executors.get(typeName);
  }

  /** A function's runtime implementation, if registered on the registry. */
  functionRun(name: string): FunctionRun | undefined {
    return this.registry.functionRun(name);
  }

  // ─── Lookups ─────────────────────────────────────────────────────────────

  /** Look up a registered Type by name. */
  type(name: string): Type | undefined {
    return this.registry.type(name);
  }

  // ─── Type backing (computed fields / RLS / FLS / source name) ─────────────

  /**
   * The parsed `Backing` wrapper for `typeName`, or `undefined` when the Type
   * has no backing. A config backing (from `QueryEngineOptions.backings`) takes
   * precedence over one registered on the registry.
   */
  backing(typeName: string): Backing | undefined {
    const def = this.configBackings.get(typeName) ?? this.registry.backing(typeName);
    return def ? new Backing(typeName, def) : undefined;
  }

  /** The raw `TypeBacking` for `typeName`, or `undefined`. */
  typeBacking(typeName: string): TypeBacking | undefined {
    return this.backing(typeName)?.def;
  }

  /** The `FieldBacking` for `typeName.field`, or `undefined` for a plain column. */
  fieldBacking(typeName: string, field: string): FieldBacking | undefined {
    return this.backing(typeName)?.fieldBacking(field);
  }

  /** The named `JoinBacking` `name` declared on `typeName`'s backing, or `undefined`. */
  joinBacking(typeName: string, name: string): JoinBacking | undefined {
    return this.backing(typeName)?.join(name);
  }

  /**
   * The soft, suppressible `DefaultCondition`s declared on `typeName`'s backing
   * (empty when none). Each is ANDed into a row-filtering op's WHERE per bound
   * occurrence unless the query lifts it — see {@link DefaultCondition}.
   */
  defaultConditions(typeName: string): readonly DefaultCondition[] {
    return this.backing(typeName)?.defaultConditions() ?? [];
  }

  /**
   * The NATURAL default order declared on `typeName`'s backing (see
   * {@link DefaultOrder}), or `undefined` when none. A SELECT whose FROM binds
   * this Type synthesizes its `ORDER BY` from this when it specifies none and
   * ordering is meaningful — see `SelectQuery`.
   */
  defaultOrder(typeName: string): DefaultOrder | undefined {
    return this.backing(typeName)?.defaultOrder();
  }

  /**
   * Whether `typeName.field` has a `FieldBacking.default` (making it
   * optional-on-insert and runtime-materialized when omitted).
   */
  fieldHasDefault(typeName: string, field: string): boolean {
    return hasFieldDefault(this.fieldBacking(typeName, field));
  }

  /**
   * Materialize `typeName.field`'s `FieldBacking.default` into a `Value`
   * (awaiting a factory), or `undefined` when the field has no default.
   */
  fieldDefault(typeName: string, field: string): Promise<Value | undefined> {
    return resolveFieldDefault(this.fieldBacking(typeName, field));
  }

  /**
   * The `SearchBacking` in effect for `typeName` (optionally its `field`), or
   * `undefined` when none. A FIELD-level `FieldBacking.search` overrides the
   * whole-type `TypeBacking.search`; a whole-type / fieldless lookup uses only
   * the type-level backing.
   */
  searchBacking(typeName: string, field?: string): SearchBacking | undefined {
    const backing = this.backing(typeName);
    if (!backing) return undefined;
    if (field !== undefined) {
      const fieldSearch = backing.fieldBacking(field)?.search;
      if (fieldSearch) return fieldSearch;
    }
    return backing.def.search;
  }

  /**
   * The `SemanticBacking` in effect for `typeName` (optionally its `field`), or
   * `undefined` when none. A FIELD-level `FieldBacking.semantic` overrides the
   * whole-type `TypeBacking.semantic`; a whole-type / fieldless lookup uses only
   * the type-level backing.
   */
  semanticBacking(typeName: string, field?: string): SemanticBacking | undefined {
    const backing = this.backing(typeName);
    if (!backing) return undefined;
    if (field !== undefined) {
      const fieldSemantic = backing.fieldBacking(field)?.semantic;
      if (fieldSemantic) return fieldSemantic;
    }
    return backing.def.semantic;
  }

  /**
   * The real underlying source name to emit in SQL `FROM` / joins for a Type:
   * its backing's `name` when set, else the Type name itself (so a backed Type
   * emits `<realName> AS <typeName>` and references still use the Type name).
   */
  sourceTable(typeName: string): string {
    return this.backing(typeName)?.sourceName() ?? typeName;
  }

  /**
   * Look up a function by name as a parsed `QueryFunction`, or `undefined`.
   * Wraps the registry's JSON `FunctionDef` once and caches the instance.
   */
  lookupFunction(name: string): QueryFunction | undefined {
    const cached = this.functionCache.get(name);
    if (cached) return cached;
    const def = this.registry.function(name);
    if (!def) return undefined;
    const fn = QueryFunction.from(def, this.registry);
    this.functionCache.set(name, fn);
    return fn;
  }

  // ─── Scope ──────────────────────────────────────────────────────────────

  /** Create a fresh root scope (with its own shared `ParamSet`). */
  globalScope(): QueryScope {
    return new QueryScope();
  }

  // ─── Entry points ─────────────────────────────────────────────────────────

  /** Parse a JSON expr def into an `Expr` via the registry. */
  parse(expr: ExprDef): Expr {
    return this.registry.parseExpr(expr);
  }

  /** Parse a JSON query def into a `Query` via the registry. */
  parseQuery(query: QueryDef): Query {
    return this.registry.parseQuery(query);
  }

  /**
   * Coerce a `Query | QueryDef` into a parsed `Query` (no cast — a structural
   * `'execute' in query` narrows an already-parsed instance from its JSON def).
   * Used where a backing supplies either form (e.g. a LATERAL subquery factory).
   */
  coerceQuery(query: Query | QueryDef): Query {
    return 'execute' in query ? query : this.registry.parseQuery(query);
  }

  /** Coerce a `Query | QueryDef` into a parsed `Query`. */
  private toQuery(query: Query | QueryDef): Query {
    // Lazily materialize inverse relations before any resolve/validate/run/
    // cost/toSQL path observes the registered Types (idempotent).
    this.registry.finalize();
    return 'execute' in query ? query : this.registry.parseQuery(query);
  }

  // ─── Query resolve / validate / run (Phase 3) ────────────────────────────

  /** Resolve a query's output type against a scope (root scope if omitted). */
  resolveQuery(query: Query | QueryDef, scope?: QueryScope): ResolvedType {
    return this.toQuery(query).resolve(this, scope ?? this.globalScope());
  }

  /**
   * Validate a query: structural walk + accumulated param diagnostics + each
   * referenced Type's executor `validate` hook. When `constraints` are
   * supplied, the estimated `cost` is checked too and `cost.rows-exceeded` /
   * `cost.bytes-exceeded` problems are appended (opt-in).
   */
  validateQuery(
    query: Query | QueryDef,
    scope?: QueryScope,
    constraints?: CostConstraints,
  ): Problems {
    const q = this.toQuery(query);
    const s = scope ?? this.globalScope();
    const p = new Problems();
    q.validateWalk(this, s, p, ROOT_VALIDATE_CONTEXT);
    s.params.problems(p);
    for (const name of q.referencedTypes()) {
      const ex = this.executor(name);
      ex?.validate?.(q, p);
    }
    if (constraints) reportCostProblems(q.cost(this, s), constraints, p);
    return p;
  }

  /** Estimate a query's `{ rows, bytes }` cost against a scope (root if omitted). */
  cost(query: Query | QueryDef, scope?: QueryScope): Cost {
    return this.toQuery(query).cost(this, scope ?? this.globalScope());
  }

  /**
   * Check a query's estimated cost against `constraints`, returning any
   * `cost.rows-exceeded` / `cost.bytes-exceeded` problems (and nothing else).
   * A standalone entry point so callers can cost-bound a query without a full
   * structural re-validation.
   */
  checkCost(
    query: Query | QueryDef,
    constraints: CostConstraints,
    scope?: QueryScope,
  ): Problems {
    const p = new Problems();
    reportCostProblems(this.cost(query, scope), constraints, p);
    return p;
  }

  /**
   * Run a query in-memory, returning its rows + resolved output metadata.
   *
   * By default rows come back as OBJECTS (`SourceRecord[]`). Passing
   * `opts.rows === 'array'` returns rows as plain POSITIONAL arrays
   * (`JsonValue[][]`), each inner array aligned to `result.fields` order — the
   * same data, transposed to a compact tabular form. Overloads make the return
   * type precise per `opts.rows`, so the default object path is never widened
   * to a union.
   */
  async run(query: Query | QueryDef, options?: RuntimeOptions): Promise<QueryResult>;
  async run(
    query: Query | QueryDef,
    options: RuntimeOptions | undefined,
    opts: { rows: 'array' },
  ): Promise<QueryResultArray>;
  async run(
    query: Query | QueryDef,
    options: RuntimeOptions | undefined,
    opts: { rows?: 'object' },
  ): Promise<QueryResult>;
  async run(
    query: Query | QueryDef,
    options?: RuntimeOptions,
    opts?: { rows?: 'object' | 'array' },
  ): Promise<QueryResult | QueryResultArray> {
    // Coerce → run. Execution-time `filters` (keyed by source) + `includeTotal`
    // ride on the RuntimeContext; the `filters` placeholders read their clauses
    // dynamically, so the caller's query is never mutated.
    const q = this.toQuery(query);
    const ctx = new RuntimeContext(this, options);
    const result = await q.execute(ctx);
    if (opts?.rows === 'array') {
      // Transpose object-rows into positional arrays aligned to `fields`; every
      // other field (fields / outputType / affected / total) carries over.
      const arrayResult: QueryResultArray = {
        ...result,
        rows: toArrayRows(result.fields, result.rows),
      };
      return arrayResult;
    }
    return result;
  }

  // ─── SQL conversion (Phase 5) ─────────────────────────────────────────────

  /**
   * Convert a query to SQL for a named (or supplied) dialect, returning the
   * SQL string + ordered bind parameters. `opts.rls` injects per-Type RLS
   * predicates; `opts.params` supplies values for named bind parameters;
   * `opts.filters` (keyed by source) feeds the `filters` placeholders' clauses;
   * `opts.includeTotal` emits the `COUNT(*) OVER () AS "$total"` column on the
   * top-level SELECT.
   */
  toSQL(
    query: Query | QueryDef,
    dialect: string | Dialect,
    opts?: {
      rls?: RlsProvider;
      params?: Readonly<Record<string, SqlValue>>;
      filters?: Record<string, ExprDef | Expr | null>;
      includeTotal?: boolean;
    },
  ): { sql: string; params: SqlValue[] } {
    const d = typeof dialect === 'string' ? this.registry.dialect(dialect) : dialect;
    if (!d) throw new Error(`QueryEngine.toSQL: unknown dialect '${String(dialect)}'.`);
    const q = this.toQuery(query);
    const scope = this.globalScope();
    const params = opts?.params ?? {};
    const planner = new JoinCtePlanner(d, this, opts?.rls, params);
    // Thread the execution-time filter exprs (parsed once, keyed by source) +
    // includeTotal onto the context so the `filters` placeholders and the
    // `$total` column read them.
    const ctx = new SqlContext(d, this, scope, planner, opts?.rls, false, params, this.parseFilters(opts?.filters), opts?.includeTotal ?? false, true);
    const rendered = q.toSQL(d, ctx).render(d);
    return { sql: rendered.sql, params: [...rendered.params] };
  }

  /**
   * Parse an execution-time filter map (`source → ExprDef | Expr | null`) into a
   * map of bound `Expr`s, dropping `null` / absent entries. A `filters`
   * placeholder over a source with no entry emits a vacuous `TRUE`.
   */
  parseFilters(filters?: Record<string, ExprDef | Expr | null>): Record<string, Expr> {
    const out: Record<string, Expr> = {};
    if (!filters) return out;
    for (const source of Object.keys(filters)) {
      const def = filters[source];
      if (def == null) continue;
      out[source] = def instanceof Expr ? def : this.registry.parseExpr(def);
    }
    return out;
  }

  /** Coerce an `Expr | ExprDef` into a parsed `Expr` (no cast — `instanceof`). */
  private toExpr(expr: Expr | ExprDef): Expr {
    // Lazily materialize inverse relations before resolution / validation.
    this.registry.finalize();
    return expr instanceof Expr ? expr : this.registry.parseExpr(expr);
  }

  /** Resolve an expression's type against a scope (root scope if omitted). */
  resolveExpr(expr: Expr | ExprDef, scope?: QueryScope): ResolvedType {
    return this.toExpr(expr).resolve(this, scope ?? this.globalScope());
  }

  /**
   * Validate an expression, returning accumulated Problems. A partial
   * `ValidateContext` may override the default (e.g. `allowAggregate: false`
   * to assert aggregate-placement diagnostics). Param diagnostics are
   * appended after the structural walk.
   */
  validateExpr(
    expr: Expr | ExprDef,
    scope?: QueryScope,
    ctx?: Partial<ValidateContext>,
  ): Problems {
    const e = this.toExpr(expr);
    const s = scope ?? this.globalScope();
    const p = new Problems();
    e.validateWalk(this, s, p, { ...ROOT_VALIDATE_CONTEXT, ...ctx });
    s.params.problems(p);
    return p;
  }

  /**
   * Evaluate a standalone expression against the in-memory runtime, returning
   * its `Value`. Accepts either a built `Expr` (e.g. from the `e.*` builder) or
   * a raw `ExprDef` (parsed first). The optional `row` binds source records the
   * expression reads (`{ task: { done: true } }`); it defaults to an empty row
   * so a constant / predicate expr still evaluates. `opts` seeds the
   * `RuntimeContext` (bound params, filters, embedder, …).
   */
  async evaluateExpr(
    expr: Expr | ExprDef,
    row?: SourceRow,
    opts?: RuntimeOptions,
  ): Promise<Value> {
    const e = this.toExpr(expr);
    const ctx = new RuntimeContext(this, opts);
    return e.evaluate(ctx, row ?? {});
  }

  /**
   * Emit a standalone expression as SQL for a named (or supplied) dialect,
   * returning the rendered SQL string + ordered bind params. Accepts either a
   * built `Expr` or a raw `ExprDef` (parsed first). Reuses the same context
   * construction path as `toSQL`: `opts.params` supplies bound param values,
   * `opts.rls` a predicate provider, `opts.filters` (keyed by source) the
   * `filters` placeholders' clauses. Literals / params emit bind parameters
   * (never string-interpolated).
   */
  exprToSQL(
    expr: Expr | ExprDef,
    dialect: string | Dialect,
    opts?: {
      rls?: RlsProvider;
      params?: Readonly<Record<string, SqlValue>>;
      filters?: Record<string, ExprDef | Expr | null>;
    },
  ): RenderedSql {
    const d = typeof dialect === 'string' ? this.registry.dialect(dialect) : dialect;
    if (!d) throw new Error(`QueryEngine.exprToSQL: unknown dialect '${String(dialect)}'.`);
    const e = this.toExpr(expr);
    const scope = this.globalScope();
    const params = opts?.params ?? {};
    const planner = new JoinCtePlanner(d, this, opts?.rls, params);
    const ctx = new SqlContext(d, this, scope, planner, opts?.rls, false, params, this.parseFilters(opts?.filters), false);
    return e.toSQL(d, ctx).render(d);
  }
}
