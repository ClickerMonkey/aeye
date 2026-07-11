/**
 * InsertQuery — INSERT … VALUES / SELECT, with RETURNING and ON CONFLICT.
 * Rows are materialized into the target Type's transactional `TypeState`
 * (so a following query in the same run sees them). ON CONFLICT matches an
 * existing row by the conflict fields, then either does nothing or applies
 * the update assignments.
 *
 * A VALUES row is a KEYED `{ field: value }` record (see `WriteValueDef`): an
 * absent key / JSON `null` value OMITS the field (its backing default fills in);
 * a literal-null expr sets SQL NULL. Multi-row INSERTs require HOMOGENEOUS keys
 * across every row (`insert.row-shape`).
 */
import type {
  InsertDef,
  InsertRowDef,
  OnConflictDef,
  QueryDef,
  SelectFieldDef,
  SetDef,
} from '../schema';
import type { Registry } from '../registry';
import type { QueryEngine } from '../engine';
import type { QueryScope } from '../scope';
import type { Problems } from '../problem';
import type { Expr, ValidateContext } from '../expr';
import type { RuntimeContext } from '../runtime/context';
import type { SourceRecord } from '../runtime/row';
import {
  Query,
  type QueryClass,
  type QueryField,
  type QueryResult,
  fieldNameOf,
  makeField,
  makeResult,
} from './query';
import { insertRecord, updateRecord } from './_type';
import { obj, lit, str, bool, list, queryRef } from '../shape';
import { selectFieldShape, writeRecordShape } from './_shape';
import { parseWriteRecord } from './_write';
import { requiredOnInsert } from '../write-model';
import { typeReadonly, fieldReadonly } from './_sql';
import { EXCLUDED_SOURCE } from '../exprs/excluded';
import { didYouMean } from '../aids';
import type { Type } from '../type';
import type { Cost } from '../cost';
import type { Dialect } from '../sql/dialect';
import { type SqlContext, SqlText } from '../sql/emit';

/** One parsed INSERT row: field name → its value expr (OMITted keys already dropped). */
export type InsertRow = ReadonlyMap<string, Expr>;

interface ReturningField {
  expr: Expr;
  as: string | undefined;
}
interface ConflictAssign {
  field: string;
  expr: Expr;
}
interface OnConflict {
  fields: string[];
  doNothing: boolean;
  update: ConflictAssign[];
}

/** Convert a keyed write `Map` into the ordered `{ field, expr }` assignment list. */
function toAssigns(map: ReadonlyMap<string, Expr>): ConflictAssign[] {
  return [...map].map(([field, expr]) => ({ field, expr }));
}

/** An `INSERT … VALUES / SELECT` statement with optional RETURNING and ON CONFLICT. */
export class InsertQuery extends Query {
  /** The Registry dispatch discriminant for this query kind. */
  static readonly KIND = 'insert' as const;
  /** This query's `kind` discriminant. */
  readonly kind = InsertQuery.KIND;

  constructor(
    /** The target Type name rows are inserted into. */
    readonly into: string,
    /** Keyed VALUES rows (field → value expr, OMITted keys dropped), or `undefined` for INSERT … SELECT. */
    readonly rows: readonly InsertRow[] | undefined,
    /** Source query for INSERT … SELECT, or `undefined` for VALUES. */
    readonly select: Query | undefined,
    /** RETURNING projection (expr + optional alias). */
    readonly returning: ReturningField[],
    /** ON CONFLICT handling, or `undefined` when absent. */
    readonly onConflict: OnConflict | undefined,
  ) {
    super();
  }

  /** Parse an `insert` `QueryDef` into an `InsertQuery`. */
  static from(json: QueryDef, registry: Registry): InsertQuery {
    if (json.kind !== 'insert') throw new Error(`InsertQuery.from: expected 'insert', got '${json.kind}'`);
    const rows = json.rows?.map((r) => parseWriteRecord(r, registry));
    const select = json.select ? registry.parseQuery(json.select) : undefined;
    const returning = (json.returning ?? []).map((c) => ({ expr: registry.parseExpr(c.expr), as: c.as }));
    const onConflict = json.onConflict
      ? {
          fields: [...json.onConflict.fields],
          doNothing: json.onConflict.doNothing ?? false,
          update: toAssigns(parseWriteRecord(json.onConflict.update ?? {}, registry)),
        }
      : undefined;
    return new InsertQuery(json.into, rows, select, returning, onConflict);
  }

  /**
   * Owned structural {@link Shape} — the zod-free parallel parser. Builds an
   * `InsertQuery` equal to `from`'s output on a valid def; accumulates every
   * problem in one pass (never throws). The homogeneity / write-model checks
   * remain in `validateWalk`; this shape covers STRUCTURE only. See `shape/`.
   */
  static readonly SHAPE = obj(
    {
      kind: lit('insert'),
      into: str('TypeName'),
      rows: list(writeRecordShape('InsertRow')),
      select: queryRef(),
      returning: list(selectFieldShape()),
      onConflict: obj(
        {
          fields: list(str('FieldName')),
          doNothing: bool('DoNothing'),
          update: writeRecordShape('SetValue'),
        },
        (v): OnConflict => ({
          fields: v.fields,
          doNothing: v.doNothing ?? false,
          update: toAssigns(v.update ?? new Map()),
        }),
        { optional: ['doNothing', 'update'], aid: 'OnConflict' },
      ),
    },
    (v) => new InsertQuery(v.into, v.rows, v.select, v.returning ?? [], v.onConflict),
    { optional: ['rows', 'select', 'returning', 'onConflict'], aid: 'Query_insert' },
  );

  /** The target is referenced by its TYPE NAME (no aliasing on DML targets). */
  private get alias(): string {
    return this.into;
  }

  /** The VALUES column set — the FIRST row's keys (homogeneity is validated separately). */
  private valueColumns(): string[] {
    return this.rows && this.rows.length ? [...this.rows[0]!.keys()] : [];
  }

  /** Bind the target Type under its alias into a child scope. */
  private targetScope(engine: QueryEngine, scope: QueryScope): QueryScope {
    const child = scope.child();
    const type = engine.type(this.into);
    if (type) child.bind(this.alias, { kind: 'type', type, source: this.alias, synthetic: false });
    return child;
  }

  /**
   * The scope an ON CONFLICT DO UPDATE assignment is resolved / emitted in: the
   * target Type bound under its name PLUS the reserved `excluded` source (also
   * the target Type), so an `excluded` expr — `EXCLUDED.<field>` — can reference
   * the proposed row.
   */
  private conflictScope(engine: QueryEngine, scope: QueryScope): QueryScope {
    const child = this.targetScope(engine, scope);
    const type = engine.type(this.into);
    if (type) child.bind(EXCLUDED_SOURCE, { kind: 'type', type, source: EXCLUDED_SOURCE, synthetic: false });
    return child;
  }

  /** Resolve the output fields from the RETURNING projection against the target scope. */
  outputFields(engine: QueryEngine, scope: QueryScope): QueryField[] {
    const inner = this.targetScope(engine, scope);
    return this.returning.map((c, i) => makeField(fieldNameOf(c.expr, c.as, i), c.expr.resolve(engine, inner)));
  }

  /** Validate the target type, fields, row homogeneity, RETURNING, and ON CONFLICT assignments. */
  validateWalk(engine: QueryEngine, scope: QueryScope, p: Problems, _ctx: ValidateContext): void {
    const type = engine.type(this.into);
    if (!type) {
      p.error('insert.unknown-type', `Unknown target type '${this.into}'.${didYouMean(this.into, engine.registry.typeList().map((t) => t.name))}`);
      return;
    }
    // WRITE-MODEL: the Type as a whole must be insertable.
    if (!type.insertable) {
      p.error('insert.type-readonly', `Type '${this.into}' is not insertable.`);
      return;
    }
    // Keyed VALUES rows carry the write-model field checks; INSERT … SELECT maps
    // its output columns by name at run / emit time (validated via the select).
    if (this.rows) {
      const columns = this.valueColumns();
      const canonical = new Set(columns);
      // Multi-row INSERT: every row must specify the SAME fields (homogeneous).
      if (this.rows.length > 1) {
        const heterogeneous = this.rows.some(
          (row) => row.size !== canonical.size || [...row.keys()].some((k) => !canonical.has(k)),
        );
        if (heterogeneous) {
          p.at('rows', () =>
            p.error('insert.row-shape', `All INSERT rows into '${this.into}' must specify the same fields.`),
          );
        }
      }
      p.at('rows', () => {
        columns.forEach((c) => {
          const field = type.field(c);
          if (!field) {
            p.at(c, () => p.error('insert.unknown-field', `Type '${this.into}' has no field '${c}'.${didYouMean(c, type.fields.map((f) => f.name))}`));
          } else if (!field.insertableFor(engine.fieldBacking(this.into, c))) {
            // WRITE-MODEL: a non-insertable (read-only / computed) field can't be supplied.
            p.at(c, () => p.error('insert.field-readonly', `Field '${c}' of '${this.into}' is not insertable.`));
          }
        });
      });
      // WRITE-MODEL: every required-on-insert field must be present.
      const missing = type.fields
        .filter((f) => !canonical.has(f.name) && requiredOnInsert(f, engine.fieldBacking(this.into, f.name)))
        .map((f) => f.name);
      if (missing.length) {
        p.at('rows', () =>
          p.error('insert.missing-required', `INSERT into '${this.into}' is missing required field(s): ${missing.join(', ')}.`),
        );
      }
    }
    const inner = this.targetScope(engine, scope);
    const ctx: ValidateContext = { inAggregate: false, inWindow: false, allowAggregate: true, groupKeys: [], inGroupBy: false };
    p.at('returning', () => {
      this.returning.forEach((c, i) => p.at([i, 'expr'], () => c.expr.validateWalk(engine, inner, p, ctx)));
    });
    // ON CONFLICT DO UPDATE assignments resolve in the conflict scope (target +
    // `excluded`), so an `EXCLUDED.<field>` reference validates against the
    // proposed row. Aggregates are not allowed in an assignment value.
    if (this.onConflict && this.onConflict.update.length) {
      const conflictScope = this.conflictScope(engine, scope);
      const assignCtx: ValidateContext = { ...ctx, allowAggregate: false };
      p.at(['onConflict', 'update'], () => {
        this.onConflict!.update.forEach((u) => {
          if (type && !type.field(u.field)) {
            p.at(u.field, () => p.error('insert.unknown-field', `Type '${this.into}' has no field '${u.field}'.${didYouMean(u.field, type.fields.map((f) => f.name))}`));
          }
          p.at(u.field, () => u.expr.validateWalk(engine, conflictScope, p, assignCtx));
        });
      });
    }
  }

  /** The target type plus any types read by an INSERT … SELECT source. */
  referencedTypes(): readonly string[] {
    const out = new Set<string>([this.into]);
    if (this.select) for (const t of this.select.referencedTypes()) out.add(t);
    return [...out];
  }

  /** Estimate `{ rows, bytes }`: the VALUES row count (or the source query's rows) at the target's per-row size. */
  cost(engine: QueryEngine, scope: QueryScope): Cost {
    const type = engine.type(this.into);
    const perRow = type ? type.bytes : 0;
    let rows = 0;
    if (this.rows) rows = this.rows.length;
    else if (this.select) rows = this.select.cost(engine, scope).rows;
    return { rows, bytes: rows * perRow };
  }

  /** Materialize rows into the target's `TypeState`, applying ON CONFLICT, then project RETURNING. */
  async execute(ctx: RuntimeContext): Promise<QueryResult> {
    const engine = ctx.engine;
    const type = engine.type(this.into);
    const outFields = this.outputFields(engine, engine.globalScope());
    if (!type) return makeResult('insert', [], outFields, 0);
    // WRITE-MODEL (belt-and-suspenders): never write a read-only Type.
    if (!type.insertable) throw typeReadonly('insert', this.into);
    const state = await ctx.typeState(type);
    // Register the target alias → its Type so RETURNING field-refs recover
    // metadata. INSERT has a single target and no joins, so no `source.duplicate`
    // collision is possible — collision detection is intentionally omitted.
    ctx.bindSourceType(this.into, type);

    const tuples = await this.gatherTuples(ctx);
    const columns = this.rows ? this.valueColumns() : tuples.length ? Object.keys(tuples[0]!) : [];
    // WRITE-MODEL (belt-and-suspenders): never write a read-only field.
    for (const c of columns) {
      const field = type.field(c);
      if (field && !field.insertableFor(engine.fieldBacking(this.into, c))) {
        throw fieldReadonly('insert', this.into, c);
      }
    }
    // WRITE-MODEL: materialize a `FieldBacking.default` for every insertable field
    // OMITTED from the row columns (value / factory, per row). SQL relies on the
    // DB's own column DEFAULT instead — a JS-factory default is runtime-only.
    await this.materializeDefaults(ctx, type, tuples, columns);
    const stored: SourceRecord[] = [];
    for (const fields of tuples) {
      const existing = this.onConflict ? this.findConflict(state.current, fields) : undefined;
      if (existing && this.onConflict) {
        if (this.onConflict.doNothing) continue;
        if (this.onConflict.update.length) {
          const updates: SourceRecord = {};
          // The assignment row exposes the EXISTING row (target alias) and the
          // PROPOSED row (`excluded`), so an `EXCLUDED.<field>` reads the value
          // that would have been inserted.
          const assignRow = { [this.alias]: existing, [EXCLUDED_SOURCE]: fields };
          for (const u of this.onConflict.update) {
            updates[u.field] = (await u.expr.evaluate(ctx, assignRow)).raw;
          }
          updateRecord(state, existing, updates);
          stored.push({ ...existing, ...updates });
          continue;
        }
      }
      stored.push(insertRecord(state, fields));
    }

    const rows = await this.projectReturning(ctx, stored);
    return makeResult('insert', rows, outFields, stored.length);
  }

  /**
   * Fill each gathered record's OMITTED insertable fields from their
   * `FieldBacking.default` (a ready value or a per-row factory). Fields the caller
   * supplied are left untouched; fields with no default resolve to `undefined`
   * and stay absent (nullable ⇒ NULL; required-missing ⇒ caught by validation).
   */
  private async materializeDefaults(ctx: RuntimeContext, type: Type, records: SourceRecord[], columns: readonly string[]): Promise<void> {
    const engine = ctx.engine;
    const provided = new Set(columns);
    const omitted = type.fields.filter(
      (f) => !provided.has(f.name) && f.insertableFor(engine.fieldBacking(this.into, f.name)),
    );
    if (omitted.length === 0) return;
    for (const rec of records) {
      for (const f of omitted) {
        const v = await engine.fieldDefault(this.into, f.name);
        if (v !== undefined) rec[f.name] = v.raw;
      }
    }
  }

  /** Materialize the records to insert (from keyed VALUES rows or a SELECT). */
  private async gatherTuples(ctx: RuntimeContext): Promise<SourceRecord[]> {
    if (this.rows) {
      const out: SourceRecord[] = [];
      for (const row of this.rows) {
        const rec: SourceRecord = {};
        for (const [field, expr] of row) {
          rec[field] = (await expr.evaluate(ctx, null)).raw;
        }
        out.push(rec);
      }
      return out;
    }
    if (this.select) {
      const result = await this.select.execute(ctx);
      // INSERT … SELECT maps the SELECT's OUTPUT columns onto the target columns
      // BY NAME (each select item's `as` / natural name is the target field).
      return result.rows.map((row) => {
        const rec: SourceRecord = {};
        for (const f of result.fields) rec[f.name] = row[f.name] ?? null;
        return rec;
      });
    }
    return [];
  }

  /** Find an existing row that conflicts on the ON CONFLICT fields. */
  private findConflict(rows: readonly SourceRecord[], fields: SourceRecord): SourceRecord | undefined {
    const cols = this.onConflict!.fields;
    const key = JSON.stringify(cols.map((c) => fields[c] ?? null));
    return rows.find((r) => JSON.stringify(cols.map((c) => r[c] ?? null)) === key);
  }

  /** Evaluate the RETURNING fields over each stored record. */
  private async projectReturning(ctx: RuntimeContext, stored: readonly SourceRecord[]): Promise<SourceRecord[]> {
    if (this.returning.length === 0) return [];
    const out: SourceRecord[] = [];
    for (const rec of stored) {
      const row: SourceRecord = {};
      for (let i = 0; i < this.returning.length; i++) {
        const c = this.returning[i]!;
        row[fieldNameOf(c.expr, c.as, i)] = (await c.expr.evaluate(ctx, { [this.alias]: rec })).raw;
      }
      out.push(row);
    }
    return out;
  }

  /** The target columns emitted in `INSERT INTO t (cols)` — the VALUES keys, or the SELECT's output names. */
  private sqlColumns(ctx: SqlContext): string[] {
    if (this.rows) return this.valueColumns();
    if (this.select) return this.select.outputFields(ctx.engine, ctx.scope).map((f) => f.name);
    return [];
  }

  /** Emit `INSERT INTO … (cols) VALUES …|SELECT … [ON CONFLICT …] [RETURNING …]`. */
  toSQL(dialect: Dialect, ctx: SqlContext): SqlText {
    const inner = ctx.withScope(this.targetScope(ctx.engine, ctx.scope));
    const columns = this.sqlColumns(ctx);
    const parts: SqlText[] = [
      SqlText.raw('INSERT INTO '),
      dialect.ident(this.into),
      SqlText.raw(' ('),
      SqlText.join(columns.map((c) => dialect.ident(c)), ', '),
      SqlText.raw(')'),
    ];

    if (this.rows) {
      const tuples = this.rows.map((row) =>
        SqlText.join(columns.map((c) => row.get(c)!.toSQL(dialect, ctx)), ', ').parens(),
      );
      parts.push(SqlText.raw(' VALUES '), SqlText.join(tuples, ', '));
    } else if (this.select) {
      parts.push(SqlText.raw(' '), this.select.toSQL(dialect, ctx));
    }

    if (this.onConflict) {
      parts.push(
        SqlText.raw(' ON CONFLICT ('),
        SqlText.join(this.onConflict.fields.map((c) => dialect.ident(c)), ', '),
        SqlText.raw(')'),
      );
      if (this.onConflict.doNothing || this.onConflict.update.length === 0) {
        parts.push(SqlText.raw(' DO NOTHING'));
      } else {
        // The assignment resolves in the conflict scope (target + `excluded`) so
        // an `EXCLUDED.<field>` emits `EXCLUDED."field"`.
        const conflictCtx = ctx.withScope(this.conflictScope(ctx.engine, ctx.scope));
        const sets = this.onConflict.update.map((u) =>
          SqlText.concat([dialect.ident(u.field), SqlText.raw(' = '), u.expr.toSQL(dialect, conflictCtx)]),
        );
        parts.push(SqlText.raw(' DO UPDATE SET '), SqlText.join(sets, ', '));
      }
    }

    if (this.returning.length) {
      const cols = this.returning.map((c, i) =>
        SqlText.concat([c.expr.toSQL(dialect, inner), SqlText.raw(' AS '), dialect.ident(fieldNameOf(c.expr, c.as, i))]),
      );
      parts.push(SqlText.raw(' RETURNING '), SqlText.join(cols, ', '));
    }
    return SqlText.concat(parts);
  }

  /** Serialize back to an `InsertDef`, omitting empty optional clauses. */
  toJSON(): InsertDef {
    const def: InsertDef = { kind: 'insert', into: this.into };
    if (this.rows) {
      def.rows = this.rows.map((row) => {
        const out: InsertRowDef = {};
        for (const [field, expr] of row) out[field] = expr.toJSON();
        return out;
      });
    }
    if (this.select) def.select = this.select.toJSON();
    if (this.returning.length) {
      def.returning = this.returning.map((c): SelectFieldDef => (c.as ? { expr: c.expr.toJSON(), as: c.as } : { expr: c.expr.toJSON() }));
    }
    if (this.onConflict) {
      const oc: OnConflictDef = { fields: [...this.onConflict.fields] };
      if (this.onConflict.doNothing) oc.doNothing = true;
      if (this.onConflict.update.length) {
        const update: SetDef = {};
        for (const u of this.onConflict.update) update[u.field] = u.expr.toJSON();
        oc.update = update;
      }
      def.onConflict = oc;
    }
    return def;
  }

  /** Deep-clone this insert (cloning rows / source query / RETURNING / ON CONFLICT exprs). */
  clone(): InsertQuery {
    return new InsertQuery(
      this.into,
      this.rows?.map((row) => new Map([...row].map(([field, expr]) => [field, expr.clone()]))),
      this.select?.clone(),
      this.returning.map((c) => ({ expr: c.expr.clone(), as: c.as })),
      this.onConflict
        ? {
            fields: [...this.onConflict.fields],
            doNothing: this.onConflict.doNothing,
            update: this.onConflict.update.map((u) => ({ field: u.field, expr: u.expr.clone() })),
          }
        : undefined,
    );
  }
}

const _check: QueryClass = InsertQuery;
void _check;
