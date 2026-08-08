/**
 * Query — abstract base for every query KIND (select / insert / update /
 * delete / set-operation / cte / expr), plus the `QueryClass` static contract
 * the Registry dispatches through, and the `QueryResult` shape callers get
 * back from `execute`.
 *
 * A Query unifies four concerns:
 *  - RESOLUTION  (`resolve` / `outputFields`) — the typed output shape, so a
 *    subquery can be type-checked and a result carries metadata for free.
 *  - VALIDATION  (`validateWalk`) — accumulate `Problems` over the structure.
 *  - SERIALIZATION (`toJSON` / `clone`).
 *  - EXECUTION   (`execute`) — run in-memory, returning rows + metadata.
 */
import type { JsonValue, ParamDef, ParamExprDef, QueryDef, QueryKind } from '../schema';
import type { Registry } from '../registry';
import type { QueryEngine } from '../engine';
import type { QueryScope } from '../scope';
import type { ResolvedType, TypeResolved, FieldResolved } from '../resolved-type';
import { asFieldType, relationOf } from '../resolved-type';
import type { ScalarKind } from '../field-type';
import type { Affected, Cost, CostContext } from '../cost';
import { AFFECTED_NONE } from '../cost';
import type { ValidateContext } from '../expr';
import { ROOT_VALIDATE_CONTEXT } from '../expr';
import type { Shape } from '../shape';
import { Problems } from '../problem';
import type { RuntimeContext } from '../runtime/context';
import type { SourceRecord } from '../runtime/row';
import type { Expr } from '../expr';
import type { Dialect } from '../sql/dialect';
import type { SqlContext, SqlText } from '../sql/emit';
import { Type } from '../type';
import { Field } from '../field';
import { TextFieldType, JsonFieldType, NumberFieldType } from '../field-types/index';
import { FieldRefExpr, AggregateExpr, FiltersExpr, SorterExpr } from '../exprs/index';

/** One specific field a query reads — its owning Type and field name. */
export interface FieldReference {
  readonly type: string;
  readonly field: string;
}

/** What a query READS: the Types, specific fields, and DB functions it touches. */
export interface QueryReferences {
  /** Every Type read (FROM / joins / subqueries / CTE sources / function reads). */
  readonly types: readonly string[];
  /** The specific fields read (resolved to `{ type, field }`), deduped. */
  readonly fields: readonly FieldReference[];
  /** The DB functions invoked, deduped. */
  readonly functions: readonly string[];
}

/** Merge several {@link QueryReferences} (union of Types / fields / functions). */
export function mergeReferences(parts: readonly QueryReferences[]): QueryReferences {
  const types = new Set<string>();
  const functions = new Set<string>();
  const fields = new Map<string, FieldReference>();
  for (const part of parts) {
    for (const t of part.types) types.add(t);
    for (const f of part.functions) functions.add(f);
    for (const fld of part.fields) fields.set(`${fld.type}.${fld.field}`, fld);
  }
  return { types: [...types], fields: [...fields.values()], functions: [...functions] };
}

/**
 * Accumulate a query's referenced Types / fields / functions from expr subtrees:
 * a function call notes its name (and any Types the function itself reads); a
 * field-ref is resolved to `{ type, field }` when a bound `scope` is supplied
 * (a base query with no binding collects Types + functions only).
 */
class ReferenceCollector {
  readonly types = new Set<string>();
  private readonly fields = new Map<string, FieldReference>();
  readonly functions = new Set<string>();
  constructor(
    private readonly engine: QueryEngine,
    private readonly scope: QueryScope | undefined,
    seedTypes: readonly string[],
  ) {
    for (const t of seedTypes) this.types.add(t);
  }

  /** Inspect ONE expr node: note a function call (+ Types it reads) and, when scoped, a field-ref. */
  note(n: Expr): void {
    const fn = n.functionRef();
    if (fn !== undefined) {
      this.functions.add(fn);
      const f = this.engine.lookupFunction(fn);
      if (f) for (const t of f.references) this.types.add(t);
    }
    if (!this.scope) return;
    const fr = n.fieldRef();
    if (!fr) return;
    const rt = fr.resolve(this.engine, this.scope);
    if (rt.kind === 'field') {
      this.types.add(rt.type.name);
      this.fields.set(`${rt.type.name}.${rt.field.name}`, { type: rt.type.name, field: rt.field.name });
    }
  }

  result(): QueryReferences {
    return { types: [...this.types], fields: [...this.fields.values()], functions: [...this.functions] };
  }
}

/**
 * One output field of a query.
 *
 *  - `type` carries the FULL resolved-type info (the discriminated
 *    `ResolvedType`) so a consumer that wants nullability, source fields,
 *    cost, etc. has everything.
 *  - `nullable` + `fieldType` are JSON-friendly SUMMARY fields derived from
 *    `type`: a `boolean` and the underlying field-type kind (`ScalarKind`, or
 *    the sentinel `'type'` when the field resolves to a whole Type). They make
 *    the metadata both rich (via `type`) AND trivially serializable / printable
 *    (via these two), so a caller never has to walk `ResolvedType` just to show
 *    a column header. Always populated — build fields through `makeField`.
 */
export interface QueryField {
  /** Output column name (alias, else a natural name). */
  name: string;
  /** The full resolved type of this field (nullability, sources, cost, …). */
  type: ResolvedType;
  /** Whether this field may be null (false for a whole-Type field). */
  nullable: boolean;
  /**
   * The underlying field-type kind (`asFieldType(type).resolve()`), or the
   * sentinel `'type'` when `type` resolves to a whole Type (no single
   * field-type). A compact, JSON-friendly summary of the value category.
   */
  fieldType: ScalarKind | 'type';
}

/**
 * Fields shared by both result shapes (object-row + array-row). `rows` is the
 * one member that differs, so it lives on the two concrete interfaces below.
 */
interface QueryResultBase {
  /** Resolved output fields (name + full type + summary metadata). */
  fields: QueryField[];
  /** A synthetic Type describing the output row shape. */
  outputType: Type;
  /** Affected-row count for INSERT / UPDATE / DELETE. */
  affected?: number;
  /**
   * Total number of result rows after WHERE / JOIN / GROUP / HAVING / DISTINCT
   * but BEFORE limit/offset — present only when the SELECT set `includeTotal`.
   * Lets a paginated caller report "showing N of total".
   */
  total?: number;
}

/** The result of running a query in-memory — rows as OBJECTS (the default). */
export interface QueryResult extends QueryResultBase {
  /** Output rows, each a field name → JSON value map. */
  rows: SourceRecord[];
}

/**
 * The result of running a query with `{ rows: 'array' }` — rows as plain
 * POSITIONAL arrays. Each inner array is aligned to `fields` order (index `i`
 * of a row holds the value of `fields[i]`). Identical to `QueryResult` in every
 * other respect.
 */
export interface QueryResultArray extends QueryResultBase {
  /** Output rows, each a positional `JsonValue[]` aligned to `fields`. */
  rows: JsonValue[][];
}

/** Static contract every concrete Query class satisfies (Registry dispatch). */
export interface QueryClass {
  /** The `kind` discriminant this class handles (the Registry dispatch key). */
  readonly KIND: QueryKind;
  /**
   * OPTIONAL concise, LLM-facing one-line description of this query kind — the
   * canonical terse doc surfaced (with `EXAMPLES`) by `describeEngine`'s
   * query-examples section. Present on the confusing/composed kinds.
   */
  readonly INSTRUCTIONS?: string;
  /**
   * OPTIONAL worked examples — each a RAW JSON string of a full query of this
   * kind, teaching its SHAPE with illustrative generic source/field names.
   * Surfaced (capped by `maxExamples`) by `describeEngine`. The ONE source of
   * truth for these examples.
   */
  readonly EXAMPLES?: readonly string[];
  /** Parse a matching `QueryDef` into a concrete `Query` instance. */
  from(json: QueryDef, registry: Registry): Query;
  /**
   * Owned structural {@link Shape} — the zod-free parallel to `from` (never
   * throws, accumulates problems). Present only on the migrated kinds; the
   * foundation of the eventual replacement for the zod structural gate.
   */
  readonly SHAPE?: Shape<Query>;
}

/** Abstract base for every query KIND (select / insert / update / delete / set-operation / cte / expr). */
export abstract class Query {
  /** The `kind` discriminant (matches the subclass's `static KIND`). */
  abstract readonly kind: QueryKind;

  // ─── Resolution ──────────────────────────────────────────────────────────

  /** The resolved output fields of this query against `scope`. */
  abstract outputFields(engine: QueryEngine, scope: QueryScope): QueryField[];

  /**
   * Resolve this query's output as a single `ResolvedType`: the lone field's
   * type when single-field (scalar subquery), else a synthetic type over all
   * fields. Replaces the Phase-2 `inferSubqueryOutput` seam.
   */
  resolve(engine: QueryEngine, scope: QueryScope): ResolvedType {
    return resolveFields(this.kind, this.outputFields(engine, scope));
  }

  // ─── Validation ────────────────────────────────────────────────────────

  /** Recursive validation walk, accumulating Problems into `p`. */
  abstract validateWalk(
    engine: QueryEngine,
    scope: QueryScope,
    p: Problems,
    ctx: ValidateContext,
  ): void;

  /** Top-level validation entry (mirrors `Expr.validate`). */
  validate(engine: QueryEngine, scope?: QueryScope): Problems {
    const p = new Problems();
    const s = scope ?? engine.globalScope();
    this.validateWalk(engine, s, p, ROOT_VALIDATE_CONTEXT);
    s.params.problems(p);
    return p;
  }

  /** Type names this query reads or writes (for per-Type validator hooks). */
  abstract referencedTypes(): readonly string[];

  // ─── Introspection: bind params + filterable sources ─────────────────────

  /**
   * The bind PARAMETERS this query references, each with the field type
   * INFERRED from how it is used. This is the introspection a caller / UI uses
   * to know what `params` values `engine.run(query, { params })` expects.
   *
   * Mechanism: it runs the SAME resolution / validation walk `validateQuery`
   * does — into a THROWAWAY `Problems` bag — purely for its side effect of
   * populating the scope's shared `ParamSet`. During that walk each `param`
   * `reference`s itself (via `collectParams` / `ParamExpr.validateWalk`) and
   * each operator `observe`s its param operand against the OTHER operand's
   * resolved field type, so by the end the set has unified a type per param.
   * `ParamSet.toJSON()` then exports the resolved params as `ParamDef[]`.
   *
   * Params that are referenced but never observed against any type (so no type
   * can be inferred) are OMITTED here — they carry no `type` to report;
   * `validateQuery` surfaces them separately as `param.untyped`.
   *
   * Out-of-tree bounds (`limit` / `offset`) are picked up by the same walk —
   * each kind that OWNS a row bound observes it from its own `validateWalk`
   * (see {@link observeRowBounds}), so a bound at ANY nesting depth lands here.
   */
  params(engine: QueryEngine, scope?: QueryScope): ParamDef[] {
    // Materialize inverse relations first (idempotent) so a relation key's
    // field type resolves, exactly as the engine's own entry points do.
    engine.registry.finalize();
    const s = scope ?? engine.globalScope();
    const p = new Problems();
    this.validateWalk(engine, s, p, ROOT_VALIDATE_CONTEXT);
    return s.params.toJSON();
  }

  /**
   * Observe a `limit` / `offset` ROW BOUND that is bound to a `param` (see
   * `autoPaginate`) against a number field type — a bound is always a row count
   * — so `params()` reports it with an inferred type. A bound lives OUTSIDE the
   * walked expr tree, so nothing else in the walk ever reaches it.
   *
   * INVARIANT: the kind that EMITS a row bound is the kind that observes it, and
   * it does so from its own `validateWalk`. That is what makes the report correct
   * at every NESTING DEPTH — `validateWalk` already recurses into a CTE body and
   * its `final`, a set-operation arm, and a FROM / IN / EXISTS subquery, and every
   * scope in that recursion shares ONE `ParamSet`. Observing only at the ROOT
   * (what `params()` used to do, via a `SelectQuery`-only hook) reported a paged
   * `cte` as taking NO params at all while `toSQL` still emitted
   * `LIMIT $1 OFFSET $2` — an unbindable statement whose declared signature was
   * empty (bug A17).
   *
   * The observation is recorded at the walk's CURRENT path (`p.here`, the
   * accessor that exists for exactly this), so a `param.conflict` naming a bound
   * points at the statement that OWNS it (`final.limit`) rather than at a
   * root-relative `limit` that does not exist.
   */
  protected observeRowBounds(
    scope: QueryScope,
    p: Problems,
    limit: number | ParamExprDef | undefined,
    offset: number | ParamExprDef | undefined,
  ): void {
    const numeric = new NumberFieldType();
    const at = p.here;
    if (limit !== undefined && typeof limit !== 'number') scope.params.observe(limit.name, numeric, [...at, 'limit']);
    if (offset !== undefined && typeof offset !== 'number') scope.params.observe(offset.name, numeric, [...at, 'offset']);
  }

  /**
   * The source names this query exposes for execution-time `filters` — i.e. the
   * sources a caller may target with `engine.run(query, { filters: [{ kind:
   * 'filters', source, … }] })`. The base query exposes NONE; only
   * `SelectQuery` overrides it (filters AND into a select's WHERE, the only
   * place execution-time filters are applied — see `QueryEngine.run`).
   */
  filterSources(_engine: QueryEngine): string[] {
    return [];
  }

  /**
   * Enumerate EVERY expression across this query's clauses, recursing into each
   * expr's descendants via `Expr.walk` (pre-order). The base query owns no clause
   * exprs, so it visits nothing; a query kind with clauses overrides this to walk
   * its own — select fields / where / groupBy / having / order / join `and`, DML
   * set / where / returning, and so on. The traversal primitive `filters()` is
   * built on.
   */
  walkExprs(_visit: (e: Expr) => void): void {
    /* default: no clause exprs */
  }

  /**
   * The lexical scope in which a `filters` placeholder's `source` resolves — the
   * query's own FROM / JOIN / target bindings. The base binds nothing (returns
   * `scope` unchanged); a query kind that binds sources overrides this. Consumed
   * only by `filters()`.
   */
  protected filterScope(_engine: QueryEngine, scope: QueryScope): QueryScope {
    return scope;
  }

  /**
   * The scope a `sorter`'s catalog exprs resolve in for `sorters()` — like
   * {@link filterScope} but ALSO exposing the enclosing SELECT's outputs (so an
   * `output`-ref sort resolves), matching order-by validation. The base binds
   * nothing; only `SelectQuery` (which owns an `order`) overrides it.
   */
  protected sorterScope(_engine: QueryEngine, scope: QueryScope): QueryScope {
    return scope;
  }

  /**
   * Introspect the execution-time `filters` this query exposes: every `filters`
   * placeholder found in any clause (via `walkExprs`), keyed by its bound
   * `source`, mapped to the filterable `fields` of that source's Type — resolved
   * as `QueryField[]` and restricted to the placeholder's `fields` allowlist when
   * it sets one. A caller uses this to know which sources it may supply a bool
   * `ExprDef` / `Expr` for via `engine.run(query, { filters })`, and which fields
   * each exposes. A query with no `filters` placeholder returns `{}`; a source
   * whose placeholder appears more than once is LAST-WINS.
   */
  filters(engine: QueryEngine, scope?: QueryScope): Record<string, { fields: QueryField[] }> {
    // Materialize inverse relations first (idempotent) so a source's fields
    // resolve, exactly as the other introspection entry points do.
    engine.registry.finalize();
    const s = scope ?? engine.globalScope();
    const bound = this.filterScope(engine, s);
    const out: Record<string, { fields: QueryField[] }> = {};
    this.walkExprs((e) => {
      if (!(e instanceof FiltersExpr)) return;
      const b = bound.lookup(e.source);
      if (!b || b.kind !== 'type') return;
      const allow = e.fields ? new Set(e.fields) : undefined;
      const fields = b.type.fields
        .filter((f) => !allow || allow.has(f.name))
        .map((f): QueryField => {
          const resolved: FieldResolved = {
            kind: 'field',
            field: f,
            type: b.type,
            source: b.source,
            nullable: f.nullable,
          };
          return makeField(f.name, resolved);
        });
      out[e.source] = { fields };
    });
    return out;
  }

  /**
   * Introspect the execution-time DYNAMIC SORTS this query exposes: every named
   * sort of every `sorter` placeholder found in an `order` list (via `walkExprs`),
   * keyed by SORT NAME, mapped to that sort expr's RESOLVED orderable type +
   * nullability (as a `QueryField`, mirroring `filters()`'s field metadata). A
   * caller / UI uses this to list a query's sort options and their value types,
   * then re-sort via `engine.run(query, { sort })` / `engine.toSQL({ sort })`.
   * A query with no `sorter` returns `{}`; sort names are unique across a query's
   * sorters, so a duplicate is LAST-WINS.
   */
  sorters(engine: QueryEngine, scope?: QueryScope): Record<string, QueryField> {
    // Materialize inverse relations first (idempotent) so each sort expr's type
    // resolves, exactly as the other introspection entry points do.
    engine.registry.finalize();
    const s = scope ?? engine.globalScope();
    const bound = this.sorterScope(engine, s);
    const out: Record<string, QueryField> = {};
    this.walkExprs((e) => {
      if (!(e instanceof SorterExpr)) return;
      for (const [name, expr] of e.sorts) {
        out[name] = makeField(name, expr.resolve(engine, bound));
      }
    });
    return out;
  }

  // ─── Cost estimation (Phase 4) ───────────────────────────────────────────

  /**
   * Bottom-up `{ rows, bytes }` estimate of this query's result (algorithm
   * "(e)" of the plan). Drives `QueryEngine.cost` / `checkCost` and the
   * opt-in cost constraints enforced during validation.
   */
  abstract cost(ctx: CostContext, scope: QueryScope): Cost;

  /**
   * Estimate the SIZE OF THE RESULT this query returns — output `rows` (capped by
   * a literal or param-resolved LIMIT / OFFSET) sized by the PROJECTION width,
   * not the whole scanned row. Distinct from {@link cost} (the WORK to produce
   * it). The base default is the processing cost; `SelectQuery` / set-operations
   * / CTEs refine it.
   */
  outputCost(ctx: CostContext, scope: QueryScope): Cost {
    return this.cost(ctx, scope);
  }

  /**
   * Estimate the rows this statement MUTATES — a total plus a per-Type breakdown
   * ({@link Affected}). A read-only query is `{ rows: 0, types: [] }` (the
   * default); INSERT / UPDATE / DELETE name their target Type, and a CTE
   * statement SUMS its data-modifying entries plus the final query per Type.
   */
  affected(_ctx: CostContext, _scope: QueryScope): Affected {
    return AFFECTED_NONE;
  }

  /**
   * Enumerate what this query READS — the {@link QueryReferences} of Types,
   * specific fields, and DB functions it touches — INCLUDING execution-time
   * `filters` predicates and the `sort`-selected sorter catalog exprs (both from
   * `ctx`). Drives `engine.changeInterval` (freshness). The base collects Types
   * (from {@link referencedTypes}) + functions (+ any Types a function reads);
   * `SelectQuery` / set-ops / CTEs override to add the specific FIELDS read,
   * resolved against their bound scope ({@link referenceScope}).
   */
  references(engine: QueryEngine, scope: QueryScope, ctx: CostContext): QueryReferences {
    const c = new ReferenceCollector(engine, this.referenceScope(engine, scope), this.referencedTypes());
    this.forEachReferenceNode(ctx, (n) => c.note(n));
    if (ctx.filters) for (const pred of ctx.filters.values()) pred.walk((n) => c.note(n));
    return c.result();
  }

  /**
   * The bound scope a `references` walk resolves its field-refs against, or
   * `undefined` when this query has no meaningful binding (so field-refs are not
   * resolved — only Types + functions are collected). Overridden by queries that
   * bind sources (`SelectQuery` returns its sorter scope).
   */
  protected referenceScope(_engine: QueryEngine, _scope: QueryScope): QueryScope | undefined {
    return undefined;
  }

  /**
   * Visit every expr NODE `references` should inspect. The default recurses every
   * clause expr ({@link walkExprs}); `SelectQuery` overrides to expand a `sorter`
   * to only its `ctx.sort`-SELECTED catalog exprs (not the whole catalog).
   */
  protected forEachReferenceNode(_ctx: CostContext, visit: (n: Expr) => void): void {
    this.walkExprs(visit);
  }

  // ─── Serialization ───────────────────────────────────────────────────────

  /** Serialize this query back to its `QueryDef` JSON shape. */
  abstract toJSON(): QueryDef;
  /** Deep-clone this query. */
  abstract clone(): Query;

  // ─── Execution ─────────────────────────────────────────────────────────

  /** Run this query against the in-memory runtime. */
  abstract execute(ctx: RuntimeContext): Promise<QueryResult>;

  // ─── SQL emission (Phase 5) ──────────────────────────────────────────────

  /**
   * Emit this query as a `SqlText` fragment for `dialect`. A SELECT assembles
   * WITH (planner CTEs) + SELECT + FROM + planned JOINs + WHERE(+RLS) +
   * GROUP BY + HAVING + ORDER BY + LIMIT/OFFSET; the DML / set-op / cte / expr
   * statements assemble their respective shapes.
   */
  abstract toSQL(dialect: Dialect, ctx: SqlContext): SqlText;

  /**
   * Emit this query as a leading-`WITH`-free BODY plus the TOP-LEVEL CTE
   * definitions it would otherwise prepend itself. The default returns no CTEs
   * and the whole `toSQL` output as the body — correct for any query that does
   * not emit a top-level `WITH` (a `SelectQuery` included).
   *
   * `CTEStatementQuery` overrides this so an OUTER `WITH` can HOIST a nested
   * statement's named CTEs and emit a SINGLE combined `WITH` list. Without it a
   * `WITH` whose final query is itself a `WITH` would emit two adjacent `WITH`s
   * — a syntax error (BUG P0-2).
   */
  emitWith(dialect: Dialect, ctx: SqlContext): { ctes: ReadonlyArray<SqlText>; body: SqlText } {
    return { ctes: [], body: this.toSQL(dialect, ctx) };
  }
}

// ─── Shared helpers ──────────────────────────────────────────────────────────

/**
 * Build a `QueryField` from a name + resolved type, deriving the JSON-friendly
 * summary metadata (`nullable` + `fieldType`) from `type`. THE single factory
 * for query fields — every `outputFields` implementation routes through it so
 * the summary metadata is always populated and always consistent.
 */
export function makeField(name: string, type: ResolvedType): QueryField {
  const ft = asFieldType(type);
  // A RELATION resolves to a whole Type, but PROJECTS as its identity object —
  // a JSON value, and a nullable one (an unset relation reads NULL). Reporting
  // the `'type'` sentinel here would tell a consumer it received a whole row.
  if (relationOf(type)?.belongsTo) return { name, type, nullable: true, fieldType: 'json' };
  // `asFieldType` is `undefined` exactly when `type` is a whole Type → the
  // `'type'` sentinel; otherwise the underlying scalar category.
  const fieldType: ScalarKind | 'type' = ft ? ft.resolve() : 'type';
  // A whole-Type field carries no nullability of its own.
  const nullable = type.kind !== 'type' && type.nullable;
  return { name, type, nullable, fieldType };
}

/**
 * Project object-rows into POSITIONAL arrays aligned to `fields`. For each row,
 * emits `[row[fields[0].name], row[fields[1].name], …]`, substituting `null`
 * for any absent field so every inner array has exactly `fields.length`
 * entries. Pure + order-preserving — the array form of a result's rows.
 */
export function toArrayRows(
  fields: QueryField[],
  rows: readonly SourceRecord[],
): JsonValue[][] {
  return rows.map((row) => fields.map((f) => row[f.name] ?? null));
}

/** Build a synthetic `Type` describing a set of output fields. */
export function syntheticType(name: string, fields: readonly QueryField[]): Type {
  const built = fields.map((c) => {
    // A projected relation identity is a JSON object; every other whole-Type
    // column keeps the historical text placeholder.
    const ft = asFieldType(c.type) ?? (relationOf(c.type)?.belongsTo ? new JsonFieldType() : new TextFieldType());
    const nullable = c.type.kind !== 'type' ? c.type.nullable : relationOf(c.type)?.belongsTo === true;
    return new Field({ name: c.name, fieldType: ft, nullable });
  });
  return new Type({ name, fields: built, indexes: [], count: 0, bytes: 0 });
}

/** Build a `TypeResolved` over a synthetic Type for the given fields. */
export function typeFromFields(
  name: string,
  source: string,
  fields: readonly QueryField[],
): TypeResolved {
  return { kind: 'type', type: syntheticType(name, fields), source, synthetic: true };
}

/** Single-field ⇒ that field's type; else a synthetic type. */
export function resolveFields(kind: QueryKind, fields: readonly QueryField[]): ResolvedType {
  if (fields.length === 1) return fields[0]!.type;
  return typeFromFields(`<${kind}>`, `<${kind}>`, fields);
}

/** The output field name for an expr: its alias, else a natural name. */
export function fieldNameOf(expr: Expr, as: string | undefined, i: number): string {
  if (as) return as;
  if (expr instanceof FieldRefExpr) return expr.field;
  if (expr instanceof AggregateExpr) return expr.fn;
  return `col${i}`;
}

/** Build a QueryResult from rows + resolved fields. */
export function makeResult(
  kind: QueryKind,
  rows: SourceRecord[],
  fields: QueryField[],
  affected?: number,
): QueryResult {
  const result: QueryResult = {
    rows,
    fields,
    outputType: syntheticType(`<${kind}>`, fields),
  };
  if (affected !== undefined) result.affected = affected;
  return result;
}
