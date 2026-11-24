/**
 * Named types and the chain:
 *
 *   a.define({ ...named types, may use a.ref() to names defined later... })
 *    .define({ ...more... })                 // any number of steps
 *    .declare<{ Name: CodeType }>()          // optional: pin the type of a ref the dynamic step will supply
 *    .dynamic((...args) => ({ ...the refs not defined yet... }), { key })   // optional
 *    .result('Name' | a.object({...}))       // a ref to a named type, or an inline schema
 *
 * Every step is checked at compile time:
 * - `define` may not redefine a name;
 * - `dynamic` must return EVERY ref still missing (used but undefined, or
 *   declared), each typed as declared; it may add new names; it may not
 *   redefine a static one;
 * - `result` fails if any ref (in the defs or the root) is still undefined.
 *
 * The result is a `Bundle<Out, Args>`: a static instance built once at
 * module scope. `Out` is fully resolved (refs swapped for their types,
 * recursion included); `Args` is what the dynamic step needs (`[]` when
 * there is none). `bundle.bind(...args)` supplies the dynamic part at call
 * time and returns a `Bound<Out>`; `bound.render(profile)` gives the model's
 * JSON schema and the codec.
 */
import { RefType, type AnySchema, type Schema, type SchemaOf } from './schema';
import type { AllowRefs, Merge, RefMarker, Resolve, SchemaError } from './types';
import { Compiler, Rendered } from './render';
import { LENIENT, type Profile } from './profile';

export type Defs = { readonly [name: string]: AnySchema };
/** Name → unresolved output of each named type. */
export type EnvOf<D extends Defs> = { [K in keyof D]: D[K]['_out'] };
type DefRefs<D extends Defs> = { [K in keyof D]: D[K]['_refs'] }[keyof D];
/** Refs used by the defs (or declared) but not defined yet. */
export type Missing<D extends Defs, Decl> = Exclude<DefRefs<D> | (keyof Decl & string), keyof D> & string;

/** What the dynamic step must return: every missing ref (typed as declared), no redefinitions, and any new names. */
export type DynamicDefs<D extends Defs, Decl> =
  { readonly [K in Missing<D, Decl>]: K extends keyof Decl ? SchemaOf<AllowRefs<Decl[K]>> : AnySchema }
  & { readonly [K in keyof D]?: never };

type Root<D extends Defs> = AnySchema | (keyof D & string);
type RootOut<R> = R extends string ? RefMarker<R> : R extends AnySchema ? R['_out'] : never;
type RootRefs<R> = R extends string ? R : R extends AnySchema ? R['_refs'] : never;
type Unresolved<D extends Defs, Decl, R> = Exclude<RootRefs<R>, keyof D> | Missing<D, Decl>;
/** Declared refs whose RESOLVED type does not match the declaration. */
type Mismatched<D extends Defs, Decl> = {
  [K in keyof Decl & keyof D]: Resolve<D[K]['_out'], EnvOf<D>> extends Decl[K] ? never : K
}[keyof Decl & keyof D];
type CheckRoot<D extends Defs, Decl, R> =
  [Unresolved<D, Decl, R>] extends [never]
    ? [Mismatched<D, Decl>] extends [never] ? unknown : SchemaError<'declared type does not match', Mismatched<D, Decl>>
    : SchemaError<'unresolved ref', Unresolved<D, Decl, R>>;
type NoRedefine<D extends Defs, D2> = { [K in keyof D & keyof D2]: SchemaError<'already defined', K> };

/** The resolved output of a chain ending at `R`. */
export type ResultOut<D extends Defs, R> = Resolve<RootOut<R>, EnvOf<D>>;

export interface DynamicOptions<A extends unknown[]> {
  /**
   * Cache key for the dynamic part (e.g. a registry's version). Binds with an
   * equal key reuse the same `Bound` — so neither the dynamic function nor
   * the rendering runs again. Without a key every `bind` calls the function
   * (ref-free subtrees still render once per profile, see `render.ts`).
   */
  readonly key?: (...args: A) => unknown;
  /** How many keyed binds to keep (default 4). */
  readonly cacheSize?: number;
}

/** Chain step: named types, possibly with refs still undefined. */
export class Module<D extends Defs = {}, Decl = {}> {
  constructor(readonly defs: Readonly<Record<string, AnySchema>> = {}) {}

  define<const D2 extends Defs>(defs: D2 & NoRedefine<D, D2>): Module<Merge<D, D2>, Decl> {
    for (const k of Object.keys(defs)) if (k in this.defs) throw new Error(`@aeye/schema: "${k}" is already defined.`);
    return new Module({ ...this.defs, ...defs });
  }

  /** Pin the code type of refs the dynamic step will supply. */
  declare<T extends Record<string, unknown>>(): Module<D, Merge<Decl, T>> {
    return this as unknown as Module<D, Merge<Decl, T>>;
  }

  /** Supply the remaining refs from runtime args (a ctx, a registry, a DB engine...). */
  dynamic<A extends unknown[], R extends Defs & DynamicDefs<D, Decl>>(
    fn: (...args: A) => R,
    opts: DynamicOptions<A> = {},
  ): DynamicModule<Merge<D, R>, Decl, A> {
    return new DynamicModule(this.defs, fn as (...args: A) => Defs, opts);
  }

  /** End the chain: a named type, or an inline schema (which may use refs). */
  result<const R extends Root<D>>(root: R & CheckRoot<D, Decl, R>): Bundle<ResultOut<D, R>, []> {
    return new Bundle(this.defs, rootOf(root as AnySchema | string));
  }
}

/** Chain step after `dynamic`: only `result` is left. */
export class DynamicModule<D extends Defs, Decl, A extends unknown[]> {
  constructor(
    readonly defs: Readonly<Record<string, AnySchema>>,
    readonly fn: (...args: A) => Defs,
    readonly opts: DynamicOptions<A>,
  ) {}

  result<const R extends Root<D>>(root: R & CheckRoot<D, Decl, R>): Bundle<ResultOut<D, R>, A> {
    return new Bundle(this.defs, rootOf(root as AnySchema | string), { fn: this.fn, opts: this.opts });
  }
}

function rootOf(root: AnySchema | string): AnySchema {
  return typeof root === 'string' ? new RefType(root) : root;
}

/**
 * Anything Tool/Prompt accept: a ref-free schema or a bundle, whose dynamic
 * part (if any) is supplied by `A` at call time. `bind` is a property (not a
 * method) so `A` is checked contravariantly: a bundle that needs
 * `{ registry }` cannot be given to a tool whose ctx lacks one.
 */
export interface Bindable<Out, A extends unknown[] = []> {
  readonly _out: Out;
  readonly _refs: never;
  readonly bind: (...args: A) => Bound<Out>;
}

/** A finished chain. Build once (module scope); bind per call. */
export class Bundle<Out, A extends unknown[] = []> {
  declare readonly _out: Out;
  declare readonly _refs: never;
  private readonly cache = new Map<unknown, Bound<Out>>();
  private staticBound: Bound<Out> | undefined;

  constructor(
    readonly defs: Readonly<Record<string, AnySchema>>,
    readonly root: AnySchema,
    readonly dyn?: { readonly fn: (...args: A) => Defs; readonly opts: DynamicOptions<A> },
  ) {}

  readonly bind = (...args: A): Bound<Out> => {
    const dyn = this.dyn;
    if (!dyn) return (this.staticBound ??= new Bound(new Map(Object.entries(this.defs)), this.root));
    const key = dyn.opts.key?.(...args);
    if (key !== undefined) {
      const hit = this.cache.get(key);
      if (hit) {
        this.cache.delete(key);
        this.cache.set(key, hit);
        return hit;
      }
    }
    const extra = dyn.fn(...args);
    const env = new Map<string, AnySchema>(Object.entries(this.defs));
    for (const [k, s] of Object.entries(extra)) {
      if (env.has(k)) throw new Error(`@aeye/schema: the dynamic step redefined "${k}".`);
      env.set(k, s);
    }
    const bound = new Bound<Out>(env, this.root);
    if (key !== undefined) {
      this.cache.set(key, bound);
      const max = dyn.opts.cacheSize ?? 4;
      while (this.cache.size > max) this.cache.delete(this.cache.keys().next().value);
    }
    return bound;
  };

  /** Shorthand for `bind(...args).render(profile)`. */
  render(profile: Profile, ...args: A): Rendered<Out> {
    return this.bind(...args).render(profile);
  }
}

/** A bundle with its dynamic part supplied: every ref resolved. */
export class Bound<Out> {
  declare readonly _out: Out;
  private readonly rendered = new Map<string, Rendered<Out>>();

  constructor(readonly env: ReadonlyMap<string, AnySchema>, readonly root: AnySchema) {
    const missing: string[] = [];
    const check = (s: AnySchema) => { for (const n of s.refNames()) if (!env.has(n) && !missing.includes(n)) missing.push(n); };
    check(root);
    for (const s of env.values()) check(s);
    if (missing.length) throw new Error(`@aeye/schema: unresolved ref(s) ${missing.join(', ')}.`);
  }

  /** The model-facing rendering for a profile, memoized on this bound instance. */
  render(profile: Profile): Rendered<Out> {
    let r = this.rendered.get(profile.id);
    if (!r) {
      const c = new Compiler(profile, this.env, () => this.render(LENIENT) as Rendered<unknown>);
      const node = c.compile(this.root);
      c.finish();
      r = new Rendered<Out>(c, node);
      this.rendered.set(profile.id, r);
    }
    return r;
  }
}

const statics = new WeakMap<AnySchema, Bundle<any, []>>();

/** The static bundle of a ref-free schema (one per schema instance). */
export function staticBundle<Out>(s: Schema<Out, never>): Bundle<Out, []> {
  let b = statics.get(s);
  if (!b) statics.set(s, (b = new Bundle<Out, []>({}, s)));
  return b;
}
