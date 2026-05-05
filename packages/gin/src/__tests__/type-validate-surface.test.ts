import { describe, test, expect } from 'vitest';
import { createRegistry, Engine } from '../index';

/**
 * `Type.validate(engine)` walks the type's surface (props / get / call /
 * init) and validates every embedded ExprDef. Embedded bodies are
 * parsed and run through the same `walkValidate` machinery a top-level
 * program goes through, with the runtime scope (`this`, `args`,
 * `recurse`, `super`, `key`, `value`) pre-bound.
 *
 * Programs validated via `engine.validate(programExpr)` do NOT auto-
 * recurse into types — that's by design (a program shouldn't pay to
 * re-validate the registry every time it touches `num`). Instead,
 * `registry.validate(engine)` aggregates `Type.validate` across every
 * named type + augmented built-in.
 */
describe('Type.validate — embedded Expr surface walk', () => {
  test('plain built-in type: native-only props validate clean', () => {
    const r = createRegistry();
    const e = new Engine(r);
    const probs = r.num().validate(e);
    // num's intrinsic methods are all `{kind:'native', id:'num.X'}`;
    // each NativeExpr validates trivially as long as its impl is
    // registered (which createRegistry does).
    expect(probs.list.length).toBe(0);
  });

  test('augmented type with a well-formed Expr body validates clean', () => {
    const r = createRegistry();
    const e = new Engine(r);
    // Add `text.echo` returning `this` — a single-segment get path on
    // the bound `this` Value. Body is real gin code, not a native id.
    r.augment('text', {
      props: {
        echo: { type: r.fn(r.obj({}), r.text()), get: { kind: 'get', path: [{ prop: 'this' }] } },
      },
    });
    const probs = r.text().validate(e);
    expect(probs.list).toEqual([]);
  });

  test('embedded body with var.unknown is caught', () => {
    const r = createRegistry();
    const e = new Engine(r);
    r.augment('text', {
      props: {
        // `unboundName` is not in scope — the slot only binds `this`/`args`/`recurse`.
        broken: { type: r.fn(r.obj({}), r.text()), get: { kind: 'get', path: [{ prop: 'unboundName' }] } },
      },
    });
    const probs = r.text().validate(e);
    expect(probs.list.some((p) => p.code === 'var.unknown')).toBe(true);
  });

  test('embedded body with wrong return type surfaces type.surface.return-type', () => {
    const r = createRegistry();
    const e = new Engine(r);
    // Method declares returns: num, but body produces text.
    r.augment('text', {
      props: {
        wrongReturn: {
          type: r.fn(r.obj({}), r.num()),
          // `this` is text — returning it gives type 'text', not 'num'.
          get: { kind: 'get', path: [{ prop: 'this' }] },
        },
      },
    });
    const probs = r.text().validate(e);
    expect(probs.list.some((p) => p.code === 'type.surface.return-type')).toBe(true);
  });

  test('Extension method body is validated like an augmentation', () => {
    const r = createRegistry();
    const e = new Engine(r);
    const Point = r.extend('obj', {
      name: 'Point',
      props: { x: { type: r.num() }, y: { type: r.num() } },
    });
    r.register(Point);
    // Augment the registered Extension with a method whose body refs
    // an unbound name.
    r.augment('Point', {
      props: {
        broken: {
          type: r.fn(r.obj({}), r.num()),
          get: { kind: 'get', path: [{ prop: 'doesNotExist' }] },
        },
      },
    });
    const probs = Point.validate(e);
    expect(probs.list.some((p) => p.code === 'var.unknown')).toBe(true);
  });

  test('program validation does NOT auto-recurse into types', () => {
    // Even though `text` is now augmented with a broken method, a
    // program that doesn't call that method validates clean. Programs
    // are scoped to their own tree.
    const r = createRegistry();
    const e = new Engine(r);
    r.augment('text', {
      props: {
        broken: {
          type: r.fn(r.obj({}), r.text()),
          get: { kind: 'get', path: [{ prop: 'unbound' }] },
        },
      },
    });
    const program = { kind: 'new' as const, type: { name: 'text' as const }, value: 'hello' };
    const probs = e.validate(program);
    expect(probs.list.length).toBe(0);
  });

  test('registry.validate aggregates Type.validate across named + augmented', () => {
    const r = createRegistry();
    const e = new Engine(r);
    // Augment a built-in with a broken method.
    r.augment('text', {
      props: {
        textBroken: {
          type: r.fn(r.obj({}), r.text()),
          get: { kind: 'get', path: [{ prop: 'unboundA' }] },
        },
      },
    });
    // Register an Extension with its own broken method.
    const Point = r.extend('obj', {
      name: 'Point',
      props: { x: { type: r.num() }, y: { type: r.num() } },
    });
    r.register(Point);
    r.augment('Point', {
      props: {
        pointBroken: {
          type: r.fn(r.obj({}), r.num()),
          get: { kind: 'get', path: [{ prop: 'unboundB' }] },
        },
      },
    });

    const probs = r.validate(e);
    // Both broken bodies surface, paths are prefixed with the type name.
    const codes = probs.list.map((p) => p.code);
    const paths = probs.list.map((p) => p.path[0]);
    expect(codes.filter((c) => c === 'var.unknown').length).toBeGreaterThanOrEqual(2);
    expect(paths).toContain('text');
    expect(paths).toContain('Point');
  });
});
