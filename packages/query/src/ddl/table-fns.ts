/**
 * Generated functions for a table: every handy fn a table's columns, keys and
 * relations make possible, each a checked `QueryDef` with its args type and
 * signature. No model is involved: the same tables always give the same fns.
 *
 * - **CRUD**: `create`, `update` and `remove` by key, `updateWhere` and
 *   `removeWhere` by equality on any column, `selectOne` by key or by each
 *   unique column, `selectPage` with optional equality filters, sorting and
 *   paging (and, on request, derived columns to show, sort and filter on).
 * - **Column helpers**: counts per value of an enum, bool or foreign key, stats
 *   (count, sum, avg, min, max) of a number column, counts per day, week or
 *   month of a date column, `exists` and `findOrCreate` by a unique column,
 *   the children of a parent and the count of children per parent.
 * - **Derived fields**, computed in SQL and offered as fns:
 *   - from a has-many relation: the count, and sum, avg, min and max of each
 *     number column (min and max of each date column), again split per value
 *     of each enum column (`projectStatusDoneCount`);
 *   - from a belongs-to relation: the parent's fields and its own derived
 *     fields (`ownerProjectAvgValue`), repeated up to `depth` relation hops;
 *   - over the whole table: total, avg, min and max of each number column;
 *   - normalized comparisons of each number column, over the whole table and
 *     among the siblings under the same parent: rank, percentile
 *     (rank / count), share (value / sum), position ((value - min) / (max -
 *     min)) and value / max, each labelled with what it means.
 *
 * Every derived field records the table and column its values come from, and a
 * ratio is only built from a numerator and denominator over the same table and
 * column (`ratio`); anything else is refused with a `TableFnError`.
 *
 * Median is left out: SQLite and SQL Server have no portable median aggregate.
 */
import { createRegistry } from '../registry';
import { QueryEngine } from '../engine';
import type { ExprDef, FieldTypeDef, InsertRowDef, JoinDef, JsonValue, QueryDef, SelectDef, SelectFieldDef, SetDef } from '../schema';
import { queryArgsType, signatureText, type QueryPaging } from '../signature';
import type { TypeDef as GinTypeDef } from '@aeye/gin';
import type { ColumnSpec, TableSpec } from './table';
import { scalarFieldType, tableToQueryType } from './query-type';

/** What a generated fn does, which also says how its query is built. */
export type TableFnKind =
  | 'create' | 'update' | 'updateWhere' | 'remove' | 'removeWhere' | 'selectOne' | 'selectPage'
  | 'countBy' | 'stats' | 'buckets' | 'exists' | 'findOrCreate' | 'childrenOf' | 'countPerParent' | 'derived';

/** What a normalized value means: a plain measure, progress through an order, a portion of a whole, or a relative place. */
export type DerivedMeaning = 'measure' | 'progress' | 'portion' | 'relative';

/** How a derived field is measured. */
export type DerivedMeasure = 'value' | 'count' | 'sum' | 'avg' | 'min' | 'max' | 'rank' | 'percentile' | 'share' | 'position' | 'ofMax';

/** A value computed for each row of a table from its relations or the whole table. */
export interface DerivedField {
  /** Its name, also the column and fn name (`projectAvgValue`). */
  readonly name: string;
  readonly about: string;
  readonly meaning: DerivedMeaning;
  readonly measure: DerivedMeasure;
  /** The table and column its values come from (`column` is null for a count of rows). */
  readonly table: string;
  readonly column: string | null;
  /** The relations crossed to reach them, in order (empty for the table's own rows). */
  readonly via: readonly string[];
}

/** How a fn changes data. */
export type TableFnMode = 'read' | 'write' | 'delete';

/** What the query of a fn is built from: JSON, so it can be stored and rebuilt. */
export interface TableFnOp {
  readonly kind: TableFnKind;
  readonly table: string;
  /** The column it is about (stats, counts, buckets, a unique lookup), or the foreign key (children, counts per parent). */
  readonly column?: string;
  /** The child table, for `childrenOf` and `countPerParent`. */
  readonly child?: string;
  /** The date bucket, for `buckets`. */
  readonly bucket?: 'day' | 'week' | 'month';
  /** Derived fields to add (`selectPage`), or the one a `derived` fn reads. */
  readonly derived?: readonly string[];
}

/** One generated fn. */
export interface TableFn {
  /** Its name within the table (`selectPage`, `projectCount`). */
  readonly name: string;
  readonly table: string;
  readonly kind: TableFnKind;
  readonly about: string;
  /** Its group: `crud`, `columns`, `table`, or the relation it comes from. */
  readonly group: string;
  /** Lower comes first: the most useful fns of a group lead. */
  readonly rank: number;
  readonly mode: TableFnMode;
  readonly op: TableFnOp;
  readonly query: QueryDef;
  /** Its args as a gin `obj` (params, then paging and sort). */
  readonly args: GinTypeDef;
  /** One line: `selectPage(status?: "active" | "done", limit?: num, …)`. */
  readonly signature: string;
  /** It reads a list, so callers page it. */
  readonly list: boolean;
  /** Output columns a caller may sort by. */
  readonly sorters: readonly string[];
  /** Params a caller may leave out (bound as null: no filter, no change). */
  readonly optional: readonly string[];
  /** Constant defaults of args a caller may leave out (`withArgDefaults` fills them before binding). */
  readonly defaults: Readonly<Record<string, JsonValue>>;
  readonly derived?: DerivedField;
}

/** A table's generated fns, the most useful first, capped. */
export interface TableFnList {
  readonly table: string;
  /** A hash of the table and every table it relates to: when it changes, regenerate. */
  readonly hash: string;
  readonly fns: readonly TableFn[];
  /** How many fns were left out past the cap. */
  readonly more: number;
}

/** What `tableFns` takes besides the tables. */
export interface TableFnOptions {
  /** How many relation hops derived fields follow (default 2). */
  readonly depth?: number;
  /** The most fns listed (default 60); the rest are counted in `more`. */
  readonly cap?: number;
  /** Paging for list fns (default max 500, page 50). */
  readonly paging?: QueryPaging;
}

/** A combination the generators refuse (an incompatible ratio, an unknown table, column or derived field). */
export class TableFnError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TableFnError';
  }
}

/** Whether a numerator and denominator measure the same table and column, so their ratio means something. */
export function canCompare(numerator: Pick<DerivedField, 'table' | 'column'>, denominator: Pick<DerivedField, 'table' | 'column'>): boolean {
  return numerator.table === denominator.table && numerator.column === denominator.column;
}

/** `numerator / denominator` as a decimal, NULL over zero; refused unless they measure the same table and column. */
export function ratio(
  numerator: { readonly expr: ExprDef; readonly table: string; readonly column: string | null },
  denominator: { readonly expr: ExprDef; readonly table: string; readonly column: string | null },
): ExprDef {
  if (!canCompare(numerator, denominator)) {
    throw new TableFnError(
      `${numerator.table}.${numerator.column ?? '*'} can't be divided by ${denominator.table}.${denominator.column ?? '*'}: a ratio needs the same table and column on both sides.`,
    );
  }
  return div(numerator.expr, denominator.expr);
}

/** Every fn a table could have, the most useful first, capped. */
export function tableFns(table: string, tables: readonly TableSpec[], options: TableFnOptions = {}): TableFnList {
  return new TableFnSchema(tables, options).list(table);
}

/** The query of one fn, rebuilt from its op (with other derived columns, say). */
export function tableFnQuery(op: TableFnOp, tables: readonly TableSpec[], options: TableFnOptions = {}): TableFn {
  return new TableFnSchema(tables, options).fn(op);
}

/** A stable hash of a table and the tables it relates to (FNV-1a over their canonical JSON). */
export function tableSchemaHash(table: string, tables: readonly TableSpec[]): string {
  const own = tables.find((t) => t.name === table);
  if (!own) throw new TableFnError(`There is no table ${table}.`);
  const related = tables.filter((t) => t.name === table || own.foreignKeys.some((f) => f.table === t.name) || t.foreignKeys.some((f) => f.table === table));
  const text = stableJson([...related].sort((a, b) => (a.name < b.name ? -1 : 1)));
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i++) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, '0');
}

/** JSON with object keys sorted, so equal values give equal text. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (typeof value !== 'object' || value === null) return JSON.stringify(value) ?? 'null';
  const entries = Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : 1));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
}

// ─── Expression helpers ───────────────────────────────────────────────────────

const ref = (source: string, field: string): ExprDef => ({ kind: 'field-ref', source, field });
const lit = (value: JsonValue): ExprDef => ({ kind: 'literal', value });
const param = (name: string): ExprDef => ({ kind: 'param', name });
const eq = (left: ExprDef, right: ExprDef): ExprDef => ({ kind: 'comparison', op: '=', left, right });
const cmp = (op: '>=' | '<=', left: ExprDef, right: ExprDef): ExprDef => ({ kind: 'comparison', op, left, right });
const isNull = (value: ExprDef): ExprDef => ({ kind: 'is-null', value });
/** `:p IS NULL OR <test>`: a filter the caller may leave out. */
const maybe = (name: string, test: ExprDef): ExprDef => ({ kind: 'logical', op: 'or', operands: [isNull(param(name)), test] });
const agg = (fn: string, value?: ExprDef): ExprDef => ({ kind: 'aggregate', function: fn, args: value === undefined ? {} : { value } });
const win = (fn: string, value: ExprDef | undefined, partitionBy: ExprDef[], orderBy?: ExprDef): ExprDef => ({
  kind: 'window',
  function: fn,
  args: value === undefined ? {} : { value },
  ...(partitionBy.length > 0 ? { partitionBy } : {}),
  ...(orderBy === undefined ? {} : { orderBy: [{ expr: orderBy, dir: 'desc' as const, nulls: 'last' as const }] }),
});
const sub = (a: ExprDef, b: ExprDef): ExprDef => ({ kind: 'binary', op: '-', left: a, right: b });
/** A decimal division, NULL when the denominator is zero. */
function div(a: ExprDef, b: ExprDef): ExprDef {
  return {
    kind: 'binary',
    op: '/',
    left: { kind: 'binary', op: '*', left: a, right: lit(1.0) },
    right: { kind: 'function-call', function: 'nullif', args: { value: b, other: lit(0) } },
  };
}

// ─── Words ────────────────────────────────────────────────────────────────────

const words = (name: string): string[] => name.replace(/([a-z0-9])([A-Z])/gu, '$1 $2').split(/[^A-Za-z0-9]+/u).filter((w) => w.length > 0).map((w) => w.toLowerCase());
const cap = (word: string): string => (word.length === 0 ? word : `${word[0]!.toUpperCase()}${word.slice(1)}`);
/** `customer_id` → `customerId`. */
const camel = (name: string): string => words(name).map((w, i) => (i === 0 ? w : cap(w))).join('');
/** `projects` → `project`, `categories` → `category` (plain English plurals only). */
function singular(name: string): string {
  if (/ies$/u.test(name)) return `${name.slice(0, -3)}y`;
  if (/(s|x|ch|sh)es$/u.test(name)) return name.slice(0, -2);
  if (/[^s]s$/u.test(name)) return name.slice(0, -1);
  return name;
}
/** The relation word of a foreign key column: `owner_id` → `owner`. */
const relWord = (column: string): string => camel(column.replace(/(_id|Id|_key)$/u, ''));
/** A value as a name part: `in progress` → `InProgress`. */
const valueWord = (value: string | number): string => cap(camel(String(value))) || 'Empty';
const human = (name: string): string => words(name).join(' ');

// ─── Relations ────────────────────────────────────────────────────────────────

/** A table's single-column foreign key onto another table's single-column key. */
interface BelongsTo {
  /** The relation word (`owner`). */
  readonly word: string;
  readonly column: string;
  readonly parent: TableSpec;
  readonly key: string;
}

/** Another table's foreign key onto this one. */
interface HasMany {
  /** The relation word (`project`, or `projectByReviewer` when one table points here twice). */
  readonly word: string;
  readonly child: TableSpec;
  readonly column: string;
}

const isNumber = (c: ColumnSpec): boolean => ['integer', 'decimal', 'float'].includes(c.type.kind);
const isDate = (c: ColumnSpec): boolean => c.type.kind === 'date' || c.type.kind === 'timestamp';
const isEnum = (c: ColumnSpec): boolean => c.values !== undefined && c.values.length <= 12;
const keyOf = (t: TableSpec): string | undefined => (t.primaryKey.length === 1 ? t.primaryKey[0] : undefined);

/** Collects the joins an inner select needs, one per belongs-to crossing, and fresh aliases. */
class JoinSet {
  readonly joins: JoinDef[] = [];
  readonly #parents = new Map<string, string>();
  #next = 0;

  fresh(prefix: string): string {
    this.#next += 1;
    return `${prefix}${this.#next}`;
  }

  /** The alias of `alias`'s parent across `column`, joining it the first time. */
  parent(alias: string, column: string): string {
    const key = `${alias}.${column}`;
    const known = this.#parents.get(key);
    if (known !== undefined) return known;
    const as = this.fresh('p');
    this.joins.push({ on: { kind: 'relation', source: alias, field: column, as }, joinType: 'left' });
    this.#parents.set(key, as);
    return as;
  }
}

/** A derived field and how to compute it for a row bound under an alias. */
interface Derivation {
  readonly field: DerivedField;
  readonly rank: number;
  readonly group: string;
  build(joins: JoinSet, alias: string): ExprDef;
}

// ─── The schema ───────────────────────────────────────────────────────────────

const DEFAULT_PAGING: QueryPaging = { max: 500, page: 50 };

/** Tables, their relations, and an engine to check every generated query. */
export class TableFnSchema {
  readonly #tables: ReadonlyMap<string, TableSpec>;
  readonly #engine: QueryEngine;
  readonly #depth: number;
  readonly #cap: number;
  readonly #paging: QueryPaging;

  constructor(tables: readonly TableSpec[], options: TableFnOptions = {}) {
    this.#tables = new Map(tables.map((t) => [t.name, t]));
    const registry = createRegistry();
    for (const t of tables) registry.registerType(registry.parseType(tableToQueryType(t, { tables })));
    registry.finalize();
    this.#engine = new QueryEngine(registry);
    this.#depth = options.depth ?? 2;
    this.#cap = options.cap ?? 60;
    this.#paging = options.paging ?? DEFAULT_PAGING;
  }

  /** The engine the queries are checked with. */
  get engine(): QueryEngine {
    return this.#engine;
  }

  table(name: string): TableSpec {
    const t = this.#tables.get(name);
    if (!t) throw new TableFnError(`There is no table ${name}.`);
    return t;
  }

  belongsTo(t: TableSpec): BelongsTo[] {
    const out: BelongsTo[] = [];
    for (const fk of t.foreignKeys) {
      const column = fk.columns.length === 1 ? fk.columns[0] : undefined;
      const parent = this.#tables.get(fk.table);
      if (column === undefined || !parent || keyOf(parent) !== fk.references[0]) continue;
      out.push({ word: relWord(column), column, parent, key: fk.references[0]! });
    }
    return out;
  }

  hasMany(t: TableSpec): HasMany[] {
    const key = keyOf(t);
    if (key === undefined) return [];
    const out: HasMany[] = [];
    for (const child of this.#tables.values()) {
      const fks = child.foreignKeys.filter((f) => f.table === t.name && f.columns.length === 1 && f.references[0] === key);
      for (const fk of fks) {
        const base = camel(singular(child.name));
        out.push({ word: fks.length > 1 ? `${base}By${cap(relWord(fk.columns[0]!))}` : base, child, column: fk.columns[0]! });
      }
    }
    return out;
  }

  /** Every derived field of a table (own number columns compared, relations followed to the depth). */
  derivations(t: TableSpec, depth: number = this.#depth, own = true): Derivation[] {
    const out: Derivation[] = [];
    const key = keyOf(t);
    if (key !== undefined && depth >= 1) {
      for (const rel of this.hasMany(t)) out.push(...this.#hasManyFields(t, key, rel));
    }
    if (depth >= 1) {
      for (const rel of this.belongsTo(t)) {
        for (const c of rel.parent.columns) {
          if (c.name === rel.key || this.belongsTo(rel.parent).some((b) => b.column === c.name)) continue;
          out.push({
            field: { name: `${rel.word}${cap(camel(c.name))}`, about: `The ${human(c.name)} of its ${human(rel.word)}.`, meaning: 'measure', measure: 'value', table: rel.parent.name, column: c.name, via: [rel.column] },
            rank: 40,
            group: rel.word,
            build: (joins, alias) => ref(joins.parent(alias, rel.column), c.name),
          });
        }
        for (const d of this.derivations(rel.parent, depth - 1, false)) {
          out.push({
            field: { ...d.field, name: `${rel.word}${cap(d.field.name)}`, about: `Of its ${human(rel.word)}: ${lower(d.field.about)}`, via: [rel.column, ...d.field.via] },
            rank: d.rank + 20,
            group: rel.word,
            build: (joins, alias) => d.build(joins, joins.parent(alias, rel.column)),
          });
        }
      }
    }
    if (own) out.push(...this.#ownComparisons(t));
    return out;
  }

  #hasManyFields(t: TableSpec, key: string, rel: HasMany): Derivation[] {
    const out: Derivation[] = [];
    const child = rel.child;
    const group = rel.word;
    const many = (filter: { column: ColumnSpec; value: string | number } | undefined, measure: DerivedMeasure, column: ColumnSpec | undefined, rank: number): Derivation => {
      const split = filter === undefined ? '' : `${cap(camel(filter.column.name))}${valueWord(filter.value)}`;
      const word = measure === 'sum' ? 'Total' : measure === 'count' ? 'Count' : cap(measure);
      const name = column === undefined ? `${rel.word}${split}Count` : `${rel.word}${split}${word}${cap(camel(column.name))}`;
      const whose = filter === undefined ? `its ${human(child.name)}` : `its ${human(child.name)} with ${human(filter.column.name)} ${String(filter.value)}`;
      const about = column === undefined ? `How many of ${whose} there are.` : `The ${measure === 'sum' ? 'total' : measure} ${human(column.name)} of ${whose}.`;
      return {
        field: { name, about, meaning: 'measure', measure, table: child.name, column: column?.name ?? null, via: [`${child.name}.${rel.column}`] },
        rank,
        group,
        build: (joins, alias) => {
          const s = joins.fresh('s');
          const j = joins.fresh('j');
          const select: SelectDef = {
            kind: 'select',
            fields: [{ expr: column === undefined ? agg('count') : agg(measure, ref(s, column.name)), as: 'v' }],
            from: { kind: 'aliased', type: child.name, as: s },
            joins: [{ on: { kind: 'relation', source: s, field: rel.column, as: j }, joinType: 'inner' }],
            where: [eq(ref(j, key), ref(alias, key)), ...(filter === undefined ? [] : [eq(ref(s, filter.column.name), lit(filter.value))])],
          };
          return { kind: 'subquery', query: select };
        },
      };
    };
    const numbers = child.columns.filter(isNumber).filter((c) => !child.foreignKeys.some((f) => f.columns.includes(c.name)) && !child.primaryKey.includes(c.name));
    const dates = child.columns.filter(isDate);
    const all = (filter: { column: ColumnSpec; value: string | number } | undefined, base: number): Derivation[] => [
      many(filter, 'count', undefined, base),
      ...numbers.flatMap((c) => [many(filter, 'sum', c, base + 1), many(filter, 'avg', c, base + 2), many(filter, 'min', c, base + 5), many(filter, 'max', c, base + 5)]),
      ...dates.flatMap((c) => [many(filter, 'min', c, base + 6), many(filter, 'max', c, base + 6)]),
    ];
    out.push(...all(undefined, 20));
    for (const e of child.columns.filter(isEnum)) {
      for (const value of e.values ?? []) out.push(...all({ column: e, value }, 30));
    }
    return out;
  }

  /** Table-wide totals and the normalized comparisons of each own number column. */
  #ownComparisons(t: TableSpec): Derivation[] {
    const out: Derivation[] = [];
    const numbers = t.columns.filter(isNumber).filter((c) => !t.foreignKeys.some((f) => f.columns.includes(c.name)) && !t.primaryKey.includes(c.name));
    for (const c of numbers) {
      const col = cap(camel(c.name));
      const measured = { table: t.name, column: c.name };
      for (const m of ['sum', 'avg', 'min', 'max'] as const) {
        out.push({
          field: { name: `${m === 'sum' ? 'total' : m}${col}`, about: `The ${m === 'sum' ? 'total' : m} ${human(c.name)} over the whole table.`, meaning: 'measure', measure: m, ...measured, via: [] },
          rank: 35,
          group: 'table',
          build: (_joins, alias) => win(m, ref(alias, c.name), []),
        });
      }
      const scopes: Array<{ word: string; about: string; group: string; partition: (joins: JoinSet, alias: string) => ExprDef[] }> = [
        { word: '', about: 'the whole table', group: 'table', partition: () => [] },
        ...this.belongsTo(t).map((rel) => ({
          word: rel.word,
          about: `its ${human(rel.word)}'s ${human(t.name)}`,
          group: rel.word,
          partition: (joins: JoinSet, alias: string) => [ref(joins.parent(alias, rel.column), rel.key)],
        })),
      ];
      for (const scope of scopes) {
        const pre = scope.word;
        const name = (plain: string, scoped: string): string => (pre === '' ? plain : scoped);
        const compare = (field: Omit<DerivedField, 'table' | 'column' | 'via'>, rank: number, build: (value: ExprDef, part: ExprDef[]) => ExprDef): Derivation => ({
          field: { ...field, ...measured, via: [] },
          rank,
          group: scope.group,
          build: (joins, alias) => build(ref(alias, c.name), scope.partition(joins, alias)),
        });
        const whole = (fn: string, value: ExprDef, part: ExprDef[]) => ({ expr: win(fn, value, part), ...measured });
        out.push(
          compare({ name: name(`relative${col}Rank`, `${pre}Relative${col}Rank`), about: `Its place by ${human(c.name)} among ${scope.about} (1 is the highest).`, meaning: 'relative', measure: 'rank' }, 26, (v, part) => win('rank', undefined, part, v)),
          compare({ name: name(`${camel(c.name)}Percentile`, `${pre}${col}Percentile`), about: `Its rank by ${human(c.name)} over how many there are among ${scope.about} (near 0 is the top).`, meaning: 'progress', measure: 'percentile' }, 27, (v, part) =>
            ratio({ expr: win('rank', undefined, part, v), table: t.name, column: null }, { expr: win('count', undefined, part), table: t.name, column: null })),
          compare({ name: name(`shareOfTotal${col}`, `shareOf${cap(pre)}Total${col}`), about: `Its ${human(c.name)} as a part of the total of ${scope.about} (0 to 1).`, meaning: 'portion', measure: 'share' }, 26, (v, part) =>
            ratio({ expr: v, ...measured }, whole('sum', v, part))),
          compare({ name: name(`${camel(c.name)}Position`, `${pre}${col}Position`), about: `Where its ${human(c.name)} sits between the lowest (0) and highest (1) of ${scope.about}.`, meaning: 'relative', measure: 'position' }, 28, (v, part) =>
            ratio({ expr: sub(v, win('min', v, part)), ...measured }, { expr: sub(win('max', v, part), win('min', v, part)), ...measured })),
          compare({ name: name(`${camel(c.name)}OfMax`, `${pre}${col}OfMax`), about: `Its ${human(c.name)} over the highest of ${scope.about}.`, meaning: 'relative', measure: 'ofMax' }, 28, (v, part) =>
            ratio({ expr: v, ...measured }, whole('max', v, part))),
        );
      }
    }
    return out;
  }

  /** The table's fns, most useful first, capped. */
  list(table: string): TableFnList {
    const t = this.table(table);
    const fns = this.#ops(t).map((op) => this.fn(op)).sort((a, b) => a.rank - b.rank || a.group.localeCompare(b.group) || a.name.localeCompare(b.name));
    return { table, hash: tableSchemaHash(table, [...this.#tables.values()]), fns: fns.slice(0, this.#cap), more: Math.max(0, fns.length - this.#cap) };
  }

  #ops(t: TableSpec): TableFnOp[] {
    const table = t.name;
    const ops: TableFnOp[] = [{ kind: 'selectPage', table }, { kind: 'create', table }];
    if (keyOf(t) !== undefined) ops.push({ kind: 'selectOne', table }, { kind: 'update', table }, { kind: 'remove', table });
    ops.push({ kind: 'updateWhere', table }, { kind: 'removeWhere', table });
    for (const u of t.unique.filter((u) => u.columns.length === 1)) {
      const column = u.columns[0]!;
      ops.push({ kind: 'selectOne', table, column }, { kind: 'exists', table, column }, { kind: 'findOrCreate', table, column });
    }
    for (const c of t.columns) {
      if (isEnum(c) || c.type.kind === 'bool') ops.push({ kind: 'countBy', table, column: c.name });
      if (isNumber(c) && !t.primaryKey.includes(c.name) && !t.foreignKeys.some((f) => f.columns.includes(c.name))) ops.push({ kind: 'stats', table, column: c.name });
      if (isDate(c)) for (const bucket of ['day', 'week', 'month'] as const) ops.push({ kind: 'buckets', table, column: c.name, bucket });
    }
    for (const rel of this.belongsTo(t)) {
      ops.push({ kind: 'countBy', table, column: rel.column });
      if (keyOf(t) !== undefined) ops.push({ kind: 'update', table, column: rel.column });
    }
    for (const rel of this.hasMany(t)) {
      ops.push({ kind: 'childrenOf', table, child: rel.child.name, column: rel.column }, { kind: 'countPerParent', table, child: rel.child.name, column: rel.column });
    }
    for (const d of this.derivations(t)) ops.push({ kind: 'derived', table, derived: [d.field.name] });
    return ops;
  }

  /** One fn from its op: its query (checked), args and signature. Throws `TableFnError` for what it can't build. */
  fn(op: TableFnOp): TableFn {
    const t = this.table(op.table);
    const built = this.#build(t, op);
    const problems = this.#engine.validateQuery(built.query).list.filter((p) => p.severity === 'error');
    if (problems.length > 0) throw new TableFnError(`${op.table}.${built.name} does not check: ${problems.map((p) => `${p.path.join('.')}: ${p.message}`).join('; ')}`);
    const params = this.#engine.parameters(built.query);
    const args = queryArgsType(params, { optional: built.optional, defaults: built.defaults, sorters: built.sorters, ...(built.list ? { paging: this.#paging } : {}) });
    return { ...built, table: t.name, op, args, signature: signatureText(built.name, args) };
  }

  #build(t: TableSpec, op: TableFnOp): Omit<TableFn, 'table' | 'op' | 'args' | 'signature'> {
    const table = t.name;
    const key = keyOf(t);
    const noun = human(singular(table));
    const column = op.column === undefined || op.kind === 'childrenOf' || op.kind === 'countPerParent' ? undefined : columnOf(t, op.column);
    const base = { kind: op.kind, list: false, sorters: [] as string[], optional: [] as string[], defaults: {} };
    switch (op.kind) {
      case 'selectPage': {
        const derived = (op.derived ?? []).map((name) => this.#derivation(t, name));
        const filters = t.columns.filter((c) => isEnum(c) || c.type.kind === 'bool' || this.#isForeign(t, c));
        const where: ExprDef[] = filters.map((c) => maybe(c.name, eq(ref('t', c.name), param(c.name))));
        const optional = filters.map((c) => c.name);
        for (const d of derived) {
          where.push(maybe(`min${cap(d.field.name)}`, cmp('>=', ref('t', d.field.name), param(`min${cap(d.field.name)}`))));
          where.push(maybe(`max${cap(d.field.name)}`, cmp('<=', ref('t', d.field.name), param(`max${cap(d.field.name)}`))));
          optional.push(`min${cap(d.field.name)}`, `max${cap(d.field.name)}`);
        }
        const columns = [...t.columns.map((c) => c.name), ...derived.map((d) => d.field.name)];
        const query = this.#outer(t, derived, columns, where);
        return { ...base, name: 'selectPage', about: `List ${human(table)}, filtered by any of ${optional.map(human).join(', ') || 'nothing'}, sorted and paged.`, group: 'crud', rank: 0, mode: 'read', query, list: true, sorters: columns, optional };
      }
      case 'selectOne': {
        const by = column ?? requireKey(t);
        const query = this.#outer(t, [], t.columns.map((c) => c.name), [eq(ref('t', by.name), param(by.name))]);
        return { ...base, name: column === undefined ? 'selectOne' : `selectBy${cap(camel(by.name))}`, about: `The ${noun} with this ${human(by.name)}.`, group: 'crud', rank: column === undefined ? 1 : 3, mode: 'read', query };
      }
      case 'create': {
        const { row, optional, defaults } = this.#insertRow(t);
        const query: QueryDef = { kind: 'insert', into: table, rows: [row], returning: this.#returning(t, table) };
        return { ...base, name: 'create', about: `Add a ${noun}; leave out what has a default or may be empty.`, group: 'crud', rank: 2, mode: 'write', query, optional, defaults };
      }
      case 'update':
      case 'updateWhere': {
        if (op.kind === 'update' && column !== undefined) {
          // Moving a row to another parent: a relation can't be kept by a CASE, so it is a fn of its own.
          const rel = this.belongsTo(t).find((b) => b.column === column.name);
          if (!rel) throw new TableFnError(`${table}.${column.name} is not a foreign key.`);
          const k = requireKey(t);
          const query: QueryDef = { kind: 'update', type: table, set: { [column.name]: param(column.name) }, where: [eq(ref(table, k.name), param(k.name))], returning: this.#returning(t, table) };
          return { ...base, name: `set${cap(rel.word)}`, about: `Give a ${noun} another ${human(rel.word)}.`, group: rel.word, rank: 6, mode: 'write', query };
        }
        // `CASE WHEN :p IS NULL OR col = :p THEN col ELSE :p END`: unchanged when left out; the comparison types the param.
        const settable = t.columns.filter((c) => !c.generated && !t.primaryKey.includes(c.name) && !this.#isForeign(t, c));
        const set: SetDef = {};
        for (const c of settable) {
          const p = param(`set${cap(camel(c.name))}`);
          set[c.name] = { kind: 'case', branches: [{ when: { kind: 'logical', op: 'or', operands: [isNull(p), eq(ref(table, c.name), p)] }, then: ref(table, c.name) }], else: p };
        }
        const optional = settable.map((c) => `set${cap(camel(c.name))}`);
        if (op.kind === 'update') {
          const k = requireKey(t);
          const query: QueryDef = { kind: 'update', type: table, set, where: [eq(ref(table, k.name), param(k.name))], returning: this.#returning(t, table) };
          return { ...base, name: 'update', about: `Change a ${noun} by its ${human(k.name)}; only the set… args given change.`, group: 'crud', rank: 3, mode: 'write', query, optional };
        }
        const matches = this.#matchable(t);
        const query: QueryDef = { kind: 'update', type: table, set, where: matches.map((c) => maybe(c.name, eq(ref(table, c.name), param(c.name)))) };
        return { ...base, name: 'updateWhere', about: `Change every ${noun} matching the given ${human(table)} values; only the set… args given change.`, group: 'crud', rank: 8, mode: 'write', query, optional: [...optional, ...matches.map((c) => c.name)] };
      }
      case 'remove': {
        const k = requireKey(t);
        const query: QueryDef = { kind: 'delete', from: table, where: [eq(ref(table, k.name), param(k.name))], returning: this.#returning(t, table) };
        return { ...base, name: 'remove', about: `Delete a ${noun} by its ${human(k.name)}.`, group: 'crud', rank: 4, mode: 'delete', query };
      }
      case 'removeWhere': {
        const matches = this.#matchable(t);
        const query: QueryDef = { kind: 'delete', from: table, where: matches.map((c) => maybe(c.name, eq(ref(table, c.name), param(c.name)))) };
        return { ...base, name: 'removeWhere', about: `Delete every ${noun} matching the given values.`, group: 'crud', rank: 9, mode: 'delete', query, optional: matches.map((c) => c.name) };
      }
      case 'exists': {
        const c = requireColumn(column, op);
        const query: QueryDef = { kind: 'select', fields: [{ expr: cmp('>=', agg('count'), lit(1)), as: 'exists' }], from: { kind: 'type', type: table }, where: [eq(ref(table, c.name), param(c.name))] };
        return { ...base, name: `existsBy${cap(camel(c.name))}`, about: `Whether a ${noun} with this ${human(c.name)} exists.`, group: 'columns', rank: 13, mode: 'read', query };
      }
      case 'findOrCreate': {
        const c = requireColumn(column, op);
        const { row, optional, defaults } = this.#insertRow(t);
        const query: QueryDef = { kind: 'insert', into: table, rows: [row], onConflict: { fields: [c.name], update: { [c.name]: { kind: 'excluded', field: c.name } } }, returning: this.#returning(t, table) };
        return { ...base, name: `findOrCreateBy${cap(camel(c.name))}`, about: `The ${noun} with this ${human(c.name)}, added first when there is none.`, group: 'columns', rank: 14, mode: 'write', query, optional, defaults };
      }
      case 'countBy': {
        const c = requireColumn(column, op);
        const value = this.#isForeign(t, c) ? ref(this.#parentAlias(t, c.name), this.#parentKey(t, c.name)) : ref(table, c.name);
        const query: QueryDef = {
          kind: 'select',
          fields: [{ expr: value, as: c.name }, { expr: agg('count'), as: 'count' }],
          from: { kind: 'type', type: table },
          ...(this.#isForeign(t, c) ? { joins: [{ on: { kind: 'relation', source: table, field: c.name, as: this.#parentAlias(t, c.name) }, joinType: 'left' as const }] } : {}),
          groupBy: [{ kind: 'output', name: c.name }],
          order: [{ expr: { kind: 'output', name: 'count' }, dir: 'desc' }],
        };
        return { ...base, name: `countBy${cap(camel(c.name))}`, about: `How many ${human(table)} there are per ${human(c.name)}.`, group: 'columns', rank: 10, mode: 'read', query, list: true, sorters: [c.name, 'count'] };
      }
      case 'stats': {
        const c = requireColumn(column, op);
        const v = ref(table, c.name);
        const query: QueryDef = {
          kind: 'select',
          fields: [{ expr: agg('count', v), as: 'count' }, { expr: agg('sum', v), as: 'total' }, { expr: agg('avg', v), as: 'avg' }, { expr: agg('min', v), as: 'min' }, { expr: agg('max', v), as: 'max' }],
          from: { kind: 'type', type: table },
        };
        return { ...base, name: `${camel(c.name)}Stats`, about: `The count, total, average, lowest and highest ${human(c.name)} of all ${human(table)}.`, group: 'columns', rank: 11, mode: 'read', query };
      }
      case 'buckets': {
        const c = requireColumn(column, op);
        const bucket = op.bucket ?? 'month';
        const query: QueryDef = {
          kind: 'select',
          fields: [{ expr: { kind: 'function-call', function: 'dateTrunc', args: { field: lit(bucket), d: ref(table, c.name) } }, as: bucket }, { expr: agg('count'), as: 'count' }],
          from: { kind: 'type', type: table },
          where: [{ kind: 'is-null', value: ref(table, c.name), not: true }],
          groupBy: [{ kind: 'output', name: bucket }],
          order: [{ expr: { kind: 'output', name: bucket }, dir: 'asc' }],
        };
        return { ...base, name: `${camel(c.name)}Per${cap(bucket)}`, about: `How many ${human(table)} there are per ${bucket} of ${human(c.name)}.`, group: 'columns', rank: 12, mode: 'read', query, list: true, sorters: [bucket, 'count'] };
      }
      case 'childrenOf':
      case 'countPerParent': {
        const rel = this.hasMany(t).find((r) => r.child.name === op.child && r.column === op.column);
        if (!rel) throw new TableFnError(`${op.child ?? '?'}.${op.column ?? '?'} is not a foreign key onto ${table}.`);
        const k = requireKey(t);
        if (op.kind === 'childrenOf') {
          const inner = this.#outer(rel.child, [], rel.child.columns.map((c) => c.name), [eq(ref('t', rel.column), param(rel.column))]);
          return { ...base, name: `${camel(rel.child.name)}Of${cap(relWord(rel.column))}`, about: `The ${human(rel.child.name)} of one ${noun}, by its ${human(k.name)}.`, group: rel.word, rank: 5, mode: 'read', query: inner, list: true, sorters: rel.child.columns.map((c) => c.name) };
        }
        const countName = `${rel.word}Count`;
        const query: QueryDef = {
          kind: 'select',
          fields: [...t.columns.filter((c) => !this.#isForeign(t, c)).map((c) => ({ expr: ref(table, c.name), as: c.name })), { expr: this.#countOf(t, rel, k.name), as: countName }],
          from: { kind: 'type', type: table },
          order: [{ expr: { kind: 'output', name: countName }, dir: 'desc' }],
        };
        return { ...base, name: `${countName}Per${cap(camel(singular(table)))}`, about: `Every ${noun} with how many ${human(rel.child.name)} it has, the most first.`, group: rel.word, rank: 15, mode: 'read', query, list: true, sorters: [countName, ...t.columns.map((c) => c.name)] };
      }
      case 'derived': {
        const name = op.derived?.[0];
        if (name === undefined) throw new TableFnError('A derived fn names its derived field.');
        const d = this.#derivation(t, name);
        const k = requireKey(t);
        const label = t.columns.find((c) => c.type.kind === 'text' && !t.primaryKey.includes(c.name) && !this.#isForeign(t, c));
        const columns = [k.name, ...(label === undefined ? [] : [label.name]), d.field.name];
        const query = this.#outer(t, [d], columns, [maybe(k.name, eq(ref('t', k.name), param(k.name)))]);
        return { ...base, name: d.field.name, about: `${d.field.about} Per ${noun}; give ${human(k.name)} for one.`, group: d.group, rank: d.rank, mode: 'read', query, list: true, sorters: columns, optional: [k.name], derived: d.field };
      }
    }
  }

  /**
   * The row an insert writes: a param per column the database does not fill. A constant default becomes the arg's
   * default; a `now` default is `CASE WHEN :p IS NULL OR :p = now() THEN now() ELSE :p END` (the comparison types
   * the param); a column with an SQL default the database computes is required unless it may be empty.
   */
  #insertRow(t: TableSpec): { row: InsertRowDef; optional: string[]; defaults: Record<string, JsonValue> } {
    const row: InsertRowDef = {};
    const optional: string[] = [];
    const defaults: Record<string, JsonValue> = {};
    for (const c of t.columns) {
      if (c.generated) continue;
      const p = param(c.name);
      if (c.default?.kind === 'now') {
        const now: ExprDef = { kind: 'function-call', function: 'now', args: {} };
        row[c.name] = { kind: 'case', branches: [{ when: { kind: 'logical', op: 'or', operands: [isNull(p), eq(p, now)] }, then: now }], else: p };
        optional.push(c.name);
        continue;
      }
      row[c.name] = p;
      if (c.default?.kind === 'value' && c.default.value !== null) defaults[c.name] = c.default.value;
      else if (c.nullable) optional.push(c.name);
    }
    return { row, optional, defaults };
  }

  #derivation(t: TableSpec, name: string): Derivation {
    const d = this.derivations(t).find((x) => x.field.name === name);
    if (!d) throw new TableFnError(`${t.name} has no derived field ${name}.`);
    return d;
  }

  #isForeign(t: TableSpec, c: ColumnSpec): boolean {
    return this.belongsTo(t).some((b) => b.column === c.name);
  }

  #parentAlias(t: TableSpec, column: string): string {
    return `${relWord(column)}Of${cap(camel(t.name))}`;
  }

  #parentKey(t: TableSpec, column: string): string {
    const rel = this.belongsTo(t).find((b) => b.column === column);
    if (!rel) throw new TableFnError(`${t.name}.${column} is not a foreign key.`);
    return rel.key;
  }

  /** Columns `updateWhere` / `removeWhere` match on: every plain scalar (no json, no key columns of composite keys). */
  #matchable(t: TableSpec): ColumnSpec[] {
    return t.columns.filter((c) => c.type.kind !== 'json' && c.type.kind !== 'bytes' && !this.#isForeign(t, c));
  }

  /** `RETURNING` every column, foreign keys as their stored value. */
  #returning(t: TableSpec, alias: string): SelectFieldDef[] {
    return t.columns.filter((c) => !this.#isForeign(t, c)).map((c) => ({ expr: ref(alias, c.name), as: c.name }));
  }

  /** How many children a row of `t` (bound under its own name) has. */
  #countOf(t: TableSpec, rel: HasMany, key: string): ExprDef {
    const count = this.#hasManyFields(t, key, rel)[0];
    if (!count) throw new TableFnError(`No count for ${rel.child.name}.`);
    return count.build(new JoinSet(), t.name);
  }

  /**
   * A select over every row of the table with its derived fields computed (an
   * inner select, so windows see the whole table), then filtered from outside
   * under the alias `t`. Foreign keys are read through their join, so they come
   * out as plain key values.
   */
  #outer(t: TableSpec, derived: readonly Derivation[], columns: readonly string[], where: ExprDef[]): QueryDef {
    const joins = new JoinSet();
    const fields: SelectFieldDef[] = t.columns.map((c) => {
      const rel = this.belongsTo(t).find((b) => b.column === c.name);
      return { expr: rel === undefined ? ref(t.name, c.name) : ref(joins.parent(t.name, c.name), rel.key), as: c.name };
    });
    for (const d of derived) fields.push({ expr: d.build(joins, t.name), as: d.field.name });
    const inner: SelectDef = { kind: 'select', fields, from: { kind: 'type', type: t.name }, ...(joins.joins.length > 0 ? { joins: joins.joins } : {}) };
    const key = keyOf(t);
    return {
      kind: 'select',
      fields: columns.map((name) => ({ expr: ref('t', name), as: name })),
      from: { kind: 'subquery', query: inner, as: 't' },
      ...(where.length > 0 ? { where } : {}),
      ...(key !== undefined && columns.includes(key) ? { order: [{ expr: ref('t', key), dir: 'asc' as const }] } : {}),
    };
  }
}

function lower(text: string): string {
  return text.length === 0 ? text : `${text[0]!.toLowerCase()}${text.slice(1)}`;
}

function columnOf(t: TableSpec, name: string): ColumnSpec {
  const c = t.columns.find((x) => x.name === name);
  if (!c) throw new TableFnError(`${t.name} has no column ${name}.`);
  return c;
}

function requireColumn(c: ColumnSpec | undefined, op: TableFnOp): ColumnSpec {
  if (!c) throw new TableFnError(`A ${op.kind} fn on ${op.table} names its column.`);
  return c;
}

function requireKey(t: TableSpec): ColumnSpec {
  const key = keyOf(t);
  if (key === undefined) throw new TableFnError(`${t.name} has no single-column key.`);
  return columnOf(t, key);
}

/** The field type of a derived field's value. */
export function derivedFieldType(field: DerivedField, tables: readonly TableSpec[]): FieldTypeDef {
  if (field.measure === 'value' && field.column !== null) {
    const c = tables.find((t) => t.name === field.table)?.columns.find((x) => x.name === field.column);
    if (c) return scalarFieldType(c.type);
  }
  if (field.measure === 'count' || field.measure === 'rank') return { kind: 'number', whole: true };
  return { kind: 'number' };
}
