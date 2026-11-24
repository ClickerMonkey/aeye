/**
 * @aeye/core Tool args and Prompt structured outputs, ported to `a`:
 * every schema in core's README/docs (packages/core/README.md, aeye-core*.md),
 * in core's src doc comments, and every distinct schema in core's
 * Tool/Prompt/Agent tests (packages/core/src/__tests__/{tool,agent,prompt-*,
 * metadata,claims,context-propagation}.test.ts).
 *
 * The function forms move as proposal/core-api.ts says:
 *   - `schema: (ctx) => z...`             → a chain with `.dynamic((ctx) => ...)`
 *   - `schema: () => undefined`           → `applicable: () => false`
 *   - prompt `schema: (input, ctx) => z...` → `.dynamic((ctx, input) => ...)`
 *   - prompt `schema: () => false`        → (GAP: PromptInputV2 has no `applicable`)
 *   - custom `parse` hook                 → `a.codec` on the schema
 *
 * Each schema has its source as `core:<file>:<line>` above it.
 */
import { expectTypeOf } from 'expect-type';
import { a, type SchemaOf } from '../../index';
import { prompt, tool, type Context } from '../../proposal/core-api';

// ============================================================================
// README / docs
// ============================================================================

// core:README.md:56 (also aeye-core.md:60) — the summarizer's structured output.
export const SummaryOutput = a.object({
  summary: a.string().describe('A concise summary'),
  keyPoints: a.array(a.string()).describe('Main points'),
});
expectTypeOf<a.infer<typeof SummaryOutput>>().toEqualTypeOf<{ summary: string; keyPoints: string[] }>();
export const summarizer = prompt({
  name: 'summarize',
  content: 'Summarize the following text:\n\n{{text}}',
  schema: SummaryOutput,
});

// core:README.md:87 (also aeye-core-tools.md:63) — `units: z.enum([...]).default('celsius')`.
export const GetWeatherArgs = a.object({
  location: a.string().describe('City name or coordinates'),
  units: a.enum(['celsius', 'fahrenheit']).default('celsius'),
});
// zod's output type: the default makes `units` required in code.
expectTypeOf<a.infer<typeof GetWeatherArgs>>().toEqualTypeOf<{ location: string; units: 'celsius' | 'fahrenheit' }>();
export const getWeather = tool({
  name: 'getWeather',
  description: 'Get current weather for a location',
  instructions: 'Use this tool to get weather data for {{location}}.',
  schema: GetWeatherArgs,
  call: (input) => ({ temperature: 20, condition: 'sunny', units: input.units, location: input.location }),
});
expectTypeOf(getWeather.call).parameter(0).toEqualTypeOf<{ location: string; units: 'celsius' | 'fahrenheit' }>();

// core:README.md:128 (also aeye-core-prompts.md:119) — travelAdvisor output.
export const TravelAdvice = a.object({
  recommendations: a.array(a.string()),
  packingList: a.array(a.string()),
  weatherNotes: a.string(),
});
expectTypeOf<a.infer<typeof TravelAdvice>>().toEqualTypeOf<{ recommendations: string[]; packingList: string[]; weatherNotes: string }>();
export const travelAdvisor = prompt({
  name: 'travelAdvisor',
  content: 'You are a travel advisor. Help plan a trip to {{destination}}.',
  schema: TravelAdvice,
});

/** core:README.md:290 MyContext. */
export interface MyContext { userRole: 'admin' | 'user'; isAuthenticated: boolean }
export type Action = 'read' | 'write' | 'delete';

// core:README.md:298 (also aeye-core-tools.md:83) — the schema varies with the caller's role:
//   schema: (ctx) => ctx.userRole === 'admin' ? z.object({ action: z.enum(['read','write','delete']) }) : z.object({ action: z.enum(['read']) })
//   applicable: (ctx) => ctx.isAuthenticated
export const ManageDataArgs = a
  .declare<{ Action: Action }>()
  .dynamic(
    (ctx: Context<MyContext>) => ({ Action: ctx.userRole === 'admin' ? a.enum(['read', 'write', 'delete']) : a.enum(['read']) }),
    { key: (ctx) => ctx.userRole },
  )
  .result(a.object({ action: a.ref('Action') }));
expectTypeOf<a.infer<typeof ManageDataArgs>>().toEqualTypeOf<{ action: Action }>();
expectTypeOf(ManageDataArgs.bind).parameters.toEqualTypeOf<[ctx: Context<MyContext>]>();
export const manageData = tool({
  name: 'manageData',
  description: 'Manage data records',
  instructions: 'Use this tool to read or write data.',
  schema: ManageDataArgs,
  applicable: (ctx: Context<MyContext>) => ctx.isAuthenticated,
  call: (input, ctx) => ({ action: input.action, executedBy: ctx.userRole }),
});
expectTypeOf(manageData.call).parameter(0).toEqualTypeOf<{ action: Action }>();
// A tool whose ctx lacks `userRole` can't take ManageDataArgs.
tool({
  name: 'bad',
  description: '',
  // @ts-expect-error — ManageDataArgs needs MyContext from ctx.
  schema: ManageDataArgs as typeof ManageDataArgs,
  call: (_input, _ctx: Context<{ other: true }>) => '',
});

// core:README.md:323 (also aeye-core-tools.md:98) — `quantity: z.number().int().min(1)`; `validate` stays a tool hook.
export const PlaceOrderArgs = a.object({ itemId: a.string(), quantity: a.int().min(1) });
expectTypeOf<a.infer<typeof PlaceOrderArgs>>().toEqualTypeOf<{ itemId: string; quantity: number }>();

// core:README.md:401 — adaptive prompt output.
export const SolutionOutput = a.object({ solution: a.string() });
// core:README.md:760 — typed prompt result.
export const GreetingOutput = a.object({ greeting: a.string() });
// core:README.md:771, prompt-core-features.test.ts:59/262/319/330/381, agent.test.ts:133,
// prompt-modes-reconfig.test.ts:24, prompt-tool-intercept.test.ts:126/149/355,
// prompt-tool-result-transformer.test.ts:48, tool.test.ts:506/642 — the add tool.
export const AddArgs = a.object({ a: a.number(), b: a.number() });
expectTypeOf<a.infer<typeof AddArgs>>().toEqualTypeOf<{ a: number; b: number }>();
export const add = tool({ name: 'add', description: 'Adds two numbers', schema: AddArgs, call: (input) => input.a + input.b });

// core:README.md:512 (also aeye-core-schema.md:166) — "same Zod, different wire shapes".
export const TaggedArgs = a.object({ name: a.string(), tags: a.record(a.string()) });
expectTypeOf<a.infer<typeof TaggedArgs>>().toEqualTypeOf<{ name: string; tags: Record<string, string> }>();

// ============================================================================
// core src
// ============================================================================

// core:src/tool.ts:12 TEXT_TOOL_SCHEMA — the parameters of a free-form (grammar/text) tool.
export const TextToolArgs = a.object({ input: a.string() });
// core:src/tool.ts:284 (Tool doc comment) and core:src/prompt.ts:554 (Prompt doc comment).
export const LocationArgs = a.object({ location: a.string() });
export const SummaryOnly = a.object({ summary: a.string() });

// ============================================================================
// core tests: Tool args
// ============================================================================

// core:tool.test.ts:63 — the calculator.
export const CalculatorArgs = a.object({ operation: a.enum(['add', 'subtract']), a: a.number(), b: a.number() });
expectTypeOf<a.infer<typeof CalculatorArgs>>().toEqualTypeOf<{ operation: 'add' | 'subtract'; a: number; b: number }>();
export const calculator = tool({
  name: 'calculator',
  description: 'Calculates things',
  instructions: 'Use for math',
  schema: CalculatorArgs,
  call: (input) => (input.operation === 'add' ? input.a + input.b : input.a - input.b),
});

// core:tool.test.ts:86 — `z.number().positive()` (exclusiveMinimum 0).
export const PositiveArgs = a.object({ value: a.number().positive() });
// core:prompt-events-tools-execution.test.ts:532 — the same, as a prompt output.
export const PersonPositive = a.object({ name: a.string(), age: a.number().positive() });

// core:tool.test.ts:121 — `program` must be an object (the double-encoding repair case).
export const ProgramArgs = a.object({ program: a.object({ kind: a.string(), value: a.number() }) });
expectTypeOf<a.infer<typeof ProgramArgs>>().toEqualTypeOf<{ program: { kind: string; value: number } }>();
// core:tool.test.ts:194 — the malformed-inner-JSON case.
export const ProgramKindArgs = a.object({ program: a.object({ kind: a.string() }) });
// core:tool.test.ts:147/227 — a nested object payload.
export const PayloadArgs = a.object({ payload: a.object({ x: a.number() }) });
// core:tool.test.ts:169 — a string payload (the maxArgsLength case; the cap is a Tool hook, not schema).
export const PayloadText = a.object({ payload: a.string() });

// core:tool.test.ts:251 — `z.string().email()`.
export const EmailArgs = a.object({ email: a.string().format('email') });

// core:tool.test.ts:617 — compile(): described location + optional enum.
export const WeatherUnitArgs = a.object({
  location: a.string().describe('The city name'),
  unit: a.enum(['celsius', 'fahrenheit']).optional(),
});
expectTypeOf<a.infer<typeof WeatherUnitArgs>>().toEqualTypeOf<{ location: string; unit?: 'celsius' | 'fahrenheit' }>();

// core:tool.test.ts:960 — Tool.parse under OpenAI strict: nulls for left-out optionals leave no key, even nested.
export const NestedOptionalArgs = a.object({
  a: a.number(),
  b: a.string().optional(),
  inner: a.object({ c: a.number().optional(), d: a.string() }),
});
expectTypeOf<a.infer<typeof NestedOptionalArgs>>().toEqualTypeOf<{ a: number; b?: string; inner: { c?: number; d: string } }>();

// core:prompt-parallel-claims.test.ts:46 — `path` optional.
export const OptionalPathArgs = a.object({ path: a.string().optional() });
// core:claims.test.ts:64
export const PathArgs = a.object({ path: a.string() });

// core:prompt-retry-translation-resolution.test.ts:450 — `z.string().min(10)` "Strict validation".
export const RequiredMin10 = a.object({ required: a.string().min(10) });
// core:prompt-events-tools-execution.test.ts:813
export const ValueMin10 = a.object({ value: a.string().min(10) });

// core:tool.test.ts:601/659/746/769/795/803, prompt-tools-dynamic.test.ts:845 — `schema: () => undefined`:
// the tool is not available. Now a static schema + `applicable`.
export const hidden = tool({
  name: 'hidden',
  description: 'Hidden',
  instructions: 'Hidden',
  schema: a.object({}),
  applicable: () => false,
  call: () => 'never',
});

/**
 * The trivial tool/prompt schemas of core's tests, deduplicated: [name, schema,
 * sources, a code-shape sample].
 */
export const TRIVIAL = [
  ['empty', a.object({}), 'agent.test.ts:552, context-propagation.test.ts:24/51/63/168/261/315/385/396/540, metadata.test.ts:279, prompt-*.test.ts (60+ sites), tool.test.ts:37/45/538/546/585/676/692/708/725/761/778/811/830', {}],
  ['input', a.object({ input: a.string() }), 'agent.test.ts:38', { input: 'hi' }],
  ['x', a.object({ x: a.number() }), 'agent.test.ts:58/356/381/407/416, metadata.test.ts:161/176, prompt-modes-reconfig.test.ts:71, prompt-suspend-resume.test.ts:197', { x: 1 }],
  ['url', a.object({ url: a.string() }), 'agent.test.ts:172', { url: 'https://example.com' }],
  ['data', a.object({ data: a.string() }), 'agent.test.ts:182, tool.test.ts:101, prompt-retry-translation-resolution.test.ts:494', { data: 'd' }],
  ['topic', a.object({ topic: a.string() }), 'agent.test.ts:497', { topic: 't' }],
  ['text', a.object({ text: a.string() }), 'agent.test.ts:513, prompt-tool-intercept.test.ts:103/386/444', { text: 'echo' }],
  ['value-number', a.object({ value: a.number() }), 'metadata.test.ts:108, prompt-*.test.ts (30+ sites), tool.test.ts:23/287/305/334/356/374/408/454/846/866/893', { value: 42 }],
  ['operation', a.object({ operation: a.string() }), 'metadata.test.ts:124', { operation: 'sum' }],
  ['mode', a.object({ mode: a.string() }), 'metadata.test.ts:140', { mode: 'fast' }],
  ['value-string', a.object({ value: a.string() }), 'prompt-edge-cases-errors.test.ts:439/523/622, prompt-events-tools-execution.test.ts:565, prompt-miscellaneous-simple.test.ts:70, prompt-streaming-tool-events.test.ts:491, prompt-suspend-resume.test.ts:100/247, prompt-tools-dynamic.test.ts:20/33/102/506', { value: 'v' }],
  ['summary', a.object({ summary: a.string() }), 'prompt-edge-cases-errors.test.ts:487, src/prompt.ts:554', { summary: 's' }],
  ['q', a.object({ q: a.string() }), 'prompt-error-kinds.test.ts:20, prompt-review.test.ts:99, prompt-schema-fallbacks.test.ts:88/95', { q: 'cats' }],
  ['required', a.object({ required: a.string() }), 'prompt-events-tools-execution.test.ts:284', { required: 'r' }],
  ['name-age', a.object({ name: a.string(), age: a.number() }), 'prompt-core-features.test.ts:48/180/208', { name: 'Alice', age: 30 }],
  ['id', a.object({ id: a.number() }), 'prompt-suspend-resume.test.ts:143/255, prompt-tool-result-pairing.test.ts:44/54', { id: 7 }],
  ['action', a.object({ action: a.string() }), 'prompt-suspend-resume.test.ts:45', { action: 'approve' }],
  ['task', a.object({ task: a.string() }), 'prompt-suspend-resume.test.ts:313', { task: 'ship it' }],
  ['query', a.object({ query: a.string() }), 'prompt-tool-intercept.test.ts:78/172/196/226/252/279/309/348, prompt-tool-result-transformer.test.ts:40, prompt-tools-dynamic.test.ts:515/585/741/749/757', { query: 'q' }],
  ['val', a.object({ val: a.string() }), 'prompt-tools-dynamic.test.ts:568/576', { val: 'v' }],
  ['result', a.object({ result: a.string() }), 'prompt-retry-translation-resolution.test.ts:505, prompt-streaming-tool-events.test.ts:351', { result: 'ok' }],
  ['key', a.object({ key: a.string() }), 'tool.test.ts:521', { key: 'k' }],
  ['delay', a.object({ delay: a.number() }), 'tool.test.ts:565', { delay: 10 }],
  ['csv', a.object({ csv: a.string() }), 'tool.test.ts:483, prompt-output-custom-parse.test.ts:288', { csv: '1,2,3' }],
] as const;

// ============================================================================
// core tests: Prompt outputs (function forms)
// ============================================================================

// core:prompt-modes-reconfig.test.ts:450 — the output schema depends on the input:
//   schema: (input?: { includeAge: boolean }) => input?.includeAge ? z.object({ name, age }) : z.object({ name })
export type PersonOut = { name: string; age: number } | { name: string };
export const PersonByInput = a
  .declare<{ Person: PersonOut }>()
  .dynamic(
    (_ctx: Context<{}>, input?: { includeAge: boolean }) => ({
      Person: (input?.includeAge ? a.object({ name: a.string(), age: a.number() }) : a.object({ name: a.string() })) as SchemaOf<PersonOut>,
    }),
    { key: (_ctx, input) => !!input?.includeAge },
  )
  .result('Person');
expectTypeOf<a.infer<typeof PersonByInput>>().toEqualTypeOf<PersonOut>();
// The `input?` of the dynamic step comes out REQUIRED (`input: T | undefined`) in `bind`'s parameters
// (type-level GAP: optional-dynamic-arg); a caller must pass `undefined` explicitly.
expectTypeOf(PersonByInput.bind).parameters.toEqualTypeOf<[Context<{}>, { includeAge: boolean } | undefined]>();

// core:prompt-miscellaneous-simple.test.ts:367 — `schema: z.string().min(5)`: core answers with the raw text.
export const TextMin5 = a.string().min(5);

// core:prompt-applicability-compatibility.test.ts:20 and prompt-edge-cases-errors.test.ts:553 —
// `schema: () => false` / `(input, ctx) => false`: the prompt is not applicable. PromptInputV2 has no
// `applicable` (GAP: prompt-applicable); the port can only drop the schema.
export const notApplicablePrompt = prompt({
  name: 'schema-false',
  content: 'Test',
  // @ts-expect-error GAP: prompt-applicable — PromptInputV2 has no `applicable` for "schema returned false".
  applicable: () => false,
});

// ============================================================================
// Custom parse hooks → a.codec
// ============================================================================

/** core:tool.test.ts:400 `Built` — what `parse` returns instead of the wire shape. */
export class Built {
  constructor(readonly value: number) {}
  doubled(): number { return this.value * 2; }
}
// core:tool.test.ts:408 — `schema: z.object({ value: z.number() }), parse: (raw) => new Built(raw.value)`.
export const BuiltArgs = a.codec(a.object({ value: a.number() }), {
  decode: (w) => new Built(w.value),
  encode: (b) => ({ value: b.value }),
});
expectTypeOf<a.infer<typeof BuiltArgs>>().toEqualTypeOf<Built>();
export const decodedClass = tool({
  name: 'decoded-class',
  description: 'parse returns a class instance',
  schema: BuiltArgs,
  call: (input) => input.doubled(),
});
expectTypeOf(decodedClass.call).parameter(0).toEqualTypeOf<Built>();

// core:tool.test.ts:483 and prompt-output-custom-parse.test.ts:288 — `parse: (raw) => raw.csv.split(',').map(Number)`.
export const CsvNumbers = a.codec(a.object({ csv: a.string() }), {
  decode: (w) => {
    const nums = w.csv.split(',').map(Number);
    return nums.some(Number.isNaN) ? new Error(`"${w.csv}" is not a comma-separated list of numbers.`) : nums;
  },
  encode: (nums) => ({ csv: nums.join(',') }),
});
expectTypeOf<a.infer<typeof CsvNumbers>>().toEqualTypeOf<number[]>();

// core:prompt-output-custom-parse.test.ts:49 — a parser returning a rich Error.
export const RichErrorOutput = a.codec(a.object({ value: a.number() }), {
  decode: () => new Error('nice compiler-style error ^^^ here'),
  encode: (v: { value: number }) => v,
});
