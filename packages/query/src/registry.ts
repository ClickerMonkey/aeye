/**
 * Registry — central authority for the query meta-model.
 *
 * Responsibilities (this phase):
 *  - Map `kind → FieldTypeClass` for field-type JSON parse dispatch (WIRED).
 *  - `parseFieldType(json)` / `parseType(json)` reconstruct instances.
 *  - Named-Type registration + lookup.
 *
 * Scaffolding for later phases (maps + register methods present, but the
 * corresponding `parse*` paths throw a clear "not yet registered" error
 * until Phase 2/3/5 register the classes):
 *  - `exprClasses`   (Phase 2), `queryClasses` (Phase 3),
 *  - `dialects`      (Phase 5), `functions`    (Phase 2/4).
 *
 * Dispatch is always a map lookup + delegation to the class's static
 * `from` — never a central switch on `kind`.
 */
import type { ExprDef, FieldTypeDef, FunctionDef, QueryDef, TypeDef } from './schema';
import type { Problems } from './problem';
import type { FieldType, FieldTypeClass } from './field-type';
import { Expr, type ExprClass } from './expr';
import { INVALID, isRecord, type Shape } from './shape';
import { aidInfo, describeInput, didYouMean } from './aids';
import type { Query, QueryClass } from './queries/query';
import { QuerySource } from './queries/source';
import type { FunctionRun } from './runtime/functions';
import type { Dialect } from './sql/dialect';
import type { TypeBacking, DefaultCondition } from './backing';
import { Type } from './type';
import { Field } from './field';
import { RelationFieldType, BUILTIN_FIELD_TYPES } from './field-types/index';
import { BUILTIN_EXPRS } from './exprs/index';
import { BUILTIN_QUERIES } from './queries/index';
import { builtinDialects } from './sql/index';
import { BUILTIN_LIBRARY } from './runtime/builtins';

/**
 * Allowed charset for a registered function name. Names are raw-interpolated
 * into emitted SQL (`${name}(`), so only a safe SQL identifier — letters,
 * digits, underscores, and dotted schema-qualification — is permitted.
 */
const FUNCTION_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_.]*$/;

/**
 * Validate a backing's default conditions at registration: every EXPLICIT
 * `without` field must name a real field on the Type (a derived `without` reads
 * the predicate's own field-refs, validated elsewhere). Throws a clear error on
 * the first unknown field so a typo surfaces immediately rather than silently
 * failing to lift the scope.
 */
function validateDefaultConditions(type: Type, conditions: readonly DefaultCondition[]): void {
  for (const cond of conditions) {
    for (const field of cond.without ?? []) {
      if (!type.field(field)) {
        throw new Error(
          `registerType: default-condition 'without' field '${field}' does not exist on Type '${type.name}'.`,
        );
      }
    }
  }
}

/**
 * Static contract used to register an Expr class. Phase 2 wires `parseExpr`
 * to dispatch through these. `ExprClass` (from `expr.ts`) is the full
 * contract (`KIND` + `from` + `toSchema`); this alias keeps the historical
 * export name stable for the barrel.
 */
export type ExprClassEntry = ExprClass;

/**
 * Static contract used to register a Query class. Aliased to `QueryClass`
 * (from `queries/query.ts`), the full `KIND` + `from` contract, keeping the
 * historical export name stable for the barrel.
 */
export type QueryClassEntry = QueryClass;

/**
 * Structural contract used to register a SQL Dialect — just a stable `NAME`.
 * The concrete `Dialect` abstract class (in `sql/dialect.ts`) implements it,
 * so dialect INSTANCES register directly.
 */
export interface DialectEntry {
  readonly NAME: string;
}

/**
 * Central authority for the query meta-model: registers and dispatches field
 * types, named Types, Expr / Query classes, dialects, and functions, and parses
 * JSON defs back into instances by `kind`.
 */
export class Registry {
  // ─── Wired this phase ───────────────────────────────────────────────────
  private readonly fieldTypeClasses = new Map<string, FieldTypeClass>();
  private readonly namedTypes = new Map<string, Type>();
  /** Optional dev-side backing per Type name (computed fields / RLS / FLS). */
  private readonly backings = new Map<string, TypeBacking>();
  /** Set when registrations change; cleared once `finalize()` has run. */
  private finalizeDirty = true;

  // ─── Wired this phase (Phase 2): Expr classes ────────────────────────────
  private readonly exprClasses = new Map<string, ExprClass>();

  // ─── Reserved for later phases (populated by their register methods) ─────
  private readonly queryClasses = new Map<string, QueryClassEntry>();
  private readonly dialects = new Map<string, Dialect>();
  private readonly functions = new Map<string, FunctionDef>();
  /** Runtime implementations of registered functions (Phase 3). */
  private readonly functionRuns = new Map<string, FunctionRun>();

  // ─── Field-type registration / dispatch ──────────────────────────────────

  /** Register a built-in FieldType class for JSON parse dispatch. */
  defineFieldType(cls: FieldTypeClass): this {
    this.fieldTypeClasses.set(cls.NAME, cls);
    return this;
  }

  /** Look up the FieldType class for a given kind. */
  fieldTypeClass(kind: string): FieldTypeClass | undefined {
    return this.fieldTypeClasses.get(kind);
  }

  /** Enumerate every registered FieldType class (for schema builders). */
  fieldTypeClassList(): FieldTypeClass[] {
    return Array.from(this.fieldTypeClasses.values());
  }

  /** Registry-level default average bytes per field-type kind (a `Field` with no explicit `bytes` falls back here). */
  private readonly defaultFieldTypeBytes = new Map<string, number>();

  /**
   * Configure the default average stored bytes for a field-type KIND — the
   * fallback a `Field` of that kind uses when it declares no explicit `bytes`
   * (before the field type's own {@link FieldType.avgBytes}). Lets a deployment
   * tune byte-cost estimates centrally (e.g. "our `text` averages 128 bytes").
   */
  setDefaultFieldBytes(kind: string, bytes: number): this {
    this.defaultFieldTypeBytes.set(kind, bytes);
    return this;
  }

  /** The configured default bytes for a field-type kind, or `undefined` when unset. */
  defaultFieldBytes(kind: string): number | undefined {
    return this.defaultFieldTypeBytes.get(kind);
  }

  /** Parse a `FieldTypeDef` into a `FieldType` instance by dispatching on kind. */
  parseFieldType(json: FieldTypeDef): FieldType {
    const cls = this.fieldTypeClasses.get(json.kind);
    if (!cls) {
      throw new Error(`registry.parseFieldType: unknown field-type kind '${json.kind}'`);
    }
    // Pass `this` so composite field types (e.g. `array`) can reconstruct
    // their nested `FieldTypeDef` children; scalar types ignore the argument.
    return cls.from(json, this);
  }

  // ─── Named Type registration / dispatch ──────────────────────────────────

  /**
   * Register a named Type instance for lookup + reference resolution, optionally
   * with its DEV-SIDE `TypeBacking` (computed fields, RLS/FLS, a real source
   * name). The backing is stored keyed by the Type name and read by the engine;
   * the JSON `TypeDef` is untouched, so the LLM-facing schema stays minimal.
   * Back-compatible: `registerType(type)` (no backing) keeps working.
   */
  registerType(type: Type, backing?: TypeBacking): this {
    if (backing?.defaultConditions) validateDefaultConditions(type, backing.defaultConditions);
    this.namedTypes.set(type.name, type);
    if (backing) this.backings.set(type.name, backing);
    this.finalizeDirty = true;
    return this;
  }

  /** The dev-side backing registered for `typeName`, or `undefined`. */
  backing(typeName: string): TypeBacking | undefined {
    return this.backings.get(typeName);
  }

  /**
   * Materialize inverse relation fields across all registered Types (idempotent).
   *
   * For every belongs-to relation field `F` (`count === 1`) on a Type `S` that
   * declares `inverseRelation: R` and points to a registered Type `T`, give `T`
   * a SYNTHETIC has-many relation field named `R` back to `S`:
   *  - `to`         = `S.name`;
   *  - `count`      = `max(1, round(S.count / max(1, T.count)))` (rows of S per row of T);
   *  - `inverseVia` = `F.name` (so its join key reuses F's foreign key);
   *  - `nullable`   = true; `synthetic` = true (omitted from `T.toJSON()`).
   *
   * Re-running is a no-op once every inverse already exists (the existence
   * guard skips already-materialized or author-declared fields). Cleared via a
   * dirty flag so repeated engine entry points pay nothing after the first run.
   */
  finalize(): this {
    if (!this.finalizeDirty) return this;
    this.finalizeDirty = false;
    // Collect first, then apply, so iterating a Type's fields is never mutated
    // mid-walk (matters for self-referential relations).
    const pending: { target: Type; field: Field }[] = [];
    for (const source of this.namedTypes.values()) {
      for (const field of source.fields) {
        const ft = field.fieldType;
        if (!(ft instanceof RelationFieldType)) continue;
        if (ft.count !== 1 || ft.inverseRelation === undefined) continue;
        const target = this.namedTypes.get(ft.to);
        if (!target || target.field(ft.inverseRelation)) continue;
        const count = Math.max(1, Math.round(source.count / Math.max(1, target.count)));
        const inverseType = new RelationFieldType(source.name, count, undefined, field.name);
        pending.push({
          target,
          field: new Field({
            name: ft.inverseRelation,
            fieldType: inverseType,
            nullable: true,
            synthetic: true,
          }),
        });
      }
    }
    for (const { target, field } of pending) {
      if (target.field(field.name)) continue;
      target.fields.push(field);
    }
    return this;
  }

  /** Look up a registered Type by name. */
  type(name: string): Type | undefined {
    return this.namedTypes.get(name);
  }

  /** Enumerate every registered named Type. */
  typeList(): Type[] {
    return Array.from(this.namedTypes.values());
  }

  /** Parse a `TypeDef` into a `Type` instance (does NOT auto-register). */
  parseType(json: TypeDef): Type {
    return Type.from(json, this);
  }

  // ─── Function registration (Phase 2/4) ────────────────────────────────────

  /**
   * Register a function definition (scalar / aggregate / window / tabular) for
   * lookup and schema generation. The name must be a safe SQL identifier
   * (`^[A-Za-z_][A-Za-z0-9_.]*$`); the dialects raw-interpolate `${name}(` when
   * emitting calls, so a non-identifier name is rejected here to guarantee the
   * generated SQL can never contain an unescaped arbitrary string.
   *
   * `sql` — the emitted name when it differs (`log10` → `log`) — is held to the
   * SAME pattern, because it is interpolated through the SAME raw slot: the four
   * call-shaped exprs emit `${fn.sql ?? fn.name}(`. Checking only `name` left
   * the guarantee reachable around, through a field whose whole purpose is to
   * replace the checked one.
   */
  registerFunction(fn: FunctionDef): this {
    for (const [what, value] of [['name', fn.name], ['sql', fn.sql]] as const) {
      if (value !== undefined && !FUNCTION_NAME_PATTERN.test(value)) {
        throw new Error(
          `registry.registerFunction: invalid function ${what} '${value}' — must match ${FUNCTION_NAME_PATTERN.source}.`,
        );
      }
    }
    this.functions.set(fn.name, fn);
    return this;
  }

  /** Look up a registered function definition by name, or `undefined`. */
  function(name: string): FunctionDef | undefined {
    return this.functions.get(name);
  }

  /** Enumerate every registered function definition (for docs / describe). */
  functionList(): FunctionDef[] {
    return Array.from(this.functions.values());
  }

  /**
   * Register a runtime implementation for a function. The run is SHAPE-TAGGED;
   * when a `FunctionDef` is already registered for `name`, its `shape` must
   * match the run's `shape` (so an aggregate def can't be given a scalar run).
   */
  registerFunctionRun(name: string, run: FunctionRun): this {
    const def = this.functions.get(name);
    if (def && def.shape !== run.shape) {
      throw new Error(
        `registry.registerFunctionRun: function '${name}' is declared '${def.shape}' but its run is '${run.shape}'.`,
      );
    }
    this.functionRuns.set(name, run);
    return this;
  }

  /** Look up a function's runtime implementation, if any. */
  functionRun(name: string): FunctionRun | undefined {
    return this.functionRuns.get(name);
  }

  // ─── Expr / Query / Dialect registration (later phases) ───────────────────

  /** Register an Expr class so `parseExpr` can dispatch JSON by `kind`. */
  defineExpr(cls: ExprClass): this {
    this.exprClasses.set(cls.KIND, cls);
    return this;
  }

  /** Look up the Expr class for a given kind. */
  exprClass(kind: string): ExprClass | undefined {
    return this.exprClasses.get(kind);
  }

  /** Enumerate every registered Expr class (for schema builders). */
  exprClassList(): ExprClass[] {
    return Array.from(this.exprClasses.values());
  }

  /** Register a Query class (Phase 3). */
  defineQuery(cls: QueryClassEntry): this {
    this.queryClasses.set(cls.KIND, cls);
    return this;
  }

  /** Look up the Query class for a given kind. */
  queryClass(kind: string): QueryClassEntry | undefined {
    return this.queryClasses.get(kind);
  }

  /** Enumerate every registered Query class (for describe/example builders). */
  queryClassList(): QueryClassEntry[] {
    return Array.from(this.queryClasses.values());
  }

  /** Register a SQL Dialect instance (Phase 5). */
  defineDialect(dialect: Dialect): this {
    this.dialects.set(dialect.NAME, dialect);
    return this;
  }

  /** Look up a registered Dialect by name. */
  dialect(name: string): Dialect | undefined {
    return this.dialects.get(name);
  }

  /** Enumerate every registered Dialect. */
  dialectList(): Dialect[] {
    return Array.from(this.dialects.values());
  }

  /**
   * Parse an `ExprDef` into an `Expr` instance by dispatching on `kind` to
   * the registered class's static `from`. Children are parsed recursively by
   * the class's `from` calling back into this method.
   *
   * An already-built `Expr` instance (e.g. from the `e.*` builder) is a
   * PASS-THROUGH — returned as-is. This is a runtime-boundary widening only: the
   * JSON `ExprDef` types stay pure, but built and parsed exprs compose freely.
   */
  parseExpr(json: ExprDef | Expr): Expr {
    if (json instanceof Expr) return json;
    const cls = this.exprClasses.get(json.kind);
    if (!cls) {
      throw new Error(`registry.parseExpr: unknown expr kind '${json.kind}'`);
    }
    return cls.from(json, this);
  }

  /** The `kind → Shape<Expr>` map, built from every Expr class that owns a `SHAPE`. */
  private checkedExprShapes(): Map<string, Shape<Expr>> {
    const map = new Map<string, Shape<Expr>>();
    for (const cls of this.exprClasses.values()) {
      if (cls.SHAPE) map.set(cls.KIND, cls.SHAPE);
    }
    return map;
  }

  /**
   * DEFENSIVE structural dispatch — the zod-free parallel to {@link parseExpr}.
   * Mirrors it but NEVER throws on bad input: it records one-or-more problems
   * into `problems` (at its current path) and returns the built `Expr` or
   * `undefined`. Children recurse via each class's owned `SHAPE` (see
   * `shape/`), accumulating every structural problem in a single pass.
   *
   * This is the FOUNDATION of the owned structural parser; it is NOT yet the
   * active gate (zod still gates `parseQueryInput`). Only kinds that declare a
   * `static SHAPE` participate — others surface as an unknown-kind problem.
   */
  parseCheckedExpr(json: unknown, problems: Problems): Expr | undefined {
    if (json instanceof Expr) return json;
    if (!isRecord(json)) {
      const got = describeInput(json);
      problems.error(
        'shape.not-object',
        `expected ${aidInfo('Expr').label}${got !== undefined ? `, got ${got}` : ''}`,
      );
      return undefined;
    }
    const kind = json['kind'];
    if (typeof kind !== 'string') {
      problems.error('shape.missing-kind', `expected ${aidInfo('Expr').label} with a string \`kind\` discriminant`);
      return undefined;
    }
    const shapes = this.checkedExprShapes();
    const shape = shapes.get(kind);
    if (!shape) {
      const kinds = Array.from(shapes.keys());
      problems.error(
        'shape.unknown-kind',
        `unknown expression kind \`${kind}\`${didYouMean(kind, kinds)} (available: ${kinds.join(', ')})`,
      );
      return undefined;
    }
    const built = shape.check(json, { problems, registry: this });
    return built === INVALID ? undefined : built;
  }

  /**
   * Parse a `QueryDef` into a `Query` instance by dispatching on `kind` to the
   * registered class's static `from`. Children (sub-selects, CTE arms, …) are
   * parsed recursively by the class's `from` calling back into this method.
   */
  parseQuery(json: QueryDef): Query {
    const cls = this.queryClasses.get(json.kind);
    if (!cls) {
      throw new Error(`registry.parseQuery: unknown query kind '${json.kind}'`);
    }
    return cls.from(json, this);
  }

  /** The `kind → Shape<Query>` map, built from every Query class that owns a `SHAPE`. */
  private checkedQueryShapes(): Map<string, Shape<Query>> {
    const map = new Map<string, Shape<Query>>();
    for (const cls of this.queryClasses.values()) {
      if (cls.SHAPE) map.set(cls.KIND, cls.SHAPE);
    }
    return map;
  }

  /**
   * DEFENSIVE structural dispatch for a QUERY — the zod-free parallel to
   * {@link parseQuery}, mirroring {@link parseCheckedExpr}. NEVER throws on bad
   * input: it records one-or-more problems into `problems` (at its current path)
   * and returns the built `Query` or `undefined`. Children recurse via each
   * class's owned `SHAPE` (see `shape/`), accumulating every structural problem
   * in a single pass. Only query kinds that declare a `static SHAPE` participate.
   */
  parseCheckedQuery(json: unknown, problems: Problems): Query | undefined {
    if (!isRecord(json)) {
      const got = describeInput(json);
      problems.error(
        'shape.not-object',
        `expected ${aidInfo('Query').label}${got !== undefined ? `, got ${got}` : ''}`,
      );
      return undefined;
    }
    const kind = json['kind'];
    if (typeof kind !== 'string') {
      problems.error('shape.missing-kind', `expected ${aidInfo('Query').label} with a string \`kind\` discriminant`);
      return undefined;
    }
    const shapes = this.checkedQueryShapes();
    const shape = shapes.get(kind);
    if (!shape) {
      const kinds = Array.from(shapes.keys());
      problems.error(
        'shape.unknown-kind',
        `unknown query kind \`${kind}\`${didYouMean(kind, kinds)} (available: ${kinds.join(', ')})`,
      );
      return undefined;
    }
    const built = shape.check(json, { problems, registry: this });
    return built === INVALID ? undefined : built;
  }

  /**
   * DEFENSIVE structural dispatch for a query SOURCE (the FROM / subquery /
   * function source shapes) — the zod-free parallel to `QuerySource.from`.
   * NEVER throws: records problems and returns the built `QuerySource` or
   * `undefined`. Dispatches on the source `kind` over `QuerySource.SHAPES`.
   */
  parseCheckedSource(json: unknown, problems: Problems): QuerySource | undefined {
    if (!isRecord(json)) {
      const got = describeInput(json);
      problems.error(
        'shape.not-object',
        `expected ${aidInfo('Source').label}${got !== undefined ? `, got ${got}` : ''}`,
      );
      return undefined;
    }
    const kind = json['kind'];
    if (typeof kind !== 'string') {
      problems.error('shape.missing-kind', `expected ${aidInfo('Source').label} with a string \`kind\` discriminant`);
      return undefined;
    }
    const shape = QuerySource.SHAPES.get(kind);
    if (!shape) {
      const kinds = Array.from(QuerySource.SHAPES.keys());
      problems.error(
        'shape.unknown-kind',
        `unknown source kind \`${kind}\`${didYouMean(kind, kinds)} (available: ${kinds.join(', ')})`,
      );
      return undefined;
    }
    const built = shape.check(json, { problems, registry: this });
    return built === INVALID ? undefined : built;
  }
}

/**
 * Create a Registry pre-populated with all built-in FieldType classes.
 * Later phases extend this bootstrap with their Expr / Query / Dialect
 * registrations.
 */
export function createRegistry(): Registry {
  const r = new Registry();
  for (const cls of BUILTIN_FIELD_TYPES) r.defineFieldType(cls);
  for (const cls of BUILTIN_EXPRS) r.defineExpr(cls);
  for (const cls of BUILTIN_QUERIES) r.defineQuery(cls);
  for (const d of builtinDialects()) r.defineDialect(d);
  // The shipped default function library: every builtin scalar / aggregate /
  // window function, registered as a `FunctionDef` PLUS its shape-tagged
  // `FunctionRun`, so all four shapes are discoverable and runnable uniformly.
  for (const fn of BUILTIN_LIBRARY) {
    r.registerFunction(fn.def);
    r.registerFunctionRun(fn.def.name, fn.run);
  }
  return r;
}
