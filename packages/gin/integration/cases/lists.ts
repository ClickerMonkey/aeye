/**
 * LIST cases — operate over a `list<...>` parameter (filter / length / reduce).
 * Each oracle is a trivial plain-JS function over the raw input; the trap is a
 * near-miss a wrong construct would produce (e.g. counting ALL items, or summing
 * the wrong field).
 */
import { a } from './assert';
import type { EvalCase } from './types';

export const listCases: EvalCase[] = [
  {
    id: 'list-count-done',
    category: 'list',
    request:
      'You are given a list of task items, each with a boolean `done` field. Return how many of them are done.',
    note: 'Filter-then-length. Returning the TOTAL count (list length) ignores the `done` filter; the mixed inputs make that wrong.',
    argsType: {
      name: 'obj',
      props: {
        items: {
          type: {
            name: 'list',
            generic: { V: { name: 'obj', props: { done: { type: { name: 'bool' } } } } },
          },
        },
      },
    },
    returnType: { name: 'num' },
    inputs: [
      { items: [{ done: true }, { done: false }, { done: true }] },
      { items: [{ done: false }, { done: false }] },
      { items: [{ done: true }, { done: true }, { done: true }, { done: false }] },
    ],
    assert: [
      a.produces((args) => {
        const items = (args['items'] ?? []) as ReadonlyArray<{ done: boolean }>;
        return items.filter((t) => t.done).length;
      }),
      a.returnsType('num'),
    ],
  },
  {
    id: 'list-sum-amounts',
    category: 'list',
    request: 'You are given a list of numbers `amounts`. Return their sum. An empty list sums to 0.',
    note: 'Reduce/fold over a list. A model that returns the COUNT, the max, or the first element fails on the varied inputs.',
    argsType: {
      name: 'obj',
      props: { amounts: { type: { name: 'list', generic: { V: { name: 'num' } } } } },
    },
    returnType: { name: 'num' },
    inputs: [
      { amounts: [1, 2, 3, 4] },
      { amounts: [] },
      { amounts: [10, -5, 2.5] },
    ],
    assert: [
      a.produces((args) => {
        const amounts = (args['amounts'] ?? []) as ReadonlyArray<number>;
        return amounts.reduce((s, n) => s + n, 0);
      }),
      a.returnsType('num'),
    ],
  },
];
