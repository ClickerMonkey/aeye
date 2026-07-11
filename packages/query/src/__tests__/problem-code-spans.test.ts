import { describe, it, expect } from 'vitest';
import { Problems } from '../problem';
import { code, span, joinCode, plain } from '../code';
import { Index } from '../index-spec';
import type { ExprDef } from '../schema';

describe('Problems path tracking', () => {
  it('enter / leave maintain a structural path', () => {
    const p = new Problems();
    p.enter('fields').enter(2).enter('type');
    p.error('field-type.bad-min', 'min cannot be negative');
    p.leave(3);
    p.error('top.level', 'after leaving');

    expect(p.list[0]!.path).toEqual(['fields', 2, 'type']);
    expect(p.list[1]!.path).toEqual([]);
    expect(p.hasErrors).toBe(true);
  });

  it('enter accepts a segment array', () => {
    const p = new Problems();
    p.enter(['fields', 0, 'name']);
    p.warn('w', 'whoops');
    expect(p.list[0]!.path).toEqual(['fields', 0, 'name']);
    expect(p.list[0]!.severity).toBe('warning');
    expect(p.hasErrors).toBe(false);
  });

  it('at() scopes enter/leave even on throw', () => {
    const p = new Problems();
    expect(() =>
      p.at(['a', 'b'], () => {
        p.error('inner', 'boom');
        throw new Error('explode');
      }),
    ).toThrow('explode');
    // path was restored after the throw
    p.error('outer', 'after');
    expect(p.list[0]!.path).toEqual(['a', 'b']);
    expect(p.list[1]!.path).toEqual([]);
  });
});

describe('Code spans + formatProblem', () => {
  it('renders a pointer under the offending span', () => {
    // Build "min: -1" where "-1" carries the validator path.
    const valueSpan = span('-1', { path: ['fields', 2, 'type', 'min'] });
    const rendered = code`min: ${valueSpan}`;
    expect(rendered.toString()).toBe('min: -1');

    const out = rendered.formatProblem({
      path: ['fields', 2, 'type', 'min'],
      code: 'field-type.bad-min',
      message: 'min cannot be negative',
      severity: 'error',
    });

    // The pointer (^^) lands under "-1", and the message follows.
    expect(out).toContain('min: -1');
    expect(out).toContain('^^');
    expect(out).toContain('error: min cannot be negative');
    // The caret offset should align with the value (col 5).
    const lines = out.split('\n');
    const caretLine = lines.find((l) => l.includes('^^'))!;
    expect(caretLine.indexOf('^')).toBe(5);
  });

  it('longest-prefix span wins for nested paths', () => {
    const inner = span('xyz', { path: ['a', 'b'] });
    const outer = span(code`(${inner})`, { path: ['a'] });
    // A problem deep under a.b resolves to the inner span, not the outer.
    const found = outer.spanFor(['a', 'b', 'c']);
    expect(found?.path).toEqual(['a', 'b']);
  });

  it('falls back to a plain line when no span matches', () => {
    const c = plain('nothing here');
    const out = c.formatProblem({
      path: ['unmatched', 'path'],
      code: 'x',
      message: 'no span for this',
      severity: 'error',
    });
    expect(out).toContain('no span for this');
    expect(out).toContain('@ unmatched.path');
  });

  it('joinCode preserves spans across a separator', () => {
    const a = span('aa', { path: ['x'] });
    const b = span('bb', { path: ['y'] });
    const joined = joinCode([a, b], ', ');
    expect(joined.toString()).toBe('aa, bb');
    expect(joined.spanFor(['y'])?.start).toBe(4);
  });
});

describe('Index (composite) prefix reduction + digest', () => {
  const fieldRef = (source: string, field: string): ExprDef => ({ kind: 'field-ref', source, field });
  /** Wrap a raw ExprDef so it satisfies the `{ toJSON(): ExprDef }` shape. */
  const node = (def: ExprDef): { toJSON(): ExprDef } => ({ toJSON: () => def });
  const single = (expr: ExprDef, count: number): Index => Index.from({ exprs: [{ expr, count }] });

  it('unique reflects the last part count === 1', () => {
    expect(single(fieldRef('u', 'id'), 1).unique).toBe(true);
    expect(single(fieldRef('u', 'email'), 1000).unique).toBe(false);
    // Composite: unique iff the LAST part collapses to one row.
    const composite = Index.from({
      exprs: [
        { expr: fieldRef('u', 'a'), count: 50 },
        { expr: fieldRef('u', 'b'), count: 1 },
      ],
    });
    expect(composite.unique).toBe(true);
  });

  it('digest is key-order independent', () => {
    // Same logical expr, different key insertion order.
    const a: ExprDef = { kind: 'field-ref', source: 'u', field: 'id' };
    const b: ExprDef = JSON.parse('{"field":"id","source":"u","kind":"field-ref"}');
    expect(single(a, 1).parts[0]!.digest).toBe(single(b, 1).parts[0]!.digest);
  });

  it('prefixReduction returns the longest matched leading prefix count', () => {
    const idx = Index.from({
      exprs: [
        { expr: fieldRef('u', 'a'), count: 100 },
        { expr: fieldRef('u', 'b'), count: 1 },
      ],
    });
    // full prefix ⇒ unique count 1; partial (only part 0) ⇒ 100; miss ⇒ undefined.
    expect(idx.prefixReduction([node(fieldRef('u', 'a')), node(fieldRef('u', 'b'))])).toBe(1);
    expect(idx.prefixReduction([node(fieldRef('u', 'a'))])).toBe(100);
    expect(idx.prefixReduction([node(fieldRef('u', 'b'))])).toBeUndefined();
    expect(idx.prefixReduction([node(fieldRef('u', 'z'))])).toBeUndefined();
  });

  it('round-trips through JSON', () => {
    const idx = single(fieldRef('u', 'id'), 1);
    const json = idx.toJSON();
    expect(json).toEqual({ exprs: [{ expr: { kind: 'field-ref', source: 'u', field: 'id' }, count: 1 }] });
    expect(Index.from(json).parts[0]!.digest).toBe(idx.parts[0]!.digest);
  });
});
