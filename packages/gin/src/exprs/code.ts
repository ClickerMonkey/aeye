import type { Registry } from '../registry';
import { Expr, type ChildBoundary } from '../expr';
import { FlowExpr } from './flow';

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

/**
 * Render an Expr as a statement-body for an if/else/for/switch branch.
 * Flow statements render bare with a trailing `;`. Blocks render as
 * already-braced statement sequences. Everything else is wrapped in
 * `{ ...; }` so the containing control structure reads cleanly.
 */
export function renderStatementBody(expr: Expr, registry?: Registry): string {
  // Import lazily via require-esque pattern would create cycles; use
  // structural markers instead of instanceof here to avoid the import.
  // FlowExpr: render bare + `;`. BlockExpr: already braces itself in
  // statement mode, reuse as-is.
  const kind = (expr as { kind: string }).kind;
  if (kind === 'flow') {
    return `${expr.toCode(registry, { expectsValue: false })};`;
  }
  if (kind === 'block') {
    const code = expr.toCode(registry, { expectsValue: false });
    return code.startsWith('{') ? code : `{\n  ${indentCode(code)}\n}`;
  }
  if (kind === 'if' || kind === 'switch' || kind === 'loop') {
    return expr.toCode(registry, { expectsValue: false });
  }
  // Expression statement — wrap in braces + `;`.
  return `{ ${expr.toCode(registry, { expectsValue: true })}; }`;
}
