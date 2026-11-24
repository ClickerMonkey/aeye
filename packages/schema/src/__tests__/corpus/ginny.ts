/**
 * CORPUS: every ginny tool and prompt schema (packages/ginny/src/tools/*,
 * src/prompts/*), ported with `a` onto the proposed Tool/Prompt API
 * (src/proposal/core-api.ts): `schema` is ALWAYS a static instance; where
 * ginny's `schema: (ctx) => ...` reads ctx, the port is a chain whose
 * dynamic step reads the same ctx fields, cached by `key`.
 *
 * What each ctx-driven schema reads:
 * - edit_type, create_var, create_new_fn, edit_fn, architect output: `buildSchemas(ctx.registry)` → the gin
 *   grammar's dynamic part (gin-grammar.ts `grammarDefs`);
 * - write: `buildSchemas(ctx.registry, { newStrict: true })`;
 * - test: `ctx.targetFn?.argsType` (the fn being authored) or an open record;
 * - designer output: `validate(output, ctx)` (designer.ts:586) → a ctx-built refinement on each name.
 *
 * ginny's ctx carries a gin `Registry` (no version; gin keys its lazies by
 * counts); here the ctx carries a `GinRegistryLike` with a version, which is
 * what `key` needs. Applicability (`applicable(ctx)`) stays on the tool.
 *
 * zod `.default(x)` (search_fns, print_fn, web_search, architect/dba/designer/
 * researcher outputs) is `.default(x)`: optional on the wire, filled in on decode.
 */
import { expectTypeOf } from 'expect-type';
import { a, fromGin, ginNamedTypes, type AnySchema, type GinRegistryLike, type GinTypeDef, type SchemaOf } from '../../index';
import { prompt, tool, type Context } from '../../proposal/core-api';
import { GinGrammarStatic, grammarDefs, grammarKey, type ExprDefT, type TypeDefT } from './gin-grammar';

// ============================================================================
// ginny's ctx (context.ts:5), structurally — the fields the schemas and applicability read
// ============================================================================

export interface GinnyCtx {
  readonly registry: GinRegistryLike;
  readonly runState: { readonly draft: ExprDefT | null; readonly lastTest: { readonly success: boolean } | null };
  readonly features: { readonly webSearch: boolean };
  readonly ask?: (question: string, signal?: AbortSignal) => Promise<string>;
  readonly programmerDepth?: number;
  /** context.ts:77 — `argsType: ObjType` there; here its TypeDef (`sourceArgs`). */
  readonly targetFn?: { readonly name: string; readonly sourceArgs: GinTypeDef; readonly sourceReturns?: GinTypeDef };
  /** The on-disk catalog (store.ts), as far as the schemas need it. */
  readonly store: { hasFn(name: string): boolean };
}
export type Ctx = Context<GinnyCtx>;

/** context.ts:106 */
export const MAX_PROGRAMMER_DEPTH = 3;

/** The registry part every grammar-typed ginny schema binds (buildSchemas(ctx.registry)). */
const grammarFromCtx = (ctx: Ctx) => grammarDefs(ctx.registry);
const grammarCtxKey = (ctx: Ctx) => grammarKey(ctx.registry);

// ============================================================================
// tools/
// ============================================================================

// tools/ask.ts:20
export const AskArgs = a.object({ question: a.string().describe('The question to put to the user.') });
export const ask = tool({
  name: 'ask',
  description: 'Ask the user a clarifying question and wait for their answer.',
  instructions: 'Use sparingly — only when you genuinely need information from the user (missing requirement, ambiguous intent, decision between options). Phrase the question concisely. Returns the user\'s typed answer.',
  schema: AskArgs,
  applicable: (ctx: Ctx) => typeof ctx.ask === 'function',
  call: async (input, ctx) => (ctx.ask ? ctx.ask(input.question, ctx.signal) : 'No interactive user available — proceed with your best assumption and note it.'),
});
expectTypeOf<a.infer<typeof AskArgs>>().toEqualTypeOf<{ question: string }>();

// tools/edit-type.ts:32 — schema: (ctx) => { name, def: buildSchemas(ctx.registry).Type }
export const EditTypeArgs = GinGrammarStatic
  .dynamic(grammarFromCtx, { key: grammarCtxKey })
  .result(a.object({
    name: a.string().describe('Name of the saved type to edit (matches the file at `./types/<name>.json`).'),
    def: a.ref('TypeDef').describe('The new TypeDef. Its `name` must match the type being edited; the structural change must be backwards-compatible.'),
  }));
export const editType = tool({
  name: 'edit_type',
  description: 'Replace a saved type with a new definition; rejects breaking changes.',
  instructions: 'Update an existing named type. The new definition is checked against the old: every value of the OLD shape must still satisfy the NEW shape. Use this to widen field types, add optional fields, or loosen constraints. Removing fields, adding REQUIRED fields, or narrowing types is rejected — those would break existing values / callers.',
  schema: EditTypeArgs,
  call: (input, _ctx: Ctx) => `Type '${input.name}' updated.`,
});
expectTypeOf<a.infer<typeof EditTypeArgs>>().toEqualTypeOf<{ name: string; def: TypeDefT }>();
expectTypeOf(editType.call).parameter(0).toEqualTypeOf<{ name: string; def: TypeDefT }>();
expectTypeOf(EditTypeArgs.bind).parameters.toEqualTypeOf<[ctx: Ctx]>();

// tools/find-or-create-fns.ts:16, find-or-create-types.ts:16, find-or-create-vars.ts:16
export const FindFnsArgs = a.object({ description: a.string().describe('What functions are needed and why') });
export const FindTypesArgs = a.object({ description: a.string().describe('What types are needed and why') });
export const FindVarsArgs = a.object({ description: a.string().describe('What vars are needed and why') });
export const findOrCreateFunctions = tool({
  name: 'find_or_create_functions',
  description: 'Locate or author reusable functions. Returns their signatures.',
  instructions: 'Delegates to the designer. Provide a description of what is needed.',
  schema: FindFnsArgs,
  // find-or-create-fns.ts:28
  applicable: (ctx: Ctx) => !ctx.targetFn && (ctx.programmerDepth ?? 0) < MAX_PROGRAMMER_DEPTH - 1,
  call: (input) => `designer: ${input.description}`,
});
export const findOrCreateTypes = tool({
  name: 'find_or_create_types',
  description: 'Locate or author the types needed for the program. Returns their code definitions.',
  instructions: 'Delegates to the architect. Provide a description of the types needed.',
  schema: FindTypesArgs,
  call: (input, _ctx: Ctx) => `architect: ${input.description}`,
});
export const findOrCreateVars = tool({
  name: 'find_or_create_vars',
  description: 'Locate or create named typed vars. Returns their type signatures.',
  instructions: 'Delegates to the dba. Provide a description of the vars needed.',
  schema: FindVarsArgs,
  call: (input, _ctx: Ctx) => `dba: ${input.description}`,
});

// tools/finish.ts:57
export const FinishArgs = a.object({
  saveAs: a.string().optional().describe('Save the finalized draft as `fns/<saveAs>.json`. Use a stable, descriptive camelCase name.'),
  docs: a.string().optional().describe('Short description of what the saved function does. Stored on the TypeDef so search_fns surfaces it.'),
});
export const finish = tool({
  name: 'finish',
  description: 'Finalize the draft after a successful test, optionally saving it as a reusable function.',
  instructions: 'Call only after test() succeeds. Pass `saveAs` to persist the draft as a callable function (`fns/<saveAs>.json`) so the user — and future requests — can invoke it by name. Omit `saveAs` for one-shot answers that don\'t need to be reused.',
  schema: FinishArgs,
  applicable: (ctx: Ctx) => !!ctx.runState.lastTest?.success,
  call: (input) => (input.saveAs ? `saved ${input.saveAs}` : 'done'),
});
expectTypeOf<a.infer<typeof FinishArgs>>().toEqualTypeOf<{ saveAs?: string; docs?: string }>();

// tools/print-fn.ts:33 — includeComments: z.boolean().optional().default(true)
export const PrintFnArgs = a.object({
  name: a.string().describe('Function name (matches the file at `./fns/<name>.json`).'),
  includeComments: a.boolean().default(true).describe('Include inline `/* docs */` and `// line` comments. Default true.'),
});
export const printFn = tool({
  name: 'print_fn',
  description: 'Render a saved function as a TypeScript-like fn declaration.',
  instructions: 'Look up a saved fn by name and return its signature + body in `fn name<G>(args): R { types; body }` form. Use `includeComments: false` to drop docs/comment annotations and just show the structure. Errors when the fn does not exist on disk.',
  schema: PrintFnArgs,
  call: (input, _ctx: Ctx) => `fn ${input.name}${input.includeComments ? ' /* with comments */' : ''}`,
});
// The zod OUTPUT type has the default applied (`includeComments: boolean`); `a` has no `.default`.
expectTypeOf<a.infer<typeof PrintFnArgs>>().toEqualTypeOf<{ name: string; includeComments: boolean }>();

// tools/research.ts:22
export const ResearchArgs = a.object({ question: a.string().describe('The factual question to research') });
export const research = tool({
  name: 'research',
  description: 'Ask a factual question; the researcher searches the web and reads pages to answer.',
  instructions: 'Pose a natural-language question. Returns an answer plus the URLs consulted.',
  schema: ResearchArgs,
  applicable: (ctx: Ctx) => !!ctx.features?.webSearch,
  call: (input) => input.question,
});

// tools/search-fns.ts:25 and tools/search-vars.ts:20 — keywords default [], limit optional default 20
export const SearchCatalogArgs = a.object({
  keywords: a.array(a.string()).default([]),
  limit: a.number().default(20),
});
export const searchFns = tool({
  name: 'search_fns',
  description: 'List or keyword-search saved functions in the catalog (./fns/*.json).',
  instructions: 'Pass an empty `keywords` array to enumerate every saved fn (up to `limit`). Pass keywords to score-rank when the catalog grows beyond ~20 entries. Each result is a top-level global — invoke it as `<name>({args})` (a path with the fn name as the first prop step), NOT `fns.<name>({args})`. The `fns.*` namespace is reserved for built-in natives (fetch, llm, log, ask).',
  schema: SearchCatalogArgs,
  call: (input, _ctx: Ctx) => input.keywords.join(','),
});
export const searchVars = tool({
  name: 'search_vars',
  description: 'List or keyword-search saved vars in the catalog (./vars/*.json).',
  instructions: 'Pass an empty `keywords` array to enumerate every saved var (up to `limit`). Pass keywords to score-rank when the catalog grows large. Returns one line per var — `name: <docs or fallback>`. Read a var\'s value via `vars.<name>` in a program.',
  schema: SearchCatalogArgs,
  call: (input, _ctx: Ctx) => input.keywords.join(','),
});
expectTypeOf<a.infer<typeof SearchCatalogArgs>>().toEqualTypeOf<{ keywords: string[]; limit: number }>();

// tools/test.ts:54 — args: the authored fn's args obj (toValueSchema({ includeDocs: 'all' })) or an open record.
const TEST_ARGS_FN = "Scope values — keys ARE the function's parameter names. The function body reads each via [{prop:'args'}, {prop:'<name>'}]. Pass concrete sample values matching the args type.";
const TEST_ARGS_TOP = 'Scope variables for the top-level draft. Keys become variable names the program reads by name.';
export const TestArgs = GinGrammarStatic
  .declare<{ TestScope: Record<string, unknown> }>()
  .dynamic(
    (ctx: Ctx) => ({
      ...grammarDefs(ctx.registry),
      ...ginNamedTypes(ctx.registry),
      TestScope: ctx.targetFn
        // GAP fromGin-widened-type: fromGin of a runtime (non-literal) TypeDef is typed RefType<string>, not a schema of unknown shape.
        ? (fromGin(ctx.targetFn.sourceArgs) as unknown as SchemaOf<Record<string, unknown>>).describe(TEST_ARGS_FN)
        : a.record(a.unknown()).describe(TEST_ARGS_TOP),
    }),
    { key: (ctx) => `${grammarKey(ctx.registry)}|${ctx.targetFn ? `${ctx.targetFn.name}:${JSON.stringify(ctx.targetFn.sourceArgs)}` : '-'}` },
  )
  .result(a.object({
    args: a.ref('TestScope').optional(),
    expectError: a.boolean().optional().describe('If true, a runtime error counts as success'),
  }));
export const test = tool({
  name: 'test',
  description: 'Execute the stored draft program and return the result.',
  instructions: 'Run the draft. `args` are the values bound under the `args` scope variable — its schema reflects the function being authored when one is in scope, so just pass concrete values for each parameter. Set `expectError: true` if a runtime error is the expected outcome.',
  schema: TestArgs,
  applicable: (ctx: Ctx) => !!ctx.runState.draft,
  call: (input) => (input.expectError ? 'expect error' : JSON.stringify(input.args ?? {})),
});
// test.ts:57 — the cast ginny writes: z.ZodType<{ args?: Record<string, unknown>; expectError?: boolean }>
expectTypeOf<a.infer<typeof TestArgs>>().toEqualTypeOf<{ args?: Record<string, unknown>; expectError?: boolean }>();

// tools/web-get-page.ts:27, web-search.ts:10
export const WebGetPageArgs = a.object({ url: a.string().describe('URL to fetch') });
export const WebSearchArgs = a.object({
  query: a.string().describe('Search query'),
  maxResults: a.number().default(5).describe('Max results (default 5)'),
});
export const webGetPage = tool({
  name: 'web_get_page',
  description: 'Fetch a URL and return its content as plain text.',
  schema: WebGetPageArgs,
  applicable: (ctx: Ctx) => !!ctx.features?.webSearch,
  call: (input) => input.url,
});
export const webSearch = tool({
  name: 'web_search',
  description: 'Search the web using Tavily. Returns titles, URLs, and content snippets.',
  instructions: 'Search the web. Returns JSON array of results with title, url, content.',
  schema: WebSearchArgs,
  call: (input, _ctx: Ctx) => `${input.query}:${input.maxResults}`,
});

// tools/write.ts:35 — { program: buildSchemas(ctx.registry, { newStrict: true }).Expr }
export const WriteToolArgs = GinGrammarStatic
  .dynamic((ctx: Ctx) => grammarDefs(ctx.registry, { newStrict: true }), { key: (ctx) => grammarKey(ctx.registry, { newStrict: true }) })
  .result(a.object({ program: a.ref('Expr') }));
export const write = tool({
  name: 'write',
  description: 'Write a gin program expression and store it as the draft.',
  instructions: 'Store the program draft. Provide the gin ExprDef JSON as "program". Returns the program rendered as TypeScript-like source via toCode() so you can sanity-check what gin actually parsed, plus any validation problems found by static analysis. ERRORS block the next step — fix them before calling test(). WARNINGS are advisory — review and address what you can; a fn whose saved warnings exceed the threshold will be rejected at finish().',
  schema: WriteToolArgs,
  call: (input, _ctx: Ctx) => input.program.kind,
});
expectTypeOf<a.infer<typeof WriteToolArgs>>().toEqualTypeOf<{ program: ExprDefT }>();

// ============================================================================
// prompts/architect.ts
// ============================================================================

// architect.ts:12 search_types / :27 get_type
export const SearchTypesArgs = a.object({
  keywords: a.array(a.string()).describe('Keywords to search for'),
  limit: a.number().default(10),
});
export const NameArgs = a.object({ name: a.string() });
export const searchTypes = tool({
  name: 'search_types',
  description: 'Search existing types by keywords.',
  instructions: 'Search the type catalog. Returns name and summary for each match.',
  schema: SearchTypesArgs,
  call: (input, _ctx: Ctx) => input.keywords.join(','),
});
export const getType = tool({ name: 'get_type', description: 'Get the full definition of a type by name.', instructions: 'Retrieve full type code definition by name.', schema: NameArgs, call: (input, _ctx: Ctx) => input.name });

// architect.ts:62 — schema: (_input, ctx) => { use: string[] = [], create: buildSchemas(ctx.registry).Type[] = [] }
export const ArchitectOut = GinGrammarStatic
  .dynamic((ctx: Ctx, _input: { description: string }) => grammarDefs(ctx.registry), { key: (ctx) => grammarKey(ctx.registry) })
  .result(a.object({
    use: a.array(a.string()).default([]).describe('Names of existing types to use'),
    create: a.array(a.ref('TypeDef')).default([]).describe('New type definitions'),
  }));
export const architect = prompt({
  name: 'architect',
  content: 'You are the architect for a gin program — responsible for picking or designing the gin types a request needs.\n...\nRequest: {{description}}',
  schema: ArchitectOut,
});
expectTypeOf<a.infer<typeof ArchitectOut>>().toEqualTypeOf<{ use: string[]; create: TypeDefT[] }>();
expectTypeOf(ArchitectOut.bind).parameters.toEqualTypeOf<[ctx: Ctx, _input: { description: string }]>();
expectTypeOf(architect).toMatchTypeOf<{ schema?: { readonly _out: { use: string[]; create: TypeDefT[] } } }>();

// ============================================================================
// prompts/dba.ts
// ============================================================================

// dba.ts:13 search_vars (keywords REQUIRED here), :28 get_var
export const DbaSearchVarsArgs = a.object({ keywords: a.array(a.string()), limit: a.number().default(10) });
export const dbaSearchVars = tool({ name: 'search_vars', description: 'Search existing vars by keywords.', instructions: 'Search the vars catalog.', schema: DbaSearchVarsArgs, call: (input, _ctx: Ctx) => input.keywords.join(',') });
export const getVar = tool({ name: 'get_var', description: 'Get the full definition of a var by name.', instructions: 'Retrieve full var definition (type, value, docs).', schema: NameArgs, call: (input, _ctx: Ctx) => input.name });

/**
 * dba.ts:43 create_var — `{ name, type: opts.Type, value: z.unknown(), docs? }`; the call then does
 * `registry.parse(type).parse(value)` (dba.ts:66). Here `value` is typed by the `type` the model
 * wrote next to it: decoding checks it against that type's value schema, in the same answer.
 */
const valueSchemas = new Map<string, AnySchema>();
export function valueSchemaOf(type: unknown): AnySchema | undefined {
  if (typeof type !== 'object' || type === null) return undefined;
  const k = JSON.stringify(type);
  let s = valueSchemas.get(k);
  if (!s) valueSchemas.set(k, (s = fromGin(type as GinTypeDef) as AnySchema));
  return s;
}
export const CreateVarArgs = GinGrammarStatic
  .dynamic((ctx: Ctx) => ({ ...grammarDefs(ctx.registry), ...ginNamedTypes(ctx.registry) }), { key: grammarCtxKey })
  .result(
    a.object({
      name: a.string().describe('Var name (camelCase)'),
      type: a.ref('TypeDef'),
      value: a.unknown(),
      docs: a.string().optional(),
    }).dependent('value', 'type', valueSchemaOf),
  );
export const createVar = tool({
  name: 'create_var',
  description: 'Create a new persistent var.',
  instructions: 'Create a typed named var. Provide name, type (TypeDef JSON), value, optional docs.',
  schema: CreateVarArgs,
  call: (input, _ctx: Ctx) => `Created var '${input.name}'.`,
});
// dba.ts:54 — the call's input type.
expectTypeOf<a.infer<typeof CreateVarArgs>>().toEqualTypeOf<{ name: string; type: TypeDefT; value: unknown; docs?: string }>();

// dba.ts:93
export const DbaOut = a.object({
  use: a.array(a.string()).default([]).describe('Names of existing vars to use'),
  created: a.array(a.string()).default([]).describe('Names of newly created vars'),
});
export const dba = prompt({ name: 'dba', content: 'You are the dba — keeper of the catalog of named typed values ...\nRequest: {{description}}', schema: DbaOut });
expectTypeOf<a.infer<typeof DbaOut>>().toEqualTypeOf<{ use: string[]; created: string[] }>();

// ============================================================================
// prompts/designer.ts
// ============================================================================

export const getFn = tool({ name: 'get_fn', description: 'Get the full signature of a function by name.', instructions: 'Retrieve function signature by name.', schema: NameArgs, call: (input, _ctx: Ctx) => input.name });

// designer.ts:48 create_new_fn
export const CreateNewFnArgs = GinGrammarStatic
  .dynamic(grammarFromCtx, { key: grammarCtxKey })
  .result(a.object({
    name: a.string().describe('Unique function name (camelCase)'),
    description: a.string().describe('What the function should do'),
    types: a.record(a.ref('TypeDef')).optional().describe(
      'Optional `call.types` aliases — declare reusable named types here ONCE and reference them inside `args` / `returns` as a bare `{name: "<alias>"}`. '
      + 'Use whenever the same composite type would appear more than once in the signature. '
      + 'Example: `{ "positiveInt": { "name": "num", "options": { "whole": true, "min": 1 } } }` lets you write `args: { name: "obj", props: { n: { type: { name: "positiveInt" } } } }` and `returns: { name: "list", generic: { V: { name: "positiveInt" } } }` — instead of repeating the full options block twice. '
      + 'Sequential: later aliases may reference earlier. Pick alias names that don\'t collide with built-in type-class names (`num`, `list`, `obj`, etc.) — bare `{name: "num"}` always resolves to the built-in num.',
    ),
    args: a.ref('TypeDef').describe(
      'TypeDef of the function\'s parameter object. The PROPS of this obj ARE the function\'s parameters — '
      + 'each prop becomes a scope variable in the body when the function is called. '
      + 'Examples: function taking one number → `{ name: "obj", props: { n: { type: { name: "num" } } } }`; '
      + 'function taking text and a list → `{ name: "obj", props: { name: { type: { name: "text" } }, items: { type: { name: "list", generic: { V: { name: "any" } } } } } }`. '
      + 'Only use `{ name: "obj" }` (empty obj, no props) for genuinely nullary functions — most useful functions have parameters, so default to listing them as props. '
      + 'May reference any alias declared in `types` via `{name: "<alias>"}` (saves repetition).',
    ),
    returns: a.ref('TypeDef').describe(
      'TypeDef of the function\'s return value — e.g. `{ name: "list", generic: { V: { name: "num" } } }` for `list<num>`. '
      + 'May reference any alias declared in `types` via `{name: "<alias>"}`.',
    ),
  }));
interface FnSignatureT { name: string; description: string; types?: Record<string, TypeDefT>; args: TypeDefT; returns: TypeDefT }
export const createNewFn = tool({
  name: 'create_new_fn',
  description: 'Spin up a programmer to implement a new function and persist it.',
  schema: CreateNewFnArgs,
  applicable: (ctx: Ctx) => (ctx.programmerDepth ?? 0) < MAX_PROGRAMMER_DEPTH - 1,
  call: (input) => input.name,
});
expectTypeOf<a.infer<typeof CreateNewFnArgs>>().toEqualTypeOf<FnSignatureT>();

// designer.ts:316 edit_fn
export const EditFnArgs = GinGrammarStatic
  .dynamic(grammarFromCtx, { key: grammarCtxKey })
  .result(a.object({
    name: a.string().describe('Saved function name (matches the file at `./fns/<name>.json`).'),
    description: a.string().describe('Updated description for the body programmer'),
    types: a.record(a.ref('TypeDef')).optional().describe('Optional `call.types` aliases — same semantics as `create_new_fn`.'),
    args: a.ref('TypeDef').describe('New args TypeDef. Must accept every value the old args accepted.'),
    returns: a.ref('TypeDef').describe('New return TypeDef. Must be assignable back into the old return type.'),
  }));
export const editFn = tool({
  name: 'edit_fn',
  description: 'Edit a saved function: new signature (compat-checked) + fresh body authored by an inner programmer.',
  schema: EditFnArgs,
  applicable: (ctx: Ctx) => (ctx.programmerDepth ?? 0) < MAX_PROGRAMMER_DEPTH - 1,
  call: (input) => input.name,
});
expectTypeOf<a.infer<typeof EditFnArgs>>().toEqualTypeOf<FnSignatureT>();

/**
 * designer.ts:575 output + :586 `validate(output, ctx)`: every name in use/created must be readable via
 * `store.readFn`. The check moves into the schema: a ctx-built refinement on each name (no key — the
 * store changes during the run), so the re-prompt names the exact entry.
 */
export const DesignerOut = a
  .declare<{ SavedFn: string }>()
  .dynamic((ctx: Ctx, _input: { description: string }) => ({
    SavedFn: a.string().refine((n) => ctx.store.hasFn(n), 'Must name a function that is on disk: create it with create_new_fn first; do NOT report a function as created when create_new_fn raised an error.'),
  }))
  .result(a.object({
    use: a.array(a.ref('SavedFn')).default([]).describe('Names of existing functions confirmed via get_fn / search_fns.'),
    created: a.array(a.ref('SavedFn')).default([]).describe('Names of functions create_new_fn successfully wrote to disk this session. Do NOT include names where create_new_fn errored.'),
  }));
export const designer = prompt({ name: 'designer', content: 'You are the designer ...\nRequest: {{description}}', schema: DesignerOut });
expectTypeOf<a.infer<typeof DesignerOut>>().toEqualTypeOf<{ use: string[]; created: string[] }>();
expectTypeOf(DesignerOut.bind).parameters.toEqualTypeOf<[ctx: Ctx, _input: { description: string }]>();

// ============================================================================
// prompts/researcher.ts:41
// ============================================================================

export const ResearcherOut = a.object({
  answer: a.string().describe('The researched answer, concise and factual.'),
  sources: a.array(a.string()).default([]).describe('URLs actually consulted.'),
});
export const researcher = prompt({ name: 'researcher', content: 'You are a research assistant ...\nQuestion: {{question}}', schema: ResearcherOut });
expectTypeOf<a.infer<typeof ResearcherOut>>().toEqualTypeOf<{ answer: string; sources: string[] }>();

// ============================================================================
// Binding rules the proposed API enforces
// ============================================================================

// A tool whose ctx lacks the registry cannot take a grammar-typed schema.
tool({
  name: 'bad_edit_type',
  description: '',
  // @ts-expect-error — EditTypeArgs's dynamic step needs `registry` (and the rest of GinnyCtx) from ctx.
  schema: EditTypeArgs as typeof EditTypeArgs,
  call: (_input, _ctx: Context<{ other: true }>) => '',
});

/** The programmer's tool set (programmer.ts:1057), in order. */
export const PROGRAMMER_TOOLS = [
  findOrCreateTypes, findOrCreateFunctions, findOrCreateVars, write, test, finish, research, ask, searchFns, searchVars, printFn, editType,
] as const;
/** Each sub-prompt's tools (architect.ts:54, dba.ts:90, designer.ts:572, researcher.ts:38). */
export const ARCHITECT_TOOLS = [searchTypes, getType, ask] as const;
export const DBA_TOOLS = [dbaSearchVars, getVar, createVar, ask] as const;
export const DESIGNER_TOOLS = [searchFns, getFn, printFn, createNewFn, editFn, ask] as const;
export const RESEARCHER_TOOLS = [webSearch, webGetPage, ask] as const;
