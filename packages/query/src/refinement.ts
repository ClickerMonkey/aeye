/**
 * FIELD-TYPE REFINEMENTS — a registered NAME over a builtin base.
 *
 * `{ kind: 'text', as: 'uuid' }` is a `text` column that a deployment has named
 * `uuid` and narrowed once, centrally, instead of at every declaration site. The
 * spelling is deliberate and it is the whole reason this feature is affordable:
 *
 *  - the wire `kind` stays one of the nine builtins, so `ScalarKind` never
 *    opens, every `def.kind === 'text'` narrowing and every `instanceof
 *    TextFieldType` check stays correct by construction, and the exhaustiveness
 *    guards in the SQL / cost / value-schema switches stay unreachable;
 *  - a DECLARATION is pure JSON, so it can be persisted, sent over the wire and
 *    shown to a model, while the CODE half ({@link FieldTypeImpl}) is a separate
 *    registration — the same split `FunctionDef` has to `FunctionRun`, and for a
 *    measured reason rather than symmetry (see {@link FieldTypeImpl});
 *  - the library COMPILES the declaration into a builtin instance. A declarer
 *    never writes a `FieldType` subclass, never writes `meetWith`, and therefore
 *    cannot break the lattice laws `param-meet.test.ts` proves.
 *
 * WHAT IT BUYS, measured. A catalog that declares `id: { kind: 'text' }` at ~40
 * sites emits `LOWER("t"."id") = LOWER($1)` for every id predicate — index-
 * defeating, and a hard `function lower(uuid) does not exist` over a physical
 * uuid column. One `uuid` refinement declaring `casing: 'exact'` turns all forty
 * into a bare, sargable `=`, and it does so through the ordinary meet rather
 * than through a new rule.
 *
 * NARROWING, NEVER WIDENING. A refinement's `options` are the FLOOR every use of
 * it stands on: a use site's own options are MET with them (`FieldType.meet`),
 * so a site may narrow further and a site that tries to widen is simply absorbed
 * — the met type is a lower bound of both by construction. A site whose options
 * cannot coexist with the declaration's (`as:'uuid'` beside `maxLength: 10`) has
 * no meet at all and is REFUSED where declarations are read, next to
 * `field-type.bad-values` and `field-type.bad-pattern`. That is gin's
 * `Extension.narrow` law, and this package already satisfies it because here the
 * meet IS narrow.
 *
 * WHAT IS NOT HERE. Custom OPTION DECLARATIONS — a refinement that invents an
 * option its base has never heard of (`srid`, `subtype`) — are a later step.
 * Everything a refinement may narrow today is drawn from the base's own
 * vocabulary, which is why `options` is typed straight off `FieldTypeDef` and
 * validated by the machinery that already validates a builtin's def. So are
 * declared comparability (`compare` / `comparableWith`), operators, and the
 * in-memory `compareValues` hook: a refinement is a SQL-road feature, exactly as
 * `semantic` and `text-search` already are.
 */
import { z } from 'zod';
import { didYouMean } from './aids';
import type { FieldType } from './field-type';
import { SCALAR_KINDS, type ScalarKind } from './field-type';
import type { SchemaOptions } from './node';
import { QueryTypeError } from './problem';
import type { Registry } from './registry';
import type { FieldTypeDef } from './schema';

/**
 * Allowed charset for a registered refinement NAME.
 *
 * A capital is allowed, and that is a deliberate cross-library decision rather
 * than a loose default. A consumer that registers the same logical type in BOTH
 * `@aeye/gin` and this package has to spell it once: gin refuses a package type
 * name that does not START with a capital (a shipped, measured rule — a system
 * package's lower-case `time` silently shadowed a user's `time` in every
 * session), so a lower-case-only rule here would make every such name
 * unspellable in one library or the other. Measured over the two worked
 * examples: `geometry`/`latlng` are refused by gin, `Geometry`/`LatLng` would be
 * refused by a lower-case-only rule here, and no third spelling satisfies both.
 *
 * It is also the rule this package already applies to the OTHER name a third
 * party registers: `FUNCTION_NAME_PATTERN` is `^[A-Za-z_][A-Za-z0-9_.]*$`, which
 * is how `ST_Contains` registers. A dot is excluded here (a refinement name is
 * never schema-qualified and renders inside a type tag), and so is a leading
 * underscore (it reads as private in every language a declarer comes from).
 */
export const REFINEMENT_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;

/**
 * The `{value}` slot of a `cast` template — the bound parameter, the ONE slot a
 * cast cannot resolve at registration because it is per-row data.
 */
const CAST_VALUE_SLOT = 'value';

/** Every `{slot}` occurrence in a template. */
const TEMPLATE_SLOT = /\{([^{}]*)\}/g;

/**
 * What an option value may look like when it is INTERPOLATED into a SQL
 * template. Templates are raw-interpolated (exactly as `${fn.sql}(` already is),
 * so the values spliced into them are the injection surface — not the template
 * body, which the declarer wrote. A bare identifier / number token is the widest
 * thing that is safe with no quoting rules of its own, and it covers every real
 * case (`Point`, `4326`, `36`, `USD`).
 */
const TEMPLATE_VALUE_PATTERN = /^[A-Za-z0-9_]+$/;

/**
 * What a fully-resolved `sql` entry may look like. It lands in a raw
 * `CAST(… AS <here>)` slot, so it is held to the shape of a SQL TYPE NAME:
 * an identifier, optionally parameterized (`varchar(36)`, `geometry(Point,4326)`),
 * optionally an array (`text[]`), optionally multi-word (`timestamp with time
 * zone`).
 */
const SQL_TYPE_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*( [A-Za-z_][A-Za-z0-9_]*)*(\([A-Za-z0-9_, ]*\))?(\[\])?$/;

/**
 * The OPTION BAG of one builtin branch — that branch's own def minus the
 * discriminant and the refinement key.
 *
 * DERIVED from `FieldTypeDef`, never restated: an option added to a builtin is
 * immediately declarable on a refinement of it, and an option removed from one
 * stops compiling at every declaration that still names it.
 */
export type FieldTypeOptionsOf<B extends ScalarKind> = Omit<
  Extract<FieldTypeDef, { kind: B }>,
  'kind' | 'as'
>;

/**
 * A field-type refinement DECLARATION, for one base `B`. The union over every
 * base is {@link FieldTypeRefinementDef}, which is what `registerFieldType`
 * takes; splitting it per-base is what makes `options` narrow to the base's own
 * vocabulary at the call site.
 */
export interface FieldTypeRefinementDefFor<B extends ScalarKind> {
  /**
   * The registered name — the `as` a field declares. Held to
   * {@link REFINEMENT_NAME_PATTERN}, and it renders VERBATIM everywhere a model
   * reads it (the type tag, the generated `as` enum): never lower-cased, never
   * pluralized, never decorated. A model reads this package's surface and a
   * sibling library's in one session, and a spelling difference between them
   * reads as two different types.
   */
  readonly name: string;
  /** The BUILTIN bucket this refines. Must be a {@link ScalarKind}. */
  readonly base: B;
  /**
   * What the type MEANS, for a model. REQUIRED — and deliberately stricter than
   * `FunctionDef.instructions`, which is optional. Measured: an undocumented
   * registered item renders as a bare signature beside documented siblings, and
   * a model choosing among them is guessing. The expensive failure is not the
   * ~20 tokens of the line, it is the validate-fail retry that carries the
   * WHOLE schema a second time.
   */
  readonly instructions: string;
  /**
   * The narrowing this refinement declares, in the base's own option vocabulary.
   * Every use of the refinement stands on it (see the module docs): a site may
   * narrow further, and a site that contradicts it is refused.
   */
  readonly options?: FieldTypeOptionsOf<B>;
  /**
   * Per-dialect SQL TYPE — the CAST target for a value of this type, keyed by
   * `Dialect.name`. `{slot}` names a declared option and is resolved at
   * REGISTRATION (the options are constants). A dialect with no entry falls back
   * to the builtin's answer for the base kind.
   */
  readonly sql?: Readonly<Record<string, string>>;
  /**
   * Per-dialect CAST of a bound DOCUMENT into this type, keyed by
   * `Dialect.name`. `{value}` is the bound parameter slot and must appear at
   * least once; every other `{slot}` names a declared option and resolves at
   * registration.
   *
   * ONLY DECLARABLE ON A BASE WHOSE VALUES ROUTE THROUGH `Dialect.jsonValue`
   * (see {@link CAST_CAPABLE_BASES}) — a scalar predicate binds its value
   * directly and there is no seam for a template to reach, so a `cast` on a
   * `text` base would validate at registration and then be silently inert on
   * every predicate over the column. It is refused instead. What a scalar base
   * declares is `sql`, the cast TARGET.
   *
   * A cast-capable base with no entry for a dialect falls back to the BASE's
   * cast — a fallback, not a degrade, because the base's answer is a real answer
   * for a value of the base type.
   */
  readonly cast?: Readonly<Record<string, string>>;
  /** Estimated average stored bytes, when the base's own estimate is wrong (a `uuid` is 16, not 32). */
  readonly avgBytes?: number;
  /**
   * Who declared it — surfaced when a SECOND declarer claims the same name, so
   * the refusal names the incumbent instead of just the collision.
   */
  readonly declaredBy?: string;
}

/**
 * A field-type refinement declaration. A discriminated union over `base`, so
 * `{ base: 'text' }` type-checks its `options` against the `text` branch and
 * nothing else — and `relation` is not a member at all, so an unrefinable base
 * is a COMPILE error rather than only a registration one (the runtime check
 * stays, for a caller with no types).
 */
export type FieldTypeRefinementDef = { [B in RefinableBase]: FieldTypeRefinementDefFor<B> }[RefinableBase];

/**
 * The CODE half of a refinement — `registry.registerFieldTypeImpl(name, impl)`,
 * the exact counterpart of `registerFunctionRun` beside `registerFunction`.
 *
 * IT IS SPLIT FROM THE DECLARATION FOR A MEASURED REASON, not for symmetry. A
 * `FieldTypeRefinementDef` is what a consumer PERSISTS and replays at boot, and
 * a zod schema does not vanish under `JSON.stringify` — it stringifies into a
 * plausible husk that survives the round-trip, passes every registration check,
 * and then throws a raw `TypeError` out of zod's internals at the first
 * `validValue()`: no `QueryTypeError`, no code, no path, and the strictest gate
 * on that column silently dead. Keeping a schema on the declaration would make
 * that the DEFAULT outcome of doing the obvious thing with it. With the split,
 * a declaration is pure JSON and round-trips honestly, and the half that cannot
 * survive a round-trip is the half nobody tries to store.
 *
 * Later members (`compareValues`, `equalValues` for the in-memory runtime) land
 * here too; today there is one.
 */
export interface FieldTypeImpl {
  /**
   * A STRICTER value gate than the base's own (`z.uuid()` for a `uuid`), applied
   * in CONJUNCTION with the field's own schema — never as a replacement, since a
   * use site may narrow further and answering with this alone would admit values
   * the field's own options refuse (see `FieldType.toValueSchema`).
   *
   * `FieldTypeDef` has no record branch, so this is also the declared home of a
   * STRUCTURAL value contract for a refinement whose raw value is an object.
   */
  readonly value?: z.ZodTypeAny;
}

/**
 * The OPTION-FREE def of each builtin kind — the target the declared `options`
 * are assigned onto to reconstitute the base's own `FieldTypeDef`.
 *
 * A table rather than a nine-arm switch, and `Object.assign` rather than a
 * spread, for one reason each. The table is a `Record<ScalarKind, …>`, so a
 * tenth builtin kind fails to COMPILE here instead of falling through to
 * whatever a spread happened to produce. And `Object.assign(def, options)` types
 * as `FieldTypeDef & <options>` — which IS a `FieldTypeDef` — whereas
 * `{ ...options, kind: base }` is an object TypeScript cannot relate to any
 * branch, because it will not see through the `Omit` that `FieldTypeOptionsOf`
 * is built from. Same object at runtime, and no cast.
 *
 * `relation` is absent because a `relation` BASE is refused outright
 * ({@link REFINABLE_BASES}) — it is also the one kind with no option-free form,
 * which is the same fact seen from the other side.
 */
const BARE_DEF_OF: Readonly<Record<RefinableBase, () => FieldTypeDef>> = {
  number: () => ({ kind: 'number' }),
  text: () => ({ kind: 'text' }),
  money: () => ({ kind: 'money' }),
  bool: () => ({ kind: 'bool' }),
  date: () => ({ kind: 'date' }),
  timestamp: () => ({ kind: 'timestamp' }),
  json: () => ({ kind: 'json' }),
  array: () => ({ kind: 'array' }),
};

/**
 * The bases a refinement may narrow: every `ScalarKind` EXCEPT `relation`.
 *
 * A relation carries an IDENTITY (`to`) and a cardinality ESTIMATE (`count`),
 * neither of which is a constraint a name can narrow — the same fact
 * `param-meet.test.ts` already records by giving `relation` no TOP ("its `to` is
 * an identity, not a constraint, so there is no relation that constrains
 * nothing"). Measured consequence of allowing it: a site had to restate `to` and
 * `count` verbatim, which is the exact duplication this feature removes, and a
 * declaration that named only `count` registered cleanly and then refused every
 * column that used it, blaming the column. Refused at the declaration instead.
 */
export const REFINABLE_BASES = SCALAR_KINDS.filter((kind) => kind !== 'relation');

/** A base a refinement may narrow (see {@link REFINABLE_BASES}). */
export type RefinableBase = Exclude<ScalarKind, 'relation'>;

/** {@link REFINABLE_BASES} as a membership test over the WIDER `ScalarKind`. */
const REFINABLE_BASE_SET: ReadonlySet<ScalarKind> = new Set<ScalarKind>(REFINABLE_BASES);

/**
 * The bases whose VALUES are bound through `Dialect.jsonValue` — the ONE seam a
 * declared `cast` template can reach.
 *
 * `writeCellSql` routes a cell there when the value is an object or the column
 * is `json`; every other road (a scalar comparison, a literal, a bound param)
 * emits the value directly. So a `cast` on a `text` base validates at
 * registration and can then never fire — measured on the documented `uuid`
 * example, whose predicate stayed `WHERE "thing"."id" = $1`. It is refused
 * rather than accepted-and-inert.
 */
const CAST_CAPABLE_BASES: ReadonlySet<ScalarKind> = new Set<ScalarKind>(['json', 'array']);

/**
 * Every key a DECLARATION may carry. An unknown one is REFUSED rather than
 * ignored, because "ignored" is how the failure this whole split exists to
 * prevent comes back in a different disguise.
 *
 * The measured case is `value`. It used to live on the declaration and now lives
 * on the impl, and TypeScript's excess-property check only fires on an INLINE
 * literal — so `registerFieldType(JSON.parse(stored) as FieldTypeRefinementDef)`,
 * which is the road the docs advertise, type-checks and silently drops the
 * strictest gate on the column. Same end state as a revived husk, reached by a
 * different road.
 *
 * The list is checked against the interface below, so adding a key to one
 * without the other does not compile.
 */
const DECLARATION_KEYS = [
  'name',
  'base',
  'instructions',
  'options',
  'sql',
  'cast',
  'avgBytes',
  'declaredBy',
] as const;

/** {@link DECLARATION_KEYS} as a membership test over an arbitrary key string. */
const DECLARATION_KEY_SET: ReadonlySet<string> = new Set<string>(DECLARATION_KEYS);

/** Keys that MOVED, so their refusal can say where they went instead of just "unknown". */
const RELOCATED_KEYS: Readonly<Record<string, string>> = {
  value: '`registerFieldTypeImpl(name, { value })` — it is a zod schema, and a declaration is JSON',
};

type Assert<T extends true> = T;
/** `DECLARATION_KEYS` covers the declaration exactly — neither list may drift. */
type _DeclarationKeysAreExact = Assert<
  Exclude<keyof FieldTypeRefinementDefFor<'text'>, (typeof DECLARATION_KEYS)[number]> extends never
    ? (typeof DECLARATION_KEYS)[number] extends keyof FieldTypeRefinementDefFor<'text'> ? true : false
    : false
>;

/** Throw a declaration-defect `QueryTypeError` for refinement `name`. */
function refuse(name: string, path: (string | number)[], message: string): never {
  throw new QueryTypeError({
    path: ['registerFieldType', name, ...path],
    code: 'field-type.bad-refinement',
    severity: 'error',
    message,
  });
}

/**
 * The declared options as an interpolable `slot → token` table, refusing any
 * value that is not a safe bare token (see {@link TEMPLATE_VALUE_PATTERN}).
 * A composite option (`values`, `item`) has no token form and is simply absent,
 * so naming one in a template reads as an unknown slot — which is the honest
 * message, since there is nothing to interpolate.
 */
function templateSlots(options: object): Map<string, string> {
  const slots = new Map<string, string>();
  const entries: [string, unknown][] = Object.entries(options);
  for (const [key, value] of entries) {
    if (typeof value === 'number' && Number.isFinite(value)) slots.set(key, String(value));
    else if (typeof value === 'boolean') slots.set(key, String(value));
    else if (typeof value === 'string' && TEMPLATE_VALUE_PATTERN.test(value)) slots.set(key, value);
  }
  return slots;
}

/**
 * Resolve every `{slot}` in `template` from `slots`, refusing an unknown one
 * with a `didYouMean` over the declared options. `keep` names the one slot that
 * is left in place (`{value}` for a cast) rather than resolved.
 */
function resolveTemplate(
  name: string,
  path: (string | number)[],
  template: string,
  slots: ReadonlyMap<string, string>,
  keep?: string,
): string {
  return template.replace(TEMPLATE_SLOT, (whole, slot: string) => {
    if (slot === keep) return whole;
    const resolved = slots.get(slot);
    if (resolved !== undefined) return resolved;
    const candidates = [...slots.keys(), ...(keep === undefined ? [] : [keep])];
    refuse(
      name,
      path,
      `SQL template ${JSON.stringify(template)} names \`{${slot}}\`, which is not an interpolable ` +
        `declared option of \`${name}\`.${didYouMean(slot, candidates)} ` +
        `(interpolable: ${candidates.length > 0 ? candidates.map((c) => `\`{${c}}\``).join(', ') : 'none'}). ` +
        'A slot must name an option whose declared value is a bare identifier or number token — the ' +
        'templates are raw-interpolated into emitted SQL, so anything else is refused rather than quoted.',
    );
  });
}

/**
 * A COMPILED refinement — the declaration plus the builtin instance its
 * `options` parse to, which is the operand every use site is met against.
 *
 * Built only by {@link FieldTypeRefinement.compile} (via
 * `Registry.registerFieldType`), so an instance in hand has already passed every
 * registration-time check.
 */
export class FieldTypeRefinement {
  private constructor(
    /** The registered name — the `as` on the wire. */
    readonly name: string,
    /** The builtin bucket this refines. */
    readonly base: ScalarKind,
    /** What this type means, for a model. */
    readonly instructions: string,
    /**
     * The declaration's own options as a parsed `FieldType` — the FLOOR a use
     * site is met against. Carries no refinement itself, so meeting it with a
     * site's type is a pure options meet.
     */
    readonly declared: FieldType,
    /** The declared average stored bytes, or `undefined` to keep the base's estimate. */
    readonly avgBytes: number | undefined,
    /** Fully-resolved SQL type per dialect name. */
    private readonly sqlTypes: ReadonlyMap<string, string>,
    /** Per dialect name, a cast template split on `{value}` (n+1 literal segments around n slots). */
    private readonly casts: ReadonlyMap<string, readonly string[]>,
    /** Who declared it, when they said. */
    readonly declaredBy: string | undefined,
  ) {}

  /** The CODE half, when one has been registered (see {@link FieldTypeImpl}). */
  private impl: FieldTypeImpl | undefined;

  /**
   * The stricter value gate this refinement's IMPL supplies, or `undefined`.
   * Read by `FieldType.toValueSchema`, which conjoins it with the field's own.
   */
  get value(): z.ZodTypeAny | undefined {
    return this.impl?.value;
  }

  /**
   * Attach the code half. Called only by `Registry.registerFieldTypeImpl`, which
   * owns the checks (that the impl is registered once, that a supplied `value`
   * is really a zod schema, and that the catalog has not been parsed yet).
   */
  attachImpl(impl: FieldTypeImpl): void {
    this.impl = impl;
  }

  /** Whether a code half has already been attached (the registry's once-only check). */
  get hasImpl(): boolean {
    return this.impl !== undefined;
  }

  /**
   * Validate and compile a declaration. Every check is cheap because the
   * declaration is data, and every one of them refuses rather than warns: a
   * refinement that registered half-broken would be wrong on every column that
   * ever names it.
   */
  static compile(
    def: FieldTypeRefinementDef,
    registry: Registry,
    /**
     * How the declared `options` become a `FieldType`. Supplied by the registry
     * rather than taken off it, because this road must NOT freeze the refinement
     * vocabulary — compiling the first declaration would otherwise refuse the
     * second (`Registry.parseFieldTypeUnflagged`).
     */
    parseFieldType: (json: FieldTypeDef) => FieldType,
  ): FieldTypeRefinement {
    const { name } = def;
    if (typeof name !== 'string' || !REFINEMENT_NAME_PATTERN.test(name)) {
      refuse(
        String(name),
        [],
        `Field-type refinement name ${JSON.stringify(name)} must match ${REFINEMENT_NAME_PATTERN.source} ` +
          '(a letter, then letters / digits / underscores). Capitals are allowed deliberately, so one ' +
          'name can be spelled the same way here and in a sibling type system.',
      );
    }
    // A refinement NARROWS a builtin; it cannot BE one. Sharing the namespace
    // would make `{kind:'text', as:'text'}` a thing, and `text` would then mean
    // one type in `kind` and another in `as`.
    if (registry.fieldTypeClass(name)) {
      refuse(name, [], `\`${name}\` is a builtin field-type kind and cannot also name a refinement of one.`);
    }
    const existing = registry.fieldTypeRefinement(name);
    if (existing) {
      refuse(
        name,
        [],
        `\`${name}\` is already registered as a refinement of \`${existing.base}\`` +
          `${existing.declaredBy !== undefined ? ` by ${existing.declaredBy}` : ''}. ` +
          'The second declaration is refused rather than allowed to shadow the first: a column stored ' +
          `as \`{kind:'${existing.base}', as:'${name}'}\` would silently change meaning depending on ` +
          'which package registered last.',
      );
    }
    // An unknown key is REFUSED, not ignored — see `DECLARATION_KEYS`. Checked
    // before anything reads the declaration, so a stale `value` cannot register
    // and then sit inert.
    for (const key of Object.keys(def)) {
      if (DECLARATION_KEY_SET.has(key)) continue;
      const moved = RELOCATED_KEYS[key];
      refuse(
        name,
        [key],
        `Unknown declaration key \`${key}\`.` +
          `${moved !== undefined ? ` It moved to ${moved}.` : didYouMean(key, [...DECLARATION_KEYS])} ` +
          `A declaration carries only: ${DECLARATION_KEYS.join(', ')}. An unknown key is refused rather ` +
          'than dropped, because a key that is silently dropped is a fact the declarer believes is in ' +
          'force and is not.',
      );
    }

    // Read as a plain string: `def.base` is typed `RefinableBase`, so `relation`
    // is already a compile error — this is the runtime half, for an untyped
    // caller, and it earns its own message because it is the one base a declarer
    // has a reason to try.
    const base: string = def.base;
    if (base === 'relation') {
      refuse(
        name,
        ['base'],
        'A `relation` cannot be refined. Its `to` is an IDENTITY and its `count` a cardinality ESTIMATE, ' +
          'neither of which is a constraint a name can narrow — so a use site would have to restate both ' +
          'verbatim (the duplication a refinement exists to remove) and a declaration naming only one of ' +
          `them would refuse every column that used it. Refine what the relation POINTS AT instead. ` +
          `Refinable bases: ${REFINABLE_BASES.join(' | ')}.`,
      );
    }
    if (!REFINABLE_BASES.includes(def.base)) {
      refuse(
        name,
        ['base'],
        `\`base\` must be one of ${REFINABLE_BASES.join(' | ')}, got ${JSON.stringify(def.base)}. ` +
          'A refinement reuses a builtin bucket — that is what keeps every SQL, cost and comparability ' +
          'path total.',
      );
    }
    if (typeof def.instructions !== 'string' || def.instructions.trim() === '') {
      refuse(
        name,
        ['instructions'],
        '`instructions` is required and must be non-empty. An undocumented registered type renders as a ' +
          'bare tag beside documented siblings, and a model choosing among them guesses — which costs a ' +
          'whole validate-fail retry carrying the entire schema.',
      );
    }
    if (def.avgBytes !== undefined && (!Number.isFinite(def.avgBytes) || def.avgBytes <= 0)) {
      refuse(name, ['avgBytes'], `\`avgBytes\` must be a finite number greater than 0, got ${JSON.stringify(def.avgBytes)}.`);
    }

    // The options are parsed by the SAME road a builtin def takes, so a bad
    // bound, an uncompilable pattern or a closed set that contradicts its own
    // constraints is refused here with the message that road already has.
    const options: object = def.options ?? {};
    let declared: FieldType;
    try {
      declared = parseFieldType(Object.assign(BARE_DEF_OF[def.base](), def.options));
    } catch (err) {
      refuse(
        name,
        ['options'],
        `\`options\` are not a valid \`${def.base}\` declaration: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const slots = templateSlots(options);
    const sqlTypes = new Map<string, string>();
    for (const [dialect, template] of Object.entries(def.sql ?? {})) {
      const resolved = resolveTemplate(name, ['sql', dialect], template, slots);
      if (!SQL_TYPE_PATTERN.test(resolved)) {
        refuse(
          name,
          ['sql', dialect],
          `SQL type ${JSON.stringify(resolved)} is not a SQL type name (it is raw-interpolated into ` +
            `\`CAST(… AS …)\`). Expected something matching ${SQL_TYPE_PATTERN.source}.`,
        );
      }
      sqlTypes.set(dialect, resolved);
    }

    const casts = new Map<string, readonly string[]>();
    const declaredCasts = Object.entries(def.cast ?? {});
    if (declaredCasts.length > 0 && !CAST_CAPABLE_BASES.has(def.base)) {
      refuse(
        name,
        ['cast'],
        `A \`${def.base}\` refinement cannot declare a \`cast\`. Only a value bound through ` +
          `\`Dialect.jsonValue\` reaches a cast template (bases: ${[...CAST_CAPABLE_BASES].join(' | ')}); ` +
          `a \`${def.base}\` predicate binds its value directly, so the template would be accepted here ` +
          'and then silently inert on every predicate over the column. Declare `sql` — the cast TARGET — ' +
          'instead.',
      );
    }
    for (const [dialect, template] of declaredCasts) {
      const resolved = resolveTemplate(name, ['cast', dialect], template, slots, CAST_VALUE_SLOT);
      const segments = resolved.split(`{${CAST_VALUE_SLOT}}`);
      if (segments.length < 2) {
        refuse(
          name,
          ['cast', dialect],
          `Cast template ${JSON.stringify(template)} never names \`{${CAST_VALUE_SLOT}}\`, so the bound ` +
            'value would be dropped and the emitted SQL would carry one parameter fewer than the query ' +
            'supplies. A cast must place the value it casts.',
        );
      }
      casts.set(dialect, segments);
    }

    return new FieldTypeRefinement(
      name,
      def.base,
      def.instructions,
      declared,
      def.avgBytes,
      sqlTypes,
      casts,
      def.declaredBy,
    );
  }

  /**
   * The field type a use site declaring `as: <this>` resolves to — the MEET of
   * this refinement's declared options and the site's own, tagged with this
   * refinement.
   *
   * The meet is the whole enforcement: its result is a lower bound of BOTH, so a
   * site can only ever narrow, and a site whose options cannot coexist with the
   * declaration's has no meet and is refused here. No new lattice law is
   * introduced — `as` itself merges through the existing flat `meetExact`, in
   * which a registered name meets only itself and an unrefined base is TOP.
   */
  refine(site: FieldType): FieldType {
    if (site.kind !== this.base) {
      throw new QueryTypeError({
        path: ['as'],
        code: 'field-type.refinement-base',
        severity: 'error',
        message:
          `\`as: '${this.name}'\` refines a \`${this.base}\`, but this field declares ` +
          `\`kind: '${site.kind}'\`. Write \`{ kind: '${this.base}', as: '${this.name}' }\`.`,
      });
    }
    const met = this.declared.meet(site);
    if (met === undefined) {
      throw new QueryTypeError({
        path: ['as'],
        code: 'field-type.refinement-conflict',
        severity: 'error',
        message:
          `This field narrows \`${this.name}\` to something no value satisfies: ` +
          `${JSON.stringify(site.toJSON())} has no meet with the refinement's own ` +
          `${JSON.stringify(this.declared.toJSON())}. A use site may narrow \`${this.name}\` further; ` +
          'it may not contradict it.',
      });
    }
    return met.withRefinement(this);
  }

  /** The declared SQL type for `dialect`, or `undefined` to keep the builtin's answer. */
  sqlType(dialect: string): string | undefined {
    return this.sqlTypes.get(dialect);
  }

  /**
   * The declared cast for `dialect` as literal segments around the `{value}`
   * slot, or `undefined` to keep the base's cast.
   */
  cast(dialect: string): readonly string[] | undefined {
    return this.casts.get(dialect);
  }
}

/**
 * The `as` KEY of one builtin branch's generated def schema — a `z.enum` of the
 * refinements registered over THAT base, or a key that REFUSES any value when
 * none are.
 *
 * This is what makes the vocabulary REAL rather than advisory. The def schema is
 * what a model authors a Type against, and it was built from the static
 * `BUILTIN_FIELD_TYPES` array — so with an open `as: string` a model would be
 * free to invent `{kind:'text', as:'uuid4'}` and only find out at parse. Offered
 * as an enum, the only names it can write are names that exist.
 *
 * Filtered BY BASE, because a refinement of `text` is not a choice a `number`
 * field has; and each name carries its `instructions` inline, because a bare
 * list of names tells a model what it may write and not what any of them mean.
 * The names render VERBATIM — a model reads this surface and a sibling type
 * system's in one session, and a spelling difference between them reads as two
 * different types.
 *
 * THE EMPTY CASE IS A REFUSAL, NOT AN OMISSION, and the difference is the whole
 * point of the key. Omitting it let zod STRIP an `as` a model wrote on a base
 * with no registrations — and the normal pipeline is `Tool.parse` →
 * `engine.parseType(result)`, so `parseType` never sees the raw def and the loud
 * `field-type.unknown-refinement` never fires. The identical mistake was caught
 * on `text` and silently discarded on `json`.
 *
 * `z.never()` refuses any value while `.optional()` keeps the key absent-able,
 * and it is the right refusal for two reasons: `z.undefined()` is
 * UNREPRESENTABLE in JSON Schema (it throws, and under `unrepresentable: 'any'`
 * it renders as "permit anything" — the opposite of the intent), whereas `never`
 * renders as `{"not":{}}`. That is true of ONE BRANCH's schema; converting the
 * whole `fieldTypeDefSchema` union is a separate, pre-existing matter (see the
 * known limit in `CHANGELOG.md`).
 *
 * Returns a spreadable fragment rather than a schema so a branch declares the
 * key exactly where it declares the rest of its wire shape.
 */
export function refinementKeySchema(base: ScalarKind, opts?: SchemaOptions): { as: z.ZodTypeAny } {
  // A base that can never be refined says so, rather than "none registered
  // HERE" — which would imply another registry could have one.
  if (!REFINABLE_BASE_SET.has(base)) {
    return { as: z.never().optional().describe(`A ${base} cannot be refined — omit \`as\`.`) };
  }
  const registered = (opts?.registry?.fieldTypeRefinementList() ?? []).filter((r) => r.base === base);
  const [first, ...rest] = registered.map((r) => r.name);
  if (first === undefined) {
    return {
      as: z
        .never()
        .optional()
        .describe(`No registered type refines a ${base} here — omit \`as\`.`),
    };
  }
  const glossary = registered.map((r) => `${r.name} — ${r.instructions}`).join(' ');
  return {
    as: z
      .enum([first, ...rest])
      .optional()
      .describe(
        `Narrow this ${base} to a registered type. It carries that type's own constraints; you may ` +
          `constrain further here, never loosen. ${glossary}`,
      ),
  };
}
