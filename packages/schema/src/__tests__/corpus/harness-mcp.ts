/**
 * CORPUS: MCP schemas the harness imports (systems/mcp/server/schema.ts `ginOfJsonSchema`: JSON Schema →
 * `z.fromJSONSchema` → `ginOf` → gin, falling back to any JSON with a `degraded` reason), and the ones the hub's own
 * MCP server publishes (hub/src/mcp/tools.ts: `z.toJSONSchema(RunArgs, { io: 'input' })` and the static tools).
 *
 * Real fixtures, verbatim:
 * - systems/mcp/server/link.test.ts:30 `ASK` (an elicitation's requestedSchema, a person's form on an approval card);
 * - link.test.ts:34-47 the fixture server's tools: `add` (input + output schema), `echo-text` (its zod args as
 *   @ayepi/mcp publishes them), `odd` (a `$ref` to a missing def: degraded), `boom` / `choose` (`{ type: 'object' }`);
 * - mcp/fixtures.ts:12-61 (NO_ARGS, `{ id }`);
 * - the hub's `run` tool input: core/src/modes.ts:75 `RunArgs` through zod 4's `z.toJSONSchema(…, { io: 'input' })`,
 *   emitted by the harness's own zod (recursive `$defs.__schema0` for `z.json()`, `default: {}`, `propertyNames`).
 *
 * `a`: `fromJSONSchema(json, report)` → a bundle typed `unknown` (or the caller's type); what can't be represented is
 * reported, never dropped silently. The harness's fallback ("any JSON, degraded") is what a missing `$ref` should map to.
 */
import { expectTypeOf } from 'expect-type';
import { a, type Bundle, type ImportReport, type JsonValue } from '../../index';

/** link.test.ts:30 */
export const ASK = { message: 'Which project?', requestedSchema: { type: 'object', properties: { project: { type: 'string', description: 'The project' } }, required: ['project'] } } as const;

/** link.test.ts:36 `add` */
export const ADD_INPUT = { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] } as const;
export const ADD_OUTPUT = { type: 'object', properties: { sum: { type: 'number' } }, required: ['sum'] } as const;
/** link.test.ts:41 `echo-text`: `z.object({ text: z.string().describe('What to say') })` as published (zod 4 toJSONSchema). */
export const ECHO_INPUT = {
  $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object',
  properties: { text: { type: 'string', description: 'What to say' } }, required: ['text'], additionalProperties: false,
} as const;
/** link.test.ts:45 `odd`: a schema with a missing `$ref`. */
export const ODD_INPUT = { type: 'object', properties: { x: { $ref: '#/$defs/missing' } } } as const;
/** link.test.ts:46 `boom`, :47 `choose`; mcp/fixtures.ts:12 NO_ARGS. */
export const OBJECT_INPUT = { type: 'object' } as const;
export const NO_ARGS = { type: 'object', properties: {} } as const;
/** mcp/fixtures.ts:54 */
export const ID_INPUT = { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } as const;

/** The hub's `run` tool as its MCP server publishes it (zod 4 `z.toJSONSchema(RunArgs, { io: 'input' })`, verbatim). */
export const HUB_RUN_INPUT = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    fn: { type: 'string', minLength: 1, description: 'The fn to run, by its qualified name (fs/read).' },
    args: { default: {}, description: 'Its args, as its card shows them.', type: 'object', propertyNames: { type: 'string' }, additionalProperties: { $ref: '#/$defs/__schema0' } },
    on: { description: 'For a system with several machines connected, which one runs it (laptop).', type: 'string', pattern: '^[a-z][a-z0-9-]*$' },
  },
  required: ['fn'],
  $defs: {
    __schema0: {
      anyOf: [
        { type: 'string' }, { type: 'number' }, { type: 'boolean' }, { type: 'null' },
        { type: 'array', items: { $ref: '#/$defs/__schema0' } },
        { type: 'object', propertyNames: { type: 'string' }, additionalProperties: { $ref: '#/$defs/__schema0' } },
      ],
    },
  },
} as const;

/** What each import reports. */
export const reports = {
  ask: { unsupported: [] } as ImportReport,
  add: { unsupported: [] } as ImportReport,
  echo: { unsupported: [] } as ImportReport,
  odd: { unsupported: [] } as ImportReport,
  run: { unsupported: [] } as ImportReport,
};

/** An elicitation's form, typed by the caller (the MCP server's contract says what it asks). */
export const AskForm = a.fromJSONSchema<{ project: string }>(ASK.requestedSchema, reports.ask);
export const AddInput = a.fromJSONSchema<{ a: number; b: number }>(ADD_INPUT, reports.add);
export const AddOutput = a.fromJSONSchema<{ sum: number }>(ADD_OUTPUT);
export const EchoInput = a.fromJSONSchema<{ text: string }>(ECHO_INPUT, reports.echo);
/** Untyped imports (a mirrored tool's args are `unknown` until the run checks them). */
export const OddInput = a.fromJSONSchema(ODD_INPUT, reports.odd);
export const ObjectInput = a.fromJSONSchema(OBJECT_INPUT);
export const NoArgs = a.fromJSONSchema(NO_ARGS);
export const IdInput = a.fromJSONSchema<{ id: string }>(ID_INPUT);
/** The hub's `run`, typed as the code reads it (`RunArgs`' input side). */
export const HubRunInput = a.fromJSONSchema<{ fn: string; args?: Record<string, JsonValue>; on?: string }>(HUB_RUN_INPUT, reports.run);

expectTypeOf(OddInput).toEqualTypeOf<Bundle<unknown, []>>();
expectTypeOf(AskForm.bind()._out).toEqualTypeOf<{ project: string }>();
expectTypeOf<a.infer<typeof HubRunInput>>().toEqualTypeOf<{ fn: string; args?: Record<string, JsonValue>; on?: string }>();
