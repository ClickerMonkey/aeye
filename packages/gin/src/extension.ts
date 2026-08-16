import type { Registry, TypeAugmentation } from './registry';
import { LocalScope, type TypeScope } from './type-scope';
import type { PropDef, TypeDef } from './schema';
import { Value, val } from './value';
import {
  Call,
  type CompatOptions,
  GetSet,
  Init,
  type NewSlotVisitor,
  Prop,
  type PropSpec,
  type Rnd,
  Type,
  ENVELOPE_ENCODE,
  slotAccepts,
  encodeSlot,
  isRecordPayload,
} from './type';
import type { Scope } from './scope';
import type { Engine } from './engine';
import type { EncodeOptions, JSONOf, RuntimeOf } from './json-type';
import { z } from 'zod';
import type { CodeOptions, SchemaOptions, ValueSchemaOptions } from './node';
import type { Expr } from './expr';

/**
 * What an Extension adds on top of its base. All fields except `name` are
 * optional — an Extension can add props alone, or narrow options alone, etc.
 *
 * `generic` declares the Extension's OWN type parameters (independent of
 * any generics the base already has). Each key is the parameter name; the
 * value is the current binding (use `registry.any()` as a default, or a
 * concrete Type for a bound instance). Placeholders elsewhere in the
 * local spec use `registry.alias('T')` — those resolve through any
 * extra `TypeScope` passed at access time (e.g. a path call site's
 * `<T: num>` bindings) before falling back to the captured layer.
 *
 *   registry.extend('obj', {
 *     name: 'Box',
 *     generic: { T: registry.any() },
 *     props: { value: { type: registry.alias('T') } },
 *   })
 */
export interface ExtensionLocal<T = any, O = any> {
  name: string;
  docs?: string;
  options?: Partial<O>;
  generic?: Record<string, Type>;
  props?: Record<string, Prop | PropSpec>;
  get?: GetSet;
  call?: Call;
  init?: Init;
  /**
   * Runtime predicate every value of this Extension must satisfy.
   * Evaluated with `this` bound to the value being validated; must return
   * bool. Runs via `Engine.validateValue(value)` — not from `Type.valid()`
   * (which has no engine access). Also described in the Zod schema so
   * LLMs see the constraint as part of the type's description.
   */
  constraint?: Expr;
}

/**
 * Extension<T, O> — the runtime manifestation of a type declared with
 * `extends`. Delegates everything to the base, overlays local additions.
 *
 * Invariants:
 *  - local.options may ONLY narrow base.options. Widening attempts throw
 *    from the base's narrow().
 *  - Every Extension value is also a valid base value (covariant).
 *  - Multi-level extension is natural: base may itself be an Extension.
 *  - Extension performs NO inspection of the base's concrete class —
 *    everything goes through base's public Type methods.
 */
/**
 * Wrap plain object literals in the matching class so Prop/GetSet/Call/Init
 * methods (read/write/invokeMethod/…) are available on the normalized
 * Extension.local. Idempotent for already-wrapped values.
 */
/** Did narrowing change the base's options at all? Shallow by design — option
 *  values are scalars or (for `not` / `tuple` / `or` / `and`) the very objects
 *  the base already holds, so identity per key is the right comparison and
 *  costs nothing. */
function sameOptions(narrowed: unknown, base: unknown): boolean {
  if (narrowed === base) return true;
  if (typeof narrowed !== 'object' || narrowed === null || typeof base !== 'object' || base === null) return false;
  const a = narrowed as Record<string, unknown>;
  const b = base as Record<string, unknown>;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k]);
}

/**
 * The `props` slot of an Extension's wire def: the anonymous base's own
 * members, then the local additions (local wins a name conflict, matching
 * `Extension.props()`' composition order). `undefined` when both are
 * empty, so a props-free type keeps emitting no `props` key at all.
 */
function mergeJSONProps(
  basePropsFromRef: Record<string, Prop | PropSpec>,
  local: Record<string, Prop | PropSpec> | undefined,
): Record<string, PropDef> | undefined {
  const baseKeys = Object.keys(basePropsFromRef);
  if (baseKeys.length === 0) return local ? Prop.toJSONMap(local) : undefined;
  return {
    ...Prop.toJSONMap(basePropsFromRef),
    ...(local ? Prop.toJSONMap(local) : {}),
  };
}

function normalizeLocal<T, O>(local: ExtensionLocal<T, O>, registry: Registry): ExtensionLocal<T, O> {
  return {
    ...local,
    props: local.props ? Prop.fromMap(local.props, registry) : undefined,
    get: local.get ? GetSet.from(local.get, registry) : undefined,
    call: local.call ? Call.from(local.call, registry) : undefined,
    init: local.init ? Init.from(local.init, registry) : undefined,
  };
}

export class Extension<T = any, O = any> extends Type<T, O> {
  readonly name: string;
  readonly docs?: string;

  /**
   * Base with any narrowed options already applied. Value operations
   * delegate here, so tighter constraints are automatically enforced.
   */
  readonly base: Type<T>;

  /** Original base before narrowing — used for encode()'s `extends`. */
  readonly original: Type<T>;

  readonly local: ExtensionLocal<T, O>;

  /**
   * Generic ARGUMENTS this instance was specialized with, or undefined for
   * the unspecialized declaration. Only entries that are real bindings
   * appear — a parameter still standing at its own placeholder is not a
   * binding, and putting one here would make `AliasType` resolve `Row` to
   * the very alias named `Row`.
   */
  readonly bindings?: Record<string, Type>;

  constructor(
    registry: Registry,
    original: Type<T>,
    local: ExtensionLocal<T, O>,
    /**
     * Resolution scope for the placeholders inside `local`. Defaults to
     * the registry (the unspecialized case). {@link specialize} passes a
     * `LocalScope` carrying the generic arguments, which is what makes a
     * bound `QueryResult<Row=…>` actually behave as the bound type rather
     * than merely print like one.
     */
    scope?: TypeScope,
  ) {
    const narrowedOptions = local.options
      ? original.narrow(local.options)
      : (original.options as O);

    // Rebuild the base only when narrowing actually CHANGED something. The
    // rebuild splices RUNTIME options into a WIRE def, which is only sound for
    // the types whose two forms coincide — `or`/`and` keep `variants`/`parts`
    // in memory but `types` on the wire, and `not` keeps a live `Type` where
    // the wire wants a TypeDef. Their `narrow` has no per-part semantics and
    // hands the base's own options straight back, so before this guard
    // `extend(or([text, num]), {options})` spliced `{variants:[…]}` into a def
    // that reads `options.types` and produced `or<>` — an Extension whose base
    // refused every value (`and<>` went the other way and accepted every
    // value). Nothing changed ⇒ nothing to rebuild ⇒ the corruption cannot
    // happen; a real narrowing (`num`, `text`, `list`, …) returns a fresh
    // merged options object and rebuilds exactly as before.
    const effectiveBase = local.options && !sameOptions(narrowedOptions, original.options)
      ? (registry.parse({ ...original.toJSON(), options: narrowedOptions as any }) as Type<T>)
      : original;

    // Thread local generic declarations up to the base Type so `this.generic`
    // reflects the Extension's own parameters. Generic specialization at
    // call sites is handled by passing an extra TypeScope into the
    // resolution-touching methods (parse / valid / call / props / etc.) —
    // AliasType reads the override layer first, then its captured scope.
    super(scope ?? registry, narrowedOptions, local.generic ?? {});
    this.original = original;
    this.base = effectiveBase;
    this.local = normalizeLocal(local, registry);
    this.name = local.name;
    this.docs = local.docs;
    const bound = Object.entries(local.generic ?? {})
      .filter(([k, t]) => !Type.isGenericPlaceholder(k, t));
    this.bindings = bound.length > 0 ? Object.fromEntries(bound) : undefined;
  }

  // ─── VALUE OPERATIONS (delegate to effective base) ─────────────────────

  // Every scope-taking delegation runs the caller's scope through
  // `bindScope` so a SPECIALIZED instance actually behaves as its
  // bindings — otherwise `QueryResult<obj{id: text}>` would print a
  // binding it does not honour, which is worse than printing nothing.

  /**
   * The Extension's own props that are STORED DATA rather than SURFACE.
   *
   * A local prop is surface when something else computes it: a `get`
   * expression derives it from `this`, and a callable type carries its body
   * in `get` — a method is not part of any value. Everything else is a field
   * this type ADDS to its base, and a value of the type has to carry it.
   *
   * Until 0.4.1 nothing drew that line and every local prop was treated as
   * surface by `parse`/`valid`/`encode` and as shape by `toValueSchema` — so
   * three surfaces of one type disagreed:
   *
   *   const W = r.extend(r.obj({}), {name:'W', props:{id:{type:r.text()}}});
   *   W.toValueSchema().safeParse({})   // FAILED: 'id' is required
   *   W.parse({id:'i'}).raw             // {}        ← the data vanished
   *   W.valid({})                       // true      ← and the loss was blessed
   *
   * The schema told a model to emit `{id}`, `parse` built that emission into
   * an empty value, and `valid` called the result a legal value of the type.
   * The line below is what the declaration reads as: `{name:'W',
   * extends:'obj', props:{id}}` is "a W, which is an obj, PLUS an id".
   *
   * Only meaningful when the base's raw is a record — you cannot store a
   * field on a `text`. Callers pair this with {@link isRecordPayload}.
   */
  private storedLocalProps(): Array<[string, Prop]> {
    const out: Array<[string, Prop]> = [];
    for (const [name, raw] of Object.entries(this.local.props ?? {})) {
      const prop = raw instanceof Prop ? raw : Prop.from(raw);
      if (prop.get || prop.type.call()) continue;
      out.push([name, prop]);
    }
    return out;
  }

  valid(raw: unknown, scope?: TypeScope): raw is RuntimeOf<T> {
    const bound = this.bindScope(scope);
    if (!this.base.valid(raw, bound)) return false;
    const locals = this.storedLocalProps();
    // A non-record base has nowhere to keep an added field, so `parse` never
    // creates the slot — and `valid` must agree, or the very first `parse`
    // would produce a value the type refuses and the Extension would be
    // uninhabitable. Every surface bails on the same condition:
    // `mergeLocalPropsInto` needs a `ZodObject`, `encode` and `withLocalSlots`
    // need a record.
    if (locals.length === 0 || !isRecordPayload(raw)) return true;
    const rec = raw as Record<string, unknown>;
    for (const [name, prop] of locals) {
      const slot = rec[name];
      // Each stored slot holds a `Value` whose own type may be a SUBTYPE of
      // the declared one — the same covariance `ObjType.valid` allows.
      if (!(slot instanceof Value)) return prop.type.isOptional();
      if (!slot.type.valid(slot.raw, bound)) return false;
      if (!slotAccepts(prop.type, slot.type, bound)) return false;
    }
    return true;
  }

  parse(json: unknown, scope?: TypeScope): Value<T> {
    const bound = this.bindScope(scope);
    const v = this.base.parse(json, bound);
    const locals = this.storedLocalProps();
    if (locals.length === 0 || !isRecordPayload(v.raw)) {
      // Re-wrap so Value.type is this Extension, not the base.
      return new Value(this, v.raw);
    }
    const input = isRecordPayload(json) ? (json as Record<string, unknown>) : {};
    const raw: Record<string, unknown> = { ...(v.raw as Record<string, unknown>) };
    for (const [name, prop] of locals) {
      raw[name] = this.registry.parseValue(input[name], prop.type, bound);
    }
    return new Value(this, raw as RuntimeOf<T>);
  }

  encode(raw: RuntimeOf<T>, scope?: TypeScope): JSONOf<T> {
    return this.encodeAs(raw, ENVELOPE_ENCODE, scope) as JSONOf<T>;
  }

  /** The base's walk, plus this Extension's own STORED props — a field the
   *  Extension adds has to come back out or the round trip loses it. */
  encodeAs(raw: RuntimeOf<T>, opts: EncodeOptions, scope?: TypeScope): unknown {
    const bound = this.bindScope(scope);
    const encoded = this.base.encodeAs(raw, opts, bound);
    const locals = this.storedLocalProps();
    if (locals.length === 0 || !isRecordPayload(encoded) || !isRecordPayload(raw)) return encoded;
    const rec = raw as Record<string, unknown>;
    const out: Record<string, unknown> = { ...(encoded as Record<string, unknown>) };
    for (const [name] of locals) {
      const slot = rec[name];
      if (slot instanceof Value) out[name] = encodeSlot(slot, opts, bound);
    }
    return out;
  }

  create(): RuntimeOf<T> {
    return this.withLocalSlots(this.base.create(), (t) => t.create());
  }

  random(rnd: Rnd): RuntimeOf<T> {
    return this.withLocalSlots(this.base.random(rnd), (t) => t.random(rnd));
  }

  /** `create`/`random` must populate the stored local props too, or the
   *  type refuses the value its own constructor just produced — the
   *  invariant `create-parse-invariant.test.ts` sweeps for. */
  private withLocalSlots(baseRaw: RuntimeOf<T>, make: (t: Type) => unknown): RuntimeOf<T> {
    const locals = this.storedLocalProps();
    if (locals.length === 0 || !isRecordPayload(baseRaw)) return baseRaw;
    const out: Record<string, unknown> = { ...(baseRaw as Record<string, unknown>) };
    for (const [name, prop] of locals) out[name] = new Value(prop.type, make(prop.type));
    return out as RuntimeOf<T>;
  }

  /**
   * A `new <ThisExtension>{value}` payload is the BASE's payload plus this
   * Extension's own stored props (see {@link storedLocalProps}), so the slot
   * walk is the base's walk with those slots appended.
   *
   * The base first, then the locals, matching `props()`' composition order —
   * a local prop shadowing a base field re-visits that field's slot with the
   * LOCAL declaration, which is the one that wins everywhere else.
   */
  forEachNewSlot(value: unknown, visit: NewSlotVisitor): boolean {
    const decomposed = this.base.forEachNewSlot(value, visit);
    const locals = this.storedLocalProps();
    if (locals.length === 0 || !isRecordPayload(value)) return decomposed;
    const input = value as Record<string, unknown>;
    for (const [name, prop] of locals) {
      if (name in input) visit.slot(prop.type, input[name], name);
      else if (prop.default !== undefined) visit.missing?.(prop.default, name);
    }
    return true;
  }

  async newFill(value: unknown, engine: Engine, scope: Scope): Promise<unknown> {
    const filled = await this.base.newFill(value, engine, scope);
    const locals = this.storedLocalProps();
    if (locals.length === 0 || !isRecordPayload(filled)) return filled;
    const input = filled as Record<string, unknown>;
    let out: Record<string, unknown> | undefined;
    for (const [name, prop] of locals) {
      if (name in input) {
        const next = await prop.type.newFill(input[name], engine, scope);
        if (next !== input[name]) {
          out ??= { ...input };
          out[name] = next;
        }
      } else if (prop.default !== undefined) {
        out ??= { ...input };
        out[name] = await prop.default.evaluate(engine, scope);
      }
    }
    return out ?? input;
  }

  // ─── TYPE RELATIONS ────────────────────────────────────────────────────

  compatible(other: Type, opts?: CompatOptions, scope?: TypeScope): boolean {
    if (opts?.exact) {
      // Exact requires same Extension name.
      if (other instanceof Extension && other.name === this.name) {
        return this.base.compatible(other.base, opts, scope);
      }
      return false;
    }
    // Covariant: compatible with base (looser) and with other Extensions
    // sharing a compatible base.
    if (other instanceof Extension) {
      return this.base.compatible(other.base, opts, scope);
    }
    return this.base.compatible(other, opts, scope);
  }

  // ─── ALGEBRA ───────────────────────────────────────────────────────────

  or(other: Type<T>): Type<T> {
    // Only merges two Extensions of the same name. Otherwise, caller
    // should build an Or via registry.or([...]).
    if (other instanceof Extension && other.name === this.name) {
      const merged: ExtensionLocal<T, O> = {
        name: this.name,
        docs: this.docs ?? other.docs,
        options: { ...(this.local.options ?? {}), ...(other.local.options ?? {}) } as Partial<O>,
        props: { ...(this.local.props ?? {}), ...(other.local.props ?? {}) },
        get: this.local.get ?? other.local.get,
        call: this.local.call ?? other.local.call,
        init: this.local.init ?? other.local.init,
      };
      return new Extension(this.registry, this.original, merged);
    }
    // Fall back to the base's or.
    return this.base.or(other);
  }

  simplify(): Type {
    return this;
  }

  required(): Type {
    return this.base.required();
  }

  isOptional(): boolean {
    return this.base.isOptional();
  }

  narrow(local: Partial<O>): O {
    // Narrow further atop already-narrowed options. Delegate to base —
    // per-option directional rules live there.
    return this.base.narrow(local);
  }

  // ─── EFFECTIVE ACCESS SPECS (merge local over base) ────────────────────

  props(scope?: TypeScope): Record<string, Prop | PropSpec> {
    // Order: base (carries `augmentation('obj')`) → registry-augmentation
    // for THIS name → extension's own local. Extension-local wins last
    // so authors can shadow either base or augmentation on conflict.
    const ownAug = this.registry.augmentation(this.name);
    return {
      ...this.base.props(this.bindScope(scope)),
      ...(ownAug?.props ?? {}),
      ...(this.local.props ?? {}),
    };
  }

  get(scope?: TypeScope): GetSet | undefined {
    return this.local.get
      ?? this.registry.augmentation(this.name)?.get
      ?? this.base.get(this.bindScope(scope));
  }

  call(scope?: TypeScope): Call | undefined {
    return this.local.call
      ?? this.registry.augmentation(this.name)?.call
      ?? this.base.call(this.bindScope(scope));
  }

  init(scope?: TypeScope): Init | undefined {
    return this.local.init
      ?? this.registry.augmentation(this.name)?.init
      ?? this.base.init(this.bindScope(scope));
  }

  // ─── SCHEMA ROUND-TRIP ─────────────────────────────────────────────────

  toJSON(): TypeDef {
    const baseDef = this.original.toJSON();
    const crossExtend = this.original.name !== this.name;
    // Always merge base options with local — even on cross-extend. For
    // types like TupleType whose identity lives entirely in options
    // (`elements`), dropping base options on cross-extend loses the
    // structure. Local options still win on per-key conflict, so narrowing
    // behaves as before.
    const mergedOptions = {
      ...(baseDef.options as Record<string, unknown> | undefined),
      ...(this.local.options as Record<string, unknown> | undefined),
    };
    // Merge base's generics with Extension's own. Extension names win on
    // conflict (which is a user error — don't shadow base parameter names).
    const mergedGeneric: Record<string, TypeDef> = { ...(baseDef.generic ?? {}) };
    if (this.local.generic) {
      for (const [k, t] of Object.entries(this.local.generic)) {
        mergedGeneric[k] = t.toJSON();
      }
    }
    return {
      name: this.name,
      extends: crossExtend ? this.original.name : undefined,
      docs: this.docs,
      generic: Object.keys(mergedGeneric).length > 0 ? mergedGeneric : undefined,
      options: mergedOptions && Object.keys(mergedOptions).length > 0 ? mergedOptions : undefined,
      // An ANONYMOUS structural base's own members ride along in the SAME
      // `props` / `get` / `call` slots as the local additions.
      //
      // Not a merge for elegance — without it the base's members were
      // simply DROPPED, and `registry.parse(t.toJSON())` produced a type
      // that accepted different values than the one it serialized:
      // `extend(obj{id, title}, {name:'todo_task', props:{note}})` came
      // back as `obj{note}`, so a row missing `id` and `title` — which
      // the original refused — round-tripped into a valid one.
      //
      // A TypeDef has exactly ONE `props` slot and `extends: 'obj'` makes
      // it structural, so a single merged slot is the only faithful wire
      // form; parse folds the whole thing back into the structural base.
      // A NAMED base contributes nothing here (`Type.refProps` is empty
      // for an Extension), so an inherited prop is never copied down into
      // the deriving type — it stays implicit under its base's name.
      props: mergeJSONProps(
        crossExtend ? this.original.refProps() : {},
        this.local.props,
      ),
      get: (this.local.get ?? (crossExtend ? this.original.refGet() : undefined))?.toJSON(),
      call: (this.local.call ?? (crossExtend ? this.original.refCall() : undefined))?.toJSON(),
      init: this.local.init?.toJSON(),
      constraint: this.local.constraint ? this.local.constraint.toJSON() : undefined,
    };
  }

  clone(): Extension<T, O> {
    const clonedGeneric = this.local.generic
      ? Object.fromEntries(
          Object.entries(this.local.generic).map(([k, t]) => [k, t.clone()]),
        )
      : undefined;
    return new Extension(this.registry, this.original.clone(), {
      name: this.local.name,
      docs: this.local.docs,
      options: this.local.options ? { ...this.local.options } : undefined,
      generic: clonedGeneric,
      props: this.local.props ? { ...this.local.props } : undefined,
      get: this.local.get,
      call: this.local.call,
      init: this.local.init,
      constraint: this.local.constraint?.clone(),
    // A specialized clone must keep resolving its bindings, so the
    // resolution scope travels with the copy.
    }, this.bindings ? this.scope : undefined);
  }

  /**
   * A reference to this Extension is its NAME — plus its generic
   * ARGUMENTS when it has been specialized (`QueryResult<obj{id: text}>`).
   * An unspecialized reference still prints bare (`QueryResult`), because
   * `<Row>` there would be the declaration echoed back, not information.
   *
   * The binding matters: a `QueryResult<Row>` that printed bare at a use
   * site lost the row type, which is the whole reason to name the
   * envelope. See {@link specialize} for how a bound instance is made.
   */
  toCode(_registry?: Registry, options?: CodeOptions): string {
    return this.docsPrefix(options) + this.name + Type.renderGenericArgs(this.generic, options);
  }

  /**
   * Renders `type Email extends text{pattern="..."}` headers in
   * `toCodeDefinition`. Uses `base` (narrowed) rather than `original`
   * so the constraints the Extension sits atop are visible.
   *
   * The base is rendered as a REFERENCE (`Type.toCodeRef`), so an
   * anonymous `obj` base contributes `extends obj` rather than inlining
   * its whole field list onto the header line. The clause survives
   * because inheritance is information — `obj` carries props this type
   * will never list — but the base's structure belongs in the body, and
   * {@link definitionProps} puts it there.
   */
  protected extendsClause(options?: CodeOptions): string {
    return ` extends ${this.base.toCodeRef(undefined, options)}`;
  }

  /**
   * Did the `extends` clause print the base by name and thereby elide its
   * declared members? If so the definition body must recover them —
   * an anonymous base is not reachable by any name, so members hidden on
   * both sides would simply vanish from the print.
   *
   * Derived by comparing the two renderings rather than testing the
   * base's class, so a new structural type that overrides `toCodeRef`
   * participates automatically and the two halves can never disagree
   * about what was hidden.
   */
  private baseMembersElided(options?: CodeOptions): boolean {
    return this.base.toCodeRef(undefined, options) !== this.base.toCode(undefined, options);
  }

  // Definition hooks — an Extension's rendered body shows only the
  // additions it declares on top of its base, PLUS whatever the `extends`
  // clause elided (see `baseMembersElided`). A base that prints as a
  // resolvable name keeps its surface implicit under that name; a base
  // that printed as bare `obj` hands its fields over to the body.
  //
  // The recovery reads the `ref*` hooks and NOT the effective `init()` /
  // `get()` / `call()`, because the contract is exactly "what the inlined
  // form showed": an obj's `get()` is a key union DERIVED from its fields
  // and never appeared inline, so recovering it would invent a member.
  //
  // A `registry.augment(<this name>, …)` addition is an ADDITION ON THIS
  // TYPE, not part of the base's implicit surface, so it belongs in the
  // body exactly like a local one. Leaving it out was a real defect: the
  // one product native with behaviour attached four methods by
  // augmentation, and reached the model as data fields with nothing it
  // could call — `props()` answered them, the definition did not. Each
  // hook reads the SAME precedence its runtime counterpart above uses
  // (local → own augmentation → base), so what the print shows and what
  // a path-walk dispatches against cannot diverge.
  //
  // Only the augmentation registered under THIS name is consulted. One
  // registered against the BASE's name arrives through `base.props()` /
  // `base.get()` and stays implicit under the `extends` clause, which
  // keeps the "additions only, never the base" property intact.
  private ownAugmentation(): TypeAugmentation | undefined {
    return this.registry.augmentation(this.name);
  }
  protected definitionInit(): Init | undefined {
    return this.local.init ?? this.ownAugmentation()?.init;
  }
  protected definitionCall(): Call | undefined {
    return this.local.call
      ?? this.ownAugmentation()?.call
      ?? (this.baseMembersElided() ? this.base.refCall() : undefined);
  }
  protected definitionGet(): GetSet | undefined {
    return this.local.get
      ?? this.ownAugmentation()?.get
      ?? (this.baseMembersElided() ? this.base.refGet() : undefined);
  }
  protected definitionProps(): Record<string, Prop | PropSpec> {
    // Base members first so the shape reads before the additions do, and
    // a local override of a base field lands in the base field's slot;
    // then augmentation, then local — `props()`' composition order, so a
    // local prop shadowing an augmented one prints the local one.
    return {
      ...(this.baseMembersElided() ? this.base.refProps() : {}),
      ...(this.ownAugmentation()?.props ?? {}),
      ...(this.local.props ?? {}),
    };
  }

  /**
   * This Extension with its type parameters BOUND — the use-site form of
   * a generic (`QueryResult.specialize({ Row: rowType })` renders as
   * `QueryResult<obj{id: text}>`).
   *
   * The returned instance is a clone: the registered declaration is never
   * mutated, so two specializations of one generic coexist. Bindings are
   * carried two ways, and both are needed:
   *
   *  - in `local.generic` (hence `this.generic`), which is what the
   *    renderer reads; and
   *  - in a `LocalScope` layered over this type's own scope, which is
   *    what the `AliasType` placeholders inside `local.props` / `call` /
   *    `get` resolve through. Resolution in gin is scope-driven — there is
   *    no eager substitution pass — so without the scope the render would
   *    claim a binding the type does not actually honour.
   *
   * Names not declared as parameters of this Extension are ignored: a
   * binding for something that is not a parameter is a caller error that
   * must not silently widen the type's surface.
   */
  specialize(bindings: Record<string, Type>): Extension<T, O> {
    const applied: Record<string, Type> = { ...(this.local.generic ?? {}) };
    const bound: Record<string, Type> = {};
    for (const k of Object.keys(this.local.generic ?? {})) {
      const b = bindings[k];
      if (!b) continue;
      applied[k] = b;
      bound[k] = b;
    }
    if (Object.keys(bound).length === 0) return this;
    return new Extension<T, O>(
      this.registry,
      this.original,
      { ...this.local, generic: applied },
      new LocalScope(this.scope, bound),
    );
  }

  /**
   * Overlay this instance's generic arguments onto a caller-supplied
   * resolution scope. The arguments sit INNERMOST — a specialization is
   * fixed at the reference, so it wins over whatever the surrounding
   * call site happens to bind for the same name.
   */
  private bindScope(scope?: TypeScope): TypeScope | undefined {
    if (!this.bindings) return scope;
    return scope ? new LocalScope(scope, this.bindings) : this.scope;
  }

  /**
   * Collected constraints: this Extension's local constraint (if any)
   * prepended to the base's chain. Consumers (`Engine.validateValue`,
   * `describeType`) evaluate/display them in that order.
   */
  constraints(): Expr[] {
    const base = this.base.constraints();
    return this.local.constraint ? [this.local.constraint, ...base] : base;
  }

  toValueSchema(opts?: ValueSchemaOptions): z.ZodTypeAny {
    // Extensions normally delegate to base — but when `local.props` adds
    // data fields atop an object-shaped base (obj/iface), those fields need
    // to land in the value schema too. Nothing else in the pipeline pushes
    // them down into base.fields.
    let schema = this.base.toValueSchema(opts);
    schema = this.mergeLocalPropsInto(schema, opts, (p) => p.type.toValueSchema(opts));
    return this.describeType(schema, opts);
  }

  toNewSchema(opts: SchemaOptions): z.ZodTypeAny {
    // Fields atop an object-shaped base accept any Expr.
    let schema = this.base.toNewSchema(opts);
    schema = this.mergeLocalPropsInto(schema, opts, () => opts.Expr);
    return this.describeType(schema, opts, 'NewValue_');
  }

  /** By-name match — Extensions are identified uniquely by their name. */
  toInstanceSchema(): z.ZodTypeAny {
    return z.object({ name: z.literal(this.name) }).passthrough();
  }

  /**
   * Add the Extension's own STORED props to an object-shaped base schema.
   *
   * Stored only — a slot that is pure SURFACE must not be demanded of the
   * model that emits a value. A `Resource` is supplied as a bare `{id}`
   * handle and resolved server-side; when its four methods rode local props
   * the value schema required `url`, `markdown`, `thumbnail` and
   * `contentType` on every handle, which no caller can supply and no value
   * of the type carries. Same line as {@link storedLocalProps}, so what
   * `parse` fills and what the schema asks for cannot diverge.
   */
  private mergeLocalPropsInto(
    schema: z.ZodTypeAny,
    opts: ValueSchemaOptions | undefined,
    slotFor: (prop: Prop) => z.ZodTypeAny,
  ): z.ZodTypeAny {
    if (!(schema instanceof z.ZodObject)) return schema;
    const mode = opts?.includeDocs ?? 'none';
    const extra: Record<string, z.ZodTypeAny> = {};
    for (const [name, p] of this.storedLocalProps()) {
      let slot = slotFor(p);
      if (mode === 'all' && p.docs) slot = slot.describe(p.docs);
      extra[name] = p.type.isOptional() ? slot.optional() : slot;
    }
    if (Object.keys(extra).length === 0) return schema;
    return (schema as z.ZodObject<z.ZodRawShape>).extend(extra);
  }

  // ─── SUPER HOOKS (called polymorphically via Type.propSuperFor) ────────

  /**
   * If this Extension's local props has an override for `name` AND the
   * base has a same-named prop, return a Fn Value delegating to the base
   * in the given direction. Direction 'get' gives the method/field read
   * super, 'set' gives the field-set super, 'callSet' gives the
   * CallDef.set super.
   */
  propSuperFor(
    self: Value,
    name: string,
    direction: 'get' | 'set' | 'callSet',
    scope: Scope,
    engine: Engine,
  ): Value | undefined {
    const localProps = this.local.props;
    const isLocal = !!(localProps && Object.hasOwn(localProps, name));
    if (!isLocal) return undefined;
    const baseProp = this.base.prop(name);
    if (!baseProp) return undefined;
    const selfAsBase = new Value(this.base, self.raw);

    if (direction === 'get') {
      if (baseProp.type.call() && baseProp.get) {
        const fnType = baseProp.type;
        const callable = async (args: Value): Promise<Value> => {
          const bindings: Record<string, Value> = { this: selfAsBase, args };
          const innerSuper = selfAsBase.type.propSuperFor(selfAsBase, name, 'get', scope, engine);
          if (innerSuper) bindings.super = innerSuper;
          return engine.evaluate(baseProp.get!, scope.child(bindings));
        };
        return new Value(fnType, callable);
      }
      const fnType = engine.registry.fn({
        args: engine.registry.obj({}),
        returns: baseProp.type,
      });
      const callable = async (_args: Value): Promise<Value> => {
        if (!baseProp.get) return val(baseProp.type, (selfAsBase.raw as Record<string, unknown> | null | undefined)?.[name]);
        const bindings: Record<string, Value> = { this: selfAsBase };
        const innerSuper = selfAsBase.type.propSuperFor(selfAsBase, name, 'get', scope, engine);
        if (innerSuper) bindings.super = innerSuper;
        return engine.evaluate(baseProp.get, scope.child(bindings));
      };
      return new Value(fnType, callable);
    }

    if (direction === 'set') {
      if (!baseProp.set) return undefined;
      const fnType = engine.registry.fn({
        args: engine.registry.obj({ value: { type: baseProp.type } }),
        returns: engine.registry.void(),
      });
      const callable = async (args: Value): Promise<Value> => {
        const newValue = (args.raw as Record<string, Value>).value!;
        const bindings: Record<string, Value> = { this: selfAsBase, value: newValue };
        const innerSuper = selfAsBase.type.propSuperFor(selfAsBase, name, 'set', scope, engine);
        if (innerSuper) bindings.super = innerSuper;
        await engine.evaluate(baseProp.set!, scope.child(bindings));
        return val(engine.registry.void(), undefined);
      };
      return new Value(fnType, callable);
    }

    // direction === 'callSet'
    const baseCall = baseProp.type.call();
    if (!baseCall?.set) return undefined;
    const fnType = engine.registry.fn({
      args: engine.registry.obj({
        args: { type: baseCall.args },
        value: { type: baseCall.returns ?? engine.registry.any() },
      }),
      returns: engine.registry.void(),
    });
    const callable = async (args: Value): Promise<Value> => {
      const raw = args.raw as Record<string, Value>;
      const bindings: Record<string, Value> = {
        this: selfAsBase, args: raw.args!, value: raw.value!,
      };
      const innerSuper = selfAsBase.type.propSuperFor(selfAsBase, name, 'callSet', scope, engine);
      if (innerSuper) bindings.super = innerSuper;
      await engine.evaluate(baseCall.set!, scope.child(bindings));
      return val(engine.registry.void(), undefined);
    };
    return new Value(fnType, callable);
  }

  /**
   * Build a super callable for index get/set when this Extension locally
   * overrides the base type's GetSet capability.
   */
  indexSuperFor(
    self: Value,
    direction: 'get' | 'set',
    _scope: Scope,
    engine: Engine,
  ): Value | undefined {
    const localGs = this.local.get;
    if (!localGs) return undefined;
    const baseGs = this.base.get();
    if (!baseGs) return undefined;
    const selfAsBase = new Value(this.base, self.raw);

    if (direction === 'get') {
      if (!localGs.get || !baseGs.get) return undefined;
      const fnType = engine.registry.fn({
        args: engine.registry.obj({ key: { type: baseGs.key } }),
        returns: baseGs.value,
      });
      const callable = async (args: Value): Promise<Value> => {
        const keyVal = (args.raw as Record<string, Value>).key;
        const child = engine.createRootScope();
        child.vars.set('this', selfAsBase);
        child.vars.set('key', keyVal);
        return engine.evaluate(baseGs.get!, child);
      };
      return new Value(fnType, callable);
    }

    // direction === 'set'
    if (!localGs.set || !baseGs.set) return undefined;
    const fnType = engine.registry.fn({
      args: engine.registry.obj({ key: { type: baseGs.key }, value: { type: baseGs.value } }),
      returns: engine.registry.void(),
    });
    const callable = async (args: Value): Promise<Value> => {
      const raw = args.raw as Record<string, Value>;
      const child = engine.createRootScope();
      child.vars.set('this', selfAsBase);
      child.vars.set('key', raw.key!);
      child.vars.set('value', raw.value!);
      await engine.evaluate(baseGs.set!, child);
      return val(engine.registry.void(), undefined);
    };
    return new Value(fnType, callable);
  }
}
