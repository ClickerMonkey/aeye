/**
 * TextScoreExpr — NUMERIC full-text RELEVANCE of a BOUND SOURCE (optionally one
 * field) against a query. The ranking counterpart of the `text-search`
 * predicate: it resolves to a non-null number, so it is usable in SELECT and
 * ORDER BY ("top 10 by text relevance").
 *
 *  - `source` (required) is the bound source to rank; `field` (optional) narrows
 *    to a single text field, otherwise the whole source's searchable text.
 *  - `query` is a literal string or a `param` whose bound value supplies the text.
 *  - `validateWalk` requires the source be searchable (whole-source) or the named
 *    field be a text field — identical eligibility to `text-search`.
 *  - `toSQL` emits the dialect's `textRank` / `tsvectorRank` (Postgres `ts_rank`),
 *    honoring a `SearchBacking` (`vectorField` / `language` / boolean `sql`
 *    override lifted to a numeric 0/1 via `matchScore`); the base dialect
 *    degrades to a numeric 0/1 match (never throws).
 *  - `evaluate` returns a deterministic in-memory relevance (the fraction of
 *    query tokens present), honoring `SearchBacking.run` (boolean ⇒ 1/0).
 */
import { z } from 'zod';
import type { ExprDef, TextScoreExprDef } from '../schema';
import type { SchemaOptions } from '../node';
import { textScoreSchema } from '../schema-build';
import type { Registry } from '../registry';
import type { QueryEngine } from '../engine';
import type { QueryScope } from '../scope';
import type { ComputedResolved } from '../resolved-type';
import type { Problems } from '../problem';
import { Expr, type ExprClass, type ValidateContext } from '../expr';
import { didYouMean } from '../aids';
import { numberResult } from './_shared';
import { checkFieldExpr } from '../write-model';
import { resolveSearchRun } from '../backing';
import { Value } from '../runtime/value';
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
  relevanceScore,
} from './text-common';

/** A NUMERIC full-text relevance score over a bound source (optionally one field). */
export class TextScoreExpr extends Expr {
  static readonly KIND = 'text-score' as const;
  /** Concise LLM-facing summary of this expr kind (see `ExprClass.INSTRUCTIONS`). */
  static readonly INSTRUCTIONS = "Numeric full-text relevance score of a source (optionally one field) → number (`ts_rank`). NARROW it to a text `field` unless the Type declares a searchable whole-record DOCUMENT: an unbacked whole-source score is REFUSED (`text-score.unbacked`) rather than guessing a column." as const;
  readonly kind = TextScoreExpr.KIND;

  /** Wrap the bound `source` (optional `field`) and the query text to rank against. */
  constructor(
    readonly source: string,
    readonly field: string | undefined,
    readonly query: TextSearchQuery,
  ) {
    super();
  }

  /** Reconstruct a TextScoreExpr from its JSON def (validates the `kind` discriminant). */
  static from(json: ExprDef, registry: Registry): TextScoreExpr {
    if (json.kind !== 'text-score') {
      throw new Error(`TextScoreExpr.from: expected 'text-score', got '${json.kind}'`);
    }
    return new TextScoreExpr(json.source, json.field, parseTextQuery(json.query, registry));
  }

  /**
   * Owned structural {@link Shape} — the zod-free parallel parser. Builds a
   * `TextScoreExpr` equal to `from`'s output on a valid def (`field` optional;
   * `query` is a string literal or a `param`). Accumulates problems in one pass
   * (never throws). The searchable-source / text-field checks remain in
   * `validateWalk`. See `shape/`.
   */
  static readonly SHAPE = obj(
    {
      kind: lit('text-score'),
      source: str('Source'),
      field: str('FieldName'),
      query: textQueryShape(),
    },
    (v) => new TextScoreExpr(v.source, v.field, v.query),
    { optional: ['field'], aid: 'Expr_text-score' },
  );

  /** Zod schema for this expr kind's JSON shape. */
  static toSchema(opts: SchemaOptions): z.ZodTypeAny {
    return textScoreSchema(opts.types ?? [], opts.depth?.refs ?? 'open', opts.cache);
  }

  override forEachChild(visit: (child: Expr) => void): void {
    if (this.query.kind === 'param') visit(this.query.param);
  }

  /** Resolve to a non-null numeric computed type (a relevance score). */
  resolve(_engine: QueryEngine, _scope: QueryScope): ComputedResolved {
    return numberResult([], false, false);
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
      p.error('text-score.unknown-source', `Unknown source '${this.source}' for text score.${didYouMean(this.source, scope.sources())}`);
    } else if (bound.kind !== 'type') {
      p.error('text-score.not-a-type', `Source '${this.source}' is not a type, so it cannot be scored.`);
    } else if (this.field === undefined) {
      // Whole-source score ⇒ same rule as `text-search`: the TYPE must be
      // declared searchable AND backed (see `TextSearchExpr.validateWalk`).
      if (!bound.type.isSearchable()) {
        p.error('text-score.not-searchable', `Type '${bound.type.name}' is not full-text-search-eligible.`);
      } else if (engine.searchBacking(bound.type.name, undefined) === undefined) {
        p.error(
          'text-score.unbacked',
          `Type '${bound.type.name}' is declared searchable but has no search backing, so it has no ` +
            `whole-record document to rank. Narrow the score to a text field, or declare a SearchBacking for the Type.`,
        );
      }
    } else {
      // Field-narrowed score ⇒ the field must exist and be text.
      const fieldName = this.field;
      const field = bound.type.field(fieldName);
      if (!field) {
        p.at('field', () =>
          p.error('text-score.unknown-field', `Type '${bound.type.name}' has no field '${fieldName}'.${didYouMean(fieldName, bound.type.fields.map((f) => f.name))}`),
        );
      } else if (field.fieldType.resolve() !== 'text') {
        p.at('field', () =>
          p.error('text-score.non-text', `Text score requires a text field; '${this.field}' is ${field.fieldType.resolve()}.`),
        );
      } else {
        // WRITE-MODEL: honor the field's `exprs` restriction for this kind.
        checkFieldExpr('text-score', field, this.source, p);
      }
    }
    if (this.query.kind === 'param') {
      const param = this.query.param;
      p.at('query', () => param.validateWalk(engine, scope, p, ctx));
    }
    return this.resolve(engine, scope);
  }

  /** A text-score's own value cost is just its operands' (it produces a number). */
  cost(ctx: CostContext, scope: QueryScope): Cost {
    return this.childCost(ctx, scope);
  }

  /** Scoring implies a full-text scan penalty per scanned row (applied by the WHERE cost model). */
  override scanRowPenalty(): number {
    return TEXT_SEARCH_ROW_PENALTY;
  }

  /**
   * A deterministic in-memory relevance in [0, 1]: the FRACTION of the query's
   * tokens present in the searched text (case-folded unless the field's
   * effective {@link TextCasing} is `'exact'`). When a `SearchBacking` is in effect its `run` override decides
   * a boolean (⇒ 1/0), or its hidden `vectorField`'s stored text is scored;
   * otherwise the whole-record / field text is scored.
   */
  async evaluate(ctx: RuntimeContext, row: SourceRow | null): Promise<Value> {
    if (!row) return Value.of(0);
    const rec = row[this.source] ?? ctx.correlation?.[this.source];
    if (!rec) return Value.of(0);
    const type = boundTypeOf(ctx, this.source);
    const sensitive = fieldCaseSensitive(this.field !== undefined ? type?.field(this.field)?.fieldType : undefined, ctx.engine.textCasing);
    const query = queryRunText(ctx, this.query);
    const backing = type ? ctx.engine.searchBacking(type.name, this.field) : undefined;
    if (backing) {
      const res = await resolveSearchRun(backing, this.source, row, query, ctx);
      if (res.kind === 'match') return Value.of(res.matched ? 1 : 0);
      if (res.kind === 'text') return Value.of(relevanceScore(res.text, query, sensitive));
      // 'default' ⇒ fall through to the whole-record / field relevance.
    }
    return Value.of(relevanceScore(haystackText(rec, this.field), query, sensitive));
  }

  /**
   * Emit the numeric relevance. When a `SearchBacking` is in effect: a boolean
   * `sql` override is lifted to a numeric 0/1 (`matchScore`); a hidden
   * `vectorField` ranks that precomputed tsvector (`tsvectorRank`). Otherwise the
   * dialect's `textRank` over the resolved column (Postgres `ts_rank`; base a
   * numeric 0/1 match).
   */
  toSQL(dialect: Dialect, ctx: SqlContext): SqlText {
    const backing = searchBackingOf(ctx, this.source, this.field);
    if (backing) {
      if (backing.sql) {
        const pred = backing.sql(this.source, SqlText.param(querySqlText(ctx, this.query)), ctx);
        return dialect.matchScore(pred);
      }
      if (backing.vectorField !== undefined) {
        const tsv = dialect.field(this.source, backing.vectorField);
        return dialect.tsvectorRank(tsv, SqlText.param(querySqlText(ctx, this.query)), backing.language);
      }
      // 'default' (an empty backing) ⇒ fall through to the conceptual-field rank.
    }
    const col = searchColumn(dialect, ctx, this.source, this.field);
    const sensitive = searchSensitive(ctx, this.source, this.field);
    return dialect.textRank(col, querySqlText(ctx, this.query), sensitive);
  }

  /** Serialize back to its JSON ExprDef. */
  toJSON(): TextScoreExprDef {
    const def: TextScoreExprDef = {
      kind: 'text-score',
      source: this.source,
      query: this.query.kind === 'text' ? this.query.text : this.query.param.toJSON(),
    };
    if (this.field !== undefined) def.field = this.field;
    return def;
  }

  /** Deep-copy this expr. */
  clone(): TextScoreExpr {
    const query: TextSearchQuery =
      this.query.kind === 'param' ? { kind: 'param', param: this.query.param.clone() } : { ...this.query };
    return new TextScoreExpr(this.source, this.field, query);
  }

  /** Render as the readable `textScore(...)` DSL form. */
  override toCode(): string {
    const target = this.field !== undefined ? `${this.source}.${this.field}` : this.source;
    const q = this.query.kind === 'text' ? JSON.stringify(this.query.text) : `:${this.query.param.name}`;
    return `textScore(${target}, ${q})`;
  }
}

const _check: ExprClass = TextScoreExpr;
void _check;
