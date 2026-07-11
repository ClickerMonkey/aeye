/**
 * `JoinCtePlanner` — algorithm (a): relation-join expansion + shared
 * hidden-join planning.
 *
 * One planner exists per query LEVEL (a SELECT and each of its subqueries get
 * their own). Relation references — authored joins plus the hidden joins a
 * computed / secured field injects — all funnel through it, so equivalent
 * references SHARE a single join (the dedup requirement):
 *
 *  - `requireJoin` adds a plain `LEFT/INNER/… JOIN`, IDEMPOTENT on a canonical
 *    key `(targetAlias, andKey)`. The target alias is deterministic
 *    (`<leftAlias>_<relationField>` or the authored `as`), so two computed
 *    fields walking the SAME relation collapse to ONE join with one alias.
 *  - `requireLateral` / `requireRawJoin` add a correlated LATERAL / a
 *    pre-emitted named join fragment, each deduped on `(alias, key)`.
 *
 * RLS is injected into every planned join's ON. Joins are collected in
 * discovery order (authored joins are registered first, so they lead);
 * `emittedJoins` exposes them for the SELECT emitter to splice into FROM.
 */
import type { QueryEngine } from '../engine';
import type { Type } from '../type';
import type { RelationOnPair } from '../backing';
import type { JoinType } from '../queries/join';
import type { Dialect } from './dialect';
import { SqlText } from './emit';
import type { SqlValue } from './emit';
import type { RlsProvider } from './rls';
import { rlsPredicate } from './rls';
import { QueryTypeError } from '../problem';

/** A relation join to materialize. */
export interface JoinRequest {
  /** Alias of the left (source) side. */
  leftAlias: string;
  /** Alias the joined target binds under (deterministic ⇒ dedup-friendly). */
  alias: string;
  /** The Type joined in. */
  targetType: Type;
  /**
   * Physical key-column pairs forming the ON (ALL ANDed; composite FKs). Each
   * emits `<leftAlias>.<localField> = <alias>.<foreignField>`. Ignored when
   * `customOn` is present (a custom predicate replaces the key equality).
   */
  keys: ReadonlyArray<RelationOnPair>;
  /**
   * A pre-emitted custom ON predicate (from a `RelationBacking.on`) that
   * REPLACES the `keys` equality entirely; RLS + `extraOn` are still ANDed on.
   */
  customOn?: SqlText;
  /** SQL join type. */
  joinType: JoinType;
  /** Canonical digest of the optional extra predicate (for dedup). */
  andKey?: string;
  /** Pre-emitted extra ON predicate, ANDed with the synthesized key. */
  extraOn?: SqlText;
  /**
   * A pre-emitted source fragment (`… AS "alias"`) for a MANUAL join — a
   * subquery / function / aliased-type source whose SQL is not `sourceTable AS
   * alias`. When present it REPLACES the default `<targetType table> AS <alias>`.
   */
  sourceSql?: SqlText;
}

/** A LATERAL / CROSS-APPLY join over a (pre-emitted) correlated subquery. */
export interface LateralRequest {
  /** Deterministic alias the lateral subquery binds under (drives dedup). */
  alias: string;
  /** The already-emitted subquery SQL (the dialect wraps it in parentheses). */
  subquery: SqlText;
  /** SQL join type — `'left'` keeps outer rows with no match. */
  joinType: 'left' | 'inner';
  /** Extra dedup-key component (e.g. the join name) so identical laterals collapse. */
  key?: string;
}

/** A pre-emitted raw join fragment (the `sql` path of a named `JoinBacking`). */
export interface RawJoinRequest {
  /** Deterministic alias the joined source binds under (drives dedup). */
  alias: string;
  /** The already-emitted join fragment (e.g. `LEFT JOIN … ON …`). */
  sql: SqlText;
  /** Extra dedup-key component (e.g. the join name) so identical joins collapse. */
  key?: string;
}

/** Map a logical join type to its SQL keyword. */
function joinKeyword(type: JoinType): string {
  switch (type) {
    case 'inner':
      return 'INNER';
    case 'left':
      return 'LEFT';
    case 'right':
      return 'RIGHT';
    case 'full':
      return 'FULL';
    /* v8 ignore next 2 -- defensive: `type` exhaustively covers JoinType */
    default:
      return assertNever(type);
  }
}

/** Per-query-level planner that dedupes hidden relation joins. */
export class JoinCtePlanner {
  /** join dedup key → resolved alias. */
  private readonly joinKeys = new Map<string, string>();
  /** Emitted joins, in discovery order. */
  private readonly joins: SqlText[] = [];
  /**
   * IMPLICIT-JOIN mode only (`implicit === true`): the comma-separated FROM /
   * USING source items (`"table" AS "alias"` / a CTE name) and the join-key
   * predicates that move into the statement's WHERE. UPDATE / DELETE can't use
   * the JOIN-clause form (the target is not a FROM item), so each required join
   * is lowered to a source item + a WHERE-able key predicate instead.
   */
  private readonly fromItems: SqlText[] = [];
  private readonly joinPredicates: SqlText[] = [];

  constructor(
    /** The active SQL dialect (identifier quoting, join/array emission). */
    readonly dialect: Dialect,
    /** The engine (Type / source-table lookup, registry for RLS parsing). */
    readonly engine: QueryEngine,
    /** The RLS predicate provider, folded into every planned join / CTE. */
    readonly rls: RlsProvider | undefined,
    /** Bound param values, so RLS predicates with params emit real bindings. */
    readonly params: Readonly<Record<string, SqlValue>> = {},
    /**
     * Implicit-join mode: lower every required join to a FROM/USING source item
     * plus a WHERE-able key predicate (instead of a `JOIN … ON …` clause). Set
     * by UPDATE / DELETE emission, whose target is not part of a FROM list, so
     * joins must be expressed as `… FROM/USING <items> WHERE <keys> AND …`.
     * Relation joins degrade to INNER (matched-row) semantics in this form;
     * LATERAL / raw named joins cannot be expressed and raise a clear error.
     */
    private readonly implicit: boolean = false,
  ) {}

  /**
   * Require a relation join, returning the alias the target is bound under.
   * Idempotent on `(alias, andKey)`: a second identical request reuses the
   * existing join (THE shared-join dedup). RLS for the target is folded into
   * the ON.
   */
  requireJoin(req: JoinRequest): string {
    const key = `J|${req.alias}|${req.andKey ?? ''}`;
    const existing = this.joinKeys.get(key);
    if (existing !== undefined) return existing;

    const onParts: SqlText[] = req.customOn
      ? [req.customOn]
      : req.keys.map((k) =>
          SqlText.join(
            [this.dialect.field(req.leftAlias, k.localField), SqlText.raw('='), this.dialect.field(req.alias, k.foreignField)],
            ' ',
          ),
        );
    const rls = rlsPredicate(this.rls, this.dialect, this.engine, this, req.targetType.name, req.alias);
    if (rls) onParts.push(rls);
    if (req.extraOn) onParts.push(req.extraOn);

    // A MANUAL join supplies its own source fragment (subquery / function /
    // aliased type); a relation join uses the target Type's real table.
    const source = req.sourceSql ?? SqlText.concat([
      this.dialect.ident(this.engine.sourceTable(req.targetType.name)),
      SqlText.raw(' AS '),
      this.dialect.ident(req.alias),
    ]);

    if (this.implicit) {
      // UPDATE/DELETE form: the joined table becomes a FROM/USING item and its
      // ON condition becomes a WHERE-able key predicate. RIGHT/FULL outer joins
      // have no comma-list equivalent, so reject them rather than emit wrong SQL.
      if (req.joinType === 'right' || req.joinType === 'full') {
        throw dmlJoinUnsupported(`a '${req.joinType}' join`);
      }
      this.fromItems.push(source);
      this.joinPredicates.push(SqlText.join(onParts, ' AND '));
      this.joinKeys.set(key, req.alias);
      return req.alias;
    }

    const joinSql = SqlText.concat([
      SqlText.raw(`${joinKeyword(req.joinType)} JOIN `),
      source,
      SqlText.raw(' ON '),
      SqlText.join(onParts, ' AND '),
    ]);
    this.joins.push(joinSql);
    this.joinKeys.set(key, req.alias);
    return req.alias;
  }

  /**
   * Require a LATERAL / CROSS-APPLY join over a correlated subquery, returning
   * the alias it binds under. Idempotent on `(alias, key)`: a named lateral
   * referenced by several fields is emitted ONCE. The subquery is delegated to
   * `dialect.lateralJoin` so each dialect renders its native lateral form
   * (Postgres `LEFT JOIN LATERAL … ON true`, the base dialect a portable
   * `LEFT JOIN LATERAL … ON 1 = 1`). RLS for the subquery's own sources is
   * already folded in when the subquery was emitted (it routes through the same
   * `rlsPredicate` chokepoint), so nothing extra is injected here.
   */
  requireLateral(req: LateralRequest): string {
    const key = `L|${req.alias}|${req.key ?? ''}`;
    const existing = this.joinKeys.get(key);
    if (existing !== undefined) return existing;
    // A LATERAL join has no comma-list (implicit) equivalent.
    if (this.implicit) throw dmlJoinUnsupported('a LATERAL join');
    this.joins.push(this.dialect.lateralJoin(req.subquery, req.alias, req.joinType));
    this.joinKeys.set(key, req.alias);
    return req.alias;
  }

  /**
   * Require a pre-emitted raw join fragment (a named `JoinBacking`'s `sql`
   * path), returning its alias. Idempotent on `(alias, key)`, so a hand-written
   * join shared by several fields is emitted ONCE.
   */
  requireRawJoin(req: RawJoinRequest): string {
    const key = `R|${req.alias}|${req.key ?? ''}`;
    const existing = this.joinKeys.get(key);
    if (existing !== undefined) return existing;
    // A pre-emitted `JOIN … ON …` fragment has no comma-list (implicit) form.
    if (this.implicit) throw dmlJoinUnsupported('a named raw join');
    this.joins.push(req.sql);
    this.joinKeys.set(key, req.alias);
    return req.alias;
  }

  /** The planned joins, in discovery order. */
  emittedJoins(): ReadonlyArray<SqlText> {
    return this.joins;
  }

  /**
   * IMPLICIT-JOIN mode: the FROM/USING source items lowered from required joins,
   * in discovery order. Empty unless the planner was built with `implicit`.
   */
  emittedFromItems(): ReadonlyArray<SqlText> {
    return this.fromItems;
  }

  /**
   * IMPLICIT-JOIN mode: the join-key predicates that move into the statement's
   * WHERE, in discovery order. Empty unless the planner was built with `implicit`.
   */
  emittedJoinPredicates(): ReadonlyArray<SqlText> {
    return this.joinPredicates;
  }

  /** IMPLICIT-JOIN mode: whether any FROM/USING source item was lowered. */
  hasFromItems(): boolean {
    return this.fromItems.length > 0;
  }
}

/** A clear error for a join shape that has no UPDATE…FROM / DELETE…USING form. */
function dmlJoinUnsupported(what: string): QueryTypeError {
  return new QueryTypeError({
    path: [],
    code: 'dml-join.unsupported',
    severity: 'error',
    message: `${what} cannot be expressed in an UPDATE…FROM / DELETE…USING statement; rewrite the join as a WHERE predicate.`,
  });
}

/* v8 ignore start -- defensive exhaustiveness guard; unreachable for valid JoinType */
/** Exhaustiveness guard over `JoinType`. */
function assertNever(value: never): never {
  throw new Error(`JoinCtePlanner: unhandled join type ${JSON.stringify(value)}`);
}
/* v8 ignore stop */
