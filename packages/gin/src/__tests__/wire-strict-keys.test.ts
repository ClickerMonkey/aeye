/**
 * Wire strictness — `registry.parse` refuses keys it would otherwise IGNORE.
 *
 * The bug this closes: every slot the parser reads has a silent default, so a
 * def whose type argument landed in the wrong slot parsed to a plausible, wrong
 * type. `{name:'list', options:{item: user}}` became `list<any>` — and unlike an
 * unbound bare name (which becomes a universal AliasType a downstream check can
 * reject) `list<any>` is NOT universal, so a component declaring it accepts
 * `list<user>` silently matched every list.
 *
 * Two halves here, and the second is the one that carries the risk: the refusals
 * below are cheap to get right, but a false refusal would break every stored def
 * in the wild — so `every legitimate wire shape still parses` walks the whole
 * built-in catalogue through `toJSON()` → `parse` and fails if a class is added
 * without a case.
 */
import { describe, test, expect } from 'vitest';
import { createRegistry, BUILTIN_TYPES, TYPE_DEF_KEYS, type Registry, type Type, type TypeDef } from '../index';

/** The message of the error `fn` throws (or '' when it doesn't throw). */
function refusal(fn: () => unknown): string {
  try {
    fn();
    return '';
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

describe('unknown keys are refused', () => {
  const r = createRegistry();

  test('the mis-keyed generic that used to parse to list<any>', () => {
    // THE case. Previously: no error, and `t.item.name === 'any'`.
    const msg = refusal(() => r.parse({ name: 'list', options: { item: { name: 'text' } } }));
    expect(msg).toContain("unknown options key 'item'");
    // The correction: say where the value was actually supposed to go.
    expect(msg).toContain('`generic` (V)');
    expect(msg).toContain('valid options for \'list\': minLength, maxLength');
  });

  test('the same mistake one level out — a type argument at the top level', () => {
    const msg = refusal(() => r.parse({ name: 'list', item: { name: 'text' } } as unknown as TypeDef));
    expect(msg).toContain("type 'list' has unknown key 'item'");
    expect(msg).toContain('`generic` (V)');
  });

  test('a wrongly NAMED generic parameter — the other route to list<any>', () => {
    const msg = refusal(() => r.parse({ name: 'list', generic: { item: { name: 'text' } } }));
    expect(msg).toContain("unknown generic parameter 'item'");
    expect(msg).toContain("valid generic parameters for 'list': V");
  });

  test('a map keyed on the wrong parameter names', () => {
    const msg = refusal(() => r.parse({ name: 'map', generic: { key: { name: 'text' }, value: { name: 'num' } } }));
    expect(msg).toContain("unknown generic parameter 'key'");
    expect(msg).toContain("valid generic parameters for 'map': K, V");
  });

  test('generic offered to a type that has no type parameters', () => {
    const msg = refusal(() => r.parse({ name: 'text', generic: { V: { name: 'num' } } }));
    expect(msg).toContain("unknown generic parameter 'V'");
    expect(msg).toContain("'text' is not generic");
  });

  test('options offered to a type that takes none', () => {
    const msg = refusal(() => r.parse({ name: 'obj', props: {}, options: { fields: {} } }));
    expect(msg).toContain("unknown options key 'fields'");
    expect(msg).toContain("'obj' takes no options");
  });

  test('a misspelt option names the option it meant', () => {
    // `didYouMean` is the whole correction — the valid-key list is dropped when
    // a single candidate is a genuine typo.
    expect(refusal(() => r.parse({ name: 'text', options: { minLenght: 3 } })))
      .toBe("registry.parse: type 'text' has unknown options key 'minLenght' — did you mean `minLength`?");
  });

  test("an interface's props at the top level, which is how a builder call gets typo'd", () => {
    const msg = refusal(() => r.parse({
      name: 'interface',
      lat: { type: { name: 'num' } },
      lng: { type: { name: 'num' } },
    } as unknown as TypeDef));
    expect(msg).toContain("type 'interface' has unknown key 'lat'");
    expect(msg).toContain('that value is a PropDef — declare it under `props`');
  });

  test('an enum whose constants were hung off `text` — found in live data', () => {
    // 9 of these were sitting in the product's dev DB, every one parsed as an
    // unconstrained text: the status column accepted any string at all, and its
    // stored set did not even list a value two live rows held.
    const msg = refusal(() => r.parse({ name: 'text', options: { values: ['todo', 'in_progress', 'done'] } }));
    expect(msg).toContain("unknown options key 'values'");
    // The correction names the CONSTRUCT, not just the bad key — and hands back
    // the author's own members already respelled, so the fix is one turn.
    expect(msg).toContain('a closed set of constants is an `enum` in gin, not an option');
    expect(msg).toContain(JSON.stringify(
      r.enum({ todo: 'todo', in_progress: 'in_progress', done: 'done' }, r.text()).toJSON(),
    ));
    // …and that example parses, which is the whole point of a signpost.
    expect(() => r.parse(JSON.parse(msg.slice(msg.indexOf('{"name":"enum"'), msg.indexOf('}}}') + 3)))).not.toThrow();
  });

  test('a closed set of numbers is respelled as a num-valued enum', () => {
    const msg = refusal(() => r.parse({ name: 'num', options: { choices: [1, 2, 3] } }));
    expect(msg).toContain(JSON.stringify(r.enum({ 1: 1, 2: 2, 3: 3 }, r.num()).toJSON()));
  });

  test('a set already keyed as a record is respelled too', () => {
    const msg = refusal(() => r.parse({ name: 'text', options: { oneOf: { todo: 'todo', done: 'done' } } }));
    expect(msg).toContain(JSON.stringify(r.enum({ todo: 'todo', done: 'done' }, r.text()).toJSON()));
  });

  test('a long set names the construct without dumping every member', () => {
    const many = Array.from({ length: 40 }, (_, i) => `v${i}`);
    const msg = refusal(() => r.parse({ name: 'text', options: { values: many } }));
    expect(msg).toContain('a closed set of constants is an `enum` in gin, not an option');
    expect(msg).not.toContain('v39');
    expect(msg.length).toBeLessThan(250);
  });

  test('the enum signpost does not fire where a payload of TYPES belongs', () => {
    // `or` / `and` / `tuple` carry TypeDefs in options; only a set of primitives
    // on a NON-generic class is an enum in disguise.
    const msg = refusal(() => r.parse({ name: 'or', options: { variants: [{ name: 'text' }] } }));
    expect(msg).toContain("unknown options key 'variants'");
    expect(msg).not.toContain('enum');
  });

  test("optional's inner type in an invented key — also found in live data", () => {
    const msg = refusal(() => r.parse({ name: 'optional', inner: { name: 'num' } } as unknown as TypeDef));
    expect(msg).toContain("type 'optional' has unknown key 'inner'");
    expect(msg).toContain('`generic` (T)');
  });

  test('an unknown key on an EXTENDS def is checked against the base class', () => {
    const msg = refusal(() => r.parse({ name: 'Email', extends: 'text', options: { patern: '@' } }));
    expect(msg).toContain("unknown options key 'patern'");
    expect(msg).toContain('did you mean `pattern`?');
  });

  test('what the refusal replaces: the two fates of an ignored key', () => {
    // Pinned because they are the ARGUMENT for erroring rather than tolerating.
    // Neither behaviour is forward-compatibility, and each is invisible to the
    // author in a different way — so a `strict` opt-out would just be a switch
    // for turning one of them back on.
    //
    //   top-level  → DROPPED: `{name:'optional', inner:{…}}` re-serializes as
    //                `optional<any>`, the intent gone without a trace.
    //   options    → PRESERVED: `{name:'text', options:{values:[…]}}` keeps
    //                `values` through `toJSON` while validating nothing, so the
    //                author reads a closed set back that never closed anything.
    expect(refusal(() => r.parse({ name: 'optional', inner: { name: 'num' } } as unknown as TypeDef))).not.toBe('');
    expect(refusal(() => r.parse({ name: 'text', options: { values: ['todo'] } }))).not.toBe('');
    // Nothing gin CAN build carries either shape: `toJSON` of a real type only
    // ever emits declared keys, so the refusal closes the only door in.
    expect(r.optional(r.num()).toJSON()).toEqual({ name: 'optional', generic: { T: { name: 'num' } } });
    expect(Object.keys(r.text({ minLength: 1 }).toJSON().options as object)).toEqual(['minLength']);
  });

  test('the message stays small — this is an agent correction loop, not a dump', () => {
    // The longest refusal lists the 11 TypeDef fields; a generated zod union
    // over the same shape measures in kilobytes.
    const msg = refusal(() => r.parse({ name: 'num', nonsense: 1 } as unknown as TypeDef));
    expect(msg).toContain('valid keys: name, docs, extends, satisfies, generic, options, init, props, get, call, constraint');
    expect(msg.length).toBeLessThan(300);
  });

  test('a query/expr node in a type slot is now refused BY SHAPE, not misread', () => {
    // gin used to dispatch on `name` and read `{kind:'param', name:'title'}` as
    // the alias type `title`, silently dropping the `kind`.
    expect(refusal(() => r.parse({ kind: 'param', name: 'title' } as unknown as TypeDef)))
      .toContain("unknown key 'kind'");
  });
});

describe('every legitimate wire shape still parses', () => {
  const r = createRegistry();

  /** One canonical instance per built-in class, keyed by class NAME. */
  const specimens = (): Record<string, Type> => ({
    any: r.any(),
    void: r.void(),
    null: r.null(),
    bool: r.bool({ trueText: 'yes', falseText: 'no' }),
    num: r.num({ min: 0, max: 10, whole: true, minPrecision: 1, maxPrecision: 2, prefix: '$', suffix: 'k' }),
    text: r.text({ minLength: 1, maxLength: 8, pattern: '^a', flags: 'i' }),
    list: r.list(r.text(), { minLength: 1, maxLength: 4 }),
    map: r.map(r.text(), r.num()),
    tuple: r.tuple([r.text(), r.num()]),
    obj: r.obj({ title: { type: r.text(), docs: 'the title' } }),
    optional: r.optional(r.num()),
    nullable: r.nullable(r.num()),
    not: r.not(r.num()),
    or: r.or([r.text(), r.num()]),
    and: r.and([r.obj({ a: { type: r.text() } }), r.obj({ b: { type: r.num() } })]),
    enum: r.enum({ a: 1, b: 2 }, r.num()),
    literal: r.literal(r.text(), 'x'),
    fn: r.fn({ args: r.obj({ id: { type: r.text() } }), returns: r.bool(), throws: r.obj({ code: { type: r.num() } }) }),
    interface: r.iface({ props: { title: { type: r.text() } } }),
    typ: r.typ(r.num()),
    date: r.date({ min: '2020-01-01', max: '2030-01-01', utc: true }),
    timestamp: r.timestamp({ min: '2020-01-01', max: '2030-01-01', utc: true, precision: 's' }),
    duration: r.duration(),
    color: r.color({ hasAlpha: true }),
  });

  test('every built-in class has a specimen here', () => {
    // The regression guard on the guard: a class added to BUILTIN_TYPES without
    // a case below would ship its `optionKeys` untested.
    expect(Object.keys(specimens()).sort()).toEqual(BUILTIN_TYPES.map((c) => c.NAME).sort());
  });

  test('toJSON() → parse() → toJSON() is a fixed point for every built-in', () => {
    for (const [name, type] of Object.entries(specimens())) {
      const def = type.toJSON();
      const reparsed = refusal(() => r.parse(def));
      expect(`${name}: ${reparsed}`).toBe(`${name}: `);
      expect(r.parse(def).toJSON()).toEqual(def);
    }
  });

  test('an in-memory def carrying `options: undefined` is not a violation', () => {
    // Every `toJSON` writes its optional members unconditionally, so the key is
    // PRESENT and holds undefined until JSON.stringify erases it. Anything that
    // hands a def straight to parse without a serialization round-trip (the
    // Extension constructor does exactly that) would break on a naive check.
    expect(() => r.parse({ name: 'text', options: undefined, generic: undefined, docs: undefined })).not.toThrow();
  });

  test('every option of every options-bearing class survives, one key at a time', () => {
    // The specimens above set all options at once; this catches a key that was
    // typo'd in BOTH the class declaration and the specimen.
    const cases: Array<[string, Record<string, unknown>]> = [
      ['num', { min: 1 }], ['num', { max: 1 }], ['num', { whole: true }],
      ['num', { minPrecision: 1 }], ['num', { maxPrecision: 1 }],
      ['num', { prefix: '$' }], ['num', { suffix: 'kg' }],
      ['text', { minLength: 1 }], ['text', { maxLength: 2 }], ['text', { pattern: 'x' }], ['text', { flags: 'i' }],
      ['bool', { trueText: 'y' }], ['bool', { falseText: 'n' }],
      ['list', { minLength: 1 }], ['list', { maxLength: 2 }],
      ['color', { hasAlpha: true }],
      ['date', { min: '2020-01-01' }], ['date', { max: '2020-01-01' }], ['date', { utc: true }],
      ['timestamp', { precision: 'us' }], ['timestamp', { utc: false }],
      ['not', { excluded: { name: 'num' } }],
      ['or', { types: [{ name: 'num' }] }],
      ['and', { types: [{ name: 'num' }] }],
      ['tuple', { elements: [{ name: 'num' }] }],
      ['enum', { values: { a: 1 } }],
      ['literal', { value: 'x' }],
    ];
    for (const [name, options] of cases) {
      expect(`${name} ${JSON.stringify(options)}: ${refusal(() => r.parse({ name, options }))}`)
        .toBe(`${name} ${JSON.stringify(options)}: `);
    }
  });

  test("a fn's generics keep their DECLARED names — the class fixes no parameter set", () => {
    const fn = r.parse({
      name: 'fn',
      generic: { R: { name: 'any' }, Element: { name: 'any' } },
      call: { args: { name: 'obj', props: {} }, returns: { name: 'R' } },
    });
    expect(fn.name).toBe('fn');
    expect(Object.keys(fn.generic).sort()).toEqual(['Element', 'R']);
  });

  test('an extension DECLARES its own type parameters, so `generic` is not checked there', () => {
    const box = r.parse({
      name: 'Box',
      extends: 'obj',
      generic: { Payload: { name: 'any' } },
      props: { value: { type: { name: 'Payload' } } },
    });
    expect(box.name).toBe('Box');
  });

  test('an extension of a named type (not a class) has no statically known options', () => {
    // `Slug` is an Extension, not a class, so there is no `optionKeys` to check
    // against — the options ride through to the Extension chain's own `narrow`.
    const reg: Registry = createRegistry();
    reg.register(reg.extend(reg.text(), { name: 'Slug', options: { pattern: '^[a-z-]+$' } }));
    expect(() => reg.parse({ name: 'Sluggish', extends: 'Slug', options: { minLength: 3 } })).not.toThrow();
  });

  test('a registered named type is resolved by IDENTITY, so its slots go unchecked', () => {
    // A def naming a registered type returns that instance and consults nothing
    // else, so its structural keys are descriptive rather than ignored — the one
    // place unknown-key strictness would say the wrong thing.
    const reg: Registry = createRegistry();
    const email = reg.extend(reg.text(), { name: 'Email', options: { pattern: '@' } });
    reg.register(email);
    expect(reg.parse({ name: 'Email', options: { pattern: '@' } })).toBe(email);
  });

  test('a third-party class that declares no wire keys stays unchecked', () => {
    // `define(...)` is public. A class written against 0.3.10 has no
    // `optionKeys` / `genericKeys` and must keep parsing until it opts in.
    const reg: Registry = createRegistry();
    const AnyClass = BUILTIN_TYPES.find((c) => c.NAME === 'any')!;
    reg.define({
      NAME: 'thirdparty',
      from: (json, scope) => AnyClass.from(json, scope),
      toSchema: AnyClass.toSchema,
      toNewSchema: AnyClass.toNewSchema,
    });
    expect(() => reg.parse({ name: 'thirdparty', options: { whatever: 1 }, generic: { Z: { name: 'num' } } })).not.toThrow();
  });
});

describe('the refusal reaches the NESTED def shapes', () => {
  const r = createRegistry();

  test('a prop key gin would ignore — the mistake that left a prop untyped', () => {
    const msg = refusal(() => r.parse({ name: 'obj', props: { a: { typ: { name: 'num' } } } } as unknown as TypeDef));
    // Named by the PROP, not just "somewhere in this type".
    expect(msg).toBe("gin.parse: prop 'a' has unknown key 'typ' — did you mean `type`?");
  });

  test('a prop key that is nobody‘s typo lists the shape instead', () => {
    const msg = refusal(() => r.parse({
      name: 'obj', props: { a: { type: { name: 'num' }, required: true } },
    } as unknown as TypeDef));
    expect(msg).toContain("prop 'a' has unknown key 'required'");
    expect(msg).toContain('valid keys: docs, type, get, default, set');
  });

  test('a closed set declared as a key ON A PROP is respelled as the prop\'s TYPE', () => {
    // The same mistake as `{name:'text', options:{values:[…]}}`, one level
    // down: the set is the prop's TYPE, not a sibling of it. Measured twice
    // in a live product database, both times on a status column. Before
    // 0.4.1 the message only listed the valid keys, which names what is
    // wrong and not what to write instead.
    const msg = refusal(() => r.parse({
      name: 'obj', props: { status: { type: { name: 'text' }, values: ['todo', 'done'] } },
    } as unknown as TypeDef));
    expect(msg).toContain("prop 'status' has unknown key 'values'");
    expect(msg).toContain("a closed set of constants is the prop's TYPE in gin, not a key beside it");
    // The example is gin's OWN serialization, built through the registry, so
    // it cannot drift from the enum wire format it is describing.
    expect(msg).toContain(JSON.stringify({
      type: r.enum({ todo: 'todo', done: 'done' }, r.text()).toJSON(),
    }));
  });

  test("a NUMERIC closed set keeps the author's LABELS in the respelling", () => {
    // gin built the suggestion from the members' VALUES, so a
    // `{label → value}` record over numbers came back as `{"1":1,"9":9}` —
    // the author wrote `Low` and `High`, the correction silently deleted
    // them, and a model that pasted the suggestion back lost them from the
    // column's value set. Text sets were byte-perfect (label and value
    // coincide there), which is why this survived.
    const msg = refusal(() => r.parse({
      name: 'num', options: { values: { Low: 1, High: 9 } },
    } as unknown as TypeDef));
    expect(msg).toContain('"values":{"Low":1,"High":9}');
    expect(msg).not.toContain('"1":1');
  });

  test('...and a bare ARRAY still synthesizes labels from the values', () => {
    const msg = refusal(() => r.parse({
      name: 'text', options: { values: ['todo', 'done'] },
    } as unknown as TypeDef));
    expect(msg).toContain('"values":{"todo":"todo","done":"done"}');
  });

  test('a TypeDef payload is NOT respelled as an enum — only primitives are', () => {
    // `or` / `tuple` / `not` option payloads hold TypeDefs; the enum
    // correction must leave them alone.
    const msg = refusal(() => r.parse({
      name: 'list', options: { item: { name: 'text' } },
    } as unknown as TypeDef));
    expect(msg).not.toContain('closed set of constants');
    expect(msg).toContain('takes its type argument');
  });

  test("a misspelt `returns` used to produce a fn with NO return type", () => {
    const msg = refusal(() => r.parse({
      name: 'fn', call: { args: { name: 'obj', props: {} }, retruns: { name: 'num' } },
    } as unknown as TypeDef));
    expect(msg).toBe("gin.parse: call signature has unknown key 'retruns' — did you mean `returns`?");
  });

  test("a fn's type parameters declared on the CALL — found in gin's own fixtures", () => {
    // The demo in `code-render-demo.test.ts` carried this spelling until 0.4.0.
    // `Call.from` ignored it, and the signature type-checked anyway because the
    // unbound `{name:'T'}` inside it is a universal alias — so the fixture
    // passed while proving nothing about generics.
    const msg = refusal(() => r.parse({
      name: 'fn', call: { generic: { T: { name: 'any' } }, args: { name: 'obj', props: {} } },
    } as unknown as TypeDef));
    expect(msg).toContain("call signature has unknown key 'generic'");
    expect(msg).toContain('a fn declares its type parameters on the TYPE, not the call');
    // The correction PARSES — a signpost that doesn't is worse than none.
    expect(() => r.parse({
      name: 'fn', generic: { T: { name: 'any' } },
      call: { args: { name: 'obj', props: { x: { type: { name: 'T' } } } }, returns: { name: 'T' } },
    })).not.toThrow();
  });

  test('a get/set surface and an init constructor are checked too', () => {
    expect(refusal(() => r.parse({
      name: 'X', extends: 'obj', get: { key: { name: 'num' }, valeu: { name: 'num' } },
    } as unknown as TypeDef))).toContain("get/set surface has unknown key 'valeu'");
    expect(refusal(() => r.parse({
      name: 'X', extends: 'obj',
      init: { args: { name: 'obj', props: {} }, ruh: { kind: 'native', id: 'obj.new' } },
    } as unknown as TypeDef))).toContain("init constructor has unknown key 'ruh' — did you mean `run`?");
  });

  test('every legitimate nested shape still parses, every key at once', () => {
    expect(() => r.parse({
      name: 'Widget',
      extends: 'obj',
      props: {
        size: {
          docs: 'how big', type: { name: 'num' },
          get: { kind: 'native', id: 'num.abs' },
          set: { kind: 'native', id: 'num.abs' },
          default: { kind: 'new', type: { name: 'num' }, value: 1 },
        },
      },
      get: {
        docs: 'indexed', key: { name: 'text' }, value: { name: 'any' },
        get: { kind: 'native', id: 'object.indexGet' },
        set: { kind: 'native', id: 'object.indexSet' },
        loop: { kind: 'native', id: 'object.iterate' },
        loopDynamic: false,
      },
      call: {
        docs: 'callable', types: { Row: { name: 'num' } },
        args: { name: 'obj', props: {} }, returns: { name: 'Row' }, throws: { name: 'text' },
        get: { kind: 'native', id: 'obj.new' },
        set: { kind: 'native', id: 'obj.new' },
      },
      init: { docs: 'ctor', args: { name: 'obj', props: {} }, run: { kind: 'native', id: 'obj.new' } },
    })).not.toThrow();
  });

  test('a Prop / Call instance gin built itself is not re-scanned', () => {
    // Only AUTHORED shapes are checked: `Prop.from` runs on every prop map
    // build, and re-reading gin's own instances would spend a key scan per
    // path-walk to police shapes that cannot be wrong.
    const built = r.obj({ a: { type: r.num() } });
    expect(() => r.list(built).toJSON()).not.toThrow();
    expect(() => r.parse(built.toJSON())).not.toThrow();
  });
});

describe('a path step names exactly one form', () => {
  const r = createRegistry();

  test('the fused `{prop, args}` — 30 of 33 refusals in one measured turn', () => {
    // Parsed as a bare prop read with the arguments DROPPED, and was then
    // diagnosed as "method 'announce' needs arguments" — about the arguments
    // supplied in that very step.
    const msg = refusal(() => r.parseExpr({
      kind: 'get',
      path: [
        { prop: 'project' },
        { prop: 'announce', args: { note: { kind: 'new', type: { name: 'text' }, value: 'hi' } } },
      ],
    }));
    expect(msg).toContain("path step names 2 forms ('prop' and 'args')");
    // The fix is spelt out with the author's own prop name in it.
    expect(msg).toContain('each is its own step: [{"prop":"announce"}, {"args":{…}}]');
  });

  test('the split spelling — what the message asks for — parses', () => {
    expect(() => r.parseExpr({
      kind: 'get',
      path: [{ prop: 'project' }, { prop: 'announce' }, { args: { note: { kind: 'new', type: { name: 'text' }, value: 'hi' } } }],
    })).not.toThrow();
  });

  test('a key outside the selected form', () => {
    expect(refusal(() => r.parseExpr({ kind: 'get', path: [{ prop: 'a', catch: { kind: 'native', id: 'x' } }] })))
      .toContain("path step has unknown key 'catch'");
  });

  test('a step selecting NO form says which key it expected', () => {
    const msg = refusal(() => r.parseExpr({ kind: 'get', path: [{ arg: {} }] }));
    expect(msg).toContain('path step selects no form (keys: arg)');
    expect(msg).toContain('did you mean `args`?');
  });

  test('every legitimate step shape still parses, and round-trips', () => {
    const path = [
      { prop: 'items' },
      { key: { kind: 'new', type: { name: 'num' }, value: 0 } },
      { args: {}, generic: { R: { name: 'num' } }, catch: { kind: 'new', type: { name: 'num' }, value: 0 } },
    ];
    const expr = r.parseExpr({ kind: 'get', path });
    expect((expr.toJSON() as { path: unknown }).path).toEqual(path);
  });
});

describe('the key list mirrors the schema', () => {
  test('TYPE_DEF_KEYS covers every field a TypeDef can carry', () => {
    // The compile-time proof lives in wire.ts (`AssertCovered`); this is the
    // runtime half — a maximal def, every key populated, parsed without refusal.
    const maximal: Required<Pick<TypeDef, (typeof TYPE_DEF_KEYS)[number]>> = {
      name: 'Widget',
      docs: 'a widget',
      extends: 'obj',
      satisfies: [],
      generic: { T: { name: 'any' } },
      options: {},
      init: { args: { name: 'obj', props: {} }, run: { kind: 'native', id: 'obj.new' } },
      props: { size: { type: { name: 'num' } } },
      get: { key: { name: 'text' }, value: { name: 'any' } },
      call: { args: { name: 'obj', props: {} }, returns: { name: 'any' } },
      constraint: { kind: 'native', id: 'bool.true' },
    };
    expect(Object.keys(maximal).sort()).toEqual([...TYPE_DEF_KEYS].sort());
    expect(() => createRegistry().parse(maximal)).not.toThrow();
  });
});
