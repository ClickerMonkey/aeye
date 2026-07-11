/**
 * FieldRefExpr — a direct field reference `<source>.<field>`. Resolves by
 * looking the source up in the scope (expecting a bound type) and finding
 * the named field on it. The resolved nullability is the field's own
 * nullability widened by any nullability the source carries (e.g. an
 * outer-joined source).
 */
import { z } from 'zod';
import type { ExprDef, FieldRefExprDef } from '../schema';
import type { SchemaOptions } from '../node';
import { fieldRefSchema } from '../schema-build';
import type { Registry } from '../registry';
import type { QueryEngine } from '../engine';
import type { QueryScope } from '../scope';
import type { ResolvedType, FieldResolved, TypeResolved, RelationResolved } from '../resolved-type';
import { relationOf } from '../resolved-type';
import type { Problems } from '../problem';
import { Expr, type ExprClass, type ValidateContext } from '../expr';
import { didYouMean } from '../aids';
import { obj, lit, str } from '../shape';
import { textResult, relationAsValueMessage } from './_shared';
import { checkFieldExpr } from '../write-model';
import { Value } from '../runtime/value';
import type { RuntimeContext } from '../runtime/context';
import type { SourceRow, SourceRecord } from '../runtime/row';
import type { Type } from '../type';
import type { Cost } from '../cost';
import { bytesOfResolved } from '../cost';
import type { Dialect } from '../sql/dialect';
import { type SqlContext, SqlText } from '../sql/emit';
import { RelationFieldType } from '../field-types/index';
import {
  resolveAccessSql,
  resolveAccessRun,
  resolveComputeSql,
  resolveComputeRun,
  resolveJoinSql,
  resolveJoinRun,
  resolveRelationOnSql,
  resolveRelationOnRun,
  joinAlias,
  type AccessSql,
  type JoinSqlPlan,
  type JoinRunPlan,
  type JoinSpec,
  type RelationJoinSpec,
} from '../backing';

/** The alias + column a backed field reads from a named LATERAL join's `pick`. */
interface LateralPick {
  /** The join's alias (its rows bind under this on each outer row). */
  readonly alias: string;
  /** The picked column the field's value reads. */
  readonly field: string;
}

/** A direct field reference `<source>.<field>`. */
export class FieldRefExpr extends Expr {
  static readonly KIND = 'field-ref' as const;
  /** Concise LLM-facing summary of this expr kind (see `ExprClass.INSTRUCTIONS`). */
  static readonly INSTRUCTIONS = "`<source>.<field>` — a SCALAR field’s value from a bound source. A ref to a RELATION field resolves to the whole related row, NOT a scalar: to READ a related scalar, cross the relation with a `relation` join (`joins:[{on:{kind:'relation',source,field,as}}]`) then field-ref the join alias. To CORRELATE a subquery, join the relation and compare the joined key — do NOT compare a relation field-ref to an id/scalar. A relation field-ref may only be compared to ANOTHER relation of the same target." as const;
  readonly kind = FieldRefExpr.KIND;

  /** Wrap a `<source>.<field>` reference by its source alias and field name. */
  constructor(
    readonly source: string,
    readonly field: string,
  ) {
    super();
  }

  /** Reconstruct a FieldRefExpr from its JSON def (validates the `kind` discriminant). */
  static from(json: ExprDef, _registry: Registry): FieldRefExpr {
    if (json.kind !== 'field-ref') {
      throw new Error(`FieldRefExpr.from: expected 'field-ref', got '${json.kind}'`);
    }
    return new FieldRefExpr(json.source, json.field);
  }

  /**
   * Owned structural {@link Shape} — the zod-free parallel parser. Builds a
   * `FieldRefExpr` equal to `from`'s output on a valid def; accumulates
   * problems on a bad def (never throws). See `shape/`.
   */
  static readonly SHAPE = obj(
    {
      kind: lit('field-ref'),
      source: str('Source'),
      field: str('FieldName'),
    },
    (v) => new FieldRefExpr(v.source, v.field),
    { aid: 'Expr_field-ref' },
  );

  /** Depth-aware Zod schema for this expr kind's JSON shape (per `opts.depth.refs`). */
  static toSchema(opts: SchemaOptions): z.ZodTypeAny {
    // Depth-aware: `refs:'open'` (or a bare call) yields the free-string shape;
    // tighter levels enumerate / pair `source` + `field` (see `refSchema`).
    return fieldRefSchema(opts.types ?? [], opts.depth?.refs ?? 'open', opts.cache);
  }

  /** Resolve to the named field on the bound source, widening nullability by the source's. */
  resolve(engine: QueryEngine, scope: QueryScope): ResolvedType {
    const bound = scope.lookup(this.source);
    if (!bound || bound.kind !== 'type') {
      // Unknown / non-type source: a nullable text placeholder keeps
      // resolution total; `validateWalk` reports the actual problem.
      return textResult([], true);
    }
    const field = bound.type.field(this.field);
    if (!field) return textResult([], true);
    // A RELATION field is a whole related row, not a scalar — resolve to the
    // related Type (marked as a relation ref) so an operator can key-compare two
    // relations and reject a relation-vs-scalar comparison.
    if (field.fieldType instanceof RelationFieldType) {
      return this.resolveRelation(engine, bound.type, field.fieldType);
    }
    const resolved: FieldResolved = {
      kind: 'field',
      field,
      type: bound.type,
      source: bound.source,
      nullable: field.nullable,
    };
    return resolved;
  }

  /**
   * Resolve a field-ref to a RELATION field to the related `TypeResolved`,
   * carrying the `relation` marker (originating `source.field`, the LOCAL FK-key
   * column, and the target Type name). The target Type is always registered for
   * a well-formed relation; a dangling `to` falls back to a nullable text
   * placeholder (and `validateWalk` reports `ref.relation-target`).
   */
  private resolveRelation(
    engine: QueryEngine,
    ownerType: Type,
    ft: RelationFieldType,
    p?: Problems,
  ): ResolvedType {
    const target = engine.type(ft.to);
    if (!target) {
      p?.error(
        'ref.relation-target',
        `Relation '${this.source}.${this.field}' points at unregistered Type '${ft.to}'.${didYouMean(ft.to, engine.registry.typeList().map((t) => t.name))}`,
      );
      return textResult([], true);
    }
    // The LOCAL key column carrying the value to compare by (belongs-to: the
    // relation field itself, whose stored value is the target's identity;
    // has-many: this Type's identity).
    const keyField = ft.resolveKey(this.field, ownerType, target).localField;
    // The comparable VALUE type: a belongs-to FK holds the TARGET identity's
    // value; a has-many keys on this Type's own identity.
    const keyType = (ft.count === 1 ? target : ownerType).identityField().fieldType;
    const relation: RelationResolved = { source: this.source, field: this.field, keyField, keyType, to: ft.to };
    const resolved: TypeResolved = {
      kind: 'type',
      type: target,
      source: this.field,
      synthetic: false,
      relation,
    };
    return resolved;
  }

  /** Validate the source resolves to a type and has the named field; report problems. */
  validateWalk(
    engine: QueryEngine,
    scope: QueryScope,
    p: Problems,
    ctx: ValidateContext,
  ): ResolvedType {
    const bound = scope.lookup(this.source);
    if (!bound) {
      p.error(
        'ref.unknown-source',
        `Unknown source '${this.source}'. Bind it in a FROM / JOIN (or check the alias).${didYouMean(this.source, scope.sources())}`,
      );
      return textResult([], true);
    }
    if (bound.kind !== 'type') {
      p.error(
        'ref.not-a-type',
        `Source '${this.source}' is not a type, so '${this.field}' cannot be read from it.`,
      );
      return textResult([], true);
    }
    const field = bound.type.field(this.field);
    if (!field) {
      p.error(
        'ref.unknown-field',
        `Type '${bound.type.name}' (source '${this.source}') has no field '${this.field}'.${didYouMean(this.field, bound.type.fields.map((f) => f.name))}`,
      );
      return textResult([], true);
    }
    // WRITE-MODEL: gate the field against the operator kind supplied by a
    // containing gating operator (else `'field-ref'` for a standalone ref).
    checkFieldExpr(ctx.fieldExprKind ?? 'field-ref', field, this.source, p);
    // A RELATION field resolves to the whole related row (a `TypeResolved`), not
    // a scalar. It is a VALUE only inside an FK-comparison operator (which sets
    // `relationValueOk` and runs its own relation-vs-relation / relation-vs-scalar
    // check). Anywhere else — a select field, aggregate/window value,
    // `partitionBy`, `orderBy`, group-by key, function arg — a bare relation
    // field-ref reads as NOTHING at runtime (it may be composite-keyed), so
    // reject it here with the join-it hint instead of letting it silently no-op.
    if (field.fieldType instanceof RelationFieldType) {
      const resolved = this.resolveRelation(engine, bound.type, field.fieldType, p);
      if (!ctx.relationValueOk) {
        const rel = relationOf(resolved);
        if (rel) p.error('ref.relation-not-value', relationAsValueMessage(rel));
      }
      return resolved;
    }
    const resolved: FieldResolved = {
      kind: 'field',
      field,
      type: bound.type,
      source: bound.source,
      nullable: field.nullable,
    };
    return resolved;
  }

  /** Zero rows; cost is just the resolved field's byte size. */
  cost(engine: QueryEngine, scope: QueryScope): Cost {
    return { rows: 0, bytes: bytesOfResolved(this.resolve(engine, scope)) };
  }

  /** Read the field's runtime value, honoring backing (joins/compute/access security). */
  async evaluate(ctx: RuntimeContext, row: SourceRow | null): Promise<Value> {
    if (!row) return Value.null();
    // Fall back to the correlation row so a correlated subquery sees its
    // outer source.
    const rec = row[this.source] ?? ctx.correlation?.[this.source];
    // Resolve the field's OWNING Type from the BOUND source first (alias-aware:
    // an `aliased` source, a self-join, or a join hop bound under its target
    // type name all have a source NAME that differs from the Type name), falling
    // back to a same-named registered Type for the common type-named path. This
    // attaches the field's type metadata — notably text case-sensitivity — so a
    // `sensitive` field still compares case-sensitively under an alias. Subquery
    // / CTE aliases resolve to no Type ⇒ no metadata, matching prior behavior.
    const type = ctx.sourceType(this.source) ?? ctx.engine.type(this.source);
    const fb = type ? ctx.engine.fieldBacking(type.name, this.field) : undefined;
    // Fast path: a plain stored field (no backing) — identical to prior behavior.
    if (!fb || !type) return this.storedValue(rec, this.field, type);

    // 0. Named joins: attach each (shared/deduped) so a `compute` / `access`
    //    Expr reading `<joinAlias>.<col>` resolves; a lateral `pick` is the
    //    default value when the field declares no `compute`.
    const lateralPick = fb.joins ? await this.attachJoinsRun(fb.joins, type.name, row, ctx) : undefined;

    // 1. Value: compute (runtime `run` else `expr`), else a lateral `pick`, else
    //    the stored field (remapped by `name` when set).
    const storedName = fb.name ?? this.field;
    let value: Value;
    if (fb.compute) {
      const cr = await resolveComputeRun(fb.compute, this.source, row, ctx);
      value = cr.kind === 'value' ? cr.value : this.storedValue(rec, storedName, type);
    } else if (lateralPick) {
      value = this.storedValue(row[lateralPick.alias], lateralPick.field, undefined);
    } else {
      value = this.storedValue(rec, storedName, type);
    }

    // 2. Field-level security: a `false`/denied access nulls the value.
    if (fb.access) {
      const ar = await resolveAccessRun(fb.access, this.source, row, ctx);
      if (ar.kind === 'visible' && !ar.visible) return Value.null();
    }
    return value;
  }

  /** Read a stored field off the bound record, attaching the conceptual field's metadata. */
  private storedValue(rec: SourceRecord | undefined, name: string, type: Type | undefined): Value {
    if (!rec) return Value.null();
    const raw = rec[name];
    const field = type?.field(this.field);
    return Value.of(raw === undefined ? null : raw, field, field?.fieldType);
  }

  /**
   * Attach every named join this field opts into onto `row` (runtime), so any
   * `compute` / `access` Expr reading `<joinAlias>.<col>` resolves. Returns the
   * value source of the FIRST lateral with a `pick` (used when the field has no
   * `compute`). Re-attaching an already-attached join is harmless (idempotent
   * per outer row), so fields sharing a join stay consistent.
   */
  private async attachJoinsRun(
    names: readonly string[],
    typeName: string,
    row: SourceRow,
    ctx: RuntimeContext,
  ): Promise<LateralPick | undefined> {
    let pick: LateralPick | undefined;
    for (const name of names) {
      const jb = ctx.engine.joinBacking(typeName, name);
      if (!jb) continue;
      const plan: JoinRunPlan = resolveJoinRun(jb, this.source, ctx);
      switch (plan.kind) {
        case 'none':
          break;
        case 'attach': {
          const attached = await plan.join.attach(row, ctx);
          row[plan.join.alias] = attached ?? {};
          break;
        }
        case 'spec': {
          const got = await this.attachJoinSpecRun(plan.spec, joinAlias(this.source, name), row, ctx);
          if (got && !pick) pick = got;
          break;
        }
        /* v8 ignore next 2 -- unreachable: JoinRunPlan union is exhaustively handled above */
        default:
          return assertNeverJoinRun(plan);
      }
    }
    return pick;
  }

  /** Attach one `JoinSpec` at runtime under `alias`; return a lateral's `pick` source. */
  private async attachJoinSpecRun(
    spec: JoinSpec,
    alias: string,
    row: SourceRow,
    ctx: RuntimeContext,
  ): Promise<LateralPick | undefined> {
    switch (spec.kind) {
      case 'relation':
        await this.attachRelationRun(spec, alias, row, ctx);
        return undefined;
      case 'lateral': {
        // Run the correlated subquery with the outer row installed, taking its
        // first row (a LEFT-JOIN miss ⇒ an empty record ⇒ columns read NULL).
        const q = ctx.engine.coerceQuery(spec.query(this.source));
        const result = await ctx.withCorrelation(row, () => q.execute(ctx));
        row[alias] = result.rows[0] ?? {};
        return spec.pick ? { alias, field: spec.pick } : undefined;
      }
      /* v8 ignore next 2 -- unreachable: JoinSpec union is exhaustively handled above */
      default:
        return assertNeverJoinSpec(spec);
    }
  }

  /** Attach a relation `JoinSpec` at runtime: bind the matched target record under `alias`. */
  private async attachRelationRun(
    spec: RelationJoinSpec,
    alias: string,
    row: SourceRow,
    ctx: RuntimeContext,
  ): Promise<void> {
    const type = ctx.sourceType(spec.source) ?? ctx.engine.type(spec.source);
    const relField = type?.field(spec.relation);
    if (!type || !relField || !(relField.fieldType instanceof RelationFieldType)) return;
    const rel = relField.fieldType;
    const target = ctx.engine.type(rel.to);
    if (!target) return;
    const resolved = rel.resolveOn(ctx.engine, spec.relation, type, target, spec.source, alias);
    /* v8 ignore next -- the `?? []` is dead: `target` is a registered type, so recordsFor(target.name) never returns undefined */
    const records = (await ctx.recordsFor(target.name)) ?? [];
    const sourceRec = row[spec.source];
    const custom = resolved.custom;
    let match: SourceRecord | undefined;
    if (custom && (custom.on.run || custom.on.expr)) {
      // Custom ON is authoritative at runtime — never fall back to the keys.
      for (const r of records) {
        const ok = await resolveRelationOnRun(custom.on, custom.localAlias, custom.joinedAlias, { [spec.source]: sourceRec, [alias]: r }, ctx);
        if (ok) { match = r; break; }
      }
    } else {
      match = records.find((r) =>
        resolved.keys.every((k) => {
          const lv = sourceRec[k.localField] ?? null;
          return lv !== null && r[k.foreignField] === lv;
        }),
      );
    }
    row[alias] = match ?? {};
  }

  /** Emit as a SqlText column ref, lowering backing (joins/compute/access) when present. */
  toSQL(dialect: Dialect, ctx: SqlContext): SqlText {
    const bound = ctx.scope.lookup(this.source);
    const typeName = bound && bound.kind === 'type' ? bound.type.name : undefined;
    const fb = typeName === undefined ? undefined : ctx.engine.fieldBacking(typeName, this.field);
    // Fast path: a plain stored field — `"alias"."field"`.
    if (!fb || typeName === undefined) return dialect.field(this.source, this.field);

    // 0. Named joins: register each (shared/deduped) with the planner so a
    //    `compute` / `access` Expr reading `<joinAlias>.<col>` resolves; a
    //    lateral `pick` is the default value when there is no `compute`.
    const lateralPick = fb.joins ? this.registerJoinsSql(fb.joins, typeName, dialect, ctx) : undefined;

    // 1. Value: compute (SQL `sql` else `expr`), else a lateral `pick`, else the
    //    stored field.
    const storedName = fb.name ?? this.field;
    let value: SqlText;
    if (fb.compute) {
      const cs = resolveComputeSql(fb.compute, this.source, ctx);
      value = cs.kind === 'sql' ? cs.sql : dialect.field(this.source, storedName);
    } else if (lateralPick) {
      value = dialect.field(lateralPick.alias, lateralPick.field);
    } else {
      value = dialect.field(this.source, storedName);
    }

    // 2. Field-level security ⇒ `CASE WHEN <access> THEN <value> ELSE NULL END`.
    if (!fb.access) return value;
    const acc: AccessSql = resolveAccessSql(fb.access, this.source, ctx);
    switch (acc.kind) {
      case 'noop':
      case 'allow':
        return value;
      case 'deny':
        return SqlText.raw('NULL');
      case 'predicate':
        return SqlText.join(
          [SqlText.raw('CASE WHEN'), acc.sql, SqlText.raw('THEN'), value, SqlText.raw('ELSE NULL END')],
          ' ',
        );
      /* v8 ignore next 2 -- unreachable: AccessSql union is exhaustively handled above */
      default:
        return assertNeverAccess(acc);
    }
  }

  /**
   * Register every named join this field opts into with the planner (SQL),
   * deduped on the join's deterministic alias so N fields sharing a join emit
   * ONE join. Returns the value source of the FIRST lateral with a `pick` (used
   * when the field has no `compute`).
   */
  private registerJoinsSql(
    names: readonly string[],
    typeName: string,
    dialect: Dialect,
    ctx: SqlContext,
  ): LateralPick | undefined {
    let pick: LateralPick | undefined;
    for (const name of names) {
      const jb = ctx.engine.joinBacking(typeName, name);
      if (!jb) continue;
      const alias = joinAlias(this.source, name);
      const plan: JoinSqlPlan = resolveJoinSql(jb, this.source, ctx);
      switch (plan.kind) {
        case 'none':
          break;
        case 'sql':
          ctx.planner.requireRawJoin({ alias, sql: plan.sql, key: name });
          break;
        case 'spec': {
          const got = this.lowerJoinSpecSql(plan.spec, alias, name, dialect, ctx);
          if (got && !pick) pick = got;
          break;
        }
        /* v8 ignore next 2 -- unreachable: JoinSqlPlan union is exhaustively handled above */
        default:
          return assertNeverJoinSql(plan);
      }
    }
    return pick;
  }

  /** Lower one `JoinSpec` to a planned join (SQL) under `alias`; return a lateral's `pick`. */
  private lowerJoinSpecSql(
    spec: JoinSpec,
    alias: string,
    name: string,
    dialect: Dialect,
    ctx: SqlContext,
  ): LateralPick | undefined {
    switch (spec.kind) {
      case 'relation':
        this.lowerRelationSql(spec, alias, ctx);
        return undefined;
      case 'lateral': {
        const subquery = ctx.engine.coerceQuery(spec.query(this.source)).toSQL(dialect, ctx);
        ctx.planner.requireLateral({ alias, subquery, joinType: spec.joinType ?? 'left', key: name });
        return spec.pick ? { alias, field: spec.pick } : undefined;
      }
      /* v8 ignore next 2 -- unreachable: JoinSpec union is exhaustively handled above */
      default:
        return assertNeverJoinSpec(spec);
    }
  }

  /** Lower a relation `JoinSpec` to a shared `requireJoin` under `alias`. */
  private lowerRelationSql(spec: RelationJoinSpec, alias: string, ctx: SqlContext): void {
    const src = ctx.scope.lookup(spec.source);
    if (!src || src.kind !== 'type') return;
    const relField = src.type.field(spec.relation);
    if (!relField || !(relField.fieldType instanceof RelationFieldType)) return;
    const rel = relField.fieldType;
    const target = ctx.engine.type(rel.to);
    if (!target) return;
    const resolved = rel.resolveOn(ctx.engine, spec.relation, src.type, target, spec.source, alias);
    const customOn = resolved.custom
      ? resolveRelationOnSql(resolved.custom.on, resolved.custom.localAlias, resolved.custom.joinedAlias, ctx)
      : undefined;
    ctx.planner.requireJoin({
      leftAlias: spec.source,
      alias,
      targetType: target,
      keys: resolved.keys,
      customOn,
      joinType: spec.joinType ?? 'left',
    });
  }

  /** Serialize back to its JSON ExprDef. */
  toJSON(): FieldRefExprDef {
    return { kind: 'field-ref', source: this.source, field: this.field };
  }

  /** Deep-copy this expr. */
  clone(): FieldRefExpr {
    return new FieldRefExpr(this.source, this.field);
  }

  /** Render as source-like code (`source.field`). */
  override toCode(): string {
    return `${this.source}.${this.field}`;
  }
}

/* v8 ignore start -- compile-time exhaustiveness guards; unreachable at runtime when the unions are fully handled */
/** Compile-time exhaustiveness guard over the `AccessSql` union. */
function assertNeverAccess(value: never): never {
  throw new Error(`FieldRefExpr.toSQL: unhandled access kind ${JSON.stringify(value)}`);
}

/** Exhaustiveness guard over the `JoinSqlPlan` union. */
function assertNeverJoinSql(value: never): never {
  throw new Error(`FieldRefExpr: unhandled SQL join plan ${JSON.stringify(value)}`);
}

/** Exhaustiveness guard over the `JoinRunPlan` union. */
function assertNeverJoinRun(value: never): never {
  throw new Error(`FieldRefExpr: unhandled runtime join plan ${JSON.stringify(value)}`);
}

/** Exhaustiveness guard over the `JoinSpec` union. */
function assertNeverJoinSpec(value: never): never {
  throw new Error(`FieldRefExpr: unhandled join spec ${JSON.stringify(value)}`);
}
/* v8 ignore stop */

const _check: ExprClass = FieldRefExpr;
void _check;
