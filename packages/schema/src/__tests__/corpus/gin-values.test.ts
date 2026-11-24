/**
 * CORPUS: gin value schemas (see gin-values.ts for sources). Each kind is
 * checked DIFFERENTIALLY against the real gin (`@aeye/gin`'s
 * `registry.parse(def).toValueSchema()`), then the converted schemas go
 * through every profile, model-shaped answers, errors, encoding, examples
 * and request budgets.
 */
import Handlebars from 'handlebars';
import { describe, expect, it } from 'vitest';
import { createRegistry } from '@aeye/gin';
import {
  a, ANTHROPIC_STRICT, fromGin, ginNamedTypes, GOOGLE_OPENAPI, GOOGLE_STRICT, LENIENT, MINIMAL, ModelProfile, OPENAI_STRICT,
  schemaHelpers, XAI_STRICT, type AnySchema, type GinRegistryLike, type GinTypeDef, type Rendered,
} from '../../index';
import { clone, MODEL_PROFILES, profileProblems, validate, unexplained } from './_check';
import {
  And, Any, Bool, DateT, Enum, FetchArgs, Literal, MapNum, MapText, Not, Null, Num, Or, PrimeFactorsArgs, PrimeFactorsDef,
  Task, TaskDef, Text, Timestamp, Void, type TaskT,
} from './gin-values';

const lenient = (s: AnySchema): Rendered<unknown> => (s as unknown as { render(p: typeof LENIENT): Rendered<unknown> }).render(LENIENT);

// ---------------------------------------------------------------------------
// 1. Differential: what gin's toValueSchema accepts, fromGin accepts
// ---------------------------------------------------------------------------

interface Case {
  readonly label: string;
  readonly def: GinTypeDef;
  readonly ok: readonly unknown[];
  readonly bad: readonly unknown[];
}

const CASES: readonly Case[] = [
  { label: 'text{min,max,pattern}', def: { name: 'text', options: { minLength: 1, maxLength: 40, pattern: '^[a-z][a-z0-9-]*$' } }, ok: ['a', 'abc-1'], bad: ['', 'Abc', 1, null] },
  { label: 'num{whole,min,max}', def: { name: 'num', options: { whole: true, min: 0, max: 100 } }, ok: [0, 100, 42], bad: [-1, 101, 1.5, '1'] },
  { label: 'num (fractions)', def: { name: 'num' }, ok: [1.5, -3], bad: ['x', null] },
  { label: 'bool', def: { name: 'bool' }, ok: [true, false], bad: ['true', 0] },
  { label: 'null', def: { name: 'null' }, ok: [null], bad: [0, ''] },
  { label: 'void', def: { name: 'void' }, ok: [null], bad: [0, {}] },
  { label: 'any', def: { name: 'any' }, ok: [1, 'x', null, { a: [1] }], bad: [] },
  { label: 'date', def: { name: 'date' }, ok: ['2024-01-15'], bad: ['Jan 15', 20240115] },
  { label: 'timestamp (T, seconds, zone)', def: { name: 'timestamp' }, ok: ['2024-01-15T10:30:00Z', '2024-01-15T10:30:00.123+02:00'], bad: ['2024-01-15', 'now'] },
  { label: 'timestamp (space, no seconds)', def: { name: 'timestamp' }, ok: ['2024-01-15 10:30', '2024-01-15T10:30'], bad: ['2024-01-15 10'] },
  { label: 'enum (numeric values; the TYPE is a gap, see gin-values.ts)', def: { name: 'enum', options: { values: { ONE: 1, TWO: 2 } } }, ok: [1, 2], bad: [3, '1'] },
  { label: 'enum (string values)', def: { name: 'enum', options: { values: { LOW: 'low', HIGH: 'high' } } }, ok: ['low', 'high'], bad: ['LOW', 'mid'] },
  { label: 'literal', def: { name: 'literal', options: { value: 'task' } }, ok: ['task'], bad: ['Task', null] },
  { label: 'list<text>{min,max}', def: { name: 'list', generic: { V: { name: 'text' } }, options: { minLength: 1, maxLength: 2 } }, ok: [['a'], ['a', 'b']], bad: [[], ['a', 'b', 'c'], [1], 'a'] },
  { label: 'optional<num>', def: { name: 'optional', generic: { T: { name: 'num' } } }, ok: [1], bad: ['1', null] },
  { label: 'nullable<text>', def: { name: 'nullable', generic: { T: { name: 'text' } } }, ok: ['a', null], bad: [1] },
  { label: 'or<text, num, null>', def: { name: 'or', options: { types: [{ name: 'text' }, { name: 'num' }, { name: 'null' }] } }, ok: ['a', 1, null], bad: [true, {}] },
  {
    label: 'and<obj{id}, obj{label}>',
    def: { name: 'and', options: { types: [{ name: 'obj', props: { id: { type: { name: 'num' } } } }, { name: 'obj', props: { label: { type: { name: 'text' } } } }] } },
    ok: [{ id: 1, label: 'x' }], bad: [{ id: 1 }, { label: 'x' }, { id: 'x', label: 'x' }],
  },
  { label: 'not<null>', def: { name: 'not', options: { excluded: { name: 'null' } } }, ok: [1, 'x', {}], bad: [null] },
  {
    label: 'obj (optional prop is an optional key; unknown keys pass)',
    def: { name: 'obj', props: { a: { type: { name: 'num' } }, b: { type: { name: 'optional', generic: { T: { name: 'text' } } } } } },
    ok: [{ a: 1 }, { a: 1, b: 'x' }, { a: 1, extra: true }], bad: [{ b: 'x' }, { a: 1, b: 2 }, []],
  },
  {
    label: 'map<num, text> (pairs in gin)',
    def: { name: 'map', generic: { K: { name: 'num' }, V: { name: 'text' } } },
    ok: [[{ key: 1, value: 'a' }], []], bad: [{ 1: 'a' }, [{ key: 'x', value: 'a' }]],
  },
];

/** Kinds that were gaps in fromGin, fixed in pass 2. */
const GAP_CASES: readonly (Case & { gap: string })[] = [
  { gap: 'gin-duration-ms', label: 'duration is a number of ms', def: { name: 'duration' }, ok: [1500, 0], bad: ['PT1S'] },
  { gap: 'gin-color-int', label: 'color is a 32-bit integer', def: { name: 'color' }, ok: [0xff0000ff, 0], bad: ['#ff0000', -1, 0x100000000] },
  { gap: 'gin-tuple', label: 'tuple reads options.elements', def: { name: 'tuple', options: { elements: [{ name: 'text' }, { name: 'num' }] } }, ok: [['a', 1]], bad: [['a'], [1, 'a']] },
  {
    gap: 'gin-interface-name', label: "iface is named 'interface' and passes extra keys",
    def: { name: 'interface', props: { id: { type: { name: 'num' } } } }, ok: [{ id: 1 }, { id: 1, more: 'x' }], bad: [{}, { id: 'x' }],
  },
  { gap: 'gin-date-prefix', label: 'date is a PREFIX match (a datetime passes)', def: { name: 'date' }, ok: ['2024-01-15', '2024-01-15T10:00:00Z'], bad: ['15/01/2024'] },
  { gap: 'gin-text-flags', label: 'text pattern flags (i)', def: { name: 'text', options: { pattern: '^user-', flags: 'i' } }, ok: ['user-1', 'USER-1'], bad: ['admin'] },
];

describe('gin kinds: fromGin accepts exactly what gin toValueSchema accepts', () => {
  const r = createRegistry();
  const ginOk = (def: GinTypeDef, v: unknown) => r.parse(def as never).toValueSchema().safeParse(v).success;
  const aOk = (def: GinTypeDef, v: unknown) => lenient(fromGin(def)).parse(clone(v)).ok;

  for (const c of CASES) {
    it(c.label, () => {
      for (const v of c.ok) expect([ginOk(c.def, v), aOk(c.def, v)], `accepts ${JSON.stringify(v)}`).toEqual([true, true]);
      for (const v of c.bad) expect([ginOk(c.def, v), aOk(c.def, v)], `rejects ${JSON.stringify(v)}`).toEqual([false, false]);
    });
  }
  for (const c of GAP_CASES) {
    it(`${c.label} (was GAP ${c.gap})`, () => {
      for (const v of c.ok) expect([ginOk(c.def, v), aOk(c.def, v)], `accepts ${JSON.stringify(v)}`).toEqual([true, true]);
      for (const v of c.bad) expect([ginOk(c.def, v), aOk(c.def, v)], `rejects ${JSON.stringify(v)}`).toEqual([false, false]);
    });
  }

  it('the same defs as gin-values.ts (typed) agree too', () => {
    const typed: [AnySchema, GinTypeDef, unknown][] = [
      [Text, { name: 'text', options: { minLength: 1, maxLength: 40, pattern: '^[a-z][a-z0-9-]*$' } }, 'ok-1'],
      [Num, { name: 'num', options: { whole: true, min: 0, max: 100 } }, 7],
      [Bool, { name: 'bool' }, true], [Null, { name: 'null' }, null], [Void, { name: 'void' }, null], [Any, { name: 'any' }, [1]],
      [DateT, { name: 'date' }, '2024-02-29'], [Timestamp, { name: 'timestamp' }, '2024-02-29T00:00:00Z'],
      [Enum, { name: 'enum', options: { values: { LOW: 'low', MID: 'mid', HIGH: 'high' } } }, 'mid'], [Literal, { name: 'literal', options: { value: 'task' } }, 'task'],
      [Or, { name: 'or', options: { types: [{ name: 'text' }, { name: 'num' }, { name: 'null' }] } }, null],
      [MapNum, { name: 'map', generic: { K: { name: 'num' }, V: { name: 'text' } } }, [{ key: 1, value: 'x' }]],
    ];
    for (const [s, def, v] of typed) expect([lenient(s).parse(clone(v)).ok, ginOk(def, v)]).toEqual([true, true]);
    // map<text, V>: gin's value is pairs, the code shape here is a record (deliberate; the profile writes pairs).
    expect(ginOk({ name: 'map', generic: { K: { name: 'text' }, V: { name: 'num' } } }, [{ key: 'a', value: 1 }])).toBe(true);
    expect(lenient(MapText).parse({ a: 1 }).ok).toBe(true);
    expect(MapText.render(OPENAI_STRICT).encode({ a: 1 })).toEqual({ input: [{ key: 'a', value: 1 }] }); // non-object root: wrapped
    expect(lenient(And).parse({ id: 1, label: 'x' }).ok).toBe(true);
    expect(lenient(Not).parse(null).ok).toBe(false);
  });

  it('a Task-shaped obj: gin and fromGin agree on good and bad values', () => {
    const ginTask = r.parse(TaskDef as never).toValueSchema();
    // gin's map<text, num> wire is pairs; feed each side its own code shape.
    const good = sample();
    const asGin = { ...good, weights: Object.entries(good.weights).map(([key, value]) => ({ key, value })) };
    expect(ginTask.safeParse(asGin).success).toBe(true);
    expect(lenient(Task).parse(clone(good)).ok).toBe(true);
    for (const bad of [{ ...good, title: '' }, { ...good, points: -1 }, { ...good, level: 'mid' }, { ...good, kind: 'note' }, { ...good, tags: ['a', 'b', 'c', 'd', 'e', 'f'] }]) {
      expect(ginTask.safeParse({ ...bad, weights: [] }).success).toBe(false);
      expect(lenient(Task).parse(clone(bad)).ok).toBe(false);
    }
  });

  it('fn args / returns: a method signature converts to a tool-args schema', () => {
    const fnType = r.parse(PrimeFactorsDef as never) as unknown as { _call: { args: { toValueSchema(): { safeParse(v: unknown): { success: boolean } } } } };
    for (const v of [{ n: 56 }, { n: 0 }, { n: 1.5 }, {}]) {
      expect(lenient(PrimeFactorsArgs).parse(clone(v)).ok).toBe(fnType._call.args.toValueSchema().safeParse(v).success);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Every profile
// ---------------------------------------------------------------------------

function sample(): TaskT {
  return {
    title: 'Ship it', points: 3, done: false, tags: ['infra'], weights: { ann: 0.5, bo: 1 }, byDay: [{ key: 1, value: 'mon' }],
    note: 'soon', due: '2024-03-01', level: 'high', kind: 'task', owner: 'ann', extra: { any: ['json'] },
  };
}
const minimalTask: TaskT = { title: 'x', points: 0, done: true, tags: [], weights: {}, byDay: [], due: null, level: 'low', kind: 'task', owner: 7 };

describe('gin values on every profile', () => {
  it('Task (every value kind at once)', () => {
    expect(profileProblems(Task, [sample(), minimalTask])).toEqual([]);
  });
  it('fn args (prime factors, fetch)', () => {
    expect(profileProblems(PrimeFactorsArgs, [{ n: 56 }])).toEqual([]);
    expect(profileProblems(FetchArgs, [{ url: 'https://x.dev' }, { url: 'https://x.dev', method: 'POST', headers: { a: 'b' }, body: [1, { c: null }] }])).toEqual([]);
  });
  it('combinators (and, or) and not', () => {
    expect(profileProblems(And, [{ id: 1, label: 'x' }])).toEqual([]);
    expect(profileProblems(Or, ['a', 1], { tool: false })).toEqual([]);
    expect(profileProblems(Or, [null], { tool: false, profiles: MODEL_PROFILES.filter((p) => p !== MINIMAL) })).toEqual([]);
    expect(profileProblems(Not, [1, 'x', { a: 1 }], { tool: false })).toEqual([]);
  });

  // gin or<text, num, null>: on a dialect with no combinators the union is a tagged object; the null member
  // encodes as `null` in its slot, which reads back as "nothing filled".
  it.fails('GAP: tagged-union-null-member — or<..., null> round-trips null on MINIMAL', () => {
    expect(profileProblems(Or, [null], { tool: false, profiles: [MINIMAL] })).toEqual([]);
  });

  it('OpenAI strict: map<text,num> as pairs, optionals as null, every key required, docs as descriptions', () => {
    const js = Task.render(OPENAI_STRICT).jsonSchema as any;
    expect(js.description).toBe('A work item.');
    expect(js.required).toEqual(Object.keys(TaskDef.props));
    expect(js.additionalProperties).toBe(false);
    expect(js.properties.title).toEqual({ type: 'string', minLength: 1, description: 'Short summary.' });
    expect(js.properties.points).toEqual({ type: 'integer', minimum: 0 });
    expect(js.properties.weights.type).toBe('array');
    expect(js.properties.weights.items.properties.key).toEqual({ type: 'string' });
    expect(js.properties.note).toEqual({ anyOf: [{ type: 'string' }, { type: 'null' }], description: 'Write null to leave it out.' });
    expect(js.properties.level).toEqual({ type: 'string', enum: ['low', 'high'] });
    expect(js.properties.kind).toEqual({ type: 'string', enum: ['task'] });
    expect(js.properties.extra.anyOf[0]).toMatchObject({ type: 'string' }); // any → JSON text
  });

  it('Anthropic strict: optionals omitted, any as JSON text, no length bounds', () => {
    const js = Task.render(ANTHROPIC_STRICT).jsonSchema as any;
    expect(js.required).not.toContain('note');
    expect(js.required).not.toContain('extra');
    expect(js.properties.extra.type).toBe('string');
    expect(js.properties.title.minLength).toBeUndefined();
    expect(js.properties.weights.type).toBe('array');
  });

  it('Gemini and xAI strict: open records', () => {
    expect((Task.render(GOOGLE_STRICT).jsonSchema as any).properties.weights).toMatchObject({ type: 'object', additionalProperties: { type: 'number' } });
    expect((Task.render(XAI_STRICT).jsonSchema as any).properties.weights).toMatchObject({ type: 'object', additionalProperties: { type: 'number' } });
    expect((Task.render(GOOGLE_OPENAPI).jsonSchema as any).properties.weights.type).toBe('array');
  });
});

// ---------------------------------------------------------------------------
// 3. Model-shaped answers
// ---------------------------------------------------------------------------

describe('decoding what models send', () => {
  it('OpenAI strict: pairs → record, null → absent, in place', () => {
    const r = Task.render(OPENAI_STRICT);
    const wire = {
      title: 'Ship it', points: 3, done: false, tags: ['infra'], weights: [{ key: 'ann', value: 0.5 }, { key: 'bo', value: 1 }],
      byDay: [{ key: 1, value: 'mon' }], note: null, due: null, level: 'high', kind: 'task', owner: 'ann', extra: '{"any":["json"]}',
    };
    expect(validate(r.jsonSchema, wire)).toEqual([]);
    const res = r.parse(wire);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value).toBe(wire); // same top reference
    expect(res.value).toEqual({ title: 'Ship it', points: 3, done: false, tags: ['infra'], weights: { ann: 0.5, bo: 1 }, byDay: [{ key: 1, value: 'mon' }], due: null, level: 'high', kind: 'task', owner: 'ann', extra: { any: ['json'] } });
    expect(res.stats).toEqual({ objects: 1, arrays: 0, edits: 3, parsed: 1, repaired: 0 });
  });

  it('Anthropic strict: absent optionals, any as JSON text', () => {
    const r = Task.render(ANTHROPIC_STRICT);
    const wire = { title: 'x', points: 0, done: true, tags: [], weights: [], byDay: [], due: '2024-03-01', level: 'low', kind: 'task', owner: 7, extra: '[1,2]' };
    expect(validate(r.jsonSchema, wire)).toEqual([]);
    const res = r.parse(wire);
    expect(res.ok && res.value).toEqual({ ...wire, weights: {}, extra: [1, 2] });
    expect(res.stats).toMatchObject({ objects: 1, parsed: 1, repaired: 0 });
  });

  it('Gemini / xAI: the code shape as is (nothing copied)', () => {
    for (const p of [GOOGLE_STRICT, XAI_STRICT]) {
      const wire = clone(sample());
      const res = Task.render(p).parse(wire);
      expect(res.ok && res.value).toBe(wire);
      expect(res.stats).toEqual({ objects: 0, arrays: 0, edits: 0, parsed: 0, repaired: 0 });
    }
  });

  it('repairs: a record sent as a JSON string, the whole args double-encoded', () => {
    const r = Task.render(OPENAI_STRICT);
    const res = r.parse({ ...r.encode(sample()) as object, weights: JSON.stringify([{ key: 'ann', value: 2 }]) });
    expect(res.ok && res.value.weights).toEqual({ ann: 2 });
    expect(res.stats.repaired).toBe(1);
    const res2 = r.parseText(JSON.stringify(JSON.stringify(r.encode(minimalTask))));
    expect(res2.ok && res2.value).toEqual(minimalTask);
    expect(res2.stats.repaired).toBe(1);
  });

  it('errors: the path the model wrote, the path the code sees, the re-prompt text', () => {
    const r = Task.render(OPENAI_STRICT);
    const wire = r.encode({ ...sample(), title: '', weights: { ann: 0.5, bo: 'heavy' as never } }) as Record<string, unknown>;
    const res = r.parse(wire);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.issues.map((i) => [i.path, i.codePath])).toEqual([
      [['title'], ['title']],
      [['weights', 1, 'value'], ['weights', 'bo']],
    ]);
    expect(res.message).toBe('- at title: Must be at least 1 characters.\n- at weights[1].value: Expected a number, got string.');
  });
});

// ---------------------------------------------------------------------------
// 4. Encoding, Handlebars, examples
// ---------------------------------------------------------------------------

describe('encoding and instructions', () => {
  it('encode / encodeText / encodeAt / encoder', () => {
    const r = Task.render(OPENAI_STRICT);
    const v = sample();
    const wire = r.encode(v) as Record<string, unknown>;
    expect(wire.weights).toEqual([{ key: 'ann', value: 0.5 }, { key: 'bo', value: 1 }]);
    expect(wire.extra).toBe('{"any":["json"]}');
    expect(v.weights).toEqual({ ann: 0.5, bo: 1 }); // never mutated
    expect(r.encodeAt({ a: 1 }, 'weights')).toEqual([{ key: 'a', value: 1 }]);
    expect(r.encodeText(minimalTask)).toBe('{"title":"x","points":0,"done":true,"tags":[],"weights":[],"byDay":[],"note":null,"due":null,"level":"low","kind":"task","owner":7,"extra":null}');
    expect(r.encoder.wire({ a: 2 } as never, 'weights')).toEqual([{ key: 'a', value: 2 }]);
    expect(Task.render(XAI_STRICT).encode(v)).toBe(v); // the code shape: the value itself
  });

  it('Handlebars {{encode}} shows a gin value in the model\'s shape', () => {
    const t = Handlebars.compile('Example: {{encode v}} / weights: {{encode w path="weights"}}', { noEscape: true });
    const out = t({ v: minimalTask, w: { ann: 1 } }, { helpers: schemaHelpers(Task.render(ANTHROPIC_STRICT)) });
    expect(out).toBe('Example: {"title":"x","points":0,"done":true,"tags":[],"weights":[],"byDay":[],"due":null,"level":"low","kind":"task","owner":7} / weights: [{"key":"ann","value":1}]');
    const req = ModelProfile.of(OPENAI_STRICT).request([{ kind: 'tool', name: 'prime_factors', schema: PrimeFactorsArgs }]);
    expect(Handlebars.compile('{{encode v}}', { noEscape: true })({ v: { n: 56 } }, { helpers: req.get('prime_factors').helpers() })).toBe('{"n":56}');
  });

  it('examples render in each model\'s shape', () => {
    const WithEx = Task.example(minimalTask);
    const strictJs = WithEx.render(OPENAI_STRICT).jsonSchema as any;
    expect(strictJs.description).toBe(`A work item.\nExample: ${WithEx.render(OPENAI_STRICT).encodeText(minimalTask)}`);
    expect(strictJs.description).toContain('"weights":[],"byDay":[],"note":null');
    expect((WithEx.render(ANTHROPIC_STRICT).jsonSchema as any).description).toContain('"weights":[],"byDay":[],"due":null');
    const lenientJs = WithEx.render(LENIENT).jsonSchema as any;
    expect(lenientJs.examples).toEqual([minimalTask]);
  });
});

// ---------------------------------------------------------------------------
// 5. Requests: several gin-typed tools at once
// ---------------------------------------------------------------------------

describe('request budgets', () => {
  it('Anthropic strict: three gin tools fit; optionals counted per request', () => {
    const req = ModelProfile.of(ANTHROPIC_STRICT).request([
      { kind: 'tool', name: 'save_task', schema: Task },
      { kind: 'tool', name: 'fetch', schema: FetchArgs },
      { kind: 'tool', name: 'prime_factors', schema: PrimeFactorsArgs },
    ]);
    expect(unexplained(req)).toEqual([]);
    for (const e of req.entries) expect(e.strict).toBe(true);
    expect(req.used.optional).toBe(2 + 3);
    const fetch = req.get('fetch');
    const res = fetch.parseText('{"url":"https://x.dev","headers":[{"key":"a","value":"b"}]}');
    expect(res.ok && res.value).toEqual({ url: 'https://x.dev', headers: { a: 'b' } });
    expect(fetch.encode({ url: 'u', headers: { a: 'b' } })).toEqual({ url: 'u', headers: [{ key: 'a', value: 'b' }] });
  });

  it('Anthropic strict: past 24 optionals the extra tools are written with nulls', () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ kind: 'tool' as const, name: `fetch_${i}`, schema: FetchArgs }));
    const req = ModelProfile.of(ANTHROPIC_STRICT).request([{ kind: 'tool', name: 'save_task', schema: Task }, ...many]);
    const adjusted = req.entries.filter((e) => e.adjustments.some((x) => x.kind === 'optional-as-null'));
    expect(adjusted.length).toBeGreaterThan(0);
    expect(adjusted[0]!.reasons.join(' ')).toMatch(/optional/);
    const res = adjusted[0]!.parse({ url: 'u', method: null, headers: null, body: null });
    expect(res.ok && res.value).toEqual({ url: 'u' });
  });
});

// ---------------------------------------------------------------------------
// 6. Registries: named, recursive, generic
// ---------------------------------------------------------------------------

describe('named gin types', () => {
  it('a structural registry: recursive named types through ginNamedTypes', () => {
    interface Node { label: string; children?: Node[] }
    const named = new Map<string, GinTypeDef>([
      ['Node', { name: 'obj', props: { label: { type: { name: 'text' } }, children: { type: { name: 'optional', generic: { T: { name: 'list', generic: { V: { name: 'Node' } } } } } } } }],
    ]);
    const reg: GinRegistryLike = { version: 1, named: () => named };
    const Tree = a.declare<{ Node: Node }>().dynamic((g: GinRegistryLike) => ginNamedTypes<{ Node: Node }>(g), { key: (g) => g.version }).result('Node');
    const tree: Node = { label: 'root', children: [{ label: 'a' }, { label: 'b', children: [] }] };
    expect(profileProblems(Tree.bind(reg), [tree])).toEqual([]);
    const res = Tree.render(ANTHROPIC_STRICT, reg).parse({ label: 'root', children: ['{"label":"a"}'] });
    expect(res.ok && res.value).toEqual({ label: 'root', children: [{ label: 'a' }] });
  });

  // gin serializes a registered type as an EXTENSION: { name: 'Task', extends: 'obj', props } (registry.extend; Type.toJSON).
  it('ginNamedTypes on a real gin registry (extends) converts the type, not a self-ref (was GAP gin-extension-defs)', () => {
    const r = createRegistry();
    r.register(r.extend('obj', { name: 'Task', props: { title: { type: r.text({ minLength: 1 }) }, done: { type: r.bool() } } }));
    const reg: GinRegistryLike = { version: 1, named: () => new Map(r.namedTypeList().map((t) => [t.name, t.toJSON() as GinTypeDef])) };
    const Save = a.declare<{ Task: { title: string; done: boolean } }>()
      .dynamic((g: GinRegistryLike) => ginNamedTypes<{ Task: { title: string; done: boolean } }>(g), { key: (g) => g.version })
      .result(a.object({ task: a.ref('Task') }));
    const res = Save.render(OPENAI_STRICT, reg).parse({ task: { title: 'x', done: false } });
    expect(res.ok).toBe(true);
    expect(Save.render(OPENAI_STRICT, reg).parse({ task: { title: '', done: false } }).ok).toBe(false);
  });

  // extension-generics.test.ts: `Box<T>` declared with generic T, used as { name: 'Box', generic: { T: num } }.
  it('a generic named type is instantiated with its use-site args, given the registry (was GAP gin-generic-named)', () => {
    const named = new Map<string, GinTypeDef>([
      ['Box', { name: 'obj', generic: { T: { name: 'any' } }, props: { item: { type: { name: 'T' } } } }],
    ]);
    const reg: GinRegistryLike = { version: 1, named: () => named };
    const UseBox = a.module()
      .dynamic((g: GinRegistryLike) => ginNamedTypes(g))
      .result(a.object({ box: fromGin({ name: 'Box', generic: { T: { name: 'num' } } }, { named }) as AnySchema }));
    const r = UseBox.render(LENIENT, reg);
    expect(r.parse({ box: { item: 1 } }).ok).toBe(true);
    expect(r.parse({ box: { item: 'x' } }).ok).toBe(false);
  });

  // type.ts:1669 describeType: a TypeDef `constraint` (ExprDef) is shown as "must satisfy <code>".
  it('a TypeDef constraint is described to the model (was GAP gin-constraint)', () => {
    const def = { name: 'text', constraint: { kind: 'get', path: [{ prop: 'this' }, { prop: 'startsWith' }, { args: { prefix: { kind: 'new', type: { name: 'text' }, value: 'user-' } } }] } } as unknown as GinTypeDef;
    expect(JSON.stringify(lenient(fromGin(def)).jsonSchema)).toContain('must satisfy');
  });
});
