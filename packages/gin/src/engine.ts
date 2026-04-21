import type { Registry } from './registry';
import type { Scope } from './scope';
import { Scope as ScopeClass } from './scope';
import type { Value } from './value';
import { val } from './value';
import type { Type } from './type';
import type { ExprDef } from './schema';
import { Expr } from './expr';
import type { CodeOptions } from './node';

import { ExitSignal } from './flow-control';
import { typeOf as typeOfAnalysis, validate as validateAnalysis, type TypeScope } from './analysis';
import type { Problems } from './problem';

/**
 * Global — a named value available in every root scope. Types are registered
 * via Engine.registerGlobal (or via the registry); the root scope is
 * pre-populated before each run.
 */
export interface Global {
  docs?: string;
  type: Type;
  value: unknown;
}

/**
 * Engine — parses JSON into runtime objects and executes expressions.
 *
 * Stays stateless across runs: each invocation of `run()` builds a fresh
 * root scope (seeded with registered globals plus any per-call extras).
 * Mutations live inside the scope graph, not on the engine or registry.
 */
export class Engine {
  private readonly globals = new Map<string, Global>();

  constructor(readonly registry: Registry) {}

  // ─── globals ─────────────────────────────────────────────────────────────

  registerGlobal(name: string, global: Global): this {
    this.globals.set(name, global);
    return this;
  }

  getGlobal(name: string): Global | undefined {
    return this.globals.get(name);
  }

  getGlobals(): ReadonlyMap<string, Global> {
    return this.globals;
  }

  // ─── execution ───────────────────────────────────────────────────────────

  /** Parse is an identity step for now — JSON ExprDefs are structurally ready. */
  parse(json: unknown): ExprDef {
    if (!json || typeof json !== 'object' || !('kind' in (json as object))) {
      throw new Error(`engine.parse: expected ExprDef with kind, got ${typeof json}`);
    }
    return json as ExprDef;
  }

  /** Build a root scope populated with registered globals plus any extras. */
  createRootScope(extras?: Record<string, Value>): Scope {
    const s = new ScopeClass(null);
    for (const [name, g] of this.globals) {
      s.vars.set(name, val(g.type, g.value));
    }
    if (extras) for (const [name, v] of Object.entries(extras)) s.vars.set(name, v);
    return s;
  }

  /** Top-level entry: build a root scope and evaluate `expr`. */
  async run(expr: ExprDef | Expr, extras?: Record<string, Value>): Promise<Value> {
    const scope = this.createRootScope(extras);
    try {
      return await this.evaluate(expr, scope);
    } catch (sig) {
      if (sig instanceof ExitSignal) {
        return sig.value ?? val(this.registry.void(), undefined);
      }
      throw sig;
    }
  }

  /**
   * Infer the static return type of an expression against a type scope.
   * Returns `any` on unknown parts — never throws.
   */
  typeOf(expr: ExprDef | Expr, scope?: TypeScope): Type {
    const s = scope ?? this.globalTypeScope();
    return typeOfAnalysis(this, expr, s);
  }

  /**
   * Walk an expression tree and collect Problems (unknown vars, unknown
   * props / natives, out-of-place break/return, etc.). Never throws.
   */
  validate(expr: ExprDef | Expr, scope?: TypeScope): Problems {
    const s = scope ?? this.globalTypeScope();
    return validateAnalysis(this, expr, s);
  }

  /**
   * Render an ExprDef (or parsed Expr) as TypeScript-like source text.
   * Thin alias for `registry.toCode(expr, options)`.
   */
  toCode(expr: ExprDef | Expr, options?: CodeOptions): string {
    return this.registry.toCode(expr, options);
  }

  /** A TypeScope seeded with the registered globals' declared types. */
  globalTypeScope(): TypeScope {
    const m = new Map<string, Type>();
    for (const [name, g] of this.globals) m.set(name, g.type);
    return m;
  }

  /** Parse (if needed) then dispatch to the Expr instance's evaluate. */
  async evaluate(expr: ExprDef | Expr, scope: Scope): Promise<Value> {
    const e = expr instanceof Expr ? expr : this.registry.parseExpr(expr);
    return e.evaluate(this, scope);
  }
}

/** Create an Engine pre-wired to a default registry (with all built-ins). */
export function createEngine(registry: Registry): Engine {
  return new Engine(registry);
}
