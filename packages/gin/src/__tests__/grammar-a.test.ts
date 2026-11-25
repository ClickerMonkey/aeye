/**
 * gin's grammar module (grammar.ts) — the `a` grammar models write types and
 * programs in. Checked against the deprecated zod grammar (`buildZodSchemas`,
 * the same verdict on gin's own fixture programs and TypeDefs), on every
 * model profile, with real answers decoded and parsed by gin, errors for the
 * model at each detail level, binds cached, and ginny's tool set in requests
 * (fitting and degradation). Fixtures are the shared corpus ones
 * (packages/schema/src/__tests__/corpus/gin-fixtures.ts).
 */
import { describe, expect, it } from 'vitest';
import {
  a, ANTHROPIC_STRICT, GOOGLE_STRICT, LENIENT, MINIMAL, ModelProfile, OPENAI_STRICT, PEOPLE, XAI_STRICT, formatIssues,
} from '@aeye/schema';
import { buildSchemas, buildZodSchemas, createRegistry, ExprSchema, GinGrammar, TypeDefSchema } from '../index';
import { clone, MODEL_PROFILES, profileProblems, unexplained, validate } from '../../../schema/src/__tests__/corpus/_check';
import {
  BAD_PROGRAMS, everythingProgram, fixtureRegistry, lambdaProgram, loopProgram, personProgram, PROGRAMS, switchProgram, t, TYPEDEFS,
} from '../../../schema/src/__tests__/corpus/gin-fixtures';

const reg = fixtureRegistry();
const zodOpts = buildZodSchemas(reg);
const zodStrict = buildZodSchemas(reg, { newStrict: true });
const zodRefs = buildZodSchemas(reg, { namedRefs: true });
const WriteArgs = GinGrammar.result(a.object({ program: a.ref('Expr') }));
const EditType = GinGrammar.result(a.object({ name: a.string(), def: a.ref('TypeDef') }));

describe('the a grammar accepts exactly what the zod grammar accepts', () => {
  const ours = buildSchemas(reg).Expr.render(LENIENT);
  const oursStrict = buildSchemas(reg, { newStrict: true }).Expr.render(LENIENT);
  const oursType = buildSchemas(reg).Type.render(LENIENT);
  const oursTypeRefs = buildSchemas(reg, { namedRefs: true }).Type.render(LENIENT);

  for (const [name, p] of Object.entries(PROGRAMS)) {
    it(`program ${name}`, () => {
      expect(zodOpts.Expr.safeParse(p).success).toBe(true);
      const res = ours.parse(clone(p));
      expect(res.ok ? res.value : res.message).toEqual(p);
    });
  }
  for (const [label, p] of BAD_PROGRAMS) {
    it(`rejects: ${label}`, () => {
      expect(zodOpts.Expr.safeParse(p).success).toBe(false);
      expect(ours.parse(clone(p)).ok).toBe(false);
    });
  }
  for (const [name, d] of Object.entries(TYPEDEFS)) {
    const refsOnly = name === 'fnSig'; // refers to its call.types alias by bare name: only with namedRefs
    it(`TypeDef ${name}`, () => {
      expect([zodOpts.Type.safeParse(d).success, oursType.parse(clone(d)).ok]).toEqual([!refsOnly, !refsOnly]);
      expect([zodRefs.Type.safeParse(d).success, oursTypeRefs.parse(clone(d)).ok]).toEqual([true, true]);
    });
  }
  it('namedRefs: a name the registry lacks passes only with namedRefs', () => {
    expect([zodOpts.Type.safeParse({ name: 'NotATask' }).success, oursType.parse({ name: 'NotATask' }).ok]).toEqual([false, false]);
    expect([zodRefs.Type.safeParse({ name: 'ns/NotATask' }).success, oursTypeRefs.parse({ name: 'ns/NotATask' }).ok]).toEqual([true, true]);
    expect([zodRefs.Type.safeParse({ name: 'has space' }).success, oursTypeRefs.parse({ name: 'has space' }).ok]).toEqual([false, false]);
  });
  it('newStrict: per-type `new` branches', () => {
    const good = [
      { kind: 'new', type: { name: 'Pair' }, value: [t('text', 'a'), t('num', 1)] },
      { kind: 'new', type: { name: 'Task' }, value: { title: 'x', done: t('bool', true) } },
      { kind: 'new', type: { name: 'num', options: { min: 0 } }, value: 3 },
      { kind: 'new', type: { name: 'list', generic: { V: { name: 'num' } } }, value: [t('num', 1)] },
      { kind: 'new', type: { name: 'map', generic: { K: { name: 'text' }, V: { name: 'num' } } }, value: [{ key: t('text', 'a'), value: t('num', 1) }] },
      { kind: 'new', type: { name: 'duration' }, value: { minutes: 5 } },
      { kind: 'new', type: { name: 'fn' }, value: 'list.push' },
      personProgram,
    ];
    const bad = [
      { kind: 'new', type: { name: 'num' }, value: 'three' },
      { kind: 'new', type: { name: 'duration' }, value: 300 },
      { kind: 'new', type: { name: 'color' }, value: { r: 300, g: 0, b: 0 } },
      { kind: 'new', type: { name: 'Task' }, value: { title: 5, done: true } },
      { kind: 'new', type: { name: 'list' }, value: 'abc' },
    ];
    for (const v of good) expect([zodStrict.Expr.safeParse(v).success, oursStrict.parse(clone(v)).ok], JSON.stringify(v)).toEqual([true, true]);
    for (const v of bad) expect([zodStrict.Expr.safeParse(v).success, oursStrict.parse(clone(v)).ok], JSON.stringify(v)).toEqual([false, false]);
  });
});

describe('rendering', () => {
  it('OpenAI strict: one $defs entry per gin aid, registry names as branches, extends as an enum', () => {
    const js = WriteArgs.bind(reg).render(OPENAI_STRICT).jsonSchema as any;
    const defs = Object.keys(js.$defs);
    for (const k of ['TypeDef', 'Type_num', 'Type_object', 'Type_function', 'Type_interface', 'Type_Extension', 'Expr', 'Expr_define', 'Expr_new', 'PathStep', 'PropDef', 'CallDef', 'GetSetDef', 'InitDef', 'Generic']) {
      expect(defs, k).toContain(k);
    }
    expect(defs.some((k: string) => k.startsWith('New_'))).toBe(false);
    expect(js.properties.program).toEqual({ $ref: '#/$defs/Expr' });
    const named = js.$defs.TypeDef.anyOf.slice(0, 3).map((b: any) => b.properties.name);
    expect(named).toEqual([{ type: 'string', enum: ['Person'] }, { type: 'string', enum: ['Task'] }, { type: 'string', enum: ['Pair'] }]);
    expect(js.$defs.Type_Extension.properties.extends.enum).toEqual(expect.arrayContaining(['obj', 'interface', 'Person', 'Task', 'Pair']));
    expect(js.$defs.PathStep.anyOf[1].properties.args.type).toBe('array'); // records as pairs
    expect(js.$defs.Expr_flow.properties.comment).toBeUndefined();
    expect(js.$defs.Expr_block.properties.comment).toBeDefined();
  });

  it('newStrict: one branch per named type (New_<name>) and per class (New_<class>)', () => {
    const js = WriteArgs.bind(reg, { newStrict: true }).render(OPENAI_STRICT).jsonSchema as any;
    const branches = js.$defs.Expr_new.anyOf;
    expect(branches.length).toBe(3 + 24);
    expect(branches[0]).toEqual({ $ref: '#/$defs/New_Person' });
    expect(branches[3]).toEqual({ $ref: '#/$defs/New_any' });
    expect(js.$defs.New_duration.properties.value.anyOf[0].properties.minutes).toBeDefined();
  });

  it('every profile renders, encodes and decodes every program (as write args)', () => {
    expect(profileProblems(WriteArgs.bind(reg), Object.values(PROGRAMS).map((program) => ({ program })))).toEqual([]);
  });
  it('every profile: newStrict programs', () => {
    expect(profileProblems(WriteArgs.bind(reg, { newStrict: true }), [personProgram, switchProgram].map((program) => ({ program })))).toEqual([]);
  });
  it('every profile: TypeDefs (OpenAI strict through a request: it needs the depth ladder)', () => {
    const notOpenAI = [...MODEL_PROFILES.filter((p) => p !== OPENAI_STRICT), PEOPLE];
    expect(profileProblems(TypeDefSchema.bind(reg, { namedRefs: true }), Object.values(TYPEDEFS), { tool: false, profiles: notOpenAI })).toEqual([]);
    const out = ModelProfile.of(OPENAI_STRICT).request([{ kind: 'output', schema: TypeDefSchema.bind(reg, { namedRefs: true }) }]).get('output');
    for (const d of Object.values(TYPEDEFS)) {
      const wire = out.encode(d);
      expect(validate(out.jsonSchema!, wire)).toEqual([]);
      const res = out.parse(JSON.parse(JSON.stringify(wire)));
      expect(res.ok ? res.value : res.message).toEqual(d);
    }
  });
});

describe('programs as models write them, then parsed and run by gin', () => {
  it('OpenAI strict: pairs, nulls and JSON text decode to the code shape gin parses', async () => {
    const r = WriteArgs.bind(reg).render(OPENAI_STRICT);
    for (const program of Object.values(PROGRAMS)) {
      const wire = JSON.parse(JSON.stringify(r.encode({ program })));
      expect(validate(r.jsonSchema, wire)).toEqual([]);
      const res = r.parse(wire);
      expect(res.ok ? res.value : res.message).toEqual({ program });
      if (res.ok) expect(() => reg.parseExpr(res.value.program as never)).not.toThrow();
    }
  });
  it('Anthropic strict / Gemini / xAI round-trip', () => {
    for (const p of [ANTHROPIC_STRICT, GOOGLE_STRICT, XAI_STRICT, MINIMAL]) {
      const r = WriteArgs.bind(reg).render(p);
      const res = r.parse(JSON.parse(JSON.stringify(r.encode({ program: everythingProgram }))));
      expect(res.ok ? res.value : res.message, p.id).toEqual({ program: everythingProgram });
    }
  });
  it('a program sent as a JSON string is repaired', () => {
    const r = WriteArgs.bind(reg).render(OPENAI_STRICT);
    const program = (r.encode({ program: loopProgram }) as { program: unknown }).program;
    const res = r.parse({ program: JSON.stringify(program) });
    expect(res.ok && res.value).toEqual({ program: loopProgram });
    expect(res.stats.repaired).toBe(1);
  });
});

describe('errors for the model', () => {
  const r = WriteArgs.bind(reg).render(OPENAI_STRICT);
  const bad = () => {
    const wire = r.encode({ program: clone(lambdaProgram) }) as any;
    wire.program.body.path[3].args[0].value = { kind: 'flow', action: 'goto', value: null, error: null };
    return wire;
  };
  it('at the model path and the code path, inside the branch whose keys fit', () => {
    const res = r.parse(bad());
    expect(!res.ok && res.issues.map((i) => [i.path, i.codePath])).toEqual([
      [['program', 'body', 'path', 3, 'args', 0, 'value', 'action'], ['program', 'body', 'path', 3, 'args', 'other', 'action']],
    ]);
  });
  it('an unknown kind names every kind, with did-you-mean', () => {
    const res = buildSchemas(reg).Expr.render(LENIENT).parse({ kind: 'gett', path: [] });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(formatIssues(res.issues)).toContain('"new", "get", "set"');
      expect(res.message).toContain('did you mean `get`');
    }
  });
  it('each detail level: summary < list < markers < full, all under the cap', () => {
    const sizes: Record<string, number> = {};
    for (const detail of ['summary', 'list', 'markers', 'full'] as const) {
      const res = r.parse(bad(), { errorFormat: { detail } });
      expect(res.ok).toBe(false);
      if (res.ok) continue;
      sizes[detail] = res.message.length;
      expect(res.message.length).toBeLessThanOrEqual(2000);
      if (detail !== 'summary') expect(res.message).toContain('action');
      if (detail === 'markers' || detail === 'full') expect(res.message).toContain('^');
    }
    expect(sizes.summary!).toBeLessThan(sizes.full!);
    expect(sizes.list!).toBeLessThanOrEqual(sizes.full!);
  });
});

describe('binding and requests', () => {
  it('binds are cached per registry and version; a registered type makes a new bind; the static grammar is shared', () => {
    expect(ExprSchema.bind(reg)).toBe(ExprSchema.bind(reg));
    expect(ExprSchema.bind(reg, { newStrict: true })).not.toBe(ExprSchema.bind(reg));
    const r2 = fixtureRegistry();
    const before = ExprSchema.bind(r2);
    r2.register(r2.extend('obj', { name: 'Project', props: { name: { type: r2.text() } } }));
    const after = ExprSchema.bind(r2);
    expect(after).not.toBe(before);
    const d1 = (ExprSchema.bind(reg).render(OPENAI_STRICT).jsonSchema.$defs as any).Type_num;
    const d2 = (after.render(OPENAI_STRICT).jsonSchema.$defs as any).Type_num;
    expect(d2).toBe(d1);
    expect(JSON.stringify(after.render(OPENAI_STRICT).jsonSchema)).toContain('"Project"');
  });
  it('two registries never share a bind', () => {
    const r1 = createRegistry();
    const r2 = createRegistry();
    expect(r1.version).toBe(r2.version);
    expect(ExprSchema.bind(r1)).not.toBe(ExprSchema.bind(r2));
  });

  it("ginny's tool set in one OpenAI strict request fits as is", () => {
    const req = ModelProfile.of(OPENAI_STRICT).request([
      { kind: 'tool', name: 'write', schema: WriteArgs.bind(reg, { newStrict: true }) },
      { kind: 'tool', name: 'edit_type', schema: EditType.bind(reg) },
    ]);
    expect(unexplained(req)).toEqual([]);
    for (const e of req.entries) expect([e.name, e.strict]).toEqual([e.name, true]);
    const res = req.get('write').parse(req.get('write').encode({ program: personProgram }));
    expect(res.ok && res.value).toEqual({ program: personProgram });
  });
  it('Anthropic strict: counted against the request, fitted, never an error', () => {
    const req = ModelProfile.of(ANTHROPIC_STRICT).request([
      { kind: 'tool', name: 'write', schema: WriteArgs.bind(reg, { newStrict: true }) },
      { kind: 'tool', name: 'edit_type', schema: EditType.bind(reg) },
    ]);
    expect(unexplained(req)).toEqual([]);
    expect(req.used.unions).toBeLessThanOrEqual(16);
    expect(req.used.optional).toBeLessThanOrEqual(24);
    const w = req.get('write');
    const res = w.parse(w.encode({ program: switchProgram }));
    expect(res.ok ? res.value : res.message).toEqual({ program: switchProgram });
  });
  it('degradation: 130 grammar tools on OpenAI (limit 128) — the overflow goes behind the dispatcher and still decodes', () => {
    const items = Array.from({ length: 130 }, (_, i) => ({
      kind: 'tool' as const, name: `write_${i}`, schema: (i % 2 ? WriteArgs.bind(reg) : EditType.bind(reg)) as never, description: `tool ${i}`,
    }));
    const req = ModelProfile.of(OPENAI_STRICT).request(items);
    expect(req.dispatcher).toBeDefined();
    const dispatched = req.entries.filter((e) => e.delivery === 'dispatched');
    expect(dispatched.length).toBeGreaterThan(0);
    const e = dispatched.find((x) => x.name.startsWith('write_') && Number(x.name.slice(6)) % 2 === 1)!;
    const wire = req.encodeCall(e.name as never, { program: loopProgram } as never);
    const call = req.decodeCall(wire.name, JSON.parse(JSON.stringify(wire.args)));
    expect(call.ok ? [call.tool, call.value] : call.message).toEqual([e.name, { program: loopProgram }]);
  });
});
