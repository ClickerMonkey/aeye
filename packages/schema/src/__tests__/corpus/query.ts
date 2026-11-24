/**
 * @aeye/query's model schemas, ported to `a`.
 *
 * Source: packages/query/src/llm/schemas.ts (`buildSchemas`, `querySchema`,
 * `resolveDepth` and the degrade ladders), src/schema-build.ts (`refSchema`,
 * the per-kind ref schemas, `functionExprSchema`, `insertRowSchema`,
 * `updateSetSchema`, `sorterSchema`, `selectFunctions`, `exprKindApplicable`,
 * `SchemaCache`), every expr kind's `static toSchema` (src/exprs/*.ts) and
 * the field types' `toValueSchema` (src/field-types/*.ts).
 *
 * The zod original threads lazy `Expr`/`Query` slots through a `SchemaOptions`
 * bag and is rebuilt per call. In `a` it is ONE chain built once:
 *
 * - the catalog-independent grammar (`binary`, `comparison`, `case`, `in`,
 *   the SELECT / set-op / CTE statements, ORDER BY, the sorter...) is static
 *   named types, recursive through `a.ref('Expr')` / `a.ref('Query')`;
 * - everything the catalog or the per-axis DEPTH changes (which expr kinds
 *   exist — the capability gate —, field refs at each `RefDepth`, function
 *   calls at each `FnDepth`, type names, sources, join targets, the DML
 *   statements and their typed rows) comes from the dynamic step, keyed by
 *   the catalog version and the options;
 * - `SchemaCache`'s shared fragments (`Fields_<Type>`, `Args_<signature>`,
 *   `param`, `Limit`) are NAMED types, so they are emitted once as `$defs`
 *   exactly as the cache makes zod's converter do.
 *
 * The code type is query's own: `Query` is `QueryDef`, `Expr` is `ExprDef`
 * minus the kinds a model is never offered — proven at the bottom of this
 * file against the types imported from `@aeye/query`.
 */
import { expectTypeOf } from 'expect-type';
import type {
  DeleteDef, ExprDef, FieldTypeDef, InsertDef, JoinDef, JoinOnDef, JsonValue as QueryJson, OrderDef, QueryDef, SelectDef,
  SelectFieldDef, SetOperationDef, SourceDef, UpdateDef, WriteValueDef,
} from '@aeye/query';
import { a, type AnySchema, type SchemaOf } from '../../index';

// ============================================================================
// The catalog: what the registry knows, as data
// ============================================================================

/** schema-build.ts `FnExprKind` + the ref kinds whose field eligibility a field may restrict. */
export type GatedKind = 'field-ref' | 'semantic' | 'text-search' | 'text-score' | 'filters' | 'array-op';

export interface CatalogField {
  readonly name: string;
  /** `field.fieldType.toJSON()`: drives the typed write value (`toValueSchema`). */
  readonly type: FieldTypeDef;
  readonly nullable: boolean;
  /** `field.allowsExpr(kind)`: the field's `exprs` restriction plus the type floor. */
  readonly allows: Readonly<Record<GatedKind, boolean>>;
  /** In `type.relationFields()` / `semanticFields()` / `textFields()`. */
  readonly relation: boolean;
  readonly semantic: boolean;
  readonly text: boolean;
  /** `field.insertableFor(backing)` / `updatableFor(backing)` / `requiredOnInsert(field, backing)`. */
  readonly insertable: boolean;
  readonly updatable: boolean;
  readonly requiredOnInsert: boolean;
}

export interface CatalogType {
  readonly name: string;
  readonly fields: readonly CatalogField[];
  readonly insertable: boolean;
  readonly updatable: boolean;
  readonly deletable: boolean;
  /** `type.isSearchable()` / `type.isSemantic()`. */
  readonly searchable: boolean;
  readonly semantic: boolean;
}

export type FunctionShape = 'scalar' | 'tabular' | 'window' | 'aggregate';
export interface CatalogFunction {
  readonly name: string;
  readonly shape: FunctionShape;
  readonly params: readonly { readonly name: string; readonly optional?: boolean }[];
}

export interface CatalogOperator {
  readonly name: string;
  readonly operands: readonly string[];
  /** `${signatureOf(op)} — ${op.instructions}` (exprs/operator.ts). */
  readonly glossary: string;
  /** `operatorReachable(op, types)` (schema-build.ts). */
  readonly reachable: boolean;
}

export interface QueryCatalog {
  /** Bumped when the registry changes; the bind cache key. */
  readonly version: string | number;
  readonly types: readonly CatalogType[];
  readonly functions: readonly CatalogFunction[];
  readonly operators: readonly CatalogOperator[];
}

// ============================================================================
// Depth (llm/schemas.ts, node.ts) — ported verbatim
// ============================================================================

export type RefDepth = 'open' | 'types' | 'fields' | 'both' | 'paired';
export type NameDepth = 'open' | 'enum';
export type FnDepth = 'open' | 'names' | 'typed';
export type FilterDepth = 'open' | 'paired';
export type WriteDepth = 'open' | 'names' | 'typed';

export interface ResolvedDepth {
  readonly refs: RefDepth;
  readonly typeNames: NameDepth;
  readonly functions: FnDepth;
  readonly filters: FilterDepth;
  readonly writes: WriteDepth;
}
export type SchemaDepth = Partial<ResolvedDepth>;

type Pick3 = string[] | 'all' | 'none';
export type FunctionSelector = 'all' | 'none' | string[] | { scalar?: Pick3; tabular?: Pick3; window?: Pick3; aggregate?: Pick3 };

/** llm/schemas.ts `BuildSchemasOptions`. */
export interface BuildOptions {
  readonly depth?: SchemaDepth | 'open' | 'paired';
  readonly functions?: FunctionSelector;
  readonly maxEnumSize?: number;
  /** Deprecated sugar: `true` ⇒ `'paired'`. */
  readonly strict?: boolean;
  /** Restrict the enumerated Types to these names (default: every Type). */
  readonly types?: readonly string[];
}

function expandPreset(preset: 'open' | 'paired'): ResolvedDepth {
  return preset === 'paired'
    ? { refs: 'paired', typeNames: 'enum', functions: 'typed', filters: 'paired', writes: 'typed' }
    : { refs: 'open', typeNames: 'open', functions: 'open', filters: 'open', writes: 'open' };
}

function presetBase(o: BuildOptions): 'open' | 'paired' {
  if (o.depth === 'paired') return 'paired';
  if (o.depth === 'open') return 'open';
  return o.strict === true ? 'paired' : 'open';
}

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

function degradeFns(d: FnDepth, n: number, max: number): FnDepth {
  let depth = d;
  if (depth === 'typed' && n > max) depth = 'names';
  if (depth === 'names' && n > max) depth = 'open';
  return depth;
}

/** llm/schemas.ts `resolveDepth`: preset, overlay, then `maxEnumSize` degradation. */
export function resolveDepth(o: BuildOptions, counts: { typeCount: number; fieldCount: number; fnCount: number }): ResolvedDepth {
  const base = expandPreset(presetBase(o));
  const d: ResolvedDepth = typeof o.depth === 'object'
    ? {
        refs: o.depth.refs ?? base.refs,
        typeNames: o.depth.typeNames ?? base.typeNames,
        functions: o.depth.functions ?? base.functions,
        filters: o.depth.filters ?? base.filters,
        writes: o.depth.writes ?? base.writes,
      }
    : base;
  if (o.maxEnumSize === undefined) return d;
  const max = o.maxEnumSize;
  return {
    refs: degradeRefs(d.refs, counts.typeCount, counts.fieldCount, max),
    typeNames: d.typeNames === 'enum' && counts.typeCount > max ? 'open' : d.typeNames,
    functions: degradeFns(d.functions, counts.fnCount, max),
    filters: d.filters === 'paired' && counts.fieldCount > max ? 'open' : d.filters,
    writes: degradeFns(d.writes, counts.fieldCount, max),
  };
}

export interface SelectedFunctions {
  readonly scalar: readonly CatalogFunction[];
  readonly tabular: readonly CatalogFunction[];
  readonly window: readonly CatalogFunction[];
  readonly aggregate: readonly CatalogFunction[];
}

/** schema-build.ts `selectFunctions`. */
export function selectFunctions(fns: readonly CatalogFunction[], selector: FunctionSelector = 'all'): SelectedFunctions {
  const byShape = (shape: FunctionShape) => fns.filter((f) => f.shape === shape);
  const pick = (available: CatalogFunction[], sel: Pick3) => (sel === 'none' ? [] : sel === 'all' ? available : available.filter((f) => sel.includes(f.name)));
  if (selector === 'all' || selector === 'none' || Array.isArray(selector)) {
    const sel: Pick3 = selector;
    return { scalar: pick(byShape('scalar'), sel), tabular: pick(byShape('tabular'), sel), window: pick(byShape('window'), sel), aggregate: pick(byShape('aggregate'), sel) };
  }
  return {
    scalar: pick(byShape('scalar'), selector.scalar ?? 'all'),
    tabular: pick(byShape('tabular'), selector.tabular ?? 'all'),
    window: pick(byShape('window'), selector.window ?? 'all'),
    aggregate: pick(byShape('aggregate'), selector.aggregate ?? 'all'),
  };
}

/** The resolved depth for a catalog + options (`resolveSchemaDepth`). */
export function depthOf(catalog: QueryCatalog, o: BuildOptions = {}): ResolvedDepth {
  const types = typesOf(catalog, o);
  const sel = selectFunctions(catalog.functions, o.functions);
  return resolveDepth(o, {
    typeCount: types.length,
    fieldCount: new Set(types.flatMap((t) => t.fields.map((f) => f.name))).size,
    fnCount: Math.max(sel.scalar.length, sel.tabular.length, sel.window.length, sel.aggregate.length),
  });
}

const typesOf = (catalog: QueryCatalog, o: BuildOptions): readonly CatalogType[] =>
  o.types ? catalog.types.filter((t) => o.types!.includes(t.name)) : catalog.types;

// ============================================================================
// The static grammar (the expr kinds and statements no catalog changes)
// ============================================================================

const Expr = a.ref('Expr');
const Query = a.ref('Query');
const dir = a.enum(['asc', 'desc']);
const nulls = a.enum(['first', 'last']);

/** The model's own expression union: query's `ExprDef` minus the kinds kept out of it (`exprKindApplicable`). */
export type ModelExprDef = Exclude<ExprDef, { kind: 'arg' | 'output' | 'sorter' | 'excluded' }>;

const grammar = {
  // exprs/literal.ts — `value: jsonValueSchema()` (any JSON, recursive)
  Expr_literal: a.object({ kind: a.literal('literal'), value: a.json() })
    .describe('A constant value: a scalar, or a whole JSON document for a json / array field.'),
  // exprs/param.ts
  Expr_param: a.object({ kind: a.literal('param'), name: a.string().describe('Parameter name; its type is inferred from usage.') })
    .describe('A named bind parameter (contextually typed).'),
  // schema-build.ts SchemaCache.param(): the shared `param` fragment (limits, text-search queries)
  param: a.object({ kind: a.literal('param'), name: a.string() }).describe('A named bind parameter.'),
  // exprs/binary.ts
  Expr_binary: a.object({ kind: a.literal('binary'), op: a.enum(['+', '-', '*', '/', '%']), left: Expr, right: Expr })
    .describe('Arithmetic binary operation.'),
  // exprs/unary.ts
  Expr_unary: a.object({ kind: a.literal('unary'), op: a.enum(['-', '+']), operand: Expr }).describe('Unary arithmetic operation.'),
  // exprs/comparison.ts
  Expr_comparison: a.object({
    kind: a.literal('comparison'),
    op: a.enum(['=', '<>', '<', '<=', '>', '>=', 'like', 'notLike', 'ilike']),
    left: Expr,
    right: Expr,
  }).describe('Scalar comparison predicate.'),
  // exprs/logical.ts
  Expr_logical: a.object({ kind: a.literal('logical'), op: a.enum(['and', 'or', 'not']), operands: a.array(Expr) })
    .describe('Boolean connective (and / or / not).'),
  // exprs/in.ts
  Expr_in: a.object({ kind: a.literal('in'), value: Expr, in: a.union([a.array(Expr), Query]), not: a.boolean().optional() })
    .describe('Membership predicate (value IN list / subquery).'),
  // exprs/between.ts
  Expr_between: a.object({ kind: a.literal('between'), value: Expr, lower: Expr, upper: Expr, not: a.boolean().optional() })
    .describe('Range predicate (value BETWEEN lower AND upper).'),
  // exprs/is-null.ts
  'Expr_is-null': a.object({ kind: a.literal('is-null'), value: Expr, not: a.boolean().optional() })
    .describe('Null test (value IS [NOT] NULL).'),
  // exprs/exists.ts
  Expr_exists: a.object({ kind: a.literal('exists'), query: Query, not: a.boolean().optional() })
    .describe('Existence predicate over a subquery.'),
  // exprs/case.ts
  Expr_case: a.object({ kind: a.literal('case'), branches: a.array(a.object({ when: Expr, then: Expr })), else: Expr.optional() })
    .describe('Conditional CASE expression.'),
  // exprs/subquery.ts
  Expr_subquery: a.object({ kind: a.literal('subquery'), query: Query }).describe('A subquery used in value position.'),
  // exprs/array-op.ts
  'Expr_array-op': a.object({
    kind: a.literal('array-op'),
    op: a.enum(['contains', 'containsAny', 'containsAll', 'isEmpty', 'notEmpty']).describe('Array predicate: element membership / overlap / emptiness.'),
    target: Expr,
    value: a.union([Expr, a.array(Expr)]).optional()
      .describe('Single element (contains), element list (containsAny/All), or omitted (isEmpty/notEmpty).'),
  }).describe('Array containment / emptiness predicate.'),

  // llm/schemas.ts — ORDER BY, output refs, the sorter
  Order: a.object({ expr: Expr, dir, nulls: nulls.optional() }).describe('An ORDER BY entry.'),
  Expr_output: a.object({ kind: a.literal('output'), name: a.string() })
    .describe('A reference to a SELECT output field by name (its `as`, or the natural derived name).'),
  GroupExpr: a.union([Expr, a.ref('Expr_output')]),
  SelectOrder: a.object({ expr: a.ref('GroupExpr'), dir, nulls: nulls.optional() })
    .describe('An ORDER BY entry (its `expr` may reference a SELECT output field by name).'),
  // schema-build.ts sorterSchema(GroupExpr)
  Expr_sorter: a.object({
    kind: a.literal('sorter'),
    sorts: a.record(a.ref('GroupExpr')).describe('Named sortable expressions (sort name → expr); the caller selects by name at run time.'),
    defaultSort: a.array(a.object({ sort: a.string().describe('A declared sort name (a key of `sorts`).'), dir })).optional()
      .describe('Default multi-key sort (each `{ sort, dir }`) applied when the caller selects none.'),
  }).describe('A dynamic-sort catalog (valid only in a SELECT `order`); the selection is supplied at execution time.'),
  SelectOrderEntry: a.union([a.ref('SelectOrder'), a.ref('Expr_sorter')])
    .describe('A SELECT ORDER BY entry: a term, or a dynamic-sort `sorter` catalog (selection supplied at run time).'),
  SelectField: a.object({ expr: Expr, as: a.string().optional() }).describe('A selected output field.'),
  // `limitOffset` with `id: 'Limit'`: one shared $def.
  Limit: a.union([a.number(), a.ref('param')]),

  // A JOIN: a relation crossing or a manual source-def join with `and` as its ON.
  Join: a.object({ on: a.ref('JoinOn'), and: Expr.optional(), joinType: a.enum(['inner', 'left', 'right', 'full']).optional() })
    .describe('A JOIN: a relation crossing (key synthesized) or a manual source-def join with `and` as its ON.'),

  Query_select: a.object({
    kind: a.literal('select'),
    distinct: a.boolean().optional(),
    fields: a.array(a.ref('SelectField')),
    from: a.ref('Source'),
    joins: a.ref('Joins').optional(),
    where: a.array(Expr).optional(),
    groupBy: a.array(a.ref('GroupExpr')).optional(),
    having: a.array(a.ref('GroupExpr')).optional(),
    order: a.array(a.ref('SelectOrderEntry')).optional(),
    limit: a.ref('Limit').optional(),
    offset: a.ref('Limit').optional(),
  }).describe('A SELECT statement.'),

  'Query_set-operation': a.object({
    kind: a.enum(['union', 'intersect', 'except']),
    left: Query,
    right: Query,
    all: a.boolean().optional(),
    order: a.array(a.ref('Order')).optional(),
    limit: a.ref('Limit').optional(),
    offset: a.ref('Limit').optional(),
  }).describe('A UNION / INTERSECT / EXCEPT set operation.'),

  // A CTE entry: plain `{ name, query }` or recursive `{ name, base, recursive }`.
  Query_cte: a.object({
    kind: a.literal('cte'),
    ctes: a.array(a.union([
      a.object({ name: a.string(), query: Query }).describe('A non-recursive CTE.'),
      a.object({ name: a.string(), base: Query, recursive: Query }).describe('A recursive CTE: a base seed UNION-ed with a recursive arm.'),
    ])),
    final: Query,
  }).describe('A WITH (CTE) statement.'),

  Query_expr: a.object({ kind: a.literal('expr'), expr: Expr }).describe('A single-expression query.'),

  // INSERT ON CONFLICT DO UPDATE may also name the proposed row.
  Expr_excluded: a.object({ kind: a.literal('excluded'), field: a.string() })
    .describe('The proposed row inside ON CONFLICT DO UPDATE (EXCLUDED.<field>).'),
  ConflictExpr: a.union([Expr, a.ref('Expr_excluded')]),
} as const;

// ============================================================================
// The dynamic part: everything the catalog and the depth decide
// ============================================================================

/** schema-build.ts `refSchema` field modes. */
type FieldMode = 'none' | 'one' | 'optional' | 'list';

interface RefOptions {
  readonly keyName: 'source' | 'type';
  readonly fieldMode: FieldMode;
  readonly eligible: (t: CatalogType) => readonly CatalogField[];
  readonly extras?: Record<string, AnySchema>;
  readonly describe: string;
}

/** One build: the named fragments it shares (`SchemaCache`) collect here. */
class Build {
  readonly defs: Record<string, AnySchema> = {};
  private readonly byKey = new Map<string, string>();
  private readonly baseUses = new Map<string, number>();

  constructor(readonly types: readonly CatalogType[], readonly depth: ResolvedDepth, readonly selected: SelectedFunctions, readonly catalog: QueryCatalog) {}

  /** `SchemaCache.defId` + `shared`: one named type per distinct content. */
  shared(contentKey: string, idBase: string, build: () => AnySchema): string {
    let id = this.byKey.get(contentKey);
    if (!id) {
      const used = this.baseUses.get(idBase) ?? 0;
      this.baseUses.set(idBase, used + 1);
      id = used === 0 ? idBase : `${idBase}_${used + 1}`;
      this.byKey.set(contentKey, id);
      this.defs[id] = build();
    }
    return id;
  }

  /** `SchemaCache.fieldEnum`: a shared `Fields_<Type>` enum. */
  fieldEnum(names: readonly string[], hint: string): SchemaOf<string> {
    return a.refOf<string>(this.shared(`fields\u0000${names.join('\u0000')}`, `Fields_${hint}`, () => a.enum(names)));
  }

  /** `SchemaCache.typedArgs`: a shared strict args object per signature (not per function). */
  typedArgs(fn: CatalogFunction): SchemaOf<Record<string, ExprDef>> {
    const params = fn.params.map((p) => `${p.name}${p.optional ? '?' : ''}`);
    return a.refOf<Record<string, ExprDef>>(this.shared(`args ${params.join(',')}`, 'Args', () => {
      const shape: Record<string, AnySchema> = {};
      for (const p of fn.params) shape[p.name] = p.optional ? Expr.optional() : Expr;
      return a.object(shape).strict().describe(`Named arguments: ${params.length ? params.join(', ') : 'none'}.`);
    }));
  }

  /** schema-build.ts `refSchema`: every `{key, field(s)}` reference at a `RefDepth`. */
  ref(depth: RefDepth, o: RefOptions): AnySchema {
    const fieldProp = (value: SchemaOf<string>): Record<string, AnySchema> => {
      switch (o.fieldMode) {
        case 'none': return {};
        case 'one': return { field: value.describe('A field of the referenced source.') };
        case 'optional': return { field: a.optional(value).describe('A field to narrow to (omit for the whole source).') };
        case 'list': return { fields: a.array(value).optional().describe('Optional allowlist of fields the reference may touch.') };
      }
    };
    if (depth === 'paired') {
      return a.union(this.types.map((t) => {
        const names = o.eligible(t).map((f) => f.name);
        const field = names.length ? this.fieldEnum(names, t.name) : a.string();
        const key = a.literal(t.name).describe(`The \`${t.name}\` ${o.keyName} (its Type name).`);
        return a.object({ [o.keyName]: key, ...fieldProp(field), ...o.extras }).describe(`A reference into \`${t.name}\`.`);
      })).describe(o.describe);
    }
    const enumKey = depth === 'types' || depth === 'both';
    const enumField = depth === 'fields' || depth === 'both';
    const noun = o.keyName === 'type' ? 'a registered Type name' : 'a bound source name';
    const key = (enumKey ? a.enum(this.types.map((t) => t.name)) : a.string())
      .describe(enumKey ? `${noun[0]!.toUpperCase()}${noun.slice(1)}.` : `A ${o.keyName} name.`);
    const names = [...new Set(this.types.flatMap((t) => o.eligible(t).map((f) => f.name)))];
    const field = enumField && names.length ? this.fieldEnum(names, 'any') : a.string();
    return a.object({ [o.keyName]: key, ...fieldProp(field), ...o.extras }).describe(o.describe);
  }

  /** schema-build.ts `functionExprSchema`: `open` / `names` / `typed`. */
  fn(kind: 'function-call' | 'tabular-function-call' | 'aggregate' | 'window', open: AnySchema): AnySchema {
    const depth = this.depth.functions;
    if (depth === 'open') return open;
    const shape = kind === 'function-call' ? 'scalar' : kind === 'tabular-function-call' ? 'tabular' : kind;
    const fns = this.selected[shape];
    const object = (fnField: AnySchema, args: AnySchema): AnySchema => {
      const k = a.literal(kind);
      switch (kind) {
        case 'function-call': return a.object({ kind: k, function: fnField, args }).describe('A scalar function call with named arguments.');
        case 'tabular-function-call': return a.object({ kind: k, function: fnField, args }).describe('A type-valued function call (produces rows).');
        case 'aggregate': return a.object({ kind: k, function: fnField, args, distinct: a.boolean().optional() })
          .describe('Aggregate function over named args (count with empty args = count(*)).');
        case 'window': return a.object({
          kind: k, function: fnField, args,
          partitionBy: a.array(Expr).optional(),
          orderBy: a.array(a.object({ expr: Expr, dir, nulls: nulls.optional() })).optional(),
        }).describe('Window function over a partition / ordering, with named args.');
      }
    };
    if (depth === 'names') {
      return object(a.enum(fns.map((f) => f.name)).describe('A selected function name.'), a.record(Expr).describe('Arguments keyed by declared parameter name.'));
    }
    // `typed`: one branch per selected function; args optional when it has no required param.
    return a.union(fns.map((f) => {
      const args = this.typedArgs(f);
      const required = f.params.some((p) => !p.optional);
      // query's zod makes `args` OPTIONAL here, while its own `ExprDef` says `args` is always
      // present: `.default({})` keeps the wire optional AND the code shape what query's types say.
      return object(a.literal(f.name).describe(`The \`${f.name}\` function.`), required ? args : a.default(args, {}));
    }));
  }
}

/** `typeRef` / `dmlTypeRef`: an enum of names when `typeNames: 'enum'`, else a string. */
const typeName = (b: Build, subset: readonly CatalogType[], describe: string): SchemaOf<string> =>
  b.depth.typeNames === 'enum' ? a.enum(subset.map((t) => t.name)).describe(describe) : a.string().describe('A Type name.');

/** The field types' `toValueSchema` (field-types/*.ts, field-type.ts), as `a`. */
export function fieldValue(t: FieldTypeDef): SchemaOf<QueryJson> {
  const closed = (values: readonly { value: string | number | boolean | null }[] | undefined): SchemaOf<QueryJson> | undefined =>
    values?.length ? (values.length === 1 ? a.literal(values[0]!.value) : a.union(values.map((v) => a.literal(v.value)))) : undefined;
  const num = (o: { whole?: boolean; min?: number; max?: number; values?: { value: string | number | boolean | null }[] }) => {
    let s = o.whole ? a.int() : a.number();
    if (o.min !== undefined) s = s.min(o.min);
    if (o.max !== undefined) s = s.max(o.max);
    return closed(o.values) ?? s;
  };
  switch (t.kind) {
    case 'text': {
      let s = a.string();
      if (t.minLength !== undefined) s = s.min(t.minLength);
      if (t.maxLength !== undefined) s = s.max(t.maxLength);
      if (t.pattern !== undefined) s = s.pattern(t.pattern);
      return closed(t.values) ?? s;
    }
    case 'number': return num(t);
    case 'money': return num(t.number ?? {});
    case 'bool': return a.boolean();
    // date.ts / timestamp.ts: a PREFIX regex (no `$`), as query has it.
    case 'date': return a.string().pattern('^\\d{4}-\\d{2}-\\d{2}');
    case 'timestamp': return a.string().pattern('^\\d{4}-\\d{2}-\\d{2}[T ]\\d{2}:\\d{2}');
    case 'json': return a.json();
    case 'array': {
      let s = a.array(t.item ? fieldValue(t.item) : a.json());
      if (t.minItems !== undefined) s = s.min(t.minItems);
      if (t.maxItems !== undefined) s = s.max(t.maxItems);
      return s;
    }
    // relation.ts: the related row's identifier.
    case 'relation': return a.string();
  }
}

/** schema-build.ts `writeValueSchema`. */
const writeValue = (f: CatalogField, writes: 'names' | 'typed', expr: AnySchema): SchemaOf<WriteValueDef> =>
  writes === 'typed'
    ? a.union([fieldValue(f.type), expr as SchemaOf<ExprDef>]).describe(`A ${f.type.kind} value, or an expression.`)
    : (expr as SchemaOf<ExprDef>);

/** schema-build.ts `insertRowSchema` (strict: unknown / non-insertable fields are rejected). */
function insertRow(t: CatalogType, writes: 'names' | 'typed', expr: AnySchema): SchemaOf<Record<string, WriteValueDef>> {
  const shape: Record<string, AnySchema> = {};
  for (const f of t.fields) {
    if (!f.insertable) continue;
    const v = writeValue(f, writes, expr);
    shape[f.name] = writes === 'typed' && f.requiredOnInsert ? v : a.optional(v);
  }
  return a.object(shape).strict().describe(`A row to insert into ${t.name} (field → value).`) as unknown as SchemaOf<Record<string, WriteValueDef>>;
}

/** schema-build.ts `updateSetSchema` (every key optional). */
function updateSet(t: CatalogType, writes: 'names' | 'typed', expr: AnySchema): SchemaOf<Record<string, WriteValueDef>> {
  const shape: Record<string, AnySchema> = {};
  for (const f of t.fields) if (f.updatable) shape[f.name] = a.optional(writeValue(f, writes, expr));
  return a.object(shape).strict().describe(`Fields to set on ${t.name} (field → value).`) as unknown as SchemaOf<Record<string, WriteValueDef>>;
}

/** schema-build.ts `exprKindApplicable`: the capability gate. */
export function applicable(kind: string, types: readonly CatalogType[], sel: SelectedFunctions, catalog: QueryCatalog): boolean {
  switch (kind) {
    case 'operator': return catalog.operators.some((o) => o.reachable);
    case 'semantic': return types.some((t) => t.semantic);
    case 'text-search':
    case 'text-score': return types.some((t) => t.searchable);
    case 'array-op': return types.some((t) => t.fields.some((f) => f.allows['array-op']));
    case 'tabular-function-call': return sel.tabular.length > 0;
    case 'aggregate': return sel.aggregate.length > 0;
    case 'window': return sel.window.length > 0;
    case 'function-call': return sel.scalar.length > 0;
    case 'filters': return types.some((t) => t.fields.length > 0);
    case 'excluded':
    case 'output':
    case 'sorter': return false;
    default: return true;
  }
}

const allowing = (kind: GatedKind, base: (t: CatalogType) => readonly CatalogField[]) => (t: CatalogType) => base(t).filter((f) => f.allows[kind]);
const allFields = (t: CatalogType) => t.fields;
const relationFields = (t: CatalogType) => t.fields.filter((f) => f.relation);
const semanticFields = (t: CatalogType) => t.fields.filter((f) => f.semantic);
const textFields = (t: CatalogType) => t.fields.filter((f) => f.text);

/** Registry `exprClassList()` order (exprs/index.ts BUILTIN_EXPRS). */
export const EXPR_KINDS = [
  'literal', 'output', 'sorter', 'field-ref', 'param', 'binary', 'unary', 'comparison', 'logical', 'in', 'between', 'is-null',
  'exists', 'array-op', 'case', 'aggregate', 'window', 'function-call', 'tabular-function-call', 'operator', 'semantic',
  'text-search', 'text-score', 'filters', 'subquery', 'excluded',
] as const;

/**
 * The dynamic step: `buildSchemas(registry, options)` for one catalog.
 * Returns the refs the grammar leaves open, plus the shared fragments.
 */
function dynamicPart(catalog: QueryCatalog, options: BuildOptions = {}) {
  const types = typesOf(catalog, options);
  const selected = selectFunctions(catalog.functions, options.functions);
  const depth = depthOf(catalog, options);
  const b = new Build(types, depth, selected, catalog);
  const named = (args: AnySchema) => args.describe('Arguments keyed by declared parameter name.');

  // Each kind's `static toSchema`, at the resolved depth.
  const kinds: Record<string, () => AnySchema> = {
    literal: () => a.ref('Expr_literal'),
    'field-ref': () => b.ref(depth.refs, {
      keyName: 'source', fieldMode: 'one', eligible: allowing('field-ref', allFields), extras: { kind: a.literal('field-ref') },
      describe: 'A direct field reference.',
    }),
    param: () => a.ref('Expr_param'),
    binary: () => a.ref('Expr_binary'),
    unary: () => a.ref('Expr_unary'),
    comparison: () => a.ref('Expr_comparison'),
    logical: () => a.ref('Expr_logical'),
    in: () => a.ref('Expr_in'),
    between: () => a.ref('Expr_between'),
    'is-null': () => a.ref('Expr_is-null'),
    exists: () => a.ref('Expr_exists'),
    'array-op': () => a.ref('Expr_array-op'),
    case: () => a.ref('Expr_case'),
    aggregate: () => b.fn('aggregate', a.object({
      kind: a.literal('aggregate'),
      function: a.string().describe('Registered aggregate function name (count for count(*)).'),
      args: named(a.record(Expr)),
      distinct: a.boolean().optional(),
    }).describe('Aggregate function over named args (count with empty args = count(*)).')),
    window: () => b.fn('window', a.object({
      kind: a.literal('window'),
      function: a.string().describe('Registered window (or aggregate) function name.'),
      args: named(a.record(Expr)),
      partitionBy: a.array(Expr).optional(),
      orderBy: a.array(a.object({ expr: Expr, dir, nulls: nulls.optional() })).optional(),
    }).describe('Window function over a partition / ordering, with named args.')),
    'function-call': () => b.fn('function-call', a.object({
      kind: a.literal('function-call'),
      function: a.string().describe('Registered scalar function name.'),
      args: named(a.record(Expr)),
    }).describe('A scalar function call with named arguments.')),
    'tabular-function-call': () => b.fn('tabular-function-call', a.object({
      kind: a.literal('tabular-function-call'),
      function: a.string().describe('Registered tabular function name.'),
      args: named(a.record(Expr)),
    }).describe('A type-valued function call (produces rows).')),
    // exprs/operator.ts: open / names (with the glossary) / typed (strict operands per operator)
    operator: () => {
      const ops = catalog.operators;
      if (depth.functions === 'open' || !ops.length) {
        return a.object({ kind: a.literal('operator'), op: a.string().describe('Registered operator name.'), args: named(a.record(Expr)) })
          .describe('A registered operator applied to named operands.');
      }
      const glossary = ops.map((o) => o.glossary).join(' ');
      if (depth.functions === 'names') {
        return a.object({ kind: a.literal('operator'), op: a.enum(ops.map((o) => o.name)).describe(`A registered operator. ${glossary}`), args: named(a.record(Expr)) })
          .describe('A registered operator applied to named operands.');
      }
      return a.union(ops.map((o) => a.object({
        kind: a.literal('operator'),
        op: a.literal(o.name).describe(o.glossary),
        args: a.object(Object.fromEntries(o.operands.map((n) => [n, Expr]))).strict().describe(`Operands for \`${o.name}\`.`),
      }))).describe('A registered operator applied to named operands.');
    },
    // schema-build.ts semanticSchema / semanticQuerySchema
    semantic: () => b.ref(depth.refs, {
      keyName: 'source', fieldMode: 'optional', eligible: allowing('semantic', semanticFields),
      extras: {
        kind: a.literal('semantic'),
        query: a.union([
          a.string().describe('A literal natural-language query.'),
          a.ref('param'),
          b.ref(depth.refs, { keyName: 'source', fieldMode: 'one', eligible: semanticFields, describe: 'Another BOUND source + semantic field whose embedding is the query vector (cross-source pairing).' }),
          b.ref(depth.refs, { keyName: 'type', fieldMode: 'one', eligible: semanticFields, describe: 'A semantic Type + field, resolved to that Type\'s single bound source, whose embedding is the query vector.' }),
        ]).describe('The query: text, a param, a bound source+field, or a semantic Type+field.'),
      },
      describe: 'Semantic-similarity score (requires an embedder).',
    }),
    'text-search': () => b.ref(depth.refs, {
      keyName: 'source', fieldMode: 'optional', eligible: allowing('text-search', textFields),
      extras: { kind: a.literal('text-search'), query: a.union([a.string(), a.ref('param')]).describe('Search query: a literal string or a param.') },
      describe: 'Full-text search predicate.',
    }),
    'text-score': () => b.ref(depth.refs, {
      keyName: 'source', fieldMode: 'optional', eligible: allowing('text-score', textFields),
      extras: { kind: a.literal('text-score'), query: a.union([a.string(), a.ref('param')]).describe('Search query: a literal string or a param.') },
      describe: 'Numeric full-text relevance score (usable in SELECT / ORDER BY).',
    }),
    // schema-build.ts filtersSchema: no clause shapes, only {source, fields?}
    filters: () => b.ref(depth.filters, {
      keyName: 'source', fieldMode: 'list', eligible: allowing('filters', allFields), extras: { kind: a.literal('filters') },
      describe: 'A structured filter placeholder; clauses are supplied at execution time.',
    }),
    subquery: () => a.ref('Expr_subquery'),
  };
  const exprOptions = EXPR_KINDS.filter((k) => applicable(k, types, selected, catalog)).map((k) => kinds[k]!());

  // Sources: type / aliased / subquery, and a table-valued function when one is registered.
  const typeRef = typeName(b, types, 'A registered Type name.');
  const sources: AnySchema[] = [
    a.object({ kind: a.literal('type'), type: typeRef }).describe('A type source, bound under (and referenced by) its type name.'),
    a.object({ kind: a.literal('aliased'), type: typeRef, as: a.string().describe('Custom source name (self-join / collision break).') })
      .describe('An explicitly-aliased type source (the discouraged escape hatch).'),
    a.object({ kind: a.literal('subquery'), query: Query, as: a.string().describe('Required alias for the derived source.') })
      .describe('A derived (subquery) source.'),
  ];
  if (selected.tabular.length) {
    const fnName = depth.functions === 'open'
      ? a.string().describe('A registered tabular function name.')
      : a.enum(selected.tabular.map((f) => f.name)).describe('A registered tabular function name.');
    sources.push(a.object({
      kind: a.literal('function'),
      function: fnName,
      args: a.record(Expr).describe('Arguments keyed by declared parameter name.'),
      as: a.string().describe('Required alias the produced rows bind under.'),
    }).describe('A table-valued function source: FROM fn(args) AS alias.'));
  }
  const Source = a.union(sources).describe('A FROM / JOIN source: a type, an aliased type, a subquery, or a table-valued function.');

  const hasRelations = types.some((t) => t.fields.some((f) => f.relation));
  const relationOn = b.ref(depth.refs, {
    keyName: 'source', fieldMode: 'one', eligible: relationFields,
    extras: { kind: a.literal('relation'), as: a.string().describe('Required alias the joined target binds under.') },
    describe: 'Cross a relation field of a bound source (key synthesized from the relation).',
  });
  const JoinOn = (hasRelations ? a.union([relationOn, a.ref('Source')]) : a.ref('Source'))
    .describe('A join target: a relation crossing or a manually-joined source.');
  // No relation anywhere: `joins` only accepts an empty list.
  const Joins = hasRelations ? a.array(a.ref('Join')) : a.array(a.never());

  // The write model.
  const insertable = types.filter((t) => t.insertable);
  const updatable = types.filter((t) => t.updatable);
  const deletable = types.filter((t) => t.deletable);
  const writes = depth.writes;
  const conflict = (t?: CatalogType) => a.object({
    fields: a.array(a.string()),
    doNothing: a.boolean().optional(),
    update: a.optional(writes !== 'open' && t
      ? updateSet(t, writes, a.ref('ConflictExpr'))
      : a.record(a.ref('ConflictExpr')).describe('DO UPDATE SET assignments (field → value).')),
  });
  const returning = a.array(a.ref('SelectField')).optional();
  const Insert = writes === 'open'
    ? a.object({
        kind: a.literal('insert'),
        into: typeName(b, insertable, 'A permitted target Type name.'),
        rows: a.array(a.record(Expr)).optional().describe('Rows to insert (each a field → value map).'),
        select: Query.optional(),
        returning,
        onConflict: conflict().optional(),
      }).describe('An INSERT statement.')
    : a.union(insertable.map((t) => a.object({
        kind: a.literal('insert'),
        into: a.literal(t.name),
        rows: a.array(insertRow(t, writes, Expr)).optional(),
        select: Query.optional(),
        returning,
        onConflict: conflict(t).optional(),
      }).describe(`An INSERT into ${t.name}.`))).describe('An INSERT statement.');
  const Update = writes === 'open'
    ? a.object({
        kind: a.literal('update'),
        type: typeName(b, updatable, 'A permitted target Type name.'),
        set: a.record(Expr).describe('Fields to set (field → value).'),
        joins: a.ref('Joins').optional(),
        where: a.array(Expr).optional(),
        returning,
      }).describe('An UPDATE statement.')
    : a.union(updatable.map((t) => a.object({
        kind: a.literal('update'),
        type: a.literal(t.name),
        set: updateSet(t, writes, Expr),
        joins: a.ref('Joins').optional(),
        where: a.array(Expr).optional(),
        returning,
      }).describe(`An UPDATE of ${t.name}.`))).describe('An UPDATE statement.');
  const Delete = a.object({
    kind: a.literal('delete'),
    from: typeName(b, deletable, 'A permitted target Type name.'),
    joins: a.ref('Joins').optional(),
    where: a.array(Expr).optional(),
    returning,
  }).describe('A DELETE statement.');

  // Query-kind gating: a DML kind only when some Type permits it.
  const queries: AnySchema[] = [a.ref('Query_select')];
  if (insertable.length) queries.push(a.ref('Query_insert'));
  if (updatable.length) queries.push(a.ref('Query_update'));
  if (deletable.length) queries.push(a.ref('Query_delete'));
  queries.push(a.ref('Query_set-operation'), a.ref('Query_cte'), a.ref('Query_expr'));

  return {
    ...b.defs,
    Expr: a.union(exprOptions) as unknown as SchemaOf<ModelExprDef>,
    Query: a.union(queries).describe('Any query: select / insert / update / delete / set-op / cte / expr.') as unknown as SchemaOf<QueryDef>,
    Source: Source as unknown as SchemaOf<SourceDef>,
    JoinOn: JoinOn as unknown as SchemaOf<JoinOnDef>,
    Joins: Joins as unknown as SchemaOf<JoinDef[]>,
    Query_insert: Insert as unknown as SchemaOf<InsertDef>,
    Query_update: Update as unknown as SchemaOf<UpdateDef>,
    Query_delete: Delete as unknown as SchemaOf<DeleteDef>,
  };
}

/** Cache key: one bind per (catalog version, options). */
const keyOf = (catalog: QueryCatalog, options: BuildOptions = {}) => `${catalog.version}|${JSON.stringify(options)}`;

/**
 * The whole grammar: static named types + the declared, catalog-built ones.
 * One module, many results (as `buildSchemas` returns a bundle of schemas).
 */
export const QueryModule = a
  .define(grammar)
  .declare<{
    Expr: ModelExprDef;
    Query: QueryDef;
    Source: SourceDef;
    JoinOn: JoinOnDef;
    Joins: JoinDef[];
  }>()
  .dynamic(dynamicPart, { key: keyOf, cacheSize: 16 });

/** `buildSchemas(...).Query`. */
export const QuerySchema = QueryModule.result('Query');
/** `buildSchemas(...).Expr`. */
export const ExprSchema = QueryModule.result('Expr');
/** `buildSchemas(...).Select`. */
export const SelectSchema = QueryModule.result('Query_select');
/** `buildSchemas(...).Source`. */
export const SourceSchema = QueryModule.result('Source');

/**
 * llm/schemas.ts `querySchema` + llm/tool.ts: the query tool's arguments,
 * `{ query: <structured Query> }`.
 */
export const QueryToolArgs = QueryModule.result(a.object({ query: Query.describe('The query to execute as a structured Query object.') }));

/** Past `max` Types (default 5) the structured schema is abandoned for prose (`shouldUseStringSchema`). */
export const DEFAULT_MAX_QUERY_SCHEMA_TYPES = 5;
export const QueryProseArgs = a.object({
  query: a.string().describe(
    'A detailed natural-language description of the query: which Types are involved, '
    + 'filter conditions, known record IDs, and the precise outcome desired. '
    + 'Do not emit a structured query — there are too many Types to enumerate.',
  ),
});
export const shouldUseStringSchema = (catalog: QueryCatalog, o: BuildOptions = {}, max = DEFAULT_MAX_QUERY_SCHEMA_TYPES) => typesOf(catalog, o).length > max;

// ============================================================================
// Type proofs: the code shape IS query's own types
// ============================================================================

const SetOpSchema = QueryModule.result('Query_set-operation');
type Q = a.infer<typeof QuerySchema>;
type E = a.infer<typeof ExprSchema>;
// Every decoded value IS a valid value of query's own types (the port is at least as precise)...
expectTypeOf<Q>().toMatchTypeOf<QueryDef>();
expectTypeOf<E>().toMatchTypeOf<ExprDef>();
expectTypeOf<a.infer<typeof SourceSchema>>().toMatchTypeOf<SourceDef>();
expectTypeOf<a.infer<typeof SelectSchema>>().toMatchTypeOf<SelectDef>();
expectTypeOf<a.infer<typeof SetOpSchema>>().toMatchTypeOf<SetOperationDef>();
expectTypeOf<a.infer<typeof QueryToolArgs>>().toMatchTypeOf<{ query: QueryDef }>();
// ...covering exactly the kinds query offers a model (no `arg`/`output`/`sorter`/`excluded` in Expr).
expectTypeOf<Q['kind']>().toEqualTypeOf<QueryDef['kind']>();
expectTypeOf<E['kind']>().toEqualTypeOf<ModelExprDef['kind']>();
expectTypeOf<a.infer<typeof SourceSchema>['kind']>().toEqualTypeOf<SourceDef['kind']>();
// Leaves are exact.
type SelectOut = a.infer<typeof SelectSchema>;
expectTypeOf<SelectOut['fields'][number]>().toEqualTypeOf<{ expr: E; as?: string }>();
expectTypeOf<NonNullable<SelectOut['limit']>>().toEqualTypeOf<number | { kind: 'param'; name: string }>();
expectTypeOf<NonNullable<SelectOut['order']>[number]>().toMatchTypeOf<OrderDef | { kind: 'sorter' }>();
expectTypeOf<Extract<E, { kind: 'comparison' }>['op']>().toEqualTypeOf<'=' | '<>' | '<' | '<=' | '>' | '>=' | 'like' | 'notLike' | 'ilike'>();
expectTypeOf<Extract<E, { kind: 'literal' }>['value']>().toEqualTypeOf<QueryJson>();
expectTypeOf<Extract<Q, { kind: 'cte' }>['ctes'][number]>().toMatchTypeOf<{ name: string }>();
expectTypeOf<SelectFieldDef>().toMatchTypeOf<{ expr: unknown; as?: string }>();
// The binds take exactly the catalog and the build options.
expectTypeOf(QuerySchema.bind).parameters.toEqualTypeOf<[catalog: QueryCatalog, options?: BuildOptions]>();
expectTypeOf<a.infer<typeof QueryProseArgs>>().toEqualTypeOf<{ query: string }>();
// Narrowing works through the recursive union.
export function __narrow(q: Q): void {
  if (q.kind === 'select') expectTypeOf(q.from).toMatchTypeOf<SourceDef>();
  if (q.kind === 'cte') expectTypeOf(q.final).toMatchTypeOf<QueryDef>();
}
