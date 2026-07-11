/**
 * ExcludedExpr — a reference to the PROPOSED (excluded) row inside an
 * `INSERT … ON CONFLICT DO UPDATE`. `{ kind:'excluded', field }` reads the value
 * that WOULD have been inserted for `field`: SQL emits `EXCLUDED."field"`, and
 * the runtime reads the proposed tuple. It is only meaningful inside an
 * on-conflict update assignment, where `InsertQuery` binds the `excluded` source
 * to the target Type; referenced anywhere else, `validateWalk` reports an error.
 */
import { z } from 'zod';
import type { ExprDef, ExcludedExprDef } from '../schema';
import type { SchemaOptions } from '../node';
import type { Registry } from '../registry';
import type { QueryEngine } from '../engine';
import type { QueryScope } from '../scope';
import type { ResolvedType, FieldResolved } from '../resolved-type';
import type { Problems } from '../problem';
import { Expr, type ExprClass, type ValidateContext } from '../expr';
import { textResult } from './_shared';
import { withAid, didYouMean } from '../aids';
import { obj, lit, str } from '../shape';
import { Value } from '../runtime/value';
import type { RuntimeContext } from '../runtime/context';
import type { SourceRow } from '../runtime/row';
import type { Cost } from '../cost';
import { bytesOfResolved } from '../cost';
import type { Dialect } from '../sql/dialect';
import { type SqlContext, SqlText } from '../sql/emit';

/** The reserved source name the proposed (excluded) row binds under. */
export const EXCLUDED_SOURCE = 'excluded';

/** A reference to the proposed (EXCLUDED) row inside an `INSERT … ON CONFLICT DO UPDATE`. */
export class ExcludedExpr extends Expr {
  static readonly KIND = 'excluded' as const;
  /** Concise LLM-facing summary of this expr kind (see `ExprClass.INSTRUCTIONS`). */
  static readonly INSTRUCTIONS = "`EXCLUDED.\"field\"` — the proposed row inside `INSERT … ON CONFLICT DO UPDATE`." as const;
  readonly kind = ExcludedExpr.KIND;

  /** Wrap the proposed-row column name this reference reads. */
  constructor(readonly field: string) {
    super();
  }

  /** Reconstruct an ExcludedExpr from its JSON def (validates the `kind` discriminant). */
  static from(json: ExprDef, _registry: Registry): ExcludedExpr {
    if (json.kind !== 'excluded') {
      throw new Error(`ExcludedExpr.from: expected 'excluded', got '${json.kind}'`);
    }
    return new ExcludedExpr(json.field);
  }

  /**
   * Owned structural {@link Shape} — the zod-free parallel parser. Builds an
   * `ExcludedExpr` equal to `from`'s output on a valid def; accumulates problems
   * on a bad def (never throws). The in-scope / field checks remain in
   * `validateWalk`. See `shape/`.
   */
  static readonly SHAPE = obj(
    {
      kind: lit('excluded'),
      field: str('FieldName'),
    },
    (v) => new ExcludedExpr(v.field),
    { aid: 'Expr_excluded' },
  );

  /** Zod schema for this expr kind's JSON shape. */
  static toSchema(_opts: SchemaOptions): z.ZodTypeAny {
    return withAid(
      z.object({
        kind: z.literal('excluded'),
        field: z.string().describe('A column of the proposed (excluded) row.'),
      }),
      'Expr_excluded',
    ).describe('The proposed row inside an INSERT ON CONFLICT DO UPDATE (EXCLUDED.<field>).');
  }

  /** Resolve to the referenced field's type (text fallback when out of scope). */
  resolve(_engine: QueryEngine, scope: QueryScope): ResolvedType {
    const bound = scope.lookup(EXCLUDED_SOURCE);
    if (!bound || bound.kind !== 'type') return textResult([], true);
    const field = bound.type.field(this.field);
    if (!field) return textResult([], true);
    const resolved: FieldResolved = { kind: 'field', field, type: bound.type, source: bound.source, nullable: field.nullable };
    return resolved;
  }

  /** Require an EXCLUDED binding in scope and that the field exists on the conflict target. */
  validateWalk(_engine: QueryEngine, scope: QueryScope, p: Problems, _ctx: ValidateContext): ResolvedType {
    const bound = scope.lookup(EXCLUDED_SOURCE);
    if (!bound || bound.kind !== 'type') {
      p.error(
        'excluded.outside-conflict',
        `EXCLUDED.'${this.field}' can only be referenced inside an INSERT … ON CONFLICT DO UPDATE assignment.`,
      );
      return textResult([], true);
    }
    const field = bound.type.field(this.field);
    if (!field) {
      p.error('excluded.unknown-field', `The conflict target '${bound.type.name}' has no field '${this.field}'.${didYouMean(this.field, bound.type.fields.map((f) => f.name))}`);
      return textResult([], true);
    }
    const resolved: FieldResolved = { kind: 'field', field, type: bound.type, source: bound.source, nullable: field.nullable };
    return resolved;
  }

  /** Byte cost of the resolved field value (no rows). */
  cost(engine: QueryEngine, scope: QueryScope): Cost {
    return { rows: 0, bytes: bytesOfResolved(this.resolve(engine, scope)) };
  }

  /** Read the proposed row's value for this field (null when absent). */
  async evaluate(_ctx: RuntimeContext, row: SourceRow | null): Promise<Value> {
    const rec = row?.[EXCLUDED_SOURCE];
    const raw = rec?.[this.field];
    return Value.of(raw === undefined ? null : raw);
  }

  /** Emit `EXCLUDED."field"` (the keyword is unquoted; only the column is). */
  toSQL(dialect: Dialect, _ctx: SqlContext): SqlText {
    // `EXCLUDED` is a SQL keyword (the proposed-row pseudo-table), so it is NOT
    // quoted; only the column is.
    return SqlText.concat([SqlText.raw('EXCLUDED.'), dialect.ident(this.field)]);
  }

  /** Serialize back to its JSON ExprDef. */
  toJSON(): ExcludedExprDef {
    return { kind: 'excluded', field: this.field };
  }

  /** Deep-copy this expr. */
  clone(): ExcludedExpr {
    return new ExcludedExpr(this.field);
  }

  /** Render as the readable `EXCLUDED.<field>` DSL form. */
  override toCode(): string {
    return `EXCLUDED.${this.field}`;
  }
}

const _check: ExprClass = ExcludedExpr;
void _check;
