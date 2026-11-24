/**
 * Runtime proofs for every @aeye/cletus tool's args (cletus-tools.ts): each
 * renders on every profile family and round-trips realistic code values
 * (the instructions' own examples), decodes model-shaped answers, reports
 * wrong answers at the model's path, encodes values for instructions, and
 * budgets the whole cletus toolset in one request.
 */
import Handlebars from 'handlebars';
import { describe, expect, it } from 'vitest';
import {
  ANTHROPIC_NON_STRICT, ANTHROPIC_STRICT, GOOGLE_OPENAPI, GOOGLE_STRICT, LENIENT, MINIMAL, ModelProfile, OLLAMA, OPENAI_STRICT, PEOPLE, XAI_STRICT,
  schemaHelpers, SchemaDefinitionError, type RequestItem,
} from '../../index';
import { asTool, clone, MODEL_PROFILES, profileProblems, validate, unexplained } from './_check';
import * as T from './cletus-tools';
import type { CletusCtx, TypeDefinition } from './cletus-tools';

const types: TypeDefinition[] = [
  {
    name: 'project', friendlyName: 'Project', knowledgeTemplate: 'Project: {{name}}',
    fields: [
      { name: 'name', friendlyName: 'Name', type: 'string', required: true },
      { name: 'status', friendlyName: 'Status', type: 'enum', enumOptions: ['planning', 'active', 'completed'], required: true, default: 'planning' },
    ],
  },
  {
    name: 'task', friendlyName: 'Task', description: 'Task assigned to a project', knowledgeTemplate: 'Task: {{name}}',
    fields: [
      { name: 'name', friendlyName: 'Name', type: 'string', required: true },
      { name: 'projectid', friendlyName: 'Project', type: 'project', required: true, onDelete: 'cascade' },
      { name: 'points', friendlyName: 'Points', type: 'number' },
    ],
  },
];
const ctxOf = (ts: TypeDefinition[], chat?: CletusCtx['chat']): CletusCtx => {
  const data = { types: ts, user: {} };
  return { config: { getData: () => data }, ...(chat ? { chat } : {}) };
};
const ctx = ctxOf(types);

const tool = (p: Parameters<typeof asTool>[0]) => asTool(p);

// ============================================================================
// Every tool, every profile: the instructions' own examples as samples
// ============================================================================

/** [name, schema target, samples] — samples are the JSON examples in each tool's instructions (code shape). */
const STATIC: [string, Parameters<typeof profileProblems>[0], unknown[]][] = [
  ['type_list', T.TypeListArgs, [{}]],
  ['type_import', T.TypeImportArgs, [{ glob: 'data/**/*.csv' }, { glob: 'documents/**/*.txt', hints: ['user', 'transaction', 'product'] }, { glob: '**/*.json', max: 5 }]],
  ['image_generate', T.ImageGenerateArgs, [{ prompt: 'A serene mountain landscape at sunset with a lake in the foreground', n: 1 }, { prompt: 'x', n: 1 }]],
  ['image_edit', T.ImageEditArgs, [{ prompt: 'Add warm sunset colors and lighting', path: 'images/photo.jpg' }]],
  ['image_analyze', T.ImageAnalyzeArgs, [{ prompt: 'What are the main differences between these two UI designs?', paths: ['designs/v1.png', 'designs/v2.png'], maxCharacters: 2084 }, { prompt: 'x', paths: [], maxCharacters: 100 }]],
  ['image_describe', T.ImageDescribeArgs, [{ path: 'screenshots/dashboard.png' }]],
  ['image_find', T.ImageFindArgs, [{ query: 'photos containing people smiling', glob: 'photos/**/*.jpg', maxImages: 100, n: 5 }, { query: 'q', glob: 'g', maxImages: 10, n: 5 }]],
  ['image_attach', T.ImageAttachArgs, [{ path: 'images/diagram.png' }]],
  ['chart_display', T.ChartDisplayArgs, [
    { chart: { chartGroup: 'partToWhole', title: 'Market Share', data: [{ name: 'Apple', value: 28 }, { name: 'Samsung', value: 22 }], defaultVariant: 'pie' } },
    { chart: { chartGroup: 'partToWhole', data: [], variantOptions: { donut: { radius: ['40%', '70%'] } } } },
    { chart: { chartGroup: 'timeSeries', data: [{ name: '2024', value: 3 }], variantOptions: { line: { smooth: true } }, defaultVariant: 'area' } },
    { chart: { chartGroup: 'geospatial', data: [{ name: 'US', value: 9 }] } },
  ]],
  ['diagram_show', T.DiagramShowArgs, [{ spec: 'graph TD\n  A[Start] --> B[Process]\n  B --> C[End]' }]],
  ['file_search', T.FileSearchArgs, [{ glob: 'src/**/*.ts', limit: 10 }]],
  ['file_summary', T.FileSummaryArgs, [{ path: 'docs/report.pdf' }, { path: 'a', limit: 10, offset: -5, limitOffsetMode: 'lines', describeImages: true, extractImages: false, transcribeImages: true }]],
  ['file_index', T.FileIndexArgs, [{ glob: '**/*.md', index: 'content' }, { glob: 'images/**/*.jpg', index: 'summary', describeImages: true }]],
  ['file_create', T.FileCreateArgs, [{ path: 'config/settings.json', content: '{"theme": "dark", "fontSize": 14}' }]],
  ['file_copy', T.FileCopyArgs, [{ glob: 'config/*.json', target: 'backup/config/' }]],
  ['file_move', T.FileMoveArgs, [{ glob: 'old-name.ts', target: 'new-name.ts' }, { glob: 'temp/*.log', target: 'archive/' }]],
  ['file_stats', T.FileStatsArgs, [{ path: 'src/index.ts' }]],
  ['file_delete', T.FileDeleteArgs, [{ path: 'temp/cache.tmp' }]],
  ['file_read', T.FileReadArgs, [{ path: 'src/main.ts', limitOffsetMode: 'characters' }, { path: 'a', limitOffsetMode: 'characters', showLines: true }]],
  ['file_edit', T.FileEditArgs, [
    { path: 'config/settings.json', request: "Add a new field 'maxRetries' with value 3, and change 'timeout' from 5000 to 10000" },
    { path: 'src/utils.ts', request: 'Refactor the parseDate function to handle ISO 8601 format', offset: 100, limit: 50 },
  ]],
  ['text_search', T.TextSearchArgs, [{ glob: 'src/**/*.ts', regex: 'function \\w+\\(', caseInsensitive: true, output: 'matches', surrounding: 2 }]],
  ['dir_create', T.DirCreateArgs, [{ path: 'src/features/auth' }]],
  ['dir_summary', T.DirSummaryArgs, [{}, { path: 'src', kind: 'all', depth: 5 }, { path: 'lib', kind: 'files' }, { path: '.', kind: 'ext' }]],
  ['file_attach', T.FileAttachArgs, [{ path: 'documents/report.pdf' }]],
  ['shell', T.ShellArgs, [{ command: 'ls -la' }, { command: 'df -h' }]],
  ['web_search', T.WebSearchArgs, [{ query: 'recent developments in large language models', maxResults: 5 }]],
  ['web_get_page', T.WebGetPageArgs, [
    { url: 'https://example.com', type: 'text' },
    { url: 'https://example.com/docs', type: 'html', lineStart: 50, lineEnd: 100 },
    { url: 'https://example.com', type: 'text', regex: 'price.*\\$[0-9]+', surrounding: 2 },
  ]],
  ['web_api_call', T.WebApiCallArgs, [
    { url: 'https://api.example.com/data', method: 'GET' },
    { url: 'https://api.example.com/items', method: 'POST', requestType: 'json', body: '{"name": "Test"}' },
    { url: 'https://api.example.com/protected', method: 'GET', headers: { Authorization: 'Bearer ...' }, responseType: 'json' },
  ]],
  ['web_download', T.WebDownloadArgs, [{ url: 'https://example.com/image.jpg', target: '/tmp/downloaded_image.jpg' }]],
  ['knowledge_search', T.KnowledgeSearchArgs, [{ query: "user's preferred programming languages", limit: 5, sourcePrefix: 'user' }]],
  ['knowledge_sources', T.KnowledgeSourcesArgs, [{}]],
  ['knowledge_add', T.KnowledgeAddArgs, [{ text: 'The authentication service uses JWT tokens with a 24-hour expiration' }]],
  ['knowledge_delete', T.KnowledgeDeleteArgs, [{ sourcePattern: '^file@docs/old-guide\\.md:', caseSensitive: true }, { sourcePattern: 'task:123', caseSensitive: false }]],
  ['todos_clear', T.TodosClearArgs, [{}]],
  ['todos_list', T.TodosListArgs, [{}]],
  ['todos_add', T.TodosAddArgs, [{ name: 'Implement user authentication with OAuth' }]],
  ['todos_done', T.TodosDoneArgs, [{ id: 'abc-123-def' }]],
  ['todos_get', T.TodosGetArgs, [{ id: 'abc-123-def' }]],
  ['todos_remove', T.TodosRemoveArgs, [{ id: 'abc-123-def' }]],
  ['todos_replace', T.TodosReplaceArgs, [{ todos: [{ name: 'Set up project structure', done: false }, { name: 'Implement core features', done: false }, { name: 'Write tests' }] }]],
  ['assistant_switch', T.AssistantSwitchArgs, [{ name: 'coder' }]],
  ['assistant_update', T.AssistantUpdateArgs, [{ name: 'helper', prompt: 'You are a helpful assistant.' }]],
  ['assistant_add', T.AssistantAddArgs, [{ name: 'writer', prompt: 'You are a creative writing coach.' }]],
  ['memory_list', T.MemoryListArgs, [{}]],
  ['memory_update', T.MemoryUpdateArgs, [{ content: 'User prefers TypeScript over JavaScript for all new projects' }]],
  ['getOperationOutput', T.GetOperationOutputArgs, [{ id: 3, operation: 0 }]],
  ['about', T.AboutArgs, [{}]],
  ['retool', T.RetoolArgs, [{ toolset: null }, { toolset: 'clerk' }, { toolset: 'dba' }]],
  ['ask', T.AskArgs, [{
    questions: [
      { name: 'Framework', min: 1, max: 1, custom: false, options: [{ label: 'React', description: 'Component-based UI library' }, { label: 'Vue', description: 'Progressive framework' }] },
      { name: 'Features', min: 1, max: 3, custom: true, customLabel: 'Other feature', options: [{ label: 'Authentication', description: 'User login system' }] },
    ],
  }]],
];

const DYNAMIC: [string, { bind(c: CletusCtx): Parameters<typeof profileProblems>[0] }, unknown[]][] = [
  ['type_info', T.TypeInfoArgs, [{ name: 'task' }]],
  ['type_update', T.TypeUpdateArgs, [
    { name: 'task', update: { fields: [{ field: 'priority', change: { friendlyName: 'Priority', type: 'number', required: false } }] } },
    { name: 'task', update: { fields: [{ field: 'assigneeid', change: { friendlyName: 'Assignee', type: 'project', required: false } }] } },
    { name: 'task', update: { description: 'A task tracking item with assignee and deadline', fields: [] } },
    { name: 'task', update: { fields: [{ field: 'deadline', change: { required: false } }] } },
    { name: 'task', update: { fields: [{ field: 'priority', change: null }] } },
  ]],
  ['type_create', T.TypeCreateArgs, [{
    name: 'project', friendlyName: 'Project', description: 'Software project tracking',
    knowledgeTemplate: 'Project: {{name}}\nStatus: {{status}}',
    fields: [
      { name: 'name', friendlyName: 'Name', type: 'string', required: true },
      { name: 'status', friendlyName: 'Status', type: 'enum', enumOptions: ['planning', 'active', 'completed'], required: true, default: 'planning' },
      { name: 'description', friendlyName: 'Description', type: 'string', required: false },
    ],
  }]],
  ['type_delete', T.TypeDeleteArgs, [{ name: 'task' }]],
  ['data_index', T.DataIndexArgs, [{ type: 'task' }]],
  ['data_import', T.DataImportArgs, [{ type: 'task', glob: 'data/*.csv' }, { type: 'project', glob: 'documents/**/*.pdf', transcribeImages: true }]],
  ['data_search', T.DataSearchArgs, [{ type: 'task', query: 'user preferences for notifications', n: 5 }]],
  ['data_get', T.DataGetArgs, [{ type: 'task' }, { type: 'task', offset: 20, limit: 10 }]],
  ['hypothetical', T.HypotheticalArgs, [{}, { agentMode: 'plan' }]],
];

/** Tools that hit a MINIMAL-dialect gap (tested on their own below). */
const MINIMAL_GAPS = new Set(['retool']);
const withoutMinimal = [...MODEL_PROFILES, PEOPLE].filter((p) => p !== MINIMAL);

describe('every cletus tool renders on every profile and round-trips its instruction examples', () => {
  for (const [name, target, samples] of STATIC) {
    const profiles = MINIMAL_GAPS.has(name) ? { profiles: withoutMinimal } : {};
    it(name, () => expect(profileProblems(target, samples, profiles)).toEqual([]));
  }
  for (const [name, target, samples] of DYNAMIC) {
    const profiles = MINIMAL_GAPS.has(name) ? { profiles: withoutMinimal } : {};
    it(`${name} (ctx-dependent)`, () => expect(profileProblems(target.bind(ctxOf(types, { mode: 'delete' })), samples, profiles)).toEqual([]));
  }

  // retool (utility.ts:114): an 8-value enum made nullable is emitted as a 9-value enum (null added),
  // over MINIMAL's cap of 8; it should be widened (or spelled with the null outside the enum).
  it.fails('GAP: nullable-enum-cap — a nullable 8-value enum on MINIMAL goes over the enum cap', () => {
    expect(profileProblems(T.RetoolArgs, [{ toolset: null }, { toolset: 'clerk' }], { profiles: [MINIMAL] })).toEqual([]);
  });
  // type_update (architect.ts:85): `change: z.union([z.null(), z.object(...)])`. With no combinators the
  // union is a tagged wrapper; a null member can't be written as a filled option, so null doesn't round-trip.
  it('(was GAP) tagged-union-null-member — a union with a null member does not round-trip on MINIMAL', () => {
    expect(profileProblems(T.TypeUpdateArgs.bind(ctx), [{ name: 'task', update: { fields: [{ field: 'priority', change: null }] } }], { profiles: [MINIMAL] })).toEqual([]);
  });
});

// ============================================================================
// JSON sent: OpenAI strict / Anthropic strict / Gemini
// ============================================================================

describe('emitted JSON', () => {
  it('web_api_call: headers are pairs on OpenAI/Anthropic strict, an open object on Gemini and xAI; absent optionals are null on OpenAI only', () => {
    const o = T.WebApiCallArgs.render(tool(OPENAI_STRICT)).jsonSchema as any;
    expect(o.required).toEqual(['url', 'method', 'headers', 'body', 'requestType', 'responseType']);
    expect(o.properties.headers.anyOf[0]).toEqual({
      type: 'array',
      items: { type: 'object', properties: { key: { type: 'string' }, value: { type: 'string' } }, required: ['key', 'value'], additionalProperties: false },
    });
    expect(o.properties.headers.anyOf[1]).toEqual({ type: 'null' });
    const c = T.WebApiCallArgs.render(tool(ANTHROPIC_STRICT)).jsonSchema as any;
    expect(c.required).toEqual(['url', 'method']);
    expect(c.properties.headers.type).toBe('array');
    expect(c.properties.headers.description).toBe('Request headers as key-value pairs\nA map written as a list of {key, value} entries; each key at most once.');
    expect((T.WebApiCallArgs.render(tool(GOOGLE_STRICT)).jsonSchema as any).properties.headers).toEqual({
      type: 'object', additionalProperties: { type: 'string' }, description: 'Request headers as key-value pairs',
    });
    expect((T.WebApiCallArgs.render(tool(XAI_STRICT)).jsonSchema as any).properties.headers.additionalProperties).toEqual({ type: 'string' });
  });

  it('type_update: the ctx type names and the field-type enum become $defs; change is null | object', () => {
    const o = T.TypeUpdateArgs.bind(ctx).render(tool(OPENAI_STRICT)).jsonSchema as any;
    expect(o.$defs.TypeName).toEqual({ type: 'string', enum: ['project', 'task'] });
    expect(o.$defs.FieldType.enum).toEqual(['string', 'number', 'boolean', 'date', 'enum', 'project', 'task']);
    const change = o.properties.update.properties.fields.items.properties.change;
    expect(change.anyOf[0]).toEqual({ type: 'null' });
    expect(change.anyOf[1].required).toEqual(['friendlyName', 'type', 'required', 'default', 'enumOptions', 'onDelete']);
    expect(change.anyOf[1].properties.friendlyName.description).toBe('Field display name, only specify if changing\nWrite null to leave it out.');
    const c = T.TypeUpdateArgs.bind(ctx).render(tool(ANTHROPIC_STRICT)).jsonSchema as any;
    expect(c.properties.update.required).toEqual(['fields']);
    expect(c.properties.update.properties.fields.items.properties.change.anyOf[1].required).toEqual([]);
  });

  it('chart_display: z.any() record values are JSON text on strict dialects; enum-keyed records are pairs with an enum key', () => {
    const c = T.ChartDisplayArgs.render(tool(ANTHROPIC_STRICT)).jsonSchema as any;
    const [part, cat] = c.properties.chart.anyOf;
    expect(part.properties.variantOptions.properties.pie.items.properties.value).toEqual({ type: 'string', description: 'Write the value as JSON text.' });
    expect(cat.properties.variantOptions.items.properties.key).toEqual({ type: 'string', enum: ['bar', 'horizontalBar', 'pictorialBar'] });
    // Ollama: the code shape.
    const l = T.ChartDisplayArgs.render(tool(OLLAMA)).jsonSchema as any;
    expect(l.properties.chart.anyOf[1].properties.variantOptions.type).toBe('object');
  });

  it('ask: minItems 1 is kept on Anthropic strict (min 0/1 allowed)', () => {
    expect((T.AskArgs.render(tool(ANTHROPIC_STRICT)).jsonSchema as any).properties.questions.minItems).toBe(1);
  });
});

// ============================================================================
// Decoding real model answers
// ============================================================================

describe('decoding model-shaped answers', () => {
  it('web_api_call on OpenAI strict: pairs → record, nulls → absent, in place', () => {
    const r = T.WebApiCallArgs.render(tool(OPENAI_STRICT));
    const wire = { url: 'https://api.example.com/protected', method: 'GET', headers: [{ key: 'Authorization', value: 'Bearer x' }], body: null, requestType: null, responseType: 'json' };
    const res = r.parse(wire);
    expect(res.ok && res.value).toEqual({ url: 'https://api.example.com/protected', method: 'GET', headers: { Authorization: 'Bearer x' }, responseType: 'json' });
    expect(res.ok && res.value).toBe(wire);
    expect(res.stats).toEqual({ objects: 1, arrays: 0, edits: 3, parsed: 0, repaired: 0 });
  });

  it('web_api_call on xAI strict: an open object, nothing copied; a record sent as JSON text is repaired', () => {
    const r = T.WebApiCallArgs.render(tool(XAI_STRICT));
    const wire = { url: 'u', method: 'POST', headers: { A: 'b' }, body: '{"name": "Test"}', requestType: 'json' };
    const res = r.parse(wire);
    expect(res.ok && res.value).toBe(wire);
    expect(res.stats).toEqual({ objects: 0, arrays: 0, edits: 0, parsed: 0, repaired: 0 });
    const rep = r.parse({ url: 'u', method: 'GET', headers: '{"A":"b"}' });
    expect(rep.ok && rep.value).toEqual({ url: 'u', method: 'GET', headers: { A: 'b' } });
    expect(rep.stats).toEqual({ objects: 0, arrays: 0, edits: 1, parsed: 0, repaired: 1 });
    // Pairs sent as JSON text on OpenAI strict: repaired, then turned into the record.
    const o = T.WebApiCallArgs.render(tool(OPENAI_STRICT)).parse({ url: 'u', method: 'GET', headers: '[{"key":"A","value":"b"}]', body: null, requestType: null, responseType: null });
    expect(o.ok && o.value).toEqual({ url: 'u', method: 'GET', headers: { A: 'b' } });
    expect(o.stats).toEqual({ objects: 1, arrays: 0, edits: 4, parsed: 0, repaired: 1 });
  });

  it('type_update on OpenAI strict: change null stays null (delete the field), change nulls → absent', () => {
    const r = T.TypeUpdateArgs.bind(ctx).render(tool(OPENAI_STRICT));
    const res = r.parse({
      name: 'task',
      update: {
        friendlyName: null, description: null, knowledgeTemplate: 'Task: {{name}}',
        fields: [
          { field: 'priority', change: null },
          { field: 'assigneeid', change: { friendlyName: 'Assignee', type: 'project', required: null, default: 3, enumOptions: null, onDelete: null } },
        ],
      },
    });
    expect(res.ok && res.value).toEqual({
      name: 'task',
      update: { knowledgeTemplate: 'Task: {{name}}', fields: [{ field: 'priority', change: null }, { field: 'assigneeid', change: { friendlyName: 'Assignee', type: 'project', default: 3 } }] },
    });
    expect(res.stats).toEqual({ objects: 0, arrays: 0, edits: 5, parsed: 0, repaired: 0 });
  });

  it('chart_display on Anthropic strict: any-values are JSON text, enum-keyed records are pairs', () => {
    const r = T.ChartDisplayArgs.render(tool(ANTHROPIC_STRICT));
    const a1 = r.parse({ chart: { chartGroup: 'partToWhole', data: [{ name: 'Apple', value: 28 }], variantOptions: { donut: [{ key: 'radius', value: '["40%","70%"]' }] } } });
    expect(a1.ok && a1.value).toEqual({ chart: { chartGroup: 'partToWhole', data: [{ name: 'Apple', value: 28 }], variantOptions: { donut: { radius: ['40%', '70%'] } } } });
    expect(a1.stats).toEqual({ objects: 1, arrays: 0, edits: 1, parsed: 1, repaired: 0 });
    const a2 = r.parse({ chart: { chartGroup: 'timeSeries', data: [], variantOptions: [{ key: 'line', value: [{ key: 'smooth', value: 'true' }] }] } });
    expect(a2.ok && a2.value).toEqual({ chart: { chartGroup: 'timeSeries', data: [], variantOptions: { line: { smooth: true } } } });
    expect(a2.stats).toEqual({ objects: 2, arrays: 0, edits: 1, parsed: 1, repaired: 0 });
  });

  it('hypothetical: the args offered follow ctx.chat; binds are cached per (mode, agentMode)', () => {
    const fromRead = T.HypotheticalArgs.bind(ctxOf(types, { mode: 'read' })).render(tool(OPENAI_STRICT));
    expect((fromRead.jsonSchema as any).properties.mode.anyOf[0]).toEqual({ type: 'string', enum: ['none'] });
    expect(fromRead.parse({ mode: 'none', agentMode: null }).ok).toBe(true);
    expect(fromRead.parse({ mode: 'read', agentMode: null }).ok).toBe(false);
    // In plan mode already, from 'none': nothing more restrictive → the tool is not applicable.
    expect(T.hypothetical.applicable!(ctxOf(types, { mode: 'none', agentMode: 'plan' }))).toBe(false);
    expect(T.hypothetical.applicable!(ctxOf(types, { mode: 'none' }))).toBe(true);
    const onlyPlan = T.HypotheticalArgs.bind(ctxOf(types, { mode: 'none' })).render(tool(ANTHROPIC_STRICT)).jsonSchema as any;
    expect(Object.keys(onlyPlan.properties)).toEqual(['agentMode']);
    expect(T.HypotheticalArgs.bind(ctxOf([], { mode: 'update' }))).toBe(T.HypotheticalArgs.bind(ctxOf(types, { mode: 'update' })));
  });

  it('ctx-dependent enums: a new types array rebinds, the same one is cached; applicable guards the empty case', () => {
    const b1 = T.DataGetArgs.bind(ctx);
    expect(T.DataGetArgs.bind(ctx)).toBe(b1);
    const more = ctxOf([...types, { name: 'user', friendlyName: 'User', knowledgeTemplate: '', fields: [] }]);
    const js = T.DataGetArgs.bind(more).render(tool(OPENAI_STRICT)).jsonSchema as any;
    expect(js.$defs.TypeName.enum).toEqual(['project', 'task', 'user']);
    expect(T.dataGet.applicable!(ctxOf([]))).toBe(false);
    expect(T.typeInfo.applicable!(ctx)).toBe(true);
  });
});

// ============================================================================
// Wrong answers: issues at the model's path and the code's path
// ============================================================================

describe('validation errors', () => {
  it('a header value of the wrong type: path is the pair, codePath the header name', () => {
    const res = T.WebApiCallArgs.render(tool(OPENAI_STRICT)).parse({ url: 'u', method: 'GET', headers: [{ key: 'Authorization', value: 5 }], body: null, requestType: null, responseType: null });
    expect(!res.ok && res.issues).toEqual([{ path: ['headers', 0, 'value'], codePath: ['headers', 'Authorization'], message: 'Expected a string, got number.' }]);
    expect(!res.ok && res.message).toBe('- at headers[0].value: Expected a string, got number.');
  });

  it('a type name not in ctx and a change of the wrong shape', () => {
    const res = T.TypeUpdateArgs.bind(ctx).render(tool(OPENAI_STRICT)).parse({
      name: 'nope',
      update: { friendlyName: null, description: null, knowledgeTemplate: null, fields: [{ field: 'b', change: { friendlyName: null, type: 'user', required: null, default: null, enumOptions: null, onDelete: null } }] },
    });
    expect(!res.ok && res.issues.map((i) => [i.path, i.codePath])).toEqual([
      [['name'], ['name']],
      // Inside the non-null option of the `change` union.
      [['update', 'fields', 0, 'change', 'type'], ['update', 'fields', 0, 'change', 'type']],
    ]);
    expect(!res.ok && res.message.split('\n')[0]).toBe('- at name: Expected one of: project, task.');
  });

  it('ask: questions must have at least one item; method must be a listed verb', () => {
    const res = T.AskArgs.render(tool(OPENAI_STRICT)).parse({ questions: [] });
    expect(!res.ok && res.message).toBe('- at questions: Must have at least 1 items.');
    const m = T.WebApiCallArgs.render(tool(ANTHROPIC_STRICT)).parse({ url: 'u', method: 'GETT' });
    expect(!m.ok && m.message).toBe('- at method: Expected one of: GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS.');
  });

  it('chart_display: both the plain z.union (literal chartGroup on every option) and the tagged form report inside the chosen group', () => {
    const answer = () => ({ input: { chartGroup: 'timeSeries', data: [{ name: 'x' }], title: null, variantOptions: null, defaultVariant: null } });
    const plain = T.ChartConfig.render(tool(OPENAI_STRICT)).parse(answer());
    expect(!plain.ok && plain.issues).toEqual([{ path: ['input', 'data', 0, 'value'], codePath: ['data', 0, 'value'], message: 'Required.' }]);
    expect(!plain.ok && plain.message).toBe('- at input.data[0].value: Required.');
    const tagged = T.ChartConfigTagged.render(tool(OPENAI_STRICT)).parse(answer());
    expect(!tagged.ok && tagged.issues).toEqual([{ path: ['input', 'data', 0, 'value'], codePath: ['data', 0, 'value'], message: 'Required.' }]);
  });
});

// ============================================================================
// Encoding values for instructions (the tools' own `Example:` lines)
// ============================================================================

describe('encoding the instruction examples', () => {
  const compile = (t: string) => Handlebars.compile(t, { noEscape: true });
  const example3 = { url: 'https://api.example.com/protected', method: 'GET', headers: { Authorization: 'Bearer ...' }, responseType: 'json' } as const;

  it('web_api_call Example 3 in each model\'s shape (the hand-written JSON is only right for open-record dialects)', () => {
    const t = compile('Example 3: {{encode ex}}');
    const one = (p: Parameters<typeof tool>[0]) => t({ ex: example3 }, { helpers: schemaHelpers(T.WebApiCallArgs.render(tool(p))) });
    expect(one(OPENAI_STRICT)).toBe('Example 3: {"url":"https://api.example.com/protected","method":"GET","headers":[{"key":"Authorization","value":"Bearer ..."}],"body":null,"requestType":null,"responseType":"json"}');
    expect(one(ANTHROPIC_STRICT)).toBe('Example 3: {"url":"https://api.example.com/protected","method":"GET","headers":[{"key":"Authorization","value":"Bearer ..."}],"responseType":"json"}');
    expect(one(XAI_STRICT)).toBe('Example 3: {"url":"https://api.example.com/protected","method":"GET","headers":{"Authorization":"Bearer ..."},"responseType":"json"}');
  });

  it('encodeAt / encoder / request helpers', () => {
    const r = T.WebApiCallArgs.render(tool(OPENAI_STRICT));
    expect(r.encodeAt({ A: 'b' }, 'headers')).toEqual([{ key: 'A', value: 'b' }]);
    expect(r.encodeText(example3)).toContain('"headers":[{"key":"Authorization"');
    const tu = T.TypeUpdateArgs.bind(ctx).render(tool(OPENAI_STRICT));
    expect(tu.encoder({ name: 'task', update: { fields: [{ field: 'deadline', change: { required: false } }] } })).toBe(
      '{"name":"task","update":{"friendlyName":null,"description":null,"knowledgeTemplate":null,"fields":[{"field":"deadline","change":{"friendlyName":null,"type":null,"required":false,"default":null,"enumOptions":null,"onDelete":null}}]}}',
    );
    const req = ModelProfile.of(ANTHROPIC_STRICT).request([{ kind: 'tool', name: 'chart_display', schema: T.ChartDisplayArgs, strict: false }, { kind: 'tool', name: 'web_api_call', schema: T.WebApiCallArgs }]);
    // chart_display is strict:false in cletus → Anthropic non-strict → the code shape.
    const out = compile('{{encode c}} / {{encode w tool="web_api_call"}}')(
      { c: { chart: { chartGroup: 'flow', data: [], variantOptions: { sankey: { a: 1 } } } }, w: example3 },
      { helpers: req.helpers('chart_display') },
    );
    expect(out).toBe('{"chart":{"chartGroup":"flow","data":[],"variantOptions":{"sankey":{"a":1}}}} / {"url":"https://api.example.com/protected","method":"GET","headers":[{"key":"Authorization","value":"Bearer ..."}],"responseType":"json"}');
  });

  it('a real example on the schema renders in each model\'s shape (description text on strict profiles)', () => {
    const X = T.WebApiCallArgs.example(example3);
    expect((X.render(tool(OPENAI_STRICT)).jsonSchema as any).description).toBe('Example: {"url":"https://api.example.com/protected","method":"GET","headers":[{"key":"Authorization","value":"Bearer ..."}],"body":null,"requestType":null,"responseType":"json"}');
    expect((X.render(tool(ANTHROPIC_STRICT)).jsonSchema as any).description).toBe('Example: {"url":"https://api.example.com/protected","method":"GET","headers":[{"key":"Authorization","value":"Bearer ..."}],"responseType":"json"}');
    expect((X.render(tool(GOOGLE_STRICT)).jsonSchema as any).description).toBe('Example: {"url":"https://api.example.com/protected","method":"GET","headers":{"Authorization":"Bearer ..."},"responseType":"json"}');
  });

  it('file_summary\'s instruction example uses "characterLimit", which is not a parameter: a .strict() example catches it', () => {
    // clerk.ts:36 `{ "path": "docs/report.pdf", "characterLimit": 32000 }` — the schema has `limit`.
    // Examples are checked when the JSON is emitted.
    const Bad = T.FileSummaryArgs.strict().example({ path: 'docs/report.pdf', characterLimit: 32000 } as never);
    expect(() => Bad.render(tool(OPENAI_STRICT)).jsonSchema).toThrow(SchemaDefinitionError);
    // The default (open) object accepts and keeps it (zod would strip it silently).
    const res = T.FileSummaryArgs.render(LENIENT).parse({ path: 'docs/report.pdf', characterLimit: 32000 });
    expect(res.ok && res.value).toEqual({ path: 'docs/report.pdf', characterLimit: 32000 });
  });
});

// ============================================================================
// The whole cletus toolset in one request
// ============================================================================

describe('request budget: every cletus tool at once', () => {
  const all = (c: CletusCtx): RequestItem[] => Object.entries(T)
    .filter(([k, v]) => k.endsWith('Args') && !k.endsWith('Uncast') && typeof (v as { bind?: unknown }).bind === 'function')
    .map(([k, v]) => ({ kind: 'tool', name: k, schema: (v as { bind(c: CletusCtx): RequestItem['schema'] }).bind(c), ...(k === 'ChartDisplayArgs' ? { strict: false } : {}) }));

  it('Anthropic strict: 20 strict tools, optionals traded for nulls, the rest non-strict; parse goes through the entry', () => {
    const items = all(ctx);
    expect(items.length).toBe(58);
    const req = ModelProfile.of(ANTHROPIC_STRICT).request(items);
    expect(req.strictTools).toBe(20);
    expect(unexplained(req)).toEqual([]);
    expect(req.used.optional).toBeLessThanOrEqual(24);
    expect(req.used.unions).toBeLessThanOrEqual(16);
    expect(req.get('ChartDisplayArgs').adjustments).toEqual([{ kind: 'not-strict', reason: 'strict: false' }]);
    const fs = req.get('FileSummaryArgs');
    expect([fs.strict, fs.adjustments]).toEqual([true, [{ kind: 'optional-as-null' }]]);
    expect(fs.reasons[0]).toMatch(/optional properties \(limit 24\)/);
    // Its answer uses null for absent; another tool's doesn't.
    const r = fs.parse({ path: 'a', limit: null, offset: null, limitOffsetMode: 'lines', describeImages: null, extractImages: null, transcribeImages: null });
    expect(r.ok && r.value).toEqual({ path: 'a', limitOffsetMode: 'lines' });
    const ask = req.get('AskArgs');
    expect(ask.strict).toBe(false);
    expect(ask.adjustments[0]!.kind).toBe('not-strict');
    const q = { questions: [{ name: 'n', min: 1, max: 1, custom: false, options: [] }] };
    expect(ask.encode(q)).toBe(q);
  });

  it('OpenAI: all 57 strict-eligible tools fit (128-tool limit)', () => {
    const req = ModelProfile.of(OPENAI_STRICT).request(all(ctx));
    expect(req.strictTools).toBe(57);
    expect(unexplained(req)).toEqual([]);
    expect(req.entries.filter((e) => e.adjustments.length).map((e) => e.name)).toEqual(['ChartDisplayArgs']);
  });
});

// ============================================================================
// Gaps
// ============================================================================

describe('gaps', () => {
  // artist.ts:21 `n: z.number().optional().default(1)`; also artist.ts:58/94/95, clerk.ts:226,
  // internet.ts:21, librarian.ts:102. zod fills the default on parse and types the output non-optional.
  it('was GAP: default — an omitted defaulted arg decodes to its default (now `.default`)', () => {
    const res = T.ImageGenerateArgs.render(tool(ANTHROPIC_STRICT)).parse({ prompt: 'x' });
    expect(res.ok && res.value).toEqual({ prompt: 'x', n: 1 });
  });

  // hypothetical: the result is a root ref; its body is inlined at the root and ALSO kept in $defs, unused.
  it.fails('GAP: unused-root-def — a non-recursive root ref is emitted twice (inline and an unused $defs entry)', () => {
    const js = T.HypotheticalArgs.bind(ctxOf(types, { mode: 'read' })).render(tool(OPENAI_STRICT)).jsonSchema;
    expect(js.$defs).toBeUndefined();
  });

  it('sanity: the independent validator accepts an encoded value', () => {
    const r = T.TodosReplaceArgs.render(tool(OPENAI_STRICT));
    expect(validate(r.jsonSchema, r.encode(clone({ todos: [{ name: 'a' }] })))).toEqual([]);
  });
});
