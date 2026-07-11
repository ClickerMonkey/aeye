/**
 * QueryScope — source-name → ResolvedType bindings with a parent chain,
 * plus a shared `ParamSet` carried on the root.
 *
 * Mirrors gin's `Scope` (lexical bindings + parent chain) but binds query
 * SOURCES (type aliases / CTE names / derived-source aliases) to their
 * `ResolvedType` rather than runtime values. A `field-ref` like
 * `{ source: 'u', field: 'name' }` resolves by `lookup('u')` to find the
 * type the field lives on.
 *
 * The `ParamSet` is created once on the root scope and threaded — by
 * reference — into every child, so a `param` observed inside a deeply nested
 * sub-expression accumulates into the same set the top-level walk later asks
 * for problems / JSON.
 */
import type { ResolvedType, TypeResolved } from './resolved-type';
import type { Expr } from './expr';
import { ParamSet } from './param';

/** A lexical resolution scope: bound sources + a shared {@link ParamSet}, chained to an optional parent. */
export class QueryScope {
  /** The enclosing (parent) scope, or `null` at the root of the chain. */
  readonly parent: QueryScope | null;
  /** Shared across the whole scope chain (created on the root). */
  readonly params: ParamSet;
  /** source name → its resolved type, for THIS level only. */
  private readonly bindings = new Map<string, ResolvedType>();
  /**
   * SELECT output field name → its (parsed) projection `Expr`, bound at THIS
   * level ONLY (never inherited up the parent chain) when a SELECT resolves its
   * `groupBy` / `orderBy` / `having` clauses. An `output` reference reads its
   * delegate target from here. Local-only binding is deliberate: a nested
   * subquery's own scope must NOT see the enclosing SELECT's outputs, and a
   * WHERE / JOIN-ON scope (which never binds outputs) makes an `output`
   * reference there fail validation.
   */
  private outputs?: ReadonlyMap<string, Expr>;

  /**
   * Create a scope. A child reuses its `parent`'s `ParamSet` (or the explicitly
   * supplied one); only a true root with neither creates a fresh set.
   */
  constructor(parent: QueryScope | null = null, params?: ParamSet) {
    this.parent = parent;
    // Reuse the parent's ParamSet (or the explicitly supplied one); only a
    // true root with neither creates a fresh set.
    this.params = params ?? parent?.params ?? new ParamSet();
  }

  /** Bind `source` to a resolved type at this scope level. Chainable. */
  bind(source: string, rt: ResolvedType): this {
    this.bindings.set(source, rt);
    return this;
  }

  /** Look up a source by name, walking up the parent chain. */
  lookup(source: string): ResolvedType | undefined {
    const local = this.bindings.get(source);
    if (local !== undefined) return local;
    return this.parent?.lookup(source);
  }

  /** Whether `source` is bound anywhere in the chain. */
  has(source: string): boolean {
    if (this.bindings.has(source)) return true;
    return this.parent?.has(source) ?? false;
  }

  /** All source names bound at this level (not including ancestors). */
  localSources(): string[] {
    return Array.from(this.bindings.keys());
  }

  /**
   * Every source name bound ANYWHERE in this scope chain (this level plus every
   * ancestor), each reported once, nearest binding first. Used to power the
   * "did you mean `<source>`?" suggestion on an unknown-source diagnostic — it
   * enumerates the sources an author could have meant. (Contrast
   * {@link localSources}, which is this level only.)
   */
  sources(): string[] {
    const seen = new Set<string>();
    let scope: QueryScope | null = this;
    while (scope) {
      for (const name of scope.bindings.keys()) seen.add(name);
      scope = scope.parent;
    }
    return Array.from(seen);
  }

  /**
   * Every BOUND source (across the whole chain) whose resolved binding is the
   * Type named `typeName` — i.e. the sources under which that Type is currently
   * in scope. A child binding SHADOWS a same-named ancestor binding (the first
   * one seen walking up wins), so a source is reported at most once. Drives the
   * semantic pairing `{ type, field }` query's resolution to a single bound
   * source (empty ⇒ unbound; more than one ⇒ ambiguous).
   */
  sourcesForType(typeName: string): TypeResolved[] {
    const out: TypeResolved[] = [];
    const seen = new Set<string>();
    let scope: QueryScope | null = this;
    while (scope) {
      for (const [name, rt] of scope.bindings) {
        if (seen.has(name)) continue;
        seen.add(name);
        if (rt.kind === 'type' && rt.type.name === typeName) out.push(rt);
      }
      scope = scope.parent;
    }
    return out;
  }

  /**
   * Bind the enclosing SELECT's output fields (name → projection `Expr`) at
   * this scope level, so an `output` reference in a `groupBy` / `orderBy` /
   * `having` clause can delegate to its target expression. Chainable.
   */
  bindOutputs(outputs: ReadonlyMap<string, Expr>): this {
    this.outputs = outputs;
    return this;
  }

  /**
   * The SELECT output projection `Expr` named `name`, or `undefined` when no
   * such output is bound here. NOT inherited from ancestors (see `outputs`).
   */
  output(name: string): Expr | undefined {
    return this.outputs?.get(name);
  }

  /** Whether ANY outputs are bound at this level (a SELECT clause scope). */
  hasOutputs(): boolean {
    return this.outputs !== undefined;
  }

  /** The bound output field names at this level (empty when none are bound). */
  outputNames(): string[] {
    return this.outputs ? Array.from(this.outputs.keys()) : [];
  }

  /** Create a child scope sharing this scope's ParamSet. */
  child(): QueryScope {
    return new QueryScope(this, this.params);
  }
}
