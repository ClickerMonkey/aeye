/**
 * RelationPathExpr — walk one or more relation fields from a source,
 * optionally ending at a scalar field. The planner (Phase 5) synthesizes the
 * joins; here we only RESOLVE the type the path lands on:
 *
 *  - ending at a scalar field  → that `FieldResolved`, nullable-widened
 *    (any traversed relation may miss → the value can be null).
 *  - ending at a relation field → the target `TypeResolved`.
 *
 * Crossing a `>1` relation means the value is multi-valued; this phase keeps
 * the resolved type but always widens nullability. Full fan-out/aggregate
 * semantics are a join-planner concern (Phase 5).
 */
import { z } from 'zod';
import type { ExprDef, JsonValue, RelationPathExprDef } from '../schema';
import type { SchemaOptions } from '../node';
import { relationPathSchema } from '../schema-build';
import type { Registry } from '../registry';
import type { QueryEngine } from '../engine';
import type { QueryScope } from '../scope';
import type { ResolvedType, FieldResolved, TypeResolved } from '../resolved-type';
import type { Problems } from '../problem';
import { Expr, type ExprClass, type ValidateContext } from '../expr';
import { didYouMean } from '../aids';
import { obj, lit, str, list } from '../shape';
import { RelationFieldType } from '../field-types/index';
import { textResult } from './_shared';
import type { Type } from '../type';
import { Value } from '../runtime/value';
import type { RuntimeContext } from '../runtime/context';
import type { SourceRow, SourceRecord } from '../runtime/row';
import type { Cost } from '../cost';
import { bytesOfResolved } from '../cost';
import type { Dialect } from '../sql/dialect';
import type { SqlContext, SqlText } from '../sql/emit';
import { emitRelationPathValue } from '../sql/relation-walk';
import { resolveRelationOnRun } from '../backing';

/** Walks one or more relation fields from a source, optionally ending at a scalar field. */
export class RelationPathExpr extends Expr {
  static readonly KIND = 'relation-path' as const;
  /** Concise LLM-facing summary of this expr kind (see `ExprClass.INSTRUCTIONS`). */
  static readonly INSTRUCTIONS = "Walks relation fields from a source (optionally ending at a scalar); planner synthesizes the joins." as const;
  readonly kind = RelationPathExpr.KIND;

  /** Wrap a relation walk by its root source alias and the segment path to traverse. */
  constructor(
    readonly source: string,
    readonly path: string[],
  ) {
    super();
  }

  /** Reconstruct a RelationPathExpr from its JSON def (validates the `kind` discriminant). */
  static from(json: ExprDef, _registry: Registry): RelationPathExpr {
    if (json.kind !== 'relation-path') {
      throw new Error(`RelationPathExpr.from: expected 'relation-path', got '${json.kind}'`);
    }
    return new RelationPathExpr(json.source, [...json.path]);
  }

  /**
   * Owned structural {@link Shape} — the zod-free parallel parser. Builds a
   * `RelationPathExpr` equal to `from`'s output on a valid def; accumulates
   * problems (bad source / path element) in one pass (never throws). The
   * source / field RESOLUTION remains in `validateWalk`. See `shape/`.
   */
  static readonly SHAPE = obj(
    {
      kind: lit('relation-path'),
      source: str('Source'),
      path: list(str('FieldName')),
    },
    (v) => new RelationPathExpr(v.source, v.path),
    { aid: 'Expr_relation-path' },
  );

  /** Depth-aware Zod schema for this expr kind's JSON shape (per `opts.depth.refs`). */
  static toSchema(opts: SchemaOptions): z.ZodTypeAny {
    // Depth-aware: `refs:'open'` (or a bare call) yields the free-string shape;
    // tighter levels root the path at a known Type's relation (see `refSchema`).
    return relationPathSchema(opts.types ?? [], opts.depth?.refs ?? 'open', opts.cache);
  }

  /**
   * Shared walker for `resolve` / `validateWalk`. Reports into `p` when
   * provided; always returns a total `ResolvedType` (a nullable text
   * placeholder on failure) so resolution never throws.
   */
  private walkPath(engine: QueryEngine, scope: QueryScope, p?: Problems): ResolvedType {
    const root = scope.lookup(this.source);
    if (!root || root.kind !== 'type') {
      p?.error(
        'relation-path.unknown-source',
        `Unknown source '${this.source}' for relation path.${didYouMean(this.source, scope.sources())}`,
      );
      return textResult([], true);
    }
    if (this.path.length === 0) {
      p?.error('relation-path.empty', `Relation path from '${this.source}' is empty.`);
      return root;
    }

    let currentType: Type = root.type;
    let currentSource = root.source;
    let crossedRelation = false;

    for (let i = 0; i < this.path.length; i++) {
      const segment = this.path[i]!;
      const field = currentType.field(segment);
      const last = i === this.path.length - 1;
      if (!field) {
        // A non-final segment must be a RELATION to be traversable, so suggest
        // from the relation fields there; the final segment may be any field.
        const candidates = last
          ? currentType.fields.map((f) => f.name)
          : currentType.relationFields().map((f) => f.name);
        p?.at(['path', i], () => {
          p.error(
            'relation-path.unknown-field',
            `Type '${currentType.name}' has no field '${segment}'.${didYouMean(segment, candidates)}`,
          );
        });
        return textResult([], true);
      }
      const ft = field.fieldType;
      if (ft instanceof RelationFieldType) {
        const target = engine.type(ft.to);
        if (!target) {
          p?.at(['path', i], () => {
            p.error(
              'relation-path.unknown-type',
              `Relation '${segment}' points at unregistered Type '${ft.to}'.${didYouMean(ft.to, engine.registry.typeList().map((t) => t.name))}`,
            );
          });
          return textResult([], true);
        }
        crossedRelation = true;
        currentType = target;
        currentSource = segment;
        if (last) {
          // Path ends on a relation → resolves to the related type.
          const type: TypeResolved = {
            kind: 'type',
            type: currentType,
            source: currentSource,
            synthetic: false,
          };
          return type;
        }
      } else {
        // A scalar field must be the final segment.
        if (!last) {
          p?.at(['path', i], () => {
            p.error(
              'relation-path.not-a-relation',
              `Cannot traverse through scalar field '${segment}'; only relation fields can be walked.`,
            );
          });
          return textResult([], true);
        }
        const resolved: FieldResolved = {
          kind: 'field',
          field,
          type: currentType,
          source: currentSource,
          // Any traversed relation may miss → widen to nullable.
          nullable: field.nullable || crossedRelation,
        };
        return resolved;
      }
    }
    // Unreachable: loop always returns on the last segment.
    return textResult([], true);
  }

  /** Resolve to the type the path lands on (scalar field or related type), nullable-widened. */
  resolve(engine: QueryEngine, scope: QueryScope): ResolvedType {
    return this.walkPath(engine, scope);
  }

  /** Zero rows; cost is just the landed value's byte size (joins are a planner concern). */
  cost(engine: QueryEngine, scope: QueryScope): Cost {
    // The synthesized joins are a query-planning concern; the path itself
    // contributes only the size of the value it lands on.
    return { rows: 0, bytes: bytesOfResolved(this.resolve(engine, scope)) };
  }

  /** Walk the path reporting any unknown source/field/type or scalar-traversal problems. */
  validateWalk(
    engine: QueryEngine,
    scope: QueryScope,
    p: Problems,
    _ctx: ValidateContext,
  ): ResolvedType {
    return this.walkPath(engine, scope, p);
  }

  /**
   * Runtime read of a relation path — SYNTHESIZING each relation hop's join the
   * same way the SQL planner does, so a path crossing a relation that is NOT
   * also an authored join still resolves (matching `toSQL`). Starting from the
   * root source's record + owning Type, each relation hop looks the related
   * record up by the key `RelationFieldType.resolveKey` synthesizes (the same
   * key `emitRelationPathValue` emits), with LEFT-join semantics: a NULL/absent
   * foreign key or a missing related record yields NULL. A trailing scalar
   * field is read through (carrying its field metadata); a path ending on a
   * relation yields the related row's identity, exactly as the SQL emits.
   *
   * Fan-out (`count > 1`) is read as the FIRST matching related record (a
   * single value per row); full row-multiplying fan-out remains a join-planner
   * concern, as in the value-position SQL.
   */
  async evaluate(ctx: RuntimeContext, row: SourceRow | null): Promise<Value> {
    if (!row) return Value.null();
    let rec: SourceRecord | undefined = row[this.source] ?? ctx.correlation?.[this.source];
    let currentType: Type | undefined = ctx.sourceType(this.source) ?? ctx.engine.type(this.source);

    for (let i = 0; i < this.path.length; i++) {
      const seg = this.path[i]!;
      const last = i === this.path.length - 1;
      const field = currentType?.field(seg);
      if (!rec || !currentType || !field) return Value.null();
      const ft = field.fieldType;
      if (ft instanceof RelationFieldType) {
        const target = ctx.engine.type(ft.to);
        if (!target) return Value.null();
        // Resolve the ON honoring any relation backing (physical FK / custom).
        // `_l` / `_r` are in-memory row-map keys only — the SQL side references
        // real table aliases; both drive the SAME predicate logic.
        const resolved = ft.resolveOn(ctx.engine, seg, currentType, target, '_l', '_r');
        /* v8 ignore next -- the `?? []` is dead: `target` is a registered type, so recordsFor(target.name) never returns undefined */
        const records: readonly SourceRecord[] = (await ctx.recordsFor(target.name)) ?? [];
        const sourceRec = rec;
        const custom = resolved.custom;
        let match: SourceRecord | undefined;
        if (custom && (custom.on.run || custom.on.expr)) {
          for (const r of records) {
            const ok = await resolveRelationOnRun(custom.on, custom.localAlias, custom.joinedAlias, { _l: sourceRec, _r: r }, ctx);
            if (ok) { match = r; break; }
          }
        } else {
          match = records.find((r) =>
            resolved.keys.every((k) => {
              // A NULL/absent local key never joins (SQL `NULL = …` is never true).
              const localVal: JsonValue = sourceRec[k.localField] ?? null;
              return localVal !== null && r[k.foreignField] === localVal;
            }),
          );
        }
        if (!match) return Value.null(); // LEFT-join miss ⇒ NULL.
        rec = match;
        currentType = target;
        if (last) {
          // Path ends on the relation ⇒ the related row's identity (as SQL emits).
          const idField = target.identityField();
          const raw = match[idField.name];
          return Value.of(raw === undefined ? null : raw, idField, idField.fieldType);
        }
      } else {
        // A scalar field: necessarily the final segment. Read it through,
        // attaching the field's metadata so text case-sensitivity matches a
        // plain field-ref.
        const raw = rec[seg];
        return Value.of(raw === undefined ? null : raw, field, field.fieldType);
      }
    }
    return Value.null();
  }

  /**
   * Register the join(s) this path needs via the planner (shared/deduped) and
   * reference the joined field. The author never writes ON; the key is
   * synthesized from each relation's `resolveKey`.
   */
  toSQL(dialect: Dialect, ctx: SqlContext): SqlText {
    return emitRelationPathValue(dialect, ctx, this.source, this.path);
  }

  /** Serialize back to its JSON ExprDef. */
  toJSON(): RelationPathExprDef {
    return { kind: 'relation-path', source: this.source, path: [...this.path] };
  }

  /** Deep-copy this expr. */
  clone(): RelationPathExpr {
    return new RelationPathExpr(this.source, [...this.path]);
  }

  /** Render as source-like code (`source.seg1.seg2`). */
  override toCode(): string {
    return `${this.source}.${this.path.join('.')}`;
  }
}

const _check: ExprClass = RelationPathExpr;
void _check;
