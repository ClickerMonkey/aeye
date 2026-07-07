/**
 * CTEStatementQuery — `WITH … AS (…) [, …] <final>`. Each CTE is evaluated in
 * order and its rows stored under its name in `ctx.ctes`, so a later CTE / the
 * final statement can read it like a type (FROM that name).
 *
 * Entries come in TWO kinds, split into distinct classes:
 *  - `CTEEntry` — a plain non-recursive `{ name, query }`.
 *  - `CTERecursiveEntry` — a recursive `{ name, base, recursive }`: the `base`
 *    seed runs once, then the `recursive` arm re-runs against the accumulated
 *    rows, appending only NEW rows (deduped by signature) until a fixpoint —
 *    capped by `ctx.maxCteIterations` so a non-terminating recursion stops
 *    safely.
 *
 * `CTEStatement.from` discriminates each entry STRUCTURALLY: a `base`+`recursive`
 * pair is recursive; a `query` is non-recursive.
 */
import type { CTEDef, CTERecursiveDef, QueryDef, CTEStatementDef } from '../schema';
import type { Registry } from '../registry';
import type { QueryEngine } from '../engine';
import type { QueryScope } from '../scope';
import type { Problems } from '../problem';
import type { ValidateContext } from '../expr';
import type { RuntimeContext } from '../runtime/context';
import { recordSignature } from '../runtime/record';
import { Query, type QueryClass, type QueryField, type QueryResult, syntheticType } from './query';
import type { Cost } from '../cost';
import type { Dialect } from '../sql/dialect';
import { type SqlContext, SqlText } from '../sql/emit';

/** A parsed CTE entry — the common surface `CTEStatementQuery` drives. */
interface CteEntry {
  readonly name: string;
  /** Whether this entry needs `WITH RECURSIVE`. */
  readonly recursive: boolean;
  /** The output fields used to bind this CTE's synthetic type downstream. */
  boundFields(engine: QueryEngine, scope: QueryScope): QueryField[];
  /** Validate the entry's inner queries (reporting at `ctes[index]`). */
  validate(engine: QueryEngine, inner: QueryScope, p: Problems, ctx: ValidateContext, index: number): void;
  /** Collect referenced Type names (excluding CTE names). */
  collectReferenced(out: Set<string>, cteNames: ReadonlySet<string>): void;
  /** Evaluate the entry, populating `ctx.ctes[name]`. */
  execute(ctx: RuntimeContext): Promise<void>;
  /** Emit `name AS ( … )`. */
  toSQL(dialect: Dialect, inner: SqlContext): SqlText;
  toJSON(): CTEDef | CTERecursiveDef;
  clone(): CteEntry;
}

/** A non-recursive CTE entry: `{ name, query }`. */
class CTEEntryImpl implements CteEntry {
  readonly recursive = false;
  constructor(
    readonly name: string,
    readonly query: Query,
  ) {}

  boundFields(engine: QueryEngine, scope: QueryScope): QueryField[] {
    return this.query.outputFields(engine, scope);
  }

  validate(engine: QueryEngine, inner: QueryScope, p: Problems, ctx: ValidateContext, index: number): void {
    p.at([index, 'query'], () => this.query.validateWalk(engine, inner, p, ctx));
  }

  collectReferenced(out: Set<string>, cteNames: ReadonlySet<string>): void {
    for (const t of this.query.referencedTypes()) if (!cteNames.has(t)) out.add(t);
  }

  async execute(ctx: RuntimeContext): Promise<void> {
    // A CTE body is a NESTED query — run non-root (see its `toSQL`).
    const res = await ctx.withNonRoot(() => this.query.execute(ctx));
    ctx.ctes.set(this.name, [...res.rows]);
  }

  toSQL(dialect: Dialect, inner: SqlContext): SqlText {
    // A CTE BODY is a nested query — emit it non-root so a Type's `defaultOrder`
    // with `applyTo: 'result'` does not treat it as the entry query.
    return SqlText.concat([dialect.ident(this.name), SqlText.raw(' AS ('), this.query.toSQL(dialect, inner.nonRoot()), SqlText.raw(')')]);
  }

  toJSON(): CTEDef {
    return { name: this.name, query: this.query.toJSON() };
  }

  clone(): CTEEntryImpl {
    return new CTEEntryImpl(this.name, this.query.clone());
  }
}

/** A recursive CTE entry: `{ name, base, recursive }`. */
class CTERecursiveEntryImpl implements CteEntry {
  readonly recursive = true;
  constructor(
    readonly name: string,
    readonly base: Query,
    readonly recursiveArm: Query,
  ) {}

  boundFields(engine: QueryEngine, scope: QueryScope): QueryField[] {
    // The seed defines the CTE's column shape.
    return this.base.outputFields(engine, scope);
  }

  validate(engine: QueryEngine, inner: QueryScope, p: Problems, ctx: ValidateContext, index: number): void {
    p.at([index, 'base'], () => this.base.validateWalk(engine, inner, p, ctx));
    p.at([index, 'recursive'], () => this.recursiveArm.validateWalk(engine, inner, p, ctx));
  }

  collectReferenced(out: Set<string>, cteNames: ReadonlySet<string>): void {
    for (const t of this.base.referencedTypes()) if (!cteNames.has(t)) out.add(t);
    for (const t of this.recursiveArm.referencedTypes()) if (!cteNames.has(t)) out.add(t);
  }

  async execute(ctx: RuntimeContext): Promise<void> {
    // Both arms are NESTED query bodies — run non-root (see its `toSQL`).
    const baseRes = await ctx.withNonRoot(() => this.base.execute(ctx));
    let all = [...baseRes.rows];
    const seen = new Set(all.map(recordSignature));
    ctx.ctes.set(this.name, all);

    let iter = 0;
    while (iter < ctx.maxCteIterations) {
      const res = await ctx.withNonRoot(() => this.recursiveArm.execute(ctx));
      const fresh = res.rows.filter((r) => {
        const k = recordSignature(r);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      if (fresh.length === 0) break;
      all = [...all, ...fresh];
      ctx.ctes.set(this.name, all);
      iter++;
    }
  }

  toSQL(dialect: Dialect, inner: SqlContext): SqlText {
    // Both arms are nested query bodies — emit non-root (see `CTEEntryImpl`).
    const arm = inner.nonRoot();
    const body = SqlText.join(
      [this.base.toSQL(dialect, arm), SqlText.raw('UNION ALL'), this.recursiveArm.toSQL(dialect, arm)],
      ' ',
    );
    return SqlText.concat([dialect.ident(this.name), SqlText.raw(' AS ('), body, SqlText.raw(')')]);
  }

  toJSON(): CTERecursiveDef {
    return { name: this.name, base: this.base.toJSON(), recursive: this.recursiveArm.toJSON() };
  }

  clone(): CTERecursiveEntryImpl {
    return new CTERecursiveEntryImpl(this.name, this.base.clone(), this.recursiveArm.clone());
  }
}

/** Parse a JSON CTE entry into the matching class (structural discrimination). */
function parseEntry(def: CTEDef | CTERecursiveDef, registry: Registry): CteEntry {
  if ('base' in def && 'recursive' in def) {
    return new CTERecursiveEntryImpl(def.name, registry.parseQuery(def.base), registry.parseQuery(def.recursive));
  }
  return new CTEEntryImpl(def.name, registry.parseQuery(def.query));
}

/** A `WITH … AS (…) <final>` statement: ordered (possibly recursive) CTE entries plus the final query that consumes them. */
export class CTEStatementQuery extends Query {
  /** The Registry dispatch discriminant for this query kind. */
  static readonly KIND = 'cte' as const;
  /** This query's `kind` discriminant. */
  readonly kind = CTEStatementQuery.KIND;

  constructor(
    /** The CTE entries, evaluated in order (each non-recursive or recursive). */
    readonly ctes: CteEntry[],
    /** The final query, run with every CTE name bound. */
    readonly final: Query,
  ) {
    super();
  }

  /** Parse a `cte` `QueryDef` into a `CTEStatementQuery`. */
  static from(json: QueryDef, registry: Registry): CTEStatementQuery {
    if (json.kind !== 'cte') throw new Error(`CTEStatementQuery.from: expected 'cte', got '${json.kind}'`);
    const ctes = json.ctes.map((c) => parseEntry(c, registry));
    return new CTEStatementQuery(ctes, registry.parseQuery(json.final));
  }

  /** Bind each CTE name as a synthetic type so downstream refs type-check. */
  private bind(engine: QueryEngine, scope: QueryScope): QueryScope {
    const child = scope.child();
    for (const cte of this.ctes) {
      const cols = cte.boundFields(engine, child);
      child.bind(cte.name, {
        kind: 'type',
        type: syntheticType(cte.name, cols),
        source: cte.name,
        synthetic: true,
      });
    }
    return child;
  }

  /** The output fields — those of the final query, with CTE names bound. */
  outputFields(engine: QueryEngine, scope: QueryScope): QueryField[] {
    return this.final.outputFields(engine, this.bind(engine, scope));
  }

  /** Validate each CTE entry and the final query, all with CTE names bound. */
  validateWalk(engine: QueryEngine, scope: QueryScope, p: Problems, ctx: ValidateContext): void {
    const inner = this.bind(engine, scope);
    p.at('ctes', () => {
      this.ctes.forEach((cte, i) => cte.validate(engine, inner, p, ctx, i));
    });
    p.at('final', () => this.final.validateWalk(engine, inner, p, ctx));
  }

  /** The Type names read by the CTEs + final query, excluding CTE names themselves. */
  referencedTypes(): readonly string[] {
    const names = new Set(this.ctes.map((c) => c.name));
    const out = new Set<string>();
    for (const cte of this.ctes) cte.collectReferenced(out, names);
    for (const t of this.final.referencedTypes()) if (!names.has(t)) out.add(t);
    return [...out];
  }

  /** Estimate `{ rows, bytes }` — the final query's cost, with CTE names bound. */
  cost(engine: QueryEngine, scope: QueryScope): Cost {
    // The statement's cost is its final query's cost, with CTE names bound.
    return this.final.cost(engine, this.bind(engine, scope));
  }

  /** Evaluate each CTE in order (populating `ctx.ctes`), then run the final query. */
  async execute(ctx: RuntimeContext): Promise<QueryResult> {
    for (const cte of this.ctes) await cte.execute(ctx);
    return this.final.execute(ctx);
  }

  /**
   * Emit `WITH [RECURSIVE] <ctes> <final-body>` as EXACTLY ONE `WITH`. The
   * final query's OWN top-level planner CTEs (e.g. a fan-out-aggregate `agg_…`
   * CTE in the final SELECT) are HOISTED into this outer `WITH` list via
   * `final.emitWith` — otherwise the final would prepend its own adjacent
   * `WITH`, producing `WITH a AS(…) WITH agg_… …`, a syntax error (BUG P0-2).
   */
  toSQL(dialect: Dialect, ctx: SqlContext): SqlText {
    const { ctes, body } = this.emitWith(dialect, ctx);
    const recursive = this.ctes.some((c) => c.recursive);
    return SqlText.concat([
      SqlText.raw(recursive ? 'WITH RECURSIVE ' : 'WITH '),
      SqlText.join(ctes, ', '),
      SqlText.raw(' '),
      body,
    ]);
  }

  /**
   * The statement's named CTE definitions MERGED with any top-level planner
   * CTEs the final query would emit, plus the final query's WITH-free body.
   * Lets an enclosing CTE statement hoist this whole set into a single `WITH`.
   */
  override emitWith(dialect: Dialect, ctx: SqlContext): { ctes: ReadonlyArray<SqlText>; body: SqlText } {
    const inner = ctx.withScope(this.bind(ctx.engine, ctx.scope));
    const named = this.ctes.map((cte) => cte.toSQL(dialect, inner));
    const finalParts = this.final.emitWith(dialect, inner);
    return { ctes: [...named, ...finalParts.ctes], body: finalParts.body };
  }

  /** Serialize back to a `CTEStatementDef`. */
  toJSON(): CTEStatementDef {
    return {
      kind: 'cte',
      ctes: this.ctes.map((c) => c.toJSON()),
      final: this.final.toJSON(),
    };
  }

  /** Deep-clone this statement (cloning every CTE entry and the final query). */
  clone(): CTEStatementQuery {
    return new CTEStatementQuery(
      this.ctes.map((c) => c.clone()),
      this.final.clone(),
    );
  }
}

const _check: QueryClass = CTEStatementQuery;
void _check;
