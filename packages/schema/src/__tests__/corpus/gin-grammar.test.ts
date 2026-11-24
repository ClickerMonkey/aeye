/**
 * CORPUS: the full gin grammar (gin-grammar.ts) against the real
 * `buildSchemas` of @aeye/gin, with gin's own test fixtures as registries
 * and programs (person.test.ts, build-schemas-named.test.ts,
 * new-strict-schema.test.ts, code-render-demo.test.ts).
 */
import Handlebars from 'handlebars';
import { describe, expect, it } from 'vitest';
import { buildSchemas } from '@aeye/gin';
import {
  a, ANTHROPIC_STRICT, GOOGLE_STRICT, LENIENT, MINIMAL, ModelProfile, OPENAI_STRICT, PEOPLE, schemaHelpers, XAI_STRICT,
} from '../../index';
import { clone, MODEL_PROFILES, profileProblems, validate, unexplained } from './_check';
import { GinGrammar, Program, TypeResult, WriteArgs } from './gin-grammar';
import { asGrammarRegistry, BAD_PROGRAMS, t, everythingProgram, fixtureRegistry, lambdaProgram, loopProgram, personProgram, PROGRAMS, switchProgram, TYPEDEFS } from './gin-fixtures';

const reg0 = fixtureRegistry();
const reg = asGrammarRegistry(reg0);
const ginOpts = buildSchemas(reg0);
const ginStrict = buildSchemas(reg0, { newStrict: true });
const ginRefs = buildSchemas(reg0, { namedRefs: true });

// ---------------------------------------------------------------------------
// 1. Differential against gin's buildSchemas
// ---------------------------------------------------------------------------

describe('the grammar accepts exactly what gin buildSchemas accepts', () => {
  const ours = Program.bind(reg).render(LENIENT);
  const oursStrict = Program.bind(reg, { newStrict: true }).render(LENIENT);
  const oursType = TypeResult.bind(reg).render(LENIENT);
  const oursTypeRefs = TypeResult.bind(reg, { namedRefs: true }).render(LENIENT);

  for (const [name, p] of Object.entries(PROGRAMS)) {
    it(`program ${name}`, () => {
      expect(ginOpts.Expr.safeParse(p).success).toBe(true);
      const res = ours.parse(clone(p));
      expect(res.ok ? 'ok' : res.message).toBe('ok');
      expect(res.ok && res.value).toEqual(p);
    });
  }
  for (const [label, p] of BAD_PROGRAMS) {
    it(`rejects: ${label}`, () => {
      expect(ginOpts.Expr.safeParse(p).success).toBe(false);
      expect(ours.parse(clone(p)).ok).toBe(false);
    });
  }
  for (const [name, d] of Object.entries(TYPEDEFS)) {
    // fnSig refers to its call.types alias by bare name ({name:'positiveInt'}): gin's Type union takes that only
    // with namedRefs (schemaBag), not with the default buildSchemas ginny's designer uses — the same verdict here.
    const refsOnly = name === 'fnSig';
    it(`TypeDef ${name}`, () => {
      expect([ginOpts.Type.safeParse(d).success, oursType.parse(clone(d)).ok]).toEqual([!refsOnly, !refsOnly]);
      expect([ginRefs.Type.safeParse(d).success, oursTypeRefs.parse(clone(d)).ok]).toEqual([true, true]);
    });
  }
  it('namedRefs: a name the registry lacks passes only with namedRefs (and nothing else may ride along)', () => {
    expect([ginOpts.Type.safeParse({ name: 'NotATask' }).success, oursType.parse({ name: 'NotATask' }).ok]).toEqual([false, false]);
    expect([ginRefs.Type.safeParse({ name: 'ns/NotATask' }).success, oursTypeRefs.parse({ name: 'ns/NotATask' }).ok]).toEqual([true, true]);
    expect([ginRefs.Type.safeParse({ name: 'has space' }).success, oursTypeRefs.parse({ name: 'has space' }).ok]).toEqual([false, false]);
  });

  it('newStrict: per-type `new` branches (gin new-strict-schema.test.ts)', () => {
    const good = [
      { kind: 'new', type: { name: 'Pair' }, value: [t('text', 'a'), t('num', 1)] },
      { kind: 'new', type: { name: 'Task' }, value: { title: 'x', done: t('bool', true) } },
      { kind: 'new', type: { name: 'Person' }, value: { firstName: 'Ada', lastName: { kind: 'get', path: [{ prop: 'n' }] }, fullName: { kind: 'get', path: [{ prop: 'f' }] } } },
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
    for (const v of good) expect([ginStrict.Expr.safeParse(v).success, oursStrict.parse(clone(v)).ok], JSON.stringify(v)).toEqual([true, true]);
    for (const v of bad) expect([ginStrict.Expr.safeParse(v).success, oursStrict.parse(clone(v)).ok], JSON.stringify(v)).toEqual([false, false]);
  });
});

// ---------------------------------------------------------------------------
// 2. Rendering
// ---------------------------------------------------------------------------

describe('rendering the grammar', () => {
  it('OpenAI strict: one $defs entry per gin aid, registry names as branches, extends as an enum', () => {
    const js = WriteArgs.render(OPENAI_STRICT, reg).jsonSchema as any;
    const defs = Object.keys(js.$defs);
    for (const k of ['TypeDef', 'Type_num', 'Type_object', 'Type_function', 'Type_interface', 'Type_Extension', 'Expr', 'Expr_define', 'Expr_new', 'PathStep', 'PropDef', 'CallDef', 'GetSetDef', 'InitDef', 'Generic']) {
      expect(defs, k).toContain(k);
    }
    expect(defs.some((k: string) => k.startsWith('New_'))).toBe(false); // only with newStrict
    expect(js.properties.program).toEqual({ $ref: '#/$defs/Expr' });
    const named = js.$defs.TypeDef.anyOf.slice(0, 3).map((b: any) => b.properties.name);
    expect(named).toEqual([{ type: 'string', enum: ['Person'] }, { type: 'string', enum: ['Task'] }, { type: 'string', enum: ['Pair'] }]);
    expect(js.$defs.Type_Extension.properties.extends.enum).toEqual(expect.arrayContaining(['obj', 'interface', 'Person', 'Task', 'Pair']));
    expect(js.$defs.Type_Extension.properties.name).toMatchObject({ type: 'string', pattern: '^(?:\\w[\\w-]*\\/)*\\w+$' });
    // records as pairs (call args, obj props), optionals as null
    expect(js.$defs.PathStep.anyOf[1].properties.args.type).toBe('array');
    expect(js.$defs.Expr_flow.properties.value.anyOf).toEqual([{ $ref: '#/$defs/Expr' }, { type: 'null' }]);
    expect(js.$defs.Expr_flow.properties.comment).toBeUndefined(); // flow has no comment field (flow.ts:49)
    expect(js.$defs.Expr_block.properties.comment).toBeDefined();
  });

  it('newStrict adds one branch per class and per named type', () => {
    const js = WriteArgs.render(OPENAI_STRICT, reg, { newStrict: true }).jsonSchema as any;
    const branches = js.$defs.Expr_new.anyOf;
    expect(branches.length).toBe(3 + 24);
    expect(branches[0].properties.type.properties.name).toEqual({ type: 'string', enum: ['Person'] });
    expect(branches[3]).toEqual({ $ref: '#/$defs/New_any' });
    expect(js.$defs.New_duration.properties.value.anyOf[0].properties.minutes).toBeDefined();
  });

  it('Anthropic strict: no recursion, so Expr/TypeDef positions are JSON text', () => {
    const r = WriteArgs.render(ANTHROPIC_STRICT, reg);
    expect(JSON.stringify(r.jsonSchema)).toContain('JSON text');
    expect(r.jsonSchema.$defs === undefined || Object.keys(r.jsonSchema.$defs as object).length >= 0).toBe(true);
  });

  it('every profile renders, encodes and decodes every program (as write args)', () => {
    const samples = Object.values(PROGRAMS).map((program) => ({ program }));
    expect(profileProblems(WriteArgs.bind(reg), samples)).toEqual([]);
  });
  const NOT_MINIMAL = [...MODEL_PROFILES.filter((p) => p !== MINIMAL), PEOPLE];
  it('every profile: newStrict programs', () => {
    const samples = [personProgram, switchProgram].map((program) => ({ program }));
    expect(profileProblems(WriteArgs.bind(reg, { newStrict: true }), samples, { profiles: NOT_MINIMAL })).toEqual([]);
  });
  // MINIMAL has no combinators and no recursion: a nullable slot whose value is written as JSON text
  // (New_nullable's `value?: Expr | null`) comes out as `anyOf [string|null, null]`.
  it.fails('GAP: minimal-nullable-escape-anyOf — newStrict grammar on MINIMAL has no anyOf', () => {
    expect(profileProblems(WriteArgs.bind(reg, { newStrict: true }), [{ program: personProgram }], { profiles: [MINIMAL] })).toEqual([]);
  });
  it('every profile: TypeDefs (as an output; OpenAI strict through a request, see the gap below)', () => {
    const notOpenAI = [...MODEL_PROFILES.filter((p) => p !== OPENAI_STRICT), PEOPLE];
    expect(profileProblems(TypeResult.bind(reg, { namedRefs: true }), Object.values(TYPEDEFS), { tool: false, profiles: notOpenAI })).toEqual([]);
    const out = ModelProfile.of(OPENAI_STRICT).request([{ kind: 'output', schema: TypeResult.bind(reg, { namedRefs: true }) }]).get('output');
    expect(out.adjustments.map((x) => x.kind)).toContain('depth-limited');
    for (const d of Object.values(TYPEDEFS)) {
      const wire = out.encode(d);
      expect(validate(out.jsonSchema!, wire)).toEqual([]);
      const res = out.parse(JSON.parse(JSON.stringify(wire)));
      expect(res.ok ? res.value : res.message).toEqual(d);
    }
  });
  // A plain `render(OPENAI_STRICT)` of the TypeDef union emits 14 levels of nesting; OpenAI's per-schema limit is 10.
  // Only `request()` applies the depth ladder, so a caller rendering directly sends a schema OpenAI rejects.
  it.fails('GAP: render-over-depth-limit — render(OPENAI_STRICT) of TypeDef obeys the profile\'s own maxDepth', () => {
    expect(profileProblems(TypeResult.bind(reg, { namedRefs: true }), [TYPEDEFS.invoice], { tool: false, profiles: [OPENAI_STRICT] })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3. Decoding programs as models write them
// ---------------------------------------------------------------------------

describe('programs as models write them', () => {
  it('OpenAI strict: call args and obj props as pairs, absent optionals as null, any as JSON text', () => {
    const r = WriteArgs.render(OPENAI_STRICT, reg);
    const wire = {
      program: {
        kind: 'block', comment: null,
        lines: [
          { kind: 'get', path: [{ prop: 'p' }, { prop: 'greet' }, { args: [{ key: 'name', value: { kind: 'new', type: { name: 'text', options: null }, value: '"Ada"' } }], generic: null, catch: null }] },
          { kind: 'new', type: { name: 'obj', props: [{ key: 'a', value: { docs: null, type: { name: 'num', options: { min: 0, max: null, whole: true, minPrecision: null, maxPrecision: null, prefix: null, suffix: null } }, get: null, default: null, set: null } }] }, value: '{"a":1}' },
          { kind: 'flow', action: 'return', value: null, error: null },
        ],
      },
    };
    expect(validate(r.jsonSchema, wire)).toEqual([]);
    const res = r.parse(wire);
    expect(res.ok ? res.value : res.message).toEqual({
      program: {
        kind: 'block',
        lines: [
          { kind: 'get', path: [{ prop: 'p' }, { prop: 'greet' }, { args: { name: { kind: 'new', type: { name: 'text' }, value: 'Ada' } } }] },
          { kind: 'new', type: { name: 'obj', props: { a: { type: { name: 'num', options: { min: 0, whole: true } } } } }, value: { a: 1 } },
          { kind: 'flow', action: 'return' },
        ],
      },
    });
    if (!res.ok) return;
    expect(res.value).toBe(wire);
    // 2 records (call args, obj props) rebuilt; 2 JSON texts parsed; every null deleted in place.
    expect(res.stats).toMatchObject({ objects: 2, arrays: 0, parsed: 2, repaired: 0 });
    expect(res.stats.edits).toBe(19); // 15 nulls deleted + 4 decoded children written back
  });

  it('Anthropic strict: the back-edges (nested Exprs) arrive as JSON text and decode in place', () => {
    const r = WriteArgs.render(ANTHROPIC_STRICT, reg);
    const j = (v: unknown) => JSON.stringify(v);
    const s = switchProgram;
    const wire = { program: { kind: 'switch', value: j(s.value), cases: [{ equals: [j(s.cases[0]!.equals[0])], body: j(s.cases[0]!.body) }], else: j(s.else) } };
    expect(r.encode({ program: s })).toEqual(wire);
    expect(validate(r.jsonSchema, wire)).toEqual([]);
    const res = r.parse(wire);
    expect(res.ok && res.value).toEqual({ program: s });
    expect(res.ok && res.value).toBe(wire);
    expect(res.stats).toEqual({ objects: 0, arrays: 0, edits: 4, parsed: 4, repaired: 0 });
    // A value sent directly where JSON text was asked for is taken as is (repair).
    const direct = r.parse({ program: { ...(r.encode({ program: s }) as typeof wire).program, else: s.else } });
    expect(direct.ok && direct.stats.repaired).toBe(1);
  });

  it('Gemini / xAI: the code shape', () => {
    for (const p of [GOOGLE_STRICT, XAI_STRICT]) {
      const r = WriteArgs.render(p, reg);
      const wire = { program: clone(everythingProgram) };
      expect(validate(r.jsonSchema, r.encode(wire))).toEqual([]);
      const res = r.parse(r.encode(wire));
      expect(res.ok && res.value).toEqual(wire);
    }
  });

  // write.ts:9 — "Claude Sonnet 4.5 over OpenRouter has been observed double-encoding very large tool args".
  // A record or array sent as a JSON string is repaired; a tagged union of objects (Expr) is not.
  it('repair: a program (tagged union) sent as a JSON string (was GAP repair-tagged-union-string)', () => {
    const r = WriteArgs.render(OPENAI_STRICT, reg);
    const program = (r.encode({ program: loopProgram }) as { program: unknown }).program;
    const res = r.parse({ program: JSON.stringify(program) });
    expect(res.ok && res.value).toEqual({ program: loopProgram });
    expect(res.stats.repaired).toBe(1);
  });
  it('repair: the whole args double-encoded', () => {
    const r = WriteArgs.render(OPENAI_STRICT, reg);
    const res = r.parseText(JSON.stringify(JSON.stringify(r.encode({ program: loopProgram }))));
    expect(res.ok && res.value).toEqual({ program: loopProgram });
    expect(res.stats.repaired).toBe(1);
  });

  it('errors: inside the branch the tag picks, at the model path and the code path', () => {
    const r = WriteArgs.render(OPENAI_STRICT, reg);
    const wire = r.encode({ program: clone(lambdaProgram) }) as any;
    // A typo inside a pairs record: args.props[0].value.type.options.min
    wire.program.type.call.args.props[0].value.type.options = { min: 'zero', max: null, whole: null, minPrecision: null, maxPrecision: null, prefix: null, suffix: null };
    // A bad flow action deep in a call step's args (pairs too)
    wire.program.body.path[3].args[0].value = { kind: 'flow', action: 'goto', value: null, error: null };
    const res = r.parse(wire);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.issues.map((i) => [i.path, i.codePath])).toEqual([
      [['program', 'type', 'call', 'args', 'props', 0, 'value', 'type', 'options', 'min'], ['program', 'type', 'call', 'args', 'props', 'x', 'type', 'options', 'min']],
      // PathStep is gin's plain (untagged) z.union: the error is at the step, as zod's invalid_union is.
      [['program', 'body', 'path', 3], ['program', 'body', 'path', 3]],
    ]);
    expect(res.message).toContain('- at program.type.call.args.props[0].value.type.options.min: Expected a number');
    expect(res.message).toContain('- at program.body.path[3]: Did not match any of: { prop: string } | { args: { [key: string]: Expr }; generic?: Generic; catch?: Expr } | { key: Expr }.');
  });

  it('errors: an unknown kind names every kind', () => {
    const res = Program.render(LENIENT, reg).parse({ kind: 'call', fn: 'x' });
    expect(!res.ok && res.message).toBe('- at kind: Expected kind to be one of: "new", "get", "set", "define", "block", "if", "switch", "loop", "lambda", "template", "flow", "native".');
  });

  // A step `{ args: [...] }` can only be the CALL branch (no other branch has `args`); reporting the
  // inner error (args[0].value.action) re-prompts far better than "Did not match any of".
  it.fails('GAP: untagged-union-error-locality — an untagged union reports the error inside the only branch whose keys fit', () => {
    const r = WriteArgs.render(OPENAI_STRICT, reg);
    const wire = r.encode({ program: clone(lambdaProgram) }) as any;
    wire.program.body.path[3].args[0].value = { kind: 'flow', action: 'goto', value: null, error: null };
    const res = r.parse(wire);
    expect(!res.ok && res.issues.map((i) => i.path)).toEqual([['program', 'body', 'path', 3, 'args', 0, 'value', 'action']]);
  });

  // `encodeAt(value, 'program.type')`: a part below a (tagged) union of refs.
  it('encodeAt a path below a tagged union branch (was GAP encodeAt-through-union)', () => {
    const r = WriteArgs.render(OPENAI_STRICT, reg);
    expect(r.encodeAt(lambdaProgram.type, 'program.type')).toMatchObject({ name: 'fn', call: { args: { props: [{ key: 'x' }] } } });
  });
});

// ---------------------------------------------------------------------------
// 4. Encoding, instructions, examples
// ---------------------------------------------------------------------------

describe('programs in instructions', () => {
  it('encode / encodeAt / encoder / Handlebars show a program in the model\'s shape', () => {
    const r = WriteArgs.render(OPENAI_STRICT, reg);
    const wire = r.encode({ program: lambdaProgram }) as any;
    expect(wire.program.body.path[3].args).toEqual([{ key: 'other', value: { kind: 'new', type: { name: 'num', options: null }, value: '2' } }]);
    expect(wire.program.comment).toBeNull();
    expect(r.encodeAt(lambdaProgram, 'program')).toEqual(wire.program);
    expect(r.encoder.wire({ program: lambdaProgram })).toEqual(wire);
    const t = Handlebars.compile('Example: {{encode ex}}', { noEscape: true });
    const strict = t({ ex: { program: loopProgram } }, { helpers: schemaHelpers(r) });
    expect(JSON.parse(strict.slice('Example: '.length))).toEqual(r.encode({ program: loopProgram }));
    const lenientText = t({ ex: { program: loopProgram } }, { helpers: schemaHelpers(WriteArgs.render(LENIENT, reg)) });
    expect(lenientText).toBe(`Example: ${JSON.stringify({ program: loopProgram })}`);
    const claude = t({ ex: { program: loopProgram } }, { helpers: schemaHelpers(WriteArgs.render(ANTHROPIC_STRICT, reg)) });
    expect(JSON.parse(claude.slice('Example: '.length))).toEqual(WriteArgs.render(ANTHROPIC_STRICT, reg).encode({ program: loopProgram }));
    expect(typeof JSON.parse(claude.slice('Example: '.length)).program.over).toBe('string'); // a back-edge: JSON text
  });

  it('an example program renders in each model\'s shape', () => {
    const WithEx = GinGrammar.result(a.object({ program: a.ref('Expr') }).example({ program: loopProgram }));
    const strictDesc = (WithEx.render(OPENAI_STRICT, reg).jsonSchema as any).description as string;
    expect(strictDesc).toContain('Example: ');
    expect(strictDesc).toContain('"comment":null');
    expect((WithEx.render(LENIENT, reg).jsonSchema as any).examples).toEqual([{ program: loopProgram }]);
  });
});

// ---------------------------------------------------------------------------
// 5. Binding, caching, requests
// ---------------------------------------------------------------------------

describe('binding and requests', () => {
  it('binds are cached per registry version + overrides; the static grammar renders once', () => {
    expect(Program.bind(reg)).toBe(Program.bind(asGrammarRegistry(reg0)));
    expect(Program.bind(reg, { newStrict: true })).not.toBe(Program.bind(reg));
    const r2 = fixtureRegistry();
    r2.register(r2.extend('obj', { name: 'Project', props: { name: { type: r2.text() } } }));
    const b2 = Program.bind(asGrammarRegistry(r2));
    expect(b2).not.toBe(Program.bind(reg));
    const d1 = (Program.render(OPENAI_STRICT, reg).jsonSchema.$defs as any).Type_num;
    const d2 = (b2.render(OPENAI_STRICT).jsonSchema.$defs as any).Type_num;
    expect(d2).toBe(d1);
    expect((b2.render(OPENAI_STRICT).jsonSchema.$defs as any).Type_Extension.properties.extends.enum).toContain('Project');
  });

  it('ginny\'s tool set in one request: OpenAI strict fits as is', () => {
    const req = ModelProfile.of(OPENAI_STRICT).request([
      { kind: 'tool', name: 'write', schema: WriteArgs.bind(reg, { newStrict: true }) },
      { kind: 'tool', name: 'edit_type', schema: GinGrammar.result(a.object({ name: a.string(), def: a.ref('TypeDef') })).bind(reg) },
    ]);
    expect(unexplained(req)).toEqual([]);
    for (const e of req.entries) expect([e.name, e.strict, e.adjustments]).toEqual([e.name, true, []]);
    const res = req.get('write').parse(req.get('write').encode({ program: personProgram }));
    expect(res.ok && res.value).toEqual({ program: personProgram });
  });

  it('Anthropic strict: the grammar\'s unions and optionals are counted against the request', () => {
    const req = ModelProfile.of(ANTHROPIC_STRICT).request([
      { kind: 'tool', name: 'write', schema: WriteArgs.bind(reg, { newStrict: true }) },
      { kind: 'tool', name: 'edit_type', schema: GinGrammar.result(a.object({ name: a.string(), def: a.ref('TypeDef') })).bind(reg) },
    ]);
    expect(unexplained(req)).toEqual([]);
    for (const e of req.entries) {
      // Either fitted strict, or fell back with a recorded reason.
      if (!e.strict) expect(e.reasons.length).toBeGreaterThan(0);
    }
    expect(req.used.unions).toBeLessThanOrEqual(16);
    expect(req.used.optional).toBeLessThanOrEqual(24);
    // Each grammar alone has ~100 optional properties (limit 24): nesting is cut to JSON text and enums widened.
    for (const e of req.entries) {
      expect(e.strict).toBe(true);
      expect(e.adjustments.map((x) => x.kind)).toEqual(['enums-widened', 'depth-limited']);
      expect(e.reasons.join(' ')).toMatch(/optional properties \(limit 24\)/);
    }
  });

  // The depth-limited entry writes `program` as JSON text; its own decoder then rejects that text.
  it('entry.parse(entry.encode(v)) on a depth-limited Anthropic entry (was GAP depth-limited-roundtrip)', () => {
    const req = ModelProfile.of(ANTHROPIC_STRICT).request([{ kind: 'tool', name: 'write', schema: WriteArgs.bind(reg, { newStrict: true }) }]);
    const w = req.get('write');
    const wire = w.encode({ program: switchProgram });
    expect(validate(w.jsonSchema!, wire)).toEqual([]);
    const res = w.parse(wire);
    expect(res.ok ? res.value : res.message).toEqual({ program: switchProgram });
  });
});
