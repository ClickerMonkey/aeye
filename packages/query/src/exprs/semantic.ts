/**
 * SemanticExpr — semantic-similarity score of a BOUND SOURCE's row against a
 * query (≈1 = most similar). Resolves to a numeric `ComputedResolved`.
 *
 *  - `source` (required) is the bound source whose row is scored; `field`
 *    (optional) narrows the score to a single semantic field, otherwise the
 *    whole source's embedding is used.
 *  - `query` is one of: a literal text string, a `param` whose bound value
 *    supplies the text, a `SourceFieldRef` (`{ source, field }`) pairing this
 *    score against ANOTHER bound source's semantic field, or a `TypeFieldRef`
 *    (`{ type, field }`) that resolves to the single bound source of that Type.
 *  - `evaluate` cosine-compares the query's embedding against the row's
 *    embedding (runtime-supplied vector, else one built from the row's text).
 *    A pairing query (`sourceField` / `typeField`) reads BOTH sides' vectors
 *    from the two bound rows and cosine-compares them.
 *  - `validateWalk` requires the source resolve to a semantic-eligible Type
 *    (and the field, if given, be semantic); a pairing query must reference a
 *    BOUND, semantic-eligible source + field (both sides bound).
 *  - `toSQL` emits the dialect's `similarity` — over the query param for a
 *    literal/param query, or over BOTH bound sides' vectors for a pairing query.
 */
import { z } from 'zod';
import type { ExprDef, SemanticExprDef, SemanticQueryDef } from '../schema';
import type { SchemaOptions } from '../node';
import { semanticSchema } from '../schema-build';
import type { Registry } from '../registry';
import type { QueryEngine } from '../engine';
import type { QueryScope } from '../scope';
import type { ResolvedType } from '../resolved-type';
import type { Problems } from '../problem';
import { Expr, type ExprClass, type ValidateContext } from '../expr';
import { didYouMean } from '../aids';
import { obj, lit, str, isRecord, expected, INVALID, type Shape } from '../shape';
import { numberResult } from './_shared';
import { checkFieldExpr } from '../write-model';
import { ParamExpr } from './param';
import { TextFieldType } from '../field-types/index';
import type { Field } from '../field';
import type { Type } from '../type';
import type { Embedder } from '../engine';
import { resolveSemanticSql, resolveSemanticRun, readFieldVector, type SemanticBacking } from '../backing';
import { Value } from '../runtime/value';
import type { RuntimeContext } from '../runtime/context';
import type { SourceRecord, SourceRow } from '../runtime/row';
import { recordSignature } from '../runtime/record';
import type { Cost, CostContext } from '../cost';
import { SEMANTIC_ROW_PENALTY } from '../cost';
import type { Dialect } from '../sql/dialect';
import { type SqlContext, SqlText } from '../sql/emit';
import { isVectorText, parseVectorText } from '../vector-text';

/**
 * The parsed query a semantic score compares against: a literal text, a bound
 * `param`, or another semantic Type+field. Mirrors `SemanticQueryDef`, with the
 * param materialized as a `ParamExpr` so it participates in param observation.
 */
export type SemanticQuery =
  | { kind: 'text'; text: string }
  | { kind: 'param'; param: ParamExpr }
  | SemanticPairingQuery;

/**
 * A cross-source PAIRING query: this row is scored against ANOTHER bound
 * source's embedding. `sourceField` names its bound source directly;
 * `typeField` resolves to the single bound source of a Type. Both carry a
 * required `field`.
 */
export type SemanticPairingQuery =
  | { kind: 'sourceField'; source: string; field: string }
  | { kind: 'typeField'; type: string; field: string };

/**
 * The outcome of resolving a pairing query to a bound source's Type: `ok` (a
 * single bound source + its Type), `unbound` (nothing usable is bound), or
 * `ambiguous` (a `{ type }` form matches more than one bound source).
 */
type QueryTypeResolution =
  | { kind: 'ok'; source: string; type: Type }
  | { kind: 'unbound' }
  | { kind: 'ambiguous' };

/** Cosine similarity of two equal-length vectors (0 when degenerate). */
function cosine(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Concatenate a record's string field values — the text we embed for a row. */
function semanticText(rec: SourceRecord): string {
  const parts: string[] = [];
  for (const key of Object.keys(rec)) {
    const v = rec[key];
    if (typeof v === 'string') parts.push(v);
  }
  return parts.join(' ');
}

/** Whether a field is semantic-eligible (a semantic/search text field). */
function fieldIsSemantic(field: Field): boolean {
  const ft = field.fieldType;
  return ft instanceof TextFieldType && (ft.options.semantic === true || ft.options.search === true);
}

/**
 * Resolve a pairing query to its bound source's Type against `scope`: a
 * `{ source }` form looks up its source directly; a `{ type }` form resolves to
 * the single bound source of that Type. `unbound` ⇒ nothing (usable) is bound;
 * `ambiguous` ⇒ a `{ type }` form matches more than one bound source.
 */
function resolveQueryType(scope: QueryScope, q: SemanticPairingQuery): QueryTypeResolution {
  if (q.kind === 'sourceField') {
    const bound = scope.lookup(q.source);
    if (!bound || bound.kind !== 'type') return { kind: 'unbound' };
    return { kind: 'ok', source: q.source, type: bound.type };
  }
  const matches = scope.sourcesForType(q.type);
  if (matches.length === 0) return { kind: 'unbound' };
  if (matches.length > 1) return { kind: 'ambiguous' };
  const only = matches[0]!;
  return { kind: 'ok', source: only.source, type: only.type };
}

/** A short readable label of a pairing query's referenced source / Type. */
function queryLabel(q: SemanticPairingQuery): string {
  return q.kind === 'sourceField' ? `${q.source}.${q.field}` : q.type;
}

/** Parse a `SemanticQueryDef` into the runtime `SemanticQuery` union. */
function parseQuery(def: SemanticQueryDef, registry: Registry): SemanticQuery {
  if (typeof def === 'string') return { kind: 'text', text: def };
  // A `SourceFieldRef` (`{ source, field }`) — the bound-source pairing form.
  if ('source' in def) return { kind: 'sourceField', source: def.source, field: def.field };
  if ('kind' in def) {
    // A `ParamExprDef` (`{ kind:'param', name }`).
    const expr = registry.parseExpr(def);
    if (expr instanceof ParamExpr) return { kind: 'param', param: expr };
    throw new Error(`SemanticExpr: expected a param query, got '${expr.kind}'.`);
  }
  // A `TypeFieldRef` (`{ type, field }`).
  return { kind: 'typeField', type: def.type, field: def.field };
}

/** Owned {@link Shape} for the `{ source, field }` pairing query form. */
const SEMANTIC_SOURCE_FIELD_SHAPE: Shape<SemanticQuery> = obj(
  { source: str('SourceName'), field: str('FieldName') },
  (v): SemanticQuery => ({ kind: 'sourceField', source: v.source, field: v.field }),
  { aid: 'SemanticQuery' },
);

/** Owned {@link Shape} for the `{ type, field }` pairing query form. */
const SEMANTIC_TYPE_FIELD_SHAPE: Shape<SemanticQuery> = obj(
  { type: str('TypeName'), field: str('FieldName') },
  (v): SemanticQuery => ({ kind: 'typeField', type: v.type, field: v.field }),
  { aid: 'SemanticQuery' },
);

/**
 * Owned structural {@link Shape} for a `SemanticQueryDef` — the zod-free
 * parallel to {@link parseQuery}. Dispatches over the four authored forms: a
 * literal `string` → `text`; a `{ kind:'param' }` def → a `ParamExpr` (validated
 * through `parseCheckedExpr`); a `{ source, field }` → the source pairing form;
 * a `{ type, field }` → the type pairing form. Anything else records an
 * aid-directed `shape.type`. Never throws; accumulates. See `shape/`.
 */
const semanticQueryShape: Shape<SemanticQuery> = {
  check(json, ctx) {
    if (typeof json === 'string') return { kind: 'text', text: json };
    if (isRecord(json)) {
      if (json['kind'] === 'param') {
        const built = ctx.registry.parseCheckedExpr(json, ctx.problems);
        if (built instanceof ParamExpr) return { kind: 'param', param: built };
        return INVALID;
      }
      if ('source' in json) return SEMANTIC_SOURCE_FIELD_SHAPE.check(json, ctx);
      if ('type' in json) return SEMANTIC_TYPE_FIELD_SHAPE.check(json, ctx);
    }
    ctx.problems.error('shape.type', expected('SemanticQuery', json));
    return INVALID;
  },
};

/** Serialize a `SemanticQuery` back to its `SemanticQueryDef`. */
function queryToJSON(q: SemanticQuery): SemanticQueryDef {
  switch (q.kind) {
    case 'text':
      return q.text;
    case 'param':
      return q.param.toJSON();
    case 'sourceField':
      return { source: q.source, field: q.field };
    case 'typeField':
      return { type: q.type, field: q.field };
    /* v8 ignore next 2 -- exhaustiveness guard: `SemanticQuery` has no other kind. */
    default:
      return assertNever(q);
  }
}

/** A semantic-similarity score of a bound source's row against a query (requires an embedder). */
export class SemanticExpr extends Expr {
  static readonly KIND = 'semantic' as const;
  /** Concise LLM-facing summary of this expr kind (see `ExprClass.INSTRUCTIONS`). */
  static readonly INSTRUCTIONS = "Embedding-similarity score of a source’s row vs a query (string / param / pairing ref) → number." as const;
  readonly kind = SemanticExpr.KIND;

  /** Wrap a bound `source` (optional `field`) and the query it is scored against. */
  constructor(
    readonly source: string,
    readonly field: string | undefined,
    readonly query: SemanticQuery,
  ) {
    super();
  }

  /** Reconstruct a SemanticExpr from its JSON def (validates the `kind` discriminant). */
  static from(json: ExprDef, registry: Registry): SemanticExpr {
    if (json.kind !== 'semantic') {
      throw new Error(`SemanticExpr.from: expected 'semantic', got '${json.kind}'`);
    }
    return new SemanticExpr(json.source, json.field, parseQuery(json.query, registry));
  }

  /**
   * Owned structural {@link Shape} — the zod-free parallel parser. Builds a
   * `SemanticExpr` equal to `from`'s output on a valid def (`query` dispatched by
   * {@link semanticQueryShape}). Accumulates on a bad def (never throws). The
   * semantic-eligibility checks remain in `validateWalk`. See `shape/`.
   */
  static readonly SHAPE = obj(
    {
      kind: lit('semantic'),
      source: str('SourceName'),
      field: str('FieldName'),
      query: semanticQueryShape,
    },
    (v) => new SemanticExpr(v.source, v.field, v.query),
    { optional: ['field'], aid: 'Expr_semantic' },
  );

  /** Zod schema for this expr kind's JSON shape. */
  static toSchema(opts: SchemaOptions): z.ZodTypeAny {
    // Depth-aware: `refs:'open'` (or a bare call) yields free-string source +
    // field + query; tighter levels pair them to a semantic Type (see
    // `refSchema` / `semanticSchema`).
    return semanticSchema(opts.types ?? [], opts.depth?.refs ?? 'open', opts.cache);
  }

  override forEachChild(visit: (child: Expr) => void): void {
    if (this.query.kind === 'param') visit(this.query.param);
  }

  /** Resolve to a non-null numeric computed type (a similarity score). */
  resolve(_engine: QueryEngine, _scope: QueryScope): ResolvedType {
    // A similarity score in roughly [0, 1]; never null.
    return numberResult([], false, false);
  }

  /** Validate the source (and field) are semantic-eligible and check the query side. */
  validateWalk(
    engine: QueryEngine,
    scope: QueryScope,
    p: Problems,
    ctx: ValidateContext,
  ): ResolvedType {
    const bound = scope.lookup(this.source);
    if (!bound) {
      p.error('semantic.unknown-source', `Unknown source '${this.source}' for semantic score.${didYouMean(this.source, scope.sources())}`);
    } else if (bound.kind === 'type') {
      const type = bound.type;
      if (!type.isSemantic()) {
        // The target Type must be semantic-eligible: flagged `semantic`, or
        // exposing a semantic/search text field (or relation).
        p.error(
          'semantic.not-eligible',
          `Source '${this.source}' (type '${type.name}') is not semantic-eligible.`,
        );
      } else if (this.field !== undefined) {
        const fieldName = this.field;
        const field = type.field(fieldName);
        if (!field) {
          p.at('field', () =>
            p.error('semantic.unknown-field', `Type '${type.name}' has no field '${fieldName}'.${didYouMean(fieldName, type.fields.map((f) => f.name))}`),
          );
        } else if (!fieldIsSemantic(field)) {
          p.at('field', () =>
            p.error('semantic.field-not-semantic', `Field '${this.field}' of '${type.name}' is not semantic.`),
          );
        } else {
          // WRITE-MODEL: honor the field's `exprs` restriction for this kind.
          checkFieldExpr('semantic', field, this.source, p);
        }
      }
    }
    // A pairing query (`sourceField` / `typeField`) must reference a BOUND,
    // semantic-eligible source + field; a `param` query observes itself.
    const q = this.query;
    if (q.kind === 'sourceField' || q.kind === 'typeField') {
      p.at('query', () => this.validateQuerySide(scope, p, q));
    } else if (q.kind === 'param') {
      const param = q.param;
      p.at('query', () => param.validateWalk(engine, scope, p, ctx));
    }
    return this.resolve(engine, scope);
  }

  /**
   * Validate a PAIRING query (`{ source, field }` / `{ type, field }`) — the
   * cross-source form that scores this row against ANOTHER bound source's
   * embedding. BOTH sides must be bound in the query's scope: a `{ source }`
   * form names its bound source directly; a `{ type }` form resolves to the
   * SINGLE bound source of that Type (`semantic.query-unbound` when none is
   * bound, `semantic.query-ambiguous` when more than one is — steering the
   * author to the unambiguous `{ source }` form). The resolved query source's
   * Type must expose the named `field` as semantic-eligible.
   */
  private validateQuerySide(scope: QueryScope, p: Problems, q: SemanticPairingQuery): void {
    const resolved = resolveQueryType(scope, q);
    if (resolved.kind === 'unbound') {
      p.error(
        'semantic.query-unbound',
        `The semantic pairing query references '${queryLabel(q)}', which is not bound in this query's scope; both sides of a pairing must be bound (join / cross-join them first).`,
      );
      return;
    }
    if (resolved.kind === 'ambiguous') {
      p.error(
        'semantic.query-ambiguous',
        `The semantic pairing query Type '${queryLabel(q)}' is bound more than once in scope; use the '{ source, field }' form to name exactly one bound source.`,
      );
      return;
    }
    const { type } = resolved;
    const field = type.field(q.field);
    if (!field) {
      p.error('semantic.unknown-query-field', `Type '${type.name}' has no field '${q.field}'.${didYouMean(q.field, type.fields.map((f) => f.name))}`);
      return;
    }
    if (!fieldIsSemantic(field)) {
      p.error('semantic.query-not-semantic', `Field '${q.field}' of '${type.name}' is not semantic.`);
    }
  }

  /** A semantic predicate's own value cost is just its operands' (a boolean). */
  cost(ctx: CostContext, scope: QueryScope): Cost {
    return this.childCost(ctx, scope);
  }

  /**
   * Each SCANNED row pays an embedding penalty (a proxy for the similarity
   * work). Applied per scanned row by the WHERE cost model, rather than folded
   * once into the value cost (where it was swallowed as a zero-row contribution).
   */
  override scanRowPenalty(): number {
    return SEMANTIC_ROW_PENALTY;
  }

  /**
   * Embed the query side into a vector (null when unavailable). A caller-supplied
   * `ctx.convertSemanticText` seam (text→pgvector-text, mirroring the SQL path)
   * takes precedence when present — the term is converted and parsed back to a
   * vector; a pre-embedded `[…]` value short-circuits the converter. With no
   * converter it falls back to the `SemanticBacking`'s `embedder` override, else
   * the run / engine embedder (unchanged existing behavior).
   */
  private async queryVector(
    ctx: RuntimeContext,
    q: { kind: 'text'; text: string } | { kind: 'param'; param: ParamExpr },
    embedder: Embedder | undefined,
  ): Promise<number[] | null> {
    const text = q.kind === 'text' ? q.text : ctx.param(q.param.name).toText();
    if (text.length === 0) return null;
    const convert = ctx.convertSemanticText;
    if (convert) {
      // A pre-embedded `[…]` term needs no conversion; anything else is text.
      const vectorText = isVectorText(text) ? text : await convert(text);
      return parseVectorText(vectorText);
    }
    return this.embedText(ctx, text, embedder);
  }

  /** Embed `text` via the backing's `embedder` override, else the run's embedder (cached). */
  private async embedText(ctx: RuntimeContext, text: string, embedder: Embedder | undefined): Promise<number[] | null> {
    return embedder ? embedder.embed(text) : ctx.embed(text);
  }

  /** The Type bound under `source`, when known (for field metadata + backing lookup). */
  private boundType(ctx: RuntimeContext): Type | undefined {
    return ctx.sourceType(this.source) ?? ctx.engine.type(this.source);
  }

  /**
   * Cosine similarity of the row's embedding against the query's embedding.
   * When a `SemanticBacking` is in effect its `run` override yields the score
   * directly, or its `vector` / hidden `vectorField` supplies the row vector;
   * otherwise the row embedding is the runtime-supplied vector when present, else
   * one built from the row's text fields and cached per `(source, row)`. The
   * query is embedded with the backing's `embedder` override when set. Returns 0
   * when no embedder is available or no text / query is present.
   */
  async evaluate(ctx: RuntimeContext, row: SourceRow | null): Promise<Value> {
    if (!row) return Value.of(0);
    const q = this.query;
    if (q.kind === 'sourceField' || q.kind === 'typeField') {
      return this.evaluatePairing(ctx, row, q);
    }
    const type = this.boundType(ctx);
    const backing = type ? ctx.engine.semanticBacking(type.name, this.field) : undefined;
    const embedder = backing?.embedder;
    // A caller-supplied text→vector converter is an alternative to an embedder
    // for the QUERY term; with neither (and no embedder), there is nothing to
    // score against ⇒ 0 (unchanged when no converter is set).
    if (!embedder && !ctx.hasEmbedder() && !ctx.convertSemanticText) return Value.of(0);
    const queryVec = await this.queryVector(ctx, q, embedder);
    if (!queryVec) return Value.of(0);
    const rec = row[this.source] ?? ctx.correlation?.[this.source];
    if (!rec) return Value.of(0);

    if (backing) {
      const res = await resolveSemanticRun(backing, this.source, row, queryVec, ctx);
      if (res.kind === 'score') return Value.of(res.score);
      if (res.kind === 'vector') return Value.of(res.vector ? cosine(queryVec, res.vector) : 0);
      // 'default' ⇒ fall through to the per-record / embed-the-text path below.
    }

    const id = rec['id'];
    // 1. A runtime-provided per-record embedding wins when available.
    let recVec = id !== undefined ? await ctx.embeddingOf(this.source, id) : null;
    if (!recVec) {
      // 2. Otherwise embed the row's text, caching per (source, row).
      const text = this.field !== undefined ? String(rec[this.field] ?? '') : semanticText(rec);
      if (text.length === 0) return Value.of(0);
      const cacheKey = `embed:${this.source}:${id !== undefined ? String(id) : recordSignature(rec)}`;
      const cached = ctx.embeddingCache.get(cacheKey);
      if (cached) {
        recVec = cached;
      } else {
        const v = await this.embedText(ctx, text, embedder);
        /* v8 ignore next -- defensive: embedText only returns null with no embedder, already guarded above. */
        if (!v) return Value.of(0);
        ctx.embeddingCache.set(cacheKey, v);
        recVec = v;
      }
    }
    return Value.of(cosine(queryVec, recVec));
  }

  /**
   * Cosine similarity of the scored row's embedding against the PAIRED query
   * source's embedding — the cross-source form. Both sources are bound
   * (join / cross-join), so both rows are present under their aliases in `row`.
   * Each side's vector comes from its `SemanticBacking` (`vector` / hidden
   * `vectorField`), else one embedded from its text. Returns 0 when the query
   * source is not present or either side has no vector.
   */
  private async evaluatePairing(ctx: RuntimeContext, row: SourceRow, q: SemanticPairingQuery): Promise<Value> {
    const qAlias = this.queryAliasFromRow(ctx, row, q);
    if (qAlias === undefined) return Value.of(0);
    const queryVec = await this.sideVector(ctx, row, qAlias, q.field);
    if (!queryVec) return Value.of(0);
    const scoredVec = await this.sideVector(ctx, row, this.source, this.field);
    if (!scoredVec) return Value.of(0);
    return Value.of(cosine(queryVec, scoredVec));
  }

  /**
   * The bound alias the pairing query reads from: a `{ source }` form names it
   * directly; a `{ type }` form finds the single row alias whose bound Type
   * matches (`undefined` when none is present).
   */
  private queryAliasFromRow(ctx: RuntimeContext, row: SourceRow, q: SemanticPairingQuery): string | undefined {
    if (q.kind === 'sourceField') return q.source;
    const wanted = q.type;
    for (const key of Object.keys(row)) {
      const type = ctx.sourceType(key) ?? ctx.engine.type(key);
      if (type?.name === wanted) return key;
    }
    return undefined;
  }

  /**
   * Read one bound side's embedding vector off `row[source]` for a pairing
   * score: the `SemanticBacking`'s `vector` producer, then its hidden
   * `vectorField`, else a vector embedded from the side's text (whole record, or
   * the named `field`). Returns `null` when no vector / text / embedder applies.
   */
  private async sideVector(
    ctx: RuntimeContext,
    row: SourceRow,
    source: string,
    field: string | undefined,
  ): Promise<number[] | null> {
    const type = ctx.sourceType(source) ?? ctx.engine.type(source);
    const backing = type ? ctx.engine.semanticBacking(type.name, field) : undefined;
    if (backing?.vector) return backing.vector(source, row, ctx);
    if (backing?.vectorField !== undefined) return readFieldVector(row, source, backing.vectorField);
    const rec = row[source];
    if (!rec) return null;
    const embedder = backing?.embedder;
    if (!embedder && !ctx.hasEmbedder()) return null;
    const text = field !== undefined ? String(rec[field] ?? '') : semanticText(rec);
    if (text.length === 0) return null;
    return this.embedText(ctx, text, embedder);
  }

  /**
   * Similarity of the source's embedding against the query embedding. When a
   * `SemanticBacking` is in effect its `sql` override or hidden `vectorField`
   * (the dialect's `similarity` over that field) is emitted against the BOUND
   * alias, with the query vector bound as the dialect's vector PARAM (kept
   * synchronous — the async embedder is never called here). Otherwise the
   * dialect chooses the default form (base degrades to 0; Postgres emits cosine
   * `1 - (embedding <=> query)`).
   */
  toSQL(dialect: Dialect, ctx: SqlContext): SqlText {
    const q = this.query;
    if (q.kind === 'sourceField' || q.kind === 'typeField') {
      return this.pairingSQL(dialect, ctx, q);
    }
    const backing = this.backingForAlias(ctx, this.source, this.field);
    if (backing) {
      const queryVector = dialect.queryVectorParam(this.querySQL(dialect, ctx));
      const res = resolveSemanticSql(backing, this.source, queryVector, ctx);
      if (res.kind === 'sql') return res.sql;
      // 'default' ⇒ fall through to the default embedding-column similarity.
    }
    const col = dialect.field(this.source, 'embedding');
    return dialect.similarity(col, this.querySQL(dialect, ctx));
  }

  /**
   * Emit a PAIRING score: `dialect.similarity(<scoredVec>, <queryVec>)` over BOTH
   * bound sides' vectors — each side's hidden `SemanticBacking.vectorField` when
   * backed, else the default `<alias>."embedding"` fragment — referenced by each
   * side's BOUND alias (alias-correct; supports self-pairing of two aliases of
   * one Type). NO async: neither side embeds text here. Base degrades to 0.
   */
  private pairingSQL(dialect: Dialect, ctx: SqlContext, q: SemanticPairingQuery): SqlText {
    const scoredVec = this.sideVectorSQL(dialect, ctx, this.source, this.field);
    const side = this.resolveQuerySideSql(ctx, q);
    const queryVec = this.sideVectorSQL(dialect, ctx, side.alias, side.field);
    return dialect.similarity(scoredVec, queryVec);
  }

  /** The bound alias + field the pairing query's vector is read from, for SQL. */
  private resolveQuerySideSql(ctx: SqlContext, q: SemanticPairingQuery): { alias: string; field: string } {
    if (q.kind === 'sourceField') return { alias: q.source, field: q.field };
    const matches = ctx.scope.sourcesForType(q.type);
    const alias = matches[0]?.source ?? q.type;
    return { alias, field: q.field };
  }

  /** One side's vector fragment: its hidden `vectorField`, else `<alias>."embedding"`. */
  private sideVectorSQL(dialect: Dialect, ctx: SqlContext, alias: string, field: string | undefined): SqlText {
    const backing = this.backingForAlias(ctx, alias, field);
    if (backing?.vectorField !== undefined) return dialect.field(alias, backing.vectorField);
    return dialect.field(alias, 'embedding');
  }

  /** The `SemanticBacking` in effect for a bound `alias` (+ field), or `undefined`. */
  private backingForAlias(ctx: SqlContext, alias: string, field: string | undefined): SemanticBacking | undefined {
    const bound = ctx.scope.lookup(alias);
    if (!bound || bound.kind !== 'type') return undefined;
    return ctx.engine.semanticBacking(bound.type.name, field);
  }

  /**
   * The query side of the similarity, emitted for SQL (text / param only). A
   * `semantic(...)` term is TEXT — never a raw embedding — so a literal (and a
   * plain-text param VALUE) is EMBEDDED into a pgvector TEXT literal (`[…]`) via
   * the caller's `ctx.semanticText` converter before it is bound; the dialect
   * then casts it `::vector`. Two existing valid inputs are preserved untouched:
   * a PRE-EMBEDDED vector-text param (already `[…]`) is bound as-is, and a `null`
   * / absent param binds `null`. When a plain-text term is hit but NO converter
   * was supplied, this THROWS (rather than emitting the invalid `'<text>'::vector`).
   */
  private querySQL(_dialect: Dialect, ctx: SqlContext): SqlText {
    const q = this.query;
    if (q.kind === 'text') return SqlText.param(this.vectorTextForSql(ctx, q.text));
    /* v8 ignore next 2 -- unreachable: `toSQL` routes pairing queries to `pairingSQL`; only text / param reach here. */
    if (q.kind !== 'param') return SqlText.raw('0');
    const raw = Object.prototype.hasOwnProperty.call(ctx.params, q.param.name) ? ctx.params[q.param.name] : null;
    // A NULL / absent, or a stray relation `{ pk }` OBJECT, is not a semantic
    // term — bind NULL (mirrors `ParamExpr.toSQL`).
    if (raw === null || typeof raw === 'object') return SqlText.param(null);
    const text = String(raw);
    // A pre-embedded vector-text param (`[…]`) is already a vector — bind as-is.
    if (isVectorText(text)) return SqlText.param(text);
    // A plain-text param value feeding a semantic score must be embedded first.
    return SqlText.param(this.vectorTextForSql(ctx, text));
  }

  /**
   * Embed a plain-text semantic term into its pgvector TEXT literal via the
   * caller's converter, or THROW a directed error when none was supplied.
   */
  private vectorTextForSql(ctx: SqlContext, text: string): string {
    const convert = ctx.semanticText;
    if (!convert) {
      throw new Error(
        `SemanticExpr.toSQL: the semantic term ${JSON.stringify(text)} is plain text, not a vector, ` +
          `and cannot be bound as-is (Postgres cannot cast '<text>'::vector). Supply a text→vector ` +
          `converter — 'engine.toSQLAsync(query, dialect, { convertSemanticText })' (async) or ` +
          `'engine.toSQL(query, dialect, { convertSemanticText })' (sync, pre-embedded) — or pass ` +
          `the query vector as a pre-embedded '[…]' vector-text param.`,
      );
    }
    return convert(text);
  }

  /** Serialize back to its JSON ExprDef. */
  toJSON(): SemanticExprDef {
    const def: SemanticExprDef = { kind: 'semantic', source: this.source, query: queryToJSON(this.query) };
    if (this.field !== undefined) def.field = this.field;
    return def;
  }

  /** Deep-copy this expr. */
  clone(): SemanticExpr {
    const query: SemanticQuery =
      this.query.kind === 'param' ? { kind: 'param', param: this.query.param.clone() } : { ...this.query };
    return new SemanticExpr(this.source, this.field, query);
  }

  /** Render as the readable `semantic(...)` DSL form. */
  override toCode(): string {
    const target = this.field !== undefined ? `${this.source}.${this.field}` : this.source;
    return `semantic(${target}, ${queryCode(this.query)})`;
  }
}

/** A short readable form of the semantic query. */
function queryCode(q: SemanticQuery): string {
  switch (q.kind) {
    case 'text':
      return JSON.stringify(q.text);
    case 'param':
      return `:${q.param.name}`;
    case 'sourceField':
      return `${q.source}.${q.field}`;
    case 'typeField':
      return `${q.type}.${q.field}`;
    /* v8 ignore next 2 -- exhaustiveness guard: `SemanticQuery` has no other kind. */
    default:
      return assertNever(q);
  }
}

/* v8 ignore next 4 -- compile-time exhaustiveness guard; never invoked at runtime. */
/** Compile-time exhaustiveness guard over `SemanticQuery`. */
function assertNever(value: never): never {
  throw new Error(`SemanticExpr: unhandled semantic query ${JSON.stringify(value)}`);
}

const _check: ExprClass = SemanticExpr;
void _check;
