/**
 * Benchmark pairs: each real corpus schema in `@aeye/schema` next to today's
 * zod path for the same schema, as each package actually uses it:
 *
 * - zod schemas: hand-written twins of the cletus / harness originals (the
 *   corpus ports are faithful to them), `@aeye/gin`'s `toValueSchema` and
 *   `buildSchemas`, `@aeye/query`'s `buildSchemas` (product calls it per turn);
 * - rendering: `toJSONSchema(strictify(schema, d), d)` (openai.ts convertTools
 *   and the structured-output path);
 * - decoding: `strictify(schema, d).safeParse(wire)` (tool.ts / prompt.ts);
 * - a request: `SchemaBudget` + per-tool allocation in priority order
 *   (ai/registry.ts `allocateToolDescriptors`) + strictify + toJSONSchema.
 *
 * Core's schema module is imported from SOURCE (`packages/core/src/schema`):
 * core's dist predates the current strictify, and the source is what the
 * monorepo runs.
 */
import { releaseZodIds } from './zod-registries';
import { z } from 'zod';
import * as core from '../../core/src/schema/index';
import { buildSchemas as ginBuildSchemas, createRegistry as ginCreateRegistry } from '@aeye/gin';
import { buildSchemas as queryBuildSchemas } from '@aeye/query';
import {
  ANTHROPIC_STRICT, GOOGLE_STRICT, LENIENT, ModelProfile, OPENAI_STRICT, staticBundle, variant,
  type Bound, type Profile, type RequestItem,
} from '../src/index';
import { CategoryComparisonChart, ImageFindArgs, TypeImportArgs } from '../src/__tests__/corpus/cletus-tools';
import { McpServerConfig } from '../src/__tests__/corpus/harness-fns';
import { Task, TaskDef } from '../src/__tests__/corpus/gin-values';
import { WriteArgs } from '../src/__tests__/corpus/gin-grammar';
import { asGrammarRegistry, everythingProgram, fixtureRegistry as ginFixtureRegistry, personProgram, t } from '../src/__tests__/corpus/gin-fixtures';
import { QueryModule, type BuildOptions, type QueryCatalog } from '../src/__tests__/corpus/query';
import { catalogOf, fixtureRegistry as queryFixtureRegistry } from '../src/__tests__/corpus/query-fixtures';
import { QuerySetArgs } from '../src/__tests__/corpus/product';
import { ANSWERS as PRODUCT_ANSWERS, ctx as productCtx, prefedRegistry } from '../src/__tests__/corpus/product-fixtures';
import { a, fromGin } from '../src/index';

// ============================================================================
// Profiles: `@aeye/schema` profile ↔ core FormatDescriptor
// ============================================================================

export interface ProfilePair { readonly id: string; readonly a: Profile; readonly d: core.FormatDescriptor }
export const PROFILES: readonly ProfilePair[] = [
  { id: 'openai-strict', a: OPENAI_STRICT, d: core.OPENAI_STRICT },
  { id: 'anthropic-strict', a: ANTHROPIC_STRICT, d: core.ANTHROPIC_STRICT },
  { id: 'gemini', a: GOOGLE_STRICT, d: core.GOOGLE_STRICT },
  { id: 'lenient', a: LENIENT, d: core.LENIENT },
];
export const asTool = (p: Profile): Profile => variant(p, { rootObject: true });

// ============================================================================
// zod twins of the corpus tools
// ============================================================================

export const TypeImportArgsZ = () => z.object({
  glob: z.string().describe('Glob pattern for files to analyze (e.g., "data/*.csv", "**/*.txt")'),
  hints: z.array(z.string()).optional().describe('Optional type name hints to focus discovery (e.g., ["user", "order", "product"])'),
  max: z.number().optional().describe('Maximum number of types to discover (default: unlimited)'),
});
export const ImageFindArgsZ = () => z.object({
  query: z.string().describe('Description of what to find in images'),
  glob: z.string().describe('Glob pattern for image files to search (e.g., "**/*.png", "photos/*.jpg")'),
  maxImages: z.number().optional().default(100).describe('Maximum number of images to analyze (default: 100)'),
  n: z.number().optional().default(5).describe('Number of top results to return (default: 5)'),
});
export const ChartZ = () => {
  const variants = ['bar', 'horizontalBar', 'pictorialBar'] as const;
  return z.object({
    chartGroup: z.literal('categoryComparison'),
    title: z.string().optional().describe('Optional chart title'),
    data: z.array(z.object({ name: z.string().describe('Name/label for the data point'), value: z.number().describe('Numeric value for the data point') })).describe('Array of data points for category comparison'),
    variantOptions: z.record(z.enum(variants), z.record(z.string(), z.unknown())).optional().describe('Optional variant-specific ECharts options'),
    defaultVariant: z.enum(variants).optional().describe('Default variant to display'),
  });
};
export const McpServerConfigZ = () => {
  const Per = z.enum(['shared', 'person']);
  const Header = z.string().regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/);
  const RemoteAuth = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('none') }),
    z.object({ kind: z.literal('bearer'), per: Per, token: z.string().min(1).optional() }),
    z.object({ kind: z.literal('headers'), per: Per, names: z.array(Header).min(1), values: z.record(z.string(), z.string()).optional() }),
    z.object({ kind: z.literal('oauth'), per: Per, scopes: z.array(z.string().min(1)).optional(), clientId: z.string().min(1).optional(), clientSecret: z.string().min(1).optional() }),
  ]);
  // The harness writes `z.string().url()`; core's toJSONSchema has no ZodURL case (it warns and emits {}),
  // so the twin uses a pattern of the same strength for http(s) URLs.
  const Url = z.string().regex(/^https?:\/\/\S+$/);
  const Transport = z.discriminatedUnion('type', [
    z.object({ type: z.literal('stdio'), command: z.string().min(1), args: z.array(z.string()).default([]), env: z.record(z.string(), z.string()).optional().describe('Environment values by name (config secrets).'), cwd: z.string().min(1).optional() }),
    z.object({ type: z.literal('http'), url: Url }),
    z.object({ type: z.literal('sse'), url: Url }),
  ]);
  return z.object({
    label: z.string().min(1), description: z.string().optional(), transport: Transport,
    auth: RemoteAuth.default({ kind: 'none' }), trusted: z.boolean().default(false),
    approval: z.enum(['always', 'writes', 'never']).default('writes'), prompts: z.boolean().default(true), resources: z.boolean().default(true),
    maxTools: z.int().min(1).max(1000).default(200), timeout: z.int().min(1000).default(120_000),
  });
};
const ginValues = ginCreateRegistry();
export const TaskZ = () => ginValues.parse(TaskDef as never).toValueSchema();

// ============================================================================
// `a` factories: the corpus schemas (cletus-tools.ts, harness-fns.ts, gin-values.ts) as functions, so a
// cold build makes new instances. Same definitions as the corpus modules.
// ============================================================================

export const TypeImportArgsA = () => a.object({
  glob: a.string().describe('Glob pattern for files to analyze (e.g., "data/*.csv", "**/*.txt")'),
  hints: a.array(a.string()).optional().describe('Optional type name hints to focus discovery (e.g., ["user", "order", "product"])'),
  max: a.number().optional().describe('Maximum number of types to discover (default: unlimited)'),
});
export const ImageFindArgsA = () => a.object({
  query: a.string().describe('Description of what to find in images'),
  glob: a.string().describe('Glob pattern for image files to search (e.g., "**/*.png", "photos/*.jpg")'),
  maxImages: a.number().default(100).describe('Maximum number of images to analyze (default: 100)'),
  n: a.number().default(5).describe('Number of top results to return (default: 5)'),
});
export const ChartA = () => {
  const variants = ['bar', 'horizontalBar', 'pictorialBar'] as const;
  return a.object({
    chartGroup: a.literal('categoryComparison'),
    title: a.string().optional().describe('Optional chart title'),
    data: a.array(a.object({ name: a.string().describe('Name/label for the data point'), value: a.number().describe('Numeric value for the data point') })).describe('Array of data points for category comparison'),
    variantOptions: a.record(a.enum(variants), a.record(a.unknown())).optional().describe('Optional variant-specific ECharts options'),
    defaultVariant: a.enum(variants).optional().describe('Default variant to display'),
  });
};
export const McpServerConfigA = () => {
  const Per = a.enum(['shared', 'person']);
  const Header = a.string().pattern(/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/);
  const RemoteAuth = a.discriminatedUnion('kind', [
    a.object({ kind: a.literal('none') }),
    a.object({ kind: a.literal('bearer'), per: Per, token: a.string().min(1).optional() }),
    a.object({ kind: a.literal('headers'), per: Per, names: a.array(Header).min(1), values: a.record(a.string()).optional() }),
    a.object({ kind: a.literal('oauth'), per: Per, scopes: a.array(a.string().min(1)).optional(), clientId: a.string().min(1).optional(), clientSecret: a.string().min(1).optional() }),
  ]);
  const Url = a.string().pattern(/^https?:\/\/\S+$/);
  const Transport = a.discriminatedUnion('type', [
    a.object({ type: a.literal('stdio'), command: a.string().min(1), args: a.array(a.string()).default([]), env: a.record(a.string()).optional().describe('Environment values by name (config secrets).'), cwd: a.string().min(1).optional() }),
    a.object({ type: a.literal('http'), url: Url }),
    a.object({ type: a.literal('sse'), url: Url }),
  ]);
  return a.object({
    label: a.string().min(1), description: a.string().optional(), transport: Transport,
    auth: RemoteAuth.default({ kind: 'none' }), trusted: a.boolean().default(false),
    approval: a.enum(['always', 'writes', 'never']).default('writes'), prompts: a.boolean().default(true), resources: a.boolean().default(true),
    maxTools: a.int().min(1).max(1000).default(200), timeout: a.int().min(1000).default(120_000),
  });
};
export const TaskA = () => fromGin(TaskDef);

// ============================================================================
// Answers
// ============================================================================

export interface Answer {
  readonly name: string;
  /** The code-shape value; the wire value per profile is the `a` encoding of it. */
  readonly code: () => unknown;
  /** Make it invalid: set this code path of the wire value (through JSON-text strings) to a wrong value. */
  readonly invalid?: readonly [readonly (string | number)[], unknown];
  /** The zod side's code shape when it differs (gin's maps are pairs in gin's own code shape). */
  readonly zodCode?: (code: any) => unknown;
  readonly big?: boolean;
}

const chartRows = (n: number) => ({
  chartGroup: 'categoryComparison', title: 'Revenue by region', defaultVariant: 'bar',
  data: Array.from({ length: n }, (_, i) => ({ name: `region-${i}`, value: i * 1.5 })),
});
const mcp = () => ({
  label: 'github', transport: { type: 'stdio', command: 'npx', args: ['-y', 'gh-mcp'], env: { GH_TOKEN: 'x', HOME: '/home/a' } },
  auth: { kind: 'headers', per: 'shared', names: ['X-Api-Key'], values: { 'X-Api-Key': 'k' } }, trusted: true, approval: 'always', prompts: true, resources: false, maxTools: 50, timeout: 5000,
});
const task = () => ({
  title: 'Ship it', points: 3, done: false, tags: ['infra'], weights: { ann: 0.5, bo: 1 }, byDay: [{ key: 1, value: 'mon' }],
  note: 'soon', due: '2024-03-01', level: 'high', kind: 'task', owner: 'ann', extra: { any: ['json'] },
});
const ginTaskCode = (c: any) => ({ ...c, weights: Object.entries(c.weights).map(([key, value]) => ({ key, value })) });

/** A gin program `if` nested `depth` deep. */
const deepIf = (depth: number): unknown => {
  let e: unknown = t('num', 0);
  for (let i = 0; i < depth; i++) e = { kind: 'if', ifs: [{ condition: { kind: 'get', path: [{ prop: 'x' }, { prop: 'gt' }, { args: { other: t('num', i) } }] }, body: e }], else: t('num', i) };
  return e;
};
/** A gin block of `n` lines (person programs). */
const wideBlock = (n: number) => ({ kind: 'block', lines: Array.from({ length: n }, () => structuredClone(personProgram)) });

const fieldRef = (source: string, field: string) => ({ kind: 'field-ref', source, field });
/** A select whose one field is a `+` chain `depth` deep. */
const deepQuery = (depth: number) => {
  let e: unknown = fieldRef('user', 'age');
  for (let i = 0; i < depth; i++) e = { kind: 'binary', op: '+', left: e, right: { kind: 'literal', value: i } };
  return { kind: 'select', fields: [{ expr: e, as: 'x' }], from: { kind: 'type', type: 'user' } };
};
/** An insert of `n` rows: typed writes take values, open writes take exprs (literals). */
const insertRows = (n: number, typed: boolean) => {
  const v = (x: unknown) => (typed ? x : { kind: 'literal', value: x });
  return {
    kind: 'insert', into: 'order',
    rows: Array.from({ length: n }, (_, i) => ({ id: v(i), userId: v(`u${i}`), total: v(i * 1.5), note: i % 2 ? v('gift') : { kind: 'param', name: 'note' } })),
  };
};
const richQuery = () => ({
  kind: 'select', distinct: true,
  fields: [
    { expr: { kind: 'case', branches: [{ when: { kind: 'is-null', value: fieldRef('user', 'age') }, then: { kind: 'literal', value: 'unknown' } }], else: { kind: 'binary', op: '+', left: fieldRef('user', 'age'), right: { kind: 'unary', op: '-', operand: { kind: 'literal', value: 1 } } } }, as: 'ageish' },
  ],
  from: { kind: 'type', type: 'user' },
  where: [{ kind: 'logical', op: 'and', operands: [
    { kind: 'in', value: fieldRef('user', 'id'), in: { kind: 'select', fields: [{ expr: fieldRef('order', 'userId') }], from: { kind: 'type', type: 'order' } } },
    { kind: 'between', value: fieldRef('user', 'age'), lower: { kind: 'literal', value: 18 }, upper: { kind: 'literal', value: 65 } },
  ] }],
  order: [{ expr: fieldRef('user', 'name'), dir: 'asc' }],
  limit: 10,
});

// ============================================================================
// Cases
// ============================================================================

export interface Case {
  readonly id: string;
  readonly label: string;
  /** `a`: the bound schema. `fresh` = a new bind (cache miss; for static schemas a new Bound). */
  readonly aBound: (fresh: boolean) => Bound<any>;
  /** zod: the schema as the caller builds it (per call for the dynamic ones, as product/gin do). */
  readonly zod: () => z.ZodType;
  readonly answers: readonly Answer[];
  readonly dynamic: boolean;
  /** Static cases: build the schema (new instances). */
  readonly aBuild?: () => unknown;
}

/** A static schema: `fresh` builds the schema again (new instances, nothing cached), else one memoized instance. */
const staticCase = (factory: () => any) => {
  let kept: any;
  return (fresh: boolean): Bound<any> => (fresh ? staticBundle(factory()).bind() : staticBundle((kept ??= factory())).bind());
};

const ginReg0 = ginFixtureRegistry();
const ginReg = asGrammarRegistry(ginReg0);
const qReg = queryFixtureRegistry();
const qCat = catalogOf(qReg);
let version = 1_000_000;
const freshCatalog = (c: QueryCatalog): QueryCatalog => ({ ...c, version: ++version });
export const QueryTool = QueryModule.result(a.object({ query: a.ref('Query') }));

const queryCase = (id: string, label: string, o: BuildOptions): Case => ({
  id, label, dynamic: true,
  aBound: (fresh) => QueryTool.bind(fresh ? freshCatalog(qCat) : qCat, o),
  zod: () => z.object({ query: queryBuildSchemas(qReg, o as never).Query }),
  answers: [
    { name: 'rich select', code: () => ({ query: richQuery() }), invalid: [['query', 'where', 0, 'op'], 'xor'] },
    { name: 'insert 1k rows', big: true, code: () => ({ query: insertRows(1000, o.strict === true) }), invalid: o.strict === true ? [['query', 'rows', 999, 'id'], 'one'] : [['query', 'rows', 999], 5] },
    { name: 'expr 100 deep', big: true, code: () => ({ query: deepQuery(100) }), invalid: [['query', 'fields', 0, 'expr', 'left', 'left', 'op'], '^^'] },
  ],
});

export const CASES: readonly Case[] = [
  {
    id: 'tool-small', label: 'small tool args (cletus type_import)', dynamic: false,
    aBound: staticCase(TypeImportArgsA), aBuild: TypeImportArgsA, zod: TypeImportArgsZ,
    answers: [{ name: 'args', code: () => ({ glob: 'data/**/*.csv', hints: ['user', 'order'] }), invalid: [['glob'], 5] }],
  },
  {
    id: 'tool-defaults', label: 'small tool args with defaults (cletus image_find)', dynamic: false,
    aBound: staticCase(ImageFindArgsA), aBuild: ImageFindArgsA, zod: ImageFindArgsZ,
    answers: [{ name: 'args', code: () => ({ query: 'red cars', glob: 'photos/*.jpg', maxImages: 100, n: 5 }), invalid: [['n'], 'five'] }],
  },
  {
    id: 'gin-value', label: 'gin value (Task obj via toValueSchema)', dynamic: false,
    aBound: staticCase(TaskA), aBuild: TaskA, zod: TaskZ,
    answers: [{ name: 'task', code: task, zodCode: ginTaskCode, invalid: [['points'], -1] }],
  },
  {
    id: 'harness-fn', label: 'harness fn (MCP server config)', dynamic: false,
    aBound: staticCase(McpServerConfigA), aBuild: McpServerConfigA, zod: McpServerConfigZ,
    answers: [{ name: 'config', code: mcp, invalid: [['transport', 'command'], ''] }],
  },
  {
    id: 'chart-1k', label: 'cletus chart, 1k data rows', dynamic: false,
    aBound: staticCase(ChartA), aBuild: ChartA, zod: ChartZ,
    answers: [
      { name: '10 rows', code: () => chartRows(10), invalid: [['data', 9, 'value'], 'x'] },
      { name: '1k rows', big: true, code: () => chartRows(1000), invalid: [['data', 999, 'value'], 'x'] },
    ],
  },
  {
    id: 'gin-grammar', label: 'gin grammar (write a program: TypeDef + Expr)', dynamic: true,
    // gin binds are keyed by the registry's content: a fresh bind empties the bundle's bind cache first.
    aBound: (fresh) => { if (fresh) (WriteArgs as unknown as { cache: Map<unknown, unknown> }).cache.clear(); return WriteArgs.bind(ginReg); },
    zod: () => z.object({ program: ginBuildSchemas(ginReg0).Expr }),
    answers: [
      { name: 'everything program', code: () => ({ program: everythingProgram }), invalid: [['program', 'lines', 0, 'kind'], 'nope'] },
      { name: 'block of 200 programs', big: true, code: () => ({ program: wideBlock(200) }), invalid: [['program', 'lines', 199, 'body', 'lines', 2, 'kind'], 'nope'] },
      { name: 'if 60 deep', big: true, code: () => ({ program: deepIf(60) }), invalid: [['program', 'ifs', 0, 'body', 'ifs', 0, 'body', 'kind'], 'nope'] },
    ],
  },
  queryCase('query-open', 'query open (default)', {}),
  queryCase('query-names', 'query names (functions: names)', { depth: { functions: 'names' } }),
  queryCase('query-typed', 'query typed (functions: typed)', { depth: { functions: 'typed' } }),
  queryCase('query-paired', 'query paired (strict: true)', { strict: true }),
  {
    id: 'product-query-set', label: 'product query_set (strict, maxEnumSize 100)', dynamic: true,
    aBound: (fresh) => QuerySetArgs.bind(productCtx(fresh ? { catalog: freshCatalog(productCtx().catalog) } : {})),
    zod: () => z.object({ value: queryBuildSchemas(prefedRegistry, { strict: true, maxEnumSize: 100 }).Query }),
    answers: [
      { name: 'groupCount', code: () => ({ value: PRODUCT_ANSWERS.groupCount }), invalid: [['value', 'from', 'type'], 'invoice'] },
      { name: 'insert', code: () => ({ value: PRODUCT_ANSWERS.insertValues }), invalid: [['value', 'rows', 0, 'status'], 'later'] },
    ],
  },
];

// ============================================================================
// Requests
// ============================================================================

/** The tools a request is made of: (a schema, zod factory, sample) triples, cycled with distinct names and descriptions. */
const TOOL_KINDS = [
  { a: TypeImportArgs, z: TypeImportArgsZ },
  { a: ImageFindArgs, z: ImageFindArgsZ },
  { a: McpServerConfig, z: McpServerConfigZ },
  { a: CategoryComparisonChart, z: ChartZ },
  { a: Task, z: TaskZ },
] as const;

export interface RequestCase {
  readonly id: string;
  readonly label: string;
  readonly aItems: () => RequestItem[];
  readonly zTools: () => { name: string; parameters: z.ZodType; strict?: boolean | number }[];
}

const nTools = (n: number): RequestCase => ({
  id: `request-${n}`, label: `${n}-tool request`,
  aItems: () => Array.from({ length: n }, (_, i) => {
    const k = TOOL_KINDS[i % TOOL_KINDS.length]!;
    return { kind: 'tool', name: `tool_${i}`, description: `Tool number ${i}.`, schema: staticBundle((k.a as any).describe(`Tool number ${i}.`)) } as RequestItem;
  }),
  zTools: () => Array.from({ length: n }, (_, i) => ({ name: `tool_${i}`, parameters: TOOL_KINDS[i % TOOL_KINDS.length]!.z().describe(`Tool number ${i}.`) })),
});

export const REQUESTS: readonly RequestCase[] = [
  nTools(8),
  nTools(129),
  {
    id: 'request-query-agent', label: 'query agent (query_set + 4 small tools)',
    aItems: () => [
      { kind: 'tool', name: 'query_set', schema: QuerySetArgs.bind(productCtx()), strict: true },
      ...nTools(4).aItems(),
    ],
    zTools: () => [
      { name: 'query_set', parameters: z.object({ value: queryBuildSchemas(prefedRegistry, { strict: true, maxEnumSize: 100 }).Query }), strict: true },
      ...nTools(4).zTools(),
    ],
  },
];

/** The zod request path: openai.ts convertTools over ai/registry.ts's budget allocation. */
export function zodRequest(tools: ReturnType<RequestCase['zTools']>, d: core.FormatDescriptor): unknown[] {
  const budget = new core.SchemaBudget(d, d);
  const descriptors: core.FormatDescriptor[] = new Array(tools.length);
  tools
    .map((tool, i) => ({ i, p: core.strictPriority(tool.strict) }))
    .sort((x, y) => y.p - x.p)
    .forEach(({ i }) => { descriptors[i] = budget.allocateTool(tools[i]!.parameters as never, tools[i]!.strict); });
  return tools.map((tool, i) => {
    const descriptor = descriptors[i]!;
    return {
      type: 'function',
      function: { name: tool.name, parameters: core.toJSONSchema(core.strictify(tool.parameters as never, descriptor), descriptor), ...(descriptor.strict ? { strict: true } : {}) },
    };
  });
}

export const aRequest = (items: RequestItem[], p: Profile) => ModelProfile.of(p).request(items);
export { core, z, releaseZodIds };
