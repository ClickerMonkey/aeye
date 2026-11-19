/**
 * TypeScript names for gin types — collision-free and deterministic.
 *
 * Several things want a TypeScript type name: every named gin type (`Person`,
 * `fs/Entry`), the fields-only half of a type with members (`PersonData`), and
 * each export's `ctx` type (`ScoreCtx`). They can collide with each other and
 * with TypeScript's own globals (`Map`, `Date`, `Record`, …).
 *
 * Names are handed out for the WHOLE registry at once, in sorted order, so
 * every export of one registry agrees on them — two outputs never call one gin
 * type by two names, or two gin types by one, and `joinTypeScript` can merge
 * them. The rules:
 *
 *  1. A gin name that is already a usable identifier keeps it.
 *  2. Any other name (namespaced `fs/Entry`, a TypeScript global such as `Map`)
 *     is made an identifier (`fs_Entry`, `Map_`) and numbered on a clash
 *     (`fs_Entry_2`), after every rule-1 name is placed.
 *  3. Derived names (`PersonData`, `ScoreCtx`) come last: a real gin type named
 *     `PersonData` keeps that name and the derived one is numbered.
 */
import type { Registry } from '../registry';
import { Extension } from '../extension';
import { PRELUDE } from './prelude';

/** Names TypeScript (or its standard library) already gives a meaning. */
export const TS_TYPE_GLOBALS: ReadonlySet<string> = new Set([
  // keywords and primitive types
  'any', 'unknown', 'never', 'object', 'string', 'number', 'boolean', 'symbol', 'bigint',
  'undefined', 'null', 'void', 'true', 'false', 'this', 'keyof', 'typeof', 'infer', 'is',
  'asserts', 'readonly', 'unique', 'type', 'interface', 'enum', 'class', 'function', 'let',
  'const', 'var', 'new', 'in', 'of', 'as', 'extends', 'implements', 'namespace', 'module',
  'declare', 'abstract', 'async', 'await', 'yield', 'import', 'export', 'default', 'return',
  'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break', 'continue', 'try', 'catch',
  'finally', 'throw', 'delete', 'instanceof', 'super', 'with', 'debugger', 'package',
  'private', 'protected', 'public', 'static', 'global', 'require',
  // standard library (ES2022)
  'Array', 'ArrayBuffer', 'ArrayLike', 'AsyncGenerator', 'AsyncIterable', 'AsyncIterator',
  'Atomics', 'Awaited', 'BigInt', 'BigInt64Array', 'BigUint64Array', 'Boolean', 'Capitalize',
  'ConstructorParameters', 'DataView', 'Date', 'Error', 'EvalError', 'Exclude', 'Extract',
  'Float32Array', 'Float64Array', 'Function', 'Generator', 'Infinity', 'InstanceType',
  'Int16Array', 'Int32Array', 'Int8Array', 'Intl', 'Iterable', 'IterableIterator', 'Iterator',
  'JSON', 'Lowercase', 'Map', 'Math', 'NaN', 'NonNullable', 'Number', 'Object', 'Omit',
  'OmitThisParameter', 'Parameters', 'Partial', 'Pick', 'Promise', 'PromiseLike',
  'PropertyKey', 'Proxy', 'RangeError', 'Readonly', 'ReadonlyArray', 'ReadonlyMap',
  'ReadonlySet', 'Record', 'ReferenceError', 'Reflect', 'RegExp', 'Required', 'ReturnType',
  'Set', 'SharedArrayBuffer', 'String', 'Symbol', 'SyntaxError', 'TemplateStringsArray',
  'ThisParameterType', 'ThisType', 'TypeError', 'URIError', 'Uint16Array', 'Uint32Array',
  'Uint8Array', 'Uint8ClampedArray', 'Uncapitalize', 'Uppercase', 'WeakMap', 'WeakRef',
  'WeakSet', 'globalThis', 'console', 'eval', 'arguments',
]);

/** A name is ours to use: an identifier, not a TypeScript global, not a prelude helper. */
export function isFreeName(n: string): boolean {
  return /^[A-Za-z_][\w$]*$/.test(n) && !TS_TYPE_GLOBALS.has(n) && !(n in PRELUDE);
}

/** `fs/Entry` → `fs_Entry`; a TypeScript global gets a trailing `_` (`Map` → `Map_`). */
function identifierFor(name: string): string {
  let n = name.replace(/[^\w]/g, '_');
  if (!/^[A-Za-z_]/.test(n)) n = '_' + n;
  return isFreeName(n) ? n : `${n}_`;
}

export class TypeNames {
  private readonly taken = new Set<string>();
  private readonly types = new Map<string, string>();
  private readonly data = new Map<string, string>();

  /**
   * @param splits  Whether a registered type splits into `XData` + `X` — decided
   *                from the registry alone, so the data names are as stable as
   *                the type names.
   */
  constructor(registry: Registry, splits: (t: Extension) => boolean) {
    const named = registry.namedTypeList()
      .filter((t): t is Extension => t instanceof Extension && !t.local.useSite)
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    // 1. names that are usable as they are
    for (const t of named) {
      if (isFreeName(t.name) && !this.taken.has(t.name)) this.claim(this.types, t.name, t.name);
    }
    // 2. everything else, made an identifier
    for (const t of named) if (!this.types.has(t.name)) this.type(t.name);
    // 3. derived data names
    for (const t of named) {
      let split = false;
      try { split = splits(t); } catch { split = false; }
      if (split) this.dataName(t.name);
    }
  }

  private claim(map: Map<string, string>, key: string, base: string): string {
    let n = base;
    for (let i = 2; this.taken.has(n); i++) n = `${base.replace(/_$/, '')}_${i}`;
    this.taken.add(n);
    map.set(key, n);
    return n;
  }

  /** The TypeScript name of the gin type `name` (one not in the registry is named on first use). */
  type(name: string): string {
    return this.types.get(name) ?? this.claim(this.types, name, identifierFor(name));
  }

  /** The name of `name`'s fields-only type: `PersonData`, numbered if a real type has it. */
  dataName(name: string): string {
    return this.data.get(name) ?? this.claim(this.data, name, `${this.type(name)}Data`);
  }

  /** A name for a one-off type (an export's `ctx`), clear of every type name. */
  fresh(base: string): string {
    return this.claim(new Map(), base, identifierFor(base));
  }
}
