/**
 * Type backing — the DEV-SIDE layer that gives a conceptual `Type` (the simple,
 * LLM-facing `TypeDef`) a richer implementation behind the scenes: computed
 * fields, row-level security (RLS), field-level security (FLS), and a real
 * underlying source name. None of this appears in the JSON `TypeDef` / `FieldDef`
 * — it is plain TypeScript the developer registers alongside the `Type`
 * (`registry.registerType(type, backing?)`), so the schema the LLM sees stays
 * minimal while the data model can be arbitrarily complex underneath.
 *
 * Two orthogonal primitives compose everything:
 *  - `Access` — a SECURITY PREDICATE (RLS at the Type level, FLS at the field
 *    level). It resolves to: a predicate (apply it), `true` (visible), `false`
 *    (not visible), or `undefined` (no-op / fall through to normal).
 *  - `Computed` — a VALUE producer (a field's value, replacing the stored
 *    column). It ALWAYS yields a value.
 *
 * Each primitive offers a dual `expr` path plus per-mode overrides:
 *  - SQL emission resolves `sql` first, else `expr`;
 *  - in-memory runtime resolves `run` first, else `expr`.
 * The `expr` path is the primary one — a single `Expr` is BOTH emitted to SQL
 * (`toSQL`) and evaluated in memory (`evaluate`), so a dual-`expr` backing yields
 * the same logical result in both modes.
 *
 * This module imports its collaborators (`Expr`, `SqlContext`, `SqlText`,
 * `RuntimeContext`, `SourceRow`, `Value`) TYPE-ONLY, so it sits at the bottom of
 * the dependency graph: the registry / engine import it, and it imports nothing
 * as a runtime value (no cycles). Method calls on instances typed as `Expr`
 * (`.toSQL` / `.evaluate`) are fine; only CONSTRUCTING those values would need a
 * runtime import, which this module never does (the caller supplies them).
 *
 * The suppression-field DERIVATION for a `DefaultCondition` needs to walk a
 * predicate's `FieldRefExpr`s, which would require a runtime import of the
 * concrete expr class; to keep this module's no-cycle invariant intact that one
 * helper (`defaultConditionWithout`) lives in `./default-conditions` instead,
 * imported by the higher query / describe layers.
 */
import type { Expr } from './expr';
import type { QueryDef } from './schema';
import type { Query } from './queries/query';
import type { Embedder } from './engine';
import type { SqlContext, SqlText } from './sql/emit';
import type { RuntimeContext } from './runtime/context';
import type { SourceRow, SourceRecord } from './runtime/row';
import type { Value } from './runtime/value';

/**
 * A security predicate, evaluated per occurrence of a Type (RLS) or per read of
 * a field (FLS). Supply at most one path; SQL prefers `sql` then `expr`, the
 * runtime prefers `run` then `expr`. Every path resolves to one of FOUR meanings:
 *  - a predicate value (an `Expr` / `SqlText`) ⇒ APPLY it (gate the row/field);
 *  - `true`      ⇒ visible (allow, no predicate needed);
 *  - `false`     ⇒ not visible (deny — RLS drops the row, FLS nulls the field);
 *  - `undefined` ⇒ no-op (nothing to apply; behave as if no `access` were set).
 */
export interface Access {
  /**
   * The DUAL predicate path: given the alias the Type is bound under, return a
   * boolean `Expr` (applied in BOTH SQL and runtime), or a static `true` /
   * `false`, or `undefined` for no-op. The factory is given the ALIAS the Type
   * is bound under and MUST use it for every reference (never hardcode the Type
   * name), so aliased / self-joined sources (multiple joins to the same Type, an
   * `{kind:'aliased'}` FROM) resolve to the correct source.
   */
  expr?: (alias: string) => Expr | boolean | undefined;
  /**
   * SQL-only override: a raw predicate `SqlText`, a static `true`/`false`, or
   * `undefined`. Given the bound `alias`; MUST reference it (never a literal Type
   * name) so aliased occurrences gate the correct source.
   */
  sql?: (alias: string, ctx: SqlContext) => SqlText | boolean | undefined;
  /**
   * Runtime-only override: whether the row/field is visible (`true`/`false`), or
   * `undefined` for no-op. Given the bound `alias` (which it MUST use — read
   * `row[alias]`, never a hardcoded key — so aliased / self-joined sources read
   * the correct record) and the current evaluation row (keyed by source).
   */
  run?: (
    alias: string,
    row: SourceRow,
    ctx: RuntimeContext,
  ) => boolean | undefined | Promise<boolean | undefined>;
}

/**
 * A computed VALUE for a field — it replaces the stored column. Unlike `Access`
 * it ALWAYS produces a value (never `undefined`). SQL prefers `sql` then `expr`;
 * the runtime prefers `run` then `expr`. With only `expr`, the SAME expression is
 * emitted to SQL and evaluated in memory.
 */
export interface Computed {
  /**
   * The DUAL value path: an `Expr` emitted to SQL AND evaluated in memory. The
   * factory is given the ALIAS the Type is bound under and MUST use it for every
   * reference (never hardcode the Type name), so aliased / self-joined sources
   * resolve to the correct source.
   */
  expr?: (alias: string) => Expr;
  /**
   * SQL-only override: emit a raw value `SqlText`. Given the bound `alias`; MUST
   * reference it (never a literal Type name) so aliased occurrences read the
   * correct source.
   */
  sql?: (alias: string, ctx: SqlContext) => SqlText;
  /**
   * Runtime-only override: produce the value in memory. Given the bound `alias`
   * (which it MUST use — read `row[alias]`, never a hardcoded key — so aliased /
   * self-joined sources read the correct record) and the current evaluation row.
   */
  run?: (alias: string, row: SourceRow, ctx: RuntimeContext) => Value | Promise<Value>;
}

/**
 * The deterministic alias a NAMED JOIN binds under, given the SOURCE alias the
 * backed Type occupies and the join's name in `TypeBacking.joins`. Stable and
 * collision-resistant (the `__` separator never appears in a relation-path's
 * single-`_` alias), so a dev who writes a `compute` / `access` `Expr` that
 * reads a named join references its columns via `joinAlias(source, name)`, and
 * every field sharing that join collapses to ONE planned join (deduped on this
 * exact alias).
 */
export function joinAlias(sourceAlias: string, name: string): string {
  return `${sourceAlias}__${name}`;
}

/**
 * A STRUCTURED join the planner can lower AND dedup — the primary (`expr`) path
 * of a `JoinBacking`. A clean discriminated union over the two join shapes the
 * backing layer supports:
 *  - `'relation'` — follow a relation field on `source`'s Type, reusing the
 *    planner's shared relation-join machinery (`requireJoin`), so it dedups with
 *    any other reference walking the same relation.
 *  - `'lateral'`  — a correlated subquery attached as a LATERAL / CROSS-APPLY
 *    join, evaluated per outer row.
 */
export type JoinSpec = RelationJoinSpec | LateralJoinSpec;

/** A named join that follows a relation field on the backed Type. */
export interface RelationJoinSpec {
  /** Discriminant. */
  readonly kind: 'relation';
  /** The bound source alias whose Type declares `relation`. */
  readonly source: string;
  /** The relation field on `source`'s Type to join through. */
  readonly relation: string;
  /** SQL join type (default `'left'`). */
  readonly joinType?: 'left' | 'inner';
}

/** A named join that attaches a correlated subquery as a LATERAL join. */
export interface LateralJoinSpec {
  /** Discriminant. */
  readonly kind: 'lateral';
  /**
   * Build the correlated subquery. `outer` is the SOURCE alias the backed Type
   * occupies — reference it inside the subquery (`<outer>.<field>`) to correlate
   * to the current outer row. Either a JSON `QueryDef` or an already-parsed
   * `Query`.
   */
  readonly query: (outer: string) => QueryDef | Query;
  /**
   * The subquery column the backed field reads. When the referencing field has
   * NO `compute`, its value defaults to `<joinAlias>.<pick>`; an explicit
   * `compute` overrides that (and may read any of the lateral's columns).
   */
  readonly pick?: string;
  /** SQL join type (default `'left'`). */
  readonly joinType?: 'left' | 'inner';
}

/**
 * How a NAMED JOIN attaches its data at runtime — the resolved `run` path of a
 * `JoinBacking`. The runtime binds the joined record under `alias` on each outer
 * row (so a `compute` / `access` `Expr` reading `<alias>.<col>` resolves), then
 * `attach` produces that record for a given outer row. Returning `null` means
 * "no match" (a LEFT-JOIN miss) — columns read off the alias then yield NULL.
 */
export interface RuntimeJoin {
  /** The alias the joined record binds under on each outer row. */
  readonly alias: string;
  /** Produce the joined record correlated to `outer`, or `null` for no match. */
  attach(outer: SourceRow, ctx: RuntimeContext): SourceRecord | null | Promise<SourceRecord | null>;
}

/**
 * A named, hidden join producer — like `Computed`, but it contributes a JOIN
 * (shared across every field that references it, added ONCE if-and-only-if some
 * referencing field is in the query). Supply at most one path:
 *  - `expr` is the PRIMARY (dual) path: a structured `JoinSpec` the planner
 *    lowers to SQL AND the runtime attaches in memory;
 *  - `sql`  is a SQL-only raw join fragment (e.g. a hand-written
 *    `LEFT JOIN LATERAL …` / `CROSS APPLY …`);
 *  - `run`  is a runtime-only attach producing the joined rows per outer row.
 * Resolution: SQL prefers `sql` then `expr`; the runtime prefers `run` then
 * `expr`.
 */
export interface JoinBacking {
  /**
   * The DUAL path: a structured `JoinSpec` lowered to SQL and attached in memory.
   * The factory is given the ALIAS the backed Type is bound under and MUST use it
   * for every reference (its `source`, and the OUTER correlation an `{kind:'lateral'}`
   * receives) — never hardcode the Type name — so aliased / self-joined sources
   * correlate to the correct source.
   */
  expr?: (alias: string) => JoinSpec;
  /**
   * SQL-only override: a raw join fragment (incl. LATERAL / CROSS APPLY). Given
   * the bound `alias`; MUST reference it (never a literal Type name) so aliased
   * occurrences correlate to the correct source.
   */
  sql?: (alias: string, ctx: SqlContext) => SqlText;
  /**
   * Runtime-only override: attach the joined rows per outer row. Given the bound
   * `alias` the backed Type occupies (which it MUST use — bind under / correlate
   * to `alias`, never a hardcoded key — so aliased / self-joined sources attach
   * against the correct source).
   */
  run?: (alias: string, ctx: RuntimeContext) => RuntimeJoin;
}

/**
 * The dev-side backing for a single conceptual field. A field absent from
 * `TypeBacking.fields` is a plain stored column (zero overhead). When present:
 *  - `name`    remaps the stored column read for this conceptual field
 *              (default = the conceptual field name); it is NOT a table/column
 *              path, just the underlying field name.
 *  - `compute` supplies the field's VALUE (replacing the stored column).
 *  - `access`  is FIELD-level security: a gate that nulls the value when denied.
 *  - `joins`   names the `TypeBacking.joins` this field needs; each is added to
 *              the query ONCE if-and-only-if this (or another referencing) field
 *              is emitted, and deduped by name. A `compute` / `access` `Expr`
 *              reads a named join's columns via `joinAlias(source, name)`. A
 *              field with `joins` but no `compute` whose (first) named join is a
 *              LATERAL with a `pick` defaults its value to that picked column.
 */
export interface FieldBacking {
  /** Underlying stored field name (default = the conceptual field name). */
  name?: string;
  /** The field's computed value, when present; otherwise the stored field. */
  compute?: Computed;
  /**
   * A default value materialized on INSERT when the field is OMITTED. Either a
   * ready `Value` or a factory (sync or async) producing one. Its PRESENCE alone
   * makes the field OPTIONAL-on-insert (there is no separate `hasDefault` flag):
   * the runtime evaluates the value / calls the factory and writes it into the
   * row. NOTE: a JS-factory default is a RUNTIME concern only — emitted SQL simply
   * omits the column and relies on the DATABASE's own column `DEFAULT`.
   */
  default?: Value | (() => Value | Promise<Value>);
  /** Field-level security: `CASE WHEN <access> THEN <value> ELSE NULL`. */
  access?: Access;
  /** Names of `TypeBacking.joins` this field needs (added once-if-referenced). */
  joins?: string[];
  /**
   * How a `search`-flagged field is searched. Overrides this Type's whole-type
   * `TypeBacking.search` for a field-narrowed `text-search` over this field.
   */
  search?: SearchBacking;
  /**
   * How a `semantic`-flagged field is scored. Overrides this Type's whole-type
   * `TypeBacking.semantic` for a field-narrowed `semantic` score over this field.
   */
  semantic?: SemanticBacking;
  /**
   * PHYSICAL join backing for a RELATION-typed field (ignored on any other field
   * kind). It drives a relation join's `ON` from explicit, LLM-HIDDEN foreign-key
   * columns (and/or a custom predicate) instead of the name convention. The
   * backing lives on the OWNING (belongs-to) relation; a materialized inverse
   * has-many REUSES the same FK (its forward relation's `relation` backing). See
   * {@link RelationBacking}.
   */
  relation?: RelationBacking;
}

// ─── Relation-join backing (physical FK columns / custom ON) ─────────────────
//
// A relation field's join `ON` is `source.local = target.foreign`. Absent any
// backing it is synthesized by NAME CONVENTION (belongs-to: `local` = the
// relation field, `foreign` = the target identity; has-many: the FK on the
// target). `RelationBacking` overrides that with EXPLICIT physical columns — the
// key columns are DEV-SIDE only, never in the conceptual `TypeDef` / `FieldDef`
// the LLM sees. Composite FKs are supported (every pair ANDed), and a fully
// custom `on` predicate is available (alias-correct, dual SQL/runtime).

/**
 * One physical key-column pair backing a relation join's `ON`, ORIENTED to the
 * join's SOURCE (left) alias and TARGET alias:
 * `ON <leftAlias>.<localField> = <targetAlias>.<foreignField>`. A resolved
 * relation ON is a list of these (all ANDed), so composite FKs are one list.
 */
export interface RelationOnPair {
  /** Column on the join's SOURCE (left) alias. */
  readonly localField: string;
  /** Column on the join's TARGET alias. */
  readonly foreignField: string;
}

/**
 * A fully custom relation `ON`, given the two BOUND aliases (alias-correct, so
 * aliased / self-joins resolve). `localAlias` is the side that DECLARES the
 * relation (the belongs-to side, where this backing lives); `joinedAlias` is the
 * belongs-to TARGET. When a has-many inverse reuses this backing the resolver
 * passes the same two aliases (declarer, target), so the predicate is written
 * ONCE and is direction-independent (`ON` is symmetric). Precedence mirrors
 * `Access` / `Computed`: SQL prefers `sql` then `expr`; the runtime prefers
 * `run` then `expr`. A mode with no applicable path (SQL with only `run`, or the
 * runtime with only `sql`) falls back to the `keys` mapping.
 */
export interface RelationOn {
  /**
   * The DUAL predicate path: a boolean `Expr` emitted to SQL AND evaluated in
   * memory. Reference the two supplied aliases for every column (never a literal
   * Type name).
   */
  expr?: (localAlias: string, joinedAlias: string) => Expr;
  /** SQL-only override: a raw boolean `SqlText`. Reference the supplied aliases. */
  sql?: (localAlias: string, joinedAlias: string, ctx: SqlContext) => SqlText;
  /**
   * Runtime-only override: given the two aliases + context, return a MATCHER over
   * the two candidate records (`localRow` = the declarer side, `joinedRow` = the
   * target side) deciding whether they join.
   */
  run?: (
    localAlias: string,
    joinedAlias: string,
    ctx: RuntimeContext,
  ) => (localRow: SourceRecord, joinedRow: SourceRecord) => boolean | Promise<boolean>;
}

/**
 * DEV-SIDE physical backing for a relation field's join `ON`. Both members are
 * optional; `on` (a custom predicate) takes precedence over `keys` (physical FK
 * columns), which in turn takes precedence over the NAME CONVENTION (used when
 * this backing is absent).
 */
export interface RelationBacking {
  /**
   * Physical key-column pairs forming the `ON` (ALL ANDed; composite FKs
   * supported). `local` is the column on the side that DECLARES the relation
   * (the belongs-to side); `foreign` is the column on the TARGET side and
   * DEFAULTS to the target's identity field. Example (composite):
   * `keys: [{ local: 'a_id', foreign: 'a' }, { local: 'b_id', foreign: 'b' }]`
   * ⇒ `ON src.a_id = tgt.a AND src.b_id = tgt.b`.
   */
  keys?: ReadonlyArray<{ local: string; foreign?: string }>;
  /** A dynamic, alias-correct custom `ON` (overrides `keys`). See {@link RelationOn}. */
  on?: RelationOn;
}

/**
 * Map a `RelationBacking`'s declared `keys` to ON column pairs ORIENTED to a
 * join's source (left) + target aliases. `forward` = the join goes the
 * belongs-to direction (the source alias is the declaring side); when `false`
 * (a has-many inverse reusing the forward FK) the orientation is swapped.
 * `targetIdentity` supplies the default column for any pair that omits `foreign`
 * (the belongs-to TARGET's identity field).
 */
export function relationKeyColumns(
  keys: ReadonlyArray<{ local: string; foreign?: string }>,
  forward: boolean,
  targetIdentity: string,
): RelationOnPair[] {
  return keys.map((k) => {
    const declarerCol = k.local;
    const targetCol = k.foreign ?? targetIdentity;
    return forward
      ? { localField: declarerCol, foreignField: targetCol }
      : { localField: targetCol, foreignField: declarerCol };
  });
}

/**
 * Resolve a custom relation `ON` for SQL emission (prefers `sql`, then the dual
 * `expr`). Returns `undefined` when neither path applies (an `on` carrying only
 * `run`), so the caller falls back to the `keys` mapping.
 */
export function resolveRelationOnSql(
  on: RelationOn,
  localAlias: string,
  joinedAlias: string,
  ctx: SqlContext,
): SqlText | undefined {
  if (on.sql) return on.sql(localAlias, joinedAlias, ctx);
  if (on.expr) return on.expr(localAlias, joinedAlias).toSQL(ctx.dialect, ctx);
  return undefined;
}

/**
 * Resolve a custom relation `ON` for the in-memory runtime (prefers `run`, then
 * the dual `expr`) over a MERGED row carrying both bound aliases' records.
 * Returns `undefined` when neither path applies (an `on` carrying only `sql`),
 * so the caller falls back to the `keys` mapping.
 */
export async function resolveRelationOnRun(
  on: RelationOn,
  localAlias: string,
  joinedAlias: string,
  row: SourceRow,
  ctx: RuntimeContext,
): Promise<boolean | undefined> {
  if (on.run) {
    const matcher = on.run(localAlias, joinedAlias, ctx);
    return matcher(row[localAlias], row[joinedAlias]);
  }
  if (on.expr) {
    const v = await on.expr(localAlias, joinedAlias).evaluate(ctx, row);
    return v.toBoolean();
  }
  return undefined;
}

/**
 * The dev-side backing for a whole Type. All members are optional:
 *  - `name`   is the real underlying source name (default = the Type name); SQL
 *             emits `<name> AS <typeName>` so references still use the Type name.
 *  - `access` is ROW-level security: ANDed into the WHERE (SQL) and applied as a
 *             row filter on load (runtime).
 *  - `joins`  maps a join NAME → its `JoinBacking`. A join is hidden and shared:
 *             it appears in a query only when some referenced field opts into it
 *             via `FieldBacking.joins`, and many fields sharing one collapse to a
 *             single planned join (deduped by name).
 *  - `fields` maps a conceptual field name → its `FieldBacking`.
 */
export interface TypeBacking {
  /** Real underlying source name (default = the Type name). */
  name?: string;
  /** Row-level security predicate for every occurrence of this Type. */
  access?: Access;
  /**
   * SOFT, suppressible default scopes for this Type's rows (think soft-delete /
   * archived filtering). Each is ANDed into the WHERE of every occurrence of the
   * Type — for the ops it covers — UNLESS the query references one of the
   * condition's `without` fields in a CONDITION position on that occurrence, at
   * which point the scope LIFTS for that source only. Distinct from `access`
   * (RLS), which ALWAYS applies and is NEVER suppressed; a default condition ANDs
   * in ALONGSIDE it. See {@link DefaultCondition}.
   */
  defaultConditions?: readonly DefaultCondition[];
  /** Named hidden joins, shared + deduped by name (added once-if-referenced). */
  joins?: Record<string, JoinBacking>;
  /** Per-field backing, keyed by conceptual field name. */
  fields?: Record<string, FieldBacking>;
  /**
   * How WHOLE-TYPE full-text search is performed for this Type (a `text-search`
   * with no `field`). A field-level `FieldBacking.search` overrides this for a
   * field-narrowed search.
   */
  search?: SearchBacking;
  /**
   * How WHOLE-TYPE semantic (embedding) similarity is performed for this Type (a
   * `semantic` with no `field`). A field-level `FieldBacking.semantic` overrides
   * this for a field-narrowed score.
   */
  semantic?: SemanticBacking;
}

// ─── Search + semantic backing ───────────────────────────────────────────────
//
// A conceptual field flagged `search: true` / `semantic: true` (in the plain,
// LLM-facing `TypeDef` / `FieldDef`, which these backings NEVER change) very
// often has a PHYSICAL field HIDDEN from the type system that already holds a
// precomputed `tsvector` (full-text) or `pgvector` embedding. These backings let
// a dev say HOW search / similarity runs per Type or field — most importantly by
// pointing at that hidden field via `vectorField`. Like `Access` / `Computed`,
// each offers per-mode overrides; every factory takes the bound `alias` FIRST
// and MUST reference it (never a literal Type name) so aliased / self-joined
// sources resolve to the correct source.

/**
 * How full-text search is performed for a backed Type / field. Precedence (both
 * modes): a full `sql` / `run` OVERRIDE wins; else a hidden `vectorField` (a
 * physical field the type system does not expose, holding a precomputed
 * `tsvector`) is used directly; else the engine's DEFAULT (the dialect's
 * `textSearch` over the conceptual text fields, or an in-memory token match).
 */
export interface SearchBacking {
  /**
   * A HIDDEN physical `tsvector` field (NOT a conceptual `TypeDef` field),
   * referenced as `<alias>."<vectorField>"`. In SQL it emits the dialect's
   * "the field IS ALREADY a tsvector" predicate (Postgres:
   * `<alias>."<vectorField>" @@ plainto_tsquery(<language>, <query>)`); in memory
   * its stored value is token-matched against the query.
   */
  vectorField?: string;
  /**
   * The text-search configuration for `to_tsvector` / `plainto_tsquery` (Postgres
   * default `'english'`). Only consulted for the `vectorField` SQL form; the base
   * dialect (which degrades to `LIKE`) ignores it.
   */
  language?: string;
  /**
   * SQL-only OVERRIDE producing a BOOLEAN predicate. Given the bound `alias`, the
   * `query` text already emitted as a bind param, and the emit context. MUST
   * reference `alias` (never a literal Type name) so aliased occurrences search
   * the correct source.
   */
  sql?: (alias: string, query: SqlText, ctx: SqlContext) => SqlText;
  /**
   * Runtime-only OVERRIDE producing whether `row` matches `query`. Given the
   * bound `alias` (which it MUST use — read `row[alias]`, never a hardcoded key —
   * so aliased / self-joined sources read the correct record), the current
   * evaluation row, and the query text.
   */
  run?: (
    alias: string,
    row: SourceRow,
    query: string,
    ctx: RuntimeContext,
  ) => boolean | Promise<boolean>;
}

/**
 * How semantic (embedding) similarity is performed for a backed Type / field.
 * Precedence — SQL: a full `sql` OVERRIDE wins; else a hidden `vectorField` (the
 * dialect's `similarity` over that field + the query-vector param); else the
 * engine DEFAULT. Runtime: a full `run` OVERRIDE wins; else a row vector from
 * `vector` / `vectorField`; else the engine DEFAULT (per-record embedding, then
 * embedding the row's text).
 */
export interface SemanticBacking {
  /**
   * A HIDDEN physical `pgvector` field (NOT a conceptual `TypeDef` field) holding
   * the row's embedding, referenced as `<alias>."<vectorField>"`. In SQL it is
   * the left operand of the dialect's `similarity`; in memory its stored array is
   * read as the row vector and cosine-compared to the query embedding.
   */
  vectorField?: string;
  /**
   * A per-Type / per-field embedder OVERRIDE used to embed the QUERY text (else
   * the run / engine embedder). Lets one Type embed against a different model.
   */
  embedder?: Embedder;
  /**
   * SQL-only OVERRIDE producing a NUMERIC score. Given the bound `alias`, the
   * query vector already emitted as a param (the dialect's vector param form),
   * and the emit context. MUST reference `alias` (never a literal Type name) so
   * aliased occurrences score the correct source.
   */
  sql?: (alias: string, queryVector: SqlText, ctx: SqlContext) => SqlText;
  /**
   * Runtime-only OVERRIDE producing the score directly. Given the bound `alias`
   * (which it MUST use — read `row[alias]`, never a hardcoded key), the current
   * evaluation row, and the already-embedded query vector.
   */
  run?: (
    alias: string,
    row: SourceRow,
    queryVector: number[],
    ctx: RuntimeContext,
  ) => number | Promise<number>;
  /**
   * Where the ROW's embedding comes from at runtime (an alternative to
   * `vectorField` — e.g. a provider lookup). Given the bound `alias` and the row;
   * returns the row vector, or `null` when unavailable (⇒ a score of 0).
   */
  vector?: (
    alias: string,
    row: SourceRow,
    ctx: RuntimeContext,
  ) => number[] | null | Promise<number[] | null>;
}

// ─── Resolved interpretations (discriminated unions) ─────────────────────────

/** The SQL-mode meaning of an `Access` result. */
export type AccessSql =
  | { readonly kind: 'noop' }
  | { readonly kind: 'allow' }
  | { readonly kind: 'deny' }
  | { readonly kind: 'predicate'; readonly sql: SqlText };

/** The runtime meaning of an `Access` result (predicate already collapsed to a boolean). */
export type AccessRun =
  | { readonly kind: 'noop' }
  | { readonly kind: 'visible'; readonly visible: boolean };

/** The SQL-mode resolution of a `Computed` value (`stored` ⇒ read the column). */
export type ComputeSql = { readonly kind: 'stored' } | { readonly kind: 'sql'; readonly sql: SqlText };

/** The runtime resolution of a `Computed` value (`stored` ⇒ read the record). */
export type ComputeRun = { readonly kind: 'stored' } | { readonly kind: 'value'; readonly value: Value };

/** Collapse a raw `Access.sql` / `Access.expr` SQL result into an `AccessSql`. */
function interpretAccessSql(r: SqlText | boolean | undefined): AccessSql {
  if (r === undefined) return { kind: 'noop' };
  if (typeof r === 'boolean') return r ? { kind: 'allow' } : { kind: 'deny' };
  return { kind: 'predicate', sql: r };
}

/**
 * Resolve an `Access` for SQL emission against `alias` (SQL prefers `sql`, then
 * the dual `expr`, then no-op).
 */
export function resolveAccessSql(access: Access, alias: string, ctx: SqlContext): AccessSql {
  if (access.sql) return interpretAccessSql(access.sql(alias, ctx));
  if (access.expr) {
    const r = access.expr(alias);
    if (r === undefined) return { kind: 'noop' };
    if (typeof r === 'boolean') return r ? { kind: 'allow' } : { kind: 'deny' };
    return { kind: 'predicate', sql: r.toSQL(ctx.dialect, ctx) };
  }
  return { kind: 'noop' };
}

/**
 * Resolve an `Access` for the in-memory runtime against `alias` (runtime prefers
 * `run`, then the dual `expr`, then no-op). A predicate `expr` is evaluated over
 * `row` and collapsed to a boolean.
 */
export async function resolveAccessRun(
  access: Access,
  alias: string,
  row: SourceRow,
  ctx: RuntimeContext,
): Promise<AccessRun> {
  if (access.run) {
    const r = await access.run(alias, row, ctx);
    return r === undefined ? { kind: 'noop' } : { kind: 'visible', visible: r };
  }
  if (access.expr) {
    const r = access.expr(alias);
    if (r === undefined) return { kind: 'noop' };
    if (typeof r === 'boolean') return { kind: 'visible', visible: r };
    const v = await r.evaluate(ctx, row);
    return { kind: 'visible', visible: v.toBoolean() };
  }
  return { kind: 'noop' };
}

// ─── Default conditions (soft, suppressible scope) ───────────────────────────
//
// A default condition is an archived-style DEFAULT SCOPE: while ACTIVE its
// `where` predicate is ANDed into the WHERE of a row-filtering op, per bound
// occurrence of the Type. It LIFTS for a given bound source the moment the query
// references one of its `without` fields (on THAT source) in a CONDITION
// position (WHERE / HAVING / a JOIN's `and`) — references in SELECT / ORDER BY /
// GROUP BY do NOT lift it. Unlike RLS (`TypeBacking.access`), which is never
// suppressed, a default condition is a soft default the query can reveal past.

/** The row-filtering ops a {@link DefaultCondition} may scope. INSERT is never scoped. */
export type DefaultConditionOp = 'select' | 'update' | 'delete';

/**
 * A soft, suppressible default scope (see the section note above). Members:
 *  - `where` — the predicate ANDed into WHERE while ACTIVE. Reuses `Access`: the
 *    dual `expr(alias)` path (emitted to SQL AND evaluated in memory), or a
 *    `sql` / `run` override. As for RLS a `true` / `undefined` result ⇒ no
 *    filter, a static `false` ⇒ no rows, a predicate ⇒ AND it.
 *  - `without` — referencing ANY of these fields (on the bound source) in a
 *    CONDITION position SUPPRESSES this condition for that source. When OMITTED
 *    it is DERIVED from the field-refs `where.expr(alias)` reads on `alias` (see
 *    {@link defaultConditionWithout}); a `where` with only `sql` / `run` (no
 *    `expr`) then derives to EMPTY — the condition is ALWAYS-ON (cannot be
 *    lifted), so set `without` EXPLICITLY to make such a condition suppressible.
 *  - `ops` — which row-filtering ops it scopes; DEFAULT all of
 *    `['select', 'update', 'delete']`. INSERT is NEVER scoped.
 *  - `description` — optional terse LLM-facing note; else auto-summarized.
 */
export interface DefaultCondition {
  /** The predicate ANDed into WHERE while ACTIVE (an `Access`; see the interface note). */
  where: Access;
  /** Condition-position fields (on the bound source) that LIFT this scope; derived from `where.expr` when omitted. */
  without?: readonly string[];
  /** Ops this condition scopes; defaults to `['select', 'update', 'delete']` (never INSERT). */
  ops?: readonly DefaultConditionOp[];
  /** Optional terse LLM-facing note; else an auto-summary is generated. */
  description?: string;
}

/** The ops a default condition scopes: its `ops`, else all of select / update / delete. */
export function defaultConditionOps(cond: DefaultCondition): readonly DefaultConditionOp[] {
  return cond.ops ?? ['select', 'update', 'delete'];
}

/** Resolve a default condition's `where` for SQL emission against `alias` (reuses the `Access` SQL path). */
export function resolveDefaultConditionSql(cond: DefaultCondition, alias: string, ctx: SqlContext): AccessSql {
  return resolveAccessSql(cond.where, alias, ctx);
}

/** Resolve a default condition's `where` for the in-memory runtime against `alias` (reuses the `Access` runtime path). */
export function resolveDefaultConditionRun(
  cond: DefaultCondition,
  alias: string,
  row: SourceRow,
  ctx: RuntimeContext,
): Promise<AccessRun> {
  return resolveAccessRun(cond.where, alias, row, ctx);
}

/** Resolve a `Computed` value for SQL emission (SQL prefers `sql`, then `expr`). */
export function resolveComputeSql(compute: Computed, alias: string, ctx: SqlContext): ComputeSql {
  if (compute.sql) return { kind: 'sql', sql: compute.sql(alias, ctx) };
  if (compute.expr) return { kind: 'sql', sql: compute.expr(alias).toSQL(ctx.dialect, ctx) };
  return { kind: 'stored' };
}

/** Resolve a `Computed` value for the runtime (runtime prefers `run`, then `expr`). */
export async function resolveComputeRun(
  compute: Computed,
  alias: string,
  row: SourceRow,
  ctx: RuntimeContext,
): Promise<ComputeRun> {
  if (compute.run) return { kind: 'value', value: await compute.run(alias, row, ctx) };
  if (compute.expr) return { kind: 'value', value: await compute.expr(alias).evaluate(ctx, row) };
  return { kind: 'stored' };
}

/** Whether a `FieldBacking` supplies a default value (making the field optional-on-insert). */
export function hasFieldDefault(fb: FieldBacking | undefined): boolean {
  return fb?.default !== undefined;
}

/**
 * Materialize a `FieldBacking.default` into a `Value` (awaiting a factory /
 * ready value), or `undefined` when the backing declares no default.
 */
export async function resolveFieldDefault(fb: FieldBacking | undefined): Promise<Value | undefined> {
  const d = fb?.default;
  if (d === undefined) return undefined;
  return typeof d === 'function' ? d() : d;
}

/** The SQL-mode resolution of a `JoinBacking` (`sql` raw fragment, else a `JoinSpec`). */
export type JoinSqlPlan =
  | { readonly kind: 'none' }
  | { readonly kind: 'sql'; readonly sql: SqlText }
  | { readonly kind: 'spec'; readonly spec: JoinSpec };

/** The runtime resolution of a `JoinBacking` (a `run` attach, else a `JoinSpec`). */
export type JoinRunPlan =
  | { readonly kind: 'none' }
  | { readonly kind: 'attach'; readonly join: RuntimeJoin }
  | { readonly kind: 'spec'; readonly spec: JoinSpec };

/** Resolve a `JoinBacking` for SQL emission against `alias` (SQL prefers `sql`, then `expr`). */
export function resolveJoinSql(join: JoinBacking, alias: string, ctx: SqlContext): JoinSqlPlan {
  if (join.sql) return { kind: 'sql', sql: join.sql(alias, ctx) };
  if (join.expr) return { kind: 'spec', spec: join.expr(alias) };
  return { kind: 'none' };
}

/** Resolve a `JoinBacking` for the runtime against `alias` (runtime prefers `run`, then `expr`). */
export function resolveJoinRun(join: JoinBacking, alias: string, ctx: RuntimeContext): JoinRunPlan {
  if (join.run) return { kind: 'attach', join: join.run(alias, ctx) };
  if (join.expr) return { kind: 'spec', spec: join.expr(alias) };
  return { kind: 'none' };
}

// ─── Search + semantic resolution (discriminated unions) ─────────────────────

/**
 * The SQL-mode resolution of a `SearchBacking` (a BOOLEAN predicate). `default`
 * ⇒ no backing form applied; the caller emits today's `Dialect.textSearch` over
 * the conceptual text fields.
 */
export type SearchSql =
  | { readonly kind: 'default' }
  | { readonly kind: 'sql'; readonly sql: SqlText };

/**
 * The runtime resolution of a `SearchBacking`. `match` ⇒ an override decided the
 * boolean; `text` ⇒ the caller token-matches this (hidden-field) text against
 * the query; `default` ⇒ today's whole-record / field token match.
 */
export type SearchRun =
  | { readonly kind: 'default' }
  | { readonly kind: 'match'; readonly matched: boolean }
  | { readonly kind: 'text'; readonly text: string };

/**
 * Resolve a `SearchBacking` for SQL emission against `alias` (prefers `sql`, then
 * a hidden `vectorField` via the dialect's tsvector predicate, then `default`).
 * `query` is the search text already emitted as a bind param.
 */
export function resolveSearchSql(
  search: SearchBacking,
  alias: string,
  query: SqlText,
  ctx: SqlContext,
): SearchSql {
  if (search.sql) return { kind: 'sql', sql: search.sql(alias, query, ctx) };
  if (search.vectorField !== undefined) {
    const field = ctx.dialect.field(alias, search.vectorField);
    return { kind: 'sql', sql: ctx.dialect.tsvectorSearch(field, query, search.language) };
  }
  return { kind: 'default' };
}

/**
 * Resolve a `SearchBacking` for the runtime against `alias` (prefers `run`, then
 * a hidden `vectorField` whose stored text is token-matched, then `default`).
 */
export async function resolveSearchRun(
  search: SearchBacking,
  alias: string,
  row: SourceRow,
  query: string,
  ctx: RuntimeContext,
): Promise<SearchRun> {
  if (search.run) return { kind: 'match', matched: await search.run(alias, row, query, ctx) };
  if (search.vectorField !== undefined) return { kind: 'text', text: readFieldText(row, alias, search.vectorField) };
  return { kind: 'default' };
}

/**
 * The SQL-mode resolution of a `SemanticBacking` (a NUMERIC score). `default` ⇒
 * the caller emits today's `Dialect.similarity` over the default embedding
 * fragment.
 */
export type SemanticSql =
  | { readonly kind: 'default' }
  | { readonly kind: 'sql'; readonly sql: SqlText };

/**
 * The runtime resolution of a `SemanticBacking`. `score` ⇒ an override produced
 * the score directly; `vector` ⇒ the caller cosine-compares this row vector (or
 * scores 0 when `null`) to the query embedding; `default` ⇒ today's per-record /
 * embed-the-text path.
 */
export type SemanticRun =
  | { readonly kind: 'default' }
  | { readonly kind: 'score'; readonly score: number }
  | { readonly kind: 'vector'; readonly vector: number[] | null };

/**
 * Resolve a `SemanticBacking` for SQL emission against `alias` (prefers `sql`,
 * then a hidden `vectorField` via the dialect's `similarity`, then `default`).
 * `queryVector` is the query vector already emitted as the dialect's vector param.
 */
export function resolveSemanticSql(
  semantic: SemanticBacking,
  alias: string,
  queryVector: SqlText,
  ctx: SqlContext,
): SemanticSql {
  if (semantic.sql) return { kind: 'sql', sql: semantic.sql(alias, queryVector, ctx) };
  if (semantic.vectorField !== undefined) {
    const field = ctx.dialect.field(alias, semantic.vectorField);
    return { kind: 'sql', sql: ctx.dialect.similarity(field, queryVector) };
  }
  return { kind: 'default' };
}

/**
 * Resolve a `SemanticBacking` for the runtime against `alias` (prefers `run`,
 * then a `vector` producer, then a hidden `vectorField` read off the row, then
 * `default`). `queryVector` is the already-embedded query vector.
 */
export async function resolveSemanticRun(
  semantic: SemanticBacking,
  alias: string,
  row: SourceRow,
  queryVector: number[],
  ctx: RuntimeContext,
): Promise<SemanticRun> {
  if (semantic.run) return { kind: 'score', score: await semantic.run(alias, row, queryVector, ctx) };
  if (semantic.vector) return { kind: 'vector', vector: await semantic.vector(alias, row, ctx) };
  if (semantic.vectorField !== undefined) return { kind: 'vector', vector: readFieldVector(row, alias, semantic.vectorField) };
  return { kind: 'default' };
}

/** Read a hidden field's stored text off `row[alias]` (string / string[] / ''). */
function readFieldText(row: SourceRow, alias: string, field: string): string {
  const rec = row[alias];
  if (!rec) return '';
  const cell = rec[field];
  if (typeof cell === 'string') return cell;
  if (Array.isArray(cell)) return cell.filter((x): x is string => typeof x === 'string').join(' ');
  return '';
}

/** Read a hidden field's stored embedding off `row[alias]` (a `number[]`, else `null`). */
export function readFieldVector(row: SourceRow, alias: string, field: string): number[] | null {
  const rec = row[alias];
  if (!rec) return null;
  const cell = rec[field];
  if (!Array.isArray(cell)) return null;
  const out: number[] = [];
  for (const v of cell) {
    if (typeof v !== 'number') return null;
    out.push(v);
  }
  return out;
}

/**
 * A parsed wrapper around a Type's `TypeBacking`, cached per Type by the engine.
 * It exposes the lookups the engine / `FieldRefExpr` / RLS injection need, so
 * callers never reach into the raw `TypeBacking` shape directly.
 */
export class Backing {
  constructor(
    /** The conceptual Type name this backing belongs to. */
    readonly typeName: string,
    /** The raw backing definition the developer registered. */
    readonly def: TypeBacking,
  ) {}

  /** The real underlying source name (`def.name ?? typeName`). */
  sourceName(): string {
    return this.def.name ?? this.typeName;
  }

  /** The backing for conceptual field `field`, or `undefined` for a plain column. */
  fieldBacking(field: string): FieldBacking | undefined {
    return this.def.fields?.[field];
  }

  /** The row-level-security `Access` for this Type, or `undefined`. */
  rls(): Access | undefined {
    return this.def.access;
  }

  /** The soft, suppressible default conditions declared on this Type (empty when none). */
  defaultConditions(): readonly DefaultCondition[] {
    return this.def.defaultConditions ?? [];
  }

  /** The named `JoinBacking` `name`, or `undefined` when this Type declares none. */
  join(name: string): JoinBacking | undefined {
    return this.def.joins?.[name];
  }
}
