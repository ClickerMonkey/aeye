import type { Registry } from './registry';
import type { Engine } from './engine';
import type { Problems } from './problem';
import type { z } from 'zod';
import type { Expr } from './expr';
import type { Type } from './type';

/**
 * Passed into each class's static `toSchema(opts)` so sub-fields that
 * reference "some Type" or "some Expr" can participate in the Zod union
 * via z.lazy. Callers typically use `buildSchemas(registry)` rather than
 * constructing this manually.
 *
 * Extras:
 *  - `types`   — specific Type INSTANCES available to LLM callers. Used
 *                by NewExpr's strict schema to lock its `type` field to
 *                one of these, giving the LLM an enumerated choice.
 *  - `exprs`   — specific Expr INSTANCES available as references (e.g.
 *                variables already bound in scope). Reserved for future
 *                constraining of GetExpr paths; not yet wired.
 *  - `newStrict` — when true, NewExpr.toSchema emits a discriminated
 *                union over `opts.types` instead of its generic shape.
 */
export interface SchemaOptions {
  Type: z.ZodTypeAny;
  Expr: z.ZodTypeAny;
  types: Type[];
  exprs: Expr[];
  newStrict?: boolean;
}

/**
 * Options controlling how `toCode` renders. For Types, most flags are
 * ignored (types are always a single expression form). For Exprs, the
 * key flag is `expectsValue`:
 *
 *   - `expectsValue: true` — the rendering will be used in a position
 *     that needs a value (rvalue of an assignment, an argument, a
 *     ternary branch). Statement-oriented Exprs (if/switch/block/define)
 *     render as ternary/IIFE; loop becomes an IIFE returning undefined;
 *     flow is emitted as-is (it never returns a value anyway).
 *   - `expectsValue: false` (default) — statement context. if/switch
 *     render as plain TS statements; block becomes a `;`-separated
 *     sequence; loop is a bare `for`; flow is `return/break/...;`.
 *
 * An `if`/`switch` whose body contains a `flow` (return/break/continue/
 * throw) always renders as a statement even when a value is expected —
 * the flow's non-local control flow can't be faithfully represented in a
 * ternary or IIFE.
 */
export interface CodeOptions {
  expectsValue?: boolean;
  indent?: string;
}

/**
 * Shared interface for things that can be converted to code, JSON, and
 * validated. Both Type and Expr conform to this.
 */
export interface Node {
  /** Render as TypeScript-like source text. */
  toCode(registry?: Registry, options?: CodeOptions): string;

  /** Serialize to its JSON shape (TypeDef for Type, ExprDef for Expr). */
  toJSON(): unknown;

  /** Walk collecting structural problems. Never throws. */
  validate(engine: Engine): Problems;

  /** Deep-copy this node. */
  clone(): Node;
}
