/**
 * Measuring an emitted schema against a provider's size limits.
 *
 * The count is taken from the JSON Schema that is actually sent (never from
 * the code-shape schema), so it is exact for the profile it was rendered
 * with: a record sent as pairs counts its `key`/`value` properties, a widened
 * enum counts nothing, an escaped subtree counts as one string.
 */
import type { SchemaLimits } from './profile';

type J = { [key: string]: unknown };

/** What a provider's limits count, for one emitted schema. */
export interface SchemaMeasure {
  /** Object properties, summed over every level and every `$defs` entry. */
  readonly properties: number;
  /** Deepest nesting of objects/arrays below the root, following `$ref`s (cycles stop). */
  readonly depth: number;
  /** Characters over property names, `$defs` names, enum and const string values. */
  readonly stringChars: number;
  /** Enum values summed over every enum. */
  readonly enumValues: number;
  /** Each enum: how many values, and the characters of its string values. */
  readonly enums: readonly { readonly values: number; readonly chars: number }[];
  /** Properties not listed in their object's `required`. */
  readonly optional: number;
  /** Nodes with a union type: `anyOf`/`oneOf` with 2+ options, or a `type` array with 2+ types. */
  readonly unions: number;
}

export const ZERO_MEASURE: SchemaMeasure = Object.freeze({
  properties: 0, depth: 0, stringChars: 0, enumValues: 0, enums: Object.freeze([]), optional: 0, unions: 0,
});

export function measureJson(schema: J): SchemaMeasure {
  let properties = 0;
  let stringChars = 0;
  let enumValues = 0;
  let optional = 0;
  let unions = 0;
  const enums: { values: number; chars: number }[] = [];
  const defs = (schema.$defs ?? {}) as Record<string, J>;
  for (const name of Object.keys(defs)) stringChars += name.length;

  const count = (j: unknown): void => {
    if (!j || typeof j !== 'object') return;
    if (Array.isArray(j)) { for (const x of j) count(x); return; }
    const o = j as J;
    if (o.properties && typeof o.properties === 'object') {
      const props = o.properties as Record<string, unknown>;
      const required = new Set(Array.isArray(o.required) ? (o.required as string[]) : []);
      for (const [k, p] of Object.entries(props)) {
        properties++;
        stringChars += k.length;
        if (!required.has(k)) optional++;
        count(p);
      }
    }
    if (Array.isArray(o.enum)) {
      let chars = 0;
      for (const v of o.enum) if (typeof v === 'string') chars += v.length;
      enumValues += o.enum.length;
      stringChars += chars;
      enums.push({ values: o.enum.length, chars });
    }
    if (typeof o.const === 'string') stringChars += o.const.length;
    const alts = (o.anyOf ?? o.oneOf) as unknown[] | undefined;
    if ((Array.isArray(alts) && alts.length > 1) || (Array.isArray(o.type) && o.type.length > 1)) unions++;
    for (const k of ['items', 'prefixItems', 'anyOf', 'oneOf', 'allOf', 'additionalProperties', 'not', 'if', 'then', 'else']) {
      if (k in o) count(o[k]);
    }
    if (o.patternProperties && typeof o.patternProperties === 'object') for (const v of Object.values(o.patternProperties as J)) count(v);
  };
  const { $defs: _d, ...body } = schema;
  count(body);
  for (const d of Object.values(defs)) count(d);

  // Depth follows $refs, with a guard so a recursive schema stops at its cycle.
  const depthOf = (j: unknown, open: Set<string>): number => {
    if (!j || typeof j !== 'object' || Array.isArray(j)) return 0;
    const o = j as J;
    if (typeof o.$ref === 'string') {
      const name = /^#\/\$defs\/(.+)$/.exec(o.$ref)?.[1]?.replace(/~1/g, '/').replace(/~0/g, '~');
      if (!name || open.has(name) || !defs[name]) return 0;
      open.add(name);
      const d = depthOf(defs[name], open);
      open.delete(name);
      return d;
    }
    const container = o.type === 'object' || o.type === 'array'
      || (Array.isArray(o.type) && (o.type.includes('object') || o.type.includes('array')));
    let inner = 0;
    const visit = (x: unknown) => { inner = Math.max(inner, depthOf(x, open)); };
    if (o.properties && typeof o.properties === 'object') for (const p of Object.values(o.properties as J)) visit(p);
    for (const k of ['items', 'additionalProperties', 'not']) if (k in o) visit(o[k]);
    for (const k of ['prefixItems', 'anyOf', 'oneOf', 'allOf']) if (Array.isArray(o[k])) for (const x of o[k] as unknown[]) visit(x);
    return (container ? 1 : 0) + inner;
  };
  const depth = depthOf(body, new Set());

  return { properties, depth, stringChars, enumValues, enums, optional, unions };
}

/** Add measures (request totals). */
export function addMeasures(a: SchemaMeasure, b: SchemaMeasure): SchemaMeasure {
  return {
    properties: a.properties + b.properties,
    depth: Math.max(a.depth, b.depth),
    stringChars: a.stringChars + b.stringChars,
    enumValues: a.enumValues + b.enumValues,
    enums: [...a.enums, ...b.enums],
    optional: a.optional + b.optional,
    unions: a.unions + b.unions,
  };
}

/** Which limits a measure breaks, as readable reasons (empty when it fits). */
export function overLimits(m: SchemaMeasure, limits: SchemaLimits | undefined, scope: string): string[] {
  if (!limits) return [];
  const out: string[] = [];
  const over = (what: string, n: number, max: number | undefined) => {
    if (max !== undefined && n > max) out.push(`${scope}: ${n} ${what} (limit ${max})`);
  };
  over('object properties', m.properties, limits.maxProperties);
  over('levels of nesting', m.depth, limits.maxDepth);
  over('characters of names and enum values', m.stringChars, limits.maxStringChars);
  over('enum values', m.enumValues, limits.maxEnumValues);
  over('optional properties', m.optional, limits.maxOptional);
  over('union-typed properties', m.unions, limits.maxUnions);
  if (limits.largeEnumValues !== undefined && limits.maxLargeEnumChars !== undefined) {
    for (const e of m.enums) {
      if (e.values > limits.largeEnumValues && e.chars > limits.maxLargeEnumChars) {
        out.push(`${scope}: an enum of ${e.values} values has ${e.chars} characters (limit ${limits.maxLargeEnumChars} above ${limits.largeEnumValues} values)`);
      }
    }
  }
  return out;
}
