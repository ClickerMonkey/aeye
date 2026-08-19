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
import type { ExprDef, FieldTypeDef, FieldTypeKind, FunctionDef, QueryDef, TypeDef } from './schema';
import { QueryTypeError, type Problem, type Problems } from './problem';
import type { FieldType, FieldTypeClass } from './field-type';
import { FieldTypeRefinement, type FieldTypeImpl, type FieldTypeRefinementDef } from './refinement';
import { z } from 'zod';
import { Expr, type ExprClass } from './expr';
import { INVALID, isRecord, type Shape } from './shape';
import { aidInfo, describeInput, didYouMean } from './aids';
import type { Query, QueryClass } from './queries/query';
import { QuerySource } from './queries/source';
import { QueryOperator, type OperatorDef } from './operator';
import type { FunctionRun, OperatorRun } from './runtime/functions';
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

  /**
   * Every registered field-type KIND, in registration order — the builtin
   * vocabulary a `FieldTypeDef.kind` may name in THIS registry.
   *
   * Exported because "which kinds exist" was previously only answerable by
   * reaching for the `BUILTIN_FIELD_TYPES` array, i.e. by asking the package
   * rather than the registry — which is wrong the moment a deployment builds a
   * registry that is not `createRegistry()`.
   */
  fieldTypeKinds(): FieldTypeKind[] {
    return this.fieldTypeClassList().map((cls) => cls.NAME);
  }

  // ─── Field-type REFINEMENT registration (`as`) ───────────────────────────

  /** Registered refinements by name (see `refinement.ts`). */
  private readonly fieldTypeRefinements = new Map<string, FieldTypeRefinement>();

  /**
   * Register a field-type REFINEMENT — a name over a builtin base, carrying its
   * narrowed options, its model-facing `instructions`, its per-dialect SQL type
   * and cast, and an optional stricter value gate.
   *
   * Every check the declaration is held to runs HERE and throws a
   * `QueryTypeError` (`field-type.bad-refinement`) — see
   * `FieldTypeRefinement.compile`. A refinement that registered half-broken
   * would be wrong on every column that ever named it, so nothing is warned and
   * deferred.
   *
   * ORDERING MATTERS: a stored `{kind:'text', as:'uuid'}` parses against the
   * registry it is handed, so every refinement a catalog names must be
   * registered BEFORE `parseType` runs over it (an unknown name is refused,
   * loudly, rather than silently degrading to the bare base).
   */
  registerFieldType(def: FieldTypeRefinementDef): this {
    this.refuseLateRegistration('registerFieldType', def.name);
    const refinement = FieldTypeRefinement.compile(def, this, (json) => this.parseFieldTypeUnflagged(json));
    this.fieldTypeRefinements.set(refinement.name, refinement);
    this.linkComparability(refinement);
    return this;
  }

  /**
   * SYMMETRIZE the new refinement's declared `comparableWith` against everything
   * already registered — every edge either side names is recorded on BOTH ends.
   *
   * Commutativity of comparability is then STRUCTURAL rather than the declarer's
   * discipline: `a.comparableWith(b)` and `b.comparableWith(a)` cannot disagree,
   * because there is no direction stored to disagree about. Which also means an
   * edge may name a type that is not registered yet — unavoidable for a mutual
   * pair, since one of the two has to be declared first, and the reason this
   * runs on EVERY registration rather than only resolving the new one's list.
   *
   * A one-sided declaration is honoured and NOTED (`warn`) rather than refused.
   * Refusing would make a mutual pair the only legal spelling and force both
   * declarers to know about each other, which is exactly the coupling a
   * registry-level relation removes; and dropping it would silently discard the
   * fact one of them stated. The note is the honest middle, and
   * {@link fieldTypeComparabilityNotes} is where a consumer reads it.
   */
  private linkComparability(added: FieldTypeRefinement): void {
    for (const existing of this.fieldTypeRefinements.values()) {
      if (existing === added) continue;
      const addedNames = added.declaredComparableWith.includes(existing.name);
      const existingNames = existing.declaredComparableWith.includes(added.name);
      if (!addedNames && !existingNames) continue;
      added.linkComparable(existing.name);
      existing.linkComparable(added.name);
      // An edge may cross BASES — that is the point of a declared relation, and
      // it is what `number`↔`money` already does natively. But it is also how a
      // `json` type ends up compared to a `text` one, emitting
      // `"t"."shape" = "t"."token"` for the database to make what it can of. The
      // meet still refuses the pair (a registered name meets only itself), so
      // nothing downstream is typed wrongly; it is worth SAYING, because a
      // cross-base edge is far more often a typo than a decision.
      if (added.base !== existing.base) {
        this.comparabilityNotes.push({
          path: ['registerFieldType', added.name, 'comparableWith'],
          code: 'field-type.cross-base-comparability',
          severity: 'warning',
          message:
            `\`${added.name}\` (a ${added.base}) and \`${existing.name}\` (a ${existing.base}) are declared ` +
            'comparable across DIFFERENT base kinds. The edge is recorded, and the meet still refuses the ' +
            'pair — but a predicate over the two emits a comparison the database resolves however it ' +
            'resolves it. Intended for a pair like a length and a plain number; a typo otherwise.',
        });
      }
      if (addedNames === existingNames) continue;
      const [names, silent] = addedNames ? [added, existing] : [existing, added];
      this.comparabilityNotes.push({
        path: ['registerFieldType', names.name, 'comparableWith'],
        code: 'field-type.one-sided-comparability',
        severity: 'warning',
        message:
          `\`${names.name}\` declares \`comparableWith: ['${silent.name}']\` and \`${silent.name}\` does ` +
          `not name it back. The edge is recorded in BOTH directions — comparability is symmetric by ` +
          `construction here — so \`${silent.name}\` is now comparable with \`${names.name}\` whether or ` +
          'not its declarer intended it. Name it on both sides to say so deliberately.',
      });
    }
  }

  /** One-sided `comparableWith` declarations the registry symmetrized (see {@link linkComparability}). */
  private readonly comparabilityNotes: Problem[] = [];

  /**
   * The `warn`-grade notes {@link registerFieldType} filed while symmetrizing
   * declared comparability. Empty for a registry whose declarations all name
   * each other (or name nothing).
   */
  fieldTypeComparabilityNotes(): readonly Problem[] {
    return this.comparabilityNotes;
  }

  /**
   * Register the CODE half of a refinement — today a stricter value gate, later
   * the in-memory comparison hooks. The counterpart of `registerFunctionRun`
   * beside `registerFunction`, and split from the declaration for the reason
   * {@link FieldTypeImpl} gives: a declaration is PERSISTED, and a zod schema
   * survives `JSON.stringify` as a husk that registers clean and then throws out
   * of zod's own internals at first use.
   *
   * The impl attaches to the compiled refinement, which every column naming it
   * SHARES — so it has to be registered before those columns are parsed, exactly
   * as the declaration does.
   */
  registerFieldTypeImpl(name: string, impl: FieldTypeImpl): this {
    this.refuseLateRegistration('registerFieldTypeImpl', name);
    const refinement = this.fieldTypeRefinements.get(name);
    if (!refinement) {
      const names = this.fieldTypeRefinementNames();
      throw new QueryTypeError({
        path: ['registerFieldTypeImpl', name],
        code: 'field-type.unknown-refinement',
        severity: 'error',
        message:
          `No field-type refinement '${name}' is registered.${didYouMean(name, names)} ` +
          `(registered: ${names.length > 0 ? names.join(', ') : 'none'}). Register the DECLARATION first.`,
      });
    }
    if (refinement.hasImpl) {
      throw new QueryTypeError({
        path: ['registerFieldTypeImpl', name],
        code: 'field-type.bad-refinement',
        severity: 'error',
        message:
          `\`${name}\` already has an implementation. A second one is refused for the same reason a second ` +
          'DECLARATION is: every column naming it shares one compiled refinement, so the last registration ' +
          'would silently decide what all of them validate against.',
      });
    }
    if (impl.value !== undefined && !(impl.value instanceof z.ZodType)) {
      throw new QueryTypeError({
        path: ['registerFieldTypeImpl', name, 'value'],
        code: 'field-type.bad-refinement',
        severity: 'error',
        message:
          `\`value\` must be a zod schema, got ${typeof impl.value}. It is checked because the failure is ` +
          "otherwise unattributable: anything else is accepted here and then throws a raw `TypeError` out " +
          'of zod at the first `validValue()`, with no code and no path.',
      });
    }
    refinement.attachImpl(impl);
    return this;
  }

  /**
   * Set once this registry has built a FIELD TYPE — through `parseFieldType`,
   * and so through `parseType` / `registerType` / `Type.from` / a function's
   * declared parameter types, all of which route there. Registration of a
   * refinement (or its impl) is refused past that point; see
   * {@link refuseLateRegistration}.
   */
  private catalogBuilt = false;

  /**
   * Refuse a refinement registration once this registry has built a field type.
   *
   * A stored `{kind:'text', as:'uuid'}` resolves against whatever the registry
   * knew AT PARSE TIME, and the resolved column is what every later predicate
   * uses. So a system that registers `uuid` after the catalog crawl leaves every
   * already-parsed column carrying the un-narrowed base — the `LOWER()` this
   * feature exists to remove — while the type tag still reads `text` and no
   * error is raised anywhere. A late IMPL is worse still: it attaches to the
   * compiled refinement every column naming it SHARES, so it retroactively
   * changes what an already-handed-out column validates against, mid-process.
   * That is the one failure in this design that is SILENT, which is why ordering
   * is enforced rather than documented.
   *
   * Armed at the field-type parse rather than at `parseType`, because
   * `parseType` is not the only road to a refined instance — `parseFieldType` is
   * public, `Type.from` is on the package barrel, and a function's declared
   * parameter types parse through the same place.
   */
  private refuseLateRegistration(verb: string, name: string): void {
    if (!this.catalogBuilt) return;
    throw new QueryTypeError({
      path: [verb, name],
      code: 'field-type.late-refinement',
      severity: 'error',
      message:
        `\`${verb}('${name}')\` was called after this registry had already built a field type ` +
        '(`parseType` / `registerType` / `parseFieldType` / `Type.from`, or a declared function ' +
        'parameter). A stored `as` resolves against the registry as it stood AT PARSE TIME, so every ' +
        'column built before this call would keep the UN-narrowed base — silently, since it still ' +
        'describes itself as the base kind — and a late impl would retroactively change what those ' +
        'columns validate against. Register every refinement and its impl first, or build a fresh registry.',
    });
  }

  /** Look up a registered field-type refinement by name, or `undefined`. */
  fieldTypeRefinement(name: string): FieldTypeRefinement | undefined {
    return this.fieldTypeRefinements.get(name);
  }

  /** Enumerate every registered field-type refinement (for docs / describe). */
  fieldTypeRefinementList(): FieldTypeRefinement[] {
    return Array.from(this.fieldTypeRefinements.values());
  }

  /**
   * The registered refinement NAMES — the closed vocabulary a `FieldTypeDef.as`
   * may name. This is what the generated def schema renders as a `z.enum`, and
   * therefore what stops a model inventing `{kind:'text', as:'uuid4'}`.
   */
  fieldTypeRefinementNames(): string[] {
    return Array.from(this.fieldTypeRefinements.keys());
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

  /**
   * Parse a `FieldTypeDef` into a `FieldType` instance by dispatching on kind,
   * then applying any `as` REFINEMENT it names.
   *
   * A refinement is applied by MEETING the declaration's options with the site's
   * own, so a use site may narrow it further and a site that contradicts it is
   * refused (`field-type.refinement-conflict`) — see `FieldTypeRefinement.refine`.
   * An `as` naming nothing registered is likewise refused rather than dropped:
   * silently degrading to the bare base would take a `uuid` column's
   * `casing: 'exact'` with it and put an index-defeating `LOWER()` back on every
   * predicate over it.
   */
  parseFieldType(json: FieldTypeDef): FieldType {
    // Building a refined instance is what FREEZES the vocabulary, so the flag is
    // set HERE rather than only in `parseType` / `registerType`. Those two are
    // not the only roads to a field type: `parseFieldType` is public, `Type.from`
    // is reachable off the barrel, and a function's declared parameter types
    // parse through here too — all three built refined instances while leaving
    // late registration open, and a late IMPL then RETROACTIVELY changed what an
    // already-handed-out column validates against, because the impl attaches to
    // the compiled refinement every column naming it shares.
    this.catalogBuilt = true;
    return this.parseFieldTypeInternal(json);
  }

  /**
   * {@link parseFieldType} WITHOUT freezing the vocabulary — the road
   * `FieldTypeRefinement.compile` takes to build a declaration's own options.
   *
   * The exemption is necessary and narrow: compiling the FIRST refinement would
   * otherwise freeze the registry and refuse the second. It SAVES AND RESTORES
   * the flag rather than bypassing the public method, because a composite option
   * recurses through `parseFieldType` for its element (`ArrayFieldType.from`) and
   * a bypass would only exempt the top level.
   */
  private parseFieldTypeUnflagged(json: FieldTypeDef): FieldType {
    const was = this.catalogBuilt;
    try {
      return this.parseFieldTypeInternal(json);
    } finally {
      this.catalogBuilt = was;
    }
  }

  /** The parse itself, with no opinion about freezing (see the two callers above). */
  private parseFieldTypeInternal(json: FieldTypeDef): FieldType {
    const cls = this.fieldTypeClasses.get(json.kind);
    if (!cls) {
      throw new Error(`registry.parseFieldType: unknown field-type kind '${json.kind}'`);
    }
    // Pass `this` so composite field types (e.g. `array`) can reconstruct
    // their nested `FieldTypeDef` children; scalar types ignore the argument.
    const built = cls.from(json, this);
    if (json.as === undefined) {
      // A `with` bag with no `as` names options belonging to nothing. Refused
      // rather than dropped, for the reason every other silently-dropped key is:
      // its author believes a fact is in force that is not.
      if (json.with !== undefined) {
        throw new QueryTypeError({
          path: ['with'],
          code: 'field-type.unknown-option',
          severity: 'error',
          message:
            'A `with` bag supplies values for the options a REFINEMENT declares, and this def names no ' +
            '`as`. Name the registered type these options belong to, or drop them.',
        });
      }
      return built;
    }
    const refinement = this.fieldTypeRefinements.get(json.as);
    if (!refinement) {
      const names = this.fieldTypeRefinementNames();
      throw new QueryTypeError({
        path: ['as'],
        code: 'field-type.unknown-refinement',
        severity: 'error',
        message:
          `Unknown field-type refinement '${json.as}'.${didYouMean(json.as, names)} ` +
          `(registered: ${names.length > 0 ? names.join(', ') : 'none'}).`,
      });
    }
    return refinement.refine(built, json.with);
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
    // The catalog now exists, so the refinement vocabulary is frozen — see
    // `refuseLateRegistration`. Both roads are marked because a Type can arrive
    // either parsed from a def or built by hand.
    this.catalogBuilt = true;
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

  /**
   * Parse a `TypeDef` into a `Type` instance (does NOT auto-register).
   *
   * This FREEZES the refinement vocabulary: the field types it builds resolved
   * their `as` against the registry as it stands now, so a refinement
   * registered afterwards could not reach them (see `refuseLateRegistration`).
   */
  parseType(json: TypeDef): Type {
    this.catalogBuilt = true;
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

  // ─── Operator registration (`&&`, `<->`, `@>`) ────────────────────────────

  /** Registered operators by name, COMPILED (see `operator.ts`). */
  private readonly operators = new Map<string, QueryOperator>();
  /** Runtime implementations of registered operators. */
  private readonly operatorRuns = new Map<string, OperatorRun>();

  /**
   * Register an OPERATOR — a name whose SQL a declaration supplies, per dialect
   * (`{ postgres: '({left} && {right})' }`).
   *
   * Every check the declaration is held to runs HERE and throws a
   * `QueryTypeError` (`operator.bad-declaration`) — see `QueryOperator.compile`.
   * COMPILED EAGERLY, unlike a `FunctionDef`, which the engine parses lazily on
   * first call: a defect in an emit template has no meaning at a call site, and
   * a failure there has no declaration to attribute it to.
   *
   * ORDERING: an operand naming a field-type refinement (`{kind:'json',
   * as:'Geometry'}`) needs that refinement registered FIRST, and says so with
   * `field-type.unknown-refinement`. Registering an operator does NOT freeze the
   * refinement vocabulary, so the reverse order stays open — the operand types
   * parse through the unflagged road for exactly that reason.
   */
  registerOperator(def: OperatorDef): this {
    const operator = QueryOperator.compile(def, this, (json) => this.parseFieldTypeUnflagged(json));
    this.operators.set(operator.name, operator);
    return this;
  }

  /** Look up a registered operator by name, or `undefined`. */
  operator(name: string): QueryOperator | undefined {
    return this.operators.get(name);
  }

  /** Enumerate every registered operator (for docs / describe / schema generation). */
  operatorList(): QueryOperator[] {
    return Array.from(this.operators.values());
  }

  /**
   * The registered operator NAMES — the closed vocabulary an `OperatorExprDef.op`
   * may name in THIS registry. What the generated schema renders as a `z.enum`,
   * and therefore what stops a model inventing an operator that does not exist.
   */
  operatorNames(): string[] {
    return Array.from(this.operators.keys());
  }

  /**
   * Register an operator's IN-MEMORY implementation — the counterpart of
   * `registerFunctionRun`, and the code half of a declaration that is otherwise
   * pure JSON.
   *
   * The DECLARATION must already be registered. A run for an unknown operator is
   * refused rather than stored against a name nothing dispatches, because the
   * failure is otherwise perfectly silent: `engine.run` would answer NULL for
   * every row and the SQL road would keep working, so the typo would surface as
   * a data defect rather than as an error.
   */
  registerOperatorRun(name: string, run: OperatorRun): this {
    if (!this.operators.has(name)) {
      const names = this.operatorNames();
      throw new QueryTypeError({
        path: ['registerOperatorRun', name],
        code: 'operator.unknown',
        severity: 'error',
        message:
          `No operator '${name}' is registered.${didYouMean(name, names)} ` +
          `(registered: ${names.length > 0 ? names.join(', ') : 'none'}). Register the DECLARATION first.`,
      });
    }
    this.operatorRuns.set(name, run);
    return this;
  }

  /** Look up an operator's runtime implementation, if any. */
  operatorRun(name: string): OperatorRun | undefined {
    return this.operatorRuns.get(name);
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
