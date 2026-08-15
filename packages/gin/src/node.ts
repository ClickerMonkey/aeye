import type { Registry } from './registry';
import type { Engine } from './engine';
import type { Problems } from './problem';
import type { z } from 'zod';
import type { Expr } from './expr';
import type { Type } from './type';
import type { TypeScope } from './type-scope';
import type { Code } from './code';

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
/**
 * Options consumed by `Type.toValueSchema` (and the helpers it delegates
 * to like `describeType`). Deliberately narrower than `SchemaOptions`:
 * value-side schema generation never references `Type` / `Expr` /
 * `types` / `exprs` / `registry` / `newStrict`, so requiring them all
 * just to pass `{ includeDocs: 'all' }` is overkill — and forces every
 * caller to plumb the full meta-language schema bag through.
 *
 * Callers building a value-side schema for one Type (e.g. ginny's
 * `test()` tool deriving its `args` schema from a function's params)
 * can call `argsType.toValueSchema({ includeDocs: 'all' })` without
 * holding onto the full `SchemaOptions`. `SchemaOptions` extends this,
 * so existing call sites that already have the full bag still work.
 */
export interface ValueSchemaOptions {
  /**
   * Control whether Type docstrings are attached to generated Zod schemas
   * via `.describe(...)`. Useful for LLM prompting — docs become part of
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
   * their trailing argument, and the one thing `toValueSchema` had no way
   * to accept until 0.4.0.
   *
   * It matters wherever a type is named rather than inlined. A signature
   * carrying `{name:'Deployment'}` built against a registry that does not
   * hold that name resolves to an unbound `AliasType`, whose value schema is
   * `z.any()` — so the call-argument gate derived from it accepts every value
   * silently. Pass the scope that DOES know the name and the alias resolves:
   *
   * ```ts
   * const session = registry.scope({ Deployment: deploymentType });
   * fnType.call()!.args.toValueSchema({ scope: session });
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
   *  - `'strip'` (default): drop it, which is zod's default and gin's own
   *    value semantics — `ObjType.parse` copies the declared fields and
   *    nothing else, `valid` ignores extras, and `obj{a}` is `compatible`
   *    with `obj{a, zz}` (width subtyping). A value carrying more than the
   *    type declares IS a value of that type.
   *  - `'refuse'`: reject it, with zod's `unrecognized_keys` issue naming
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
   * Optional pass-through to the full meta-language schema bag. Most
   * `toValueSchema` paths never touch these — they're declared here so
   * a `SchemaOptions` (where these are required) is structurally
   * assignable to `ValueSchemaOptions` without casts, and so the rare
   * type that DOES need them (e.g. `TypType.toValueSchema` building an
   * inline-Extension branch) can read them off `opts` directly when
   * present and gracefully degrade when not.
   */
  Type?: z.ZodTypeAny;
  Expr?: z.ZodTypeAny;
  types?: Type[];
  exprs?: Expr[];
  registry?: Registry;
  newStrict?: boolean;
}

export interface SchemaOptions extends ValueSchemaOptions {
  Type: z.ZodTypeAny;
  Expr: z.ZodTypeAny;
  types: Type[];
  exprs: Expr[];
  /**
   * Registry reference so schema builders can enumerate classes and
   * registered named types (e.g. `NewExpr.toSchema` strict mode builds a
   * union with branches per built-in class + per named instance).
   */
  registry: Registry;
  newStrict?: boolean;
  /**
   * Control whether Expr comments are attached via `.describe(...)`.
   *  - `'none'` (default): ignore.
   *  - `'all'`: describe an Expr instance's schema with its `comment`
   *             field where a per-instance schema is produced.
   */
  includeComments?: 'none' | 'all';
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
