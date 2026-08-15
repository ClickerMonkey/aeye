import type { CallDef, GetSetDef, PropDef, TypeDef } from './schema';
import type { TypeClass } from './registry';
import type { TypeBuilder } from './builder';
import { nearest } from './aids';
// Type-only — the coverage assertions at the bottom of this file compare each
// class's declared wire keys against the options interface it mirrors.
import type {
  BoolOptions, ColorOptions, DateOptions, ListOptions,
  NumOptions, TextOptions, TimestampOptions,
} from './builder';
import type { BoolType } from './types/bool';
import type { ColorType } from './types/color';
import type { DateType } from './types/date';
import type { EnumOptions, EnumType } from './types/enum';
import type { ListType } from './types/list';
import type { LiteralOptions, LiteralType } from './types/literal';
import type { NotOptions, NotType } from './types/not';
import type { NumType } from './types/num';
import type { TextType } from './types/text';
import type { TimestampType } from './types/timestamp';
import type { TupleOptions, TupleType } from './types/tuple';

/**
 * Wire strictness — the keys gin actually READS out of a serialized
 * `TypeDef`, and the refusal of everything else.
 *
 * WHY. Every slot the parser reads has a silent default: a `list` with no
 * `generic.V` is `list<any>`, a type with no `options` gets `{}`. So a def
 * whose element type landed in the WRONG slot —
 *
 *   { name: 'list', options: { item: { name: 'user' } } }
 *
 * — used to parse, quietly, to `list<any>`. That is worse than an error and
 * worse than an unbound bare name: an unbound `{name:'user'}` parses to an
 * AliasType that is universal, so a downstream "does this pattern claim
 * everything?" check can reject it, but `list<any>` is NOT universal and
 * sails straight through — a component declaring it accepts `list<user>`
 * then silently matched every list. Detecting "this def carried keys gin
 * ignored" is the parser's business; a consumer can only do it by
 * re-deriving gin's wire format, which is the wrong place for it to live.
 *
 * WHY NOT PERMISSIVE. A permissive parser is sometimes deliberate — forward
 * tolerance for a def written by a NEWER version. That is not what leniency
 * bought here. Measured on 0.3.10, an ignored key meets one of two fates,
 * and neither is compatibility:
 *
 *   - a top-level key is DROPPED. `{name:'optional', inner:{name:'num'}}`
 *     re-serializes as `optional<any>` — the author's intent is simply gone.
 *   - an `options` key SURVIVES verbatim, because the class keeps the whole
 *     options bag. `{name:'text', options:{values:['todo','done']}}`
 *     re-serializes with `values` intact while `.valid('anything')` stays
 *     true: the author reads their own closed set back and it enforces
 *     nothing. (Found on a live status column whose stored set did not even
 *     list a value two rows already held.)
 *
 * One is silent data loss, the other a declaration that lies for as long as
 * it exists. Hence a hard error and no opt-out flag — and deliberately no
 * "fix" by stripping the key on the way in, which would only move the
 * silence from the reader to the writer.
 *
 * WHAT IS CHECKED. Three slots, all of them shapes gin declares:
 *   - the TypeDef's own keys, against {@link TYPE_DEF_KEYS};
 *   - `options`, against the dispatched class's {@link TypeClass.optionKeys};
 *   - `generic`, against the class's {@link TypeClass.genericKeys}.
 *
 * A class that declares neither list is left UNCHECKED, so a third-party
 * class registered through `registry.define(...)` keeps working until it
 * opts in. Two more deliberate exclusions, both because the keys there are
 * not "ignored" in the sense that matters:
 *   - a def whose `name` is a REGISTERED named type resolves to that type by
 *     identity (`registry.parse(Email.toJSON())` is `Email`), so its
 *     structural keys are descriptive rather than consumed;
 *   - `generic` on an `extends` def DECLARES the extension's own type
 *     parameters instead of binding the base's, so it has no fixed key set.
 *
 * THE NESTED SHAPES, and why they had to follow. A `TypeDef` is not the only
 * wire shape gin reads — `props` holds `PropDef`s, `get` a `GetSetDef`, `call`
 * a `CallDef`, `init` an init def, and a `get`/`set` expr holds a `PathDef` of
 * steps. Until 0.4.0 the refusal stopped at the TypeDef, so the identical
 * mistake one level down kept its identical silent fate:
 *
 *   { name: 'fn', call: { args: {…}, retruns: { name: 'num' } } }   // a fn with NO return type
 *   { name: 'obj', props: { a: { typ: { name: 'num' } } } }         // was: a prop with no type
 *
 * A misspelt `returns` is exactly the `{name:'list', options:{item}}` defect
 * with a different key: the def parses, the type is plausible, and what the
 * author declared is gone. Each nested shape is now checked against its own
 * key list ({@link PROP_DEF_KEYS} and friends) by {@link checkDefKeys}, with
 * the same `did you mean` correction.
 *
 * Only AUTHORED shapes are checked. Every `from(...)` here also accepts the
 * in-memory instance it produced (`Prop`, `GetSet`, `Call`, `Init`) — those
 * carry gin's own fields by construction, so re-checking them would spend a
 * key scan per path-walk to police shapes gin itself built.
 *
 * A PATH STEP is checked by {@link checkPathStep}, which additionally refuses a
 * step naming more than ONE form. `PathStepDef` is a union — `{prop}` |
 * `{args, generic?, catch?}` | `{key}` — and `PathStep.from` took the first
 * form it recognized and dropped the rest, so the fused spelling an LLM reaches
 * for first,
 *
 *   { "prop": "announce", "args": { "note": … } }
 *
 * parsed as a bare prop read and was then diagnosed as `method 'announce' needs
 * arguments` — about the arguments the author had supplied in that very step.
 * Measured on a product acceptance lane, 2026-08-10: 30 of 33 refusals in one
 * turn were this one mis-spelling, and the model never touched it because the
 * diagnostic pointed at the one thing that was right.
 */

/**
 * Every key gin reads off a `TypeDef`. Anything else in a def is a
 * mis-build (see the module comment) and is refused by {@link checkWireKeys}.
 */
export const TYPE_DEF_KEYS = [
  'name', 'docs', 'extends', 'satisfies', 'generic',
  'options', 'init', 'props', 'get', 'call', 'constraint',
] as const satisfies readonly (keyof TypeDef)[];

/**
 * `true` when `Listed` covers every member of `All`, otherwise the members
 * left out — so {@link AssertCovered} names them in the compile error.
 */
export type CoversKeys<All extends PropertyKey, Listed extends PropertyKey> =
  [Exclude<All, Listed>] extends [never] ? true : Exclude<All, Listed>;

/**
 * Compile-time proof that a runtime key list mirrors the interface it
 * describes. Pair with {@link CoversKeys} next to every `optionKeys`
 * declaration: adding a field to the options interface and forgetting the
 * list would otherwise make the parser reject a legitimate def, which is
 * the one way this strictness could do harm.
 */
export type AssertCovered<T extends true> = T;

/** The list is the runtime mirror of `keyof TypeDef` — keep them in step. */
type _TypeDefKeysCovered = AssertCovered<CoversKeys<keyof TypeDef, (typeof TYPE_DEF_KEYS)[number]>>;

/** Every key gin reads off a `PropDef` — the shape under `TypeDef.props`. */
export const PROP_DEF_KEYS = [
  'docs', 'type', 'get', 'default', 'set',
] as const satisfies readonly (keyof PropDef)[];

/** Every key gin reads off a `GetSetDef` — the shape under `TypeDef.get`. */
export const GET_SET_DEF_KEYS = [
  'docs', 'key', 'value', 'get', 'set', 'loop', 'loopDynamic',
] as const satisfies readonly (keyof GetSetDef)[];

/** Every key gin reads off a `CallDef` — the shape under `TypeDef.call`. */
export const CALL_DEF_KEYS = [
  'docs', 'types', 'args', 'returns', 'throws', 'get', 'set',
] as const satisfies readonly (keyof CallDef)[];

/** Every key gin reads off an init def — the shape under `TypeDef.init`. */
export const INIT_DEF_KEYS = [
  'docs', 'args', 'run',
] as const satisfies readonly (keyof InitDef)[];

/** The init def has no exported interface of its own — it is declared inline
 *  on `TypeDef`, and this is the name the coverage proof needs. */
type InitDef = NonNullable<TypeDef['init']>;

type _PropDefKeysCovered = AssertCovered<CoversKeys<keyof PropDef, (typeof PROP_DEF_KEYS)[number]>>;
type _GetSetDefKeysCovered = AssertCovered<CoversKeys<keyof GetSetDef, (typeof GET_SET_DEF_KEYS)[number]>>;
type _CallDefKeysCovered = AssertCovered<CoversKeys<keyof CallDef, (typeof CALL_DEF_KEYS)[number]>>;
type _InitDefKeysCovered = AssertCovered<CoversKeys<keyof InitDef, (typeof INIT_DEF_KEYS)[number]>>;

/** Which slot of a def a bad key was found in. */
type Slot = 'top' | 'options' | 'generic';

/**
 * Reject any key in `def` that gin would ignore.
 *
 * @param def the def about to be parsed.
 * @param cls the built-in class that will consume `def.options` / `def.generic`
 *   — the class named by `def.extends` on an extension, otherwise the class
 *   named by `def.name`. `undefined` when the def routes to a registered
 *   named type or an Extension chain, where the slot keys are not statically
 *   known; the TypeDef-level check still runs.
 * @param checkGeneric false on the `extends` path (see the module comment).
 * @param registry builds the worked example a closed-set option is corrected
 *   with, so the suggested def is gin's OWN serialization and cannot drift.
 * @throws Error naming the offending key, the shape being parsed, and — when
 *   it can be inferred — the construct the author was actually reaching for.
 */
export function checkWireKeys(
  def: TypeDef,
  cls: TypeClass | undefined,
  checkGeneric: boolean,
  registry: TypeBuilder,
): void {
  // The point of this pass is the keys the interface does NOT declare, so the
  // def is read as the open bag it arrived as. An interface has no implicit
  // index signature, hence the widening.
  const bag = def as unknown as Record<string, unknown>;
  for (const key of definedKeys(bag)) {
    if ((TYPE_DEF_KEYS as readonly string[]).includes(key)) continue;
    throw new Error(
      `registry.parse: type '${def.name}' has unknown key '${key}'`
      + explain(key, bag[key], TYPE_DEF_KEYS, cls, 'top', registry),
    );
  }

  const options = isPlainObject(def.options) ? def.options : undefined;
  if (cls?.optionKeys && options) {
    for (const key of definedKeys(options)) {
      if (cls.optionKeys.includes(key)) continue;
      throw new Error(
        `registry.parse: type '${def.name}' has unknown options key '${key}'`
        + explain(key, options[key], cls.optionKeys, cls, 'options', registry),
      );
    }
  }

  const generic = isPlainObject(def.generic) ? def.generic : undefined;
  if (checkGeneric && cls?.genericKeys && generic) {
    for (const key of definedKeys(generic)) {
      if (cls.genericKeys.includes(key)) continue;
      throw new Error(
        `registry.parse: type '${def.name}' has unknown generic parameter '${key}'`
        + explain(key, generic[key], cls.genericKeys, cls, 'generic', registry),
      );
    }
  }
}

/**
 * Reject any key in a NESTED def shape that gin would ignore — the same
 * refusal {@link checkWireKeys} applies to a `TypeDef`, for the shapes hanging
 * off it (`PropDef`, `GetSetDef`, `CallDef`, the init def). See the module
 * comment for why a misspelt `returns` is the same defect as a misspelt
 * `generic`.
 *
 * @param what the shape being read, named as the author would recognize it —
 *   `"prop 'title'"`, `"call signature"`. Leads the message.
 * @param bag the authored def. Anything that is not a plain object is left to
 *   the caller's own "no scope to parse this" errors, which are more specific.
 * @param valid that shape's key list, e.g. {@link PROP_DEF_KEYS}.
 * @param hints per-key corrections for a key that is not a typo but a
 *   MISPLACEMENT — the author reached for a real construct and put it one
 *   level off. Same job as the `enum` respelling in {@link explain}: name the
 *   construct, not just the bad key.
 * @throws Error naming the offending key and the nearest valid one.
 */
export function checkDefKeys(
  what: string,
  bag: unknown,
  valid: readonly string[],
  hints?: Readonly<Record<string, string>>,
): void {
  if (!isPlainObject(bag)) return;
  for (const key of definedKeys(bag)) {
    if (valid.includes(key)) continue;
    const hint = hints?.[key];
    const near = nearest(key, valid);
    throw new Error(
      `gin.parse: ${what} has unknown key '${key}'`
      + (hint ? ` — ${hint}` : near ? ` — did you mean \`${near}\`?` : ` — valid keys: ${valid.join(', ')}`),
    );
  }
}

/**
 * Misplacements worth naming on a `CallDef`. A fn's type parameters are
 * declared on the TYPE (`FnType.from` reads `json.generic`), never on the
 * call — and gin's own rendering demo carried the wrong spelling until 0.4.0,
 * where it "worked" only because the unbound `{name:'T'}` in the signature
 * parses to a universal alias that matches anything.
 */
export const CALL_DEF_HINTS: Readonly<Record<string, string>> = {
  generic: "a fn declares its type parameters on the TYPE, not the call:"
    + ' {"name":"fn","generic":{"T":{"name":"any"}},"call":{"args":…,"returns":…}}',
};

/**
 * The three forms of a `PathStepDef`, each keyed by the field that SELECTS it.
 * Order matches `PathStep.from`'s dispatch, which is also the order they read
 * in the union.
 */
const PATH_STEP_FORMS = [
  { by: 'prop', keys: ['prop'], example: '{"prop":"name"}' },
  { by: 'args', keys: ['args', 'generic', 'catch'], example: '{"args":{…}}' },
  { by: 'key', keys: ['key'], example: '{"key":<expr>}' },
] as const satisfies readonly { by: string; keys: readonly string[]; example: string }[];

/**
 * Reject a path step gin would read only part of. Two refusals, both of which
 * used to be silent truncations (see the module comment):
 *
 *   1. a step naming MORE THAN ONE form — `{prop, args}` is a prop read AND a
 *      call, and gin took the prop and dropped the arguments;
 *   2. a key outside the form the step selected — `{prop:'x', arg:{…}}`.
 *
 * The message spells the fix as a step LIST, because that is the shape the
 * author has to end up with either way.
 *
 * @throws Error naming both forms, with the split spelling written out.
 */
export function checkPathStep(step: unknown): void {
  if (!isPlainObject(step)) return;
  const present = PATH_STEP_FORMS.filter((f) => step[f.by] !== undefined);
  if (present.length === 0) {
    // No form selected at all. `PathStep.from`'s own "unknown step shape" is
    // true but unactionable, and the usual cause is a near-miss on the
    // selecting key (`arg` for `args`), so say which key was expected.
    const found = definedKeys(step);
    const selectors = PATH_STEP_FORMS.map((f) => f.by);
    const near = found.map((k) => nearest(k, selectors)).find((n) => n !== undefined);
    throw new Error(
      `gin.parse: path step selects no form (keys: ${found.join(', ') || 'none'})`
      + (near ? ` — did you mean \`${near}\`?` : '')
      + ` — a step is one of ${PATH_STEP_FORMS.map((f) => f.example).join(', ')}`,
    );
  }
  if (present.length > 1) {
    const named = present.map((f) => `'${f.by}'`).join(' and ');
    const spelt = present.map((f) => (
      f.by === 'prop' ? JSON.stringify({ prop: step.prop }) : f.example
    )).join(', ');
    throw new Error(
      `gin.parse: path step names ${present.length} forms (${named}) — each is its own step: [${spelt}]`,
    );
  }
  checkDefKeys('path step', step, present[0]!.keys);
}

/** Keys actually carrying a value. An in-memory def routinely holds
 *  `options: undefined` (every `toJSON` writes the key unconditionally),
 *  which JSON drops and which gin never reads. */
function definedKeys(bag: Record<string, unknown>): string[] {
  return Object.keys(bag).filter((k) => bag[k] !== undefined);
}

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/** A TypeDef, or a list of them — anything with a `name` string. */
function holdsTypeDef(x: unknown): boolean {
  if (Array.isArray(x)) return x.length > 0 && holdsTypeDef(x[0]);
  return isPlainObject(x) && typeof x.name === 'string';
}

/** A PropDef — `{ type: … }`, the shape that belongs under `props`. */
function holdsPropDef(x: unknown): boolean {
  return isPlainObject(x) && 'type' in x;
}

/**
 * The correction half of the message. A refusal a model can't act on just costs
 * a turn, so the message aims to name the CONSTRUCT the author was reaching
 * for, not merely the key that was wrong:
 *
 *   1. a genuine typo → the key it meant;
 *   2. a closed set of constants on a non-generic type → that is an `enum`,
 *      with the members already respelled as one (see {@link enumClause});
 *   3. a misplaced TypeDef → the `generic` parameter it belongs in;
 *   4. a misplaced PropDef → `props`;
 *   5. otherwise the slot's valid keys (bounded — the longest is 11 names).
 */
function explain(
  key: string,
  value: unknown,
  valid: readonly string[],
  cls: TypeClass | undefined,
  slot: Slot,
  registry: TypeBuilder,
): string {
  const clauses: string[] = [];
  const near = nearest(key, valid);
  if (near) return ` — did you mean \`${near}\`?`;

  const generics = cls?.genericKeys ?? [];
  const asEnum = slot === 'options' ? enumClause(value, cls, registry) : undefined;
  if (asEnum) {
    clauses.push(asEnum);
  } else if (cls && slot !== 'generic' && generics.length > 0 && holdsTypeDef(value)) {
    clauses.push(
      `that value is a TypeDef, and '${cls.NAME}' takes its type argument${generics.length > 1 ? 's' : ''}`
      + ` in \`generic\` (${generics.join(', ')})`,
    );
  } else if (slot === 'top' && holdsPropDef(value) && (cls?.consumes ?? []).includes('props')) {
    clauses.push('that value is a PropDef — declare it under `props`');
  }

  clauses.push(validClause(valid, cls, slot));
  return ` — ${clauses.join('; ')}`;
}

/** How many members a closed-set correction will respell before it just names
 *  the construct. Long enough for a realistic status column, short enough that
 *  the message stays a signpost rather than a dump. */
const ENUM_EXAMPLE_MAX_MEMBERS = 12;

/**
 * The correction for the single most expensive mis-build in this family: a
 * CLOSED SET declared as an option on a scalar — `{name:'text', options:
 * {values:['todo','done']}}`. It used to parse to a plain `TextType` whose
 * `valid('anything')` is true, AND survive `toJSON` unchanged, so the author
 * read their own declaration back and saw the set sitting there enforcing
 * nothing. (Found on a live status column that did not even list a value two
 * stored rows already held.)
 *
 * The set is a type in gin, not an option, so the message respells it as one.
 * The example is built through the registry and serialized by gin's own
 * `toJSON`, never hand-written — a literal here would be a second copy of the
 * enum wire format, free to drift from the first.
 *
 * Returns undefined unless the value really is a closed set of same-typed
 * primitives on a non-generic class (so `or`/`and`/`tuple` option payloads,
 * which hold TypeDefs, and `enum`'s own `values` are untouched).
 */
function enumClause(value: unknown, cls: TypeClass | undefined, registry: TypeBuilder): string | undefined {
  if (!cls || cls.NAME === 'enum' || (cls.genericKeys?.length ?? 0) > 0) return undefined;
  const members = Array.isArray(value) ? value
    : isPlainObject(value) ? Object.values(value)
    : undefined;
  if (!members || members.length === 0) return undefined;
  const kind = typeof members[0];
  if (!members.every((m) => typeof m === kind)) return undefined;
  const inner = kind === 'number' ? registry.num()
    : kind === 'boolean' ? registry.bool()
    : kind === 'string' ? registry.text()
    : undefined;
  if (!inner) return undefined;
  const head = 'a closed set of constants is an `enum` in gin, not an option';
  if (members.length > ENUM_EXAMPLE_MAX_MEMBERS) return head;
  const keyed = Object.fromEntries(members.map((m) => [String(m), m]));
  return `${head}: ${JSON.stringify(registry.enum(keyed, inner).toJSON())}`;
}

function validClause(valid: readonly string[], cls: TypeClass | undefined, slot: Slot): string {
  const owner = cls ? `'${cls.NAME}'` : 'this type';
  if (slot === 'top') return `valid keys: ${valid.join(', ')}`;
  if (slot === 'options') {
    return valid.length === 0 ? `${owner} takes no options` : `valid options for ${owner}: ${valid.join(', ')}`;
  }
  return valid.length === 0
    ? `${owner} is not generic`
    : `valid generic parameters for ${owner}: ${valid.join(', ')}`;
}

// ─── OPTION-KEY COVERAGE ────────────────────────────────────────────────────
//
// Every `optionKeys` list whose class has a real options INTERFACE is proven
// here to cover it. `as const satisfies readonly (keyof O)[]` at the
// declaration already rejects a key that isn't in the interface; these
// aliases close the other direction — adding an option to the interface and
// forgetting the list would make `parse` refuse a legitimate def, which is
// the only way this strictness could do harm. A compile error here names the
// missing key.
//
// Absent by design: `and` / `or` (whose WIRE key `types` is not their runtime
// options field, so there is nothing to mirror) and every class whose options
// type is `Record<string, never>` (nothing to cover).

type _BoolOptionKeys = AssertCovered<CoversKeys<keyof BoolOptions, (typeof BoolType.optionKeys)[number]>>;
type _NumOptionKeys = AssertCovered<CoversKeys<keyof NumOptions, (typeof NumType.optionKeys)[number]>>;
type _TextOptionKeys = AssertCovered<CoversKeys<keyof TextOptions, (typeof TextType.optionKeys)[number]>>;
type _ListOptionKeys = AssertCovered<CoversKeys<keyof ListOptions, (typeof ListType.optionKeys)[number]>>;
type _ColorOptionKeys = AssertCovered<CoversKeys<keyof ColorOptions, (typeof ColorType.optionKeys)[number]>>;
type _DateOptionKeys = AssertCovered<CoversKeys<keyof DateOptions, (typeof DateType.optionKeys)[number]>>;
type _TimestampOptionKeys = AssertCovered<CoversKeys<keyof TimestampOptions, (typeof TimestampType.optionKeys)[number]>>;
type _TupleOptionKeys = AssertCovered<CoversKeys<keyof TupleOptions, (typeof TupleType.optionKeys)[number]>>;
type _EnumOptionKeys = AssertCovered<CoversKeys<keyof EnumOptions, (typeof EnumType.optionKeys)[number]>>;
type _LiteralOptionKeys = AssertCovered<CoversKeys<keyof LiteralOptions, (typeof LiteralType.optionKeys)[number]>>;
type _NotOptionKeys = AssertCovered<CoversKeys<keyof NotOptions, (typeof NotType.optionKeys)[number]>>;
