import { z } from 'zod';
import type { FieldTypeDef, TextFieldTypeDef, FieldValueDef } from '../schema';
import { fieldValuesSchema, closedSetValueSchema, compactFieldValues, eqSelectivityOf } from './_values';
import type { ValueSchemaOptions } from '../node';
import { FieldType, type FieldTypeClass, type ScalarKind } from '../field-type';
import { QueryTypeError } from '../problem';

/** Options bag for a text field type (instance-side). */
export interface TextOptions {
  /** Minimum string length. */
  minLength?: number;
  /** Maximum string length. */
  maxLength?: number;
  /** Format regex the value must match. */
  pattern?: string;
  /** Eligible for embedding-based semantic similarity. */
  semantic?: boolean;
  /** Eligible for full-text search. */
  search?: boolean;
  /** When true, text matching is case-sensitive (default: case-insensitive). */
  sensitive?: boolean;
  /** The closed set of values this column may hold (see `NumberOptions.values`). */
  values?: FieldValueDef[];
}

function compact(o: TextOptions): TextOptions {
  const out: TextOptions = {};
  if (o.minLength !== undefined) out.minLength = o.minLength;
  if (o.maxLength !== undefined) out.maxLength = o.maxLength;
  if (o.pattern !== undefined) out.pattern = o.pattern;
  if (o.semantic !== undefined) out.semantic = o.semantic;
  if (o.search !== undefined) out.search = o.search;
  if (o.sensitive !== undefined) out.sensitive = o.sensitive;
  const values = compactFieldValues(o.values);
  if (values) out.values = values;
  return out;
}

/**
 * TextFieldType — a string field with optional length / pattern constraints,
 * semantic-search / full-text flags, and a `sensitive` case-sensitivity flag.
 *
 * CASE-SENSITIVITY RULE (important): textual matching and comparison on a text
 * field are CASE-INSENSITIVE BY DEFAULT — every text operator (equality,
 * ordering comparisons, `contains` / `startsWith` / `endsWith` / `like` /
 * `ilike`, and full-text `search`) lower-cases both operands. Set
 * `sensitive: true` to make matching CASE-SENSITIVE (operands compared as-is;
 * SQL emits plain operators with no `LOWER(...)` wrapping).
 */
export class TextFieldType extends FieldType {
  /** Discriminant kind tag (`'text'`) shared by all instances. */
  static readonly NAME = 'text' as const;
  /** This instance's discriminant kind. */
  readonly kind = TextFieldType.NAME;

  constructor(
    /** Length / pattern / search / sensitivity options for this string. */
    readonly options: TextOptions = {},
  ) {
    super();
  }

  /** Text matching is case-sensitive only when this field is `sensitive`. */
  override textCaseSensitive(): boolean {
    return this.options.sensitive === true;
  }

  /** Reconstruct from a JSON def (throws on a kind mismatch). */
  static from(json: FieldTypeDef): TextFieldType {
    if (json.kind !== 'text') {
      throw new QueryTypeError({
        path: [], code: 'field-type.mismatch', severity: 'error',
        message: `TextFieldType.from: expected kind 'text', got '${json.kind}'`,
      });
    }
    const { minLength, maxLength, pattern, semantic, search, sensitive, values } = json;
    return new TextFieldType(compact({ minLength, maxLength, pattern, semantic, search, sensitive, values }));
  }

  /** The Zod schema for this field type's JSON def. */
  static toSchema(): z.ZodTypeAny {
    return z.object({
      kind: z.literal('text'),
      minLength: z.number().int().optional().describe('Real lower bound (e.g. non-empty → 1).'),
      maxLength: z.number().int().optional().describe('Real upper bound (field width / API limit).'),
      pattern: z.string().optional().describe('Format regex (UUID, slug, …); not accept-anything.'),
      semantic: z.boolean().optional().describe('Eligible for embedding-based semantic similarity.'),
      search: z.boolean().optional().describe('Eligible for full-text search.'),
      sensitive: z.boolean().optional().describe('When true, text matching is CASE-SENSITIVE (default: case-insensitive).'),
      values: fieldValuesSchema(),
    }).meta({ aid: 'FieldType_text' }).describe('String field type.');
  }

  /** Resolve to the `text` scalar comparison category. */
  resolve(): ScalarKind {
    return 'text';
  }

  /** A declared closed set of `n` members makes `= x` a `1/n` predicate. */
  override eqSelectivity(): number | undefined {
    return eqSelectivityOf(this.options.values);
  }

  /** Estimated average stored byte size (half the max length, else 32). */
  avgBytes(): number {
    // Half the max length is a reasonable average; default to 32 when
    // unbounded. (One byte per char is a deliberate ASCII-ish estimate.)
    if (this.options.maxLength !== undefined) {
      return Math.max(1, Math.ceil(this.options.maxLength / 2));
    }
    return 32;
  }

  /** SQL column type (`varchar(n)` when bounded, else `text`). */
  toSQLType(): string {
    return this.options.maxLength !== undefined ? `varchar(${this.options.maxLength})` : 'text';
  }

  /** Zod schema validating a string, honoring the closed value set else length / pattern options. */
  toValueSchema(_opts?: ValueSchemaOptions): z.ZodTypeAny {
    // A closed set IS the value schema — length / pattern only ever described
    // the same members less precisely.
    const closed = closedSetValueSchema(this.options.values);
    if (closed) return closed;
    let s = z.string();
    if (this.options.minLength !== undefined) s = s.min(this.options.minLength);
    if (this.options.maxLength !== undefined) s = s.max(this.options.maxLength);
    if (this.options.pattern !== undefined) s = s.regex(new RegExp(this.options.pattern));
    return s;
  }

  /** Serialize to its JSON def (flattening the compacted options). */
  toJSON(): TextFieldTypeDef {
    return { kind: TextFieldType.NAME, ...compact(this.options) };
  }

  /** A copy of this field type (deep-cloning the options bag's value set). */
  clone(): TextFieldType {
    return new TextFieldType({ ...this.options, values: this.options.values?.map((v) => ({ ...v })) });
  }
}

const _check: FieldTypeClass = TextFieldType;
void _check;
