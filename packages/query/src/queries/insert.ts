/**
 * InsertQuery — INSERT … VALUES / SELECT, with RETURNING and ON CONFLICT.
 * Rows are materialized into the target Type's transactional `TypeState`
 * (so a following query in the same run sees them). ON CONFLICT matches an
 * existing row by the conflict fields, then either does nothing or applies
 * the update assignments.
 */
import type {
  FieldValueDef,
  InsertDef,
  OnConflictDef,
  QueryDef,
  SelectFieldDef,
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
import { obj, lit, str, bool, list, exprRef, queryRef } from '../shape';
import { selectFieldShape, fieldValueShape } from './_shape';
import { requiredOnInsert } from '../write-model';
import { typeReadonly, fieldReadonly } from './_sql';
import { EXCLUDED_SOURCE } from '../exprs/excluded';
import { didYouMean } from '../aids';
import type { Type } from '../type';
import type { Cost } from '../cost';
import type { Dialect } from '../sql/dialect';
import { type SqlContext, SqlText } from '../sql/emit';

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

/** An `INSERT … VALUES / SELECT` statement with optional RETURNING and ON CONFLICT. */
export class InsertQuery extends Query {
  /** The Registry dispatch discriminant for this query kind. */
  static readonly KIND = 'insert' as const;
  /** This query's `kind` discriminant. */
  readonly kind = InsertQuery.KIND;

  constructor(
    /** The target Type name rows are inserted into. */
    readonly into: string,
    /** The target column names, in tuple order. */
    readonly fields: string[],
    /** Literal row tuples (one expr per field), or `undefined` for an INSERT … SELECT. */
    readonly values: Expr[][] | undefined,
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
    const values = json.values?.map((tuple) => tuple.map((e) => registry.parseExpr(e)));
    const select = json.select ? registry.parseQuery(json.select) : undefined;
    const returning = (json.returning ?? []).map((c) => ({ expr: registry.parseExpr(c.expr), as: c.as }));
    const onConflict = json.onConflict
      ? {
          fields: [...json.onConflict.fields],
          doNothing: json.onConflict.doNothing ?? false,
          update: (json.onConflict.update ?? []).map((u) => ({
            field: u.field,
            expr: registry.parseExpr(u.value),
          })),
        }
      : undefined;
    return new InsertQuery(json.into, [...json.fields], values, select, returning, onConflict);
  }

  /**
   * Owned structural {@link Shape} — the zod-free parallel parser. Builds an
   * `InsertQuery` equal to `from`'s output on a valid def; accumulates every
   * problem in one pass (never throws). The VALUES-arity / write-model checks
   * remain in `validateWalk`; this shape covers STRUCTURE only. See `shape/`.
   */
  static readonly SHAPE = obj(
    {
      kind: lit('insert'),
      into: str('TypeName'),
      fields: list(str('FieldName')),
      values: list(list(exprRef())),
      select: queryRef(),
      returning: list(selectFieldShape()),
      onConflict: obj(
        {
          fields: list(str('FieldName')),
          doNothing: bool('DoNothing'),
          update: list(fieldValueShape()),
        },
        (v) => ({ fields: v.fields, doNothing: v.doNothing ?? false, update: v.update ?? [] }),
        { optional: ['doNothing', 'update'], aid: 'OnConflict' },
      ),
    },
    (v) => new InsertQuery(v.into, v.fields, v.values, v.select, v.returning ?? [], v.onConflict),
    { optional: ['values', 'select', 'returning', 'onConflict'], aid: 'Query_insert' },
  );

  /** The target is referenced by its TYPE NAME (no aliasing on DML targets). */
  private get alias(): string {
    return this.into;
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

  /** Validate the target type, fields, VALUES arity, RETURNING, and ON CONFLICT assignments. */
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
    p.at('fields', () => {
      this.fields.forEach((c, i) => {
        const field = type.field(c);
        if (!field) {
          p.at(i, () => p.error('insert.unknown-field', `Type '${this.into}' has no field '${c}'.${didYouMean(c, type.fields.map((f) => f.name))}`));
        } else if (!field.insertableFor(engine.fieldBacking(this.into, c))) {
          // WRITE-MODEL: a non-insertable (read-only / computed) field can't be supplied.
          p.at(i, () => p.error('insert.field-readonly', `Field '${c}' of '${this.into}' is not insertable.`));
        }
      });
    });
    // WRITE-MODEL: every required-on-insert field must be present in `fields`.
    const provided = new Set(this.fields);
    const missing = type.fields
      .filter((f) => !provided.has(f.name) && requiredOnInsert(f, engine.fieldBacking(this.into, f.name)))
      .map((f) => f.name);
    if (missing.length) {
      p.at('fields', () =>
        p.error('insert.missing-required', `INSERT into '${this.into}' is missing required field(s): ${missing.join(', ')}.`),
      );
    }
    if (this.values) {
      p.at('values', () => {
        this.values!.forEach((tuple, i) => {
          if (tuple.length !== this.fields.length) {
            p.at(i, () => p.error('insert.arity', `Row ${i} has ${tuple.length} values for ${this.fields.length} fields.`));
          }
        });
      });
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
        this.onConflict!.update.forEach((u, i) => {
          if (type && !type.field(u.field)) {
            p.at([i, 'field'], () => p.error('insert.unknown-field', `Type '${this.into}' has no field '${u.field}'.${didYouMean(u.field, type.fields.map((f) => f.name))}`));
          }
          p.at([i, 'value'], () => u.expr.validateWalk(engine, conflictScope, p, assignCtx));
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

  /** Estimate `{ rows, bytes }`: the VALUES tuple count (or the source query's rows) at the target's per-row size. */
  cost(engine: QueryEngine, scope: QueryScope): Cost {
    const type = engine.type(this.into);
    const perRow = type ? type.bytes : 0;
    let rows = 0;
    if (this.values) rows = this.values.length;
    else if (this.select) rows = this.select.cost(engine, scope).rows;
    return { rows, bytes: rows * perRow };
  }

  /** Materialize tuples into the target's `TypeState`, applying ON CONFLICT, then project RETURNING. */
  async execute(ctx: RuntimeContext): Promise<QueryResult> {
    const engine = ctx.engine;
    const type = engine.type(this.into);
    const fields = this.outputFields(engine, engine.globalScope());
    if (!type) return makeResult('insert', [], fields, 0);
    // WRITE-MODEL (belt-and-suspenders): never write a read-only Type / field.
    if (!type.insertable) throw typeReadonly('insert', this.into);
    for (const c of this.fields) {
      const field = type.field(c);
      if (field && !field.insertableFor(engine.fieldBacking(this.into, c))) {
        throw fieldReadonly('insert', this.into, c);
      }
    }
    const state = await ctx.typeState(type);
    // Register the target alias → its Type so RETURNING field-refs recover
    // metadata. INSERT has a single target and no joins, so no `source.duplicate`
    // collision is possible — collision detection is intentionally omitted.
    ctx.bindSourceType(this.into, type);

    const tuples = await this.gatherTuples(ctx);
    // WRITE-MODEL: materialize a `FieldBacking.default` for every insertable field
    // OMITTED from `fields` (value / factory, per row). SQL relies on the DB's own
    // column DEFAULT instead — a JS-factory default is a runtime-only concern.
    await this.materializeDefaults(ctx, type, tuples);
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
    return makeResult('insert', rows, fields, stored.length);
  }

  /**
   * Fill each gathered record's OMITTED insertable fields from their
   * `FieldBacking.default` (a ready value or a per-row factory). Fields the caller
   * supplied are left untouched; fields with no default resolve to `undefined`
   * and stay absent (nullable ⇒ NULL; required-missing ⇒ caught by validation).
   */
  private async materializeDefaults(ctx: RuntimeContext, type: Type, records: SourceRecord[]): Promise<void> {
    const engine = ctx.engine;
    const provided = new Set(this.fields);
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

  /** Materialize the tuples to insert (from VALUES or a SELECT). */
  private async gatherTuples(ctx: RuntimeContext): Promise<SourceRecord[]> {
    if (this.values) {
      const out: SourceRecord[] = [];
      for (const tuple of this.values) {
        const rec: SourceRecord = {};
        for (let i = 0; i < this.fields.length; i++) {
          rec[this.fields[i]!] = (await tuple[i]!.evaluate(ctx, null)).raw;
        }
        out.push(rec);
      }
      return out;
    }
    if (this.select) {
      const result = await this.select.execute(ctx);
      return result.rows.map((row) => {
        const rec: SourceRecord = {};
        this.fields.forEach((col, i) => {
          const src = result.fields[i]?.name;
          rec[col] = src !== undefined ? row[src] ?? null : null;
        });
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

  /** Emit `INSERT INTO … (cols) VALUES …|SELECT … [ON CONFLICT …] [RETURNING …]`. */
  toSQL(dialect: Dialect, ctx: SqlContext): SqlText {
    const inner = ctx.withScope(this.targetScope(ctx.engine, ctx.scope));
    const parts: SqlText[] = [
      SqlText.raw('INSERT INTO '),
      dialect.ident(this.into),
      SqlText.raw(' ('),
      SqlText.join(this.fields.map((c) => dialect.ident(c)), ', '),
      SqlText.raw(')'),
    ];

    if (this.values) {
      const tuples = this.values.map((tuple) =>
        SqlText.join(tuple.map((e) => e.toSQL(dialect, ctx)), ', ').parens(),
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
    const def: InsertDef = { kind: 'insert', into: this.into, fields: [...this.fields] };
    if (this.values) def.values = this.values.map((t) => t.map((e) => e.toJSON()));
    if (this.select) def.select = this.select.toJSON();
    if (this.returning.length) {
      def.returning = this.returning.map((c): SelectFieldDef => (c.as ? { expr: c.expr.toJSON(), as: c.as } : { expr: c.expr.toJSON() }));
    }
    if (this.onConflict) {
      const oc: OnConflictDef = { fields: [...this.onConflict.fields] };
      if (this.onConflict.doNothing) oc.doNothing = true;
      if (this.onConflict.update.length) {
        oc.update = this.onConflict.update.map((u): FieldValueDef => ({ field: u.field, value: u.expr.toJSON() }));
      }
      def.onConflict = oc;
    }
    return def;
  }

  /** Deep-clone this insert (cloning values / source query / RETURNING / ON CONFLICT exprs). */
  clone(): InsertQuery {
    return new InsertQuery(
      this.into,
      [...this.fields],
      this.values?.map((t) => t.map((e) => e.clone())),
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
