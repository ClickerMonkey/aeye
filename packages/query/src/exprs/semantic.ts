/**
 * SemanticExpr — semantic-similarity score of a BOUND SOURCE's row against a
 * query (≈1 = most similar). Resolves to a numeric `ComputedResolved`.
 *
 *  - `source` (required) is the bound source whose row is scored; `field`
 *    (optional) narrows the score to a single semantic field, otherwise the
 *    whole source's embedding is used.
 *  - `query` is one of: a literal text string, a `param` whose bound value
 *    supplies the text, or a `TypeFieldRef` pointing at another semantic
 *    Type+field whose embedding is the query vector.
 *  - `evaluate` cosine-compares the query's embedding against the row's
 *    embedding (runtime-supplied vector, else one built from the row's text).
 *  - `validateWalk` requires the source resolve to a semantic-eligible Type
 *    (and the field, if given, be semantic); a `TypeFieldRef` query must point
 *    at a semantic-eligible Type + field.
 *  - `toSQL` emits the dialect's `similarity`.
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
import { numberResult } from './_shared';
import { ParamExpr } from './param';
import { TextFieldType } from '../field-types/index';
import type { Field } from '../field';
import { Value } from '../runtime/value';
import type { RuntimeContext } from '../runtime/context';
import type { SourceRecord, SourceRow } from '../runtime/row';
import { recordSignature } from '../runtime/record';
import type { Cost } from '../cost';
import { SEMANTIC_ROW_PENALTY } from '../cost';
import type { Dialect } from '../sql/dialect';
import { type SqlContext, SqlText } from '../sql/emit';

/**
 * The parsed query a semantic score compares against: a literal text, a bound
 * `param`, or another semantic Type+field. Mirrors `SemanticQueryDef`, with the
 * param materialized as a `ParamExpr` so it participates in param observation.
 */
export type SemanticQuery =
  | { kind: 'text'; text: string }
  | { kind: 'param'; param: ParamExpr }
  | { kind: 'typeField'; type: string; field: string };

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

/** Parse a `SemanticQueryDef` into the runtime `SemanticQuery` union. */
function parseQuery(def: SemanticQueryDef, registry: Registry): SemanticQuery {
  if (typeof def === 'string') return { kind: 'text', text: def };
  if ('kind' in def) {
    // A `ParamExprDef` (`{ kind:'param', name }`).
    const expr = registry.parseExpr(def);
    if (expr instanceof ParamExpr) return { kind: 'param', param: expr };
    throw new Error(`SemanticExpr: expected a param query, got '${expr.kind}'.`);
  }
  // A `TypeFieldRef` (`{ type, field }`).
  return { kind: 'typeField', type: def.type, field: def.field };
}

/** Serialize a `SemanticQuery` back to its `SemanticQueryDef`. */
function queryToJSON(q: SemanticQuery): SemanticQueryDef {
  switch (q.kind) {
    case 'text':
      return q.text;
    case 'param':
      return q.param.toJSON();
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

  /** Zod schema for this expr kind's JSON shape. */
  static toSchema(opts: SchemaOptions): z.ZodTypeAny {
    // Depth-aware: `refs:'open'` (or a bare call) yields free-string source +
    // field + query; tighter levels pair them to a semantic Type (see
    // `refSchema` / `semanticSchema`).
    return semanticSchema(opts.types ?? [], opts.depth?.refs ?? 'open');
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
      p.error('semantic.unknown-source', `Unknown source '${this.source}' for semantic score.`);
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
        const field = type.field(this.field);
        if (!field) {
          p.at('field', () =>
            p.error('semantic.unknown-field', `Type '${type.name}' has no field '${this.field}'.`),
          );
        } else if (!fieldIsSemantic(field)) {
          p.at('field', () =>
            p.error('semantic.field-not-semantic', `Field '${this.field}' of '${type.name}' is not semantic.`),
          );
        }
      }
    }
    // A `TypeFieldRef` query must reference a semantic Type + field; a `param`
    // query observes itself into the param set.
    if (this.query.kind === 'typeField') {
      p.at('query', () => this.validateTypeFieldQuery(engine, p));
    } else if (this.query.kind === 'param') {
      const param = this.query.param;
      p.at('query', () => param.validateWalk(engine, scope, p, ctx));
    }
    return this.resolve(engine, scope);
  }

  /**
   * Validate a `{ type, field }` query references a semantic Type + field, then
   * REJECT it as unsupported (BUG P0-7). The referenced Type is not joined into
   * the query's scope, so SQL would emit a reference to an UNBOUND alias, and
   * the runtime has no row from which to build the query vector (it yields 0).
   * Rather than emit invalid SQL / silently diverge, reject the cross-entity
   * embedding query with a clear Problem so SQL and runtime agree.
   */
  private validateTypeFieldQuery(engine: QueryEngine, p: Problems): void {
    /* v8 ignore next -- type-narrowing guard: only ever called from the `typeField` branch. */
    if (this.query.kind !== 'typeField') return;
    const type = engine.type(this.query.type);
    if (!type) {
      p.error('semantic.unknown-query-type', `Unknown Type '${this.query.type}' in semantic query.`);
      return;
    }
    const field = type.field(this.query.field);
    if (!field) {
      p.error('semantic.unknown-query-field', `Type '${this.query.type}' has no field '${this.query.field}'.`);
      return;
    }
    if (!fieldIsSemantic(field)) {
      p.error('semantic.query-not-semantic', `Field '${this.query.field}' of '${this.query.type}' is not semantic.`);
      return;
    }
    // Well-formed but unsupported: no join brings '<type>' into scope.
    p.error(
      'semantic.cross-entity-unsupported',
      `A Type+field embedding query ('${this.query.type}.${this.query.field}') is not supported: '${this.query.type}' is not joined into this query's scope, so neither SQL nor the runtime can resolve it. Use a literal-text or param query instead.`,
    );
  }

  /** Per-row embedding penalty approximating the scoring work. */
  cost(_engine: QueryEngine, _scope: QueryScope): Cost {
    // Each row evaluated pays an embedding penalty (a proxy for the work).
    return { rows: 0, bytes: SEMANTIC_ROW_PENALTY };
  }

  /** Embed the query side into a vector (null when unavailable). */
  private async queryVector(ctx: RuntimeContext): Promise<number[] | null> {
    switch (this.query.kind) {
      case 'text':
        return ctx.embed(this.query.text);
      case 'param': {
        const text = ctx.param(this.query.param.name).toText();
        return text.length > 0 ? ctx.embed(text) : null;
      }
      case 'typeField':
        // Cross-Type field embedding is a best-effort runtime concern; without
        // a concrete row to read there is no query vector in-memory.
        return null;
      /* v8 ignore next 2 -- exhaustiveness guard: `SemanticQuery` has no other kind. */
      default:
        return assertNever(this.query);
    }
  }

  /**
   * Cosine similarity of the row's embedding against the query's embedding.
   * The row embedding is the runtime-supplied vector when present, else one
   * built from the row's text fields and cached per `(source, row)`. Returns
   * 0 when no embedder is configured or no text/query is available.
   */
  async evaluate(ctx: RuntimeContext, row: SourceRow | null): Promise<Value> {
    if (!ctx.hasEmbedder() || !row) return Value.of(0);
    const queryVec = await this.queryVector(ctx);
    if (!queryVec) return Value.of(0);
    const rec = row[this.source] ?? ctx.correlation?.[this.source];
    if (!rec) return Value.of(0);

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
        const v = await ctx.embed(text);
        /* v8 ignore next -- defensive: ctx.embed only returns null with no embedder, already guarded by hasEmbedder() above. */
        if (!v) return Value.of(0);
        ctx.embeddingCache.set(cacheKey, v);
        recVec = v;
      }
    }
    return Value.of(cosine(queryVec, recVec));
  }

  /**
   * Similarity of the source's embedding column against the query embedding.
   * The dialect chooses the form (base degrades to 0; Postgres emits cosine
   * `1 - (embedding <=> query)`).
   */
  toSQL(dialect: Dialect, ctx: SqlContext): SqlText {
    if (this.query.kind === 'typeField') {
      // A Type+field embedding query is unsupported (validateWalk reports
      // `semantic.cross-entity-unsupported`): the referenced Type is not in
      // scope, so referencing it would emit an UNBOUND alias. Degrade to a
      // constant 0 — matching the runtime's `Value.of(0)` for this case — so
      // any SQL that slips past validation is still valid and agrees with the
      // runtime (BUG P0-7).
      return SqlText.raw('0');
    }
    const col = dialect.field(this.source, 'embedding');
    return dialect.similarity(col, this.querySQL(dialect, ctx));
  }

  /** The query side of the similarity, emitted for SQL (text / param only). */
  private querySQL(dialect: Dialect, ctx: SqlContext): SqlText {
    switch (this.query.kind) {
      case 'text':
        return SqlText.param(this.query.text);
      case 'param':
        return this.query.param.toSQL(dialect, ctx);
      /* v8 ignore next 5 -- unreachable: `toSQL` short-circuits typeField, and the exhaustiveness default has no other kind. */
      case 'typeField':
        // Unreachable: `toSQL` short-circuits the unsupported typeField query.
        return SqlText.raw('0');
      default:
        return assertNever(this.query);
    }
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
