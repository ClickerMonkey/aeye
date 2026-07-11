/**
 * RuntimeContext — the per-run mutable state threaded through every
 * `evaluate` / `execute` call (the analogue of cletus's `QueryContext`).
 *
 * It holds:
 *  - lazily-loaded, transactional `TypeState` per Type (original / current /
 *    deleted / updated / inserted) so INSERT/UPDATE/DELETE see their own
 *    pending changes;
 *  - CTE result sets, keyed by name, that a FROM can read like a type;
 *  - bound param VALUES (param name → `Value`);
 *  - an optional embedder + embedding cache for semantic scoring;
 *  - a `correlation` row so a correlated subquery can see its outer row;
 *  - a recursion cap for recursive CTEs.
 */
import type { ExprDef, JsonValue, SortSelectionDef } from '../schema';
import type { QueryEngine } from '../engine';
import type { Type } from '../type';
import type { Embedder } from '../engine';
import type { Expr } from '../expr';
import type { RlsProvider } from '../sql/rls';
import { resolveAccessRun } from '../backing';
import { Value } from './value';
import type { SourceRecord, SourceRow } from './row';

/** Default safety cap on recursive-CTE iterations. */
export const DEFAULT_MAX_CTE_ITERATIONS = 1000;

/**
 * Transactional state for a single Type's type during a run. `current`
 * reflects all pending inserts/updates/deletes; `original` is the loaded
 * snapshot. The three change maps/sets are keyed by a record's identity.
 */
export interface TypeState {
  /** The Type this state belongs to. */
  type: Type;
  /** Rows as first loaded from the executor. */
  original: SourceRecord[];
  /** Rows including pending changes (what queries read). */
  current: SourceRecord[];
  /** Identity keys deleted during this run. */
  deleted: Set<string>;
  /** Identity key → the merged fields applied by updates. */
  updated: Map<string, SourceRecord>;
  /** Identity key → the fields of a row inserted during this run. */
  inserted: Map<string, SourceRecord>;
}

/** Options used to seed a `RuntimeContext` (typically from `engine.run`). */
export interface RuntimeOptions {
  /** Bound param values (name → JSON value). */
  params?: Record<string, JsonValue>;
  /**
   * Execution-time filter EXPRS, KEYED BY SOURCE NAME — each a BOOLEAN
   * `ExprDef` / `Expr`, or `null` (no filter). The `filters` placeholder bound
   * to a `source` reads its expr here and AND-folds it into the WHERE; a source
   * with no entry (or `null`) yields a vacuous TRUE. The caller's query is never
   * mutated. Use `query.filters(engine)` to introspect which sources a query
   * exposes and their filterable fields.
   */
  filters?: Record<string, ExprDef | Expr | null>;
  /**
   * Execution-time DYNAMIC-SORT selection — an ORDERED list of `{ sort, dir? }`
   * (multi-key priority; `dir` defaults to `'asc'`). Each `sort` names one of a
   * `sorter` placeholder's declared `sorts`; the sorter EXPANDS the selection into
   * concrete ORDER BY terms at execution time. With no selection a sorter falls
   * back to its `defaultSort`. Use `query.sorters(engine)` to introspect the sort
   * names a query exposes and their orderable types. Mirrors `engine.toSQL({ sort })`.
   */
  sort?: SortSelectionDef[];
  /**
   * Row-level-security provider for the in-memory runtime: a Type's rows are
   * filtered on load by `provider.predicateFor(typeName, typeName)` (AND-ed with
   * any `TypeBacking.access`). Mirrors `engine.toSQL({ rls })` for SQL.
   */
  rls?: RlsProvider;
  /**
   * When true, a top-level SELECT also reports `total` — the result count after
   * WHERE/JOIN/GROUP/HAVING/DISTINCT but BEFORE limit/offset.
   */
  includeTotal?: boolean;
  /** Embedder override (defaults to the engine's). */
  embedder?: Embedder;
  /** Per-record embedding lookup for semantic scoring. */
  recordEmbedding?: (source: string, id: JsonValue) => Promise<number[] | null>;
  /** Cap on recursive-CTE iterations. */
  maxCteIterations?: number;
}

/** The identity key of a record (its `id` field, else its JSON form). */
export function recordKey(record: SourceRecord): string {
  const id = record['id'];
  if (id !== undefined) return `id:${String(id)}`;
  return `row:${JSON.stringify(record)}`;
}

/** Per-run mutable state threaded through every `evaluate` / `execute` call. */
export class RuntimeContext {
  /** The engine this run executes against (registry, executors, embedder). */
  readonly engine: QueryEngine;
  /** CTE name → its materialized rows. */
  readonly ctes = new Map<string, SourceRecord[]>();
  /** Embedding cache (query text / record key → vector). */
  readonly embeddingCache = new Map<string, number[]>();
  /** Outer row visible to a correlated subquery (null at top level). */
  correlation: SourceRow | null = null;
  /**
   * The enclosing SELECT's output projections (name → `Expr`), installed for
   * the duration of its `groupBy` / `orderBy` / `having` evaluation via
   * `withOutputs`. An `output` reference reads its delegate target from here at
   * runtime. Empty outside a SELECT clause (so an `output` reference elsewhere
   * evaluates to NULL — it is already rejected by validation).
   */
  private outputs: ReadonlyMap<string, Expr> = new Map();
  /** Cap on recursive-CTE iterations. */
  readonly maxCteIterations: number;
  /** Whether a top-level SELECT should report its pre-limit `total`. */
  readonly includeTotal: boolean;
  /**
   * Whether the currently-executing query is the ROOT (entry) query
   * `engine.run` was called with. Starts `true`; `withNonRoot` clears it while a
   * NESTED query runs (a subquery / EXISTS / IN subquery, a FROM subquery, a CTE
   * body, a set-op branch) and restores it after. A SELECT reads it to decide
   * whether a Type's `defaultOrder` with `applyTo: 'result'` applies.
   */
  private root = true;

  private readonly states = new Map<string, TypeState>();
  private readonly paramValues = new Map<string, Value>();
  /** Execution-supplied filter EXPRS (parsed once), keyed by source name. */
  private readonly filterExprs: Readonly<Record<string, Expr>>;
  /** Execution-supplied dynamic-sort selection (ordered; a sorter expands it). */
  private readonly sortSelection: readonly SortSelectionDef[];
  /** Optional row-level-security provider for the runtime row filter. */
  private readonly rlsProvider?: RlsProvider;
  /** Type names currently mid-RLS-filter, to break self-referential recursion. */
  private readonly rlsInProgress = new Set<string>();
  /**
   * Alias → owning Type, bound for the duration of THIS run. Populated as each
   * source / join hop binds its rows in the execute loops of select / update /
   * delete / insert. It lets a `field-ref` recover its field's owning Type — and
   * therefore the field's metadata (notably text case-sensitivity) — even when
   * the source NAME differs from the Type name: an `aliased` source, a self-join
   * with two instances of one Type, or a join bound under its target type name.
   * Per-run lifetime: a fresh `RuntimeContext` starts with an empty map.
   */
  private readonly sourceTypes = new Map<string, Type>();
  private readonly embedder?: Embedder;
  private readonly recordEmbedding?: (source: string, id: JsonValue) => Promise<number[] | null>;

  constructor(engine: QueryEngine, options: RuntimeOptions = {}) {
    this.engine = engine;
    this.maxCteIterations = options.maxCteIterations ?? DEFAULT_MAX_CTE_ITERATIONS;
    this.includeTotal = options.includeTotal ?? false;
    this.filterExprs = engine.parseFilters(options.filters);
    this.sortSelection = options.sort ?? [];
    this.rlsProvider = options.rls;
    this.embedder = options.embedder ?? engine.embedder;
    this.recordEmbedding = options.recordEmbedding;
    if (options.params) {
      for (const name of Object.keys(options.params)) {
        this.paramValues.set(name, Value.of(options.params[name]!));
      }
    }
  }

  // ─── Params ───────────────────────────────────────────────────────────

  /** The bound value of `name`, or NULL when unbound. */
  param(name: string): Value {
    return this.paramValues.get(name) ?? Value.null();
  }

  // ─── Execution-time filter exprs ──────────────────────────────────────

  /** The execution-supplied filter expr bound to `source`, or `undefined`. */
  filtersFor(source: string): Expr | undefined {
    return this.filterExprs[source];
  }

  // ─── Execution-time dynamic-sort selection ────────────────────────────────

  /**
   * The execution-supplied dynamic-sort selection (ordered; possibly empty). A
   * `sorter` placeholder in a SELECT `order` expands this into concrete terms.
   */
  get sortSpec(): readonly SortSelectionDef[] {
    return this.sortSelection;
  }

  // ─── Bound source types (alias → Type) ───────────────────────────────

  /**
   * Bind `name` (a FROM alias, DML target name, or join hop alias) to its
   * underlying `type` for this run. Called by each query's execute loop as it
   * binds the corresponding rows, BEFORE any expression evaluates against them.
   */
  bindSourceType(name: string, type: Type): void {
    this.sourceTypes.set(name, type);
  }

  /**
   * The Type bound under `name` this run, or `undefined` when `name` is not a
   * bound source (e.g. a subquery / CTE alias, whose fields carry no Type-level
   * metadata — matching the prior behavior).
   */
  sourceType(name: string): Type | undefined {
    return this.sourceTypes.get(name);
  }

  // ─── Type state ──────────────────────────────────────────────────────

  /**
   * Load (once) and return the transactional state for `type`, loading rows
   * via the engine's executor for the Type. With no executor the type starts
   * empty.
   */
  async typeState(type: Type): Promise<TypeState> {
    const existing = this.states.get(type.name);
    if (existing) return existing;
    const executor = this.engine.executor(type.name);
    const loaded = executor ? await executor.load({ type, runtime: this }) : [];
    const visible = await this.applyRls(type, loaded);
    const original = visible.map((r) => ({ ...r }));
    const state: TypeState = {
      type,
      original,
      current: original.map((r) => ({ ...r })),
      deleted: new Set<string>(),
      updated: new Map<string, SourceRecord>(),
      inserted: new Map<string, SourceRecord>(),
    };
    this.states.set(type.name, state);
    return state;
  }

  /**
   * Apply runtime row-level security to freshly loaded `records`: keep only the
   * rows BOTH the optional RLS provider AND the Type's `TypeBacking.access`
   * admit. With neither configured the records pass through untouched (zero
   * overhead). A self-referential predicate (one that re-loads the same Type)
   * short-circuits to the unfiltered records to avoid infinite recursion.
   */
  private async applyRls(
    type: Type,
    records: readonly SourceRecord[],
  ): Promise<readonly SourceRecord[]> {
    const access = this.engine.typeBacking(type.name)?.access;
    const providerDef = this.rlsProvider?.predicateFor(type.name, type.name);
    if (!access && !providerDef) return records;
    if (this.rlsInProgress.has(type.name)) return records;
    this.rlsInProgress.add(type.name);
    try {
      const providerExpr = providerDef ? this.engine.registry.parseExpr(providerDef) : undefined;
      const kept: SourceRecord[] = [];
      for (const record of records) {
        const row: SourceRow = { [type.name]: record };
        if (providerExpr && !(await providerExpr.evaluate(this, row)).toBoolean()) continue;
        if (access) {
          const r = await resolveAccessRun(access, type.name, row, this);
          if (r.kind === 'visible' && !r.visible) continue;
        }
        kept.push(record);
      }
      return kept;
    } finally {
      this.rlsInProgress.delete(type.name);
    }
  }

  /** Every type state touched so far (for result/affected reporting). */
  typeStates(): IterableIterator<TypeState> {
    return this.states.values();
  }

  /**
   * The current rows visible for a source name: a CTE's rows when one matches,
   * else the Type's transactional `current` rows. Returns `undefined` when the
   * name is neither a CTE nor a registered Type.
   */
  async recordsFor(name: string): Promise<readonly SourceRecord[] | undefined> {
    const cte = this.ctes.get(name);
    if (cte) return cte;
    const type = this.engine.type(name);
    if (!type) return undefined;
    const state = await this.typeState(type);
    return state.current;
  }

  // ─── Correlation ──────────────────────────────────────────────────────

  /** Run `fn` with `row` installed as the correlation row, then restore. */
  async withCorrelation<T>(row: SourceRow, fn: () => Promise<T>): Promise<T> {
    const prev = this.correlation;
    this.correlation = prev ? { ...prev, ...row } : row;
    try {
      return await fn();
    } finally {
      this.correlation = prev;
    }
  }

  // ─── SELECT output projections (for `output` references) ──────────────

  /**
   * Run `fn` with `outputs` (name → projection `Expr`) installed as the
   * enclosing SELECT's outputs, restoring the previous set afterwards. A SELECT
   * wraps its GROUP BY / HAVING / ORDER BY evaluation in this so an `output`
   * reference can delegate to its target. Save/restore keeps nested SELECTs
   * (subqueries) correct — each installs and restores its own outputs.
   */
  async withOutputs<T>(outputs: ReadonlyMap<string, Expr>, fn: () => Promise<T>): Promise<T> {
    const prev = this.outputs;
    this.outputs = outputs;
    try {
      return await fn();
    } finally {
      this.outputs = prev;
    }
  }

  /** The enclosing SELECT's projection `Expr` named `name`, or `undefined`. */
  outputExpr(name: string): Expr | undefined {
    return this.outputs.get(name);
  }

  // ─── Root / nested query marker ───────────────────────────────────────

  /** Whether the currently-executing query is the ROOT (entry) query. */
  get isRoot(): boolean {
    return this.root;
  }

  /**
   * Run `fn` with the root marker cleared (a NESTED query executes), restoring
   * the previous value afterwards. Wrapped around every nested query execution —
   * a subquery / EXISTS / IN subquery, a FROM subquery, a CTE body, a set-op
   * branch — so only the entry query sees `isRoot === true`.
   */
  async withNonRoot<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.root;
    this.root = false;
    try {
      return await fn();
    } finally {
      this.root = prev;
    }
  }

  // ─── Embedding ────────────────────────────────────────────────────────

  /** Whether a semantic embedder is available this run. */
  hasEmbedder(): boolean {
    return this.embedder !== undefined;
  }

  /** Embed `text`, caching the vector. Returns null when no embedder is set. */
  async embed(text: string): Promise<number[] | null> {
    if (!this.embedder) return null;
    const cached = this.embeddingCache.get(text);
    if (cached) return cached;
    const vec = await this.embedder.embed(text);
    this.embeddingCache.set(text, vec);
    return vec;
  }

  /** Look up a record's stored embedding (null when unavailable). */
  async embeddingOf(source: string, id: JsonValue): Promise<number[] | null> {
    if (!this.recordEmbedding) return null;
    return this.recordEmbedding(source, id);
  }
}
