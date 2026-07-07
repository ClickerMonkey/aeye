/**
 * QueryJoin — relation-based join expansion over a SINGLE relation hop.
 *
 * A `JoinDef.on` is a `SourceFieldRef`: `on.source` is the bound source to join
 * FROM, `on.field` its relation field. There is NO explicit ON: the join key is
 * SYNTHESIZED from the relation field type's `resolveKey(relationField, thisType,
 * target)` (see `RelationFieldType`), applying the author's `by`/`target`/`owns`
 * hints or the default convention:
 *  - belongs-to (`count === 1`): `this.<rel>Id = target.id`.
 *  - has-many  (`count > 1`):    `this.id = target.<thisType>Id`.
 *
 * The optional `JoinDef.and` predicate is ANDed with the synthesized key.
 * MULTI-HOP joins are expressed as CHAINED single-hop joins (the `relation-path`
 * EXPR still covers multi-hop value access).
 *
 * BINDING: a joined source binds under its **target TYPE name** by default —
 * NOT the relation field name. So `{ on:{ source:'user', field:'orders' } }`
 * binds the joined rows under `order` (the `orders` relation's target type), and
 * field-refs into it use `source:'order'`. `JoinDef.as` is the optional
 * COLLISION-BREAKER: when set, it overrides the bound alias (e.g. a join whose
 * target type equals the FROM type — otherwise a `source.duplicate` error).
 */
import type { ExprDef, JoinDef, SourceFieldRef } from '../schema';
import type { Registry } from '../registry';
import type { QueryEngine } from '../engine';
import type { QueryScope } from '../scope';
import type { Problems } from '../problem';
import type { Expr, ValidateContext } from '../expr';
import { checkBoolCondition } from './_condition';
import type { RuntimeContext } from '../runtime/context';
import type { SourceRow } from '../runtime/row';
import type { Type } from '../type';
import type { ResolvedRelationOn } from '../field-types/relation';
import type { RelationOnPair } from '../backing';
import { resolveRelationOnRun } from '../backing';
import { RelationFieldType } from '../field-types/index';
import { Value } from '../runtime/value';
import type { SourceRecord } from '../runtime/row';

/** One materialized relation hop in a join. */
export interface JoinHop {
  /** Alias of the left (source) side of this hop. */
  leftAlias: string;
  /** Alias the joined target is bound under. */
  targetAlias: string;
  /** The target Type joined in. */
  targetType: Type;
  /**
   * Physical ON key-column pairs, oriented to `leftAlias` / `targetAlias` (ALL
   * ANDed; composite FKs). Convention or backing `keys`; the non-custom match.
   */
  keys: readonly RelationOnPair[];
  /** A custom ON backing (overrides `keys`), with its oriented aliases. */
  custom?: ResolvedRelationOn['custom'];
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

/** The SQL join type applied to a relation hop. */
export type JoinType = 'inner' | 'left' | 'right' | 'full';

/** A relation-based join over a single relation hop — the ON key is synthesized from the relation field, never written. */
export class QueryJoin {
  private constructor(
    /** The bound source + relation field this join walks (a single hop). */
    readonly on: SourceFieldRef,
    /**
     * The author-supplied alias override (the collision breaker from
     * `JoinDef.as`), or `undefined` to bind under the target TYPE name (the
     * default). Type-name resolution is deferred to `buildPlan` (it has the
     * `engine`, which `from` does not).
     */
    readonly authoredAs: string | undefined,
    /** Optional extra predicate, ANDed with the synthesized key. */
    readonly and: Expr | undefined,
    /** The join type applied to the hop (defaults to `'left'`). */
    readonly joinType: JoinType,
  ) {}

  /** Build a `QueryJoin` from its authored `JoinDef` (parsing the optional `and` predicate). */
  static from(def: JoinDef, registry: Registry): QueryJoin {
    const and = def.and ? registry.parseExpr(def.and) : undefined;
    return new QueryJoin({ source: def.on.source, field: def.on.field }, def.as, and, def.joinType ?? 'left');
  }

  /** A short readable form of the hop (e.g. `'user.orders'`). */
  get label(): string {
    return `${this.on.source}.${this.on.field}`;
  }

  /**
   * Build the per-hop plan (a single hop) given the known alias → Type map (root
   * source + earlier joins). Returns `undefined` when the relation is
   * unresolvable (used by validation to report a problem). The returned array
   * always holds exactly one hop on success.
   */
  buildPlan(engine: QueryEngine, aliasTypes: ReadonlyMap<string, Type>): JoinHop[] | undefined {
    const root = aliasTypes.get(this.on.source);
    if (!root) return undefined;
    const field = root.field(this.on.field);
    if (!field || !(field.fieldType instanceof RelationFieldType)) return undefined;
    const rel = field.fieldType;
    const target = engine.type(rel.to);
    if (!target) return undefined;
    const targetAlias = this.authoredAs !== undefined ? this.authoredAs : target.name;
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
   * Validate this join's optional `and` predicate: walk it against the bound
   * scope, then require it to resolve to a boolean (a bare `param` is exempt,
   * matching `logical`). Recorded at the `and` path so the report underlines the
   * offending predicate. The synthesized key is never authored, so nothing else
   * here needs validating.
   */
  validateWalk(engine: QueryEngine, scope: QueryScope, p: Problems, ctx: ValidateContext): void {
    if (!this.and) return;
    p.at('and', () => {
      const rt = this.and!.validateWalk(engine, scope, p, ctx);
      checkBoolCondition(this.and!, rt, p);
    });
  }

  /**
   * The alias the joined source binds under, given the known alias → Type map —
   * the name `filters` / field-refs reference. Resolves to the authored `as`
   * when set, else the hop's target TYPE name. `undefined` when unresolvable.
   */
  finalAlias(engine: QueryEngine, aliasTypes: ReadonlyMap<string, Type>): string | undefined {
    const plan = this.buildPlan(engine, aliasTypes);
    return plan?.[0]?.targetAlias;
  }

  /**
   * The row-multiplication factor this join applies for cost estimation: the
   * `count` of the relation field (one-to-one ⇒ ×1, fan-out ⇒ ×count). Returns
   * `1` when unresolvable.
   */
  expansionFactor(_engine: QueryEngine, aliasTypes: ReadonlyMap<string, Type>): number {
    const root = aliasTypes.get(this.on.source);
    if (!root) return 1;
    const field = root.field(this.on.field);
    if (!field || !(field.fieldType instanceof RelationFieldType)) return 1;
    return Math.max(1, field.fieldType.count);
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
    /* v8 ignore next -- the hop target is always a registered Type, so recordsFor never returns undefined */
    const targets = (await ctx.recordsFor(hop.targetType.name)) ?? [];
    const out: SourceRow[] = [];

    const combine = async (left: SourceRow, ti: number): Promise<SourceRow | null> => {
      const target = targets[ti]!;
      const leftRec = left[hop.leftAlias];
      const merged: SourceRow = { ...left, [hop.targetAlias]: target };
      // Custom ON (runtime `run`/`expr`) wins; else fall back to the key match.
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

  /** Serialize back to a `JoinDef`, omitting defaults (no `as`, no `and`, `left` join type). */
  toJSON(): JoinDef {
    const def: JoinDef = { on: { source: this.on.source, field: this.on.field } };
    if (this.authoredAs !== undefined) def.as = this.authoredAs;
    if (this.and) def.and = this.and.toJSON();
    if (this.joinType !== 'left') def.joinType = this.joinType;
    return def;
  }

  /** Deep-clone this join (cloning the optional `and` predicate). */
  clone(): QueryJoin {
    const andDef: ExprDef | undefined = this.and?.toJSON();
    return new QueryJoin(
      { source: this.on.source, field: this.on.field },
      this.authoredAs,
      andDef ? this.and!.clone() : undefined,
      this.joinType,
    );
  }
}

/* v8 ignore start -- compile-time exhaustiveness guard; unreachable at runtime */
function assertNever(value: never): never {
  throw new Error(`QueryJoin: unhandled join type ${JSON.stringify(value)}`);
}
/* v8 ignore stop */
