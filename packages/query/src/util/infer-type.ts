/**
 * inferType — derive a `TypeDef` from a sample of plain JSON rows.
 *
 * For each field observed across the sample it infers a `FieldTypeDef` and
 * nullability, and estimates rough `count` / `bytes`. Useful for bootstrapping
 * a Type from example data (e.g. an LLM-provided dataset) without hand-writing
 * the schema.
 *
 * Inference rules per field (over its non-null observed values):
 *  - all booleans                      → bool
 *  - all numbers                       → number (whole if all integral)
 *  - all strings, all ISO date         → date
 *  - all strings, all ISO timestamp    → timestamp
 *  - all strings (otherwise)           → text (maxLength = longest seen)
 *  - all arrays                        → array (item inferred from the elements:
 *                                        homogeneous scalars ⇒ that scalar type;
 *                                        objects / mixed / empty ⇒ item omitted)
 *  - any object                        → json
 *  - mixed primitive kinds             → text (safe stringifiable fallback)
 * A field is nullable when ANY row has it null or missing.
 */
import type {
  FieldDef,
  FieldTypeDef,
  JsonValue,
  TypeDef,
} from '../schema';

/** Options controlling `inferType` (sampling + Type labelling). */
export interface InferOptions {
  /** Cap the number of rows examined (from the front). Default: all. */
  sampleSize?: number;
  /** Friendly label for the produced Type. */
  label?: string;
  /** Description for the produced Type. */
  description?: string;
}

/** ISO calendar-date with NO time component. */
const ISO_DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
/** ISO datetime (date + time component). */
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;

/** The primitive category a single observed value falls into. */
type Observed = 'bool' | 'int' | 'float' | 'date' | 'timestamp' | 'text' | 'json' | 'array';

function classify(value: JsonValue): Observed | 'null' {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return 'bool';
  if (typeof value === 'number') return Number.isInteger(value) ? 'int' : 'float';
  if (typeof value === 'string') {
    if (ISO_TIMESTAMP.test(value)) return 'timestamp';
    if (ISO_DATE_ONLY.test(value)) return 'date';
    return 'text';
  }
  if (Array.isArray(value)) return 'array';
  // plain object
  return 'json';
}

/** Accumulator tracking everything observed for one field across the sample. */
interface FieldStats {
  /** Distinct primitive categories seen (excluding null). */
  kinds: Set<Observed>;
  /** Whether any row had this field null or missing. */
  nullable: boolean;
  /** Longest string length seen (for text maxLength). */
  maxStringLen: number;
  /** Min / max numeric values seen. */
  numMin: number;
  numMax: number;
  /** Nested stats for ARRAY elements (populated lazily when arrays are seen). */
  elem?: FieldStats;
}

function newStats(): FieldStats {
  return {
    kinds: new Set<Observed>(),
    nullable: false,
    maxStringLen: 0,
    numMin: Number.POSITIVE_INFINITY,
    numMax: Number.NEGATIVE_INFINITY,
  };
}

/** Fold one observed (non-null) value into a stats accumulator. */
function observe(s: FieldStats, value: JsonValue): void {
  const cat = classify(value);
  if (cat === 'null') {
    s.nullable = true;
    return;
  }
  s.kinds.add(cat);
  if (typeof value === 'string') s.maxStringLen = Math.max(s.maxStringLen, value.length);
  if (typeof value === 'number') {
    s.numMin = Math.min(s.numMin, value);
    s.numMax = Math.max(s.numMax, value);
  }
  if (cat === 'array' && Array.isArray(value)) {
    const elem = s.elem ?? (s.elem = newStats());
    for (const ev of value) observe(elem, ev);
  }
}

/** Build the inferred FieldTypeDef from accumulated stats. */
function fieldTypeFromStats(stats: FieldStats): FieldTypeDef {
  const kinds = stats.kinds;
  // No non-null observations at all → fall back to nullable text.
  if (kinds.size === 0) return { kind: 'text' };

  const has = (k: Observed): boolean => kinds.has(k);
  const only = (...ks: Observed[]): boolean =>
    kinds.size <= ks.length && [...kinds].every((k) => ks.includes(k));

  if (only('bool')) return { kind: 'bool' };
  if (only('int')) {
    return { kind: 'number', whole: true };
  }
  if (only('int', 'float')) {
    // Numeric, but with at least one fractional value → not whole.
    return { kind: 'number' };
  }
  if (only('timestamp')) return { kind: 'timestamp' };
  if (only('date')) return { kind: 'date' };
  if (only('date', 'timestamp')) return { kind: 'timestamp' };
  if (only('array')) {
    // Homogeneous arrays → infer the element type from the accumulated element
    // stats; omit `item` when there were no elements (all empty).
    if (stats.elem && stats.elem.kinds.size > 0) {
      return { kind: 'array', item: fieldTypeFromStats(stats.elem) };
    }
    return { kind: 'array' };
  }
  if (has('json') && only('json')) return { kind: 'json' };

  // Pure text, or any mix that includes only string-ish categories →
  // treat as text with the longest length observed.
  if (only('text', 'date', 'timestamp')) {
    return stats.maxStringLen > 0 ? { kind: 'text', maxLength: stats.maxStringLen } : { kind: 'text' };
  }

  // Anything genuinely mixed (e.g. number + string, json + scalar, array +
  // scalar) → a JSON field is the only shape that can hold it losslessly.
  if (has('json') || has('array')) return { kind: 'json' };
  return stats.maxStringLen > 0 ? { kind: 'text', maxLength: stats.maxStringLen } : { kind: 'text' };
}

/** Average byte size of a row, via JSON serialization length. */
function averageBytes(rows: ReadonlyArray<Record<string, JsonValue>>): number {
  if (rows.length === 0) return 0;
  let total = 0;
  for (const row of rows) total += JSON.stringify(row).length;
  return Math.max(1, Math.round(total / rows.length));
}

/** Derive a `TypeDef` named `name` by inferring each field's type from a sample of JSON `rows`. */
export function inferType(
  name: string,
  rows: ReadonlyArray<Record<string, JsonValue>>,
  opts: InferOptions = {},
): TypeDef {
  const sample = opts.sampleSize !== undefined ? rows.slice(0, opts.sampleSize) : rows;

  // Preserve first-seen field order for stable output.
  const order: string[] = [];
  const stats = new Map<string, FieldStats>();
  const ensure = (key: string): FieldStats => {
    let s = stats.get(key);
    if (!s) {
      s = newStats();
      stats.set(key, s);
      order.push(key);
    }
    return s;
  };

  for (const row of sample) {
    // First register every known key so a missing key in this row marks
    // the corresponding field nullable.
    const keysHere = new Set(Object.keys(row));
    for (const key of keysHere) ensure(key);
    for (const key of order) {
      const s = stats.get(key)!;
      if (!keysHere.has(key)) {
        s.nullable = true;
        continue;
      }
      observe(s, row[key]!);
    }
  }

  const fields: FieldDef[] = order.map((key) => {
    const s = stats.get(key)!;
    const fieldType = fieldTypeFromStats(s);
    const def: FieldDef = { name: key, type: fieldType };
    if (s.nullable) def.nullable = true;
    return def;
  });

  return {
    name,
    label: opts.label,
    description: opts.description,
    fields,
    count: rows.length,
    bytes: averageBytes(sample),
  };
}
