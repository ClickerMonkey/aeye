import type { Engine } from './engine';
import type { Type } from './type';
import type { ExprDef } from './schema';
import { Problems } from './problem';
import { Expr, type ValidateContext } from './expr';
import { RESERVED_NAMES } from './scope';

/**
 * Static type scope: name → runtime Type. Used by typeOf / validate to
 * reason about expression trees without executing them.
 */
export type TypeScope = Map<string, Type>;

/**
 * Infer the static result Type of an ExprDef (or parsed Expr) against a
 * type scope. Falls back to `any` on unknown parts — never throws.
 */
export function typeOf(engine: Engine, expr: ExprDef | Expr, scope: TypeScope): Type {
  const e = expr instanceof Expr ? expr : parseExprSafe(engine, expr);
  if (!e) return engine.registry.any();
  return e.typeOf(engine, scope);
}

function parseExprSafe(engine: Engine, expr: ExprDef): Expr | undefined {
  try { return engine.registry.parseExpr(expr); }
  catch { return undefined; }
}

/** Top-level: walk an expression tree collecting Problems. Never throws. */
export function validate(engine: Engine, expr: ExprDef | Expr, scope: TypeScope): Problems {
  const p = new Problems();
  walkValidate(engine, expr, scope, p, { inLoop: false, inLambda: false });
  return p;
}

/** Recursive form used by Expr classes to validate child exprs. */
export function walkValidate(
  engine: Engine,
  expr: ExprDef | Expr,
  scope: TypeScope,
  p: Problems,
  ctx: ValidateContext,
): Type {
  let e: Expr;
  if (expr instanceof Expr) {
    e = expr;
  } else {
    try {
      e = engine.registry.parseExpr(expr);
    } catch {
      p.warn('expr.unknown-kind', `unknown expr kind '${(expr as ExprDef).kind}'`);
      return engine.registry.any();
    }
  }
  return e.validateWalk(engine, scope, p, ctx);
}

// Re-export ValidateContext for convenience.
export type { ValidateContext } from './expr';

/**
 * Validate a user-supplied binding name against the rules a `define`
 * (or any other user-named scope binding) must follow:
 *
 * 1. Must not be a reserved name — gin's runtime injects those at
 *    well-known contexts (`args`, `recurse`, etc.); a user binding
 *    would be silently shadowed at runtime.
 * 2. Must not already exist in `scope` — including names from outer
 *    scopes / globals. Disallowing this prevents accidental shadowing
 *    that produces confusing-at-runtime behavior (e.g. `define vars =
 *    ...` shadowing the persistent vars global).
 *
 * Pushes errors into `p`; never throws. Caller is expected to have
 * already entered the relevant `at(...)` path.
 */
export function checkBindingName(
  name: string,
  scope: TypeScope,
  p: Problems,
): void {
  if (RESERVED_NAMES.has(name)) {
    p.error(
      'binding.reserved',
      `'${name}' is a reserved name (gin binds it automatically in fn/loop/path contexts) — pick a different name`,
    );
    return;
  }
  if (scope.has(name)) {
    p.error(
      'binding.shadow',
      `'${name}' is already in scope — pick a different name to avoid shadowing`,
    );
  }
}
