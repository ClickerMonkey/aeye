import { describe, test, expect } from 'vitest';
import ts from 'typescript';
import {
  createRegistry, Engine, joinTypeScript, renderTypeScriptFile, renderTypeScriptTypes,
  TypeScriptExportError, type TypeScriptOptions, type TypeScriptOutput, type Registry, type Type,
} from '../index';
import type { ExprDef, TypeDef } from '../schema';

// ─── compile + run harness ─────────────────────────────────────────────────

const COMPILER: ts.CompilerOptions = {
  strict: true,
  noEmit: true,
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.CommonJS,
  lib: ['lib.es2022.d.ts'],
  types: [],
  skipLibCheck: true,
};

/** Type-check in-memory files; return the diagnostics as text. */
function typecheck(files: Record<string, string>): string[] {
  const host = ts.createCompilerHost(COMPILER);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (name, lang, ...rest) =>
    name in files ? ts.createSourceFile(name, files[name]!, lang) : getSourceFile(name, lang, ...rest);
  const readFile = host.readFile.bind(host);
  host.readFile = (name) => files[name] ?? readFile(name);
  const fileExists = host.fileExists.bind(host);
  host.fileExists = (name) => name in files || fileExists(name);
  const program = ts.createProgram(Object.keys(files), COMPILER, host);
  return ts.getPreEmitDiagnostics(program).map((d) => {
    const msg = ts.flattenDiagnosticMessageText(d.messageText, '\n');
    if (!d.file || d.start === undefined) return msg;
    const { line } = d.file.getLineAndCharacterOfPosition(d.start);
    return `${d.file.fileName}:${line + 1}: ${msg}\n    ${d.file.text.split('\n')[line]}`;
  });
}

/** Type-check a file (failing the test with the source on errors), then run it and return its exports. */
function load(source: string): Record<string, any> {
  const errors = typecheck({ 'out.ts': source });
  if (errors.length) throw new Error(`TypeScript errors:\n${errors.join('\n')}\n\n--- source ---\n${number(source)}`);
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports: Record<string, any> = {};
  new Function('exports', 'require', js)(exports, () => { throw new Error('no require in generated code'); });
  return exports;
}

function number(src: string): string {
  return src.split('\n').map((l, i) => `${String(i + 1).padStart(3)} ${l}`).join('\n');
}

// ─── ExprDef shorthands ────────────────────────────────────────────────────

const T = (name: string, extra: Record<string, unknown> = {}): TypeDef => ({ name, ...extra } as TypeDef);
const num = (value: number): ExprDef => ({ kind: 'new', type: T('num'), value });
const text = (value: string): ExprDef => ({ kind: 'new', type: T('text'), value });
const bool = (value: boolean): ExprDef => ({ kind: 'new', type: T('bool'), value });
const list = (item: TypeDef, value: unknown[]): ExprDef => ({ kind: 'new', type: T('list', { generic: { V: item } }), value });
type Step = string | { args: Record<string, ExprDef> } | { key: ExprDef };
const get = (...steps: Step[]): ExprDef => ({
  kind: 'get',
  path: steps.map((s) => (typeof s === 'string' ? { prop: s } : s)) as any,
});
const call = (args: Record<string, ExprDef> = {}): { args: Record<string, ExprDef> } => ({ args });
const set = (path: Step[], value: ExprDef): ExprDef => ({ kind: 'set', path: (get(...path) as any).path, value });
const obj = (props: Record<string, TypeDef>): TypeDef =>
  T('obj', { props: Object.fromEntries(Object.entries(props).map(([k, t]) => [k, { type: t }])) });
const fnType = (args: Record<string, TypeDef>, returns?: TypeDef): TypeDef =>
  T('fn', { call: { args: obj(args), ...(returns ? { returns } : {}) } });
const lambda = (args: Record<string, TypeDef>, returns: TypeDef | undefined, body: ExprDef): ExprDef =>
  ({ kind: 'lambda', type: fnType(args, returns), body } as ExprDef);
const define = (vars: Array<[string, ExprDef, TypeDef?]>, body: ExprDef): ExprDef =>
  ({ kind: 'define', vars: vars.map(([name, value, type]) => ({ name, value, ...(type ? { type } : {}) })), body } as ExprDef);
const block = (...lines: ExprDef[]): ExprDef => ({ kind: 'block', lines });
const iff = (cond: ExprDef, then: ExprDef, otherwise?: ExprDef): ExprDef =>
  ({ kind: 'if', ifs: [{ condition: cond, body: then }], ...(otherwise ? { else: otherwise } : {}) } as ExprDef);
const loop = (over: ExprDef, body: ExprDef, extra: Record<string, unknown> = {}): ExprDef =>
  ({ kind: 'loop', over, body, ...extra } as ExprDef);
const flow = (action: string, extra: Record<string, unknown> = {}): ExprDef => ({ kind: 'flow', action, ...extra } as ExprDef);
const tmpl = (template: string, params?: ExprDef): ExprDef => ({ kind: 'template', template, ...(params ? { params } : {}) } as ExprDef);
/** A callback for list.map / filter / … — `(args: { value, index })`. */
const each = (V: TypeDef, returns: TypeDef, body: ExprDef): ExprDef => lambda({ value: V, index: T('num') }, returns, body);

// ─── fixtures ──────────────────────────────────────────────────────────────

/** A registry with a few named types: Person (gin-written members), Customer (a host method), Box<T>. */
function fixture(): { r: Registry; e: Engine } {
  const r = createRegistry();
  const Person = r.extend(r.obj({
    firstName: { type: r.text(), docs: 'Given name.' },
    lastName: { type: r.text() },
    age: { type: r.num({ min: 0, whole: true }) },
    nick: { type: r.optional(r.text()) },
  }), {
    name: 'Person',
    docs: 'Someone we know.',
    props: {
      fullName: {
        docs: 'First and last name.',
        type: r.fn({ args: r.obj({}), returns: r.text() }),
        get: r.parseExpr(tmpl('{first} {last}', {
          kind: 'new', type: obj({ first: T('text'), last: T('text') }),
          value: { first: get('this', 'firstName'), last: get('this', 'lastName') },
        } as ExprDef)),
      },
      isAdult: {
        type: r.bool(),
        get: r.parseExpr(get('this', 'age', 'gte', call({ other: num(18) }))),
      },
      greet: {
        type: r.fn({ args: r.obj({ greeting: { type: r.text() } }), returns: r.text() }),
        get: r.parseExpr(get('args', 'greeting', 'concat', call({ other: tmpl(', {name}!', {
          kind: 'new', type: obj({ name: T('text') }), value: { name: get('this', 'fullName') },
        } as ExprDef) }))),
      },
    },
  });
  r.register(Person);

  const Customer = r.extend(r.obj({ id: { type: r.text() }, plan: { type: r.enum(['free', 'pro']) } }), {
    name: 'Customer',
    props: { upgrade: r.method({ plan: r.text() }, r.bool(), 'Customer.upgrade', { docs: 'Move to another plan.' }) },
  });
  r.register(Customer);
  r.setNative('Customer.upgrade', async (scope, reg) => {
    const self = scope.get('this')!;
    const plan = (scope.get('args')!.raw as any).plan.raw;
    (self.raw as any).plan = reg.text().parse(plan);
    return reg.bool().parse(true);
  });

  const Box = r.extend('obj', {
    name: 'Box',
    generic: { V: r.alias('V') },
    props: { value: { type: r.alias('V') }, label: { type: r.text() } },
  });
  r.register(Box);

  const e = new Engine(r);
  e.registerGlobal('taxRate', { type: r.num(), value: 0.25, docs: 'Sales tax as a fraction.' });
  return { r, e };
}

/** Export one lambda, run it both ways on `args` (gin JSON), and expect the same result. */
async function parity(e: Engine, def: ExprDef, args: Record<string, unknown>, options: TypeScriptOptions = {}): Promise<{ out: TypeScriptOutput; result: unknown }> {
  const out = e.toTypeScript(def, { name: 'fn', export: true, ...options });
  const mod = load(renderTypeScriptFile(out));
  const fnValue = await e.run(def);
  const argsType = fnValue.type.call()!.args as Type;
  const argsValue = argsType.parse(args);
  const expected = (await (fnValue.raw as (a: unknown) => Promise<any>)(argsValue)).toLogical();
  const actual = await mod.fn(argsValue.toLogical(), { taxRate: 0.25 });
  expect(plain(actual)).toEqual(plain(expected));
  return { out, result: actual };
}

/** Compare data only: functions dropped, Maps / Dates kept comparable. */
function plain(v: unknown): unknown {
  if (v instanceof Map) return { $map: [...v].map(([k, x]) => [plain(k), plain(x)]) };
  if (v instanceof Date) return { $date: v.toISOString() };
  if (Array.isArray(v)) return v.map(plain);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).filter(([, x]) => typeof x !== 'function' && x !== undefined).map(([k, x]) => [k, plain(x)]));
  }
  return v;
}

// ─── tests ─────────────────────────────────────────────────────────────────

describe('gin → TypeScript: expressions run the same as engine.run', () => {
  test('arithmetic on args, with a declared return type', async () => {
    const { e } = fixture();
    const def = lambda({ a: T('num'), b: T('num') }, T('num'),
      get('args', 'a', 'add', call({ other: get('args', 'b') }), 'mul', call({ other: num(2) })));
    const { out, result } = await parity(e, def, { a: 3, b: 4 });
    expect(result).toBe(14);
    expect(out.code).toContain('export async function fn(args: { a: number; b: number }): Promise<number>');
    expect(out.types.size).toBe(0);
  });

  test('list pipeline: filter → map → reduce, join, contains, sort', async () => {
    const { e } = fixture();
    const nums = T('list', { generic: { V: T('num') } });
    const def = lambda({ xs: nums }, undefined, define([
      ['evens', get('args', 'xs', 'filter', call({ fn: each(T('num'), T('bool'), get('args', 'value', 'isEven')) }))],
      ['squares', get('evens', 'map', { args: { fn: each(T('num'), T('num'), get('args', 'value', 'mul', call({ other: get('args', 'value') }))) }, generic: { R: T('num') } } as any)],
      ['total', get('squares', 'reduce', { args: {
        fn: lambda({ acc: T('num'), value: T('num'), index: T('num') }, T('num'), get('args', 'acc', 'add', call({ other: get('args', 'value') }))),
        initial: num(0),
      }, generic: { R: T('num') } } as any)],
    ], {
      kind: 'new', type: obj({ total: T('num'), text: T('text'), has4: T('bool'), sorted: nums, first: T('optional', { generic: { T: T('any') } }) }),
      value: {
        total: get('total'),
        text: get('squares', 'join', call({ separator: text('+') })),
        has4: get('evens', 'contains', call({ value: num(4) })),
        sorted: get('args', 'xs', 'sort', call({ fn: lambda({ a: T('num'), b: T('num') }, T('num'), get('args', 'b', 'sub', call({ other: get('args', 'a') }))) })),
        first: get('squares', 'first'),
      },
    } as ExprDef));
    const { result } = await parity(e, def, { xs: [5, 2, 8, 3, 4] });
    expect(result).toEqual({ total: 84, text: '4+64+16', has4: true, sorted: [8, 5, 4, 3, 2], first: 4 });
  });

  test('control flow: define, if as a value, loops with break / continue, set', async () => {
    const { e } = fixture();
    const nums = T('list', { generic: { V: T('num') } });
    const def = lambda({ xs: nums, limit: T('num') }, T('obj', { props: { sum: { type: T('num') }, label: { type: T('text') }, n: { type: T('num') } } }), define([
      ['sum', num(0)],
      ['count', num(0)],
    ], block(
      loop(get('args', 'xs'), block(
        iff(get('value', 'isOdd'), flow('continue')),
        iff(get('sum', 'gt', call({ other: get('args', 'limit') })), flow('break')),
        set(['sum'], get('sum', 'add', call({ other: get('value') }))),
      )),
      loop(num(3), set(['count'], get('count', 'add', call({ other: get('key') })))),
      {
        kind: 'new', type: obj({ sum: T('num'), label: T('text'), n: T('num') }),
        value: {
          sum: get('sum'),
          label: iff(get('sum', 'gt', call({ other: num(10) })), text('big'), text('small')),
          n: get('count'),
        },
      } as ExprDef,
    )));
    const { result } = await parity(e, def, { xs: [2, 3, 4, 6, 8, 10, 12], limit: 9 });
    // 2 + 4 + 6, then 12 > 9 breaks before 8 is added; the 3 is skipped.
    expect(result).toEqual({ sum: 12, label: 'big', n: 3 });
  });

  test('an if whose branch needs statements becomes an if-chain into a temp', async () => {
    const { e } = fixture();
    const def = lambda({ n: T('num') }, T('num'),
      get('args', 'n', 'add', call({
        other: iff(get('args', 'n', 'gt', call({ other: num(0) })),
          define([['x', get('args', 'n', 'mul', call({ other: num(10) }))]], get('x', 'sub', call({ other: num(1) }))),
          num(-1)),
      })));
    const { out } = await parity(e, def, { n: 4 });
    expect(out.code).toMatch(/let v;/);
    await parity(e, def, { n: -4 });
  });

  test('switch, text natives, optional and nullable', async () => {
    const { e } = fixture();
    const def = lambda({ word: T('text'), maybe: T('optional', { generic: { T: T('text') } }) }, T('text'), define([
      ['kind', {
        kind: 'switch', value: get('args', 'word', 'lower'),
        cases: [
          { equals: [text('a'), text('e'), text('i')], body: text('vowel') },
          { equals: [text('z')], body: text('last') },
        ],
        else: text('other'),
      } as ExprDef],
    ], tmpl('{kind}:{up}:{m}:{len}', {
      kind: 'new', type: obj({ kind: T('text'), up: T('text'), m: T('text'), len: T('num') }),
      value: {
        kind: get('kind'),
        up: get('args', 'word', 'upper', 'replace', call({ search: text('A'), replacement: text('4') })),
        m: get('args', 'maybe', 'or', call({ fallback: text('none') })),
        len: get('args', 'word', 'length'),
      },
    } as ExprDef)));
    await parity(e, def, { word: 'A' });
    const { result } = await parity(e, def, { word: 'Zed', maybe: 'yes' });
    expect(result).toBe('other:ZED:yes:3');
  });

  test('maps, obj iteration, index get / set', async () => {
    const { e } = fixture();
    const M = T('map', { generic: { K: T('text'), V: T('num') } });
    const def = lambda({}, undefined, define([
      ['m', { kind: 'new', type: M, value: [['a', 1], ['b', 2]] } as ExprDef],
      ['o', { kind: 'new', type: obj({ x: T('num'), y: T('num') }), value: { x: 10, y: 20 } } as ExprDef],
      ['total', num(0)],
      ['names', list(T('text'), [])],
    ], block(
      set(['m', { key: text('c') }], num(3)),
      loop(get('m'), set(['total'], get('total', 'add', call({ other: get('value') })))),
      loop(get('o'), get('names', 'push', call({ value: get('key') }))),
      set(['o', 'y'], get('o', 'x', 'add', call({ other: get('m', { key: text('b') }) }))),
      { kind: 'new', type: obj({ total: T('num'), names: T('list', { generic: { V: T('text') } }), size: T('num'), y: T('num'), keys: T('list', { generic: { V: T('text') } }) }),
        value: { total: get('total'), names: get('names'), size: get('m', 'size'), y: get('o', 'y'), keys: get('o', 'keys') } } as ExprDef,
    )));
    const { result } = await parity(e, def, {});
    expect(result).toEqual({ total: 6, names: ['x', 'y'], size: 3, y: 12, keys: ['x', 'y'] });
  });

  test('throw is caught by a call step\'s catch; exit unwinds to the top', async () => {
    const { e } = fixture();
    const thrower = lambda({ n: T('num') }, T('num'), iff(
      get('args', 'n', 'lt', call({ other: num(0) })),
      flow('throw', { error: text('negative') }),
      get('args', 'n'),
    ));
    const def = lambda({ n: T('num') }, T('text'), define([['f', thrower]],
      block(
        iff(get('args', 'n', 'eq', call({ other: num(99) })), flow('exit', { value: text('exited') })),
        tmpl('{v}', {
          kind: 'new', type: obj({ v: T('text') }),
          value: { v: get('f', { args: { n: get('args', 'n') }, catch: { kind: 'new', type: T('num'), value: -1 } } as any, 'toText') },
        } as ExprDef),
      )));
    expect((await parity(e, def, { n: 5 })).result).toBe('5');
    expect((await parity(e, def, { n: -5 })).result).toBe('-1');
    // exit: engine.run returns the exit value; the lambda call does not catch it, so compare to the program form.
    const out = e.toTypeScript(def, { name: 'fn', export: true });
    expect(await load(renderTypeScriptFile(out)).fn({ n: 99 })).toBe('exited');
  });

  test('dates, durations and colors use the prelude', async () => {
    const { e } = fixture();
    const def = lambda({ d: T('date') }, undefined, define([
      ['dur', { kind: 'new', type: T('duration'), value: { hours: 1, minutes: 30 } } as ExprDef],
      ['c', { kind: 'new', type: T('color'), value: { r: 255, g: 128, b: 0 } } as ExprDef],
    ], {
      kind: 'new', type: obj({ next: T('text'), dow: T('num'), dur: T('text'), hex: T('text'), light: T('text') }),
      value: {
        next: get('args', 'd', 'addMonths', call({ months: num(1) }), 'toText'),
        dow: get('args', 'd', 'dayOfWeek'),
        dur: get('dur', 'toText'),
        hex: get('c', 'toHex'),
        light: get('c', 'lighten', call({ amount: num(0.1) }), 'toHex'),
      },
    } as ExprDef));
    const { out, result } = await parity(e, def, { d: '2026-01-31' });
    expect((result as any).dur).toBe('1h 30m');
    expect([...out.helpers.keys()]).toEqual(expect.arrayContaining(['$date', '$duration', '$color']));
  });

  test('globals and run extras arrive through a typed ctx', async () => {
    const { e, r } = fixture();
    const def = lambda({ price: T('num') }, T('num'),
      get('args', 'price', 'mul', call({ other: get('taxRate', 'add', call({ other: num(1) })) })));
    const { out } = await parity(e, def, { price: 100 });
    expect(out.code).toContain('ctx: FnCtx');
    expect(out.types.get('FnCtx')).toContain('taxRate: number');
    expect(out.types.get('FnCtx')).toContain('Sales tax as a fraction.');

    // A program (not a lambda) reading a run extra.
    const program = get('greeting', 'upper');
    const prog = e.toTypeScript(program, { name: 'shout', export: true, scope: { greeting: r.text() } });
    const mod = load(renderTypeScriptFile(prog));
    expect(await mod.shout({ greeting: 'hi' })).toBe((await e.run(program, { greeting: r.text().parse('hi') })).raw);
  });
});

describe('gin → TypeScript: referenced types', () => {
  test('a named type with gin-written members gets a declaration and a makeX constructor', async () => {
    const { e } = fixture();
    const def = lambda({ first: T('text'), last: T('text') }, T('text'), define([
      ['p', { kind: 'new', type: T('Person'), value: { firstName: get('args', 'first'), lastName: get('args', 'last'), age: 30 } } as ExprDef],
    ], tmpl('{a}|{b}|{c}', {
      kind: 'new', type: obj({ a: T('text'), b: T('bool'), c: T('text') }),
      value: { a: get('p', 'fullName'), b: get('p', 'isAdult'), c: get('p', 'greet', call({ greeting: text('Hello') })) },
    } as ExprDef)));
    const { out, result } = await parity(e, def, { first: 'Ada', last: 'Lovelace' });
    expect(result).toBe('Ada Lovelace|true|Hello, Ada Lovelace!');

    const person = out.types.get('Person')!;
    expect(person).toMatch(/^\/\*\* Someone we know\. \*\/\nexport type Person = \{/);
    expect(person).toContain('/** Given name. */ firstName: string;');
    expect(person).toContain('age: number;');
    expect(person).toContain('gin: num{min=0, whole=true}');
    expect(person).toContain('nick?: string;');
    expect(person).toContain('/** First and last name. */ fullName: () => Promise<string>;');
    expect(person).toContain('readonly isAdult: boolean;');
    expect(person).toContain('greet: (args: { greeting: string }) => Promise<string>;');
    expect(person).not.toContain('interface');
    expect(out.helpers.get('makePerson')).toContain('function makePerson(data: Omit<Person, "fullName" | "isAdult" | "greet">): Person');
  });

  test('a host-native method is a member the value carries', async () => {
    const { e } = fixture();
    const def = lambda({ c: T('Customer') }, T('text'), block(
      get('args', 'c', 'upgrade', call({ plan: text('pro') })),
      get('args', 'c', 'plan'),
    ));
    const out = e.toTypeScript(def, { name: 'fn', export: true });
    expect(out.types.get('Customer')).toContain('/** Move to another plan. */ upgrade: (args: { plan: string }) => Promise<boolean>');
    expect(out.types.get('Customer')).toContain('plan: "free" | "pro"');
    expect(out.code).toContain('(await args.c.upgrade({ plan: "pro" }))');
    const mod = load(renderTypeScriptFile(out));
    const customer = { id: 'c1', plan: 'free', async upgrade(a: { plan: string }) { this.plan = a.plan; return true; } };
    expect(await mod.fn({ c: customer })).toBe('pro');
  });

  test('generic named types declare their parameters', async () => {
    const { e } = fixture();
    const BoxNum = T('Box', { generic: { V: T('num') } });
    // gin's own run cannot resolve `b.value` through the binding here, so this one
    // checks the export alone: it type-checks and runs.
    const def = lambda({ b: BoxNum }, T('num'), get('args', 'b', 'value', 'add', call({ other: num(1) })));
    const out = e.toTypeScript(def, { name: 'fn', export: true });
    expect(out.types.get('Box')).toBe('export type Box<V = any> = { value: V; label: string };');
    expect(out.code).toContain('args: { b: Box<number> }');
    expect(await load(renderTypeScriptFile(out)).fn({ b: { value: 41, label: 'x' } })).toBe(42);
  });

  test('many functions join into one file: each type once, and it all compiles and runs', async () => {
    const { e } = fixture();
    const fns: Record<string, ExprDef> = {
      fullNameOf: lambda({ p: T('Person') }, T('text'), get('args', 'p', 'fullName')),
      adults: lambda({ people: T('list', { generic: { V: T('Person') } }) }, undefined,
        get('args', 'people', 'filter', call({ fn: each(T('Person'), T('bool'), get('args', 'value', 'isAdult')) }))),
      makeOne: lambda({ name: T('text') }, T('Person'),
        { kind: 'new', type: T('Person'), value: { firstName: get('args', 'name'), lastName: 'Doe', age: 7 } } as ExprDef),
      upgradeAll: lambda({ cs: T('list', { generic: { V: T('Customer') } }) }, T('num'), block(
        loop(get('args', 'cs'), get('value', 'upgrade', call({ plan: text('pro') }))),
        get('args', 'cs', 'length'),
      )),
    };
    const outs = Object.entries(fns).map(([name, def]) => e.toTypeScript(def, { name, export: true }));
    const all = joinTypeScript(outs);
    expect([...all.types.keys()].sort()).toEqual(['Customer', 'Person']);
    expect(all.helpers.has('makePerson')).toBe(true);
    const file = renderTypeScriptFile(all);
    expect(file.match(/export type Person =/g)).toHaveLength(1);
    const mod = load(file);
    const kid = await mod.makeOne({ name: 'Kim' });
    expect(await kid.fullName()).toBe('Kim Doe');
    const ada = mod.makePerson({ firstName: 'Ada', lastName: 'L', age: 36 });
    expect(await mod.fullNameOf({ p: ada })).toBe('Ada L');
    expect((await mod.adults({ people: [kid, ada] })).map((p: any) => p.firstName)).toEqual(['Ada']);
    const cs = [{ id: 'a', plan: 'free', upgrade: async function (this: any, a: any) { this.plan = a.plan; return true; } }];
    expect(await mod.upgradeAll({ cs })).toBe(1);
    expect(cs[0]!.plan).toBe('pro');
  });

  test('the types alone compile, and a hand-written function against them runs', async () => {
    const { e } = fixture();
    const out = joinTypeScript([
      e.toTypeScript(lambda({ p: T('Person') }, T('text'), get('args', 'p', 'fullName')), { name: 'nameOf', export: true }),
      e.toTypeScript(lambda({ c: T('Customer'), b: T('Box', { generic: { V: T('text') } }) }, T('text'), get('args', 'b', 'label')), { name: 'labelOf', export: true }),
    ]);
    const types = renderTypeScriptTypes(out);
    expect(typecheck({ 'types.ts': types })).toEqual([]);

    // What a model given `types.ts` might write: only the declarations, no gin.
    const handWritten = `
export async function describe(people: Person[], box: Box<number>): Promise<string> {
  const names: string[] = [];
  for (const p of people) if (p.isAdult) names.push(await p.greet({ greeting: 'Hi' }));
  return names.join(' / ') + ' #' + (box.value + 1) + ' ' + box.label;
}`;
    const file = `${types}\n${[...out.helpers.values()].join('\n\n')}\n${handWritten}`;
    const mod = load(file);
    const people = [
      mod.makePerson({ firstName: 'Ada', lastName: 'L', age: 36 }),
      mod.makePerson({ firstName: 'Kim', lastName: 'D', age: 7 }),
    ];
    expect(await mod.describe(people, { value: 1, label: 'box' })).toBe('Hi, Ada L! #2 box');
  });
});

describe('gin → TypeScript: options', () => {
  test("async: 'auto' leaves pure code synchronous", async () => {
    const { e } = fixture();
    const nums = T('list', { generic: { V: T('num') } });
    const def = lambda({ xs: nums }, undefined,
      get('args', 'xs', 'map', { args: { fn: each(T('num'), T('num'), get('args', 'value', 'mul', call({ other: num(3) }))) }, generic: { R: T('num') } } as any));
    const { out } = await parity(e, def, { xs: [1, 2] }, { async: 'auto' });
    expect(out.code).toMatch(/^export function fn\(/);
    expect(out.code).toContain('$map(args.xs, ');
    expect(out.code).not.toContain('await');

    // ... and a host call (EXTERNAL by default) still makes it async.
    const host = lambda({ c: T('Customer') }, T('bool'), get('args', 'c', 'upgrade', call({ plan: text('pro') })));
    expect(e.toTypeScript(host, { name: 'up', async: 'auto' }).code).toMatch(/^async function up/);
  });

  test("prelude: 'inline' puts helpers in the code; types: 'none' declares nothing", () => {
    const { e } = fixture();
    const def = lambda({ p: T('Person'), xs: T('list', { generic: { V: T('num') } }) }, T('num'),
      get('args', 'xs', { key: num(0) }));
    const inline = e.toTypeScript(def, { prelude: 'inline', types: 'none' });
    expect(inline.helpers.size).toBe(0);
    expect(inline.types.size).toBe(0);
    expect(inline.code).toContain('function $listGet');
  });

  test('includeComments: false drops docs', () => {
    const { e } = fixture();
    const out = e.toTypeScript(lambda({ p: T('Person') }, T('text'), get('args', 'p', 'fullName')), { includeComments: false });
    expect(out.types.get('Person')).not.toContain('/**');
  });

  test('is<T> / as<T> use a structural guard', async () => {
    const { e } = fixture();
    // `x.is<T>()` — prop then call
    const isDef = lambda({ x: T('any') }, T('bool'), {
      kind: 'get', path: [{ prop: 'args' }, { prop: 'x' }, { prop: 'is' }, { args: {}, generic: { T: obj({ id: T('text') }) } }],
    } as ExprDef);
    const out = e.toTypeScript(isDef, { name: 'fn', export: true });
    const mod = load(renderTypeScriptFile(out));
    expect(await mod.fn({ x: { id: 'a' } })).toBe(true);
    expect(await mod.fn({ x: { id: 3 } })).toBe(false);
  });

  test('constructs with no TypeScript form are reported, not guessed', () => {
    const { e, r } = fixture();
    r.register(r.extend('obj', {
      name: 'Bag',
      props: { items: { type: r.list(r.num()) } },
      get: { key: r.num(), value: r.num(), loop: r.parseExpr({ kind: 'native', id: 'nope.loop' }) },
    } as any));
    const def = lambda({ b: T('Bag') }, undefined, loop(get('args', 'b'), get('value')));
    expect(() => e.toTypeScript(def)).toThrow(TypeScriptExportError);
  });
});
