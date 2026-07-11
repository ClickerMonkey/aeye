import type { Value } from './value';

/**
 * Names gin's runtime injects into child scopes for specific
 * expression contexts. User-authored bindings (`DefineExpr.vars[].name`,
 * `LoopExpr.keyName`/`valueName` overrides) MUST NOT use these — the
 * engine will rebind them at the relevant context, silently shadowing
 * the user's value and producing very confusing behavior.
 *
 * - `args` — function parameters (Lambda, path call.get/set, NewExpr init).
 * - `recurse` — self-reference in fn bodies.
 * - `this` — receiver in prop/method bodies, NewExpr init, loop.over.
 * - `super` — base impl in prop/method overrides.
 * - `key`, `value` — loop iteration bindings (default names).
 * - `yield` — internal yield callback for loop bodies.
 * - `error` — bound in path catch handlers.
 */
export const RESERVED_NAMES: ReadonlySet<string> = new Set([
  'args', 'recurse', 'this', 'super', 'key', 'value', 'yield', 'error',
]);

/**
 * Scope: lexical variable bindings with parent chain.
 *
 * Root scope contains globals. Each Define/Lambda/Loop creates a child.
 * Reserved names (see `RESERVED_NAMES`) are injected per-context, not
 * by globals.
 */
export class Scope {
  readonly parent: Scope | null;
  readonly vars: Map<string, Value>;

  constructor(parent: Scope | null = null, vars?: Record<string, Value>) {
    this.parent = parent;
    this.vars = new Map(vars ? Object.entries(vars) : []);
  }

  get(name: string): Value | undefined {
    const local = this.vars.get(name);
    if (local !== undefined) return local;
    return this.parent?.get(name);
  }

  set(name: string, value: Value): void {
    // Walk up to find existing binding, or set locally
    if (this.vars.has(name)) {
      this.vars.set(name, value);
      return;
    }
    if (this.parent && this.parent.has(name)) {
      this.parent.set(name, value);
      return;
    }
    // New binding in current scope
    this.vars.set(name, value);
  }

  has(name: string): boolean {
    if (this.vars.has(name)) return true;
    return this.parent?.has(name) ?? false;
  }

  child(vars?: Record<string, Value>): Scope {
    return new Scope(this, vars);
  }

  /**
   * Every variable name visible from this scope — its own bindings plus
   * every ancestor's, de-duplicated (a shadowed outer name appears once).
   * Used for "did you mean?" suggestions on an unknown-variable lookup.
   */
  names(): string[] {
    const seen = new Set<string>();
    for (let s: Scope | null = this; s; s = s.parent) {
      for (const name of s.vars.keys()) seen.add(name);
    }
    return [...seen];
  }
}
