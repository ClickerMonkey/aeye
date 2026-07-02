import { z } from 'zod';
import type { FieldTypeDef, MoneyFieldTypeDef, NumberOptions } from '../schema';
import type { ValueSchemaOptions } from '../node';
import { FieldType, type FieldTypeClass, type ScalarKind } from '../field-type';
import { QueryTypeError } from '../problem';
import { catalogForFieldType, type FilterOp } from '../filters';
import {
  compactNumberOptions,
  numberOptionsSchema,
  numberValueSchema,
} from './number';

/** Instance-side options for a money field type. */
export interface MoneyOptions {
  /** Numeric constraints applied to the underlying amount. */
  number?: NumberOptions;
  /** ISO 4217 currency code (e.g. `"USD"`). */
  currency?: string;
}

function compact(o: MoneyOptions): MoneyOptions {
  const out: MoneyOptions = {};
  const num = o.number ? compactNumberOptions(o.number) : undefined;
  if (num && Object.keys(num).length > 0) out.number = num;
  if (o.currency !== undefined) out.currency = o.currency;
  return out;
}

/**
 * MoneyFieldType — a monetary amount: a number with an optional currency
 * label. Resolves to the `money` category (numeric-comparable), and its
 * value schema reuses the inner `NumberOptions`.
 */
export class MoneyFieldType extends FieldType {
  /** Discriminant kind tag (`'money'`) shared by all instances. */
  static readonly NAME = 'money' as const;
  /** This instance's discriminant kind. */
  readonly kind = MoneyFieldType.NAME;

  constructor(
    /** Numeric + currency options for this monetary field. */
    readonly options: MoneyOptions = {},
  ) {
    super();
  }

  /** Reconstruct from a JSON def (throws on a kind mismatch). */
  static from(json: FieldTypeDef): MoneyFieldType {
    if (json.kind !== 'money') {
      throw new QueryTypeError({
        path: [], code: 'field-type.mismatch', severity: 'error',
        message: `MoneyFieldType.from: expected kind 'money', got '${json.kind}'`,
      });
    }
    return new MoneyFieldType(compact({ number: json.number, currency: json.currency }));
  }

  /** The Zod schema for this field type's JSON def. */
  static toSchema(): z.ZodTypeAny {
    return z.object({
      kind: z.literal('money'),
      number: numberOptionsSchema().optional().describe('Numeric constraints on the amount.'),
      currency: z.string().optional().describe('ISO 4217 currency code (e.g. "USD").'),
    }).meta({ aid: 'FieldType_money' }).describe('Monetary amount field type.');
  }

  /** Resolve to the `money` scalar comparison category. */
  resolve(): ScalarKind {
    return 'money';
  }

  /** The filter operators valid on money fields. */
  filterOps(): FilterOp[] {
    return catalogForFieldType(this);
  }

  /** Estimated average stored byte size. */
  avgBytes(): number {
    return 8;
  }

  /** SQL column type for a monetary amount. */
  toSQLType(): string {
    return 'numeric';
  }

  /** Zod schema validating the amount, honoring the inner number options. */
  toValueSchema(_opts?: ValueSchemaOptions): z.ZodTypeAny {
    return numberValueSchema(this.options.number ?? {});
  }

  /** Serialize to its JSON def (flattening the compacted options). */
  toJSON(): MoneyFieldTypeDef {
    return { kind: MoneyFieldType.NAME, ...compact(this.options) };
  }

  /** A copy of this field type (cloning the options bag). */
  clone(): MoneyFieldType {
    return new MoneyFieldType({
      number: this.options.number ? { ...this.options.number } : undefined,
      currency: this.options.currency,
    });
  }
}

const _check: FieldTypeClass = MoneyFieldType;
void _check;
