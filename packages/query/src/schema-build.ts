/**
 * Neutral, depth-aware schema-building primitives shared by BOTH the concrete
 * `Expr` classes (`src/exprs/*`) and the central LLM schema assembler
 * (`src/llm/schemas.ts`). It lives OUTSIDE both layers so each rich expr kind
 * can own ONE depth-aware `static toSchema` (rendering the same shape the
 * central builder used to render in its per-kind switch), while the central
 * builder keeps only capability-gating + folding.
 *
 * To avoid import cycles this module imports NOTHING from `src/llm/` or
 * `src/exprs/`: every registry / Type / selected-function / child-`Expr`
 * dependency arrives by PARAMETER (or as a type-only import). It owns:
 *  - the small union primitives `enumOf` / `orFold` + `paramSchema`;
 *  - the unified depth-aware reference schema `refSchema` and its field
 *    eligibility selectors + the per-kind ref wrappers
 *    (`fieldRefSchema` / `relationPathSchema` / `semanticSchema` /
 *    `textSearchSchema` / `filtersSchema`);
 *  - the function-call schema builder `functionExprSchema` (names / typed);
 *  - the function selection (`selectFunctions`) + the capability gate
 *    (`exprKindApplicable`).
 */
import { z } from 'zod';
import type { Registry } from './registry';
import type { Type } from './type';
import type { Field } from './field';
import type { RefDepth, FnDepth, SelectedFunctions } from './node';
import type { FunctionDef, FunctionShape, ExprKind } from './schema';

// ─── Union primitives ─────────────────────────────────────────────────────────

/**
 * Build a union over a list of string literals WITHOUT a tuple cast — folds
 * `z.literal` branches with `.or`. An empty list collapses to `z.never()`.
 */
export function enumOf(values: readonly string[]): z.ZodTypeAny {
  const unique = Array.from(new Set(values));
  const first = unique[0];
  if (first === undefined) return z.never();
  return unique.slice(1).reduce<z.ZodTypeAny>((acc, v) => acc.or(z.literal(v)), z.literal(first));
}

/** Fold a list of branch schemas into a union with `.or` (no tuple cast). */
export function orFold(branches: readonly z.ZodTypeAny[]): z.ZodTypeAny {
  const first = branches[0];
  if (!first) return z.never();
  return branches.slice(1).reduce<z.ZodTypeAny>((acc, s) => acc.or(s), first);
}

/** The shared `param` expr schema (used by query positions + semantic queries). */
export function paramSchema(): z.ZodTypeAny {
  return z
    .object({ kind: z.literal('param'), name: z.string() })
    .describe('A named bind parameter.');
}

// ─── Field eligibility selectors ───────────────────────────────────────────────

/** Which of a Type's fields a reference position may name. */
export type FieldEligibility = (type: Type) => readonly Field[];

/** Eligibility: every field (a plain `field-ref` may name any field). */
export const allFields: FieldEligibility = (t) => t.fields;
/** Eligibility: only relation fields (relation-path / join hops). */
export const relationFieldsOf: FieldEligibility = (t) => t.relationFields();
/** Eligibility: only semantic-eligible fields (semantic score / query). */
export const semanticFieldsOf: FieldEligibility = (t) => t.semanticFields();
/** Eligibility: only text fields (a narrowed text-search target). */
export const textFieldsOf: FieldEligibility = (t) => t.textFields();

/**
 * WRITE-MODEL: narrow an eligibility to only the fields that ALLOW expr `kind`
 * (a field's `exprs` restriction can exclude a kind). So a paired / enumerated
 * field position never offers a field the kind is denied on.
 */
export function allowingExpr(base: FieldEligibility, kind: ExprKind): FieldEligibility {
  return (t) => base(t).filter((f) => f.allowsExpr(kind));
}

// ─── The unified depth-aware reference schema helper ──────────────────────────
//
// ONE builder renders EVERY `{ key, field(s) }` reference position at a given
// `RefDepth`, so `field-ref` / `relation-path` / `join.on` / `semantic` /
// `text-search` / `filters` (and the semantic query's Type+field ref) all share
// the same depth ladder. It is parameterized by three knobs:
//
//  - `keyName`     — the key property: `'source'` (a BOUND name — a Type name,
//                    join alias, CTE, or aliased source) or `'type'` (a value
//                    that MUST be a registered Type name).
//  - `fieldMode`   — the field property's requiredness / shape:
//                      `'none'`     — no field property (key only);
//                      `'one'`      — a required single `field`;
//                      `'optional'` — an optional single `field?`;
//                      `'list'`     — an optional `fields?: string[]` allowlist;
//                      `'path'`     — a relation `path` tuple (relation-path only).
//  - `eligible`    — which of a Type's fields the position may name (drives the
//                    PER-TYPE `paired` enum and the cross-Type `fields`/`both`
//                    enum).
//
// The five `RefDepth` levels render exactly as the legacy `fieldRefSchema` did:
//  - `open`   — `key` + `field` free strings;
//  - `types`  — `key` is an enum of Type names; `field` open;
//  - `fields` — `key` open; `field` an enum of eligible field names;
//  - `both`   — both enumerated but UNPAIRED;
//  - `paired` — a per-Type discriminated union pinning the key literal to one
//               Type's name and the field enum to ONLY that Type's eligible
//               fields (so a cross-Type pairing can't validate).

/** The field-property requiredness / shape a reference position renders. */
type RefFieldMode = 'none' | 'one' | 'optional' | 'list' | 'path';

/** Knobs for `refSchema` — everything except the Types + depth. */
export interface RefSchemaOptions {
  /** The key property: a bound `source`, or a must-be-defined `type`. */
  keyName: 'source' | 'type';
  /** The field property's shape (see `RefFieldMode`). */
  fieldMode: RefFieldMode;
  /** A Type's fields eligible for this position (the paired-enum source). */
  eligible: FieldEligibility;
  /** Extra object properties merged into EVERY branch (e.g. `kind`, `query`). */
  extras?: Record<string, z.ZodTypeAny>;
  /** `aid` for the single-object levels; paired branches append `_<Type>`. */
  aid?: string;
  /** Top-level `.describe(...)` for the whole reference. */
  describe: string;
}

/** The distinct eligible field NAMES across a set of Types (stable order). */
function eligibleFieldNames(types: readonly Type[], eligible: FieldEligibility): string[] {
  const seen = new Set<string>();
  for (const t of types) for (const f of eligible(t)) seen.add(f.name);
  return Array.from(seen);
}

/** A field-property Zod schema for one mode, given the `field` value schema. */
function fieldProperty(mode: RefFieldMode, fieldValue: z.ZodTypeAny, pathValue: z.ZodTypeAny): Record<string, z.ZodTypeAny> {
  switch (mode) {
    case 'none':
      return {};
    case 'one':
      return { field: fieldValue.describe('A field of the referenced source.') };
    case 'optional':
      return { field: fieldValue.optional().describe('A field to narrow to (omit for the whole source).') };
    case 'list':
      return { fields: z.array(fieldValue).optional().describe('Optional allowlist of fields the reference may touch.') };
    case 'path':
      return { path: pathValue };
    /* v8 ignore next 2 -- unreachable: `mode` exhaustively covers RefFieldMode (compile-time guard) */
    default:
      return assertNeverFieldMode(mode);
  }
}

/** Assemble one reference object (a single branch) from its parts. */
function refObject(
  keyName: 'source' | 'type',
  keyValue: z.ZodTypeAny,
  fieldProps: Record<string, z.ZodTypeAny>,
  extras: Record<string, z.ZodTypeAny> | undefined,
  aid: string | undefined,
  describe: string,
): z.ZodTypeAny {
  const shape: Record<string, z.ZodTypeAny> = { [keyName]: keyValue, ...fieldProps, ...extras };
  const obj = z.object(shape);
  return (aid ? obj.meta({ aid }) : obj).describe(describe);
}

/**
 * The unified depth-aware reference schema. See the block comment above for the
 * `keyName` / `fieldMode` / `eligible` semantics and the `RefDepth` ladder.
 */
export function refSchema(types: readonly Type[], depth: RefDepth, opts: RefSchemaOptions): z.ZodTypeAny {
  const keyNoun = opts.keyName === 'type' ? 'a registered Type name' : 'a bound source name';

  if (depth === 'paired') {
    // One branch per Type: the key pinned to the Type's name, the field enum to
    // ONLY that Type's eligible fields (a relation `path` tuple for `'path'`).
    const branches = types.map((t) => {
      const names = opts.eligible(t).map((f) => f.name);
      const fieldValue = names.length ? enumOf(names) : z.string();
      const pathValue =
        names.length > 0 ? z.tuple([enumOf(names)]).rest(z.string()) : z.array(z.string()).min(1);
      const path = pathValue.describe(
        names.length > 0
          ? `Relation path from \`${t.name}\`; first segment is one of its relations: ${names.join(', ')}.`
          : `Relation path from \`${t.name}\` (it declares no relations).`,
      );
      const keyValue = z.literal(t.name).describe(`The \`${t.name}\` ${opts.keyName} (its Type name).`);
      const fieldProps = fieldProperty(opts.fieldMode, fieldValue, path);
      return refObject(
        opts.keyName,
        keyValue,
        fieldProps,
        opts.extras,
        opts.aid ? `${opts.aid}_${t.name}` : undefined,
        `A reference into \`${t.name}\`.`,
      );
    });
    return orFold(branches).describe(opts.describe);
  }

  // The flat (non-paired) levels: enumerate the key and/or field independently.
  const enumKey = depth === 'types' || depth === 'both';
  const enumField = depth === 'fields' || depth === 'both';
  const keyValue = (enumKey ? enumOf(types.map((t) => t.name)) : z.string()).describe(
    enumKey ? `${keyNoun[0]!.toUpperCase()}${keyNoun.slice(1)}.` : `A ${opts.keyName} name.`,
  );
  const fieldNames = eligibleFieldNames(types, opts.eligible);
  const fieldValue = enumField && fieldNames.length ? enumOf(fieldNames) : z.string();
  const pathValue = z
    .array(z.string())
    .describe('Relation field names, optionally ending in a scalar field name.');
  const fieldProps = fieldProperty(opts.fieldMode, fieldValue, pathValue);
  return refObject(opts.keyName, keyValue, fieldProps, opts.extras, opts.aid, opts.describe);
}

// ─── Per-kind ref schemas (called from the rich expr classes) ──────────────────

/** The `field-ref` schema at a `RefDepth` — `source` + a required `field`. */
export function fieldRefSchema(types: readonly Type[], depth: RefDepth): z.ZodTypeAny {
  return refSchema(types, depth, {
    keyName: 'source',
    fieldMode: 'one',
    eligible: allowingExpr(allFields, 'field-ref'),
    extras: { kind: z.literal('field-ref') },
    aid: 'Expr_field-ref',
    describe: 'A direct field reference.',
  });
}

/** The `relation-path` schema at a `RefDepth` — `source` + a relation `path`. */
export function relationPathSchema(types: readonly Type[], depth: RefDepth): z.ZodTypeAny {
  return refSchema(types, depth, {
    keyName: 'source',
    fieldMode: 'path',
    eligible: relationFieldsOf,
    extras: { kind: z.literal('relation-path') },
    aid: 'Expr_relation-path',
    describe: 'A relation-path reference (joins synthesized by the planner).',
  });
}

/** The semantic `query` schema: text, a param, a bound source+field, or a semantic Type+field. */
function semanticQuerySchema(types: readonly Type[], depth: RefDepth): z.ZodTypeAny {
  const sourceField = refSchema(types, depth, {
    keyName: 'source',
    fieldMode: 'one',
    eligible: semanticFieldsOf,
    describe: 'Another BOUND source + semantic field whose embedding is the query vector (cross-source pairing).',
  });
  const typeField = refSchema(types, depth, {
    keyName: 'type',
    fieldMode: 'one',
    eligible: semanticFieldsOf,
    describe: 'A semantic Type + field, resolved to that Type\'s single bound source, whose embedding is the query vector.',
  });
  return orFold([
    z.string().describe('A literal natural-language query.'),
    paramSchema(),
    sourceField,
    typeField,
  ]).describe('The query: text, a param, a bound source+field, or a semantic Type+field.');
}

/** The `semantic` schema at a `RefDepth` — `source` + optional `field` + query. */
export function semanticSchema(types: readonly Type[], depth: RefDepth): z.ZodTypeAny {
  return refSchema(types, depth, {
    keyName: 'source',
    fieldMode: 'optional',
    eligible: allowingExpr(semanticFieldsOf, 'semantic'),
    extras: { kind: z.literal('semantic'), query: semanticQuerySchema(types, depth) },
    aid: 'Expr_semantic',
    describe: 'Semantic-similarity score (requires an embedder).',
  });
}

/** The `text-search` schema at a `RefDepth` — `source` + optional `field` + query. */
export function textSearchSchema(types: readonly Type[], depth: RefDepth): z.ZodTypeAny {
  return refSchema(types, depth, {
    keyName: 'source',
    fieldMode: 'optional',
    eligible: allowingExpr(textFieldsOf, 'text-search'),
    extras: {
      kind: z.literal('text-search'),
      query: z.string().or(paramSchema()).describe('Search query: a literal string or a param.'),
    },
    aid: 'Expr_text-search',
    describe: 'Full-text search predicate.',
  });
}

/** The `text-score` schema at a `RefDepth` — `source` + optional `field` + query. */
export function textScoreSchema(types: readonly Type[], depth: RefDepth): z.ZodTypeAny {
  return refSchema(types, depth, {
    keyName: 'source',
    fieldMode: 'optional',
    eligible: allowingExpr(textFieldsOf, 'text-score'),
    extras: {
      kind: z.literal('text-score'),
      query: z.string().or(paramSchema()).describe('Search query: a literal string or a param.'),
    },
    aid: 'Expr_text-score',
    describe: 'Numeric full-text relevance score (usable in SELECT / ORDER BY).',
  });
}

/**
 * The `filters` placeholder schema. The `filters` axis is two-level (`open` /
 * `paired`), mapped onto the ref ladder: `open` leaves `source` + `fields` free,
 * `paired` pins `source` to a Type and the `fields` allowlist to that Type's
 * fields (every field is filterable). NO clause shapes appear — clauses are
 * execution-time only.
 */
export function filtersSchema(types: readonly Type[], depth: 'open' | 'paired'): z.ZodTypeAny {
  return refSchema(types, depth, {
    keyName: 'source',
    fieldMode: 'list',
    eligible: allowingExpr(allFields, 'filters'),
    extras: { kind: z.literal('filters') },
    aid: 'Expr_filters',
    describe: 'A structured filter placeholder; clauses are supplied at execution time.',
  });
}

// ─── Function selection ────────────────────────────────────────────────────────

/** Resolve a per-shape `'all' | 'none' | string[]` selection against a list. */
function pickByNames(
  available: readonly FunctionDef[],
  sel: string[] | 'all' | 'none',
): FunctionDef[] {
  if (sel === 'none') return [];
  if (sel === 'all') return [...available];
  const names = new Set(sel);
  return available.filter((f) => names.has(f.name));
}

/**
 * Which functions appear in the `names` / `typed` function schemas:
 *  - `'all'`   — every registered function (default).
 *  - `'none'`  — none (function names become `z.never()`-locked).
 *  - `string[]`— exactly these function names, across all shapes.
 *  - object    — a per-shape selection (`'all'` / `'none'` / a name list),
 *                each defaulting to `'all'` when omitted.
 */
export type FunctionSelector =
  | 'all'
  | 'none'
  | string[]
  | {
      scalar?: string[] | 'all' | 'none';
      tabular?: string[] | 'all' | 'none';
      window?: string[] | 'all' | 'none';
      aggregate?: string[] | 'all' | 'none';
    };

/**
 * Resolve a `FunctionSelector` against the registry's `functionList()` into the
 * set of functions available PER SHAPE. Default (`undefined` / `'all'`) selects
 * every registered function.
 */
export function selectFunctions(registry: Registry, selector: FunctionSelector = 'all'): SelectedFunctions {
  const all = registry.functionList();
  const byShape = (shape: FunctionShape): FunctionDef[] => all.filter((f) => f.shape === shape);

  if (selector === 'all' || selector === 'none') {
    const sel = selector;
    return {
      scalar: pickByNames(byShape('scalar'), sel),
      tabular: pickByNames(byShape('tabular'), sel),
      window: pickByNames(byShape('window'), sel),
      aggregate: pickByNames(byShape('aggregate'), sel),
    };
  }
  if (Array.isArray(selector)) {
    const names = new Set(selector);
    const keep = (shape: FunctionShape): FunctionDef[] => byShape(shape).filter((f) => names.has(f.name));
    return { scalar: keep('scalar'), tabular: keep('tabular'), window: keep('window'), aggregate: keep('aggregate') };
  }
  // Per-shape object — each axis defaults to `'all'`.
  return {
    scalar: pickByNames(byShape('scalar'), selector.scalar ?? 'all'),
    tabular: pickByNames(byShape('tabular'), selector.tabular ?? 'all'),
    window: pickByNames(byShape('window'), selector.window ?? 'all'),
    aggregate: pickByNames(byShape('aggregate'), selector.aggregate ?? 'all'),
  };
}

/** The selected functions for one shape. */
function functionsForShape(s: SelectedFunctions, shape: FunctionShape): FunctionDef[] {
  switch (shape) {
    case 'scalar':
      return s.scalar;
    case 'tabular':
      return s.tabular;
    case 'window':
      return s.window;
    case 'aggregate':
      return s.aggregate;
    /* v8 ignore next 2 -- unreachable: `shape` exhaustively covers FunctionShape (compile-time guard) */
    default:
      return assertNeverShape(shape);
  }
}

// ─── Function-call schema (names / typed) ──────────────────────────────────────

/** The four function-call expr kinds (their `KIND` literals). */
export type FnExprKind = 'function-call' | 'tabular-function-call' | 'aggregate' | 'window';

/** The function SHAPE an expr kind dispatches to (function-call ⇒ scalar, …). */
function shapeForKind(kind: FnExprKind): FunctionShape {
  switch (kind) {
    case 'function-call':
      return 'scalar';
    case 'tabular-function-call':
      return 'tabular';
    case 'aggregate':
      return 'aggregate';
    case 'window':
      return 'window';
    /* v8 ignore next 2 -- unreachable: `kind` exhaustively covers FnExprKind (compile-time guard) */
    default:
      return assertNeverKind(kind);
  }
}

/** The window `orderBy` entry schema (matches `WindowExpr.toSchema`). */
function windowOrderSchema(child: z.ZodTypeAny): z.ZodTypeAny {
  return z.array(
    z.object({
      expr: child,
      dir: z.enum(['asc', 'desc']),
      nulls: z.enum(['first', 'last']).optional(),
    }),
  );
}

/**
 * Assemble a function-call object for a given kind, with caller-supplied
 * `function` + `args` field schemas plus the kind's shape extras (aggregate ⇒
 * `distinct`; window ⇒ `partitionBy` / `orderBy`).
 */
function functionObject(
  kind: FnExprKind,
  functionField: z.ZodTypeAny,
  argsField: z.ZodTypeAny,
  child: z.ZodTypeAny,
): z.ZodTypeAny {
  switch (kind) {
    case 'function-call':
      return z
        .object({ kind: z.literal('function-call'), function: functionField, args: argsField })
        .meta({ aid: 'Expr_function-call' })
        .describe('A scalar function call with named arguments.');
    case 'tabular-function-call':
      return z
        .object({ kind: z.literal('tabular-function-call'), function: functionField, args: argsField })
        .meta({ aid: 'Expr_tabular-function-call' })
        .describe('A type-valued function call (produces rows).');
    case 'aggregate':
      return z
        .object({
          kind: z.literal('aggregate'),
          function: functionField,
          args: argsField,
          distinct: z.boolean().optional(),
        })
        .meta({ aid: 'Expr_aggregate' })
        .describe('Aggregate function over named args (count with empty args = count(*)).');
    case 'window':
      return z
        .object({
          kind: z.literal('window'),
          function: functionField,
          args: argsField,
          partitionBy: z.array(child).optional(),
          orderBy: windowOrderSchema(child).optional(),
        })
        .meta({ aid: 'Expr_window' })
        .describe('Window function over a partition / ordering, with named args.');
    /* v8 ignore next 2 -- unreachable: `kind` exhaustively covers FnExprKind (compile-time guard) */
    default:
      return assertNeverKind(kind);
  }
}

/** The strict per-function `args` object built from its declared parameters. */
function typedArgsSchema(fn: FunctionDef, child: z.ZodTypeAny): z.ZodTypeAny {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const param of fn.params) {
    shape[param.name] = param.optional ? child.optional() : child;
  }
  // `strictObject` REJECTS an undeclared argument name (the whole point of
  // `typed`), while declared-but-optional params may be omitted.
  return z.strictObject(shape).describe(`Named arguments for \`${fn.name}\`.`);
}

/**
 * The function-call schema for one expr kind at a given `FnDepth`:
 *  - `open`  — the kind's own open shape (passed in by the class) — free name +
 *              loose args; old behavior.
 *  - `names` — `function` enum-locked to the selected names for the kind's
 *              shape; `args` a loose record.
 *  - `typed` — a discriminated union, one branch per selected function of the
 *              matching shape, each with a strict named-arg object.
 *
 * `selected` is undefined only for a bare `Cls.toSchema()` (no central build);
 * combined with the `open` default that path renders the open shape.
 */
export function functionExprSchema(
  kind: FnExprKind,
  openSchema: z.ZodTypeAny,
  selected: SelectedFunctions | undefined,
  depth: FnDepth,
  child: z.ZodTypeAny,
): z.ZodTypeAny {
  if (depth === 'open' || !selected) return openSchema;
  const fns = functionsForShape(selected, shapeForKind(kind));

  if (depth === 'names') {
    const functionField = enumOf(fns.map((f) => f.name)).describe('A selected function name.');
    const argsField = z
      .record(z.string(), child)
      .describe('Arguments keyed by declared parameter name.');
    return functionObject(kind, functionField, argsField, child);
  }

  // `typed` — one branch per selected function of the matching shape.
  const branches = fns.map((fn) => {
    const hasRequired = fn.params.some((p) => !(p.optional ?? false));
    const argsObj = typedArgsSchema(fn, child);
    return functionObject(
      kind,
      z.literal(fn.name).describe(`The \`${fn.name}\` function.`),
      hasRequired ? argsObj : argsObj.optional(),
      child,
    );
  });
  return branches.length > 0 ? orFold(branches) : z.never();
}

// ─── Capability gating ─────────────────────────────────────────────────────────

/**
 * CAPABILITY GATING — whether an expr `kind` is usable at all given the
 * available Types + selected functions, INDEPENDENT of depth. A gated-out kind
 * is omitted from the Expr union entirely so the model is never offered an
 * unusable construct (e.g. `text-search` when nothing is searchable). The
 * always-usable CORE — literal / param / binary / unary / comparison / logical /
 * in / between / is-null / exists / case / field-ref / subquery — is NEVER
 * gated, so the `default` returns `true`. (A string switch over the open `kind`
 * space, hence no `never` guard.)
 */
export function exprKindApplicable(
  kind: string,
  types: readonly Type[],
  selected: SelectedFunctions,
): boolean {
  switch (kind) {
    case 'semantic':
      return types.some((t) => t.isSemantic());
    case 'text-search':
      return types.some((t) => t.isSearchable());
    case 'text-score':
      return types.some((t) => t.isSearchable());
    case 'array-op':
      // WRITE-MODEL: gone entirely when EVERY array field excludes `array-op`.
      return types.some((t) => t.fields.some((f) => f.allowsExpr('array-op')));
    case 'relation-path':
      return types.some((t) => t.relationFields().length > 0);
    case 'tabular-function-call':
      return selected.tabular.length > 0;
    case 'aggregate':
      return selected.aggregate.length > 0;
    case 'window':
      return selected.window.length > 0;
    case 'function-call':
      return selected.scalar.length > 0;
    case 'filters':
      return types.some((t) => t.fields.length > 0);
    case 'excluded':
      // Only valid inside an INSERT ON CONFLICT DO UPDATE assignment, so it is
      // kept OUT of the general Expr union and folded into that position alone
      // (see the `OnConflict.update` schema in `llm/schemas.ts`).
      return false;
    case 'output':
      // A reference to a SELECT output field by name, only valid in a SELECT's
      // groupBy / orderBy / having — so it is kept OUT of the general Expr union
      // (never offered in WHERE / expr args) and folded into those clause
      // positions alone (see the `Select` schema in `llm/schemas.ts`).
      return false;
    default:
      return true;
  }
}

// ─── Exhaustiveness guards ─────────────────────────────────────────────────────

/* v8 ignore start -- compile-time exhaustiveness guards; never invoked at runtime */
/** Compile-time exhaustiveness guard over `FunctionShape`. */
function assertNeverShape(value: never): never {
  throw new Error(`schema-build: unhandled function shape ${JSON.stringify(value)}`);
}

/** Compile-time exhaustiveness guard over `FnExprKind`. */
function assertNeverKind(value: never): never {
  throw new Error(`schema-build: unhandled function-call kind ${JSON.stringify(value)}`);
}

/** Compile-time exhaustiveness guard over `RefFieldMode`. */
function assertNeverFieldMode(value: never): never {
  throw new Error(`schema-build: unhandled ref field mode ${JSON.stringify(value)}`);
}
/* v8 ignore stop */
