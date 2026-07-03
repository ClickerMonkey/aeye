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
import { TextFieldType } from '../field-types/index';
import type { Type } from '../type';
import type { SearchBacking } from '../backing';
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
 * The SQL column to search / rank: the named `field`, else the source's first
 * `search`-flagged text field, else its first text field, else a `search`
 * pseudo-column fallback.
 */
export function searchColumn(dialect: Dialect, ctx: SqlContext, source: string, field: string | undefined): SqlText {
  if (field !== undefined) return dialect.field(source, field);
  const bound = ctx.scope.lookup(source);
  if (bound && bound.kind === 'type') {
    const searchable = bound.type.fields.find(
      (f) => f.fieldType instanceof TextFieldType && f.fieldType.options.search === true,
    );
    if (searchable) return dialect.field(source, searchable.name);
    const text = bound.type.fields.find((f) => f.fieldType.resolve() === 'text');
    if (text) return dialect.field(source, text.name);
  }
  return dialect.field(source, 'search');
}

/** The `SearchBacking` in effect for a bound `source` (+ field), or `undefined`. */
export function searchBackingOf(ctx: SqlContext, source: string, field: string | undefined): SearchBacking | undefined {
  const bound = ctx.scope.lookup(source);
  if (!bound || bound.kind !== 'type') return undefined;
  return ctx.engine.searchBacking(bound.type.name, field);
}

/** Case-sensitivity of the searched field (false for whole-source / unbound / non-type). */
export function searchSensitive(ctx: SqlContext, source: string, field: string | undefined): boolean {
  if (field === undefined) return false;
  const bound = ctx.scope.lookup(source);
  if (!bound || bound.kind !== 'type') return false;
  return bound.type.field(field)?.fieldType.textCaseSensitive() ?? false;
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
