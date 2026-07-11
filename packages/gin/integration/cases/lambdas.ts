/**
 * lambda / higher-order cases — the generated function must reach for a list
 * higher-order op (`map` / `filter` / `reduce` / `sort` / `find` / `some` /
 * `every`) and wire a LAMBDA into it. Each oracle is a trivial plain-JS
 * equivalent over the raw input; the trap is what a wrong construct produces
 * (operating on ALL elements, the wrong field, wrong sort direction, or a
 * guessed predicate threshold).
 *
 * PARAM-ACCESS PATHS the model must emit (verified against `src/types/list.ts`
 * and the README `list` signatures):
 *  - TOP-LEVEL params live under `args.<name>` — e.g. the `nums` param is
 *    `[{prop:'args'},{prop:'nums'}]`.
 *  - Inside a `map`/`filter`/`find`/`some`/`every` CALLBACK the element is
 *    `args.value` and the position is `args.index` (callback sig
 *    `(value, index) => …`), so a field read is `args.value.<field>` — exactly
 *    the README `tasks.filter(fn)` shape where `fn` reads `args.value.<field>`.
 *  - A `reduce` callback sees `args.acc` / `args.value` / `args.index`.
 *  - A `sort` comparator sees `args.a` / `args.b` and returns a num.
 * These paths are the model's job to produce; the ORACLES below are plain JS and
 * never touch gin `ExprDef`s. `a.usesKind('lambda')` is a WARN (advisory) — a
 * program that reaches the same outputs by another construct still passes.
 */
import { a } from './assert';
import type { EvalCase, FnSpec } from './types';

// ════════════════════════════════════════════════════════════════════════════
// Reusable arg-type fragments
// ════════════════════════════════════════════════════════════════════════════

/** A `list<num>` obj-prop payload keyed `nums`. */
const NUMS_ARG = {
  name: 'obj',
  props: { nums: { type: { name: 'list', generic: { V: { name: 'num' } } } } },
} as const;

// ════════════════════════════════════════════════════════════════════════════
// fns-with-distractors: candidate PREDICATES (only one is correct)
// ════════════════════════════════════════════════════════════════════════════

/** The priority threshold `isHighPriority` hides — unguessable, so the fn is
 *  genuinely load-bearing (a model that inlines a guessed cutoff mis-counts). */
const HIGH_PRIORITY_MIN = 8;

/** One event: a `{name, priority}` obj — the element type the predicates test. */
const EVENT_TYPE = {
  name: 'obj',
  props: { name: { type: { name: 'text' } }, priority: { type: { name: 'num' } } },
} as const;

/** The predicates each take `{event}` and return bool. `impl` receives the plain
 *  `{event: {name, priority}}` decode. Only `isHighPriority` answers the request;
 *  the other three are plausible-but-wrong predicate distractors. */
const eventPredicates: FnSpec[] = [
  {
    name: 'isHighPriority',
    args: { name: 'obj', props: { event: { type: EVENT_TYPE } } },
    returns: { name: 'bool' },
    impl: (args) => {
      const event = (args['event'] ?? {}) as { priority: number };
      return event.priority >= HIGH_PRIORITY_MIN;
    },
    docs: 'True when an event counts as high priority (applies the internal priority cutoff)',
    probe: { event: { name: 'launch', priority: 9 } },
  },
  {
    name: 'isLowPriority',
    args: { name: 'obj', props: { event: { type: EVENT_TYPE } } },
    returns: { name: 'bool' },
    impl: (args) => {
      const event = (args['event'] ?? {}) as { priority: number };
      return event.priority <= 2;
    },
    docs: 'True when an event is low priority',
    distractor: true,
    probe: { event: { name: 'cleanup', priority: 1 } },
  },
  {
    name: 'hasName',
    args: { name: 'obj', props: { event: { type: EVENT_TYPE } } },
    returns: { name: 'bool' },
    impl: (args) => {
      const event = (args['event'] ?? {}) as { name: string };
      return event.name.length > 0;
    },
    docs: 'True when an event has a non-empty name',
    distractor: true,
    probe: { event: { name: 'launch', priority: 9 } },
  },
  {
    name: 'isUrgentName',
    args: { name: 'obj', props: { event: { type: EVENT_TYPE } } },
    returns: { name: 'bool' },
    impl: (args) => {
      const event = (args['event'] ?? {}) as { name: string };
      return event.name.toLowerCase().includes('urgent');
    },
    docs: 'True when an event name mentions "urgent"',
    distractor: true,
    probe: { event: { name: 'urgent patch', priority: 3 } },
  },
];

// ════════════════════════════════════════════════════════════════════════════
// Cases
// ════════════════════════════════════════════════════════════════════════════

export const lambdaCases: EvalCase[] = [
  // ── map (simplest): transform every element ────────────────────────────────
  {
    id: 'lambda-map-triple',
    category: 'lambda',
    request:
      'You are given a list of numbers `nums`. Return a NEW list where every number has been multiplied by 3, in the same order.',
    note: 'Map/transform over a list. Returning `nums` unchanged, the sum, or the length all fail; the empty-list input must map to an empty list.',
    argsType: NUMS_ARG,
    returnType: { name: 'list', generic: { V: { name: 'num' } } },
    inputs: [
      { nums: [1, 2, 3] },
      { nums: [] },
      { nums: [0, -4, 2.5, 10] },
    ],
    assert: [
      a.produces((args) => {
        const nums = (args['nums'] ?? []) as ReadonlyArray<number>;
        return nums.map((n) => n * 3);
      }),
      a.usesKind('lambda'),
      a.returnsType('list'),
    ],
  },

  // ── filter: keep the elements matching a predicate ─────────────────────────
  {
    id: 'lambda-filter-active-users',
    category: 'lambda',
    request:
      'You are given a list of users `users`, each with a `name` and a boolean `active`. Return the sublist of users that are active, preserving order.',
    note: 'Filter a list<obj> by a boolean field. Returning ALL users ignores the predicate; the mixed / none-active / all-active inputs make that wrong. Output element shape must still carry both fields.',
    argsType: {
      name: 'obj',
      props: {
        users: {
          type: {
            name: 'list',
            generic: {
              V: {
                name: 'obj',
                props: { name: { type: { name: 'text' } }, active: { type: { name: 'bool' } } },
              },
            },
          },
        },
      },
    },
    returnType: {
      name: 'list',
      generic: {
        V: {
          name: 'obj',
          props: { name: { type: { name: 'text' } }, active: { type: { name: 'bool' } } },
        },
      },
    },
    inputs: [
      { users: [{ name: 'Ann', active: true }, { name: 'Bo', active: false }, { name: 'Cy', active: true }] },
      { users: [] },
      { users: [{ name: 'Di', active: false }, { name: 'Ed', active: false }] },
      { users: [{ name: 'Fi', active: true }, { name: 'Gu', active: true }] },
    ],
    assert: [
      a.produces((args) => {
        const users = (args['users'] ?? []) as ReadonlyArray<{ name: string; active: boolean }>;
        return users.filter((u) => u.active);
      }),
      a.usesKind('lambda'),
      a.returnsType('list'),
    ],
  },

  // ── count matching: filter-then-length over a predicate ────────────────────
  {
    id: 'lambda-count-instock',
    category: 'lambda',
    request:
      'You are given a list of products `products`, each with a `name` and a numeric `stock`. Return how many products have stock strictly greater than 0.',
    note: 'Count-matching (filter then length). Returning the TOTAL product count ignores the stock predicate; an all-zero-stock input must yield 0.',
    argsType: {
      name: 'obj',
      props: {
        products: {
          type: {
            name: 'list',
            generic: {
              V: {
                name: 'obj',
                props: { name: { type: { name: 'text' } }, stock: { type: { name: 'num' } } },
              },
            },
          },
        },
      },
    },
    returnType: { name: 'num' },
    inputs: [
      { products: [{ name: 'pen', stock: 3 }, { name: 'ink', stock: 0 }, { name: 'pad', stock: 12 }] },
      { products: [] },
      { products: [{ name: 'x', stock: 0 }, { name: 'y', stock: 0 }] },
      { products: [{ name: 'a', stock: 1 }, { name: 'b', stock: 5 }, { name: 'c', stock: 2 }] },
    ],
    assert: [
      a.produces((args) => {
        const products = (args['products'] ?? []) as ReadonlyArray<{ stock: number }>;
        return products.filter((p) => p.stock > 0).length;
      }),
      a.usesKind('lambda'),
      a.returnsType('num'),
    ],
  },

  // ── reduce/fold: derive a scalar from every element ────────────────────────
  {
    id: 'lambda-reduce-cart-total',
    category: 'lambda',
    request:
      'You are given a shopping cart `items`, each item having a numeric `price` and integer `qty`. Return the cart total: the sum over all items of price times qty. An empty cart totals 0.',
    note: 'Reduce/fold combining TWO fields per element. Summing only price (ignoring qty), or only qty, or returning the item count, fails on the varied inputs. Empty list folds to the initial 0.',
    argsType: {
      name: 'obj',
      props: {
        items: {
          type: {
            name: 'list',
            generic: {
              V: {
                name: 'obj',
                props: { price: { type: { name: 'num' } }, qty: { type: { name: 'num' } } },
              },
            },
          },
        },
      },
    },
    returnType: { name: 'num' },
    inputs: [
      { items: [{ price: 2, qty: 3 }, { price: 5, qty: 1 }] },
      { items: [] },
      { items: [{ price: 1.5, qty: 4 }, { price: 10, qty: 0 }, { price: 3, qty: 2 }] },
    ],
    assert: [
      a.produces((args) => {
        const items = (args['items'] ?? []) as ReadonlyArray<{ price: number; qty: number }>;
        return items.reduce((sum, it) => sum + it.price * it.qty, 0);
      }),
      a.usesKind('lambda'),
      a.returnsType('num'),
    ],
  },

  // ── sort by a key (descending) — CUSTOM TYPE via setup ─────────────────────
  {
    id: 'lambda-sort-players-desc',
    category: 'lambda',
    request:
      'You are given a list of players. Return them sorted by `score` from HIGHEST to lowest (descending). Keep every player; only the order changes.',
    note: 'Sort a list<CustomObj> by a field, descending. Sorting ascending, or by the wrong field, or dropping/duplicating players fails. Scores are distinct per input so the ordering is unambiguous. Uses a per-case registered `Player` type.',
    setup: (registry) => {
      // Extend a STRUCTURAL `obj({...})` base — `extend('obj', {props})` drops
      // the fields at runtime (parse delegates to the empty base).
      const Player = registry.extend(
        registry.obj({ name: { type: registry.text() }, score: { type: registry.num() } }),
        { name: 'Player', docs: 'A leaderboard player with a name and a numeric score.' },
      );
      registry.register(Player);
      return [Player];
    },
    argsType: {
      name: 'obj',
      props: { players: { type: { name: 'list', generic: { V: { name: 'Player' } } } } },
    },
    returnType: { name: 'list', generic: { V: { name: 'Player' } } },
    inputs: [
      { players: [{ name: 'Ann', score: 30 }, { name: 'Bo', score: 90 }, { name: 'Cy', score: 55 }] },
      { players: [] },
      { players: [{ name: 'Di', score: 7 }] },
      { players: [{ name: 'Ed', score: 12 }, { name: 'Fi', score: 4 }, { name: 'Gu', score: 41 }, { name: 'Ha', score: 25 }] },
    ],
    assert: [
      a.produces((args) => {
        const players = (args['players'] ?? []) as ReadonlyArray<{ name: string; score: number }>;
        // Copy before sort so the oracle stays pure over its input.
        return [...players].sort((x, y) => y.score - x.score);
      }),
      a.usesKind('lambda'),
      a.returnsType('list'),
    ],
  },

  // ── find first matching → derive a scalar (avoids optional/undefined) ──────
  {
    id: 'lambda-find-first-adult',
    category: 'lambda',
    request:
      'You are given a list of `users`, each with an `email` and an `age`. Return the email of the FIRST user whose age is at least 18. If no user qualifies, return an empty string.',
    note: 'Find-first-matching over an ordered list. Returning the LAST match, any match, or the first user unconditionally fails. The no-match and empty inputs must return "" (empty string), not the wrong email.',
    argsType: {
      name: 'obj',
      props: {
        users: {
          type: {
            name: 'list',
            generic: {
              V: {
                name: 'obj',
                props: { email: { type: { name: 'text' } }, age: { type: { name: 'num' } } },
              },
            },
          },
        },
      },
    },
    returnType: { name: 'text' },
    inputs: [
      { users: [{ email: 'kid@x.io', age: 12 }, { email: 'ann@x.io', age: 20 }, { email: 'bo@x.io', age: 40 }] },
      { users: [] },
      { users: [{ email: 'a@x.io', age: 5 }, { email: 'b@x.io', age: 17 }] },
      { users: [{ email: 'first@x.io', age: 30 }, { email: 'second@x.io', age: 25 }] },
    ],
    assert: [
      a.produces((args) => {
        const users = (args['users'] ?? []) as ReadonlyArray<{ email: string; age: number }>;
        const hit = users.find((u) => u.age >= 18);
        return hit ? hit.email : '';
      }),
      a.usesKind('lambda'),
      a.returnsType('text'),
    ],
  },

  // ── chained pipeline: filter → map → reduce ────────────────────────────────
  {
    id: 'lambda-pipeline-instock-revenue',
    category: 'lambda',
    request:
      'You are given a list of `products`, each with a `name`, a numeric `price`, and a boolean `inStock`. Return the total price of the products that are in stock (sum the prices of only the in-stock ones). If none are in stock, return 0.',
    note: 'Chained pipeline: filter by `inStock`, project `price`, then sum. Summing ALL prices ignores the filter; summing the wrong field, or counting instead of summing, fails on the mixed / none-in-stock / empty inputs.',
    argsType: {
      name: 'obj',
      props: {
        products: {
          type: {
            name: 'list',
            generic: {
              V: {
                name: 'obj',
                props: {
                  name: { type: { name: 'text' } },
                  price: { type: { name: 'num' } },
                  inStock: { type: { name: 'bool' } },
                },
              },
            },
          },
        },
      },
    },
    returnType: { name: 'num' },
    inputs: [
      { products: [{ name: 'pen', price: 2, inStock: true }, { name: 'ink', price: 5, inStock: false }, { name: 'pad', price: 3, inStock: true }] },
      { products: [] },
      { products: [{ name: 'x', price: 9, inStock: false }, { name: 'y', price: 4, inStock: false }] },
      { products: [{ name: 'a', price: 1.5, inStock: true }, { name: 'b', price: 2.5, inStock: true }] },
    ],
    assert: [
      a.produces((args) => {
        const products = (args['products'] ?? []) as ReadonlyArray<{ price: number; inStock: boolean }>;
        return products.filter((p) => p.inStock).map((p) => p.price).reduce((s, n) => s + n, 0);
      }),
      a.usesKind('lambda'),
      a.returnsType('num'),
    ],
  },

  // ── fns-with-distractors: wire the RIGHT predicate into the higher-order op ─
  {
    id: 'lambda-count-high-priority',
    category: 'lambda',
    request:
      'You are given a list of `events`, each with a `name` and a numeric `priority`. Using the provided predicate, return how many events are HIGH PRIORITY. Do not assume what the priority cutoff is — use the predicate.',
    note: 'Higher-order + function selection: only `isHighPriority` knows the cutoff. Filtering with a guessed threshold, or wiring in isLowPriority / hasName / isUrgentName, mis-counts. `usesFn(isHighPriority)` is a required gate because the threshold is unknowable otherwise.',
    fns: eventPredicates,
    argsType: {
      name: 'obj',
      props: { events: { type: { name: 'list', generic: { V: EVENT_TYPE } } } },
    },
    returnType: { name: 'num' },
    inputs: [
      { events: [{ name: 'launch', priority: 9 }, { name: 'chore', priority: 2 }, { name: 'review', priority: 8 }] },
      { events: [] },
      { events: [{ name: 'a', priority: 1 }, { name: 'b', priority: 5 }, { name: 'c', priority: 7 }] },
      { events: [{ name: 'urgent patch', priority: 3 }, { name: 'ship', priority: 10 }] },
    ],
    assert: [
      // The cutoff lives in the fn, so calling it is genuinely mandatory.
      a.require(a.usesFn('isHighPriority')),
      a.produces((args) => {
        const events = (args['events'] ?? []) as ReadonlyArray<{ priority: number }>;
        return events.filter((e) => e.priority >= HIGH_PRIORITY_MIN).length;
      }),
      a.usesKind('lambda'),
      a.returnsType('num'),
    ],
  },
];
