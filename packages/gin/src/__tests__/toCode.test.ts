import { describe, test, expect } from 'vitest';
import { createRegistry, Engine } from '../index';

/**
 * Type.toCode() and Engine.toCode(expr) render types/expressions as
 * TypeScript-like source for docs, debugging, and LLM prompts. Output is
 * not guaranteed to parse — emphasis is on readability.
 */

describe('Type.toCode — primitives', () => {
  const r = createRegistry();
  test('any',       () => expect(r.any().toCode()).toBe('any'));
  test('void',      () => expect(r.void().toCode()).toBe('void'));
  test('null',      () => expect(r.null().toCode()).toBe('null'));
  test('bool',      () => expect(r.bool().toCode()).toBe('bool'));
  test('num',       () => expect(r.num().toCode()).toBe('num'));
  test('text',      () => expect(r.text().toCode()).toBe('text'));
  test('date',      () => expect(r.date().toCode()).toBe('date'));
  test('timestamp', () => expect(r.timestamp().toCode()).toBe('timestamp'));
  test('duration',  () => expect(r.duration().toCode()).toBe('duration'));
  test('color',     () => expect(r.color().toCode()).toBe('color'));
  test('num with options → num{min=0, max=100, whole=true}', () => {
    expect(r.num({ min: 0, max: 100, whole: true }).toCode())
      .toBe('num{min=0, max=100, whole=true}');
  });
  test('text with options → text{minLength=1, pattern="^a"}', () => {
    expect(r.text({ minLength: 1, pattern: '^a' }).toCode())
      .toBe('text{minLength=1, pattern="^a"}');
  });
});

describe('Type.toCode — collections', () => {
  const r = createRegistry();
  test('list<num>', () => {
    expect(r.list(r.num()).toCode()).toBe('list<num>');
  });
  test('list<text>', () => {
    expect(r.list(r.text()).toCode()).toBe('list<text>');
  });
  test('list<optional<num>>', () => {
    expect(r.list(r.optional(r.num())).toCode()).toBe('list<optional<num>>');
  });
  test('list with length options', () => {
    expect(r.list(r.num(), { minLength: 1, maxLength: 5 }).toCode())
      .toBe('list<num>{minLength=1, maxLength=5}');
  });
  test('map<text, num>', () => {
    expect(r.map(r.text(), r.num()).toCode()).toBe('map<text, num>');
  });
  test('tuple<num, text, bool>', () => {
    expect(r.tuple([r.num(), r.text(), r.bool()]).toCode()).toBe('tuple<num, text, bool>');
  });
  test('obj empty → obj', () => {
    expect(r.obj({}).toCode()).toBe('obj');
  });
  test('obj with fields → obj{name: text, age: num}', () => {
    const t = r.obj({ name: { type: r.text() }, age: { type: r.num() } });
    expect(t.toCode()).toBe('obj{name: text, age: num}');
  });
  test('obj with Optional field → name? syntax', () => {
    const t = r.obj({ name: { type: r.text() }, middle: { type: r.optional(r.text()) } });
    expect(t.toCode()).toBe('obj{name: text, middle?: text}');
  });
});

describe('Type.toCode — wrappers and combinators', () => {
  const r = createRegistry();
  test('optional<T>', () => {
    expect(r.optional(r.num()).toCode()).toBe('optional<num>');
  });
  test('nullable<T>', () => {
    expect(r.nullable(r.text()).toCode()).toBe('nullable<text>');
  });
  test('or<A, B>', () => {
    expect(r.or([r.num(), r.text()]).toCode()).toBe('or<num, text>');
  });
  test('and<A, B>', () => {
    const a = r.obj({ a: { type: r.num() } });
    const b = r.obj({ b: { type: r.text() } });
    expect(r.and([a, b]).toCode()).toBe('and<obj{a: num}, obj{b: text}>');
  });
  test('not<T>', () => {
    expect(r.not(r.num()).toCode()).toBe('not<num>');
  });
  test('enum of strings → enum<text>{KEY="val", ...}', () => {
    const t = r.enum({ RED: 'red', GREEN: 'green', BLUE: 'blue' }, r.text());
    expect(t.toCode()).toBe('enum<text>{RED="red", GREEN="green", BLUE="blue"}');
  });
  test('literal(text) → literal<text>{value="foo"}', () => {
    expect(r.literal(r.text(), 'foo').toCode()).toBe('literal<text>{value="foo"}');
  });
  test('literal(num) → literal<num>{value=42}', () => {
    expect(r.literal(r.num(), 42).toCode()).toBe('literal<num>{value=42}');
  });
});

describe('Type.toCode — functions and references', () => {
  const r = createRegistry();
  test('fn → flattened signature', () => {
    const fn = r.fn(r.obj({ x: { type: r.num() } }), r.text());
    expect(fn.toCode()).toBe('(x: num): text');
  });
  test('fn returning void', () => {
    const fn = r.fn(r.obj({}), r.void());
    expect(fn.toCode()).toBe('(): void');
  });
  test('fn with generics', () => {
    const fn = r.fn(r.obj({ x: { type: r.alias('T') } }), r.alias('T'), undefined, { T: r.any() });
    expect(fn.toCode()).toBe('<T>(x: T): T');
  });
  test('ref → bare name', () => {
    expect(r.alias('User').toCode()).toBe('User');
  });
  test('generic → bare name', () => {
    expect(r.alias('T').toCode()).toBe('T');
  });
  test('iface renders struct-style', () => {
    const t = r.iface({
      props: {
        name: { type: { name: 'text' } },
        age:  { type: { name: 'num' } },
      },
    });
    expect(t.toCode()).toBe('iface{name: text, age: num}');
  });
  test('extension → its declared name', () => {
    const t = r.extend('num', { name: 'Money', options: { min: 0 } });
    expect(t.toCode()).toBe('Money');
  });
});

describe('Engine.toCode — expressions', () => {
  const e = new Engine(createRegistry());

  test('new on optional type with no value renders as undefined', () => {
    expect(e.toCode({
      kind: 'new',
      type: { name: 'optional', generic: { T: { name: 'num' } } },
    })).toBe('undefined');
  });

  test('new on non-optional type with no value renders as new T()', () => {
    expect(e.toCode({ kind: 'new', type: { name: 'num' } })).toBe('new num()');
  });

  test('new primitive literal', () => {
    expect(e.toCode({ kind: 'new', type: { name: 'num' }, value: 42 })).toBe('42');
    expect(e.toCode({ kind: 'new', type: { name: 'text' }, value: 'hi' })).toBe('"hi"');
    expect(e.toCode({ kind: 'new', type: { name: 'bool' }, value: true })).toBe('true');
    expect(e.toCode({ kind: 'new', type: { name: 'null' } })).toBe('new null()');
  });

  test('get path with method call', () => {
    const code = e.toCode({
      kind: 'get',
      path: [
        { prop: 'x' }, { prop: 'add' },
        { args: { other: { kind: 'new', type: { name: 'num' }, value: 5 } } },
      ],
    });
    expect(code).toBe('x.add({ other: 5 })');
  });

  test('get path with index access', () => {
    const code = e.toCode({
      kind: 'get',
      path: [{ prop: 'arr' }, { key: { kind: 'new', type: { name: 'num' }, value: 0 } }],
    });
    expect(code).toBe('arr[0]');
  });

  test('set single-var', () => {
    const code = e.toCode({
      kind: 'set',
      path: [{ prop: 'x' }],
      value: { kind: 'new', type: { name: 'num' }, value: 99 },
    });
    expect(code).toBe('x = 99');
  });

  test('set indexed', () => {
    const code = e.toCode({
      kind: 'set',
      path: [{ prop: 'arr' }, { key: { kind: 'new', type: { name: 'num' }, value: 0 } }],
      value: { kind: 'new', type: { name: 'num' }, value: 99 },
    });
    expect(code).toBe('arr[0] = 99');
  });

  test('define renders as statements by default', () => {
    const code = e.toCode({
      kind: 'define',
      vars: [{ name: 'x', value: { kind: 'new', type: { name: 'num' }, value: 10 } }],
      body: { kind: 'get', path: [{ prop: 'x' }] },
    });
    expect(code).toContain('let x = 10');
    expect(code).toContain('x;');
  });

  test('define IIFE with expectsValue: true', () => {
    const code = e.toCode({
      kind: 'define',
      vars: [{ name: 'x', value: { kind: 'new', type: { name: 'num' }, value: 10 } }],
      body: { kind: 'get', path: [{ prop: 'x' }] },
    }, { expectsValue: true });
    expect(code).toContain('let x');
    expect(code).toContain('return x');
  });

  test('if renders as statement by default', () => {
    const code = e.toCode({
      kind: 'if',
      ifs: [{
        condition: { kind: 'new', type: { name: 'bool' }, value: true },
        body: { kind: 'new', type: { name: 'num' }, value: 1 },
      }],
      else: { kind: 'new', type: { name: 'num' }, value: 2 },
    });
    expect(code).toContain('if (true)');
    expect(code).toContain('else');
  });

  test('if ternary with expectsValue: true', () => {
    const code = e.toCode({
      kind: 'if',
      ifs: [{
        condition: { kind: 'new', type: { name: 'bool' }, value: true },
        body: { kind: 'new', type: { name: 'num' }, value: 1 },
      }],
      else: { kind: 'new', type: { name: 'num' }, value: 2 },
    }, { expectsValue: true });
    expect(code).toBe('(true ? 1 : 2)');
  });

  test('ExprDef.comment is emitted and round-trips through encode', () => {
    const code = e.toCode({
      kind: 'block',
      lines: [
        {
          kind: 'set',
          path: [{ prop: 'x' }],
          value: { kind: 'new', type: { name: 'num' }, value: 1 },
          comment: 'initialize x',
        },
        {
          kind: 'if',
          ifs: [{
            condition: { kind: 'new', type: { name: 'bool' }, value: true },
            body: { kind: 'flow', action: 'return', value: { kind: 'new', type: { name: 'num' }, value: 1 } },
          }],
          comment: 'early exit',
        },
      ],
    });
    expect(code).toContain('// initialize x');
    expect(code).toContain('// early exit');
    expect(code).toContain('x = 1;');
    expect(code).toContain('return 1');
  });

  test('ExprDef.comment renders inline in expression position', () => {
    const code = e.toCode({
      kind: 'get',
      path: [{ prop: 'x' }],
      comment: 'read x',
    }, { expectsValue: true });
    expect(code).toBe('/* read x */ x');
  });

  test('ExprDef.comment survives encode round-trip', () => {
    const r = createRegistry();
    const def = {
      kind: 'new' as const,
      type: { name: 'num' as const },
      value: 42,
      comment: 'the answer',
    };
    const parsed = r.parseExpr(def);
    expect(parsed.comment).toBe('the answer');
    const roundtripped = parsed.toJSON();
    expect(roundtripped.comment).toBe('the answer');
  });

  test('if with DEEP return still forces statement form (traversal-based)', () => {
    // return is nested inside a block inside the branch body; still escapes.
    const code = e.toCode({
      kind: 'if',
      ifs: [{
        condition: { kind: 'new', type: { name: 'bool' }, value: true },
        body: {
          kind: 'block',
          lines: [
            { kind: 'new', type: { name: 'num' }, value: 0 },
            { kind: 'flow', action: 'return', value: { kind: 'new', type: { name: 'num' }, value: 7 } },
          ],
        },
      }],
      else: { kind: 'new', type: { name: 'num' }, value: 0 },
    }, { expectsValue: true });
    expect(code).not.toContain('?'); // no ternary
    expect(code).toContain('if (true)');
    expect(code).toContain('return 7');
  });

  test('if with return INSIDE a nested lambda does NOT force statement form', () => {
    // The return is caught by the lambda — it doesn't escape the if.
    const code = e.toCode({
      kind: 'if',
      ifs: [{
        condition: { kind: 'new', type: { name: 'bool' }, value: true },
        body: {
          kind: 'lambda',
          type: { name: 'fn', call: { args: { name: 'obj' }, returns: { name: 'num' } } },
          body: { kind: 'flow', action: 'return', value: { kind: 'new', type: { name: 'num' }, value: 7 } },
        },
      }],
      else: {
        kind: 'lambda',
        type: { name: 'fn', call: { args: { name: 'obj' }, returns: { name: 'num' } } },
        body: { kind: 'new', type: { name: 'num' }, value: 0 },
      },
    }, { expectsValue: true });
    // Ternary is allowed because the lambda contains the return.
    expect(code).toContain('?');
  });

  test('if with break inside a nested loop does NOT force statement form', () => {
    const code = e.toCode({
      kind: 'if',
      ifs: [{
        condition: { kind: 'new', type: { name: 'bool' }, value: true },
        body: {
          kind: 'loop',
          over: { kind: 'new', type: { name: 'list', generic: { V: { name: 'num' } } }, value: [1] },
          body: { kind: 'flow', action: 'break' },
        },
      }],
      else: {
        kind: 'loop',
        over: { kind: 'new', type: { name: 'list', generic: { V: { name: 'num' } } }, value: [1] },
        body: { kind: 'flow', action: 'continue' },
      },
    }, { expectsValue: true });
    // Ternary is allowed — break/continue stay inside their loops.
    expect(code).toContain('?');
  });

  test('if with flow body renders as statement even when expectsValue: true', () => {
    const code = e.toCode({
      kind: 'if',
      ifs: [{
        condition: { kind: 'new', type: { name: 'bool' }, value: true },
        body: { kind: 'flow', action: 'return', value: { kind: 'new', type: { name: 'num' }, value: 1 } },
      }],
    }, { expectsValue: true });
    expect(code).toContain('if (true)');
    expect(code).toContain('return 1');
    expect(code).not.toContain('?');
  });

  test('lambda', () => {
    const code = e.toCode({
      kind: 'lambda',
      type: {
        name: 'fn',
        call: { args: { name: 'obj', props: { n: { type: { name: 'num' } } } }, returns: { name: 'num' } },
      },
      body: {
        kind: 'get',
        path: [
          { prop: 'args' }, { prop: 'n' }, { prop: 'mul' },
          { args: { other: { kind: 'new', type: { name: 'num' }, value: 2 } } },
        ],
      },
    });
    expect(code).toBe('(n: num): num => args.n.mul({ other: 2 })');
  });

  test('template with static params inlines interpolations', () => {
    const code = e.toCode({
      kind: 'template',
      template: { kind: 'new', type: { name: 'text' }, value: 'Hello {name}!' },
      params: {
        kind: 'new',
        type: { name: 'obj', props: { name: { type: { name: 'text' } } } },
        value: { name: 'Alice' },
      },
    });
    expect(code).toBe('`Hello ${"Alice"}!`');
  });

  test('flow return', () => {
    expect(e.toCode({ kind: 'flow', action: 'return', value: { kind: 'new', type: { name: 'num' }, value: 7 } }))
      .toBe('return 7');
    expect(e.toCode({ kind: 'flow', action: 'break' })).toBe('break');
    expect(e.toCode({ kind: 'flow', action: 'continue' })).toBe('continue');
    expect(e.toCode({ kind: 'flow', action: 'throw', error: { kind: 'new', type: { name: 'text' }, value: 'boom' } }))
      .toBe('throw "boom"');
  });

  test('native as comment', () => {
    expect(e.toCode({ kind: 'native', id: 'num.add' })).toBe('/* native: num.add */');
  });

  test('loop for-of', () => {
    const code = e.toCode({
      kind: 'loop',
      over: { kind: 'get', path: [{ prop: 'arr' }] },
      body: { kind: 'get', path: [{ prop: 'value' }] },
    });
    expect(code).toContain('for (const [key, value] of arr)');
  });

  test('switch IIFE', () => {
    const code = e.toCode({
      kind: 'switch',
      value: { kind: 'get', path: [{ prop: 'x' }] },
      cases: [{
        equals: [{ kind: 'new', type: { name: 'num' }, value: 1 }],
        body: { kind: 'new', type: { name: 'text' }, value: 'one' },
      }],
      else: { kind: 'new', type: { name: 'text' }, value: 'other' },
    });
    expect(code).toContain('switch (x)');
    expect(code).toContain('case 1:');
    expect(code).toContain('default:');
  });
});
