/**
 * LiteralExpr — a constant scalar value (`string | number | boolean | null`).
 * Resolves to a `computed` value whose field type mirrors the JS type of the
 * value. A `null` literal is special-cased: it is nullable and treated as
 * comparable with anything (SQL NULL), which operator validators consult via
 * `isNullLiteral`.
 */
import { z } from 'zod';
import type { ExprDef, LiteralExprDef, ScalarValue } from '../schema';
import type { SchemaOptions } from '../node';
import type { Registry } from '../registry';
import type { QueryEngine } from '../engine';
import type { QueryScope } from '../scope';
import type { ResolvedType } from '../resolved-type';
import type { Problems } from '../problem';
import { Expr, type ExprClass, type ValidateContext } from '../expr';
import {
  BoolFieldType,
  NumberFieldType,
  TextFieldType,
} from '../field-types/index';
import { computed } from './_shared';
import { Value } from '../runtime/value';
import type { Cost } from '../cost';
import { bytesOfResolved } from '../cost';
import type { Dialect } from '../sql/dialect';
import { type SqlContext, SqlText } from '../sql/emit';

/** A constant scalar value (`string | number | boolean | null`). */
export class LiteralExpr extends Expr {
  static readonly KIND = 'literal' as const;
  /** Concise LLM-facing summary of this expr kind (see `ExprClass.INSTRUCTIONS`). */
  static readonly INSTRUCTIONS = "A constant scalar value." as const;
  readonly kind = LiteralExpr.KIND;

  /** Wrap a constant scalar value (`string | number | boolean | null`). */
  constructor(readonly value: ScalarValue) {
    super();
  }

  /** Reconstruct a LiteralExpr from its JSON def (validates the `kind` discriminant). */
  static from(json: ExprDef, _registry: Registry): LiteralExpr {
    if (json.kind !== 'literal') {
      throw new Error(`LiteralExpr.from: expected 'literal', got '${json.kind}'`);
    }
    return new LiteralExpr(json.value);
  }

  /** Zod schema for this expr kind's JSON shape. */
  static toSchema(_opts: SchemaOptions): z.ZodTypeAny {
    return z
      .object({
        kind: z.literal('literal'),
        value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
      })
      .meta({ aid: 'Expr_literal' })
      .describe('A constant scalar value.');
  }

  /** Whether this is the SQL `NULL` literal. */
  isNullLiteral(): boolean {
    return this.value === null;
  }

  /** Resolve to a computed type mirroring the value's JS type (NULL → nullable text). */
  resolve(_engine: QueryEngine, _scope: QueryScope): ResolvedType {
    if (this.value === null) {
      // Untyped NULL — nullable; category placeholder is text.
      return computed(new TextFieldType(), [], true, false);
    }
    switch (typeof this.value) {
      case 'number':
        return computed(new NumberFieldType(), [], false, false);
      case 'boolean':
        return computed(new BoolFieldType(), [], false, false);
      default:
        return computed(new TextFieldType(), [], false, false);
    }
  }

  /** A literal is always valid; resolve its type. */
  validateWalk(
    engine: QueryEngine,
    scope: QueryScope,
    _p: Problems,
    _ctx: ValidateContext,
  ): ResolvedType {
    // A literal is always valid.
    return this.resolve(engine, scope);
  }

  /** Zero rows; cost is just the resolved value's byte size. */
  cost(engine: QueryEngine, scope: QueryScope): Cost {
    return { rows: 0, bytes: bytesOfResolved(this.resolve(engine, scope)) };
  }

  /** Evaluate to the wrapped constant value. */
  async evaluate(): Promise<Value> {
    return Value.of(this.value);
  }

  /** Emit as a SqlText fragment — `NULL` keyword or a bound param. */
  toSQL(_dialect: Dialect, _ctx: SqlContext): SqlText {
    // SQL NULL is a keyword, not a bind value; everything else binds.
    return this.value === null ? SqlText.raw('NULL') : SqlText.param(this.value);
  }

  /** Serialize back to its JSON ExprDef. */
  toJSON(): LiteralExprDef {
    return { kind: 'literal', value: this.value };
  }

  /** Deep-copy this expr. */
  clone(): LiteralExpr {
    return new LiteralExpr(this.value);
  }

  /** Render as source-like code (`NULL` or a JSON literal). */
  override toCode(): string {
    return this.value === null ? 'NULL' : JSON.stringify(this.value);
  }
}

const _check: ExprClass = LiteralExpr;
void _check;
