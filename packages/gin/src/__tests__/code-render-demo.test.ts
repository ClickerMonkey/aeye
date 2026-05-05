import { describe, test, expect } from 'vitest';
import { createRegistry, Engine, formatProblems } from '../index';
import type { ExprDef } from '../schema';

/**
 * Visual demo — for each representative ExprDef, print the JSON
 * input, the `toGinCode` (TS-pseudocode) render, the `toJSONCode`
 * (JSON-with-spans) render, and (when validation fails) the
 * compiler-style `formatProblems` output. Useful for eyeballing
 * what the LLM and the user actually see.
 *
 * Each test asserts a basic invariant so vitest doesn't skip it,
 * but the real signal is in the printed output.
 *
 * Run with: `npx vitest run code-render-demo --reporter=verbose`
 *  (or just `npx vitest run code-render-demo` and inspect the
 *  stdout block above the summary).
 */

const e = new Engine(createRegistry());

function divider(title: string): void {
  console.log('\n' + '═'.repeat(80));
  console.log(`  ${title}`);
  console.log('═'.repeat(80));
}

function section(label: string, body: string): void {
  console.log(`\n── ${label} ${'─'.repeat(Math.max(0, 76 - label.length))}`);
  console.log(body);
}

function showRender(label: string, expr: ExprDef, engine: Engine = e): void {
  divider(label);

  section('Input ExprDef (JSON)', JSON.stringify(expr, null, 2));

  let ginCode = '';
  let jsonCode = '';
  try { ginCode = engine.toGinCode(expr).toString(); }
  catch (err) { ginCode = `<toGinCode threw: ${err instanceof Error ? err.message : String(err)}>`; }
  try { jsonCode = engine.toJSONCode(expr).toString(); }
  catch (err) { jsonCode = `<toJSONCode threw: ${err instanceof Error ? err.message : String(err)}>`; }

  section('toGinCode() — TS-pseudocode form', ginCode);
  section('toJSONCode() — JSON form (with span annotations underneath)', jsonCode);

  const probs = engine.validate(expr);
  if (probs.list.length === 0) {
    section('validate()', '(no problems)');
    return;
  }
  section(`validate() — ${probs.list.length} problem${probs.list.length === 1 ? '' : 's'}`,
    probs.list.map((p) => `  [${p.severity}] ${p.code}: ${p.message} @ ${p.path.join('.')}`).join('\n'));

  const richCode = engine.toGinCode(expr);
  const jsonRichCode = engine.toJSONCode(expr);
  section('formatProblems(richCode) — TS form with ^^^ pointers',
    formatProblems(richCode, probs, { color: false }));
  section('formatProblems(jsonCode) — JSON form with ^^^ pointers',
    formatProblems(jsonRichCode, probs, { color: false }));
}

describe('toGinCode / toJSONCode — visual rendering demo', () => {
  test('1. simple add expression: x + 3', () => {
    const expr: ExprDef = {
      kind: 'get',
      path: [
        { prop: 'x' }, { prop: 'add' },
        { args: { other: { kind: 'new', type: { name: 'num' }, value: 3 } } },
      ],
    };
    showRender('1. Simple expression — `x.add({ other: 3 })`', expr);
    expect(e.toGinCode(expr).toString()).toContain('add');
  });

  test('2. block with define + if/else', () => {
    const expr: ExprDef = {
      kind: 'block',
      lines: [
        {
          kind: 'define',
          vars: [{ name: 'x', value: { kind: 'new', type: { name: 'num' }, value: 5 } }],
          body: {
            kind: 'if',
            ifs: [{
              condition: {
                kind: 'get',
                path: [
                  { prop: 'x' }, { prop: 'gt' },
                  { args: { other: { kind: 'new', type: { name: 'num' }, value: 0 } } },
                ],
              },
              body: { kind: 'new', type: { name: 'text' }, value: 'positive' },
            }],
            otherwise: { kind: 'new', type: { name: 'text' }, value: 'non-positive' },
          },
        },
      ],
    };
    showRender('2. Composite — block + define + if/else', expr);
    expect(e.toGinCode(expr).toString()).toContain('positive');
  });

  test('3. switch with flow body (return)', () => {
    const expr: ExprDef = {
      kind: 'switch',
      value: { kind: 'get', path: [{ prop: 'x' }] },
      cases: [{
        equals: [{ kind: 'new', type: { name: 'num' }, value: 1 }],
        body: { kind: 'flow', action: 'return', value: { kind: 'new', type: { name: 'num' }, value: 99 } },
      }],
      else: { kind: 'new', type: { name: 'num' }, value: 0 },
    } as ExprDef;
    showRender('3. switch with flow (return) body', expr);
    expect(e.toGinCode(expr).toString()).toContain('case');
  });

  test('4. nested obj field access — args.config.host', () => {
    const expr: ExprDef = {
      kind: 'get',
      path: [{ prop: 'args' }, { prop: 'config' }, { prop: 'host' }],
    };
    showRender('4. Nested prop access — `args.config.host`', expr);
    expect(e.toGinCode(expr).toString()).toContain('args.config.host');
  });

  test('5. BROKEN — type mismatch (define with wrong-typed value)', () => {
    // const x: num = "wrong"
    const expr: ExprDef = {
      kind: 'define',
      vars: [{
        name: 'x',
        type: { name: 'num' },
        value: { kind: 'new', type: { name: 'text' }, value: 'wrong' },
      }],
      body: { kind: 'get', path: [{ prop: 'x' }] },
    };
    showRender('5. BROKEN — `const x: num = "wrong"` (type mismatch)', expr);
    const probs = e.validate(expr);
    expect(probs.list.length).toBeGreaterThan(0);
  });

  test('6. BROKEN — unknown variable in if condition', () => {
    const expr: ExprDef = {
      kind: 'if',
      ifs: [{
        condition: { kind: 'get', path: [{ prop: 'undeclared' }] },
        body: { kind: 'new', type: { name: 'text' }, value: 'yes' },
      }],
    };
    showRender('6. BROKEN — `if (undeclared)` (var.unknown)', expr);
    const probs = e.validate(expr);
    expect(probs.list.length).toBeGreaterThan(0);
  });

  test('7. BROKEN — multiple issues in one program', () => {
    // Simulates the kind of program ginny.log shows the model writing:
    // declared `text` but value is num, condition isn't bool, ref to
    // undeclared var.
    const expr: ExprDef = {
      kind: 'define',
      vars: [
        { name: 'x', type: { name: 'num' }, value: { kind: 'new', type: { name: 'text' }, value: 'oops' } },
        { name: 'y', value: { kind: 'get', path: [{ prop: 'unbound' }] } },
      ],
      body: {
        kind: 'if',
        ifs: [{
          condition: { kind: 'new', type: { name: 'num' }, value: 1 },
          body: { kind: 'get', path: [{ prop: 'x' }] },
        }],
      },
    };
    showRender('7. BROKEN — multi-error fixture', expr);
    const probs = e.validate(expr);
    expect(probs.list.length).toBeGreaterThanOrEqual(2);
  });

  test('8. template with placeholders + scope fallback', () => {
    const expr: ExprDef = {
      kind: 'block',
      lines: [
        { kind: 'define', vars: [{ name: 'host', value: { kind: 'new', type: { name: 'text' }, value: 'api.example.com' } }],
          body: { kind: 'new', type: { name: 'void' } } },
        { kind: 'template',
          template: { kind: 'new', type: { name: 'text' }, value: 'https://{host}/v1' } } as ExprDef,
      ],
    };
    showRender('8. Template — `https://${host}/v1` with scope-fallback', expr);
    expect(e.toGinCode(expr).toString()).toContain('https');
  });

  test('9. loop over a list', () => {
    const expr: ExprDef = {
      kind: 'loop',
      over: { kind: 'new', type: { name: 'list', generic: { V: { name: 'num' } } }, value: [1, 2, 3] },
      body: { kind: 'flow', action: 'continue' },
    };
    showRender('9. Loop — `for (const [key, value] of [1,2,3])`', expr);
    expect(e.toGinCode(expr).toString()).toContain('for');
  });

  test('10. lambda with constraint + body', () => {
    const expr: ExprDef = {
      kind: 'lambda',
      type: { name: 'fn', call: { args: { name: 'obj', props: { x: { type: { name: 'num' } } } }, returns: { name: 'num' } } },
      body: {
        kind: 'get',
        path: [
          { prop: 'args' }, { prop: 'x' }, { prop: 'mul' },
          { args: { other: { kind: 'new', type: { name: 'num' }, value: 2 } } },
        ],
      },
    };
    showRender('10. Lambda — `(args) => args.x.mul({ other: 2 })`', expr);
    expect(e.toGinCode(expr).toString()).toContain('=>');
  });

  test('11. new — typed obj literal', () => {
    const expr: ExprDef = {
      kind: 'new',
      type: { name: 'obj', props: { name: { type: { name: 'text' } }, age: { type: { name: 'num' } } } },
      value: { name: 'Alice', age: 30 },
    };
    showRender('11. New obj — `new obj{name: text, age: num}({name: "Alice", age: 30})`', expr);
    expect(e.toJSONCode(expr).toString()).toContain('Alice');
  });

  test('AUTO-WRAP-1. compact args (short, fit on one line)', () => {
    const expr: ExprDef = {
      kind: 'get',
      path: [
        { prop: 'x' }, { prop: 'add' },
        { args: { other: { kind: 'new', type: { name: 'num' }, value: 3 } } },
      ],
    };
    showRender('AUTO-WRAP-1. Compact args — `x.add({ other: 3 })`', expr);
    // Should render compact, no leading newline.
    expect(e.toGinCode(expr).toString()).not.toContain('\n');
  });

  test('AUTO-WRAP-2. long args (wrap kicks in)', () => {
    const expr: ExprDef = {
      kind: 'get',
      path: [
        { prop: 'fns' }, { prop: 'fetch' },
        { args: {
          url: { kind: 'new', type: { name: 'text' }, value: 'https://api.example.com/v1/very/long/path' },
          method: { kind: 'new', type: { name: 'text' }, value: 'POST' },
          body: { kind: 'new', type: { name: 'text' }, value: 'a-fairly-long-body-string-here' },
          output: { kind: 'new', type: { name: 'typ' }, value: { name: 'text' } },
        } },
      ],
    };
    showRender('AUTO-WRAP-2. Long args — wrap kicks in', expr);
    // Wrap form: contains newlines.
    expect(e.toGinCode(expr).toString()).toContain('\n');
  });

  test('12. BROKEN — template with unresolved placeholder + new with no value', () => {
    // Mirrors the user's "circle area" exchange: a template referencing
    // a placeholder that doesn't exist anywhere, and a `new obj` with
    // no value (defaults to zero). Both are real bugs the validator
    // catches and `formatProblems` should pinpoint.
    const expr: ExprDef = {
      kind: 'block',
      lines: [
        {
          kind: 'define',
          vars: [{
            name: 'p',
            value: { kind: 'new', type: { name: 'obj', props: { x: { type: { name: 'num' } } } } },
          }],
          body: { kind: 'new', type: { name: 'void' } },
        },
        {
          kind: 'template',
          template: { kind: 'new', type: { name: 'text' }, value: 'x={x} y={y}' },
        } as ExprDef,
      ],
    };
    showRender('12. BROKEN — `new obj` with no value + template missing `{y}`', expr);
    const probs = e.validate(expr);
    expect(probs.list.length).toBeGreaterThan(0);
  });

  test('COMPREHENSIVE-OK. all expression kinds, simple + complex, well-formed', () => {
    // One program that exercises every Expr kind in both its simplest
    // and most-complex form. Structured as a single outer `define`
    // (so all vars are visible to each other AND to the body) whose
    // body is a block of standalone expressions.
    //
    //   define-vars (top): a, env, port, config, url, identity, double, numbers
    //     ↳ exercises: define (multi-var), new (scalar + obj literal),
    //       template (no placeholders + scope-resolved placeholders),
    //       lambda (identity + with constraint), get (chained call)
    //   body block:
    //     ↳ template (simple), if (simple + complex), loop (over list),
    //       switch (multi-case + flow continue + else), set (obj field),
    //       native (text.upper — registered), get (final var read)
    const expr: ExprDef = {
      kind: 'define',
      vars: [
        // simple new
        { name: 'a', value: { kind: 'new', type: { name: 'num' }, value: 1 } },
        // template scope vars
        { name: 'env', value: { kind: 'new', type: { name: 'text' }, value: 'prod' } },
        { name: 'port', value: { kind: 'new', type: { name: 'num' }, value: 8080 } },
        // complex new — typed obj literal
        {
          name: 'config',
          type: { name: 'obj', props: { env: { type: { name: 'text' } }, port: { type: { name: 'num' } } } },
          value: {
            kind: 'new',
            type: { name: 'obj', props: { env: { type: { name: 'text' } }, port: { type: { name: 'num' } } } },
            value: { env: 'prod', port: 8080 },
          },
        },
        // complex template — placeholders auto-resolved via scope
        {
          name: 'url',
          value: {
            kind: 'template',
            template: { kind: 'new', type: { name: 'text' }, value: 'https://api-{env}.example.com:{port}' },
          },
        },
        // simple lambda — identity
        {
          name: 'identity',
          value: {
            kind: 'lambda',
            type: { name: 'fn', call: { args: { name: 'obj', props: { x: { type: { name: 'num' } } } }, returns: { name: 'num' } } },
            body: { kind: 'get', path: [{ prop: 'args' }, { prop: 'x' }] },
          },
        },
        // complex lambda — with constraint, body chains methods to compute result
        {
          name: 'double',
          value: {
            kind: 'lambda',
            type: { name: 'fn', call: { args: { name: 'obj', props: { n: { type: { name: 'num' } } } }, returns: { name: 'num' } } },
            constraint: {
              kind: 'get',
              path: [
                { prop: 'args' }, { prop: 'n' },
                { prop: 'gt' }, { args: { other: { kind: 'new', type: { name: 'num' }, value: 0 } } },
              ],
            },
            body: {
              kind: 'get',
              path: [
                { prop: 'args' }, { prop: 'n' },
                { prop: 'mul' }, { args: { other: { kind: 'new', type: { name: 'num' }, value: 2 } } },
              ],
            },
          },
        },
        // a list to loop over
        { name: 'numbers', value: { kind: 'new', type: { name: 'list', generic: { V: { name: 'num' } } }, value: [1, 2, 3] } },
      ],
      body: {
        kind: 'block',
        lines: [
          // ─── template (simple — no placeholders) ──────────────────
          // `hello world`
          {
            kind: 'template',
            template: { kind: 'new', type: { name: 'text' }, value: 'hello world' },
          } as ExprDef,
          // ─── if (simple — single branch, no else) ─────────────────
          {
            kind: 'if',
            ifs: [{
              condition: { kind: 'new', type: { name: 'bool' }, value: true },
              body: { kind: 'new', type: { name: 'text' }, value: 'yes' },
            }],
          },
          // ─── if (complex — multi-branch + else) ───────────────────
          // if (a > 0) "pos" else if (a == 0) "zero" else "neg"
          {
            kind: 'if',
            ifs: [
              {
                condition: { kind: 'get', path: [{ prop: 'a' }, { prop: 'gt' }, { args: { other: { kind: 'new', type: { name: 'num' }, value: 0 } } }] },
                body: { kind: 'new', type: { name: 'text' }, value: 'pos' },
              },
              {
                condition: { kind: 'get', path: [{ prop: 'a' }, { prop: 'eq' }, { args: { other: { kind: 'new', type: { name: 'num' }, value: 0 } } }] },
                body: { kind: 'new', type: { name: 'text' }, value: 'zero' },
              },
            ],
            otherwise: { kind: 'new', type: { name: 'text' }, value: 'neg' },
          },
          // ─── loop with switch + flow continue ─────────────────────
          // for (key, value) in numbers { switch value { case 1, 2: continue; case 3: "three"; default: void } }
          {
            kind: 'loop',
            over: { kind: 'get', path: [{ prop: 'numbers' }] },
            body: {
              kind: 'switch',
              value: { kind: 'get', path: [{ prop: 'value' }] },
              cases: [
                {
                  equals: [
                    { kind: 'new', type: { name: 'num' }, value: 1 },
                    { kind: 'new', type: { name: 'num' }, value: 2 },
                  ],
                  body: { kind: 'flow', action: 'continue' },
                },
                {
                  equals: [{ kind: 'new', type: { name: 'num' }, value: 3 }],
                  body: { kind: 'new', type: { name: 'text' }, value: 'three' },
                },
              ],
              else: { kind: 'new', type: { name: 'void' } },
            },
          },
          // ─── set (simple — assign a defined obj's field) ──────────
          // config.env = "dev"
          {
            kind: 'set',
            path: [{ prop: 'config' }, { prop: 'env' }],
            value: { kind: 'new', type: { name: 'text' }, value: 'dev' },
          },
          // ─── native (a registered impl: `text.upper`) ─────────────
          // /* native: text.upper */
          { kind: 'native', id: 'text.upper', type: { name: 'text' } },
          // ─── get (simple — final var read) ────────────────────────
          // url
          { kind: 'get', path: [{ prop: 'url' }] },
        ],
      },
    };
    showRender('COMPREHENSIVE-OK — all expression kinds, well-formed', expr);
    expect(e.toGinCode(expr).toString()).toContain('let');
  });

  test('COMPREHENSIVE-BROKEN. all expression kinds, with mixed problems', () => {
    // Same shape as COMPREHENSIVE-OK but with deliberate errors covering
    // many validator codes:
    //   define.var.type-mismatch     (typed num, value text)
    //   var.unknown                  (referencing undefined name)
    //   if.condition.type            (num where bool expected)
    //   template.placeholder.unresolved
    //   new.value.missing            (new obj with no value)
    //   lambda.returns.type          (body type doesn't match returns)
    //   flow.outside-lambda          (return at top level)
    //   prop.unknown                 (chained get on wrong type)
    const expr: ExprDef = {
      kind: 'block',
      lines: [
        // BAD: const x: num = "wrong"  (define.var.type-mismatch)
        {
          kind: 'define',
          vars: [{
            name: 'x', type: { name: 'num' },
            value: { kind: 'new', type: { name: 'text' }, value: 'wrong' },
          }],
          body: { kind: 'new', type: { name: 'void' } },
        },
        // BAD: const p = unbound  (var.unknown)
        {
          kind: 'define',
          vars: [{ name: 'p', value: { kind: 'get', path: [{ prop: 'unbound' }] } }],
          body: { kind: 'new', type: { name: 'void' } },
        },
        // BAD: new obj with no value  (new.value.missing)
        {
          kind: 'define',
          vars: [{
            name: 'cfg',
            value: { kind: 'new', type: { name: 'obj', props: { env: { type: { name: 'text' } } } } },
          }],
          body: { kind: 'new', type: { name: 'void' } },
        },
        // BAD: template references {host} which is not in scope or params
        {
          kind: 'template',
          template: { kind: 'new', type: { name: 'text' }, value: 'https://{host}/v1' },
        } as ExprDef,
        // BAD: if condition is num, not bool
        {
          kind: 'if',
          ifs: [{
            condition: { kind: 'new', type: { name: 'num' }, value: 1 },
            body: { kind: 'new', type: { name: 'text' }, value: 'yep' },
          }],
        },
        // BAD: lambda declares returns: bool but body returns num
        {
          kind: 'define',
          vars: [{
            name: 'shouldBeBool',
            value: {
              kind: 'lambda',
              type: { name: 'fn', call: { args: { name: 'obj', props: { n: { type: { name: 'num' } } } }, returns: { name: 'bool' } } },
              body: { kind: 'get', path: [{ prop: 'args' }, { prop: 'n' }] },
            },
          }],
          body: { kind: 'new', type: { name: 'void' } },
        },
        // BAD: return at top-level (flow.outside-lambda)
        {
          kind: 'flow', action: 'return',
          value: { kind: 'new', type: { name: 'num' }, value: 1 },
        },
        // BAD: prop.unknown — chaining a method that doesn't exist on num
        {
          kind: 'get',
          path: [{ prop: 'x' }, { prop: 'doesNotExist' }, { args: {} }],
        },
        // OK: a switch that's well-formed amongst the broken stuff so
        // the demo shows mixed-state output (sections with and without
        // problems both rendered).
        {
          kind: 'switch',
          value: { kind: 'new', type: { name: 'num' }, value: 1 },
          cases: [{
            equals: [{ kind: 'new', type: { name: 'num' }, value: 1 }],
            body: { kind: 'new', type: { name: 'text' }, value: 'one' },
          }],
          else: { kind: 'new', type: { name: 'text' }, value: 'other' },
        } as ExprDef,
      ],
    };
    showRender('COMPREHENSIVE-BROKEN — all expression kinds, with mixed problems', expr);
    const probs = e.validate(expr);
    expect(probs.list.length).toBeGreaterThanOrEqual(5);
  });

  test('COMPREHENSIVE-OK-2. custom named types, generics, list.map, list.reduce', () => {
    // Build a registry that knows about a user-named type `Point` so
    // we can demonstrate (1) lambdas whose params/returns reference a
    // custom registered type and (2) generic lambdas that resolve T
    // via call-site bindings. Then exercise list.map and list.reduce
    // with inline lambda callbacks — the higher-order list ops the
    // model reaches for most often.
    const r2 = createRegistry();
    const Point = r2.extend('obj', {
      name: 'Point',
      props: { x: { type: r2.num() }, y: { type: r2.num() } },
    });
    r2.register(Point);
    const e2 = new Engine(r2);

    const expr: ExprDef = {
      kind: 'define',
      vars: [
        // ─── data: a list of Points ─────────────────────────────────
        {
          name: 'points',
          value: {
            kind: 'new',
            type: { name: 'list', generic: { V: { name: 'Point' } } },
            value: [{ x: 1, y: 2 }, { x: 3, y: 4 }, { x: 5, y: 6 }],
          },
        },
        // ─── lambda taking a custom named type ──────────────────────
        // const originDistance = (p: Point): num =>
        //   args.p.x.mul({other: args.p.x}).add({other: args.p.y.mul({other: args.p.y})})
        // (squared distance from origin — close enough for demo)
        {
          name: 'originDistance',
          value: {
            kind: 'lambda',
            type: {
              name: 'fn',
              call: {
                args: { name: 'obj', props: { p: { type: { name: 'Point' } } } },
                returns: { name: 'num' },
              },
            },
            body: {
              kind: 'get',
              path: [
                { prop: 'args' }, { prop: 'p' }, { prop: 'x' },
                { prop: 'mul' },
                { args: { other: { kind: 'get', path: [{ prop: 'args' }, { prop: 'p' }, { prop: 'x' }] } } },
                { prop: 'add' },
                { args: { other: {
                  kind: 'get',
                  path: [
                    { prop: 'args' }, { prop: 'p' }, { prop: 'y' },
                    { prop: 'mul' },
                    { args: { other: { kind: 'get', path: [{ prop: 'args' }, { prop: 'p' }, { prop: 'y' }] } } },
                  ],
                } } },
              ],
            },
          },
        },
        // ─── generic lambda — identity<T> ───────────────────────────
        // const identity = <T>(x: T): T => args.x
        {
          name: 'identity',
          value: {
            kind: 'lambda',
            type: {
              name: 'fn',
              call: {
                generic: { T: { name: 'any' } },
                args: { name: 'obj', props: { x: { type: { name: 'T' } } } },
                returns: { name: 'T' },
              },
            },
            body: { kind: 'get', path: [{ prop: 'args' }, { prop: 'x' }] },
          },
        },
        // ─── list.map — extract each point's x ──────────────────────
        // const xs = points.map({ fn: (value: Point, index: num): num => args.value.x })
        {
          name: 'xs',
          value: {
            kind: 'get',
            path: [
              { prop: 'points' }, { prop: 'map' },
              { args: {
                fn: {
                  kind: 'lambda',
                  type: {
                    name: 'fn',
                    call: {
                      args: {
                        name: 'obj',
                        props: {
                          value: { type: { name: 'Point' } },
                          index: { type: { name: 'num' } },
                        },
                      },
                      returns: { name: 'num' },
                    },
                  },
                  body: { kind: 'get', path: [{ prop: 'args' }, { prop: 'value' }, { prop: 'x' }] },
                },
              } },
            ],
          },
        },
        // ─── list.reduce — sum the x coordinates ────────────────────
        // const totalX = points.reduce({
        //   fn: (acc: num, value: Point, index: num): num => args.acc.add({other: args.value.x}),
        //   initial: 0,
        // })
        {
          name: 'totalX',
          value: {
            kind: 'get',
            path: [
              { prop: 'points' }, { prop: 'reduce' },
              { args: {
                fn: {
                  kind: 'lambda',
                  type: {
                    name: 'fn',
                    call: {
                      args: {
                        name: 'obj',
                        props: {
                          acc: { type: { name: 'num' } },
                          value: { type: { name: 'Point' } },
                          index: { type: { name: 'num' } },
                        },
                      },
                      returns: { name: 'num' },
                    },
                  },
                  body: {
                    kind: 'get',
                    path: [
                      { prop: 'args' }, { prop: 'acc' }, { prop: 'add' },
                      { args: { other: { kind: 'get', path: [{ prop: 'args' }, { prop: 'value' }, { prop: 'x' }] } } },
                    ],
                  },
                },
                initial: { kind: 'new', type: { name: 'num' }, value: 0 },
              } },
            ],
          },
        },
      ],
      body: {
        kind: 'block',
        lines: [
          // Use the custom-typed lambda on the first point
          {
            kind: 'get',
            path: [
              { prop: 'originDistance' },
              { args: { p: { kind: 'get', path: [{ prop: 'points' }, { key: { kind: 'new', type: { name: 'num' }, value: 0 } }] } } },
            ],
          },
          // Use the generic identity with a num argument — concrete T = num
          {
            kind: 'get',
            path: [
              { prop: 'identity' },
              { args: { x: { kind: 'new', type: { name: 'num' }, value: 42 } } },
            ],
          },
          // Final value: total of x coords (validates the reduce result)
          { kind: 'get', path: [{ prop: 'totalX' }] },
        ],
      },
    };
    showRender(
      'COMPREHENSIVE-OK-2 — custom types, generics, list.map, list.reduce',
      expr,
      e2,
    );
    expect(e2.toGinCode(expr).toString()).toContain('map');
  });
});
