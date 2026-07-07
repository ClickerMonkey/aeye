/**
 * FiltersExpr — a structured filter PLACEHOLDER bound to a source, with an
 * optional `fields` allowlist. A `BoolExpr`, so it is usable anywhere a boolean
 * condition is (a WHERE / HAVING / ON predicate).
 *
 * The placeholder is authored by the LLM as just `{ source, fields? }`; the
 * actual filter PREDICATE is supplied at EXECUTION time as a BOOLEAN `Expr`,
 * keyed by source name (`RuntimeOptions.filters` / `engine.toSQL({ filters })`).
 * At evaluate / emit time the placeholder:
 *  - fetches the bool expr bound to `this.source` from the context;
 *  - if present, evaluates / emits it (it must resolve to a boolean);
 *  - if absent, resolves to a vacuous TRUE — so a WHERE over only a `filters`
 *    placeholder is always well-formed.
 *
 * A caller supplies that bool `Expr` / `ExprDef` per source at execution time;
 * `Query.filters(engine)` introspects the placeholders a query exposes (each
 * source → its filterable fields). `validateWalk` checks the source resolves and
 * each listed field exists.
 */
import { z } from 'zod';
import type { ExprDef, FiltersExprDef } from '../schema';
import type { SchemaOptions } from '../node';
import { filtersSchema } from '../schema-build';
import type { Registry } from '../registry';
import type { QueryEngine } from '../engine';
import type { QueryScope } from '../scope';
import type { ComputedResolved } from '../resolved-type';
import type { Problems } from '../problem';
import { BoolExpr, type ExprClass, type ValidateContext } from '../expr';
import { boolResult } from './_shared';
import { checkFieldExpr } from '../write-model';
import type { RuntimeContext } from '../runtime/context';
import type { SourceRow } from '../runtime/row';
import { triOf } from '../runtime/tri';
import type { Dialect } from '../sql/dialect';
import { type SqlContext, SqlText } from '../sql/emit';

/** A structured filter placeholder bound to a source (clauses supplied at execution time). A `BoolExpr`. */
export class FiltersExpr extends BoolExpr {
  static readonly KIND = 'filters' as const;
  /** Concise LLM-facing summary of this expr kind (see `ExprClass.INSTRUCTIONS`). */
  static readonly INSTRUCTIONS = "An execution-time filter placeholder bound to a source (optional `fields` allowlist); predicate supplied at run time." as const;
  readonly kind = FiltersExpr.KIND;

  /** Wrap the bound `source` and its optional `fields` allowlist. */
  constructor(
    readonly source: string,
    readonly fields: string[] | undefined,
  ) {
    super();
  }

  /** Reconstruct a FiltersExpr from its JSON def (validates the `kind` discriminant). */
  static from(json: ExprDef, _registry: Registry): FiltersExpr {
    if (json.kind !== 'filters') {
      throw new Error(`FiltersExpr.from: expected 'filters', got '${json.kind}'`);
    }
    return new FiltersExpr(json.source, json.fields ? [...json.fields] : undefined);
  }

  /** Zod schema for this expr kind's JSON shape. */
  static toSchema(opts: SchemaOptions): z.ZodTypeAny {
    // Depth-aware on the `filters` axis: `open` (or a bare call) leaves source +
    // fields free; `paired` pins them to a Type's filterable fields.
    return filtersSchema(opts.types ?? [], opts.depth?.filters ?? 'open', opts.cache);
  }

  // ─── Resolution / validation ─────────────────────────────────────────────

  override resolve(_engine: QueryEngine, _scope: QueryScope): ComputedResolved {
    // The placeholder always resolves to a boolean predicate.
    return boolResult([], false, false);
  }

  /** Validate the source resolves to a type and each listed field exists. */
  validateWalk(
    _engine: QueryEngine,
    scope: QueryScope,
    p: Problems,
    _ctx: ValidateContext,
  ): ComputedResolved {
    const bound = scope.lookup(this.source);
    if (!bound || bound.kind !== 'type') {
      p.error('filters.unknown-source', `Unknown source '${this.source}' for filters.`);
      return boolResult([], false, false);
    }
    const type = bound.type;
    if (this.fields) {
      p.at('fields', () => {
        this.fields!.forEach((field, i) => {
          const f = type.field(field);
          if (!f) {
            p.at(i, () =>
              p.error('filters.unknown-field', `Type '${type.name}' has no field '${field}'.`),
            );
          } else {
            // WRITE-MODEL: honor the field's `exprs` restriction for this kind.
            p.at(i, () => checkFieldExpr('filters', f, this.source, p));
          }
        });
      });
    }
    return boolResult([], false, false);
  }

  // ─── Evaluation ────────────────────────────────────────────────────────────

  /**
   * Evaluate the execution-supplied bool expr for this source (TRUE when none).
   * Propagates the inner predicate's 3VL result (a NULL ⇒ UNKNOWN) so a
   * `filters` placeholder nested under `not` / `and` / `or` composes correctly.
   */
  async evaluateBool(
    ctx: RuntimeContext,
    row: SourceRow,
    group?: readonly SourceRow[],
  ): Promise<boolean | undefined> {
    const expr = ctx.filtersFor(this.source);
    if (!expr) return true;
    return triOf(await expr.evaluate(ctx, row, group));
  }

  /** Emit the execution-supplied bool expr's SQL, or `TRUE` when none is bound. */
  toSQL(dialect: Dialect, ctx: SqlContext): SqlText {
    const expr = ctx.filtersFor(this.source);
    // No supplied expr ⇒ a vacuously-true predicate (so a WHERE over only filters
    // is well-formed SQL).
    if (!expr) return SqlText.raw('TRUE');
    return expr.toSQL(dialect, ctx);
  }

  /** Serialize back to its JSON ExprDef. */
  toJSON(): FiltersExprDef {
    const def: FiltersExprDef = { kind: 'filters', source: this.source };
    if (this.fields) def.fields = [...this.fields];
    return def;
  }

  /** Deep-copy this expr. */
  clone(): FiltersExpr {
    return new FiltersExpr(this.source, this.fields ? [...this.fields] : undefined);
  }

  /** Render as the readable `filters(...)` DSL form. */
  override toCode(): string {
    const fields = this.fields ? `, [${this.fields.join(', ')}]` : '';
    return `filters(${this.source}${fields})`;
  }
}

const _check: ExprClass = FiltersExpr;
void _check;
