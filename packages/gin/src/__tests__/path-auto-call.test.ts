import { describe, test, expect } from 'vitest';
import { createRegistry, Engine } from '../index';

/**
 * Path walker auto-call: when a `{prop: 'method'}` step lands on a
 * callable whose args type has no required fields (zero fields, or
 * every field is `optional<...>`), the walker invokes the method
 * with empty args instead of returning the bare function value.
 *
 * Coverage spans the three places the rule has to agree:
 *   - `evaluate` (runtime)
 *   - `typeOf` (static type inference)
 *   - `validateWalk` (static analysis used by `engine.validate`)
 *
 * Plus the negative cases — explicit `{args: {}}` still works, methods
 * with required args are NOT auto-called, and standalone fn-typed
 * scope variables stay as function values.
 */
describe('path auto-call (zero-required-arg methods)', () => {
  const r = createRegistry();
  const e = new Engine(r);

  test('runtime: optional<num>.has auto-invokes → bool (present)', async () => {
    // Build the optional<num> Value programmatically and pass it as
    // an `extras` binding. Creating the present optional via gin's
    // type.parse(42) is the simplest way to materialize a real
    // OptionalType-typed Value at runtime.
    const opt = r.optional(r.num()).parse(42);
    const v = await e.run(
      { kind: 'get', path: [{ prop: 'opt' }, { prop: 'has' }] },
      { opt },
    );
    expect(v.raw).toBe(true);
  });

  test('runtime: optional<num>.has auto-invokes → bool (absent)', async () => {
    // Same access pattern, but the optional has no value bound; auto-
    // call still fires and returns false.
    const opt = r.optional(r.num()).parse(undefined);
    const v = await e.run(
      { kind: 'get', path: [{ prop: 'opt' }, { prop: 'has' }] },
      { opt },
    );
    expect(v.raw).toBe(false);
  });

  test('runtime: explicit {args: {}} still works (back-compat)', async () => {
    // Programs that already had the empty-args step keep behaving the
    // same — the explicit-call branch fires before the auto-call
    // branch.
    const opt = r.optional(r.num()).parse(7);
    const v = await e.run(
      { kind: 'get', path: [{ prop: 'opt' }, { prop: 'has' }, { args: {} }] },
      { opt },
    );
    expect(v.raw).toBe(true);
  });

  test('runtime: text.upper auto-invokes → text', async () => {
    // `text.upper` is `({}, text)` — zero args. Reading `s.upper`
    // without an explicit call step should produce the upper-cased
    // string.
    const v = await e.run(
      { kind: 'get', path: [{ prop: 's' }, { prop: 'upper' }] },
      { s: r.text().parse('hello') },
    );
    expect(v.raw).toBe('HELLO');
  });

  test('runtime: method with required arg is NOT auto-called', async () => {
    // num.add(other: num) has a required arg, so accessing
    // `n.add` without {args: ...} should NOT auto-call. Using it
    // explicitly with `{args: {other: 3}}` must still work.
    const v = await e.run(
      {
        kind: 'get',
        path: [
          { prop: 'n' }, { prop: 'add' },
          { args: { other: { kind: 'new', type: { name: 'num' }, value: 3 } } },
        ],
      },
      { n: r.num().parse(5) },
    );
    expect(v.raw).toBe(8);
  });

  test('runtime: standalone fn-typed scope var is NOT auto-called', async () => {
    // Bare scope-var access (current === null in the walker) is the
    // "give me the function value" path. Even if the fn has zero
    // required args, the user has to invoke it explicitly with a
    // CallStep — otherwise we'd lose the ability to pass functions
    // around. We construct a no-arg lambda in scope via a `define +
    // lambda` ExprDef, read it bare (gets the fn value), then call
    // it with explicit empty args (gets the body's value).
    const fnTypeDef = { name: 'fn' as const, call: { args: { name: 'obj' as const }, returns: { name: 'num' as const } } };
    const lambdaExpr = {
      kind: 'lambda' as const,
      type: fnTypeDef,
      body: { kind: 'new' as const, type: { name: 'num' as const }, value: 99 },
    };

    // Bare access — should yield the fn value (typeof === 'function'),
    // NOT 99. If auto-call were firing on scope vars, this would
    // return 99 and the assertion would fail.
    const bare = await e.run({
      kind: 'define',
      vars: [{ name: 'f', value: lambdaExpr }],
      body: { kind: 'get', path: [{ prop: 'f' }] },
    });
    expect(typeof bare.raw).toBe('function');

    // Explicit call — should yield 99.
    const called = await e.run({
      kind: 'define',
      vars: [{ name: 'f', value: lambdaExpr }],
      body: { kind: 'get', path: [{ prop: 'f' }, { args: {} }] },
    });
    expect(called.raw).toBe(99);
  });

  test('typeOf: auto-callable prop reports the call return type', () => {
    // `engine.validate` walks the program with `typeOf` to infer the
    // value's type. For an auto-call site, that should be the call's
    // `returns`, not the fn type itself. We exercise this through a
    // `define` whose declared type is `bool`: if `opt.has` resolved
    // to a fn, we'd get a `define.var.type-mismatch` error.
    const probs = e.validate(
      {
        kind: 'define',
        vars: [{
          name: 'present',
          type: { name: 'bool' },
          value: { kind: 'get', path: [{ prop: 'opt' }, { prop: 'has' }] },
        }],
        body: { kind: 'get', path: [{ prop: 'present' }] },
      },
      // Pre-bind `opt` in the type scope as `optional<num>`.
      new Map([['opt', r.optional(r.num())]]),
    );
    expect(probs.list.some((p) => p.code === 'define.var.type-mismatch')).toBe(false);
  });

  test('validateWalk: auto-callable prop is OK as an if condition', () => {
    // The exact case from the user's ginny.log: a conditional that
    // tests `optional.has`. Pre-fix, this flagged
    // `if.condition.type: got 'fn'`. With auto-call, the condition
    // resolves to bool and the warning goes away.
    const probs = e.validate(
      {
        kind: 'if',
        ifs: [{
          condition: { kind: 'get', path: [{ prop: 'opt' }, { prop: 'has' }] },
          body: { kind: 'new', type: { name: 'num' }, value: 1 },
        }],
        otherwise: { kind: 'new', type: { name: 'num' }, value: 2 },
      },
      new Map([['opt', r.optional(r.num())]]),
    );
    expect(probs.list.some((p) => p.code === 'if.condition.type')).toBe(false);
  });

  test('validateWalk: required-arg method without {args:...} is a validation error', () => {
    // num.add takes a required `other`. Reading `n.add` without calling it used
    // to silently degrade to the bare fn value (and, at runtime, a wrong result);
    // it is now a `call.uncalled` error so the retry loop can catch and fix it.
    const probs = e.validate(
      {
        kind: 'if',
        ifs: [{
          condition: { kind: 'get', path: [{ prop: 'n' }, { prop: 'add' }] },
          body: { kind: 'new', type: { name: 'num' }, value: 1 },
        }],
        otherwise: { kind: 'new', type: { name: 'num' }, value: 2 },
      },
      new Map([['n', r.num()]]),
    );
    const uncalled = probs.list.find((p) => p.code === 'call.uncalled');
    expect(uncalled).toBeDefined();
    expect(uncalled?.message).toContain("method 'add' needs arguments");
  });

  test('runtime: method-chain auto-call — text.upper.lower', async () => {
    // `text.upper` and `text.lower` both take zero args. Accessing
    // `s.upper.lower` should auto-call each step in turn — first
    // upper-casing then lower-casing — yielding the original string
    // (lowercased).
    const v = await e.run(
      { kind: 'get', path: [{ prop: 's' }, { prop: 'upper' }, { prop: 'lower' }] },
      { s: r.text().parse('Hello') },
    );
    expect(v.raw).toBe('hello');
  });
});
