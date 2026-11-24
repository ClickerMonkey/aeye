/**
 * Runtime tests for harness-mcp.ts: outside MCP servers' tool schemas and elicitation forms, and the hub's own
 * published `run` schema, imported with `fromJSONSchema` and rendered for every profile.
 */
import Handlebars from 'handlebars';
import { describe, expect, it } from 'vitest';
import { ANTHROPIC_STRICT, GOOGLE_STRICT, LENIENT, ModelProfile, OPENAI_STRICT, PEOPLE, XAI_NON_STRICT, XAI_STRICT, schemaHelpers, type Profile } from '../../index';
import { asTool, clone, profileProblems, unexplained } from './_check';
import * as M from './harness-mcp';
import { lines } from '../_lines';

const tool = <T>(bound: { render(p: Profile): T }, p: Profile): T => bound.render(asTool(p));

describe('an elicitation\'s requested form (systems/mcp/server/elicitation.ts:44, link.test.ts:30)', () => {
  const form = M.AskForm.bind();

  it('imports with nothing unsupported, and renders for the person who fills it', () => {
    expect(M.reports.ask.unsupported).toEqual([]);
    expect(form.render(PEOPLE).jsonSchema).toEqual({ type: 'object', properties: { project: { type: 'string', description: 'The project' } }, required: ['project'] });
    expect(profileProblems(form, [{ project: 'Website' }])).toEqual([]);
  });

  it('reads the person\'s answer (answer_elicitation\'s example `content`), refuses a missing one', () => {
    const answer = { project: 'Website' };
    const res = form.render(PEOPLE).parse(answer);
    expect(res.ok && res.value).toBe(answer);
    const missing = form.render(PEOPLE).parse({});
    expect(lines(missing)).toBe('- at project: Required.');
  });
});

describe('a mirrored server\'s tools (systems/mcp/server/mirror.ts:32, link.test.ts:34)', () => {
  it('add: input and output schemas, typed by the caller; strict on every provider', () => {
    expect(M.reports.add.unsupported).toEqual([]);
    expect(profileProblems(M.AddInput.bind(), [{ a: 1, b: 2 }, { a: -0.5, b: 1e9 }])).toEqual([]);
    expect(profileProblems(M.AddOutput.bind(), [{ sum: 3 }], { tool: false })).toEqual([]);
    for (const p of [OPENAI_STRICT, ANTHROPIC_STRICT, XAI_STRICT, GOOGLE_STRICT]) {
      const res = tool(M.AddInput.bind(), p).parse({ a: 1, b: 2 });
      expect(res.ok && res.value, p.id).toEqual({ a: 1, b: 2 });
    }
    const bad = tool(M.AddInput.bind(), OPENAI_STRICT).parse({ a: '1' });
    expect(bad.ok ? [] : bad.issues.map((i) => [i.path, i.message])).toEqual([[['a'], 'Expected a number, got string.'], [['b'], 'Required.']]);
  });

  it('echo-text: a zod-published schema ($schema, closed) imports as is', () => {
    expect(M.reports.echo.unsupported).toEqual([]);
    expect(tool(M.EchoInput.bind(), OPENAI_STRICT).jsonSchema).toEqual({ type: 'object', properties: { text: { type: 'string', description: 'What to say' } }, required: ['text'], additionalProperties: false });
    expect(profileProblems(M.EchoInput.bind(), [{ text: 'hi' }])).toEqual([]);
    const extra = tool(M.EchoInput.bind(), XAI_STRICT).parse({ text: 'hi', loud: true });
    expect(extra.ok).toBe(false);
  });

  it('no args (`{ type: "object", properties: {} }`, mcp/fixtures.ts:12) and `{ id }` (:54)', () => {
    expect(profileProblems(M.NoArgs.bind(), [{}])).toEqual([]);
    expect(profileProblems(M.IdInput.bind(), [{ id: 'T-1' }])).toEqual([]);
    const res = tool(M.IdInput.bind(), ANTHROPIC_STRICT).parse({});
    expect(lines(res)).toBe('- at id: Required.');
  });

  it('(was GAP) `{ type: "object" }` with no properties (boom, choose) means ANY object — imported closed, a model can send no args at all', () => {
    const r = tool(M.ObjectInput.bind(), XAI_NON_STRICT);
    expect(r.jsonSchema['additionalProperties']).not.toBe(false);
    expect(r.parse({ anything: 1 }).ok).toBe(true);
  });

  it('(was GAP) a missing $ref (odd) should be reported (the harness degrades it to any JSON with a reason), not silently a JSON-text def', () => {
    expect(M.OddInput.bind()).toBeDefined();
    expect(M.reports.odd.unsupported).not.toEqual([]);
  });

  it('a missing $ref today: the field is any JSON, written as JSON text on every profile', () => {
    const r = tool(M.OddInput.bind(), ANTHROPIC_STRICT);
    expect(r.jsonSchema).toMatchObject({ properties: { x: { $ref: '#/$defs/missing' } }, $defs: { missing: { type: 'string', description: 'Unknown reference missing.\nWrite the value as JSON text.' } } });
    const res = r.parse({ x: '{"anything":1}' });
    expect(res.ok && res.value).toEqual({ x: { anything: 1 } });
  });
});

describe('the hub\'s own `run`, as its MCP server publishes it (zod 4 toJSONSchema of RunArgs)', () => {
  const run = M.HubRunInput.bind();
  const samples = [{ fn: 'fs__read', args: { path: 'x', lines: [1, 20] }, on: 'laptop' }, { fn: 'hub__fns_examples', args: { fn: 'hub__fns_get' } }, { fn: 'x' }];

  it('imports the recursive z.json() ($defs.__schema0) with nothing unsupported; round-trips flat args everywhere', () => {
    expect(M.reports.run.unsupported).toEqual([]);
    expect(profileProblems(run, samples)).toEqual([]);
    expect(tool(run, OPENAI_STRICT).jsonSchema).toMatchObject({
      properties: { args: { anyOf: [{ type: 'array', items: { properties: { key: { type: 'string' }, value: { $ref: '#/$defs/__schema0' } } } }, { type: 'null' }] } },
      $defs: { __schema0: { anyOf: expect.any(Array) } },
    });
    // Claude strict: the recursive JSON value is described once and recurs as JSON text
    expect(tool(run, ANTHROPIC_STRICT).jsonSchema['description']).toBe('Named types used by the fields written as JSON text:\ntype __schema0 = string | number | boolean | __schema0[] | { [key: string]: __schema0 } | null');
  });

  it('(was GAP) a JSON value holding an object, inside a record, on a pairs dialect — z.json()\'s union of a list and a record-as-pairs is ambiguous (both arrays)', () => {
    expect(profileProblems(run, [{ fn: 'fs__read', args: { path: 'x', deep: { a: [1, null] } } }])).toEqual([]);
  });

  it('decodes each provider\'s answer', () => {
    const openai = { fn: 'fs__read', args: [{ key: 'path', value: 'notes.md' }, { key: 'lines', value: [1, 20] }], on: null };
    const res = tool(run, OPENAI_STRICT).parse(openai);
    expect(res.ok && res.value).toEqual({ fn: 'fs__read', args: { path: 'notes.md', lines: [1, 20] } });
    expect(res.stats).toEqual({ objects: 1, arrays: 0, edits: 2, parsed: 0, repaired: 0 });
    const grok = { fn: 'fs__read', args: { path: 'notes.md' } };
    const g = tool(run, XAI_STRICT).parse(grok);
    expect(g.ok && g.value).toBe(grok);
    const bad = tool(run, ANTHROPIC_STRICT).parse({ fn: '', on: 'My Laptop' });
    expect(bad.ok ? [] : bad.issues.map((i) => i.path)).toEqual([['fn'], ['on']]);
  });

  it('encodes a call for the tool\'s instructions; budgets it with the other static tools', () => {
    const entry = ModelProfile.of(OPENAI_STRICT).request([{ kind: 'tool', name: 'run', schema: run }]).get('run');
    const t = Handlebars.compile('Example args: {{encode call}}', { noEscape: true });
    expect(t({ call: { fn: 'hub__fns_examples', args: { fn: 'hub__fns_get' } } }, { helpers: entry.helpers() })).toBe('Example args: {"fn":"hub__fns_examples","args":[{"key":"fn","value":"hub__fns_get"}],"on":null}');
    expect(t({ call: { fn: 'hub__fns_examples', args: { fn: 'hub__fns_get' } } }, { helpers: schemaHelpers(run.render(asTool(GOOGLE_STRICT))) })).toBe('Example args: {"fn":"hub__fns_examples","args":{"fn":"hub__fns_get"}}');
    const claude = ModelProfile.of(ANTHROPIC_STRICT).request([
      { kind: 'tool', name: 'run', schema: run },
      { kind: 'tool', name: 'add', schema: M.AddInput.bind() },
      { kind: 'tool', name: 'echo_text', schema: M.EchoInput.bind() },
    ]);
    expect(unexplained(claude)).toEqual([]);
    expect(claude.entries.every((e) => e.strict)).toBe(true);
    expect(claude.get('add').parse(clone({ a: 1, b: 2 })).ok).toBe(true);
    expect(LENIENT.id).toBe('lenient');
  });
});
