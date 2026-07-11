/**
 * QueryJoin — a join over another source. Its `on` is one of two shapes:
 *
 *  - a RELATION crossing (`{ kind:'relation', source, field, as }`): join the
 *    bound `source`'s relation `field` into its target, bound under the REQUIRED
 *    alias `as`. There is NO explicit ON — the key is SYNTHESIZED from the
 *    relation field type's `resolveKey(relationField, thisType, target)` (see
 *    `RelationFieldType`), applying the author's `by`/`target`/`owns` hints or the
 *    default convention (belongs-to ⇒ `this.<rel>Id = target.id`; has-many ⇒
 *    `this.id = target.<thisType>Id`). This reproduces the old relation-path
 *    traversal EXACTLY: LEFT by default, nullable-widened, multi-hop expressed as
 *    CHAINED relation joins (each hop names the previous hop's `as`). `and` adds
 *    an OPTIONAL extra predicate ANDed with the synthesized key.
 *
 *  - a MANUAL join over a source def (`type` / `aliased` / `subquery` /
 *    `function`): the source is added directly (bound under the Type name for
 *    `type`, else its `as`) and `and` IS the ON condition (absent ⇒ a cross join).
 *
 * BINDING: a relation join binds the joined rows under its REQUIRED `as`; a
 * manual join binds them under the source's own bound name. Either way the bound
 * alias is what field-refs into the joined source reference.
 */
import type { ExprDef, JoinDef, JoinOnDef } from '../schema';
import type { Registry } from '../registry';
import type { QueryEngine } from '../engine';
import type { QueryScope } from '../scope';
import type { Problems } from '../problem';
import { canonicalize, type Expr, type ValidateContext } from '../expr';
import { checkBoolCondition } from './_condition';
import type { RuntimeContext } from '../runtime/context';
import type { SourceRow } from '../runtime/row';
import type { Type } from '../type';
import type { ResolvedRelationOn } from '../field-types/relation';
import type { RelationOnPair } from '../backing';
import { resolveRelationOnRun, resolveRelationOnSql } from '../backing';
import { RelationFieldType } from '../field-types/index';
import { Value } from '../runtime/value';
import type { SourceRecord } from '../runtime/row';
import { QuerySource } from './source';
import type { Dialect } from '../sql/dialect';
import { type SqlContext, SqlText } from '../sql/emit';
import type { JoinCtePlanner } from '../sql/planner';
import { obj, str, enumOf, exprRef, lit, sourceRef, isRecord, INVALID, type Shape } from '../shape';

/**
 * A parsed join `on`: a RELATION crossing (key synthesized from the relation) or
 * a MANUAL join over an added `QuerySource` (ON supplied by `JoinDef.and`).
 */
export type JoinOn =
  | { readonly kind: 'relation'; readonly source: string; readonly field: string; readonly as: string }
  | { readonly kind: 'source'; readonly source: QuerySource };

/** One materialized hop of a join (relation or manual source). */
export interface JoinHop {
  /** Alias of the left (source) side of a relation hop (unused for a manual source). */
  leftAlias: string;
  /** Alias the joined source is bound under. */
  targetAlias: string;
  /** The joined Type (a synthetic type for a subquery / function source). */
  targetType: Type;
  /**
   * Physical ON key-column pairs, oriented to `leftAlias` / `targetAlias` (ALL
   * ANDed; composite FKs). Empty for a manual source join (whose ON is `and`).
   */
  keys: readonly RelationOnPair[];
  /** A custom ON backing (overrides `keys`), with its oriented aliases. */
  custom?: ResolvedRelationOn['custom'];
  /** Present ⇒ a MANUAL source join: this source is added and `and` is its ON. */
  source?: QuerySource;
}

/** Whether every key pair equates `leftRec.localField` to `targetRec.foreignField`. */
function keysMatch(
  keys: readonly RelationOnPair[],
  leftRec: SourceRecord | undefined,
  targetRec: SourceRecord,
): boolean {
  for (const k of keys) {
    const lv = Value.of(leftRec?.[k.localField] ?? null);
    const fv = Value.of(targetRec[k.foreignField] ?? null);
    if (!lv.equals(fv)) return false;
  }
  return true;
}

/** The SQL join type applied to a join. */
export type JoinType = 'inner' | 'left' | 'right' | 'full';

/** The `relation` branch of a join `on` (structural shape). */
const RELATION_ON_SHAPE: Shape<JoinOn> = obj(
  {
    kind: lit('relation'),
    source: str('SourceName'),
    field: str('FieldName'),
    as: str('SourceName'),
  },
  (v) => ({ kind: 'relation', source: v.source, field: v.field, as: v.as }),
  { aid: 'JoinOn' },
);

/**
 * A join's `on`: a `relation` crossing (dispatched by `kind:'relation'`) or a
 * MANUAL join over a source def (`type` / `aliased` / `subquery` / `function`),
 * parsed via the shared `sourceRef` and wrapped as `{ kind:'source', source }`.
 */
const JOIN_ON_SHAPE: Shape<JoinOn> = {
  check(json, ctx) {
    if (isRecord(json) && json['kind'] === 'relation') {
      return RELATION_ON_SHAPE.check(json, ctx);
    }
    const src = sourceRef().check(json, ctx);
    return src === INVALID ? INVALID : { kind: 'source', source: src };
  },
};

/** A join over another source — a relation crossing (key synthesized) or a manual source-def join. */
export class QueryJoin {
  private constructor(
    /** The join target: a relation crossing or a manually-joined source. */
    readonly on: JoinOn,
    /** For a `relation` `on`, an extra predicate ANDed with the synthesized key;
     *  for a source-def `on`, the ON condition itself (absent ⇒ a cross join). */
    readonly and: Expr | undefined,
    /** The join type (defaults to `'left'`). */
    readonly joinType: JoinType,
  ) {}

  /** Build a `QueryJoin` from its authored `JoinDef` (parsing `on` + the optional `and`). */
  static from(def: JoinDef, registry: Registry): QueryJoin {
    const on: JoinOn =
      def.on.kind === 'relation'
        ? { kind: 'relation', source: def.on.source, field: def.on.field, as: def.on.as }
        : { kind: 'source', source: QuerySource.from(def.on, registry) };
    const and = def.and ? registry.parseExpr(def.and) : undefined;
    return new QueryJoin(on, and, def.joinType ?? 'left');
  }

  /**
   * Owned structural {@link Shape} for a `JoinDef` (`{ on, and?, joinType? }`) —
   * the zod-free parallel to {@link from}. `on` is a relation crossing or a
   * source def; the synthesized relation key is never authored. Never throws;
   * accumulates. See `shape/`.
   */
  static readonly SHAPE: Shape<QueryJoin> = obj(
    {
      on: JOIN_ON_SHAPE,
      and: exprRef(),
      joinType: enumOf(['inner', 'left', 'right', 'full'] as const, 'JoinType'),
    },
    (v) => new QueryJoin(v.on, v.and, v.joinType ?? 'left'),
    { optional: ['and', 'joinType'], aid: 'Join' },
  );

  /** A short readable form of the join (e.g. `'user.orders'` / `'order'`). */
  get label(): string {
    return this.on.kind === 'relation' ? `${this.on.source}.${this.on.field}` : this.on.source.alias;
  }

  /**
   * Build the per-join plan given the known alias → Type map (root source +
   * earlier joins). Returns `undefined` when a relation is unresolvable (used by
   * validation to report a problem). The returned array always holds exactly one
   * hop on success.
   */
  buildPlan(engine: QueryEngine, aliasTypes: ReadonlyMap<string, Type>): JoinHop[] | undefined {
    if (this.on.kind === 'source') {
      const src = this.on.source;
      const type = src.resolvedType(engine, engine.globalScope().child()).type;
      return [{ leftAlias: src.alias, targetAlias: src.alias, targetType: type, keys: [], source: src }];
    }
    const root = aliasTypes.get(this.on.source);
    if (!root) return undefined;
    const field = root.field(this.on.field);
    if (!field || !(field.fieldType instanceof RelationFieldType)) return undefined;
    const rel = field.fieldType;
    const target = engine.type(rel.to);
    if (!target) return undefined;
    const targetAlias = this.on.as;
    const resolved = rel.resolveOn(engine, this.on.field, root, target, this.on.source, targetAlias);
    return [
      {
        leftAlias: this.on.source,
        targetAlias,
        targetType: target,
        keys: resolved.keys,
        custom: resolved.custom,
      },
    ];
  }

  /**
   * Validate this join: for a MANUAL source join, the added source itself; for
   * EITHER kind, the `and` predicate (required to resolve to a boolean, a bare
   * `param` exempt as in `logical`). The synthesized relation key is never
   * authored, so nothing else here needs validating.
   */
  validateWalk(engine: QueryEngine, scope: QueryScope, p: Problems, ctx: ValidateContext): void {
    const on = this.on;
    if (on.kind === 'source') {
      p.at('on', () => on.source.validateWalk(engine, scope, p));
    }
    if (!this.and) return;
    p.at('and', () => {
      const rt = this.and!.validateWalk(engine, scope, p, ctx);
      checkBoolCondition(this.and!, rt, p);
    });
  }

  /**
   * The alias the joined source binds under, given the known alias → Type map —
   * the name `filters` / field-refs reference. `undefined` when unresolvable.
   */
  finalAlias(engine: QueryEngine, aliasTypes: ReadonlyMap<string, Type>): string | undefined {
    const plan = this.buildPlan(engine, aliasTypes);
    return plan?.[0]?.targetAlias;
  }

  /**
   * The row-multiplication factor this join applies for cost estimation: the
   * `count` of the relation field (one-to-one ⇒ ×1, fan-out ⇒ ×count), or the
   * joined source's row count for a manual join. Returns `1` when unresolvable.
   */
  expansionFactor(engine: QueryEngine, aliasTypes: ReadonlyMap<string, Type>): number {
    if (this.on.kind === 'source') {
      const type = this.on.source.resolvedType(engine, engine.globalScope().child()).type;
      return Math.max(1, type.count);
    }
    const root = aliasTypes.get(this.on.source);
    if (!root) return 1;
    const field = root.field(this.on.field);
    if (!field || !(field.fieldType instanceof RelationFieldType)) return 1;
    return Math.max(1, field.fieldType.count);
  }

  /**
   * Register this join's hop(s) with the SQL `planner`. A relation hop
   * synthesizes its key (custom ON / composite keys) and ANDs any `and`; a
   * MANUAL source hop adds the source's own FROM fragment and uses `and` as the
   * ON (`1 = 1` when absent). Shared by SELECT / UPDATE / DELETE emission.
   */
  emitInto(dialect: Dialect, ctx: SqlContext, planner: JoinCtePlanner, plan: readonly JoinHop[]): void {
    for (const hop of plan) {
      if (hop.source) {
        const onSql = this.and ? this.and.toSQL(dialect, ctx) : SqlText.raw('1 = 1');
        planner.requireJoin({
          leftAlias: hop.leftAlias,
          alias: hop.targetAlias,
          targetType: hop.targetType,
          keys: [],
          customOn: onSql,
          joinType: this.joinType,
          sourceSql: hop.source.fromSQL(dialect, ctx),
        });
        continue;
      }
      let extraOn: SqlText | undefined;
      let andKey: string | undefined;
      if (this.and) {
        extraOn = this.and.toSQL(dialect, ctx);
        andKey = canonicalize(this.and);
      }
      const customOn = hop.custom
        ? resolveRelationOnSql(hop.custom.on, hop.custom.localAlias, hop.custom.joinedAlias, ctx)
        : undefined;
      planner.requireJoin({
        leftAlias: hop.leftAlias,
        alias: hop.targetAlias,
        targetType: hop.targetType,
        keys: hop.keys,
        customOn,
        joinType: this.joinType,
        andKey,
        extraOn,
      });
    }
  }

  /** Expand `leftRows` over the resolved plan, returning the joined rows. */
  async expand(
    ctx: RuntimeContext,
    leftRows: readonly SourceRow[],
    plan: readonly JoinHop[],
  ): Promise<SourceRow[]> {
    let rows: SourceRow[] = [...leftRows];
    for (const hop of plan) {
      rows = await this.applyHop(ctx, rows, hop, this.and);
    }
    return rows;
  }

  /** Apply a single hop, honoring the join type + optional `and` predicate. */
  private async applyHop(
    ctx: RuntimeContext,
    leftRows: readonly SourceRow[],
    hop: JoinHop,
    andExpr: Expr | undefined,
  ): Promise<SourceRow[]> {
    // A MANUAL source join draws its rows from the source itself (keyed under
    // its bound alias); a relation join reads the target Type's records.
    const targets: readonly SourceRecord[] = hop.source
      ? /* v8 ignore next -- `rows()` always keys the record under `targetAlias`, so `?? {}` never fires */
        (await hop.source.rows(ctx)).map((r) => r[hop.targetAlias] ?? {})
      : /* v8 ignore next -- registered Type ⇒ recordsFor never returns undefined */
        ((await ctx.recordsFor(hop.targetType.name)) ?? []);
    const out: SourceRow[] = [];

    const combine = async (left: SourceRow, ti: number): Promise<SourceRow | null> => {
      const target = targets[ti]!;
      const leftRec = left[hop.leftAlias];
      const merged: SourceRow = { ...left, [hop.targetAlias]: target };
      // Custom ON (runtime `run`/`expr`) wins; else fall back to the key match
      // (a manual source join has no keys ⇒ the empty-key match is vacuously
      // true, so `and` alone decides).
      let ok: boolean | undefined;
      if (hop.custom) {
        ok = await resolveRelationOnRun(hop.custom.on, hop.custom.localAlias, hop.custom.joinedAlias, merged, ctx);
      }
      if (ok === undefined) ok = keysMatch(hop.keys, leftRec, target);
      if (!ok) return null;
      if (andExpr && !(await andExpr.evaluate(ctx, merged)).toBoolean()) return null;
      return merged;
    };

    switch (this.joinType) {
      case 'inner':
        for (const left of leftRows) {
          for (let ti = 0; ti < targets.length; ti++) {
            const c = await combine(left, ti);
            if (c) out.push(c);
          }
        }
        break;
      case 'left':
        for (const left of leftRows) {
          let matched = false;
          for (let ti = 0; ti < targets.length; ti++) {
            const c = await combine(left, ti);
            if (c) {
              out.push(c);
              matched = true;
            }
          }
          if (!matched) out.push(left);
        }
        break;
      case 'right':
        for (let ti = 0; ti < targets.length; ti++) {
          let matched = false;
          for (const left of leftRows) {
            const c = await combine(left, ti);
            if (c) {
              out.push(c);
              matched = true;
            }
          }
          if (!matched) out.push({ [hop.targetAlias]: targets[ti]! });
        }
        break;
      case 'full': {
        const matchedTargets = new Set<number>();
        for (const left of leftRows) {
          let matched = false;
          for (let ti = 0; ti < targets.length; ti++) {
            const c = await combine(left, ti);
            if (c) {
              out.push(c);
              matched = true;
              matchedTargets.add(ti);
            }
          }
          if (!matched) out.push(left);
        }
        for (let ti = 0; ti < targets.length; ti++) {
          if (!matchedTargets.has(ti)) out.push({ [hop.targetAlias]: targets[ti]! });
        }
        break;
      }
      /* v8 ignore next 2 -- exhaustive over JoinType; unreachable */
      default:
        return assertNever(this.joinType);
    }
    return out;
  }

  /** Serialize back to a `JoinDef`, omitting defaults (no `and`, `left` join type). */
  toJSON(): JoinDef {
    const on: JoinOnDef =
      this.on.kind === 'relation'
        ? { kind: 'relation', source: this.on.source, field: this.on.field, as: this.on.as }
        : this.on.source.toJSON();
    const def: JoinDef = { on };
    if (this.and) def.and = this.and.toJSON();
    if (this.joinType !== 'left') def.joinType = this.joinType;
    return def;
  }

  /** Deep-clone this join (cloning the manual source + the optional `and`). */
  clone(): QueryJoin {
    const on: JoinOn =
      this.on.kind === 'relation'
        ? { kind: 'relation', source: this.on.source, field: this.on.field, as: this.on.as }
        : { kind: 'source', source: this.on.source.clone() };
    const andDef: ExprDef | undefined = this.and?.toJSON();
    return new QueryJoin(on, andDef ? this.and!.clone() : undefined, this.joinType);
  }
}

/* v8 ignore start -- compile-time exhaustiveness guard; unreachable at runtime */
function assertNever(value: never): never {
  throw new Error(`QueryJoin: unhandled join type ${JSON.stringify(value)}`);
}
/* v8 ignore stop */
