/**
 * CORPUS: ginny's tools and prompts (ginny.ts) — static ones on every
 * profile, ctx-driven ones bound from a ginny-shaped ctx over gin's own
 * fixture registry, the sibling-typed `create_var.value`, the designer's
 * ctx refinement, applicability, and the programmer's whole tool set as one
 * request.
 */
import Handlebars from 'handlebars';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  a, ANTHROPIC_STRICT, GOOGLE_STRICT, LENIENT, MINIMAL, ModelProfile, OPENAI_STRICT, schemaHelpers, XAI_STRICT,
  type Profile,
} from '../../index';
import { compileTool, runToolCall } from '../../proposal/core-api';
import { clone, MODEL_PROFILES, profileProblems, validate, unexplained } from './_check';
import { asGrammarRegistry, fixtureRegistry, personProgram, switchProgram, t, TYPEDEFS } from './gin-fixtures';
import {
  ArchitectOut, AskArgs, CreateNewFnArgs, CreateVarArgs, DbaOut, DbaSearchVarsArgs, DesignerOut, EditFnArgs, EditTypeArgs, FindFnsArgs,
  FindTypesArgs, FindVarsArgs, FinishArgs, NameArgs, PrintFnArgs, PROGRAMMER_TOOLS, ResearchArgs, ResearcherOut, SearchCatalogArgs,
  SearchTypesArgs, TestArgs, WebGetPageArgs, WebSearchArgs, WriteToolArgs, editType, type Ctx, type GinnyCtx,
} from './ginny';

// ---------------------------------------------------------------------------
// A ginny ctx over gin's fixture registry
// ---------------------------------------------------------------------------

const registry = asGrammarRegistry(fixtureRegistry());
const saved = new Set(['fetchContent', 'summarize']);
function makeCtx(over: Partial<GinnyCtx> = {}): Ctx {
  return {
    registry,
    runState: { draft: null, lastTest: null },
    features: { webSearch: false },
    store: { hasFn: (n: string) => saved.has(n) },
    ...over,
  };
}
const ctx = makeCtx();
/** designer.ts:57's example signature: primeFactors(n: num{whole, min:1}): list<num>. */
const primeArgs = { name: 'obj', props: { n: { type: { name: 'num', options: { whole: true, min: 1 } }, docs: 'The number to factor.' } } } as const;
const authoringCtx = makeCtx({ targetFn: { name: 'primeFactors', sourceArgs: primeArgs }, programmerDepth: 1, runState: { draft: switchProgram, lastTest: { success: true } } });

// ---------------------------------------------------------------------------
// 1. Static tool/prompt schemas on every profile
// ---------------------------------------------------------------------------

describe('static schemas on every profile', () => {
  const cases: [string, Parameters<typeof profileProblems>[0], unknown[]][] = [
    ['ask', AskArgs, [{ question: 'Which city?' }]],
    ['find_or_create_functions', FindFnsArgs, [{ description: 'fetch a page and summarize it' }]],
    ['find_or_create_types', FindTypesArgs, [{ description: 'an Invoice with line items' }]],
    ['find_or_create_vars', FindVarsArgs, [{ description: 'the GitHub token' }]],
    ['finish', FinishArgs, [{}, { saveAs: 'primeFactors', docs: 'Prime factors of n.' }]],
    ['print_fn', PrintFnArgs, [{ name: 'primeFactors', includeComments: true }, { name: 'primeFactors', includeComments: false }]],
    ['research', ResearchArgs, [{ question: 'What is the Tavily rate limit?' }]],
    ['search_fns / search_vars', SearchCatalogArgs, [{ keywords: [], limit: 20 }, { keywords: ['fetch', 'url'], limit: 5 }]],
    ['web_get_page', WebGetPageArgs, [{ url: 'https://example.com' }]],
    ['web_search', WebSearchArgs, [{ query: 'gin language', maxResults: 5 }, { query: 'x', maxResults: 3 }]],
    ['search_types', SearchTypesArgs, [{ keywords: ['invoice'], limit: 10 }]],
    ['get_type / get_var / get_fn', NameArgs, [{ name: 'Task' }]],
    ['dba search_vars', DbaSearchVarsArgs, [{ keywords: ['token'], limit: 10 }]],
    ['dba output', DbaOut, [{ use: [], created: [] }, { use: ['githubToken'], created: [] }]],
    ['researcher output', ResearcherOut, [{ answer: '42', sources: [] }, { answer: '42', sources: ['https://a.dev'] }]],
  ];
  for (const [name, schema, samples] of cases) {
    it(name, () => expect(profileProblems(schema, samples)).toEqual([]));
  }

  it('OpenAI strict: optionals are null, descriptions carried', () => {
    const js = WebSearchArgs.render(OPENAI_STRICT).jsonSchema as any;
    expect(js).toEqual({
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        maxResults: { anyOf: [{ type: 'number' }, { type: 'null' }], description: 'Max results (default 5)\nDefault when left out: 5.\nWrite null to leave it out.' },
      },
      required: ['query', 'maxResults'],
      additionalProperties: false,
    });
    const res = WebSearchArgs.render(OPENAI_STRICT).parseText('{"query":"gin","maxResults":null}');
    expect(res.ok && res.value).toEqual({ query: 'gin', maxResults: 5 });
    expect(res.stats.edits).toBe(1);
  });

  it('Anthropic strict: optionals are left out', () => {
    const js = FinishArgs.render(ANTHROPIC_STRICT).jsonSchema as any;
    expect(js.required).toEqual([]);
    expect(FinishArgs.render(ANTHROPIC_STRICT).parseText('{}').ok).toBe(true);
  });

  // zod `.optional().default(x)`: ginny's call sees the default filled in (search-fns.ts:31 reads input.keywords.length).
  it('defaults: an absent field with a zod default decodes to the default (was GAP defaults)', () => {
    const zodShape = z.object({ keywords: z.array(z.string()).default([]), limit: z.number().optional().default(20) });
    expect(zodShape.parse({})).toEqual({ keywords: [], limit: 20 });
    const res = SearchCatalogArgs.render(OPENAI_STRICT).parseText('{"keywords":null,"limit":null}');
    expect(res.ok && res.value).toEqual({ keywords: [], limit: 20 });
  });
});

// ---------------------------------------------------------------------------
// 2. ctx-driven tools
// ---------------------------------------------------------------------------

describe('edit_type (buildSchemas(ctx.registry).Type)', () => {
  // An edit of a type the registry does NOT hold yet (an inline Extension) — see the gap below for a registered one.
  const projectDef = { name: 'Project', extends: 'obj', props: { title: { type: { name: 'text' } }, done: { type: { name: 'bool' } }, due: { type: { name: 'optional', generic: { T: { name: 'date' } } } } } };
  const NOT_MINIMAL_NOR_DIRECT_OPENAI = MODEL_PROFILES.filter((p) => p !== MINIMAL && p !== OPENAI_STRICT);

  it('every profile: a TypeDef edit (OpenAI strict through a request: render-over-depth-limit)', () => {
    const samples = [{ name: 'Project', def: projectDef }, { name: 'X', def: TYPEDEFS.iface }];
    expect(profileProblems(EditTypeArgs.bind(ctx), samples, { profiles: NOT_MINIMAL_NOR_DIRECT_OPENAI })).toEqual([]);
    const e = ModelProfile.of(OPENAI_STRICT).request([{ kind: 'tool', name: 'edit_type', schema: EditTypeArgs.bind(ctx) }]).get('edit_type');
    for (const s of samples) {
      const wire = JSON.parse(JSON.stringify(e.encode(s)));
      expect(validate(e.jsonSchema!, wire)).toEqual([]);
      expect(e.parse(wire)).toMatchObject({ ok: true, value: s });
    }
  });

  const projectWire = {
    name: 'Project',
    def: {
      name: 'Project', extends: 'obj', docs: null, satisfies: null, generic: null, options: null, get: null, call: null, init: null, constraint: null,
      props: [{ key: 'due', value: { docs: 'When it is due.', type: { name: 'optional', generic: { T: { name: 'date', options: null } } }, get: null, default: null, set: null } }],
    },
  };
  const projectValue = { name: 'Project', def: { name: 'Project', extends: 'obj', props: { due: { docs: 'When it is due.', type: { name: 'optional', generic: { T: { name: 'date' } } } } } } };

  it('OpenAI strict: the def as a model writes it (props as pairs, nulls)', () => {
    const r = EditTypeArgs.render(OPENAI_STRICT, ctx);
    const wire = clone(projectWire);
    expect(validate(r.jsonSchema, wire)).toEqual([]);
    const res = r.parse(wire);
    expect(res.ok ? res.value : res.message).toEqual(projectValue);
    expect(res.ok && res.value).toBe(wire);
    expect(res.stats.objects).toBe(1);
  });

  // edit-type.ts:55 — the def's name MUST be the edited (registered) type's name, so its tag picks gin's name-only
  // branch `{ name: 'Task' }` (schemas.ts:231, passthrough). On a strict dialect that branch is a CLOSED object, so
  // the model must write the Extension branch (props as pairs); the decoder still dispatches on the tag to the
  // name-only branch, which accepts and keeps the unknown keys — the pairs and nulls come back undecoded.
  it('(was GAP) tag-dispatch-closed-branch — a registered type\'s full def decodes through the Extension branch on strict dialects', () => {
    const r = EditTypeArgs.render(OPENAI_STRICT, ctx);
    const wire = JSON.parse(JSON.stringify(projectWire).replaceAll('Project', 'Task'));
    expect(validate(r.jsonSchema, wire)).toEqual([]);
    const res = r.parse(wire);
    expect(res.ok ? res.value : res.message).toEqual(JSON.parse(JSON.stringify(projectValue).replaceAll('Project', 'Task')));
  });

  it('errors: an `extends` the registry does not know (gin: extends is an enum of known names)', () => {
    const r = EditTypeArgs.render(OPENAI_STRICT, ctx);
    const res = r.parse({ name: 'Project', def: { ...clone(projectWire.def), extends: 'Ghost' } });
    expect(res.ok).toBe(false);
    // The Extension branch is the one whose keys fit: the error is at `extends`.
    expect(!res.ok && res.issues.map((i) => i.path)).toEqual([['def', 'extends']]);
  });

  it('the proposed Tool API: compileTool / runToolCall bind the ctx and decode through the same rendering', async () => {
    const compiled = compileTool(editType, ctx, OPENAI_STRICT);
    expect(compiled.bound).toBe(EditTypeArgs.bind(ctx)); // cached by registry version
    const out = await runToolCall(editType, ctx, OPENAI_STRICT, () => JSON.stringify(compiled.rendered.encode({ name: 'Task', def: { name: 'Task' } })));
    expect(out).toEqual({ ok: true, output: "Type 'Task' updated." });
    const bad = await runToolCall(editType, ctx, OPENAI_STRICT, () => '{"name":"Task","def":{"name":"num","options":{"min":"zero"}}}');
    expect(bad.ok).toBe(false);
  });
});

describe('write (newStrict)', () => {
  it('decodes a program in each strict dialect', () => {
    for (const p of [OPENAI_STRICT, ANTHROPIC_STRICT, GOOGLE_STRICT, XAI_STRICT]) {
      const r = WriteToolArgs.render(p, ctx);
      const wire = JSON.parse(JSON.stringify(r.encode({ program: personProgram })));
      expect(validate(r.jsonSchema, wire), p.id).toEqual([]);
      const res = r.parse(wire);
      expect(res.ok ? res.value : res.message, p.id).toEqual({ program: personProgram });
    }
  });
  it('newStrict refuses a `new` whose value does not fit its class', () => {
    const r = WriteToolArgs.render(LENIENT, ctx);
    expect(r.parse({ program: { kind: 'new', type: { name: 'num' }, value: 'three' } }).ok).toBe(false);
    expect(r.parse({ program: { kind: 'new', type: { name: 'Pair' }, value: [t('text', 'a'), t('num', 1)] } }).ok).toBe(true);
  });
});

describe('test (args typed by ctx.targetFn)', () => {
  it('while authoring a fn: args are that fn\'s parameters', () => {
    const r = TestArgs.render(OPENAI_STRICT, authoringCtx);
    const js = r.jsonSchema as any;
    const args = js.$defs?.TestScope ?? js.properties.args.anyOf[0];
    expect(JSON.stringify(args)).toContain('The number to factor.');
    const res = r.parseText('{"args":{"n":56},"expectError":null}');
    expect(res.ok && res.value).toEqual({ args: { n: 56 } });
    const bad = r.parseText('{"args":{"n":0},"expectError":null}');
    expect(!bad.ok && bad.issues.map((i) => [i.path, i.codePath])).toEqual([[['args', 'n'], ['args', 'n']]]);
    expect(!bad.ok && bad.message).toBe('- at args.n: Must be at least 1.');
  });

  it('top level: an open record of scope values (pairs of JSON text on OpenAI strict)', () => {
    const r = TestArgs.render(OPENAI_STRICT, ctx);
    const wire = { args: [{ key: 'x', value: '3' }, { key: 'names', value: '["a","b"]' }], expectError: true };
    expect(validate(r.jsonSchema, wire)).toEqual([]);
    const res = r.parse(wire);
    expect(res.ok && res.value).toEqual({ args: { x: 3, names: ['a', 'b'] }, expectError: true });
    expect(res.stats).toEqual({ objects: 1, arrays: 0, edits: 1, parsed: 2, repaired: 0 });
  });

  it('every profile, both ctx shapes', () => {
    expect(profileProblems(TestArgs.bind(authoringCtx), [{}, { args: { n: 56 } }, { args: { n: 7 }, expectError: true }])).toEqual([]);
    expect(profileProblems(TestArgs.bind(ctx), [{ args: { x: 1, list: [1, { a: null }] } }])).toEqual([]);
  });

  it('binds are cached per (registry version, target fn)', () => {
    expect(TestArgs.bind(authoringCtx)).toBe(TestArgs.bind(makeCtx({ targetFn: { name: 'primeFactors', sourceArgs: primeArgs } })));
    expect(TestArgs.bind(authoringCtx)).not.toBe(TestArgs.bind(ctx));
  });
});

describe('create_var (value typed by the type the model wrote)', () => {
  const rOpen = () => CreateVarArgs.render(OPENAI_STRICT, ctx);

  it('OpenAI strict: the value is JSON text, checked against the written type', () => {
    const r = rOpen();
    const js = r.jsonSchema as any;
    expect(js.properties.value.description).toContain('"type"');
    const wire = { name: 'retryDelays', type: { name: 'map', generic: { K: { name: 'text', options: null }, V: { name: 'num', options: { min: 0, max: null, whole: null, minPrecision: null, maxPrecision: null, prefix: null, suffix: null } } } }, value: '{"fetch":250,"llm":1000}', docs: null };
    expect(validate(r.jsonSchema, wire)).toEqual([]);
    const res = r.parse(wire);
    expect(res.ok ? res.value : res.message).toEqual({ name: 'retryDelays', type: { name: 'map', generic: { K: { name: 'text' }, V: { name: 'num', options: { min: 0 } } } }, value: { fetch: 250, llm: 1000 } });
  });

  it('a value that does not fit its type: error at value, in the code shape', () => {
    const r = rOpen();
    const res = r.parse({ name: 'limit', type: { name: 'num', options: { min: 0, max: null, whole: true, minPrecision: null, maxPrecision: null, prefix: null, suffix: null } }, value: '-1', docs: null });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.issues[0]!.path[0]).toBe('value');
    expect(res.message).toContain('Must be at least 0');
  });

  it('Anthropic strict and Gemini decode the same var', () => {
    const v = { name: 'githubToken', type: { name: 'text', options: { minLength: 1 } }, value: '', docs: 'Create a token at https://github.com/settings/tokens (scope: repo) and paste it here.' } as const;
    // A placeholder that breaks the type's own minLength (dba.ts:84 asks for "" placeholders): rejected.
    expect(CreateVarArgs.render(ANTHROPIC_STRICT, ctx).parse(JSON.parse(JSON.stringify(CreateVarArgs.render(ANTHROPIC_STRICT, ctx).encode(v as never)))).ok).toBe(false);
    const ok = { ...v, type: { name: 'text' }, value: '' };
    for (const p of [ANTHROPIC_STRICT, GOOGLE_STRICT, XAI_STRICT] as Profile[]) {
      const r = CreateVarArgs.render(p, ctx);
      const res = r.parse(JSON.parse(JSON.stringify(r.encode(ok as never))));
      expect(res.ok ? res.value : res.message, p.id).toEqual(ok);
    }
  });

  it('a typ-typed var: its value is itself a TypeDef (a ref into the grammar)', () => {
    const r = CreateVarArgs.render(LENIENT, ctx);
    expect(r.parse({ name: 'shape', type: { name: 'typ' }, value: { name: 'list', generic: { V: { name: 'Task' } } } }).ok).toBe(true);
    expect(r.parse({ name: 'shape', type: { name: 'typ' }, value: { name: 'Ghost' } }).ok).toBe(false);
  });

  it('every profile (builtin types)', () => {
    const samples = [
      { name: 'count', type: { name: 'num', options: { whole: true } }, value: 3 },
      { name: 'tags', type: { name: 'list', generic: { V: { name: 'text' } } }, value: ['a', 'b'], docs: 'Default tags.' },
      { name: 'cfg', type: { name: 'obj', props: { host: { type: { name: 'text' } }, port: { type: { name: 'optional', generic: { T: { name: 'num' } } } } } }, value: { host: 'x' } },
    ];
    expect(profileProblems(CreateVarArgs.bind(ctx), samples, { profiles: MODEL_PROFILES.filter((p) => p !== MINIMAL) })).toEqual([]);
  });

  // dba.ts:66 `registry.parse(typeDef).parse(value)` resolves a registered type; fromGin of the registry's
  // extension defs (`{ name: 'Task', extends: 'obj', ... }`) is a self-ref (see gin-values GAP gin-extension-defs).
  it('a var of a registered type checks its value against that type (was GAP gin-extension-defs)', () => {
    const r = CreateVarArgs.render(LENIENT, ctx);
    expect(r.parse({ name: 'first', type: { name: 'Task' }, value: { title: 'x', done: false } }).ok).toBe(true);
    expect(r.parse({ name: 'first', type: { name: 'Task' }, value: { title: '', done: false } }).ok).toBe(false);
  });

  it('instructions show a create_var call in the model\'s shape', () => {
    const example = { name: 'apiBase', type: { name: 'text' }, value: 'https://api.example.com' };
    const tpl = Handlebars.compile('Example: {{encode ex}}', { noEscape: true });
    const out = tpl({ ex: example }, { helpers: schemaHelpers(rOpen()) });
    expect(JSON.parse(out.slice('Example: '.length))).toEqual({ name: 'apiBase', type: { name: 'text', options: null }, value: '"https://api.example.com"', docs: null });
  });
});

describe('designer create_new_fn / edit_fn', () => {
  const sig = { name: 'primeFactors', description: 'Prime factors of n.', types: { positiveInt: { name: 'num', options: { whole: true, min: 1 } } }, args: { name: 'obj', props: { n: { type: { name: 'num' } } } }, returns: { name: 'list', generic: { V: { name: 'num' } } } };
  it('every profile', () => {
    const profiles = MODEL_PROFILES.filter((p) => p !== MINIMAL && p !== OPENAI_STRICT); // OpenAI strict direct: render-over-depth-limit
    expect(profileProblems(CreateNewFnArgs.bind(ctx), [sig, { ...sig, types: undefined } as never].map((s) => JSON.parse(JSON.stringify(s))), { profiles })).toEqual([]);
    expect(profileProblems(EditFnArgs.bind(ctx), [sig], { profiles })).toEqual([]);
  });
  it('OpenAI strict: the `types` record as pairs', () => {
    const wire = CreateNewFnArgs.render(OPENAI_STRICT, ctx).encode(sig) as any;
    expect(wire.types[0].key).toBe('positiveInt');
    expect(wire.args.props).toEqual([{ key: 'n', value: { docs: null, type: { name: 'num', options: null }, get: null, default: null, set: null } }]);
  });
});

// ---------------------------------------------------------------------------
// 3. Prompt outputs
// ---------------------------------------------------------------------------

describe('prompt outputs', () => {
  it('architect: TypeDefs to create, bound from (ctx, input)', () => {
    const b = ArchitectOut.bind(ctx, { description: 'an invoice' });
    expect(b).toBe(ArchitectOut.bind(ctx, { description: 'something else' })); // keyed by registry only
    const create = [TYPEDEFS.invoice, TYPEDEFS.listOfTasks];
    expect(profileProblems(b, [{ use: ['Task'], create }, { use: [], create: [] }], { tool: false, profiles: MODEL_PROFILES.filter((p) => p !== MINIMAL && p !== OPENAI_STRICT) })).toEqual([]);
    const r = b.render(ANTHROPIC_STRICT);
    const res = r.parse(JSON.parse(JSON.stringify(r.encode({ use: ['Task'], create }))));
    expect(res.ok && res.value).toEqual({ use: ['Task'], create });
  });

  it('designer: every name must be on disk (ctx refinement), at the entry the model wrote', () => {
    const r = DesignerOut.bind(ctx, { description: 'x' }).render(OPENAI_STRICT);
    expect(r.parseText('{"use":["fetchContent"],"created":["summarize"]}').ok).toBe(true);
    const res = r.parseText('{"use":["fetchContent"],"created":["summarize","ghostFn"]}');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.issues.map((i) => i.path)).toEqual([['created', 1]]);
    expect(res.message).toContain('Must name a function that is on disk');
    // The rule is shown to the model (strict profiles: in the description).
    expect(JSON.stringify(r.jsonSchema)).toContain('Must name a function that is on disk');
    // No key: each bind reads the store as it is now.
    saved.add('ghostFn');
    try {
      expect(DesignerOut.bind(ctx, { description: 'x' }).render(OPENAI_STRICT).parseText('{"use":null,"created":["ghostFn"]}').ok).toBe(true);
    } finally {
      saved.delete('ghostFn');
    }
  });

  it('researcher / dba outputs: Anthropic strict output (always strict)', () => {
    const req = ModelProfile.of(ANTHROPIC_STRICT).request([{ kind: 'output', schema: ResearcherOut }]);
    const out = req.get('output');
    expect(out.strict).toBe(true);
    expect(out.parseText('{"answer":"42"}').ok).toBe(true);
    expect(DbaOut.render(OPENAI_STRICT).parseText('{"use":null,"created":["githubToken"]}')).toMatchObject({ ok: true, value: { created: ['githubToken'] } });
  });
});

// ---------------------------------------------------------------------------
// 4. Applicability and the programmer's request
// ---------------------------------------------------------------------------

describe('the programmer\'s tools', () => {
  const available = (c: Ctx) => PROGRAMMER_TOOLS.filter((x) => !('applicable' in x) || !x.applicable || x.applicable(c)).map((x) => x.name);

  it('applicable(ctx) decides which tools are offered (was: schema fn returning undefined)', () => {
    expect(available(ctx)).toEqual(['find_or_create_types', 'find_or_create_functions', 'find_or_create_vars', 'write', 'search_fns', 'search_vars', 'print_fn', 'edit_type']);
    expect(available(makeCtx({ ask: async () => 'yes', features: { webSearch: true }, runState: { draft: switchProgram, lastTest: { success: true } } })))
      .toEqual(['find_or_create_types', 'find_or_create_functions', 'find_or_create_vars', 'write', 'test', 'finish', 'research', 'ask', 'search_fns', 'search_vars', 'print_fn', 'edit_type']);
    expect(available(authoringCtx)).not.toContain('find_or_create_functions'); // authoring a fn inline
  });

  const items = (c: Ctx) => PROGRAMMER_TOOLS
    .filter((x) => !('applicable' in x) || !x.applicable || x.applicable(c))
    .map((x) => ({ kind: 'tool' as const, name: x.name, schema: x.schema.bind(c) }));

  it('OpenAI strict: every applicable tool fits strict as is', () => {
    const req = ModelProfile.of(OPENAI_STRICT).request(items(authoringCtx));
    expect(unexplained(req)).toEqual([]);
    for (const e of req.entries) expect([e.name, e.strict]).toEqual([e.name, true]);
    const w = req.get('write');
    // @ts-expect-error GAP request-computed-items: with a computed (filtered) item list, `get(name)` is typed RequestEntry<never>, so encode takes `never`.
    expect(w.parse(JSON.parse(JSON.stringify(w.encode({ program: switchProgram })))).ok).toBe(true);
    const tst = req.get('test');
    expect(tst.parseText('{"args":{"n":12},"expectError":null}')).toMatchObject({ ok: true, value: { args: { n: 12 } } });
  });

  it('Anthropic strict: the request budget (24 optionals, 16 unions) is spent in priority order', () => {
    const req = ModelProfile.of(ANTHROPIC_STRICT).request(items(authoringCtx));
    expect(unexplained(req)).toEqual([]);
    expect(req.strictTools).toBeLessThanOrEqual(20);
    expect(req.used.optional).toBeLessThanOrEqual(24);
    expect(req.used.unions).toBeLessThanOrEqual(16);
    const adjusted = req.entries.filter((e) => e.adjustments.length);
    expect(adjusted.map((e) => e.name)).toEqual(expect.arrayContaining(['write', 'edit_type']));
    for (const e of adjusted) expect(e.reasons.length).toBeGreaterThan(0);
    // Every entry still round-trips a real call through its own rendering.
    const calls: Record<string, unknown> = {
      find_or_create_types: { description: 'Invoice' }, find_or_create_vars: { description: 'token' }, write: { program: switchProgram },
      test: { args: { n: 12 } }, finish: { saveAs: 'primeFactors' }, search_fns: { keywords: ['prime'], limit: 20 }, search_vars: { keywords: [], limit: 20 },
      print_fn: { name: 'primeFactors', includeComments: true }, edit_type: { name: 'Task', def: TYPEDEFS.invoice },
    };
    for (const e of req.entries) {
      const v = calls[e.name];
      if (v === undefined) continue;
      const res = e.parse(JSON.parse(JSON.stringify(e.encode(v))));
      expect(res.ok ? res.value : res.message, e.name).toEqual(v);
    }
  });

  it('Handlebars: a tool\'s instructions show its call in the model\'s shape', () => {
    const req = ModelProfile.of(OPENAI_STRICT).request(items(authoringCtx));
    const tpl = Handlebars.compile('e.g. {{encode ex}}', { noEscape: true });
    expect(tpl({ ex: { saveAs: 'primeFactors' } }, { helpers: req.get('finish').helpers() })).toBe('e.g. {"saveAs":"primeFactors","docs":null}');
    expect(tpl({ ex: { saveAs: 'primeFactors' } }, { helpers: ModelProfile.of(ANTHROPIC_STRICT).request([{ kind: 'tool', name: 'finish', schema: FinishArgs }]).get('finish').helpers() })).toBe('e.g. {"saveAs":"primeFactors"}');
  });

  it('examples render in each model\'s shape', () => {
    const Ex = FinishArgs.example({ saveAs: 'primeFactors' });
    expect((Ex.render(OPENAI_STRICT).jsonSchema as any).description).toBe('Example: {"saveAs":"primeFactors","docs":null}');
    expect((Ex.render(ANTHROPIC_STRICT).jsonSchema as any).description).toBe('Example: {"saveAs":"primeFactors"}');
    expect((Ex.render(LENIENT).jsonSchema as any).examples).toEqual([{ saveAs: 'primeFactors' }]);
  });
});

void clone;
void a;
