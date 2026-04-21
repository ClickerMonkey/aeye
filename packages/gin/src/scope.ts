import type { Value } from './value';

/**
 * Scope: lexical variable bindings with parent chain.
 *
 * Root scope contains globals. Each Define/Lambda/Loop creates a child.
 * Reserved names (this, args, result, key, value, yield, super) are
 * injected per-context, not by globals.
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
}
