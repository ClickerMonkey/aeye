/**
 * Shared relation-path → join lowering, used by both `relation-path` (value
 * position) and `aggregate` (fan-out pre-aggregation). Kept free of any
 * concrete-`Expr` import (it takes `(source, path)` primitives) so the expr
 * classes can depend on it without a load cycle.
 */
import type { Type } from '../type';
import { RelationFieldType } from '../field-types/index';
import type { Dialect } from './dialect';
import { SqlContext, SqlText } from './emit';

/** Resolve the Type a source name is bound to in the current scope. */
function sourceType(ctx: SqlContext, source: string): Type | undefined {
  const bound = ctx.scope.lookup(source);
  return bound && bound.kind === 'type' ? bound.type : undefined;
}

/**
 * Emit a relation-path used as a VALUE, registering one LEFT JOIN per relation
 * hop (shared/deduped via the planner) and returning the final field
 * reference. A path ending on a relation references the target's `id`.
 */
export function emitRelationPathValue(
  dialect: Dialect,
  ctx: SqlContext,
  source: string,
  path: ReadonlyArray<string>,
): SqlText {
  let leftAlias = source;
  let leftType = sourceType(ctx, source);
  if (!leftType || path.length === 0) {
    // Unresolvable source: emit a best-effort qualified reference.
    return dialect.field(source, path[path.length - 1] ?? source);
  }
  for (let i = 0; i < path.length; i++) {
    const seg = path[i]!;
    const last = i === path.length - 1;
    const field = leftType.field(seg);
    if (field && field.fieldType instanceof RelationFieldType) {
      const rel = field.fieldType;
      const target = ctx.engine.type(rel.to);
      if (!target) return dialect.field(leftAlias, seg);
      const key = rel.resolveKey(seg, leftType, target);
      const alias = `${leftAlias}_${seg}`;
      ctx.planner.requireJoin({
        leftAlias,
        alias,
        targetType: target,
        localField: key.localField,
        foreignField: key.foreignField,
        joinType: 'left',
      });
      leftAlias = alias;
      leftType = target;
      if (last) return dialect.field(leftAlias, 'id');
    } else {
      // A scalar field: it must be (and is treated as) the final segment.
      return dialect.field(leftAlias, seg);
    }
    /* v8 ignore next 4 -- defensive: the loop always returns (relation→id, scalar→ref), so its natural exit edge and the trailing return are unreachable */
  }
  return dialect.field(leftAlias, path[path.length - 1]!);
}

/** A fan-out relation-path that an aggregate can pre-compute as a CTE. */
export interface FanoutAggregateInfo {
  /** Alias of the left (source) side the grouped CTE attaches to. */
  leftAlias: string;
  /** Matched field on the left side (joins to the CTE group key). */
  localField: string;
  /** The grouped foreign-key field on the target side. */
  foreignField: string;
  /** The fanned-out target Type. */
  targetType: Type;
  /** Relation field name (used only to name the CTE readably). */
  relationField: string;
  /** The aggregated target field, or `'*'` when the path ends on the relation. */
  argField: string;
}

/**
 * If `(source, path)` is a single fan-out relation hop (optionally ending at a
 * scalar), return the info needed to build a grouped aggregate CTE; else
 * `undefined` (the aggregate then emits normally).
 */
export function fanoutAggregateInfo(
  ctx: SqlContext,
  source: string,
  path: ReadonlyArray<string>,
): FanoutAggregateInfo | undefined {
  if (path.length < 1 || path.length > 2) return undefined;
  const leftType = sourceType(ctx, source);
  if (!leftType) return undefined;
  const seg = path[0]!;
  const field = leftType.field(seg);
  if (!field || !(field.fieldType instanceof RelationFieldType)) return undefined;
  const rel = field.fieldType;
  if (rel.count <= 1) return undefined; // one-to-one ⇒ plain join, not a CTE
  const target = ctx.engine.type(rel.to);
  if (!target) return undefined;
  const key = rel.resolveKey(seg, leftType, target);
  return {
    leftAlias: source,
    localField: key.localField,
    foreignField: key.foreignField,
    targetType: target,
    relationField: seg,
    argField: path.length === 2 ? path[1]! : '*',
  };
}
