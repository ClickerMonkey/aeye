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

  // Depth follows $refs, with a guard so a recursive schema stops at its cycle:
  // the longest path that enters each named type at most once. Through a
  // recursive grammar that is a longest-SIMPLE-path search, exponential if
  // walked naively (cletus's DBA grammar took 0.66 s per measure), so a named
  // type's depth is memoized by the part of the open set it can reach: only
  // the open members of its own strongly connected component (every open name
  // is an ancestor on the path, so it reaches this type; this type reaches it
  // back only within one component). Exact, and each (type, open component
  // members) state is computed once.
  const refName = (o: J): string | undefined => {
    if (typeof o.$ref !== 'string') return undefined;
    return /^#\/\$defs\/(.+)$/.exec(o.$ref)?.[1]?.replace(/~1/g, '/').replace(/~0/g, '~');
  };
  const sccOf = components(defs, refName);
  const open = new Set<string>();
  const memo = new Map<string, number>();
  const depthOf = (j: unknown): number => {
    if (!j || typeof j !== 'object' || Array.isArray(j)) return 0;
    const o = j as J;
    if (typeof o.$ref === 'string') {
      const name = refName(o);
      if (!name || open.has(name) || !defs[name]) return 0;
      const comp = sccOf.get(name);
      let key = name;
      if (comp) {
        key += '|';
        for (const m of comp) key += open.has(m) ? '1' : '0';
      }
      const hit = memo.get(key);
      if (hit !== undefined) return hit;
      open.add(name);
      const d = depthOf(defs[name]);
      open.delete(name);
      memo.set(key, d);
      return d;
    }
    const container = o.type === 'object' || o.type === 'array'
      || (Array.isArray(o.type) && (o.type.includes('object') || o.type.includes('array')));
    let inner = 0;
    const visit = (x: unknown) => { const d = depthOf(x); if (d > inner) inner = d; };
    if (o.properties && typeof o.properties === 'object') for (const p of Object.values(o.properties as J)) visit(p);
    for (const k of ['items', 'additionalProperties', 'not']) if (k in o) visit(o[k]);
    for (const k of ['prefixItems', 'anyOf', 'oneOf', 'allOf']) if (Array.isArray(o[k])) for (const x of o[k] as unknown[]) visit(x);
    return (container ? 1 : 0) + inner;
  };
  const depth = depthOf(body);

  return { properties, depth, stringChars, enumValues, enums, optional, unions };
}

/**
 * The recursive components of a schema's `$defs` ref graph: for each named
 * type in a component of 2+ types (or one that refers to itself), the
 * component's members in a fixed order. Non-recursive types are absent.
 */
function components(defs: Record<string, J>, refName: (o: J) => string | undefined): Map<string, readonly string[]> {
  const edges = new Map<string, string[]>();
  const collect = (j: unknown, out: Set<string>): void => {
    if (!j || typeof j !== 'object') return;
    if (Array.isArray(j)) { for (const x of j) collect(x, out); return; }
    const n = refName(j as J);
    if (n !== undefined && defs[n]) out.add(n);
    for (const v of Object.values(j as J)) collect(v, out);
  };
  for (const name of Object.keys(defs)) {
    const out = new Set<string>();
    collect(defs[name], out);
    edges.set(name, [...out]);
  }
  // Tarjan's algorithm, iterative (grammars can be deep).
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const result = new Map<string, readonly string[]>();
  let next = 0;
  for (const root of edges.keys()) {
    if (index.has(root)) continue;
    const work: [string, number][] = [[root, 0]];
    while (work.length) {
      const frame = work[work.length - 1]!;
      const [v, i] = frame;
      if (i === 0) {
        index.set(v, next); low.set(v, next); next++;
        stack.push(v); onStack.add(v);
      }
      const out = edges.get(v)!;
      if (i < out.length) {
        frame[1]++;
        const w = out[i]!;
        if (!index.has(w)) work.push([w, 0]);
        else if (onStack.has(w)) low.set(v, Math.min(low.get(v)!, index.get(w)!));
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent) low.set(parent[0], Math.min(low.get(parent[0])!, low.get(v)!));
      if (low.get(v) === index.get(v)) {
        const comp: string[] = [];
        let w: string;
        do { w = stack.pop()!; onStack.delete(w); comp.push(w); } while (w !== v);
        if (comp.length > 1 || out.includes(v)) for (const m of comp) result.set(m, comp);
      }
    }
  }
  return result;
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

/** The limit a measure breaks, by name (`largeEnum` for the large-enum characters rule). */
export type LimitName = Exclude<keyof SchemaLimits, 'largeEnumValues' | 'maxLargeEnumChars'> | 'largeEnum';

/** Which limits a measure breaks, by name (what `overLimits` explains). */
export function brokenLimits(m: SchemaMeasure, limits: SchemaLimits | undefined, out: Set<LimitName> = new Set()): Set<LimitName> {
  if (!limits) return out;
  const over = (k: LimitName, n: number, max: number | undefined) => { if (max !== undefined && n > max) out.add(k); };
  over('maxProperties', m.properties, limits.maxProperties);
  over('maxDepth', m.depth, limits.maxDepth);
  over('maxStringChars', m.stringChars, limits.maxStringChars);
  over('maxEnumValues', m.enumValues, limits.maxEnumValues);
  over('maxOptional', m.optional, limits.maxOptional);
  over('maxUnions', m.unions, limits.maxUnions);
  if (limits.largeEnumValues !== undefined && limits.maxLargeEnumChars !== undefined) {
    for (const e of m.enums) if (e.values > limits.largeEnumValues && e.chars > limits.maxLargeEnumChars) out.add('largeEnum');
  }
  return out;
}
