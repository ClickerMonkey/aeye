/**
 * Values written into text before the request they go in is planned.
 *
 * `{{encode value}}` writes a value as the model writes it, which depends on the
 * request's plan: a record is pairs on OpenAI strict, an absent optional is
 * `null` past Anthropic's optional budget, a tool past the provider's cap is
 * called through the dispatcher. Text made before the plan exists (a relaying
 * provider that forwards the request to the one that plans it; text an
 * application assembles before its provider plans) holds a DEFERRED value
 * instead: the code-shape value and which schema of the request it is written
 * with. Once the request is planned, `fillDeferred(text, plan)` writes each one
 * through that plan, so the text and the schemas sent can't disagree.
 *
 * ```ts
 * const text = `Call it like ${deferEncode({ tool: 'search', value: { query: 'x', limits: { food: 3 } } })}`;
 * // … the provider plans the request for its model …
 * fillDeferred(text, plan);     // Call it like {"query":"x","limits":[{"key":"food","value":3}]}  (OpenAI strict)
 * plainDeferred(text);          // Call it like {"query":"x","limits":{"food":3}}                    (the code shape)
 * ```
 *
 * A relay renders its templates for `deferredRequest(plan)`: every `{{encode}}`,
 * `{{schema}}` and encoder in them writes a deferred value, which travels as
 * plain text and is filled where the request is planned (`@aeye/core`'s
 * `prepareRequest` fills every deferred value of a request it plans).
 *
 * The form is `⟦encode {…}⟧` / `⟦schema {…}⟧` with the spec as JSON inside (its
 * `⟧` escaped), so it survives JSON, Handlebars and copying.
 */
import { fromJSONSchema } from './json-schema';
import { LENIENT } from './profile';
import type { Bound } from './module';
import type { EncodeTextOptions, Encoder, JsonSchema, PathSeg, Rendered } from './render';
import type { RenderedRequest, RequestEntry, Strictness } from './request';

/** What a deferred value is written with, once the request is planned. */
export interface DeferredSpec {
  /** The tool of the request whose arguments it is (or a part of, with `path`). */
  readonly tool?: string;
  /** The request's structured output instead of a tool. */
  readonly output?: boolean;
  /** The value, in the code shape (ignored for `type`). */
  readonly value?: unknown;
  /** A part: the value sits at this code path of the schema (`limits`, `rows.*.tags`). */
  readonly path?: string | readonly PathSeg[];
  /** Indent the JSON (`true` = 2 spaces). */
  readonly pretty?: boolean | number;
  /** Write the schema itself as TypeScript-like text (`{{schema}}`) instead of a value. */
  readonly type?: boolean;
  /**
   * For a tool the request may not have (one offered in a later step): its schema as lenient JSON Schema. When the
   * request has no tool of that name, the value is written as that schema would be, planned alone for the request's
   * model (with `strict`); without it the value is written in the code shape.
   */
  readonly schema?: JsonSchema;
  /** The strictness the tool would be asked with (`schema` only). Default `1`. */
  readonly strict?: Strictness;
  /**
   * Show only this part of what was written (a dotted path in the WIRE value): the whole value is written, then the
   * part picked, e.g. a dispatcher-like tool's `args` as it writes them for the one it names (`{ fn, args }`, pick
   * `args`). Unlike `path`, the part is written as the whole value has it.
   */
  readonly pick?: string;
  /** What to show when the plan can't write it (no such tool, no plan, a value that doesn't fit): else the code shape. */
  readonly fallback?: string;
}

const OPEN = '⟦';
const CLOSE = '⟧';
const PATTERN = /⟦(encode|schema) (\{[^⟧]*\})⟧/g;

/** One deferred value, captured whole: `text.split(DEFERRED_SPAN)` gives the text around them at even indexes and the values at odd ones. */
export const DEFERRED_SPAN = /(⟦(?:encode|schema) \{[^⟧]*\}⟧)/;

/** The text of a deferred value: the spec, to be written through the request's plan. */
export function deferEncode(spec: DeferredSpec): string {
  const { type, ...rest } = spec;
  return `${OPEN}${type ? 'schema' : 'encode'} ${JSON.stringify(rest).replace(/⟧/g, '\\u27e7')}${CLOSE}`;
}

/** The text of a deferred `{{schema}}`: the schema of a tool (or the output) as TypeScript-like text. */
export function deferSchema(spec: Pick<DeferredSpec, 'tool' | 'output' | 'schema' | 'strict'>): string {
  return deferEncode({ ...spec, type: true });
}

/** Whether a text holds any deferred value. */
export function hasDeferred(text: string): boolean {
  return text.includes(`${OPEN}encode `) || text.includes(`${OPEN}schema `);
}

/** How `fillDeferred` treats what isn't in the plan. */
export interface FillOptions {
  /** A bound schema for a lenient JSON Schema a deferred value carries (default: `a.fromJSONSchema`, kept by JSON). */
  readonly schemaOf?: (schema: JsonSchema) => Bound<unknown>;
}

/** Schemas rebuilt from deferred values' JSON, least recently used first. */
const rebuilt = new Map<string, Bound<unknown>>();
const REBUILT_MAX = 32;

function defaultSchemaOf(schema: JsonSchema): Bound<unknown> {
  const key = JSON.stringify(schema);
  const known = rebuilt.get(key);
  if (known) {
    rebuilt.delete(key);
    rebuilt.set(key, known);
    return known;
  }
  const made = fromJSONSchema(schema).bind() as Bound<unknown>;
  rebuilt.set(key, made);
  while (rebuilt.size > REBUILT_MAX) rebuilt.delete(rebuilt.keys().next().value as string);
  return made;
}

function indentOf(pretty: DeferredSpec['pretty']): number | undefined {
  return pretty === true ? 2 : typeof pretty === 'number' ? pretty : undefined;
}

/** The code shape of a deferred value (nothing to write it through). */
function codeShape(spec: DeferredSpec): string {
  if (spec.fallback !== undefined) return spec.fallback;
  if (spec.type) return 'unknown';
  const shown = spec.pick === undefined ? spec.value : pickAt(spec.value, spec.pick);
  return JSON.stringify(shown, null, indentOf(spec.pretty)) ?? 'null';
}

/** The part of a JSON value at a dotted path (`undefined` where there is none). */
function pickAt(value: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((at, key) => (typeof at === 'object' && at !== null ? (at as Record<string, unknown>)[key] : undefined), value);
}

/** The entry a deferred value is written through: the plan's, or its own schema planned alone for the plan's model. */
function entryFor(spec: DeferredSpec, plan: RenderedRequest<any> | undefined, opts: FillOptions): RequestEntry<unknown> | undefined {
  if (!plan) return undefined;
  if (spec.output) return plan.output;
  if (spec.tool === undefined) return undefined;
  if (plan.has(spec.tool)) return plan.get(spec.tool as never) as unknown as RequestEntry<unknown>;
  if (!spec.schema) return undefined;
  const bound = (opts.schemaOf ?? defaultSchemaOf)(spec.schema);
  return plan.target.request([{ kind: 'tool', name: spec.tool, schema: bound, strict: spec.strict ?? 1 }]).get(spec.tool);
}

/** Whether two JSON values are the same (object key order aside). */
function sameJson(x: unknown, y: unknown): boolean {
  if (x === y) return true;
  if (typeof x !== 'object' || typeof y !== 'object' || x === null || y === null) return false;
  if (Array.isArray(x) !== Array.isArray(y)) return false;
  if (Array.isArray(x)) return x.length === (y as unknown[]).length && x.every((item, i) => sameJson(item, (y as unknown[])[i]));
  const xs = Object.entries(x).filter(([, v]) => v !== undefined);
  const ys = Object.entries(y).filter(([, v]) => v !== undefined);
  return xs.length === ys.length && xs.every(([key, v]) => sameJson(v, (y as Record<string, unknown>)[key]));
}

/** One deferred value written through a plan (the code shape where the plan can't write it). */
function fillOne(spec: DeferredSpec, plan: RenderedRequest<any> | undefined, opts: FillOptions): string {
  const entry = entryFor(spec, plan, opts);
  if (!entry) return codeShape(spec);
  try {
    if (spec.type) return entry.rendered.typescript();
    const textOpts: { pretty?: boolean | number; path?: string | readonly PathSeg[] } = {};
    if (spec.pretty !== undefined) textOpts.pretty = spec.pretty;
    if (spec.path !== undefined) textOpts.path = spec.path;
    const text = spec.pick === undefined ? entry.encodeText(spec.value, textOpts as EncodeTextOptions) : entry.encodeText(spec.value);
    // a whole value must read back as itself through the schema it was written for: one that doesn't fit (a stale
    // example) is shown as it is, never dressed up as if it were right
    if (spec.path === undefined) {
      const back = entry.parseText(text, { repair: false });
      if (!back.ok || !sameJson(back.value, spec.value)) return codeShape(spec);
    }
    if (spec.pick === undefined) return text;
    return JSON.stringify(pickAt(JSON.parse(text), spec.pick), null, indentOf(spec.pretty)) ?? 'null';
  } catch {
    // a value its schema can't write: shown as it is
    return codeShape(spec);
  }
}

/**
 * Write every deferred value of a text through a request's plan: as the model writes that tool's arguments (or the
 * output), a part of them with `path`; a tool the plan doesn't have through the schema the value carries, planned
 * alone for the plan's model, else in the code shape. Without a plan, the code shape (`plainDeferred`). Text with no
 * deferred value comes back as it is.
 */
export function fillDeferred(text: string, plan: RenderedRequest<any> | undefined, opts: FillOptions = {}): string {
  if (!hasDeferred(text)) return text;
  return text.replace(PATTERN, (whole, kind: string, json: string) => {
    let spec: DeferredSpec;
    try {
      spec = JSON.parse(json) as DeferredSpec;
    } catch {
      return whole;
    }
    return fillOne(kind === 'schema' ? { ...spec, type: true } : spec, plan, opts);
  });
}

/** A text with each deferred value in the code shape: for estimates, logs and people, before a plan exists. */
export function plainDeferred(text: string): string {
  return fillDeferred(text, undefined);
}

/** What a deferred request's entries offer the template helpers and encoders. */
interface DeferredEntry {
  readonly name: string;
  readonly kind: 'tool' | 'output';
  readonly rendered: { encodeText(value: unknown, opts?: EncodeTextOptions): string; typescript(): string };
  readonly encoder: Encoder<unknown>;
  encodeText(value: unknown, opts?: EncodeTextOptions): string;
  encode(value: unknown): unknown;
}

/**
 * A stand-in for a request's plan whose encoders write deferred values: render a request's templates for it (core's
 * `deferRequest`) and the text carries each value to be written once the request is planned where it is sent. `known`
 * supplies schemas a template may name that the request doesn't have (a tool offered in a later step): their deferred
 * values carry the schema. `wire` (a JSON value, not text) can't be deferred: it gives the code shape.
 */
export function deferredRequest(plan: RenderedRequest<any>, known?: (name: string) => Bound<any> | undefined): RenderedRequest {
  const entries = new Map<string, DeferredEntry>();
  const entryOf = (name: string, output: boolean): DeferredEntry => {
    const key = output ? '\u0000output' : name;
    const kept = entries.get(key);
    if (kept) return kept;
    const extra = !output && !plan.has(name) ? known?.(name) : undefined;
    const base: Pick<DeferredSpec, 'tool' | 'output' | 'schema'> = output ? { output: true }
      : extra ? { tool: name, schema: extra.render(LENIENT).jsonSchema } : { tool: name };
    const lenient = (output ? plan.output?.rendered : plan.has(name) ? plan.get(name as never).rendered : extra?.render(LENIENT)) as Rendered<unknown> | undefined;
    const encodeText = (value: unknown, opts: EncodeTextOptions = {}): string => deferEncode({
      ...base, value, ...(opts.path !== undefined ? { path: opts.path } : {}), ...(opts.pretty !== undefined ? { pretty: opts.pretty } : {}),
    });
    const encoder = ((value: unknown, opts?: EncodeTextOptions) => encodeText(value, opts)) as Encoder<unknown>;
    (encoder as { wire: Encoder<unknown>['wire'] }).wire = (value, path) => (lenient ? (path === undefined ? lenient.encode(value) : lenient.encodeAt(value, path)) : value);
    const made: DeferredEntry = {
      name, kind: output ? 'output' : 'tool',
      rendered: { encodeText, typescript: () => deferSchema(base) },
      encoder: Object.freeze(encoder), encodeText,
      encode: (value) => encoder.wire(value),
    };
    entries.set(key, made);
    return made;
  };
  const target = {
    target: plan.target,
    entries: plan.entries,
    degradations: plan.degradations,
    dispatcher: plan.dispatcher,
    get tools() { return plan.tools; },
    get sent() { return plan.sent; },
    get output() { return plan.output ? entryOf(plan.output.name, true) : undefined; },
    has: (name: string) => plan.has(name) || known?.(name) !== undefined,
    get: (name: string) => {
      if (plan.output && name === plan.output.name) return entryOf(name, true);
      if (!plan.has(name) && known?.(name) === undefined) throw new Error(`@aeye/schema: no schema named "${name}" in this request.`);
      return entryOf(name, false);
    },
    decodeCall: plan.decodeCall.bind(plan),
    encodeCall: plan.encodeCall.bind(plan),
    helpers: plan.helpers.bind(plan),
  };
  return target as unknown as RenderedRequest;
}
