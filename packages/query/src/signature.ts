/**
 * A saved query as a callable function: its args as a gin `obj` type (the
 * query's params, then paging and sorting), a one-line signature, and the check
 * a call's args go through before the query runs. One home for what every
 * caller of a stored query needs, so the args a model is shown, the args a call
 * is checked against and the params the query binds can't drift apart.
 *
 * Every param is REQUIRED: a missing param is refused as invalid input, never
 * bound as NULL (`engine.checkParams` only warns about it, because
 * `autoPaginate` binds NULL on purpose; a call through a signature does not).
 */
import { argProblems, createRegistry as createGinRegistry, type Registry as GinRegistry, type TypeDef as GinTypeDef } from '@aeye/gin';
import type { ParamInfo } from './param';
import type { FieldTypeDef, JsonValue } from './schema';

/** A gin type as a plain def (the `@aeye/gin` `TypeDef`). */
type GinDef = GinTypeDef;

/** Paging for a query that reads a list: the most rows one call reads, and the page when the caller gives none. */
export interface QueryPaging {
  readonly max: number;
  readonly page: number;
}

/** What `queryArgsType` adds after the params. */
export interface QueryArgsOptions {
  /** Add optional `limit` / `offset` args (a list query that does not bound its own rows). */
  readonly paging?: QueryPaging;
  /** The sort names a caller may pick; adds an optional `sort` list of `{ column, dir }`. */
  readonly sorters?: readonly string[];
  /** Params that are optional after all (a paging window bound as a param). */
  readonly optional?: readonly string[];
  /** Constant defaults: the param becomes optional, and `withArgDefaults` fills it before binding. */
  readonly defaults?: Readonly<Record<string, JsonValue>>;
}

/** A param's gin type: its merged field type as a value a caller passes (`any` when nothing closer fits). */
export function fieldTypeToGin(def: FieldTypeDef | undefined): GinDef {
  switch (def?.kind) {
    case undefined:
      return { name: 'any' };
    case 'number':
    case 'money': {
      const options = def.kind === 'number' ? def : (def.number ?? {});
      if (options.values !== undefined) return enumOf(options.values.map((v) => v.value), { name: 'num' });
      const bounds = {
        ...(options.min === undefined ? {} : { min: options.min }),
        ...(options.max === undefined ? {} : { max: options.max }),
        ...(options.whole === true ? { whole: true } : {}),
      };
      return Object.keys(bounds).length === 0 ? { name: 'num' } : { name: 'num', options: bounds };
    }
    case 'text': {
      if (def.values !== undefined) return enumOf(def.values.map((v) => v.value), { name: 'text' });
      const bounds = {
        ...(def.minLength === undefined ? {} : { minLength: def.minLength }),
        ...(def.maxLength === undefined ? {} : { maxLength: def.maxLength }),
        ...(def.pattern === undefined ? {} : { pattern: def.pattern }),
      };
      return Object.keys(bounds).length === 0 ? { name: 'text' } : { name: 'text', options: bounds };
    }
    case 'bool':
      return { name: 'bool' };
    case 'date':
      return { name: 'date' };
    case 'timestamp':
      return { name: 'timestamp' };
    case 'array':
      return { name: 'list', generic: { V: fieldTypeToGin(def.item) } };
    case 'json':
    case 'relation':
      return { name: 'any' };
  }
}

/** A gin enum of values over a scalar. */
function enumOf(values: readonly (string | number)[], scalar: GinDef): GinDef {
  const members: Record<string, string | number> = {};
  for (const value of values) members[String(value)] = value;
  return { name: 'enum', generic: { V: scalar }, options: { values: members } };
}

const optional = (type: GinDef): GinDef => ({ name: 'optional', generic: { T: type } });

/**
 * The args of a query's fn, as a gin `obj`: each param (required unless named
 * in `optional`; documented with the column it is compared with), then
 * `limit` / `offset`, then `sort`.
 */
export function queryArgsType(params: readonly ParamInfo[], options: QueryArgsOptions = {}): GinDef {
  const props: NonNullable<GinDef['props']> = {};
  const loose = new Set(options.optional ?? []);
  for (const param of params) {
    const type = fieldTypeToGin(param.type?.toJSON());
    const column = param.uses.find((use) => use.field !== undefined)?.field;
    const fallback = options.defaults?.[param.name];
    const docs = [column === undefined ? undefined : `Compared with ${column.type}.${column.field}.`, fallback === undefined ? undefined : `Default ${JSON.stringify(fallback)}.`].filter((d) => d !== undefined);
    props[param.name] = {
      type: loose.has(param.name) || fallback !== undefined ? optional(type) : type,
      ...(docs.length === 0 ? {} : { docs: docs.join(' ') }),
      ...(fallback === undefined ? {} : { default: { kind: 'new', type, value: fallback } }),
    };
  }
  if (options.paging) {
    props['limit'] ??= { type: optional({ name: 'num', options: { whole: true, min: 1, max: options.paging.max } }), docs: `How many rows (${options.paging.page} when empty).` };
    props['offset'] ??= { type: optional({ name: 'num', options: { whole: true, min: 0 } }), docs: 'How many rows to skip, for the next page.' };
  }
  const sorters = options.sorters ?? [];
  if (sorters.length > 0 && props['sort'] === undefined) {
    const entry: GinDef = { name: 'obj', props: { column: { type: enumOf(sorters, { name: 'text' }) }, dir: { type: enumOf(['asc', 'desc'], { name: 'text' }) } } };
    props['sort'] = { type: optional({ name: 'list', generic: { V: entry } }), docs: "Sort by these columns, in order (the query's own order when empty)." };
  }
  return { name: 'obj', props };
}

/** Call args with every left-out arg that has a constant default (`queryArgsType`'s `defaults`) filled in. */
export function withArgDefaults(type: GinDef, args: Readonly<Record<string, JsonValue>>): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = { ...args };
  for (const [name, prop] of Object.entries(type.props ?? {})) {
    const fallback = prop.default;
    if (out[name] !== undefined || fallback === undefined || fallback.kind !== 'new' || !('value' in fallback)) continue;
    out[name] = toJson(fallback.value);
  }
  return out;
}

function toJson(value: unknown): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map(toJson);
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toJson(v)]));
  return null;
}

const ARGS_REGISTRY: GinRegistry = createGinRegistry();

/**
 * What is wrong with a call's args for a query's fn (`queryArgsType`), one line
 * per problem; empty when they fit. A missing required param is refused.
 */
export function queryArgProblems(type: GinDef, args: unknown): string[] {
  return argProblems(ARGS_REGISTRY, type, args);
}

/** A gin def as a short type word (`text`, `num`, `"open" | "paid"`, `list<…>`). */
function typeWord(def: GinDef): string {
  switch (def.name) {
    case 'optional':
    case 'nullable':
      return typeWord(def.generic?.['T'] ?? { name: 'any' });
    case 'enum':
      return Object.values(def.options?.['values'] ?? {}).map((v) => JSON.stringify(v)).join(' | ');
    case 'list':
      return `list<${typeWord(def.generic?.['V'] ?? { name: 'any' })}>`;
    case 'obj':
      return `{ ${Object.entries(def.props ?? {}).map(([name, prop]) => `${name}: ${typeWord(prop.type)}`).join(', ')} }`;
    default:
      return def.name;
  }
}

/** A fn's one-line signature: `database/main.overdue(customer: text, limit?: num, offset?: num)`. */
export function signatureText(fn: string, args: GinDef): string {
  const parts = Object.entries(args.props ?? {}).map(([name, prop]) => {
    const loose = prop.type.name === 'optional' || prop.type.name === 'nullable';
    return `${name}${loose ? '?' : ''}: ${typeWord(prop.type)}`;
  });
  return `${fn}(${parts.join(', ')})`;
}
