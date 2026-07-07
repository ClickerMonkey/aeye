/**
 * `jsonSource` — the positioned canonical stringifier that lets a query
 * problem underline the offending value in the model's own JSON.
 *
 * Two invariants are asserted: (1) `text` is BYTE-IDENTICAL to
 * `JSON.stringify(value, null, 2)`, and (2) every recorded span's
 * `text.slice(start, end)` is EXACTLY that node's canonical token — for the
 * root, every object property value (keyed by path incl. the property name),
 * and every array element (keyed by index), across nested containers, all
 * scalar types, and empty `{}` / `[]`.
 */
import { describe, it, expect } from 'vitest';
import { jsonSource, type JsonSpan } from '../json-source';

/** Look up the span for an exact structural path. */
function spanAt(spans: ReadonlyArray<JsonSpan>, path: (string | number)[]): JsonSpan | undefined {
  const key = JSON.stringify(path);
  return spans.find((s) => JSON.stringify(s.path) === key);
}

/** The exact token `text.slice(start, end)` for the span at `path`. */
function tokenAt(value: unknown, path: (string | number)[]): string {
  const { text, spans } = jsonSource(value);
  const span = spanAt(spans, path);
  if (!span) throw new Error(`no span at ${JSON.stringify(path)}`);
  return text.slice(span.start, span.end);
}

describe('jsonSource', () => {
  it('text is byte-identical to JSON.stringify(value, null, 2)', () => {
    const values: unknown[] = [
      { a: 1, b: 'two', c: true, d: null, e: [1, 2], f: {} },
      [{ x: 1 }, [], 'y', false],
      { nested: { deep: { list: [1, { k: 'v' }] } } },
      'a bare string',
      42,
      true,
      null,
      [],
      {},
    ];
    for (const v of values) {
      expect(jsonSource(v).text).toBe(JSON.stringify(v, null, 2));
    }
  });

  it('records the root span over the whole text', () => {
    const value = { a: 1 };
    const { text, spans } = jsonSource(value);
    const root = spanAt(spans, []);
    expect(root).toBeDefined();
    expect(text.slice(root!.start, root!.end)).toBe(text);
  });

  it('covers every scalar token exactly (including its quotes)', () => {
    const value = { s: 'hi', n: -3.5, t: true, f: false, z: null };
    expect(tokenAt(value, ['s'])).toBe('"hi"');
    expect(tokenAt(value, ['n'])).toBe('-3.5');
    expect(tokenAt(value, ['t'])).toBe('true');
    expect(tokenAt(value, ['f'])).toBe('false');
    expect(tokenAt(value, ['z'])).toBe('null');
  });

  it('covers nested object + array element tokens', () => {
    const value = { fields: [{ expr: { kind: 'field-ref', source: 'u', field: 'id' } }] };
    // The array element (an object) spans the whole `{ ... }` block.
    const elem = tokenAt(value, ['fields', 0]);
    expect(elem.startsWith('{')).toBe(true);
    expect(elem.endsWith('}')).toBe(true);
    expect(elem).toContain('"kind": "field-ref"');
    // Deep scalars resolve to their own quoted tokens.
    expect(tokenAt(value, ['fields', 0, 'expr', 'source'])).toBe('"u"');
    expect(tokenAt(value, ['fields', 0, 'expr', 'field'])).toBe('"id"');
    expect(tokenAt(value, ['fields', 0, 'expr', 'kind'])).toBe('"field-ref"');
  });

  it('covers empty container tokens', () => {
    const value = { obj: {}, arr: [] };
    expect(tokenAt(value, ['obj'])).toBe('{}');
    expect(tokenAt(value, ['arr'])).toBe('[]');
  });

  it('drops object properties JSON.stringify omits (undefined)', () => {
    const value = { kept: 1, gone: undefined };
    const { text, spans } = jsonSource(value);
    expect(text).toBe(JSON.stringify(value, null, 2));
    expect(spanAt(spans, ['kept'])).toBeDefined();
    expect(spanAt(spans, ['gone'])).toBeUndefined();
  });

  it('serializes undefined/function array elements as null (matching JSON.stringify)', () => {
    const value = [undefined, 1];
    const { text } = jsonSource(value);
    expect(text).toBe(JSON.stringify(value, null, 2));
    expect(tokenAt(value, [0])).toBe('null');
    expect(tokenAt(value, [1])).toBe('1');
  });

  it('records a span for every node, each slicing to its exact token', () => {
    const value = { a: [10, 20], b: 'x' };
    const { text, spans } = jsonSource(value);
    for (const span of spans) {
      // Every span's slice is a well-formed, non-empty token.
      expect(text.slice(span.start, span.end).length).toBeGreaterThan(0);
    }
    expect(tokenAt(value, ['a', 0])).toBe('10');
    expect(tokenAt(value, ['a', 1])).toBe('20');
    expect(tokenAt(value, ['a'])).toBe('[\n    10,\n    20\n  ]');
  });
});
