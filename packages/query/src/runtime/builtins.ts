/**
 * The shipped default function library — every builtin scalar / aggregate /
 * window function as a `FunctionDef` (declared name + named params + output)
 * PAIRED with its shape-tagged `FunctionRun`. `createRegistry` registers both
 * lists, so the whole library is discoverable via `functionList()` /
 * `describeFunctions()` and runnable through the uniform dispatch path.
 *
 * Argument convention: every function takes NAMED arguments keyed by the param
 * names declared here. The few variadic SQL functions (`concat`, `coalesce`,
 * `greatest`, `least`) take a single `values: array` parameter — the caller
 * passes one expression evaluating to an array of the operands.
 *
 * No `any` / casts; all logic is typed against `Value` / `NamedArgs`.
 */
import type {
  AggregateExprDef,
  ExprDef,
  FieldTypeDef,
  FunctionCallExprDef,
  FunctionDef,
  JsonValue,
  QueryDef,
  ScalarValue,
  WindowExprDef,
} from '../schema';
import type {
  AggregateRun,
  FunctionRun,
  NamedArgs,
  ScalarRun,
  WindowRun,
} from './functions';
import { WINDOW_ORDER_ARG } from './functions';
import { Value } from './value';

/** A registered builtin: its declaration plus its runtime implementation. */
export interface BuiltinFunction {
  /** The function's declaration (name, params, output, shape). */
  def: FunctionDef;
  /** The shape-tagged runtime implementation. */
  run: FunctionRun;
}

// ─── Small typed helpers ─────────────────────────────────────────────────────

const ANY = 'any' as const;
const TEXT: FieldTypeDef = { kind: 'text' };
const NUMBER: FieldTypeDef = { kind: 'number' };
const WHOLE: FieldTypeDef = { kind: 'number', whole: true };
const BOOL: FieldTypeDef = { kind: 'bool' };
const ARRAY: FieldTypeDef = { kind: 'array' };
const DATE: FieldTypeDef = { kind: 'date' };
const TIMESTAMP: FieldTypeDef = { kind: 'timestamp' };

// ─── Worked-example builders (raw-JSON `examples` strings) ───────────────────
//
// Shipped examples teach a function's SHAPE with ILLUSTRATIVE generic
// source/field names (`event.score`, …) — the model gets the caller's REAL Type
// names from the catalog. Built as TYPED defs (compile-checked) then stringified
// to the raw-JSON form `examples` carries; a structural test parses each back.

/** A `<source>.<field>` reference expr def. */
function ref(source: string, field: string): ExprDef {
  return { kind: 'field-ref', source, field };
}

/** A literal scalar expr def. */
function litExpr(value: ScalarValue): ExprDef {
  return { kind: 'literal', value };
}

/** A worked scalar CALL as a raw-JSON example (an expr FRAGMENT). */
function callExample(fn: string, args: Record<string, ExprDef>): string {
  const def: FunctionCallExprDef = { kind: 'function-call', function: fn, args };
  return JSON.stringify(def);
}

/** A worked AGGREGATE call as a raw-JSON example (an expr FRAGMENT). `count(*)`
 *  is `count` with EMPTY `args`. */
function aggExample(fn: string, args: Record<string, ExprDef>): string {
  const def: AggregateExprDef = { kind: 'aggregate', function: fn, args };
  return JSON.stringify(def);
}

/**
 * A worked WINDOW example as a raw-JSON example (a full SELECT): projects a label
 * plus `fn(args) OVER (ORDER BY score DESC [PARTITION BY category])`. `orderBy`
 * sets the ranking/sequence; passing `partition` splits rows into INDEPENDENT
 * groups — the two clauses whose confusion these examples exist to prevent.
 */
function windowExample(
  fn: string,
  args: Record<string, ExprDef>,
  opts: { partition?: boolean } = {},
): string {
  const win: WindowExprDef = {
    kind: 'window',
    function: fn,
    args,
    orderBy: [{ expr: ref('event', 'score'), dir: 'desc' }],
  };
  if (opts.partition) win.partitionBy = [ref('event', 'category')];
  const def: QueryDef = {
    kind: 'select',
    fields: [{ expr: ref('event', 'label') }, { expr: win, as: fn }],
    from: { kind: 'type', type: 'event' },
  };
  return JSON.stringify(def);
}

/** Read a named arg, defaulting to NULL when absent. */
function arg(args: NamedArgs, name: string): Value {
  return args[name] ?? Value.null();
}

/** The raw elements of an array-valued named arg (empty for a non-array). */
function elements(args: NamedArgs, name: string): readonly JsonValue[] {
  const raw = arg(args, name).raw;
  return Array.isArray(raw) ? raw : [];
}

/** Apply a unary math op, returning NULL for non-numbers or non-finite results
 *  (e.g. `ln(0)` → -∞, `asin(2)` → NaN, mirroring SQL's NULL/error semantics). */
function numeric(v: Value, fn: (n: number) => number): Value {
  if (v.isNull()) return Value.null();
  const n = v.toNumber();
  if (Number.isNaN(n)) return Value.null();
  const r = fn(n);
  return Number.isFinite(r) ? Value.of(r) : Value.null();
}

/** Apply a binary math op over two args, NULL when either is non-numeric or the
 *  result is non-finite (e.g. `mod(x, 0)` → NaN, `log(1, x)` → ±∞). */
function numeric2(a: Value, b: Value, fn: (x: number, y: number) => number): Value {
  if (a.isNull() || b.isNull()) return Value.null();
  const x = a.toNumber();
  const y = b.toNumber();
  if (Number.isNaN(x) || Number.isNaN(y)) return Value.null();
  const r = fn(x, y);
  return Number.isFinite(r) ? Value.of(r) : Value.null();
}

/** A named arg as a truncated integer, defaulting when absent / non-numeric. */
function intArg(args: NamedArgs, name: string, dflt: number): number {
  const v = args[name];
  if (!v || v.isNull()) return dflt;
  const n = v.toNumber();
  return Number.isNaN(n) ? dflt : Math.trunc(n);
}

/** greatest (dir=1) / least (dir=-1) over the non-null `values`. */
function extremum(values: readonly Value[], dir: 1 | -1): Value {
  const present = values.filter((v) => !v.isNull());
  if (present.length === 0) return Value.null();
  return present.reduce((best, v) => (v.compareTo(best) * dir > 0 ? v : best));
}

// ─── Date/time helpers (Group 2a) ────────────────────────────────────────────
//
// All computations use UTC getters so results are deterministic and independent
// of the host timezone. A date/timestamp value is a parseable ISO string; a
// value that does not parse (or SQL NULL) yields NULL, mirroring SQL semantics.

/** Parse a value as a UTC `Date`, or NULL (`null`) when absent / unparseable. */
function toDate(v: Value): Date | null {
  if (v.isNull()) return null;
  const d = new Date(v.toText());
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Two-digit zero-padded string of a whole number (for date formatting). */
function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** 1-based day-of-year (Jan 1 = 1). */
function dayOfYearOf(d: Date): number {
  const start = Date.UTC(d.getUTCFullYear(), 0, 0);
  const cur = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return Math.round((cur - start) / 86400000);
}

/** ISO-8601 week number (weeks start Monday; week 1 holds the year's first
 *  Thursday). Branch-free so it stays fully covered. */
function isoWeekOf(d: Date): number {
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  target.setUTCDate(target.getUTCDate() - ((target.getUTCDay() + 6) % 7) + 3); // this week's Thursday
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  firstThursday.setUTCDate(firstThursday.getUTCDate() - ((firstThursday.getUTCDay() + 6) % 7) + 3);
  return 1 + Math.round((target.getTime() - firstThursday.getTime()) / (7 * 86400000));
}

/** The numeric value of a date FIELD (`datePart` token), or NULL for an
 *  unrecognized token. `dow` = 0(Sun)..6(Sat); `isodow` = 1(Mon)..7(Sun). */
function datePartOf(token: string, d: Date): number | null {
  switch (token) {
    case 'year': return d.getUTCFullYear();
    case 'quarter': return Math.floor(d.getUTCMonth() / 3) + 1;
    case 'month': return d.getUTCMonth() + 1;
    case 'week': return isoWeekOf(d);
    case 'day': return d.getUTCDate();
    case 'hour': return d.getUTCHours();
    case 'minute': return d.getUTCMinutes();
    case 'second': return d.getUTCSeconds();
    case 'dow': return d.getUTCDay();
    case 'isodow': return d.getUTCDay() === 0 ? 7 : d.getUTCDay();
    case 'doy': return dayOfYearOf(d);
    case 'epoch': return Math.floor(d.getTime() / 1000);
    default: return null;
  }
}

/** `d` plus `n` units of `field`, or NULL for a non-interval field token. */
function addToDate(d: Date, token: string, n: number): Date | null {
  const r = new Date(d.getTime());
  switch (token) {
    case 'year': r.setUTCFullYear(r.getUTCFullYear() + n); return r;
    case 'quarter': r.setUTCMonth(r.getUTCMonth() + 3 * n); return r;
    case 'month': r.setUTCMonth(r.getUTCMonth() + n); return r;
    case 'week': r.setUTCDate(r.getUTCDate() + 7 * n); return r;
    case 'day': r.setUTCDate(r.getUTCDate() + n); return r;
    case 'hour': r.setUTCHours(r.getUTCHours() + n); return r;
    case 'minute': r.setUTCMinutes(r.getUTCMinutes() + n); return r;
    case 'second': r.setUTCSeconds(r.getUTCSeconds() + n); return r;
    default: return null;
  }
}

/** `d` truncated to `field` precision (lower components zeroed), or NULL for a
 *  non-truncatable field token. `week` truncates back to Monday. */
function truncToDate(token: string, d: Date): Date | null {
  const y = d.getUTCFullYear();
  const mo = d.getUTCMonth();
  const da = d.getUTCDate();
  const h = d.getUTCHours();
  const mi = d.getUTCMinutes();
  const s = d.getUTCSeconds();
  switch (token) {
    case 'year': return new Date(Date.UTC(y, 0, 1));
    case 'quarter': return new Date(Date.UTC(y, Math.floor(mo / 3) * 3, 1));
    case 'month': return new Date(Date.UTC(y, mo, 1));
    case 'week': {
      const r = new Date(Date.UTC(y, mo, da));
      r.setUTCDate(r.getUTCDate() - ((r.getUTCDay() + 6) % 7));
      return r;
    }
    case 'day': return new Date(Date.UTC(y, mo, da));
    case 'hour': return new Date(Date.UTC(y, mo, da, h));
    case 'minute': return new Date(Date.UTC(y, mo, da, h, mi));
    case 'second': return new Date(Date.UTC(y, mo, da, h, mi, s));
    default: return null;
  }
}

/** Format `d` (UTC) with the supported `to_char`-style tokens: `YYYY`, `MM`,
 *  `DD`, `HH24` (24h), `HH` (12h), `MI`, `SS`. Other characters pass through. */
function formatDate(d: Date, fmt: string): string {
  const map: Record<string, string> = {
    YYYY: String(d.getUTCFullYear()).padStart(4, '0'),
    MM: pad2(d.getUTCMonth() + 1),
    DD: pad2(d.getUTCDate()),
    HH24: pad2(d.getUTCHours()),
    HH: pad2(((d.getUTCHours() + 11) % 12) + 1),
    MI: pad2(d.getUTCMinutes()),
    SS: pad2(d.getUTCSeconds()),
  };
  return fmt.replace(/YYYY|HH24|HH|MM|DD|MI|SS/g, (t) => map[t]);
}

/** Apply a unary date-component extractor, NULL when the arg does not parse. */
function dateComponent(a: NamedArgs, name: string, fn: (d: Date) => number): Value {
  const d = toDate(arg(a, name));
  return d ? Value.of(fn(d)) : Value.null();
}

/** Build a scalar builtin entry. `instructions` is the terse LLM-facing usage
 *  note. `sql` overrides the emitted call name (e.g. `trimLeft` → `ltrim`) when
 *  the SQL function name differs from the declared camelCase name. */
function scalar(
  name: string,
  instructions: string,
  params: FunctionDef['params'],
  output: FunctionDef['output'],
  run: ScalarRun,
  sql?: string,
  rawArgs?: readonly number[],
  examples?: readonly string[],
): BuiltinFunction {
  return {
    def: {
      name,
      shape: 'scalar',
      instructions,
      ...(examples ? { examples } : {}),
      params,
      output,
      ...(sql ? { sql } : {}),
      ...(rawArgs ? { rawArgs } : {}),
    },
    run: { shape: 'scalar', run },
  };
}

// ─── Scalar library ──────────────────────────────────────────────────────────

const SCALARS: readonly BuiltinFunction[] = [
  scalar('concat', "Concatenate the array elements into one string (NULLs become empty).", [{ name: 'values', type: ARRAY }], TEXT, (a) =>
    Value.of(elements(a, 'values').map((e) => Value.of(e).toText()).join('')),
  ),
  scalar('lower', "Lower-case the text.", [{ name: 'value', type: TEXT }], TEXT, (a) =>
    Value.of(arg(a, 'value').toText().toLowerCase()),
  ),
  scalar('upper', "Upper-case the text.", [{ name: 'value', type: TEXT }], TEXT, (a) =>
    Value.of(arg(a, 'value').toText().toUpperCase()),
  ),
  scalar('trim', "Strip leading and trailing whitespace.", [{ name: 'value', type: TEXT }], TEXT, (a) =>
    Value.of(arg(a, 'value').toText().trim()),
  ),
  scalar('length', "Character length of the text.", [{ name: 'value', type: TEXT }], WHOLE, (a) =>
    Value.of(arg(a, 'value').toText().length),
  ),
  scalar('substring', "1-based substring; omit length to read to the end.",
    [
      { name: 'value', type: TEXT },
      { name: 'start', type: NUMBER },
      { name: 'length', type: NUMBER, optional: true },
    ],
    TEXT,
    (a) => {
      const str = arg(a, 'value').toText();
      const start = arg(a, 'start').toNumber();
      const len = a['length'] ? a['length'].toNumber() : undefined;
      return Value.of(len !== undefined ? str.substring(start, start + len) : str.substring(start));
    },
  ),
  scalar('replace', "Replace EVERY occurrence of `search` in `value` with `replacement` (all three are text; pass literals via `{kind:'literal'}`).",
    [
      { name: 'value', type: TEXT },
      { name: 'search', type: TEXT },
      { name: 'replacement', type: TEXT },
    ],
    TEXT,
    (a) =>
      Value.of(
        arg(a, 'value').toText().split(arg(a, 'search').toText()).join(arg(a, 'replacement').toText()),
      ),
    undefined,
    undefined,
    [callExample('replace', { value: ref('event', 'code'), search: litExpr('-'), replacement: litExpr('') })],
  ),
  scalar('abs', "Absolute value.", [{ name: 'value', type: NUMBER }], NUMBER, (a) => numeric(arg(a, 'value'), Math.abs)),
  scalar('ceil', "Round up to the next whole number.", [{ name: 'value', type: NUMBER }], NUMBER, (a) => numeric(arg(a, 'value'), Math.ceil)),
  scalar('floor', "Round down to the previous whole number.", [{ name: 'value', type: NUMBER }], NUMBER, (a) => numeric(arg(a, 'value'), Math.floor)),
  scalar('round', "Round to the nearest whole number.", [{ name: 'value', type: NUMBER }], NUMBER, (a) => numeric(arg(a, 'value'), Math.round)),
  scalar('sqrt', "Square root (NULL for negatives).", [{ name: 'value', type: NUMBER }], NUMBER, (a) => numeric(arg(a, 'value'), Math.sqrt)),
  scalar('power', "`base` raised to `exponent`.",
    [
      { name: 'base', type: NUMBER },
      { name: 'exponent', type: NUMBER },
    ],
    NUMBER,
    (a) => {
      const base = arg(a, 'base').toNumber();
      const exp = arg(a, 'exponent').toNumber();
      if (Number.isNaN(base) || Number.isNaN(exp)) return Value.null();
      return Value.of(Math.pow(base, exp));
    },
  ),
  scalar('coalesce', "First non-null element of the array.", [{ name: 'values', type: ARRAY }], 'inferred', (a) => {
    for (const e of elements(a, 'values')) {
      if (e !== null) return Value.of(e);
    }
    return Value.null();
  }),
  scalar('nullif', "NULL when `value` equals `other`, else `value`.",
    [
      { name: 'value', type: ANY },
      { name: 'other', type: ANY },
    ],
    'inferred',
    (a) => (arg(a, 'value').equals(arg(a, 'other')) ? Value.null() : arg(a, 'value')),
  ),
  scalar('greatest', "Largest non-null element of the array.", [{ name: 'values', type: ARRAY }], 'inferred', (a) =>
    extremum(elements(a, 'values').map((e) => Value.of(e)), 1),
  ),
  scalar('least', "Smallest non-null element of the array.", [{ name: 'values', type: ARRAY }], 'inferred', (a) =>
    extremum(elements(a, 'values').map((e) => Value.of(e)), -1),
  ),
  scalar('arrayLength', "Number of elements in the array.", [{ name: 'arr', type: ARRAY }], WHOLE, (a) =>
    Value.of(elements(a, 'arr').length),
  ),
  // ─── Group 2c: common scalars (string) ─────────────────────────────────────
  // Most emit the portable `name(args)` form; a `sql` override supplies the
  // postgres/common function name where it differs from the camelCase name.
  scalar('trimLeft', "Strip leading whitespace.", [{ name: 'value', type: TEXT }], TEXT, (a) =>
    Value.of(arg(a, 'value').toText().trimStart()), 'ltrim'),
  scalar('trimRight', "Strip trailing whitespace.", [{ name: 'value', type: TEXT }], TEXT, (a) =>
    Value.of(arg(a, 'value').toText().trimEnd()), 'rtrim'),
  scalar('left', "First `count` characters (negative drops the last |count|).",
    [{ name: 'value', type: TEXT }, { name: 'count', type: NUMBER }],
    TEXT,
    // `left(s, n)`: first n chars; a negative n drops the last |n| (pg semantics).
    (a) => Value.of(arg(a, 'value').toText().slice(0, intArg(a, 'count', 0))),
  ),
  scalar('right', "Last `count` characters (negative drops the first |count|).",
    [{ name: 'value', type: TEXT }, { name: 'count', type: NUMBER }],
    TEXT,
    // `right(s, n)`: last n chars; n = 0 → '' ; a negative n drops the first |n|.
    (a) => {
      const s = arg(a, 'value').toText();
      const n = intArg(a, 'count', 0);
      return Value.of(n === 0 ? '' : s.slice(-n));
    },
  ),
  scalar('padLeft', "Left-pad to `length` with `fill` (space); truncates when longer.",
    [
      { name: 'value', type: TEXT },
      { name: 'length', type: NUMBER },
      { name: 'fill', type: TEXT, optional: true },
    ],
    TEXT,
    // `lpad`: truncate to `length` when shorter, else left-pad with `fill` (space).
    (a) => {
      const s = arg(a, 'value').toText();
      const len = intArg(a, 'length', 0);
      const fill = a['fill'] ? arg(a, 'fill').toText() : ' ';
      return Value.of(len < s.length ? s.slice(0, Math.max(len, 0)) : s.padStart(len, fill));
    },
    'lpad',
  ),
  scalar('padRight', "Right-pad to `length` with `fill` (space); truncates when longer.",
    [
      { name: 'value', type: TEXT },
      { name: 'length', type: NUMBER },
      { name: 'fill', type: TEXT, optional: true },
    ],
    TEXT,
    // `rpad`: truncate to `length` when shorter, else right-pad with `fill` (space).
    (a) => {
      const s = arg(a, 'value').toText();
      const len = intArg(a, 'length', 0);
      const fill = a['fill'] ? arg(a, 'fill').toText() : ' ';
      return Value.of(len < s.length ? s.slice(0, Math.max(len, 0)) : s.padEnd(len, fill));
    },
    'rpad',
  ),
  scalar('repeat', "Repeat the text `count` times.",
    [{ name: 'value', type: TEXT }, { name: 'count', type: NUMBER }],
    TEXT,
    (a) => Value.of(arg(a, 'value').toText().repeat(Math.max(0, intArg(a, 'count', 0)))),
  ),
  scalar('reverse', "Reverse the characters.", [{ name: 'value', type: TEXT }], TEXT, (a) =>
    Value.of([...arg(a, 'value').toText()].reverse().join('')),
  ),
  scalar('indexOf', "1-based position of `search`, 0 when absent.",
    [{ name: 'value', type: TEXT }, { name: 'search', type: TEXT }],
    // 1-based position of `search` in `value`, 0 when absent (pg `strpos`).
    WHOLE,
    (a) => Value.of(arg(a, 'value').toText().indexOf(arg(a, 'search').toText()) + 1),
    'strpos',
  ),
  scalar('startsWith', "True if the text begins with `search`.",
    [{ name: 'value', type: TEXT }, { name: 'search', type: TEXT }],
    BOOL,
    (a) => Value.of(arg(a, 'value').toText().startsWith(arg(a, 'search').toText())),
    // pg `starts_with(value, search)`; base uses the same builtin name.
    'starts_with',
  ),
  scalar('splitPart', "The 1-based `index`-th field after splitting on `delimiter`.",
    [
      { name: 'value', type: TEXT },
      { name: 'delimiter', type: TEXT },
      { name: 'index', type: NUMBER },
    ],
    TEXT,
    // `split_part(s, delim, n)`: the 1-based n-th field, '' when out of range.
    (a) => {
      const parts = arg(a, 'value').toText().split(arg(a, 'delimiter').toText());
      return Value.of(parts[intArg(a, 'index', 1) - 1] ?? '');
    },
    'split_part',
  ),
  scalar('concatWs', "Join the array's non-null elements with `separator`.",
    [{ name: 'separator', type: TEXT }, { name: 'values', type: ARRAY }],
    TEXT,
    // Like `concat`, `values` is ONE array arg (the variadic operands); non-null
    // elements are joined by `separator` (pg `concat_ws(sep, …)`).
    (a) =>
      Value.of(
        elements(a, 'values')
          .filter((e) => e !== null)
          .map((e) => Value.of(e).toText())
          .join(arg(a, 'separator').toText()),
      ),
    'concat_ws',
  ),
  // ─── Group 2c: common scalars (math) ───────────────────────────────────────
  scalar('mod', "Remainder of `value` divided by `divisor`.",
    [{ name: 'value', type: NUMBER }, { name: 'divisor', type: NUMBER }],
    NUMBER,
    (a) => numeric2(arg(a, 'value'), arg(a, 'divisor'), (x, y) => x % y),
  ),
  scalar('sign', "-1, 0, or 1 for the number’s sign.", [{ name: 'value', type: NUMBER }], NUMBER, (a) => numeric(arg(a, 'value'), Math.sign)),
  scalar('exp', "e raised to `value`.", [{ name: 'value', type: NUMBER }], NUMBER, (a) => numeric(arg(a, 'value'), Math.exp)),
  scalar('ln', "Natural logarithm (NULL for value ≤ 0).", [{ name: 'value', type: NUMBER }], NUMBER, (a) => numeric(arg(a, 'value'), Math.log)),
  scalar('log', "Logarithm of `value` in `base`.",
    [{ name: 'base', type: NUMBER }, { name: 'value', type: NUMBER }],
    // `log(base, value)` = log of `value` in `base` (pg `log(b, x)`).
    NUMBER,
    (a) => numeric2(arg(a, 'base'), arg(a, 'value'), (b, x) => Math.log(x) / Math.log(b)),
  ),
  // base-10 log; pg spells single-arg `log(x)` as base-10, so emit `log`.
  scalar('log10', "Base-10 logarithm.", [{ name: 'value', type: NUMBER }], NUMBER, (a) => numeric(arg(a, 'value'), Math.log10), 'log'),
  scalar('trunc', "Truncate toward zero to a whole number.", [{ name: 'value', type: NUMBER }], NUMBER, (a) => numeric(arg(a, 'value'), Math.trunc)),
  scalar('pi', "The constant π.", [], NUMBER, () => Value.of(Math.PI)),
  scalar('degrees', "Convert radians to degrees.", [{ name: 'value', type: NUMBER }], NUMBER, (a) => numeric(arg(a, 'value'), (n) => (n * 180) / Math.PI)),
  scalar('radians', "Convert degrees to radians.", [{ name: 'value', type: NUMBER }], NUMBER, (a) => numeric(arg(a, 'value'), (n) => (n * Math.PI) / 180)),
  scalar('random', "Random number in [0, 1).", [], NUMBER, () => Value.of(Math.random())),
  scalar('sin', "Sine (radians).", [{ name: 'value', type: NUMBER }], NUMBER, (a) => numeric(arg(a, 'value'), Math.sin)),
  scalar('cos', "Cosine (radians).", [{ name: 'value', type: NUMBER }], NUMBER, (a) => numeric(arg(a, 'value'), Math.cos)),
  scalar('tan', "Tangent (radians).", [{ name: 'value', type: NUMBER }], NUMBER, (a) => numeric(arg(a, 'value'), Math.tan)),
  scalar('asin', "Arc-sine in radians (NULL outside [-1, 1]).", [{ name: 'value', type: NUMBER }], NUMBER, (a) => numeric(arg(a, 'value'), Math.asin)),
  scalar('acos', "Arc-cosine in radians (NULL outside [-1, 1]).", [{ name: 'value', type: NUMBER }], NUMBER, (a) => numeric(arg(a, 'value'), Math.acos)),
  scalar('atan', "Arc-tangent in radians.", [{ name: 'value', type: NUMBER }], NUMBER, (a) => numeric(arg(a, 'value'), Math.atan)),
  scalar('atan2', "Angle in radians of the point (x, y).",
    [{ name: 'y', type: NUMBER }, { name: 'x', type: NUMBER }],
    NUMBER,
    (a) => numeric2(arg(a, 'y'), arg(a, 'x'), (y, x) => Math.atan2(y, x)),
  ),
  // ─── Group 2c: conditional ─────────────────────────────────────────────────
  scalar('iif', "Return `then` when `condition` is true, else `else`.",
    [
      { name: 'condition', type: BOOL },
      { name: 'then', type: ANY },
      { name: 'else', type: ANY },
    ],
    'inferred',
    // Emitted (both dialects) as `(CASE WHEN condition THEN then ELSE else END)`.
    (a) => (arg(a, 'condition').toBoolean() ? arg(a, 'then') : arg(a, 'else')),
  ),
  scalar('now', "Current timestamp.", [], { kind: 'timestamp' }, () => Value.of(new Date().toISOString())),
  scalar('currentDate', "Today’s date.", [], { kind: 'date' }, () => {
    const iso = new Date().toISOString();
    /* v8 ignore next -- `toISOString()` always contains 'T', so `split('T')[0]` is always defined; the `?? iso` is dead */
    return Value.of(iso.split('T')[0] ?? iso);
  }),
  // ─── Group 2a: date / time ─────────────────────────────────────────────────
  // Temporal inputs are typed `any` (an ISO date/timestamp string OR a temporal
  // field), so a `date` value is accepted wherever a `timestamp` is. The FIELD
  // arg of the four selectors is a `rawArgs` inline literal (emitted as an
  // `EXTRACT`/`date_part` field, never a bind param). `currentTime`/…, the
  // `EXTRACT`-based extractors, and the pg selector forms live in the dialects.
  scalar('currentTime', "Current time of day (HH:MM:SS).", [], TEXT, () => Value.of(new Date().toISOString().slice(11, 19))),
  scalar('currentTimestamp', "Current timestamp.", [], TIMESTAMP, () => Value.of(new Date().toISOString())),
  scalar('datePart', "Numeric component named by `field` (year/month/day/dow/…) of `d`.",
    [{ name: 'field', type: TEXT }, { name: 'd', type: ANY }],
    // Numeric component named by `field` (year/month/day/dow/doy/week/…).
    NUMBER,
    (a) => {
      const d = toDate(arg(a, 'd'));
      if (!d) return Value.null();
      const n = datePartOf(arg(a, 'field').toText(), d);
      return n === null ? Value.null() : Value.of(n);
    },
    undefined,
    [0],
  ),
  scalar('year', "Year component of `d`.", [{ name: 'd', type: ANY }], WHOLE, (a) => dateComponent(a, 'd', (x) => x.getUTCFullYear())),
  scalar('month', "Month component (1-12) of `d`.", [{ name: 'd', type: ANY }], WHOLE, (a) => dateComponent(a, 'd', (x) => x.getUTCMonth() + 1)),
  scalar('day', "Day-of-month (1-31) of `d`.", [{ name: 'd', type: ANY }], WHOLE, (a) => dateComponent(a, 'd', (x) => x.getUTCDate())),
  scalar('hour', "Hour (0-23) of `d`.", [{ name: 'd', type: ANY }], WHOLE, (a) => dateComponent(a, 'd', (x) => x.getUTCHours())),
  scalar('minute', "Minute (0-59) of `d`.", [{ name: 'd', type: ANY }], WHOLE, (a) => dateComponent(a, 'd', (x) => x.getUTCMinutes())),
  scalar('second', "Second (0-59) of `d`.", [{ name: 'd', type: ANY }], WHOLE, (a) => dateComponent(a, 'd', (x) => x.getUTCSeconds())),
  // `dayOfWeek` = 0(Sun)..6(Sat) (matches pg `EXTRACT(DOW …)`); `week` = ISO week.
  scalar('dayOfWeek', "Day of week of `d` (0=Sun … 6=Sat).", [{ name: 'd', type: ANY }], WHOLE, (a) => dateComponent(a, 'd', (x) => x.getUTCDay())),
  scalar('dayOfYear', "1-based day of year of `d`.", [{ name: 'd', type: ANY }], WHOLE, (a) => dateComponent(a, 'd', dayOfYearOf)),
  scalar('week', "ISO week number of `d`.", [{ name: 'd', type: ANY }], WHOLE, (a) => dateComponent(a, 'd', isoWeekOf)),
  scalar('dateAdd', "`d` plus `n` whole units of `field` (year/month/day/…).",
    [{ name: 'field', type: TEXT }, { name: 'n', type: NUMBER }, { name: 'd', type: ANY }],
    TIMESTAMP,
    (a) => {
      const d = toDate(arg(a, 'd'));
      if (!d) return Value.null();
      const r = addToDate(d, arg(a, 'field').toText(), intArg(a, 'n', 0));
      return r ? Value.of(r.toISOString()) : Value.null();
    },
    undefined,
    [0],
  ),
  scalar('dateDiff', "Whole-unit difference b−a in the given field (year/month/day/…).",
    [{ name: 'field', type: TEXT }, { name: 'a', type: ANY }, { name: 'b', type: ANY }],
    // The DIFFERENCE of the two extracted `field` components (`part(b) - part(a)`),
    // NOT a true calendar span — matches the emitted pg/base SQL semantics.
    NUMBER,
    (a) => {
      const da = toDate(arg(a, 'a'));
      const db = toDate(arg(a, 'b'));
      if (!da || !db) return Value.null();
      const token = arg(a, 'field').toText();
      const pa = datePartOf(token, da);
      const pb = datePartOf(token, db);
      return pa === null || pb === null ? Value.null() : Value.of(pb - pa);
    },
    undefined,
    [0],
  ),
  scalar('dateTrunc', "Truncate `d` DOWN to `field` precision (zeroes lower components) — e.g. `field:'month'` maps any day to the 1st. `field` is a literal token (year/quarter/month/week/day/hour/minute/second).",
    [{ name: 'field', type: TEXT }, { name: 'd', type: ANY }],
    TIMESTAMP,
    (a) => {
      const d = toDate(arg(a, 'd'));
      if (!d) return Value.null();
      const r = truncToDate(arg(a, 'field').toText(), d);
      return r ? Value.of(r.toISOString()) : Value.null();
    },
    undefined,
    [0],
    [callExample('dateTrunc', { field: litExpr('month'), d: ref('event', 'createdAt') })],
  ),
  scalar('makeDate', "Build a date from numeric `year`, `month`, `day`.",
    [{ name: 'year', type: NUMBER }, { name: 'month', type: NUMBER }, { name: 'day', type: NUMBER }],
    DATE,
    // ISO `YYYY-MM-DD` from the numeric parts (zero-padded).
    (a) =>
      Value.of(
        `${String(intArg(a, 'year', 0)).padStart(4, '0')}-${pad2(intArg(a, 'month', 1))}-${pad2(intArg(a, 'day', 1))}`,
      ),
    'make_date',
  ),
  scalar('dateFormat', "Format `d` with `format` tokens (YYYY/MM/DD/HH24/HH/MI/SS).",
    [{ name: 'd', type: ANY }, { name: 'format', type: TEXT }],
    TEXT,
    // pg `to_char(d, fmt)`; supported tokens: YYYY/MM/DD/HH24/HH/MI/SS.
    (a) => {
      const d = toDate(arg(a, 'd'));
      return d ? Value.of(formatDate(d, arg(a, 'format').toText())) : Value.null();
    },
    'to_char',
  ),
  // `epoch` emits `EXTRACT(EPOCH FROM ts)` (both dialects, via the dialect).
  scalar('epoch', "Unix seconds since 1970 for `ts`.", [{ name: 'ts', type: ANY }], NUMBER, (a) => {
    const d = toDate(arg(a, 'ts'));
    return d ? Value.of(Math.floor(d.getTime() / 1000)) : Value.null();
  }),
  scalar('fromEpoch', "Timestamp from Unix seconds `value`.",
    [{ name: 'value', type: NUMBER }],
    TIMESTAMP,
    // Seconds since the epoch → an ISO timestamp; pg `to_timestamp(n)`.
    (a) => {
      const v = arg(a, 'value');
      if (v.isNull()) return Value.null();
      const n = v.toNumber();
      return Number.isNaN(n) ? Value.null() : Value.of(new Date(n * 1000).toISOString());
    },
    'to_timestamp',
  ),
  scalar('age', "Whole-day span `a − b` (integer days; `a` and `b` are dates/timestamps). NOTE order: the LATER date is `a`.",
    [{ name: 'a', type: ANY }, { name: 'b', type: ANY }],
    // Whole-day span `a - b`. pg `age(a, b)` yields a symbolic interval; our
    // runtime returns the integer day difference (documented divergence).
    WHOLE,
    (a) => {
      const da = toDate(arg(a, 'a'));
      const db = toDate(arg(a, 'b'));
      if (!da || !db) return Value.null();
      return Value.of(Math.trunc((da.getTime() - db.getTime()) / 86400000));
    },
    undefined,
    undefined,
    [callExample('age', { a: ref('event', 'endedAt'), b: ref('event', 'startedAt') })],
  ),
  // ─── Group 2b: array (postgres-native; the base dialect DEGRADES) ───────────
  // Runtime impls operate on JS arrays. SQL for BOTH dialects lives in the
  // dialects: Postgres emits native array operators; the base (ANSI) dialect has
  // no array type and degrades gracefully (a constant, or the array unchanged) —
  // it NEVER throws.
  scalar('arrayContains', "True if the array contains the element.",
    [{ name: 'arr', type: ARRAY }, { name: 'value', type: ANY }],
    BOOL,
    (a) => {
      const target = arg(a, 'value');
      return Value.of(elements(a, 'arr').some((el) => Value.of(el).identical(target)));
    },
  ),
  scalar('arrayAppend', "Array with `value` added at the end.", [{ name: 'arr', type: ARRAY }, { name: 'value', type: ANY }], ARRAY, (a) =>
    Value.of([...elements(a, 'arr'), arg(a, 'value').raw]),
  ),
  scalar('arrayPrepend', "Array with `value` added at the front.", [{ name: 'arr', type: ARRAY }, { name: 'value', type: ANY }], ARRAY, (a) =>
    Value.of([arg(a, 'value').raw, ...elements(a, 'arr')]),
  ),
  scalar('arrayConcat', "Concatenate arrays `a` and `b`.", [{ name: 'a', type: ARRAY }, { name: 'b', type: ARRAY }], ARRAY, (a) =>
    Value.of([...elements(a, 'a'), ...elements(a, 'b')]),
  ),
  scalar('arrayIndexOf', "1-based position of `value` in the array, NULL when absent.",
    [{ name: 'arr', type: ARRAY }, { name: 'value', type: ANY }],
    // 1-based position of `value`, NULL when absent (pg `array_position`).
    WHOLE,
    (a) => {
      const target = arg(a, 'value');
      const idx = elements(a, 'arr').findIndex((el) => Value.of(el).identical(target));
      return idx < 0 ? Value.null() : Value.of(idx + 1);
    },
  ),
  scalar('arraySlice', "1-based inclusive slice `arr[lo:hi]`.",
    [{ name: 'arr', type: ARRAY }, { name: 'lo', type: NUMBER }, { name: 'hi', type: NUMBER }],
    // 1-based inclusive slice `arr[lo:hi]` (pg array slice semantics).
    ARRAY,
    (a) => {
      const arr = elements(a, 'arr');
      const lo = intArg(a, 'lo', 1);
      const hi = intArg(a, 'hi', arr.length);
      return Value.of(arr.slice(Math.max(0, lo - 1), hi));
    },
  ),
  scalar('arrayRemove', "Array with every occurrence of `value` removed.", [{ name: 'arr', type: ARRAY }, { name: 'value', type: ANY }], ARRAY, (a) => {
    const target = arg(a, 'value');
    return Value.of(elements(a, 'arr').filter((el) => !Value.of(el).identical(target)));
  }),
  scalar('arrayDistinct', "Array with duplicate elements removed.", [{ name: 'arr', type: ARRAY }], ARRAY, (a) => {
    const seen = new Set<string>();
    const out: JsonValue[] = [];
    for (const el of elements(a, 'arr')) {
      const key = JSON.stringify(el);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(el);
    }
    return Value.of(out);
  }),
  scalar('arrayToString', "Join the array’s non-null elements with `sep`.",
    [{ name: 'arr', type: ARRAY }, { name: 'sep', type: TEXT }],
    TEXT,
    // Non-null elements joined by `sep` (pg `array_to_string` drops NULLs).
    (a) =>
      Value.of(
        elements(a, 'arr')
          .filter((el) => el !== null)
          .map((el) => Value.of(el).toText())
          .join(arg(a, 'sep').toText()),
      ),
  ),
  scalar('stringToArray', "Split `str` on `sep` into an array.",
    [{ name: 'str', type: TEXT }, { name: 'sep', type: TEXT }],
    ARRAY,
    // Split `str` on `sep` (pg `string_to_array`).
    (a) => Value.of(arg(a, 'str').toText().split(arg(a, 'sep').toText())),
  ),
];

// ─── Aggregate library ───────────────────────────────────────────────────────

/** The non-null `value` args across a group's rows. */
function aggValues(rows: readonly NamedArgs[]): Value[] {
  const out: Value[] = [];
  for (const r of rows) {
    const v = r['value'];
    if (v && !v.isNull()) out.push(v);
  }
  return out;
}

const countRun: AggregateRun = (rows) => {
  // `count(*)` arrives as rows that carry no `value` arg → count the rows;
  // `count(value)` counts the non-null values.
  const counted = rows.some((r) => 'value' in r);
  if (!counted) return Value.of(rows.length);
  return Value.of(aggValues(rows).length);
};

const sumRun: AggregateRun = (rows) => {
  const vals = aggValues(rows);
  if (vals.length === 0) return Value.null();
  return Value.of(vals.reduce((acc, v) => acc + v.toNumber(), 0));
};

const avgRun: AggregateRun = (rows) => {
  const vals = aggValues(rows);
  if (vals.length === 0) return Value.null();
  return Value.of(vals.reduce((acc, v) => acc + v.toNumber(), 0) / vals.length);
};

const minRun: AggregateRun = (rows) => {
  const vals = aggValues(rows);
  if (vals.length === 0) return Value.null();
  return vals.reduce((best, v) => (v.compareTo(best) < 0 ? v : best));
};

const maxRun: AggregateRun = (rows) => {
  const vals = aggValues(rows);
  if (vals.length === 0) return Value.null();
  return vals.reduce((best, v) => (v.compareTo(best) > 0 ? v : best));
};

/** Sample mean of a numeric value list. */
function mean(nums: readonly number[]): number {
  return nums.reduce((acc, n) => acc + n, 0) / nums.length;
}

/** Sample variance (n-1 denominator) of the rows' numeric values, or NULL for
 *  n < 2 (a single value has no sample spread). */
function sampleVariance(rows: readonly NamedArgs[]): number | null {
  const nums = aggValues(rows).map((v) => v.toNumber());
  if (nums.length < 2) return null;
  const m = mean(nums);
  return nums.reduce((acc, n) => acc + (n - m) ** 2, 0) / (nums.length - 1);
}

/** Sample variance, NULL for n < 2. */
const varianceRun: AggregateRun = (rows) => {
  const v = sampleVariance(rows);
  return v === null ? Value.null() : Value.of(v);
};

/** Sample standard deviation (√ sample variance), NULL for n < 2. */
const stddevRun: AggregateRun = (rows) => {
  const v = sampleVariance(rows);
  return v === null ? Value.null() : Value.of(Math.sqrt(v));
};

/** Concatenate non-null `value`s with the per-group `sep` (NULL over empty). */
const stringAggRun: AggregateRun = (rows) => {
  const parts: string[] = [];
  let sep = ',';
  for (const r of rows) {
    if (r['sep']) sep = r['sep'].toText();
    const v = r['value'];
    if (v && !v.isNull()) parts.push(v.toText());
  }
  return parts.length === 0 ? Value.null() : Value.of(parts.join(sep));
};

/** Collect every row's `value` (NULLs included) into an array (NULL over empty). */
const arrayAggRun: AggregateRun = (rows) => {
  if (rows.length === 0) return Value.null();
  return Value.of(rows.map((r) => (r['value'] ? r['value'].raw : null)));
};

/** Logical AND / OR (`dir` = 'and' / 'or') over the non-null bool `value`s. */
function boolAggRun(dir: 'and' | 'or'): AggregateRun {
  return (rows) => {
    const vals = aggValues(rows);
    if (vals.length === 0) return Value.null();
    return Value.of(dir === 'and' ? vals.every((v) => v.toBoolean()) : vals.some((v) => v.toBoolean()));
  };
}

/** Count rows whose `cond` is a non-null truthy value. */
const countIfRun: AggregateRun = (rows) => {
  let n = 0;
  for (const r of rows) {
    const c = r['cond'];
    if (c && !c.isNull() && c.toBoolean()) n++;
  }
  return Value.of(n);
};

/** Build an aggregate builtin entry. `instructions` is the terse LLM-facing
 *  usage note; `sql` overrides the emitted call name. */
function aggregate(
  name: string,
  instructions: string,
  params: FunctionDef['params'],
  output: FunctionDef['output'],
  run: AggregateRun,
  sql?: string,
  examples?: readonly string[],
): BuiltinFunction {
  return {
    def: {
      name,
      shape: 'aggregate',
      instructions,
      ...(examples ? { examples } : {}),
      params,
      output,
      ...(sql ? { sql } : {}),
    },
    run: { shape: 'aggregate', run },
  };
}

const AGGREGATES: readonly BuiltinFunction[] = [
  aggregate('count', "Count ROWS when `value` is omitted (the `count(*)` form — EMPTY args), or the non-null values of `value` when supplied.", [{ name: 'value', type: ANY, optional: true }], WHOLE, countRun, undefined,
    [aggExample('count', {})],
  ),
  aggregate('sum', "Sum of the non-null values.", [{ name: 'value', type: NUMBER }], 'inferred', sumRun),
  aggregate('avg', "Mean of the non-null values.", [{ name: 'value', type: NUMBER }], NUMBER, avgRun),
  aggregate('min', "Smallest non-null value.", [{ name: 'value', type: ANY }], 'inferred', minRun),
  aggregate('max', "Largest non-null value.", [{ name: 'value', type: ANY }], 'inferred', maxRun),
  // ─── Group 2d: statistical / collecting aggregates ─────────────────────────
  // `stddev`/`variance` are the SAMPLE (n-1) forms and emit `name(args)` on both
  // dialects. `stringAgg`/`arrayAgg`/`boolAnd`/`boolOr` are postgres-native; the
  // base dialect degrades (see the dialects). `countIf` emits the portable
  // `sum(CASE WHEN cond THEN 1 ELSE 0 END)` on both dialects.
  aggregate('stddev', "Sample standard deviation (n−1), NULL for fewer than 2 values.", [{ name: 'value', type: NUMBER }], NUMBER, stddevRun),
  aggregate('variance', "Sample variance (n−1), NULL for fewer than 2 values.", [{ name: 'value', type: NUMBER }], NUMBER, varianceRun),
  aggregate('stringAgg', "Concatenate non-null values with `sep`.",
    [{ name: 'value', type: ANY }, { name: 'sep', type: TEXT }],
    TEXT,
    stringAggRun,
    'string_agg',
  ),
  aggregate('arrayAgg', "Collect every value into an array.", [{ name: 'value', type: ANY }], ARRAY, arrayAggRun, 'array_agg'),
  aggregate('boolAnd', "True when every non-null value is true.", [{ name: 'value', type: BOOL }], BOOL, boolAggRun('and'), 'bool_and'),
  aggregate('boolOr', "True when any non-null value is true.", [{ name: 'value', type: BOOL }], BOOL, boolAggRun('or'), 'bool_or'),
  aggregate('countIf', "Count rows where `cond` is true.", [{ name: 'cond', type: BOOL }], WHOLE, countIfRun),
];

// ─── Window library ──────────────────────────────────────────────────────────

/** A partition row's ORDER-BY signature (from the injected `$order` arg). */
function orderSig(row: NamedArgs): string {
  const v = row[WINDOW_ORDER_ARG];
  return JSON.stringify(v ? v.raw : null);
}

const rowNumberRun: WindowRun = (_partition, index) => Value.of(index + 1);

const rankRun: WindowRun = (partition, index) => {
  const target = orderSig(partition[index] ?? {});
  let first = index;
  while (first > 0 && orderSig(partition[first - 1] ?? {}) === target) first--;
  return Value.of(first + 1);
};

const denseRankRun: WindowRun = (partition, index) => {
  const distinct = new Set<string>();
  for (let i = 0; i <= index; i++) distinct.add(orderSig(partition[i] ?? {}));
  return Value.of(distinct.size);
};

/** Shared lag/lead implementation; `dir` = -1 for lag, +1 for lead. */
function offsetRun(dir: 1 | -1): WindowRun {
  return (partition, index) => {
    const cur = partition[index] ?? {};
    const offset = cur['offset'] ? Math.trunc(cur['offset'].toNumber()) : 1;
    const target = partition[index + dir * offset];
    const value = target?.['value'];
    if (value && !value.isNull()) return value;
    return cur['default'] ?? Value.null();
  };
}

/** The 0-based offset of the first partition row sharing `index`'s order key.
 *  `index` is always in range (the dispatcher clamps it), so slots are defined. */
function peerStart(partition: readonly NamedArgs[], index: number): number {
  const target = orderSig(partition[index]);
  let first = index;
  while (first > 0 && orderSig(partition[first - 1]) === target) first--;
  return first;
}

/** The 0-based offset of the LAST partition row sharing `index`'s order key. */
function peerEnd(partition: readonly NamedArgs[], index: number): number {
  const target = orderSig(partition[index]);
  let last = index;
  while (last + 1 < partition.length && orderSig(partition[last + 1]) === target) last++;
  return last;
}

/** `percent_rank` = (rank − 1) / (N − 1); 0 for a single-row partition. */
const percentRankRun: WindowRun = (partition, index) => {
  const n = partition.length;
  if (n <= 1) return Value.of(0);
  return Value.of(peerStart(partition, index) / (n - 1));
};

/** `cume_dist` = (# rows ordered ≤ current) / N. */
const cumeDistRun: WindowRun = (partition, index) =>
  Value.of((peerEnd(partition, index) + 1) / partition.length);

/** `ntile(n)` — the 1-based bucket of the current row over `n` equal buckets
 *  (earlier buckets take the remainder), NULL when `n` ≤ 0. */
const ntileRun: WindowRun = (partition, index) => {
  const cur = partition[index];
  const buckets = cur['n'] ? Math.trunc(cur['n'].toNumber()) : 1;
  if (buckets <= 0) return Value.null();
  const total = partition.length;
  const base = Math.floor(total / buckets);
  const rem = total % buckets;
  const bigCount = rem * (base + 1);
  if (index < bigCount) return Value.of(Math.floor(index / (base + 1)) + 1);
  return Value.of(rem + Math.floor((index - bigCount) / base) + 1);
};

/** `first_value(value)` — the first partition row's `value`. */
const firstValueRun: WindowRun = (partition) => partition[0]?.['value'] ?? Value.null();

/** `last_value(value)` — the LAST partition row's `value` (full-partition frame;
 *  diverges from pg's default running frame, which stops at the current row). */
const lastValueRun: WindowRun = (partition) =>
  partition[partition.length - 1]?.['value'] ?? Value.null();

/** `nth_value(value, n)` — the 1-based n-th partition row's `value` (NULL if out
 *  of range). */
const nthValueRun: WindowRun = (partition, index) => {
  const cur = partition[index];
  const nth = cur['n'] ? Math.trunc(cur['n'].toNumber()) : 1;
  return partition[nth - 1]?.['value'] ?? Value.null();
};

/** Build a window builtin entry. `instructions` is the terse LLM-facing usage
 *  note. `sql` overrides the emitted call name (e.g. `rowNumber` →
 *  `row_number`) when the SQL name differs from the declared camelCase name. */
function window(
  name: string,
  instructions: string,
  params: FunctionDef['params'],
  output: FunctionDef['output'],
  run: WindowRun,
  sql?: string,
  examples?: readonly string[],
): BuiltinFunction {
  return {
    def: {
      name,
      shape: 'window',
      instructions,
      ...(examples ? { examples } : {}),
      params,
      output,
      ...(sql ? { sql } : {}),
    },
    run: { shape: 'window', run },
  };
}

const OFFSET_PARAMS: FunctionDef['params'] = [
  { name: 'value', type: ANY },
  { name: 'offset', type: NUMBER, optional: true },
  { name: 'default', type: ANY, optional: true },
];

const WINDOWS: readonly BuiltinFunction[] = [
  window('rowNumber', "Sequential 1-based number of the row within its ordered partition.", [], WHOLE, rowNumberRun, 'row_number'),
  window('rank', "Rank within the ordered partition, with GAPS after ties (1,2,2,4). `orderBy` sets the ranking key; `partitionBy` ranks WITHIN each group (OMIT it to rank all rows together).", [], WHOLE, rankRun, undefined,
    [windowExample('rank', {}, { partition: true })],
  ),
  window('denseRank', "Rank within the ordered partition, NO gaps after ties (1,2,2,3). `orderBy` is the ranking key; `partitionBy` splits into independent groups (OMIT to rank all rows together).", [], WHOLE, denseRankRun, 'dense_rank',
    [windowExample('denseRank', {})],
  ),
  window('lag', "`value` from the row `offset` (default 1) BEFORE the current one in the ordered partition (`default` when none). `orderBy` sets the sequence; `partitionBy` scopes 'before' to each group.", OFFSET_PARAMS, 'inferred', offsetRun(-1), undefined,
    [windowExample('lag', { value: ref('event', 'score') })],
  ),
  window('lead', "`value` from the row `offset` (default 1) AFTER the current one in the ordered partition (`default` when none). `orderBy` sets the sequence; `partitionBy` scopes 'after' to each group.", OFFSET_PARAMS, 'inferred', offsetRun(1), undefined,
    [windowExample('lead', { value: ref('event', 'score') })],
  ),
  // ─── Group 2d: ranking / positional window functions ───────────────────────
  // All emit the generic `name(args)` form via the SQL-name override.
  window('percentRank', "Relative rank (rank−1)/(N−1) in [0, 1].", [], NUMBER, percentRankRun, 'percent_rank'),
  window('cumeDist', "Cumulative distribution: fraction of partition rows ordered ≤ the current, in (0,1]. `orderBy` sets the order; `partitionBy` computes it per group.", [], NUMBER, cumeDistRun, 'cume_dist',
    [windowExample('cumeDist', {})],
  ),
  window('ntile', "Bucket number (1..n) splitting the ordered partition into n groups.", [{ name: 'n', type: NUMBER }], WHOLE, ntileRun),
  window('firstValue', "First `value` in the ordered partition. `orderBy` sets the order; `partitionBy` gives the first per group.", [{ name: 'value', type: ANY }], 'inferred', firstValueRun, 'first_value',
    [windowExample('firstValue', { value: ref('event', 'score') })],
  ),
  window('lastValue', "Last `value` in the ordered partition (full-partition frame). `orderBy` sets the order; `partitionBy` gives the last per group.", [{ name: 'value', type: ANY }], 'inferred', lastValueRun, 'last_value',
    [windowExample('lastValue', { value: ref('event', 'score') })],
  ),
  window('nthValue', "The 1-based `n`-th `value` in the ordered partition, NULL if out of range. `orderBy` sets the order; `partitionBy` scopes to each group.",
    [{ name: 'value', type: ANY }, { name: 'n', type: NUMBER }],
    'inferred',
    nthValueRun,
    'nth_value',
    [windowExample('nthValue', { value: ref('event', 'score'), n: litExpr(2) })],
  ),
];

// ─── Aggregated export ───────────────────────────────────────────────────────

/** Every builtin function (declaration + runtime), across all four shapes. */
export const BUILTIN_LIBRARY: readonly BuiltinFunction[] = [
  ...SCALARS,
  ...AGGREGATES,
  ...WINDOWS,
];
