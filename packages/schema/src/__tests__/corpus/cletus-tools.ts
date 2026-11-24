/**
 * CORPUS: every @aeye/cletus tool's argument schema (packages/cletus/src/tools/*.ts),
 * ported faithfully to `a`, with the static types they produce.
 *
 * Function-form schemas (`schema: (ctx) => z.object(...)`) become chains whose
 * `.dynamic((ctx) => ...)` step supplies the ctx-dependent part; "tool
 * unavailable" moves to `applicable(ctx)` (proposal/core-api.ts).
 *
 * zod features with no `a` counterpart are ported as the closest thing and
 * recorded as gaps in cletus-tools.test.ts:
 *  - `.optional().default(x)` (artist/internet/librarian/clerk): `.default(x)` (optional on
 *    the wire, required in code, filled on decode — as zod's output type).
 *  - `z.any()` → `a.unknown()` (zod infers `any`).
 */
import { expectTypeOf } from 'expect-type';
import { a, type SchemaOf } from '../../index';
import { tool, type Context } from '../../proposal/core-api';

// ============================================================================
// The ctx cletus tools read (stand-in for CletusAIContext)
// ============================================================================

/** packages/cletus/src/schemas.ts:221 TypeFieldSchema (storage type, used to build model schemas). */
export interface TypeField {
  name: string;
  friendlyName: string;
  type: string;
  default?: string | number | boolean;
  required?: boolean;
  enumOptions?: string[];
  onDelete?: 'restrict' | 'cascade' | 'setNull';
}
/** packages/cletus/src/schemas.ts:231 TypeDefinitionSchema. */
export interface TypeDefinition {
  name: string;
  friendlyName: string;
  description?: string;
  knowledgeTemplate: string;
  fields: TypeField[];
}
/** packages/cletus/src/schemas.ts:191/195. */
export type ChatMode = 'none' | 'read' | 'create' | 'update' | 'delete';
export type AgentMode = 'plan' | 'default';

export interface ConfigData {
  types: TypeDefinition[];
  user: { maxQuerySchemaTypes?: number };
}
/** What cletus tool schemas/applicable read from ctx: `ctx.config.getData()` and `ctx.chat`. */
export type CletusCtx = Context<{
  config: { getData(): ConfigData };
  chat?: { mode?: ChatMode; agentMode?: AgentMode };
}>;

/** The type names as a non-empty tuple (an `applicable` guard makes it non-empty). */
export const typeNames = (ctx: CletusCtx): [string, ...string[]] => {
  const names = ctx.config.getData().types.map((t) => t.name);
  return (names.length ? names : ['(none)']) as [string, ...string[]];
};
/** Dynamic parts are cached per types array (the config replaces it on change). */
const byTypes = { key: (ctx: CletusCtx) => ctx.config.getData().types };
const hasTypes = (ctx: CletusCtx) => ctx.config.getData().types.length > 0;

/** A `type` enum of the configured type names (dba.ts:23, architect.ts:24...). */
const TypeName = a.declare<{ TypeName: string }>().dynamic((ctx: CletusCtx) => ({ TypeName: a.enum(typeNames(ctx)) }), byTypes);

// ============================================================================
// architect (packages/cletus/src/tools/architect.ts)
// ============================================================================

/**
 * architect.ts:12 `fieldType`: built when the tools are created, from the
 * types at that time: primitives + every type name. A ctx-dependent enum.
 */
export const FieldTypeDyn = a.declare<{ FieldType: string }>().dynamic(
  (ctx: CletusCtx) => ({
    FieldType: a.enum(['string', 'number', 'boolean', 'date', 'enum', ...ctx.config.getData().types.map((t) => t.name)])
      .describe('Field type - can be a primitive type (string, number, boolean, date, enum) or the name of another type to create a relationship'),
  }),
  byTypes,
);

// architect.ts:23
export const TypeInfoArgs = TypeName.result(a.object({
  name: a.ref('TypeName').describe('Type name to get information about'),
}));
export const typeInfo = tool({
  name: 'type_info',
  description: 'Get all information about a type definition',
  schema: TypeInfoArgs,
  applicable: hasTypes,
  call: (input) => input,
});
expectTypeOf(typeInfo.call).parameter(0).toEqualTypeOf<{ name: string }>();

// architect.ts:41 — `z.object({ ...globalToolProperties })` (globalToolProperties is empty, ai.ts:305).
export const TypeListArgs = a.object({});
expectTypeOf<a.infer<typeof TypeListArgs>>().toEqualTypeOf<{}>();

/** architect.ts:85 `update.fields[].change` when not null. */
const FieldChange = a.object({
  friendlyName: a.string().optional().describe('Field display name, only specify if changing'),
  type: a.ref('FieldType').optional().describe('Field type, only specify if changing'),
  required: a.boolean().optional().describe('Is field required? Only specify if changing'),
  default: a.union([a.string(), a.number(), a.boolean()]).optional().describe('Default value, only specify if changing'),
  enumOptions: a.array(a.string()).optional().describe('Valid enum values (required for enum type), only specify if changing or adding enum field'),
  onDelete: a.enum(['restrict', 'cascade', 'setNull']).optional().describe('Cascade delete behavior for reference fields, only specify if changing: restrict (default, prevent deletion), cascade (delete referencing records), setNull (set field to null)'),
});

// architect.ts:76 — both the type names (ctx) and fieldType (types at creation) are dynamic.
export const TypeUpdateArgs = a
  .declare<{ TypeName: string; FieldType: string }>()
  .dynamic((ctx: CletusCtx) => ({
    TypeName: a.enum(typeNames(ctx)),
    FieldType: a.enum(['string', 'number', 'boolean', 'date', 'enum', ...ctx.config.getData().types.map((t) => t.name)])
      .describe('Field type - can be a primitive type (string, number, boolean, date, enum) or the name of another type to create a relationship'),
  }), byTypes)
  .result(a.object({
    name: a.ref('TypeName').describe('Type name to update'),
    update: a.object({
      friendlyName: a.string().optional().describe('New friendly name'),
      description: a.string().optional().describe('New description'),
      knowledgeTemplate: a.string().optional().describe('New Handlebars template for knowledge generation, ie: {{name}} and {{#if field}}...{{/if}}. It should include all fields and if the fields are optional #if statements should be used. Newlines & markdown can be used for formatting.'),
      fields: a.array(a.object({
        field: a.string().describe('Field name to update (lowercase, no spaces)'),
        change: a.union([a.null(), FieldChange]).describe('Field updates: set to null to delete'),
      })),
    }).describe('Updates to apply'),
  }));
export type FieldChangeT = {
  friendlyName?: string;
  type?: string;
  required?: boolean;
  default?: string | number | boolean;
  enumOptions?: string[];
  onDelete?: 'restrict' | 'cascade' | 'setNull';
};
export type TypeUpdateT = {
  name: string;
  update: {
    friendlyName?: string;
    description?: string;
    knowledgeTemplate?: string;
    fields: { field: string; change: null | FieldChangeT }[];
  };
};
expectTypeOf<a.infer<typeof TypeUpdateArgs>>().toEqualTypeOf<TypeUpdateT>();
expectTypeOf(TypeUpdateArgs.bind).parameters.toEqualTypeOf<[CletusCtx]>();
export const typeUpdate = tool({ name: 'type_update', description: 'Update an EXISTING type definition in a backwards compatible way', schema: TypeUpdateArgs, applicable: hasTypes, call: (input) => input });

// architect.ts:130 — static schema, but `fieldType` is built from the types at tool creation.
export const TypeCreateArgs = FieldTypeDyn.result(a.object({
  name: a.string().describe('Type name (lowercase, no spaces)'),
  friendlyName: a.string().describe('Display name'),
  description: a.string().optional().describe('Type description'),
  knowledgeTemplate: a.string().describe('Handlebars template for knowledge generation, ie: {{name}} and {{#if field}}...{{/if}}. It should include all fields and if the fields are optional #if statements should be used. Newlines & markdown can be used for formatting.'),
  fields: a.array(a.object({
    name: a.string().describe('Field name (lowecase, no spaces)'),
    friendlyName: a.string().describe('Field display name'),
    type: a.ref('FieldType'),
    default: a.union([a.string(), a.number(), a.boolean()]).optional().describe('Default value'),
    required: a.boolean().optional().describe('Is field required?'),
    enumOptions: a.array(a.string()).optional().describe('Valid enum values (required for enum type)'),
    onDelete: a.enum(['restrict', 'cascade', 'setNull']).optional().describe('Cascade delete behavior for reference fields: restrict (default, prevent deletion), cascade (delete referencing records), setNull (set field to null)'),
  })).describe('Field definitions'),
}));
export type TypeCreateT = {
  name: string;
  friendlyName: string;
  description?: string;
  knowledgeTemplate: string;
  fields: {
    name: string;
    friendlyName: string;
    type: string;
    default?: string | number | boolean;
    required?: boolean;
    enumOptions?: string[];
    onDelete?: 'restrict' | 'cascade' | 'setNull';
  }[];
};
expectTypeOf<a.infer<typeof TypeCreateArgs>>().toEqualTypeOf<TypeCreateT>();
// The created TypeDefinition is exactly the tool's args (minus optional description semantics).
expectTypeOf<TypeCreateT>().toMatchTypeOf<TypeDefinition>();

// architect.ts:163
export const TypeDeleteArgs = TypeName.result(a.object({ name: a.ref('TypeName').describe('Type name to delete') }));
expectTypeOf<a.infer<typeof TypeDeleteArgs>>().toEqualTypeOf<{ name: string }>();

// architect.ts:213
export const TypeImportArgs = a.object({
  glob: a.string().describe('Glob pattern for files to analyze (e.g., "data/*.csv", "**/*.txt")'),
  hints: a.array(a.string()).optional().describe('Optional type name hints to focus discovery (e.g., ["user", "order", "product"])'),
  max: a.number().optional().describe('Maximum number of types to discover (default: unlimited)'),
});
expectTypeOf<a.infer<typeof TypeImportArgs>>().toEqualTypeOf<{ glob: string; hints?: string[]; max?: number }>();

// ============================================================================
// artist (packages/cletus/src/tools/artist.ts, helpers/artist.ts)
// ============================================================================

// artist.ts:19 — `n: z.number().optional().default(1)` (`.default(1)`).
export const ImageGenerateArgs = a.object({
  prompt: a.string().describe('Text description of the image to generate'),
  n: a.number().default(1).describe('Number of images to generate (default: 1)'),
});
expectTypeOf<a.infer<typeof ImageGenerateArgs>>().toEqualTypeOf<{ prompt: string; n: number }>();

// artist.ts:37
export const ImageEditArgs = a.object({
  prompt: a.string().describe('Description of how to edit the image'),
  path: a.string().describe('Path to the image to edit (relative path or absolute path or [filename](filepath) URL)'),
});
expectTypeOf<a.infer<typeof ImageEditArgs>>().toEqualTypeOf<{ prompt: string; path: string }>();

// artist.ts:55 — maxCharacters default 2084 (`.default`).
export const ImageAnalyzeArgs = a.object({
  prompt: a.string().describe('Question or analysis request about the images'),
  paths: a.array(a.string()).describe('Paths to images to analyze (relative paths or absolute file or [filename](filepath))'),
  maxCharacters: a.number().default(2084).describe('Maximum response length (maxCharacters/4 = maxTokens, default: 2084)'),
});
expectTypeOf<a.infer<typeof ImageAnalyzeArgs>>().toEqualTypeOf<{ prompt: string; paths: string[]; maxCharacters: number }>();

// artist.ts:74
export const ImageDescribeArgs = a.object({
  path: a.string().describe('Path to the image to describe (relative path or absolute path or [filename](filepath))'),
});

// artist.ts:91 — maxImages default 100, n default 5 (`.default`).
export const ImageFindArgs = a.object({
  query: a.string().describe('Description of what to find in images'),
  glob: a.string().describe('Glob pattern for image files to search (e.g., "**/*.png", "photos/*.jpg")'),
  maxImages: a.number().default(100).describe('Maximum number of images to analyze (default: 100)'),
  n: a.number().default(5).describe('Number of top results to return (default: 5)'),
});
expectTypeOf<a.infer<typeof ImageFindArgs>>().toEqualTypeOf<{ query: string; glob: string; maxImages: number; n: number }>();

// artist.ts:110
export const ImageAttachArgs = a.object({
  path: a.string().describe('Path to the image file to attach (absolute or relative)'),
});

// helpers/artist.ts:8
export const ChartDataPoint = a.object({
  name: a.string().describe('Name/label for the data point'),
  value: a.number().describe('Numeric value for the data point'),
});

/** A chart group whose variantOptions is `z.record(z.enum(variants), z.record(z.string(), z.unknown()))`. */
function chartGroup<const G extends string, const V extends readonly [string, ...string[]]>(group: G, variants: V, dataDescription: string) {
  return a.object({
    chartGroup: a.literal(group),
    title: a.string().optional().describe('Optional chart title'),
    data: a.array(ChartDataPoint).describe(dataDescription),
    // zod v4: a record keyed by an enum is EXHAUSTIVE (every key required); `a.record(enum)` keys are optional.
    variantOptions: a.record(a.enum(variants), a.record(a.unknown())).optional().describe('Optional variant-specific ECharts options'),
    defaultVariant: a.enum(variants).optional().describe('Default variant to display'),
  });
}

// helpers/artist.ts:16 — the one group whose variantOptions is an object of optional `z.record(z.string(), z.any())`.
export const PartToWholeChart = a.object({
  chartGroup: a.literal('partToWhole'),
  title: a.string().optional().describe('Optional chart title'),
  data: a.array(ChartDataPoint).describe('Array of data points showing parts of a whole'),
  variantOptions: a.object({
    pie: a.record(a.unknown()).optional(),
    donut: a.record(a.unknown()).optional(),
    treemap: a.record(a.unknown()).optional(),
    sunburst: a.record(a.unknown()).optional(),
  }).optional().describe('Optional variant-specific ECharts options'),
  defaultVariant: a.enum(['pie', 'donut', 'treemap', 'sunburst']).optional().describe('Default variant to display'),
});
// helpers/artist.ts:28..124
export const CategoryComparisonChart = chartGroup('categoryComparison', ['bar', 'horizontalBar', 'pictorialBar'], 'Array of data points for category comparison');
export const TimeSeriesChart = chartGroup('timeSeries', ['line', 'area', 'step', 'smoothLine'], 'Array of time-series data points');
export const DistributionChart = chartGroup('distribution', ['histogram', 'boxplot'], 'Array of data points for distribution analysis');
export const CorrelationChart = chartGroup('correlation', ['scatter', 'effectScatter', 'heatmap'], 'Array of data points for correlation analysis');
export const RankingChart = chartGroup('ranking', ['orderedBar', 'horizontalOrderedBar'], 'Array of data points to rank');
export const HierarchicalChart = chartGroup('hierarchical', ['treemap', 'sunburst', 'tree'], 'Array of hierarchical data points');
export const FlowChart = chartGroup('flow', ['sankey', 'funnel'], 'Array of flow/funnel data points');
export const GeospatialChart = chartGroup('geospatial', ['map'], 'Array of geographic data points');
export const MultivariateComparisonChart = chartGroup('multivariateComparison', ['groupedBar', 'stackedBar', 'radar', 'parallel'], 'Array of data points for multivariate comparison');

// helpers/artist.ts:134 — a plain z.union (no discriminator); every option has a literal `chartGroup`.
export const ChartConfig = a.union([
  PartToWholeChart, CategoryComparisonChart, TimeSeriesChart, DistributionChart, CorrelationChart,
  RankingChart, HierarchicalChart, FlowChart, GeospatialChart, MultivariateComparisonChart,
]);
/** The same union, tagged (what the code means: a union picked by `chartGroup`). */
export const ChartConfigTagged = a.discriminatedUnion('chartGroup', [
  PartToWholeChart, CategoryComparisonChart, TimeSeriesChart, DistributionChart, CorrelationChart,
  RankingChart, HierarchicalChart, FlowChart, GeospatialChart, MultivariateComparisonChart,
]);
type Point = { name: string; value: number };
type Group<G, V extends string> = {
  chartGroup: G;
  title?: string;
  data: Point[];
  variantOptions?: { [K in V]?: Record<string, unknown> };
  defaultVariant?: V;
};
export type ChartConfigT =
  | {
    chartGroup: 'partToWhole';
    title?: string;
    data: Point[];
    variantOptions?: { pie?: Record<string, unknown>; donut?: Record<string, unknown>; treemap?: Record<string, unknown>; sunburst?: Record<string, unknown> };
    defaultVariant?: 'pie' | 'donut' | 'treemap' | 'sunburst';
  }
  | Group<'categoryComparison', 'bar' | 'horizontalBar' | 'pictorialBar'>
  | Group<'timeSeries', 'line' | 'area' | 'step' | 'smoothLine'>
  | Group<'distribution', 'histogram' | 'boxplot'>
  | Group<'correlation', 'scatter' | 'effectScatter' | 'heatmap'>
  | Group<'ranking', 'orderedBar' | 'horizontalOrderedBar'>
  | Group<'hierarchical', 'treemap' | 'sunburst' | 'tree'>
  | Group<'flow', 'sankey' | 'funnel'>
  | Group<'geospatial', 'map'>
  | Group<'multivariateComparison', 'groupedBar' | 'stackedBar' | 'radar' | 'parallel'>;
expectTypeOf<a.infer<typeof ChartConfig>>().toEqualTypeOf<ChartConfigT>();
expectTypeOf<a.infer<typeof ChartConfigTagged>>().toEqualTypeOf<ChartConfigT>();

// artist.ts:150 (strict: false; metadata.onlyClient: 'browser')
export const ChartDisplayArgs = a.object({ chart: ChartConfig });
expectTypeOf<a.infer<typeof ChartDisplayArgs>>().toEqualTypeOf<{ chart: ChartConfigT }>();

// artist.ts:172
export const DiagramShowArgs = a.object({ spec: a.string().describe('Mermaid diagram specification string') });

// ============================================================================
// clerk (packages/cletus/src/tools/clerk.ts)
// ============================================================================

// clerk.ts:20
export const FileSearchArgs = a.object({
  glob: a.string().describe('Glob pattern (e.g., "**/*.ts", "src/**/*.json")'),
  limit: a.number().optional().describe('Maximum results (default: 50)'),
  offset: a.number().optional().describe('Starting position for results (default: 0)'),
});
expectTypeOf<a.infer<typeof FileSearchArgs>>().toEqualTypeOf<{ glob: string; limit?: number; offset?: number }>();

// clerk.ts:39
export const FileSummaryArgs = a.object({
  path: a.string().describe('Relative file path'),
  limit: a.number().optional().describe('Maximum summary length in characters/lines (default: 64,000 chars or 1000 lines - whatever is smaller)'),
  offset: a.number().optional().describe('Character offset to start summary from (default: 0). This can be a negative number meaning it will start from the end of the file.'),
  limitOffsetMode: a.enum(['characters', 'lines']).optional().describe('Whether limit & offset are in characters or lines (default: "characters")'),
  describeImages: a.boolean().optional().describe('Generate descriptions for images (default: false)'),
  extractImages: a.boolean().optional().describe('Extract images from documents (default: false)'),
  transcribeImages: a.boolean().optional().describe('OCR text from images (default: false)'),
});
export type FileSummaryT = {
  path: string; limit?: number; offset?: number; limitOffsetMode?: 'characters' | 'lines';
  describeImages?: boolean; extractImages?: boolean; transcribeImages?: boolean;
};
expectTypeOf<a.infer<typeof FileSummaryArgs>>().toEqualTypeOf<FileSummaryT>();

// clerk.ts:92
export const FileIndexArgs = a.object({
  glob: a.string().describe('Glob pattern for files to index'),
  index: a.enum(['content', 'summary']).describe('Index mode: "content" embeds full text in chunks, "summary" embeds AI summary'),
  describeImages: a.boolean().optional().describe('Generate descriptions for images (default: false)'),
  extractImages: a.boolean().optional().describe('Extract images from documents (default: false)'),
  transcribeImages: a.boolean().optional().describe('OCR text from images (default: false)'),
});
expectTypeOf<a.infer<typeof FileIndexArgs>>().toEqualTypeOf<{ glob: string; index: 'content' | 'summary'; describeImages?: boolean; extractImages?: boolean; transcribeImages?: boolean }>();

// clerk.ts:113
export const FileCreateArgs = a.object({ path: a.string().describe('Relative file path'), content: a.string().describe('File content') });
// clerk.ts:131
export const FileCopyArgs = a.object({ glob: a.string().describe('Glob pattern for files to copy'), target: a.string().describe('Destination file path or directory') });
// clerk.ts:152
export const FileMoveArgs = a.object({ glob: a.string().describe('Glob pattern for files to move'), target: a.string().describe('Destination directory or file') });
// clerk.ts:178 / 196 / 315 / 361
export const FileStatsArgs = a.object({ path: a.string().describe('Relative file path') });
export const FileDeleteArgs = a.object({ path: a.string().describe('Relative file path') });
export const DirCreateArgs = a.object({ path: a.string().describe('Relative directory path') });
export const FileAttachArgs = a.object({ path: a.string().describe('Relative path to the text, audio, or PDF file to attach') });
expectTypeOf<a.infer<typeof FileCreateArgs>>().toEqualTypeOf<{ path: string; content: string }>();
expectTypeOf<a.infer<typeof FileMoveArgs>>().toEqualTypeOf<{ glob: string; target: string }>();
expectTypeOf<a.infer<typeof FileStatsArgs>>().toEqualTypeOf<{ path: string }>();

// clerk.ts:222 — `limitOffsetMode: z.enum([...]).default('characters')` (`.default`).
export const FileReadArgs = a.object({
  path: a.string().describe('Relative file path'),
  limit: a.number().optional().describe('Maximum summary length in characters/lines (default: 64,000 chars or 1000 lines - whatever is smaller)'),
  offset: a.number().optional().describe('Character offset to start reading from (default: 0). This can be a negative number meaning it will start from the end of the file.'),
  limitOffsetMode: a.enum(['characters', 'lines']).default('characters').describe('Whether limit & offset are in characters or lines (default: "characters")'),
  showLines: a.boolean().optional().describe('Include line numbers in output (default: false)'),
  describeImages: a.boolean().optional().describe('Generate descriptions for images (default: false)'),
  extractImages: a.boolean().optional().describe('Extract images from documents (default: false)'),
  transcribeImages: a.boolean().optional().describe('OCR text from images (default: false)'),
});

// clerk.ts:252
export const FileEditArgs = a.object({
  path: a.string().describe('Relative file path to edit'),
  request: a.string().describe('Detailed request describing the changes to make. Be precise with rules and requirements.'),
  offset: a.number().optional().describe('Line offset to start editing from (default: 0). Negative numbers start from the end.'),
  limit: a.number().optional().describe('Maximum lines to edit (default: 1000 lines)'),
});

// clerk.ts:284
export const TextSearchArgs = a.object({
  glob: a.string().describe('Glob pattern for files to search'),
  regex: a.string().describe('Regular expression pattern, EMCA syntax'),
  caseInsensitive: a.boolean().optional().describe('Case insensitive search (default: true)'),
  output: a.enum(['file-count', 'files', 'match-count', 'matches']).optional().describe('Output format (default: "matches")'),
  surrounding: a.number().optional().describe('Lines of context around match (default: 0)'),
  transcribeImages: a.boolean().optional().describe('OCR text from images before searching (default: false). This may be slow and costly so the user should be prompted for permission if not done so yet.'),
  offset: a.number().optional().describe('Starting position for results (default: 0)'),
  limit: a.number().optional().describe('Maximum results (default: 0 = unlimited)'),
});
export type TextSearchT = {
  glob: string; regex: string; caseInsensitive?: boolean; output?: 'file-count' | 'files' | 'match-count' | 'matches';
  surrounding?: number; transcribeImages?: boolean; offset?: number; limit?: number;
};
expectTypeOf<a.infer<typeof TextSearchArgs>>().toEqualTypeOf<TextSearchT>();

// clerk.ts:342
export const DirSummaryArgs = a.object({
  path: a.string().optional().describe('Relative directory path (defaults to CWD)'),
  kind: a.enum(['files', 'dirs', 'ext', 'all']).optional().describe('Type of summary: files, dirs, ext (extensions), or all (default: all)'),
  depth: a.number().optional().describe('Maximum depth to traverse (default: 10)'),
});
expectTypeOf<a.infer<typeof DirSummaryArgs>>().toEqualTypeOf<{ path?: string; kind?: 'files' | 'dirs' | 'ext' | 'all'; depth?: number }>();

// clerk.ts:397
export const ShellArgs = a.object({ command: a.string().describe('Shell command to execute') });

// ============================================================================
// dba (packages/cletus/src/tools/dba.ts) — the simple ones; `query` is in cletus-dba.ts
// ============================================================================

// dba.ts:30
export const DataIndexArgs = TypeName.result(a.object({ type: a.ref('TypeName').describe('Type name to index') }));
// dba.ts:56
export const DataImportArgs = TypeName.result(a.object({
  type: a.ref('TypeName').describe('Type name to import into'),
  glob: a.string().describe('Glob pattern for files to import (e.g., "data/*.csv", "**/*.txt")'),
  transcribeImages: a.boolean().optional().describe('Extract text from images in documents (default: false)'),
}));
// dba.ts:75
export const DataSearchArgs = TypeName.result(a.object({
  type: a.ref('TypeName').describe('Type name to search'),
  query: a.string().describe('Search query text'),
  n: a.number().optional().describe('Maximum results (default: 10)'),
}));
// dba.ts:100
export const DataGetArgs = TypeName.result(a.object({
  type: a.ref('TypeName').describe('Type name to retrieve records from'),
  offset: a.number().optional().describe('Number of records to skip (default: 0)'),
  limit: a.number().optional().describe('Maximum records to return (default: 10)'),
}));
expectTypeOf<a.infer<typeof DataIndexArgs>>().toEqualTypeOf<{ type: string }>();
expectTypeOf<a.infer<typeof DataImportArgs>>().toEqualTypeOf<{ type: string; glob: string; transcribeImages?: boolean }>();
expectTypeOf<a.infer<typeof DataSearchArgs>>().toEqualTypeOf<{ type: string; query: string; n?: number }>();
expectTypeOf<a.infer<typeof DataGetArgs>>().toEqualTypeOf<{ type: string; offset?: number; limit?: number }>();
expectTypeOf(DataGetArgs.bind).parameters.toEqualTypeOf<[CletusCtx]>();
export const dataGet = tool({ name: 'data_get', description: 'Get paginated records of a data type', schema: DataGetArgs, applicable: hasTypes, call: (input) => input });
expectTypeOf(dataGet.call).parameter(0).toEqualTypeOf<{ type: string; offset?: number; limit?: number }>();
// A tool whose ctx has no config can't take the ctx-dependent schema.
tool({
  name: 'bad',
  description: '',
  // @ts-expect-error — DataGetArgs needs ctx.config.
  schema: DataGetArgs as typeof DataGetArgs,
  call: (_input, _ctx: Context<{ other: true }>) => '',
});

// ============================================================================
// internet (packages/cletus/src/tools/internet.ts)
// ============================================================================

// internet.ts:19 — maxResults default 5 (`.default`).
export const WebSearchArgs = a.object({
  query: a.string().describe('Search query'),
  maxResults: a.number().default(5).describe('Maximum number of results to return (default: 5)'),
});
// internet.ts:43
export const WebGetPageArgs = a.object({
  url: a.string().describe('URL of the page to fetch'),
  type: a.enum(['html', 'text']).describe('Content type to return: "html" for raw HTML, "text" for plain text'),
  regex: a.string().optional().describe('Optional regex pattern to search for in content'),
  surrounding: a.number().optional().describe('Number of surrounding lines to include when using regex (default: 0)'),
  lineStart: a.number().optional().describe('Starting line number (1-indexed)'),
  lineEnd: a.number().optional().describe('Ending line number (1-indexed)'),
});
expectTypeOf<a.infer<typeof WebGetPageArgs>>().toEqualTypeOf<{ url: string; type: 'html' | 'text'; regex?: string; surrounding?: number; lineStart?: number; lineEnd?: number }>();
// internet.ts:76 — a string record of headers: pairs on OpenAI/Anthropic strict.
export const WebApiCallArgs = a.object({
  url: a.string().describe('API endpoint URL'),
  method: a.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']).describe('HTTP method'),
  headers: a.record(a.string()).optional().describe('Request headers as key-value pairs'),
  body: a.string().optional().describe('Request body (for POST, PUT, PATCH)'),
  requestType: a.enum(['json', 'text', 'binary']).optional().describe('Request body type (default: text)'),
  responseType: a.enum(['json', 'text', 'binary']).optional().describe('Expected response type (default: text)'),
});
export type WebApiCallT = {
  url: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';
  headers?: Record<string, string>;
  body?: string;
  requestType?: 'json' | 'text' | 'binary';
  responseType?: 'json' | 'text' | 'binary';
};
expectTypeOf<a.infer<typeof WebApiCallArgs>>().toEqualTypeOf<WebApiCallT>();
// internet.ts:111
export const WebDownloadArgs = a.object({
  url: a.string().describe('URL of the file to download'),
  target: a.string().describe('Target file path where the file should be saved (can be relative or absolute)'),
});

// ============================================================================
// librarian (packages/cletus/src/tools/librarian.ts)
// ============================================================================

// librarian.ts:30
export const KnowledgeSearchArgs = a.object({
  query: a.string().describe('Search query text'),
  limit: a.number().optional().describe('Maximum results (default: 10)'),
  sourcePrefix: a.string().optional().describe('Filter by source prefix (e.g., "user", "task:", "file@{path}:")'),
});
// librarian.ts:61
export const KnowledgeSourcesArgs = a.object({});
// librarian.ts:77
export const KnowledgeAddArgs = a.object({ text: a.string().describe('The memory text to add') });
// librarian.ts:100 — caseSensitive default true (`.default`).
export const KnowledgeDeleteArgs = a.object({
  sourcePattern: a.string().describe('Regex pattern to match source strings (e.g., "^task:123", "file@.*\\.md:", "^user:")'),
  caseSensitive: a.boolean().default(true).describe('Whether pattern matching is case-sensitive (default: true)'),
});
expectTypeOf<a.infer<typeof KnowledgeSearchArgs>>().toEqualTypeOf<{ query: string; limit?: number; sourcePrefix?: string }>();
expectTypeOf<a.infer<typeof KnowledgeDeleteArgs>>().toEqualTypeOf<{ sourcePattern: string; caseSensitive: boolean }>();

// ============================================================================
// planner (packages/cletus/src/tools/planner.ts)
// ============================================================================

// planner.ts:18 / 34
export const TodosClearArgs = a.object({});
export const TodosListArgs = a.object({});
// planner.ts:50
export const TodosAddArgs = a.object({ name: a.string().describe('The todo name/description') });
// planner.ts:68 / 86 / 103
export const TodosDoneArgs = a.object({ id: a.string().describe('The todo ID to mark as done') });
export const TodosGetArgs = a.object({ id: a.string().describe('The todo ID') });
export const TodosRemoveArgs = a.object({ id: a.string().describe('The todo ID to remove') });
// planner.ts:121
export const TodosReplaceArgs = a.object({
  todos: a.array(a.object({ name: a.string(), done: a.boolean().optional() })).describe('Array of new todos'),
});
expectTypeOf<a.infer<typeof TodosReplaceArgs>>().toEqualTypeOf<{ todos: { name: string; done?: boolean }[] }>();

// ============================================================================
// secretary (packages/cletus/src/tools/secretary.ts)
// ============================================================================

// secretary.ts:18 / 35 / 53 / 71 / 87
export const AssistantSwitchArgs = a.object({ name: a.string().describe('Assistant name') });
export const AssistantUpdateArgs = a.object({ name: a.string().describe('Assistant name'), prompt: a.string().describe('New system prompt') });
export const AssistantAddArgs = a.object({ name: a.string().describe('Assistant name'), prompt: a.string().describe('System prompt for the assistant') });
export const MemoryListArgs = a.object({});
export const MemoryUpdateArgs = a.object({ content: a.string().describe('Memory content to add or update') });
expectTypeOf<a.infer<typeof AssistantAddArgs>>().toEqualTypeOf<{ name: string; prompt: string }>();

// ============================================================================
// utility (packages/cletus/src/tools/utility.ts)
// ============================================================================

// utility.ts:18
export const GetOperationOutputArgs = a.object({
  id: a.number().describe('The message ID provided in the truncation notice'),
  operation: a.number().describe('The operation index within the message provided in the truncation notice'),
});
// utility.ts:66
export const AboutArgs = a.object({});

/** packages/cletus/src/tool-registry.ts:234 */
export const STATIC_TOOLSETS = ['planner', 'librarian', 'clerk', 'secretary', 'architect', 'artist', 'internet', 'dba'] as const;
// utility.ts:110 — a function form with no ctx dependence: static.
export const RetoolArgs = a.object({
  toolset: a.enum(STATIC_TOOLSETS).nullable().describe('The toolset to switch to, or null to enable adaptive tool selection'),
});
expectTypeOf<a.infer<typeof RetoolArgs>>().toEqualTypeOf<{ toolset: (typeof STATIC_TOOLSETS)[number] | null }>();

/**
 * utility.ts:186 `hypothetical`: the PRESENCE of each field depends on ctx.chat
 * (only more restrictive chat modes; `agentMode` only from 'default'), and the
 * schema function returns `undefined` (tool unavailable) when neither applies.
 * Ported: the whole args object is a dynamic named type; undefined → applicable.
 */
const CHAT_MODES: ChatMode[] = ['none', 'read', 'create', 'update', 'delete'];
export function hypotheticalOptions(ctx: CletusCtx): { modes: ChatMode[]; plan: boolean } {
  const current = ctx.chat?.mode || 'none';
  return { modes: CHAT_MODES.slice(0, CHAT_MODES.indexOf(current)), plan: (ctx.chat?.agentMode || 'default') === 'default' };
}
export type HypotheticalT = { mode?: ChatMode; agentMode?: 'plan' };
export const HypotheticalArgs = a
  .declare<{ Args: HypotheticalT }>()
  .dynamic((ctx: CletusCtx) => {
    const { modes, plan } = hypotheticalOptions(ctx);
    const mode = a.enum(modes as [ChatMode, ...ChatMode[]]).optional().describe('Switch to a more restrictive operation mode');
    const agentMode = a.literal('plan').optional().describe('Switch to plan mode to see what would be done without executing');
    // The cast pins the declared type; see HypotheticalArgsUncast for the gap.
    const Args = (modes.length && plan ? a.object({ mode, agentMode })
      : modes.length ? a.object({ mode })
      : a.object({ agentMode })) as SchemaOf<HypotheticalT>;
    return { Args };
  }, { key: (ctx) => `${ctx.chat?.mode}|${ctx.chat?.agentMode}` })
  .result('Args');
expectTypeOf<a.infer<typeof HypotheticalArgs>>().toEqualTypeOf<HypotheticalT>();
/**
 * GAP (types): declare-pinned-union — without the cast, a dynamic step whose
 * schema is a union of differently-shaped objects makes the result type that
 * union (`{ mode?, agentMode? } | { mode? } | { agentMode? }`), not the declared
 * `HypotheticalT`. `declare<{ Args: T }>()` should pin the ref's code type.
 */
export const HypotheticalArgsUncast = a
  .declare<{ Args: HypotheticalT }>()
  .dynamic((ctx: CletusCtx) => {
    const { modes, plan } = hypotheticalOptions(ctx);
    const mode = a.enum(modes as [ChatMode, ...ChatMode[]]).optional();
    const agentMode = a.literal('plan').optional();
    return { Args: modes.length && plan ? a.object({ mode, agentMode }) : modes.length ? a.object({ mode }) : a.object({ agentMode }) };
  })
  .result('Args');
// @ts-expect-error GAP: declare-pinned-union — remove this directive once declare<> pins the result type.
expectTypeOf<a.infer<typeof HypotheticalArgsUncast>>().toEqualTypeOf<HypotheticalT>();
export const hypothetical = tool({
  name: 'hypothetical',
  description: 'Switch to a more restrictive mode to explore what would happen hypothetically without actually performing operations',
  schema: HypotheticalArgs,
  // Was: the schema function returning undefined.
  applicable: (ctx: CletusCtx) => { const o = hypotheticalOptions(ctx); return o.modes.length > 0 || o.plan; },
  call: (input) => input,
});
expectTypeOf(hypothetical.call).parameter(0).toEqualTypeOf<HypotheticalT>();

// utility.ts:342
export const AskArgs = a.object({
  questions: a.array(a.object({
    name: a.string().describe('Short name for the question'),
    min: a.number().describe('Minimum number of selections required'),
    max: a.number().describe('Maximum number of selections allowed'),
    custom: a.boolean().describe('Whether custom answers are allowed'),
    customLabel: a.string().optional().describe('Label for custom answer option (defaults to "Custom")'),
    options: a.array(a.object({
      label: a.string().describe('Option label'),
      description: a.string().describe('Option description'),
    })).describe('Available options for this question'),
  })).min(1).describe('Array of questions to ask the user'),
});
export type AskT = {
  questions: {
    name: string; min: number; max: number; custom: boolean; customLabel?: string;
    options: { label: string; description: string }[];
  }[];
};
expectTypeOf<a.infer<typeof AskArgs>>().toEqualTypeOf<AskT>();
