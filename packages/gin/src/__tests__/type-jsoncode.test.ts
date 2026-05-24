import { describe, test, expect } from 'vitest';
import { createRegistry, Engine } from '../index';

/**
 * `Type.toJSONCode` walks the standard TypeDef structure and emits
 * fine-grained spans on every nested slot — props/get/call/init,
 * each Prop's get/set/default, embedded ExprDefs, etc. Combined with
 * `Type.validate(engine)` (which surfaces problems with paths into
 * the same structure), `typeJsonCode.formatProblem(problem)` can
 * underline precisely the offending range INSIDE a type definition,
 * the way it does inside Expr trees.
 *
 * The tests below exercise the path resolution end-to-end: build an
 * augmented type with a deliberately broken Expr body, validate it,
 * then check that the formatted output's underline lands on the
 * expected piece of the rendered JSON.
 */
describe('Type.toJSONCode — fine spans inside type defs', () => {
  test('Extension toJSONCode contains all structural keys with spans', () => {
    const r = createRegistry();
    const Point = r.extend('obj', {
      name: 'Point',
      props: {
        x: { type: r.num() },
        y: { type: r.num() },
      },
    });
    r.register(Point);

    const codeObj = Point.toJSONCode([], 2, 0);
    const text = codeObj.toString();
    // Structural keys are rendered.
    expect(text).toContain('"name": "Point"');
    expect(text).toContain('"props"');
    expect(text).toContain('"x"');
    expect(text).toContain('"y"');

    // Spans are emitted at every level (not just one coarse top-level).
    // Each Prop's `type` slot has its own span.
    const xTypeSpan = codeObj.spanFor(['props', 'x', 'type']);
    expect(xTypeSpan).toBeDefined();
    const yTypeSpan = codeObj.spanFor(['props', 'y', 'type']);
    expect(yTypeSpan).toBeDefined();
    expect(xTypeSpan!.start).not.toBe(yTypeSpan!.start);
  });

  test('span for an embedded Prop.get path resolves precisely', () => {
    const r = createRegistry();
    const e = new Engine(r);
    const Sample = r.extend('obj', {
      name: 'Sample',
      props: {
        // Method body is an Expr — referencing an unbound name.
        broken: {
          type: r.fn({ args: r.obj({}), returns: r.text() }),
          get: { kind: 'get', path: [{ prop: 'unboundName' }] },
        },
      },
    });
    r.register(Sample);

    const codeObj = Sample.toJSONCode([], 2, 0);
    // The Expr's path is `['props', 'broken', 'get', 'path', 0]` for
    // the unbound get — the validator emits exactly that path.
    const inner = codeObj.spanFor(['props', 'broken', 'get', 'path', 0]);
    expect(inner).toBeDefined();
    // Confirm validate produces a problem at that path so the two
    // sides line up.
    const probs = Sample.validate(e);
    const varUnknown = probs.list.find((p) => p.code === 'var.unknown');
    expect(varUnknown).toBeDefined();
    // The problem path should be a prefix-match for the span we found.
    // (`spanFor` uses longest-prefix matching, so the span's path is
    // <= the problem's path in length.)
    expect(varUnknown!.path).toEqual(
      expect.arrayContaining(['props', 'broken', 'get']),
    );
  });

  test('typeJsonCode.formatProblems(problems) produces sectioned ^^^ output', () => {
    const r = createRegistry();
    const e = new Engine(r);
    const Broken = r.extend('obj', {
      name: 'Broken',
      props: {
        rotateX: {
          // method declares returns: num, body returns text — mismatch.
          type: r.fn({ args: r.obj({}), returns: r.num() }),
          get: { kind: 'new', type: { name: 'text' }, value: 'oops' },
        },
        bad: {
          // unbound name in method body.
          type: r.fn({ args: r.obj({}), returns: r.text() }),
          get: { kind: 'get', path: [{ prop: 'whoIsThis' }] },
        },
      },
    });
    r.register(Broken);

    const probs = Broken.validate(e);
    expect(probs.list.length).toBeGreaterThan(0);

    const codeObj = Broken.toJSONCode([], 2, 0);
    const formatted = codeObj.formatProblems(probs, { color: false });
    // Each problem renders against its own line range with line numbers,
    // a `^^^` underline, and the message — same shape as Expr-side.
    expect(formatted).toMatch(/── lines \d+-\d+ ─/);
    expect(formatted).toContain('^');
    // At least one error message references the bad slot's content.
    expect(formatted).toMatch(/whoIsThis|unknown variable|return-type/);
  });

  test('Init.run inside a type def gets its own span path', () => {
    const r = createRegistry();
    const e = new Engine(r);
    // An Extension whose `init.run` references an unbound name.
    const T = r.extend('obj', {
      name: 'T',
      props: { v: { type: r.num() } },
      init: {
        args: r.obj({ start: { type: r.num() } }),
        run: { kind: 'get', path: [{ prop: 'noSuchVar' }] },
      },
    });
    r.register(T);

    const codeObj = T.toJSONCode([], 2, 0);
    const initRunSpan = codeObj.spanFor(['init', 'run']);
    expect(initRunSpan).toBeDefined();

    const probs = T.validate(e);
    const violation = probs.list.find((p) =>
      p.code === 'var.unknown' && p.path[0] === 'init' && p.path[1] === 'run',
    );
    expect(violation).toBeDefined();

    const formatted = codeObj.formatProblems(probs, { color: false });
    expect(formatted).toContain('noSuchVar');
  });

  test('roundtrip: toJSONCode().toString() parses back to toJSON()', () => {
    const r = createRegistry();
    const Round = r.extend('obj', {
      name: 'Round',
      docs: 'a round trip test type',
      props: {
        x: { type: r.num({ min: 0, max: 100 }) },
        helper: {
          type: r.fn({ args: r.obj({ n: { type: r.num() } }), returns: r.num() }),
          get: { kind: 'get', path: [{ prop: 'args' }, { prop: 'n' }] },
        },
      },
    });
    r.register(Round);

    const text = Round.toJSONCode([], 2, 0).toString();
    const parsed = JSON.parse(text);
    // Equivalent to the canonical toJSON() output.
    expect(parsed).toEqual(JSON.parse(JSON.stringify(Round.toJSON())));
  });
});
