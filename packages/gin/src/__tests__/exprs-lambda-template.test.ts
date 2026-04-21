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
                  name: 'function',
                  call: {
                    args: { name: 'object', props: { value: { type: { name: 'num' } }, index: { type: { name: 'num' } } } },
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
                type: { name: 'function', call: { args: { name: 'object' }, returns: { name: 'bool' } } },
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
        type: { name: 'object', props: { name: { type: { name: 'text' } }, count: { type: { name: 'num' } } } },
        value: { name: 'Alice', count: 3 },
      },
    });
    expect(v.raw).toBe('Hello Alice, you have 3 messages');
  });

  test('missing placeholder becomes empty', async () => {
    const v = await e.run({
      kind: 'template',
      template: { kind: 'new', type: { name: 'text' }, value: 'hi {missing}' },
      params: { kind: 'new', type: { name: 'object', props: {} }, value: {} },
    });
    expect(v.raw).toBe('hi ');
  });
});
