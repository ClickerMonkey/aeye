/**
 * Shared option bags + the `Node` marker interface, adapted from gin's
 * `node.ts`. Trimmed to query's needs: gin's `toGinCode` / effects /
 * engine-validate surface is dropped here (those concerns either don't
 * apply to a query language or arrive in later phases). What remains is
 * the minimal contract every serializable meta-model node satisfies, plus
 * the two schema-generation option bags.
 *
 * To keep this package fully standalone and free of phase-2+ coupling,
 * `SchemaOptions` references later-phase schemas (Expr / Query unions) as
 * OPTIONAL `z.ZodTypeAny` slots rather than importing not-yet-existing
 * classes. Everything here is `import type` so there is no runtime import
 * cycle with `registry` / `type`.
 */
import type { z } from 'zod';
import type { Registry } from './registry';
import type { Type } from './type';
import type { FunctionDef } from './schema';
import type { SchemaCache } from './schema-build';

/**
 * Options consumed by value-side schema generation (`toValueSchema`).
 * Deliberately narrow: producing the Zod schema for a *value* of a field
 * type never needs the full meta-language schema bag, so requiring it
 * would force every caller to plumb things they don't use.
 */
export interface ValueSchemaOptions {
  /**
   * Whether to attach docstrings to generated Zod schemas via
   * `.describe(...)`. Useful for LLM prompting.
   *  - `'none'` (default): ignore docs.
   *  - `'type'`: describe each Type's own schema.
   *  - `'all'`: also describe each field with its own docs.
   */
  includeDocs?: 'none' | 'type' | 'all';
}

/**
 * The per-axis schema-depth LEVEL VOCABULARY. These unions live HERE (the
 * `llm/`-free shared module) so `ResolvedSchemaDepth` references them rather
 * than re-inlining the literals; `llm/schemas.ts` re-exports them so existing
 * `llm` imports keep working.
 *
 * How `field-ref` / join `on` references are constrained, loosest → tightest:
 *  - `open`   — `source` + `field` are free strings.
 *  - `types`  — `source` is an enum of Type names; `field` stays open.
 *  - `fields` — `source` stays open; `field` is an enum of known field names.
 *  - `both`   — both enumerated but UNPAIRED (any known source × any field).
 *  - `paired` — a per-Type discriminated union (a Type's name paired with ONLY
 *               its fields).
 */
export type RefDepth = 'open' | 'types' | 'fields' | 'both' | 'paired';

/** Bare Type-name positions: a free string (`open`) or an enum (`enum`). */
export type NameDepth = 'open' | 'enum';

/**
 * Function-call kinds, loosest → tightest:
 *  - `open`  — `function: string`, `args` a loose record.
 *  - `names` — `function` is an enum of selected function names; loose `args`.
 *  - `typed` — a per-function discriminated union with a strict named-arg object.
 */
export type FnDepth = 'open' | 'names' | 'typed';

/** The `filters` clause level: a loose clause (`open`) or `(field,op)` pairs. */
export type FilterDepth = 'open' | 'paired';

/**
 * A FULLY-RESOLVED, per-axis schema-depth bag — every axis concretized to a
 * single level (no presets, no `undefined`), AFTER `maxEnumSize` degradation.
 * It is the runtime form of `buildSchemas`' authoring-time `SchemaDepth` (the
 * looser, all-optional authoring type lives in `llm/schemas.ts`). Defined here,
 * alongside `SchemaOptions`, so the option bag can carry it without `node.ts`
 * importing the LLM layer. Each axis references the shared level unions above.
 */
export interface ResolvedSchemaDepth {
  refs: RefDepth;
  typeNames: NameDepth;
  functions: FnDepth;
  filters: FilterDepth;
}

/**
 * The selected functions, grouped by shape (drives the `names` / `typed`
 * function-call schemas). The resolving `selectFunctions` FUNCTION lives in
 * `schema-build.ts`; the TYPE lives here so `SchemaOptions` can carry it
 * without `node.ts` importing the LLM / schema-build layer.
 */
export interface SelectedFunctions {
  scalar: FunctionDef[];
  tabular: FunctionDef[];
  window: FunctionDef[];
  aggregate: FunctionDef[];
}

/**
 * Options threaded into each class's static `toSchema(opts)`. All fields
 * are optional so a caller can do `Cls.toSchema()` in tests, while richer
 * call sites (later phases) supply the lazy sub-schemas needed to build
 * recursive unions.
 */
export interface SchemaOptions extends ValueSchemaOptions {
  /** Registry, so schema builders can enumerate registered classes / types. */
  registry?: Registry;
  /** Lazy schema for "any Expr" — used by composite schemas referencing exprs. */
  Expr?: z.ZodTypeAny;
  /** Lazy schema for "any Query" — used by subquery / set-op schemas. */
  Query?: z.ZodTypeAny;
  /** Concrete Type instances available to an LLM caller (enumerated choices). */
  types?: Type[];
  /**
   * The resolved per-axis schema depth (replaces the old binary `strict`
   * flag). Carried so recursive child schemas observe the same tightness; the
   * top-level `buildSchemas` resolves presets / `strict` sugar / `maxEnumSize`
   * into this concrete bag before threading it here.
   */
  depth?: ResolvedSchemaDepth;
  /**
   * The functions (grouped by shape) the `names` / `typed` function-call
   * schemas enumerate. Set by `buildSchemas` from its `FunctionSelector`; read
   * by the four function-call expr classes' `toSchema`. Absent for a bare
   * `Cls.toSchema()` (which then renders the open shape).
   */
  functions?: SelectedFunctions;
  /**
   * Per-`buildSchemas` cache of shared, `meta.id`-tagged fragment instances
   * (each Type's field-name enum, the `param` expr, …) so the generated
   * JSON-Schema factors the largest repeated fragments into single `$def`s +
   * `$ref`s instead of inlining every copy. Absent for a bare `Cls.toSchema()`
   * (which then rebuilds the fragments inline, as before).
   */
  cache?: SchemaCache;
}

/**
 * Options controlling how `toCode` renders a node as readable text.
 * Query nodes have a single expression form, so this is intentionally tiny
 * compared with gin's CodeOptions.
 */
export interface CodeOptions {
  /** Indentation unit for nested rendering. */
  indent?: string;
}

/**
 * The shared marker interface every serializable meta-model node conforms
 * to (Type and every FieldType this phase; Expr / Query in later phases).
 *
 * `toJSON` is intentionally NOT declared here: each concrete class returns
 * its own precise `*Def` shape (e.g. `Type.toJSON(): TypeDef`,
 * `FieldType.toJSON(): FieldTypeDef`). Declaring a union/`unknown` return
 * on the shared interface would leak imprecise types into the public API,
 * which this package forbids. Callers that hold a concrete reference get
 * the precise return type; the shared interface only guarantees the two
 * truly universal capabilities below.
 */
export interface Node {
  /** Render as a short, human / LLM readable description string. */
  toCode(registry?: Registry, options?: CodeOptions): string;
  /** Deep-copy this node. */
  clone(): Node;
}
