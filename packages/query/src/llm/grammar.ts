/**
 * The query language as one `@aeye/schema` module — what a model is given to
 * write a query against, for one registry at one depth.
 *
 * - The catalog-independent grammar (`binary`, `comparison`, `case`, `in`,
 *   the SELECT / set-op / CTE statements, ORDER BY, the sorter…) is STATIC
 *   named types, recursive through `a.ref('Expr')` / `a.ref('Query')`.
 * - Everything the registry or the per-axis depth decides (which expr kinds
 *   exist — the capability gate —, field references at each `RefDepth`,
 *   function calls at each `FnDepth`, Type names, sources, join targets, the
 *   DML statements and their typed rows) comes from ONE dynamic step,
 *   `(registry, options)`, keyed by the registry's identity + `version` and
 *   the options. A bind for the same registry and options is cached.
 * - Fragments shared across positions (a Type's field-name enum
 *   `Fields_<Type>`, a typed-args object per signature `Args…`, `param`,
 *   `Limit`) are named types, written once as `$defs`.
 *
 * The code type is query's own: `Query` is `QueryDef`, `Expr` is `ExprDef`
 * minus the kinds a model is never offered at large (`ModelExprDef`).
 *
 * Extension: a registered expr class that isn't one of the builtin kinds
 * contributes its branch through `static toA(build)` (see `ExprClass.toA`);
 * one without it is left out of the model's grammar (it can still be built
 * in code).
 */
import { a, type AnySchema, type Bound, type Bundle, type SchemaOf } from '@aeye/schema';
import type { Registry } from '../registry';
import type { Type } from '../type';
import type { Field } from '../field';
import type { FunctionDef } from '../schema';
import type {
  DeleteDef, ExprDef, InsertDef, JoinDef, JoinOnDef, QueryDef, SourceDef, UpdateDef, WriteValueDef, ExprKind,
  CTEDef, ExprQueryDef, OrderDef, SelectDef, SelectFieldDef, SetOperationDef,
} from '../schema';
import type { RefDepth, ResolvedSchemaDepth, SelectedFunctions } from '../node';
import {
  allFields, allowingExpr, exprKindApplicable, relationFieldsOf, selectFunctions, semanticFieldsOf, textFieldsOf,
  type FieldEligibility,
} from '../schema-build';
import { requiredOnInsert } from '../write-model';
import { signatureOf } from '../exprs/operator';
import { resolveDepthFor, type BuildSchemasOptions } from './depth';

// ============================================================================
// The static grammar
// ============================================================================

const Expr = a.ref('Expr');
const Query = a.ref('Query');
const dir = a.enum(['asc', 'desc']);
const nulls = a.enum(['first', 'last']);

/** The model's own expression union: `ExprDef` minus the kinds kept out of it (`exprKindApplicable`). */
export type ModelExprDef = Exclude<ExprDef, { kind: 'arg' | 'output' | 'sorter' | 'excluded' }>;

const grammar = {
  Expr_literal: a.object({ kind: a.literal('literal'), value: a.json() })
    .describe('A constant value: a scalar, or a whole JSON document for a json / array field.'),
  Expr_param: a.object({ kind: a.literal('param'), name: a.string().describe('Parameter name; its type is inferred from usage.') })
    .describe('A named bind parameter (contextually typed).'),
  // The shared `param` fragment (limits, text-search queries).
  param: a.object({ kind: a.literal('param'), name: a.string() }).describe('A named bind parameter.'),
  Expr_binary: a.object({ kind: a.literal('binary'), op: a.enum(['+', '-', '*', '/', '%']), left: Expr, right: Expr })
    .describe('Arithmetic binary operation.'),
  Expr_unary: a.object({ kind: a.literal('unary'), op: a.enum(['-', '+']), operand: Expr }).describe('Unary arithmetic operation.'),
  Expr_comparison: a.object({
    kind: a.literal('comparison'),
    op: a.enum(['=', '<>', '<', '<=', '>', '>=', 'like', 'notLike', 'ilike']),
    left: Expr,
    right: Expr,
  }).describe('Scalar comparison predicate.'),
  Expr_logical: a.object({ kind: a.literal('logical'), op: a.enum(['and', 'or', 'not']), operands: a.array(Expr) })
    .describe('Boolean connective (and / or / not).'),
  Expr_in: a.object({ kind: a.literal('in'), value: Expr, in: a.union([a.array(Expr), Query]), not: a.boolean().optional() })
    .describe('Membership predicate (value IN list / subquery).'),
  Expr_between: a.object({ kind: a.literal('between'), value: Expr, lower: Expr, upper: Expr, not: a.boolean().optional() })
    .describe('Range predicate (value BETWEEN lower AND upper).'),
  'Expr_is-null': a.object({ kind: a.literal('is-null'), value: Expr, not: a.boolean().optional() })
    .describe('Null test (value IS [NOT] NULL).'),
  Expr_exists: a.object({ kind: a.literal('exists'), query: Query, not: a.boolean().optional() })
    .describe('Existence predicate over a subquery.'),
  Expr_case: a.object({ kind: a.literal('case'), branches: a.array(a.object({ when: Expr, then: Expr })), else: Expr.optional() })
    .describe('Conditional CASE expression.'),
  Expr_subquery: a.object({ kind: a.literal('subquery'), query: Query }).describe('A subquery used in value position.'),
  'Expr_array-op': a.object({
    kind: a.literal('array-op'),
    op: a.enum(['contains', 'containsAny', 'containsAll', 'isEmpty', 'notEmpty']).describe('Array predicate: element membership / overlap / emptiness.'),
    target: Expr,
    value: a.union([Expr, a.array(Expr)]).optional()
      .describe('Single element (contains), element list (containsAny/All), or omitted (isEmpty/notEmpty).'),
  }).describe('Array containment / emptiness predicate.'),

  // ORDER BY, output refs, the sorter
  Order: a.object({ expr: Expr, dir, nulls: nulls.optional() }).describe('An ORDER BY entry.'),
  Expr_output: a.object({ kind: a.literal('output'), name: a.string() })
    .describe('A reference to a SELECT output field by name (its `as`, or the natural derived name).'),
  GroupExpr: a.union([Expr, a.ref('Expr_output')]),
  SelectOrder: a.object({ expr: a.ref('GroupExpr'), dir, nulls: nulls.optional() })
    .describe('An ORDER BY entry (its `expr` may reference a SELECT output field by name).'),
  Expr_sorter: a.object({
    kind: a.literal('sorter'),
    sorts: a.record(a.ref('GroupExpr')).describe('Named sortable expressions (sort name → expr); the caller selects by name at run time.'),
    defaultSort: a.array(a.object({ sort: a.string().describe('A declared sort name (a key of `sorts`).'), dir })).optional()
      .describe('Default multi-key sort (each `{ sort, dir }`) applied when the caller selects none.'),
  }).describe('A dynamic-sort catalog (valid only in a SELECT `order`); the selection is supplied at execution time.'),
  SelectOrderEntry: a.union([a.ref('SelectOrder'), a.ref('Expr_sorter')])
    .describe('A SELECT ORDER BY entry: a term, or a dynamic-sort `sorter` catalog (selection supplied at run time).'),
  SelectField: a.object({ expr: Expr, as: a.string().optional() }).describe('A selected output field.'),
  Limit: a.union([a.number(), a.ref('param')]),

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
// The dynamic part
// ============================================================================

/** The field property's shape at a reference position. */
type FieldMode = 'none' | 'one' | 'optional' | 'list';

/** What a `{ source|type, field(s) }` reference position is. */
export interface RefOptions {
  readonly keyName: 'source' | 'type';
  readonly fieldMode: FieldMode;
  readonly eligible: FieldEligibility;
  /** Properties every branch carries besides the key and field (`kind`, `query`…). */
  readonly extras?: Record<string, AnySchema>;
  readonly describe: string;
}

/** The function-call expr kinds. */
export type FnExprKind = 'function-call' | 'tabular-function-call' | 'aggregate' | 'window';

/**
 * One build of the dynamic part: the registry, the Types offered, the
 * resolved depth and functions, and the named fragments it shares. A custom
 * expr class's `toA(build)` gets one, so its branch can use the same
 * references, fragments and depth as the builtin kinds.
 */
export class QueryGrammarBuild {
  /** The shared named fragments built so far (they join the module's named types). */
  readonly defs: Record<string, AnySchema> = {};
  private readonly byKey = new Map<string, string>();
  private readonly baseUses = new Map<string, number>();

  constructor(
    readonly registry: Registry,
    readonly types: readonly Type[],
    readonly depth: ResolvedSchemaDepth,
    readonly selected: SelectedFunctions,
  ) {}

  /** `a.ref('Expr')`: any expression. */
  get Expr(): SchemaOf<ExprDef> { return Expr as unknown as SchemaOf<ExprDef>; }
  /** `a.ref('Query')`: any query. */
  get Query(): SchemaOf<QueryDef> { return Query as unknown as SchemaOf<QueryDef>; }

  /** One named type per distinct content (`Fields_user`, `Args_2`…); its ref. */
  shared<T>(contentKey: string, idBase: string, build: () => AnySchema): SchemaOf<T> {
    let id = this.byKey.get(contentKey);
    if (!id) {
      const used = this.baseUses.get(idBase) ?? 0;
      this.baseUses.set(idBase, used + 1);
      id = used === 0 ? idBase : `${idBase}_${used + 1}`;
      this.byKey.set(contentKey, id);
      this.defs[id] = build();
    }
    return a.refOf<T>(id);
  }

  /** A shared `Fields_<Type>` enum over these field names. */
  fieldEnum(names: readonly string[], hint: string): SchemaOf<string> {
    return this.shared<string>(`fields\u0000${names.join('\u0000')}`, `Fields_${hint}`, () => a.enum(names));
  }

  /** A shared strict args object per argument signature (not per function). */
  typedArgs(fn: FunctionDef): SchemaOf<Record<string, ExprDef>> {
    const params = fn.params.map((p) => `${p.name}${p.optional ? '?' : ''}`);
    return this.shared<Record<string, ExprDef>>(`args ${params.join(',')}`, 'Args', () => {
      const shape: Record<string, AnySchema> = {};
      for (const p of fn.params) shape[p.name] = p.optional ? Expr.optional() : Expr;
      return a.object(shape).strict().describe(`Named arguments: ${params.length ? params.join(', ') : 'none'}.`);
    });
  }

  /**
   * A `{ key, field(s) }` reference at a `RefDepth`: free strings (`open`),
   * the key or the field (or both) enumerated (`types` / `fields` / `both`),
   * or one branch per Type pairing its name with only its fields (`paired`).
   */
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

  /** A function-call kind at the `functions` depth: `open` as given, `names` (an enum), `typed` (a branch per function). */
  fn(kind: FnExprKind, open: AnySchema): AnySchema {
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
    return a.union(fns.map((f) => {
      const args = this.typedArgs(f);
      const required = f.params.some((p) => !p.optional);
      // Optional on the wire when nothing is required; written in as `{}`, as `ExprDef` has it.
      return object(a.literal(f.name).describe(`The \`${f.name}\` function.`), required ? args : a.default(args, {}));
    }));
  }

  /** A Type-name position: an enum over `subset` when `typeNames: 'enum'`, else a string. */
  typeName(subset: readonly Type[], describe: string): SchemaOf<string> {
    return this.depth.typeNames === 'enum' ? a.enum(subset.map((t) => t.name)).describe(describe) : a.string().describe('A Type name.');
  }

  /** The backing of `type.field`, for the write model. */
  backing(type: Type, field: Field) {
    return this.registry.backing(type.name)?.fields?.[field.name];
  }

  /** A field's write value: its typed value or an expression (`typed`), an expression (`names`). */
  writeValue(field: Field, writes: 'names' | 'typed', expr: AnySchema): SchemaOf<WriteValueDef> {
    return writes === 'typed'
      ? a.union([field.fieldType.toA(), expr as SchemaOf<ExprDef>]).describe(`A ${field.fieldType.kind} value, or an expression.`)
      : (expr as SchemaOf<ExprDef>);
  }

  /** A strict INSERT row: insertable fields only; at `typed`, the required-on-insert ones required. */
  insertRow(t: Type, writes: 'names' | 'typed', expr: AnySchema): SchemaOf<Record<string, WriteValueDef>> {
    const shape: Record<string, AnySchema> = {};
    for (const f of t.fields) {
      const fb = this.backing(t, f);
      if (!f.insertableFor(fb)) continue;
      const v = this.writeValue(f, writes, expr);
      shape[f.name] = writes === 'typed' && requiredOnInsert(f, fb) ? v : a.optional(v);
    }
    return a.object(shape).strict().describe(`A row to insert into ${t.name} (field → value).`) as unknown as SchemaOf<Record<string, WriteValueDef>>;
  }

  /** A strict UPDATE SET: updatable fields only, every key optional. */
  updateSet(t: Type, writes: 'names' | 'typed', expr: AnySchema): SchemaOf<Record<string, WriteValueDef>> {
    const shape: Record<string, AnySchema> = {};
    for (const f of t.fields) if (f.updatableFor(this.backing(t, f))) shape[f.name] = a.optional(this.writeValue(f, writes, expr));
    return a.object(shape).strict().describe(`Fields to set on ${t.name} (field → value).`) as unknown as SchemaOf<Record<string, WriteValueDef>>;
  }
}

const named = (args: AnySchema) => args.describe('Arguments keyed by declared parameter name.');

/** Each builtin expr kind's branch at the build's depth. */
const BUILTIN_BRANCHES: { readonly [K in ExprKind]?: (b: QueryGrammarBuild) => AnySchema } = {
  literal: () => a.ref('Expr_literal'),
  'field-ref': (b) => b.ref(b.depth.refs, {
    keyName: 'source', fieldMode: 'one', eligible: allowingExpr(allFields, 'field-ref'), extras: { kind: a.literal('field-ref') },
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
  aggregate: (b) => b.fn('aggregate', a.object({
    kind: a.literal('aggregate'),
    function: a.string().describe('Registered aggregate function name (count for count(*)).'),
    args: named(a.record(Expr)),
    distinct: a.boolean().optional(),
  }).describe('Aggregate function over named args (count with empty args = count(*)).')),
  window: (b) => b.fn('window', a.object({
    kind: a.literal('window'),
    function: a.string().describe('Registered window (or aggregate) function name.'),
    args: named(a.record(Expr)),
    partitionBy: a.array(Expr).optional(),
    orderBy: a.array(a.object({ expr: Expr, dir, nulls: nulls.optional() })).optional(),
  }).describe('Window function over a partition / ordering, with named args.')),
  'function-call': (b) => b.fn('function-call', a.object({
    kind: a.literal('function-call'),
    function: a.string().describe('Registered scalar function name.'),
    args: named(a.record(Expr)),
  }).describe('A scalar function call with named arguments.')),
  'tabular-function-call': (b) => b.fn('tabular-function-call', a.object({
    kind: a.literal('tabular-function-call'),
    function: a.string().describe('Registered tabular function name.'),
    args: named(a.record(Expr)),
  }).describe('A type-valued function call (produces rows).')),
  // `op` enum-locked past `open`, with each operator's signature and instructions; strict operands at `typed`.
  operator: (b) => {
    const ops = b.registry.operatorList();
    if (b.depth.functions === 'open' || !ops.length) {
      return a.object({ kind: a.literal('operator'), op: a.string().describe('Registered operator name.'), args: named(a.record(Expr)) })
        .describe('A registered operator applied to named operands.');
    }
    const glossary = ops.map((o) => `${signatureOf(o)} — ${o.instructions}`).join(' ');
    if (b.depth.functions === 'names') {
      return a.object({ kind: a.literal('operator'), op: a.enum(ops.map((o) => o.name)).describe(`A registered operator. ${glossary}`), args: named(a.record(Expr)) })
        .describe('A registered operator applied to named operands.');
    }
    return a.union(ops.map((o) => a.object({
      kind: a.literal('operator'),
      op: a.literal(o.name).describe(`${signatureOf(o)} — ${o.instructions}`),
      args: a.object(Object.fromEntries(o.operands.map((n) => [n.name, Expr]))).strict().describe(`Operands for \`${o.name}\`.`),
    }))).describe('A registered operator applied to named operands.');
  },
  semantic: (b) => b.ref(b.depth.refs, {
    keyName: 'source', fieldMode: 'optional', eligible: allowingExpr(semanticFieldsOf, 'semantic'),
    extras: {
      kind: a.literal('semantic'),
      query: a.union([
        a.string().describe('A literal natural-language query.'),
        a.ref('param'),
        b.ref(b.depth.refs, { keyName: 'source', fieldMode: 'one', eligible: semanticFieldsOf, describe: 'Another BOUND source + semantic field whose embedding is the query vector (cross-source pairing).' }),
        b.ref(b.depth.refs, { keyName: 'type', fieldMode: 'one', eligible: semanticFieldsOf, describe: 'A semantic Type + field, resolved to that Type\'s single bound source, whose embedding is the query vector.' }),
      ]).describe('The query: text, a param, a bound source+field, or a semantic Type+field.'),
    },
    describe: 'Semantic-similarity score (requires an embedder).',
  }),
  'text-search': (b) => b.ref(b.depth.refs, {
    keyName: 'source', fieldMode: 'optional', eligible: allowingExpr(textFieldsOf, 'text-search'),
    extras: { kind: a.literal('text-search'), query: a.union([a.string(), a.ref('param')]).describe('Search query: a literal string or a param.') },
    describe: 'Full-text search predicate.',
  }),
  'text-score': (b) => b.ref(b.depth.refs, {
    keyName: 'source', fieldMode: 'optional', eligible: allowingExpr(textFieldsOf, 'text-score'),
    extras: { kind: a.literal('text-score'), query: a.union([a.string(), a.ref('param')]).describe('Search query: a literal string or a param.') },
    describe: 'Numeric full-text relevance score (usable in SELECT / ORDER BY).',
  }),
  filters: (b) => b.ref(b.depth.filters, {
    keyName: 'source', fieldMode: 'list', eligible: allowingExpr(allFields, 'filters'), extras: { kind: a.literal('filters') },
    describe: 'A structured filter placeholder; clauses are supplied at execution time.',
  }),
  subquery: () => a.ref('Expr_subquery'),
};

/** The Types an options bag offers. */
const typesOf = (registry: Registry, o: BuildSchemasOptions): readonly Type[] => o.types ?? registry.typeList();

/** The dynamic step: the named types the registry and the options decide. */
function grammarDefs(registry: Registry, options: BuildSchemasOptions) {
  registry.finalize();
  const types = typesOf(registry, options);
  const selected = selectFunctions(registry, options.functions);
  const depth = resolveDepthFor(types, selected, options);
  const b = new QueryGrammarBuild(registry, types, depth, selected);

  const exprOptions: AnySchema[] = [];
  for (const cls of registry.exprClassList()) {
    if (!exprKindApplicable(cls.KIND, types, selected, registry)) continue;
    const builtin = BUILTIN_BRANCHES[cls.KIND];
    const branch = builtin ? builtin(b) : cls.toA?.(b);
    if (branch) exprOptions.push(branch);
  }

  // Sources: type / aliased / subquery, and a table-valued function when one is registered.
  const typeRef = b.typeName(types, 'A registered Type name.');
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

  const hasRelations = types.some((t) => t.relationFields().length > 0);
  const relationOn = b.ref(depth.refs, {
    keyName: 'source', fieldMode: 'one', eligible: relationFieldsOf,
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
  const conflict = (t?: Type) => a.object({
    fields: a.array(a.string()),
    doNothing: a.boolean().optional(),
    update: a.optional(writes !== 'open' && t
      ? b.updateSet(t, writes, a.ref('ConflictExpr'))
      : a.record(a.ref('ConflictExpr')).describe('DO UPDATE SET assignments (field → value).')),
  });
  const returning = a.array(a.ref('SelectField')).optional();
  const Insert = writes === 'open'
    ? a.object({
        kind: a.literal('insert'),
        into: b.typeName(insertable, 'A permitted target Type name.'),
        rows: a.array(a.record(Expr)).optional().describe('Rows to insert (each a field → value map).'),
        select: Query.optional(),
        returning,
        onConflict: conflict().optional(),
      }).describe('An INSERT statement.')
    : a.union(insertable.map((t) => a.object({
        kind: a.literal('insert'),
        into: a.literal(t.name),
        rows: a.array(b.insertRow(t, writes, Expr)).optional(),
        select: Query.optional(),
        returning,
        onConflict: conflict(t).optional(),
      }).describe(`An INSERT into ${t.name}.`))).describe('An INSERT statement.');
  const Update = writes === 'open'
    ? a.object({
        kind: a.literal('update'),
        type: b.typeName(updatable, 'A permitted target Type name.'),
        set: a.record(Expr).describe('Fields to set (field → value).'),
        joins: a.ref('Joins').optional(),
        where: a.array(Expr).optional(),
        returning,
      }).describe('An UPDATE statement.')
    : a.union(updatable.map((t) => a.object({
        kind: a.literal('update'),
        type: a.literal(t.name),
        set: b.updateSet(t, writes, Expr),
        joins: a.ref('Joins').optional(),
        where: a.array(Expr).optional(),
        returning,
      }).describe(`An UPDATE of ${t.name}.`))).describe('An UPDATE statement.');
  const Delete = a.object({
    kind: a.literal('delete'),
    from: b.typeName(deletable, 'A permitted target Type name.'),
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
    TypeName: typeRef,
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

// ============================================================================
// Caching: one set of named types per (registry, version, options)
// ============================================================================

/**
 * Binds kept per result. A query bind rendered on 4 profiles keeps ~8.8 MB
 * (PERFORMANCE.md), so 4 binds (one per distinct options bag, or per recent
 * registry version) hold ~35 MB at most per result in use.
 */
export const QUERY_BIND_CACHE_SIZE = 4;

let nextRegistryId = 0;
const registryIds = new WeakMap<Registry, number>();
const idOf = (r: Registry): number => {
  let id = registryIds.get(r);
  if (id === undefined) registryIds.set(r, (id = ++nextRegistryId));
  return id;
};

/** The options as a cache key (Types by name). */
export function optionsKey(o: BuildSchemasOptions = {}): string {
  return JSON.stringify([o.depth ?? null, o.functions ?? null, o.maxEnumSize ?? null, o.strict ?? null, o.types?.map((t) => t.name) ?? null]);
}

/** The bind key: the registry's identity and version, and the options. */
export const grammarKey = (registry: Registry, options: BuildSchemasOptions = {}): string =>
  `${idOf(registry)}.${registry.version}|${optionsKey(options)}`;

/**
 * The dynamic step's output, memoized per registry (weakly) so every result
 * of one `buildSchemas` call — and every later call with the same registry
 * version and options — shares one set of named types (and so the nodes
 * rendered from them).
 */
const defsMemo = new WeakMap<Registry, Map<string, ReturnType<typeof grammarDefs>>>();
function memoDefs(registry: Registry, options: BuildSchemasOptions = {}): ReturnType<typeof grammarDefs> {
  let byKey = defsMemo.get(registry);
  if (!byKey) defsMemo.set(registry, (byKey = new Map()));
  const key = grammarKey(registry, options);
  let defs = byKey.get(key);
  if (defs) {
    byKey.delete(key);
    byKey.set(key, defs);
    return defs;
  }
  defs = grammarDefs(registry, options);
  byKey.set(key, defs);
  while (byKey.size > QUERY_BIND_CACHE_SIZE) byKey.delete(byKey.keys().next().value!);
  return defs;
}

/**
 * The query grammar: static named types plus the registry-built ones.
 * `QueryGrammar.result(...)` gives a bundle bound with `(registry, options?)`.
 */
export const QueryGrammar = a
  .define(grammar)
  .declare<{
    TypeName: string;
    Expr: ModelExprDef;
    Query: QueryDef;
    Source: SourceDef;
    JoinOn: JoinOnDef;
    Joins: JoinDef[];
  }>()
  .dynamic((registry: Registry, options?: BuildSchemasOptions) => memoDefs(registry, options), { key: grammarKey, cacheSize: QUERY_BIND_CACHE_SIZE });

/** A query (`buildSchemas(...).Query`). */
export const QueryResult: QueryBundle<QueryDef> = QueryGrammar.result('Query');
/** An expression. */
export const ExprResult: QueryBundle<ModelExprDef> = QueryGrammar.result('Expr');

/** A result of `QueryGrammar`, bound with `(registry, options?)`. */
export type QueryBundle<T> = Bundle<T, [Registry, BuildSchemasOptions?]>;

/**
 * The code types of `buildSchemas`' parts, written out: the inferred ones are too long to emit. The parts the module
 * declares are checked; the rest are the model's subset of their def (narrower ExprDefs), typed as the def.
 */
export interface QueryResults {
  readonly Type: QueryBundle<string>;
  readonly Expr: QueryBundle<ModelExprDef>;
  readonly Source: QueryBundle<SourceDef>;
  readonly Join: QueryBundle<JoinDef>;
  readonly Order: QueryBundle<OrderDef>;
  readonly SelectField: QueryBundle<SelectFieldDef>;
  readonly Select: QueryBundle<SelectDef>;
  readonly Insert: QueryBundle<InsertDef>;
  readonly Update: QueryBundle<UpdateDef>;
  readonly Delete: QueryBundle<DeleteDef>;
  readonly SetOperation: QueryBundle<SetOperationDef>;
  readonly CTE: QueryBundle<CTEDef>;
  readonly ExprQuery: QueryBundle<ExprQueryDef>;
  readonly Query: QueryBundle<QueryDef>;
}

/** The bundles of `buildSchemas`, one per named result. */
export const QUERY_RESULTS: QueryResults = {
  Type: QueryGrammar.result('TypeName'),
  Expr: ExprResult,
  Source: QueryGrammar.result('Source'),
  Join: QueryGrammar.result('Join') as unknown as QueryBundle<JoinDef>,
  Order: QueryGrammar.result('Order') as unknown as QueryBundle<OrderDef>,
  SelectField: QueryGrammar.result('SelectField') as unknown as QueryBundle<SelectFieldDef>,
  Select: QueryGrammar.result('Query_select') as unknown as QueryBundle<SelectDef>,
  Insert: QueryGrammar.result('Query_insert'),
  Update: QueryGrammar.result('Query_update'),
  Delete: QueryGrammar.result('Query_delete'),
  SetOperation: QueryGrammar.result('Query_set-operation') as unknown as QueryBundle<SetOperationDef>,
  CTE: QueryGrammar.result('Query_cte') as unknown as QueryBundle<CTEDef>,
  ExprQuery: QueryGrammar.result('Query_expr') as unknown as QueryBundle<ExprQueryDef>,
  Query: QueryResult,
};

/** `buildSchemas`' result: each part of the language, bound for one registry and options. */
export type QuerySchemas = { readonly [K in keyof typeof QUERY_RESULTS]: Bound<(typeof QUERY_RESULTS)[K]['_out']> };

