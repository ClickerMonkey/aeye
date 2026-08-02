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
import type { ResolvedType, FieldResolved, TypeResolved, RelationResolved, RelationKeyPair } from '../resolved-type';
import { relationOf } from '../resolved-type';
import type { Problems } from '../problem';
import { Expr, type ExprClass, type ValidateContext } from '../expr';
import { didYouMean } from '../aids';
import { obj, lit, str } from '../shape';
import { textResult, relationAsValueMessage, hasManyValueMessage, relationAggregateMessage } from './_shared';
import { checkFieldExpr } from '../write-model';
import { Value } from '../runtime/value';
import type { RuntimeContext } from '../runtime/context';
import type { SourceRow, SourceRecord } from '../runtime/row';
import type { Type } from '../type';
import type { Cost, CostContext } from '../cost';
import { bytesOfResolved } from '../cost';
import type { Dialect } from '../sql/dialect';
import { type SqlContext, SqlText } from '../sql/emit';
import { RelationFieldType } from '../field-types/index';
import { relationIdentityValue, relationIdentitySql } from './_relation-value';
import type { FieldType } from '../field-type';
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
  static readonly INSTRUCTIONS = "`<source>.<field>` — a SCALAR field’s value from a bound source. A ref to a BELONGS-TO RELATION field IS a value: it projects the relation's IDENTITY — the target's key read off THIS row's own key column(s), as an object keyed by the target's identity field names (`{id:'u1'}`, `{tenantId:3,userId:1}`), NULL when unset — planning NO join and applying no target scope. Legal in `fields` / `RETURNING`, `order`, `groupBy`, `is null`, and an identity `=` / `<>` / `in`. To read any OTHER field of the target, cross the relation with a `relation` join (`joins:[{on:{kind:'relation',source,field,as}}]`) then field-ref the join alias. A HAS-MANY ref is REFUSED (`ref.relation-has-many`) — it has no key on this row and its value is a SET: join it, or test membership against a target key. A relation is still NOT a value as an arithmetic operand / `case` arm / function argument / aggregate; and to CORRELATE a subquery, join the relation and compare the joined key — never a relation field-ref against an id/scalar." as const;
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
    // The ORDERED join-key pairs (composite/backing-aware). Each pair's VALUE
    // type is the TARGET-side scalar field's type (the target's PK field for a
    // belongs-to), falling back to the relevant identity when the target column
    // is not a plain scalar field.
    const keys: RelationKeyPair[] = ft.resolveKeys(engine, this.field, ownerType, target).map((kp) => {
      const tf = target.field(kp.foreign);
      // The target-side key column's scalar type. When that column is not a plain
      // scalar field — a HAS-MANY's FK-back column is itself the belongs-to
      // relation — fall back to the OWNER's identity type (this side of a has-many
      // is compared against this row's identity). A belongs-to's target-side key
      // is always the target's plain-scalar PK, so it never reaches the fallback.
      let keyType: FieldType;
      if (tf && !(tf.fieldType instanceof RelationFieldType)) {
        keyType = tf.fieldType;
      } else {
        /* v8 ignore next -- degenerate: a belongs-to whose target-side key column is not a plain scalar field */
        keyType = (ft.isBelongsTo() ? target : ownerType).identityField().fieldType;
      }
      return { local: kp.local, foreign: kp.foreign, keyType };
    });
    const relation: RelationResolved = {
      source: this.source,
      field: this.field,
      keyField: keys[0]!.local,
      keyType: keys[0]!.keyType,
      to: ft.to,
      count: ft.count,
      belongsTo: ft.isBelongsTo(),
      keys,
    };
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
    // A RELATION field resolves to the whole related row (a `TypeResolved`).
    // Whether that is legal here — and what it MEANS — is decided by
    // `ctx.relationUse` (see `ValidateContext`): an FK-comparison operator
    // handles it itself; an identity-value position reads the key off this row;
    // anywhere else it is refused, with a message that says WHICH of the three
    // reasons applies rather than one blanket code for all of them.
    if (field.fieldType instanceof RelationFieldType) {
      const resolved = this.resolveRelation(engine, bound.type, field.fieldType, p);
      const rel = relationOf(resolved);
      if (rel) this.checkRelationUse(rel, p, ctx);
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

  /**
   * Report the relation-as-value problem for this position, if any. Split into
   * three distinct outcomes because they have three different fixes:
   *  - an identity-value position + a BELONGS-TO ⇒ fine, it has a local key;
   *  - an identity-value position + a HAS-MANY ⇒ there is no key on this row at
   *    all and its "value" is a set, so say that instead of the join-it hint;
   *  - inside an AGGREGATE ⇒ an identity is not summable/averageable/max-able
   *    under any representation, so say that;
   *  - anywhere else ⇒ the long-standing "join it" hint.
   */
  private checkRelationUse(rel: RelationResolved, p: Problems, ctx: ValidateContext): void {
    if (ctx.relationUse === 'compare') return;
    if (ctx.relationUse === 'value') {
      if (rel.belongsTo) return;
      p.error('ref.relation-has-many', hasManyValueMessage(rel));
      return;
    }
    if (ctx.inAggregate) {
      p.error('ref.relation-aggregate', relationAggregateMessage(rel));
      return;
    }
    p.error('ref.relation-not-value', relationAsValueMessage(rel));
  }

  /** Zero rows; cost is just the resolved field's byte size. */
  cost(ctx: CostContext, scope: QueryScope): Cost {
    return { rows: 0, bytes: bytesOfResolved(this.resolve(ctx.engine, scope)) };
  }

  /** A field-ref IS a plain column reference (drives GROUP BY / index-key costing). */
  override fieldRef(): FieldRefExpr {
    return this;
  }

  /** Read the field's runtime value, honoring backing (joins/compute/access security). */
  async evaluate(ctx: RuntimeContext, row: SourceRow | null): Promise<Value> {
    if (!row) return Value.null();
    // A RELATION field's value is its IDENTITY, read off THIS row's own key
    // columns — no join, no target scope. Field-level security still applies
    // (a denied relation reads NULL like any other denied field).
    const identity = relationIdentityValue(this, ctx, row);
    if (identity) return this.securedRun(identity, ctx, row);
    return this.columnValue(ctx, row);
  }

  /**
   * Read this ref as a plain COLUMN, skipping the relation-identity projection.
   *
   * Needed because a belongs-to's local key column and the relation FIELD share
   * a name under the package's name convention (`order.userId` is both the
   * relation and the column holding its key). Every internal reader of a key
   * column — relation comparison lowering, ORDER BY / GROUP BY expansion, an
   * `IN` against a scalar subquery — wants the COLUMN; going through
   * {@link evaluate} would resolve the relation again and hand back the identity
   * object. Backing (compute / lateral / stored-name remap / access) still
   * applies exactly as it does for any other column.
   */
  async columnValue(ctx: RuntimeContext, row: SourceRow | null): Promise<Value> {
    /* v8 ignore next -- defensive: every caller (evaluate, the key-column readers) already has a row */
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

  /**
   * Apply this field's `access` backing (FLS) to an already-computed value: a
   * denied field reads NULL. Shared by the relation-identity path, which
   * bypasses the stored/compute/lateral resolution but must not bypass security.
   */
  private async securedRun(value: Value, ctx: RuntimeContext, row: SourceRow): Promise<Value> {
    /* v8 ignore next 2 -- unreachable: the relation identity only resolves for a source bound to a Type */
    const type = ctx.sourceType(this.source) ?? ctx.engine.type(this.source);
    const access = type ? ctx.engine.fieldBacking(type.name, this.field)?.access : undefined;
    if (!access) return value;
    const ar = await resolveAccessRun(access, this.source, row, ctx);
    return ar.kind === 'visible' && !ar.visible ? Value.null() : value;
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
    // A RELATION field projects its IDENTITY object from this row's own key
    // columns (see `_relation-value.ts`). It plans no join, so it survives an
    // RLS scope that would have hidden the target row — which is the whole
    // point: the FK value belongs to the reader's row, not the target's.
    const identity = relationIdentitySql(this, dialect, ctx);
    if (identity) {
      // An identity only resolves for a source bound to a Type, so the lookup
      // below always finds one — it is re-read here purely to name the Type.
      const rel = ctx.scope.lookup(this.source);
      /* v8 ignore next -- unreachable: `relationIdentitySql` already required a bound Type */
      const owner = rel && rel.kind === 'type' ? rel.type.name : undefined;
      return this.securedSql(identity, dialect, ctx, owner);
    }
    return this.columnSQL(dialect, ctx);
  }

  /**
   * Emit this ref as a plain COLUMN, skipping the relation-identity projection —
   * the SQL twin of {@link columnValue}, and needed for the same reason (a
   * belongs-to's key column shares the relation field's name).
   */
  columnSQL(dialect: Dialect, ctx: SqlContext): SqlText {
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
   * Apply this field's `access` backing (FLS) to an already-emitted fragment —
   * the SQL twin of {@link securedRun}, so a relation identity is secured by the
   * same rule as any other column.
   */
  private securedSql(value: SqlText, dialect: Dialect, ctx: SqlContext, typeName: string | undefined): SqlText {
    /* v8 ignore next -- unreachable: the only caller resolved a bound Type to get here */
    const access = typeName === undefined ? undefined : ctx.engine.fieldBacking(typeName, this.field)?.access;
    if (!access) return value;
    const acc: AccessSql = resolveAccessSql(access, this.source, ctx);
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
