import type { PathStepDef, TypeDef } from '../schema';
import type { Registry } from '../registry';
import { Value } from '../value';
import {
  optionsCode,
  type Call,
  type CompatOptions,
  type GetSet,
  type Init,
  type NewSlotVisitor,
  type Prop,
  type PropSpec,
  type Rnd,
  Type,
} from '../type';
import type { Engine } from '../engine';
import type { Scope } from '../scope';
import type { EncodeOptions } from '../json-type';
import type { TypeScope } from '../type-scope';
import { z } from 'zod';
import type { CodeOptions, SchemaOptions, ValueSchemaOptions } from '../node';


export interface AliasOptions {
  name: string;
  /**
   * Use-site OPTIONS narrowing the named type (`PlayerText{maxLength=40}`).
   * Present only on a reference the registry could not apply eagerly — see
   * {@link AliasType} "Use-site arguments".
   */
  options?: Record<string, unknown>;
}

/**
 * AliasType — a bare-name reference. Covers two roles via a single
 * runtime class: a lazy reference to a registered named type, and an
 * unbound type-parameter placeholder. Whichever role applies is
 * scope-driven, never structural.
 *
 *   JSON shape:  `{name: 'X'}` (bare — no peers like `options`,
 *   `generic`, `props`, etc.; those would route to a class instead).
 *
 *   Resolution:  `this.resolve(extra?)` walks an optional caller-
 *   supplied `extra` scope first, then falls back to `this.scope`. The
 *   caller passes `extra` to override the captured scope at access
 *   time — this is how call-site generic bindings (e.g. `<R: num>` on
 *   a path step) reach the AliasTypes inside a fn's signature without
 *   rebuilding the type tree. Every value/access method takes an
 *   optional `scope` argument that propagates through children.
 *   - Hit on `extra` → caller's local layer (call-site bindings).
 *   - Hit on `this.scope` (LocalScope chain → Registry) → captured
 *     layer (generic placeholder bound by the enclosing fn, alias
 *     declared in `CallDef.types`, registered named type, built-in
 *     class instance).
 *   - Miss → AliasType behaves as an unbound placeholder (compatible
 *     with everything, validates anything, no props).
 *
 *   Use-site arguments: a reference may also carry generic ARGUMENTS
 *   (`Node<T>`, kept in `this.generic`) and narrowing OPTIONS
 *   (`PlayerText{maxLength=40}`, kept in `options.options`). The registry
 *   applies those eagerly when the name is already registered; it builds an
 *   AliasType carrying them when the name is bound in a LocalScope (a scope
 *   overlay or a generic placeholder), or not bound yet at all (a self or
 *   forward reference — `next?: Node<T>` inside `Node<T>`, or
 *   `When<A>` ↔ `Condition<A>`). On resolve the target is specialized
 *   and narrowed via `Registry.applyUse`, once per target.
 */
export class AliasType extends Type<any, AliasOptions> {
  static readonly NAME = 'alias';
  readonly name = AliasType.NAME;

  constructor(scope: TypeScope, options: AliasOptions, generic: Record<string, Type> = {}) {
    super(scope, options, generic);
  }

  /** True when this reference carries use-site arguments or options. */
  get hasUse(): boolean {
    return Object.keys(this.generic).length > 0 || this.options.options !== undefined;
  }

  /** Target → its specialized / narrowed form, so each target builds once. */
  private applied?: WeakMap<Type, Type>;

  static from(json: TypeDef, scope: TypeScope): AliasType {
    return new AliasType(scope, { name: json.name });
  }

  static toSchema(_opts: SchemaOptions): z.ZodTypeAny {
    // AliasType isn't a normal Type-union branch — its JSON shape
    // `{name: '<any>'}` collides with every named class. Schema
    // consumers (LLM type union) don't surface AliasType directly;
    // bare names route through the registered class / named-type
    // branches at parse time. This stub exists for completeness.
    return z.object({ name: z.string() }).passthrough();
  }

  static toNewSchema(_opts: SchemaOptions): z.ZodTypeAny {
    return z.any();
  }

  /** Resolve via `extra` (caller-supplied call-site scope) first, then
   *  the captured `this.scope`. Returns undefined when unresolved (so
   *  callers can fall back to placeholder behavior). */
  private resolve(extra?: TypeScope): Type | undefined {
    const t = (extra ? extra.lookup(this.options.name) : undefined)
      ?? this.scope.lookup(this.options.name);
    if (!t || !this.hasUse) return t;
    this.applied ??= new WeakMap();
    let use = this.applied.get(t);
    if (!use) {
      use = this.registry.applyUse(t, this.generic, this.options.options);
      this.applied.set(t, use);
    }
    return use;
  }

  // ─── delegating ops ─────────────────────────────────────────────────────
  // When resolved, every value-side op delegates to the target — and
  // forwards `scope` so AliasTypes nested inside the resolved target
  // also see the call-site bindings.
  // When unresolved, behave as a permissive placeholder:
  // valid/compatible accept anything, props is empty, etc.

  valid(raw: unknown, scope?: TypeScope): boolean {
    const t = this.resolve(scope);
    return t ? t.valid(raw, scope) : true;
  }

  parse(json: unknown, scope?: TypeScope): Value<any> {
    const t = this.resolve(scope);
    if (!t) return new Value(this, json);
    const v = t.parse(json, scope);
    return new Value(this, v.raw);
  }

  encode(raw: any, scope?: TypeScope): any {
    const t = this.resolve(scope);
    return t ? t.encode(raw, scope) : raw;
  }

  /** The resolved target's value form. An UNRESOLVED alias answers false:
   *  it knows nothing about the value form, and claiming an ExprDef is data
   *  would silently readmit the smuggling the refusal exists to stop. */
  parsesExprValue(scope?: TypeScope): boolean {
    return this.resolve(scope)?.parsesExprValue(scope) ?? false;
  }

  /** The resolved target does the walk. Unresolved, the alias knows nothing
   *  about the shape and hands the raw back — as `encode` already does. */
  encodeAs(raw: any, opts: EncodeOptions, scope?: TypeScope): unknown {
    const t = this.resolve(scope);
    return t ? t.encodeAs(raw, opts, scope) : raw;
  }

  create(): any {
    const t = this.resolve();
    return t ? t.create() : null;
  }

  random(rnd: Rnd): any {
    const t = this.resolve();
    return t ? t.random(rnd) : null;
  }

  compatibleType(other: Type, opts?: CompatOptions, scope?: TypeScope): boolean {
    const t = this.resolve(scope);
    return t ? t.compatible(other, opts, scope) : true;
  }

  flexible(): boolean { return true; }

  /** Unbound aliases are universal placeholders; resolved aliases
   *  inherit the target's classification (most concrete types are not
   *  universal, so this defaults to false once resolved). */
  isUniversal(): boolean {
    const t = this.resolve();
    return t ? t.isUniversal() : true;
  }

  or(other: Type<any>): Type<any> {
    const t = this.resolve();
    return t ? t.or(other) : this;
  }

  /** Collapse to the resolved target — used by callers that prefer a
   *  concrete type over a lazy alias when both exist. */
  simplify(scope?: TypeScope): Type {
    return this.resolve(scope) ?? this;
  }

  narrow(local: Partial<AliasOptions>): AliasOptions {
    return { ...this.options, name: local.name ?? this.options.name };
  }

  props(scope?: TypeScope): Record<string, Prop | PropSpec> {
    const t = this.resolve(scope);
    return t ? t.props(scope) : super.props(scope);
  }

  get(scope?: TypeScope): GetSet | undefined {
    return this.resolve(scope)?.get(scope);
  }

  call(scope?: TypeScope): Call | undefined {
    return this.resolve(scope)?.call(scope);
  }

  init(scope?: TypeScope): Init | undefined {
    return this.resolve(scope)?.init(scope);
  }

  follow(step: PathStepDef, scope?: TypeScope): Type | undefined {
    return this.resolve(scope)?.follow(step, scope);
  }

  /** A `new` payload against a bound alias is a payload of the TARGET, so
   *  the slot walk is the target's. Unresolved, the alias knows nothing
   *  about the payload's shape and leaves it opaque. */
  forEachNewSlot(value: unknown, visit: NewSlotVisitor): boolean {
    return this.resolve()?.forEachNewSlot(value, visit) ?? false;
  }

  async newFill(value: unknown, engine: Engine, scope: Scope): Promise<unknown> {
    const t = this.resolve();
    return t ? t.newFill(value, engine, scope) : super.newFill(value, engine, scope);
  }

  /** Bare-name JSON shape. Unconditional — `{name: this.options.name}`,
   *  no `options` wrapper. Round-trip relies on the parse-side scope to
   *  rebuild the AliasType. */
  toJSON(): TypeDef {
    if (!this.hasUse) return { name: this.options.name };
    const generic = Object.entries(this.generic);
    return {
      name: this.options.name,
      ...(generic.length > 0 ? { generic: Object.fromEntries(generic.map(([k, t]) => [k, t.toJSON()])) } : {}),
      ...(this.options.options !== undefined ? { options: { ...this.options.options } } : {}),
    } as TypeDef;
  }

  clone(): AliasType {
    return new AliasType(this.scope, { ...this.options }, { ...this.generic });
  }

  toCode(_registry?: Registry, options?: CodeOptions): string {
    return this.docsPrefix(options) + this.options.name
      + Type.renderGenericArgs(this.generic, options)
      + optionsCode(this.options.options);
  }

  toValueSchema(opts?: ValueSchemaOptions): z.ZodTypeAny {
    // `opts.scope` is the call-site layer, consulted before the captured one
    // exactly as in every other value-side op. Without it a name the
    // schema-building registry does not hold falls to `z.any()` — a gate that
    // accepts everything, with no parameter to fix it (see `ValueSchemaOptions.scope`).
    // Lazy so recursive named types (Node → list<Node>) don't blow the stack.
    return this.describeType(z.lazy(() => {
      const t = this.resolve(opts?.scope);
      return t ? t.toValueSchema(opts) : z.any();
    }), opts);
  }

  toNewSchema(opts: SchemaOptions): z.ZodTypeAny {
    return this.describeType(z.lazy(() => {
      const t = this.resolve(opts.scope);
      return t ? t.toNewSchema(opts) : z.any();
    }), opts, 'NewValue_');
  }

  /** An alias IS a name — instance schema is just `{name: <target>}`.
   *  Lazy so self-referential named types (Node → list<Node>) don't
   *  infinite-recurse. */
  toInstanceSchema(): z.ZodTypeAny {
    return z.lazy(() => {
      const t = this.resolve();
      return t ? t.toInstanceSchema() : z.object({ name: z.literal(this.options.name) });
    });
  }
}
