/**
 * SetOperationQuery — UNION / INTERSECT / EXCEPT over two queries. Duplicates
 * are removed unless `all` is set. Rows are compared structurally via a
 * key-sorted signature. Output fields come from the left arm.
 *
 * An optional SET-LEVEL `order` / `limit` / `offset` is applied AFTER the set
 * operation, over the COMBINED rows. Its ORDER BY terms reference OUTPUT COLUMNS
 * (a `field-ref` whose `field` is the output column name; the `source` carries
 * no table to qualify): the runtime sorts then slices the combined records, and
 * SQL appends a trailing `ORDER BY <col> … LIMIT … OFFSET …` to the whole set.
 */
import type { ParamExprDef, QueryDef, SetOperationDef } from '../schema';
import type { Registry } from '../registry';
import type { QueryEngine } from '../engine';
import type { QueryScope } from '../scope';
import type { Problems } from '../problem';
import { type Expr, type ValidateContext } from '../expr';
import { FieldRefExpr } from '../exprs/index';
import type { RuntimeContext } from '../runtime/context';
import type { SourceRecord, SourceRow } from '../runtime/row';
import { recordSignature } from '../runtime/record';
import { NumberFieldType } from '../field-types/index';
import type { ParamSet } from '../param';
import { Query, type QueryClass, type QueryField, type QueryResult, makeResult, syntheticType } from './query';
import { QueryOrder, sortEntries, type OrderEntry } from './order';
import { type Cost, addCost } from '../cost';
import type { Dialect } from '../sql/dialect';
import { type SqlContext, SqlText } from '../sql/emit';
import { boundSQL } from './_sql';

type SetKind = 'union' | 'intersect' | 'except';

/** A `UNION` / `INTERSECT` / `EXCEPT` over two queries, with optional set-level order/limit/offset. */
export class SetOperationQuery extends Query {
  /** Representative kind for the static contract; instances carry the real one. */
  static readonly KIND = 'union' as const;
  /** This instance's actual set operation (`union` / `intersect` / `except`). */
  readonly kind: SetKind;

  constructor(
    kind: SetKind,
    /** The left arm; its output fields define the set's output shape. */
    readonly left: Query,
    /** The right arm. */
    readonly right: Query,
    /** Whether duplicates are kept (`ALL`); otherwise the result is de-duplicated. */
    readonly all: boolean,
    /** Set-level ORDER BY terms (over output columns), applied to the combined rows. */
    readonly order: QueryOrder[],
    /** Set-level row cap: a literal count or a bound `param` (`undefined` when unset). */
    readonly limit: number | ParamExprDef | undefined,
    /** Set-level row offset: a literal count or a bound `param` (`undefined` when unset). */
    readonly offset: number | ParamExprDef | undefined,
  ) {
    super();
    this.kind = kind;
  }

  /** Parse a `union` / `intersect` / `except` `QueryDef` into a `SetOperationQuery`. */
  static from(json: QueryDef, registry: Registry): SetOperationQuery {
    if (json.kind !== 'union' && json.kind !== 'intersect' && json.kind !== 'except') {
      throw new Error(`SetOperationQuery.from: expected a set op, got '${json.kind}'`);
    }
    return new SetOperationQuery(
      json.kind,
      registry.parseQuery(json.left),
      registry.parseQuery(json.right),
      json.all ?? false,
      (json.order ?? []).map((o) => QueryOrder.from(o, registry)),
      json.limit,
      json.offset,
    );
  }

  /** The set's output fields — taken from the left arm. */
  outputFields(engine: QueryEngine, scope: QueryScope): QueryField[] {
    return this.left.outputFields(engine, scope);
  }

  /**
   * A child scope binding the set's OUTPUT shape (a synthetic type over the left
   * arm's fields) under EVERY source name the `order` terms reference, so an
   * output-column `field-ref` resolves regardless of the `source` it names.
   */
  private orderScope(engine: QueryEngine, scope: QueryScope): QueryScope {
    const child = scope.child();
    const fields = this.outputFields(engine, scope);
    const type = syntheticType('<set>', fields);
    for (const source of this.orderSources()) {
      child.bind(source, { kind: 'type', type, source, synthetic: true });
    }
    return child;
  }

  /** The distinct `field-ref` source names referenced by the `order` terms. */
  private orderSources(): Set<string> {
    const out = new Set<string>();
    for (const o of this.order) collectFieldRefSources(o.expr, out);
    return out;
  }

  /** Validate both arms, plus any set-level ORDER BY terms against the output columns. */
  validateWalk(engine: QueryEngine, scope: QueryScope, p: Problems, ctx: ValidateContext): void {
    p.at('left', () => this.left.validateWalk(engine, scope, p, ctx));
    p.at('right', () => this.right.validateWalk(engine, scope, p, ctx));
    if (this.order.length) {
      const inner = this.orderScope(engine, scope);
      const colCtx: ValidateContext = { inAggregate: false, inWindow: false, allowAggregate: false, groupKeys: [], inGroupBy: false };
      p.at('order', () => {
        this.order.forEach((o, i) => p.at([i, 'expr'], () => o.expr.validateWalk(engine, inner, p, colCtx)));
      });
    }
  }

  /** The union of both arms' referenced Type names. */
  referencedTypes(): readonly string[] {
    return [...new Set([...this.left.referencedTypes(), ...this.right.referencedTypes()])];
  }

  /** Set-level `limit` / `offset` params live outside the walked expr tree. */
  protected override observeBoundParams(params: ParamSet): void {
    const numeric = new NumberFieldType();
    if (this.limit !== undefined && typeof this.limit !== 'number') params.observe(this.limit.name, numeric, ['limit']);
    if (this.offset !== undefined && typeof this.offset !== 'number') params.observe(this.offset.name, numeric, ['offset']);
  }

  /** Estimate `{ rows, bytes }`: combine both arms per operation, then cap by a literal LIMIT. */
  cost(engine: QueryEngine, scope: QueryScope): Cost {
    const l = this.left.cost(engine, scope);
    const r = this.right.cost(engine, scope);
    let combined: Cost;
    switch (this.kind) {
      case 'union':
        // UNION (ALL) can produce up to the sum of both arms.
        combined = addCost(l, r);
        break;
      case 'intersect':
        // At most the smaller arm survives the intersection.
        combined = { rows: Math.min(l.rows, r.rows), bytes: Math.min(l.bytes, r.bytes) };
        break;
      case 'except':
        // EXCEPT keeps at most the left arm.
        combined = l;
        break;
      /* v8 ignore next 2 -- exhaustive over SetKind; unreachable */
      default:
        return assertNever(this.kind);
    }
    // A set-level literal LIMIT caps the combined output rows.
    if (typeof this.limit === 'number' && combined.rows > 0) {
      const perRow = combined.bytes / combined.rows;
      const rows = Math.min(combined.rows, this.limit);
      combined = { rows, bytes: rows * perRow };
    }
    return combined;
  }

  /** Run both arms, combine per the set operation, de-dup unless `all`, then apply set-level ORDER BY / OFFSET / LIMIT. */
  async execute(ctx: RuntimeContext): Promise<QueryResult> {
    const leftRes = await this.left.execute(ctx);
    const rightRes = await this.right.execute(ctx);
    let rows: SourceRecord[];
    switch (this.kind) {
      case 'union':
        rows = [...leftRes.rows, ...rightRes.rows];
        break;
      case 'intersect': {
        const rightKeys = new Set(rightRes.rows.map(recordSignature));
        rows = leftRes.rows.filter((r) => rightKeys.has(recordSignature(r)));
        break;
      }
      case 'except': {
        const rightKeys = new Set(rightRes.rows.map(recordSignature));
        rows = leftRes.rows.filter((r) => !rightKeys.has(recordSignature(r)));
        break;
      }
      /* v8 ignore next 2 -- exhaustive over SetKind; unreachable */
      default:
        return assertNever(this.kind);
    }
    if (!this.all) {
      const seen = new Set<string>();
      rows = rows.filter((r) => {
        const k = recordSignature(r);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    }

    // SET-LEVEL ORDER BY then OFFSET / LIMIT over the combined rows.
    if (this.order.length) rows = await this.sortRows(rows, ctx);
    const offset = this.numericBound(this.offset, ctx);
    const limit = this.numericBound(this.limit, ctx);
    if (offset !== undefined) rows = rows.slice(offset);
    if (limit !== undefined) rows = rows.slice(0, limit);

    return makeResult(this.kind, rows, leftRes.fields);
  }

  /** Sort the combined output records by the set-level ORDER BY terms. */
  private async sortRows(rows: readonly SourceRecord[], ctx: RuntimeContext): Promise<SourceRecord[]> {
    const sources = this.orderSources();
    const entries: OrderEntry<SourceRecord>[] = rows.map((rec) => {
      // Bind the output record under every source the order terms reference so an
      // output-column field-ref reads it regardless of the `source` it names.
      const row: SourceRow = {};
      for (const s of sources) row[s] = rec;
      return { item: rec, row, group: [row] };
    });
    return sortEntries(entries, this.order, ctx);
  }

  /** Resolve a literal / param bound to a number (undefined when unset). */
  private numericBound(v: number | ParamExprDef | undefined, ctx: RuntimeContext): number | undefined {
    if (v === undefined) return undefined;
    if (typeof v === 'number') return v;
    const n = ctx.param(v.name).toNumber();
    return Number.isNaN(n) ? undefined : n;
  }

  /** Emit `(left) <OP> [ALL] (right) [ORDER BY …] [LIMIT/OFFSET …]`. */
  toSQL(dialect: Dialect, ctx: SqlContext): SqlText {
    const op = `${this.kind.toUpperCase()}${this.all ? ' ALL' : ''}`;
    const parts: SqlText[] = [
      SqlText.join(
        [this.left.toSQL(dialect, ctx).parens(), SqlText.raw(op), this.right.toSQL(dialect, ctx).parens()],
        ' ',
      ),
    ];
    // SET-LEVEL trailing ORDER BY / LIMIT / OFFSET. ORDER BY references OUTPUT
    // COLUMN names (unqualified — a set op has no table to qualify).
    if (this.order.length) {
      const terms = this.order.map((o) => this.orderTermSQL(dialect, ctx, o));
      parts.push(SqlText.raw(' ORDER BY '), SqlText.join(terms, ', '));
    }
    const lo = dialect.limitOffset(boundSQL(this.limit, ctx), boundSQL(this.offset, ctx));
    if (!lo.isEmpty()) parts.push(SqlText.raw(' '), lo);
    return SqlText.concat(parts);
  }

  /** One set-level ORDER BY term: an UNQUALIFIED output column + dir + nulls. */
  private orderTermSQL(dialect: Dialect, ctx: SqlContext, o: QueryOrder): SqlText {
    // A set op's ORDER BY can only name output columns, so a field-ref emits its
    // bare (unqualified) field name; any other expr falls back to its own SQL.
    const col = o.expr instanceof FieldRefExpr ? dialect.ident(o.expr.field) : o.expr.toSQL(dialect, ctx);
    return SqlText.concat([
      col,
      SqlText.raw(` ${o.dir.toUpperCase()}`),
      o.nulls ? SqlText.raw(` NULLS ${o.nulls.toUpperCase()}`) : SqlText.empty(),
    ]);
  }

  /** Serialize back to a `SetOperationDef`, omitting empty / default fields. */
  toJSON(): SetOperationDef {
    const def: SetOperationDef = { kind: this.kind, left: this.left.toJSON(), right: this.right.toJSON() };
    if (this.all) def.all = true;
    if (this.order.length) def.order = this.order.map((o) => o.toJSON());
    if (this.limit !== undefined) def.limit = cloneBound(this.limit);
    if (this.offset !== undefined) def.offset = cloneBound(this.offset);
    return def;
  }

  /** Deep-clone this set operation (cloning both arms and order terms). */
  clone(): SetOperationQuery {
    return new SetOperationQuery(
      this.kind,
      this.left.clone(),
      this.right.clone(),
      this.all,
      this.order.map((o) => o.clone()),
      cloneBound(this.limit),
      cloneBound(this.offset),
    );
  }
}

/** Recursively collect the `source` names of every `field-ref` in `e`. */
function collectFieldRefSources(e: Expr, out: Set<string>): void {
  if (e instanceof FieldRefExpr) out.add(e.source);
  e.forEachChild((c) => collectFieldRefSources(c, out));
}

/** Clone a limit/offset bound (number stays, param def is copied). */
function cloneBound(v: number | ParamExprDef | undefined): number | ParamExprDef | undefined {
  if (v === undefined || typeof v === 'number') return v;
  return { ...v };
}

/* v8 ignore start -- compile-time exhaustiveness guard; unreachable at runtime */
function assertNever(value: never): never {
  throw new Error(`SetOperationQuery: unhandled kind ${JSON.stringify(value)}`);
}
/* v8 ignore stop */

const _check: QueryClass = SetOperationQuery;
void _check;
