import type { Registry } from '../registry';
import type { CodeOptions } from '../node';
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
 *
 * Always emits a multi-line braced form so all branches read uniformly
 * (no mixing of `} else { x; }` single-liners with multi-line if-bodies).
 * Special cases:
 *   - `flow` (return / break / continue / throw / exit) renders bare
 *     plus `;` — `else return x;` is more readable than wrapping in
 *     braces just to terminate.
 *   - sub-`if` / `switch` / `loop` render in their own statement form
 *     (already self-bracing); used by `else if (...)` chains.
 *   - `block` emits its lines bare (BlockExpr no longer self-braces in
 *     statement form), so the wrapper here adds the `{` / `}`.
 *   - everything else: an expression statement wrapped in braces.
 */
export function renderStatementBody(expr: Expr, registry?: Registry, options: CodeOptions = {}): string {
  // Use structural markers instead of instanceof to avoid a circular
  // import on the concrete Expr classes.
  const kind = (expr as { kind: string }).kind;
  if (kind === 'flow') {
    return `${expr.toCode(registry, { ...options, expectsValue: false })};`;
  }
  if (kind === 'if' || kind === 'switch' || kind === 'loop') {
    return expr.toCode(registry, { ...options, expectsValue: false });
  }
  if (kind === 'block') {
    const code = expr.toCode(registry, { ...options, expectsValue: false });
    return code.startsWith('{') ? code : `{\n  ${indentCode(code)}\n}`;
  }
  // Expression statement — wrap in multi-line braces so the rendered
  // code stays uniform across branch sizes.
  return `{\n  ${indentCode(expr.toCode(registry, { ...options, expectsValue: true }))};\n}`;
}
