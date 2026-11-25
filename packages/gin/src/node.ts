import type { Registry } from './registry';
import type { Engine } from './engine';
import type { Problems } from './problem';
import type { Type } from './type';
import type { TypeScope } from './type-scope';
import type { Code } from './code';
import type { AnySchema } from '@aeye/schema';

/**
 * Options for a value schema of a type: `Type.toA(opts)` (and `defineA` /
 * `valueA` / `toNewA`, `ginValue(type, opts)`). The meta-language schemas
 * (TypeDef / Expr) are the grammar module's (`GinGrammar`, `buildSchemas`),
 * so nothing here names them.
 */
export interface ValueSchemaOptions {
  /**
   * Control whether Type docstrings are attached to the value schema
   * as descriptions. Useful for LLM prompting — docs become part of
   * the schema description the model sees.
   *
   *  - `'none'`  (default): ignore all docs.
   *  - `'type'`: describe each Type's own schema with `type.docs`.
   *  - `'all'`:  also describe each field / prop / get / call / init
   *              with its own `docs`.
   */
  includeDocs?: 'none' | 'type' | 'all';
  /**
   * Type-name resolution scope for the schema being built — the same
   * `TypeScope` that `valid` / `parse` / `compatible` / `props` take as
   * their trailing argument.
   *
   * It matters wherever a type is named rather than inlined. A signature
   * carrying `{name:'Deployment'}` built against a registry that does not
   * hold that name resolves to an unbound `AliasType`, whose value schema is
   * any value — so the call-argument gate derived from it accepts every value
   * silently. Pass the scope that DOES know the name and the alias resolves:
   *
   * ```ts
   * const session = registry.scope({ Deployment: deploymentType });
   * fnType.call()!.args.toA({ scope: session });
   * ```
   *
   * It rides the options bag rather than a positional parameter because a
   * value schema is built by recursion through slots that already thread
   * `opts` verbatim — so every nested list element, obj field and map value
   * inherits it, where a positional argument would have to be re-threaded by
   * each composite and would be silently dropped by any that forgot.
   */
  scope?: TypeScope;
  /**
   * What an object-shaped schema does with a key the type does not declare.
   *
   *  - `'strip'` (default): drop it, gin's own value semantics — `ObjType.parse` copies the declared fields and
   *    nothing else, `valid` ignores extras, and `obj{a}` is `compatible`
   *    with `obj{a, zz}` (width subtyping). A value carrying more than the
   *    type declares IS a value of that type.
   *  - `'refuse'`: reject it (a strict object), with an issue naming
   *    the key and its path.
   *
   * `'refuse'` is opt-in — and it is a per-BOUNDARY choice, not a per-type
   * one, which is why it lives here rather than on the type. At a boundary
   * where the payload was AUTHORED against the declared type (settings, a
   * config bag, an agent-supplied argument object) an undeclared key is a
   * typo, and stripping it means a mis-spelt optional knob vanishes with no
   * error at any layer — measured on
   * `{type:'graph', charThreshold:5000, bogus:1}`, which parsed clean with
   * `bogus` silently gone. At a boundary where a wider value is flowing
   * through a narrower view, the same key is legitimate width and refusing it
   * would contradict `compatible`. Only the caller knows which it is.
   *
   * Contrast the WIRE side, where there is no such choice: `registry.parse`
   * refuses an unknown `TypeDef` key outright, with no opt-out, because a def
   * is gin's own format and an ignored key there is data loss (see `wire.ts`).
   */
  unknownKeys?: 'strip' | 'refuse';
  /**
   * The caller's own schema for some types (`toA` only): asked for every type
   * `toA` reaches, before gin's mapping; a schema it returns is used as is (a
   * ref to a named type the caller's module defines, a codec), `undefined`
   * keeps gin's. The harness maps its fn-name texts to a per-prompt codec this
   * way. `ginValue` memoizes without it: compose with
   * `GinGrammar.result(type.toA({ override }))` instead.
   */
  override?: (type: Type) => AnySchema | undefined;
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
  /**
   * When false, suppress all `/* docs * /` and `// comment` rendering —
   * Type docstrings, Prop docs, Expr comments, and `// docs` lines on
   * Init / Call / Prop in `toCodeDefinition`. Default true (include).
   *
   * Threading this through inner `.toCode(...)` / `.toCodeDefinition(...)`
   * calls is the responsibility of each composite type / expr — callers
   * that want a comment-free render set this once at the top.
   */
  includeComments?: boolean;
}

/**
 * Shared interface for things that can be converted to code, JSON, and
 * validated. Both Type and Expr conform to this.
 */
export interface Node {
  /**
   * Render as TypeScript-like source text. Convenience wrapper that
   * delegates to `toGinCode(...).toString()`. Existing callers that
   * just want a string keep working unchanged.
   */
  toCode(registry?: Registry, options?: CodeOptions): string;

  /**
   * Render as gin's TS-pseudocode form (the same format `toCode`
   * emits) but as a structured `Code` value carrying spans that tie
   * each rendered range back to its node + validator path. Used by
   * `formatProblem` to emit compiler-style `^^^` underlines for
   * validation errors.
   *
   * The `path` argument is the validator-style path prefix where
   * this node sits in its parent — composite renderers thread
   * `[...path, segment]` into each child's `toGinCode` call so the
   * resulting span paths line up with `Problem.path` exactly.
   *
   * Future: a sibling `toTypescriptCode` would emit real TypeScript
   * with the same Code shape.
   */
  toGinCode(
    registry?: Registry,
    options?: CodeOptions,
    path?: ReadonlyArray<string | number>,
  ): Code;

  /**
   * Render as the JSON form (the same shape `toJSON` emits, formatted
   * with the same indentation as `JSON.stringify(..., null, 2)`) as a
   * structured `Code` carrying spans aligned to JSON-token positions.
   * Lets the caller surface validation errors in the JSON the LLM
   * actually wrote.
   */
  toJSONCode(
    path?: ReadonlyArray<string | number>,
    indent?: number,
    /** Current nesting depth — used by the indentation arithmetic so a
     *  child rendered inside its parent's `code\`...\`` indents its
     *  continuation lines correctly. Public callers leave at default 0;
     *  composite renderers pass `level + 1` to each child. */
    level?: number,
  ): Code;

  /** Serialize to its JSON shape (TypeDef for Type, ExprDef for Expr). */
  toJSON(): unknown;

  /** Walk collecting structural problems. Never throws. */
  validate(engine: Engine): Problems;

  /** Deep-copy this node. */
  clone(): Node;
}
