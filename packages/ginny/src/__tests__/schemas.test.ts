/**
 * ginny's tool and prompt schemas on `@aeye/schema`: each bound with a real
 * gin registry (ginny's own bootstrap types) the way a request binds it,
 * rendered for OpenAI strict / Anthropic strict / lenient, a model-shaped
 * answer decoded, a bad one told back to the model, and the programmer's
 * whole tool set planned as one request.
 */
import { describe, expect, it } from 'vitest';
import { ANTHROPIC_STRICT, LENIENT, ModelProfile, OPENAI_STRICT, type Bound } from '@aeye/schema';
import { createRegistry, Registry } from '@aeye/gin';
import { write } from '../tools/write';
import { test as testTool } from '../tools/test';
import { editType } from '../tools/edit-type';
import { ask } from '../tools/ask';
import { finish } from '../tools/finish';
import { printFn } from '../tools/print-fn';
import { searchFns } from '../tools/search-fns';
import { searchVars } from '../tools/search-vars';
import { research } from '../tools/research';
import { findOrCreateFunctions } from '../tools/find-or-create-fns';
import { findOrCreateTypes } from '../tools/find-or-create-types';
import { findOrCreateVars } from '../tools/find-or-create-vars';
import { webSearch } from '../tools/web-search';
import { webGetPage } from '../tools/web-get-page';
import { architect } from '../prompts/architect';
import { dba } from '../prompts/dba';
import { designer } from '../prompts/designer';
import { researcher } from '../prompts/researcher';

function registry(): Registry {
  const r = createRegistry();
  r.register(r.extend('obj', { name: 'Task', docs: 'a work item', props: { title: { type: r.text({ minLength: 1 }) }, done: { type: r.bool() } } }));
  return r;
}

const reg = registry();
const argsType = reg.obj({ n: { type: reg.num({ whole: true, min: 1 }), docs: 'how many' }, task: { type: reg.lookup('Task')! } });
const ctx = (extra: Record<string, unknown> = {}) => ({
  registry: reg,
  runState: { draft: { kind: 'new', type: { name: 'num' }, value: 1 }, lastTest: { success: true } },
  features: { webSearch: true },
  ask: async () => 'yes',
  store: { readFn: () => { throw new Error('none'); }, readType: () => { throw new Error('none'); } },
  ...extra,
});

interface WithSource { readonly name?: string; readonly source: { bind(...args: unknown[]): Promise<Bound<unknown> | undefined> } }
const bindTool = async (t: unknown, c = ctx()) => (await (t as WithSource).source.bind(c))!;
const bindPrompt = async (p: unknown, c = ctx()) => (await (p as { output: WithSource["source"] }).output.bind(c, { description: "x" }))!;

const PROGRAM = {
  kind: 'define',
  vars: [{ name: 'items', value: { kind: 'new', type: { name: 'list', generic: { V: { name: 'num' } } }, value: [{ kind: 'new', type: { name: 'num' }, value: 1 }] } }],
  body: { kind: 'get', path: [{ prop: 'items' }, { prop: 'length' }] },
};

describe('ginny tool schemas', () => {
  it('write: the gin grammar with newStrict, on every profile family; a program decodes, a bad one is told back', async () => {
    const bound = await bindTool(write);
    for (const p of [OPENAI_STRICT, ANTHROPIC_STRICT, LENIENT]) {
      const r = bound.render(p);
      const res = r.parse(JSON.parse(JSON.stringify(r.encode({ program: PROGRAM }))));
      expect(res.ok ? res.value : res.message, p.id).toEqual({ program: PROGRAM });
    }
    expect(JSON.stringify(bound.render(OPENAI_STRICT).jsonSchema)).toContain('New_Task');
    const bad = bound.render(OPENAI_STRICT).parse({ program: { kind: 'defne', vars: [], body: null } });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.message).toContain('program');
      expect(bad.message).toContain('did you mean `define`');
    }
    // cached per registry version: the next request binds the same thing
    expect(await bindTool(write)).toBe(bound);
  });

  it('edit_type: { name, def: TypeDef } with the registry\'s named types', async () => {
    const bound = await bindTool(editType);
    const r = bound.render(LENIENT);
    expect(r.parse({ name: 'Task', def: { name: 'Task', extends: 'obj', props: { title: { type: { name: 'text' } } } } }).ok).toBe(true);
    expect(r.parse({ name: 'Task', def: { name: 'list', generic: { V: { name: 'Task' } } } }).ok).toBe(true);
    const bad = r.parse({ name: 'Task', def: { name: 'Taks' } });
    expect(bad.ok).toBe(false);
  });

  it('test: args typed by the fn being authored (its docs, its named types), else an open record', async () => {
    const typed = await bindTool(testTool, ctx({ targetFn: { argsType } }));
    const js = JSON.stringify(typed.render(OPENAI_STRICT).jsonSchema);
    expect(js).toContain('how many');
    const r = typed.render(LENIENT);
    expect(r.parse({ args: { n: 2, task: { title: 'x', done: false } } }).ok).toBe(true);
    const bad = r.parse({ args: { n: 0, task: { title: 'x', done: false } } });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.message).toContain('args.n');
    const open = await bindTool(testTool);
    expect(open.render(LENIENT).parse({ args: { anything: [1] }, expectError: true }).ok).toBe(true);
    expect(open).not.toBe(typed);
  });

  it('static tools: defaults filled in on decode', async () => {
    const search = (await bindTool(searchFns)).render(OPENAI_STRICT);
    const res = search.parse({ keywords: null, limit: null });
    expect(res.ok ? res.value : res.message).toEqual({ keywords: [], limit: 20 });
    const print = (await bindTool(printFn)).render(LENIENT).parse({ name: 'f' });
    expect(print.ok && print.value).toEqual({ name: 'f', includeComments: true });
    const web = (await bindTool(webSearch)).render(LENIENT).parse({ query: 'q' });
    expect(web.ok && web.value).toEqual({ query: 'q', maxResults: 5 });
  });
});

describe('ginny prompt schemas', () => {
  it('architect: { use, create: TypeDef[] } (defaults [])', async () => {
    const r = (await bindPrompt(architect)).render(OPENAI_STRICT);
    const res = r.parse(JSON.parse(JSON.stringify(r.encode({ use: ['Task'], create: [{ name: 'Point', extends: 'obj', props: { x: { type: { name: 'num' } } } }] }))));
    expect(res.ok ? res.value : res.message).toEqual({ use: ['Task'], create: [{ name: 'Point', extends: 'obj', props: { x: { type: { name: 'num' } } } }] });
  });
  it('dba create_var: the value is checked against the type written beside it', async () => {
    const tools = (dba as unknown as { input: { tools: unknown[] } }).input.tools;
    const createVar = tools.find((t) => (t as { input: { name: string } }).input.name === 'create_var')!;
    const r = (await bindTool(createVar)).render(LENIENT);
    expect(r.parse({ name: 'n', type: { name: 'num', options: { min: 0 } }, value: 3 }).ok).toBe(true);
    const bad = r.parse({ name: 'n', type: { name: 'num', options: { min: 0 } }, value: -1 });
    expect(bad.ok).toBe(false);
    expect(r.parse({ name: 't', type: { name: 'Task' }, value: { title: 'x', done: true } }).ok).toBe(true);
    expect(r.parse({ name: 't', type: { name: 'Task' }, value: { title: '', done: true } }).ok).toBe(false);
  });
  it('designer / researcher / dba outputs: defaults', async () => {
    for (const p of [designer, researcher, dba]) {
      const res = (await bindPrompt(p)).render(LENIENT).parse(p === researcher ? { answer: 'a' } : {});
      expect(res.ok, (p as { input: { name: string } }).input.name).toBe(true);
    }
  });
});

describe("the programmer's tool set in one request", () => {
  const TOOLS = [findOrCreateTypes, findOrCreateFunctions, findOrCreateVars, write, testTool, finish, research, ask, searchFns, searchVars, printFn, editType, webSearch, webGetPage];
  it('OpenAI strict / Anthropic strict: planned without errors; every call decodes back', async () => {
    const items = await Promise.all(TOOLS.map(async (t) => ({
      kind: 'tool' as const,
      name: (t as unknown as { input: { name: string } }).input.name,
      schema: await bindTool(t, ctx({ targetFn: { argsType } })),
    })));
    for (const p of [OPENAI_STRICT, ANTHROPIC_STRICT]) {
      const req = ModelProfile.of(p).request(items);
      expect(req.entries.length).toBe(items.length);
      const w = req.get('write');
      const res = w.parse(JSON.parse(JSON.stringify(w.encode({ program: PROGRAM }))));
      expect(res.ok ? res.value : res.message, p.id).toEqual({ program: PROGRAM });
      if (p === ANTHROPIC_STRICT) {
        expect(req.used.unions).toBeLessThanOrEqual(16);
        expect(req.used.optional).toBeLessThanOrEqual(24);
      }
    }
  });
});

describe('fns.llm output', () => {
  it('a text output is the model\'s text; any other output type its value schema (wrapped where the provider needs an object)', async () => {
    const { llmOutput } = await import('../natives/llm');
    expect(llmOutput.bind(undefined, { prompt: 'p' }).root.kind).toBe('string');
    expect(llmOutput.bind(undefined, { prompt: 'p', output: reg.text() }).root.kind).toBe('string');
    const list = llmOutput.bind(undefined, { prompt: 'p', output: reg.list(reg.lookup('Task')!) });
    const r = list.render(OPENAI_STRICT);
    expect((r.jsonSchema as { properties?: object }).properties).toHaveProperty('input');
    const res = r.parse({ input: [{ title: 'x', done: false }] });
    expect(res.ok && res.value).toEqual([{ title: 'x', done: false }]);
  });
});
