import { describe, test, expect } from 'vitest';
import { createRegistry, Engine } from '../index';

/**
 * Type-level constraints via Extension:
 *   - `Extension.local.constraint` is an Expr evaluated with `this` = value
 *   - `Engine.validateValue(value)` runs the constraint chain and returns Problems
 *   - `toValueSchema()` adds the constraint text to the Zod description
 *
 * Lambda-level constraints:
 *   - `LambdaExpr.constraint` is a pre-call guard, evaluated with `args` in scope
 *   - Violations throw at call time
 */

describe('Type constraints (via Extension)', () => {
  test('engine.validateValue catches violations', async () => {
    const r = createRegistry();
    const e = new Engine(r);

    // Extension on text: value must be non-empty.
    const nonEmpty = r.extend('text', {
      name: 'nonEmpty',
      constraint: r.parseExpr({
        kind: 'get',
        path: [
          { prop: 'this' },
          { prop: 'isNotEmpty' },
          { args: {} },
        ],
      }),
    });
    r.register(nonEmpty);

    const good = nonEmpty.parse('hello');
    const bad = nonEmpty.parse('');

    const p1 = await e.validateValue(good);
    expect(p1.hasErrors).toBe(false);

    const p2 = await e.validateValue(bad);
    expect(p2.hasErrors).toBe(true);
    expect(p2.list.some((x) => x.code === 'constraint.failed')).toBe(true);
  });

  test('types with no constraints return empty Problems', async () => {
    const r = createRegistry();
    const e = new Engine(r);
    const v = r.num().parse(42);
    const p = await e.validateValue(v);
    expect(p.hasErrors).toBe(false);
    expect(p.list.length).toBe(0);
  });

  test('toValueSchema describes the constraint', () => {
    const r = createRegistry();
    const nonEmpty = r.extend('text', {
      name: 'nonEmpty',
      constraint: r.parseExpr({
        kind: 'get',
        path: [{ prop: 'this' }, { prop: 'isNotEmpty' }, { args: {} }],
      }),
    });
    const schema = nonEmpty.toValueSchema();
    expect(schema.description).toContain('must satisfy');
    expect(schema.description).toContain('isNotEmpty');
  });

  test('constraint chain: Extension over Extension inherits ancestor constraints', async () => {
    const r = createRegistry();
    const e = new Engine(r);

    const nonEmpty = r.extend('text', {
      name: 'nonEmpty',
      constraint: r.parseExpr({
        kind: 'get',
        path: [{ prop: 'this' }, { prop: 'isNotEmpty' }, { args: {} }],
      }),
    });
    r.register(nonEmpty);

    // Child extends nonEmpty and adds its own constraint (must start with 'u-').
    const userId = r.extend('nonEmpty', {
      name: 'userId',
      constraint: r.parseExpr({
        kind: 'get',
        path: [
          { prop: 'this' },
          { prop: 'startsWith' },
          { args: { prefix: { kind: 'new', type: { name: 'text' }, value: 'u-' } } },
        ],
      }),
    });
    r.register(userId);

    expect(userId.constraints().length).toBe(2); // own + inherited

    // Satisfies both
    const good = userId.parse('u-42');
    expect((await e.validateValue(good)).hasErrors).toBe(false);

    // Fails parent (empty)
    const empty = userId.parse('');
    const pEmpty = await e.validateValue(empty);
    expect(pEmpty.hasErrors).toBe(true);

    // Fails own (no 'u-' prefix)
    const bad = userId.parse('not-a-user-id');
    const pBad = await e.validateValue(bad);
    expect(pBad.hasErrors).toBe(true);
  });
});

describe('Lambda constraints', () => {
  test('pre-call guard: false throws at call time', async () => {
    const r = createRegistry();
    const e = new Engine(r);

    // A lambda that returns args.x + 1, but requires args.x >= 0.
    const lambda = r.parseExpr({
      kind: 'lambda',
      type: {
        name: 'function',
        call: {
          args: { name: 'obj', props: { x: { type: { name: 'num' } } } },
          returns: { name: 'num' },
        },
      },
      constraint: {
        kind: 'get',
        path: [
          { prop: 'args' },
          { prop: 'x' },
          { prop: 'gte' },
          { args: { other: { kind: 'new', type: { name: 'num' }, value: 0 } } },
        ],
      },
      body: {
        kind: 'get',
        path: [
          { prop: 'args' },
          { prop: 'x' },
          { prop: 'add' },
          { args: { other: { kind: 'new', type: { name: 'num' }, value: 1 } } },
        ],
      },
    });

    // Construct the closure and call with x=5 (ok), then x=-1 (fails).
    const fn = await e.run(lambda);
    const callable = fn.raw as (a: { raw: { x: { raw: number } } }) => Promise<{ raw: number }>;

    const argsOk = r.obj({ x: { type: r.num() } }).parse({ x: 5 });
    const argsBad = r.obj({ x: { type: r.num() } }).parse({ x: -1 });

    const resultOk = await callable(argsOk as unknown as { raw: { x: { raw: number } } });
    expect(resultOk.raw).toBe(6);

    await expect(callable(argsBad as unknown as { raw: { x: { raw: number } } }))
      .rejects.toThrow(/constraint failed/);
  });
});
