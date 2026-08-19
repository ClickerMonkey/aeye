/**
 * Shared full-text helpers for the two text expressions — the `text-search`
 * predicate (`TextSearchExpr`) and the numeric `text-score` relevance
 * (`TextScoreExpr`). Both bind to a source (optionally one field) and take a
 * literal / param query, and both resolve the SAME searched COLUMN, query text,
 * case-sensitivity, and haystack text. Centralizing those here keeps the two
 * exprs in lock-step (a fix to column resolution or query extraction applies to
 * both) with no duplicated branch logic.
 */
import type { Registry } from '../registry';
import { ParamExpr } from './param';
import { INVALID, type Shape } from '../shape';
import { QueryTypeError } from '../problem';
import type { Type } from '../type';
import type { FieldType } from '../field-type';
import type { SearchBacking } from '../backing';
import { effectiveCasing, foldsAtRuntime, type TextCasing } from '../text-casing';
import type { RuntimeContext } from '../runtime/context';
import type { SourceRecord } from '../runtime/row';
import type { Dialect } from '../sql/dialect';
import { type SqlContext, SqlText } from '../sql/emit';

/** The parsed query text source: a literal or a bound param. */
export type TextSearchQuery = { kind: 'text'; text: string } | { kind: 'param'; param: ParamExpr };

/** Parse the JSON query (`string | ParamExprDef`) into the runtime union. */
export function parseTextQuery(def: string | { kind: 'param'; name: string }, registry: Registry): TextSearchQuery {
  if (typeof def === 'string') return { kind: 'text', text: def };
  const expr = registry.parseExpr(def);
  if (expr instanceof ParamExpr) return { kind: 'param', param: expr };
  throw new Error(`TextSearchQuery: expected a param query, got '${expr.kind}'.`);
}

/**
 * Structural {@link Shape} for the `query` slot shared by `text-search` /
 * `text-score`: a literal STRING → `{ kind:'text' }`, else a `param` expr →
 * `{ kind:'param' }` (validated by `ParamExpr.SHAPE`). The zod-free parallel to
 * {@link parseTextQuery}; it NEVER throws (a non-string / non-param records a
 * problem and returns INVALID rather than throwing like `parseTextQuery`).
 */
export function textQueryShape(): Shape<TextSearchQuery> {
  return {
    check(json, ctx) {
      if (typeof json === 'string') return { kind: 'text', text: json };
      const built = ParamExpr.SHAPE.check(json, ctx);
      return built === INVALID ? INVALID : { kind: 'param', param: built };
    },
  };
}

/** The query text for a run (a literal, or a param's bound value). */
export function queryRunText(ctx: RuntimeContext, query: TextSearchQuery): string {
  return query.kind === 'text' ? query.text : ctx.param(query.param.name).toText();
}

/** The query text as a plain string for the dialect's SQL (a literal, or a param value in `ctx.params`). */
export function querySqlText(ctx: SqlContext, query: TextSearchQuery): string {
  if (query.kind === 'text') return query.text;
  const name = query.param.name;
  const v = Object.prototype.hasOwnProperty.call(ctx.params, name) ? ctx.params[name] : null;
  return v == null ? '' : String(v);
}

/** The Type bound under `source`, when known (for field metadata). */
export function boundTypeOf(ctx: RuntimeContext, source: string): Type | undefined {
  return ctx.sourceType(source) ?? ctx.engine.type(source);
}

/**
 * The SQL column to search / rank — the named `field`, and NOTHING ELSE.
 *
 * An UNNARROWED search/score has no column of its own: what it wants is the
 * Type's searchable DOCUMENT, which only a `SearchBacking` can supply (a
 * precomputed `vectorField`, or a `sql` override). This used to guess one —
 * the first `search`-flagged text field, else the first text field of any kind,
 * else a column literally named `search` — so a query asking for a multi-field
 * document silently searched one column, and which column depended on field
 * ORDER. Validation now refuses the unbacked whole-source form up front
 * (`text-search.unbacked` / `text-score.unbacked`), so reaching here without a
 * `field` means a backing was declared but offers no SQL path; refusing is the
 * only honest answer left.
 */
export function searchColumn(dialect: Dialect, ctx: SqlContext, source: string, field: string | undefined): SqlText {
  if (field !== undefined) return dialect.field(source, field);
  const bound = ctx.scope.lookup(source);
  const typeName = bound && bound.kind === 'type' ? bound.type.name : source;
  throw new QueryTypeError({
    path: [], code: 'text-search.unbacked', severity: 'error',
    message:
      `Whole-source text search / score on '${source}' (type '${typeName}') has no SQL-emitting search ` +
      `backing (a 'vectorField' or a 'sql' override), so there is no column to search. Narrow it to a ` +
      `text field, or complete the Type's SearchBacking.`,
  });
}

/** The `SearchBacking` in effect for a bound `source` (+ field), or `undefined`. */
export function searchBackingOf(ctx: SqlContext, source: string, field: string | undefined): SearchBacking | undefined {
  const bound = ctx.scope.lookup(source);
  if (!bound || bound.kind !== 'type') return undefined;
  return ctx.engine.searchBacking(bound.type.name, field);
}

/**
 * Whether matching against a single field is case-SENSITIVE: the field's own
 * declared {@link TextCasing} when it makes one, else the engine's default. The
 * one-sided form of `effectiveCasing`, shared by every road that searches or
 * scores ONE column, so the runtime and SQL halves of `text-search` /
 * `text-score` cannot resolve the same field differently.
 *
 * Search collapses the three casings to a BOOLEAN, and correctly: the two
 * insensitive casings pick the same emission. A folded search goes through the
 * dialect's real text-search machinery (`to_tsvector` / `plainto_tsquery`,
 * which folds as part of what it does and ranks through a GIN index), so there
 * is no `LOWER(col)` predicate for `'collated'` to spare. Only `'exact'` changes
 * the emission — it degrades to an exact-case `LIKE`.
 */
export function fieldCaseSensitive(fieldType: FieldType | undefined, engineDefault: TextCasing): boolean {
  return !foldsAtRuntime(effectiveCasing(fieldType?.textCasing(), undefined, engineDefault));
}

/**
 * {@link fieldCaseSensitive} for the SQL road, resolving the searched field off
 * the bound source. An unbound / non-type source resolves no field, so it takes
 * the engine default alone.
 *
 * The `field === undefined` guard is defensive only: an unnarrowed search never
 * reaches here, because `searchColumn` refuses it first.
 */
export function searchSensitive(ctx: SqlContext, source: string, field: string | undefined): boolean {
  /* v8 ignore next -- unreachable: `searchColumn` refuses an unnarrowed search before this is called */
  if (field === undefined) return fieldCaseSensitive(undefined, ctx.engine.textCasing);
  const bound = ctx.scope.lookup(source);
  const fieldType = bound?.kind === 'type' ? bound.type.field(field)?.fieldType : undefined;
  return fieldCaseSensitive(fieldType, ctx.engine.textCasing);
}

/** The searched text of a record: one field, or all string values joined. */
export function haystackText(rec: SourceRecord, field: string | undefined): string {
  if (field !== undefined) {
    const v = rec[field];
    return typeof v === 'string' ? v : v == null ? '' : String(v);
  }
  const parts: string[] = [];
  for (const key of Object.keys(rec)) {
    const v = rec[key];
    if (typeof v === 'string') parts.push(v);
  }
  return parts.join(' ');
}

/** Fold `query` into whitespace tokens (lower-cased unless `sensitive`). */
function queryTokens(query: string, sensitive: boolean): string[] {
  const folded = sensitive ? query : query.toLowerCase();
  return folded.split(/\s+/).filter((t) => t.length > 0);
}

/** Whether `haystack` contains EVERY whitespace-separated token of `query`. */
export function tokenMatch(haystack: string, query: string, sensitive: boolean): boolean {
  const tokens = queryTokens(query, sensitive);
  if (tokens.length === 0) return false;
  const hay = sensitive ? haystack : haystack.toLowerCase();
  return tokens.every((t) => hay.includes(t));
}

/**
 * A deterministic in-memory relevance score in [0, 1]: the FRACTION of the
 * query's whitespace tokens that occur in `haystack` (0 when the query has no
 * tokens). Case-insensitive unless `sensitive`. A numeric analogue of
 * `tokenMatch` (which requires ALL tokens) for the `text-score` expr.
 */
export function relevanceScore(haystack: string, query: string, sensitive: boolean): number {
  const tokens = queryTokens(query, sensitive);
  if (tokens.length === 0) return 0;
  const hay = sensitive ? haystack : haystack.toLowerCase();
  const matched = tokens.filter((t) => hay.includes(t)).length;
  return matched / tokens.length;
}
