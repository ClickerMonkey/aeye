// @ts-nocheck — frozen zod-path baseline (see ./index.ts); compiled as it was in its own package, not under this one's stricter test flags.
/**
 * The prelude — small runtime helpers a TypeScript export calls where a gin
 * native has no one-expression TypeScript equivalent (or where the obvious
 * one would differ from gin: list indexing throws out of range, `num.eq`
 * takes an epsilon, a callback-taking list method runs its callbacks one
 * at a time, …).
 *
 * Each helper is self-contained TypeScript with no import, so a rendered
 * file runs without `@aeye/gin`. A helper names the helpers it calls in
 * `deps`; the exporter emits a helper once, with its dependencies, and
 * only when the exported code reaches it.
 *
 * Every helper here mirrors the gin native it stands for — see
 * `src/natives/*`. When a native changes, its helper changes with it; the
 * parity tests in `__tests__/typescript-export.test.ts` run both.
 */

export interface PreludeHelper {
  /** The helper's TypeScript source — one or more declarations. */
  code: string;
  /** Other helpers this one calls. */
  deps?: string[];
}

export const PRELUDE: Record<string, PreludeHelper> = {
  // ─── flow control ────────────────────────────────────────────────────────

  $Exit: {
    code: `/** gin \`flow: exit\` — unwinds to the outermost exported function, whose result becomes \`value\`. */
class $Exit {
  constructor(readonly value: unknown) {}
}`,
  },
  $Throw: {
    code: `/** gin \`flow: throw\` — a thrown gin value; a call step's \`catch\` handler receives \`error\`. */
class $Throw extends Error {
  constructor(readonly error: unknown) { super(typeof error === 'string' ? error : 'gin throw'); }
}`,
  },

  // ─── general ─────────────────────────────────────────────────────────────

  $str: {
    code: `/** Template placeholder text — \`null\`/\`undefined\` read as the empty string. */
function $str(v: unknown): string {
  return v === undefined || v === null ? '' : String(v);
}`,
  },
  $template: {
    code: `/** A template whose text is only known at run time: \`{name}\` reads \`params.name\`. */
function $template(tmpl: string, params: Record<string, unknown> | undefined): string {
  return tmpl.replace(/\\{(\\w+)\\}/g, (_, name: string) =>
    params && Object.prototype.hasOwnProperty.call(params, name) ? $str(params[name]) : '');
}`,
    deps: ['$str'],
  },
  $typeOf: {
    code: `/** The gin type name of a run-time value (\`any.typeOf\`). */
function $typeOf(v: unknown): string {
  if (v === undefined) return 'void';
  if (v === null) return 'null';
  if (typeof v === 'number') return 'num';
  if (typeof v === 'string') return 'text';
  if (typeof v === 'boolean') return 'bool';
  if (typeof v === 'function') return 'fn';
  if (v instanceof Date) return 'timestamp';
  if (v instanceof Map) return 'map';
  if (Array.isArray(v)) return 'list';
  return 'obj';
}`,
  },
  $deepEq: {
    code: `/** Structural equality (\`obj.eq\`). */
function $deepEq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!$deepEq(a[i], b[i])) return false;
    return true;
  }
  const ak = Object.keys(a as object);
  const bk = Object.keys(b as object);
  if (ak.length !== bk.length) return false;
  for (const k of ak) if (!$deepEq((a as any)[k], (b as any)[k])) return false;
  return true;
}`,
  },
  $objText: {
    code: `/** \`obj.toText\` — the declared fields as JSON. */
function $objText(o: Record<string, unknown>, fields: readonly string[]): string {
  const out: Record<string, unknown> = {};
  for (const f of fields) out[f] = o[f];
  return JSON.stringify(out);
}`,
  },

  // ─── num ─────────────────────────────────────────────────────────────────

  $numEq: {
    code: `/** \`num.eq\` — equal within \`epsilon\` (default 0). */
function $numEq(a: number, b: number, epsilon?: number): boolean {
  return Math.abs(a - b) <= (typeof epsilon === 'number' ? epsilon : 0);
}`,
  },
  $numText: {
    code: `/** \`num.toText\` — fixed to \`precision\` digits when given. */
function $numText(n: number, precision?: number): string {
  return precision != null ? n.toFixed(precision) : String(n);
}`,
  },

  // ─── optional / nullable ─────────────────────────────────────────────────

  $optValue: {
    code: `/** \`optional.value\` — the value, or a throw when there is none. */
function $optValue<T>(v: T | undefined): T {
  if (v === undefined) throw new Error('optional.value: value is undefined');
  return v;
}`,
  },
  $nullValue: {
    code: `/** \`nullable.value\` — the value, or a throw when it is null. */
function $nullValue<T>(v: T | null): T {
  if (v === null) throw new Error('nullable.value: value is null');
  return v;
}`,
  },

  // ─── text ────────────────────────────────────────────────────────────────

  $charAt: {
    code: `/** \`text[i]\` — throws out of range. */
function $charAt(s: string, i: number): string {
  const ch = s[i];
  if (ch === undefined) throw new Error(\`text[\${i}]: index out of range\`);
  return ch;
}`,
  },

  // ─── list ────────────────────────────────────────────────────────────────

  $listGet: {
    code: `/** \`list[i]\` — throws out of range. */
function $listGet<T>(xs: T[], i: number): T {
  if (i < 0 || i >= xs.length) throw new Error(\`list[\${i}]: index out of range\`);
  return xs[i]!;
}`,
  },
  $listSet: {
    code: `/** \`list[i] = v\` — throws out of range. */
function $listSet<T>(xs: T[], i: number, v: T): void {
  if (i < 0 || i >= xs.length) throw new Error(\`list[\${i}] =: index out of range\`);
  xs[i] = v;
}`,
  },
  $listAt: {
    code: `/** \`list.at\` — the element, or undefined out of range. */
function $listAt<T>(xs: T[], i: number): T | undefined {
  return i < 0 || i >= xs.length ? undefined : xs[i];
}`,
  },
  $duplicates: {
    code: `/** \`list.duplicates\` — each value seen more than once, in first-repeat order. */
function $duplicates<T>(xs: T[]): T[] {
  const seen = new Set<T>();
  const dupes = new Set<T>();
  const out: T[] = [];
  for (const v of xs) {
    if (seen.has(v)) { if (!dupes.has(v)) { dupes.add(v); out.push(v); } }
    else seen.add(v);
  }
  return out;
}`,
  },
  $sortNatural: {
    code: `/** \`list.sort\` without a comparator — a sorted copy by \`<\`. */
function $sortNatural<T>(xs: T[]): T[] {
  return [...xs].sort((a: any, b: any) => a < b ? -1 : a > b ? 1 : 0);
}`,
  },

  // Callback-taking list methods: callbacks run ONE AT A TIME, in order —
  // gin awaits each before the next, so a callback with effects sees the
  // previous one's. The `Async` forms await; the plain forms are for
  // callbacks known to be synchronous.
  $map: {
    code: `function $map<T, R>(xs: T[], fn: (args: { value: T; index: number }) => R): R[] {
  const out: R[] = [];
  for (let i = 0; i < xs.length; i++) out.push(fn({ value: xs[i]!, index: i }));
  return out;
}`,
  },
  $mapAsync: {
    code: `async function $mapAsync<T, R>(xs: T[], fn: (args: { value: T; index: number }) => R | Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < xs.length; i++) out.push(await fn({ value: xs[i]!, index: i }));
  return out;
}`,
  },
  $filter: {
    code: `function $filter<T>(xs: T[], fn: (args: { value: T; index: number }) => boolean): T[] {
  const out: T[] = [];
  for (let i = 0; i < xs.length; i++) if (fn({ value: xs[i]!, index: i })) out.push(xs[i]!);
  return out;
}`,
  },
  $filterAsync: {
    code: `async function $filterAsync<T>(xs: T[], fn: (args: { value: T; index: number }) => boolean | Promise<boolean>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < xs.length; i++) if (await fn({ value: xs[i]!, index: i })) out.push(xs[i]!);
  return out;
}`,
  },
  $find: {
    code: `function $find<T>(xs: T[], fn: (args: { value: T; index: number }) => boolean): T | undefined {
  for (let i = 0; i < xs.length; i++) if (fn({ value: xs[i]!, index: i })) return xs[i];
  return undefined;
}`,
  },
  $findAsync: {
    code: `async function $findAsync<T>(xs: T[], fn: (args: { value: T; index: number }) => boolean | Promise<boolean>): Promise<T | undefined> {
  for (let i = 0; i < xs.length; i++) if (await fn({ value: xs[i]!, index: i })) return xs[i];
  return undefined;
}`,
  },
  $some: {
    code: `function $some<T>(xs: T[], fn: (args: { value: T; index: number }) => boolean): boolean {
  for (let i = 0; i < xs.length; i++) if (fn({ value: xs[i]!, index: i })) return true;
  return false;
}`,
  },
  $someAsync: {
    code: `async function $someAsync<T>(xs: T[], fn: (args: { value: T; index: number }) => boolean | Promise<boolean>): Promise<boolean> {
  for (let i = 0; i < xs.length; i++) if (await fn({ value: xs[i]!, index: i })) return true;
  return false;
}`,
  },
  $every: {
    code: `function $every<T>(xs: T[], fn: (args: { value: T; index: number }) => boolean): boolean {
  for (let i = 0; i < xs.length; i++) if (!fn({ value: xs[i]!, index: i })) return false;
  return true;
}`,
  },
  $everyAsync: {
    code: `async function $everyAsync<T>(xs: T[], fn: (args: { value: T; index: number }) => boolean | Promise<boolean>): Promise<boolean> {
  for (let i = 0; i < xs.length; i++) if (!(await fn({ value: xs[i]!, index: i }))) return false;
  return true;
}`,
  },
  $reduce: {
    code: `function $reduce<T, R>(xs: T[], fn: (args: { acc: R; value: T; index: number }) => R, initial: R): R {
  let acc = initial;
  for (let i = 0; i < xs.length; i++) acc = fn({ acc, value: xs[i]!, index: i });
  return acc;
}`,
  },
  $reduceAsync: {
    code: `async function $reduceAsync<T, R>(xs: T[], fn: (args: { acc: R; value: T; index: number }) => R | Promise<R>, initial: R): Promise<R> {
  let acc = initial;
  for (let i = 0; i < xs.length; i++) acc = await fn({ acc, value: xs[i]!, index: i });
  return acc;
}`,
  },
  // gin's comparator sort ranks each element by how many others it beats
  // (comparator > 0) — kept as is, so a comparator that is not a total
  // order sorts exactly as it does in gin.
  $sort: {
    code: `function $sort<T>(xs: T[], fn: (args: { a: T; b: T }) => number): T[] {
  const ranked = xs.map((v, i) => {
    let key = 0;
    for (let j = 0; j < xs.length; j++) if (i !== j && fn({ a: v, b: xs[j]! }) > 0) key++;
    return { v, key };
  });
  ranked.sort((x, y) => x.key - y.key);
  return ranked.map((r) => r.v);
}`,
  },
  $sortAsync: {
    code: `async function $sortAsync<T>(xs: T[], fn: (args: { a: T; b: T }) => number | Promise<number>): Promise<T[]> {
  const ranked: Array<{ v: T; key: number }> = [];
  for (let i = 0; i < xs.length; i++) {
    let key = 0;
    for (let j = 0; j < xs.length; j++) if (i !== j && (await fn({ a: xs[i]!, b: xs[j]! })) > 0) key++;
    ranked.push({ v: xs[i]!, key });
  }
  ranked.sort((x, y) => x.key - y.key);
  return ranked.map((r) => r.v);
}`,
  },

  // ─── map ─────────────────────────────────────────────────────────────────

  $mapGet: {
    code: `/** \`map[key]\` — throws when the key is missing. */
function $mapGet<K, V>(m: Map<K, V>, k: K): V {
  if (!m.has(k)) throw new Error(\`map[\${String(k)}]: key not found\`);
  return m.get(k)!;
}`,
  },

  // ─── loops ───────────────────────────────────────────────────────────────

  $parallel: {
    code: `/** A \`parallel\` loop: at most \`concurrent\` bodies at once, starts at least \`rate\` ms apart. */
async function $parallel<K, V>(
  items: Iterable<[K, V]>,
  concurrent: number | undefined,
  rate: number | undefined,
  body: (key: K, value: V) => unknown | Promise<unknown>,
): Promise<void> {
  const limit = concurrent && concurrent > 0 ? concurrent : Infinity;
  const running = new Set<Promise<unknown>>();
  let last = 0;
  for (const [k, v] of items) {
    while (running.size >= limit) await Promise.race(running);
    if (rate) {
      const wait = last + rate - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      last = Date.now();
    }
    const p: Promise<unknown> = Promise.resolve().then(() => body(k, v)).finally(() => running.delete(p));
    running.add(p);
  }
  await Promise.all(running);
}`,
  },

  // ─── date / timestamp / duration ─────────────────────────────────────────

  $date: {
    code: `/** gin \`date\` / \`timestamp\` natives (all UTC). */
const $date = {
  dayOfYear(d: Date): number {
    return Math.floor((d.getTime() - Date.UTC(d.getUTCFullYear(), 0, 0)) / 86_400_000);
  },
  addDays(d: Date, n: number): Date { const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x; },
  addMonths(d: Date, n: number): Date { const x = new Date(d); x.setUTCMonth(x.getUTCMonth() + n); return x; },
  addYears(d: Date, n: number): Date { const x = new Date(d); x.setUTCFullYear(x.getUTCFullYear() + n); return x; },
  diffDays(a: Date, b: Date): number { return Math.round((a.getTime() - b.getTime()) / 86_400_000); },
  diffMonths(a: Date, b: Date): number {
    return (a.getUTCFullYear() - b.getUTCFullYear()) * 12 + (a.getUTCMonth() - b.getUTCMonth());
  },
  toDate(d: Date): Date { return new Date(d.toISOString().slice(0, 10)); },
};`,
  },
  $duration: {
    code: `/** gin \`duration\` (milliseconds) natives. */
const $duration = {
  init(a: { days?: number; hours?: number; minutes?: number; seconds?: number; ms?: number }): number {
    return (a.days ?? 0) * 86_400_000 + (a.hours ?? 0) * 3_600_000 + (a.minutes ?? 0) * 60_000
      + (a.seconds ?? 0) * 1_000 + (a.ms ?? 0);
  },
  toText(ms: number): string {
    const days = Math.trunc(ms / 86_400_000);
    const hours = Math.trunc((ms % 86_400_000) / 3_600_000);
    const mins = Math.trunc((ms % 3_600_000) / 60_000);
    const secs = Math.trunc((ms % 60_000) / 1_000);
    const parts: string[] = [];
    if (days) parts.push(\`\${days}d\`);
    if (hours) parts.push(\`\${hours}h\`);
    if (mins) parts.push(\`\${mins}m\`);
    if (secs || parts.length === 0) parts.push(\`\${secs}s\`);
    return parts.join(' ');
  },
};`,
  },

  // ─── color (packed 0xRRGGBBAA) ───────────────────────────────────────────

  $color: {
    code: `/** gin \`color\` natives — a color is a packed 0xRRGGBBAA number. */
const $color = {
  r: (c: number) => (c >>> 24) & 0xff,
  g: (c: number) => (c >>> 16) & 0xff,
  b: (c: number) => (c >>> 8) & 0xff,
  a: (c: number) => (c & 0xff) / 255,
  pack(r: number, g: number, b: number, a: number): number {
    return (((Math.round(r) & 0xff) << 24) | ((Math.round(g) & 0xff) << 16)
      | ((Math.round(b) & 0xff) << 8) | (Math.round(a * 255) & 0xff)) >>> 0;
  },
  init(a: { r: number; g: number; b: number; a?: number }): number {
    return $color.pack(a.r, a.g, a.b, a.a ?? 1);
  },
  hsl(c: number): { h: number; s: number; l: number } {
    const r = $color.r(c) / 255, g = $color.g(c) / 255, b = $color.b(c) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    let h = 0, s = 0;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      switch (max) {
        case r: h = (g - b) / d + (g < b ? 6 : 0); break;
        case g: h = (b - r) / d + 2; break;
        case b: h = (r - g) / d + 4; break;
      }
      h *= 60;
    }
    return { h, s, l };
  },
  fromHsl(h: number, s: number, l: number, a: number): number {
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = l - c / 2;
    let r1 = 0, g1 = 0, b1 = 0;
    if (h < 60) [r1, g1, b1] = [c, x, 0];
    else if (h < 120) [r1, g1, b1] = [x, c, 0];
    else if (h < 180) [r1, g1, b1] = [0, c, x];
    else if (h < 240) [r1, g1, b1] = [0, x, c];
    else if (h < 300) [r1, g1, b1] = [x, 0, c];
    else [r1, g1, b1] = [c, 0, x];
    return $color.pack((r1 + m) * 255, (g1 + m) * 255, (b1 + m) * 255, a);
  },
  lighten(c: number, amount: number): number {
    const { h, s, l } = $color.hsl(c);
    return $color.fromHsl(h, s, Math.max(0, Math.min(1, l + amount)), $color.a(c));
  },
  saturate(c: number, amount: number): number {
    const { h, s, l } = $color.hsl(c);
    return $color.fromHsl(h, Math.max(0, Math.min(1, s + amount)), l, $color.a(c));
  },
  complement(c: number): number {
    const { h, s, l } = $color.hsl(c);
    return $color.fromHsl((h + 180 + 360) % 360, s, l, $color.a(c));
  },
  opacity(c: number, alpha: number): number {
    return (c & 0xffffff00) | (Math.round(alpha * 255) & 0xff);
  },
  invert(c: number): number {
    return $color.pack(255 - $color.r(c), 255 - $color.g(c), 255 - $color.b(c), $color.a(c));
  },
  mix(a: number, b: number, weight?: number): number {
    const w = weight ?? 0.5;
    return $color.pack(
      $color.r(a) * (1 - w) + $color.r(b) * w,
      $color.g(a) * (1 - w) + $color.g(b) * w,
      $color.b(a) * (1 - w) + $color.b(b) * w,
      $color.a(a) * (1 - w) + $color.a(b) * w,
    );
  },
  toHex: (c: number) => '#' + c.toString(16).padStart(8, '0'),
  toRgb: (c: number) => \`rgb(\${$color.r(c)},\${$color.g(c)},\${$color.b(c)})\`,
  toHsl(c: number): string {
    const { h, s, l } = $color.hsl(c);
    return \`hsl(\${Math.round(h)},\${Math.round(s * 100)}%,\${Math.round(l * 100)}%)\`;
  },
};`,
  },
};
