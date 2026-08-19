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
 *  - a refinement is pure DATA (bar one optional zod schema), so it can be
 *    persisted, sent over the wire and shown to a model — the same split
 *    `FunctionDef` has to `registerFunction`;
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
   * A STRICTER value gate than the base's own (`z.uuid()` for a `uuid`). It is
   * applied in CONJUNCTION with the field's own schema, never as a replacement —
   * see `FieldType.toValueSchema`.
   *
   * The one part of a declaration that is code rather than data, so it does not
   * persist and does not reach a model. `FieldTypeDef` has no record branch, so
   * this is also the declared home of a STRUCTURAL value contract for a
   * refinement whose raw value is an object.
   */
  readonly value?: z.ZodTypeAny;
  /**
   * Per-dialect SQL TYPE — the CAST target for a value of this type, keyed by
   * `Dialect.name`. `{slot}` names a declared option and is resolved at
   * REGISTRATION (the options are constants). A dialect with no entry falls back
   * to the builtin's answer for the base kind.
   */
  readonly sql?: Readonly<Record<string, string>>;
  /**
   * Per-dialect CAST of a bound value INTO this type, keyed by `Dialect.name`.
   * `{value}` is the bound parameter slot and must appear at least once; every
   * other `{slot}` names a declared option and resolves at registration.
   *
   * A dialect with no entry falls back to the BASE's cast — a fallback, not a
   * degrade, because the base's answer is a real answer for a value of the base
   * type.
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
 * nothing else.
 */
export type FieldTypeRefinementDef = { [B in ScalarKind]: FieldTypeRefinementDefFor<B> }[ScalarKind];

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
 * `relation` is the one kind with no option-free form (`to` is an identity, not
 * a constraint), so its entry is a placeholder that a declaration MUST overwrite
 * — enforced in `compile`, which refuses a `relation` refinement declaring no
 * options rather than letting the empty `to` register.
 */
const BARE_DEF_OF: Readonly<Record<ScalarKind, () => FieldTypeDef>> = {
  number: () => ({ kind: 'number' }),
  text: () => ({ kind: 'text' }),
  money: () => ({ kind: 'money' }),
  bool: () => ({ kind: 'bool' }),
  date: () => ({ kind: 'date' }),
  timestamp: () => ({ kind: 'timestamp' }),
  json: () => ({ kind: 'json' }),
  array: () => ({ kind: 'array' }),
  relation: () => ({ kind: 'relation', to: '', count: 1 }),
};

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
    /** The declaration's stricter value gate, or `undefined`. */
    readonly value: z.ZodTypeAny | undefined,
    /** The declared average stored bytes, or `undefined` to keep the base's estimate. */
    readonly avgBytes: number | undefined,
    /** Fully-resolved SQL type per dialect name. */
    private readonly sqlTypes: ReadonlyMap<string, string>,
    /** Per dialect name, a cast template split on `{value}` (n+1 literal segments around n slots). */
    private readonly casts: ReadonlyMap<string, readonly string[]>,
    /** Who declared it, when they said. */
    readonly declaredBy: string | undefined,
  ) {}

  /**
   * Validate and compile a declaration. Every check is cheap because the
   * declaration is data, and every one of them refuses rather than warns: a
   * refinement that registered half-broken would be wrong on every column that
   * ever names it.
   */
  static compile(def: FieldTypeRefinementDef, registry: Registry): FieldTypeRefinement {
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
    if (!SCALAR_KINDS.includes(def.base)) {
      refuse(
        name,
        ['base'],
        `\`base\` must be one of ${SCALAR_KINDS.join(' | ')}, got ${JSON.stringify(def.base)}. ` +
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

    if (def.base === 'relation' && def.options === undefined) {
      refuse(
        name,
        ['options'],
        'A `relation` refinement must declare `options` naming its `to` Type and `count` — a relation ' +
          'carries an identity rather than a constraint, so there is no option-free form of one.',
      );
    }

    // The options are parsed by the SAME road a builtin def takes, so a bad
    // bound, an uncompilable pattern or a closed set that contradicts its own
    // constraints is refused here with the message that road already has.
    const options: object = def.options ?? {};
    let declared: FieldType;
    try {
      declared = registry.parseFieldType(Object.assign(BARE_DEF_OF[def.base](), def.options));
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
    for (const [dialect, template] of Object.entries(def.cast ?? {})) {
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
      def.value,
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
 * refinements registered over THAT base, or nothing at all when there are none.
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
 * Returns a spreadable fragment rather than a schema so a branch declares the
 * key exactly where it declares the rest of its wire shape.
 */
export function refinementKeySchema(base: ScalarKind, opts?: SchemaOptions): { as?: z.ZodTypeAny } {
  const registered = (opts?.registry?.fieldTypeRefinementList() ?? []).filter((r) => r.base === base);
  const [first, ...rest] = registered.map((r) => r.name);
  if (first === undefined) return {};
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
