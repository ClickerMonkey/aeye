/**
 * LiteralExpr — a constant VALUE: a scalar (`string | number | boolean | null`)
 * or a whole JSON DOCUMENT (an object / array). Resolves to a `computed` value
 * whose field type mirrors the JS type of the value. A `null` literal is
 * special-cased: it is nullable and treated as comparable with anything (SQL
 * NULL), which operator validators consult via `isNullLiteral`.
 *
 * The DOCUMENT half is what lets a write cell carry a `json` / `array` value
 * (0.6.1's A9): a scalar binds as a plain parameter, a document binds through
 * `Dialect.jsonValue` — one parameter carrying the encoded document, cast to
 * the target column's SQL type. Nothing is ever string-interpolated.
 */
import { z } from 'zod';
import type { ExprDef, JsonValue, LiteralExprDef } from '../schema';
import type { SchemaOptions } from '../node';
import type { Registry } from '../registry';
import type { QueryEngine } from '../engine';
import type { QueryScope } from '../scope';
import type { ResolvedType } from '../resolved-type';
import type { Problems } from '../problem';
import { Expr, type ExprClass, type ValidateContext } from '../expr';
import {
  ArrayFieldType,
  BoolFieldType,
  JsonFieldType,
  NumberFieldType,
  TextFieldType,
} from '../field-types/index';
import { jsonValueSchema } from '../field-types/json';
import { computed } from './_shared';
import { withAid } from '../aids';
import { obj, lit, json } from '../shape';
import { Value } from '../runtime/value';
import type { Cost, CostContext } from '../cost';
import { bytesOfResolved } from '../cost';
import type { Dialect } from '../sql/dialect';
import { type SqlContext, SqlText } from '../sql/emit';

/** A constant value: a scalar, or a whole JSON document (object / array). */
export class LiteralExpr extends Expr {
  static readonly KIND = 'literal' as const;
  /** Concise LLM-facing summary of this expr kind (see `ExprClass.INSTRUCTIONS`). */
  static readonly INSTRUCTIONS = "A constant value: a scalar (string / number / boolean / null), or a whole JSON DOCUMENT (object / array) for a `json` / `array` field — which is how a write cell carries one. A document is bound as ONE parameter, never interpolated." as const;
  readonly kind = LiteralExpr.KIND;

  /** Wrap a constant value: a scalar, or a whole JSON document. */
  constructor(readonly value: JsonValue) {
    super();
  }

  /** Reconstruct a LiteralExpr from its JSON def (validates the `kind` discriminant). */
  static from(json: ExprDef, _registry: Registry): LiteralExpr {
    if (json.kind !== 'literal') {
      throw new Error(`LiteralExpr.from: expected 'literal', got '${json.kind}'`);
    }
    return new LiteralExpr(json.value);
  }

  /**
   * Owned structural {@link Shape} — the zod-free parallel parser. Builds a
   * `LiteralExpr` equal to `from`'s output on a valid def; accumulates problems
   * on a bad def (never throws). See `shape/`.
   */
  static readonly SHAPE = obj(
    {
      kind: lit('literal'),
      value: json('LiteralValue'),
    },
    (v) => new LiteralExpr(v.value),
    { aid: 'Expr_literal' },
  );

  /** Zod schema for this expr kind's JSON shape. */
  static toSchema(_opts: SchemaOptions): z.ZodTypeAny {
    return withAid(
      z.object({
        kind: z.literal('literal'),
        value: withAid(jsonValueSchema(), 'LiteralValue'),
      }),
      'Expr_literal',
    ).describe('A constant value: a scalar, or a whole JSON document for a json / array field.');
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
    // A DOCUMENT literal reports the category its value can be ASSIGNED to /
    // compared with: a bare array is a heterogeneous `array` (no declared item
    // type — the target column's own item type is the authority), an object is
    // `json`. Reporting `text` for either would let a document be written to a
    // text column, which is the mismatch `write.type` exists to catch.
    if (Array.isArray(this.value)) return computed(new ArrayFieldType(), [], false, false);
    switch (typeof this.value) {
      case 'number':
        return computed(new NumberFieldType(), [], false, false);
      case 'boolean':
        return computed(new BoolFieldType(), [], false, false);
      case 'object':
        return computed(new JsonFieldType(), [], false, false);
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
  cost(ctx: CostContext, scope: QueryScope): Cost {
    const engine = ctx.engine;
    return { rows: 0, bytes: bytesOfResolved(this.resolve(engine, scope)) };
  }

  /** Evaluate to the wrapped constant value. */
  async evaluate(): Promise<Value> {
    return Value.of(this.value);
  }

  /**
   * Emit as a SqlText fragment — `NULL` keyword, a bound scalar param, or a
   * bound DOCUMENT.
   *
   * A document has no target field type HERE (a bare literal in a WHERE knows
   * only its own shape), so it binds through the dialect's default json type.
   * The WRITE path emits its cells through `writeCellSql`, which supplies the
   * target COLUMN's field type — the difference between a Postgres `jsonb` cast
   * and the `ARRAY[…]::text[]` a native array column actually needs.
   */
  toSQL(dialect: Dialect, _ctx: SqlContext): SqlText {
    // SQL NULL is a keyword, not a bind value; everything else binds.
    if (this.value === null) return SqlText.raw('NULL');
    if (typeof this.value === 'object') return dialect.jsonValue(this.value);
    return SqlText.param(this.value);
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
