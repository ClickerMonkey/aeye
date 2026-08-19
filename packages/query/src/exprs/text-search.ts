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
import { didYouMean } from '../aids';
import { boolResult } from './_shared';
import { checkFieldExpr } from '../write-model';
import { resolveSearchSql, resolveSearchRun } from '../backing';
import type { RuntimeContext } from '../runtime/context';
import type { SourceRow } from '../runtime/row';
import type { Cost, CostContext } from '../cost';
import { TEXT_SEARCH_ROW_PENALTY } from '../cost';
import type { Dialect } from '../sql/dialect';
import { type SqlContext, SqlText } from '../sql/emit';
import { obj, lit, str } from '../shape';
import {
  type TextSearchQuery,
  parseTextQuery,
  textQueryShape,
  queryRunText,
  querySqlText,
  boundTypeOf,
  searchColumn,
  searchSensitive,
  fieldCaseSensitive,
  searchBackingOf,
  haystackText,
  tokenMatch,
} from './text-common';

export type { TextSearchQuery } from './text-common';

/** A full-text search predicate over a bound source (optionally one field). A `BoolExpr`. */
export class TextSearchExpr extends BoolExpr {
  static readonly KIND = 'text-search' as const;
  /** Concise LLM-facing summary of this expr kind (see `ExprClass.INSTRUCTIONS`). */
  static readonly INSTRUCTIONS = "Full-text predicate over a source (optionally one field) → boolean. NARROW it to a text `field` unless the Type declares a searchable whole-record DOCUMENT: an unbacked whole-source search is REFUSED (`text-search.unbacked`) rather than guessing a column." as const;
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
    return new TextSearchExpr(json.source, json.field, parseTextQuery(json.query, registry));
  }

  /**
   * Owned structural {@link Shape} — the zod-free parallel parser. Builds a
   * `TextSearchExpr` equal to `from`'s output on a valid def (`field` optional;
   * `query` is a string literal or a `param`). Accumulates problems in one pass
   * (never throws). The searchable-source / text-field checks remain in
   * `validateWalk`. See `shape/`.
   */
  static readonly SHAPE = obj(
    {
      kind: lit('text-search'),
      source: str('Source'),
      field: str('FieldName'),
      query: textQueryShape(),
    },
    (v) => new TextSearchExpr(v.source, v.field, v.query),
    { optional: ['field'], aid: 'Expr_text-search' },
  );

  /** Zod schema for this expr kind's JSON shape. */
  static toSchema(opts: SchemaOptions): z.ZodTypeAny {
    // Depth-aware: `refs:'open'` (or a bare call) yields free-string source +
    // field; tighter levels pair them to a searchable Type (see `refSchema`).
    return textSearchSchema(opts.types ?? [], opts.depth?.refs ?? 'open', opts.cache);
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
      p.error('text-search.unknown-source', `Unknown source '${this.source}' for text search.${didYouMean(this.source, scope.sources())}`);
    } else if (bound.kind !== 'type') {
      p.error('text-search.not-a-type', `Source '${this.source}' is not a type, so it cannot be searched.`);
    } else if (this.field === undefined) {
      // Whole-source search ⇒ the TYPE (not merely one of its fields) must be
      // declared searchable, AND actually backed. A `SearchBacking` IS the
      // "this document exists and here is how to search it" declaration; with
      // none, the only thing left was a guess about which column stood in for
      // the document, so refuse and name both remedies.
      if (!bound.type.isSearchable()) {
        p.error('text-search.not-searchable', `Type '${bound.type.name}' is not full-text-search-eligible.`);
      } else if (engine.searchBacking(bound.type.name, undefined) === undefined) {
        p.error(
          'text-search.unbacked',
          `Type '${bound.type.name}' is declared searchable but has no search backing, so it has no ` +
            `whole-record document to search. Narrow the search to a text field, or declare a SearchBacking for the Type.`,
        );
      }
    } else {
      // Field-narrowed search ⇒ the field must exist and be text.
      const fieldName = this.field;
      const field = bound.type.field(fieldName);
      if (!field) {
        p.at('field', () =>
          p.error('text-search.unknown-field', `Type '${bound.type.name}' has no field '${fieldName}'.${didYouMean(fieldName, bound.type.fields.map((f) => f.name))}`),
        );
      } else if (field.fieldType.resolve() !== 'text') {
        p.at('field', () =>
          p.error('text-search.non-text', `Text search requires a text field; '${this.field}' is ${field.fieldType.resolve()}.`),
        );
      } else {
        // WRITE-MODEL: honor the field's `exprs` restriction for this kind.
        checkFieldExpr('text-search', field, this.source, p);
      }
    }
    if (this.query.kind === 'param') {
      const param = this.query.param;
      p.at('query', () => param.validateWalk(engine, scope, p, ctx));
    }
    return this.resolve(engine, scope);
  }

  /** A text-search predicate's own value cost is just its operands' (a boolean). */
  override cost(ctx: CostContext, scope: QueryScope): Cost {
    return this.childCost(ctx, scope);
  }

  /** Each SCANNED row pays a full-text scan penalty (applied per row by the WHERE cost model). */
  override scanRowPenalty(): number {
    return TEXT_SEARCH_ROW_PENALTY;
  }

  /**
   * Basic token match: the searched text matches when it contains every
   * whitespace-separated token of the query. case-FOLDED unless the
   * searched field's effective {@link TextCasing} is `'exact'`. When a `SearchBacking` is in effect its `run`
   * override decides the boolean, or its hidden `vectorField`'s stored text is
   * token-matched; otherwise today's whole-record / field text is matched. The
   * dialect tsvector / ranking forms are a SQL-emission concern.
   */
  async evaluateBool(
    ctx: RuntimeContext,
    row: SourceRow,
    _group?: readonly SourceRow[],
  ): Promise<boolean> {
    const rec = row[this.source] ?? ctx.correlation?.[this.source];
    if (!rec) return false;
    const type = boundTypeOf(ctx, this.source);
    const sensitive = fieldCaseSensitive(this.field !== undefined ? type?.field(this.field)?.fieldType : undefined, ctx.engine.textCasing);
    const query = queryRunText(ctx, this.query);
    const backing = type ? ctx.engine.searchBacking(type.name, this.field) : undefined;
    if (backing) {
      const res = await resolveSearchRun(backing, this.source, row, query, ctx);
      if (res.kind === 'match') return res.matched;
      if (res.kind === 'text') return tokenMatch(res.text, query, sensitive);
      // 'default' ⇒ fall through to the whole-record / field token match.
    }
    return tokenMatch(haystackText(rec, this.field), query, sensitive);
  }

  /**
   * Emit the search predicate. When a `SearchBacking` is in effect its `sql`
   * override or hidden `vectorField` (the dialect's precomputed-tsvector
   * predicate) is emitted against the BOUND alias; otherwise the dialect's
   * `textSearch` over the resolved column.
   */
  toSQL(dialect: Dialect, ctx: SqlContext): SqlText {
    const backing = searchBackingOf(ctx, this.source, this.field);
    if (backing) {
      const res = resolveSearchSql(backing, this.source, SqlText.param(querySqlText(ctx, this.query)), ctx);
      if (res.kind === 'sql') return res.sql;
      // 'default' ⇒ fall through to the conceptual-field text search below.
    }
    const col = searchColumn(dialect, ctx, this.source, this.field);
    const sensitive = searchSensitive(ctx, this.source, this.field);
    return dialect.textSearch(col, querySqlText(ctx, this.query), sensitive);
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
