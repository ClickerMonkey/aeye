/**
 * map / dict cases (get-with-default, keys, values, has, size, aggregate,
 * filter/select, build-from-list) for the gin LLM harness.
 *
 * Follows the EvalCase contract (see `types.ts`) and the `a` builder
 * (`assert.ts`): each case is a NL `request` to generate a gin function
 * `(args) => output`, proven by `a.produces(oracle)` over several `inputs`.
 *
 * TWO shape facts drive every oracle here (verified against `src/types/map.ts`
 * `parse`/`encode` + `integration/model.ts` `toPlain`):
 *
 *  1. A `map<K,V>` ARGUMENT arrives to the generated function — and to the
 *     ORACLE, which reads the same raw `inputs` record — as an ARRAY of
 *     `{ key, value }` pairs (that is the shape `MapType.parse` accepts and the
 *     LLM-facing value schema advertises). So an oracle over a map param iterates
 *     `entries.map(e => e.key / e.value)`, NOT `Object.entries`.
 *  2. A map RETURN value, once unwrapped by `toPlain`, is a plain JS object
 *     `{ [stringKey]: value }` — but `MapType.parse` (which the `--check` gate
 *     runs over every oracle output) REQUIRES the array form, so the two shapes
 *     disagree and a map-returning oracle can never satisfy both. Every case here
 *     therefore returns a scalar / list / bool derived FROM a map, never a map
 *     itself; maps are only ever inputs or internally-built structures.
 *
 * Custom object types (used by `map-inventory-value`) put their DATA fields in
 * the BASE obj — `registry.extend(registry.obj({ ... }), { name })` — so the
 * generated program can actually READ those fields at runtime (an
 * `extend('obj', { props })` base leaves the fields unreadable).
 */
import { a } from './assert';
import type { EvalCase, FnSpec, RawArgs } from './types';

/** How a `map<text, num>` argument reaches an oracle: an array of pairs. */
type NumEntry = { key: string; value: number };

/** A `map<text, num>` gin TypeDef, reused across the numeric-map cases. */
const TEXT_NUM_MAP = { name: 'map', generic: { K: { name: 'text' }, V: { name: 'num' } } } as const;

/** Read a raw map-arg (`args[name]`) as a typed array of `{ key, value }`. */
function numEntries(args: RawArgs, name: string): ReadonlyArray<NumEntry> {
  return (args[name] ?? []) as ReadonlyArray<NumEntry>;
}

/**
 * Collapse map entries into a plain lookup, LAST value winning per key — the
 * same semantics `MapType.parse` gives (a repeated key overwrites). All test
 * inputs use DISTINCT keys, so this only matters as documentation of intent.
 */
function lookup(entries: ReadonlyArray<NumEntry>): Record<string, number> {
  const rec: Record<string, number> = {};
  for (const e of entries) rec[e.key] = e.value;
  return rec;
}

/**
 * The proprietary campaign-scoring weights the `campaignScore` fn hides from the
 * model — a click is worth 0.5 and a conversion 3. Shared by the fn impl and the
 * oracle so both compute the identical number.
 */
const SCORE_WEIGHTS = { clicks: 0.5, conversions: 3 } as const;

/** Apply the hidden weighting to a metric lookup (used by fn impl + oracle). */
function weightedScore(metrics: Record<string, number>): number {
  return (metrics['clicks'] ?? 0) * SCORE_WEIGHTS.clicks + (metrics['conversions'] ?? 0) * SCORE_WEIGHTS.conversions;
}

/**
 * The scoring functions for `map-campaign-score`: one solver (`campaignScore`,
 * the only one that knows the weights) plus three plausible distractors that
 * aggregate the SAME map differently. Every fn receives its `metrics` arg already
 * decoded to a plain `{ [name]: value }` object (gin's call-arg `toPlain`), so
 * each impl — and each `probe` — is authored over that object shape.
 */
const scoreFns: FnSpec[] = [
  {
    name: 'campaignScore',
    args: { name: 'obj', props: { metrics: { type: TEXT_NUM_MAP } } },
    returns: { name: 'num' },
    impl: (args) => weightedScore((args['metrics'] ?? {}) as Record<string, number>),
    docs: 'Compute a campaign score from its metric map (applies the proprietary per-metric weights)',
    probe: { metrics: { clicks: 100, conversions: 4 } },
  },
  {
    name: 'sumMetrics',
    args: { name: 'obj', props: { metrics: { type: TEXT_NUM_MAP } } },
    returns: { name: 'num' },
    impl: (args) => Object.values((args['metrics'] ?? {}) as Record<string, number>).reduce((s, n) => s + n, 0),
    docs: 'Add up every metric value in the map',
    distractor: true,
    probe: { metrics: { clicks: 100, conversions: 4 } },
  },
  {
    name: 'maxMetric',
    args: { name: 'obj', props: { metrics: { type: TEXT_NUM_MAP } } },
    returns: { name: 'num' },
    impl: (args) => {
      const vals = Object.values((args['metrics'] ?? {}) as Record<string, number>);
      return vals.length === 0 ? 0 : Math.max(...vals);
    },
    docs: 'Return the single largest metric value',
    distractor: true,
    probe: { metrics: { clicks: 100, conversions: 4 } },
  },
  {
    name: 'metricCount',
    args: { name: 'obj', props: { metrics: { type: TEXT_NUM_MAP } } },
    returns: { name: 'num' },
    impl: (args) => Object.keys((args['metrics'] ?? {}) as Record<string, number>).length,
    docs: 'Count how many distinct metrics the map holds',
    distractor: true,
    probe: { metrics: { clicks: 100, conversions: 4 } },
  },
];

export const mapCases: EvalCase[] = [
  // ── get a value by key, defaulting when absent ────────────────────────────
  {
    id: 'map-get-default',
    category: 'map',
    request:
      'You are given a price map `prices` (item name → price) and an item `sku`. Return the price for that sku. If the map has no entry for it, return 0.',
    note: 'Safe keyed lookup with a default. A model that assumes the key is present (an unguarded index-get) throws on the missing-key and empty-map inputs; returning 0 only on absence is the discriminator.',
    argsType: { name: 'obj', props: { prices: { type: TEXT_NUM_MAP }, sku: { type: { name: 'text' } } } },
    returnType: { name: 'num' },
    inputs: [
      { prices: [{ key: 'apple', value: 3 }, { key: 'pear', value: 2 }], sku: 'pear' },
      { prices: [{ key: 'apple', value: 3 }], sku: 'banana' },
      { prices: [], sku: 'apple' },
    ],
    assert: [
      a.produces((args) => {
        const rec = lookup(numEntries(args, 'prices'));
        const sku = args['sku'] as string;
        return sku in rec ? rec[sku] : 0;
      }),
      a.returnsType('num'),
    ],
  },

  // ── has(key) ──────────────────────────────────────────────────────────────
  {
    id: 'map-has-item',
    category: 'map',
    request:
      'You are given an inventory map `inventory` (item name → quantity on hand) and an item name `item`. Return whether the inventory contains an entry for that item.',
    note: 'Membership test — `has`, not a value read. Reading the value and coercing it to bool would report false for an item stocked at quantity 0; only a key-presence check answers correctly.',
    argsType: { name: 'obj', props: { inventory: { type: TEXT_NUM_MAP }, item: { type: { name: 'text' } } } },
    returnType: { name: 'bool' },
    inputs: [
      { inventory: [{ key: 'nails', value: 40 }, { key: 'screws', value: 0 }], item: 'screws' },
      { inventory: [{ key: 'nails', value: 40 }], item: 'bolts' },
      { inventory: [], item: 'nails' },
    ],
    assert: [
      a.produces((args) => {
        const item = args['item'] as string;
        return numEntries(args, 'inventory').some((e) => e.key === item);
      }),
      a.returnsType('bool'),
    ],
  },

  // ── size ──────────────────────────────────────────────────────────────────
  {
    id: 'map-distinct-count',
    category: 'map',
    request: 'You are given a map `cart` (product → quantity). Return how many distinct products it contains. An empty cart has 0.',
    note: 'Map size — the number of ENTRIES, not the sum of the quantities. Summing the values (a natural confusion for a quantity map) gives a different, larger number on the multi-entry inputs.',
    argsType: { name: 'obj', props: { cart: { type: TEXT_NUM_MAP } } },
    returnType: { name: 'num' },
    inputs: [
      { cart: [{ key: 'pen', value: 3 }, { key: 'pad', value: 5 }, { key: 'clip', value: 2 }] },
      { cart: [] },
      { cart: [{ key: 'pen', value: 12 }] },
    ],
    assert: [
      // Inputs use distinct keys, so entry-count == distinct-product-count.
      a.produces((args) => numEntries(args, 'cart').length),
      a.returnsType('num'),
    ],
  },

  // ── keys() ────────────────────────────────────────────────────────────────
  {
    id: 'map-key-list',
    category: 'map',
    request:
      'You are given a map `scores` (player name → points). Return the list of player names (the keys), in the map’s own order.',
    note: 'keys() projection. Returning the VALUES (the points) instead of the keys, or the whole entries, fails the list comparison. The oracle uses the input (insertion) order, which the map preserves.',
    argsType: { name: 'obj', props: { scores: { type: TEXT_NUM_MAP } } },
    returnType: { name: 'list', generic: { V: { name: 'text' } } },
    inputs: [
      { scores: [{ key: 'ana', value: 10 }, { key: 'bo', value: 7 }, { key: 'cy', value: 15 }] },
      { scores: [] },
      { scores: [{ key: 'zoe', value: 3 }] },
    ],
    assert: [
      a.produces((args) => numEntries(args, 'scores').map((e) => e.key)),
      a.returnsType('list'),
    ],
  },

  // ── values() + filter/select + aggregate ──────────────────────────────────
  {
    id: 'map-filter-sum',
    category: 'map',
    request:
      'You are given a map `scores` (name → score) and a number `cutoff`. Return the total of all scores that are greater than or equal to `cutoff`. If none qualify, return 0.',
    note: 'Select entries by their VALUE, then aggregate. Summing ALL values ignores the cutoff; counting the qualifying entries returns a tally instead of a total. Varied cutoffs (including one no score meets) expose both mistakes.',
    argsType: { name: 'obj', props: { scores: { type: TEXT_NUM_MAP }, cutoff: { type: { name: 'num' } } } },
    returnType: { name: 'num' },
    inputs: [
      { scores: [{ key: 'a', value: 5 }, { key: 'b', value: 9 }, { key: 'c', value: 2 }], cutoff: 5 },
      { scores: [{ key: 'a', value: 1 }, { key: 'b', value: 3 }], cutoff: 10 },
      { scores: [], cutoff: 0 },
    ],
    assert: [
      a.produces((args) => {
        const cutoff = args['cutoff'] as number;
        return numEntries(args, 'scores')
          .filter((e) => e.value >= cutoff)
          .reduce((s, e) => s + e.value, 0);
      }),
      a.returnsType('num'),
    ],
  },

  // ── build a map FROM a list, then look up (with a default) ─────────────────
  {
    id: 'map-index-by-id',
    category: 'map',
    request:
      'You are given a list `people`, each with a text `id` and a number `age`, and a target `targetId`. Index the people by id and return the age of the person whose id is `targetId`. If no one matches, return -1.',
    note: 'Build a lookup keyed by a field, then read it with a default. A model that returns the first person’s age, or throws when the id is absent, fails the miss and empty-list inputs.',
    argsType: {
      name: 'obj',
      props: {
        people: {
          type: {
            name: 'list',
            generic: { V: { name: 'obj', props: { id: { type: { name: 'text' } }, age: { type: { name: 'num' } } } } },
          },
        },
        targetId: { type: { name: 'text' } },
      },
    },
    returnType: { name: 'num' },
    inputs: [
      { people: [{ id: 'p1', age: 30 }, { id: 'p2', age: 41 }, { id: 'p3', age: 25 }], targetId: 'p2' },
      { people: [{ id: 'p1', age: 30 }], targetId: 'p9' },
      { people: [], targetId: 'p1' },
    ],
    assert: [
      a.produces((args) => {
        const people = (args['people'] ?? []) as ReadonlyArray<{ id: string; age: number }>;
        const target = args['targetId'] as string;
        const rec: Record<string, number> = {};
        for (const p of people) rec[p.id] = p.age;
        return target in rec ? rec[target] : -1;
      }),
      a.returnsType('num'),
    ],
  },

  // ── fns-with-distractors: aggregate a map through the RIGHT function ───────
  {
    id: 'map-campaign-score',
    category: 'map',
    request:
      'Given a map `metrics` of campaign metrics (metric name → value, e.g. clicks and conversions), compute the campaign’s overall score. Use the provided scoring function — the per-metric weighting is proprietary and must not be guessed.',
    note: 'Distractor gauntlet over a MAP argument: only `campaignScore` knows the weights. Summing the metrics (`sumMetrics`), taking the max (`maxMetric`), or counting them (`metricCount`) — or inlining a guessed formula — all yield the wrong number. `usesFn(campaignScore)` is required because the weights are unknowable otherwise.',
    fns: scoreFns,
    argsType: { name: 'obj', props: { metrics: { type: TEXT_NUM_MAP } } },
    returnType: { name: 'num' },
    inputs: [
      { metrics: [{ key: 'clicks', value: 200 }, { key: 'conversions', value: 5 }] },
      { metrics: [{ key: 'clicks', value: 80 }] },
      { metrics: [] },
    ],
    assert: [
      a.require(a.usesFn('campaignScore')),
      a.produces((args) => weightedScore(lookup(numEntries(args, 'metrics')))),
    ],
  },

  // ── custom-type map: aggregate a field across the values ───────────────────
  {
    id: 'map-inventory-value',
    category: 'map',
    request:
      'You are given a catalog map `catalog` (sku → Product). Return the total inventory value: the sum of `price` times `qty` over every product in the catalog. An empty catalog is worth 0.',
    note: 'Aggregate a computed field across a map of CUSTOM objects. Summing only price (or only qty), or double-counting via the keys, diverges from the price×qty total on the multi-entry inputs.',
    setup: (registry) => {
      // Data fields live in the BASE obj so the program can READ them; `extend`
      // only names the type (an `extend('obj', { props })` base is unreadable).
      const Product = registry.extend(
        registry.obj({
          name: { type: registry.text() },
          price: { type: registry.num() },
          qty: { type: registry.num() },
        }),
        { name: 'Product', docs: 'A catalog product with a unit price and quantity on hand.' },
      );
      registry.register(Product);
      return [Product];
    },
    argsType: {
      name: 'obj',
      props: { catalog: { type: { name: 'map', generic: { K: { name: 'text' }, V: { name: 'Product' } } } } },
    },
    returnType: { name: 'num' },
    inputs: [
      {
        catalog: [
          { key: 'sku1', value: { name: 'Widget', price: 2.5, qty: 4 } },
          { key: 'sku2', value: { name: 'Gadget', price: 10, qty: 2 } },
        ],
      },
      { catalog: [] },
      { catalog: [{ key: 'sku9', value: { name: 'Gizmo', price: 7, qty: 3 } }] },
    ],
    assert: [
      a.produces((args) => {
        const entries = (args['catalog'] ?? []) as ReadonlyArray<{ key: string; value: { price: number; qty: number } }>;
        return entries.reduce((s, e) => s + e.value.price * e.value.qty, 0);
      }),
      a.returnsType('num'),
    ],
  },
];
