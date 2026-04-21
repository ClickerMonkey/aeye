import { describe, test, expect } from 'vitest';
import { createRegistry, Engine } from '../index';
import { primitives } from './_utils';

const e = new Engine(createRegistry());

function listOf(type: string, value: any[]) {
  return { kind: 'new', type: { name: 'list', generic: { V: { name: type } } }, value };
}
function method(self: any, name: string, args: Record<string, any> = {}) {
  return {
    kind: 'get',
    path: [
      { prop: 's' },
      { prop: name },
      { args },
    ],
  };
}

async function runOn(listJson: any, name: string, args: Record<string, any> = {}) {
  return e.run({
    kind: 'define',
    vars: [{ name: 's', value: listJson }],
    body: method(null, name, args),
  });
}

describe('list natives', () => {
  test('length + push + pop', async () => {
    const program = {
      kind: 'define',
      vars: [{ name: 'arr', value: listOf('num', [1, 2, 3]) }],
      body: {
        kind: 'block',
        lines: [
          {
            kind: 'get', path: [
              { prop: 'arr' }, { prop: 'push' },
              { args: { value: { kind: 'new', type: { name: 'num' }, value: 4 } } },
            ],
          },
          { kind: 'get', path: [{ prop: 'arr' }, { prop: 'length' }] },
        ],
      },
    } as const;
    expect((await e.run(program)).raw).toBe(4);
  });

  test('at returns Optional<V>', async () => {
    expect((await runOn(listOf('num', [10, 20, 30]), 'at', { index: { kind: 'new', type: { name: 'num' }, value: 1 } })).raw).toBe(20);
    expect((await runOn(listOf('num', [10, 20, 30]), 'at', { index: { kind: 'new', type: { name: 'num' }, value: 99 } })).raw).toBe(undefined);
  });

  test('indexOf + contains + unique + duplicates', async () => {
    expect((await runOn(listOf('num', [1, 2, 3]), 'indexOf',    { value: { kind: 'new', type: { name: 'num' }, value: 2 } })).raw).toBe(1);
    expect((await runOn(listOf('num', [1, 2, 3]), 'contains',   { value: { kind: 'new', type: { name: 'num' }, value: 2 } })).raw).toBe(true);
    expect(primitives(await runOn(listOf('num', [1, 2, 2, 3]), 'unique'))).toEqual([1, 2, 3]);
    expect(primitives(await runOn(listOf('num', [1, 2, 2, 3, 3]), 'duplicates'))).toEqual([2, 3]);
  });

  test('slice + concat + reverse + join', async () => {
    expect(primitives(await runOn(listOf('num', [1, 2, 3, 4]), 'slice',   { start: { kind: 'new', type: { name: 'num' }, value: 1 }, end: { kind: 'new', type: { name: 'num' }, value: 3 } }))).toEqual([2, 3]);
    expect(primitives(await runOn(listOf('num', [1, 2]),       'concat',  { other: listOf('num', [3, 4]) }))).toEqual([1, 2, 3, 4]);
    expect(primitives(await runOn(listOf('num', [1, 2, 3]),    'reverse'))).toEqual([3, 2, 1]);
    expect((await runOn(listOf('text', ['a', 'b']),  'join',    { separator: { kind: 'new', type: { name: 'text' }, value: '-' } })).raw).toBe('a-b');
  });

  test('some + every', async () => {
    const program = (fn: any, method: string) => ({
      kind: 'define',
      vars: [{ name: 's', value: listOf('num', [1, 2, 3]) }],
      body: { kind: 'get', path: [{ prop: 's' }, { prop: method }, { args: { fn } }] },
    });
    const gt2 = {
      kind: 'lambda',
      type: { name: 'function', call: { args: { name: 'object' }, returns: { name: 'bool' } } },
      body: { kind: 'get', path: [{ prop: 'args' }, { prop: 'value' }, { prop: 'gt' }, { args: { other: { kind: 'new', type: { name: 'num' }, value: 2 } } }] },
    };
    expect((await e.run(program(gt2, 'some'))).raw).toBe(true);
    expect((await e.run(program(gt2, 'every'))).raw).toBe(false);
  });

  test('isEmpty + isNotEmpty + first + last', async () => {
    expect((await runOn(listOf('num', []),     'isEmpty')).raw).toBe(true);
    expect((await runOn(listOf('num', [1]),    'isNotEmpty')).raw).toBe(true);
    const first = await e.run({
      kind: 'define',
      vars: [{ name: 's', value: listOf('num', [10, 20, 30]) }],
      body: { kind: 'get', path: [{ prop: 's' }, { prop: 'first' }] },
    });
    expect(first.raw).toBe(10);
    const last = await e.run({
      kind: 'define',
      vars: [{ name: 's', value: listOf('num', [10, 20, 30]) }],
      body: { kind: 'get', path: [{ prop: 's' }, { prop: 'last' }] },
    });
    expect(last.raw).toBe(30);
  });
});

describe('map natives', () => {
  test('size/has/at/delete', async () => {
    const m = { kind: 'new', type: { name: 'map', generic: { K: { name: 'text' }, V: { name: 'num' } } }, value: [['a', 1], ['b', 2]] };
    const withM = (body: any) => ({ kind: 'define', vars: [{ name: 's', value: m }], body });

    expect((await e.run(withM({ kind: 'get', path: [{ prop: 's' }, { prop: 'size' }] }))).raw).toBe(2);
    expect((await e.run(withM({ kind: 'get', path: [{ prop: 's' }, { prop: 'has' }, { args: { key: { kind: 'new', type: { name: 'text' }, value: 'a' } } }] }))).raw).toBe(true);
    expect((await e.run(withM({ kind: 'get', path: [{ prop: 's' }, { prop: 'at' },  { args: { key: { kind: 'new', type: { name: 'text' }, value: 'a' } } }] }))).raw).toBe(1);
    expect((await e.run(withM({ kind: 'get', path: [{ prop: 's' }, { prop: 'at' },  { args: { key: { kind: 'new', type: { name: 'text' }, value: 'x' } } }] }))).raw).toBe(undefined);
  });

  test('keys + values', async () => {
    const m = { kind: 'new', type: { name: 'map', generic: { K: { name: 'text' }, V: { name: 'num' } } }, value: [['a', 1], ['b', 2]] };
    const kv = (prop: string) => e.run({
      kind: 'define', vars: [{ name: 's', value: m }],
      body: { kind: 'get', path: [{ prop: 's' }, { prop }, { args: {} }] },
    });
    expect(primitives(await kv('keys'))).toEqual(['a', 'b']);
    expect(primitives(await kv('values'))).toEqual([1, 2]);
  });
});

describe('obj natives', () => {
  test('keys/values/entries/has', async () => {
    const objType = { name: 'object', props: { name: { type: { name: 'text' } }, age: { type: { name: 'num' } } } };
    const obj = { kind: 'new', type: objType, value: { name: 'Alice', age: 30 } };
    const call = (prop: string, args: any = {}) => e.run({
      kind: 'define', vars: [{ name: 's', value: obj }],
      body: { kind: 'get', path: [{ prop: 's' }, { prop }, { args }] },
    });
    expect(primitives(await call('keys'))).toEqual(['name', 'age']);
    expect((await call('has', { key: { kind: 'new', type: { name: 'text' }, value: 'name' } })).raw).toBe(true);
    expect((await call('has', { key: { kind: 'new', type: { name: 'text' }, value: 'missing' } })).raw).toBe(false);
  });

  test('indexed access', async () => {
    const objType = { name: 'object', props: { name: { type: { name: 'text' } }, age: { type: { name: 'num' } } } };
    const obj = { kind: 'new', type: objType, value: { name: 'Alice', age: 30 } };
    const result = await e.run({
      kind: 'define', vars: [{ name: 's', value: obj }],
      body: { kind: 'get', path: [{ prop: 's' }, { key: { kind: 'new', type: { name: 'text' }, value: 'name' } }] },
    });
    expect(result.raw).toBe('Alice');
  });
});
