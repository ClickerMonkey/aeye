/**
 * Showing values in instructions and prompts exactly as the model reads and
 * writes them.
 *
 * aeye's tools and prompts render their instructions/content with Handlebars
 * (`Handlebars.compile(template, { noEscape: true })` in `@aeye/core`'s
 * `Tool.compileInstructions` / `Prompt.compileContent`). A value written into
 * those templates as plain JSON is in the CODE shape — but a strict model
 * might write the same record as `[{key, value}]` pairs, an absent optional
 * as `null`, or a recursive part as JSON text. `{{encode value}}` writes it in
 * the shape of the schema the model actually has, for its profile, in this
 * request:
 *
 * ```hbs
 * Call it like this: {{encode example}}
 * The current limits are {{encode limits path="limits"}}.
 * The report you return looks like {{encode sample output=true pretty=true}}.
 * Search takes {{encode query tool="search"}}.
 * ```
 *
 * Two ways to supply the helpers, both work with `noEscape` on or off:
 *
 * - per render: `template(vars, { helpers: entry.helpers() })` (or
 *   `request.helpers('toolName')`);
 * - once: `registerSchemaHelpers(Handlebars)`, then per render
 *   `template(vars, { data: schemaData(entry) })`.
 *
 * Function-form instructions (core's `instructionsFn`) use the entry's
 * `encoder` instead: it needs only the value.
 */
import type { EncodeTextOptions, PathSeg, Rendered } from './render';
import type { RenderedRequest, RequestEntry } from './request';

/** What a template helper can encode through. */
export type SchemaTarget = Rendered<any> | RequestEntry<any> | RenderedRequest<any>;

/** The Handlebars helper options this module reads (structural; no Handlebars import). */
export interface HelperOptions {
  readonly hash?: { readonly [key: string]: unknown };
  readonly data?: { readonly [key: string]: unknown };
}

export type Helper = (...args: any[]) => unknown;

/** `encode` and `schema` helpers (a Handlebars `helpers` object). */
export interface HelperSet {
  readonly [name: string]: Helper;
  /** `{{encode value [pretty=true|2] [path="a.b"] [tool="name"] [output=true]}}` → JSON text in the model's shape. */
  readonly encode: Helper;
  /** `{{schema [tool="name"] [output=true]}}` → the schema as TypeScript-like text. */
  readonly schema: Helper;
}

/** The `data` key `registerSchemaHelpers` reads its target from. */
export const SCHEMA_DATA_KEY = 'aeyeSchema';

/** Text Handlebars never escapes (it duck-types `SafeString` by `toHTML`). */
class Safe {
  constructor(private readonly text: string) {}
  toHTML(): string { return this.text; }
  toString(): string { return this.text; }
}

function isRequest(t: SchemaTarget): t is RenderedRequest<any> {
  return 'entries' in t && 'problems' in t;
}

/** Pick the rendering a helper call means. */
function resolve(target: SchemaTarget, hash: HelperOptions['hash'], defaultName: string | undefined): Pick<Rendered<unknown>, 'encodeText' | 'typescript'> {
  if (!isRequest(target)) {
    if (hash?.tool !== undefined || hash?.output !== undefined) {
      throw new Error('@aeye/schema: tool=/output= need a whole request (request.helpers()).');
    }
    return 'rendered' in target ? target.rendered : target;
  }
  const name = typeof hash?.tool === 'string' ? hash.tool : hash?.output ? target.output?.name : defaultName ?? (target.entries.length === 1 ? target.entries[0]!.name : undefined);
  if (name === undefined) throw new Error('@aeye/schema: say which schema: {{encode value tool="name"}} or output=true.');
  if (!target.has(name)) throw new Error(`@aeye/schema: no schema named "${name}" in this request.`);
  return (target.get(name as never) as unknown as RequestEntry<unknown>).rendered;
}

function optionsOf(hash: HelperOptions['hash']): EncodeTextOptions {
  const out: { pretty?: boolean | number; path?: string | PathSeg[] } = {};
  if (hash?.pretty !== undefined) out.pretty = hash.pretty as boolean | number;
  if (typeof hash?.path === 'string') out.path = hash.path;
  return out;
}

function makeHelpers(get: (options: HelperOptions) => { target: SchemaTarget; defaultName: string | undefined }): HelperSet {
  return {
    encode(...args: unknown[]) {
      const options = args[args.length - 1] as HelperOptions;
      if (args.length < 2) throw new Error('@aeye/schema: {{encode value}} needs a value.');
      const { target, defaultName } = get(options);
      return new Safe(resolve(target, options.hash, defaultName).encodeText(args[0] as never, optionsOf(options.hash)));
    },
    schema(...args: unknown[]) {
      const options = args[args.length - 1] as HelperOptions;
      const { target, defaultName } = get(options);
      return new Safe(resolve(target, options.hash, defaultName).typescript());
    },
  };
}

/**
 * Helpers bound to one target: a rendering, a request entry, or a whole
 * request (then `defaultName` is the schema `{{encode value}}` means).
 * Pass as `template(vars, { helpers: schemaHelpers(entry) })`.
 */
export function schemaHelpers(target: SchemaTarget, defaultName?: string): HelperSet {
  const bound = { target, defaultName };
  return makeHelpers(() => bound);
}

/** The `data` for a render when the helpers are registered globally. */
export function schemaData(target: SchemaTarget, defaultName?: string): { readonly [SCHEMA_DATA_KEY]: { target: SchemaTarget; defaultName: string | undefined } } {
  return { [SCHEMA_DATA_KEY]: { target, defaultName } };
}

/**
 * Register `encode` and `schema` on a Handlebars instance; each render then
 * names its target with `{ data: schemaData(entry) }`.
 */
export function registerSchemaHelpers(handlebars: { registerHelper(name: string, fn: Helper): void }, names: { encode?: string; schema?: string } = {}): void {
  const helpers = makeHelpers((options) => {
    const d = options.data?.[SCHEMA_DATA_KEY] as { target: SchemaTarget; defaultName: string | undefined } | undefined;
    if (!d) throw new Error('@aeye/schema: no schema for this render; pass { data: schemaData(entry) } to the template.');
    return d;
  });
  handlebars.registerHelper(names.encode ?? 'encode', helpers.encode);
  handlebars.registerHelper(names.schema ?? 'schema', helpers.schema);
}
