/**
 * INVARIANT: `T.parse(T.create())` succeeds for every INHABITABLE builtin `T`.
 *
 * A type's own constructor must not produce a value its own parser refuses.
 * Stated as a sweep rather than a per-class test, because the failures are all
 * the same shape and each one stayed invisible until someone happened to call
 * `create` on that class:
 *
 *  - `map.create()` returned a live `Map` (the RUNTIME form), while `map.parse`
 *    read only the authored `[{key, value}]` array — `map.parse(map.create())`
 *    threw. It was the only builtin whose two forms disagreed.
 *  - `and<num, num{min=3}>.create()` was `0` — the first part's zero, ignoring
 *    every other part's constraints — which the type then refused; and an
 *    object intersection got only the FIRST part's fields.
 *  - `num{max:-3}.create()` was `0`: `create` honored `min` but not `max`.
 *  - `text{minLength:2}.create()` was `''`.
 *
 * The last two were found BY this sweep rather than reported, which is the
 * point of writing it as a sweep.
 *
 * Three buckets, all ENUMERATED rather than skipped silently:
 *  - `inhabitable` — the invariant proper: `parse` accepts `create()`, and the
 *    parsed value is `valid` (what a composite parent checks when this type is
 *    nested inside one);
 *  - `uninhabitable` — no value exists, so `parse` REFUSING its own `create()`
 *    is the correct answer and is asserted as such;
 *  - `noDerivableWitness` — inhabitable, but nothing about the declaration
 *    tells `create` what a satisfying value looks like (a regex has no general
 *    inverse; a `fn` value is a JS function / Expr). Only that `create()` does
 *    not blow up is asserted — named so the limit stays deliberate.
 *
 * The coverage test derives its expectation from `BUILTIN_TYPES`, so a new
 * builtin class fails until it is placed in one of the three.
 */
import { describe, test, expect } from 'vitest';
import { BUILTIN_TYPES, createRegistry } from '../registry';
import type { Type } from '../type';

const r = createRegistry();

/** Every builtin type class, plus the constrained variants that used to break. */
const inhabitable: ReadonlyArray<readonly [string, Type]> = [
  ['any', r.any()],
  ['void', r.void()],
  ['null', r.null()],
  ['bool', r.bool()],
  ['num', r.num()],
  ['num{min:3}', r.num({ min: 3 })],
  ['num{max:-3}', r.num({ max: -3 })],
  ['num{min:2,max:9,whole}', r.num({ min: 2, max: 9, whole: true })],
  ['num{max:-2.5,whole}', r.num({ max: -2.5, whole: true })],
  ['text', r.text()],
  ['text{minLength:2}', r.text({ minLength: 2 })],
  ['text{minLength:2,maxLength:4}', r.text({ minLength: 2, maxLength: 4 })],
  ['list', r.list(r.text())],
  ['list{minLength:2}', r.list(r.text(), { minLength: 2 })],
  ['list<num{min:3}>{minLength:2}', r.list(r.num({ min: 3 }), { minLength: 2 })],
  ['map', r.map(r.text(), r.num())],
  ['map<text,num{min:3}>', r.map(r.text(), r.num({ min: 3 }))],
  ['tuple', r.tuple([r.text(), r.num()])],
  ['obj', r.obj({ a: { type: r.text() } })],
  ['obj{constrained}', r.obj({ a: { type: r.text({ minLength: 2 }) }, b: { type: r.num({ max: -3 }) } })],
  ['optional', r.optional(r.text())],
  ['nullable', r.nullable(r.text())],
  ['not<num>', r.not(r.num())],
  ['or', r.or([r.num(), r.text()])],
  ['and<num,num{min:3}>', r.and([r.num(), r.num({ min: 3 })])],
  ['and<obj,obj>', r.and([r.obj({ a: { type: r.text() } }), r.obj({ b: { type: r.num() } })])],
  ['and<list,list{maxLength:2}>', r.and([r.list(r.text()), r.list(r.text(), { maxLength: 2 })])],
  ['and<>', r.and([])],
  ['enum', r.enum({ A: 'a', B: 'b' }, r.text())],
  ['literal', r.literal(r.text(), 'x')],
  ['date', r.date()],
  ['timestamp', r.timestamp()],
  ['duration', r.duration()],
  ['color', r.color()],
  ['interface', r.iface({ props: { a: { type: r.text() } } })],
  ['alias', r.alias('num')],
  ['typ', r.typ(r.any())],
];

/**
 * Types NO value inhabits. `create` cannot produce a witness because none
 * exists, so `parse` refusing its own `create()` is the CORRECT answer — these
 * are listed rather than skipped.
 */
const uninhabitable: ReadonlyArray<readonly [string, Type]> = [
  // `not<any>` excludes every value by construction.
  ['not<any>', r.not(r.any())],
  // Disjoint parts: nothing is both a num and a text.
  ['and<num,text>', r.and([r.num(), r.text()])],
];

/**
 * Inhabitable, but with NO witness `create` can derive from the declaration —
 * so `create()` returns a placeholder the type itself may refuse, and that is
 * as far as the invariant reaches. Named rather than quietly omitted:
 *  - `text{pattern}` — a regex has no general inverse;
 *  - `fn` — a fn value is a JS function / string ref / Expr; there is nothing
 *    to synthesize, so `create()` is `null` (which `valid` rejects).
 */
const noDerivableWitness: ReadonlyArray<readonly [string, Type]> = [
  ['text{pattern}', r.text({ pattern: '^[a-z]+$' })],
  ['fn', r.fn({ args: r.obj({ x: { type: r.num() } }), returns: r.num() })],
];

describe('T.parse(T.create()) — the builtin sweep', () => {
  for (const [name, type] of inhabitable) {
    test(`${name}: parse accepts its own create()`, () => {
      const created = type.create();
      expect(() => type.parse(created)).not.toThrow();
      // `create` must also satisfy the type's own runtime predicate, since that
      // is what a composite parent checks when this type is nested inside one.
      expect(type.valid(type.parse(created).raw)).toBe(true);
    });
  }

  for (const [name, type] of uninhabitable) {
    test(`${name}: uninhabitable — its own create() is refused, as it must be`, () => {
      expect(() => type.parse(type.create())).toThrow();
    });
  }

  for (const [name, type] of noDerivableWitness) {
    test(`${name}: no witness derivable — create() is a placeholder the type may refuse`, () => {
      expect(() => type.create()).not.toThrow();
    });
  }

  test('the sweep covers EVERY registered builtin class', () => {
    // Derived from `BUILTIN_TYPES`, not a hand-written list, so a new builtin
    // class fails here until it gets a sweep entry.
    const covered = new Set(
      [...inhabitable, ...uninhabitable, ...noDerivableWitness].map(([, t]) => t.name),
    );
    const missing = BUILTIN_TYPES.map((c) => c.NAME).filter((n) => !covered.has(n));
    expect(missing).toEqual([]);
  });
});

describe('the create()/parse() disagreements this sweep pins', () => {
  test('map: parse accepts the RUNTIME Map that create() returns', () => {
    const m = r.map(r.text(), r.num());
    expect(m.parse(m.create()).raw).toBeInstanceOf(Map);
    // A POPULATED runtime map round-trips with its entries intact.
    const populated = m.parse([{ key: 'a', value: 1 }, { key: 'b', value: 2 }]);
    expect(m.encode(m.parse(populated.raw).raw as never)).toEqual(m.encode(populated.raw as never));
    // ...and a hand-built plain `key → value` Map reads as pairs.
    expect(m.encode(m.parse(new Map([['a', 1]])).raw as never)).toEqual(
      m.encode(m.parse([['a', 1]]).raw as never),
    );
    // A non-array, non-Map is still refused.
    expect(() => m.parse('nope')).toThrow(/map\.invalid/);
  });

  test('and: create() satisfies EVERY part, not just the first', () => {
    expect(r.and([r.num(), r.num({ min: 3 })]).create()).toBe(3);
    const objs = r.and([r.obj({ a: { type: r.text() } }), r.obj({ b: { type: r.num() } })]);
    expect(Object.keys(objs.create() as object).sort()).toEqual(['a', 'b']);
  });

  test('and: random() walks the same candidates, so it satisfies every part', () => {
    // A deterministic `rnd` pinned to the low bound: the plain `num` part yields
    // 0 (refused by `min:3`), so the walk falls through to the constrained part.
    const low = (min: number, _max: number, whole: boolean): number => (whole ? Math.floor(min) : min);
    expect(r.and([r.num(), r.num({ min: 3 })]).random(low)).toBe(3);
    const objs = r.and([r.obj({ a: { type: r.text() } }), r.obj({ b: { type: r.num() } })]);
    expect(Object.keys(objs.random(low) as object).sort()).toEqual(['a', 'b']);
  });

  test('num: create() is CLAMPED into the range, not merely lifted to `min`', () => {
    expect(r.num().create()).toBe(0);
    expect(r.num({ min: 3 }).create()).toBe(3);
    expect(r.num({ max: -3 }).create()).toBe(-3);
    // A whole-number bound rounds INTO the range rather than out of it.
    expect(r.num({ max: -2.5, whole: true }).create()).toBe(-3);
    expect(r.num({ min: 2.5, whole: true }).create()).toBe(3);
  });

  test('text: create() is padded to `minLength`', () => {
    expect(r.text().create()).toBe('');
    expect(r.text({ minLength: 2 }).create()).toHaveLength(2);
  });
});
