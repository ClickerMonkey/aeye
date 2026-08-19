import { z } from 'zod';
import type { FieldTypeDef, TextFieldTypeDef, FieldValueDef } from '../schema';
import {
  fieldValuesSchema,
  checkFieldValues,
  closedSetValueSchema,
  compactFieldValues,
  meetFieldValues,
  narrowFieldValues,
} from './_values';
import { meetExact, meetFlag, meetLower, meetUpper, emptyRange } from './_meet';
import type { ValueSchemaOptions } from '../node';
import { FieldType, type FieldTypeClass, type ScalarKind } from '../field-type';
import { QueryTypeError } from '../problem';

/** Options bag for a text field type (instance-side). */
export interface TextOptions {
  /** Minimum string length. */
  minLength?: number;
  /** Maximum string length. */
  maxLength?: number;
  /**
   * Format regex the value must match. Validated by {@link TextFieldType.from},
   * which is the road every in-package parse takes (a Type's fields, a nested
   * `array` item, a function parameter) — so a type built from a DEF cannot
   * carry an uncompilable one. The CONSTRUCTOR does not validate, so a
   * hand-built `new TextFieldType({ pattern: '([' })` still can, and will throw
   * a `SyntaxError` at whichever use compiles it first. Same caveat as every
   * other option supplied by hand rather than parsed.
   */
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

/**
 * Reject a `pattern` that is not a compilable regex, at DECLARATION time.
 *
 * It belongs here rather than at any use site because it is a defect in the
 * DEFINITION — nothing a query does can make `'(['` valid — and because the uses
 * compile it lazily and inconsistently: `toValueSchema()` short-circuits on a
 * closed set and never compiles at all, so a column declaring BOTH a pattern and
 * a set carried an uncompilable regex completely inertly. The meet then compiles
 * it (it narrows a merged set by the merged constraints), which turned a def
 * `parseType` had accepted into a raw `SyntaxError` thrown out of
 * `validateQuery` — from a package whose whole contract is that diagnostics come
 * back as `Problems`. Failing at registration makes that unreachable, and it is
 * the same road (`QueryTypeError` from `from`) a malformed def already takes.
 */
function checkPattern(pattern: string): void {
  try {
    new RegExp(pattern);
  } catch (err) {
    // `String(err)` rather than a narrowing `instanceof Error` check: `RegExp`
    // only ever throws a `SyntaxError`, so the non-Error arm would be dead code,
    // and the engine's own text ("Unterminated character class") is the half of
    // this message that says how to FIX the pattern.
    throw new QueryTypeError({
      path: ['pattern'], code: 'field-type.bad-pattern', severity: 'error',
      message: `Text field 'pattern' is not a valid regular expression: ${JSON.stringify(pattern)} (${String(err)}).`,
    });
  }
}

/**
 * A value-side Zod schema for a text bag's SCALAR CONSTRAINTS alone — length +
 * pattern, ignoring any closed set. Split out from `toValueSchema` (which
 * short-circuits on the closed set) because a MEET has to ask the two questions
 * separately: it narrows a merged set by the merged constraints, which is only
 * possible if the constraints can be asked about on their own.
 *
 * Its `pattern` is compilable by construction on any type built through
 * {@link TextFieldType.from} — see {@link checkPattern}.
 */
export function textConstraintSchema(o: TextOptions): z.ZodTypeAny {
  let s = z.string();
  if (o.minLength !== undefined) s = s.min(o.minLength);
  if (o.maxLength !== undefined) s = s.max(o.maxLength);
  if (o.pattern !== undefined) s = s.regex(new RegExp(o.pattern));
  return s;
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

  /**
   * Reconstruct from a JSON def. Throws a `QueryTypeError` on a kind mismatch,
   * on an uncompilable `pattern`, and on a closed set holding a member this
   * type's own length / pattern constraints reject — all three are defects in
   * the DECLARATION, and this is the road every in-package parse takes.
   */
  static from(json: FieldTypeDef): TextFieldType {
    if (json.kind !== 'text') {
      throw new QueryTypeError({
        path: [], code: 'field-type.mismatch', severity: 'error',
        message: `TextFieldType.from: expected kind 'text', got '${json.kind}'`,
      });
    }
    const { minLength, maxLength, pattern, semantic, search, sensitive, values } = json;
    // Order matters: `textConstraintSchema` COMPILES the pattern, so an
    // uncompilable one has to be refused as itself before the set is checked
    // against it — otherwise the member check throws a raw `SyntaxError`.
    if (pattern !== undefined) checkPattern(pattern);
    const options = compact({ minLength, maxLength, pattern, semantic, search, sensitive, values });
    // Checked on the COMPACTED set, so a member repeated in the declaration is
    // named once rather than once per occurrence.
    checkFieldValues('text', ['values'], options.values, textConstraintSchema(options));
    return new TextFieldType(options);
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
      // A `text` member is a STRING — the owning kind decides the member type
      // (see `fieldValuesSchema`), so this schema cannot offer a numeric one.
      values: fieldValuesSchema(z.string()),
    }).meta({ aid: 'FieldType_text' }).describe('String field type.');
  }

  /** Resolve to the `text` scalar comparison category. */
  resolve(): ScalarKind {
    return 'text';
  }

  /** The closed set this string may hold, when one is declared (drives `eqSelectivity`, membership, the meet). */
  override values(): readonly FieldValueDef[] | undefined {
    return this.options.values;
  }

  /**
   * Meet with another `text`: bounds tighten, a `pattern` must AGREE (there is
   * no regex that is the intersection of two others, so two different formats
   * are a genuine conflict), flags OR, and the closed sets intersect. The merged
   * SET is then narrowed by the merged CONSTRAINTS — the two can arrive from
   * different uses, and a closed set is the value schema, so a member that
   * cannot satisfy the merged length/pattern would otherwise be accepted.
   */
  protected override meetWith(other: FieldType): FieldType | undefined {
    if (!(other instanceof TextFieldType)) return undefined;
    const a = this.options;
    const b = other.options;
    const pattern = meetExact(a.pattern, b.pattern);
    if (!pattern.ok) return undefined;
    const minLength = meetLower(a.minLength, b.minLength);
    const maxLength = meetUpper(a.maxLength, b.maxLength);
    if (emptyRange(minLength, maxLength)) return undefined;
    const values = meetFieldValues(a.values, b.values);
    if (!values.ok) return undefined;
    const merged: TextOptions = compact({
      minLength,
      maxLength,
      pattern: pattern.value,
      semantic: meetFlag(a.semantic, b.semantic),
      search: meetFlag(a.search, b.search),
      sensitive: meetFlag(a.sensitive, b.sensitive),
      values: values.value,
    });
    if (merged.values) {
      const constraints = textConstraintSchema(merged);
      const kept = narrowFieldValues(merged.values, (v) => constraints.safeParse(v).success);
      if (kept.length === 0) return undefined;
      merged.values = kept;
    }
    return new TextFieldType(merged);
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
    // the same members less precisely. (A MERGED type keeps that true: its meet
    // narrows the set by the constraints rather than leaving both to be read.)
    return closedSetValueSchema(this.options.values) ?? textConstraintSchema(this.options);
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
