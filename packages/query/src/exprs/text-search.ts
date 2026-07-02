/**
 * TextSearchExpr — full-text search predicate over a BOUND SOURCE (optionally
 * one field). A `BoolExpr`.
 *
 *  - `source` (required) is the bound source to search; `field` (optional)
 *    narrows the search to a single text field, otherwise the whole source's
 *    searchable text is matched.
 *  - `query` is a literal string or a `param` whose bound value supplies the
 *    search text.
 *  - `validateWalk` requires the source be searchable (whole-source search) or
 *    the named field be a text field.
 *  - `evaluate` does a basic token match; `toSQL` emits the dialect's
 *    `textSearch` (ANSI substring `LIKE` vs Postgres tsvector).
 */
import { z } from 'zod';
import type { ExprDef, TextSearchExprDef } from '../schema';
import type { SchemaOptions } from '../node';
import { textSearchSchema } from '../schema-build';
import type { Registry } from '../registry';
import type { QueryEngine } from '../engine';
import type { QueryScope } from '../scope';
import type { ComputedResolved } from '../resolved-type';
import type { Problems } from '../problem';
import { BoolExpr, Expr, type ExprClass, type ValidateContext } from '../expr';
import { boolResult } from './_shared';
import { ParamExpr } from './param';
import { TextFieldType } from '../field-types/index';
import type { Type } from '../type';
import type { RuntimeContext } from '../runtime/context';
import type { SourceRecord, SourceRow } from '../runtime/row';
import type { Cost } from '../cost';
import { addCost, TEXT_SEARCH_ROW_PENALTY } from '../cost';
import type { Dialect } from '../sql/dialect';
import { type SqlContext, SqlText } from '../sql/emit';

/** The parsed query text source: a literal or a bound param. */
export type TextSearchQuery = { kind: 'text'; text: string } | { kind: 'param'; param: ParamExpr };

/** Parse the JSON query (`string | ParamExprDef`) into the runtime union. */
function parseQuery(def: string | { kind: 'param'; name: string }, registry: Registry): TextSearchQuery {
  if (typeof def === 'string') return { kind: 'text', text: def };
  const expr = registry.parseExpr(def);
  if (expr instanceof ParamExpr) return { kind: 'param', param: expr };
  throw new Error(`TextSearchExpr: expected a param query, got '${expr.kind}'.`);
}

/** A full-text search predicate over a bound source (optionally one field). A `BoolExpr`. */
export class TextSearchExpr extends BoolExpr {
  static readonly KIND = 'text-search' as const;
  readonly kind = TextSearchExpr.KIND;

  /** Wrap the bound `source` (optional `field`) and the search query text. */
  constructor(
    readonly source: string,
    readonly field: string | undefined,
    readonly query: TextSearchQuery,
  ) {
    super();
  }

  /** Reconstruct a TextSearchExpr from its JSON def (validates the `kind` discriminant). */
  static from(json: ExprDef, registry: Registry): TextSearchExpr {
    if (json.kind !== 'text-search') {
      throw new Error(`TextSearchExpr.from: expected 'text-search', got '${json.kind}'`);
    }
    return new TextSearchExpr(json.source, json.field, parseQuery(json.query, registry));
  }

  /** Zod schema for this expr kind's JSON shape. */
  static toSchema(opts: SchemaOptions): z.ZodTypeAny {
    // Depth-aware: `refs:'open'` (or a bare call) yields free-string source +
    // field; tighter levels pair them to a searchable Type (see `refSchema`).
    return textSearchSchema(opts.types ?? [], opts.depth?.refs ?? 'open');
  }

  override forEachChild(visit: (child: Expr) => void): void {
    if (this.query.kind === 'param') visit(this.query.param);
  }

  /** Resolve to a non-null boolean computed type. */
  override resolve(_engine: QueryEngine, _scope: QueryScope): ComputedResolved {
    return boolResult([], false, false);
  }

  /** Validate the source is searchable (or the named field is text), and the query side. */
  validateWalk(
    engine: QueryEngine,
    scope: QueryScope,
    p: Problems,
    ctx: ValidateContext,
  ): ComputedResolved {
    const bound = scope.lookup(this.source);
    if (!bound) {
      p.error('text-search.unknown-source', `Unknown source '${this.source}' for text search.`);
    } else if (bound.kind !== 'type') {
      p.error('text-search.not-a-type', `Source '${this.source}' is not a type, so it cannot be searched.`);
    } else if (this.field === undefined) {
      // Whole-source search ⇒ the Type itself must be full-text-search-eligible.
      if (!bound.type.isSearchable()) {
        p.error('text-search.not-searchable', `Type '${bound.type.name}' is not full-text-search-eligible.`);
      }
    } else {
      // Field-narrowed search ⇒ the field must exist and be text.
      const field = bound.type.field(this.field);
      if (!field) {
        p.at('field', () =>
          p.error('text-search.unknown-field', `Type '${bound.type.name}' has no field '${this.field}'.`),
        );
      } else if (field.fieldType.resolve() !== 'text') {
        p.at('field', () =>
          p.error('text-search.non-text', `Text search requires a text field; '${this.field}' is ${field.fieldType.resolve()}.`),
        );
      }
    }
    if (this.query.kind === 'param') {
      const param = this.query.param;
      p.at('query', () => param.validateWalk(engine, scope, p, ctx));
    }
    return this.resolve(engine, scope);
  }

  /** Child cost plus a per-row text-scan penalty. */
  override cost(engine: QueryEngine, scope: QueryScope): Cost {
    // A text-search predicate implies a per-row scan penalty.
    return addCost(this.childCost(engine, scope), { rows: 0, bytes: TEXT_SEARCH_ROW_PENALTY });
  }

  /** The query text for this run (a literal, or a param's bound value). */
  private queryText(ctx: RuntimeContext): string {
    return this.query.kind === 'text' ? this.query.text : ctx.param(this.query.param.name).toText();
  }

  /** The Type bound under `source`, when known (for field metadata). */
  private boundType(ctx: RuntimeContext): Type | undefined {
    return ctx.sourceType(this.source) ?? ctx.engine.type(this.source);
  }

  /**
   * Basic token match: the searched text matches when it contains every
   * whitespace-separated token of the query. CASE-INSENSITIVE unless the
   * searched field is `sensitive`. The dialect tsvector / ranking forms are a
   * SQL-emission concern.
   */
  async evaluateBool(
    ctx: RuntimeContext,
    row: SourceRow,
    _group?: readonly SourceRow[],
  ): Promise<boolean> {
    const rec = row[this.source] ?? ctx.correlation?.[this.source];
    if (!rec) return false;
    const type = this.boundType(ctx);
    const sensitive = this.field !== undefined ? type?.field(this.field)?.fieldType.textCaseSensitive() ?? false : false;
    const fold = (s: string): string => (sensitive ? s : s.toLowerCase());
    const haystack = fold(this.haystackText(rec));
    const tokens = fold(this.queryText(ctx)).split(/\s+/).filter((t) => t.length > 0);
    if (tokens.length === 0) return false;
    return tokens.every((t) => haystack.includes(t));
  }

  /** The searched text of a record: one field, or all string values. */
  private haystackText(rec: SourceRecord): string {
    if (this.field !== undefined) {
      const v = rec[this.field];
      return typeof v === 'string' ? v : v == null ? '' : String(v);
    }
    const parts: string[] = [];
    for (const key of Object.keys(rec)) {
      const v = rec[key];
      if (typeof v === 'string') parts.push(v);
    }
    return parts.join(' ');
  }

  /** Emit the dialect's `textSearch` over the resolved column. */
  toSQL(dialect: Dialect, ctx: SqlContext): SqlText {
    const col = this.column(dialect, ctx);
    const sensitive = this.sensitiveColumn(ctx);
    return dialect.textSearch(col, this.querySQLText(ctx), sensitive);
  }

  /** The SQL column to search: the named field, else the source's first
   *  searchable text field (fallback: a `search` pseudo-column). */
  private column(dialect: Dialect, ctx: SqlContext): SqlText {
    if (this.field !== undefined) return dialect.field(this.source, this.field);
    const bound = ctx.scope.lookup(this.source);
    if (bound && bound.kind === 'type') {
      const searchable = bound.type.fields.find(
        (f) => f.fieldType instanceof TextFieldType && f.fieldType.options.search === true,
      );
      if (searchable) return dialect.field(this.source, searchable.name);
      const text = bound.type.fields.find((f) => f.fieldType.resolve() === 'text');
      if (text) return dialect.field(this.source, text.name);
    }
    return dialect.field(this.source, 'search');
  }

  /** Case-sensitivity of the searched field (false for whole-source search). */
  private sensitiveColumn(ctx: SqlContext): boolean {
    if (this.field === undefined) return false;
    const bound = ctx.scope.lookup(this.source);
    if (!bound || bound.kind !== 'type') return false;
    return bound.type.field(this.field)?.fieldType.textCaseSensitive() ?? false;
  }

  /** The query text as a plain string for the dialect's `textSearch`. */
  private querySQLText(ctx: SqlContext): string {
    if (this.query.kind === 'text') return this.query.text;
    const name = this.query.param.name;
    const v = Object.prototype.hasOwnProperty.call(ctx.params, name) ? ctx.params[name] : null;
    return v == null ? '' : String(v);
  }

  /** Serialize back to its JSON ExprDef. */
  toJSON(): TextSearchExprDef {
    const def: TextSearchExprDef = {
      kind: 'text-search',
      source: this.source,
      query: this.query.kind === 'text' ? this.query.text : this.query.param.toJSON(),
    };
    if (this.field !== undefined) def.field = this.field;
    return def;
  }

  /** Deep-copy this expr. */
  clone(): TextSearchExpr {
    const query: TextSearchQuery =
      this.query.kind === 'param' ? { kind: 'param', param: this.query.param.clone() } : { ...this.query };
    return new TextSearchExpr(this.source, this.field, query);
  }

  /** Render as the readable `search(...)` DSL form. */
  override toCode(): string {
    const target = this.field !== undefined ? `${this.source}.${this.field}` : this.source;
    const q = this.query.kind === 'text' ? JSON.stringify(this.query.text) : `:${this.query.param.name}`;
    return `search(${target}, ${q})`;
  }
}

const _check: ExprClass = TextSearchExpr;
void _check;
