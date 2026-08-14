import { describe, test, expect } from 'vitest';
import { createRegistry, Engine, Call, GetSet, Init, val, Value } from '../index';

/**
 * `Registry.augment(name, { props?, get?, call?, init? })` lets a dev
 * extend an existing built-in or registered type WITHOUT subclassing
 * or wrapping it in an Extension. The added surface flows through
 * `Type.props` / `Type.get` / `Type.call` / `Type.init`, so it shows
 * up at runtime path-walks, in static type analysis, and in
 * `toCodeDefinition` rendering.
 */
describe('Registry.augment', () => {
  test('add a method to text — visible via path access', async () => {
    const r = createRegistry();
    const e = new Engine(r);
    r.augment('text', {
      props: { shout: r.method({}, r.text(), 'text.shout') },
    });
    r.setNative('text.shout', (scope, reg) => {
      const self = scope.get('this')!.raw as string;
      return val(reg.text(), self.toUpperCase() + '!');
    });

    const program = {
      kind: 'get',
      path: [{ prop: 's' }, { prop: 'shout' }, { args: {} }],
    } as const;
    const result = await e.run(program, { s: r.text().parse('hello') });
    expect(result.raw).toBe('HELLO!');
  });

  test('augmented prop is visible in toCodeDefinition', () => {
    const r = createRegistry();
    r.augment('text', {
      props: { shout: r.method({}, r.text(), 'text.shout') },
    });
    const def = r.text().toCodeDefinition();
    expect(def).toMatch(/shout\(\): text/);
  });

  test('augmented props do NOT override intrinsic — `num.add` stays intact', () => {
    const r = createRegistry();
    r.augment('num', {
      // attempt to override num.add with a wrong-shape stub
      props: { add: r.method({}, r.text(), 'fake.add') },
    });
    const num = r.num();
    const add = num.prop('add');
    expect(add?.type.call?.()?.returns?.name).toBe('num');
  });

  test('add `get` to a type that has none — date becomes iterable', async () => {
    const r = createRegistry();
    const e = new Engine(r);
    // Loop yields three consecutive days starting from `this`.
    // `yield` is path-shaped: takes a single `{key, value}` args Value.
    r.setNative('date.dayLoop', async (scope, reg) => {
      const self = scope.get('this')!.raw as Date;
      const yieldFn = scope.get('yield')!.raw as (args: Value) => Promise<Value>;
      const indexType = reg.num({ whole: true, min: 0 });
      const dateType = reg.date();
      const argsType = reg.obj({
        key: { type: indexType }, value: { type: dateType },
      });
      const start = self.getTime();
      for (let i = 0; i < 3; i++) {
        await yieldFn(new Value(argsType as any, {
          key: val(indexType, i),
          value: val(dateType, new Date(start + i * 86400_000)),
        } as any));
      }
      return val(reg.void(), undefined);
    });
    r.augment('date', {
      get: new GetSet({
        key: r.num({ whole: true, min: 0 }),
        value: r.date(),
        loop: { kind: 'native', id: 'date.dayLoop' },
      }),
    });

    // date now reports a `get`/`loop` surface.
    const dateGet = r.date().get();
    expect(dateGet).toBeDefined();
    expect(dateGet?.loop?.toJSON()).toEqual({ kind: 'native', id: 'date.dayLoop' });

    // Run a loop that collects the iteration count via a counter.
    const program = {
      kind: 'block',
      lines: [
        {
          kind: 'define',
          vars: [
            { name: 'count', value: { kind: 'new', type: { name: 'num', options: { whole: true, min: 0 } }, value: 0 } },
          ],
          body: {
            kind: 'block',
            lines: [
              {
                kind: 'loop',
                over: { kind: 'get', path: [{ prop: 'd' }] },
                body: {
                  kind: 'set',
                  path: [{ prop: 'count' }],
                  value: {
                    kind: 'get',
                    path: [
                      { prop: 'count' }, { prop: 'add' },
                      { args: { other: { kind: 'new', type: { name: 'num' }, value: 1 } } },
                    ],
                  },
                },
              },
              { kind: 'get', path: [{ prop: 'count' }] },
            ],
          },
        },
      ],
    } as const;
    const result = await e.run(program, {
      d: r.date().parse(new Date('2026-01-01')),
    });
    expect(result.raw).toBe(3);
  });

  test('add `call` to a type that has none — make timestamp callable', () => {
    const r = createRegistry();
    r.augment('timestamp', {
      call: new Call({
        args: r.obj({ offsetDays: { type: r.num() } }) as any,
        returns: r.timestamp(),
      }),
    });
    const ts = r.timestamp();
    const call = ts.call();
    expect(call).toBeDefined();
    expect(call?.returns?.name).toBe('timestamp');
  });

  test('augmented `init` — `new <type>(args)` invokes the init expression', async () => {
    // `text` doesn't have a native init. Augment it with one that
    // formats `{name, count}` args into a custom string.
    const r = createRegistry();
    const e = new Engine(r);
    r.setNative('text.greet.init', (scope, reg) => {
      const args = scope.get('args')!.raw as Record<string, Value>;
      const name = args['name']!.raw as string;
      const count = args['count']!.raw as number;
      return val(reg.text(), `Hello ${name} x${count}`);
    });
    r.augment('text', {
      init: new Init({
        args: r.obj({
          name: { type: r.text() },
          count: { type: r.num({ whole: true, min: 1 }) },
        }) as any,
        run: { kind: 'native', id: 'text.greet.init' },
      }),
    });

    // `new text { name: "World", count: 3 }` should call init.run with
    // `args` bound and return its result as a text Value.
    const program = {
      kind: 'new',
      type: { name: 'text' },
      value: { name: 'World', count: 3 },
    } as const;
    const result = await e.run(program);
    expect(result.raw).toBe('Hello World x3');
  });

  test('augmentation is also picked up by Extensions over the augmented type', () => {
    const r = createRegistry();
    r.augment('num', {
      props: { stamp: r.method({}, r.text(), 'num.stamp') },
    });
    const positiveInt = r.extend(r.num({ whole: true, min: 1 }), {
      name: 'PositiveInt',
    });
    r.register(positiveInt);
    expect(positiveInt.prop('stamp')).toBeDefined();
  });

  test('custom loop Expr (non-native) — augmented type drives iteration via path-callable yield', async () => {
    // Augment `num` with a SECOND loop shape via Extension — actually,
    // simpler: register a fresh `Pair` type whose `loop` is a plain
    // `block` that calls `yield(...)` twice via path. The path-callable
    // yield (an obj `{key, value}` arg) is what makes a non-native
    // loop ExprDef expressible. This is THE thing custom loops need:
    // a path-shaped yield Value sitting in scope.
    const r = createRegistry();
    const e = new Engine(r);

    // A custom loop ExprDef — a `block` of two `get` paths that each
    // call `yield({ key: <i>, value: <text> })`. No natives involved.
    const customLoop = {
      kind: 'block',
      lines: [
        {
          kind: 'get',
          path: [
            { prop: 'yield' },
            {
              args: {
                key: { kind: 'new', type: { name: 'num' }, value: 0 },
                value: { kind: 'new', type: { name: 'text' }, value: 'first' },
              },
            },
          ],
        },
        {
          kind: 'get',
          path: [
            { prop: 'yield' },
            {
              args: {
                key: { kind: 'new', type: { name: 'num' }, value: 1 },
                value: { kind: 'new', type: { name: 'text' }, value: 'second' },
              },
            },
          ],
        },
      ],
    };

    // Augment `text` with a loop that yields these two pairs whenever
    // any text Value is iterated. (Replacing text's intrinsic
    // `text.chars` is fine here because augmentation only fills gaps —
    // text already has `get`, so this augmentation's `get` is dead;
    // pick a type that has NONE instead.)
    r.augment('null', {
      get: new GetSet({
        key: r.num({ whole: true, min: 0 }),
        value: r.text(),
        loop: customLoop as any,
      }),
    });

    // Run a loop over null. The custom loop should yield two pairs.
    const program = {
      kind: 'define',
      vars: [
        { name: 'collected', value: { kind: 'new', type: { name: 'list', generic: { V: { name: 'text' } } }, value: [] } },
      ],
      body: {
        kind: 'block',
        lines: [
          {
            kind: 'loop',
            over: { kind: 'new', type: { name: 'null' } },
            body: {
              kind: 'get',
              path: [
                { prop: 'collected' }, { prop: 'push' },
                { args: { value: { kind: 'get', path: [{ prop: 'value' }] } } },
              ],
            },
          },
          { kind: 'get', path: [{ prop: 'collected' }] },
        ],
      },
    } as const;
    const v = await e.run(program);
    const raw = (v.raw as Value[]).map((x) => x.raw);
    expect(raw).toEqual(['first', 'second']);
  });

  test('augmented `init` shapes the `new` value schema', () => {
    // The `value` slot of a `new T(args)` expression should match
    // `init.args` whenever T has init defined — augmented or
    // intrinsic. Verified by inspecting the Zod shape of the
    // type's `toNewSchema()`.
    const r = createRegistry();
    r.augment('text', {
      init: new Init({
        args: r.obj({
          name: { type: r.text() },
          count: { type: r.num({ whole: true, min: 1 }) },
        }) as any,
        run: { kind: 'native', id: 'text.greet.init' },
      }),
    });

    // Build a synthetic SchemaOptions just rich enough for toNewSchema.
    const opts = {
      Type: r.any() as any,
      Expr: r.any() as any,
      types: [],
      exprs: [],
      registry: r,
    } as any;

    const schema = r.text().toNewSchema(opts);
    // Should accept the init.args shape (and reject mismatched).
    expect(schema.safeParse({ name: 'World', count: 3 }).success).toBe(true);
    expect(schema.safeParse('plain string').success).toBe(false);
    expect(schema.safeParse({ name: 'World' }).success).toBe(false); // count missing
  });

  test('intrinsic init also flows through (duration, color)', async () => {
    // `duration.init.args` is `{days?, hours?, minutes?, seconds?, ms?}`.
    // After the base `Type.toNewSchema` change, both static AND instance
    // schemas should reflect this — not the legacy bare-number form.
    const r = createRegistry();
    const opts = {
      Type: r.any() as any, Expr: r.any() as any,
      types: [], exprs: [], registry: r,
    } as any;
    const dSchema = r.duration().toNewSchema(opts);
    expect(dSchema.safeParse({ days: 1, hours: 2 }).success).toBe(true);
    expect(dSchema.safeParse(1234).success).toBe(false);

    // Color too — init.args is {r, g, b, a?}.
    const cSchema = r.color().toNewSchema(opts);
    expect(cSchema.safeParse({ r: 255, g: 0, b: 0 }).success).toBe(true);
    expect(cSchema.safeParse(0xff0000ff).success).toBe(false);
  });

  test('repeated augment calls MERGE props, get/call/init are first-wins', () => {
    const r = createRegistry();
    r.augment('text', { props: { a: r.method({}, r.text(), 'a.id') } });
    r.augment('text', { props: { b: r.method({}, r.text(), 'b.id') } });
    const props = r.text().props();
    expect(props['a']).toBeDefined();
    expect(props['b']).toBeDefined();

    // First `init` wins; second is silently dropped.
    const init1 = new Init({
      args: r.obj({}) as any,
      run: { kind: 'native', id: 'init.first' },
    });
    const init2 = new Init({
      args: r.obj({}) as any,
      run: { kind: 'native', id: 'init.second' },
    });
    r.augment('text', { init: init1 });
    r.augment('text', { init: init2 });
    const eff = r.text().init();
    expect(eff?.run.toJSON()).toEqual({ kind: 'native', id: 'init.first' });
  });
});

/**
 * An augmentation on a NAMED Extension must reach `toCodeDefinition` —
 * that print is the whole description of the type a model gets, so a
 * surface that exists at run time and not in the print is a capability
 * the model cannot know about.
 *
 * The motivating case, measured: a `resource` handle (an Extension over
 * an anonymous `obj`) carried its four methods by `augment`, because the
 * bare `{ id }` handle is its VALUE contract — a local prop would land
 * in `toValueSchema` and stop that handle parsing. `props()` answered the
 * methods, the definition showed none of them, and the one native with
 * behaviour reached the model as data fields and nothing to call.
 *
 * Two properties constrain the fix and are pinned below: the body still
 * shows only what this type ADDS (a base's surface stays implicit under
 * `extends`), and `toJSON` / `toValueSchema` are untouched — an
 * augmentation is registry-side surface, never wire shape.
 */
describe('augmentation on a named Extension reaches the definition print', () => {
  /** The product's `resource` in miniature: a named handle over an
   *  anonymous obj, with its behaviour attached by `augment`. */
  const resourceFixture = () => {
    const r = createRegistry();
    const resource = r.extend(
      r.obj({ id: { type: r.text() }, title: { type: r.optional(r.text()) } }),
      { name: 'resource', docs: 'a stored file' },
    );
    r.register(resource);
    r.augment('resource', {
      props: {
        markdown: r.method({}, r.text(), 'resource.markdown', { docs: 'the file as markdown' }),
        url: r.method({}, r.text(), 'resource.url'),
      },
    });
    return { r, resource };
  };

  test('EXTENSION arm — augmented props render as methods, after the base fields', () => {
    const { resource } = resourceFixture();
    expect(resource.toCodeDefinition()).toBe(
      [
        '/// a stored file',
        'type resource extends obj {',
        '  id: text',
        '  title?: text',
        '  /// the file as markdown',
        '  markdown(): text',
        '  url(): text',
        '}',
      ].join('\n'),
    );
  });

  test('BUILT-IN arm — the arm that already worked keeps working', () => {
    const r = createRegistry();
    r.augment('num', { props: { doubled: r.method({}, r.num(), 'num.doubled') } });
    expect(r.num().toCodeDefinition()).toContain('  doubled(): num\n');
  });

  test('a local prop SHADOWS an augmented one of the same name — printed once', () => {
    const r = createRegistry();
    r.augment('resource', { props: { url: r.method({}, r.text(), 'resource.url') } });
    const resource = r.extend(r.obj({ id: { type: r.text() } }), {
      name: 'resource',
      props: { url: { type: r.text() } },
    });
    r.register(resource);
    const def = resource.toCodeDefinition();
    // The local wins, exactly as `props()` composes it — the augmented
    // method must not ALSO print, or the type would declare `url` twice.
    expect(def).toContain('  url: text\n');
    expect(def).not.toContain('url()');
    expect(def.match(/\burl\b/g)).toHaveLength(1);
  });

  test('an augmentation on the BASE\'s name stays implicit under `extends`', () => {
    const r = createRegistry();
    r.augment('num', { props: { stamp: r.method({}, r.text(), 'num.stamp') } });
    const positive = r.extend(r.num({ whole: true, min: 1 }), { name: 'PositiveInt' });
    r.register(positive);
    // It IS part of the effective surface (that is `props()`' job)…
    expect(positive.prop('stamp')).toBeDefined();
    // …but the definition body shows only what THIS type adds; `stamp`
    // belongs to `num` and is reachable under the base's own name.
    expect(positive.toCodeDefinition()).toBe('type PositiveInt extends num{whole=true, min=1} {}');
  });

  test('augmented get / call / init reach the definition too', () => {
    const r = createRegistry();
    const handle = r.extend(r.obj({ id: { type: r.text() } }), { name: 'handle' });
    r.register(handle);
    r.augment('handle', {
      get: new GetSet({ key: r.text(), value: r.text() }),
      call: new Call({ args: r.obj({ n: { type: r.num() } }), returns: r.text() }),
      init: new Init({ args: r.obj({ path: { type: r.text() } }), run: r.nativeExpr('handle.init') }),
    });
    expect(handle.toCodeDefinition()).toBe(
      [
        'type handle extends obj {',
        '  new(path: text)',
        '  (n: num): text',
        '  [key: text]: text',
        '  id: text',
        '}',
      ].join('\n'),
    );
  });

  test('the WIRE form is untouched — parse(toJSON()) is an equal type', () => {
    const { r, resource } = resourceFixture();
    const json = resource.toJSON();
    // An augmentation is registry-side surface, so it must not leak into
    // the def; a consumer reloading this def in a registry WITHOUT the
    // augmentation would otherwise get props it cannot dispatch.
    expect(Object.keys(json.props ?? {})).toEqual(['id', 'title']);
    const back = r.parse(json);
    expect(back.toJSON()).toEqual(json);
    expect(back.toCode()).toBe(resource.toCode());
    // Reloaded in the SAME registry the augmentation is registered in,
    // the print comes back identical — the print reads the registry.
    expect(back.toCodeDefinition()).toBe(resource.toCodeDefinition());
  });

  test('toValueSchema accepts exactly what it accepted before — a bare handle', () => {
    const { resource } = resourceFixture();
    const schema = resource.toValueSchema();
    // The bare `{ id }` handle is the value contract. This is the whole
    // reason the methods live on the augmentation and not in `local.props`
    // (a local method prop enters the value schema and breaks this), so
    // the definition fix had to leave the schema alone.
    expect(schema.parse({ id: 'x' })).toEqual({ id: 'x' });
    expect(schema.safeParse({ id: 'x', title: 't' }).success).toBe(true);
    expect(schema.safeParse({ title: 't' }).success).toBe(false);
    // …and the augmented methods are NOT members of the value.
    expect(Object.keys(schema.parse({ id: 'x' }) as object)).toEqual(['id']);
  });

  test('the effective surface and the printed one agree', () => {
    const { resource } = resourceFixture();
    const def = resource.toCodeDefinition();
    for (const name of ['markdown', 'url']) {
      expect(resource.prop(name)).toBeDefined();
      expect(def).toContain(`${name}(): text`);
    }
  });
});
