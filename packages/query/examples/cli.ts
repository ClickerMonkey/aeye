/**
 * Interactive CLI for `@aeye/query` — a tiny REPL in the spirit of `ginny`.
 *
 * It loads whatever JSON data lives in a data directory (every `*.json` file
 * that holds an ARRAY of objects becomes a Type via `inferType`), wires an
 * in-memory `QueryEngine` over that data, then lets you type a
 * natural-language request at a `query> ` prompt. For each request it:
 *
 *   1. (optionally) narrows the schema to the relevant Types via `selectTypes`,
 *   2. asks an LLM for a STRUCTURED query against `querySchema(engine)`,
 *      with the prompt fully informed by `describeEngine(engine)` (every Type,
 *      every usable expr kind, every function) threaded through the prompt's
 *      context,
 *   3. parses the model output with `parseQueryTool(engine, { query })` — which
 *      validates + parses it into a runnable `Query`, returning a
 *      `QueryToolError` (its `.report` is LLM-friendly `Problems`) on failure;
 *      on that failure it does ONE repair round feeding the formatted errors
 *      back,
 *   4. runs the built query via `engine.run(...)` in-memory and prints the rows
 *      + resolved output fields.
 *
 * This file is DEV-ONLY (it lives under `examples/` and is never published).
 * The non-LLM pieces (`loadDataDir`, `buildQuery`, `runBuiltQuery`) are
 * exported so an offline test can exercise the data→type→query→run pipeline
 * without touching any provider.
 *
 *   npm run cli                 # uses examples/data
 *   npm run cli ./path/to/data  # uses a custom data directory
 *
 * Provider selection mirrors ginny (env-based, lean):
 *   OPENAI_API_KEY      → OpenAI
 *   OPENROUTER_API_KEY  → OpenRouter
 *   AWS credentials     → AWS Bedrock (probed via checkHealth)
 *   QUERY_MODEL         → pin a specific model id (optional)
 */
import * as readline from 'node:readline';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, basename, extname } from 'node:path';
import { z } from 'zod';

import { AI, type Provider } from '@aeye/ai';
import { OpenAIProvider } from '@aeye/openai';
import { OpenRouterProvider } from '@aeye/openrouter';
import { AWSBedrockProvider } from '@aeye/aws';
import { models, strictSupport } from '@aeye/models';

import {
  createRegistry,
  QueryEngine,
  arrayExecutor,
  inferType,
  parseQueryTool,
  QueryToolError,
  querySchema,
  describeTypes,
  describeFunctions,
  describeEngine,
  depthInstructions,
  selectTypes,
  DEFAULT_MAX_QUERY_SCHEMA_TYPES,
  type Type,
  type TypeDef,
  type QueryDef,
  type Query,
  type QueryResult,
  type SourceRecord,
  type SchemaDepth,
  type FunctionSelector,
  type BuildQueryToolOptions,
} from '../src/index';

// ════════════════════════════════════════════════════════════════════════
// Schema-depth configuration for the REPL
// ════════════════════════════════════════════════════════════════════════

/**
 * The REPL's DEFAULT schema depth: a sensible tight-but-forgiving preset.
 * `refs: 'paired'` pins each field-ref to a Type + one of ITS fields,
 * `typeNames: 'enum'` enum-locks FROM / INTO positions, `functions: 'typed'`
 * shapes each function's named args, and `filters: 'paired'` locks `(field,
 * op)` pairs. Combined with `CLI_MAX_ENUM_SIZE`, an oversized catalog degrades
 * gracefully rather than emitting an unusably large schema. Switch at runtime
 * with `:depth` (e.g. `:depth open`, `:depth functions=names refs=types`).
 */
const CLI_DEFAULT_DEPTH: SchemaDepth = {
  refs: 'paired',
  typeNames: 'enum',
  functions: 'typed',
  filters: 'paired',
};

/** Auto-degrade any enumerated axis whose catalog exceeds this many entries. */
const CLI_MAX_ENUM_SIZE = 50;

/** The REPL exposes every registered function to the model. */
const CLI_FUNCTIONS: FunctionSelector = 'all';

// ════════════════════════════════════════════════════════════════════════
// Data loading + type inference (no LLM — exported for the offline test)
// ════════════════════════════════════════════════════════════════════════

/**
 * Turn a data filename into a Type name.
 *
 * Rule: take the basename without extension, SINGULARIZE it (a light,
 * English-ish rule — `categories`→`category`, `boxes`→`box`, `users`→`user`),
 * then CAPITALIZE the first letter. So `users.json`→`User`,
 * `orders.json`→`Order`, `products.json`→`Product`. Type names are otherwise
 * opaque to the engine (field references use query-local aliases), so the
 * exact casing only affects how Types read in the prompt.
 */
export function typeNameFromFile(file: string): string {
  const stem = basename(file, extname(file));
  const singular = singularize(stem);
  return singular.charAt(0).toUpperCase() + singular.slice(1);
}

/** A small, dependency-free English singularizer (best-effort). */
function singularize(word: string): string {
  if (/ies$/i.test(word)) return word.replace(/ies$/i, 'y'); // categories → category
  if (/(ses|xes|zes|ches|shes)$/i.test(word)) return word.replace(/es$/i, ''); // boxes → box
  if (/ss$/i.test(word)) return word; // address → address (not addres)
  if (/s$/i.test(word)) return word.replace(/s$/i, ''); // users → user
  return word;
}

/** What `loadDataDir` produces. */
export interface LoadedData {
  /** The engine with every inferred Type registered + array executors wired. */
  engine: QueryEngine;
  /** The inferred Types, in load order. */
  types: Type[];
  /** Non-fatal warnings (e.g. files skipped because they weren't arrays). */
  warnings: string[];
}

/**
 * Load every `*.json` file in `dir`, infer a Type from each (files must hold a
 * JSON array of objects), and return a fresh `QueryEngine` serving that data
 * in memory. Files that aren't a JSON array are skipped with a warning.
 */
export function loadDataDir(dir: string): LoadedData {
  const registry = createRegistry();
  const executors: Record<string, ReturnType<typeof arrayExecutor>> = {};
  const types: Type[] = [];
  const warnings: string[] = [];

  const files = readdirSync(dir).filter((f) => extname(f).toLowerCase() === '.json').sort();
  if (files.length === 0) warnings.push(`No *.json files found in ${dir}.`);

  for (const file of files) {
    const name = typeNameFromFile(file);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    } catch (err) {
      warnings.push(`Skipped ${file}: invalid JSON (${err instanceof Error ? err.message : String(err)}).`);
      continue;
    }
    if (!Array.isArray(parsed)) {
      warnings.push(`Skipped ${file}: top-level JSON is not an array.`);
      continue;
    }
    if (parsed.length === 0) {
      warnings.push(`Skipped ${file}: empty array (no rows to infer a Type from).`);
      continue;
    }
    const rows = parsed as SourceRecord[];
    const def: TypeDef = inferType(name, rows, { label: name });
    const type = registry.parseType(def);
    registry.registerType(type);
    types.push(type);
    executors[name] = arrayExecutor(rows);
  }

  registry.finalize();
  const engine = new QueryEngine(registry, { executors });
  return { engine, types, warnings };
}

// ════════════════════════════════════════════════════════════════════════
// Query build + run (no LLM — exported for the offline test)
// ════════════════════════════════════════════════════════════════════════

/** The outcome of building a query def through the parser (no throw on failure). */
export interface BuiltQuery {
  /** The parsed, runnable query — `null` when the def was invalid. */
  query: Query | null;
  /** LLM-friendly diagnostics report (empty string when valid). */
  report: string;
  /** True when the def failed to validate. */
  hasErrors: boolean;
}

/**
 * Run a query DEF (as an LLM would emit) through the STANDALONE
 * `parseQueryTool` — validating + parsing it into a runnable `Query` WITHOUT
 * building a Tool. A directly-supplied def is already conceptual, so it needs
 * no wire decode. On failure it returns a `QueryToolError` (its `.report` is
 * the formatted diagnostics); we surface that as `{ query: null, report }` so
 * the REPL / test can inspect it without a throw. `types` optionally narrows
 * the parse options. */
export function buildQuery(
  engine: QueryEngine,
  queryDef: QueryDef,
  types?: Type[],
): BuiltQuery {
  const result = parseQueryTool(engine, { query: queryDef }, types ? { types } : {});
  if (result instanceof QueryToolError) {
    return { query: null, report: result.report, hasErrors: result.problems.hasErrors };
  }
  return { query: result, report: '', hasErrors: false };
}

/**
 * Build + (if valid) RUN a query def, returning its result. Throws the
 * `QueryToolError` (its `.message` is the formatted report) when the def
 * doesn't validate — the test asserts on the happy path, the REPL catches +
 * prints the report.
 */
export async function runBuiltQuery(
  engine: QueryEngine,
  queryDef: QueryDef,
  types?: Type[],
): Promise<QueryResult> {
  const result = parseQueryTool(engine, { query: queryDef }, types ? { types } : {});
  if (result instanceof QueryToolError) throw result;
  return engine.run(result);
}

// ════════════════════════════════════════════════════════════════════════
// Provider bootstrap (lean, env-based — mirrors ginny's buildProviders)
// ════════════════════════════════════════════════════════════════════════

interface ProviderBundle {
  providers: Record<string, Provider>;
  enabled: string[];
  skipped: string[];
}

/**
 * Build the set of providers from the environment.
 */
async function buildProviders(): Promise<ProviderBundle> {
  const enabled: string[] = [];
  const skipped: string[] = [];
  const providers: Record<string, Provider> = {};

  if (process.env['OPENAI_API_KEY']) {
    providers.openai = new OpenAIProvider({ apiKey: process.env['OPENAI_API_KEY'] });
    enabled.push('openai');
  } else {
    skipped.push('openai (OPENAI_API_KEY unset)');
  }

  if (process.env['OPENROUTER_API_KEY']) {
    providers.openrouter = new OpenRouterProvider({ apiKey: process.env['OPENROUTER_API_KEY'] });
    enabled.push('openrouter');
  } else {
    skipped.push('openrouter (OPENROUTER_API_KEY unset)');
  }

  // AWS Bedrock: credentials may come from env vars, `aws sso login`, an IAM
  // role, the shared credentials file, etc. — so we probe via `checkHealth`
  // rather than checking a single env var.
  try {
    const aws = new AWSBedrockProvider({ region: process.env['AWS_REGION'] ?? 'us-east-1' });
    if (await aws.checkHealth()) {
      providers.aws = aws;
      enabled.push('aws');
    } else {
      skipped.push('aws (credential chain yielded no access — try `aws sso login`)');
    }
  } catch (err) {
    skipped.push(`aws (health check threw: ${err instanceof Error ? err.message : String(err)})`);
  }

  return { providers, enabled, skipped };
}

/** Model used when `QUERY_MODEL` is not set. The auto-selector can otherwise
 *  pick a top-scored model the active provider can't actually serve (e.g. a
 *  dead OpenRouter endpoint), so we pin a known-good default. Override per
 *  session with `QUERY_MODEL` (e.g. `gpt-4o` on a pure-OpenAI key). */
const DEFAULT_MODEL = 'openai/gpt-4o';

/** The model id the REPL pins: `QUERY_MODEL` if set, else `DEFAULT_MODEL`. */
function effectiveModelId(): string {
  return process.env['QUERY_MODEL']?.trim() || DEFAULT_MODEL;
}

/** Per-call metadata pinning the model id. */
function modelMetadata(): { model: { id: string } } {
  return { model: { id: effectiveModelId() } };
}

/** The minimal AI surface the REPL needs: ask the model for a structured query.
 *  `engine` + `types` flow into the prompt's CONTEXT so its instructions render
 *  `describeEngine(engine, { types })` — a fully-informed model (every Type,
 *  usable expr kind, and function). */
interface QueryAsker {
  ask(
    content: string,
    schema: z.ZodTypeAny,
    engine: QueryEngine,
    types: readonly Type[],
    options: BuildQueryToolOptions,
  ): Promise<{ query: Query | null; report: string }>;
}

/** Build the AI instance + a `QueryAsker` over it. */
async function createAsker(
  providers: Record<string, Provider>,
  enabled: string[],
): Promise<QueryAsker> {
  const metadata = modelMetadata();
  // Constrain model selection to the providers we actually registered, so the
  // scorer can't pick a top-ranked model we can't dispatch to (see ginny).
  // The single narrow `as any` ginny tolerates: the AI metadata typing can't
  // see our pinned model id / allow-list without it.
  const defaultMetadata = {
    model: { id: metadata.model.id },
    providers: { allow: enabled },
  } as any;
  const ai = AI.with()
    .providers(providers)
    .create({
      defaultMetadata,
      models,
      modelOverrides: [...strictSupport],
    });

  // One hoisted prompt — per-call data (the content + output schema + the ENGINE
  // it targets) flows through `input`, exactly like ginny's `gin_llm_call`. The
  // engine + narrowed Types ride the context so the prompt's `{{instructions}}`
  // are rendered from `describeEngine` — the model is told every Type, every
  // usable expr kind (with its INSTRUCTIONS), and every function (args +
  // instructions) — followed by the per-request user text in `{{userPrompt}}`.
  type PromptInput = {
    prompt: string;
    schema?: z.ZodTypeAny;
    engine?: QueryEngine;
    types?: readonly Type[];
  };
  const promptInstructions = (i: PromptInput): string =>
    i.engine
      ? describeEngine(i.engine, { types: i.types, functions: CLI_FUNCTIONS, maxExamples: 2 })
      : '';
  const errRef: { last: QueryToolError | null } = { last: null };
  const parseRef: { engine: QueryEngine | null; options: BuildQueryToolOptions | null } = {
    engine: null,
    options: null,
  };
  const takeLastError = (): QueryToolError | null => errRef.last;
  const prompt = ai.prompt({
    name: 'query_build',
    description: 'Build a structured query from a natural-language request',
    content: '{{instructions}}\n\n{{userPrompt}}',
    input: (i: PromptInput) => ({ instructions: promptInstructions(i), userPrompt: i.prompt }),
    schema: (i: PromptInput | undefined) => i?.schema ?? false,
    outputRetries: 5,
    strict: false,
    schemaDelivery: 'auto',
    parse: (raw: unknown): Query | QueryToolError => {
      const engine = parseRef.engine;
      const options = parseRef.options;
      if (!engine || !options) throw new Error('query parser context is unset');
      const result = parseQueryTool(engine, raw, options);
      if (result instanceof QueryToolError) errRef.last = result;
      return result;
    },
    metadata,
  });

  return {
    ask: async (content, schema, engine, types, options) => {
      errRef.last = null;
      parseRef.engine = engine;
      parseRef.options = options;
      try {
        const query = await prompt.get('result', { prompt: content, schema, engine, types });
        return { query, report: '' };
      } catch (err) {
        return {
          query: null,
          report:
            takeLastError()?.report ??
            `The model did not return a valid structured query: ${err instanceof Error ? err.message : String(err)}`,
        };
      } finally {
        parseRef.engine = null;
        parseRef.options = null;
      }
    },
  };
}

// ════════════════════════════════════════════════════════════════════════
// The LLM build loop
// ════════════════════════════════════════════════════════════════════════

/** Pretty-print a query result: a compact table of rows + the output fields. */
function printResult(result: QueryResult): void {
  const fields = result.fields.map((f) => f.name);
  console.log(`\n${result.rows.length} row(s):`);
  if (result.rows.length > 0) {
    console.table(result.rows.map((r) => pick(r, fields)));
  }
  // When the SELECT requested `includeTotal`, surface the pre-limit total so a
  // paginated view reads "showing <page> of <total>".
  if (result.total !== undefined) {
    console.log(`(showing ${result.rows.length} of ${result.total})`);
  }
  console.log(
    `fields: ${result.fields.map((f) => `${f.name}:${f.type.kind}`).join(', ')}`,
  );
}

/** Project a row down to (and in the order of) the resolved output fields. */
function pick(row: SourceRecord, fields: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) out[f] = row[f];
  return out;
}

/**
 * Build the per-request USER text: the schema-shape reminder + active
 * constraints and the user request. The engine's full capability summary
 * (`describeEngine` + example JSON) is supplied SEPARATELY by the prompt's
 * `{{instructions}}` (see `createAsker`), so it is not repeated here.
 */
function buildContent(schemaNote: string, request: string): string {
  return [
    schemaNote,
    '',
    'Return ONLY the structured query as the `query` field of the schema.',
    '',
    `User request: ${request}`,
  ].join('\n');
}

/**
 * One full request: narrow Types → ask the model (parser-backed retries) →
 * run. Prints the result or the problems. Never throws — keeps the REPL alive.
 */
async function handleRequest(
  engine: QueryEngine,
  asker: QueryAsker,
  request: string,
  showSql: boolean,
  depth: SchemaDepth | 'open' | 'paired',
): Promise<void> {
  const allTypes = engine.registry.typeList();
  // Narrow to the relevant Types when there are more than the structured-schema
  // threshold; otherwise hand the model every Type.
  const selected =
    allTypes.length > DEFAULT_MAX_QUERY_SCHEMA_TYPES
      ? await selectTypes(engine, request, { topN: DEFAULT_MAX_QUERY_SCHEMA_TYPES })
      : allTypes;

  // Build the tool at the active depth: enumerated Type names / paired field
  // refs / typed function args, with the function library in scope and an
  // enum-size budget that degrades oversized axes.
  const options = {
    types: selected,
    depth,
    functions: CLI_FUNCTIONS,
    maxEnumSize: CLI_MAX_ENUM_SIZE,
  };
  // The model-facing schema — the model emits against it and core `decodeWire`s
  // the response with it. Parsing is done DIRECTLY via `parseQueryTool` (below);
  // no Tool is built here.
  const schema = querySchema(engine, options);
  // The engine's full capability summary rides the prompt CONTEXT (see
  // `createAsker`); the per-request text carries only the schema-shape reminder
  // + the active depth constraints and the user request.
  const note = depthInstructions(engine, options);
  const schemaNote = note
    ? `Emit the query as a structured JSON object matching the schema.\nSchema constraints:\n${note}`
    : 'Emit the query as a structured JSON object matching the schema.';

  // The prompt validates with `parseQueryTool` and re-prompts through its own
  // `outputRetries` with the parser's report — no manual repair loop.
  const built = await asker.ask(
    buildContent(schemaNote, request),
    schema,
    engine,
    selected,
    options,
  );

  if (!built.query) {
    console.log('\nStill could not build a valid query:');
    console.log(built.report);
    return;
  }

  // ── Run + print ────────────────────────────────────────────────────────────
  if (showSql) printSql(engine, built.query.toJSON());
  const result = await engine.run(built.query);
  printResult(result);
}

/** Print the base + postgres SQL for a query def (best-effort). */
function printSql(engine: QueryEngine, queryDef: QueryDef): void {
  for (const dialect of ['base', 'postgres']) {
    try {
      const { sql, params } = engine.toSQL(queryDef, dialect);
      console.log(`\n[${dialect}] ${sql}`);
      if (params.length > 0) console.log(`  params: ${JSON.stringify(params)}`);
    } catch (err) {
      console.log(`\n[${dialect}] (could not emit: ${err instanceof Error ? err.message : String(err)})`);
    }
  }
}

// ════════════════════════════════════════════════════════════════════════
// REPL
// ════════════════════════════════════════════════════════════════════════

const HELP = [
  'Commands:',
  '  :types              list the loaded Types and their fields',
  '  :fns                list the functions the model may call (by shape)',
  '  :depth <spec>       set schema tightness; <spec> is a preset or axis=level pairs:',
  '                        :depth open                       (all positions free strings)',
  '                        :depth paired                     (fully locked)',
  '                        :depth functions=names refs=types (per-axis)',
  '                      axes: refs=open|types|fields|both|paired, typeNames=open|enum,',
  '                            functions=open|names|typed, filters=open|paired',
  '  :sql                toggle printing the emitted base + postgres SQL per query',
  '  :data <dir>         reload Types from a different data directory',
  '  :help               show this help',
  '  :exit               quit (Ctrl+C also works)',
  '',
  'Anything else is treated as a natural-language query request.',
].join('\n');

/** The result of parsing a `:depth` argument: a new depth value or an error. */
type DepthParse = { depth: SchemaDepth | 'open' | 'paired' } | { error: string };

/**
 * Parse a `:depth` argument into a depth value. A lone `open` / `paired` is a
 * preset; otherwise each whitespace-separated token is an `axis=level` pair.
 * Each branch's literal comparisons NARROW the parsed string to the axis's
 * level union, so the `SchemaDepth` is built without a cast.
 */
function parseDepthSpec(arg: string): DepthParse {
  const tokens = arg.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { error: 'usage: :depth <open|paired|axis=level …>' };
  if (tokens.length === 1 && (tokens[0] === 'open' || tokens[0] === 'paired')) {
    return { depth: tokens[0] };
  }
  const depth: SchemaDepth = {};
  for (const tok of tokens) {
    const eq = tok.indexOf('=');
    if (eq < 0) return { error: `expected 'axis=level' (or a preset), got '${tok}'` };
    const axis = tok.slice(0, eq);
    const level = tok.slice(eq + 1);
    if (axis === 'refs') {
      if (level === 'open' || level === 'types' || level === 'fields' || level === 'both' || level === 'paired') depth.refs = level;
      else return { error: `invalid refs level '${level}' (open|types|fields|both|paired)` };
    } else if (axis === 'typeNames') {
      if (level === 'open' || level === 'enum') depth.typeNames = level;
      else return { error: `invalid typeNames level '${level}' (open|enum)` };
    } else if (axis === 'functions') {
      if (level === 'open' || level === 'names' || level === 'typed') depth.functions = level;
      else return { error: `invalid functions level '${level}' (open|names|typed)` };
    } else if (axis === 'filters') {
      if (level === 'open' || level === 'paired') depth.filters = level;
      else return { error: `invalid filters level '${level}' (open|paired)` };
    } else {
      return { error: `unknown axis '${axis}' (refs|typeNames|functions|filters)` };
    }
  }
  return { depth };
}

/** Print the active depth + the model-facing constraint note it produces. */
function printDepth(engine: QueryEngine, depth: SchemaDepth | 'open' | 'paired'): void {
  const label = typeof depth === 'string' ? depth : JSON.stringify(depth);
  console.log(`Schema depth: ${label}`);
  const note = depthInstructions(engine, { depth, functions: CLI_FUNCTIONS, maxEnumSize: CLI_MAX_ENUM_SIZE });
  console.log(note ? note : '(all positions are free strings)');
}

/** Print the loaded Types (name + field count). */
function printTypes(types: Type[]): void {
  if (types.length === 0) {
    console.log('(no Types loaded)');
    return;
  }
  console.log('Loaded Types:');
  for (const t of types) {
    console.log(`  ${t.name} (${t.fields.length} field${t.fields.length === 1 ? '' : 's'}): ${t.fields.map((f) => f.name).join(', ')}`);
  }
}

function printNoProviderMessage(skipped: string[]): void {
  console.log('No AI provider is configured, so the interactive query loop can\'t run.\n');
  console.log('Set one of the following and re-run `npm run cli`:');
  console.log('  • OPENAI_API_KEY      — use OpenAI');
  console.log('  • OPENROUTER_API_KEY  — use OpenRouter');
  console.log('  • AWS credentials     — use AWS Bedrock (env vars, `aws sso login`, IAM role, ~/.aws/credentials)');
  console.log('  • QUERY_MODEL         — (optional) pin a specific model id');
  if (skipped.length > 0) {
    console.log('\nProvider probe details:');
    for (const s of skipped) console.log(`  · skipped ${s}`);
  }
}

async function main(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  const defaultDir = join(here, 'data');
  const arg = process.argv[2];
  let dataDir = arg ? resolve(process.cwd(), arg) : defaultDir;

  // Load data FIRST so even a no-provider run shows the user their schema.
  let loaded = loadDataDir(dataDir);
  console.log(`@aeye/query CLI — data: ${dataDir}\n`);
  for (const w of loaded.warnings) console.log(`warning: ${w}`);
  printTypes(loaded.types);

  // Provider bootstrap. No provider ⇒ friendly message + clean exit (0).
  const { providers, enabled, skipped } = await buildProviders();
  if (enabled.length === 0) {
    console.log('');
    printNoProviderMessage(skipped);
    process.exit(0);
  }
  console.log(`\nProviders: ${enabled.join(', ')}`);
  const pinned = process.env['QUERY_MODEL']?.trim();
  console.log(`Model: ${effectiveModelId()}${pinned ? '' : ' (default)'}`);

  const asker = await createAsker(providers, enabled);

  let showSql = false;
  // The active schema depth, switchable at runtime via `:depth`.
  let replDepth: SchemaDepth | 'open' | 'paired' = CLI_DEFAULT_DEPTH;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log('\nType a request (or :help). Ctrl+C to exit.\n');

  const ask = () => {
    rl.question('query> ', async (line) => {
      const input = line.trim();
      try {
        if (!input) {
          // no-op
        } else if (input === ':exit' || input === ':quit') {
          rl.close();
          return;
        } else if (input === ':help') {
          console.log(HELP);
        } else if (input === ':types') {
          printTypes(loaded.types);
        } else if (input === ':fns') {
          console.log(describeFunctions(loaded.engine, CLI_FUNCTIONS));
        } else if (input === ':depth') {
          printDepth(loaded.engine, replDepth);
        } else if (input.startsWith(':depth')) {
          const result = parseDepthSpec(input.slice(':depth'.length).trim());
          if ('error' in result) {
            console.log(`:depth — ${result.error}`);
          } else {
            replDepth = result.depth;
            printDepth(loaded.engine, replDepth);
          }
        } else if (input === ':sql') {
          showSql = !showSql;
          console.log(`SQL printing ${showSql ? 'ON' : 'OFF'}.`);
        } else if (input.startsWith(':data')) {
          const next = input.slice(':data'.length).trim();
          if (!next) {
            console.log('usage: :data <dir>');
          } else {
            dataDir = resolve(process.cwd(), next);
            loaded = loadDataDir(dataDir);
            console.log(`Reloaded from ${dataDir}.`);
            for (const w of loaded.warnings) console.log(`warning: ${w}`);
            printTypes(loaded.types);
          }
        } else {
          await handleRequest(loaded.engine, asker, input, showSql, replDepth);
        }
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      }
      ask();
    });
  };

  rl.on('close', () => process.exit(0));
  ask();
}

// Only run the REPL when executed directly (not when imported by the test).
const invokedDirectly = (() => {
  try {
    return resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  void main().catch((err: unknown) => {
    console.error(`Fatal: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
