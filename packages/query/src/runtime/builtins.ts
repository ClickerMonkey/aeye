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
import type { FieldTypeDef, FunctionDef, JsonValue } from '../schema';
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
const ARRAY: FieldTypeDef = { kind: 'array' };

/** Read a named arg, defaulting to NULL when absent. */
function arg(args: NamedArgs, name: string): Value {
  return args[name] ?? Value.null();
}

/** The raw elements of an array-valued named arg (empty for a non-array). */
function elements(args: NamedArgs, name: string): readonly JsonValue[] {
  const raw = arg(args, name).raw;
  return Array.isArray(raw) ? raw : [];
}

/** Apply a unary math op, returning NULL for non-numbers. */
function numeric(v: Value, fn: (n: number) => number): Value {
  if (v.isNull()) return Value.null();
  const n = v.toNumber();
  if (Number.isNaN(n)) return Value.null();
  return Value.of(fn(n));
}

/** greatest (dir=1) / least (dir=-1) over the non-null `values`. */
function extremum(values: readonly Value[], dir: 1 | -1): Value {
  const present = values.filter((v) => !v.isNull());
  if (present.length === 0) return Value.null();
  return present.reduce((best, v) => (v.compareTo(best) * dir > 0 ? v : best));
}

/** Build a scalar builtin entry. */
function scalar(
  name: string,
  params: FunctionDef['params'],
  output: FunctionDef['output'],
  run: ScalarRun,
  sql?: string,
): BuiltinFunction {
  /* v8 ignore next -- no shipped builtin scalar declares a `sql` template, so the `sql ?` true-branch is unreachable */
  return { def: { name, shape: 'scalar', params, output, ...(sql ? { sql } : {}) }, run: { shape: 'scalar', run } };
}

// ─── Scalar library ──────────────────────────────────────────────────────────

const SCALARS: readonly BuiltinFunction[] = [
  scalar('concat', [{ name: 'values', type: ARRAY }], TEXT, (a) =>
    Value.of(elements(a, 'values').map((e) => Value.of(e).toText()).join('')),
  ),
  scalar('lower', [{ name: 'value', type: TEXT }], TEXT, (a) =>
    Value.of(arg(a, 'value').toText().toLowerCase()),
  ),
  scalar('upper', [{ name: 'value', type: TEXT }], TEXT, (a) =>
    Value.of(arg(a, 'value').toText().toUpperCase()),
  ),
  scalar('trim', [{ name: 'value', type: TEXT }], TEXT, (a) =>
    Value.of(arg(a, 'value').toText().trim()),
  ),
  scalar('length', [{ name: 'value', type: TEXT }], WHOLE, (a) =>
    Value.of(arg(a, 'value').toText().length),
  ),
  scalar(
    'substring',
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
  scalar(
    'replace',
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
  ),
  scalar('abs', [{ name: 'value', type: NUMBER }], NUMBER, (a) => numeric(arg(a, 'value'), Math.abs)),
  scalar('ceil', [{ name: 'value', type: NUMBER }], NUMBER, (a) => numeric(arg(a, 'value'), Math.ceil)),
  scalar('floor', [{ name: 'value', type: NUMBER }], NUMBER, (a) => numeric(arg(a, 'value'), Math.floor)),
  scalar('round', [{ name: 'value', type: NUMBER }], NUMBER, (a) => numeric(arg(a, 'value'), Math.round)),
  scalar('sqrt', [{ name: 'value', type: NUMBER }], NUMBER, (a) => numeric(arg(a, 'value'), Math.sqrt)),
  scalar(
    'power',
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
  scalar('coalesce', [{ name: 'values', type: ARRAY }], 'inferred', (a) => {
    for (const e of elements(a, 'values')) {
      if (e !== null) return Value.of(e);
    }
    return Value.null();
  }),
  scalar(
    'nullif',
    [
      { name: 'value', type: ANY },
      { name: 'other', type: ANY },
    ],
    'inferred',
    (a) => (arg(a, 'value').equals(arg(a, 'other')) ? Value.null() : arg(a, 'value')),
  ),
  scalar('greatest', [{ name: 'values', type: ARRAY }], 'inferred', (a) =>
    extremum(elements(a, 'values').map((e) => Value.of(e)), 1),
  ),
  scalar('least', [{ name: 'values', type: ARRAY }], 'inferred', (a) =>
    extremum(elements(a, 'values').map((e) => Value.of(e)), -1),
  ),
  scalar('arrayLength', [{ name: 'arr', type: ARRAY }], WHOLE, (a) =>
    Value.of(elements(a, 'arr').length),
  ),
  scalar('now', [], { kind: 'timestamp' }, () => Value.of(new Date().toISOString())),
  scalar('current_date', [], { kind: 'date' }, () => {
    const iso = new Date().toISOString();
    /* v8 ignore next -- `toISOString()` always contains 'T', so `split('T')[0]` is always defined; the `?? iso` is dead */
    return Value.of(iso.split('T')[0] ?? iso);
  }),
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

/** Build an aggregate builtin entry. */
function aggregate(
  name: string,
  params: FunctionDef['params'],
  output: FunctionDef['output'],
  run: AggregateRun,
): BuiltinFunction {
  return { def: { name, shape: 'aggregate', params, output }, run: { shape: 'aggregate', run } };
}

const AGGREGATES: readonly BuiltinFunction[] = [
  aggregate('count', [{ name: 'value', type: ANY, optional: true }], WHOLE, countRun),
  aggregate('sum', [{ name: 'value', type: NUMBER }], 'inferred', sumRun),
  aggregate('avg', [{ name: 'value', type: NUMBER }], NUMBER, avgRun),
  aggregate('min', [{ name: 'value', type: ANY }], 'inferred', minRun),
  aggregate('max', [{ name: 'value', type: ANY }], 'inferred', maxRun),
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

/** Build a window builtin entry. */
function window(
  name: string,
  params: FunctionDef['params'],
  output: FunctionDef['output'],
  run: WindowRun,
): BuiltinFunction {
  return { def: { name, shape: 'window', params, output }, run: { shape: 'window', run } };
}

const OFFSET_PARAMS: FunctionDef['params'] = [
  { name: 'value', type: ANY },
  { name: 'offset', type: NUMBER, optional: true },
  { name: 'default', type: ANY, optional: true },
];

const WINDOWS: readonly BuiltinFunction[] = [
  window('row_number', [], WHOLE, rowNumberRun),
  window('rank', [], WHOLE, rankRun),
  window('dense_rank', [], WHOLE, denseRankRun),
  window('lag', OFFSET_PARAMS, 'inferred', offsetRun(-1)),
  window('lead', OFFSET_PARAMS, 'inferred', offsetRun(1)),
];

// ─── Aggregated export ───────────────────────────────────────────────────────

/** Every builtin function (declaration + runtime), across all four shapes. */
export const BUILTIN_LIBRARY: readonly BuiltinFunction[] = [
  ...SCALARS,
  ...AGGREGATES,
  ...WINDOWS,
];
