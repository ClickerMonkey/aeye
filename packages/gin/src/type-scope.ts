import type { Registry } from './registry';
import type { Type } from './type';

/**
 * Type-name resolution scope. A tree of name → Type bindings rooted at
 * the Registry. Used by `AliasType` to resolve `{name: 'X'}` lazily,
 * and by `Registry.parse` to dispatch bare-name TypeDefs to AliasType
 * when X is bound in a local scope.
 *
 * - The Registry is the root scope; it implements `Scope` directly.
 *   Its `lookup` walks `namedTypes` and built-in `classes`.
 * - `LocalScope` wraps a parent scope with an overlay map. Used by
 *   `decodeCall` to scope `CallDef.types` aliases, by FnType to scope
 *   declared generics, etc.
 *
 * Distinct from:
 *  - `Scope` in `scope.ts` (runtime variable bindings — Value scope).
 *  - `TypeScope` in `analysis.ts` (`Map<string, Type>` for static
 *    variable-type analysis during validate / typeOf).
 */
export interface Scope {
  /** Look up a type by name. Returns the bound Type if present in this
   *  scope or any parent scope; undefined if not found anywhere. */
  lookup(name: string): Type | undefined;

  /** The root Registry — every Scope can resolve to it via the parent
   *  chain. Used by Type subclasses that need to construct child types
   *  (e.g. `this.scope.registry.num()`) without caring about whether
   *  they're inside a LocalScope. */
  readonly registry: Registry;

  /** Parent scope, or undefined for the root (Registry). */
  readonly parent?: Scope;
}

/**
 * A scope layer holding local name → Type bindings. Falls through to
 * `parent.lookup` on miss. Construction order matters for sequential
 * builds (later aliases referencing earlier ones); the caller is
 * responsible for adding bindings in order if dependencies exist.
 */
export class LocalScope implements Scope {
  readonly parent: Scope;
  readonly registry: Registry;
  private readonly local: Record<string, Type>;

  constructor(parent: Scope, local: Record<string, Type> = {}) {
    this.parent = parent;
    this.registry = parent.registry;
    this.local = local;
  }

  lookup(name: string): Type | undefined {
    return this.local[name] ?? this.parent.lookup(name);
  }

  /** Add a binding to this scope's local map. Used by sequential
   *  alias / generic build steps where each entry may reference
   *  earlier ones. */
  bind(name: string, type: Type): void {
    this.local[name] = type;
  }

  /** Return the names bound DIRECTLY in this scope (excluding parent).
   *  Used for diagnostics / rendering. */
  ownNames(): string[] {
    return Object.keys(this.local);
  }
}
