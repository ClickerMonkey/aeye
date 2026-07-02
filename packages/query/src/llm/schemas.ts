/**
 * LLM-facing Zod schemas for authoring queries — the query analogue of gin's
 * `buildSchemas`.
 *
 * `buildSchemas(engineOrRegistry, opts?)` returns a bundle of lazily-threaded
 * Zod schemas (`Type`, `Expr`, `Source`, `Select`, …, `Query`) an LLM can be
 * constrained to. Recursion (an Expr inside an Expr, a subquery inside an
 * Expr) is closed with `z.lazy`, exactly like gin: a single `SchemaOptions`
 * bag carries the lazy `Expr` / `Query` slots that each class's
 * `static toSchema(opts)` reads for its child positions.
 *
 * GRADUATED DEPTH (replaces the old binary `strict` flag): every constrainable
 * axis is dialed INDEPENDENTLY via `opts.depth` —
 *  - `refs`      — `field-ref` / `relation-path` (`open` → `paired`);
 *  - `typeNames` — bare Type-name positions (`open` → `enum`);
 *  - `functions` — the four function-call kinds (`open` → `names` → `typed`);
 *  - `filters`   — the `filters` clause (`open` → `paired`).
 * `depth: 'open'` (and the deprecated `strict: false`) reproduces the old
 * FREE-STRING mode byte-for-byte; `depth: 'paired'` (and `strict: true`) is the
 * old fully-locked STRICT mode (now also typing function args). A partial
 * `SchemaDepth` fills only the axes it names and leaves the rest open. Finally
 * `maxEnumSize` AUTO-DEGRADES any axis whose enumeration would exceed the
 * budget (see `degradeRefs` / `degradeFns`), so an oversized catalog never
 * produces an unusably large schema.
 *
 * STRUCTURAL NOTE: each expr KIND owns its own depth-aware `static toSchema`
 * (rendered through the shared `src/schema-build.ts` primitives). This module
 * keeps only the CENTRAL concerns: resolving the per-axis depth, CAPABILITY
 * GATING (which kinds appear at all), and FOLDING the applicable kinds into the
 * recursive Expr union — it no longer re-renders any per-kind shape.
 *
 * `shouldUseStringSchema(types, max)` + `querySchema(engine, opts)` mirror
 * cletus's `tools/dba.ts` threshold: past `max` Types the structured schema
 * is too large to be useful, so the tool falls back to a single
 * `{ query: z.string() }` natural-language description.
 */
import { z } from 'zod';
import type { Registry } from '../registry';
import type { QueryEngine } from '../engine';
import type { Type } from '../type';
import type { SchemaOptions, ResolvedSchemaDepth, RefDepth, NameDepth, FnDepth, FilterDepth, SelectedFunctions } from '../node';
import {
  enumOf,
  orFold,
  paramSchema,
  refSchema,
  relationFieldsOf,
  selectFunctions,
  exprKindApplicable,
  type FunctionSelector,
} from '../schema-build';

/** The default Type-count past which the structured schema is abandoned. */
export const DEFAULT_MAX_QUERY_SCHEMA_TYPES = 5;

// ─── Depth vocabulary ────────────────────────────────────────────────────────
//
// The per-axis level unions (`RefDepth` / `NameDepth` / `FnDepth`) now live in
// `node.ts` (the shared, `llm`-free module) so `ResolvedSchemaDepth` references
// them directly. Re-exported here so existing `llm/schemas` imports keep working.
export type { RefDepth, NameDepth, FnDepth, FilterDepth, ResolvedSchemaDepth } from '../node';

// The function selection TYPE lives in `node.ts` (so `SchemaOptions` can carry
// it); the resolving FUNCTION + the `FunctionSelector` authoring union live in
// `schema-build.ts`. Both are re-exported here as part of this module's surface.
export type { SelectedFunctions } from '../node';
export { selectFunctions, type FunctionSelector } from '../schema-build';

/** A partial, per-axis depth specification; unset axes fall back to the preset. */
export interface SchemaDepth {
  /** `field-ref` / `relation-path` tightness. */
  refs?: RefDepth;
  /** Bare Type-name positions. */
  typeNames?: NameDepth;
  /** The four function-call kinds. */
  functions?: FnDepth;
  /** The `filters` clause. */
  filters?: FilterDepth;
}

/** Options accepted by `buildSchemas`. */
export interface BuildSchemasOptions {
  /**
   * Per-axis schema tightness. A `SchemaDepth` object dials each axis
   * independently; the string presets `'open'` (all loose) / `'paired'` (all
   * tight) expand to every axis. Unspecified axes of a partial `SchemaDepth`
   * inherit the resolved preset (or the `strict` sugar, else `'open'`).
   */
  depth?: SchemaDepth | 'open' | 'paired';
  /**
   * Which functions populate the `names` / `typed` function schemas.
   * Defaults to `'all'`.
   */
  functions?: FunctionSelector;
  /**
   * When set, AUTO-DEGRADE any axis whose enumeration would exceed this many
   * entries one level looser (see `degradeRefs` / `degradeFns`). Counts used:
   * #Types for the source/type-name axis, #distinct fields for the field axis,
   * #selected functions (largest shape group) for the function axis. No-op when
   * unset.
   */
  maxEnumSize?: number;
  /**
   * DEPRECATED binary sugar. `strict: true` ⇒ `depth: 'paired'`;
   * `strict: false` / absent ⇒ `depth: 'open'`. Prefer `depth`.
   */
  strict?: boolean;
  /** Attach `.describe(...)` docs to generated schemas for LLM prompting. */
  includeDocs?: 'none' | 'type' | 'all';
  /**
   * Restrict the enumerated Types (depth + instance branches) to this subset.
   * Defaults to every Type registered on the registry.
   */
  types?: Type[];
}

/** The bundle of schemas `buildSchemas` produces. */
export interface QuerySchemas {
  /** "Any registered Type" — an enum of names when `typeNames: 'enum'`, else a string. */
  Type: z.ZodTypeAny;
  /** "Any expression" — the recursive union over every registered Expr kind. */
  Expr: z.ZodTypeAny;
  /** A FROM / JOIN source (type or subquery). */
  Source: z.ZodTypeAny;
  /** A relation-based JOIN clause. */
  Join: z.ZodTypeAny;
  /** An ORDER BY entry. */
  Order: z.ZodTypeAny;
  /** A selected output field. */
  SelectField: z.ZodTypeAny;
  /** A `SELECT` statement. */
  Select: z.ZodTypeAny;
  /** An `INSERT` statement. */
  Insert: z.ZodTypeAny;
  /** An `UPDATE` statement. */
  Update: z.ZodTypeAny;
  /** A `DELETE` statement. */
  Delete: z.ZodTypeAny;
  /** A `UNION` / `INTERSECT` / `EXCEPT` set operation. */
  SetOperation: z.ZodTypeAny;
  /** A `WITH` (CTE) statement. */
  CTE: z.ZodTypeAny;
  /** A single-expression query. */
  ExprQuery: z.ZodTypeAny;
  /** "Any query" — the union over every query kind. */
  Query: z.ZodTypeAny;
  /**
   * The strict `(field, filter-op)` discriminated union for one Type's
   * `filters` clause. Throws if the Type isn't registered.
   */
  filtersForType(typeName: string): z.ZodTypeAny;
}

/** Narrow a `QueryEngine | Registry` to its `Registry` without a cast. */
function toRegistry(engineOrRegistry: QueryEngine | Registry): Registry {
  return 'registry' in engineOrRegistry ? engineOrRegistry.registry : engineOrRegistry;
}

/** The distinct field NAMES across a set of Types (deduped, stable order). */
function uniqueFieldNames(types: readonly Type[]): string[] {
  const seen = new Set<string>();
  for (const t of types) for (const f of t.fields) seen.add(f.name);
  return Array.from(seen);
}

/** The size of the largest selected per-shape group (the function-axis budget). */
function maxFunctionGroup(s: SelectedFunctions): number {
  return Math.max(s.scalar.length, s.tabular.length, s.window.length, s.aggregate.length);
}

// ─── Depth resolution + degradation ──────────────────────────────────────────

/** Expand a preset into a fully-concretized per-axis depth. */
function expandPreset(preset: 'open' | 'paired'): ResolvedSchemaDepth {
  return preset === 'paired'
    ? { refs: 'paired', typeNames: 'enum', functions: 'typed', filters: 'paired' }
    : { refs: 'open', typeNames: 'open', functions: 'open', filters: 'open' };
}

/** The base preset a (partial) `depth` / `strict` resolves against. */
function presetBase(options: BuildSchemasOptions): 'open' | 'paired' {
  if (options.depth === 'paired') return 'paired';
  if (options.depth === 'open') return 'open';
  // A partial `SchemaDepth` object (or no `depth`) inherits the `strict` sugar.
  if (options.strict === true) return 'paired';
  return 'open';
}

/**
 * AUTO-DEGRADE the `refs` axis so no enumeration exceeds `max`, loosest step
 * first. Ladder (tightest → loosest):
 *   `paired` → `both` → (`types` | `fields` | `open`)
 * `paired` is a per-Type union enumerating each Type's fields, so it needs BOTH
 * the Type count AND the field count to fit; over budget it drops to `both`.
 * `both` enumerates Type names and field names independently — whichever axis is
 * over budget loses its enum: both over ⇒ `open`, only Types over ⇒ `fields`
 * (keep the field enum), only fields over ⇒ `types` (keep the Type enum).
 * `types` / `fields` drop to `open` when their single enum is over budget.
 */
function degradeRefs(d: RefDepth, typeCount: number, fieldCount: number, max: number): RefDepth {
  const typesOver = typeCount > max;
  const fieldsOver = fieldCount > max;
  let depth = d;
  if (depth === 'paired' && (typesOver || fieldsOver)) depth = 'both';
  if (depth === 'both') {
    if (typesOver && fieldsOver) return 'open';
    if (typesOver) return 'fields';
    if (fieldsOver) return 'types';
    return 'both';
  }
  if (depth === 'types' && typesOver) return 'open';
  if (depth === 'fields' && fieldsOver) return 'open';
  return depth;
}

/**
 * AUTO-DEGRADE the `functions` axis. Ladder (tightest → loosest):
 *   `typed` → `names` → `open`
 * `typed` builds one union branch per selected function (the most expensive), so
 * it drops to `names` (a single name enum) when the largest shape group exceeds
 * the budget; the name enum itself drops to `open` when still over budget.
 */
function degradeFns(d: FnDepth, fnCount: number, max: number): FnDepth {
  let depth = d;
  if (depth === 'typed' && fnCount > max) depth = 'names';
  if (depth === 'names' && fnCount > max) depth = 'open';
  return depth;
}

/** Catalog counts the degrade ladders consult. */
interface DepthCounts {
  typeCount: number;
  fieldCount: number;
  fnCount: number;
}

/**
 * Resolve the caller's `depth` / `strict` / `maxEnumSize` options into a single
 * concrete per-axis `ResolvedSchemaDepth`: expand the preset, overlay any
 * partial `SchemaDepth`, then apply `maxEnumSize` degradation.
 */
function resolveDepth(options: BuildSchemasOptions, counts: DepthCounts): ResolvedSchemaDepth {
  const base = expandPreset(presetBase(options));
  const d: ResolvedSchemaDepth =
    typeof options.depth === 'object'
      ? {
          refs: options.depth.refs ?? base.refs,
          typeNames: options.depth.typeNames ?? base.typeNames,
          functions: options.depth.functions ?? base.functions,
          filters: options.depth.filters ?? base.filters,
        }
      : base;

  if (options.maxEnumSize === undefined) return d;
  const max = options.maxEnumSize;
  return {
    refs: degradeRefs(d.refs, counts.typeCount, counts.fieldCount, max),
    typeNames: d.typeNames === 'enum' && counts.typeCount > max ? 'open' : d.typeNames,
    functions: degradeFns(d.functions, counts.fnCount, max),
    // The `paired` filters clause enumerates `(field, op)` pairs per Type, so it
    // is governed by the field count; over budget it drops to the loose clause.
    filters: d.filters === 'paired' && counts.fieldCount > max ? 'open' : d.filters,
  };
}

/**
 * The strict `filters` clause union for one Type: one discriminated branch
 * per `(field, op)` the field's filter-op catalog allows, with the op's own
 * operand schema.
 */
function strictFilterClauseSchema(type: Type): z.ZodTypeAny {
  const branches: z.ZodTypeAny[] = [];
  for (const field of type.fields) {
    for (const op of field.fieldType.filterOps()) {
      const valueSchema = op.valueSchema(field.fieldType);
      branches.push(
        z.object({
          field: z.literal(field.name),
          op: z.literal(op.op),
          // Unary ops (isNull / notNull / exists) take no value.
          value: op.arity === 'unary' ? valueSchema.optional() : valueSchema,
        }),
      );
    }
  }
  return orFold(branches).describe(`A filter clause valid for type '${type.name}'.`);
}

/** The join `on` schema at a `RefDepth` — `source` + its relation `field`. */
function joinOnSchema(types: readonly Type[], depth: RefDepth): z.ZodTypeAny {
  return refSchema(types, depth, {
    keyName: 'source',
    fieldMode: 'one',
    eligible: relationFieldsOf,
    describe: 'The bound source + relation field for this single join hop.',
  });
}

/**
 * Build the recursive Expr union at the resolved per-axis depth, gated to the
 * APPLICABLE kinds (see `exprKindApplicable`). Each applicable kind self-renders
 * at the threaded depth via its own `static toSchema(inner)` (the depth /
 * functions / types / lazy Expr all ride on `inner`); this central builder only
 * filters out gated-away kinds and folds the rest into one union.
 */
function buildExprUnion(
  registry: Registry,
  inner: SchemaOptions,
  types: readonly Type[],
  selected: SelectedFunctions,
): z.ZodTypeAny {
  const applicable = registry
    .exprClassList()
    .filter((c) => exprKindApplicable(c.KIND, types, selected));
  return orFold(applicable.map((c) => c.toSchema(inner)));
}

/**
 * Build the bundle of lazily-threaded, depth-aware Zod schemas (`Type`, `Expr`,
 * `Source`, `Select`, …, `Query`) an LLM can be constrained to for one engine /
 * registry. Resolves the per-axis depth, function selection, and capability
 * gating from `options`, then folds the applicable expr / query kinds into the
 * recursive union returned as a `QuerySchemas`.
 */
export function buildSchemas(
  engineOrRegistry: QueryEngine | Registry,
  options: BuildSchemasOptions = {},
): QuerySchemas {
  const registry = toRegistry(engineOrRegistry);
  const types = options.types ?? registry.typeList();
  const typeNames = types.map((t) => t.name);

  // Resolve the function selection + concrete per-axis depth (presets / sugar /
  // `maxEnumSize` degradation) up front, then thread both through `inner`.
  const selected = selectFunctions(registry, options.functions);
  const depth = resolveDepth(options, {
    typeCount: types.length,
    fieldCount: uniqueFieldNames(types).length,
    fnCount: maxFunctionGroup(selected),
  });

  // The shared options bag whose lazy slots close the recursion. `Expr` /
  // `Query` are filled below; each class's `toSchema(opts)` reads `depth` /
  // `functions` / `types` / `Expr` to render its (depth-aware) child positions.
  const inner: SchemaOptions = {
    registry,
    types: [...types],
    depth,
    functions: selected,
    includeDocs: options.includeDocs,
    Expr: z.never(),
    Query: z.never(),
  };

  // "Any expression" — recursive, so wrap in z.lazy.
  inner.Expr = z.lazy(() => buildExprUnion(registry, inner, types, selected));

  // A Type reference: an enum of names when `typeNames: 'enum'`, else a string.
  // (`SchemaOptions` has no `Type` slot — query exprs never embed a Type
  // definition, so it lives only as this local.)
  const typeRef: z.ZodTypeAny =
    depth.typeNames === 'enum'
      ? enumOf(typeNames).describe('A registered Type name.')
      : z.string().describe('A Type name.');

  // ─── Query building blocks (no class has its own `toSchema`, so build
  //     them here against the lazy Expr / Query slots) ──────────────────────
  const Expr = inner.Expr;
  const Query: z.ZodTypeAny = z.lazy(() => QueryUnion);
  // Close the recursion for subquery positions inside exprs (`exists` / `in`):
  // their `static toSchema` reads `inner.Query`, which until now stayed the
  // placeholder `z.never()` — leaving an unconvertible `ZodNever` in the
  // generated schema. Point it at the real lazy Query union so subqueries are
  // expressible and the schema converts cleanly.
  inner.Query = Query;

  // Three source shapes. The plain `type` source has NO `as` — it is always
  // bound under its type name, so field-refs reference it by that name (the
  // common, alias-free path the paired field-ref schema assumes). The
  // `aliased` escape hatch carries an explicit `as` for self-joins / collision
  // breaks, and `subquery` is always aliased.
  const sourceBranches: z.ZodTypeAny[] = [
    z
      .object({ kind: z.literal('type'), type: typeRef })
      .describe('A type source, bound under (and referenced by) its type name.'),
    z
      .object({
        kind: z.literal('aliased'),
        type: typeRef,
        as: z.string().describe('Custom source name (self-join / collision break).'),
      })
      .describe('An explicitly-aliased type source (the discouraged escape hatch).'),
    z
      .object({
        kind: z.literal('subquery'),
        query: Query,
        as: z.string().describe('Required alias for the derived source.'),
      })
      .describe('A derived (subquery) source.'),
  ];
  // CAPABILITY GATE: a table-valued-function source is only offered when at
  // least one TABULAR function is registered (else it can never resolve).
  if (selected.tabular.length > 0) {
    const fnName =
      depth.functions === 'open'
        ? z.string().describe('A registered tabular function name.')
        : enumOf(selected.tabular.map((f) => f.name)).describe('A registered tabular function name.');
    sourceBranches.push(
      z
        .object({
          kind: z.literal('function'),
          function: fnName,
          args: z.record(z.string(), Expr).describe('Arguments keyed by declared parameter name.'),
          as: z.string().describe('Required alias the produced rows bind under.'),
        })
        .describe('A table-valued function source: FROM fn(args) AS alias.'),
    );
  }
  const Source: z.ZodTypeAny = orFold(sourceBranches).describe(
    'A FROM / JOIN source: a type, an aliased type, a subquery, or a table-valued function.',
  );

  // A join's `on` is a depth-aware `{ source, relation-field }` ref (the SAME
  // unified helper field-refs use, with relations-only eligibility). Whether any
  // join is expressible AT ALL is gated below on the Select schema.
  const hasRelations = types.some((t) => t.relationFields().length > 0);
  const Join: z.ZodTypeAny = z
    .object({
      on: joinOnSchema(types, depth.refs),
      as: z.string().optional(),
      and: Expr.optional(),
      joinType: enumOf(['inner', 'left', 'right', 'full']).optional(),
    })
    .describe('A relation-based JOIN over a single relation hop (key synthesized from the relation).');

  // Gate the `joins` array out when NO Type has a relation: a relationless type
  // set can't express any join, so `joins` accepts only an empty / absent list
  // (a present hop is rejected) rather than offering an unusable construct.
  const joinsField: z.ZodTypeAny = hasRelations
    ? z.array(Join).optional()
    : z.array(z.never()).optional();

  const Order: z.ZodTypeAny = z
    .object({
      expr: Expr,
      dir: enumOf(['asc', 'desc']),
      nulls: enumOf(['first', 'last']).optional(),
    })
    .describe('An ORDER BY entry.');

  // An `output` reference — a SELECT output field named by string — is offered
  // ONLY in a SELECT's groupBy / orderBy / having (never in the general Expr
  // union, so it can't appear in WHERE / expr args). `name` is QUERY-LOCAL, so
  // it stays a plain string regardless of depth.
  const OutputRef: z.ZodTypeAny = z
    .object({ kind: z.literal('output'), name: z.string() })
    .describe('A reference to a SELECT output field by name (its `as`, or the natural derived name).');
  // A groupBy / having expression OR an output-field reference.
  const GroupExpr: z.ZodTypeAny = Expr.or(OutputRef);
  // A SELECT ORDER BY entry whose `expr` may also be an output-field reference.
  const SelectOrder: z.ZodTypeAny = z
    .object({
      expr: GroupExpr,
      dir: enumOf(['asc', 'desc']),
      nulls: enumOf(['first', 'last']).optional(),
    })
    .describe('An ORDER BY entry (its `expr` may reference a SELECT output field by name).');

  const SelectField: z.ZodTypeAny = z
    .object({ expr: Expr, as: z.string().optional() })
    .describe('A selected output field.');

  const FieldValue: z.ZodTypeAny = z.object({ field: z.string(), value: Expr });

  const limitOffset: z.ZodTypeAny = z.number().or(paramSchema());

  const Select: z.ZodTypeAny = z
    .object({
      kind: z.literal('select'),
      distinct: z.boolean().optional(),
      fields: z.array(SelectField),
      from: Source,
      joins: joinsField,
      where: z.array(Expr).optional(),
      groupBy: z.array(GroupExpr).optional(),
      having: z.array(GroupExpr).optional(),
      order: z.array(SelectOrder).optional(),
      limit: limitOffset.optional(),
      offset: limitOffset.optional(),
      // `includeTotal` is an EXECUTION-time option (engine.run / engine.toSQL),
      // not a SELECT field — so it is intentionally absent here.
    })
    .meta({ aid: 'Query_select' })
    .describe('A SELECT statement.');

  // An on-conflict update assignment may additionally reference the PROPOSED
  // (excluded) row via `{ kind:'excluded', field }` — folded in only here (the
  // `excluded` expr is gated out of the general Expr union).
  const ExcludedExprSchema: z.ZodTypeAny = z
    .object({ kind: z.literal('excluded'), field: z.string() })
    .describe('The proposed row inside ON CONFLICT DO UPDATE (EXCLUDED.<field>).');
  const ConflictFieldValue: z.ZodTypeAny = z.object({ field: z.string(), value: Expr.or(ExcludedExprSchema) });

  const OnConflict: z.ZodTypeAny = z.object({
    fields: z.array(z.string()),
    doNothing: z.boolean().optional(),
    update: z.array(ConflictFieldValue).optional(),
  });

  const Insert: z.ZodTypeAny = z
    .object({
      kind: z.literal('insert'),
      into: typeRef,
      fields: z.array(z.string()),
      values: z.array(z.array(Expr)).optional(),
      select: Query.optional(),
      returning: z.array(SelectField).optional(),
      onConflict: OnConflict.optional(),
    })
    .meta({ aid: 'Query_insert' })
    .describe('An INSERT statement.');

  const Update: z.ZodTypeAny = z
    .object({
      kind: z.literal('update'),
      type: typeRef,
      set: z.array(FieldValue),
      joins: joinsField,
      where: z.array(Expr).optional(),
      returning: z.array(SelectField).optional(),
    })
    .meta({ aid: 'Query_update' })
    .describe('An UPDATE statement.');

  const Delete: z.ZodTypeAny = z
    .object({
      kind: z.literal('delete'),
      from: typeRef,
      joins: joinsField,
      where: z.array(Expr).optional(),
      returning: z.array(SelectField).optional(),
    })
    .meta({ aid: 'Query_delete' })
    .describe('A DELETE statement.');

  const SetOperation: z.ZodTypeAny = z
    .object({
      kind: enumOf(['union', 'intersect', 'except']),
      left: Query,
      right: Query,
      all: z.boolean().optional(),
      // SET-LEVEL ordering / pagination applied AFTER the set op; ORDER BY terms
      // reference OUTPUT COLUMN names (a set op has no table to qualify).
      order: z.array(Order).optional(),
      limit: limitOffset.optional(),
      offset: limitOffset.optional(),
    })
    .meta({ aid: 'Query_set-operation' })
    .describe('A UNION / INTERSECT / EXCEPT set operation.');

  // A CTE entry is EITHER a plain `{ name, query }` or a recursive
  // `{ name, base, recursive }` (structurally discriminated by `base`).
  const CteEntry: z.ZodTypeAny = orFold([
    z.object({ name: z.string(), query: Query }).describe('A non-recursive CTE.'),
    z
      .object({ name: z.string(), base: Query, recursive: Query })
      .describe('A recursive CTE: a base seed UNION-ed with a recursive arm.'),
  ]);

  const CTE: z.ZodTypeAny = z
    .object({
      kind: z.literal('cte'),
      ctes: z.array(CteEntry),
      final: Query,
    })
    .meta({ aid: 'Query_cte' })
    .describe('A WITH (CTE) statement.');

  const ExprQuery: z.ZodTypeAny = z
    .object({ kind: z.literal('expr'), expr: Expr })
    .meta({ aid: 'Query_expr' })
    .describe('A single-expression query.');

  const QueryUnion: z.ZodTypeAny = orFold([
    Select,
    Insert,
    Update,
    Delete,
    SetOperation,
    CTE,
    ExprQuery,
  ]).describe('Any query: select / insert / update / delete / set-op / cte / expr.');

  const filtersForType = (typeName: string): z.ZodTypeAny => {
    const type = registry.type(typeName);
    if (!type) throw new Error(`buildSchemas.filtersForType: unknown type '${typeName}'.`);
    return strictFilterClauseSchema(type);
  };

  return {
    Type: typeRef,
    Expr,
    Source,
    Join,
    Order,
    SelectField,
    Select,
    Insert,
    Update,
    Delete,
    SetOperation,
    CTE,
    ExprQuery,
    Query: QueryUnion,
    filtersForType,
  };
}

/**
 * Whether the structured query schema should be ABANDONED for a plain
 * natural-language string, because there are too many Types to enumerate
 * usefully (mirrors cletus's `shouldUseStringSchema`).
 */
export function shouldUseStringSchema(
  types: readonly Type[],
  max: number = DEFAULT_MAX_QUERY_SCHEMA_TYPES,
): boolean {
  return types.length > max;
}

/** Options for `querySchema`. */
export interface QuerySchemaOptions extends BuildSchemasOptions {
  /** Type-count threshold for the string fallback. Default 5. */
  max?: number;
}

/**
 * The schema for a tool's `query` input: a `{ query: <structured> }` object
 * when the Type count is within `max`, else `{ query: z.string() }` — the
 * caller's LLM describes the query in prose and a later pass structures it.
 */
export function querySchema(
  engine: QueryEngine | Registry,
  options: QuerySchemaOptions = {},
): z.ZodTypeAny {
  const registry = toRegistry(engine);
  const types = options.types ?? registry.typeList();
  const max = options.max ?? DEFAULT_MAX_QUERY_SCHEMA_TYPES;
  if (shouldUseStringSchema(types, max)) {
    return z.object({
      query: z
        .string()
        .describe(
          'A detailed natural-language description of the query: which Types are involved, ' +
            'filter conditions, known record IDs, and the precise outcome desired. ' +
            'Do not emit a structured query — there are too many Types to enumerate.',
        ),
    });
  }
  const schemas = buildSchemas(registry, options);
  return z.object({
    query: schemas.Query.describe('The query to execute as a structured Query object.'),
  });
}

/**
 * Resolve the caller's `buildSchemas` options into the SAME concrete per-axis
 * `ResolvedSchemaDepth` the generated schema uses (presets + `strict` sugar +
 * `maxEnumSize` degradation). Exposed so prompt-builders (`buildQueryTool`) can
 * describe the active depth and stay in lock-step with the schema.
 */
export function resolveSchemaDepth(
  engine: QueryEngine | Registry,
  options: BuildSchemasOptions = {},
): ResolvedSchemaDepth {
  const registry = toRegistry(engine);
  const types = options.types ?? registry.typeList();
  const selected = selectFunctions(registry, options.functions);
  return resolveDepth(options, {
    typeCount: types.length,
    fieldCount: uniqueFieldNames(types).length,
    fnCount: maxFunctionGroup(selected),
  });
}

/**
 * A short, LLM-facing note describing which query positions the ACTIVE schema
 * depth constrains, so the prompt and the schema agree. Returns `''` when every
 * axis is `open` (free-string mode — nothing to flag). Resolution mirrors
 * `buildSchemas` exactly (including `maxEnumSize` auto-degrade), so the note is
 * never tighter than the schema actually is.
 */
export function depthInstructions(
  engine: QueryEngine | Registry,
  options: BuildSchemasOptions = {},
): string {
  const depth = resolveSchemaDepth(engine, options);
  const notes: string[] = [];

  switch (depth.refs) {
    case 'paired':
      notes.push(
        'Field references are CONSTRAINED: `source` must be a known Type name and `field` must be one of THAT Type’s fields (a `field-ref` cannot mix one Type’s source with another Type’s field).',
      );
      break;
    case 'both':
      notes.push('Field references use known Type names for `source` and known field names for `field`.');
      break;
    case 'types':
      notes.push('A field reference’s `source` must be a known Type name.');
      break;
    case 'fields':
      notes.push('A field reference’s `field` must be a known field name.');
      break;
    case 'open':
      break;
  }

  if (depth.typeNames === 'enum') {
    notes.push('Type-name positions (FROM / INTO / UPDATE / DELETE) must be one of the registered Type names.');
  }

  switch (depth.functions) {
    case 'typed':
      notes.push(
        'Function / aggregate / window calls are limited to the functions listed above; each call’s `args` must be that function’s declared NAMED parameters (no unknown argument names).',
      );
      break;
    case 'names':
      notes.push('Function names (in function-call / aggregate / window / tabular calls) must be one of the functions listed above.');
      break;
    case 'open':
      break;
  }

  if (depth.filters === 'paired') {
    notes.push('Filter clauses are locked to valid `(field, op)` pairs for the field’s type.');
  }

  return notes.join('\n');
}
