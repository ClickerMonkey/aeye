import type { Registry } from './registry';
import type { TypeDef } from './schema';
import { Value, val } from './value';
import {
  Call,
  type CompatOptions,
  GetSet,
  Init,
  Prop,
  type PropSpec,
  type Rnd,
  Type,
} from './type';
import {
  encodeCall,
  encodeGetSet,
  encodeInit,
  encodeProps,
} from './spec';
import type { Scope } from './scope';
import type { Engine } from './engine';
import type { JSONOf, RuntimeOf } from './json-type';
import { z } from 'zod';
import type { SchemaOptions } from './node';
import type { Expr } from './expr';

/**
 * What an Extension adds on top of its base. All fields except `name` are
 * optional — an Extension can add props alone, or narrow options alone, etc.
 *
 * `generic` declares the Extension's OWN type parameters (independent of
 * any generics the base already has). Each key is the parameter name; the
 * value is the current binding (use `registry.any()` as a default, or a
 * concrete Type for a bound instance). Placeholders elsewhere in the
 * local spec use `registry.generic('T')` — those get substituted by
 * `.bind({T: …})` via the standard substitute walk.
 *
 *   registry.extend('object', {
 *     name: 'Box',
 *     generic: { T: registry.any() },
 *     props: { value: { type: registry.generic('T') } },
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
function normalizeLocal<T, O>(local: ExtensionLocal<T, O>): ExtensionLocal<T, O> {
  const next: ExtensionLocal<T, O> = { ...local };
  if (local.props) {
    const p: Record<string, Prop> = {};
    for (const [k, v] of Object.entries(local.props)) {
      p[k] = Prop.from(v);
    }
    next.props = p;
  }
  if (local.get && !(local.get instanceof GetSet)) {
    next.get = new GetSet(local.get as ConstructorParameters<typeof GetSet>[0]);
  }
  if (local.call && !(local.call instanceof Call)) {
    next.call = new Call(local.call as ConstructorParameters<typeof Call>[0]);
  }
  if (local.init && !(local.init instanceof Init)) {
    next.init = new Init(local.init as ConstructorParameters<typeof Init>[0]);
  }
  return next;
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

  constructor(registry: Registry, original: Type<T>, local: ExtensionLocal<T, O>) {
    const narrowedOptions = local.options
      ? original.narrow(local.options)
      : (original.options as O);

    const effectiveBase = local.options
      ? (registry.parse({ ...original.toJSON(), options: narrowedOptions as any }) as Type<T>)
      : original;

    // Thread local generic declarations up to the base Type so `this.generic`
    // reflects the Extension's own parameters. Binding via `.bind(bindings)`
    // walks through substituteChildren, which rebuilds the Extension with
    // substituted placeholders.
    super(registry, narrowedOptions, local.generic ?? {});
    this.original = original;
    this.base = effectiveBase;
    this.local = normalizeLocal(local);
    this.name = local.name;
    this.docs = local.docs;
  }

  // ─── VALUE OPERATIONS (delegate to effective base) ─────────────────────

  valid(raw: unknown): raw is RuntimeOf<T> {
    return this.base.valid(raw);
  }

  parse(json: unknown): Value<T> {
    const v = this.base.parse(json);
    // Re-wrap so Value.type is this Extension, not the base.
    return new Value(this, v.raw);
  }

  encode(raw: RuntimeOf<T>): JSONOf<T> {
    return this.base.encode(raw);
  }

  create(): RuntimeOf<T> {
    return this.base.create();
  }

  random(rnd: Rnd): RuntimeOf<T> {
    return this.base.random(rnd);
  }

  // ─── TYPE RELATIONS ────────────────────────────────────────────────────

  compatible(other: Type, opts?: CompatOptions): boolean {
    if (opts?.exact) {
      // Exact requires same Extension name.
      if (other instanceof Extension && other.name === this.name) {
        return this.base.compatible(other.base, opts);
      }
      return false;
    }
    // Covariant: compatible with base (looser) and with other Extensions
    // sharing a compatible base.
    if (other instanceof Extension) {
      return this.base.compatible(other.base, opts);
    }
    return this.base.compatible(other, opts);
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

  props(): Record<string, Prop | PropSpec> {
    return { ...this.base.props(), ...(this.local.props ?? {}) };
  }

  get(): GetSet | undefined {
    return this.local.get ?? this.base.get();
  }

  call(): Call | undefined {
    return this.local.call ?? this.base.call();
  }

  init(): Init | undefined {
    return this.local.init ?? this.base.init();
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
      props: this.local.props ? encodeProps(this.local.props) : undefined,
      get: this.local.get ? encodeGetSet(this.local.get) : undefined,
      call: this.local.call ? encodeCall(this.local.call) : undefined,
      init: this.local.init ? encodeInit(this.local.init) : undefined,
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
    });
  }

  toCode(): string { return this.docsPrefix() + this.name; }

  /** Renders `type Email extends text{pattern="..."}` headers in
   *  `toCodeDefinition`. Uses `base` (narrowed) rather than `original`
   *  so the constraints the Extension sits atop are visible. */
  protected extendsClause(): string {
    return ` extends ${this.base.toCode()}`;
  }

  // Definition hooks — an Extension's rendered body shows only the
  // additions it declares on top of its base. The base's surface lives
  // under the `extends` clause, not duplicated inside the block.
  protected definitionInit():  Init    | undefined { return this.local.init; }
  protected definitionCall():  Call    | undefined { return this.local.call; }
  protected definitionGet():   GetSet  | undefined { return this.local.get; }
  protected definitionProps(): Record<string, Prop | PropSpec> {
    return this.local.props ?? {};
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

  toValueSchema(opts?: SchemaOptions): z.ZodTypeAny {
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

  private mergeLocalPropsInto(
    schema: z.ZodTypeAny,
    opts: SchemaOptions | undefined,
    slotFor: (prop: Prop) => z.ZodTypeAny,
  ): z.ZodTypeAny {
    const props = this.local.props;
    if (!props || !(schema instanceof z.ZodObject)) return schema;
    const mode = opts?.includeDocs ?? 'none';
    const extra: Record<string, z.ZodTypeAny> = {};
    for (const [name, raw] of Object.entries(props)) {
      const p = raw instanceof Prop ? raw : Prop.from(raw);
      if (!p.type) continue;
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
      const fnType = engine.registry.fn(engine.registry.obj({}), baseProp.type);
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
      const fnType = engine.registry.fn(
        engine.registry.obj({ value: { type: baseProp.type } }),
        engine.registry.void(),
      );
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
    const fnType = engine.registry.fn(
      engine.registry.obj({
        args: { type: baseCall.args },
        value: { type: baseCall.returns ?? engine.registry.any() },
      }),
      engine.registry.void(),
    );
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
      const fnType = engine.registry.fn(
        engine.registry.obj({ key: { type: baseGs.key } }),
        baseGs.value,
      );
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
    const fnType = engine.registry.fn(
      engine.registry.obj({ key: { type: baseGs.key }, value: { type: baseGs.value } }),
      engine.registry.void(),
    );
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
