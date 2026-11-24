/**
 * Runtime proofs for the schemas inside cletus operations (cletus-ops.ts):
 * the type_extractor's state-dependent tools, the record extractor built
 * from a user type, the type selector and the unique-fields output.
 */
import Handlebars from 'handlebars';
import { describe, expect, it } from 'vitest';
import { a, ANTHROPIC_STRICT, GOOGLE_STRICT, LENIENT, ModelProfile, OPENAI_STRICT, XAI_STRICT, profileFor, type Rendered } from '../../index';
import { asTool, dialectProblems, profileProblems, unexplained } from './_check';
import * as O from './cletus-ops';
import type { TypeDefinition } from './cletus-tools';
import { lines } from '../_lines';

const state = (existing: string[], discovered: string[], version: number, max?: number): O.ImportCtx => ({
  importState: {
    existing, version, ...(max !== undefined ? { max } : {}),
    discovered: new Map(discovered.map((n) => [n, { name: n, friendlyName: n, fields: [], instanceCount: 1 }])),
  },
});
const s1 = state(['project'], ['invoice', 'vendor'], 1);

const task: TypeDefinition = {
  name: 'task', friendlyName: 'Task', knowledgeTemplate: '',
  fields: [
    { name: 'name', friendlyName: 'Name', type: 'string', required: true },
    { name: 'status', friendlyName: 'Status', type: 'enum', enumOptions: ['todo', 'doing', 'done'], required: true, default: 'todo' },
    { name: 'points', friendlyName: 'Points', type: 'number' },
    { name: 'due', friendlyName: 'Due', type: 'date' },
    { name: 'urgent', friendlyName: 'Urgent', type: 'boolean' },
    { name: 'projectid', friendlyName: 'Project', type: 'project' },
  ],
};

describe('type_extractor tools (architect.tsx): every profile', () => {
  const field = { name: 'amount', friendlyName: 'Amount', type: 'number', required: true };
  const cases: [string, { bind(c: O.ImportCtx): Parameters<typeof profileProblems>[0] }, unknown[]][] = [
    ['add_discovered', O.AddDiscoveredArgs, [
      { name: 'invoice', friendlyName: 'Invoice', fields: [field, { name: 'vendorid', friendlyName: 'Vendor', type: 'vendor', onDelete: 'cascade' }], instanceCount: 12 },
      { name: 'receipt', friendlyName: 'Receipt', description: 'A receipt', fields: [] },
    ]],
    ['rename_discovered', O.RenameDiscoveredArgs, [{ oldName: 'invoice', newName: 'bill' }]],
    ['update_fields', O.UpdateFieldsArgs, [{ typeName: 'project', fields: [field, { name: 'old', remove: true }] }]],
    ['update_discovered', O.UpdateDiscoveredArgs, [{ name: 'vendor', friendlyName: 'Supplier' }, { name: 'vendor' }]],
    ['add_instances', O.AddInstancesArgs, [{ typeName: 'invoice', count: 3 }]],
    ['remove_discovered', O.RemoveDiscoveredArgs, [{ name: 'vendor', reason: 'too infrequent' }, { name: 'invoice' }]],
  ];
  for (const [name, target, samples] of cases) it(name, () => expect(profileProblems(target.bind(s1), samples)).toEqual([]));
});

describe('type_extractor tools: the enums follow the import state', () => {
  it('discovered names, all names and field types come from the state; a new version rebinds', () => {
    const js = O.UpdateFieldsArgs.bind(s1).render(asTool(OPENAI_STRICT)).jsonSchema as any;
    expect(js.$defs.AnyType.enum).toEqual(['project', 'invoice', 'vendor']);
    expect(js.$defs.FieldType.enum).toEqual(['string', 'number', 'boolean', 'date', 'enum', 'project', 'invoice', 'vendor']);
    expect(O.RenameDiscoveredArgs.bind(s1)).toBe(O.RenameDiscoveredArgs.bind(state([], [], 1)));
    const s2 = state(['project'], ['invoice', 'vendor', 'receipt'], 2);
    expect((O.RenameDiscoveredArgs.bind(s2).render(asTool(OPENAI_STRICT)).jsonSchema as any).$defs.Discovered.enum).toEqual(['invoice', 'vendor', 'receipt']);
  });

  it('no discovered types: the tools needing one are not applicable (was z.never()); max reached: add_discovered is not', () => {
    expect(O.renameDiscovered.applicable!(state(['project'], [], 3))).toBe(false);
    expect(O.removeDiscovered.applicable!(state(['project'], [], 3))).toBe(false);
    expect(O.updateFields.applicable!(state(['project'], [], 3))).toBe(true);
    expect(O.addDiscovered.applicable!(state([], ['a', 'b'], 4, 2))).toBe(false);
    expect(O.addDiscovered.applicable!(state([], ['a'], 4, 2))).toBe(true);
  });

  it('update_fields: a field or a removal; decoded on OpenAI strict, nulls → absent', () => {
    const r = O.UpdateFieldsArgs.bind(s1).render(asTool(OPENAI_STRICT));
    const res = r.parse({
      typeName: 'invoice',
      fields: [
        { name: 'amount', friendlyName: 'Amount', type: 'number', required: true, enumOptions: null, onDelete: null },
        { name: 'old', remove: true },
      ],
    });
    expect(res.ok && res.value).toEqual({ typeName: 'invoice', fields: [{ name: 'amount', friendlyName: 'Amount', type: 'number', required: true }, { name: 'old', remove: true }] });
    expect(res.stats).toEqual({ objects: 0, arrays: 0, edits: 2, parsed: 0, repaired: 0 });
    expect(O.updateFields.call(res.ok ? res.value : { typeName: '', fields: [] }, s1)).toBe(1);
  });

  it('errors: an undiscovered name, a field type that is not a type, remove: false', () => {
    const r = O.UpdateFieldsArgs.bind(s1).render(asTool(ANTHROPIC_STRICT));
    const res = r.parse({ typeName: 'receipt', fields: [{ name: 'x', friendlyName: 'X', type: 'money' }, { name: 'y', remove: false }] });
    expect(!res.ok && res.issues.map((i) => i.path)).toEqual([['typeName'], ['fields', 0, 'type'], ['fields', 1, 'remove']]); // inside the chosen union option
    expect(lines(res).split('\n')[0]).toBe('- at typeName: Expected one of: project, invoice, vendor.');
  });

  it('a request with all six tools fits Anthropic strict', () => {
    const req = ModelProfile.of(ANTHROPIC_STRICT).request([
      { kind: 'tool', name: 'add_discovered', schema: O.AddDiscoveredArgs.bind(s1) },
      { kind: 'tool', name: 'rename_discovered', schema: O.RenameDiscoveredArgs.bind(s1) },
      { kind: 'tool', name: 'update_fields', schema: O.UpdateFieldsArgs.bind(s1) },
      { kind: 'tool', name: 'update_discovered', schema: O.UpdateDiscoveredArgs.bind(s1) },
      { kind: 'tool', name: 'add_instances', schema: O.AddInstancesArgs.bind(s1) },
      { kind: 'tool', name: 'remove_discovered', schema: O.RemoveDiscoveredArgs.bind(s1) },
    ]);
    expect(req.strictTools).toBe(6);
    expect(unexplained(req)).toEqual([]);
    expect(req.entries.every((e) => e.strict && e.adjustments.length === 0)).toBe(true);
    expect(req.used.optional).toBe(11);
  });
});

describe('extractor (dba.tsx:141): an output built from the user type', () => {
  const input = { typeDef: task, text: 'Ship it by Friday (5 points, urgent).' };
  const records = [
    { name: 'Ship it', status: 'todo', points: 5, due: '2026-11-27', urgent: true, projectid: null },
    { name: 'Write docs', status: 'done', points: null, due: null, urgent: null, projectid: 'p-1' },
  ];

  it('renders on every profile and round-trips extracted records', () => {
    expect(profileProblems(O.ExtractorOutput.bind({}, input), [{ results: records }, { results: [] }], { tool: false })).toEqual([]);
  });

  it('required fields are plain, the others nullable; dates are format date; the enum is the type\'s options', () => {
    const r0 = O.ExtractorOutput.bind({}, input).render(OPENAI_STRICT);
    const js = r0.jsonSchema as any;
    const f = js.$defs.Fields;
    expect(f.required).toEqual(['name', 'status', 'points', 'due', 'urgent', 'projectid']);
    expect(f.properties.name).toEqual({ type: 'string' });
    // status has `default: 'todo'` (helpers/type.ts:58): optional on the wire, so null-for-absent on OpenAI strict.
    expect(f.properties.status).toEqual({
      anyOf: [{ type: 'string', enum: ['todo', 'doing', 'done'] }, { type: 'null' }],
      description: 'Default when left out: "todo".\nWrite null to leave it out.',
    });
    // A null status (the model leaving it out) decodes to the default.
    const filled = r0.parse({ results: [{ ...records[0], status: null }] });
    expect(filled.ok && filled.value.results[0]).toMatchObject({ status: 'todo' });
    expect(f.properties.due).toEqual({ anyOf: [{ type: 'string', format: 'date' }, { type: 'null' }] });
    // Gemini strict keeps date formats; Anthropic strict lists format date too.
    expect((O.ExtractorOutput.bind({}, input).render(GOOGLE_STRICT).jsonSchema as any).$defs.Fields.properties.due).toEqual({ type: ['string', 'null'], format: 'date' });
  });

  it('decoding: nulls are kept (nullable, not optional), nothing is copied; a wrong enum is reported at the record', () => {
    const r = O.ExtractorOutput.bind({}, input).render(OPENAI_STRICT);
    const wire = { results: structuredClone(records) };
    const res = r.parse(wire);
    expect(res.ok && res.value).toBe(wire);
    expect(res.stats).toEqual({ objects: 0, arrays: 0, edits: 0, parsed: 0, repaired: 0 });
    const bad = r.parse({ results: [records[0], { ...records[1], status: 'blocked' }] });
    expect(!bad.ok && bad.issues).toEqual([{ path: ['results', 1, 'status'], codePath: ['results', 1, 'status'], message: 'Expected one of: todo, doing, done.' }]);
  });

  it('a records array sent as JSON text is repaired; the bind is cached per typeDef', () => {
    const r = O.ExtractorOutput.bind({}, input).render(XAI_STRICT);
    const res = r.parse({ results: JSON.stringify(records) });
    expect(res.ok && res.value.results).toEqual(records);
    expect(res.stats.repaired).toBe(1);
    expect(O.ExtractorOutput.bind({}, { typeDef: task, text: 'other' })).toBe(O.ExtractorOutput.bind({}, input));
  });

  it('{{encode}} shows an extracted record in the prompt', () => {
    const t = Handlebars.compile('Like: {{encode r path="results.*"}}', { noEscape: true });
    const req = ModelProfile.of(OPENAI_STRICT).request([{ kind: 'output', schema: O.ExtractorOutput.bind({}, input) }]);
    expect(t({ r: records[0] }, { helpers: req.helpers() })).toBe('Like: {"name":"Ship it","status":"todo","points":5,"due":"2026-11-27","urgent":true,"projectid":null}');
  });
});

describe('query_type_selector (dba.tsx:682) and unique fields (dba.tsx:1123)', () => {
  it('type selector: an array of the type names', () => {
    const b = O.TypeSelectorOutput.bind({}, { types: [task] });
    expect(profileProblems(b, [{ types: ['task'] }, { types: [] }], { tool: false })).toEqual([]);
    const res = b.render(ANTHROPIC_STRICT).parse({ types: ['task', 'user'] });
    expect(lines(res)).toBe('- at types[1]: Expected one of: task.');
  });

  it('unique fields: strict structured output on OpenAI; on Claude without structured output it is prompt text', () => {
    expect(profileProblems(O.UniqueFieldsOutput, [{ fields: ['email'] }, { fields: [] }], { tool: false })).toEqual([]);
    const gpt = profileFor({ id: 'gpt-5.4', provider: 'openai', capabilities: ['toolsStrict', 'structured', 'json'] }).request([{ kind: 'output', schema: O.UniqueFieldsOutput }]).get('output');
    expect([gpt.strict, gpt.delivery]).toEqual([true, 'structured']);
    expect(gpt.jsonSchema).toEqual({ type: 'object', properties: { fields: { type: 'array', items: { type: 'string' } } }, required: ['fields'], additionalProperties: false });
    const claude = profileFor({ id: 'claude-old', provider: 'anthropic', capabilities: ['json'] }).request([{ kind: 'output', schema: O.UniqueFieldsOutput }]).get('output');
    expect(claude.delivery).toBe('prompt');
    expect(claude.promptText).toContain('fields: string[]');
    expect(claude.parseText('{"fields":["email"]}').ok).toBe(true);
  });
});

describe('gaps', () => {
  // helpers/type.ts:58 `schema.default(field.default)`: zod fills `status: 'todo'` when the model leaves it out.
  it('(was GAP) default — a type field\'s default fills an omitted value', () => {
    const withDefault = O.buildFieldsSchema({
      name: 'task', friendlyName: 'Task', knowledgeTemplate: '',
      fields: [{ name: 'status', friendlyName: 'Status', type: 'enum', enumOptions: ['todo', 'doing', 'done'], required: true, default: 'todo' }],
    });
    const res = (withDefault as unknown as { render(p: typeof LENIENT): Rendered<O.Fields> }).render(LENIENT).parse({});
    expect(res.ok && res.value).toEqual({ status: 'todo' });
  });

  // architect.tsx:586 `z.never()` when nothing is discovered yet: now `a.never()`, and a runtime
  // `a.enum(list)` of an empty list is never too (was the type-level gap "never").
  it('never: a.never() and an empty runtime enum render as a valid nothing-schema and reject every value', () => {
    const Never = a.object({ oldName: a.never() });
    const discovered: string[] = [];
    const Empty = a.object({ oldName: a.enum(discovered) });
    for (const S of [Never, Empty]) {
      const r = S.render(asTool(OPENAI_STRICT));
      expect(dialectProblems(r.jsonSchema, asTool(OPENAI_STRICT))).toEqual([]);
      expect(r.parse({ oldName: 'x' }).ok).toBe(false);
    }
  });
});
