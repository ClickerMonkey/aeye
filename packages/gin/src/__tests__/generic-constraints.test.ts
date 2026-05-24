import { describe, test, expect } from 'vitest';
import { createRegistry, Engine } from '../index';
import { CallStep } from '../path';
import { AliasType } from '../types/alias';

/**
 * Constraints on generics — declared via `generic: { R: <constraint> }`.
 * The constraint is the type a call-site binding for R must satisfy
 * (`constraint.compatible(binding) === true`); it is NOT a default
 * resolution. R itself stays an unresolved AliasType placeholder until
 * a call-site binding layers it into the scope.
 *
 * Semantics:
 *   - Bare `{name: 'R'}` inside the signature parses as AliasType('R')
 *     and resolves only through caller-supplied scope, never to its
 *     constraint.
 *   - `CallStep.callSiteScope(calledType)` validates each binding
 *     against the declared constraint and throws on violation.
 *   - `R: alias('R')` is the canonical "unconstrained" declaration —
 *     no satisfies check is run for that form. (`any` works too —
 *     compatible() is permissive — but the self-ref form is what the
 *     declaration-site reads as "no constraint".)
 */
describe('generic constraints', () => {
  test('unconstrained generic — any binding accepted', () => {
    const r = createRegistry();
    // identity<T: any>({x: T}): T — declared with `any` constraint.
    const identity = r.fn({ args: r.obj({ x: { type: r.alias('T') } }), returns: r.alias('T'), generic: { T: r.any() } });

    const stepNum = new CallStep({}, { T: { name: 'num' } });
    const stepText = new CallStep({}, { T: { name: 'text' } });

    expect(() => stepNum.callSiteScope(identity)).not.toThrow();
    expect(() => stepText.callSiteScope(identity)).not.toThrow();
  });

  test('union constraint — only members of the union are accepted', () => {
    const r = createRegistry();
    // describe<R: text | obj>(...) — like fns.llm's R constraint.
    const describer = r.fn({ args: r.obj({}), returns: r.alias('R'), generic: { R: r.or([r.text(), r.obj({})]) } });

    // Accepted: text fits the or<text, obj> constraint.
    expect(() =>
      new CallStep({}, { R: { name: 'text' } }).callSiteScope(describer),
    ).not.toThrow();
    // Accepted: obj fits.
    expect(() =>
      new CallStep({}, { R: { name: 'obj', props: { x: { type: { name: 'num' } } } } }).callSiteScope(describer),
    ).not.toThrow();
    // Rejected: num doesn't satisfy text | obj.
    expect(() =>
      new CallStep({}, { R: { name: 'num' } }).callSiteScope(describer),
    ).toThrow(/generic 'R' binding .* does not satisfy constraint/);
  });

  test('interface constraint — structural satisfaction at binding time', () => {
    // Interface declaring a single method `length: num` (read as a prop
    // returning num — text and list both expose it; num and bool do not).
    // Used to demonstrate that the satisfies check is structural via
    // `iface.compatible(binding)`.
    const r = createRegistry();
    const Sized = r.iface({
      props: { length: { type: { name: 'num' } } },
    });

    // measure<T: Sized>({x: T}): num
    const measure = r.fn({ args: r.obj({ x: { type: r.alias('T') } }), returns: r.num(), generic: { T: Sized } });

    // text has `length: num` → satisfies Sized.
    expect(() =>
      new CallStep({}, { T: { name: 'text' } }).callSiteScope(measure),
    ).not.toThrow();

    // list<num> has `length: num` → satisfies.
    expect(() =>
      new CallStep({}, { T: { name: 'list', generic: { V: { name: 'num' } } } }).callSiteScope(measure),
    ).not.toThrow();

    // num has no `length` prop → does NOT satisfy.
    expect(() =>
      new CallStep({}, { T: { name: 'num' } }).callSiteScope(measure),
    ).toThrow(/generic 'T' binding 'num' does not satisfy constraint/);

    // bool has no `length` prop → does NOT satisfy.
    expect(() =>
      new CallStep({}, { T: { name: 'bool' } }).callSiteScope(measure),
    ).toThrow(/generic 'T' binding 'bool' does not satisfy constraint/);
  });

  test('self-referencing constraint (R: alias R) is unconstrained', () => {
    // `{ R: alias('R') }` is a self-reference — the constraint resolves
    // to itself, declaring "this generic has no real constraint". The
    // satisfies check is skipped for this form so any binding is accepted.
    const r = createRegistry();
    const identity = r.fn({ args: r.obj({ x: { type: r.alias('R') } }), returns: r.alias('R'), generic: { R: r.alias('R') } });

    expect(() =>
      new CallStep({}, { R: { name: 'num' } }).callSiteScope(identity),
    ).not.toThrow();
    expect(() =>
      new CallStep({}, { R: { name: 'text' } }).callSiteScope(identity),
    ).not.toThrow();
    expect(() =>
      new CallStep({}, { R: { name: 'bool' } }).callSiteScope(identity),
    ).not.toThrow();
  });

  test('constraint is not a default — unbound R stays a placeholder', () => {
    // The constraint type is stored on `fnType.generic[k]` but is NOT
    // bound into the captured scope. Bare `alias('R')` inside the
    // signature stays unresolved (AliasType placeholder); only call-
    // site bindings provide concrete resolution.
    const r = createRegistry();
    // constraint, not default
    const fn = r.fn({
      args: r.obj({ x: { type: r.alias('R') } }),
      returns: r.alias('R'),
      generic: { R: r.text() },
    });

    // Without a call-site binding, the captured fn scope does NOT
    // resolve R to text. The args type's `x` field is AliasType('R')
    // and stays so when accessed via the fn's own scope.
    const argsType = fn.call()!.args;
    const xField = (argsType as unknown as { fields: Record<string, { type: any }> }).fields.x;
    expect(xField.type).toBeInstanceOf(AliasType);
    expect((xField.type as AliasType).options.name).toBe('R');

    // The constraint IS retained in `fn.generic` for later validation.
    expect(fn.generic.R!.name).toBe('text');
  });

  test('runtime call: binding satisfying the constraint resolves the return type', async () => {
    // End-to-end: build a generic identity-like fn with a `text|obj`
    // constraint, invoke at the engine level with an explicit binding.
    // The path's typeOf reflects the bound R; the binding succeeds.
    const r = createRegistry();
    const e = new Engine(r);

    const identity = r.fn({ args: r.obj({ x: { type: r.alias('R') } }), returns: r.alias('R'), generic: { R: r.or([r.text(), r.obj({})]) } });

    const expr = {
      kind: 'get',
      path: [
        { prop: 'f' },
        {
          args: { x: { kind: 'new', type: { name: 'text' }, value: 'hi' } },
          generic: { R: { name: 'text' } },
        },
      ],
    } as const;

    const scope = new Map([['f', identity]]);
    expect(e.typeOf(expr, scope).name).toBe('text');
  });

  test('runtime call: binding violating the constraint throws', () => {
    const r = createRegistry();
    const e = new Engine(r);

    const identity = r.fn({ args: r.obj({ x: { type: r.alias('R') } }), returns: r.alias('R'), generic: { R: r.or([r.text(), r.obj({})]) } });

    // bool doesn't satisfy text|obj — typeOf walks callSiteScope which
    // throws on the satisfies failure.
    const expr = {
      kind: 'get',
      path: [
        { prop: 'f' },
        {
          args: { x: { kind: 'new', type: { name: 'bool' }, value: true } },
          generic: { R: { name: 'bool' } },
        },
      ],
    } as const;

    const scope = new Map([['f', identity]]);
    expect(() => e.typeOf(expr, scope)).toThrow(/generic 'R' binding 'bool' does not satisfy/);
  });
});
