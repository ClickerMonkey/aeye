import type { Engine } from './engine';
import type { Scope } from './scope';
import type { Value } from './value';
import type { Type } from './type';
import type { Registry } from './registry';
import type { ExprDef } from './schema';
import type { Locals } from './analysis';
import { Problems } from './problem';
import type { Node, CodeOptions, SchemaOptions } from './node';
import { Code, code, span } from './code';
import type { z } from 'zod';
import type { TypeScope } from './type-scope';
import type { Effects } from './effects';

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

  /**
   * Whether this Expr's comment should render as a line comment
   * (`// foo\n` on the line above) rather than an inline block
   * (`/* foo *\/ expr`). Defaults to "line in statement context, inline
   * in value context". Multi-line / statement-shaped Exprs (define /
   * if / switch / block / lambda / loop / flow / set) override this to
   * force the line form even when used in value position — a stacked
   * `// note` reads better above a multi-line construct than a stray
   * inline block at its head.
   */
  protected useLineComment(options: CodeOptions = {}): boolean {
    return options.expectsValue === false;
  }

  /** Rendered comment prefix for toCode. */
  protected commentPrefix(options: CodeOptions = {}): string {
    if (!this.comment) return '';
    if (options.includeComments === false) return '';
    return this.useLineComment(options)
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
  abstract typeOf(engine: Engine, scope: Locals): Type;

  /**
   * Recursive validation walk — accumulates Problems into `p` and returns
   * the inferred Type. Called by child exprs during validate walks.
   * Use `validate(engine)` for the clean top-level entry.
   */
  abstract validateWalk(engine: Engine, scope: Locals, p: Problems, ctx: ValidateContext): Type;

  /** Top-level entry: walk collecting Problems. Mirrors Type.validate. */
  validate(engine: Engine, scope?: Locals): Problems {
    const p = new Problems();
    const s = scope ?? engine.globalTypeScope();
    this.validateWalk(engine, s, p, { inLoop: false, inLambda: false });
    return p;
  }

  /**
   * Render as TypeScript-like source text. See CodeOptions.expectsValue.
   * The default implementation delegates to `toGinCode(...).toString()`,
   * so subclasses can override either method — concrete classes
   * historically override `toCode` directly with string concatenation,
   * but newer / migrated classes override `toGinCode` to gain spans.
   */
  toCode(registry?: Registry, options?: CodeOptions): string {
    return this.toGinCode(registry, options).toString();
  }

  /**
   * Render as gin's TS-pseudocode form as a structured `Code` value
   * carrying spans tied to validator paths. Default: wrap the legacy
   * string-returning `toCode` output in a single coarse span covering
   * the whole text. Composite classes that the validator targets with
   * structural paths (block, define, if, switch, get, …) override this
   * to thread `[...path, segment]` into each child's `toGinCode` call,
   * producing fine-grained spans.
   *
   * Subclasses that have NOT been migrated yet keep returning the
   * existing `toCode` result wrapped in a coarse span — every consumer
   * still works, error pointers are just less precise (point at the
   * whole node rather than a nested field) until the override lands.
   */
  toGinCode(
    registry?: Registry,
    options?: CodeOptions,
    path: ReadonlyArray<string | number> = [],
  ): Code {
    // The base reaches into `toCode` even though `toCode` defaults to
    // `toGinCode().toString()`. To avoid infinite recursion when a
    // subclass overrides NEITHER, fall back to the abstract `_toCode`
    // helper that subclasses MUST provide. In practice every subclass
    // currently overrides `toCode`, so this branch is reached only
    // through explicit `super.toGinCode` calls (which we don't make).
    const text = this._toCodeFallback(registry, options);
    return span(text, { path, expr: this });
  }

  /**
   * Render this expression as the body of a statement-context branch
   * (an if-arm, an else clause, a loop body, a switch case). The
   * result is always multi-line braced for visual symmetry with sibling
   * branches, with three exceptions:
   *
   *   - `flow` (return / break / continue / throw / exit) renders bare
   *     plus `;` — `else return x;` is more readable than wrapping a
   *     terminator in braces.
   *   - With `chainElseIf=true` AND this is an `if`: render bare so the
   *     enclosing `else <inner-if>` collapses to `else if (...) ...`.
   *     Callers pass `true` only for the else clause of an enclosing if.
   *   - `block` emits its lines bare; the wrapper here adds the `{`/`}`.
   *
   * Everything else (including sub-`if`/`switch`/`loop` in body
   * position) wraps in braces so `if (cond) { for (...) {...} }` reads
   * symmetrically with the else (which is braced).
   */
  renderStatementBody(
    registry?: Registry,
    options: CodeOptions = {},
    chainElseIf: boolean = false,
  ): string {
    // Kind-based dispatch (instead of `instanceof`) avoids dragging
    // concrete Expr classes into this base module.
    const kind = this.kind;
    if (kind === 'flow') {
      return `${this.toCode(registry, { ...options, expectsValue: false })};`;
    }
    if (chainElseIf && kind === 'if') {
      return this.toCode(registry, { ...options, expectsValue: false });
    }
    if (kind === 'block') {
      const out = this.toCode(registry, { ...options, expectsValue: false });
      return out.startsWith('{') ? out : `{\n  ${indentForBody(out)}\n}`;
    }
    if (kind === 'if' || kind === 'switch' || kind === 'loop') {
      const inner = this.toCode(registry, { ...options, expectsValue: false });
      return `{\n  ${indentForBody(inner)}\n}`;
    }
    return `{\n  ${indentForBody(this.toCode(registry, { ...options, expectsValue: true }))};\n}`;
  }

  /** `Code`-aware variant of `renderStatementBody`. Same dispatch but
   *  spans flow through; `path` is the prefix where this expr sits in
   *  its parent (e.g. `[...path, 'ifs', i, 'body']`). */
  renderStatementBodyRich(
    registry?: Registry,
    options: CodeOptions = {},
    path: ReadonlyArray<string | number> = [],
    chainElseIf: boolean = false,
  ): Code {
    const kind = this.kind;
    if (kind === 'flow') {
      const inner = this.toGinCode(registry, { ...options, expectsValue: false }, path);
      return code`${inner};`;
    }
    if (chainElseIf && kind === 'if') {
      return this.toGinCode(registry, { ...options, expectsValue: false }, path);
    }
    if (kind === 'block') {
      const body = this.toGinCode(registry, { ...options, expectsValue: false }, path);
      return body.text.startsWith('{')
        ? body
        : code`{\n  ${body.indent('  ')}\n}`;
    }
    if (kind === 'if' || kind === 'switch' || kind === 'loop') {
      const body = this.toGinCode(registry, { ...options, expectsValue: false }, path);
      return code`{\n  ${body.indent('  ')}\n}`;
    }
    const inner = this.toGinCode(registry, { ...options, expectsValue: true }, path);
    return code`{\n  ${inner.indent('  ')};\n}`;
  }

  /**
   * Default JSON-form rendering. Returns the indented JSON of
   * `toJSON()` wrapped in a coarse single span. Subclasses override
   * to thread child paths through.
   *
   * `level > 0` re-indents continuation lines so when this Code is
   * embedded as a child of a composite renderer the indentation
   * matches `JSON.stringify`'s shape exactly. The first line is
   * never re-indented (the parent positions the opening `{` / `[`
   * itself).
   */
  toJSONCode(
    path: ReadonlyArray<string | number> = [],
    indent: number = 2,
    level: number = 0,
  ): Code {
    let text = JSON.stringify(this.toJSON(), null, indent);
    if (level > 0) {
      const lead = ' '.repeat(level * indent);
      text = text.replace(/\n/g, '\n' + lead);
    }
    return span(text, { path, expr: this });
  }

  /**
   * Internal hook for the base `toGinCode` to reach the subclass's
   * legacy string render without re-entering `toCode` (which delegates
   * back to us). Subclasses that still ship a string-form override
   * keep their `toCode` definition; this base just calls into it
   * through a stable name.
   *
   * The default forwards to `toCode` if a subclass HAS overridden
   * `toCode` (the historical pattern). Subclasses that override
   * `toGinCode` directly never hit this path.
   */
  protected _toCodeFallback(registry?: Registry, options?: CodeOptions): string {
    // Subclasses that haven't yet been migrated still override `toCode`
    // with their own string-builder. Calling this.toCode would recurse
    // because `Expr.toCode` defaults to toGinCode().toString(). To
    // bridge, look up the prototype's own `toCode` — if it's not the
    // base default, call it; otherwise emit a placeholder.
    const proto = Object.getPrototypeOf(this) as { toCode?: typeof Expr.prototype.toCode };
    const own = proto.toCode;
    if (own && own !== Expr.prototype.toCode) {
      return own.call(this, registry, options) as string;
    }
    return `<unrendered:${(this as { kind?: string }).kind ?? '?'}>`;
  }

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

  /**
   * Categorical side-effect classification — the set of `Effects` bits
   * this expression's evaluation can produce.
   *
   * Every concrete Expr subclass MUST implement this — no base default,
   * intentionally. Forces each new Expr kind to think through what it
   * does to scope, system, and the outside world rather than inheriting
   * a one-size-fits-all walk. Most container classes (`block`, `if`,
   * `switch`, `define`, ...) will be a one-liner OR-ing their children,
   * but writing it out per-class catches surprises like `LambdaExpr`
   * (NONE despite having a body) and `SetExpr` (STATE regardless of
   * what it assigns).
   */
  abstract effects(): Effects;
}

/** Indent every line after the first by two spaces — string helper
 *  used by `Expr.renderStatementBody`. Duplicated here (rather than
 *  imported from `./exprs/code`) to keep `expr.ts` free of imports
 *  that would create circular dependencies with the concrete Expr
 *  classes. */
function indentForBody(s: string): string {
  return s.replace(/\n/g, '\n  ');
}

/**
 * Per-kind expression class constructor — registered with the Registry so
 * Registry.parseExpr(ExprDef) can dispatch by kind.
 */
export interface ExprClass {
  readonly KIND: string;
  /** Build an Expr from its JSON. `scope` is the type-name resolution
   *  scope used when recursing into nested TypeDefs (for `new`,
   *  `lambda`, `native`, `define`). Use `scope.registry` to access the
   *  underlying Registry. */
  from(json: ExprDef, scope: TypeScope): Expr;
  /** JSON-shape Zod schema for this Expr's ExprDef. */
  toSchema(opts: SchemaOptions): z.ZodTypeAny;
}
