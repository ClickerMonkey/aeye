// @ts-nocheck — frozen zod-path baseline (see ./index.ts); compiled as it was in its own package, not under this one's stricter test flags.
/**
 * Built-in gin natives → TypeScript.
 *
 * Each entry renders one native call as a TypeScript expression from the
 * already-compiled receiver and arguments. The compiler has put the
 * receiver and every argument in evaluation order before this runs (an
 * argument with effects is already a temp), so an entry may reorder or
 * drop pure arguments freely — but must read a value it uses more than
 * once through `once`/`argOnce`, which spill to a temp.
 *
 * A native with no one-expression equivalent calls a prelude helper
 * (`c.helper('$name')`), which mirrors the gin implementation in
 * `src/natives/*`. Ids absent from this table are HOST natives: the
 * exporter treats them as members the value carries (see `index.ts`).
 */
import type { Type } from '../type';
import { EnumType } from '../types/enum';

export interface NativeCtx {
  /** The receiver, as an expression (use once). */
  self(): string;
  /** The receiver, spilled to a temp when it is not a plain name — for multi-use. */
  once(): string;
  /** The compiled argument, or undefined when the call did not pass it. */
  arg(name: string): string | undefined;
  /** `arg`, spilled to a temp for multi-use. */
  argOnce(name: string): string | undefined;
  /** A callback argument (a fn value) and whether it is known to be synchronous. */
  fn(name: string): { code: string; sync: boolean } | undefined;
  /** Request a prelude helper; returns its name. */
  helper(name: string): string;
  /** Wrap an expression in `await` (marks the enclosing function async). */
  aw(code: string): string;
  /** The receiver is not used: evaluate it for its effects (if any) and drop it. */
  discard(): void;
  /** The receiver's static type. */
  selfType: Type;
  /** The receiver's declared field names (obj natives). */
  fields(): string[];
  /** For `is` / `as`: a structural guard function for the call's bound `T`. */
  guard(): string | undefined;
  /** The gin type name to answer `typeOf` with, when the receiver's type is concrete. */
  staticTypeName(): string | undefined;
}

export type NativeEmit = (c: NativeCtx) => string;

/** An optional argument with gin's default when it is left out or nullish. */
const orDefault = (code: string | undefined, def: string): string => {
  if (code === undefined || code === 'undefined' || code === 'null') return def;
  return /^(-?\d[\d.e+-]*|"(?:[^"\\]|\\.)*"|true|false)$/.test(code) ? code : `(${code} ?? ${def})`;
};
const req = (c: NativeCtx, name: string): string => c.arg(name) ?? 'undefined';
const bin = (op: string): NativeEmit => (c) => `(${c.self()} ${op} ${req(c, 'other')})`;
const call = (fn: string, ...args: string[]): NativeEmit => (c) =>
  `${fn}(${[c.self(), ...args.map((a) => req(c, a))].join(', ')})`;
const meth = (m: string, ...args: string[]): NativeEmit => (c) =>
  `${c.self()}.${m}(${args.map((a) => req(c, a)).join(', ')})`;
const prop = (p: string): NativeEmit => (c) => `${c.self()}.${p}`;
const voided = (inner: NativeEmit): NativeEmit => (c) => `void ${inner(c)}`;
const optArgs = (c: NativeCtx, ...names: string[]): string => {
  // Trailing optional args left out are omitted, so `slice(start)` stays `slice(start)`.
  const parts = names.map((n) => c.arg(n));
  while (parts.length > 0 && parts[parts.length - 1] === undefined) parts.pop();
  return parts.map((p) => p ?? 'undefined').join(', ');
};

/** A callback-taking list method: `$name(xs, fn)` or `await $nameAsync(xs, fn)`. */
const listFn = (name: string, ...extra: string[]): NativeEmit => (c) => {
  const fn = c.fn('fn');
  const rest = extra.map((a) => req(c, a));
  if (!fn) return `${c.helper('$' + name)}(${[c.self(), 'undefined as any', ...rest].join(', ')})`;
  if (fn.sync) return `${c.helper('$' + name)}(${[c.self(), fn.code, ...rest].join(', ')})`;
  return c.aw(`${c.helper('$' + name + 'Async')}(${[c.self(), fn.code, ...rest].join(', ')})`);
};

/** `optional.map` / `nullable.map`: the callback runs only when there is a value. */
const wrapperMap = (empty: 'undefined' | 'null'): NativeEmit => (c) => {
  const v = c.once();
  const fn = c.fn('fn');
  if (!fn) return v;
  const inv = `(${fn.code})({ value: ${v} })`;
  return `(${v} === ${empty} ? ${empty} : ${fn.sync ? inv : c.aw(inv)})`;
};

export const NATIVE_TS: Record<string, NativeEmit> = {
  // ─── universal / any ─────────────────────────────────────────────────────
  'type.toAny': (c) => c.self(),
  'any.typeOf': (c) => {
    const s = c.staticTypeName();
    if (s === undefined) return `${c.helper('$typeOf')}(${c.self()})`;
    c.discard();
    return JSON.stringify(s);
  },
  'any.is': (c) => {
    const g = c.guard();
    if (g) return `${g}(${c.self()})`;
    c.discard();
    return 'true';
  },
  'any.as': (c) => {
    const g = c.guard();
    if (!g) return c.self();
    const v = c.once();
    return `(${g}(${v}) ? ${v} : undefined)`;
  },
  'any.toText': (c) => `String(${c.self()})`,
  'any.toBool': (c) => `Boolean(${c.self()})`,
  'any.eq': bin('==='),
  'any.neq': bin('!=='),
  'void.toText': (c) => { c.discard(); return '"void"'; },
  'void.toBool': (c) => { c.discard(); return 'false'; },
  'null.toText': (c) => { c.discard(); return '"null"'; },
  'null.toBool': (c) => { c.discard(); return 'false'; },
  'not.typeOf': (c) => `${c.helper('$typeOf')}(${c.self()})`,
  'not.toText': (c) => `String(${c.self()})`,

  // ─── bool ────────────────────────────────────────────────────────────────
  'bool.eq': bin('==='),
  'bool.neq': bin('!=='),
  // gin evaluates both operands; the compiler spilled an impure `other`
  // already, so short-circuiting here cannot skip an effect.
  'bool.and': bin('&&'),
  'bool.or': bin('||'),
  'bool.xor': bin('!=='),
  'bool.not': (c) => `!${c.self()}`,
  'bool.toText': (c) => {
    const t = c.arg('trueText'), f = c.arg('falseText');
    if (t === undefined && f === undefined) return `String(${c.self()})`;
    return `(${c.self()} ? ${orDefault(t, '"true"')} : ${orDefault(f, '"false"')})`;
  },
  'bool.toNum': (c) => {
    const t = c.arg('trueValue'), f = c.arg('falseValue');
    return `(${c.self()} ? ${orDefault(t, '1')} : ${orDefault(f, '0')})`;
  },

  // ─── num ─────────────────────────────────────────────────────────────────
  'num.eq': (c) => c.arg('epsilon') !== undefined
    ? `${c.helper('$numEq')}(${c.self()}, ${req(c, 'other')}, ${c.arg('epsilon')})`
    : `${c.helper('$numEq')}(${c.self()}, ${req(c, 'other')})`,
  'num.neq': (c) => c.arg('epsilon') !== undefined
    ? `!${c.helper('$numEq')}(${c.self()}, ${req(c, 'other')}, ${c.arg('epsilon')})`
    : `!${c.helper('$numEq')}(${c.self()}, ${req(c, 'other')})`,
  'num.lt': bin('<'),
  'num.lte': bin('<='),
  'num.gt': bin('>'),
  'num.gte': bin('>='),
  'num.add': bin('+'),
  'num.sub': bin('-'),
  'num.mul': bin('*'),
  'num.div': bin('/'),
  'num.mod': bin('%'),
  'num.pow': bin('**'),
  'num.abs': call('Math.abs'),
  'num.neg': (c) => `(-${c.self()})`,
  'num.sign': call('Math.sign'),
  'num.sqrt': call('Math.sqrt'),
  'num.min': call('Math.min', 'other'),
  'num.max': call('Math.max', 'other'),
  'num.clamp': (c) => `Math.min(Math.max(${c.self()}, ${req(c, 'min')}), ${req(c, 'max')})`,
  'num.floor': call('Math.floor'),
  'num.ceil': call('Math.ceil'),
  'num.round': call('Math.round'),
  'num.isZero': (c) => `(Math.abs(${c.self()}) <= 0)`,
  'num.isPositive': (c) => `(${c.self()} > 0)`,
  'num.isNegative': (c) => `(${c.self()} < 0)`,
  'num.isInteger': call('Number.isInteger'),
  'num.isEven': (c) => `(${c.self()} % 2 === 0)`,
  'num.isOdd': (c) => `(Math.abs(${c.self()}) % 2 === 1)`,
  'num.toText': (c) => c.arg('precision') !== undefined
    ? `${c.helper('$numText')}(${c.self()}, ${c.arg('precision')})`
    : `String(${c.self()})`,
  'num.toBool': (c) => `(${c.self()} !== 0)`,

  // ─── text ────────────────────────────────────────────────────────────────
  'text.length': prop('length'),
  'text.eq': bin('==='),
  'text.neq': bin('!=='),
  'text.contains': meth('includes', 'search'),
  'text.startsWith': meth('startsWith', 'prefix'),
  'text.endsWith': meth('endsWith', 'suffix'),
  'text.trim': meth('trim'),
  'text.trimStart': meth('trimStart'),
  'text.trimEnd': meth('trimEnd'),
  'text.upper': meth('toUpperCase'),
  'text.lower': meth('toLowerCase'),
  'text.slice': (c) => `${c.self()}.slice(${optArgs(c, 'start', 'end')})`,
  'text.replace': (c) => `${c.self()}.split(${req(c, 'search')}).join(${req(c, 'replacement')})`,
  'text.split': meth('split', 'separator'),
  'text.concat': bin('+'),
  'text.repeat': meth('repeat', 'count'),
  'text.indexOf': (c) => `${c.self()}.indexOf(${optArgs(c, 'search', 'from')})`,
  'text.lastIndexOf': (c) => `${c.self()}.lastIndexOf(${optArgs(c, 'search', 'from')})`,
  'text.match': (c) => `(${c.self()}.match(new RegExp(${req(c, 'pattern')}, "g")) ?? [] as string[])`,
  'text.test': (c) => `new RegExp(${req(c, 'pattern')}).test(${c.self()})`,
  'text.isEmpty': (c) => `(${c.self()}.length === 0)`,
  'text.isNotEmpty': (c) => `(${c.self()}.length > 0)`,
  'text.toNum': call('Number'),
  'text.toBool': (c) => `(${c.self()}.length > 0)`,

  // ─── list ────────────────────────────────────────────────────────────────
  'list.length': prop('length'),
  'list.at': (c) => `${c.helper('$listAt')}(${c.self()}, ${req(c, 'index')})`,
  'list.push': voided(meth('push', 'value')),
  'list.pop': meth('pop'),
  'list.shift': meth('shift'),
  'list.unshift': voided(meth('unshift', 'value')),
  'list.insert': (c) => `void ${c.self()}.splice(${req(c, 'index')}, 0, ${req(c, 'value')})`,
  'list.remove': (c) => `${c.self()}.splice(${req(c, 'index')}, 1)[0]!`,
  'list.clear': (c) => `void (${c.self()}.length = 0)`,
  'list.slice': (c) => `${c.self()}.slice(${optArgs(c, 'start', 'end')})`,
  'list.concat': meth('concat', 'other'),
  'list.reverse': (c) => `[...${c.self()}].reverse()`,
  'list.join': (c) => `${c.self()}.map(String).join(${orDefault(c.arg('separator'), '","')})`,
  'list.indexOf': meth('indexOf', 'value'),
  'list.contains': (c) => `(${c.self()}.indexOf(${req(c, 'value')}) !== -1)`,
  'list.unique': (c) => `[...new Set(${c.self()})]`,
  'list.duplicates': (c) => `${c.helper('$duplicates')}(${c.self()})`,
  'list.map': listFn('map'),
  'list.filter': listFn('filter'),
  'list.find': listFn('find'),
  'list.reduce': listFn('reduce', 'initial'),
  'list.some': listFn('some'),
  'list.every': listFn('every'),
  'list.sort': (c) => {
    if (c.arg('fn') === undefined) return `${c.helper('$sortNatural')}(${c.self()})`;
    return listFn('sort')(c);
  },
  'list.isEmpty': (c) => `(${c.self()}.length === 0)`,
  'list.isNotEmpty': (c) => `(${c.self()}.length > 0)`,
  'list.first': (c) => `${c.self()}[0]`,
  'list.last': (c) => `${c.self()}.at(-1)`,

  // ─── map ─────────────────────────────────────────────────────────────────
  'map.size': prop('size'),
  'map.at': meth('get', 'key'),
  'map.has': meth('has', 'key'),
  'map.delete': meth('delete', 'key'),
  'map.clear': voided(meth('clear')),
  'map.keys': (c) => `[...${c.self()}.keys()]`,
  'map.values': (c) => `[...${c.self()}.values()]`,
  'map.isEmpty': (c) => `(${c.self()}.size === 0)`,
  'map.isNotEmpty': (c) => `(${c.self()}.size > 0)`,

  // ─── obj ─────────────────────────────────────────────────────────────────
  // gin reads an obj's DECLARED fields, not the keys a run-time object has,
  // so the field list is baked in from the static type.
  'object.keys': (c) => { c.discard(); return JSON.stringify(c.fields()); },
  'object.values': (c) => {
    const o = c.once();
    return `[${c.fields().map((f) => access(o, f)).join(', ')}]`;
  },
  'object.entries': (c) => {
    const o = c.once();
    return `[${c.fields().map((f) => `[${JSON.stringify(f)}, ${access(o, f)}] as [string, unknown]`).join(', ')}]`;
  },
  'object.has': (c) => { c.discard(); return `(${JSON.stringify(c.fields())} as string[]).includes(${req(c, 'key')})`; },
  'object.eq': (c) => `${c.helper('$deepEq')}(${c.self()}, ${req(c, 'other')})`,
  'object.neq': (c) => `!${c.helper('$deepEq')}(${c.self()}, ${req(c, 'other')})`,
  'object.toText': (c) => `${c.helper('$objText')}(${c.self()} as any, ${JSON.stringify(c.fields())})`,

  // ─── tuple ───────────────────────────────────────────────────────────────
  'tuple.length': prop('length'),
  'tuple.first': (c) => `${c.self()}[0]`,
  'tuple.last': (c) => {
    const t = c.once();
    return `${t}[${t}.length - 1]`;
  },
  'tuple.toList': (c) => `[...${c.self()}]`,

  // ─── optional / nullable ─────────────────────────────────────────────────
  'optional.value': (c) => `${c.helper('$optValue')}(${c.self()})`,
  'optional.has': (c) => `(${c.self()} !== undefined)`,
  'optional.or': (c) => {
    const v = c.once();
    return `(${v} !== undefined ? ${v} : ${req(c, 'fallback')})`;
  },
  'optional.map': wrapperMap('undefined'),
  'nullable.value': (c) => `${c.helper('$nullValue')}(${c.self()})`,
  'nullable.isNull': (c) => `(${c.self()} === null)`,
  'nullable.or': (c) => {
    const v = c.once();
    return `(${v} !== null ? ${v} : ${req(c, 'fallback')})`;
  },
  'nullable.map': wrapperMap('null'),

  // ─── enum ────────────────────────────────────────────────────────────────
  'enum.name': (c) => {
    const t = enumOf(c.selfType);
    const byValue: Record<string, string> = {};
    for (const [label, v] of Object.entries(t?.options.values ?? {})) byValue[String(v)] = label;
    return `((${JSON.stringify(byValue)} as Record<string, string>)[String(${c.self()})] ?? "")`;
  },
  'enum.value': (c) => c.self(),
  'enum.eq': bin('==='),
  'enum.neq': bin('!=='),
  'enum.toText': (c) => `String(${c.self()})`,

  // ─── date ────────────────────────────────────────────────────────────────
  'date.year': meth('getUTCFullYear'),
  'date.month': (c) => `(${c.self()}.getUTCMonth() + 1)`,
  'date.day': meth('getUTCDate'),
  'date.dayOfWeek': meth('getUTCDay'),
  'date.dayOfYear': (c) => `${c.helper('$date')}.dayOfYear(${c.self()})`,
  'date.eq': (c) => `(${c.self()}.getTime() === ${req(c, 'other')}.getTime())`,
  'date.neq': (c) => `(${c.self()}.getTime() !== ${req(c, 'other')}.getTime())`,
  'date.before': (c) => `(${c.self()}.getTime() < ${req(c, 'other')}.getTime())`,
  'date.after': (c) => `(${c.self()}.getTime() > ${req(c, 'other')}.getTime())`,
  'date.addDays': (c) => `${c.helper('$date')}.addDays(${c.self()}, ${req(c, 'days')})`,
  'date.addMonths': (c) => `${c.helper('$date')}.addMonths(${c.self()}, ${req(c, 'months')})`,
  'date.addYears': (c) => `${c.helper('$date')}.addYears(${c.self()}, ${req(c, 'years')})`,
  'date.diffDays': (c) => `${c.helper('$date')}.diffDays(${c.self()}, ${req(c, 'other')})`,
  'date.diffMonths': (c) => `${c.helper('$date')}.diffMonths(${c.self()}, ${req(c, 'other')})`,
  'date.diffYears': (c) => `(${c.self()}.getUTCFullYear() - ${req(c, 'other')}.getUTCFullYear())`,
  'date.toText': (c) => `${c.self()}.toISOString().slice(0, 10)`,

  // ─── timestamp ───────────────────────────────────────────────────────────
  'timestamp.year': meth('getUTCFullYear'),
  'timestamp.month': (c) => `(${c.self()}.getUTCMonth() + 1)`,
  'timestamp.day': meth('getUTCDate'),
  'timestamp.hour': meth('getUTCHours'),
  'timestamp.minute': meth('getUTCMinutes'),
  'timestamp.second': meth('getUTCSeconds'),
  'timestamp.millisecond': meth('getUTCMilliseconds'),
  'timestamp.eq': (c) => `(${c.self()}.getTime() === ${req(c, 'other')}.getTime())`,
  'timestamp.before': (c) => `(${c.self()}.getTime() < ${req(c, 'other')}.getTime())`,
  'timestamp.after': (c) => `(${c.self()}.getTime() > ${req(c, 'other')}.getTime())`,
  'timestamp.addDuration': (c) => `new Date(${c.self()}.getTime() + ${req(c, 'duration')})`,
  'timestamp.subDuration': (c) => `new Date(${c.self()}.getTime() - ${req(c, 'duration')})`,
  'timestamp.diff': (c) => `(${c.self()}.getTime() - ${req(c, 'other')}.getTime())`,
  'timestamp.toDate': (c) => `${c.helper('$date')}.toDate(${c.self()})`,
  'timestamp.toEpoch': meth('getTime'),
  'timestamp.toText': meth('toISOString'),

  // ─── duration (ms) ───────────────────────────────────────────────────────
  'duration.init': (c) => `${c.helper('$duration')}.init(${c.self()})`,
  'duration.totalSeconds': (c) => `(${c.self()} / 1000)`,
  'duration.totalMinutes': (c) => `(${c.self()} / 60000)`,
  'duration.totalHours': (c) => `(${c.self()} / 3600000)`,
  'duration.totalDays': (c) => `(${c.self()} / 86400000)`,
  'duration.days': (c) => `Math.trunc(${c.self()} / 86400000)`,
  'duration.hours': (c) => `(Math.trunc(${c.self()} / 3600000) % 24)`,
  'duration.minutes': (c) => `(Math.trunc(${c.self()} / 60000) % 60)`,
  'duration.seconds': (c) => `(Math.trunc(${c.self()} / 1000) % 60)`,
  'duration.ms': (c) => `(${c.self()} % 1000)`,
  'duration.toText': (c) => `${c.helper('$duration')}.toText(${c.self()})`,

  // ─── color ───────────────────────────────────────────────────────────────
  'color.init': (c) => `${c.helper('$color')}.init(${c.self()})`,
  'color.hue': (c) => `${c.helper('$color')}.hsl(${c.self()}).h`,
  'color.saturation': (c) => `${c.helper('$color')}.hsl(${c.self()}).s`,
  'color.lightness': (c) => `${c.helper('$color')}.hsl(${c.self()}).l`,
  'color.eq': bin('==='),
  'color.neq': bin('!=='),
  'color.lighten': (c) => `${c.helper('$color')}.lighten(${c.self()}, ${req(c, 'amount')})`,
  'color.darken': (c) => `${c.helper('$color')}.lighten(${c.self()}, -${req(c, 'amount')})`,
  'color.saturate': (c) => `${c.helper('$color')}.saturate(${c.self()}, ${req(c, 'amount')})`,
  'color.desaturate': (c) => `${c.helper('$color')}.saturate(${c.self()}, -${req(c, 'amount')})`,
  'color.opacity': (c) => `${c.helper('$color')}.opacity(${c.self()}, ${req(c, 'alpha')})`,
  'color.invert': (c) => `${c.helper('$color')}.invert(${c.self()})`,
  'color.mix': (c) => `${c.helper('$color')}.mix(${c.self()}, ${optArgs(c, 'other', 'weight')})`,
  'color.complement': (c) => `${c.helper('$color')}.complement(${c.self()})`,
  'color.toHex': (c) => `${c.helper('$color')}.toHex(${c.self()})`,
  'color.toRgb': (c) => `${c.helper('$color')}.toRgb(${c.self()})`,
  'color.toHsl': (c) => `${c.helper('$color')}.toHsl(${c.self()})`,
  'color.toText': (c) => `${c.helper('$color')}.toHex(${c.self()})`,
};

// Channel reads — `$color.r(c)` and friends.
for (const id of ['color.r', 'color.g', 'color.b', 'color.a']) {
  const ch = id.slice(-1);
  NATIVE_TS[id] = (c) => `${c.helper('$color')}.${ch}(${c.self()})`;
}

/**
 * Index / loop natives — the `get` surface of a built-in type. Keyed by
 * the native id of `GetSet.get` / `GetSet.set`; `key` / `value` are the
 * compiled index and (for set) the assigned value.
 */
export const INDEX_GET_TS: Record<string, (c: { self: string; key: string; helper(n: string): string }) => string> = {
  'list.indexGet': (c) => `${c.helper('$listGet')}(${c.self}, ${c.key})`,
  'text.charAt': (c) => `${c.helper('$charAt')}(${c.self}, ${c.key})`,
  'map.indexGet': (c) => `${c.helper('$mapGet')}(${c.self}, ${c.key})`,
  'object.indexGet': (c) => `(${c.self} as any)[${c.key}]`,
  'tuple.at': (c) => `${c.self}[${c.key}]`,
};

export const INDEX_SET_TS: Record<string, (c: { self: string; key: string; value: string; helper(n: string): string }) => string> = {
  'list.indexSet': (c) => `${c.helper('$listSet')}(${c.self}, ${c.key}, ${c.value})`,
  'map.indexSet': (c) => `${c.self}.set(${c.key}, ${c.value})`,
  'object.indexSet': (c) => `(${c.self} as any)[${c.key}] = ${c.value}`,
  'tuple.setAt': (c) => `${c.self}[${c.key}] = ${c.value}`,
};

/** A property read, quoting a key that is not a plain identifier. */
export function access(target: string, name: string): string {
  return isIdent(name) ? `${target}.${name}` : `${target}[${JSON.stringify(name)}]`;
}

export function isIdent(name: string): boolean {
  return /^[A-Za-z_$][\w$]*$/.test(name);
}

function enumOf(t: Type): EnumType | undefined {
  let cur: Type | undefined = t;
  for (let i = 0; i < 10 && cur; i++) {
    if (cur instanceof EnumType) return cur;
    cur = (cur as { base?: Type }).base;
  }
  return undefined;
}
