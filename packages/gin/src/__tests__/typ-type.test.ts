import { describe, test, expect } from 'vitest';
import { createRegistry } from '../registry';
import { buildSchemas } from '../schemas';
import { TypType } from '../types/typ';
import { LocalScope } from '../type-scope';

/**
 * TypType — a gin type whose runtime values ARE TypeDefs. Its generic T
 * constrains which TypeDefs are valid: only types compatible with T are
 * accepted.
 */
describe('TypType', () => {
  test('construction, toCode, toJSON, round-trip', () => {
    const r = createRegistry();
    const t = r.typ(r.num());
    expect(t).toBeInstanceOf(TypType);
    expect(t.toCode()).toBe('typ<num>');

    const json = t.toJSON();
    expect(json.name).toBe('typ');
    expect(json.generic?.T).toEqual({ name: 'num' });

    const back = r.parse(json) as TypType;
    expect(back).toBeInstanceOf(TypType);
    expect(back.constraint.name).toBe('num');
  });

  test('valid accepts compatible Type instance, rejects incompatible', () => {
    const r = createRegistry();
    const t = r.typ(r.num());
    expect(t.valid(r.num())).toBe(true);
    expect(t.valid(r.text())).toBe(false);
    expect(t.valid('oops')).toBe(false);
    expect(t.valid(null)).toBe(false);
    expect(t.valid({ name: 'num' })).toBe(false); // JSON is NOT a Type — use parse()
  });

  test('parse accepts compatible TypeDef JSON, rejects incompatible', () => {
    const r = createRegistry();
    const t = r.typ(r.num());
    expect(t.parse({ name: 'num' }).raw.name).toBe('num');
    expect(() => t.parse({ name: 'text' })).toThrow(/typ\.parse/);
    expect(() => t.parse('oops')).toThrow(/typ\.parse/);
    expect(() => t.parse(null)).toThrow(/typ\.parse/);
    expect(() => t.parse({})).toThrow(/typ\.parse/);
  });

  test('parse accepts registered Extension whose base is compatible', () => {
    const r = createRegistry();
    const Positive = r.extend(r.num(), { name: 'Positive' });
    r.register(Positive);

    const t = r.typ(r.num());
    expect(t.parse({ name: 'Positive' }).raw.name).toBe('Positive');
    expect(t.parse({ name: 'num' }).raw.name).toBe('num');
    expect(() => t.parse({ name: 'text' })).toThrow();
  });

  test('parse with list<num> accepts list-of-num TypeDef', () => {
    const r = createRegistry();
    const t = r.typ(r.list(r.num()));
    const v = t.parse({ name: 'list', generic: { V: { name: 'num' } } });
    expect(v.raw.name).toBe('list');
    expect(() => t.parse({ name: 'list', generic: { V: { name: 'text' } } })).toThrow();
  });

  test('parse result: .raw is a Type instance; encode round-trips to JSON', () => {
    const r = createRegistry();
    const t = r.typ(r.num());
    const v = t.parse({ name: 'num' });
    // .raw is now a Type instance (parse-once), not the raw JSON.
    expect(v.raw.name).toBe('num');
    expect(t.encode(v.raw)).toEqual({ name: 'num' });
  });

  test('compatible: typ<num> compat typ<num>; not compat typ<text>', () => {
    const r = createRegistry();
    expect(r.typ(r.num()).compatible(r.typ(r.num()))).toBe(true);
    expect(r.typ(r.num()).compatible(r.typ(r.text()))).toBe(false);
    expect(r.typ(r.num()).compatible(r.num())).toBe(false);
  });

  test('generic resolution: typ<R> with extra-scope R=num behaves as typ<num>', () => {
    const r = createRegistry();
    const t = r.typ(r.alias('R'));
    const local = new LocalScope(r, { R: r.num() });
    // typ<R>.parse({name:'num'}, local) — R resolves to num via the
    // extra scope, so num is a satisfying TypeDef.
    expect(t.parse({ name: 'num' }, local).raw.name).toBe('num');
    // typ<R>.parse({name:'text'}, local) — text is not num-compatible.
    expect(() => t.parse({ name: 'text' }, local)).toThrow();
  });

  test('typ<any> parse accepts any TypeDef JSON', () => {
    const r = createRegistry();
    const t = r.typ(r.any());
    expect(t.parse({ name: 'num' }).raw.name).toBe('num');
    expect(t.parse({ name: 'text' }).raw.name).toBe('text');
    expect(t.parse({ name: 'list', generic: { V: { name: 'num' } } }).raw.name).toBe('list');
    expect(() => t.parse('not an object')).toThrow();
  });

  test('toValueSchema (typ<num>) accepts {name:num} and rejects {name:text}', () => {
    const r = createRegistry();
    const t = r.typ(r.num());
    const schema = t.toValueSchema();
    expect(schema.safeParse({ name: 'num' }).success).toBe(true);
    expect(schema.safeParse({ name: 'text' }).success).toBe(false);
  });

  test('toValueSchema (typ<num>) accepts registered Extension', () => {
    const r = createRegistry();
    const Positive = r.extend(r.num(), { name: 'Positive' });
    r.register(Positive);

    const schema = r.typ(r.num()).toValueSchema();
    expect(schema.safeParse({ name: 'num' }).success).toBe(true);
    expect(schema.safeParse({ name: 'Positive' }).success).toBe(true);
    expect(schema.safeParse({ name: 'text' }).success).toBe(false);
  });

  test('toValueSchema (typ<num>) accepts inline Extension whose extends is num', () => {
    // The inline-Extension branch kicks in when typ<T>'s toValueSchema is
    // invoked with `opts`. Without opts, only the registry.like branch is
    // emitted (no inline path).
    const r = createRegistry();
    const opts = buildSchemas(r);

    const schema = r.typ(r.num()).toValueSchema(opts);
    // Inline Extension with `extends: 'num'` — valid.
    expect(schema.safeParse({ name: 'MyNum', extends: 'num' }).success).toBe(true);
    // Inline Extension with `extends: 'text'` — invalid (text isn't num-compatible).
    expect(schema.safeParse({ name: 'WeirdText', extends: 'text' }).success).toBe(false);
    // Plain registered class name still works.
    expect(schema.safeParse({ name: 'num' }).success).toBe(true);
  });
});

/**
 * typ<R> inside a fn's signature — generic R must bind through both the
 * typ type and other positions in the fn. Mirrors how fns.fetch/fns.llm use
 * `output?: typ<R>` alongside a return type of `R`.
 */
describe('TypType + generics', () => {
  test('unbound typ<R> acts as typ<any> — parse accepts any TypeDef', () => {
    const r = createRegistry();
    const t = r.typ(r.alias('R'));
    expect(t.parse({ name: 'num' }).raw.name).toBe('num');
    expect(t.parse({ name: 'text' }).raw.name).toBe('text');
    expect(t.parse({ name: 'list', generic: { V: { name: 'num' } } }).raw.name).toBe('list');
    expect(() => t.parse(null)).toThrow();
    expect(() => t.parse(42)).toThrow();
  });

  test('typ<R> with extra-scope R=num accepts num and rejects text', () => {
    const r = createRegistry();
    const unbound = r.typ(r.alias('R'));
    const local = new LocalScope(r, { R: r.num() });
    expect(unbound.parse({ name: 'num' }, local).raw.name).toBe('num');
    expect(() => unbound.parse({ name: 'text' }, local)).toThrow();
  });

  test('fn<(args{output: typ<R>}), R> with R=num scope: returns resolves to num, output to optional<typ<R>>', () => {
    const r = createRegistry();
    const fn = r.fn(
      r.obj({ output: { type: r.optional(r.typ(r.alias('R'))) } }),
      r.alias('R'),
      undefined,
      { R: r.any() },
    );
    const local = new LocalScope(r, { R: r.num() });
    const call = fn.call(local);
    expect(call).toBeTruthy();
    // Return type's resolved form is num via simplify(local).
    expect(call!.returns?.simplify(local).name).toBe('num');
    // output arg is optional<typ<R>> — outer Optional doesn't change.
    const argsType = call!.args;
    const outputProp = argsType.prop('output', local);
    expect(outputProp).toBeTruthy();
    expect(outputProp!.type.name).toBe('optional');
  });

  test('typ<R> JSON round-trips preserving the generic placeholder', () => {
    const r = createRegistry();
    const t = r.typ(r.alias('R'));
    const json = t.toJSON();
    expect(json.name).toBe('typ');
    // Bare-name form — AliasType.toJSON emits `{name: 'R'}`.
    expect(json.generic?.T).toEqual({ name: 'R' });

    const back = r.parse(json) as TypType;
    expect(back).toBeInstanceOf(TypType);
    expect(back.constraint.name).toBe('alias');
  });

  test('typ<list<R>> with extra-scope R=num: list<num> ok, list<text> rejected', () => {
    const r = createRegistry();
    const t = r.typ(r.list(r.alias('R')));
    const local = new LocalScope(r, { R: r.num() });
    expect(t.parse({ name: 'list', generic: { V: { name: 'num' } } }, local).raw.name).toBe('list');
    expect(() => t.parse({ name: 'list', generic: { V: { name: 'text' } } }, local)).toThrow();
  });
});
