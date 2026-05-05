import { describe, test, expect } from 'vitest';
import { Code, code, span, plain, joinCode, joinLines } from '../code';

/**
 * `Code` arithmetic — concat, indent, span re-anchoring across
 * newlines, line splitting, and longest-prefix path lookup. These
 * are the primitives `toGinCode` / `toJSONCode` build on, so a
 * regression here cascades.
 */
describe('Code primitives', () => {
  test('plain text has no spans', () => {
    const c = plain('hello');
    expect(c.text).toBe('hello');
    expect(c.spans).toEqual([]);
  });

  test('span() wraps text with one outer span over the whole range', () => {
    const c = span('abc', { path: ['x'] });
    expect(c.text).toBe('abc');
    expect(c.spans.length).toBe(1);
    expect(c.spans[0]!.start).toBe(0);
    expect(c.spans[0]!.end).toBe(3);
    expect(c.spans[0]!.path).toEqual(['x']);
  });

  test('code`...` interpolates strings and Codes, shifting child spans', () => {
    const child = span('inner', { path: ['child'] });
    const c = code`prefix ${child} suffix`;
    expect(c.text).toBe('prefix inner suffix');
    // Child span's offsets must point at "inner" within the combined text.
    expect(c.spans.length).toBe(1);
    expect(c.spans[0]!.start).toBe(7);
    expect(c.spans[0]!.end).toBe(12);
    expect(c.spans[0]!.path).toEqual(['child']);
  });

  test('concat appends and shifts spans', () => {
    const a = span('aa', { path: ['a'] });
    const b = span('bb', { path: ['b'] });
    const c = a.concat(b);
    expect(c.text).toBe('aabb');
    expect(c.spans.length).toBe(2);
    expect(c.spans[0]!.path).toEqual(['a']);
    expect(c.spans[0]!.start).toBe(0);
    expect(c.spans[1]!.path).toEqual(['b']);
    expect(c.spans[1]!.start).toBe(2);
    expect(c.spans[1]!.end).toBe(4);
  });

  test('indent prepends to every line after the first; spans stay correct', () => {
    // Line 1: "first" (no shift)
    // Line 2: "  second" (shifted by len("  ")=2)
    // Line 3: "  third"  (shifted by 4 — two newlines accumulated)
    const inner = span('second', { path: ['s'] });
    const c = code`first\n${inner}\nthird`;
    expect(c.text).toBe('first\nsecond\nthird');
    const indented = c.indent('  ');
    expect(indented.text).toBe('first\n  second\n  third');
    // The "second" span must still cover the original chars,
    // accounting for the inserted whitespace.
    const sSpan = indented.spans.find((s) => s.path[0] === 's')!;
    const sliced = indented.text.slice(sSpan.start, sSpan.end);
    expect(sliced).toBe('second');
  });

  test('toLines splits multi-line text and re-anchors spans per line', () => {
    const inner = span('xx', { path: ['x'] });
    const c = code`line one\n${inner} line two`;
    const lines = c.toLines();
    expect(lines.length).toBe(2);
    expect(lines[0]!.text).toBe('line one');
    expect(lines[0]!.lineNum).toBe(1);
    expect(lines[1]!.text).toBe('xx line two');
    expect(lines[1]!.spans.length).toBe(1);
    // Per-line span uses line-relative offsets.
    expect(lines[1]!.spans[0]!.start).toBe(0);
    expect(lines[1]!.spans[0]!.end).toBe(2);
  });

  test('toLines clips multi-line spans to each line', () => {
    // A single span covering BOTH lines should appear in BOTH lines'
    // spans arrays, with offsets clipped to that line.
    const c = new Code('foo\nbar', [{ start: 0, end: 7, path: ['whole'] }]);
    const lines = c.toLines();
    expect(lines[0]!.spans.length).toBe(1);
    expect(lines[0]!.spans[0]!.end).toBe(3); // "foo" length
    expect(lines[1]!.spans.length).toBe(1);
    expect(lines[1]!.spans[0]!.start).toBe(0);
    expect(lines[1]!.spans[0]!.end).toBe(3); // "bar" length
  });

  test('spanFor finds longest-prefix match', () => {
    // Three nested spans — outer covers everything, mid covers a sub-
    // range, inner is the most specific. Looking up
    // `['outer', 'mid', 'inner', 'leaf']` should pick the inner span.
    const c = new Code('aaaaaaaaaa', [
      { start: 0, end: 10, path: ['outer'] },
      { start: 2, end: 8, path: ['outer', 'mid'] },
      { start: 4, end: 6, path: ['outer', 'mid', 'inner'] },
    ]);
    const found = c.spanFor(['outer', 'mid', 'inner', 'leaf']);
    expect(found?.path).toEqual(['outer', 'mid', 'inner']);
  });

  test('spanFor returns undefined when no span matches', () => {
    const c = new Code('xy', [{ start: 0, end: 2, path: ['a'] }]);
    expect(c.spanFor(['b'])).toBeUndefined();
  });

  test('spanFor breaks ties by smaller (more specific) range', () => {
    // Two spans with identical paths but different ranges — pick the
    // tighter one.
    const c = new Code('xxxxxx', [
      { start: 0, end: 6, path: ['a'] },
      { start: 1, end: 3, path: ['a'] },
    ]);
    const found = c.spanFor(['a']);
    expect(found?.start).toBe(1);
    expect(found?.end).toBe(3);
  });

  test('joinCode preserves spans across separator', () => {
    const a = span('a', { path: ['a'] });
    const b = span('b', { path: ['b'] });
    const joined = joinCode([a, b], '|');
    expect(joined.text).toBe('a|b');
    expect(joined.spans.find((s) => s.path[0] === 'a')?.start).toBe(0);
    expect(joined.spans.find((s) => s.path[0] === 'b')?.start).toBe(2);
  });

  test('joinLines joins with newline, preserves spans', () => {
    const a = span('a', { path: ['a'] });
    const b = span('b', { path: ['b'] });
    const joined = joinLines([a, b]);
    expect(joined.text).toBe('a\nb');
    const lines = joined.toLines();
    expect(lines.length).toBe(2);
    expect(lines[0]!.text).toBe('a');
    expect(lines[1]!.text).toBe('b');
  });

  test('toString returns the underlying text', () => {
    const c = code`hi ${span('there', { path: ['t'] })}`;
    expect(c.toString()).toBe('hi there');
    expect(`${c}`).toBe('hi there');
  });

  test('empty Code has zero lines… wait, one empty line', () => {
    const c = new Code('');
    const lines = c.toLines();
    expect(lines.length).toBe(1);
    expect(lines[0]!.text).toBe('');
  });
});
