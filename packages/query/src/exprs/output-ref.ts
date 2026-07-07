/**
 * OutputRefExpr — a reference to a SELECT OUTPUT FIELD by its name:
 * `{ kind:'output', name }`. It lets a SELECT's `groupBy` / `orderBy` /
 * `having` reference a projected output BY NAME instead of repeating its whole
 * expression — smaller queries and fewer GROUP BY / ORDER BY mismatches.
 *
 * SEMANTICS = DELEGATE to the referenced select item's `Expr`. The target is
 * looked up by OUTPUT NAME among the enclosing SELECT's output fields (its
 * explicit `as`, else the natural name from `fieldNameOf`), which the SELECT
 * binds onto the scope (`scope.output`) / runtime context (`ctx.outputExpr`)
 * used to resolve / validate / execute those clauses:
 *  - `resolve` / `validateWalk` / `cost` / `toSQL` find the target and delegate
 *    (so `toSQL` EXPANDS to the target's SQL — portable across dialects in every
 *    clause);
 *  - `evaluate` re-evaluates the target expr over the same row / group (so a
 *    group key re-computes over the source row, and an ORDER BY / HAVING ref
 *    re-computes over the group — including an aggregate target).
 *
 * It has NO child exprs. `toJSON` / `clone` preserve `{ kind:'output', name }`
 * so it round-trips; its canonical digest is therefore just its kind + name.
 * The enclosing SELECT only binds outputs for `groupBy` / `orderBy` / `having`,
 * so an `output` reference in WHERE / a JOIN `on` / a general expression
 * argument (where no outputs are bound) fails validation (`output.not-available`).
 */
import { z } from 'zod';
import type { ExprDef, OutputRefExprDef } from '../schema';
import type { SchemaOptions } from '../node';
import type { Registry } from '../registry';
import type { QueryEngine } from '../engine';
import type { QueryScope } from '../scope';
import type { ResolvedType } from '../resolved-type';
import type { Problems } from '../problem';
import { Expr, type ExprClass, type ValidateContext } from '../expr';
import { textResult } from './_shared';
import { withAid } from '../aids';
import { Value } from '../runtime/value';
import type { RuntimeContext } from '../runtime/context';
import type { SourceRow } from '../runtime/row';
import { ZERO_COST, type Cost } from '../cost';
import type { Dialect } from '../sql/dialect';
import { type SqlContext, SqlText } from '../sql/emit';

/** A reference to a SELECT output field by name; delegates to that field's expr. */
export class OutputRefExpr extends Expr {
  static readonly KIND = 'output' as const;
  /** Concise LLM-facing summary of this expr kind (see `ExprClass.INSTRUCTIONS`). */
  static readonly INSTRUCTIONS = "References a projected SELECT output field by name (valid ONLY in groupBy/orderBy/having); expands to that item's expr." as const;
  readonly kind = OutputRefExpr.KIND;

  /** Wrap the referenced output field name. */
  constructor(readonly name: string) {
    super();
  }

  /** Reconstruct an OutputRefExpr from its JSON def (validates the `kind` discriminant). */
  static from(json: ExprDef, _registry: Registry): OutputRefExpr {
    if (json.kind !== 'output') {
      throw new Error(`OutputRefExpr.from: expected 'output', got '${json.kind}'`);
    }
    return new OutputRefExpr(json.name);
  }

  /** Zod schema for this expr kind's JSON shape (name is query-local ⇒ a plain string). */
  static toSchema(_opts: SchemaOptions): z.ZodTypeAny {
    return withAid(
      z.object({
        kind: z.literal('output'),
        name: z.string().describe('A SELECT output field name (its `as`, or the natural derived name).'),
      }),
      'Expr_output',
    ).describe('A reference to a SELECT output field by name (valid in groupBy / orderBy / having).');
  }

  /** Resolve to the referenced output field's type (delegates; text fallback when unbound). */
  resolve(engine: QueryEngine, scope: QueryScope): ResolvedType {
    const target = scope.output(this.name);
    if (!target) return textResult([], true);
    return target.resolve(engine, scope);
  }

  /**
   * Validate the reference against the enclosing SELECT's outputs:
   *  - no outputs bound at all (WHERE / JOIN-ON / a general expr) ⇒
   *    `output.not-available`;
   *  - outputs bound but none named `name` ⇒ `output.unknown`;
   *  - a GROUP BY key whose target is an aggregate ⇒ `output.aggregate`.
   * On success it delegates to the target's own validation + resolution.
   */
  validateWalk(engine: QueryEngine, scope: QueryScope, p: Problems, ctx: ValidateContext): ResolvedType {
    const target = scope.output(this.name);
    if (!target) {
      if (!scope.hasOutputs()) {
        p.error(
          'output.not-available',
          `An 'output' reference (to '${this.name}') is only valid in a SELECT's groupBy / orderBy / having; it cannot be used here.`,
        );
      } else {
        const names = scope.outputNames();
        p.error(
          'output.unknown',
          `No SELECT output field named '${this.name}'. Available output fields: ${names.join(', ')}.`,
        );
      }
      return textResult([], true);
    }
    const resolved = target.resolve(engine, scope);
    if (ctx.inGroupBy && resolved.kind === 'computed' && resolved.aggregate) {
      p.error(
        'output.aggregate',
        `Cannot GROUP BY output field '${this.name}': it is an aggregate. Group by a non-aggregate key instead.`,
      );
    }
    return resolved;
  }

  /** Delegate to the target's cost (zero when the reference is unbound). */
  cost(engine: QueryEngine, scope: QueryScope): Cost {
    const target = scope.output(this.name);
    return target ? target.cost(engine, scope) : ZERO_COST;
  }

  /** Re-evaluate the referenced output expr over the same row / group. */
  async evaluate(ctx: RuntimeContext, row: SourceRow | null, group?: readonly SourceRow[]): Promise<Value> {
    const target = ctx.outputExpr(this.name);
    if (!target) return Value.null();
    return target.evaluate(ctx, row, group);
  }

  /** Emit the target's SQL (EXPANDS the reference; NULL when unbound — never after validation). */
  toSQL(dialect: Dialect, ctx: SqlContext): SqlText {
    const target = ctx.scope.output(this.name);
    if (!target) return SqlText.raw('NULL');
    return target.toSQL(dialect, ctx);
  }

  /** Serialize back to its JSON ExprDef (round-trips as `{ kind:'output', name }`). */
  toJSON(): OutputRefExprDef {
    return { kind: 'output', name: this.name };
  }

  /** Deep-copy this expr. */
  clone(): OutputRefExpr {
    return new OutputRefExpr(this.name);
  }

  /** Render as the readable `output(<name>)` DSL form. */
  override toCode(): string {
    return `output(${this.name})`;
  }
}

const _check: ExprClass = OutputRefExpr;
void _check;
