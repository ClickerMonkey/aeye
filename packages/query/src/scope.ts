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
import type { ResolvedType } from './resolved-type';
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
