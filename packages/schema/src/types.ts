/**
 * Type-level machinery for `@aeye/schema`.
 *
 * Every schema class carries two phantom types:
 *
 * - `_out`  — the CODE shape the caller gets after decoding. A reference to a
 *   named type that is not known yet (`a.ref('Node')`) appears in `_out` as a
 *   `RefMarker<'Node'>` placeholder.
 * - `_refs` — the union of ref names used anywhere below the schema. The chain
 *   (`define → dynamic → result`) uses it to prove at compile time that every
 *   ref is defined, statically or by the dynamic step.
 *
 * When the chain ends, `Resolve<Out, Env>` swaps every placeholder for the
 * named type's own (resolved) output. Mapped types are evaluated lazily per
 * property, so recursive named types (Node → Node[]) resolve to a finite,
 * cyclic TypeScript type instead of an infinite expansion.
 */

declare const REF: unique symbol;
declare const BRAND: unique symbol;

/** Placeholder for "the output of named type `N`", swapped out by `Resolve`. */
export interface RefMarker<N extends string> {
  readonly [REF]: N;
}

/** Nominal tag added by `.brand<B>()`. */
export interface Brand<B extends string> {
  readonly [BRAND]: { readonly [K in B]: true };
}

type Primitive = string | number | boolean | bigint | symbol | null | undefined;

/**
 * Replace every `RefMarker<N>` in `T` with the resolved output of `Env[N]`.
 * Distributes over unions; leaves primitives (and branded primitives) alone.
 * A marker whose name is not in `Env` resolves to `never` — the chain's
 * checks make that unreachable for anything it returns.
 */
export type Resolve<T, Env> =
  unknown extends T ? T
  : T extends RefMarker<infer N> ? (N extends keyof Env ? Resolve<Env[N], Env> : never)
  : T extends Primitive ? T
  : T extends readonly unknown[] ? ResolveArray<T, Env>
  : { [K in keyof T]: Resolve<T[K], Env> };

type ResolveArray<T extends readonly unknown[], Env> =
  number extends T['length']
    ? (T extends unknown[] ? Resolve<T[number], Env>[] : readonly Resolve<T[number], Env>[])
    : { [K in keyof T]: Resolve<T[K], Env> };

/**
 * `T` where any position may instead be a not-yet-resolved ref. A dynamic
 * step's schema for a declared ref is checked against this (it may use refs,
 * itself included); the exact check after resolution happens at `result`.
 */
export type AllowRefs<T> =
  | RefMarker<string>
  | (unknown extends T ? T
    : T extends Primitive ? T
    : T extends readonly (infer E)[] ? AllowRefs<E>[]
    : { [K in keyof T]: AllowRefs<T[K]> });

/** Same as `Resolve`, but an unknown name becomes `unknown` (used for examples/refinements typed before the chain closes). */
export type Loose<T> =
  unknown extends T ? T
  : T extends RefMarker<string> ? unknown
  : T extends Primitive ? T
  : T extends readonly unknown[] ? Loose<T[number]>[]
  : { [K in keyof T]: Loose<T[K]> };

/** Flatten intersections for readable hovers. */
export type Simplify<T> = { [K in keyof T]: T[K] } & {};

/** Merge two records, right wins (used by `define` chains). */
export type Merge<A, B> = Simplify<Omit<A, keyof B> & B>;

/** A JSON value. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/**
 * A compile-time error carried in a parameter type. The property name is the
 * message and its value names the offending refs, so the TypeScript error
 * reads e.g. `Property '"unresolved ref"' is missing ... { "unresolved ref": "Ghost" }`.
 */
export type SchemaError<Message extends string, Detail> = { readonly [K in Message]: Detail };
