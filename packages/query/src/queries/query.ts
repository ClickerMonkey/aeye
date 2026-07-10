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
import type { JsonValue, ParamDef, QueryDef, QueryKind } from '../schema';
import type { Registry } from '../registry';
import type { QueryEngine } from '../engine';
import type { QueryScope } from '../scope';
import type { ResolvedType, TypeResolved, FieldResolved } from '../resolved-type';
import { asFieldType } from '../resolved-type';
import type { ScalarKind } from '../field-type';
import type { Cost } from '../cost';
import type { ValidateContext } from '../expr';
import { ROOT_VALIDATE_CONTEXT } from '../expr';
import type { Shape } from '../shape';
import { Problems } from '../problem';
import type { ParamSet } from '../param';
import type { RuntimeContext } from '../runtime/context';
import type { SourceRecord } from '../runtime/row';
import type { Expr } from '../expr';
import type { Dialect } from '../sql/dialect';
import type { SqlContext, SqlText } from '../sql/emit';
import { Type } from '../type';
import { Field } from '../field';
import { TextFieldType } from '../field-types/index';
import { FieldRefExpr, AggregateExpr, FiltersExpr } from '../exprs/index';

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
   */
  params(engine: QueryEngine, scope?: QueryScope): ParamDef[] {
    // Materialize inverse relations first (idempotent) so a relation key's
    // field type resolves, exactly as the engine's own entry points do.
    engine.registry.finalize();
    const s = scope ?? engine.globalScope();
    const p = new Problems();
    this.validateWalk(engine, s, p, ROOT_VALIDATE_CONTEXT);
    // Some params never appear in a walked expr position — a SELECT's
    // `limit` / `offset` bind params (added by `autoPaginate`) live OUTSIDE the
    // expr tree. Let the subclass observe those against their implied type so
    // they show up too.
    this.observeBoundParams(s.params);
    return s.params.toJSON();
  }

  /**
   * Observe any bind params that live OUTSIDE this query's walked expr tree
   * (e.g. a SELECT's `limit` / `offset`), so `params()` reports them with the
   * right inferred type. Base: none. Overridden by `SelectQuery`.
   */
  protected observeBoundParams(_params: ParamSet): void {
    /* default: no out-of-tree params */
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

  // ─── Cost estimation (Phase 4) ───────────────────────────────────────────

  /**
   * Bottom-up `{ rows, bytes }` estimate of this query's result (algorithm
   * "(e)" of the plan). Drives `QueryEngine.cost` / `checkCost` and the
   * opt-in cost constraints enforced during validation.
   */
  abstract cost(engine: QueryEngine, scope: QueryScope): Cost;

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
    const ft = asFieldType(c.type) ?? new TextFieldType();
    const nullable = c.type.kind !== 'type' && c.type.nullable;
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
