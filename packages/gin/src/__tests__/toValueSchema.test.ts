import { describe, test, expect } from 'vitest';
import { createRegistry } from '../index';

/**
 * Each Type exposes `toValueSchema(): z.ZodTypeAny` — a Zod schema over
 * the RUNTIME PRIMITIVE form (what an LLM should produce). Options on
 * the type fold into the schema. Composites emit LLM-friendly shapes:
 * lists are `z.array(V)`, maps are `z.array(z.object({key, value}))`
 * (NOT tuples), objects are `z.object({per-field})`.
 */

describe('Type.toValueSchema', () => {
  const r = createRegistry();

  test('primitives', () => {
    expect(r.any().toValueSchema().parse('anything')).toBe('anything');
    expect(r.null().toValueSchema().parse(null)).toBe(null);
    expect(r.void().toValueSchema().parse(null)).toBe(null);
    expect(r.bool().toValueSchema().parse(true)).toBe(true);
    expect(r.num().toValueSchema().parse(42)).toBe(42);
    expect(r.text().toValueSchema().parse('hi')).toBe('hi');
  });

  test('num options: min / max / whole', () => {
    const s = r.num({ min: 0, max: 10, whole: true }).toValueSchema();
    expect(s.safeParse(5).success).toBe(true);
    expect(s.safeParse(-1).success).toBe(false);
    expect(s.safeParse(11).success).toBe(false);
    expect(s.safeParse(3.5).success).toBe(false); // not whole
  });

  test('text options: minLength / maxLength / pattern', () => {
    const s = r.text({ minLength: 2, maxLength: 5, pattern: '^[a-z]+$' }).toValueSchema();
    expect(s.safeParse('abc').success).toBe(true);
    expect(s.safeParse('a').success).toBe(false);    // too short
    expect(s.safeParse('abcdef').success).toBe(false); // too long
    expect(s.safeParse('AB').success).toBe(false);   // pattern
  });

  test('date / timestamp value schemas', () => {
    const date = r.date().toValueSchema();
    expect(date.safeParse('2026-04-21').success).toBe(true);
    expect(date.safeParse('not-a-date').success).toBe(false);

    const ts = r.timestamp().toValueSchema();
    expect(ts.safeParse('2026-04-21T12:34:56Z').success).toBe(true);
    // Time component required — bare date not enough for timestamp.
    expect(ts.safeParse('2026-04-21').success).toBe(false);
    // Accept a space separator in place of 'T'.
    expect(ts.safeParse('2026-04-21 12:34:56').success).toBe(true);
  });

  test('list<V> → z.array(V) with length bounds', () => {
    const s = r.list(r.num(), { minLength: 1, maxLength: 3 }).toValueSchema();
    expect(s.safeParse([1, 2]).success).toBe(true);
    expect(s.safeParse([]).success).toBe(false);
    expect(s.safeParse([1, 2, 3, 4]).success).toBe(false);
    expect(s.safeParse([1, 'x']).success).toBe(false); // wrong inner type
  });

  test('map<K, V> → z.array(z.object({key, value})) (LLM-friendly, not tuple)', () => {
    const s = r.map(r.text(), r.num()).toValueSchema();
    // The {key, value} shape is what LLMs produce reliably.
    expect(s.safeParse([{ key: 'a', value: 1 }, { key: 'b', value: 2 }]).success).toBe(true);
    // Positional [K, V] tuples are NOT accepted by this schema.
    expect(s.safeParse([['a', 1]]).success).toBe(false);
    // Inner type constraints still apply.
    expect(s.safeParse([{ key: 'a', value: 'bad' }]).success).toBe(false);
  });

  test('obj → z.object({per-field})', () => {
    const t = r.obj({
      name: { type: r.text({ minLength: 1 }) },
      age: { type: r.num({ min: 0, whole: true }) },
    });
    const s = t.toValueSchema();
    expect(s.safeParse({ name: 'Alice', age: 30 }).success).toBe(true);
    expect(s.safeParse({ name: '', age: 30 }).success).toBe(false); // minLength
    expect(s.safeParse({ name: 'Bob', age: -1 }).success).toBe(false); // min
    expect(s.safeParse({ name: 'Bob' }).success).toBe(false); // missing age
  });

  test('optional<T> — undefined allowed, null NOT (distinct from nullable)', () => {
    const s = r.optional(r.num()).toValueSchema();
    expect(s.safeParse(undefined).success).toBe(true);
    expect(s.safeParse(5).success).toBe(true);
    expect(s.safeParse(null).success).toBe(false);
  });

  test('nullable<T> — null allowed, undefined NOT', () => {
    const s = r.nullable(r.num()).toValueSchema();
    expect(s.safeParse(null).success).toBe(true);
    expect(s.safeParse(5).success).toBe(true);
    expect(s.safeParse(undefined).success).toBe(false);
  });

  test('or → z.union', () => {
    const s = r.or([r.num(), r.text()]).toValueSchema();
    expect(s.safeParse(5).success).toBe(true);
    expect(s.safeParse('x').success).toBe(true);
    expect(s.safeParse(true).success).toBe(false);
  });

  test('literal → z.literal', () => {
    const s = r.literal(r.text(), 'exact').toValueSchema();
    expect(s.safeParse('exact').success).toBe(true);
    expect(s.safeParse('other').success).toBe(false);
  });

  test('enum → z.enum', () => {
    const s = r.enum({ RED: 'red', GREEN: 'green', BLUE: 'blue' }, r.text()).toValueSchema();
    expect(s.safeParse('red').success).toBe(true);
    expect(s.safeParse('green').success).toBe(true);
    expect(s.safeParse('purple').success).toBe(false);
  });

  test('tuple → z.tuple (positional)', () => {
    const s = r.tuple([r.num(), r.text(), r.bool()]).toValueSchema();
    expect(s.safeParse([1, 'a', true]).success).toBe(true);
    expect(s.safeParse([1, 'a']).success).toBe(false);   // wrong length
    expect(s.safeParse(['a', 1, true]).success).toBe(false); // wrong order
  });

  test('nested composites produce nested schemas', () => {
    // list<obj<name: text, scores: list<num>>>
    const inner = r.obj({
      name: { type: r.text() },
      scores: { type: r.list(r.num({ whole: true })) },
    });
    const s = r.list(inner).toValueSchema();
    expect(s.safeParse([
      { name: 'a', scores: [1, 2] },
      { name: 'b', scores: [3] },
    ]).success).toBe(true);
    expect(s.safeParse([{ name: 'a', scores: [1.5] }]).success).toBe(false);
  });

  test('Extension delegates to base', () => {
    const ranged = r.extend('num', { name: 'ranged', options: { min: 0, max: 100 } });
    const s = ranged.toValueSchema();
    expect(s.safeParse(50).success).toBe(true);
    expect(s.safeParse(150).success).toBe(false);
  });
});
