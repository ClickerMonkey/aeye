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
 *  - `refs`      — `field-ref` / join `on` (`open` → `paired`);
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
import { withAid } from '../aids';
import type { Registry } from '../registry';
import type { QueryEngine } from '../engine';
import type { Type } from '../type';
import type { SchemaOptions, ResolvedSchemaDepth, RefDepth, NameDepth, FnDepth, FilterDepth, SelectedFunctions } from '../node';
import type { FieldBacking } from '../backing';
import { requiredOnInsert } from '../write-model';
import {
  enumOf,
  orFold,
  refSchema,
  relationFieldsOf,
  selectFunctions,
  exprKindApplicable,
  SchemaCache,
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
  /** `field-ref` / join `on` reference tightness. */
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
 * The RELATION branch of a join `on` at a `RefDepth` — `{ kind:'relation',
 * source, field, as }`, `field` restricted to the source's relations and `as`
 * the REQUIRED alias the joined target binds under. A manual (source-def) join
 * `on` reuses the FROM `Source` union (added alongside this in `buildSchemas`).
 */
function relationOnSchema(types: readonly Type[], depth: RefDepth, cache?: SchemaCache): z.ZodTypeAny {
  return refSchema(types, depth, {
    keyName: 'source',
    fieldMode: 'one',
    eligible: relationFieldsOf,
    extras: {
      kind: z.literal('relation'),
      as: z.string().describe('Required alias the joined target binds under.'),
    },
    aid: 'JoinOn',
    describe: 'Cross a relation field of a bound source (key synthesized from the relation).',
  }, cache);
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
  return withAid(orFold(applicable.map((c) => c.toSchema(inner))), 'Expr', {
    kinds: applicable.map((c) => c.KIND),
  });
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

  // A per-generation cache of shared, `meta.id`-tagged fragment instances (each
  // Type's field-name enum, the `param` expr) so the generated JSON-Schema
  // factors the largest repeated fragments into single `$def`s + `$ref`s instead
  // of inlining every copy. Threaded on `inner` so every expr class's
  // `toSchema` reuses the SAME instances.
  const cache = new SchemaCache();

  // The shared options bag whose lazy slots close the recursion. `Expr` /
  // `Query` are filled below; each class's `toSchema(opts)` reads `depth` /
  // `functions` / `types` / `Expr` to render its (depth-aware) child positions.
  const inner: SchemaOptions = {
    registry,
    types: [...types],
    depth,
    functions: selected,
    includeDocs: options.includeDocs,
    cache,
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
      ? withAid(enumOf(typeNames), 'TypeName').describe('A registered Type name.')
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
        : withAid(enumOf(selected.tabular.map((f) => f.name)), 'FunctionName').describe(
            'A registered tabular function name.',
          );
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
  const sourceKinds: string[] = selected.tabular.length > 0
    ? ['type', 'aliased', 'subquery', 'function']
    : ['type', 'aliased', 'subquery'];
  const Source: z.ZodTypeAny = withAid(orFold(sourceBranches), 'Source', {
    kinds: sourceKinds,
  }).describe(
    'A FROM / JOIN source: a type, an aliased type, a subquery, or a table-valued function.',
  );

  // A join's `on` is EITHER a `relation` crossing (`{ kind:'relation', source,
  // field, as }`, key synthesized from the relation) OR a MANUAL join adding a
  // source directly (the SAME `Source` union the FROM uses) with `and` as the ON
  // condition. Whether any join is expressible is gated below on the Select
  // schema (a relationless type set still allows the manual source-def forms).
  const hasRelations = types.some((t) => t.relationFields().length > 0);
  const relationOn = relationOnSchema(types, depth.refs, cache);
  const JoinOn: z.ZodTypeAny = withAid(
    hasRelations ? orFold([relationOn, Source]) : Source,
    'JoinOn',
    { kinds: ['relation', ...sourceKinds] },
  ).describe('A join target: a relation crossing or a manually-joined source.');
  const Join: z.ZodTypeAny = withAid(
    z.object({
      on: JoinOn,
      and: Expr.optional(),
      joinType: withAid(enumOf(['inner', 'left', 'right', 'full']), 'JoinType').optional(),
    }),
    'Join',
  ).describe('A JOIN: a relation crossing (key synthesized) or a manual source-def join with `and` as its ON.');

  // Gate the `joins` array out when NO Type has a relation: a relationless type
  // set can't express any join, so `joins` accepts only an empty / absent list
  // (a present hop is rejected) rather than offering an unusable construct.
  const joinsField: z.ZodTypeAny = hasRelations
    ? z.array(Join).optional()
    : z.array(z.never()).optional();

  const Order: z.ZodTypeAny = z
    .object({
      expr: Expr,
      dir: withAid(enumOf(['asc', 'desc']), 'OrderDir'),
      nulls: withAid(enumOf(['first', 'last']), 'OrderNulls').optional(),
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
      dir: withAid(enumOf(['asc', 'desc']), 'OrderDir'),
      nulls: withAid(enumOf(['first', 'last']), 'OrderNulls').optional(),
    })
    .describe('An ORDER BY entry (its `expr` may reference a SELECT output field by name).');

  const SelectField: z.ZodTypeAny = z
    .object({ expr: Expr, as: z.string().optional() })
    .describe('A selected output field.');

  const FieldValue: z.ZodTypeAny = z.object({ field: z.string(), value: Expr });

  // `limitOffset` is reused across Select / SetOp limit+offset; the `id: 'Limit'`
  // factors it into a single shared `$def` instead of inlining each of the four
  // uses, and its `param` branch is the shared cached `param` fragment.
  const limitOffset: z.ZodTypeAny = withAid(z.number().or(cache.param()), 'Limit', { id: cache.defId('Limit') });

  const Select: z.ZodTypeAny = withAid(
    z.object({
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
    }),
    'Query_select',
  ).describe('A SELECT statement.');

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

  // ─── WRITE MODEL: per-Type write permissions drive the DML schemas ─────────
  //
  // A Type/field is INSERTABLE / UPDATABLE / DELETABLE (default true); a field's
  // backing (computed / default) further shapes its effective write status +
  // insert-requiredness. These schemas: (1) restrict each DML target's Type-name
  // enum to the permitted subset; (2) at `refs:'paired'` restrict `Insert.fields`
  // / `Update.set` to the permitted FIELDS and require the required-on-insert
  // ones; (3) DROP a DML query kind entirely when NO Type permits it.
  const insertableTypes = types.filter((t) => t.insertable);
  const updatableTypes = types.filter((t) => t.updatable);
  const deletableTypes = types.filter((t) => t.deletable);
  /** The FieldBacking for `typeName.field` off the registry, or `undefined`. */
  const fbOf = (typeName: string, field: string): FieldBacking | undefined =>
    registry.backing(typeName)?.fields?.[field];
  /** A DML target Type-name schema over a permitted subset (enum when `typeNames:'enum'`). */
  const dmlTypeRef = (subset: readonly Type[]): z.ZodTypeAny =>
    depth.typeNames === 'enum'
      ? enumOf(subset.map((t) => t.name)).describe('A permitted target Type name.')
      : z.string().describe('A Type name.');

  /** The paired-per-Type INSERT: `into` pinned, `fields` restricted + required-enforced. */
  const pairedInsert = (): z.ZodTypeAny =>
    orFold(
      insertableTypes.map((t) => {
        const insertable = t.fields.filter((f) => f.insertableFor(fbOf(t.name, f.name)));
        const requiredNames = insertable
          .filter((f) => requiredOnInsert(f, fbOf(t.name, f.name)))
          .map((f) => f.name);
        const fieldEnum = insertable.length ? enumOf(insertable.map((f) => f.name)) : z.never();
        const fieldsArray = z
          .array(fieldEnum)
          .describe(requiredNames.length ? `Insertable fields; required: ${requiredNames.join(', ')}.` : 'Insertable fields.');
        // REQUIRED-on-insert fields must all be present (optional / defaulted ones may be omitted).
        const fields = requiredNames.length
          ? fieldsArray.refine((arr) => requiredNames.every((n) => arr.some((x) => x === n)), {
              message: `Missing required field(s): ${requiredNames.join(', ')}.`,
            })
          : fieldsArray;
        return z
          .object({
            kind: z.literal('insert'),
            into: z.literal(t.name),
            fields,
            values: z.array(z.array(Expr)).optional(),
            select: Query.optional(),
            returning: z.array(SelectField).optional(),
            onConflict: OnConflict.optional(),
          })
          .describe(`An INSERT into ${t.name}.`);
      }),
    ).describe('An INSERT statement.');

  const Insert: z.ZodTypeAny =
    depth.refs === 'paired'
      ? pairedInsert()
      : withAid(
          z.object({
            kind: z.literal('insert'),
            into: dmlTypeRef(insertableTypes),
            fields: z.array(z.string()),
            values: z.array(z.array(Expr)).optional(),
            select: Query.optional(),
            returning: z.array(SelectField).optional(),
            onConflict: OnConflict.optional(),
          }),
          'Query_insert',
        ).describe('An INSERT statement.');

  /** The paired-per-Type UPDATE: `type` pinned, `set.field` restricted to updatable fields. */
  const pairedUpdate = (): z.ZodTypeAny =>
    orFold(
      updatableTypes.map((t) => {
        const updatable = t.fields.filter((f) => f.updatableFor(fbOf(t.name, f.name)));
        const fieldEnum = updatable.length ? enumOf(updatable.map((f) => f.name)) : z.never();
        return z
          .object({
            kind: z.literal('update'),
            type: z.literal(t.name),
            set: z.array(z.object({ field: fieldEnum, value: Expr })),
            joins: joinsField,
            where: z.array(Expr).optional(),
            returning: z.array(SelectField).optional(),
          })
          .describe(`An UPDATE of ${t.name}.`);
      }),
    ).describe('An UPDATE statement.');

  const Update: z.ZodTypeAny =
    depth.refs === 'paired'
      ? pairedUpdate()
      : withAid(
          z.object({
            kind: z.literal('update'),
            type: dmlTypeRef(updatableTypes),
            set: z.array(FieldValue),
            joins: joinsField,
            where: z.array(Expr).optional(),
            returning: z.array(SelectField).optional(),
          }),
          'Query_update',
        ).describe('An UPDATE statement.');

  const Delete: z.ZodTypeAny = withAid(
    z.object({
      kind: z.literal('delete'),
      from: dmlTypeRef(deletableTypes),
      joins: joinsField,
      where: z.array(Expr).optional(),
      returning: z.array(SelectField).optional(),
    }),
    'Query_delete',
  ).describe('A DELETE statement.');

  const SetOperation: z.ZodTypeAny = withAid(
    z.object({
      kind: withAid(enumOf(['union', 'intersect', 'except']), 'SetOpKind'),
      left: Query,
      right: Query,
      all: z.boolean().optional(),
      // SET-LEVEL ordering / pagination applied AFTER the set op; ORDER BY terms
      // reference OUTPUT COLUMN names (a set op has no table to qualify).
      order: z.array(Order).optional(),
      limit: limitOffset.optional(),
      offset: limitOffset.optional(),
    }),
    'Query_set-operation',
  ).describe('A UNION / INTERSECT / EXCEPT set operation.');

  // A CTE entry is EITHER a plain `{ name, query }` or a recursive
  // `{ name, base, recursive }` (structurally discriminated by `base`).
  const CteEntry: z.ZodTypeAny = orFold([
    z.object({ name: z.string(), query: Query }).describe('A non-recursive CTE.'),
    z
      .object({ name: z.string(), base: Query, recursive: Query })
      .describe('A recursive CTE: a base seed UNION-ed with a recursive arm.'),
  ]);

  const CTE: z.ZodTypeAny = withAid(
    z.object({
      kind: z.literal('cte'),
      ctes: z.array(CteEntry),
      final: Query,
    }),
    'Query_cte',
  ).describe('A WITH (CTE) statement.');

  const ExprQuery: z.ZodTypeAny = withAid(
    z.object({ kind: z.literal('expr'), expr: Expr }),
    'Query_expr',
  ).describe('A single-expression query.');

  // QUERY-KIND GATING: a DML kind is offered only when SOME registered Type
  // permits it (no insertable Type ⇒ no `insert`, etc.), so the model is never
  // shown an unusable statement.
  const queryBranches: z.ZodTypeAny[] = [Select];
  const queryKinds: string[] = ['select'];
  if (insertableTypes.length > 0) {
    queryBranches.push(Insert);
    queryKinds.push('insert');
  }
  if (updatableTypes.length > 0) {
    queryBranches.push(Update);
    queryKinds.push('update');
  }
  if (deletableTypes.length > 0) {
    queryBranches.push(Delete);
    queryKinds.push('delete');
  }
  queryBranches.push(SetOperation, CTE, ExprQuery);
  queryKinds.push('union', 'intersect', 'except', 'cte', 'expr');
  const QueryUnion: z.ZodTypeAny = withAid(orFold(queryBranches), 'Query', {
    kinds: queryKinds,
  }).describe('Any query: select / insert / update / delete / set-op / cte / expr.');

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
    notes.push('A `filters` placeholder’s `source` must be a known Type name and its optional `fields` allowlist must name that Type’s fields.');
  }

  return notes.join('\n');
}
