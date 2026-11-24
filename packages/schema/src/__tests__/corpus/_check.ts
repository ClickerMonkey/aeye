/**
 * Shared checks for the corpus: every ported schema is run through these on
 * every profile family, so each example is tested for every piece of
 * functionality the same way.
 *
 * - `dialectProblems(json, profile)`: the emitted JSON Schema obeys the
 *   profile's own rules (closed objects, no schema-valued
 *   additionalProperties where records are pairs, every property required
 *   under null-for-absent, no `$ref` cycles without recursion, no keywords
 *   the dialect lacks, enum caps, formats, examples placement, size limits).
 * - `validate(json, value)`: a small JSON Schema validator for the subset
 *   `a` emits, independent of `a`'s own decoder. It proves the wire values
 *   (encoded examples, the model-shaped answers in the tests) are values a
 *   grammar-constrained model could actually write.
 * - `profileProblems(target, samples)`: per profile, render, check the
 *   dialect, encode each code-shape sample, validate the wire against the
 *   JSON sent, decode it back and compare, and check that a LENIENT decode of
 *   the code value copies nothing.
 */
import { isDeepStrictEqual } from 'node:util';
import {
  ANTHROPIC_NON_STRICT, ANTHROPIC_STRICT, GOOGLE_NON_STRICT, GOOGLE_OPENAPI, GOOGLE_STRICT, LENIENT, MINIMAL, OLLAMA,
  OPENAI_NON_STRICT, OPENAI_STRICT, PEOPLE, XAI_NON_STRICT, XAI_STRICT, isBasicPattern, measureJson, overLimits, variant,
  type Bound, type JsonSchema, type Profile, type Rendered,
} from '../../index';

/** Every built-in profile family, strict and not. */
export const PROFILES = {
  lenient: LENIENT,
  people: PEOPLE,
  'openai-strict': OPENAI_STRICT,
  openai: OPENAI_NON_STRICT,
  'anthropic-strict': ANTHROPIC_STRICT,
  anthropic: ANTHROPIC_NON_STRICT,
  'google-strict': GOOGLE_STRICT,
  google: GOOGLE_NON_STRICT,
  'google-openapi': GOOGLE_OPENAPI,
  'xai-strict': XAI_STRICT,
  xai: XAI_NON_STRICT,
  ollama: OLLAMA,
  minimal: MINIMAL,
} as const satisfies Record<string, Profile>;

/** The profiles a model can be given (everything but `people`). */
export const MODEL_PROFILES: readonly Profile[] = Object.values(PROFILES).filter((p) => p.audience !== 'people');

/** Tool parameters: the profile with an object root (as `planRequest` renders tools). */
export const asTool = (p: Profile): Profile => variant(p, { rootObject: true });

type J = { [key: string]: unknown };
const isObj = (v: unknown): v is J => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Walk every subschema of an emitted schema with its JSON pointer-ish path. */
function walk(root: J, visit: (node: J, path: string, parentKey: string | undefined) => void): void {
  const go = (node: unknown, path: string, key: string | undefined): void => {
    if (!isObj(node)) return;
    visit(node, path, key);
    if (isObj(node.properties)) for (const [k, v] of Object.entries(node.properties)) go(v, `${path}/properties/${k}`, 'properties');
    if (isObj(node.patternProperties)) for (const [k, v] of Object.entries(node.patternProperties)) go(v, `${path}/patternProperties/${k}`, 'patternProperties');
    if (isObj(node.$defs)) for (const [k, v] of Object.entries(node.$defs)) go(v, `${path}/$defs/${k}`, '$defs');
    for (const k of ['items', 'additionalProperties', 'not', 'if', 'then', 'else']) if (isObj(node[k])) go(node[k], `${path}/${k}`, k);
    for (const k of ['anyOf', 'oneOf', 'allOf', 'prefixItems']) if (Array.isArray(node[k])) (node[k] as unknown[]).forEach((v, i) => go(v, `${path}/${k}/${i}`, k));
  };
  go(root, '#', undefined);
}

/** Named types that reach themselves through `$ref`. */
function cyclicDefs(root: J): string[] {
  const defs = (isObj(root.$defs) ? root.$defs : {}) as Record<string, J>;
  const edges = new Map<string, Set<string>>();
  for (const [name, d] of Object.entries(defs)) {
    const out = new Set<string>();
    JSON.stringify(d, (k, v) => {
      if (k === '$ref' && typeof v === 'string') {
        const m = /^#\/\$defs\/(.+)$/.exec(v);
        if (m) out.add(m[1]!);
      }
      return v;
    });
    edges.set(name, out);
  }
  const cyclic: string[] = [];
  for (const start of edges.keys()) {
    const seen = new Set<string>();
    const stack = [...(edges.get(start) ?? [])];
    while (stack.length) {
      const n = stack.pop()!;
      if (n === start) { cyclic.push(start); break; }
      if (seen.has(n)) continue;
      seen.add(n);
      stack.push(...(edges.get(n) ?? []));
    }
  }
  return cyclic;
}

/** How the emitted schema breaks the profile's own rules (empty when it obeys them). */
export function dialectProblems(json: JsonSchema, profile: Profile): string[] {
  const out: string[] = [];
  const p = profile;
  if (p.rootObject && json.type !== 'object') out.push(`#: root must be an object (got ${JSON.stringify(json.type ?? Object.keys(json))})`);
  if (!p.defs && (json.$defs !== undefined || JSON.stringify(json).includes('"$ref"'))) out.push('#: $defs/$ref used but the dialect has none');
  if (p.defs && p.recursion === false) for (const n of cyclicDefs(json)) out.push(`#/$defs/${n}: recursive, but the dialect has no recursion`);
  walk(json, (n, path) => {
    const has = (k: string) => k in n;
    if (has('properties') || n.type === 'object') {
      const props = isObj(n.properties) ? Object.keys(n.properties) : [];
      const req = new Set(Array.isArray(n.required) ? (n.required as string[]) : []);
      if (p.closedObjects && n.additionalProperties !== false && props.length) out.push(`${path}: object not closed`);
      if (p.optional === 'null') for (const k of props) if (!req.has(k)) out.push(`${path}/properties/${k}: optional, but every property must be required`);
      for (const k of req) if (!props.includes(k)) out.push(`${path}: requires "${k}" with no schema for it`);
      if (p.records === 'pairs' && isObj(n.additionalProperties)) out.push(`${path}: schema-valued additionalProperties, but records are pairs here`);
      if (p.propertyOrdering && props.length && !Array.isArray(n.propertyOrdering)) out.push(`${path}: no propertyOrdering`);
    }
    if (has('prefixItems') && p.tuples !== 'prefixItems') out.push(`${path}: prefixItems unsupported`);
    if ((has('anyOf') || has('oneOf')) && p.unions === 'tagged') out.push(`${path}: anyOf in a dialect with no combinators`);
    if (has('allOf') && !p.allOf) out.push(`${path}: allOf unsupported`);
    if ((has('not') || has('if') || has('then') || has('else')) && !p.conditionals) out.push(`${path}: not/if unsupported`);
    if (has('patternProperties') && !p.patternProperties) out.push(`${path}: patternProperties unsupported`);
    if (has('examples') && p.examples !== 'keyword') out.push(`${path}: examples keyword unsupported`);
    if (Array.isArray(n.type) && (p.nulls === 'anyOf' || p.nulls === 'nullable')) out.push(`${path}: type array, but nulls are spelled ${p.nulls}`);
    if (has('nullable') && p.nulls !== 'nullable') out.push(`${path}: nullable keyword unsupported`);
    const typeless = !has('type') && !has('not') && !has('anyOf') && !has('oneOf') && !has('allOf') && !has('$ref') && !has('enum') && !has('const');
    if (typeless && p.any !== 'empty') out.push(`${path}: empty ("any") schema, but "any" is ${p.any} here`);
    const c = p.constraints;
    if (!c.length && (has('minLength') || has('maxLength'))) out.push(`${path}: length bounds unsupported`);
    if (!c.range && (has('minimum') || has('maximum'))) out.push(`${path}: range bounds unsupported`);
    if (c.items === 'none' && (has('minItems') || has('maxItems'))) out.push(`${path}: item bounds unsupported`);
    if (c.items === 'min-0-1' && (has('maxItems') || (typeof n.minItems === 'number' && n.minItems > 1))) {
      // A tuple's exact length is only emitted with prefixItems, which these dialects lack.
      out.push(`${path}: only minItems 0 or 1 supported`);
    }
    if (typeof n.pattern === 'string' && (c.pattern === 'none' || (c.pattern === 'basic' && !isBasicPattern(n.pattern)))) out.push(`${path}: pattern unsupported`);
    if (typeof n.format === 'string' && p.formats !== 'all' && !p.formats.has(n.format)) out.push(`${path}: format ${n.format} unsupported`);
    if (Array.isArray(n.enum) && p.maxEnumValues !== undefined && n.enum.length > p.maxEnumValues) out.push(`${path}: enum of ${n.enum.length} over the cap ${p.maxEnumValues}`);
    if (Array.isArray(n.enum) && n.enum.length === 0) out.push(`${path}: empty enum`);
    if (Array.isArray(n.anyOf) && n.anyOf.length === 0) out.push(`${path}: empty anyOf`);
  });
  out.push(...overLimits(measureJson(json), p.limits, '#'));
  return out;
}

// ============================================================================
// A small JSON Schema validator (the subset `a` emits)
// ============================================================================

const typeOf = (v: unknown): string =>
  v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v === 'number' ? (Number.isInteger(v) ? 'integer' : 'number') : typeof v;

/** Errors validating `value` against an emitted JSON Schema (empty when valid). */
export function validate(root: JsonSchema, value: unknown): string[] {
  const defs = (isObj(root.$defs) ? root.$defs : {}) as Record<string, J>;
  const errs: string[] = [];
  const check = (s: unknown, v: unknown, path: string, out: string[]): void => {
    if (s === true || s === undefined) return;
    if (s === false) { out.push(`${path}: nothing allowed`); return; }
    if (!isObj(s)) return;
    if (typeof s.$ref === 'string') {
      const m = /^#\/\$defs\/(.+)$/.exec(s.$ref);
      const d = m ? defs[m[1]!] : undefined;
      if (!d) out.push(`${path}: unresolved ${s.$ref}`);
      else check(d, v, path, out);
    }
    if (s.nullable === true && v === null) return;
    if (s.type !== undefined) {
      const types = Array.isArray(s.type) ? (s.type as string[]) : [s.type as string];
      const t = typeOf(v);
      if (!types.some((x) => x === t || (x === 'number' && t === 'integer'))) { out.push(`${path}: expected ${types.join('|')}, got ${t}`); return; }
    }
    if (Array.isArray(s.enum) && !s.enum.some((e) => isDeepStrictEqual(e, v))) out.push(`${path}: not in enum`);
    if ('const' in s && !isDeepStrictEqual(s.const, v)) out.push(`${path}: not the const`);
    for (const k of ['anyOf', 'oneOf'] as const) {
      if (Array.isArray(s[k])) {
        const opts = s[k] as unknown[];
        const ok = opts.filter((o) => { const e: string[] = []; check(o, v, path, e); return !e.length; }).length;
        if (k === 'anyOf' ? ok === 0 : ok !== 1) out.push(`${path}: ${ok} of ${k} matched`);
      }
    }
    if (Array.isArray(s.allOf)) for (const o of s.allOf) check(o, v, path, out);
    if (s.not !== undefined) { const e: string[] = []; check(s.not, v, path, e); if (!e.length) out.push(`${path}: matched "not"`); }
    if (s.if !== undefined) {
      const e: string[] = [];
      check(s.if, v, path, e);
      if (!e.length) { if (s.then !== undefined) check(s.then, v, path, out); }
      else if (s.else !== undefined) check(s.else, v, path, out);
    }
    if (typeof v === 'string') {
      if (typeof s.minLength === 'number' && v.length < s.minLength) out.push(`${path}: too short`);
      if (typeof s.maxLength === 'number' && v.length > s.maxLength) out.push(`${path}: too long`);
      if (typeof s.pattern === 'string' && !new RegExp(s.pattern).test(v)) out.push(`${path}: pattern`);
    }
    if (typeof v === 'number') {
      if (typeof s.minimum === 'number' && v < s.minimum) out.push(`${path}: below minimum`);
      if (typeof s.maximum === 'number' && v > s.maximum) out.push(`${path}: above maximum`);
    }
    if (Array.isArray(v)) {
      if (typeof s.minItems === 'number' && v.length < s.minItems) out.push(`${path}: too few items`);
      if (typeof s.maxItems === 'number' && v.length > s.maxItems) out.push(`${path}: too many items`);
      const prefix = Array.isArray(s.prefixItems) ? (s.prefixItems as unknown[]) : [];
      v.forEach((x, i) => check(i < prefix.length ? prefix[i] : s.items, x, `${path}[${i}]`, out));
    }
    if (isObj(v) && (s.properties !== undefined || s.additionalProperties !== undefined || s.required !== undefined || s.patternProperties !== undefined)) {
      const props = (isObj(s.properties) ? s.properties : {}) as Record<string, unknown>;
      const pats = Object.entries((isObj(s.patternProperties) ? s.patternProperties : {}) as Record<string, unknown>).map(([p, x]) => [new RegExp(p), x] as const);
      for (const r of (Array.isArray(s.required) ? s.required : []) as string[]) if (!(r in v)) out.push(`${path}.${r}: required`);
      for (const [k, x] of Object.entries(v)) {
        if (k in props) { check(props[k], x, `${path}.${k}`, out); continue; }
        const pm = pats.filter(([re]) => re.test(k));
        if (pm.length) { for (const [, ps] of pm) check(ps, x, `${path}.${k}`, out); continue; }
        if (s.additionalProperties === false) out.push(`${path}.${k}: not allowed`);
        else if (isObj(s.additionalProperties)) check(s.additionalProperties, x, `${path}.${k}`, out);
      }
    }
  };
  check(root, value, '$', errs);
  return errs;
}

// ============================================================================
// Every profile, every sample
// ============================================================================

export interface ProfileCheckOptions {
  /** Render as tool parameters (object root). Default true. */
  readonly tool?: boolean;
  /** Profiles to check (default every model profile + PEOPLE). */
  readonly profiles?: readonly Profile[];
  /**
   * The samples hold codec values (fn names, ids) whose code form is not
   * their wire form: skip the "decoding a code value copies nothing" check.
   */
  readonly codecs?: boolean;
}

type Target = Bound<any> | { bind(): Bound<any> };
const boundOf = (t: Target): Bound<any> => ('env' in t && 'root' in t ? t : (t as { bind(): Bound<any> }).bind());

/**
 * For every profile: the dialect is obeyed; each code-shape sample encodes
 * to a wire value the emitted JSON Schema accepts, which decodes back to
 * the sample (in place and copy-on-write) without touching the sample; and
 * decoding the code value itself under LENIENT copies nothing.
 */
export function profileProblems(target: Target, samples: readonly unknown[], opts: ProfileCheckOptions = {}): string[] {
  const bound = boundOf(target);
  const out: string[] = [];
  const profiles = opts.profiles ?? [...MODEL_PROFILES, PEOPLE];
  for (const base of profiles) {
    const p = opts.tool === false ? base : asTool(base);
    let r: Rendered<unknown>;
    try {
      r = bound.render(p);
      for (const x of dialectProblems(r.jsonSchema, p)) out.push(`[${p.id}] ${x}`);
    } catch (e) {
      out.push(`[${p.id}] render threw: ${(e as Error).message}`);
      continue;
    }
    samples.forEach((sample, i) => {
      const before = structuredClone(sample);
      let wire: unknown;
      try {
        wire = r.encode(sample);
      } catch (e) {
        out.push(`[${p.id}] sample ${i}: encode threw: ${(e as Error).message}`);
        return;
      }
      if (!isDeepStrictEqual(sample, before)) out.push(`[${p.id}] sample ${i}: encode mutated the value`);
      for (const x of validate(r.jsonSchema, wire)) out.push(`[${p.id}] sample ${i}: wire invalid: ${x}`);
      const text = JSON.stringify(wire);
      const res = r.parseText(text);
      if (!res.ok) out.push(`[${p.id}] sample ${i}: decode failed:\n${res.message}`);
      else if (!isDeepStrictEqual(res.value, sample)) out.push(`[${p.id}] sample ${i}: round trip differs: ${JSON.stringify(res.value)} vs ${JSON.stringify(sample)}`);
      const cow = r.parse(JSON.parse(text), { inPlace: false });
      if (!cow.ok || !isDeepStrictEqual(cow.value, sample)) out.push(`[${p.id}] sample ${i}: copy-on-write decode differs`);
    });
  }
  // Decoding a code value under LENIENT is a pure check: same reference, nothing allocated.
  if (opts.codecs) return out;
  const lenient = bound.render(LENIENT);
  samples.forEach((sample, i) => {
    const res = lenient.parse(sample, { inPlace: false });
    if (!res.ok) out.push(`[lenient] sample ${i} is not a valid code value:\n${res.message}`);
    else {
      if (res.value !== sample && typeof sample === 'object' && sample !== null) out.push(`[lenient] sample ${i}: not the same reference`);
      const s = res.stats;
      if (s.objects + s.arrays + s.edits + s.parsed + s.repaired) out.push(`[lenient] sample ${i}: copied ${JSON.stringify(s)}`);
    }
  });
  return out;
}

/** Deep clone a JSON value (answers are parsed in place). */
export const clone = <T>(v: T): T => structuredClone(v);

/**
 * Degradations of a request that no entry records (each one should be
 * explained by an entry's `adjustments`, a rename, or the dispatcher).
 */
export function unexplained(req: { readonly degradations: readonly string[]; readonly entries: readonly { readonly name: string; readonly adjustments: readonly { readonly kind: string }[] }[] }): string[] {
  const adjusted = new Set(req.entries.filter((e) => e.adjustments.some((x) => x.kind !== 'root-wrapped')).map((e) => `"${e.name}"`));
  return req.degradations.filter((d) => {
    const m = /^"[^"]+"/.exec(d);
    if (/ tools \(limit \d+\): /.test(d) || / is named twice/.test(d)) return false;
    return !(m && adjusted.has(m[0]));
  });
}
