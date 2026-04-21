import type { Engine } from './engine';
import type { Scope } from './scope';
import type { Value } from './value';
import type { Type } from './type';
import type { Registry } from './registry';
import type { ExprDef } from './schema';
import type { TypeScope } from './analysis';
import { Problems } from './problem';
import type { Node, CodeOptions, SchemaOptions } from './node';
import type { z } from 'zod';

/**
 * Context flags carried through validate walks so handlers can report
 * out-of-place flow controls (break/continue outside a loop, return
 * outside a lambda).
 */
export interface ValidateContext {
  inLoop: boolean;
  inLambda: boolean;
}

/**
 * Boundary passed with a child during forEachChild traversal.
 *   'inherit' — the child shares the parent's control-flow context
 *   'loop'    — the child is inside a fresh loop (catches break/continue)
 *   'lambda'  — the child is inside a fresh lambda (catches return)
 */
export type ChildBoundary = 'inherit' | 'loop' | 'lambda';

export type ChildVisitor = (child: Expr, boundary: ChildBoundary) => void;

/**
 * The abstract runtime Expr class — the execution-side counterpart of
 * ExprDef (the JSON shape). Every concrete expression (NewExpr, GetExpr,
 * IfExpr, …) extends this.
 *
 * Mirror of Type: the Registry parses `ExprDef` JSON into `Expr`
 * instances via each class's static `from(json, registry)`. Once parsed,
 * evaluation/analysis/code-emission are pure virtual method calls — no
 * central switch on `kind`.
 *
 * To add a new expression kind, create a class extending Expr with a
 * `static KIND = 'your.kind'` and `static from(json, registry)` method,
 * and register via `registry.defineExpr(YourExpr)`.
 */
export abstract class Expr implements Node {
  /** Identifier of this expression kind (e.g. 'new', 'get'). */
  abstract readonly kind: string;

  /**
   * Optional source comment attached to this expression. Rendered by
   * toCode; passed through encode/clone. Not evaluated at runtime.
   */
  comment?: string;

  /**
   * Copy `comment` onto this expression and return `this` (chaining).
   * Concrete `from(json, registry)` factories call this last to wire the
   * ExprDef.comment into the parsed instance.
   */
  withComment(comment: string | undefined): this {
    if (comment) this.comment = comment;
    return this;
  }

  /** Rendered comment prefix for toCode. */
  protected commentPrefix(options: CodeOptions = {}): string {
    if (!this.comment) return '';
    return options.expectsValue === false
      ? `// ${this.comment}\n`
      : `/* ${this.comment} */ `;
  }

  /** Add `comment` onto an encoded ExprDef when present. */
  protected withCommentOn<T extends ExprDef>(def: T): T {
    return this.comment ? { ...def, comment: this.comment } : def;
  }

  /** Produce a Value by running this expression. */
  abstract evaluate(engine: Engine, scope: Scope): Promise<Value>;

  /** Infer the static return Type against a type scope. */
  abstract typeOf(engine: Engine, scope: TypeScope): Type;

  /**
   * Recursive validation walk — accumulates Problems into `p` and returns
   * the inferred Type. Called by child exprs during validate walks.
   * Use `validate(engine)` for the clean top-level entry.
   */
  abstract validateWalk(engine: Engine, scope: TypeScope, p: Problems, ctx: ValidateContext): Type;

  /** Top-level entry: walk collecting Problems. Mirrors Type.validate. */
  validate(engine: Engine, scope?: TypeScope): Problems {
    const p = new Problems();
    const s = scope ?? engine.globalTypeScope();
    this.validateWalk(engine, s, p, { inLoop: false, inLambda: false });
    return p;
  }

  /** Render as TypeScript-like source text. See CodeOptions.expectsValue. */
  abstract toCode(registry?: Registry, options?: CodeOptions): string;

  /** Serialize back to the JSON ExprDef shape (inverse of static from). */
  abstract toJSON(): ExprDef;

  /** Deep copy this Expr tree. */
  abstract clone(): Expr;

  /**
   * Visit immediate child Exprs. Concrete classes with children override
   * to call `visit(child, boundary)` for each. Default: no children.
   * Used by `findEscapingFlow` and similar structural analyses that need
   * to know when a child crosses a loop or lambda boundary.
   */
  forEachChild(_visit: ChildVisitor): void { /* default: leaf */ }
}

/**
 * Per-kind expression class constructor — registered with the Registry so
 * Registry.parseExpr(ExprDef) can dispatch by kind.
 */
export interface ExprClass {
  readonly KIND: string;
  from(json: ExprDef, registry: Registry): Expr;
  /** JSON-shape Zod schema for this Expr's ExprDef. */
  toSchema(opts: SchemaOptions): z.ZodTypeAny;
}
