/**
 * Runtime tests for harness-authoring.ts: the code / api drafts and the program tools over the session's grammar,
 * the input form draft (recursive FieldType), and the widget proposal schema built per call with its refinement.
 */
import Handlebars from 'handlebars';
import { describe, expect, it } from 'vitest';
import { ANTHROPIC_STRICT, GOOGLE_OPENAPI, GOOGLE_STRICT, LENIENT, ModelProfile, OPENAI_STRICT, PEOPLE, XAI_STRICT, schemaHelpers, type Profile } from '../../index';
import { asTool, clone, profileProblems } from './_check';
import type { ProgramSessionLike } from './harness-grammar';
import * as W from './harness-authoring';

const tool = <T>(bound: { render(p: Profile): T }, p: Profile): T => bound.render(asTool(p));

/** A code session with nothing bound; an api session with the HTTP types bound (api authoring.ts:60 `own: HTTP_TYPES`). */
const codeSession: ProgramSessionLike = { named: [] };
const apiSession: ProgramSessionLike = {
  named: ['HttpRequest', 'HttpParam', 'HttpBody', 'HttpResponse'].map((n) => ({ name: `api/${n}`, def: { name: 'obj', props: {} } })),
};

describe('code and api drafts (systems/code, systems/api server/authoring.ts)', () => {
  const code = W.CodeDraft.bind(codeSession);
  const samples = [
    { name: 'price_with_tax', description: 'The amount with tax, and a note.', program: W.CODE_EXAMPLES.priceWithTax.program, sample: { amount: 100, rate: 8.25 } },
    { name: 'total_with_local', description: 'The same with a local.', program: W.CODE_EXAMPLES.withLocal.program, sample: { amount: 10, rate: 10 } },
    { name: 'ticket_summary', description: 'A ticket\'s status in words.', program: W.CODE_EXAMPLES.callsFn.program, sample: { ticket: 'T-1' } },
  ];

  it('render and round-trip CODE_EXAMPLES on every profile', () => {
    expect(profileProblems(code, samples)).toEqual([]);
    expect(profileProblems(W.CodeSetTool.bind(codeSession), samples.map((draft) => ({ draft })))).toEqual([]);
  });

  it('API_EXAMPLES over the api session\'s bound types (a type name the session bound is an enum member)', () => {
    const api = W.ApiDraft.bind(apiSession);
    const drafts = [
      { name: 'repo', description: 'A repo\'s name and stars.', request: W.API_EXAMPLES.repo.request, responseType: W.API_EXAMPLES.repo.responseType, output: W.API_EXAMPLES.repo.output, sample: { owner: 'octo', repo: 'hello' } },
      { name: 'open_issues', description: 'A repo\'s open issues.', request: W.API_EXAMPLES.openIssues.request, sample: { owner: 'octo', repo: 'hello' } },
    ];
    expect(profileProblems(api, drafts)).toEqual([]);
    expect(tool(api, OPENAI_STRICT).jsonSchema).toMatchObject({ $defs: { NamedType: { type: 'string', enum: ['api/HttpRequest', 'api/HttpParam', 'api/HttpBody', 'api/HttpResponse'] } } });
    // a type no one bound is refused where the model wrote it
    const res = tool(api, XAI_STRICT).parse({ ...clone(drafts[1]!), request: { kind: 'new', type: { name: 'api/Nope' } } });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.issues[0]?.path.slice(0, 2)).toEqual(['request', 'type']);
  });

  it('decodes the program as each provider writes it', () => {
    // OpenAI strict: recursion through $defs, absent optionals null, `sample` as pairs of JSON text
    const openai = {
      name: 'price_with_tax', description: 'The amount with tax.',
      program: { kind: 'get', path: [{ prop: 'args' }, { prop: 'amount' }] },
      sample: [{ key: 'amount', value: '100' }, { key: 'rate', value: '8.25' }],
    };
    const sent = clone(openai);
    const res = tool(code, OPENAI_STRICT).parse(sent);
    expect(res.ok && res.value).toEqual({ ...openai, sample: { amount: 100, rate: 8.25 } });
    expect(res.ok && res.value).toBe(sent);
    expect(res.stats).toEqual({ objects: 1, arrays: 0, edits: 1, parsed: 2, repaired: 0 });
    // Gemini: open objects; the program as written
    const gemini = { ...openai, sample: { amount: 100, rate: 8.25 } };
    const g = tool(code, GOOGLE_STRICT).parse(gemini);
    expect(g.ok && g.value).toBe(gemini);
    // a path step with no shape the grammar knows is refused where it is
    const bad = tool(code, GOOGLE_STRICT).parse({ ...gemini, program: { kind: 'get', path: [{ field: 'args' }] } });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.issues[0]?.path).toEqual(['program', 'path', 0]);
    const unnamed = tool(code, ANTHROPIC_STRICT).parse({ ...clone(openai), name: 'Price With Tax' });
    expect(unnamed.ok ? '' : unnamed.message).toBe('- at name: Must match /^[a-z][a-z0-9_]*$/.');
  });

  it('the signature, load and search tools', () => {
    const sig = W.SignatureArgs.bind(codeSession);
    expect(profileProblems(sig, [W.CODE_EXAMPLES.priceWithTax.signature, W.CODE_EXAMPLES.callsFn.signature])).toEqual([]);
    expect(profileProblems(W.LoadToolArgs, [{ fns: ['tickets/status'], types: ['tickets/Ticket'] }, {}])).toEqual([]);
    expect(profileProblems(W.SearchToolArgs, [{ text: 'the status of a ticket' }])).toEqual([]);
    expect(tool(sig, OPENAI_STRICT).jsonSchema).toMatchObject({ properties: { args: { $ref: '#/$defs/TypeDef', description: 'An obj type: {"name":"obj","props":{"amount":{"type":{"name":"num"}}}}.' } } });
  });

  it('encodes a worked example for the guide in the model\'s shape', () => {
    const entry = ModelProfile.of(ANTHROPIC_STRICT).request([{ kind: 'tool', name: 'set', schema: W.CodeSetTool.bind(codeSession) }]).get('set');
    const text = Handlebars.compile('Example: {{encode ex path="draft.program"}}', { noEscape: true })({ ex: W.CODE_EXAMPLES.callsFn.program }, { helpers: entry.helpers() });
    // Claude strict: the first level is an object, recursion (params) is JSON text
    expect(text.startsWith('Example: {"kind":"template","template":"{ticket}: {summary}","params":"{\\"kind\\":\\"new\\"')).toBe(true);
    const openai = tool(W.CodeSetTool.bind(codeSession), OPENAI_STRICT);
    // OpenAI strict: recursion stays in $defs, but `new`'s value (any JSON) is JSON text
    expect(openai.encodeAt(W.CODE_EXAMPLES.callsFn.program, 'draft.program')).toMatchObject({ kind: 'template', params: { kind: 'new', value: JSON.stringify(W.CODE_EXAMPLES.callsFn.program.params.value) } });
  });
});

describe('the input form draft (systems/input server/authoring.ts:183)', () => {
  const nested = {
    title: 'Trip', description: '',
    type: {
      name: 'obj' as const,
      props: {
        where: { docs: 'Where to?', type: { name: 'text' as const, options: { minLength: 2 } } },
        stops: { docs: 'Stops on the way', type: { name: 'list' as const, generic: { V: { name: 'obj' as const, props: { place: { type: { name: 'text' as const } }, nights: { docs: 'Nights', type: { name: 'optional' as const, generic: { T: { name: 'num' as const, options: { min: 1, whole: true } } } } } } } } } },
        kind: { docs: 'What kind of trip?', type: { name: 'enum' as const, generic: { V: { name: 'text' as const } }, options: { values: { work: 'For work', fun: 'For fun' } } } },
        when: { docs: 'When?', type: { name: 'date' as const } },
      },
    },
    submit: 'Plan it',
  };

  it('renders and round-trips on every profile (the recursion is a ref; JSON text where unsupported)', () => {
    expect(profileProblems(W.FormDraft, [W.PROJECT, nested])).toEqual([]);
    expect(profileProblems(W.FormDraftTool, [{ draft: W.PROJECT }])).toEqual([]);
    expect(tool(W.FormDraft.bind(), OPENAI_STRICT).jsonSchema).toMatchObject({ $defs: { FieldType: { anyOf: expect.any(Array) } } });
    expect(tool(W.FormDraft.bind(), GOOGLE_OPENAPI).jsonSchema['$defs']).toBeUndefined();
  });

  it('decodes a model\'s form: props as pairs on OpenAI strict, nested field types through the ref', () => {
    const answer = {
      title: 'Project details', description: 'What the project is.', submit: null,
      type: { name: 'obj', props: [{ key: 'project', value: { docs: 'Which project?', type: { name: 'text', options: null } } }, { key: 'hours', value: { docs: 'How many hours?', type: { name: 'optional', generic: { T: { name: 'num', options: { min: null, max: null, whole: true } } } } } }] },
    };
    const res = tool(W.FormDraft.bind(), OPENAI_STRICT).parse(answer);
    expect(res.ok && res.value).toEqual({ ...W.PROJECT, description: 'What the project is.' });
    expect(res.stats).toEqual({ objects: 1, arrays: 0, edits: 5, parsed: 0, repaired: 0 });
    const wrong = tool(W.FormDraft.bind(), OPENAI_STRICT).parse({ ...answer, type: { name: 'obj', props: [{ key: 'q', value: { docs: '', type: { name: 'color' } } }] } });
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) {
      expect(wrong.issues.map((i) => [i.path, i.codePath])).toContainEqual([['type', 'props', 0, 'value', 'docs'], ['type', 'props', 'q', 'docs']]);
    }
  });

  it('shows the form to people (PEOPLE) as the code shape', () => {
    expect(W.FormDraft.bind().render(PEOPLE).jsonSchema).toMatchObject({ properties: { type: { properties: { props: { type: 'object', additionalProperties: { properties: { type: { $ref: '#/$defs/FieldType' } } } } } } } });
    const t = Handlebars.compile('{{encode form pretty=false}}', { noEscape: true });
    expect(t({ form: W.PROJECT }, { helpers: schemaHelpers(W.FormDraft.bind().render(PEOPLE)) })).toBe(JSON.stringify(W.PROJECT));
  });
});

describe('the widget proposal schema (sdk/src/widget-schema.ts, widgets.test.ts:195)', () => {
  const KEY = ['text', 'boolean', 'date', 'datetime'];
  const NUM = ['integer', 'number'];
  /** widgets.test.ts:24 SOURCE_ARGS */
  const SOURCE_ARGS = {
    name: 'obj', props: {
      status: { type: { name: 'enum', options: { values: { open: 'open', done: 'done' } } } },
      owner: { type: { name: 'optional', generic: { T: { name: 'text' } } } },
      due_from: { type: { name: 'optional', generic: { T: { name: 'date' } } } },
      due_to: { type: { name: 'optional', generic: { T: { name: 'date' } } } },
      offset: { type: { name: 'optional', generic: { T: { name: 'num', options: { whole: true } } } } },
      limit: { type: { name: 'optional', generic: { T: { name: 'num', options: { whole: true } } } } },
    },
  } as const satisfies W.WidgetProposalInput['args'];
  /** widgets.test.ts:33 TABLE's facts (`resultFacts`), and the category / table visuals as core's BUILT_IN_VISUALS shape them. */
  const input: W.WidgetProposalInput = {
    source: 'tasks/open_by_owner',
    args: SOURCE_ARGS,
    facts: { whole: true, columns: [{ name: 'owner', kind: 'text', role: 'group', opaque: false }, { name: 'open', kind: 'integer', role: 'measure', opaque: false }, { name: 'id', kind: 'uuid', role: 'attribute', opaque: true }] },
    ranked: [
      { visual: 'category', styles: ['bar', 'stacked', 'percent', 'horizontal', 'line', 'area', 'radar', 'polar', 'pictorial'], bind: { x: ['owner'], y: ['open'] } },
      { visual: 'table', styles: ['table', 'compact', 'cards'], bind: { columns: ['owner', 'open'] } },
    ],
    entries: [
      {
        name: 'category', label: 'Bars',
        shape: {
          channels: [
            { name: 'x', label: 'Category', accepts: KEY, required: true, many: false, role: 'group' },
            { name: 'y', label: 'Values', accepts: NUM, required: true, many: true, role: 'measure' },
            { name: 'series', label: 'Series', accepts: ['text', 'boolean'], required: false, many: false, role: 'group' },
          ],
          styles: [{ name: 'bar' }, { name: 'stacked' }, { name: 'percent', whole: true }, { name: 'horizontal' }, { name: 'line' }, { name: 'area' }, { name: 'radar' }, { name: 'polar' }, { name: 'pictorial' }],
        },
      },
      { name: 'table', label: 'Table', shape: { channels: [{ name: 'columns', label: 'Columns', accepts: ['text', 'integer', 'number', 'boolean', 'date', 'datetime', 'time', 'uuid', 'json', 'binary'], required: false, many: true }], styles: [{ name: 'table' }, { name: 'compact' }, { name: 'cards' }] } },
    ],
    drills: ['tasks/by_owner'],
  };
  const proposal = W.WidgetProposal.bind(input);
  /** widgets.test.ts:210 `draft` */
  const draft: W.WidgetDraftInputT = {
    name: 'open_by_owner', description: 'Open tasks per owner.', title: 'Open tasks by owner',
    choice: { visual: 'category', style: 'horizontal' }, more: ['table', 'category'],
    args: { status: { show: 'pinned', value: { literal: 'open' } }, owner: { show: 'control', choices: [{ label: 'Anyone' }, { label: 'Ann', value: { literal: 'ann' } }] } },
    presets: [{ label: 'This week', sets: { owner: { literal: 'bo' } } }],
    drill: { fn: 'tasks/by_owner', label: 'Tasks', bind: { owner: 'owner' } },
  };
  /** widgets.test.ts:230 `dated`: a range arg with a plan and presets while no chosen visual draws the range. */
  const dated: W.WidgetDraftInputT = {
    ...draft, args: { ...draft.args, due_from: { show: 'control', default: { relative: 'today-7d' } } },
    presets: [{ label: 'This week', sets: { due_from: { relative: 'startOf(week)' }, due_to: { relative: 'endOf(week)' } } }],
  };

  it('renders and round-trips the real drafts on every profile; cached per call input', () => {
    expect(W.WidgetProposal.bind(input)).toBe(proposal);
    expect(profileProblems(proposal, [draft, dated])).toEqual([]);
  });

  it('keeps every enum in the tool\'s JSON Schema (widgets.test.ts:250)', () => {
    for (const p of [OPENAI_STRICT, ANTHROPIC_STRICT, XAI_STRICT]) {
      const text = JSON.stringify(tool(proposal, p).jsonSchema);
      for (const word of ['"horizontal"', '"done"', '"owner"', '"tasks/by_owner"', '"startOf(week)"']) expect(text, `${p.id} ${word}`).toContain(word);
      expect(text, p.id).not.toContain('"time"');
      expect(text, p.id).not.toContain('"now-1h"');
    }
    // strict: the arg plans are closed objects with one key per open arg (no offset/limit: the pager drives them)
    expect(tool(proposal, OPENAI_STRICT).jsonSchema).toMatchObject({ properties: { args: { type: 'object', additionalProperties: false, required: ['status', 'owner', 'due_from', 'due_to'] } } });
  });

  it('can\'t spell a broken widget: each refused where the model wrote it (widgets.test.ts:238)', () => {
    const refused = (patch: object): string[] => {
      const res = tool(proposal, LENIENT).parse({ ...clone(draft), ...patch });
      return res.ok ? [] : res.issues.map((issue) => issue.path.join('.') || issue.message);
    };
    expect(refused({ choice: { visual: 'category', style: 'river' } })).toEqual(['choice.style']);
    expect(refused({ choice: { visual: 'time', style: 'line' } })).toEqual(['choice.visual']);
    expect(refused({ choice: { visual: 'category', style: 'bar', bind: { x: ['open'] } } })).toEqual(['choice.bind.x.0']);
    expect(refused({ args: { status: { show: 'pinned', value: { literal: 'later' } } } })).toContain('args.status.value.literal');
    expect(refused({ args: { ...draft.args, status: { show: 'hidden' } } })).toEqual(['args.status.show']);
    expect(refused({ args: { ...draft.args, offset: { show: 'hidden' } } })).toEqual(['args.offset']);
    expect(refused({ args: { ...draft.args, status: { show: 'control', choices: [{ label: 'Any' }] } } })).toEqual(['args.status.choices.0.value']);
    expect(refused({ drill: { fn: 'tasks/other', label: 'x', bind: {} } })).toEqual(['drill.fn']);
    // a rule only the refinement sees: a pinned arg set by a preset
    expect(refused({ presets: [{ label: 'Done', sets: { status: { literal: 'done' } } }] })).toEqual(['Preset Done: arg status is pinned, so a preset can\'t set it.']);
    expect(refused({ drill: { fn: 'tasks/by_owner', label: 'Tasks', bind: { owner: 'assignee' } } })).toEqual(['drill.bind.owner']);
  });

  it('the style rules: a whole-only style on a page of more rows', () => {
    const paged = W.WidgetProposal.bind({ ...input, facts: { ...input.facts, whole: false } });
    const res = tool(paged, LENIENT).parse({ ...clone(draft), choice: { visual: 'category', style: 'percent' } });
    expect(res.ok ? '' : res.message).toBe('- at (root): Visual category: style percent only draws a whole result.');
  });

  it('decodes a strict model\'s proposal (OpenAI strict: nulls, the plan union by `show`)', () => {
    const wire = tool(proposal, OPENAI_STRICT).encode(draft) as Record<string, unknown>;
    expect(wire).toMatchObject({ choice: { visual: 'category', style: 'horizontal', label: null, bind: null }, drill: { fn: 'tasks/by_owner' }, args: { due_from: null, due_to: null } });
    const res = tool(proposal, OPENAI_STRICT).parse(clone(wire));
    expect(res.ok ? '' : res.message).toBe('');
    expect(res.ok && res.value).toEqual(draft);
    // Anthropic strict: the drill's bind (a record) as pairs; absent optionals left out
    const claudeWire = tool(proposal, ANTHROPIC_STRICT).encode(draft);
    expect(claudeWire).toMatchObject({ drill: { fn: 'tasks/by_owner', label: 'Tasks', bind: [{ key: 'owner', value: 'owner' }] } });
    const claude = tool(proposal, ANTHROPIC_STRICT).parse(clone(claudeWire));
    expect(claude.ok && claude.value).toEqual(draft);
    expect(claude.stats).toEqual({ objects: 1, arrays: 0, edits: 1, parsed: 0, repaired: 0 });
  });

  it('request budget on Anthropic strict: one large tool with many optional and union-typed fields', () => {
    const entry = ModelProfile.of(ANTHROPIC_STRICT).request([{ kind: 'tool', name: 'propose', schema: proposal }]).get('propose');
    expect(entry.strict).toBe(true);
    expect(entry.parse(clone(draft)).ok).toBe(true);
    expect(entry.measure.optional + entry.measure.unions).toBeGreaterThan(0);
  });
});
