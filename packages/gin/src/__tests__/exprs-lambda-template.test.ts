import { describe, test, expect } from 'vitest';
import { primitives } from './_utils';
import { createRegistry, Engine } from '../index';

describe('evalLambda + list.map', () => {
  const e = new Engine(createRegistry());

  test('list.map applies a lambda', async () => {
    // [1,2,3].map(v => v * 2) → [2,4,6]
    const program = {
      kind: 'define',
      vars: [{
        name: 'arr',
        value: { kind: 'new', type: { name: 'list', generic: { V: { name: 'num' } } }, value: [1, 2, 3] },
      }],
      body: {
        kind: 'get',
        path: [
          { prop: 'arr' },
          { prop: 'map' },
          {
            args: {
              fn: {
                kind: 'lambda',
                type: {
                  name: 'fn',
                  call: {
                    args: { name: 'obj', props: { value: { type: { name: 'num' } }, index: { type: { name: 'num' } } } },
                    returns: { name: 'num' },
                  },
                },
                body: {
                  kind: 'get',
                  path: [
                    { prop: 'args' },
                    { prop: 'value' },
                    { prop: 'mul' },
                    { args: { other: { kind: 'new', type: { name: 'num' }, value: 2 } } },
                  ],
                },
              },
            },
          },
        ],
      },
    } as const;
    const v = await e.run(program);
    expect(primitives(v)).toEqual([2, 4, 6]);
  });

  test('list.filter applies a lambda with bool result', async () => {
    // [1,2,3,4].filter(v => v > 2) → [3,4]
    const program = {
      kind: 'define',
      vars: [{
        name: 'arr',
        value: { kind: 'new', type: { name: 'list', generic: { V: { name: 'num' } } }, value: [1, 2, 3, 4] },
      }],
      body: {
        kind: 'get',
        path: [
          { prop: 'arr' },
          { prop: 'filter' },
          {
            args: {
              fn: {
                kind: 'lambda',
                type: { name: 'fn', call: { args: { name: 'obj' }, returns: { name: 'bool' } } },
                body: {
                  kind: 'get',
                  path: [
                    { prop: 'args' }, { prop: 'value' }, { prop: 'gt' },
                    { args: { other: { kind: 'new', type: { name: 'num' }, value: 2 } } },
                  ],
                },
              },
            },
          },
        ],
      },
    } as const;
    const v = await e.run(program);
    expect(primitives(v)).toEqual([3, 4]);
  });
});

describe('evalTemplate', () => {
  const e = new Engine(createRegistry());

  test('interpolates params into template string', async () => {
    const v = await e.run({
      kind: 'template',
      template: { kind: 'new', type: { name: 'text' }, value: 'Hello {name}, you have {count} messages' },
      params: {
        kind: 'new',
        type: { name: 'obj', props: { name: { type: { name: 'text' } }, count: { type: { name: 'num' } } } },
        value: { name: 'Alice', count: 3 },
      },
    });
    expect(v.raw).toBe('Hello Alice, you have 3 messages');
  });

  test('missing placeholder becomes empty', async () => {
    const v = await e.run({
      kind: 'template',
      template: { kind: 'new', type: { name: 'text' }, value: 'hi {missing}' },
      params: { kind: 'new', type: { name: 'obj', props: {} }, value: {} },
    });
    expect(v.raw).toBe('hi ');
  });

  test('falls back to scope variables when params is omitted', async () => {
    // Template can reference any local variable directly — no
    // explicit params object needed. This is the common case the
    // LLM hits when it writes `${baseUrl}` expecting the local
    // `define baseUrl = ...` to flow through.
    const v = await e.run({
      kind: 'define',
      vars: [
        { name: 'host', value: { kind: 'new', type: { name: 'text' }, value: 'api.example.com' } },
        { name: 'port', value: { kind: 'new', type: { name: 'num' }, value: 8080 } },
      ],
      body: {
        kind: 'template',
        template: { kind: 'new', type: { name: 'text' }, value: 'https://{host}:{port}/v1' },
        // No `params` — `{host}` and `{port}` resolve via scope.
      },
    });
    expect(v.raw).toBe('https://api.example.com:8080/v1');
  });

  test('partial params + scope fallback for the rest', async () => {
    // params supplies one placeholder; the other comes from scope.
    const v = await e.run({
      kind: 'define',
      vars: [
        { name: 'host', value: { kind: 'new', type: { name: 'text' }, value: 'api.example.com' } },
      ],
      body: {
        kind: 'template',
        template: { kind: 'new', type: { name: 'text' }, value: '{host}/{path}' },
        params: {
          kind: 'new',
          type: { name: 'obj', props: { path: { type: { name: 'text' } } } },
          value: { path: 'users' },
        },
      },
    });
    expect(v.raw).toBe('api.example.com/users');
  });

  test('params overrides scope when both have the same name', async () => {
    // Explicit params is meant to be the override path — values
    // there take precedence over a same-named scope variable.
    const v = await e.run({
      kind: 'define',
      vars: [
        { name: 'name', value: { kind: 'new', type: { name: 'text' }, value: 'from scope' } },
      ],
      body: {
        kind: 'template',
        template: { kind: 'new', type: { name: 'text' }, value: 'hello {name}' },
        params: {
          kind: 'new',
          type: { name: 'obj', props: { name: { type: { name: 'text' } } } },
          value: { name: 'from params' },
        },
      },
    });
    expect(v.raw).toBe('hello from params');
  });

  test('validate: ERRORS on unresolved placeholder (not in params, not in scope)', () => {
    const probs = e.validate({
      kind: 'template',
      template: { kind: 'new', type: { name: 'text' }, value: 'x={x} y={y}' },
      params: {
        kind: 'new',
        type: { name: 'obj', props: { x: { type: { name: 'num' } } } },
        value: { x: 1 },
      },
    });
    // `{x}` is in params, `{y}` is in neither params nor scope.
    // Unresolved placeholders silently produce empty strings at
    // runtime — a real bug — so promote to error severity.
    const unresolved = probs.list.find((p) => p.code === 'template.placeholder.unresolved');
    expect(unresolved).toBeDefined();
    expect(unresolved?.severity).toBe('error');
    expect(unresolved?.message).toContain("'{y}'");
  });

  test('validate: typed-obj params (a `get`) participates in the keys check', () => {
    // params is `args.config` — we don't know the inline value, but
    // we DO know its declared type (obj{baseUrl, apiKey}). The
    // validator uses those keys to decide which placeholders are
    // satisfied, so `{baseUrl}` is fine and `{port}` errors.
    const probs = e.validate(
      {
        kind: 'template',
        template: { kind: 'new', type: { name: 'text' }, value: '{baseUrl}:{port}/x?key={apiKey}' },
        params: { kind: 'get', path: [{ prop: 'config' }] },
      },
      // Scope binds `config` to a typed obj.
      new Map([
        ['config', e.registry.obj({
          baseUrl: { type: e.registry.text() },
          apiKey: { type: e.registry.text() },
        })],
      ]),
    );
    const unresolved = probs.list.filter((p) => p.code === 'template.placeholder.unresolved');
    // {baseUrl} and {apiKey} are keys of the params type.
    // {port} is not — error on that one only.
    expect(unresolved.length).toBe(1);
    expect(unresolved[0]!.message).toContain("'{port}'");
  });

  test('validate: opaque `any` params defers to scope-only check', () => {
    // When params is typed `any` we can't see its shape — the
    // validator falls back to scope-only checking. `{x}` is in
    // scope, `{y}` is not.
    const probs = e.validate(
      {
        kind: 'template',
        template: { kind: 'new', type: { name: 'text' }, value: 'x={x} y={y}' },
        params: { kind: 'get', path: [{ prop: 'opaque' }] },
      },
      new Map([
        ['opaque', e.registry.any()],
        ['x', e.registry.num()],
      ]),
    );
    const unresolved = probs.list.filter((p) => p.code === 'template.placeholder.unresolved');
    expect(unresolved.length).toBe(1);
    expect(unresolved[0]!.message).toContain("'{y}'");
  });

  test('validate: scope fallback satisfies the placeholder check', () => {
    // The same `{y}` placeholder, this time bound by an outer
    // `define` — should NOT warn because runtime will pick it up
    // via scope fallback.
    const probs = e.validate({
      kind: 'define',
      vars: [{ name: 'y', value: { kind: 'new', type: { name: 'num' }, value: 9 } }],
      body: {
        kind: 'template',
        template: { kind: 'new', type: { name: 'text' }, value: 'y={y}' },
      },
    });
    expect(probs.list.some((p) => p.code === 'template.placeholder.unresolved')).toBe(false);
  });

  test('toCode: bare template (no params) renders placeholders as ${name}', async () => {
    const e2 = new Engine(createRegistry());
    const code = e2.toCode({
      kind: 'template',
      template: { kind: 'new', type: { name: 'text' }, value: 'hello {who}' },
    });
    expect(code).toBe('`hello ${who}`');
  });

  test('toCode: literal-inline params renders without with()', async () => {
    const e2 = new Engine(createRegistry());
    const code = e2.toCode({
      kind: 'template',
      template: { kind: 'new', type: { name: 'text' }, value: 'n={n}' },
      params: {
        kind: 'new',
        type: { name: 'obj', props: { n: { type: { name: 'num' } } } },
        value: { n: 42 },
      },
    });
    // Inline literal — no `with(...)` clause needed.
    expect(code).toContain('${42}');
    expect(code).not.toContain('with(');
  });

  test('toCode: non-inlinable params drops to bare placeholders (no with() clause)', async () => {
    // params is a `get` Expr (not a `new obj` literal), so its
    // field values can't be inlined at toCode time. Bare `${name}`
    // wins — the runtime falls through to scope, which is what the
    // user wrote `params: args.config` for in the first place. No
    // `with(...)` clause: it added noise without adding info.
    const e2 = new Engine(createRegistry());
    const code = e2.toCode({
      kind: 'define',
      vars: [{
        name: 'p',
        value: {
          kind: 'new',
          type: { name: 'obj', props: { name: { type: { name: 'text' } } } },
          value: { name: 'alice' },
        },
      }],
      body: {
        kind: 'template',
        template: { kind: 'new', type: { name: 'text' }, value: 'hi {name}' },
        params: { kind: 'get', path: [{ prop: 'p' }] },
      },
    });
    expect(code).toContain('${name}');
    expect(code).not.toContain('with(');
  });

  test('toCode: literal params with Expr values inlines the Expr toCode', async () => {
    // params is `new obj{ apiKey: <get vars.apiKey> }` — a literal
    // obj whose fields are themselves Exprs. Each `{name}` lookup
    // grabs the matching field's Expr code and substitutes it.
    const e2 = new Engine(createRegistry());
    const code = e2.toCode({
      kind: 'template',
      template: { kind: 'new', type: { name: 'text' }, value: 'auth={apiKey}' },
      params: {
        kind: 'new',
        type: { name: 'obj', props: { apiKey: { type: { name: 'text' } } } },
        value: {
          apiKey: { kind: 'get', path: [{ prop: 'vars' }, { prop: 'marketstackApiKey' }] },
        },
      },
    });
    // The `{apiKey}` placeholder should be replaced by the rendered
    // get path, not left as `${apiKey}` or trailed by a `with()`.
    expect(code).toContain('${vars.marketstackApiKey}');
    expect(code).not.toContain('with(');
    expect(code).not.toContain('${apiKey}');
  });

  test('toCode: long inline code (>64 chars) wraps to multi-line ${\\n  code\\n}', async () => {
    // Build a deeply-nested chain that produces > 64 chars of code.
    // `vars.x.toText.upper.lower.toText.upper.lower` is over the
    // threshold — it should render across three lines so the
    // template doesn't sprawl horizontally.
    const e2 = new Engine(createRegistry());
    const longExpr = {
      kind: 'get',
      path: [
        { prop: 'vars' }, { prop: 'someExtremelyLongIdentifierName' },
        { prop: 'toText' }, { prop: 'upper' }, { prop: 'lower' },
        { prop: 'toText' }, { prop: 'upper' }, { prop: 'lower' },
      ],
    };
    const code = e2.toCode({
      kind: 'template',
      template: { kind: 'new', type: { name: 'text' }, value: 'x={x}' },
      params: {
        kind: 'new',
        type: { name: 'obj', props: { x: { type: { name: 'text' } } } },
        value: { x: longExpr },
      },
    });
    // The long code should be wrapped on its own line. The marker
    // is the `${\n` that opens the multi-line interpolation.
    expect(code).toContain('${\n');
    expect(code).toContain('\n}');
    // And the inline form should NOT be present.
    expect(code).not.toMatch(/\$\{vars\.someExtremelyLongIdentifierName/);
  });
});
