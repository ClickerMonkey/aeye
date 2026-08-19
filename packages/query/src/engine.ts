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
import type { ExprDef, JsonValue, QueryDef, SortSelectionDef } from './schema';
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
import type { Affected, Cost, CostConstraints, CostContext } from './cost';
import { reportCostProblems, foldChanges, NEVER_CHANGES } from './cost';
import type { Query, QueryReferences, QueryResult, QueryResultArray } from './queries/query';
import type { ParamInfo } from './param';
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
import type { SqlValue, SqlParamValue, RenderedSql } from './sql/emit';
import { SqlContext } from './sql/emit';
import { JoinCtePlanner } from './sql/planner';
import type { SemanticTextToVector, SemanticEmbeddings } from './vector-text';
import { embeddingResolver, toVectorText } from './vector-text';
import { DEFAULT_TEXT_CASING, type TextCasing } from './text-casing';

/**
 * Pluggable text-embedding provider. Semantic similarity exprs (Phase 4) use
 * it to embed natural-language queries. Optional — only semantic features
 * require one.
 */
export interface Embedder {
  /** Embed `text` into a dense vector. */
  embed(text: string): Promise<number[]>;
}

/** Options for constructing a {@link QueryEngine} (embedder, executors, backings, text casing). */
export interface QueryEngineOptions {
  /** Optional embedder for semantic features. */
  embedder?: Embedder;
  /**
   * The DEFAULT {@link TextCasing} for text columns that declare none — the
   * deployment-wide answer to "does `'Ada' = 'ada'` hold, and who folds?".
   * Defaults to {@link DEFAULT_TEXT_CASING} (`'fold'`, this package's behaviour
   * in every release before the option existed).
   *
   * Set it once, here, rather than on every declaration; a field that declares
   * its own `casing` still wins, because collation is genuinely a per-COLUMN
   * fact and this default only ever speaks for the columns that said nothing.
   *
   * A deployment whose text columns are mostly identifiers, codes, uuids or
   * enums wants `'exact'`: folding them is semantically pointless, it makes
   * every predicate over them non-sargable, and on PostgreSQL a `LOWER()` over
   * a physical `uuid` column does not merely deoptimise — the function does not
   * exist for that type and the statement errors.
   */
  textCasing?: TextCasing;
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
 * The optional execution-time selections a query may be COSTED with, mirroring
 * the `filters` / `sort` accepted by `run` / `toSQL`. Supplying them lets a
 * `filters` / `sorter` placeholder weave the real supplied predicate / sort into
 * the estimate instead of contributing nothing.
 */
export interface CostOptions {
  /** Execution-time filter predicates per source (authored `ExprDef` or parsed `Expr`). */
  filters?: Record<string, ExprDef | Expr | null>;
  /** Execution-time dynamic-sort selection, woven into a `sorter`'s cost. */
  sort?: SortSelectionDef[];
  /** Execution-time param VALUES, so a param-bound LIMIT / OFFSET resolves in `outputCost`. */
  params?: Readonly<Record<string, JsonValue>>;
}

/** The dialect-agnostic SQL-emit options common to {@link QueryEngine.toSQL} / {@link QueryEngine.semanticTexts}. */
export interface BaseSqlOptions {
  /** Per-Type RLS predicate provider. */
  rls?: RlsProvider;
  /** Values for named bind parameters (name → scalar, or a relation `{ pk }` object). */
  params?: Readonly<Record<string, SqlParamValue>>;
  /** Execution-time filter predicates per source (authored `ExprDef` or parsed `Expr`). */
  filters?: Record<string, ExprDef | Expr | null>;
  /** Execution-time dynamic-sort selection, feeding a SELECT `order`'s `sorter`. */
  sort?: SortSelectionDef[];
  /**
   * Emit `COUNT(*) OVER () AS "$total"` on the ENTRY SELECT — and ONLY there.
   * Every nesting boundary clears it, because `$total` is a PROJECTED column: an
   * arm's `$total` participates in a set operation's comparison and silently
   * changes the ROWS (UNION stops de-duplicating; INTERSECT / EXCEPT compare
   * counts they were never meant to see), and a CTE body would pay a window
   * aggregate nothing selects. A query whose ENTRY is a SET OPERATION therefore
   * emits no `$total` at all — matching `run`, which reports none. Wrap it in a
   * SELECT over a `subquery` source when a paged set operation needs a count.
   */
  includeTotal?: boolean;
}

/** Options for {@link QueryEngine.toSQL}. */
export interface ToSqlOptions extends BaseSqlOptions {
  /**
   * Precomputed text→vector cache (see {@link SemanticEmbeddings}) for every
   * `semantic(...)` text term — the vectors the caller obtained by embedding the
   * terms {@link QueryEngine.semanticTexts} returned. Each such term is
   * looked up here, formatted to pgvector TEXT, and bound (all SYNC). A needed
   * term ABSENT from the cache throws (never a silently mis-bound
   * `'<text>'::vector`); an already-`[…]` vector-text term needs no entry.
   */
  embeddings?: SemanticEmbeddings;
}

/**
 * A syntactically valid pgvector TEXT literal bound during {@link
 * QueryEngine.semanticTexts}'s discarded COLLECTING pass, so rendering
 * that pass never fails on a placeholder. The pass's SQL is thrown away; only the
 * set of requested semantic terms is kept.
 */
const PLACEHOLDER_VECTOR_TEXT = '[0]';

/**
 * The query engine: holds the {@link Registry}, exposes type / function lookup,
 * and is the entry point for resolve / validate / cost / run / toSQL.
 */
export class QueryEngine {
  /** The registry of types, field types, exprs, queries, dialects, and functions. */
  readonly registry: Registry;
  /** Optional embedding provider (semantic features, Phase 4). */
  readonly embedder?: Embedder;
  /**
   * The default {@link TextCasing} for text columns that declare none. Read by
   * BOTH emission roads — `ComparisonExpr` / `ArrayOpExpr` / `text-search` /
   * `text-score` reach it through `SqlContext.engine` and
   * `RuntimeContext.engine` — which is why the policy lives on the engine and
   * not on a `Dialect` (an argument to `toSQL`, invisible to the runtime).
   */
  readonly textCasing: TextCasing;
  /**
   * The NEUTRAL cost context over this engine — no execution-time `filters` /
   * `sort` / `params`.
   *
   * Used wherever a RESOLUTION path has to estimate: a DERIVED source sizes the
   * synthetic Type it binds from its own body (`QuerySource.resolvedType`, a CTE
   * name's binding — A18). Neutral on purpose, for two reasons. Those selections
   * belong to the ENCLOSING query — `engine.run` ANDs a `filters` predicate into
   * a select's WHERE by source name, and neither it nor a `sort` reaches inside a
   * derived table — and one shared instance gives every such estimate a single
   * identity to memoize against (see `ScopeMemo`), which is what keeps a deeply
   * nested statement's resolution linear. The consequence to know: a `LIMIT` bound
   * to a PARAM *inside* a CTE body / derived table is estimated UNCAPPED (the
   * conservative direction); one on the statement's own `final` still resolves,
   * because that is costed with the caller's real context.
   */
  readonly neutralCost: CostContext = { engine: this };

  /** Cache of parsed runtime functions, keyed by name. */
  private readonly functionCache = new Map<string, QueryFunction>();
  /** Per-Type executors (data + validation hooks). */
  private readonly executors = new Map<string, TypeExecutor>();
  /** Convenience dev-side backings (precede the registry's), keyed by Type name. */
  private readonly configBackings = new Map<string, TypeBacking>();

  constructor(registry: Registry, options: QueryEngineOptions = {}) {
    this.registry = registry;
    this.embedder = options.embedder;
    this.textCasing = options.textCasing ?? DEFAULT_TEXT_CASING;
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
   * `cost.bytes-exceeded` problems are appended (opt-in). When `options.params`
   * are supplied, the VALUES are checked against the type each param's uses
   * require, appending `param.value` / `param.missing` / `param.unknown` (also
   * opt-in — see {@link checkParams}).
   */
  validateQuery(
    query: Query | QueryDef,
    scope?: QueryScope,
    constraints?: CostConstraints,
    options?: CostOptions,
  ): Problems {
    const q = this.toQuery(query);
    const s = scope ?? this.globalScope();
    const p = new Problems();
    q.validateWalk(this, s, p, ROOT_VALIDATE_CONTEXT);
    s.params.problems(p);
    if (options?.params) s.params.checkValues(p, options.params);
    for (const name of q.referencedTypes()) {
      const ex = this.executor(name);
      ex?.validate?.(q, p);
    }
    if (constraints) reportCostProblems(q.cost(this.costContext(options), s), constraints, p);
    return p;
  }

  /**
   * The full introspection of a query's bind PARAMETERS: for each, every place
   * it is used, what each use requires of it, the type MERGED from those uses,
   * and the conflict when they have none. The rich counterpart to
   * `Query.params()` (which reports the minimal `{ name, type }` a caller
   * binds with) — read this to EXPLAIN a param rather than to bind one.
   *
   * A param's type is the MEET of its uses, i.e. the most specific type
   * compatible with all of them: compared against an `enum` in one place and
   * plain `text` in another it is the ENUM, and it is that answer regardless of
   * which use the walk reached first.
   */
  parameters(query: Query | QueryDef, scope?: QueryScope): ParamInfo[] {
    return this.toQuery(query).paramInfo(this, scope);
  }

  /**
   * Check SUPPLIED param values against what the query's uses of each param
   * require — the PRE-EXECUTION gate for a binding, and the only place a bound
   * value is compared with the type it is bound into. Returns the value
   * problems and nothing else (a standalone entry point, mirroring
   * {@link checkCost}); the param TYPE problems — `param.untyped` /
   * `param.conflict` — come from {@link validateQuery}.
   *
   * `param.value` (error) is a value that does not satisfy the merged type;
   * `param.missing` (warning) is a typed param with no value, which binds SQL
   * NULL; `param.unknown` (warning) is a value supplied under a name the query
   * has no param for. Reported as Problems rather than thrown, so a bad binding
   * reads like every other diagnostic — and so `run` / `toSQL` stay unchanged:
   * they do NOT validate, because a hot path that can only throw is not the
   * place to discover this.
   */
  checkParams(
    query: Query | QueryDef,
    params: Readonly<Record<string, JsonValue | undefined>>,
    scope?: QueryScope,
  ): Problems {
    const p = new Problems();
    this.toQuery(query).walkParams(this, scope).params.checkValues(p, params);
    return p;
  }

  /**
   * Estimate a query's `{ rows, bytes }` cost against a scope (root if omitted).
   * `options` may supply the execution-time `filters` / `sort` the query is
   * costed WITH, so a `filters` / `sorter` placeholder weaves the real supplied
   * predicate / sort into the estimate (a subquery in a filter then raises the
   * cost, as it should).
   */
  cost(query: Query | QueryDef, scope?: QueryScope, options?: CostOptions): Cost {
    return this.toQuery(query).cost(this.costContext(options), scope ?? this.globalScope());
  }

  /**
   * Estimate the SIZE OF THE RESULT a query hands back — `{ rows, bytes }` where
   * `rows` is the delivered row count (post-WHERE / GROUP / DISTINCT, capped by a
   * literal or `options.params`-resolved LIMIT / OFFSET) and `bytes` sizes those
   * rows by the PROJECTION width (the selected columns), not the whole scanned
   * row. Contrast {@link cost}, which estimates the WORK to produce the result.
   */
  outputCost(query: Query | QueryDef, scope?: QueryScope, options?: CostOptions): Cost {
    return this.toQuery(query).outputCost(this.costContext(options), scope ?? this.globalScope());
  }

  /**
   * Estimate the rows a statement MUTATES — a total plus a per-Type breakdown
   * ({@link Affected}). An UPDATE / DELETE uses the target Type's indexes +
   * selectivity (OR-aware) to count the rows its WHERE matches; an INSERT counts
   * its VALUES / source rows; a CTE SUMS every data-modifying entry plus its
   * final query per Type. Read-only queries report `{ rows: 0, types: [] }`.
   * `options.params` resolves a param-bound LIMIT where used.
   */
  affected(query: Query | QueryDef, scope?: QueryScope, options?: CostOptions): Affected {
    return this.toQuery(query).affected(this.costContext(options), scope ?? this.globalScope());
  }

  /**
   * Estimate how long (ms) until the DATA behind a query could change — a
   * freshness / cache-TTL signal. Uses {@link Query.references} (so it counts
   * ONLY the Types / fields the query actually reads, plus execution-time
   * `filters` / selected `sort` exprs and invoked functions) and folds their
   * `changes` rates: `0` (always changing) dominates, a negative (never) is
   * ignored, else the FASTEST positive interval wins. Each read Type contributes
   * its row-level rate; a read field with its OWN rate refines it; a called
   * function (e.g. `currentDate()`) contributes its volatility. A query over only
   * immutable data / pure literals returns `-1`.
   */
  /**
   * Enumerate what a query READS — its {@link QueryReferences} of Types, specific
   * fields, and DB functions — including execution-time `filters` predicates and
   * the `sort`-selected sorter exprs (from `options`). Powers `changeInterval`
   * and lets a caller inspect the exact surface a query touches.
   */
  references(query: Query | QueryDef, scope?: QueryScope, options?: CostOptions): QueryReferences {
    this.registry.finalize();
    return this.toQuery(query).references(this, scope ?? this.globalScope(), this.costContext(options));
  }

  changeInterval(query: Query | QueryDef, scope?: QueryScope, options?: CostOptions): number {
    this.registry.finalize();
    const refs = this.toQuery(query).references(this, scope ?? this.globalScope(), this.costContext(options));
    let acc = NEVER_CHANGES;
    for (const name of refs.types) {
      const type = this.type(name);
      if (type) acc = foldChanges(acc, type.changes);
    }
    for (const ref of refs.fields) {
      const changes = this.type(ref.type)?.field(ref.field)?.changes();
      if (changes !== undefined) acc = foldChanges(acc, changes);
    }
    for (const name of refs.functions) {
      const fn = this.lookupFunction(name);
      if (fn) acc = foldChanges(acc, fn.changes);
    }
    return acc;
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
    options?: CostOptions,
  ): Problems {
    const p = new Problems();
    reportCostProblems(this.cost(query, scope, options), constraints, p);
    return p;
  }

  /**
   * Build the {@link CostContext} for a cost walk from optional execution-time
   * selections: the `filters` map is parsed once (source → bound `Expr`) exactly
   * as `run` / `toSQL` do; `sort` is the dynamic-sort selection. With neither, a
   * bare `{ engine }` context is returned (placeholders stay neutral).
   */
  private costContext(options?: CostOptions): CostContext {
    if (!options?.filters && !options?.sort && !options?.params) return { engine: this };
    const parsed = options.filters ? this.parseFilters(options.filters) : undefined;
    const filters = parsed ? new Map(Object.entries(parsed)) : undefined;
    return { engine: this, filters, sort: options.sort, params: options.params };
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
   * `opts.sort` (an ordered `{ sort, dir? }` list) feeds the `sorter` placeholders
   * in a SELECT `order`; `opts.includeTotal` emits the `COUNT(*) OVER () AS
   * "$total"` column on the ENTRY SELECT only (a set operation gets none — see
   * {@link BaseSqlOptions.includeTotal}).
   *
   * `opts.embeddings` is a precomputed text→vector cache (see {@link
   * SemanticEmbeddings}): a `semantic(...)` TEXT literal — or the value of a
   * `semantic(...)` text PARAM — is looked up there, formatted to a pgvector TEXT
   * literal (`[…]`), and bound (all synchronous). Obtain the terms to embed with
   * {@link semanticTexts}, embed them, fill the cache, then call this. A
   * plain-text semantic term with NO cache — or one MISSING from the cache —
   * THROWS (rather than emitting the invalid `'<text>'::vector`); a pre-embedded
   * `[…]` vector-text param is always bound as-is (never looked up).
   */
  toSQL(
    query: Query | QueryDef,
    dialect: string | Dialect,
    opts?: ToSqlOptions,
  ): { sql: string; params: SqlValue[] } {
    return this.emitSQL(query, dialect, opts, this.semanticConverter(opts?.embeddings));
  }

  /**
   * Extract the DISTINCT plain-text `semantic(...)` terms in `query` (+ the same
   * execution-time `opts` `toSQL` sees — `filters` / `params` can carry a semantic
   * text term) that need embedding, in a STABLE (first-seen) order. Give it a
   * query + params, get back the text to embed: embed each, fill a
   * {@link SemanticEmbeddings} cache, then pass that as `toSQL`'s `opts.embeddings`.
   *
   * Reuses `toSQL`'s exact emit walk (a discarded COLLECTING pass) rather than a
   * second walker, so it sees precisely the terms `toSQL` would bind. A term
   * already in pgvector TEXT form (`[…]`) needs no embedding and is NOT returned;
   * an absent / relation-`{ pk }` param value is not a semantic term and is
   * skipped.
   */
  semanticTexts(query: Query | QueryDef, opts?: BaseSqlOptions): string[] {
    // A `Set` dedupes while preserving first-seen (stable) order. The collecting
    // converter records each plain-text term and returns a valid placeholder
    // vector so the discarded render never fails on it.
    const terms = new Set<string>();
    const dialect = this.collectDialect();
    this.emitSQL(query, dialect, opts, (text) => {
      terms.add(text);
      return PLACEHOLDER_VECTOR_TEXT;
    });
    return [...terms];
  }

  /**
   * A dialect for the discarded {@link semanticTexts} pass. The rendered
   * SQL is thrown away and every dialect drives the same semantic-term walk (a
   * `semantic(...)` term's query side is emitted — hence collected — regardless of
   * dialect), so any registered dialect serves; the first is used.
   */
  private collectDialect(): Dialect {
    const d = this.registry.dialectList()[0];
    if (!d) throw new Error('QueryEngine.semanticTexts: no dialect registered.');
    return d;
  }

  /**
   * Build the INTERNAL sync `semanticText` seam (text → pgvector TEXT) the emit
   * path threads, from a precomputed {@link SemanticEmbeddings} cache: look the
   * term up and format its vector with {@link toVectorText}; a term MISSING from
   * the cache throws the same fail-loud error the emit path would (never a
   * silently mis-bound `'<text>'::vector`). Returns `undefined` when no cache was
   * supplied, so a plain-text term then hits the emit path's own "no embeddings"
   * throw.
   */
  private semanticConverter(embeddings: SemanticEmbeddings | undefined): SemanticTextToVector | undefined {
    if (!embeddings) return undefined;
    const resolve = embeddingResolver(embeddings);
    return (text) => {
      const vector = resolve(text);
      if (vector === undefined) {
        throw new Error(
          `QueryEngine.toSQL: no embedding supplied for the semantic term ${JSON.stringify(text)}. ` +
            `Collect the terms with 'engine.semanticTexts(query, opts)', embed each, and pass ` +
            `them via 'opts.embeddings' (a text→vector Map).`,
        );
      }
      return toVectorText(vector);
    };
  }

  /**
   * Shared SQL-emit core for {@link toSQL} / {@link semanticTexts}: resolve
   * the dialect, build the root {@link SqlContext} (threading params / filters /
   * sort / includeTotal + the SYNC `semanticText` converter), and render.
   */
  private emitSQL(
    query: Query | QueryDef,
    dialect: string | Dialect,
    opts: BaseSqlOptions | undefined,
    semanticText: SemanticTextToVector | undefined,
  ): { sql: string; params: SqlValue[] } {
    const d = typeof dialect === 'string' ? this.registry.dialect(dialect) : dialect;
    if (!d) throw new Error(`QueryEngine.toSQL: unknown dialect '${String(dialect)}'.`);
    const q = this.toQuery(query);
    const scope = this.globalScope();
    const params = opts?.params ?? {};
    const planner = new JoinCtePlanner(d, this, opts?.rls, params);
    // Thread the execution-time filter exprs (parsed once, keyed by source) + the
    // dynamic-sort selection + includeTotal + the semantic-text converter onto the
    // context so the `filters` / `sorter` placeholders, the `$total` column, and
    // a `semantic` term read them.
    const ctx = new SqlContext(d, this, scope, planner, opts?.rls, false, params, this.parseFilters(opts?.filters), opts?.includeTotal ?? false, true, opts?.sort ?? [], semanticText);
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
      params?: Readonly<Record<string, SqlParamValue>>;
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
