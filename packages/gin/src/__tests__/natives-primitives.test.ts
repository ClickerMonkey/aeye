import { describe, test, expect } from 'vitest';
import { createRegistry, Engine } from '../index';
import { primitives } from './_utils';

const e = new Engine(createRegistry());

// Helper to build a method-call program against a single value.
function callOn(type: any, value: any, method: string, args: Record<string, any> = {}) {
  const argExprs: Record<string, any> = {};
  for (const [k, v] of Object.entries(args)) {
    if (v && typeof v === 'object' && 'kind' in v) argExprs[k] = v;
    else argExprs[k] = { kind: 'new', type: typeof v === 'number' ? { name: 'num' } : typeof v === 'string' ? { name: 'text' } : { name: 'bool' }, value: v };
  }
  return {
    kind: 'define',
    vars: [{ name: 's', value: { kind: 'new', type, value } }],
    body: {
      kind: 'get',
      path: [{ prop: 's' }, { prop: method }, { args: argExprs }],
    },
  };
}

describe('num natives', () => {
  test('add/sub/mul/div', async () => {
    expect((await e.run(callOn({ name: 'num' }, 10, 'add', { other: 5 }))).raw).toBe(15);
    expect((await e.run(callOn({ name: 'num' }, 10, 'sub', { other: 3 }))).raw).toBe(7);
    expect((await e.run(callOn({ name: 'num' }, 4,  'mul', { other: 3 }))).raw).toBe(12);
    expect((await e.run(callOn({ name: 'num' }, 10, 'div', { other: 4 }))).raw).toBe(2.5);
  });

  test('comparison', async () => {
    expect((await e.run(callOn({ name: 'num' }, 5, 'lt',  { other: 10 }))).raw).toBe(true);
    expect((await e.run(callOn({ name: 'num' }, 5, 'gte', { other: 5 }))).raw).toBe(true);
    expect((await e.run(callOn({ name: 'num' }, 5, 'eq',  { other: 5 }))).raw).toBe(true);
  });

  test('unary math', async () => {
    expect((await e.run(callOn({ name: 'num' }, -5, 'abs'))).raw).toBe(5);
    expect((await e.run(callOn({ name: 'num' }, 3.7, 'floor'))).raw).toBe(3);
    expect((await e.run(callOn({ name: 'num' }, 3.2, 'ceil'))).raw).toBe(4);
  });

  test('predicates', async () => {
    expect((await e.run(callOn({ name: 'num' }, 0, 'isZero'))).raw).toBe(true);
    expect((await e.run(callOn({ name: 'num' }, 4, 'isEven'))).raw).toBe(true);
    expect((await e.run(callOn({ name: 'num' }, 5, 'isOdd'))).raw).toBe(true);
    expect((await e.run(callOn({ name: 'num' }, 3, 'isInteger'))).raw).toBe(true);
  });

  test('conversion', async () => {
    expect((await e.run(callOn({ name: 'num' }, 42, 'toText'))).raw).toBe('42');
    expect((await e.run(callOn({ name: 'num' }, 0, 'toBoolean'))).raw).toBe(false);
    expect((await e.run(callOn({ name: 'num' }, 5, 'toBoolean'))).raw).toBe(true);
  });
});

describe('text natives', () => {
  test('length field', async () => {
    const program = {
      kind: 'define',
      vars: [{ name: 's', value: { kind: 'new', type: { name: 'text' }, value: 'hello' } }],
      body: { kind: 'get', path: [{ prop: 's' }, { prop: 'length' }] },
    } as const;
    expect((await e.run(program)).raw).toBe(5);
  });

  test('upper/lower/trim', async () => {
    expect((await e.run(callOn({ name: 'text' }, 'hi',   'upper'))).raw).toBe('HI');
    expect((await e.run(callOn({ name: 'text' }, 'HI',   'lower'))).raw).toBe('hi');
    expect((await e.run(callOn({ name: 'text' }, '  x ', 'trim'))).raw).toBe('x');
  });

  test('contains/startsWith/endsWith', async () => {
    expect((await e.run(callOn({ name: 'text' }, 'hello world', 'contains',   { search: 'lo w' }))).raw).toBe(true);
    expect((await e.run(callOn({ name: 'text' }, 'hello',       'startsWith', { prefix: 'hel' }))).raw).toBe(true);
    expect((await e.run(callOn({ name: 'text' }, 'hello',       'endsWith',   { suffix: 'llo' }))).raw).toBe(true);
  });

  test('slice/replace/split/concat/repeat', async () => {
    expect((await e.run(callOn({ name: 'text' }, 'hello', 'slice',   { start: 1, end: 4 }))).raw).toBe('ell');
    expect((await e.run(callOn({ name: 'text' }, 'hello', 'replace', { search: 'l', replacement: 'L' }))).raw).toBe('heLLo');
    expect(primitives(await e.run(callOn({ name: 'text' }, 'a,b,c', 'split',   { separator: ',' })))).toEqual(['a', 'b', 'c']);
    expect((await e.run(callOn({ name: 'text' }, 'ab',    'concat',  { other: 'cd' }))).raw).toBe('abcd');
    expect((await e.run(callOn({ name: 'text' }, 'ab',    'repeat',  { count: 3 }))).raw).toBe('ababab');
  });

  test('toNumber', async () => {
    expect((await e.run(callOn({ name: 'text' }, '42.5', 'toNumber'))).raw).toBe(42.5);
  });
});

describe('bool natives', () => {
  test('and/or/not/xor', async () => {
    expect((await e.run(callOn({ name: 'bool' }, true,  'and', { other: false }))).raw).toBe(false);
    expect((await e.run(callOn({ name: 'bool' }, true,  'or',  { other: false }))).raw).toBe(true);
    expect((await e.run(callOn({ name: 'bool' }, true,  'not'))).raw).toBe(false);
    expect((await e.run(callOn({ name: 'bool' }, true,  'xor', { other: false }))).raw).toBe(true);
  });

  test('toText', async () => {
    expect((await e.run(callOn({ name: 'bool' }, true,  'toText'))).raw).toBe('true');
    expect((await e.run(callOn({ name: 'bool' }, false, 'toText'))).raw).toBe('false');
  });
});

describe('any natives', () => {
  test('typeOf', async () => {
    expect((await e.run(callOn({ name: 'any' }, 42, 'typeOf'))).raw).toBe('any');
  });
});
