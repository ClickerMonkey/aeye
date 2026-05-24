import { Expr, type ChildBoundary } from '../expr';
import { FlowExpr } from './flow';
import { Code, plain } from '../code';

/** Indent every line after the first by two spaces (for multi-line bodies). */
export function indentCode(code: string): string {
  return code.replace(/\n/g, '\n  ');
}

/**
 * True iff `expr` contains a flow whose effect would cross the expression's
 * outer boundary — making it impossible to render the surrounding if/switch
 * as a ternary or value-returning IIFE.
 *
 *   - `return`          escapes unless the path crosses a LambdaExpr boundary.
 *   - `break`/`continue` escape unless the path crosses a LoopExpr   boundary.
 *   - `throw` / `exit`  always escape.
 *
 * Traversal uses Expr.forEachChild so each class can declare its boundary
 * semantics polymorphically.
 */
export function findEscapingFlow(expr: Expr, enclosing: ChildBoundary = 'inherit'): FlowExpr | undefined {
  if (expr instanceof FlowExpr) {
    if (expr.action === 'throw' || expr.action === 'exit') return expr;
    if (expr.action === 'return')   return enclosing === 'lambda' ? undefined : expr;
    if (expr.action === 'break' || expr.action === 'continue') {
      return enclosing === 'loop' ? undefined : expr;
    }
    return undefined;
  }
  let found: FlowExpr | undefined;
  expr.forEachChild((child, childBoundary) => {
    if (found) return;
    // A child either inherits the caller's boundary or introduces a new one.
    const nextBoundary: ChildBoundary = childBoundary === 'inherit' ? enclosing : childBoundary;
    const f = findEscapingFlow(child, nextBoundary);
    if (f) found = f;
  });
  return found;
}

// `renderStatementBody` / `renderStatementBodyRich` moved to
// `Expr.renderStatementBody(...)` / `Expr.renderStatementBodyRich(...)`
// as instance methods (see `../expr.ts`).

/** `Code.indent` thin wrapper for callers that already have a Code. */
export function indentCodeRich(c: Code, prefix: string = '  '): Code {
  return c.indent(prefix);
}

// `plain` is exported for callers that need to mix bare strings into a
// `code\`...\`` chain without losing typing — keep it re-exported so
// composite renderers don't need to import from `../code` directly.
export { plain };
